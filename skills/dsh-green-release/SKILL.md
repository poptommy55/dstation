---
name: dsh-green-release
description: 把本地 D-STATION 打包成一份**干净的、不含任何 API KEY、拷到别的 Windows 机器上双击即用**的「绿色版」整包。含出厂态清理清单、DSH 自管软链接层这个致命坑、可移植性修复、自带运行时（Python/Git）补齐、启动验证方法论、zip 交付与校验。触发词：绿色版、便携版、打包整包、发布整包、出个干净版本、没有 API KEY 的版本、发给别人能直接跑、拷到别的电脑、离线安装包、绿色包、portable、打包给朋友。
whenToUse: 当用户说「出一份绿色版 / 便携版」「打包一份干净的给别人」「把这个 D-STATION 拷到别的机器上用」「做一个没有 API KEY 的版本」「做个离线整包」时；当用户装完新插件后想重新出一份整包时；当用户问「为什么拷到别的电脑起不来」时。只要涉及「把整个 D-STATION 打包交付给别的机器」，就加载本 Skill。
---

# 发布 D-STATION 绿色版（便携整包）

用户说一句「出一份绿色版发给我朋友」，剩下交给工具与脚本。
**你负责：选对清理边界、跑脚本、用启动证据证明它能用、把限制讲清楚。**

---

## 零、一句话流程

```
build-green.ps1（第 0 步含补丁闸门）  →  头less 启动验证  →  清掉验证痕迹  →  压 zip  →  报 SHA256
```

