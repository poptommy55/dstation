# D-STATION

[English](README.md) | **简体中文**

一个 Windows 桌面应用：用 Electron 外壳封装开源的 **DeepSeek Harness（DSH）** 智能体运行时，
并附加一组第一方插件、智能体技能，以及一套自建的在途升级（OTA）机制。

[![CI](https://github.com/poptommy55/dstation/actions/workflows/ci.yml/badge.svg)](https://github.com/poptommy55/dstation/actions/workflows/ci.yml)
![License](https://img.shields.io/badge/license-Apache--2.0-blue)
![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-lightgrey)
![Shell](https://img.shields.io/badge/Electron-44.2.0-47848F)

---

## 这是什么

D-STATION 是**给一个已有的智能体运行时套的桌面外壳**，它本身不是一个新的运行时。

运行时是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，在 npm 上以
`@deepseek-ai/dsh` 发布，在本仓库中以**未修改的 npm 依赖**形式引入。D-STATION 既没有把内核
源码拷进仓库，也没有做分支改造：构建时安装该依赖，再与外壳、第一方插件一起组装成应用。

在内核之上，D-STATION 增加了三部分：

1. **Electron 外壳**：把 DSH 后端作为子进程拉起在本机 HTTP 端口上，注入品牌信息，并在运行时
   启动期间显示启动画面。
2. **一组第一方插件与技能**：本仓库维护 12 个插件和 5 个技能。
3. **自建 OTA 升级客户端**：校验签名后的清单文件，按内容寻址做整文件替换式更新。

本仓库中的所有组件都是开源的。它背后没有任何专有服务，源码与发行包中也都不含任何 API 密钥。

---

## 功能

### 桌面外壳

- 把 DSH 运行时作为受管子进程拉起在本机 HTTP 端口（默认 3080；端口被占用时自动递增到
  3081–3099）。
- 向运行时的 Web 界面注入品牌信息。
- 用启动画面覆盖运行时启动过程。
- 可签名的自建升级通道（见 [OTA 升级](#ota-升级)）。

### 第一方插件

`plugins/` 下共 12 个插件，每个都是独立的 npm 风格包：

| 插件 | 作用 |
| --- | --- |
| `dsh-agent-maker` | 编写智能体预设的 UI 工作台。 |
| `dsh-skill-panel` | 技能管理面板。 |
| `dsh-knowledge-base` | 知识库管理器。 |
| `dsh-composer-upload` | 对话输入框中的文件上传。 |
| `dsh-media-preview` | 把生成的媒体渲染成预览卡片。 |
| `dsh-web-search-bing` | 基于必应的联网搜索工具。 |
| `dsh-daily-workspace` | 每日临时工作区。 |
| `dsh-ollama` | 本地模型提供方。 |
| `dsh-wallpaper` | 壁纸选择器。 |
| `dsh-file-opener` | "在资源管理器中显示"的宿主路由。 |
| `dsh-dstation-market` | 应用内插件市场的浏览与安装。 |
| `@michengai/dsh-archive-manager` | 侧边栏的归档与文件夹管理。 |

### 智能体技能

`skills/` 下共 5 个技能，每个是一份 Markdown `SKILL.md`，可选带辅助脚本：

| 技能 | 作用 |
| --- | --- |
| `aces-system` | 通过外部 ACES 网关生成图片、视频、BGM 与数字人；使用用户自备的密钥文件配置。 |
| `dsh-green-release` | 打包绿色版发行包。 |
| `dsh-plugin-dev` | DSH 插件开发指南。 |
| `dsh-plugin-submit` | 投稿与导出插件。 |
| `wechat-publisher` | 发布文章到微信公众号。 |

### OTA 升级

外壳会拉取一份 JSON 升级清单，用**编译进 `shell/ota-core.js` 的 Ed25519 公钥校验签名**，
然后按内容寻址执行整文件替换式更新。签名私钥**不在本仓库中**；升级清单地址也没有硬编码到
任何真实服务器——你可以通过 `DSTATION_OTA_MANIFEST` 环境变量把它指向你自己的服务器。

---

## 截图

```
<!-- TODO: add screenshot of the main window -->
```

*占位：此处应放置一张 D-STATION 主窗口的截图。*

---

## 环境要求

| 要求 | 版本 / 说明 |
| --- | --- |
| 操作系统 | **仅 Windows 10 / Windows 11 x64** |
| Node.js | **22.19 或更高**（DSH 内核的依赖树有此要求） |
| npm | 随 Node 附带；`scripts/setup.ps1` 使用它 |
| pnpm | 仅当你在应用内从插件市场安装插件时才需要 |
| git | 仅克隆本仓库时需要 |

### 为什么只支持 Windows x64

发行包里含有 **Windows x64 原生二进制**——Electron 的 x64 运行时本身，以及 `node-pty`、
`libsql` 这类原生 Node 模块。本仓库不提供 macOS、Linux 或 ARM64 的构建。外壳与插件在原理上
是可移植的，但打包后的应用不是，且本仓库不发布也不测试这些平台。

---

## 快速开始

推荐的流程是三个 PowerShell 脚本，它们就是本地检出后构建的正式入口：

```powershell
# 1. 安装依赖并准备工作区
./scripts/setup.ps1

# 2. 由外壳、插件与 DSH 依赖组装应用
./scripts/build.ps1

# 3. 启动构建好的应用
./scripts/start.ps1
```

请在仓库根目录按上述顺序执行。首次构建需要下载 Electron 与运行时依赖，耗时会明显长于后续构建。

> 如果你的检出里缺少这些脚本、或者执行失败，那是一个应当被报告的缺陷——它们是文档化的构建路径，
> 不是可选的小工具。

---

## 配置

### 模型 API 密钥

**你必须自备模型 API 密钥**（例如 DeepSeek API 密钥）。本仓库不含任何密钥，任何发行包也不含。
应用首次运行时会向你索取密钥；没有密钥时运行时仍能启动，但无法访问模型。

请勿把密钥提交进版本库。本仓库的 `.gitignore` 已经排除了常见的凭据文件形态，详见该文件顶部的
*Secrets* 注释块。

### 可选环境变量

| 变量 | 用途 |
| --- | --- |
| `DSTATION_OTA_MANIFEST` | 你自己的 OTA 升级清单的完整 URL。设置它即可把升级客户端指向你自己的服务器；默认值不是任何真实服务器地址。 |

---

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `shell/` | Electron 外壳源码——外壳的唯一真实来源（`main.js`、`files.js`、`brand-inject.js`、`ota.js`、`ota-core.js`、`ota-preload.js`、`ota-updater.js`、`splash.html`）。 |
| `plugins/` | 12 个第一方 DSH 插件，每个都是独立的 npm 风格包。 |
| `skills/` | 智能体技能——每技能一份 Markdown `SKILL.md`，可选带辅助脚本。 |
| `profiles/web/` | DSH profile 配置：`cordis.yml`、`cordis.patch.yml`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`。 |
| `patches/` | 7 个 `.frag` 片段文件，由发布工具链消费。 |
| `scripts/` | 构建、运行与校验脚本。 |

---

## 构建绿色版发行包

绿色版发行包由干净检出配合 `scripts/` 下的构建脚本产出。构建过程会把 Electron 外壳、12 个插件、
技能以及固定版本的 DSH 内核组装成一棵自包含目录树，在 Windows x64 机器上无需另装 Node.js 即可运行。

分发构建产物之前，请确认：

1. 从干净检出构建，避免把本地运行时状态带进产物。
2. 产物中**不含任何 API 密钥或任何形式的凭据**。
3. 编译进 `shell/ota-core.js` 的 OTA 公钥确实是你要用来签名发布的那把，且对应私钥存放在本仓库之外。
4. 在构建机以外的机器上启动一次，做冒烟测试。

`skills/` 中的 `dsh-green-release` 技能更详细地记录了绿色版打包清单，包括交付给别人之前必须清理掉
哪些东西。

---

## 参与贡献

欢迎贡献。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)——其中包含开发循环、`shell/` 与 `plugins/`
的唯一真实来源规则、提 PR 前的检查清单，以及提交信息规范。

参与之前也请阅读 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

---

## 安全

请**不要**在公开 issue 中报告安全漏洞。请使用 GitHub 的私密漏洞报告功能——具体步骤、报告应包含
的内容、以及哪些范围在受理之内，见 [SECURITY.md](SECURITY.md)。

---

## 状态

> **D-STATION 把 DSH 固定在候选发布版 `0.1.2-rc.1` 上。**
>
> 候选发布版按定义就不是稳定接口。从现在到稳定版之间，DSH 内核可能变更其 API、配置结构或插件契约，
> D-STATION 只能跟着改。**任何一次发布都可能包含破坏性变更**，包括需要你重新配置 profile 或更新
> 自己插件的那种变更。
>
> 把它当作"能用但尚未冻结"的项目。需要可复现性时，请固定到某个具体提交。

---

## 许可证

D-STATION 以 **Apache License 2.0** 发布，完整文本见 [LICENSE](LICENSE)。

DSH 内核为 MIT 许可，Electron 亦为 MIT 许可；两者都要求署名，因此本仓库带有 [NOTICE](NOTICE) 文件。
该文件记录了本应用所依赖的上游项目——DeepSeek Harness、Electron 与 Chromium——并说明 DSH 是以
未修改的 npm 依赖形式引入的。
