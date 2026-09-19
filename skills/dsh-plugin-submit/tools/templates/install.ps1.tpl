# @@PLUGIN_NAME@@ 安装程序（Windows / PowerShell）
#
# ⚠️ 本文件必须以 UTF-8 **带 BOM** 保存。
#    Windows PowerShell 5.1 读取「无 BOM 的 UTF-8 .ps1」时会当成 ANSI，
#    中文会变成乱码并直接导致语法错误（实测）。
#    导出工具会自动加 BOM，手工改动本文件后请确认 BOM 还在。
#
# 直接双击「一键安装.cmd」即可，不需要命令行。
#
# 手工用法：
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Profile web -DshHome "D:\DSH\home"
#
# 装完需要重启 DSH 才会生效（插件装载走的是启动时读取的清单）。

[CmdletBinding()]
param(
  [string]$Profile = '',
  [string]$DshHome = $env:DSH_HOME,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$PluginName  = '@@PLUGIN_NAME@@'
$PluginVer   = '@@VERSION@@'
$EntryId     = '@@ENTRY_ID@@'
$PrettyName  = '@@PRETTY_NAME@@'

$script:problems = 0

function Fail($m) { Write-Host ""; Write-Host "  ✗ $m" -ForegroundColor Red; Write-Host ""; exit 1 }
function Ok($m)   { Write-Host "  ✓ $m" -ForegroundColor Green }
function Info($m) { Write-Host "  · $m" -ForegroundColor Gray }
function Warn($m) { Write-Host "  ! $m" -ForegroundColor Yellow; $script:problems++ }
function Head($m) { Write-Host ""; Write-Host $m -ForegroundColor Cyan }

Write-Host ""
Write-Host "  ┌──────────────────────────────────────────────┐" -ForegroundColor Cyan
Write-Host "  │  $PrettyName" -ForegroundColor Cyan
Write-Host "  │  $PluginName $PluginVer" -ForegroundColor DarkGray
Write-Host "  └──────────────────────────────────────────────┘" -ForegroundColor Cyan

$here = $PSScriptRoot

# ═══════════════════════════════════════════════════════ 1. 校验安装包完整性
# 这一步不是形式主义：一个「缺文件的插件包」曾把 DSH 装到起不来
# （客户端模块组装失败 → 核心条目不可自动禁用 → 全站停机）。
# 所以宁可在装之前就停下。
Head "① 校验安装包"

$pkgDir = Join-Path $here 'plugin'
if (-not (Test-Path $pkgDir)) { Fail "安装包不完整：找不到 plugin 目录。请重新解压整个压缩包再运行。" }

$manifestPath = Join-Path $here 'MANIFEST.json'
$manifest = $null
if (Test-Path $manifestPath) {
  try { $manifest = [System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json }
  catch { Fail "MANIFEST.json 无法解析，安装包可能已损坏。请重新下载。" }
}

$missing = @()
$corrupt = @()
if ($manifest -and $manifest.files) {
  foreach ($f in $manifest.files) {
    $full = Join-Path $here ($f.path -replace '/', '\')
    if (-not (Test-Path $full)) { $missing += $f.path; continue }
    $h = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLower()
    if ($h -ne $f.sha256.ToLower()) { $corrupt += $f.path }
  }
} else {
  Warn "包内没有 MANIFEST.json，跳过逐文件校验。"
}

if ($missing.Count -gt 0) {
  Write-Host ""
  Write-Host "  安装包缺少以下文件：" -ForegroundColor Red
  foreach ($m in $missing) { Write-Host "      $m" -ForegroundColor Red }
  Fail "请不要只解压一部分，或换个方式重新下载。"
}
if ($corrupt.Count -gt 0) {
  Write-Host ""
  Write-Host "  以下文件内容与清单不符（可能传输损坏或被改动）：" -ForegroundColor Red
  foreach ($c in $corrupt) { Write-Host "      $c" -ForegroundColor Red }
  Fail "为安全起见已中止安装。"
}
if ($manifest -and $manifest.files) { Ok "逐文件校验通过（$($manifest.files.Count) 个文件）" }

# 自洽性：声明了 dsh.client 就必须真的有 ./client 导出与对应文件
$pkgJsonPath = Join-Path $pkgDir 'package.json'
if (-not (Test-Path $pkgJsonPath)) { Fail "plugin\package.json 不存在，安装包已损坏。" }
try { $pkg = [System.IO.File]::ReadAllText($pkgJsonPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json }
catch { Fail "plugin\package.json 不是合法 JSON，安装包已损坏。" }

$hasClient = $false
if ($pkg.dsh -and $pkg.dsh.PSObject.Properties.Name -contains 'client' -and $pkg.dsh.client) { $hasClient = $true }

if ($hasClient) {
  $clientRel = $null
  if ($pkg.exports -and ($pkg.exports.PSObject.Properties.Name -contains './client')) {
    $clientRel = $pkg.exports.'./client'
  }
  if (-not $clientRel) {
    Fail "package.json 声明了 dsh.client，但 exports 里没有 `"./client`"。`n      这种包会让 DSH 的客户端模块组装失败，直接导致 DSH 起不来，已中止安装。"
  }
  $clientFile = Join-Path $pkgDir ($clientRel -replace '^\./', '' -replace '/', '\')
  if (-not (Test-Path $clientFile)) {
    Fail "exports 指向的客户端文件不存在：$clientRel`n      安装它会让 DSH 起不来，已中止。"
  }
  Ok "客户端入口自洽（exports""./client"" -> $clientRel）"
} else {
  Ok "纯宿主插件（未声明 dsh.client）"
}

# ═══════════════════════════════════════════════════════ 2. 定位 DSH 主目录
Head "② 定位 DSH"

$candidates = @()
if (-not [string]::IsNullOrWhiteSpace($DshHome)) { $candidates += $DshHome }
foreach ($c in @("$env:USERPROFILE\.dsh", "$env:USERPROFILE\dsh", "$env:APPDATA\dsh", "$env:LOCALAPPDATA\dsh")) {
  if (-not [string]::IsNullOrWhiteSpace($c)) { $candidates += $c }
}

$found = $null
foreach ($c in $candidates) {
  if ([string]::IsNullOrWhiteSpace($c)) { continue }
  if (-not (Test-Path $c)) { continue }
  $probe = Join-Path $c 'profiles'
  if (Test-Path $probe) {
    $sub = @(Get-ChildItem $probe -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName 'package.json') })
    if ($sub.Count -gt 0) { $found = [System.IO.Path]::GetFullPath($c); break }
  }
}

if (-not $found) {
  Write-Host ""
  Write-Host "  找不到 DSH 的主目录。试过这些位置：" -ForegroundColor Yellow
  foreach ($c in $candidates) { if ($c) { Write-Host "      $c" -ForegroundColor DarkGray } }
  Write-Host ""
  Write-Host "  请手工指定，例如：" -ForegroundColor Yellow
  Write-Host "      powershell -ExecutionPolicy Bypass -File install.ps1 -DshHome `"C:\你的\DSH\home`"" -ForegroundColor White
  Fail "未找到 DSH 主目录。"
}
Ok "DSH_HOME = $found"

# ═══════════════════════════════════════════════════════ 3. 定位 profile
Head "③ 定位 profile"

$profilesRoot = Join-Path $found 'profiles'
$avail = @(Get-ChildItem $profilesRoot -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName 'package.json') })

if (-not [string]::IsNullOrWhiteSpace($Profile)) {
  $profileDir = Join-Path $profilesRoot $Profile
  if (-not (Test-Path (Join-Path $profileDir 'package.json'))) {
    Fail "profile `"$Profile`" 不存在。可用的有：$(($avail | ForEach-Object { $_.Name }) -join ', ')"
  }
} elseif ($avail.Count -eq 1) {
  $profileDir = $avail[0].FullName
  $Profile = $avail[0].Name
} elseif (@($avail | Where-Object { $_.Name -eq 'web' }).Count -eq 1) {
  $profileDir = Join-Path $profilesRoot 'web'
  $Profile = 'web'
} elseif ($avail.Count -eq 0) {
  Fail "在 $profilesRoot 下没有找到任何可用的 profile。"
} else {
  Write-Host ""
  Write-Host "  有多个 profile，请用 -Profile 指定要用哪个：" -ForegroundColor Yellow
  foreach ($p in $avail) { Write-Host "      $($p.Name)" -ForegroundColor White }
  Fail "profile 不明确。"
}
Ok "profile = $Profile"

$profilePkg   = Join-Path $profileDir 'package.json'
$profilePatch = Join-Path $profileDir 'cordis.patch.yml'

# ═══════════════════════════════════════════════════════ 4. 复制插件本体
Head "④ 安装插件文件"

$target = Join-Path $found "plugins\$PluginName"
if (Test-Path $target) {
  $ti = Get-Item $target -Force
  if ($ti.LinkType) {
    Warn "$target 是一个链接（$($ti.LinkType)）。本安装器不会顺着链接写。"
    Write-Host "      请先手工处理该链接，然后重跑本安装。"
    Fail "目标位置被占用。"
  }
  Info "目标目录已存在，将覆盖其中的同名文件"
}
New-Item -ItemType Directory -Force -Path $target | Out-Null

# 只复制 plugin 目录里的内容，不删目标目录里的其他文件
Get-ChildItem $pkgDir -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($pkgDir.Length).TrimStart('\')
  $dst = Join-Path $target $rel
  $dstDir = Split-Path $dst -Parent
  if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Force -Path $dstDir | Out-Null }
  Copy-Item -LiteralPath $_.FullName -Destination $dst -Force
}
$copied = @(Get-ChildItem $pkgDir -Recurse -File).Count
Ok "已复制 $copied 个文件到 plugins\$PluginName"

# ═══════════════════════════════════════════════════════ 5. junction
Head "⑤ 建立 node_modules 链接"

$nmDir = Join-Path $profileDir 'node_modules'
if (-not (Test-Path $nmDir)) { New-Item -ItemType Directory -Force -Path $nmDir | Out-Null }
$link = Join-Path $nmDir $PluginName

if (Test-Path $link) {
  $ex = Get-Item $link -Force
  if ($ex.LinkType -eq 'Junction' -or $ex.LinkType -eq 'SymbolicLink') {
    $cur = @($ex.Target)[0]
    if ($cur -and ([System.IO.Path]::GetFullPath($cur) -eq [System.IO.Path]::GetFullPath($target))) {
      Ok "链接已正确指向目标"
    } else {
      Remove-Item $link -Force -Recurse
      New-Item -ItemType Junction -Path $link -Target $target | Out-Null
      Ok "链接已重新指向 plugins\$PluginName"
    }
  } else {
    Warn "$link 是一个真实目录（可能是 pnpm 装的）。已保留不动。"
    Warn "如果它是本插件的旧副本，请手工删除后再重跑。"
  }
} else {
  New-Item -ItemType Junction -Path $link -Target $target | Out-Null
  Ok "链接已创建"
}

# ═══════════════════════════════════════════════════════ 6. 注册到启动清单
Head "⑥ 注册到 DSH 启动清单"

Copy-Item $profilePkg "$profilePkg.bak-$PluginName" -Force
$raw = [System.IO.File]::ReadAllText($profilePkg, [System.Text.Encoding]::UTF8)
$pp = $raw | ConvertFrom-Json

if (-not $pp.dsh) { $pp | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force }
if (-not $pp.dsh.profile) { $pp.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force }

$bundles = @()
if ($pp.dsh.profile.bundles) { $bundles = @($pp.dsh.profile.bundles) }
if ($bundles -contains $PluginName) {
  Info "启动清单里已有本插件（将原地更新）"
} else {
  $pp.dsh.profile.bundles = @($bundles + $PluginName)
  Ok "已加入启动清单"
}

if (-not $pp.dependencies) { $pp | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force }
$depValue = 'file:./node_modules/' + $PluginName
if ($pp.dependencies.PSObject.Properties.Name -contains $PluginName) {
  Info "依赖项已存在"
} else {
  $pp.dependencies | Add-Member -NotePropertyName $PluginName -NotePropertyValue $depValue -Force
  Ok "已登记依赖项"
}

[System.IO.File]::WriteAllText($profilePkg, ($pp | ConvertTo-Json -Depth 12), (New-Object System.Text.UTF8Encoding($false)))

# 写完必须读回验证 —— 不信任何没有回读的写入
$check = [System.IO.File]::ReadAllText($profilePkg, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
if (-not (@($check.dsh.profile.bundles) -contains $PluginName)) {
  Copy-Item "$profilePkg.bak-$PluginName" $profilePkg -Force
  Fail "写入校验失败，已还原 profile 配置。"
}
Ok "写入回读校验通过（备份：$PluginName.bak）"

# ═══════════════════════════════════════════════════════ 7. 双重挂载检查
Head "⑦ 检查冲突"

if (Test-Path $profilePatch) {
  $pt = [System.IO.File]::ReadAllText($profilePatch, [System.Text.Encoding]::UTF8)
  $hitName = $pt -match "name:\s*'?$([regex]::Escape($PluginName))'?"
  $hitId   = $false
  if ($EntryId) { $hitId = $pt -match "(?m)^\s*-?\s*id:\s*'?$([regex]::Escape($EntryId))'?\s*$" }
  if ($hitName -or $hitId) {
    Warn "profile 的 cordis.patch.yml 里还有一条针对本插件的手工挂载。"
    Warn "这与启动清单是两条通道，同时存在会「双重挂载」并导致 DSH 启动失败。"
    Write-Host "      请删掉这个文件里的对应 insert 块：" -ForegroundColor Yellow
    Write-Host "      $profilePatch" -ForegroundColor White
  } else {
    Ok "没有冲突的手工挂载"
  }
} else {
  Ok "profile 没有 cordis.patch.yml（正常）"
}

# ═══════════════════════════════════════════════════════ 完成
Write-Host ""
Write-Host "  ────────────────────────────────────────────────" -ForegroundColor DarkGray
if ($script:problems -gt 0) {
  Write-Host "  安装完成，但有 $($script:problems) 条提醒需要你看一眼。" -ForegroundColor Yellow
} else {
  Write-Host "  安装完成 ✓" -ForegroundColor Green
}
Write-Host ""
Write-Host "  下一步：重启 DSH" -ForegroundColor White
Write-Host "      插件是在 DSH 启动时装载的，所以现在还没生效。" -ForegroundColor Gray
Write-Host "      在 DSH 里正常重启一次即可。" -ForegroundColor Gray
Write-Host ""
Write-Host "  出问题怎么办：" -ForegroundColor White
Write-Host "      卸载：双击「一键卸载.cmd」，或运行 uninstall.ps1" -ForegroundColor Gray
Write-Host "      profile 配置的备份在：$profilePkg.bak-$PluginName" -ForegroundColor DarkGray
Write-Host ""
exit 0
