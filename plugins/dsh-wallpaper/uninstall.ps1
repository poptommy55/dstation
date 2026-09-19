# dsh-wallpaper -- uninstaller (Windows / PowerShell)
#
# Reverses install.ps1. ASCII-only on purpose (see install.ps1 header).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Profile web
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 -PurgeData
#
# By default your uploaded wallpapers in <DSH_HOME>\wallpapers are KEPT.
# Pass -PurgeData to delete them too.

[CmdletBinding()]
param(
  [string]$Profile = 'web',
  [string]$DshHome = $env:DSH_HOME,
  [switch]$PurgeData,
  [switch]$RemovePackage
)

$ErrorActionPreference = 'Stop'
$PluginName = 'dsh-wallpaper'

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }
function Ok($msg)   { Write-Host "  ok   $msg" -ForegroundColor Green }
function Info($msg) { Write-Host "  --   $msg" }
function Warn($msg) { Write-Host "  !!   $msg" -ForegroundColor Yellow }

Write-Host ""
Write-Host "$PluginName uninstaller" -ForegroundColor Cyan
Write-Host ""

if ([string]::IsNullOrWhiteSpace($DshHome)) { $DshHome = $env:DSH_HOME }
if ([string]::IsNullOrWhiteSpace($DshHome)) { Fail "DSH_HOME is not set. Pass -DshHome." }
$DshHome = [System.IO.Path]::GetFullPath($DshHome)

$profileDir = Join-Path $DshHome "profiles\$Profile"
$profilePkg = Join-Path $profileDir 'package.json'
if (-not (Test-Path $profilePkg)) { Fail "profile '$Profile' not found." }

# ---------------------------------------------------------- 1. junction away
$link = Join-Path $profileDir "node_modules\$PluginName"
if (Test-Path $link) {
  $item = Get-Item $link -Force
  if ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') {
    Remove-Item $link -Force -Recurse
    Ok "junction removed"
  } else {
    Warn "$link is a real directory (pnpm-installed); remove it with your package manager."
  }
} else {
  Info "no junction to remove"
}

# ------------------------------------------------------- 2. unregister bundle
Copy-Item $profilePkg "$profilePkg.bak-$PluginName-uninstall" -Force
$pkg = [System.IO.File]::ReadAllText($profilePkg, [System.Text.Encoding]::UTF8) | ConvertFrom-Json

if ($pkg.dsh -and $pkg.dsh.profile -and $pkg.dsh.profile.bundles) {
  $kept = @($pkg.dsh.profile.bundles) | Where-Object { $_ -ne $PluginName }
  if ($kept.Count -ne @($pkg.dsh.profile.bundles).Count) {
    $pkg.dsh.profile.bundles = @($kept)
    Ok "removed from dsh.profile.bundles"
  } else {
    Info "not present in dsh.profile.bundles"
  }
}

if ($pkg.dependencies -and ($pkg.dependencies.PSObject.Properties.Name -contains $PluginName)) {
  $pkg.dependencies.PSObject.Properties.Remove($PluginName)
  Ok "removed from dependencies"
}

[System.IO.File]::WriteAllText($profilePkg, ($pkg | ConvertTo-Json -Depth 12), (New-Object System.Text.UTF8Encoding($false)))
$check = [System.IO.File]::ReadAllText($profilePkg, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
if ($check.dsh.profile.bundles -contains $PluginName) { Fail "readback failed: still in dsh.profile.bundles" }
Ok "readback verified"

# ------------------------------------------------------------- 3. warn patch
$profilePatch = Join-Path $profileDir 'cordis.patch.yml'
if (Test-Path $profilePatch) {
  $t = [System.IO.File]::ReadAllText($profilePatch, [System.Text.Encoding]::UTF8)
  if ($t -match "name:\s*'?$PluginName'?") {
    Warn "profile cordis.patch.yml still mentions $PluginName -- delete that insert block."
  }
}

# --------------------------------------------------------------- 4. payload
if ($RemovePackage) {
  $dir = Join-Path $DshHome "plugins\$PluginName"
  if (Test-Path $dir) { Remove-Item $dir -Recurse -Force; Ok "package directory removed" }
}
if ($PurgeData) {
  $data = Join-Path $DshHome 'wallpapers'
  if (Test-Path $data) { Remove-Item $data -Recurse -Force; Ok "wallpaper data purged" }
} else {
  Info "wallpapers kept at $(Join-Path $DshHome 'wallpapers')  (use -PurgeData to delete)"
}

Write-Host ""
Write-Host "Done. Restart dsh web to unmount the plugin." -ForegroundColor Cyan
Write-Host ""
