# export.mjs 产出的分发包 —— 端到端安装测试
#
# 重点不是「正常能装上」，而是**「坏包必须被拦住」**：
# 一个缺文件的插件包曾经把 DSH 装到完全起不来，所以安装器的自检必须真的有效。
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File test-export.ps1
#   powershell -ExecutionPolicy Bypass -File test-export.ps1 -PluginDir "C:\path\to\some-plugin"

[CmdletBinding()]
param(
    [string]$PluginDir = ''
)

$ErrorActionPreference = 'Stop'
$tools = $PSScriptRoot

# 默认找一个可用的插件来打包测试（开发布局是同级目录）
if ([string]::IsNullOrWhiteSpace($PluginDir)) {
    $cands = @(
        (Join-Path $tools '..\..\..\skill-sessions\dsh-wallpaper'),
        (Join-Path $tools '..\dsh-wallpaper'),
        (Join-Path $env:DSH_HOME 'plugins\dsh-wallpaper')
    )
    foreach ($c in $cands) {
        if ($c -and (Test-Path (Join-Path $c 'package.json'))) { $PluginDir = [System.IO.Path]::GetFullPath($c); break }
    }
}
if ([string]::IsNullOrWhiteSpace($PluginDir) -or -not (Test-Path (Join-Path $PluginDir 'package.json'))) {
    Write-Host "找不到可用的测试插件。请用 -PluginDir 指定一个含 package.json 的插件目录。" -ForegroundColor Red
    exit 1
}

$work = Join-Path $env:TEMP ("export-test-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $work | Out-Null

$script:pass = 0
$script:fail = 0
$script:fails = @()

function Check($name, $cond, $msg) {
    if ($cond) {
        $script:pass++
        Write-Host "  ok   $name" -ForegroundColor Green
    } else {
        $script:fail++
        $script:fails += "$name`n        $msg"
        Write-Host "  FAIL $name`n        $msg" -ForegroundColor Red
    }
}

function NewFakeHome($path, [switch]$Pristine) {
    if (Test-Path $path) { Remove-Item $path -Recurse -Force }
    New-Item -ItemType Directory -Force -Path (Join-Path $path 'profiles\web') | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $path 'plugins') | Out-Null
    $pkg = @{
        name = 'web'
        version = '0.0.0'
        dsh = @{ profile = @{ bundles = @() } }
        dependencies = @{}
    } | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText((Join-Path $path 'profiles\web\package.json'), $pkg, (New-Object System.Text.UTF8Encoding($false)))
    return $path
}

# 用**真子进程**跑 install.ps1，而不是 `& $script`。两个原因：
#   1. 安装器的提示全走 Write-Host，而 Write-Host **不进管道** ——
#      `& $s 2>&1` 一个字都抓不到（第一版就栽在这：行为全对，断言全空）。
#   2. 双击「一键安装.cmd」走的就是 `powershell -File`，子进程方式测的是同一条路。
#
# 参数名也不能叫 $home —— 那是 PowerShell 的只读自动变量 $HOME
# （与坑 #53 的 $remote/$Remote 同类）。
function RunInstall($pkgDir, $DshHomePath, [switch]$NoHome) {
    $s = Join-Path $pkgDir 'install.ps1'
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $s)
    if (-not $NoHome) { $a += @('-DshHome', $DshHomePath) }
    $out = (& powershell @a 2>&1 | Out-String)
    return @{ code = $LASTEXITCODE; text = $out }
}

function RunUninstall($pkgDir, $DshHomePath, [switch]$RemovePackage) {
    $s = Join-Path $pkgDir 'uninstall.ps1'
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $s, '-DshHome', $DshHomePath)
    if ($RemovePackage) { $a += '-RemovePackage' }
    $out = (& powershell @a 2>&1 | Out-String)
    return @{ code = $LASTEXITCODE; text = $out }
}

function ExpandPkg($zipPath, $dest) {
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    Expand-Archive -LiteralPath $zipPath -DestinationPath $dest -Force:$false
    $sub = @(Get-ChildItem $dest -Directory)
    if ($sub.Count -ne 1) { throw "解压后顶层目录数不是 1，而是 $($sub.Count)" }
    return $sub[0].FullName
}