工具包位置：**`%DSH_HOME%\daily-use\`** 下的 `build-green.ps1` 与 `_green-build\`：

> ℹ️ **本 Skill 属于本地维护工具，不进对外分发的整包**：它引用的 `build-green.ps1` / `_green-build\`
> 都在工作区 `home\daily-use\` 里，而那个目录本身就在排除名单里。
> `build-green.ps1` 也已把 `home\skills\dsh-green-release` 显式排除。
> 想让它随包分发，就把那两条排除去掉（但接受收件人看到一份用不上的说明）。

| 路径 | 作用 |
|---|---|
| `build-green.ps1` | 一条命令出整包（**第 0 步补丁闸门**→复制→清数据→删自管链接层→装运行时→装插件→套出厂配置→自检报告） |
| `reapply-local-plugin-patches.ps1` | **本地补丁表**：第三方插件 patch 的单一真相源。幂等重放 / `-Check` 只检 / `-List` 列表 / `-Only <id>` 单条；被 OTA 或市场更新冲掉后跑它，见 §二·五 |
| `reapply-univer-media-type-patch.ps1` | 兼容转发器，只打 univer 那一条（旧的调用点仍可用） |
| `_green-build\templates\` | 出厂配置 4 件：`home\AGENTS.md`、`home\settings.yaml`、`profiles-web\cordis.patch.yml`、`首次使用-必读.txt`、`激活自带环境.cmd` |
| `_green-build\plugin\dsh-bundled-runtime\` | 自带运行时注入插件源码 |
| `_green-build\runtime-cache\` | Python / MinGit 安装包缓存（有它就不用联网） |
| `_green-build\verify-clean.ps1` | 成品校验（密钥 / 绝对路径 / 残留链接 / 结构） |
| `_green-build\test-runtime-plugin.ps1` | 启动验证 + `/dsh-bundled-runtime/health` 自检（支持 `-ScrubPath` 模拟干净机器） |

> ⚠️ `-Src` 默认指向**活着的安装目录**（= `%DSH_HOME%` 的上一级）。换机器/换部署时要显式传。

---

## 一、四条铁律（先看这四条）

1. **🔴 你自己双击试跑过的那个目录，绝不能直接压包发人。**
   跑一次会写进：`home\.credentials.yaml`（浏览器会话令牌）、`home\.anonymous-user-id`、
   `home\sessions\`、`home\storages\`，以及 **DSH 按你这台机器绝对路径重建的两层软链接**。
   发出去对方启动直接失败。**要么发现在这个 zip，要么重跑一次脚本再发。**
2. **绝不打印密钥。** 扫描只输出**文件名与命中条数**，永不回显命中行内容。
   校验口令：`has_key()` 这类只返回布尔值的写法。
3. **交付前必须真启动一次。** 没有启动证据的整包不算做完 —— 本项目历史上最快的失败
   （自管链接层被物化）**只有启动才能发现**，静态检查怎么查都是干净的。
4. **🔴 本地补丁必须在位，且不许手工绕过闸门。** 第三方插件上带着本地修复
   （`dsh-univer-office` 的截图附件 `mediaType`、`dsh-office-tools` 的沙箱策略透传 ⇒ 不修则
   会话每次请求都失败 / `word_*`·`excel_*` 写入被拒）。这些文件在 `node_modules` 里、git 管不到，
   **OTA 与市场更新都会静默还原**。`build-green.ps1` 第 0 步**自动补 + 复验**、
   `verify-clean.ps1` E 段**再验一次**。**源里没补丁就打包 = 把坏版本发给别人**，详见 §二·五。

---

## 二、出厂态清理表（照这个排，不要自己发挥）

| 类别 | 路径（相对 `<源安装目录>`） | 为什么 |
|---|---|---|
| **密钥** | `home\.credentials.yaml`、`home\.credentials.yaml.lock.bak-stale-*`、`home\skills\aces-system\.aceskey`、`home\.anonymous-user-id` | 明文 KEY / 身份标识。**`.aceskey.example` 要留**（它是空模板） |
| **技能凭证库** | `home\wechat-publisher\{accounts,tokens}.json`（公众号账号与 token） | 🔴 **不在 `.credentials.yaml` 里，最容易漏**。2026-09-19 实测：它**已经随包出去了一次**，因为：(a) 排除名单只按目录列，没列家目录根下的技能数据目录；(b) 文件名检查当时不认识 `tokens.json` / `accounts.json`；(c) 密钥格式扫描也抓不到 —— 微信 token 不是 `sk-` 形状，`tokens.json` 的键还是**动态 AppID**。**规矩**：凡是"技能自己在家目录根下建的账号/令牌/会话库"，一律按密钥处理 |
| **插件缓存** | `home\cache\`（如 `home\cache\dsh-univer-office\resources\*`） | 运行时下载缓存，非出厂态。内容无害，但会让 `home\` 一级多出一项、破坏交付清单 |
| **密钥备份** | `_backup\` | 里面可能有 `dsh-model-config-*\\.credentials.yaml.bak`（旧 KEY） |
| **个人数据** | `home\sessions\`、`home\storages\`、`home\attachments\`、`home\knowledge-bases\`、`home\daily-use\`、`home\super-agents\`、`home\agent-orchestration\`、`home\skill-sessions\`、`home\.agent-presets\`、`home\wallpapers\`、`home\telemetry\`、`home\llm-deepseek\` | 会话/工作区/知识库/自定义预设/壁纸/遥测 |
| **运行残留** | `launcher.log`、`launcher.lock`、`ota-update.log`、`electron-data\`、`backups\`、`ota-staging\`、`nul` | 日志含本机路径；`nul` 是历史脏文件 |
| **OTA 状态残留** | 根目录 `ota-tx.json`、`ota-index.json` | 两个都是**本机运行时状态**，且都写死了打包机的绝对路径（`ota-tx.json` 的 `snapshotDir`、`ota-index.json` 的 `base`）。删了安全：`ota-core.js` 的 `readIndex()` 读不到就当空索引，`readTx()` 失败返回 `null`，代价只是对方首次检查更新时要重建索引（一次性全量哈希）。**2026-09-17 新踩** |
| **第三方缓存** | `home\profiles\web\.dsh-market\` | 市场发现缓存 + 日志 |
| **开发者垃圾** | `profiles\web\node_modules\*_tmp_*\`（22 个）、`resources\app\*.bak-*`、`home\skills\*\__pycache__\` | pnpm 中断残留 / 手改备份 |
| **个人全局指令** | `home\AGENTS.md` | 换成中性出厂版（模板里有） |

**必须保留**：`app\`（内核）、`runtime\`（Node 等）、`locales\`、`resources\`、
`home\profiles\web\`（12 个 bundle + 全部插件依赖，约 1.2 GB）、`home\skills\`、`home\plugins\`、
`config.json`、`dsh-launcher.exe` 及全部 DLL/pak。

---

## 二·五、🔴 本地补丁闸门：第三方插件的 patch 表

**不是可选项。** 整包必须带上这些补丁；漏了就是把「坏版本」发出去。

这些补丁都打在**第三方市场插件**上（文件在 `node_modules` 里），所以 **git 管不到它们**，
而 OTA 与市场更新都会**静默还原**。它们的**单一真相源**是
`%DSH_HOME%\daily-use\reapply-local-plugin-patches.ps1` 里的 patch 表：

```powershell
powershell -ExecutionPolicy Bypass -File ".\reapply-local-plugin-patches.ps1" -List
```

| id | 插件 | 症状（不修会怎样） | 修法 |
|---|---|---|---|
| `univer-media-type` | `dsh-univer-office` | `univer_screenshot` 回填的附件描述符用了**渲染器声明的** `item.mediaType`（恒为 `image/png`），而附件仓库对**渲染后超过 `2048×2048 = 4,194,304` 像素**的截图会重编码（有 alpha → WebP，无 alpha → JPEG）；引用与磁盘对象不一致 ⇒ **该会话此后每一次请求**都在本地准备图片阶段抛 `ATTACHMENT_CORRUPT`/`INVALID_IMAGE`，被适配器包成 `DeepSeek API stream from https://api.deepseek.com failed`（`TRANSPORT`），**重试与重启都无效**（脏引用已写进会话历史）。2026-09-19 实际发生，一个会话整段报废 | `lib\index.js` 的 `image{ … mediaType: item.mediaType }` → `ref.mediaType`。⚠️ `saveImages` **入参**那个 `item.mediaType` 必须保留（声明输入字节类型，仓库靠它校验） |
| `office-tools-sandbox` | `dsh-office-tools` | `saveOfficeText` 调 `ctx.fs.writeText` 时**没透传会话沙箱策略**，沙箱解析不到会话 cwd ⇒ 只要会话工作区不在部署根下，`word_*` / `excel_*` 的**写**一律 `FS_SANDBOX_DENIED`（读不受影响） | 补上 `officeSandboxPolicy(ctx, exec)` 并作为 `writeText` 第 5 参传入 |

