# dsh-wallpaper -- installer for DeepSeek Harness (Windows / PowerShell)
#
# This script is intentionally ASCII-only: Windows PowerShell 5.1 reads a
# BOM-less UTF-8 .ps1 as ANSI, which would corrupt any non-ASCII text.
#
# What it does (idempotent, no pnpm involved):
#   1. copy this package to  <DSH_HOME>\plugins\dsh-wallpaper
#   2. create a junction     <DSH_HOME>\profiles\<profile>\node_modules\dsh-wallpaper
#   3. append "dsh-wallpaper" to that profile package.json's dsh.profile.bundles
#      -- the profile boot then merges the package's own cordis.patch.yml,
#         so NO profile file has to be hand-edited.
#   4. warn if the profile's own cordis.patch.yml still carries an old manual
#      mount line for this plugin (that would double-mount and fail at boot).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Profile web -DshHome "D:\DSH\home"
#
# Restart `dsh web` afterwards.

[CmdletBinding()]
param(
  [string]$Profile = 'web',
  [string]$DshHome = $env:DSH_HOME
)

$ErrorActionPreference = 'Stop'
$PluginName = 'dsh-wallpaper'
$PluginId = 'wallpaper'

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }
function Ok($msg)   { Write-Host "  ok   $msg" -ForegroundColor Green }
function Info($msg) { Write-Host "  --   $msg" }
function Warn($msg) { Write-Host "  !!   $msg" -ForegroundColor Yellow }

Write-Host ""
Write-Host "$PluginName installer" -ForegroundColor Cyan
Write-Host ""

