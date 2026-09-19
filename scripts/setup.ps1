#Requires -Version 5.1
<#
.SYNOPSIS
    Fetch D-STATION's third-party dependencies.

.DESCRIPTION
    D-STATION does not vendor Electron, the DeepSeek Harness kernel, or a Node
    runtime. They are fetched into .vendor/ and assembled into dist/ by
    scripts/build.ps1. Run this once before the first build.

    Versions are pinned in scripts/deps.json.

.PARAMETER VendorDir
    Where to put the downloaded dependencies. Defaults to <repo>\.vendor

.PARAMETER Force
    Delete any existing .vendor directory first.
#>
[CmdletBinding()]
param(
    [string]$VendorDir,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$repoRoot  = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $VendorDir) { $VendorDir = Join-Path $repoRoot '.vendor' }
$VendorDir = [System.IO.Path]::GetFullPath($VendorDir)

$deps = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'deps.json') -Raw | ConvertFrom-Json

Write-Host 'D-STATION dependency setup'
Write-Host "  repo    : $repoRoot"
Write-Host "  vendor  : $VendorDir"
Write-Host "  electron: $($deps.electron)"
Write-Host "  dsh     : $($deps.dsh)"
Write-Host "  node    : $($deps.nodeRuntime)"
Write-Host ''

foreach ($tool in @('node', 'npm')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "$tool was not found on PATH. Install Node.js $($deps.nodeRuntime).x and try again."
    }
}

# The DSH kernel's dependency tree requires Node 22.19 or newer. Older 22.x
# installs work for npm itself but emit EBADENGINE warnings and may fail at runtime.
$nodeVersion = (& node --version).TrimStart('v')
$nodeParts = $nodeVersion.Split('.')
$nodeOk = ([int]$nodeParts[0] -gt 22) -or
          (([int]$nodeParts[0] -eq 22) -and ([int]$nodeParts[1] -ge 19))
if (-not $nodeOk) {
    throw "Node $nodeVersion is too old. The DSH kernel requires Node 22.19.0 or newer (found $nodeVersion)."
}
Write-Host "Using Node $nodeVersion"

if ($Force -and (Test-Path -LiteralPath $VendorDir)) {
    Write-Host "Removing $VendorDir (-Force)"
    Remove-Item -Recurse -Force -LiteralPath $VendorDir
}
New-Item -ItemType Directory -Force -Path $VendorDir | Out-Null

function Write-Utf8NoBom {
    param([string]$Path, [string]$Text)
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $enc)
}

# ---------------------------------------------------------------- npm deps
$pkgPath = Join-Path $VendorDir 'package.json'
if (-not (Test-Path -LiteralPath $pkgPath)) {
    Write-Utf8NoBom -Path $pkgPath -Text "{`n  `"name`": `"dstation-vendor`",`n  `"private`": true,`n  `"version`": `"0.0.0`"`n}`n"
}

Write-Host "[1/2] Installing Electron and the DSH kernel (this downloads ~150 MB)..."

# Resolve an npm entry point that survives being called from a script.
#
# Do NOT call `& npm` here. On Windows `npm` resolves to npm.ps1, which rebuilds the
# argument list by parsing the original command text and stripping
# $MyInvocation.InvocationName.Length characters off the front. Invoked through the
# call operator the text still carries its leading "& ", so the offset lands two
# characters too far: the first letters of "install" are eaten and npm fails with a
# baffling "Unknown command: pm". npm.cmd is an ordinary batch shim and has no such
# problem, so prefer it and fall back to invoking the CLI through node.
function Get-NpmInvocation {
    $cmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($cmd) { return @{ Exe = $cmd.Source; Prefix = @() } }

    $nodeExe = (Get-Command node).Source
    $cli = Join-Path (Split-Path -Parent $nodeExe) 'node_modules\npm\bin\npm-cli.js'
    if (Test-Path -LiteralPath $cli) { return @{ Exe = $nodeExe; Prefix = @($cli) } }

    $any = Get-Command npm -ErrorAction SilentlyContinue
    if ($any) { return @{ Exe = $any.Source; Prefix = @() } }

    throw 'Could not locate npm. Install Node.js and make sure npm is on PATH.'
}

