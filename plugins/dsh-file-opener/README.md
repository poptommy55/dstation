# dsh-file-opener

把对话里出现的**本地文件路径**变成可点击入口：

- **点文件名** → 用系统默认程序打开（`.docx`/`.xlsx` 走 WPS/Office，`.html`/`.svg` 走浏览器）
- **点旁边的文件夹图标** → 在文件夹中显示（打开所在目录）

## 为什么需要它（先查了官方能力，不是臆测）

| 事实 | 出处 |
|---|---|
| 宿主**自带**原生打开能力，Win 下执行 `Invoke-Item -LiteralPath` | `@deepseek-ai/dsh-native-command` |
| 宿主已开放 RPC `session.openWorkspacePath` + 能力探测 `canOpenWorkspacePath` | `@deepseek-ai/dsh-api-session-controller` |
| `.html/.htm/.xhtml/.svg` 会被**浏览器**接管，其余走文件关联 | `BROWSER_DOCUMENTS` |
| 官方只有**产物事件**会变成可点提及 | `@deepseek-ai/dsh-client-ui-deliverables` 的 `chatFileMentions` |
| **模型在正文/代码块里手写的路径，官方没有任何人处理** ← 本插件补的就是这块 | 同上 |

本插件**不修改任何官方文件**，只新增自己的一份代码 + profile 里一条登记。

## 结构

```
index.js        宿主半：/health /status /check /reveal /report /selftest（6 条路由）
path-guard.js   路径边界：四道闸门，**只暴露元数据，不传任何文件字节**
reveal.js       「在文件夹中显示」：explorer.exe /select, 的参数构造（**写法是实测出来的**）
client.js       浏览器半：扫描块级元素 → 批量校验存在性 → 在块后挂 chip 条
cordis.patch.yml  自带补丁（走 bundle 通道，勿与 profile 手工 mount 行并存）
```

## 🔴 两个"不是直觉能推出来"的事实（改之前务必读）

### 1. `explorer /select,` 的参数**必须拆成两个元素、且不能自带引号**

```js
spawn('explorer.exe', ['/select,', nativePath], { stdio: 'ignore' })   // ✅
```

实测五种写法（目标用「带空格 + 中文」的文件名）：

| 写法 | 结果 |
|---|---|
| `['/select,"<path>"']` 参数自带引号 | ❌ 打开「文档」默认位置 |
| `['/select,<path>']` 交给 Node 引 | ❌ 打开「文档」默认位置 |
| **`['/select,', '<path>']`** | ✅ **正确打开目标目录并选中** |
| `cmd /c start /select,"<path>"` | ❓ 没有窗口 |
| `['/n', '/select,"<path>"']` | ❌ 打开「文档」默认位置 |

原因：**Node 在 Windows 上会把 argv 重新拼成一条命令行**，参数里自带的引号会被再转义一层，
explorer 解析不出来就回退到默认位置 —— **不报错**，所以极难发现。

⚠️ 踩过的坑：用手动 `Start-Process -ArgumentList '/select,"<path>"'` 测**是好的**，
因为那条路不做二次转义。**「换条路测通过」不等于「产品这条路能用」**，
验证必须走产品自己用的入口（`spawn`）。对照实验脚本：`test/spawn-probe.mjs`。

### 2. 「在文件夹中显示」不能走 `openWorkspacePath`

官方 RPC 只能**打开**：对已有一个资源管理器窗口开着的目录，往往只是把它切到前台，
用户看到的就是「点了没反应」。所以要 `explorer /select,` 打开父目录**并选中该文件**。
这也是为什么本插件有一个自己的宿主路由 `/reveal`（唯一会起子进程的地方）。

## ⚠️ 依赖一个设置：`dsh-better-sidebar` 的 `interceptOpenPath`

`dsh-better-sidebar` **默认会 shadow `remote.session.openWorkspacePath`** ——
那是聊天侧文件打开的**唯一漏斗**（工具行路径链接 / 产物行 / 正文提及 / 行内代码路径），
于是所有点击都落进侧栏编辑器，而不是系统默认程序（它的源码注释原话：
*"so opens land in the sidebar editor instead of the Host OS"*）。

本插件与官方的"点路径打开"都走这条通道，所以必须把它关掉：

```yaml
# <DSH_HOME>/settings.yaml
dsh-better-sidebar:
  interceptOpenPath: false
```