# ---------------------------------------------------------------- locate DSH
if ([string]::IsNullOrWhiteSpace($DshHome)) { $DshHome = $env:DSH_HOME }
if ([string]::IsNullOrWhiteSpace($DshHome)) {
  Fail "DSH_HOME is not set. Pass it explicitly: -DshHome `"C:\path\to\dsh\home`""
}
if (-not (Test-Path $DshHome)) { Fail "DSH_HOME does not exist: $DshHome" }
$DshHome = [System.IO.Path]::GetFullPath($DshHome)
Info "DSH_HOME = $DshHome"

$profileDir = Join-Path $DshHome "profiles\$Profile"
$profilePkg = Join-Path $profileDir 'package.json'
if (-not (Test-Path $profilePkg)) {
  Fail "profile '$Profile' not found (no $profilePkg). Use -Profile <name>."
}
$profilePatch = Join-Path $profileDir 'cordis.patch.yml'

# ------------------------------------------------------------ 1. copy package
$source = $PSScriptRoot
$target = Join-Path $DshHome "plugins\$PluginName"
$sourceFull = [System.IO.Path]::GetFullPath($source)
$targetFull = [System.IO.Path]::GetFullPath($target)

if ($sourceFull -eq $targetFull) {
  Ok "already running from $targetFull (no copy needed)"
} else {
  # $target may already be a junction pointing back at the source (developer
  # layout). Copying would then mean "copy a file onto itself" -> Copy-Item
  # throws. Detect that and skip the copy.
  $targetIsLinkToSource = $false
  if (Test-Path $target) {
    $ti = Get-Item $target -Force
    if ($ti.LinkType) {
      $tt = @($ti.Target)[0]
      if ($tt -and ([System.IO.Path]::GetFullPath($tt) -eq $sourceFull)) { $targetIsLinkToSource = $true }
    }
  }

  if ($targetIsLinkToSource) {
    Ok "$target is already a link to $sourceFull (developer layout, no copy)"
  } else {
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    foreach ($item in @('index.js','client.js','package.json','cordis.patch.yml','LICENSE','README.md')) {
      $src = Join-Path $source $item
      if (Test-Path $src) { Copy-Item $src -Destination $target -Force }
    }
    $srcTest = Join-Path $source 'test'
    if (Test-Path $srcTest) {
      Copy-Item $srcTest -Destination $target -Recurse -Force
    }
    Ok "copied package to $targetFull"
  }
}

# --------------------------------------------------------------- 2. junction
$nmDir = Join-Path $profileDir 'node_modules'
if (-not (Test-Path $nmDir)) { New-Item -ItemType Directory -Force -Path $nmDir | Out-Null }
$link = Join-Path $nmDir $PluginName

if (Test-Path $link) {
  $existing = Get-Item $link -Force
  if ($existing.LinkType -eq 'Junction' -or $existing.LinkType -eq 'SymbolicLink') {
    $cur = @($existing.Target)[0]
    if ($cur -and ([System.IO.Path]::GetFullPath($cur) -eq $targetFull)) {
      Ok "junction already points at $targetFull"
    } else {
      Remove-Item $link -Force -Recurse
      New-Item -ItemType Junction -Path $link -Target $targetFull | Out-Null
      Ok "junction repointed to $targetFull"
    }
  } else {
    Warn "$link exists and is a real directory (probably pnpm-installed)."
    Warn "Leaving it alone. If it is an OLD copy of this plugin, remove it and re-run."
  }
} else {
  New-Item -ItemType Junction -Path $link -Target $targetFull | Out-Null
  Ok "junction created: $link -> $targetFull"
}

# ------------------------------------------------- 3. register in bundle list
Copy-Item $profilePkg "$profilePkg.bak-$PluginName" -Force
$raw = [System.IO.File]::ReadAllText($profilePkg, [System.Text.Encoding]::UTF8)
$pkg = $raw | ConvertFrom-Json

if (-not $pkg.dsh) { $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force }
if (-not $pkg.dsh.profile) {
  $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force
}

$bundles = @()
if ($pkg.dsh.profile.bundles) { $bundles = @($pkg.dsh.profile.bundles) }
if ($bundles -contains $PluginName) {
  Ok "already listed in dsh.profile.bundles"
} else {
  $pkg.dsh.profile.bundles = @($bundles + $PluginName)
  Ok "appended to dsh.profile.bundles"
}

if (-not $pkg.dependencies) {
  $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force
}
$depValue = 'file:./node_modules/' + $PluginName
if ($pkg.dependencies.PSObject.Properties.Name -contains $PluginName) {
  Ok "already present in dependencies"
} else {
  $pkg.dependencies | Add-Member -NotePropertyName $PluginName -NotePropertyValue $depValue -Force
  Ok "added to dependencies as $depValue"
}

$out = $pkg | ConvertTo-Json -Depth 12
[System.IO.File]::WriteAllText($profilePkg, $out, (New-Object System.Text.UTF8Encoding($false)))

# read back -- never trust a write without a readback
$check = [System.IO.File]::ReadAllText($profilePkg, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
if (-not (@($check.dsh.profile.bundles) -contains $PluginName)) {
  Fail "readback failed: $PluginName is not in dsh.profile.bundles after write"
}
Ok "readback verified (backup: $profilePkg.bak-$PluginName)"

# ---------------------------------------------------- 4. double-mount warning
if (Test-Path $profilePatch) {
  $patchText = [System.IO.File]::ReadAllText($profilePatch, [System.Text.Encoding]::UTF8)
  if ($patchText -match "name:\s*'?$PluginName'?") {
    Warn "profile cordis.patch.yml still contains a manual mount for $PluginName."
    Warn "That would DOUBLE-MOUNT the plugin and fail the boot"
    Warn "  (webserver: duplicate exact route \`"/$PluginName/config\`")."
    Warn "Delete that insert block from: $profilePatch"
  } else {
    Ok "no conflicting manual mount in the profile patch"
  }
}

Write-Host ""
Write-Host "Done. Next steps:" -ForegroundColor Cyan
Write-Host "  1. restart dsh web  (a plugin whose HOST half changed is not hot-reloaded)"
Write-Host "  2. open  Settings -> General -> 'Window background'"
Write-Host "  3. diagnose any time:  GET http://127.0.0.1:3080/$PluginName/status"
Write-Host ""
