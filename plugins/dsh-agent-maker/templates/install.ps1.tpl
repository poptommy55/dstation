# =============================================================================
#  智能体安装程序（Windows / PowerShell）
#
#  ⚠️ 本文件必须以 UTF-8 **带 BOM** 保存。
#     Windows PowerShell 5.1 读取「无 BOM 的 UTF-8 .ps1」时会当成 ANSI，
#     中文会变成乱码并直接导致语法错误（实测）。导出工具会自动加 BOM。
#
#  直接双击「一键安装.cmd」即可，不需要命令行。
#
#  手工用法：
#     powershell -ExecutionPolicy Bypass -File install.ps1
#     powershell -ExecutionPolicy Bypass -File install.ps1 -DshHome "D:\DSH\home"
#     powershell -ExecutionPolicy Bypass -File install.ps1 -KeepExisting
#
#  这个脚本只做一件事：把智能体目录放进 <DSH_HOME>\.agent-presets\<id>\。
#  它**不碰** profile、node_modules、junction、插件清单 —— 装智能体不会
#  影响对方已经装好的任何插件。
# =============================================================================

[CmdletBinding()]
param(
  [string]$DshHome = $env:DSH_HOME,
  [switch]$KeepExisting
)

$ErrorActionPreference = 'Stop'

$AgentNames = '@@AGENT_NAMES@@'
$AgentCount = '@@AGENT_COUNT@@'
$BuiltAt    = '@@BUILT_AT@@'
$SourceHome = '@@SOURCE_HOME@@'

