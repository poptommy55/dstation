# DSH 补丁记录：新建对话默认落在「日常使用」分区

> 本补丁修改的是 **DSH 本体 UI 包**与 **第三方插件**，不属于 `dsh-daily-workspace` 插件。
> **风险**：DSH 更新或插件更新会覆盖这两处，补丁失效
> （症状：新建会话不再默认日常使用，退回"继承当前/最近分区"）。跑一次脚本即可重打。

## 🔴 最重要的一条：要打**两个**文件，真正生效的是第二个

实测（2026-09-14）发现：**`@michengai/dsh-archive-manager` 把 workspace 客户端整个接管了**。

| 判据 | 结果 |
|---|---|
| 服务端发出的客户端模块清单里有 `@michengai/dsh-archive-manager/client.js` | ✅ 有 |
| 服务端发出的客户端模块清单里有 `@deepseek-ai/dsh-client-ui-workspace/client.js` | ❌ **没有** |
| 发出的 bundle 里 `recentWorkspace(workspace.items, sessions.byId)`（workspace 包版本） | **0 次** |
| 发出的 bundle 里 `recentWorkspace()`（archive-manager 版本） | **2 次** |

archive-manager 内部有 `ctx.slots.inject("sidebar.workspaces")`、
`conversation.hero.workspace`、`WorkspaceBrowser`、`WorkspacePicker`、
`createWorkspaceViewStore` 的**完整副本** —— 它 fork 了 workspace UI 并加了归档能力。

**所以只改 workspace 包是无效的**（我第一次就踩了这个坑：改完重启，
服务端发的代码里依然没有补丁）。现在两处都打上：archive-manager 那份负责当前生效，
workspace 包那份作为后备（若卸载 archive-manager 就会由它接管）。

## 目标文件（绝对路径）

```
1) %DSH_HOME%\profiles\web\node_modules\@michengai\dsh-archive-manager\lib\client.js   ← 真正生效
2) build\dist\app\node_modules\@deepseek-ai\dsh-client-ui-workspace\lib\client.js      ← 后备
```
备份：同目录 `client.js.bak-daily-default-<时间戳>`

## 目的
点侧栏「新对话」（`startSession()`，**不带参数**）时默认落在「日常使用」分区，
而不是"当前会话所在分区 / 最近活动分区"。

## 改法（每个文件 1 处）

**锚点**（每个文件内全文唯一）：
```js
const target = workspaceId ?? currentWorkspaceId ?? recent;
```

**改成**（末段 `?? recent` → `?? dailyUseId ?? recent`，并在上方插入 `dailyUseId` 计算）：
```js
// [补丁 dsh-daily-default] 新会话默认落在「日常使用」分区。
// 按 canonical path 结尾匹配 daily-use，而不是按标题 —— 改标题不影响。
// 未指定 workspaceId 时优先它，其次才继承当前/最近分区；
// 用户在 hero 里显式改选时会带着 workspaceId 进来，所以改选仍落入他选的分区。
const dailyUseId = <快照>.phase === "ready" ? <快照>.items.find((item) => typeof item.path === "string" && /[\\/]daily-use$/i.test(item.path))?.workspaceId : void 0;
const target = workspaceId ?? dailyUseId ?? currentWorkspaceId ?? recent;
```
> 两个文件的快照变量名不同：archive-manager 用 `workspaceState`，
> workspace 包用 `workspace`。脚本里已分别处理。

## 设计要点（为何这样改）

- **按 `path` 匹配而不是 `title`**：标题可被用户改名（`renameWorkspace`），
  路径才是稳定身份。`WorkspaceView.path` 是 canonical 路径，由 `dsh-workspace`
  用 `fs.realpath` 规范化过。
- **插在 `workspaceId` 之后**：显式参数代表"用户已经做了选择"
  （hero 的 `onPick` → `selectWorkspace` → `connectWorkspace` →
  `sessions.create({ workspaceId })` 全都显式带 id），必须优先于默认值，
  否则"用户改选后落入其他区"会失效。
- **保留 `currentWorkspaceId` 兜底**：日常使用分区被删或未注册时
  `dailyUseId` 为 `undefined`，自动退回原行为，不会让新建会话失败。
- **不动 sidebar**：调用方 `dsh-client-ui-sidebar` 有 3 处
  （170/225 行无参、294 行带 id），改一处 `target` 计算即覆盖全部无参调用。

## 重打步骤

```powershell
node "$env:DSH_HOME\plugins\dsh-daily-workspace\patch-dsh-daily-default.mjs"
```
脚本对**两个**目标都做：断言锚点唯一 → 自动备份 → 写回 → `node --check`（不过则自动回滚）。
已打过则报"补丁已存在"，幂等。

## 验证

1. 重启 DSH，刷新页面
2. 在**任意其他分区**（如「超级智能体」）打开一个会话
3. 点侧栏「新对话」→ 应落在 **「日常使用」**
4. 在 hero 里把分区改选成别的 → 新会话应落在**你选的那个**

### 服务端证据（最快判定补丁是否生效）
抓首页里的组合脚本 URL → 下载该 bundle → grep `dailyUseId`。
**有 = 补丁在生效；没有 = 被覆盖或没重启。**
> 注意：`dsh-client-ui-workspace/client.js` 单独取会 404（它不在模块清单里），
> 必须从组合 URL 一起取。

## 关联

- 分区本身的创建在插件 `dsh-daily-workspace`（宿主侧，`%DSH_HOME%\daily-use`）
- 同类补丁：`dsh-agent-maker/PATCH-dsh-agent-preset-selector.md`
