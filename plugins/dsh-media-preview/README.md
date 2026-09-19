# dsh-media-preview

在 DSH 对话里**就地**预览大模型生成的图片 / 视频 / 音频，并一键下载到本机。

装好之后，模型只要在回复里写出媒体文件的绝对路径（或用 `media_preview` 工具显式声明），
这段路径就会被替换成一张可播放、可下载的预览卡：

```
图片生成好了：D:\work\out\cover.png
        ↓
┌──────────────────────────────┐
│   [ 图片预览 ]               │
│ IMAGE  cover.png      62.2 KB│
│ [ ⬇ 下载 ]  [ 新标签打开 ]   │
└──────────────────────────────┘
```

## 它解决什么问题

DSH 的附件通道**架构上只接受光栅图片**（`dsh-attachment` 的明确约束：通用文件、音频、
视频都不支持），而浏览器侧也没有任何读本地文件的 API。于是模型辛苦生成的
`mp4` / `mp3` / 大图，在对话里只能看到一行路径文本，人既看不到也点不开。

本插件补的就是这一段：宿主开一条**只读的媒体通道**，浏览器半把正文里的媒体路径
换成预览卡。它不修改 DSH 任何现有文件，卸载即恢复原样。

## 功能

| 能力 | 说明 |
|---|---|
| 内联预览卡 | 图片直接显示、视频带播放器、音频带波形条（原生 `<audio>`） |
| 点击下载 | 优先用「另存为」让用户自己选位置；不支持时退化为浏览器下载；大文件直接交给浏览器，不进内存 |
| 新标签打开 | 原文件在与对话同一个服务上单独打开 |
| 视频拖动 / 音频 seek | 宿主路由支持单区间 `Range`，返回 206 |
| 模型主动声明 | 提供 `media_preview` 工具，模型可显式把若干文件标记为「要给人看」 |
| 失败可见 | 文件不存在 / 不在工作区 / 不是媒体，都会在卡片上写明原因，而不是静默消失 |
| 刷新重扫 | `Alt+M` 手动重扫；DOM 变化由 `MutationObserver` 自动增量处理 |

## 安装

本插件是 profile 级插件（宿主半 + 浏览器半），装进 web profile 即可：

```powershell
# 1) 把插件目录放进 profile 的 node_modules
$profile = "$env:DSH_HOME\profiles\web"        # 或你实际的 profile 目录
Copy-Item -Recurse <本目录> "$profile\node_modules\dsh-media-preview"

# 2) 在 profile 的 package.json 里登记（dependencies 与 dsh.profile.bundles 各加一条）
#    "dsh-media-preview": "file:./node_modules/dsh-media-preview"
#    bundles 里追加 "dsh-media-preview"

# 3) 重启 dsh 服务（关掉托盘再启动，或让 launcher 看门狗自动拉起）
```

重启后 `GET /dsh-media/health` 应返回 `{"ok":true,...}`，页面刷新时滚动条旁会出现
本插件的客户端模块。

## 使用

**方式一（自动）**：模型在回复里给出媒体文件的绝对路径即可。例如

> 视频已生成：`D:\work\out\demo.mp4`

**方式二（显式）**：模型调用 `media_preview` 工具：

```json
{ "paths": ["D:\\work\\out\\demo.mp4", "D:\\work\\out\\cover.png"] }
```

工具会返回被确认的绝对路径，把它们写进回复文本即可看到卡片。

> 为什么工具还要模型"再把路径写一遍"：卡片锚定在**消息文本里的路径**上，
> 工具返回的那段文本本身就是锚点，所以通常不需要额外操作。

## 安全边界（改动前必读）

`/dsh-media/*` 是一条**浏览器可直接 GET 的路由，且不以 `/api` 开头**，
因此它没有 `dsh-client-connection` 的 cookie 鉴权 —— 安全完全由 `path-guard.js` 承担：

1. **扩展名白名单**：只放行媒体后缀，其余一律 415。它不是通用文件服务器。
2. **允许根白名单**：`realpath` 之后必须落在允许根之内。允许根来自
   ① 部署的 `sandboxPolicy.workspaceRoot`；② 每个 live session 的工作目录；
   ③ 环境变量 `DSH_MEDIA_ROOTS`（`;` 分隔，逃生舱）。符号链接逃逸在 realpath 这一步被拆穿。
3. **拒绝隐私路径**：`.ssh` / `.aws` / `.gnupg` 等目录段与点开头的文件都拒绝。
4. **只读**：宿主半不提供任何写操作。

查看当前生效的允许根：`GET /dsh-media/health`。

## 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_MEDIA_ROOTS` | 追加允许根（`;` 分隔）。工作区之外的成品目录（例如专门的产物目录）用它显式放行 |

## 开发

源码在 `~/dsh-media-preview`（本目录），结构：

