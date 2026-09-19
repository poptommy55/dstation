# @@PLUGIN_NAME@@ 卸载程序（Windows / PowerShell）
#
# ⚠️ 本文件必须以 UTF-8 **带 BOM** 保存（原因见 install.ps1 头部说明）。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 -RemovePackage
#
# 默认**保留**插件自己产生的数据（如果有的话）。加 -RemovePackage 连插件
# 目录一起删掉。

[CmdletBinding()]
param(
  [string]$Profile = '',
  [string]$DshHome = $env:DSH_HOME,
  [switch]$RemovePackage
)

$ErrorActionPreference = 'Stop'

$PluginName = '@@PLUGIN_NAME@@'
$PrettyName = '@@PRETTY_NAME@@'

function Fail($m) { Write-Host ""; Write-Host "  ✗ $m" -ForegroundColor Red; Write-Host ""; exit 1 }
function Ok($m)   { Write-Host "  ✓ $m" -ForegroundColor Green }
function Info($m) { Write-Host "  · $m" -ForegroundColor Gray }
function Warn($m) { Write-Host "  ! $m" -ForegroundColor Yellow }
function Head($m) { Write-Host ""; Write-Host $m -ForegroundColor Cyan }

Write-Host ""
Write-Host "  卸载 $PrettyName（$PluginName）" -ForegroundColor Cyan

# ───────────────────────────────────────────────────── 定位 DSH
$candidates = @()
if (-not [string]::IsNullOrWhiteSpace($DshHome)) { $candidates += $DshHome }
foreach ($c in @("$env:USERPROFILE\.dsh", "$env:USERPROFILE\dsh", "$env:APPDATA\dsh", "$env:LOCALAPPDATA\dsh")) {
  if (-not [string]::IsNullOrWhiteSpace($c)) { $candidates += $c }
}

$found = $null
foreach ($c in $candidates) {
  if ([string]::IsNullOrWhiteSpace($c) -or -not (Test-Path $c)) { continue }
  $probe = Join-Path $c 'profiles'
  if (Test-Path $probe) {
    $sub = @(Get-ChildItem $probe -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName 'package.json') })
    if ($sub.Count -gt 0) { $found = [System.IO.Path]::GetFullPath($c); break }
  }
}
if (-not $found) { Fail "找不到 DSH 主目录。请用 -DshHome 指定。" }

# ───────────────────────────────────────────────────── 定位 profile
$profilesRoot = Join-Path $found 'profiles'
$avail = @(Get-ChildItem $profilesRoot -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName 'package.json') })

if (-not [string]::IsNullOrWhiteSpace($Profile)) {
  $profileDir = Join-Path $profilesRoot $Profile
  if (-not (Test-Path (Join-Path $profileDir 'package.json'))) { Fail "profile `"$Profile`" 不存在。" }
} else {
  # 找出真正装了本插件的那个 profile（可能不止一个）
  $withPlugin = @($avail | Where-Object {
    $pj = Join-Path $_.FullName 'package.json'
    $t = [System.IO.File]::ReadAllText($pj, [System.Text.Encoding]::UTF8)
    $t -match [regex]::Escape($PluginName)
  })
  if ($withPlugin.Count -eq 1) { $profileDir = $withPlugin[0].FullName }
  elseif (@($withPlugin | Where-Object { $_.Name -eq 'web' }).Count -eq 1) { $profileDir = (Join-Path $profilesRoot 'web') }
  elseif ($avail.Count -eq 1) { $profileDir = $avail[0].FullName }
  else { Fail "无法确定要卸载哪个 profile，请用 -Profile 指定。可用的有：$(($avail | ForEach-Object { $_.Name }) -join ', ')" }
}
Ok "profile = $(Split-Path $profileDir -Leaf)"

$profilePkg   = Join-Path $profileDir 'package.json'
$profilePatch = Join-Path $profileDir 'cordis.patch.yml'

# ───────────────────────────────────────────────────── 1. 移除链接
Head "① 移除链接"
$link = Join-Path $profileDir "node_modules\$PluginName"
if (Test-Path $link) {
  $item = Get-Item $link -Force
  if ($item.LinkType -eq 'Junction' -or $item.LinkType -eq 'SymbolicLink') {
    Remove-Item $link -Force -Recurse
    Ok "链接已移除"
  } else {
    Warn "$link 是真实目录（可能是 pnpm 装的），已保留不动。"
  }
} else {
  Info "没有需要移除的链接"
}

# ───────────────────────────────────────────────────── 2. 从启动清单注销
Head "② 从 DSH 启动清单注销"
Copy-Item $profilePkg "$profilePkg.bak-$PluginName-uninstall" -Force
$pp = [System.IO.File]::ReadAllText($profilePkg, [System.Text.Encoding]::UTF8) | ConvertFrom-Json

if ($pp.dsh -and $pp.dsh.profile -and $pp.dsh.profile.bundles) {
  $kept = @($pp.dsh.profile.bundles) | Where-Object { $_ -ne $PluginName }
  if ($kept.Count -ne @($pp.dsh.profile.bundles).Count) {
    $pp.dsh.profile.bundles = @($kept)
    Ok "已从启动清单移除"
  } else {
    Info "启动清单里本来就没有本插件"
  }
}

if ($pp.dependencies -and ($pp.dependencies.PSObject.Properties.Name -contains $PluginName)) {
  $pp.dependencies.PSObject.Properties.Remove($PluginName)
  Ok "已移除依赖项登记"
}

[System.IO.File]::WriteAllText($profilePkg, ($pp | ConvertTo-Json -Depth 12), (New-Object System.Text.UTF8Encoding($false)))
$check = [System.IO.File]::ReadAllText($profilePkg, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
if (@($check.dsh.profile.bundles) -contains $PluginName) {
  Copy-Item "$profilePkg.bak-$PluginName-uninstall" $profilePkg -Force
  Fail "写入校验失败，已还原 profile 配置。"
}
Ok "写入回读校验通过"

# ───────────────────────────────────────────────────── 3. 手工挂载提醒
if (Test-Path $profilePatch) {
  $pt = [System.IO.File]::ReadAllText($profilePatch, [System.Text.Encoding]::UTF8)
  if ($pt -match [regex]::Escape($PluginName)) {
    Warn "profile 的 cordis.patch.yml 里还提到本插件，请手工删掉那段："
    Write-Host "      $profilePatch" -ForegroundColor White
  }
}

# ───────────────────────────────────────────────────── 4. 删除插件目录
Head "③ 清理文件"
if ($RemovePackage) {
  $dir = Join-Path $found "plugins\$PluginName"
  if (Test-Path $dir) {
    $di = Get-Item $dir -Force
    if ($di.LinkType) { Warn "$dir 是链接，未删除。" }
    else { Remove-Item $dir -Recurse -Force; Ok "插件目录已删除" }
  } else { Info "插件目录不存在" }
} else {
  Info "插件文件保留在 plugins\$PluginName（加 -RemovePackage 可一并删除）"
}

Write-Host ""
Write-Host "  ────────────────────────────────────────────────" -ForegroundColor DarkGray
Write-Host "  卸载完成 ✓  —— 重启 DSH 后生效" -ForegroundColor Green
Write-Host ""
Write-Host "  配置备份：$profilePkg.bak-$PluginName-uninstall" -ForegroundColor DarkGray
Write-Host ""
exit 0