关掉后：聊天里的路径 → WPS/Office 等默认程序；**侧栏自己的文件树点击不受影响**。
想恢复：删掉这行，或在「侧栏设置」里重新勾选。


## 三个刻意的设计取舍（改之前先读）

1. **不动正文文字节点，只在块后面追加兄弟节点。**
   对话在流式输出时文字节点每个 token 都在变，把一段文本拆成"前/中/后"三个节点
   会与 React 的协调打架。`dsh-media-preview` 用的也是"块后挂节点"，这条路已被验证。

2. **只装饰"确实存在"的路径。**
   候选路径先批量送宿主 `/check` 校验；不存在的路径不装饰 ——
   否则每个像路径的字符串都长出一条按钮，比不做好。
   ⚠️ 校验未返回前**不许定案**（不许标记 `done=empty`），否则那个块永远出不来条。

3. **不与兄弟插件抢地盘。**
   跳过 `[data-dsh-media-host]`（media-preview 的卡片）、`.dsh-mmd`（mermaid）、
   `.cm-editor`、`[contenteditable="true"]`。
   本插件与 media-preview 是**互补**关系：它管图片/视频且**不碰 `<pre>`**；
   本插件以 `<pre>` 为主战场、管任意后缀。

## 幂等性（两道闸，都要）

- **第一道**：块上的 `data-dsfo-done` 标记（靠 `closest` 覆盖嵌套块，避免重复出条）。
- **第二道**：条子上的 `data-dsfo-key`（路径内容键）。
  React 在流式结束/重渲染时可能**替换掉整个块节点**，标记随旧节点消失，
  而挂在兄弟位置的条子活了下来 ⇒ 只看标记会重复出条。
  测试里有专门一条模拟"块节点被替换"来钉住这个行为。

## 诊断（证据在哪里）

```powershell
# 宿主侧：允许根、构建号、客户端上报
Invoke-WebRequest http://127.0.0.1:3080/dsh-file-opener/health -UseBasicParsing
Invoke-WebRequest http://127.0.0.1:3080/dsh-file-opener/status  -UseBasicParsing

# 浏览器侧：状态同时写进 <html data-dsfo-*>
#   data-dsfo-build / phase / scans / candidates / decorated / capability / error
```

⚠️ 两个构建号是**独立常量**，改代码时要各自 +1：
`index.js` 的 `BUILD`（宿主半，改它要重启）与 `client.js` 的 `BUILD`（浏览器半，会热重载）。

⚠️ 查询 `/check` 传中文路径时，PowerShell 必须显式给 UTF-8 字节，
否则中文会变成 `?????` 而被误判成"文件不存在"（本插件的功能没问题，是探针的编码问题）：

```powershell
$json  = '{"paths":["C:\\目录\\文件.docx"]}'
$bytes = [Text.Encoding]::UTF8.GetBytes($json)
Invoke-WebRequest .../check -Method POST -Body $bytes -ContentType 'application/json' -UseBasicParsing
```

## 测试

```powershell
node test/run-tests.mjs        # 132 项：参数构造 + 宿主半路由 + 浏览器半（最小 DOM 替身跑真源码）
```

- 假 `ctx.webServer.register` **复刻真实行为**（重复 `(kind,path)` 就抛），
  所以"路由表能否装配"不需要重启就能验证。
- 假 `res` 是真 `Writable` 流，且 `writeHead` 走 Node 的 `res.validateHeaderValue`。
- 假 XHR 支持**按 URL** 应答 —— 客户端会同时发 `/report` 与 `/check`，按"最早"应答会发错对象。

## 安装 / 卸载

源码即运行位置（两层 junction）：

```
<DSH_HOME>\plugins\dsh-file-opener                      → <工作区>\dsh-file-opener
<DSH_HOME>\profiles\web\node_modules\dsh-file-opener    → <DSH_HOME>\plugins\dsh-file-opener
```

profile 的 `package.json` 需要两处：`dependencies` 里一条 `file:./node_modules/dsh-file-opener`，
`dsh.profile.bundles` 里追加 `"dsh-file-opener"`。

⚠️ **`dsh.profile.bundles` 只在启动时读** —— 加完必须重启 dsh（宿主半是 ESM，
按解析后的 URL 缓存，热重载只对客户端半有效）。
重启用分离进程延迟执行，别让"杀服务"的命令把发起它的工具调用一起带走。
卸载：删两个 junction + 撤掉 profile 那两处 + 重启。
