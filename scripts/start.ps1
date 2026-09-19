#Requires -Version 5.1
<#
.SYNOPSIS
    Launch a D-STATION bundle built by scripts/build.ps1.

.DESCRIPTION
    Starts dsh-launcher.exe from the bundle root. The window can take a minute
    or more to appear on the first run while the plugin tree is assembled.

    Closing the window only minimises to the tray. To stop the app completely,
    right-click the tray icon and choose Quit.

.PARAMETER DistDir
    The assembled bundle. Defaults to <repo>\dist
#>
[CmdletBinding()]
param(
    [string]$DistDir
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $DistDir) { $DistDir = Join-Path $repoRoot 'dist' }
$DistDir = [System.IO.Path]::GetFullPath($DistDir)

$exe = Join-Path $DistDir 'dsh-launcher.exe'
if (-not (Test-Path -LiteralPath $exe)) {
    throw "No bundle at $DistDir. Run scripts/build.ps1 first."
}

foreach ($rel in @('runtime\node\node.exe', 'app\node_modules\@deepseek-ai\dsh\lib\bin.js')) {
    if (-not (Test-Path -LiteralPath (Join-Path $DistDir $rel))) {
        throw "Bundle is incomplete: $rel is missing. Re-run scripts/build.ps1."
    }
}

$running = Get-Process -Name 'dsh-launcher' -ErrorAction SilentlyContinue
if ($running) {
    Write-Host 'A D-STATION instance is already running.'
    Write-Host 'Closing the window only minimises it, so the single-instance lock will'
    Write-Host 'block a new window. Right-click the tray icon and choose Quit first.'
    return
}

Write-Host "Starting $exe"
if (Test-Path -LiteralPath (Join-Path $DistDir 'launcher.log')) {
    Remove-Item -Force -LiteralPath (Join-Path $DistDir 'launcher.log')
}
Start-Process -FilePath $exe -WorkingDirectory $DistDir
Write-Host "Started. Watch progress with: Get-Content '$DistDir\launcher.log' -Wait"