function Fail($m) { Write-Host ""; Write-Host "  [X] $m" -ForegroundColor Red; Write-Host ""; exit 1 }
function Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Info($m) { Write-Host "  -  $m" -ForegroundColor Gray }
function Warn($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Head($m) { Write-Host ""; Write-Host $m -ForegroundColor Cyan }

Write-Host ""
Write-Host "  ==================================================" -ForegroundColor Cyan
Write-Host "   智能体安装包" -ForegroundColor Cyan
Write-Host "   $AgentNames" -ForegroundColor White
Write-Host "   $AgentCount 个智能体 · 打包于 $BuiltAt" -ForegroundColor DarkGray
Write-Host "  ==================================================" -ForegroundColor Cyan

$here = $PSScriptRoot

# ═══════════════════════════════════════════════ ① 校验安装包本身
Head "① 校验安装包"

$agentDir = Join-Path $here 'agent'
if (-not (Test-Path $agentDir)) {
  Fail "安装包不完整：找不到 agent 目录。请重新解压**整个**压缩包再运行。"
}

$manifestPath = Join-Path $here 'MANIFEST.json'
if (-not (Test-Path $manifestPath)) {
  Fail "安装包不完整：找不到 MANIFEST.json。请重新解压整个压缩包。"
}

$manifest = $null
try {
  $rawJson = [System.IO.File]::ReadAllText($manifestPath, [System.Text.Encoding]::UTF8)
  $manifest = $rawJson | ConvertFrom-Json
} catch {
  Fail "MANIFEST.json 无法解析，安装包可能已损坏。请让打包方重新导出一份。"
}

if (-not $manifest.agents) { Fail "MANIFEST.json 里没有 agents 列表，安装包已损坏。" }
$agents = @($manifest.agents)
if ($agents.Count -eq 0) { Fail "MANIFEST.json 里的 agents 列表是空的。" }

$missing = @()
$corrupt = @()
$allFiles = @()
foreach ($a in $agents) {
  foreach ($f in @($a.files)) { $allFiles += $f }
}

foreach ($f in $allFiles) {
  $full = Join-Path $here ($f.path -replace '/', '\')
  if (-not (Test-Path $full)) { $missing += $f.path; continue }
  $h = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLower()
  if ($h -ne $f.sha256.ToLower()) { $corrupt += $f.path }
}

if ($missing.Count -gt 0) {
  Write-Host ""
  Write-Host "  安装包缺少以下文件：" -ForegroundColor Red
  foreach ($m in $missing) { Write-Host "      $m" -ForegroundColor Red }
  Fail "请不要只解压一部分，或换个方式重新传一遍文件。"
}
if ($corrupt.Count -gt 0) {
  Write-Host ""
  Write-Host "  以下文件内容与清单不符（可能传输损坏，或被改动过）：" -ForegroundColor Red
  foreach ($c in $corrupt) { Write-Host "      $c" -ForegroundColor Red }
  Fail "为安全起见已中止安装。请让打包方重新导出一份。"
}
Ok "逐文件校验通过（$($allFiles.Count) 个文件，sha256 全部吻合）"

# ═══════════════════════════════════════════════ ② 定位 DSH 主目录
Head "② 定位 D-STATION 数据目录"

$candidates = @()
if (-not [string]::IsNullOrWhiteSpace($DshHome)) { $candidates += $DshHome }
foreach ($c in @("$env:USERPROFILE\.dsh", "$env:USERPROFILE\dsh", "$env:APPDATA\dsh",
                 "$env:LOCALAPPDATA\dsh", "$env:APPDATA\D-STATION\home",
                 "$env:LOCALAPPDATA\D-STATION\home", "C:\D-STATION\home", "D:\D-STATION\home")) {
  if (-not [string]::IsNullOrWhiteSpace($c)) { $candidates += $c }
}

$found = $null
foreach ($c in $candidates) {
  if ([string]::IsNullOrWhiteSpace($c)) { continue }
  if (-not (Test-Path $c)) { continue }
  if (Test-Path (Join-Path $c 'profiles')) { $found = [System.IO.Path]::GetFullPath($c); break }
}

if (-not $found) {
  Write-Host ""
  Write-Host "  找不到 D-STATION 的数据目录。试过这些位置：" -ForegroundColor Yellow
  foreach ($c in $candidates) { if ($c) { Write-Host "      $c" -ForegroundColor DarkGray } }
  Write-Host ""
  Write-Host "  请手工指定（把下面的路径换成你的实际路径）：" -ForegroundColor Yellow
  Write-Host "      powershell -ExecutionPolicy Bypass -File install.ps1 -DshHome `"C:\你的\D-STATION\home`"" -ForegroundColor White
  Write-Host ""
  Write-Host "  小提示：在 D-STATION 里随便开一个会话，工作目录的上级通常就是它。" -ForegroundColor DarkGray
  Fail "未找到 D-STATION 数据目录。"
}
Ok "DSH_HOME = $found"

# ═══════════════════════════════════════════════ ③ 安装
Head "③ 安装智能体"

$presetsRoot = Join-Path $found '.agent-presets'
$backupRoot  = Join-Path $found 'agent-preset-backups'
if (-not (Test-Path $presetsRoot)) {
  New-Item -ItemType Directory -Path $presetsRoot -Force | Out-Null
  Info "已创建目录 $presetsRoot"
}
Ok "智能体目录 = $presetsRoot"

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$installed = 0
$skipped = 0
$destList = @()

foreach ($a in $agents) {
  $id = $a.id
  $srcDir = Join-Path $here ($a.dir -replace '/', '\')
  $dest = Join-Path $presetsRoot $id

  if (-not (Test-Path $srcDir)) {
    Fail "安装包里找不到智能体「$id」的目录（$($a.dir)）。安装包已损坏。"
  }

  if (Test-Path $dest) {
    if ($KeepExisting) {
      Warn "已存在同名智能体「$id」，按 -KeepExisting 保留原样，跳过。"
      $skipped++
      continue
    }
    # 备份到 .agent-presets **之外**：
    # 放在里面会被 DSH 当成一个额外的智能体扫出来，SUPER AGENTS 里就会出现重复项。
    if (-not (Test-Path $backupRoot)) { New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null }
    $bak = Join-Path $backupRoot ("$id-$stamp")
    try {
      Copy-Item -LiteralPath $dest -Destination $bak -Recurse -Force
      Warn "已存在同名智能体「$id」，原版本已备份到："
      Info "$bak"
      Info "（确认新版本没问题后，可以自行删除这个备份目录）"
    } catch {
      Fail "备份已有智能体「$id」失败，为免丢数据已中止：$($_.Exception.Message)"
    }
    Remove-Item -LiteralPath $dest -Recurse -Force
  }

  New-Item -ItemType Directory -Path $dest -Force | Out-Null

  foreach ($f in @($a.files)) {
    $rel = $f.path
    $prefix = $a.dir + '/'
    if (-not $rel.StartsWith($prefix)) { Fail "清单里的路径与智能体目录不匹配：$rel" }
    $sub = $rel.Substring($prefix.Length) -replace '/', '\'
    $target = Join-Path $dest $sub
    $targetParent = Split-Path -Parent $target
    if (-not (Test-Path $targetParent)) { New-Item -ItemType Directory -Path $targetParent -Force | Out-Null }
    Copy-Item -LiteralPath (Join-Path $here ($rel -replace '/', '\')) -Destination $target -Force
  }

  # 写回后重新校验：确认落盘的内容与清单一致（不是只信"拷贝没报错"）
  $bad = @()
  foreach ($f in @($a.files)) {
    $prefix = $a.dir + '/'
    $sub = $f.path.Substring($prefix.Length) -replace '/', '\'
    $target = Join-Path $dest $sub
    if (-not (Test-Path $target)) { $bad += $f.path; continue }
    $h = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLower()
    if ($h -ne $f.sha256.ToLower()) { $bad += $f.path }
  }
  if ($bad.Count -gt 0) {
    Fail "智能体「$id」写入后有 $($bad.Count) 个文件与清单不符，安装可能不完整。请重试或联系打包方。"
  }

  $label = $a.name
  if ([string]::IsNullOrWhiteSpace($label)) { $label = $id }
  Ok "已安装「$label」($id) —— $(@($a.files).Count) 个文件"
  $destList += $dest
  $installed++
}

Write-Host ""
Write-Host "  安装位置：" -ForegroundColor Gray
foreach ($d in $destList) { Write-Host "      $d" -ForegroundColor DarkGray }

# ═══════════════════════════════════════════════ ④ 依赖清单
$depFile = Join-Path $here '依赖清单.txt'
if (Test-Path $depFile) {
  Head "④ 依赖清单（重要，请读一下）"
  try {
    $depText = [System.IO.File]::ReadAllText($depFile, [System.Text.Encoding]::UTF8)
    foreach ($line in ($depText -split "`r?`n")) { Write-Host "  $line" -ForegroundColor Gray }
  } catch {
    Warn "依赖清单读取失败，请手工打开包里的「依赖清单.txt」。"
  }
}

# ═══════════════════════════════════════════════ ⑤ 收尾
Head "⑤ 完成"
$summary = "成功安装 $installed 个智能体"
if ($skipped -gt 0) { $summary = $summary + "，跳过 $skipped 个（已存在，按 -KeepExisting 保留）" }
Ok $summary
Write-Host ""
Write-Host "  接下来怎么做：" -ForegroundColor White
Write-Host "    1. 打开 D-STATION，点侧边栏底部的「智能体工作台」" -ForegroundColor Gray
Write-Host "    2. 新装的智能体会出现在 SUPER AGENTS 分区里" -ForegroundColor Gray
Write-Host "    3. 如果没看到，把 D-STATION 完全退出再启动一次（智能体目录在启动时扫描）" -ForegroundColor Gray
Write-Host ""
Write-Host "  装错了想撤销：删掉 .agent-presets 里对应的文件夹即可，" -ForegroundColor DarkGray
Write-Host "  被覆盖的旧版本在 agent-preset-backups 里。" -ForegroundColor DarkGray
Write-Host ""

exit 0