**三层保证它们随包走**：

| 层 | 机制 |
|---|---|
| 打包前 | `build-green.ps1` **第 0 步**先 `-Check`：缺补丁就调 patch 表**自动补 + 复验**，补不上才 `throw` 中止（中止发生在 `Remove-Item $Dst` **之前**，走不到 robocopy，**也不会毁掉上一份成品**）。`-NoAutoPatch` 改成"只报警不写入" |
| 打包后 | `_green-build\verify-clean.ps1` **E 段**直接 `-Check` 那个包（不再复制一份判定逻辑，避免漂移）：全部 `OK` ⇒ `PASS`，出现 `MISS`/`FAIL` ⇒ `FAIL` 并给出修复命令 |
| 被冲掉后 | patch 表幂等重放（退出码 `0` 成功/已打 · `2` 根路径不存在 · `3` 补丁缺失或锚点消失=上游改版 · `4` 锚点歧义 · `5` 语法检查失败）；备份写在 `daily-use\_univer-patch-backups\`（在排除名单里，不进成品）。`-Check` 只读，`-Only <id>` 单条 |

**补丁为什么会被冲掉**（两条都是**实测**，不是推测）：

- **OTA**：`resources\app\ota-core.js` 的 `WRITE_ALLOWLIST` 明确允许写 `^home/profiles/`；
  本地 `ota-index.json` 里 univer 该文件有 **810 条**受管路径，两条补丁都让它自己的 sha256
  与索引记录不一致 ⇒ **下一次检查更新就会判为「需替换」并覆盖**。旁证：`ota-update.log` 里
  2026-09-14 那次 OTA 真的覆盖过 40 个 `home\profiles\web\node_modules\...` 文件。
- **市场更新插件**：`dshmarket` 走 `dsh plugin --profile web add <pkg>@<ver>` → pnpm **整体替换包目录**。

**怎么一眼看出"有多少补丁正暴露"**：跑 `dstation-git-dev\tools\baseline-drift-scan.mjs`
（拿 `ota-index.json` 当基准，列出所有"本地改过、OTA 会覆盖"的文件）。

**所以每次开工前先跑一句**（幂等，已打过就什么都不做）：

```powershell
powershell -ExecutionPolicy Bypass -File ".\reapply-local-plugin-patches.ps1"
```

> 这是本地止血 + 可检测，**不是**上游修复的替代品；根治仍要向上游提 issue/PR。
> 新增一条本地补丁 = 往 patch 表里加一个表项（**不要**在 `build-green.ps1` / `verify-clean.ps1`
> 里另写判定）。

---

## 三、🔴 最大的坑：DSH **自管软链接层**必须删掉，不能物化

**症状**：整包看起来完美（0 软链接、0 密钥、体积正常），但原地启动直接失败：

```
Error: dsh: <...>\home\profiles\node_modules\@deepseek-ai\dsh exists and is not a
symlink or dsh-managed module proxy; remove it so dsh can manage the installation fallback
```

**根因**（源码在 `app\node_modules\@deepseek-ai\dsh-app-boot\lib\index.js`）：

| 目录 | DSH 的行为 |
|---|---|
| `home\profiles\node_modules\` | `healProfilesModuleFallback()` 每次启动**重建**：为安装依赖闭包里的每个包写一条**指向本机安装目录的 junction**（`symlinkSync(target, link, 'junction')`） |
| `home\profiles\<每个 profile>\.dsh-module-fallback\node_modules\` | `healProfileModuleFallback()` 每次启动**重建**：profile 自有回退链接。⚠️ **每个 profile 各有一份，不是只有 `web`** —— 2026-09-19 实测 `headless` 那份（一个**空但真实**的目录）仍然进了成品，因为修法当时把 `web` 写死了 |

`ensureSymlink()` 遇到「已存在的真实目录」时**直接抛错**（除非它是 dsh 自己写的 proxy）。
⇒ 这些层**要么是 symlink、要么不存在**，**唯独不能是真实目录**（**空目录也算**：`readModuleProxyRecord` 读不到 proxy 记录一样抛）。
而 robocopy/复制默认会把 junction 跟随物化成真实目录 —— 正好踩中。

**修法**：整包**不含**这些目录，让 DSH 在目标机器上按本机路径重建。

```powershell
# build-green.ps1 第 2 步已按「所有 profile」遍历，不要只写着 web
Remove-Item -Recurse -Force "$Dst\home\profiles\node_modules"
Get-ChildItem "$Dst\home\profiles" -Directory |
  ForEach-Object { Remove-Item -Recurse -Force (Join-Path $_.FullName '.dsh-module-fallback') }