Write-Host ""
Write-Host "分发包安装测试" -ForegroundColor Cyan

# ═══════════════════════════════════════ 先导出三个包
Write-Host ""
Write-Host "· 准备测试包 …" -ForegroundColor DarkGray

$zips = Join-Path $work 'zips'
$goodZip = (node (Join-Path $tools 'export.mjs') $PluginDir `
    --name "窗口背景" --where "设置 → 通用 → 窗口背景" --out $zips | Out-String)
$goodZipPath = Join-Path $zips 'dsh-wallpaper-1.0.0-分发包.zip'
Check "导出正常包" (Test-Path $goodZipPath) "没有产出 $goodZipPath"

# ═══════════════════════════════════════ 1. 中文文件名是否活着
Write-Host ""
$ex = Join-Path $work 'ex1'
$pkgDir = ExpandPkg $goodZipPath $ex
$names = @(Get-ChildItem $pkgDir | Select-Object -ExpandProperty Name)
Write-Host "解压后的顶层内容：$($names -join ' / ')" -ForegroundColor DarkGray
Check "中文文件名在解压后完好（一键安装.cmd）" ($names -contains '一键安装.cmd') "实际：$($names -join ', ')"
Check "中文文件名在解压后完好（安装说明.txt）" ($names -contains '安装说明.txt') "实际：$($names -join ', ')"
Check "包内有 MANIFEST.json" ($names -contains 'MANIFEST.json') "实际：$($names -join ', ')"
Check "包内有 plugin 目录" ($names -contains 'plugin') "实际：$($names -join ', ')"

# ═══════════════════════════════════════ 2. 正常安装
Write-Host ""
$home1 = NewFakeHome (Join-Path $work 'home1')
$r = RunInstall $pkgDir $home1
Check "正常安装退出码为 0" ($r.code -eq 0) "退出码 $($r.code)`n$($r.text)"
Check "插件文件已落到 plugins\dsh-wallpaper" (Test-Path (Join-Path $home1 'plugins\dsh-wallpaper\package.json')) "文件不在"
Check "客户端文件也在" (Test-Path (Join-Path $home1 'plugins\dsh-wallpaper\client.js')) "client.js 不在"
$link = Join-Path $home1 'profiles\web\node_modules\dsh-wallpaper'
Check "node_modules 链接已建立" (Test-Path $link) "链接不在"
if (Test-Path $link) {
    $li = Get-Item $link -Force
    Check "链接类型是 Junction" ($li.LinkType -eq 'Junction') "实际 $($li.LinkType)"
    Check "链接能解析到 package.json" (Test-Path (Join-Path $link 'package.json')) "解析不到"
}
$pp = [System.IO.File]::ReadAllText((Join-Path $home1 'profiles\web\package.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
Check "已登记进 dsh.profile.bundles" (@($pp.dsh.profile.bundles) -contains 'dsh-wallpaper') "bundles = $(@($pp.dsh.profile.bundles) -join ',')"
Check "已登记进 dependencies" ($pp.dependencies.PSObject.Properties.Name -contains 'dsh-wallpaper') "依赖里没有"
Check "profile 备份已生成" (Test-Path (Join-Path $home1 'profiles\web\package.json.bak-dsh-wallpaper')) "没有备份"

# ═══════════════════════════════════════ 3. 幂等
Write-Host ""
$r2 = RunInstall $pkgDir $home1
$pp2 = [System.IO.File]::ReadAllText((Join-Path $home1 'profiles\web\package.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
Check "重复安装退出码为 0" ($r2.code -eq 0) "退出码 $($r2.code)"
Check "重复安装不会重复登记 bundles" (@($pp2.dsh.profile.bundles | Where-Object { $_ -eq 'dsh-wallpaper' }).Count -eq 1) "出现了 $(@($pp2.dsh.profile.bundles | Where-Object { $_ -eq 'dsh-wallpaper' }).Count) 次"

# ═══════════════════════════════════════ 4. 缺文件必须被拦
Write-Host ""
$ex2 = Join-Path $work 'ex2'
$badDir = ExpandPkg $goodZipPath $ex2
Remove-Item (Join-Path $badDir 'plugin\client.js') -Force
$home2 = NewFakeHome (Join-Path $work 'home2')
$r3 = RunInstall $badDir $home2
Check "★ 缺文件时安装失败（退出码非 0）" ($r3.code -ne 0) "居然成功了，退出码 $($r3.code)"
Check "★ 缺文件时给出可读原因" ($r3.text -match '缺少|清单不符|不完整') "输出里没有说明：$($r3.text.Substring(0, [Math]::Min(300, $r3.text.Length)))"
Check "★ 缺文件时不留下半成品（bundles 未被改）" (@((([System.IO.File]::ReadAllText((Join-Path $home2 'profiles\web\package.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json)).dsh.profile.bundles).Count -eq 0) "bundles 被改了"

# ═══════════════════════════════════════ 5. 内容被篡改必须被拦
Write-Host ""
$ex3 = Join-Path $work 'ex3'
$tamperDir = ExpandPkg $goodZipPath $ex3
$target = Join-Path $tamperDir 'plugin\index.js'
$orig = [System.IO.File]::ReadAllBytes($target)
$tampered = New-Object byte[] $orig.Length
[Array]::Copy($orig, $tampered, $orig.Length)
$tampered[0] = $tampered[0] -bxor 0xFF
[System.IO.File]::WriteAllBytes($target, $tampered)
$home3 = NewFakeHome (Join-Path $work 'home3')
$r4 = RunInstall $tamperDir $home3
Check "★ 文件被篡改时安装失败" ($r4.code -ne 0) "居然成功了"
Check "★ 篡改时指出是哪个文件" ($r4.text -match 'index\.js') "输出里没点名：$($r4.text.Substring(0, [Math]::Min(300, $r4.text.Length)))"

# ═══════════════════════════════════════ 6. 缺 exports["./client"] 必须被拦（全站停机闸门）
Write-Host ""
$ex4 = Join-Path $work 'ex4'
$brokenDir = ExpandPkg $goodZipPath $ex4
$bp = Join-Path $brokenDir 'plugin\package.json'
$bpObj = [System.IO.File]::ReadAllText($bp, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$bpObj.exports.PSObject.Properties.Remove('./client')
[System.IO.File]::WriteAllText($bp, ($bpObj | ConvertTo-Json -Depth 12), (New-Object System.Text.UTF8Encoding($false)))
# 同步改 MANIFEST，否则会先被 sha256 拦下来，测不到这条
$mf = [System.IO.File]::ReadAllText((Join-Path $brokenDir 'MANIFEST.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
foreach ($f in $mf.files) {
    if ($f.path -eq 'plugin/package.json') {
        $f.size = (Get-Item $bp).Length
        $f.sha256 = (Get-FileHash $bp -Algorithm SHA256).Hash.ToLower()
    }
}
[System.IO.File]::WriteAllText((Join-Path $brokenDir 'MANIFEST.json'), ($mf | ConvertTo-Json -Depth 12), (New-Object System.Text.UTF8Encoding($false)))
$home4 = NewFakeHome (Join-Path $work 'home4')
$r5 = RunInstall $brokenDir $home4
Check "★ 缺 exports[`"./client`"] 的坏包被拦下（防全站停机）" ($r5.code -ne 0) "居然装进去了"
Check "★ 并说明原因" ($r5.text -match 'exports|起不来') "输出没解释：$($r5.text.Substring(0, [Math]::Min(400, $r5.text.Length)))"

# ═══════════════════════════════════════ 7. 双重挂载告警
Write-Host ""
$home5 = NewFakeHome (Join-Path $work 'home5')
$patch = Join-Path $home5 'profiles\web\cordis.patch.yml'
[System.IO.File]::WriteAllText($patch, "- insert:`n    - id: wallpaper`n      name: 'dsh-wallpaper'`n", (New-Object System.Text.UTF8Encoding($false)))
$r6 = RunInstall $pkgDir $home5
Check "★ 检测到手工挂载并告警" ($r6.text -match '双重挂载|手工挂载') "没有告警：$($r6.text.Substring(0, [Math]::Min(400, $r6.text.Length)))"
Check "★ 告警时仍然装完（只是提醒）" ($r6.code -eq 0) "退出码 $($r6.code)"

# ═══════════════════════════════════════ 8. DSH_HOME 自动探测
Write-Host ""
$home6 = NewFakeHome (Join-Path $work 'home6')
$oldHome = $env:DSH_HOME
$env:DSH_HOME = $home6
$r7 = RunInstall $pkgDir '' -NoHome
$env:DSH_HOME = $oldHome
Check "★ 靠 DSH_HOME 环境变量自动找到（不传参数）" ($r7.code -eq 0 -and (Test-Path (Join-Path $home6 'plugins\dsh-wallpaper\package.json'))) "退出码 $($r7.code)`n$($r7.text)"

# ═══════════════════════════════════════ 9. profile 自动选择
Write-Host ""
$home7 = NewFakeHome (Join-Path $work 'home7')
$r8 = RunInstall $pkgDir $home7
Check "★ 只有一个 profile 时自动选中" ($r8.text -match 'profile = web') "输出里没显示选中 web：$($r8.text.Substring(0, [Math]::Min(400, $r8.text.Length)))"

# ═══════════════════════════════════════ 10. 卸载
Write-Host ""
$ru = RunUninstall $pkgDir $home1
$uout = $ru.text
$ucode = $ru.code
Check "卸载退出码为 0" ($ucode -eq 0) "退出码 $ucode`n$uout"
Check "卸载后链接已移除" (-not (Test-Path (Join-Path $home1 'profiles\web\node_modules\dsh-wallpaper'))) "链接还在"
$pp3 = [System.IO.File]::ReadAllText((Join-Path $home1 'profiles\web\package.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
Check "卸载后 bundles 已清空" (@($pp3.dsh.profile.bundles).Count -eq 0) "还有 $(@($pp3.dsh.profile.bundles) -join ',')"
Check "卸载后依赖已清空" (-not ($pp3.dependencies.PSObject.Properties.Name -contains 'dsh-wallpaper')) "依赖还在"
Check "卸载默认保留插件目录" (Test-Path (Join-Path $home1 'plugins\dsh-wallpaper')) "被删了"

# ═══════════════════════════════════════ 11. 文件编码
Write-Host ""
$ps1Bytes = [System.IO.File]::ReadAllBytes((Join-Path $pkgDir 'install.ps1'))
Check "install.ps1 带 UTF-8 BOM" ($ps1Bytes[0] -eq 0xEF -and $ps1Bytes[1] -eq 0xBB -and $ps1Bytes[2] -eq 0xBF) "前三字节是 $($ps1Bytes[0..2] -join ',')"
$cmdBytes = [System.IO.File]::ReadAllBytes((Join-Path $pkgDir '一键安装.cmd'))
$hasNonAscii = ($cmdBytes | Where-Object { $_ -gt 127 }).Count -gt 0
Check "一键安装.cmd 是纯 ASCII（cmd.exe 用 OEM 代码页）" (-not $hasNonAscii) "含 $((($cmdBytes | Where-Object { $_ -gt 127 }).Count)) 个非 ASCII 字节"
$txtBytes = [System.IO.File]::ReadAllBytes((Join-Path $pkgDir '安装说明.txt'))
Check "安装说明.txt 带 UTF-8 BOM" ($txtBytes[0] -eq 0xEF -and $txtBytes[1] -eq 0xBB -and $txtBytes[2] -eq 0xBF) "前三字节是 $($txtBytes[0..2] -join ',')"
$txt = [System.IO.File]::ReadAllText((Join-Path $pkgDir '安装说明.txt'), [System.Text.Encoding]::UTF8)
Check "说明里的「在哪里看到」已被替换" ($txt -match '窗口背景' -and $txt -notmatch '@@') "模板变量没替换干净"

# ═══════════════════════════════════════
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ""
Write-Host "$($script:pass) 通过，$($script:fail) 失败" -ForegroundColor $(if ($script:fail) { 'Red' } else { 'Green' })
if ($script:fail) {
    Write-Host ""
    Write-Host "失败详情：" -ForegroundColor Red
    foreach ($f in $script:fails) { Write-Host "  - $f" -ForegroundColor Red }
    exit 1
}
exit 0