```
index.js                 宿主半：/dsh-media/{file,allow,health,selftest} 四条路由 + media_preview 工具
client.js                浏览器半：扫描正文 → 预览卡（手写 DSH 模块格式，无需打包）
mime.js                  扩展名 → MIME/Kind（宿主与浏览器共用的唯一事实源）
path-guard.js            文件访问边界（安全核心）
http-range.js            单区间 Range 解析
test/                    node:test 单测 + 浏览器/真实服务验收脚本
test/visual/make-*.mjs   生成测试样本（真 PNG / WAV / ffmpeg 编的 H.264 MP4）
```

### 排障

**状态是写在 DOM 上的，默认不打扰界面**：

```
<html data-dsh-media-build="v7-…" data-dsh-media-phase="scan:done"
      data-dsh-media-scans="3" data-dsh-media-candidates="5" data-dsh-media-cards="5">
```

想看到浮层（左下角小标签），在 URL 上加 `?dsh-media-debug=1`，或预先设
`window.__DSH_MEDIA_DEBUG__ = true`。默认静默：常驻浮层会压住左下角的侧边栏按钮。

**自检页** `GET /dsh-media/selftest`：上半页是宿主真读盘的结果（类型/大小/文件魔数），
下半页把真实 `client.js` 注入到真实路径上出卡，并检测自激循环（稳定后 0.6 秒内
的新增 DOM 变更必须为 0）。`?files=<绝对路径>` 可指定样本。

**三种故障怎么分辨**（这是当初做这些装置的原因）：

| 现象 | 含义 |
|---|---|
| `<html>` 上没有 `data-dsh-media-*` | 客户端模块根本没加载 |
| 有 build 但没有 scans | 模块加载了，`apply()` 却没跑起来 |
| 有 scans 但 candidates=0 | 扫到了正文，但没认出路径（看跳过规则） |
| candidates>0 但 cards=0 | 认出来了但渲染失败（看 `data-dsh-media-error`） |

### 测试

```powershell
node test/run-tests.mjs      # 59 项：PathGuard / Range / MIME / 路径识别 / 卡片渲染 / 路由 / 工具
```

> 为什么不是 `node --test test/`：DSH 的文件沙箱禁止子进程管道通信，
> `node --test` 默认每个测试文件起子进程会直接 EPERM；`run-tests.mjs` 改为
> 把测试文件 import 进同一进程。

### 真实环境验收

```powershell
# 1) 生成能看能听能播的样本（PNG / WAV / H.264 MP4）
node test/visual/make-showcase.mjs "D:/你的工作区/媒体预览示例"

# 2) 真实 DSH 服务端到端（health / allow / file / Range / 下载头 / 越界拒绝）
node test/visual/live-check.mjs http://127.0.0.1:3080 <token> 6-verify "D:/你的工作区"

# 3) 单个文件的字节范围核对（播放器拖进度条的前提）
node test/visual/range-check.mjs http://127.0.0.1:3080 <token> out.txt "D:/路径/a.mp4"
```

### 已知边界

- **卡片锚定在正文文本上**：模型把路径写进最终回答即可，**包括写成行内代码**
  （反引号包住的一小段路径）—— 行内代码会被识别，并把那个代码元素整块换成卡片。
  但**多行代码块**（三个反引号围起来的那种）里的路径一律不动：那是要给人复制的原文，
  注释里出现路径是常态。（这条判据曾写错成"任何 `<code>` 都跳过"，
  导致模型最自然的写法反而看不到卡片，2026-09-13 已修，见 `test/client-skip.test.js`。）
- **路径被拆行不识别**：中间夹了换行或空格就不认（例如 `D:\我的 项目\a.png`）。
  识别策略刻意保守，宁可少认也不误吞整段话。
- **相对路径不处理**：宿主只接受绝对路径。模型写 `out/a.png` 时不会出卡，
  请让它写绝对路径（系统提示里已给出工作目录）。
- **`media_preview` 工具对已存在的会话不生效**：工具在插件激活时注册，
  DSH 不会追溯已创建的 agent。新会话即有。（卡片本身不依赖工具，任何会话都工作。）
- **`/dsh-media/*` 不鉴权**：如前所述，安全靠路径白名单而非会话。
  若把 dsh 暴露到非回环网络，请自行评估。
- **视频必须用浏览器真支持的编解码器**：手写的 MJPEG-in-MP4 容器完全合法
  （帧表逐项校验通过），但 Chromium 的 `<video>` 不解 MJPEG ——
  **容器合法 ≠ 能播**。样本现在用 ffmpeg 编 H.264（`yuv420p` + baseline + faststart）。
  生成样本请走 `test/visual/make-video-ffmpeg.mjs`。
- **真实浏览器自动化验收尚未打通**：DSH 的 Electron 主窗口没开远程调试端口，
  独立起 Electron 又被单实例锁与 React 版本（18/19 混装）绊住。
  目前的替代是 `/dsh-media/selftest` 自检页（含抖动检测）+ 单测里的卡片结构断言。

## 卸载

从 profile 的 `package.json` 里删掉 `dependencies` 与 `bundles` 两条，删除
`node_modules/dsh-media-preview`，重启服务即可。DSH 自身文件不受影响。
