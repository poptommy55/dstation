#Requires -Version 5.1
<#
.SYNOPSIS
    Assemble a runnable D-STATION bundle in dist/.

.DESCRIPTION
    Copies the Electron runtime, the shell, the DSH kernel, the portable Node
    runtime, and this repository's plugins/skills/profile into a bundle whose
    layout the shell expects:

        dist\
          dsh-launcher.exe        renamed electron.exe
          resources\app\          the shell (main.js and friends)
          app\node_modules\       the DSH kernel
          runtime\node\           portable Node, used to run the sidecar
          home\                   profile, plugins, skills

    The shell picks "packaged" mode by looking for runtime\node\node.exe next to
    the executable. Without it the bundle will not start.

    Run scripts/setup.ps1 first.

.PARAMETER VendorDir
    Where setup.ps1 downloaded the dependencies. Defaults to <repo>\.vendor

.PARAMETER OutDir
    Where to assemble the bundle. Defaults to <repo>\dist

.PARAMETER Clean
    Delete OutDir before assembling.
#>
[CmdletBinding()]
param(
    [string]$VendorDir,
    [string]$OutDir,
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $VendorDir) { $VendorDir = Join-Path $repoRoot '.vendor' }
if (-not $OutDir)    { $OutDir    = Join-Path $repoRoot 'dist' }
$VendorDir = [System.IO.Path]::GetFullPath($VendorDir)
$OutDir    = [System.IO.Path]::GetFullPath($OutDir)

$deps = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'deps.json') -Raw | ConvertFrom-Json

Write-Host 'D-STATION build'
Write-Host "  repo   : $repoRoot"
Write-Host "  vendor : $VendorDir"
Write-Host "  output : $OutDir"
Write-Host ''

# ------------------------------------------------------------------ preflight
$electronDist = Join-Path $VendorDir 'node_modules\electron\dist'
$kernelDir    = Join-Path $VendorDir 'node_modules'
$nodeRuntime  = Join-Path $VendorDir 'node-runtime'

$missing = @()
if (-not (Test-Path -LiteralPath (Join-Path $electronDist 'electron.exe'))) { $missing += 'Electron runtime (node_modules\electron\dist)' }
if (-not (Test-Path -LiteralPath (Join-Path $kernelDir '@deepseek-ai\dsh\lib\bin.js'))) { $missing += 'DSH kernel (node_modules\@deepseek-ai\dsh)' }
if (-not (Test-Path -LiteralPath (Join-Path $nodeRuntime 'node.exe'))) { $missing += 'Portable Node runtime (node-runtime)' }
if ($missing.Count -gt 0) {
    Write-Host 'Missing prerequisites:'
    $missing | ForEach-Object { Write-Host "  - $_" }
    throw 'Run scripts/setup.ps1 first.'
}

function Write-Utf8NoBom {
    param([string]$Path, [string]$Text)
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $enc)
}

if ($Clean -and (Test-Path -LiteralPath $OutDir)) {
    Write-Host "Cleaning $OutDir"
    Remove-Item -Recurse -Force -LiteralPath $OutDir
}
$fresh = -not (Test-Path -LiteralPath $OutDir)
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# ------------------------------------------------------- 1. Electron runtime
Write-Host '[1/6] Electron runtime'
Copy-Item -Path (Join-Path $electronDist '*') -Destination $OutDir -Recurse -Force

# Electron ships a default app; ours lives in resources\app instead.
Remove-Item -Force -LiteralPath (Join-Path $OutDir 'resources\default_app.asar') -ErrorAction SilentlyContinue

$exeSrc = Join-Path $OutDir 'electron.exe'
if (Test-Path -LiteralPath $exeSrc) {
    Move-Item -Force -LiteralPath $exeSrc -Destination (Join-Path $OutDir 'dsh-launcher.exe')
}

# ------------------------------------------------------------------ 2. shell
Write-Host '[2/6] Shell'
$appDir = Join-Path $OutDir 'resources\app'
New-Item -ItemType Directory -Force -Path $appDir | Out-Null

# Everything except the npm project files: those describe the developer's own
# Electron install, not the packaged app manifest.
$skip = @('package.json', 'package-lock.json', 'start-dstation.bat')
Get-ChildItem -LiteralPath (Join-Path $repoRoot 'shell') -File |
    Where-Object { $skip -notcontains $_.Name } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $appDir -Force }

Write-Utf8NoBom -Path (Join-Path $appDir 'package.json') -Text @"
{
  "name": "dsh-launcher",
  "productName": "D-STATION",
  "version": "1.0.0",
  "main": "main.js",
  "private": true
}
"@

# ------------------------------------------------------------- 3. DSH kernel
Write-Host '[3/6] DSH kernel'
$kernelOut = Join-Path $OutDir 'app'
New-Item -ItemType Directory -Force -Path $kernelOut | Out-Null
Copy-Item -LiteralPath $kernelDir -Destination (Join-Path $kernelOut 'node_modules') -Recurse -Force
Write-Utf8NoBom -Path (Join-Path $kernelOut 'package.json') -Text @"
{
  "dependencies": {
    "@deepseek-ai/dsh": "$($deps.dsh)"
  }
}
"@