$npmInvocation = Get-NpmInvocation
Push-Location $VendorDir
try {
    & $npmInvocation.Exe @($npmInvocation.Prefix) install --no-audit --no-fund --save-exact "electron@$($deps.electron)" "@deepseek-ai/dsh@$($deps.dsh)"
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
}
finally {
    Pop-Location
}

# Electron ships as a small npm package plus a large platform binary that its
# postinstall step downloads. That step fails silently in some environments
# (corporate proxies, registry mirrors), leaving the package present but
# dist\electron.exe missing -- which only shows up much later as a confusing
# build failure. So verify it and re-run the installer explicitly.
$electronExe = Join-Path $VendorDir 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electronExe)) {
    Write-Host '      Electron binary not present; running its installer explicitly'
    Push-Location $VendorDir
    try {
        & node 'node_modules\electron\install.js'
        if ($LASTEXITCODE -ne 0) {
            throw @"
Electron's binary download failed (exit code $LASTEXITCODE).
If you are behind a slow or filtered network, set a mirror and retry:
  `$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
  Remove-Item -Recurse -Force '$VendorDir\node_modules\electron'
  powershell -ExecutionPolicy Bypass -File scripts/setup.ps1
"@
        }
    }
    finally {
        Pop-Location
    }
}

# ------------------------------------------------------------ node runtime
Write-Host "[2/2] Fetching the portable Node runtime..."
$nodeRuntimeDir = Join-Path $VendorDir 'node-runtime'
if (Test-Path -LiteralPath (Join-Path $nodeRuntimeDir 'node.exe')) {
    Write-Host '      already present, skipping'
}
else {
    $zipPath = Join-Path $VendorDir 'node-runtime.zip'
    Write-Host "      downloading $($deps.nodeRuntimeUrl)"
    $oldProgress = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar on
    try {
        Invoke-WebRequest -Uri $deps.nodeRuntimeUrl -OutFile $zipPath -UseBasicParsing
    }
    finally {
        $ProgressPreference = $oldProgress
    }

    $extractDir = Join-Path $VendorDir 'node-runtime-extract'
    if (Test-Path -LiteralPath $extractDir) { Remove-Item -Recurse -Force -LiteralPath $extractDir }
    Write-Host '      extracting'
    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force

    $inner = Get-ChildItem -LiteralPath $extractDir -Directory | Select-Object -First 1
    if (-not $inner) { throw 'The Node runtime archive did not contain a directory.' }
    Move-Item -LiteralPath $inner.FullName -Destination $nodeRuntimeDir

    Remove-Item -Recurse -Force -LiteralPath $extractDir
    Remove-Item -Force -LiteralPath $zipPath
}

# ------------------------------------------------------------------ verify
Write-Host ''
Write-Host 'Verifying:'
$checks = @(
    @{ Name = 'electron.exe';    Path = (Join-Path $VendorDir 'node_modules\electron\dist\electron.exe') },
    @{ Name = 'dsh lib/bin.js';  Path = (Join-Path $VendorDir 'node_modules\@deepseek-ai\dsh\lib\bin.js') },
    @{ Name = 'node runtime';    Path = (Join-Path $nodeRuntimeDir 'node.exe') }
)
$failed = $false
foreach ($c in $checks) {
    if (Test-Path -LiteralPath $c.Path) {
        Write-Host "  [ok]   $($c.Name)"
    }
    else {
        Write-Host "  [FAIL] $($c.Name) missing at $($c.Path)"
        $failed = $true
    }
}
if ($failed) { throw 'Setup finished but expected files are missing.' }

Write-Host ''
Write-Host 'Done. Next: powershell -ExecutionPolicy Bypass -File scripts/build.ps1'