```

**判据（压包前必查）**：成品里 `.dsh-module-fallback` 与 `home\profiles\node_modules` 的条目数 = **0**：

```powershell
Get-ChildItem $Dst -Recurse -Force -Directory |
  Where-Object { $_.Name -eq '.dsh-module-fallback' -or ($_.Name -eq 'node_modules' -and $_.Parent.Name -eq 'profiles') }
# 无输出 = 干净
```

**代价**：目标机器**首次启动会慢一些**（要装配插件树 + 重建这两层；实测 42s vs 复用后 8s）。
在「首次使用-必读.txt」里写明，否则用户会以为卡死。

**验证口令**：改完必须真启动一次 —— 这个坑**静态检查查不出来**。

---

## 四、junction 物化：要跟、但只跟该跟的

源安装目录里常见 **860+ 个 junction**（`home\profiles\**` 指向 `app\node_modules\**` 与自身）。
`robocopy /E` **默认跟随 junction 并把内容拷成真实目录** —— 这正是我们要的
（否则换机器断链），所以**不要加 `/XJ`**。

| 位置 | 处理 |
|---|---|
| `home\profiles\node_modules\**` | 跟随物化，**然后整层删掉**（§三） |
| `home\profiles\web\node_modules\dsh-<自研插件>` | 跟随物化 → **保留**（真实目录 DSH 容忍，`ensureProfileSymlink` 见已存在就跳过） |
| `home\plugins\dsh-dstation-market`（junction → `home\skill-sessions\`） | 跟随物化 → **保留**（`skill-sessions` 被排除，但源还在，能读到内容） |

**校验**：成品 `reparse points = 0`（这证明没有残留的绝对路径链接）。

---

## 五、可移植性修复三件套（不修就会在别的机器上出问题）

1. **`cordis.patch.yml` 写死盘符** → 改成跟随环境：
   ```yaml
   - id: sandbox-policy
     config:
       mode: workspace-write
       workspaceRoot: !!js process.env.DSH_HOME || process.cwd()
   ```
   `!!js` 是官方支持的表达式标签（`patchReload: live`）。写死 `D:/DSH/DH` 的机器，
   换台没有 D 盘的电脑 ⇒ 工作区内写文件被沙箱拒绝。

2. **默认模型指向中转站**（`agent-default-model.provider: toter`）→ 改成官方直连，
   否则新用户一开就报认证失败：
   ```yaml
   agent-default-model:
     provider: deepseek-official
     model: deepseek-flash
   ```

3. **`home\AGENTS.md`**（个人全局指令，常含个人路径/KEY 说明）→ 换成模板里的中性版。

---

## 六、自带运行时补齐（绿色版的「补环境」）

源安装目录**没有** Python 和 Git，而这两样被真实能力用到：

| 能力 | 依赖 | 影响 |
|---|---|---|
| ACES 创作（文生图/图生视频/BGM/数字人） | `python` | `home\skills\aces-system\*.py` —— **只用标准库**，无需 pip |
| 插件市场审核工具 | `python` + `node` | `home\skills\dsh-plugin-review\tools\server\*.py` |
| 右侧栏 Git 面板 | `git` | `dsh-better-sidebar` 宿主半 spawn |

**打进去**：`runtime\python\`（Python 3.13 embeddable，约 10 MB 压缩）+ `runtime\git\`
（MinGit，约 37 MB 压缩）。**不打** Ollama（1 GB+、要显卡、插件默认关）。

**怎么让它们被发现**：插件 `dsh-bundled-runtime` 在 `apply()` 里改 `process.env.PATH`。

**🔴 三条设计约束（照做，别改）**：

1. **只在系统里没有该命令时才补。** 自己走一遍 PATH 搜索，找到就 `skip`。
   否则自带的**可嵌入 Python（无 pip、无 site-packages）会顶掉用户的完整 Python**，
   用户装过的包突然 import 不到 —— 这是比「缺 Python」严重得多的问题。
2. **改 `process.env.PATH`，不改任何技能正文。** 插件跑在内核进程里，改完之后
   pwsh 工具 / 右侧栏终端 / 技能 spawn 的脚本 / better-sidebar 的 git **全部继承**。
   改技能正文不但要改多处，还会随 OTA 被覆盖。
3. **不改 `resources\app\main.js`。** 外壳属于 OTA 覆盖范围（清单替换 `resources\app\*`），
   写进去的补丁会被静默冲掉。插件 + patch 属数据层，可读可删可测。

顺带设：`DSTATION_NODE`→包内 node（审核工具认这个变量）、
`PYTHONUTF8=1` + `PYTHONIOENCODING=utf-8`（自带 Python 中文不乱码）。

**自检路由**：`GET /dsh-bundled-runtime/health` —— 用**改名后的 PATH** 真跑一遍
`python/git/node --version` 并返回版本号。**这就是「通没通」的证据，不要靠猜。**

---

## 七、验证方法论（三条证据链，缺一不可）

### ① 成品静态校验（`verify-clean.ps1`）
- 密钥文件名匹配 = 0
- 密钥格式内容命中 = 0（`sk-[A-Za-z0-9]{20,}` / `api_key\s*=\s*sk-`）
- **reparse points = 0**
- `*_tmp_*` / `*.bak-*` / `launcher.log|lock` = 0
- `home\` 一级只剩 `plugins, profiles, skills, AGENTS.md, settings.yaml`

### ② 启动验证 + 与原装机**同口径对照**（关键）
用包内 node 直接跑内核（不碰活着的 GUI，换端口）：

```powershell
$env:DSH_HOME = "$Dst\home"
& "$Dst\runtime\node\node.exe" "$Dst\app\node_modules\@deepseek-ai\dsh\lib\bin.js" web --port 3107 --no-open
```

然后**同一组探针分别打活装机与新包**，逐项比对：

| 探测点 | 期望 |
|---|---|
| `/`（带 token） | 200 + 约 28 KB HTML |
| `/dsh-wallpaper/health` | 200 |
| `/dsh-media/health` | 200 |
| `/dsh-ollama/status` | 200 |
| `/dsh-bundled-runtime/health` | 200 + 三个 `probes.ok=true` |

**必须用 CookieContainer**：裸请求会被拒（401），别把它当成「没起来」。
**探测写法**：用 `HttpWebRequest` 并捕获 `WebException` 读状态码；
`Invoke-WebRequest` 遇非 2xx 直接抛异常，会把能用的服务误判成挂了。

**判据**：新包每项与活装机一致 ⇒ 插件树装配成功、前端能出、自研插件路由在。

### ③ 运行时注入的双向验证
| 场景 | 命令 | 期望 |
|---|---|---|
| **模拟干净机器** | `test-runtime-plugin.ps1 -ScrubPath`（PATH 只留 `system32`） | `injected` 三个，probes = 自带 3.13.7 / 2.55.0 / v22.20.0 |
| **不抢优先级** | 不带 `-ScrubPath` | `injected: []`，三个都 `system-already-has-it`，**PATH 不变** |

### ④ 清干净再打包
验证跑过会在包里留下 `home\.credentials.yaml`、`.anonymous-user-id`、
`home\storages\`、`home\telemetry\`、`home\wallpapers\`、`home\daily-use\`、
`home\profiles\node_modules\`、`home\profiles\web\.dsh-module-fallback\`、`_boottest*.log`
—— **删掉它们，回到 §二 的出厂态**，再压 zip。

---

## 八、打包与交付

```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($Dst, $zip,
  [System.IO.Compression.CompressionLevel]::Optimal, $true)   # $true = 带顶层文件夹