# -------------------------------------------------------- 4. portable Node
Write-Host '[4/6] Portable Node runtime'
$runtimeOut = Join-Path $OutDir 'runtime\node'
New-Item -ItemType Directory -Force -Path $runtimeOut | Out-Null
Copy-Item -Path (Join-Path $nodeRuntime '*') -Destination $runtimeOut -Recurse -Force

# ------------------------------------------------ 5. profile, plugins, skills
Write-Host '[5/6] Profile, plugins and skills'
$homeOut = Join-Path $OutDir 'home'

$profileOut = Join-Path $homeOut 'profiles\web'
New-Item -ItemType Directory -Force -Path $profileOut | Out-Null
Copy-Item -Path (Join-Path $repoRoot 'profiles\web\*') -Destination $profileOut -Recurse -Force

# First-party plugins are loaded from the profile's node_modules. A copy is also
# placed in home\plugins so they appear as installed plugins in the UI.
$pluginSrc = Join-Path $repoRoot 'plugins'
$profileModules = Join-Path $profileOut 'node_modules'
$homePlugins = Join-Path $homeOut 'plugins'
New-Item -ItemType Directory -Force -Path $profileModules | Out-Null
New-Item -ItemType Directory -Force -Path $homePlugins | Out-Null

$pluginCount = 0
Get-ChildItem -LiteralPath $pluginSrc -Directory | ForEach-Object {
    $name = $_.Name
    if ($name.StartsWith('@')) {
        # scoped: keep the @scope directory level so the package resolves
        Get-ChildItem -LiteralPath $_.FullName -Directory | ForEach-Object {
            $dest1 = Join-Path (Join-Path $profileModules $name) $_.Name
            $dest2 = Join-Path (Join-Path $homePlugins $name) $_.Name
            New-Item -ItemType Directory -Force -Path (Split-Path $dest1) | Out-Null
            New-Item -ItemType Directory -Force -Path (Split-Path $dest2) | Out-Null
            Copy-Item -LiteralPath $_.FullName -Destination $dest1 -Recurse -Force
            Copy-Item -LiteralPath $_.FullName -Destination $dest2 -Recurse -Force
            $script:pluginCount++
        }
    }
    else {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $profileModules $name) -Recurse -Force
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $homePlugins $name) -Recurse -Force
        $script:pluginCount++
    }
}

$skillsOut = Join-Path $homeOut 'skills'
New-Item -ItemType Directory -Force -Path $skillsOut | Out-Null
Copy-Item -Path (Join-Path $repoRoot 'skills\*') -Destination $skillsOut -Recurse -Force

# --------------------------------------------------------- 6. bundle metadata
Write-Host '[6/6] Bundle metadata'
Write-Utf8NoBom -Path (Join-Path $OutDir 'config.json') -Text @"
{
  "port": 0
}
"@

Write-Utf8NoBom -Path (Join-Path $OutDir 'README-FIRST.txt') -Text @"
D-STATION (built from source)
=============================

1. Double-click dsh-launcher.exe. A desktop window opens; no browser needed.
2. The first launch is slow (roughly 1-3 minutes) because the plugin tree has
   to be assembled. Later launches take a few seconds.
3. You must supply your own model API key: Settings -> Models.
4. To quit completely, right-click the tray icon and choose Quit. Closing the
   window only minimizes it to the tray.
5. Logs: launcher.log next to dsh-launcher.exe.

Built with Electron $($deps.electron) and @deepseek-ai/dsh $($deps.dsh).
Supported platform: Windows 10/11 x64.
"@

# ------------------------------------------------------------------ summary
Write-Host ''
Write-Host 'Build summary:'
$totalFiles = (Get-ChildItem -LiteralPath $OutDir -Recurse -File -Force | Measure-Object).Count
$totalBytes = (Get-ChildItem -LiteralPath $OutDir -Recurse -File -Force | Measure-Object -Property Length -Sum).Sum
Write-Host "  bundle size  : $([math]::Round($totalBytes / 1MB, 1)) MB in $totalFiles files"
Write-Host "  plugins      : $pluginCount"
Write-Host "  skills       : $((Get-ChildItem -LiteralPath $skillsOut -Directory).Count)"
Write-Host "  launcher     : $(Join-Path $OutDir 'dsh-launcher.exe')"

$mustExist = @(
    'dsh-launcher.exe',
    'resources\app\main.js',
    'app\node_modules\@deepseek-ai\dsh\lib\bin.js',
    'runtime\node\node.exe',
    'home\profiles\web\cordis.yml'
)
$broken = @()
foreach ($rel in $mustExist) {
    if (-not (Test-Path -LiteralPath (Join-Path $OutDir $rel))) { $broken += $rel }
}
if ($broken.Count -gt 0) {
    Write-Host ''
    Write-Host 'Bundle is incomplete, missing:'
    $broken | ForEach-Object { Write-Host "  - $_" }
    throw 'Build produced an incomplete bundle.'
}

Write-Host ''
Write-Host 'Done. Next: powershell -ExecutionPolicy Bypass -File scripts/start.ps1'