```

- **别用 `Compress-Archive`**（有 2 GB 级限制问题）；用 `ZipFile.CreateFromDirectory`。
- **`includeBaseDirectory: $true`**，否则解压出来是一堆散文件而不是 `D-STATION-绿色版\`。
- 1.6 GB 目录约压成 530 MB，耗时 5~10 分钟 —— 用后台任务跑。
- **压完必须校验**：条目数、顶层文件夹名、关键文件（`dsh-launcher.exe` / `runtime\python\python.exe` /
  `runtime\git\cmd\git.exe` / 插件 / `首次使用-必读.txt`）、密钥类条目 = 0。
- **报 SHA256 给用户**（`Get-FileHash -Algorithm SHA256`），方便他核对传输完整性。

**交付时一并说清**：
- 发的是 zip（不是目录）；解压到**非 `C:\Program Files`** 的位置；
- 首次启动 1~3 分钟属正常；
- 包里**没有任何 KEY**，要用户自己填（设置 → 模型）；
- 支持 **Windows 10/11 x64**；Mac/Linux/ARM64 用不了（exe 是 x64，原生模块是 win32-x64）；
- Ollama 不在包里（要本地模型自己装）。

---

## 九、环境事实（本环境实测，别踩）

| 事实 | 说明 |
|---|---|
| **pwsh 工具 = Windows PowerShell 5.1** | `.ps1` 文件**必须只含 ASCII**，中文注释会让它按 ANSI 解析报 `TerminatorExpectedAtEndOfString`。命令**内联**中文没问题 |
| **`robocopy` 可能被拒** | 沙箱 read-only / workspace-write 下报 `Access is denied`（不是命令写错）；`danger-full-access` 下可用。不可用时改用 `Copy-Item` |
| **🔴 打包必须在 `danger-full-access` 下跑** | 会话工作区通常是 `…\home\skill-sessions\`，而打包要写 `…\dist\home\daily-use\<成品>\`——**在工作区之外**，`workspace-write` 会拒掉 robocopy 与每一次 Copy/Remove。**失败是「像成功」的**：`Remove-Item $Dst` 删不掉旧目录，脚本照样往下跑，最后打印的 `size / reparse / secret files / home entries` 全是**上一次那份旧成品**的数字，只有逐行的 `copied / removed / runtime / plugin / templates` 才看得出真假。判据：**先看有没有那几行逐行输出，再看成品目录 mtime 是不是刚刚**。**2026-09-17 新踩** |
| **`Get-Content` 看不了 UTF-8 中文** | 控制台按 ANSI 解 → 乱码。看文件用 **read 工具**，不要用 shell |
| **`if` 不能当表达式** | PS 5.1 不支持 `(if($x){...}else{...})`，会报 `The term 'if' is not recognized` |
| **磁盘要留够** | 源 3.19 GB → 成品 1.64 GB（物化 junction 会短暂占用更多）。`Get-CimInstance Win32_LogicalDisk` 可能被拒，用 `[System.IO.DriveInfo]::new('C')` |
| **端口会串** | 验证用 3107/3109/3111 之类，杀掉进程后 TCP 可能还没释放 ⇒ 换端口重试 |
| **不要碰活着的实例** | 用户正在用的 GUI 在 3080。**杀 node 进程时按可执行文件路径过滤**（`*D-STATION-*`），别按名字全杀 |
| **`/dsh-media/health` 两边长度不等是正常的** | 它回的是「本机解析出来的可预览根目录」：活装机多出 `liveSessionRoots`（当前会话目录）。两边都会列出 `D:/DSH`、`D:/AI/HARNESS` 这两条**历史遗留根**（插件内建默认值，不是本包写进去的；别的机器上没有该盘符 ⇒ 直接命中不到，无害）。**别把它当打包失败去追**。判据是 `ok:true` 且 `deploymentRoot` 指向**包内** home。**2026-09-17 实测** |

---

## 十、交付清单（照这个收尾）

- [ ] 成品目录 `reparse points = 0`、`密钥类文件 = 0`
- [ ] **第三方插件本地补丁全部在位**（patch 表 `-Check` 全 `OK`；`verify-clean.ps1` E 段 = `RESULT: PASS`；见 §二·五）
- [ ] `home\` 一级 = `plugins, profiles, skills, AGENTS.md, settings.yaml`（`verify-clean.ps1` D 段有**硬断言** `home extras = 0`；多出来的都是用户数据漏回来了）
- [ ] `runtime\` = `git, node, python`
- [ ] `cordis.patch.yml` 里 `workspaceRoot` 不含写死盘符；`agent-default-model` 指向 `deepseek-official`
- [ ] 启动验证通过，且与活装机**逐项一致**
- [ ] `/dsh-bundled-runtime/health` 双向验证通过（干净机器补齐 / 已有则不抢）
- [ ] 验证痕迹已清干净（§七·④）
- [ ] zip 条目数 / 顶层文件夹 / 关键文件 / 密钥类条目 = 0 已核对
- [ ] SHA256 已报给用户
- [ ] 已提醒：**试跑过的目录不能直接发**；支持的系统范围；KEY 要自填
- [ ] 本次新踩的坑已回填 `dsh-plugin-dev` 的坑清单与插件台账
