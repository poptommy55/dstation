---
name: dsh-plugin-dev
description: 开发 / 调试 / 安装 DSH (DeepSeek Harness) 的第三方插件——宿主半与浏览器半的骨架、/plugins 客户端模块格式、槽位与 DOM 后处理、路由与安全边界、以及把"看不见的状态"变成可查证据的排障方法论。触发词：开发 DSH 插件、写一个插件、给 DSH 加功能、插件不生效、插件不显示、卡片不出现、插件抖动、宿主路由、client.js、dsh.bundle、dsh.client、槽位 slots、插件安装到 profile。**每次开发/修改任何一个 DSH 插件后，必须把新踩到的坑按本文格式补进「坑清单」，并把该插件记进「插件台账」。**
whenToUse: 当任务涉及在 DSH / DeepSeek Harness / D-STATION 里开发、修改、调试或安装插件时；当用户报告某个插件"装了没反应 / 不显示 / 不出效果 / 界面抖动 / 按钮被挡"时；当需要给 DSH 的 Web GUI 加 UI、加宿主路由、注册槽位、注册模型工具、或读取本地文件给浏览器用时；当要生成可供预览的图片/音频/视频测试样本时；以及任何一次插件改动完成、准备收尾（必须回填坑清单与插件台账）时。不确定是否该加载时：只要涉及 DSH 插件的代码或排障，就加载。
---

# DSH 插件开发 Skill

## 这个 Skill 怎么用

- **开发新插件前**：先读「插件骨架」与「验证方法论」两节，照抄骨架、先建自检页再写功能。
- **调试插件时**：直接跳「坑清单」，按**症状**查表。这张表是三个插件的真实故障记录，命中率很高。
- **改完任何插件后（强制）**：把新坑按同样格式追加进「坑清单」，把插件登记进「插件台账」。
  台账与坑清单是本 Skill 的全部价值所在——**不更新等于这次白干**。

---

## 一、插件骨架（照抄，不要重新发明）

一个 DSH 插件就是**三个文件**，不需要打包器、不需要 TS、不需要构建步骤：

```
<plugin-dir>/
  package.json          名字 + dsh.bundle.patch + dsh.client + exports
  index.js              宿主半（Node 侧）：路由 / 工具 / 服务
  client.js             浏览器半：手写 DSH 模块格式
  cordis.patch.yml      把自己插进 profile 的插件树
```

### package.json

```json
{
  "name": "dsh-my-plugin",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": [] }
  }
}
```

### cordis.patch.yml

```yaml
- insert:
    - id: my-plugin          # 插件树里的 id，patch 用它定位
      name: 'dsh-my-plugin'  # 包名
```

### index.js（宿主半）

```js
export const name = 'dsh-my-plugin';
export const inject = ['webServer'];          // 只列真正必需的；可选服务用 ctx.get() 探测

export function apply(ctx) {
  const dispose = ctx.webServer.register({
    kind: 'prefix',                            // 'prefix' 或 'exact'
    path: '/dsh-my-plugin/api',
    handler: async (req, res) => { /* node:http 原生 req/res，自己 writeHead/end */ }
  });
  ctx.effect(() => () => dispose(), 'dsh-my-plugin.routes');
}

export default { name, inject, apply };
```

- **必需服务**放 `inject`；**可选能力**用 `ctx.get('xxx')` 探测，缺了要降级而不是崩。
- 只导入 Node 内置模块 + 运行时才 `await import()` DSH 的包（见坑 #12）。
- 需要给模型工具：`ctx.get('tools')?.register(defineTool({...}))`，
  `defineTool` 用动态 import（`await import('@deepseek-ai/dsh-tools')`），拿不到时用恒等函数兜底。

### client.js（浏览器半）

```js
(function () {
  window.__ModuleLoader__.load({
    id: 'dsh-my-plugin',                       // 必须等于包名
    factory: function (require) {
      var module = { exports: {} };
      var exports = module.exports;
      exports.name = 'dsh-my-plugin';
      exports.inject = ['slots'];              // 只依赖槽位；不要依赖 DSH 内部服务
      exports.apply = function (ctx) { /* ... */ };
      return module.exports;
    }
  });
})();
```

**静态模块表**（`require()` 能直接拿到，其他一律 throw）：

```
react, react/jsx-runtime, react-dom, react-dom/client,
@deepseek-ai/cordis, @deepseek-ai/dsh-client-store,
@deepseek-ai/dsh-client-ui-slots, @deepseek-ai/dsh-client-ui-primitives
```

### 安装到 profile

```powershell
$profile = "$env:DSH_HOME\profiles\web"
Copy-Item -Recurse <plugin-dir> "$profile\node_modules\dsh-my-plugin"
# package.json 里加两条：
#   dependencies."dsh-my-plugin": "file:./node_modules/dsh-my-plugin"
#   dsh.profile.bundles 追加 "dsh-my-plugin"
# 然后重启服务（见「运维」）
```

---

## 二、验证方法论（本 Skill 的核心，比代码重要）

**铁律：UI 效果不能靠"看"，要靠可查的证据。**

浏览器半住在用户的窗口里，你（agent）看不见它。历史上三次"插件不生效"，
三次根因都不同，**全都是靠加证据定位的，靠猜一次都没猜对**。

### 三条证据链，缺一不可

| 证据 | 怎么拿 | 能回答什么 |
|---|---|---|
| ① 服务端在发哪一版 | 带 token 拉 `/`，找到组合脚本 URL（含 `&rev=`），抓下来 grep 构建号 | "用户拿到的是新代码吗" |
| ② 宿主能力是否正常 | 直接 `fetch` 宿主路由（脚本探针，不靠界面） | "宿主这一侧通不通" |
| ③ 浏览器端跑到哪一步 | DOM 属性 `data-*` + 自检页 | "模块加载了吗 / 扫到了吗 / 渲染了吗" |

### 构建号是命根子

client.js 里放 `var BUILD = 'vN-日期-短说明'`，并且：

- 写进注入的 `<style data-plugin-build="...">`
- 写进 `<html data-dsh-media-build="...">`（通用命名：`data-<你的前缀>-build`）

**改代码必须同时 +1**，否则"用户到底跑的是哪一版"永远说不清。

### 状态写进 DOM 属性，不要靠浮层

```js
document.documentElement.dataset.mypluginPhase = reason;   // apply:start / apply:ok / scan:done
document.documentElement.dataset.mypluginScans = String(STATS.scans);
```

**默认不要显示浮层**：常驻浮层会压住左下角的侧边栏按钮（实测被投诉过）。
要看的时候给个开关：URL 带 `?<前缀>-debug=1`，或 `window.__MYPLUGIN_DEBUG__ = true`。

### 三种故障的判据表（照这个排）

| 现象 | 结论 | 下一步查什么 |
|---|---|---|
| DOM 上**完全没有** `data-*` | 客户端模块没加载 | bundle 在启动图里吗？抓组合脚本 grep 包名 |
| 有 build、没有 phase | 加载了但 `apply()` 没跑 | 你的 `inject` 声明对不对、apply 前是否抛异常 |
| 有 phase、没有 scans | apply 跑了但扫描没启动 | `document.body` 存在吗？`ctx.effect` 被调了吗 |
| scans 有、candidates=0 | 扫到了但没认出目标 | 跳过规则是否误伤（见坑 #2） |
| candidates>0、cards=0 | 认出来了但渲染失败 | 把异常写进 `data-*-error` |

### 自检页模式（强烈推荐，成本很低）

宿主半加一条 `/<前缀>/selftest` 路由，返回一个**自包含 HTML**：

1. 上半页：宿主真读盘/真调用的结果表格（类型、大小、文件魔数、逐项判定）；
2. 下半页：把**真实的 client.js** 注入进去（`window.__ModuleLoader__` 桩 + 注入 `<script>`），
   对真实数据现场出效果；
3. 底部：把关键读数直接写在页面上（元素数、解码数、**稳定后 N 秒内的 DOM 变更数**）。

用户只要打开这个 URL 截个图，就能一次分清故障在哪一侧。
**比让用户开 DevTools 现实一万倍。**

---

## 三、坑清单（症状 → 根因 → 修法）

> 每一条都是真实踩过的。新增的请追加在末尾，保持格式一致。

### #1 插件"装上了但界面上什么都没发生"

- **症状**：宿主路由 200 正常，界面上毫无变化，浮层也没有。
- **根因**：客户端模块其实没加载 —— 启动图（boot graph）里没有它，
  或 `<package>/client.js` 组合脚本 404。
- **修法**：带 token 拉首页 → 从 HTML 里抠出**含 `&rev=` 的完整组合 URL**（注意 HTML 里
  是 `&amp;`）→ 抓下来 grep 包名。只抓 `/plugins/<pkg>/client.js` 会 404，
  真实入口是组合 URL。

### #2 该出效果的地方没出效果：跳过规则误伤

- **症状**：路径明明在正文里，却没有变成卡片。
- **根因**：跳过规则写得太宽。真实案例：把"任何 `<code>` 内部"都跳过，
  而模型最自然的写法恰恰是把路径放进行内代码（反引号）。
- **修法**：区分**行内代码**与**代码块**——判据是"祖先里有没有 `<pre>`"，
  不能只看直接父节点（语法高亮会把 token 包成 `<span>`，只看父节点会漏）。
- **教训**：跳过规则要按**用户实际会写的样子**设计，不要按自己的洁癖设计。

### #3 界面不停抖动（文字/图片在闪）

- **症状**：页面元素反复重建，像有个看不见的手在刷新。
- **根因**：**自激循环** —— 插件改 DOM → 触发自己的 `MutationObserver` →
  重扫 → 重建 → 再触发。典型的自我伤害。
- **修法**（三道闸，全都要）：
  1. 自变更标志：扫描期间置 `selfMutating = true`，`finally` 里 `setTimeout(…, 0)` 复位，
     观察器回调开头 `if (selfMutating) return;`
  2. 内容指纹：把本轮认出的候选排序拼成 key 写在宿主容器上，
     与上一轮相同就**整轮跳过**，不重建；
  3. 跳过自己的节点：观察器与扫描都要忽略带自己标记的元素（`closest('[data-*-host]')`、
     `closest('[data-*-legend]')`）。

### #4 媒体元素（video/audio）反复闪烁或回到第一帧

- **症状**：图片看着正常，只有视频在闪；或视频一加载就重来。
- **根因**：渲染函数每次重绘都用 `replaceChildren()` **重建** `<video>`。
  在浏览器里"重建元素" = "重新加载媒体"。
- **修法**：让渲染**幂等**——记住舞台当前挂的 `{kind, src}`，
  只有两者之一变了才重建；已挂好的元素只更新可变属性（alt 等）。

### #5 卡片永远停在"正在确认…"，下载按钮是灰的

- **症状**：能出卡，但内容区一直显示"正在向宿主确认这个文件…"。
- **根因**：把预览**押在一次 HTTP 往返上**。只要那次请求既不 resolve 也不 reject
  （`fetch` 在回环场景下真出现过），状态就永远停在 pending。
- **修法**（两件事一起做）：
  1. **预览不依赖往返**：URL 约定是确定性的，客户端自己拼、立刻交给浏览器加载；
     登记降级为"补充信息"（体积、权威类型），回来再更新卡片。
  2. 传输层换成 `XMLHttpRequest` 并带超时（15s 登记 / 60s 下载）——
     XHR 一定会以 load/error/timeout 结束；外加一个 watchdog 把 pending 换成明确失败。
- **教训**：任何"等一次网络"的状态都要有超时和可见失败，否则用户看到的是一个不动的转圈。

### #6 容器合法 ≠ 浏览器能播

- **症状**：宿主 200、MIME 正确、字节范围服务全对，`<video>` 报"格式不受支持"。
- **根因**：手写的 **MJPEG-in-MP4** 容器结构完全合法（帧表逐项校验通过），
  但 Chromium 的 `<video>` 不解 MJPEG —— 它只在 `<img>` 里能解 JPEG。
- **修法**：用浏览器真支持的编解码器。**先查机器上有没有 ffmpeg**，有就用它：
  ```
  ffmpeg -framerate 15 -i f%04d.png -c:v libx264 -profile:v baseline \
         -level 3.1 -pix_fmt yuv420p -movflags +faststart out.mp4
  ```
  `yuv420p` + baseline + faststart 三件套是兼容性下限。
- **教训**：**先盘点环境（`Get-Command ffmpeg`）再决定手写还是调用**。
  我为了"不引依赖"手写了一百多行编码器，而机器上本来就装着 ffmpeg 8.1。

### #7 错误卡片里仍在加载被拒绝的文件

- **症状**：宿主明确拒绝（文件在工作区外），卡片进了错误态，但 `<img>` 还在请求。
- **根因**：渲染函数在"未登记 → 明确拒绝"之间被调用多次，
  但错误分支只改了提示文字，没清掉上一轮算出来的 `src`/`item`。
- **修法**：错误分支必须显式 `src = null; item = null;`。
  **渲染函数要么彻底幂等，要么每个分支都写全**，不能有"残留状态"。

### #8 从 DOM 里读状态时读到的是旧值

- **症状**：诊断浮层永远显示"扫描 0 轮"，而功能其实是好的。
- **根因**：只在 `apply` 阶段刷新了一次状态，扫描结束后没刷新。
  **显示错误数字的诊断装置比没有诊断装置更糟**——它会把你带偏。
- **修法**：状态刷新放在**每个阶段结束时**（扫描的 `finally` 里也刷一次），
  并且别让刷新动作自己触发观察器风暴。

### #9 行内脚本里的 `</script>` 会提前闭合

- **症状**：注入 client.js 源码的自检页只渲染到一半就崩。
- **根因**：client.js 里任何字符串含 `</script`，注进 `<script>` 就截断 HTML。
- **修法**：注入前转义：`src.replace(/<\/script/gi, '<\\/script')`。

### #10 子进程被沙箱拒绝（EPERM / Access is denied）

- **症状**：`node --test test/` 直接 `spawn EPERM`；`... | Select-String` 时报
  "Program 'node.exe' failed to run: Access is denied"。
- **根因**：DSH 文件沙箱禁止子进程通过**管道**通信。
- **修法**：
  - 测试不要在**目录**上跑多进程：写一个 `run-tests.mjs` 把测试文件 `import` 进同一进程；
  - **不要用 PowerShell 管道接 node 输出**，直接跑、让输出原样回显；
  - 需要落盘证据时，用脚本写文件再 `read`。

### #11 连不上用户正在用的窗口

- **症状**：想用 CDP 检查真实界面，`/json/list` 不可达。
- **根因**：DSH 的 Electron 主窗口由 launcher 启动，**没有开远程调试端口**。
  独立起一个 Electron 实例则被单实例锁 + React 版本混装（18/19 同时存在）绊住。
- **修法**：接受这个限制，用「自检页 + DOM 属性 + 用户截图」三件套。
  **不要试图改 launcher 去开调试端口**——那要重启整个应用、丢用户会话。

### #12 DSH 的包在工作区外单独跑测试会解析失败

- **症状**：`Cannot find package '@deepseek-ai/dsh-tools'`。
- **根因**：profile 目录能回退到 DSH 安装目录解析包，工作区目录不能。
- **修法**：对 DSH 的包一律用**动态 import + 兜底**：
  ```js
  let defineTool = (def) => def;
  try { ({ defineTool } = await import('@deepseek-ai/dsh-tools')); } catch { /* 恒等兜底 */ }
  ```
  这样逻辑照样能被单测覆盖，生产环境走真实现。

### #13 只在一层目录里找样本 ⇒ 自检页显示"没有样本"

- **症状**：自检页说找不到可测文件，其实工作区里有。
- **根因**：成品通常放在 `<工作区>/<子目录>/` 里，只扫一层永远找不到。
- **修法**：递归两层，并用目录数/条目数上限封顶，避免在巨目录里扫穿磁盘。

### #14 改了插件文件但界面没变

- **根因**：DSH 对**已加载**的插件不自查文件变化，客户端 bundle 按 specifier 缓存。
- **修法**：改完 → 同步到 profile → **重启服务** → 刷新页面。
  重启会丢"进行中的那一轮"（会话记录不丢，是持久化的）。
  **攒够改动再重启一次**，不要改一行重启一次（用户会以为程序挂了）。
  重启后务必用证据链 ① 确认新构建号已经在服务端。

### #15 🔴 槽位组件必须返回 React 元素，返回原生 DOM 节点会静默失败

- **症状**：按钮/组件在槽位里**根本不出现**，控制台也没有可见报错；
  而同一槽位上别的插件（如 `dsh-composer-upload`）正常。
- **根因**：槽位是 **React 渲染**的（`renderSlot(...)` → `react_jsx_runtime`）。
  给它一个 `document.createElement('button')` 的返回值，React 渲染不了，
  整个条目被丢掉，**没有任何提示**。
- **修法**：槽位里注册的组件一律返回 `React.createElement(...)`（或 JSX）。
  本地没有 React 变量时用 `require('react')`（插件工厂里 `require` 可用）。
  ```js
  function MyButton() {
    var React = require('react');
    return React.createElement('button', { className: 'x', onClick: open }, '打开');
  }
  ```
- **推论**：纯 DOM 只在「自己挂到 document.body / 自己创建的容器」里安全；
  一旦进入别人的 React 树，就必须用 React。
- **代价记录**：这条坑让我多绕了一大圈（面板用纯 DOM 的判断被错误地延伸到按钮上）。

### #16 重启后历史卡片集体变成"拒绝访问：文件不在任何允许的会话工作区之内"

- **症状**：重启 DSH 之后，**以前正常**的卡片全部报错，且都指向同一类路径
  （例如工作区旁边另一个目录 `D:\DSH\DH2\geometry-svg-lessons\*`）。
- **根因**：允许根只取了「部署 workspaceRoot + **当前 live 会话**的 cwd」。
  重启后旧会话不再 live，它们目录里的文件就掉出白名单 —— 历史消息里的卡片集体失效。
- **修法**：允许根要包含**用户登记过的工作区**（这是"登记过就该长期可读"的语义），
  而且**两份注册表都要读**：
  ```
  %DSH_HOME%\storages\workspace.json          ← 会话 home
  %USERPROFILE%\.dsh\storages\workspace.json  ← 用户级 home（常被漏掉！）
  ```
  后者里的 `D:\DSH` 恰好覆盖了被拒的那批路径。
  读盘结果做 30s 缓存；`realpath` 校验、受保护目录、只读这些边界**不要放松**。
- **教训**：任何"从运行态推导的白名单"都要问一句：**重启后它还成立吗？**

### #17 失败状态一旦记进内存就再也不会重试

- **症状**：宿主侧的限制已修好，界面上的卡片却仍显示旧错误，**只能整页刷新**才恢复。
- **根因**：客户端把"登记结果"缓存在内存 Map 里，且跳过逻辑写成
  `if (entry.status !== 'pending') continue;` —— **连"失败"也一起跳过了**。
- **修法**：只跳过**已成功**与**在飞**的，失败的允许重试：
  `if (entry && entry.status === 'ok') continue;`
  另外给错误态加一个「重试」按钮（清掉本地记录、重新请求），别让用户只能刷新页面。
- **教训**：缓存失败要留出口。凡是"记住了一次失败"的地方，都要想清楚怎么撤销它。

### #18 会话日志是多帧 zstd，直接解只能拿到几十字节

- **症状**：用 `zstdDecompressSync(readFileSync(file))` 解 `session.jsonl.zstd`，
  4MB 的文件只解出 180 字符、1 行事件。
- **根因**：DSH 的会话日志是**多帧** zstd（每帧一段）。该 API 只解第一帧。
- **修法**：按帧魔数 `28 B5 2F FD` 切开逐帧解、拼接：
  ```js
  const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
  for (i...) if (buf[i]===MAGIC[0] && ...) starts.push(i);
  // 每帧 zstdDecompressSync(buf.subarray(starts[k], starts[k+1]))
  ```
  实测 88KB → 124 帧 → 21 万字符，能完整读出另一个对话里发生了什么。
- **用途**：用户说"另一个对话里插件没生效"时，**这是唯一能还原现场的证据源**。
  配合"抽正文里的媒体路径 → 逐个问宿主 /allow"，可以直接定位到"哪条路径被谁拒了"。

### #19 会话目录名的编码要靠"枚举+文件系统验证"来解，不要硬推规则

- **症状**：想从 `…\sessions\<编码目录名>\<session>\session.jsonl.zstd` 反推工作区路径。
- **根因**：编码规则是「非 ASCII → `~XXXX`、分隔符与盘符冒号 → `-`、两端再包 `-`」，
  但**路径里本来就有的 `-` 与分隔符无法从字符串上区分**，而且包裹层数靠肉眼数不可靠
  （我先后猜错两次：先漏剥一层、后多剥一层把盘符标记吃掉）。
- **修法**：把「两端各剥 0/1/2 个 `-`」×「内部每个 `-` 是否算分隔符」**全枚举**，
  再用 `os.path.isdir` 验证 —— 真实路径必然存在，唯一解会自己浮出来。
  ```python
  for lead in (0,1,2):
    for tail in (0,1,2):
      for combo in combinations(dash_positions, keep): ...
          if os.path.isdir(candidate): return os.path.abspath(candidate)
  ```
  实测：`--D-DSH-DH2-~5B9E~9A8C~533A--` → `D:\DSH\DH2\实验区`，
  `--C-…-knowledge-bases--`（含连字符的歧义样本）也正确，无效串返回 None。
- **教训**：解析别人的私有编码时，**用现实（文件系统/服务端）当裁判，而不是用推理当裁判**。

### #20 交付媒体/文件预览类插件时，要区分「路径驱动的卡片」与「主动浏览面板」

- **症状**：用户说"AI 生成的图片不会自动显示"，我一路在"路径识别"上打补丁，
  加自检页、重试、允许根……始终没解决。
- **根因**：**搞错了需求**。用户要的是"不管对话里有没有路径，都能翻看并下载刚生成的东西"，
  而路径驱动方案有个前提——**媒体路径必须出现在消息文本里**，模型不写路径就什么都没有。
- **修法**：直接把需求二选一问清楚，再动手：
  | | 语义 | 实现 |
  |---|---|---|
  | A | 对话里引用了路径的地方显示卡片 | 扫正文 + 出卡 |
  | B | 不管有没有路径，都能翻看并下载工作区里的成果 | 一个「最近生成」面板 |
  两者是**不同功能**，B 不依赖 A 的任何机制（不依赖文本、不依赖模型配合）。
- **教训**：**用户描述的是期望效果，不是你脑补的实现路径**。动手前先问一句是哪一种。

### #21 调试时反复重启服务 = 反复把用户的界面搞停

- **症状**：用户连续问"怎么又停了""到哪了"。
- **根因**：改一行客户端代码 → 同步 → 重启服务（约 10-20 秒白屏，看门狗恢复）
  → 再改一行 → 再重启。用户每轮都被打断一次。
- **修法**：
  1. **攒够一批改动再重启一次**；能在一个批次里验证完的，不要拆成多次；
  2. 先把"完全不依赖服务端"的部分做完（纯函数、单测、静态页面），再动需要重启的；
  3. 重启前在回复里说清"我要重启了，约 15 秒"，别让用户以为程序崩了；
  4. 客户端版本号（`BUILD`）+1，重启后用组合 URL 验证服务端真的在发新版 —— 避免白重启。

- **🔴 升级版（2026-09-14 实测，代价很大，务必读）**：
  频繁重启会**耗尽看门狗的重试预算，让服务直接停住**：
  ```
  [17:18:13] dsh 进程已退出（退出码 4294967295）。
  [17:18:13] [看门狗] 已连续重启 5 次仍失败，停止重试。
  ```
  此时 **DSH 处于关闭状态，用户的界面连不上**，要等有人手动再启动。
  本次在 45 分钟里重启了十几次，触发了两次"停止重试"。
- **`Stop-Process -Force` 的退出码是 `4294967295`（= -1）**，与真崩溃**可以区分**：
  ```powershell
  Select-String -Path "$env:DSH_HOME\..\launcher.log" -Pattern "退出码 (\d+)" |
    ForEach-Object { $_.Matches[0].Groups[1].Value } | Group-Object | Sort-Object Count -Descending
  ```
  排查"到底是不是插件把服务搞崩了"时**先跑这个**：
  | 退出码 | 含义 |
  |---|---|
  | `4294967295` | 被强杀 ⇒ **是人在重启，不是崩溃** |
  | `3221226505` | `0xC0000409` 硬终止（原生库/GGML_ABORT）⇒ 真崩 |
  | `1` | 普通退出 |
  本次实测：`4294967295 × 39`（我的重启）、`3221226505 × 2`（且最后一次在**删掉那个原生插件之后就没再出现**）。
  **不先分类退出码就下"插件崩了"的结论，会把责任判错方向。**
- **还有一个坑**：**"杀掉服务"的那条命令会把自己也带走**（会话就住在 DSH 进程里），
  于是工具调用被中断、结果未知。所以重启要用**分离进程延迟执行**，
  让命令先正常返回：
  ```powershell
  $exe = (Get-Process -Id $PID).Path
  Start-Process -FilePath $exe -ArgumentList "-NoProfile","-Command",
    "Start-Sleep -Seconds 5; Stop-Process -Id <pid> -Force" -WindowStyle Hidden
  ```
  （注意 `pwsh` 不一定在 PATH 上，要用 `(Get-Process -Id $PID).Path` 取当前 shell 的绝对路径。）

### #22 🔴 `package.json` 的 `files` 白名单漏掉运行时 import 的同级模块 → 插件被看门狗禁用

- **症状**：用户报「重启后插件报错，被禁用了」。`launcher.log` 里是：
  ```
  ERR_MODULE_NOT_FOUND: Cannot find module '...node_modules\dsh-media-preview\mime.js'
    imported from '...node_modules\dsh-media-preview\index.js'
  [看门狗] 检测到确定性插件错误，停止无意义重试: dsh-media-preview
  [看门狗] 已禁用 media-preview          ← 自动往 cordis.patch.yml 写 disabled: true
  ```
- **根因**：`package.json` 的 `files` 白名单**只列了 `index.js` / `client.js` / `test`**，
  漏了 `index.js` 运行时真正 import 的 `mime.js` / `path-guard.js` / `http-range.js`
  （还列了一个根本不存在的 `lib`）。一旦 pnpm 重新落盘 `node_modules`，
  就按白名单只拷列出的文件，**三个模块被静默删除** → 下次启动 import 直接崩。
- **为什么特别容易踩**：本项目的安装方式是
  `"dsh-media-preview": "file:./node_modules/dsh-media-preview"` ——
  **pnpm 读的就是已安装目录自己的 `package.json`**。所以这个白名单有自我毁灭性：
  它决定了下一次安装会不会把插件自己删残。**改源目录的那份不够，必须同时改已安装那份。**
- **修法**：
  1. 把运行时 import 的所有同级模块补进 `files`，删掉不存在的条目；
     顺手加一条自检——`files` 里每一项要么真实存在，要么是运行时 import 到的；
  2. 已安装目录与源目录的 `package.json` **两份都要改**；
  3. 补齐缺失文件后重启/热加载即可恢复。
- **诊断套路（可复用）**：静态扫描每个插件的相对 import 是否落地——
  遍历 `profiles/web/node_modules/dsh-*`，对每个 `.js` 用正则抓 `from './x.js'`，
  再 `existsSync(resolve(dirname(file), spec))`。本次一跑就同时回答了
  「media-preview 缺什么」和「别的插件有没有同样的病」（结果：`dsh-canvas-preview` 无此问题）。
  脚本：`D:\DSH\DH2\实验区\scan-plugin-imports.mjs`。
- **注意误报**：JSDoc 里的 `import('...')` 类型注解会被抓成缺失（本次 `dsh-better-sidebar`
  的 `../../graphlib/graph.js` 就是 `/** @type {Record<import(...)>} */`），**不是运行时依赖**，
  判问题前先看那一行的上下文。
- **教训**：`files` 白名单是「发布契约」，必须与代码的真实依赖图对齐。
  **改完代码增删模块时，回头看一眼 `files`。**

### #23 测试里写死等待时长 < 真实异步耗时 → 假失败

- **症状**：单测 `tool: media_preview 注册到 tools 服务` 报「应当注册 media_preview 工具」，
  但产品功能其实是好的。
- **根因**：该工具注册是 async（要先动态 `import('@deepseek-ai/dsh-tools')`），
  测试写死 `await new Promise(r => setTimeout(r, 30))` 就去看结果；
  而实测这个 import 在本机**稳定约 51ms**，30ms 经常不够 → 随机假失败。
- **修法**：把固定 sleep 换成**轮询等待**（每 10ms 查一次，上限 2s）：
  ```js
  let tool;
  for (let wait = 0; wait < 200 && tool === undefined; wait += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    tool = registeredTools.get('media_preview');
  }
  ```
  通过场景毫秒级返回，慢机器也不误报。
- **顺手得到的证据**：量 import 耗时的探针同时证明了
  `@deepseek-ai/dsh-tools` 在 profile 目录下**能**正常解析（51ms 成功），
  与坑 #12 的「工作区外单独跑才失败」互为印证。
- **教训**：**任何 `setTimeout` 当同步屏障的测试都是脆的**。
  等异步结果就用轮询 + 超时，别猜一个数字。

---

### #24 🔴 两个插件争抢同一段正文文本 → 卡片"闪一下就没了"

- **症状**：ACES 生成好的图片在对话里出现一下随即消失，宿主侧毫无报错；
  用户描述为"以前能预览，现在不能了"。
- **排查顺序（这次真正有效的路径：从宿主往外走，别一上来改客户端）**：
  1. 文件本体 —— 读魔数，确认是真 PNG（`89504e47`）而不是错误页；
  2. 宿主路由 —— 直接 GET `/dsh-media/file?path=…`，返回 **200 + `image/png`**
     （中文名与 ASCII 名**都**返回 200，顺带排除"非 ASCII 文件名"这一嫌疑）；
  3. 允许根 —— GET `/dsh-media/health`，确认清单里**含当前会话工作区**
     （本次是 `D:/DSH/DH2/实验区`），排除坑 #16 那类边界问题；
  4. **数一数浏览器侧有几个渲染器** —— 这一步才是根因所在：
     `profiles/web` 里同时装了 `dsh-media-preview` **和** `@wingsky-1/dsh-web-file-preview`，
     两个 `/health` 路由**都是 200**，即两个插件同时活着、同时改同一片对话流 DOM。
- **根因**：两个插件都对聊天流里的路径文本做 DOM 后处理：
  - `dsh-media-preview`：藏掉路径文字 + 在块后挂自己的卡片；
  - `@wingsky-1/dsh-web-file-preview`：嗅探路径并用 `fetch → Blob → objectURL`
    内联渲染（**带 `AbortSignal`**）。
  一方重建节点 → 另一方的 in-flight 请求被 abort → **图片先出现再被撤掉**。
  这类冲突**不报错**，只表现为闪烁/消失，所以靠读日志永远查不出来。
- **时间线证据（"为什么以前好的"）**：`cordis.patch.yml` 里记着
  `dsh-media-preview` 曾因缺 `mime.js`/`path-guard.js`/`http-range.js` 被看门狗自动禁用
  （见坑 #22），2026-09-13 补好后**移除禁用恢复加载** —— 第二个渲染器上线的时间点，
  与"预览开始闪烁"的时间点吻合。
- **修法**：**同一类 DOM 后处理渲染器，一个 profile 里只留一个。**
  本次禁用 `@wingsky-1/dsh-web-file-preview`，验证方式（可复用的判据）：
  ```
  改前：/api/dsh-file-preview/health → 200    /dsh-media/health → 200
  改后：/api/dsh-file-preview/health → 401    /dsh-media/health → 200   ← 只剩一个渲染器
  ```
  再让它生成一张新图（走完整链路：出图 → 落盘 → 正文写绝对路径），用户确认"正常了"。
- **代价（必须同时告知用户）**：被禁用的那个还提供文件预览 Modal / HTML 预览 / Diff /
  Mermaid 渲染，禁用后这些一起没了。**二选一是临时解法**；
  要两者共存，得让其中一个跳过已被另一个处理的块（改客户端协作逻辑），那是更大的改动。
- **顺带确认的规则**（写正文路径的姿势，来自 `dsh-media-preview` 的跳过谓词）：
  - 路径写进 ``` 围栏代码块**不出卡片** —— 它明确不碰 `<pre>` 里的内容（见坑 #2）；
  - **纯文本行**与**单个反引号**都能出卡片；
  - 只认**绝对路径**，且文件必须在允许根内。
- **教训**：`/health` 路由是排查"谁在线、谁在抢"的**第一手证据**，
  比读代码快得多。凡是"效果不稳定/闪烁/消失"类问题，
  先问一句：**这片 DOM 上有几个插件在动手？**

---

### #25 侧栏 HTML 预览里，外部 js/css 被 `nosniff` 静默拒收

- **症状**：把 AI 生成的 HTML 用 `sidebar_open` 开到右侧栏，页面**能打开但显示不全**
  （缺样式、少交互、图表不出现）；而**单文件内联**的页面完全正常。
  浏览器控制台才会报"因 MIME 类型不符而拒绝执行"。
- **根因**（2026-09-13 实测）：`dsh-better-sidebar` 的 `/sidebar/html` 路由用
  `mediaTypeForPath()` 决定 Content-Type，而它的 `MEDIA_TYPES` 表
  **只收录 9 种图片 + pdf + html/htm**，`.js` / `.css` / `.json` / `.mjs` / `.woff2`
  全部回落 `application/octet-stream`；同一响应又带
  `X-Content-Type-Options: nosniff` ⇒ 浏览器严格 MIME 校验，直接拒收。
- **证据（逐条可复现）**：
  ```
  /sidebar/html/<sid>/…/probe2.html        → 200  text/html; charset=utf-8
  /sidebar/html/<sid>/…/probe-classic.js   → 200  application/octet-stream   ← 元凶
  /sidebar/html/<sid>/…/*.png              → 200  image/png                  ← 图片没问题
  越界：…/../../Windows/win.ini            → 400        （`..` 穿越）
         C:\Windows\win.ini（工作区外）     → 403
  ```
  响应头同时含 `Content-Security-Policy: sandbox allow-scripts allow-popups
  allow-downloads allow-modals; object-src 'none'`（⇒ 内联脚本可执行，但页面在不透明源）。
- **连带结论**：不透明源 ⇒ `fetch()` / `XHR` / 外部 `type="module"` 不可用，
  `localStorage` 被拒。**内联 module 可以跑**（不涉网络）。
- **修法**：产物按**单文件自包含**产出（内联 `<style>`/`<script>`；图片可外链同目录；
  数据硬编码），生成后 `sidebar_open` 打开。规则已写进 `$DSH_HOME/AGENTS.md`
  的「生成 HTML 产物时的硬性约束」一节。
- **上游可修（本次没动）**：给 `MEDIA_TYPES` 补 `.js/.css/.json/.mjs/.woff2`。
- **教训**：第三方预览器的"**能打开**"≠"**能正常显示**"。
  验一条静态资源路由时，**必须连响应头（Content-Type + nosniff）一起看**，
  否则会把"静默降级"误判成"功能正常"。

---

### #26 🔴🔴 在宿主进程内加载原生 GPU 库 → **整个 DSH 被硬终止**，看门狗反复重启

- **症状**：插件装上去第一次真正使用（加载模型）时，DSH 进程直接消失，窗口白屏，
  看门狗 2 秒后拉起、恢复页面，用户再次触发又崩 —— **反复重启**。
  `launcher.log` 里是：
  ```
  [dsh] D:\a\node-llama-cpp\...\ggml\src\ggml-cuda\ggml-cuda.cu:108: CUDA error
  dsh 进程已退出（退出码 3221226505）。
  [看门狗] 2s 后自动重启 dsh（第 N/5 次）...
  ```
- **根因**：退出码 `3221226505` = `0xC0000409` = **STATUS_STACK_BUFFER_OVERRUN**，
  是 llama.cpp 的 `GGML_ABORT` 触发的**进程级 fail-fast**。
  **它不是异常，`try/catch` 抓不到，只能整个进程死。**
  触发条件是「在 DSH 进程内初始化 CUDA 后端」——DSH 进程里已加载的原生模块
  （node-pty / libsql / @neon-rs / puppeteer-core 等）与 CUDA 上下文冲突。
- **判别实验（务必按这个顺序做，不要凭直觉下结论）**：
  1. 在**干净 node 进程**里跑同一份引擎 → 正常（本次 ctx 4096~32768 全过）；
  2. 换成 **DSH 自带的 `runtime\node\node.exe`** 再跑 → **也正常**
     ⇒ 排除"node 版本不兼容"；
  3. 再把 `contextSize` 调大 → 仍正常（VRAM 16GB 只用 2.28GB）⇒ 排除"显存不足"；
  4. 结论：**同样的二进制、同样的参数，只有进了 DSH 进程才崩** ⇒ 是宿主进程内的冲突。
  > 本次我先误判成"上下文太大导致 OOM"，做了实验 3 才推翻；
  > 又误判成"Electron 环境问题"，做了进程身份检查（DSH 服务其实是真正的
  > `runtime\node\node.exe`，不是 Electron 模式）才推翻。**别跳过实验。**
- **修法（唯一可靠的一种）：把原生推理放进子进程，插件只做管理者。**
  - 子进程用 `process.execPath`（=DSH 自带 node）启动，加载模型、暴露一个
    回环 HTTP 接口；父进程（插件）通过 HTTP 流式取结果。
  - 这样 GPU **照样可用**（实测 43 层上 GPU、2.2GB 显存），而崩溃只死子进程，
    父进程捕获连接失败 → 转成一个可读错误的 `finish` 块，DSH 毫发无伤。
  - ⚠️ **spawn 不要用管道 stdio**：宿主沙箱下 pipe 会 EPERM。
    用 `stdio: ['ignore', logFd, logFd]`，日志落文件。
  - 子进程要有**空闲自退**（如 30 分钟无请求即退出），防止宿主异常消失后
    留下孤儿进程占着显存。
- **代价**：多一个后台进程、多一份显存常驻；换来宿主再也不会被带崩。
- **教训**：
  1. **原生库（CUDA/驱动级）是宿主进程的"不可捕获风险源"**。任何会把
     `.node` 原生模块加载进宿主进程的插件，都要先问一句：**它崩了谁来兜？**
     答案是：没人兜得住，只能隔离到子进程。
  2. **"在我这边跑得好好的"不构成证据**。必须做**判别实验**把变量逐个排除
     （干净进程 / 同二进制 / 同参数 / 再看宿主），否则会把结论建立在猜测上。

---

### #27 🔴 鸭子类型实现 LLM 适配器：漏掉基类默认方法 → 运行期才炸

- **症状**：插件加载成功、路由注册成功、模型也能在选择器里看到，
  但一发起请求就返回
  `{"kind":"error","failure":{"message":"adapter.prepareCall is not a function"}}`。
- **根因**：`ctx.llm.registerAdapter()` **不做 `instanceof` 检查**（只校验
  `adapter.providerInfo()` 返回的 id/name），所以鸭子类型实现是可行的；
  **但基类 `LlmAdapter` 提供的默认方法也随之丢失**，而 `LlmRuntime` 运行期会调它们。
  实测只实现 `providerInfo / providerRetryPolicy / listModels / resolveModel / stream`
  是不够的 —— 还缺 `prepareCall`（和潜在的 `imageRequestPricing`）。
- **修法**：鸭子类型实现必须把这 7 个都补齐（基类默认实现照抄即可）：
  ```js
  imageRequestPricing() { return undefined; }
  async prepareCall(provider, model, signal) {
    return { model: await this.resolveModel(provider, model, signal),
             stream: (options) => this.stream(options) };
  }
  ```
  出处：`dsh-llm/lib/index.js` 的 `LlmAdapter` 类（`prepareCall` 在其 L1143）。
- **教训**：**鸭子类型不等于"可以少实现"**。绕过基类时，先通读基类**所有**方法，
  把自己当成那个基类来补全。

---

### #28 🔴 模型把工具调用标签注册成 CONTROL token → 库默认解码把它们**静默丢掉**

- **症状**：模型明明产出了工具调用，但拿到的文本是残片：
  ` name="get_weather"> name="city">Beijing`（`<function` / `<param` 凭空消失），
  XML 解析必然失败。**不报错、不警告**，只是内容缺了。
- **根因**：本模型词表里
  `<function`=18 / `</function>`=19 / `<param`=20 / `</param>`=21 全是
  **CONTROL(3)** 类型，而 `<think>`=8 / `</think>`=9 是 **USER_DEFINED(4)** 类型。
  `node-llama-cpp` 默认的流式解码（`onTextChunk`）**丢弃 CONTROL 类 token、
  保留 USER_DEFINED 类** —— 所以 `<think>` 活下来、工具标签死掉。
- **修法**：不用 `onTextChunk`，改用 `onToken` + **显式指定 specialTokens**：
  ```js
  let allTokens = [], text = '';
  onToken: (tokens) => {
    const piece = model.detokenize(tokens, true, allTokens); // ← true = 保留特殊 token
    allTokens = allTokens.concat(tokens);
    text += piece;
  }
  ```
  **并且不要再采信库返回的 `response`**（那份是错误解码的结果），用自己累计的 `text`。
- **诊断方法（可复用）**：把词表里相关项的**类型**打出来就能一眼看出问题。
  GGUF 元数据是**按前缀嵌套**的（`metadata.tokenizer.ggml.token_type` 等），
  不是扁平 key；`readGgufFileInfo(path, { readTensorInfo: false })` 读，不用加载模型。
  ```js
  const tg = info.metadata.tokenizer.ggml;
  tg.tokens.forEach((t, i) => { if (/function|param/.test(t)) console.log(i, tg.token_type[i], t); });
  ```
- **教训**：**"文本里少了几个字符"这类静默缺失，几乎都是 tokenizer 层级的问题**，
  不是模型不听话、也不是你的解析器写错。先去查词表里那些标记的 token 类型。

---

### #29 🔴 cordis 的 `ctx` 是 Proxy：访问未注入属性会抛错并**带崩整个插件树**

- **症状**：插件装完重启，DSH 启动失败，看门狗写回 `disabled: true`，
  `launcher.log` 里是：
  ```
  failed to apply loader entry minicpm-local: cannot get property "config" without inject
  ```
- **根因**：`ctx` 是 Proxy，`get` 陷阱对**未注入的属性**直接抛
  `cannot get property "X" without inject`。这个异常会沿着插件树冒泡，
  **导致整棵插件树加载失败**，进而被看门狗自动禁用。
- **修法**：
  1. **不要盲信"把名字加进 inject 就行"**：全 DSH 插件树里**没有任何插件**把
     `config` 放进 inject，说明惯用做法是 `apply(ctx, config)` 的**第二参数**。
     加一个不可满足的 inject 会让插件永远等不到加载 —— 比报错更难排查。
  2. 正确姿势：
     ```js
     export function apply(ctx, pluginConfigArg) {
       let cfg = pluginConfigArg;
       if (cfg == null) { try { cfg = ctx.config; } catch { cfg = {}; } }
       ...
     }
     ```
  3. **所有诊断日志也要包起来**：`ctx.logger` 同样可能是致命点，写个
     `safeLog()` 内部 try/catch，别让"打日志"把插件打死。
- **教训**：
  1. `apply()` 里**任何一行抛异常 = 插件树挂掉 = 被自动禁用**。
     入口函数的每一处外部访问都值得包一层。
  2. 排查顺序：**先读 launcher.log 里的那一行原始错误**，
     它会直接给出属性和原因，比任何猜测都快。

---

### #30 插件真实路径在 `%DSH_HOME%\plugins\` 时，`@deepseek-ai/*` 解析不到

- **症状**：插件里 `await import('@deepseek-ai/dsh-llm')` 抛
  `Cannot find package '@deepseek-ai/dsh-llm'`，而 `node-llama-cpp` 之类
  装在插件自己 `node_modules` 里的包正常。
- **根因**：插件通过 junction 挂进 `profiles/web/node_modules` 时，
  Node 默认**按 symlink 的真实路径解析依赖**，于是从
  `%DSH_HOME%\plugins\<plugin>\` 向上找 —— 那里没有 `@deepseek-ai`。
- **修法**：**不要 import DSH 的包，用注入的服务 + 按契约手工构造数据**。
  例：自检路由需要一条 user 消息时，直接写
  ```js
  { id: `x-${Date.now()}`, role: 'user', content: [{type:'text',text}], source: {kind:'user'} }
  ```
  即可（`source.kind` 是 `'user'` 就够），不需要 `createUserMessage`。
- **教训**：坑 #12 的变体。**凡是 DSH 的包，一律优先通过 `ctx` 注入的服务使用**；
  真要 import，先确认它在**插件的真实路径**下可解析。
- **🔴 最阴的变体：它会让「设置页里看不到自己的插件」**（实测踩到，代价是一轮返工）。
  失败路径**完全安静**：
  ```
  await import('@deepseek-ai/schemastery')  →  抛错（被 catch 吞掉）
    → schema 拿不到 → ctx.settings.register() 从未执行
    → 设置命名空间不存在
    → 设置页那一行查不到命名空间 → 没有可解析的设置地址
    → 用户报"设置里根本看不到这个模型"
  ```
  而宿主侧 `registerAdapter()` / `registerConfigurableProviders()` **都成功了**，
  自检路由看起来一切正常 —— 只有设置页是坏的。
- **修法（不要试图"把包弄进来"）：读源码，照最小契约自己实现 schema。**
  `dsh-settings` 的 `register()` 只把 schema 存下来，全流程只有两处用到：
  ```js
  // resolve()   —— 只是把它当函数调用
  const value = schema(mergeLayers(base, section));
  // describe()  —— 只是序列化给设置页渲染表单
  schema: registration.schema.toJSON()
  ```
  **没有任何 instanceof / 类型校验**。所以"可调用的、带 `toJSON()` 的对象"完全满足契约，
  零依赖且不受版本漂移影响：
  ```js
  const schema = (data) => { /* 逐字段归一 + 回退默认值 */ };
  schema.toJSON = () => ({ type: 'object', meta: { default: defaults }, dict: {...} });
  ```
  ⚠️ 反过来，**别把 `config` 之类塞进 `inject` 去"解决"解析问题** —— 见坑 #29，
  不可满足的 inject 会让插件永远等不到加载，比报错更难排查。
- **配套动作（强制）**：自检路由里**必须显式暴露"命名空间是否注册"这个布尔值**
  （`namespaceRegistered`），否则这个故障在宿主侧完全不可见。

---

### #31 🔴 没申报 `reasoningEffort` 档位 → 请求在**发起前**就被拒绝

- **症状**：模型能在选择器里选中，但一发消息就失败（不是卡住，是直接不出结果）。
- **根因**：`dsh-llm` 会把请求里的 `reasoningEffort` 与该模型适配器**申报的档位集合**比对，
  **不匹配就在发起 provider I/O 之前拒绝**
  （原文：*"Unsupported explicit efforts reject before provider I/O"*）。
  适配器完全不声明 `reasoning` 时，任何显式档位都会被拒。
- **修法**：`resolveModel()` 返回 `reasoning.efforts`，并且**把 DSH 可能传来的标准档位
  全部收下**（`off` / `low` / `medium` / `high`），不要只声明自己"想要"的那两个：
  ```js
  reasoning: {
    efforts: [{id:'off',…},{id:'low',…},{id:'medium',…},{id:'high',…}],
    defaultEffort: 'off',
  }
  ```
  再定一条**可预测**的映射规则，例如
  「设置里 false ⇒ 绝不思考；否则听请求：'off' 不思考、其余都思考」。
- **教训**：**适配器申报的能力集合是一道准入闸门，不是提示。**
  凡是 DSH 可能传下来的枚举值，要么全支持，要么明确接受被拒。

---

### #32 小模型的「思考链」会把输出预算烧光 → 用户报"卡死"

- **症状**：用户说"不能用，**卡在思维链里**"——界面上思考内容在长，却迟迟没有正文。
- **根因**：DSH 的真实请求包含**完整 agent 系统提示词 + 几十个工具定义**，
  对 2B 级模型是超大提示词。模型进思考模式后会把**整个 `maxTokens` 预算烧在推理上**：
  实测 25~30 tok/s × 4096 tokens ≈ **2~3 分钟没有任何可见回答**。
  从用户视角这就是"卡死"，但进程其实活得好好的。
- **修法**：
  1. **默认关闭思考**（`enableThinking: false`），把思考做成显式选项。
     实测同一问题从"长时间无输出"变成 **4.3 秒直接作答**。
  2. `maxTokens` 按模型规模调小；对 2B 模型 4096 太长。
  3. **给推理层加"每次生成的现场日志"**：提示词字符数、耗时、停止原因、输入输出 token。
     没有这行日志，"卡死"永远无法定位。
- **教训**：
  1. **"卡死"要先区分「真死」还是「很慢」**——看日志里有没有
     `generate 开始` / `generate 结束` 就知道，别靠感觉。
  2. **模型规模决定默认参数**。给 30B 合适的默认值，套到 2B 上就是不可用。
  3. 接新模型前先问：**它的输出预算够不够它自己"想完"？**

- **🔴 更根本的一层：DSH 的 agent 提示词本身就会压垮小模型**（继续实测出来的）。
  只关思考还不够。在 **20003 tokens 系统提示词 + 28 个工具** 的真实规模下，
  同一个"讲个故事"出现两种失败，**都不报错、都"有输出"**，所以极难判断：
  | 条件 | 表现 |
  |---|---|
  | 开思考 | 卡在"分析系统提示词里的任务分类"，烧完预算也不回答 |
  | 关思考 | 被 agent 角色框死，**直接拒绝**："我是工作助手，无法讲故事" |
  > 这两种都不能靠"看日志有没有报错"发现——协议完全正常、
  > `finish: stop`、有正文。**只有人工读一遍回答内容才知道答非所问。**
- **修法：给插件一个 `promptMode` 开关。**
  - `'chat'`：**替换掉** DSH 的 system（换成一句短人设）+ **丢弃 `options.tools`**；
  - `'agent'`：忠实使用 DSH 的完整 system 与工具。
  实测换成 chat 模式后，同一问题输入从 **~18500 tokens 降到 63 tokens**，回答正常。
  给"只当对话模型用"的小模型默认 `'chat'`，需要 agent 能力时再切回 `'agent'`。
- **教训（最值钱的一条）**：
  **"请求成功"不等于"回答正确"。** 协议层全绿、`finish` 正常、有正文，
  模型却可能根本没回答用户的问题（复述人设 / 拒绝 / 去调工具）。
  交付任何模型接入，**必须亲自读一遍模型的实际回答**，
  并**在真实规模下测**（真实大小的系统提示词 + 真实数量的工具）——
  小样本上通过不能说明任何问题。


---

### #33 接 Ollama 类外部推理服务：五个「不显式做就会静默出错」的点

> 背景：内嵌方案（坑 #26）被判定无使用价值后，改为对接本机 Ollama。
> 这条路**反而更好**：模型跑在 Ollama 自己的进程里，插件只做协议翻译 + DSH 注册，
> 既没有原生库炸宿主的风险，模型列表还能**动态读**（pull 了新模型自动可选），
> 且**零第三方依赖**。以下五点是实测踩到的。

- **① `/api/tags` 的 `capabilities` 不可靠，必须用 `/api/show` 复核。**
  实测同一模型两个接口给出不同答案：
  | 模型 | `/api/tags` | `/api/show` |
  |---|---|---|
  | `maternion/minicpm5:2b` | `completion` | **`tools/thinking`**/completion |
  | `SetneufPT/Qwopus3.5-9B` | `completion` | **`tools/thinking`**/completion |
  | `gemma4:latest` | completion/tools/thinking | **+ `vision/audio`** |
  只看 tags 会严重低估模型能力。做法：tags 出列表，`/api/show` 逐模型补全并缓存。
- **② 思考开关必须显式下发 `think`，不能靠默认。**
  Ollama 对思考型模型**默认就开思考**；不传 `think` 等于放任它烧输出预算
  （实测：不传时漏出 32 字思考；显式 `think:false` 后归零）。
  但**没有 thinking 能力的模型不能传这个字段**，所以要先查能力再决定传不传。
- **③ `num_ctx` 必须显式设置。**
  Ollama 默认上下文很小（实测 4096），而 DSH 的 agent 提示词约 18.5K，
  不设置会被**静默截断**。统一设可配置值（默认 32768），并用 `ollama ps`
  核对实际生效的 CONTEXT 列。
- **④ 用原生 `/api/chat` 而不是 OpenAI 兼容端点。**
  原生接口把 **`thinking` 与 `content` 分成两个字段**，不必再解析 `</think>`；
  还直接给 `prompt_eval_count` / `eval_count`（精确 token 用量）与 `done_reason`。
  OpenAI 兼容端点拿不到这些。
- **⑤ DSH 把工具结果塞在 `role='user'` 的消息里**，而 Ollama 有独立的 `tool` 角色。
  混用会让模型困惑：转换层必须把带 `tool-result` 块的消息转成 `role:'tool'`；
  同时 assistant 的 `tool_calls` 参数要**从 JSON 字符串转成对象**（Ollama 收对象）。
- **教训**：接外部推理服务时，**"默认值"是最危险的地方** ——
  `think` 的默认、`num_ctx` 的默认、能力清单的来源，三处默认都会静默出错。
  做法是把每一个都**显式写进请求**，并用服务端自查接口（`ollama ps`、`/api/show`）
  核对生效结果。

---

### #34 🔴 图片「附加成功」但模型说看不到 —— 闸门在 `resolveModel().inputModalities`

- **症状**：给支持视觉的模型发图，全链路看起来都正常：
  `image.attached = true`、引用里 `width/height/bytes` 都对、协议全绿、`finish: stop`。
  **但模型的回答是"您未提供图片或附件内容（sha256 哈希值无法还原图像）"**。
- **根因**：DSH 的 `LlmRuntime` 用 **`resolveModel()` 返回的 `inputModalities`** 决定
  「把 durable 图片引用**投影成真实请求图片**」还是「**替换成含 sha256 的确定性文字占位符**」。
  我把该字段写死成 `['text']`（关掉视觉时的遗留），于是图片被换成占位文字。
  注意 `listModels()` 里是对的 —— **两处都要反映同一能力，漏一处就只坏在半路**。
- **判据（可量化，别靠肉眼）**：对比 **`usage.inputTokens`**。
  同一张图：真实投影时 `in=161`；被替换成占位符时 `in=70`。
  模型看到的字节变了，token 数必然变 —— 这是最快的判别法。
- **修法**：
  ```js
  inputModalities: info?._vision === true ? ['text', 'image'] : ['text'],  // resolveModel 里
  ```
  并让 `listModels()` 与 `resolveModel()` 用**同一个判定函数**，不要各写一份。
- **图片链路本身（正确姿势，全部实测过）**：
  ```js
  ctx.get('attachments').readImageRequest(ref,
      { maxPixels, maxBytes }, signal)      // → { data: Uint8Array, mediaType, … }
  // 再 Buffer.from(data).toString('base64') 交给 Ollama 的 message.images
  ```
  `ImageBlock` 里**只有 durable 引用**（`attachmentId`/`mediaType`/`width`/`height`），
  没有字节；不经过附件服务拿不到图。写入端用
  `attachments.saveImage({ data, mediaType, name })`（`mediaType` 只收
  png / jpeg / webp / gif）。
- **教训**：
  1. **模型能力有两道门：能力清单（给选择器看）与请求模态（给投影器看）。**
     只开一道，症状是"看起来成功但内容是假的"，比直接报错更难查。
  2. **"附加成功"这类中间态日志会骗人** —— `attached: true` 只说明引用被接受，
     不代表模型收到了图。验证必须看**模型的实际回答**与**token 数**。
  3. 这条又是"端到端实测"抓出来的：单测 24/24 通过、协议检查、附加状态**全是绿的**。

---

### #35 🔴 `SettingsScope` 没有 `.value` —— 写 `scope?.value` 会让插件**永远读不到用户配置**

- **症状**：界面上改配置 → 保存成功 → **settings.yaml 里确实写进去了** →
  但插件行为毫无变化。而且**极难察觉**，因为默认值往往看起来本来就是对的。
  暴露它的契机是：写入后**立刻回读**，发现返回的还是旧值。
- **根因**：`ctx.settings.register(ns, schema)` 返回的 `SettingsScope` 接口只有
  ```ts
  get(): T
  watch(cb: (next: T, prev: T) => void): () => void
  update(patch: object): Promise<void>
  replace(section: object): Promise<void>
  ```
  **没有 `.value` 属性**。写成 `scope?.value` 恒为 `undefined`，
  于是 `readConfig()` 每次都回落到默认值 —— 用户层被完全忽略。
- **修法**：
  ```js
  const readConfig = () => {
    let resolved = null;
    try { resolved = scope && typeof scope.get === 'function' ? scope.get() : null; } catch { resolved = null; }
    return { ...defaults, ...pluginConfig, ...(resolved && typeof resolved === 'object' ? resolved : {}) };
  };
  ```
  并用 `scope.watch(() => invalidateCaches())` 让配置变更使缓存失效。
- **配套（做「界面可改配置」时的完整姿势）**：
  1. 字段定义**只写一处**（如 `configFields`）：schema 注册、界面渲染、
     写入校验全用它 —— 以后加配置项，界面自动就有；
  2. 写入口走**宿主自定义路由**（`GET/POST /<prefix>/config`），
     不要让客户端直接碰设置服务；
  3. **写入必须过白名单校验**：未知字段拒绝、按声明类型归一、
     非法值**报错而不是静默取默认**（"改了没生效"比报错难查十倍）；
  4. 提供「恢复默认」= `scope.replace({})`；
  5. 界面表单按宿主返回的**字段定义**动态渲染，不要硬编码字段。
- **教训**：
  1. **"写进去了"和"读出来了"是两件事，必须成对验证**：
     写完立刻回读，值没变就是没接通。只验 settings.yaml 会被骗。
  2. 读别人的接口时**照着 `.d.ts` 抄**，不要凭印象补一个"应该是 `.value`"。
     这里 `get()` 与 `.value` 差一个括号，代价是整个配置系统静默失效。
  3. 同样的错在**上一个插件里也犯过** —— 说明这是"看起来太自然"的陷阱。

---

### #36 🔴 第三方插件会 **fork 并接管** DSH 的客户端 UI —— 改原包无效，且**静态搜索会骗你**

- **症状**：给 DSH 客户端打补丁（改 `@deepseek-ai/dsh-client-ui-workspace/lib/client.js`），
  语法正确、重启完成，**但界面行为毫无变化**。
- **根因**：用户装了 `@michengai/dsh-archive-manager`，它**自带了 workspace UI 的完整副本**
  （`WorkspaceBrowser` / `WorkspacePicker` / `startSession` / `recentWorkspace` /
  `ctx.slots.inject("sidebar.workspaces")` …），**把原包整个接管了**。
  于是原包的代码根本不参与运行。
- **判据（⚠️ 必须用运行时证据，不能只搜磁盘）**：
  | 手段 | 结果 |
  |---|---|
  | 磁盘上搜 `recentWorkspace` | **两个文件都有**（原包 + archive-manager）→ **无法区分谁在跑** |
  | 服务端发出的客户端模块清单 | archive-manager **在**、原包 **不在** |
  | 服务端发出的 bundle 里数调用形态 | `recentWorkspace()`（archive-manager）**2 次**；<br>`recentWorkspace(workspace.items, sessions.byId)`（原包）**0 次** ⇒ **就是它** |
- **抓 bundle 的方法**（客户端无 cookie 鉴权，直接 curl 即可）：
  ```powershell
  # 1) 带 token 抓首页
  # 2) 从 HTML 里抠出 /plugins/??<id>/client.js,<id>/client.js&rev=… 这一整条
  # 3) curl 该 URL（约几十 MB），在内容里 grep 你的补丁标记
  ```
  ⚠️ **单独取 `/plugins/<pkg>/client.js` 会 404** —— 只有组合 URL 能取到。
- **修法**：**给所有副本都打补丁**（本例：archive-manager 那份负责当前生效，
  原包那份作为后备——卸载 archive-manager 后它会接管）。
  重打脚本要**遍历多个目标**，每个都断言锚点唯一 + 备份 + 语法校验 + 失败回滚。
- **教训**：
  1. **"磁盘上有这句代码" ≠ "跑的是这句代码"。** 与坑 #24（两个插件抢 DOM）、
     坑 #35（写完要回读）同源：**必须取运行时的第一手证据**。
  2. 改 DSH 客户端后，**验证方式是 grep 服务端发出的 bundle**，
     而不是 grep 你刚改的那个文件 —— 后者永远成功，毫无意义。
  3. 看到不认识的第三方插件（`@xxx/dsh-*`）时，先怀疑它是不是 fork 了某个官方包。

---

### #37 🔴 同一个 path 注册两条 `exact` 路由 → **插件树崩 + 看门狗禁用 + 用户看到"启动失败"**

- **症状**：插件写完第一次重启，**DSH 起不来**，`launcher.log` 里是
  ```
  [15:13:50] [插件] 检测到加载失败: id=wallpaper pkg=dsh-wallpaper | webserver: duplicate exact route "/dsh-wallpaper/config"
  [15:13:50] [看门狗] 检测到确定性插件错误，停止无意义重试: dsh-wallpaper
  [15:15:02] [看门狗] 已禁用 wallpaper
  ```
  然后看门狗往 `cordis.patch.yml` 追加 `- id: wallpaper` / `disabled: true`，服务才恢复。
- **根因**：宿主路由的键是 **`(kind, path)`，不含 method**。
  `WebServer.register` 文档原话：*"Duplicate (kind, path) throws — route patterns are a
  composition-level contract, so a collision is a misconfiguration."*
  我为了区分读和写，给 `/config` 注册了两条 exact 路由（GET 一条、POST 一条）→ 直接抛。
  而这个异常发生在 `apply()` 里 ⇒ 带崩整棵插件树 ⇒ 看门狗禁用（同坑 #29 的机制）。
- **修法**：**一个 path 只注册一次**，方法靠 `req.method` 在 handler 内部分派。
  ```js
  route(`${PREFIX}/config`, async (req, res) => {
    if (req.method === 'GET') { /* 读 */ return; }
    if (req.method !== 'POST') { sendJson(res, 405, {...}); return; }
    /* 写 */
  });
  ```
- **配套（真正让它不再复发的东西）**：写一个**离线测试**，用一个假 ctx 跑 `apply()`，
  假 `register` **刻意复刻真实行为**（重复键就抛）。
  这样"路由表能不能装配起来"在**不重启服务**的前提下就能验证：
  ```js
  register(route) {
    const key = `${route.kind} ${route.path}`;
    if (routes.has(key)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
    ...
  }
  ```
  再加一条 `check('注册了 N 条路由', h.routes.size === N)` —— 加路由时数字会变，
  强迫你确认每一条都是有意为之。
- **教训**：
  1. **路由注册的冲突键是 `(kind, path)`，不是 `(method, kind, path)`。**
     直觉在这里是错的，读 `.d.ts` 才对。
  2. **"能不能装配起来"是可以在离线测试里验证的**，不要拿"重启一次试试"当第一手段 ——
     重启失败会让用户的界面直接停摆。
  3. 看门狗会**自愈**（禁用插件后继续启动），所以它不会把你永久锁死；
     但用户那一刻看到的就是"启动失败了"，要有心理准备并尽快说明。

---

### #38 🔴 宿主半**不会**热重载，只有客户端半会 —— 与"改动立即生效"的直觉相反

- **症状**：改了 `index.js`（宿主半），profile 配着 `patchReload: live`，
  插件树的 `insert` 也确实生效了（**新插件第一次加载不需要重启**），
  但**新代码没跑**：`GET /dsh-wallpaper/health` 仍返回旧的构建号。
- **实测对照**：

  | 改哪个文件 | 是否自动生效 | 证据 |
  |---|---|---|
  | `index.js`（宿主半） | ❌ 必须重启 | `/health` 一直报 `v1-...`，新路由全部 404 |
  | `client.js`（浏览器半） | ✅ 热重载 | 组合 URL 的 `rev` 从 `c3376efc67b7c9c0-59` 变成 `9be10966d298`，抓下来 grep 到新的 BUILD |
  | 往 `cordis.patch.yml` 追加 `insert` | ✅ 立即生效 | 插件当场出现在启动图里 |
- **根因**：宿主半是 Node 的 ESM 模块，**按解析后的 URL 缓存**。
  插件树重载只是重新 `import()` 同一个 URL，Node 直接返回缓存里的旧模块。
  客户端 bundle 是**内容寻址**的（`rev` 哈希），宿主会重新读盘并重新下发给浏览器。
- **修法**：
  1. 把改动**分批**：客户端半随便改（热重载），宿主半攒够了一次性重启。
  2. 重启用**分离进程 + 延迟**，别让"杀服务"的命令把自己带走（见坑 #21 升级版）：
     ```powershell
     $exe = (Get-Process -Id $PID).Path
     Start-Process -FilePath $exe -ArgumentList '-NoProfile','-Command',
       "Start-Sleep -Seconds 3; Stop-Process -Id $target -Force" -WindowStyle Hidden
     ```
  3. **重启后必须验证构建号**（`/health` + 组合 URL 的 `rev`），否则等于白重启。
- **血泪补充：写个"重启 + 自恢复验证"脚本，让分离进程自己把结果落盘。**
  否则会出现这一幕：你发起重启后立刻用工具去轮询服务恢复，
  而**你的会话就跑在 DSH 进程里** ⇒ 轮询命令跟着被杀，
  工具调用返回"结果未知"，你既不知道重启成没成、也不知道插件有没有加载失败。
  正确做法是让分离进程干完全部活（杀 → 等 `/health` 返回 200 → 拉 `/status`），
  **写进一个结果文件**；你的下一次工具调用只读那个文件。
  本次实测：`UP after = 6~8s`，三次重启全部一次成功。

---

### #39 浏览器侧诊断上报**共用一个槽位** → 后到的把先到的整个冲掉

- **症状**：探针明明上报了"侧栏计算背景色 = rgba(27,27,28,0.72)"，
  过一会儿再查 `/status`，那份读数**整个消失了**，只剩客户端模块报的 `phase:"saved"`。
- **根因**：宿主用**一个变量**存最近一次上报（`clientReport = {...parsed}`），
  而**两个来源**都会上报：宿主注入的探针（页面加载时）和客户端模块（设置面板挂载后）。
  后到的整体覆盖先到的。
- **修法**：**按 `source` 分槽存**，上报体里必须带来源标记：
  ```js
  const reports = { probe: null, client: null };
  const source = parsed && parsed.source === 'probe' ? 'probe' : 'client';
  reports[source] = { at: ..., ...parsed };
  ```
  探针脚本里写 `{ source: 'probe', ... }`，客户端 `report()` 里写 `source: 'client'`。
  并给它写测试：探针上报**不得**冲掉客户端槽，反之亦然。
- **教训**：**诊断装置自身的一致性也要设计。**
  一个会被别的来源悄悄覆盖的诊断，会让排查者拿着过期读数下结论 ——
  这和坑 #8（显示错误数字的浮层）是同一个病，只是方向相反（不是数字错，是**没了**）。

---

### #40 🔴🔴 PowerShell 文本往返（`Get-Content` → `Set-Content`）**毁掉了整个 UTF-8 中文源文件**

- **症状**：只想把源码里的构建号 `v6-...` 批量替换成 `v7-...`，用了
  ```powershell
  (Get-Content $f -Raw) -replace "v6-...","v7-..." | Set-Content $f -Encoding utf8 -NoNewline
  ```
  结果 `node --check` 直接报语法错误，报错行是
  `label: '鍥剧墖鏂囦欢鍚? },` —— **文件里所有中文都变成了乱码**，
  而且部分**行尾引号被吃掉**，语法都断了。
- **根因**：`Get-Content` 用了与本机不一致的编码去**读** UTF-8 文件
  （中文系统上是 GBK/CP936），内存里得到的已经是乱码字符串，
  再 `Set-Content -Encoding utf8` 写回 ⇒ **双重编码**。
- **它是可逆的，但不可逆完全**：用 GBK 反编码能把大部分还原
  （`[System.Text.Encoding]::GetEncoding(936).GetBytes($mojibake)` 再按 UTF-8 解码），
  实测 `图片文件` 确实回来了；**但每处「中文串紧邻 ASCII 字符」的边界都会丢掉那一个 ASCII 字节**
  （GBK 两字节一取，3N 字节的中文串会剩 1 字节，与后面的 ASCII 字符配对被吞）。
  index.js 173 处、client.js 58 处 `U+FFFD`，语法仍不通 ⇒ **信息已不可逆，只能重写文件**。
- **修法**：
  1. **绝不用 `Get-Content` | `Set-Content` 做文本替换**。改文本一律用 `edit` / `write` 工具
     （它们按 UTF-8 读写，不会碰编码）。
  2. 确实要在 shell 里做批量替换时，用 **.NET 显式指定编码**：
     ```powershell
     $t = [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)
     $t = $t.Replace('v6-','v7-')
     [System.IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($false)))
     ```
  3. **别用 `Get-Content` 看中文文件的内容再"照着改"** —— 显示的乱码可能是**渲染问题**，
     也可能是**文件真坏了**，两者用肉眼分不清。用 `read` 工具读，才能确定。
- **代价**：这次两个源文件（约 1400 行）全部重写，一轮返工。
- **教训**：
  1. **改一行也别图快走 shell 文本管道。** 省下的 10 秒换来一次全量重写。
  2. **构建号这类"到处都要改的常量"应该只有一处定义**，而不是散在多个文件里等着被批量替换。
  3. 「文件在磁盘上、内容我写过」≠「我随时能改回去」。**破坏性操作前先确认可恢复性。**

---

### #41 视觉强度类参数：**必须用「计算后的实际值」验收，不能看输入值**

- **症状**：用户点完「面板不透明度 = 60%」后反馈**"侧栏和卡片还是实的，没生效"**。
- **真相**（探针读回来的第一手数据）：
  ```
  tokens['--dsw-specific-sidebar-fill'] = "color-mix(in srgb, #1b1b1c 72.0%, transparent)"
  sidebarBg                             = color(srgb 0.105882 0.105882 0.109804 / 0.72)
  ```
  **覆写完全生效了，侧栏就是 72% 不透明** —— 问题在于我给各表面加的偏移量太大
  （base +0、侧栏 +12、卡片 +22、输入框 +26），用户输入的 60 被推到了 72%，
  叠在深色照片上肉眼分不出来。
- **根因**：**滑杆值 ≠ 生效值**。中间隔着一层映射，而映射是我自己写的。
  只看滑杆数字，等于用一个**推导量**去验收一个**观测量**。
- **修法**：
  1. 把映射的偏移整体压小（+10/+18/+22），默认值从 68 降到 38；
  2. **验收时读探针报回来的计算值**（`sidebarBg` / 各 token 的 `color-mix` 百分比），
     确认落在预期区间再交给用户看。
- **可复用判据**：**任何"中间隔着映射"的参数（透明度、缩放、阈值、权重、超时），
  都要有办法读到映射之后的实际值，并用它来验收。**
  这一条与坑 #8、#39 同源：**别拿自己的输入当结论。**
- **教训**：用户说"没生效"时，**先分辨是"真的没生效"还是"生效了但看不出来"** ——
  本次我一开始就误判成前者（怀疑 CSS 特异性），差点去改一个本来就正确的选择器。
  探针的 `sidebarBg` 一读出来，方向立刻就正了。

---

### #42 🔴 「手工 mount 行」与「bundle 通道」同时存在 → **双重挂载，启动失败**

- **症状**：把插件改成标准封装（自带 `cordis.patch.yml` + 加进 `dsh.profile.bundles`）后，
  如果 profile 自己那份 `cordis.patch.yml` 里的**手写 mount 行没删**，
  启动时宿主半会被注册两次 ⇒ `webserver: duplicate exact route "…"`
  ⇒ 插件树崩 ⇒ 看门狗禁用。**与坑 #37 是同一种死法，但根因完全不同。**
- **根因**：DSH 有**两条**把插件挂进插件树的路，它们**不互斥、也不会去重**：

  | 通道 | insert 从哪来 | 何时用 |
  |---|---|---|
  | **手工行** | 作者自己写进 profile 的 `cordis.patch.yml` | 早期 / 临时挂载 |
  | **bundle 通道** | 插件包自带的 `cordis.patch.yml`（`package.json` 的 `dsh.bundle.patch` 声明），profile 启动时自动合并 | 正规发布 |

  两条都开着 = 同一个包被 mount 两次。
- **修法**：**切换通道前先删掉旧的手工行。** `dsh-better-sidebar` 的补丁注释里
  专门写了这句警告（"remove it before switching to the bundle channel to avoid
  double-mounting"），照做即可。
- **自检**：让安装脚本**主动检查** profile 的 `cordis.patch.yml` 里还有没有自己的包名，
  有就报警（`dsh-wallpaper` 的 `install.ps1` 就是这么做的，实测有效）。
- **教训**：**"能装上去"和"只能装一次"是两回事。** 任何有两条安装路径的系统，
  都要在设计时就想清楚"两条同时走会怎样"，并给出检测手段。

---

### #43 Windows PowerShell 5.1 读**无 BOM 的 UTF-8 `.ps1`** 会按 ANSI 解码 → 脚本里的中文全乱

- **症状**：本地 `pwsh`（PowerShell 7）下跑得好好的 `.ps1`，发给用
  Windows PowerShell 5.1 的人之后输出乱码；严重时脚本直接语法报错。
- **根因**：**PowerShell 5.1 对 `.ps1` 的默认读取编码是 ANSI（中文系统 = CP936）**，
  而 `write` 工具（以及大多数现代编辑器）写出的是**不带 BOM 的 UTF-8**。
  于是非 ASCII 字符被按 ANSI 解码 → 乱码。
  **PowerShell 7 默认按 UTF-8 读，所以本机测试永远发现不了这个问题。**
- **修法（两条路，按需求选）**：
  1. **想要中文提示 → 写 UTF-8 带 BOM**。实测有效，连 emoji 都正常：
     ```powershell
     [IO.File]::WriteAllText($p, $text, (New-Object Text.UTF8Encoding $true))
     ```
     对照实验（同一段内容、同一台机器）：带 BOM → `中文输出测试：安装成功 ✅`；
     无 BOM → `Write-Host ('鍙傛暟: ' + ...)` **且直接抛 `The string is missing the terminator`**。
  2. **不需要中文 → 保持纯 ASCII**，更省事、更适合跨国分发：
     ```powershell
     ([regex]::Matches([IO.File]::ReadAllText($f,[Text.Encoding]::UTF8),'[^\x00-\x7F]')).Count  # 必须是 0
     ```
  ⚠️ **本机就是 5.1**：本仓库的 `pwsh` 工具实测 `$PSVersionTable.PSVersion` = **5.1.26100**，
  不是 PowerShell 7。所以这个问题**在本机就能复现**，别再用"本机跑得好好的"当理由。
- **`.cmd` / `.bat` 是另一条规则**：cmd.exe 用 **OEM 代码页**读批处理文件，
  UTF-8 中文会乱码，加 BOM 还会让第一行命令失效。
  ⇒ **`.cmd` 一律纯 ASCII**，中文交给它调用的 `.ps1` 去输出。
- **验收方式**（可复用）：交付前扫一遍非 ASCII 字符数（见上面第 2 条）。
- **教训**：
  1. 与坑 #40 是同一个病的两个面 —— **"文本文件的编码在传输边界上会变"**。
     凡是会离开你机器的东西（脚本、配置、文档），**要么只用 ASCII，要么显式控制 BOM**。
  2. **"在我这儿是好的"对文本编码完全不构成证据。**
  3. 补充认知：**BOM 不是"不得已的兼容手段"，而是"我想在 PS 5.1 上写中文"的正解。**
     真正不能用 BOM 的是 `.cmd`，不是 `.ps1`。

---

### #44 🔴 `file:///C:/…` 直接剥前缀得到 `/C:/…` → 数据**静默变空**，不报错

- **症状**：插件里读 profile 全部失败，但**没有任何异常**：补丁文件读不到、
  `package.json` 解析不出、22 个已装插件只认出 4 个。日志干净。
- **根因**：拿 loader 给的 include 路径做 `config.path.replace(/^file:\/\//, '')`，
  对 `file:///C:/Users/.../cordis.yml` 会得到 **`/C:/Users/...`**（盘符前多一个斜杠）。
  之后 `dirname()` / `readFileSync()` 全落在不存在的路径上，
  而所有读取都包在 `try/catch` 里 → **失败被吞成空值**。
- **修法**：用 `node:url` 的 `fileURLToPath()`，它拒绝时退化处理；
  最后兜底去掉 Windows 盘符前的前导斜杠：
  ```js
  function normalizeLocalPath(raw) {
    let s = String(raw ?? '');
    if (s.startsWith('file:')) {
      try { s = fileURLToPath(s); }
      catch { s = decodeURIComponent(s.replace(/^file:\/\//, '')); }
    }
    if (/^\/[A-Za-z]:[\\/]/.test(s)) s = s.slice(1);   // /C:/x -> C:/x
    return s;
  }
  ```
- **配套（比修法更重要）**：把这个路径**暴露到诊断接口里**。
  `/state` 现在同时返回 `rawInclude`（原始值）和 `includePath`（归一化结果）——
  一眼就能看出是"读不到"还是"路径本来就错"。
- **教训**：
  1. **"全都被 try/catch 包着"的系统会静默失败。** 读盘失败退化成空值，
     看起来像"这台机器上没装插件"，而不像报错。
  2. **任何"路径来自别人"的地方，都要把原始值和归一化结果都打出来。**
     这次若 `/state` 只返回归一化后的路径，我会去怀疑 loader，查不到真因。

---

### #45 🔴🔴 把 profile 补丁文件的**最后一行**删掉，会**让 dsh 彻底无法启动**

- **症状**：用户在管理面板里"停用 → 再启用"一个插件之后，**下次启动 profile 直接失败**：
  `must be a top-level YAML array of loader patch entries`。
- **根因**：profile 模板里的 `cordis.patch.yml` 带一个空列表占位符 `[]`。
  往它**后面**直接追加 `- id: X` 会产生"一个文档两个顶层元素"的 YAML 错误，
  所以正规实现会先**把 `[]` 注释掉**再追加。
  于是：**删掉最后一行之后，文件里只剩注释** —— 它不再是顶层数组，profile 起不来。
- **修法**：删除行之后必须"复活占位符"，且**每次改动都走这一条路径**：
  ```js
  function withPlaceholderRestored(text) {
    if (text.replace(/^[ \t]*#.*$/gmu, '').trim() !== '') return text;  // 还有内容，别动
    const uncommented = text.replace(/^[ \t]*#[ \t]*\[[ \t]*\][ \t]*(?:\r?\n|$)/mu, '[]\n');
    if (uncommented !== text) return uncommented;                       // 复活被注释的 []
    return text === '' || text.endsWith('\n') ? `${text}[]\n` : `${text}\n[]\n`;
  }
  ```
- **另外两条必须一起做**：
  1. **写入前先拒绝畸形文件**：文件不是合法的条目列表时宁可不写，也不能改得更糟。
  2. **别自己发明 YAML 语义** —— 这段语义抄自 `dshmarket/lib/patch.js`，
     它的注释里就写着这个坑的历史（"Disable a plugin, enable it again, and the profile is bricked"）。
- **验收方式**：**往返测试** —— 对同一文件做"加一行 → 删一行"，
  断言最终内容与初始**逐字节一致**（实测通过）；再断言删除后 `去掉注释的 trim()` 等于 `[]`。
- **教训**：**"写别人的配置文件"风险级别等同于改数据库。**
  必须幂等、可往返、拒绝畸形输入，并用"往返后逐字节相等"来验收。

---

### #46 按 id 写入的接口不校验"这个 id 存不存在" → 写出一堆**孤儿行**

- **症状**：管理面板上没点错什么，但 profile 补丁里多了一条
  `- id: dsh-dstation-market` / `disabled: true` —— 而该 id **根本不存在**
  （真实 entry id 是 `dstation-market`，不是包名）。
- **根因**：接口只校验了 id 的**格式**（`^[A-Za-z0-9_.-]+$`），
  没校验它**属于某个已装插件**。于是调用方把**包名**当 entry id 传进来也能写成功。
- **影响**（为什么不能不管）：
  1. 孤儿行本身不生效，但**污染补丁层**，让"用户到底改了什么"变得看不清；
  2. 更糟的是**将来真出现同名 entry 时它会被静默停用** —— 埋一个迟到的雷。
- **修法**：写入前必须解析出归属，解析不到就拒绝：
  ```js
  const owner = state.plugins.find((p) => p.entries.some((e) => e.id === entry));
  if (!owner) return sendJson(res, 404, { ok: false, error: `no installed plugin owns entry id "${entry}"` });
  ```
  顺带把"受保护插件"判定挂在同一个 `owner` 上（`@deepseek-ai/*` 与市场自己不允停用）。
- **教训**：**格式校验 ≠ 存在性校验。**
  任何"用 id 去改别人状态"的接口都要多问一句：**这个 id 现在真的指向一个东西吗？**
  这条与坑 #35（写完必须回读）、#42（两条安装路径要互斥检查）同族：
  **写入路径上每一个"我以为它一定成立"的前提，都得验一遍。**

---

### #47 🔴🔴🔴 一个坏插件包能让**整个 DSH 停机、且看门狗拒绝自愈**（本 Skill 最贵的一条）

- **症状**：用"插件市场"装了一个插件后重启，**DSH 起不来**，界面白屏。`launcher.log`：
  ```
  [15:09:39] [插件] 检测到加载失败: id=modules pkg=@deepseek-ai/dsh-client-modules
             | client-modules: 1 client package failed to compose:
  [15:09:39] dsh 进程已退出（退出码 1）。
  [15:09:39] [看门狗] 核心条目失败，拒绝自动禁用: @deepseek-ai/dsh-client-modules
  ```
  **最后一行是致命的**：平时插件加载失败，看门狗会往 `cordis.patch.yml` 写
  `disabled: true` 自动禁用、继续启动（见坑 #37）。但这里失败的是**核心条目**，
  看门狗**明确拒绝自动禁用** ⇒ 没有任何自愈路径 ⇒ **只能人工介入**。
  实测代价：用户界面全黑，要靠外部工具救回来。
- **根因（自建市场自己造的）**：打包时插件的 `files` 白名单没写 `package.json`，
  于是装出来的插件目录里**没有包元数据**。DSH 的 `ClientModuleRegistry.resolveMeta`
  会从模块路径**向上找最近的 `package.json`**，结果把**别的包**的 `dsh.client` 声明
  算到了这个包头上，于是抛：
  ```
  client-modules: dsh-demo-hello declares dsh.client but exports no "./client" bundle
  ```
  ⇒ `dsh-client-modules` 组装失败 ⇒ 核心条目失败 ⇒ 全站停机。
- **三层修法（缺一层都不够）**：
  1. **打包器**：`package.json` **永远进包**，不受 `files` 白名单影响（硬性不变量）；
     并在打包时就校验自洽性 —— 声明了 `dsh.client` 就必须有 `exports["./client"]`
     且该文件真的在包里；声明了 `dsh.bundle.patch` 就必须有那个补丁文件。
  2. **安装器**：**在写任何文件之前**做自洽性校验 —— `package.json` 必须存在、
     `name` 必须与清单一致、`dsh.client` 的导出能解析到实际文件、
     `dsh.bundle.patch` 指向的文件存在。任一条不合格 ⇒ **整体拒绝，不留半成品**。
  3. **测试**：用**故意造出来的坏包**去撞闸门（本次补了 6 组断言，
     每组都额外断言"被拒之后目标目录不存在"）。
- **教训**：
  1. **插件市场的失败模式不是"这个插件不好用"，而是"全站停机"。**
     安装器必须假设**每一个包都可能是坏的**，校验点必须在
     **"写进插件树 + 注册进启动路径"之前** —— 装完再发现就太晚了。
  2. **"核心条目"不可自动禁用**，所以任何能让 `dsh-client-modules` / `dsh-app-boot`
     这类包组装失败的东西，风险等级等同于"删系统文件"。
  3. **自测不能只用自己写的、本来就正确的包。** 要专门造坏包
     （缺元数据 / 声明与实现不符 / 文件缺失）来证明闸门真的会拦。
  4. 附带一条通用设计教训：**"从模块路径向上找最近的 package.json"这类解析逻辑，
     在包不完整时会静默地把别人的配置算给自己。** 自己设计插件体系时要防这个；
     凡是"向上找"的元数据解析，都该加一条"找到的 package.json 的 name 是否等于期望值"的断言。

---

### #48 🔴 快照/备份的 ID 只有**秒级精度** → 同秒内互相覆盖 → **回滚到错误的版本**

- **症状**：单测里"更新到 v1.0.1 → 故意让 v1.0.2 校验失败 → 自动回滚 → 再从历史备份手动回滚"
  这条链路的最后一步，**回滚出来的不是预期的 v1.0.0**。
- **根因**：备份 ID 用 `new Date().toISOString().slice(0,19)`（秒级）当目录名，
  而每次备份开头都会 `rmSync(dest, {recursive:true})` 清理同名目录。
  **同一秒内两次备份 → 同一个 ID → 第二份把第一份删掉**。
  于是"回滚到上一版"实际拿到的是**更早**的那一版 —— 失败回滚最不能出的问题。
  本机跑得快，"一次更新 + 一次失败更新"经常落在同一秒里。
- **修法**：ID 必须天然唯一 —— 毫秒/微秒时间戳 + 进程内自增序号：
  ```js
  let seq = 0;
  const stamp = `${new Date().toISOString().replace(/[:.]/g,'-').slice(0,23)}-${String(++seq).padStart(3,'0')}`;
  ```
- **验收**：把 `backupPlugin` 暴露给测试，**连调两次**（间隔 0ms），断言
  `bk1.id !== bk2.id` 且 `listBackups().length === 2`。现已加回归测试。
- **教训**：**任何"用时间戳当唯一标识"的地方都要问：同一毫秒/同一秒会不会撞？**
  快照、备份、操作 ID、日志文件名、临时目录全是高发区。
  而且它**只在快的时候暴露** —— 手工点两下永远测不出来。

---

### #49 "取最新版本"不能靠目录遍历顺序

- **症状**：包目录里同时有 `1.0.0/` 和 `1.0.1/`，重新生成索引后 `latest` 却写成 **1.0.0**，
  于是**市场永远看不到更新**，且不报任何错。
- **根因**：索引构建时 `for (const v of readdirSync(...))` 取"**先遍历到的**那个"就 `break`。
  目录遍历顺序不保证（不同文件系统还不一样）。
- **修法**：按 **semver 倒序**排序后再取第一个，不能按字符串排：
  ```js
  const versions = readdirSync(nameDir, { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name)
    .sort((a, b) => cmpVer(b, a));
  ```
  插件端判断"有没有新版本"也必须用 semver 比较，**不能用 `!==`**
  （否则索引里版本更低时也会显示"有新版本"）。
- **验收**：打包两个版本后断言 `index.latest` 等于较高者，且 `totalSize` 与新版目录一致。
- **教训**：**"最新/最大/最优"这类语义必须显式排序求得，绝不能依赖遍历顺序。**
  与坑 #44 同族：**这类"看起来必然成立"的前提，都是静默失效的温床。**

---

### #50 插件目录若是 junction 的**目标**，就**不能重命名它** —— 替换只能"清空内容再填充"

- **症状**：设计"原子替换"时最自然的写法是
  `rename(target → target.old)` → `rename(staging → target)`。但在 DSH 插件体系里这么做会让
  `profiles/<p>/node_modules/<pkg>` 的 junction **悬空**，插件当场失效。
- **根因**：插件是"**真实目录 + profile 里一条 junction**"的组合，junction 记的是**路径**。
  目录一改名，junction 就指向不存在的路径。
- **修法**：
  1. **不重命名目标目录**；替换用"清空目录**内容**（保留目录本身）+ 递归复制新内容"；
  2. 因此**原子性只能靠备份来兜**：先完整备份 → 再替换 → 失败整目录还原；
  3. `清空内容` 必须是"删掉目录里的条目"，**不是删掉目录**：
     ```js
     for (const e of readdirSync(dir)) rmSync(join(dir, e), { recursive: true, force: true });
     ```
- **⚠️ 开发期的连带陷阱**：若用 junction 把 `plugins/<pkg>` 指向**源码工作区**
  （本项目的做法），"清空内容"会**顺着 junction 删掉源码**。本项目实测确认。
  处理方式：**先把 `plugins/<pkg>` 从 junction 改成真实目录**，
  删链接用 `cmd /c rmdir <junction>`（**不加 `/s`**，只删链接），
  删前备份工作区、删后**校验文件数与总字节数不变**。
- **验收**：更新后断言"目标目录本身仍存在且是目录" + "profile 那条 junction 仍能解析到 package.json"。
- **教训**：
  1. **"目录"不只是目录，它可能是一条链接的一端。** 对插件目录做破坏性操作前先问：
     **它是真实目录还是链接？删/改名会不会波及其他地方？**
  2. 删链接时 `cmd /c rmdir`（不加 `/s`）比 PowerShell 的 `Remove-Item -Recurse` 可预测；
     **后者会顺着链接删进目标** —— 这是一条能直接毁掉源码的操作。

---

### #51 🔴 nginx 的 `types{}` 是**替换**不是追加 —— 静态页 `.html` 会被**下载**而不是渲染

- **症状**：把 `index.html` 部署到服务器，访问返回 **200**，但浏览器把网页**下载成了文件**。
  `curl -I` 显示 `Content-Type: application/octet-stream`；同目录的 `index.json` 却是正常的
  `application/json`。**页面代码本身没问题**，问题在服务器。
- **根因**：nginx 的 `types{}` 指令**会替换掉继承来的整张 MIME 类型表**。该站点 location 里写着
  `types { application/json json; application/octet-stream zip bin gz; text/plain log txt; }`
  —— 只声明了 5 类，`.html` 落不到任何类型 ⇒ 回落到 `default_type`
  （Ubuntu 的 nginx.conf 默认 `application/octet-stream`）⇒ 浏览器当文件下载。
  顺带发现**站点根 `/index.html` 也一直是 octet-stream**，只是没人注意过。
- **修法**：往那个 `types{}` 里**补上**需要的类型（追加式，不动原有内容）：
  ```nginx
  types { text/html html htm; text/css css; text/javascript js mjs;
          application/json json; application/octet-stream zip bin gz; text/plain log txt; }
  ```
- **🔴 但这是改生产服务器，必须按四件套做**（本项目实测流程）：
  1. **先备份**：`sudo cp -a <conf> <conf>.bak-$(date +%Y%m%d-%H%M%S)`
  2. **只做追加式修改**，脚本里带"已补过就跳过"的幂等判断
  3. **`nginx -t` 校验；失败自动从备份还原** —— 配置绝不在错误状态停留
  4. **`reload` 而不是 `restart`**，然后**逐站回归验证**：
     把该机器上所有 server block 都 HEAD 一遍，确认其他站点照常
- **验收**：`curl -sI <url> | grep -i content-type` 必须是**期望的那一个**，
  并且用 `curl -s <url> | wc -c` 核对字节数（防"改完变成另一个页面"）。
- **教训**：
  1. **`types{}` 是替换不是追加**，这条反直觉；只声明少数类型的 location 是隐藏地雷。
  2. 与坑 #25 同族：**"能打开"≠"能正常显示"**，验静态资源必须连**响应头**一起看。
  3. **改别人的生产配置 = 改数据库**：备份 → 最小改动 → 语法校验 → 失败自动还原 →
     平滑 reload → 回归验证。少任何一步都可能把整台机器上的站点一起弄挂。
  4. 事后必须把**回滚命令**明确写给用户（本次：一条 `cp` + 一条 `reload`）。

---

### #52 🔴 PowerShell 管道给 ssh 时补的 `\r` 会**粘在最后一个参数上**，静默失效

- **症状**：写了个包装脚本，把命令通过 stdin 喂给远端 `bash -s`（为了绕开引号地狱）。
  命令**跑起来了、不报错、输出正常**，但**参数像没传一样**：
  `review.mjs list --human` 走的是「没有 --human」的分支。
- **根因**：PowerShell 把字符串管道给原生程序时会补 `\r\n`。
  远端 bash 的 `IFS` **不含 `\r`** ⇒ 那个 `\r` 会粘在**最后一个参数**屁股后面：
  `'--human'` 变成 `"--human\r"` ⇒ `argv.includes('--human')` 为 false。
  **注意它不报错**——这才是最坑的地方。
- **验证手法**：让远端回显 argv，一眼就能看见：
  ```bash
  node -e 'console.log(JSON.stringify(process.argv))' 'list' '--human'
  # → ["/usr/local/bin/node","list","--human\r"]     ← 就是它
  ```
- **修法**：在远端命令行**末尾接一个 bash 注释**，让 `\r` 落进注释里：
  ```powershell
  $remoteCmd = "cd $Dir && node review.mjs $quoted # dsh-eol"
  $remoteCmd | ssh -i $Key ... $Host bash -s
  ```
  （`#` 前必须有空格才会被当作注释起始。）
- **教训**：**「没报错」不等于「参数传对了」。** 跨 shell / 跨进程传参时，
  要么让远端把收到的 argv 回显出来验一次，要么就别用会被隐式加工的通路。

---

### #53 ⚠️ PowerShell 变量名**大小写不敏感** —— `$remote` 会把 `$Remote` 覆盖掉

- **症状**：ssh 报 `Could not resolve hostname cd /opt/... && node review.mjs ...`，
  即**把整条命令当成了主机名**。
- **根因**：脚本里先定义了 `$Remote = 'ubuntu@1.2.3.4'`（主机），
  后面又写了 `$remote = "cd ... && node ..."`（命令）。
  PowerShell 变量名**大小写不敏感**，两者是**同一个变量** ⇒ 主机名被命令字符串覆盖。
- **修法**：换个不会撞的名字（`$remoteCmd`），并且**别用只差大小写的名字**。
- **同一家族的另一位成员：`$home`**。它撞的是 PowerShell 的**只读自动变量 `$HOME`**，
  报错更直白：`Cannot overwrite variable home because it is read-only or constant.`
  给函数参数起名 `$home` 是**最自然的写法**，所以这一条特别容易踩。
  安全做法：参数名带上完整语义（`$DshHomePath`），不要用 `home` / `host` / `error` /
  `args` / `input` / `pwd` 这类**与自动变量同名或近似**的词。
- **教训**：从 bash 迁过来的人特别容易踩 —— bash 里 `$Remote` 和 `$remote` 是两个变量，
  `$HOME` 也可以随便覆盖。PowerShell 两条都不成立。
  **给变量起名时，先想一下它是不是"系统已经在用的名字"。**

---

### #54 🔴 给生产服务加功能：宁可**另起一个极小服务**，也不要往生产进程里塞

- **场景**：要让服务器接收「插件投稿」，最省事的做法是往已有的
  RunningHub 网关（FastAPI，`gateway.service`）里 `include_router` 加两个端点。
- **为什么不做**：
  1. 加完**必须重启那个服务** —— 而它在给真实用户提供生图中转。为一个跟它毫无关系的功能
     去重启一个生产应用，是拿别人的业务给你的新功能当赌注。
  2. 那个 app 有 100 KB 的 `db.py`、admin/user/editor 三个 router、Session/CORS 中间件，
     **改动半径无法评估**。
- **改成的样子**：一个**纯 Python 标准库**的独立服务（约 500 行，无 venv、无 pip 依赖），
  独立 systemd 单元，监听 `127.0.0.1:8100`，nginx 加一个 `location = ` 精确匹配反代过去。
  **完全不碰那个网关**，而且可以随便重启、随便调试。
- **顺带得到的两层安全收益**（值得抄）：
  1. **管理端完全不设 HTTP 接口** —— 批准/驳回走 SSH。于是这个**公开服务不存在任何提权入口**：
     就算它被完全攻陷，攻击者也只能往待审区塞垃圾，碰不到已上架的插件。
  2. **用 systemd 沙箱把它焊死在数据目录里**：
     ```ini
     NoNewPrivileges=true
     PrivateTmp=true
     ProtectSystem=strict      # 除下面这个目录，整个文件系统只读
     ProtectHome=true          # 摸不到 SSH 私钥
     ReadWritePaths=/opt/dstation-plugins
     ```
     于是它**在物理上就没有权限**去改线上插件目录。发布只能由人经 SSH 手动触发。
     ⇒ **「能不能作恶」由内核保证，而不是由代码里的检查保证。**
- **教训**：
  1. **新功能不该有能力和既有生产服务共享命运。** 隔离的成本是一个 systemd 单元，收益是
     「它崩了/被打穿了，业务照常」。
  2. **权限边界尽量下沉到内核**（systemd / 文件权限 / 独立用户），
     别只写在应用代码里 —— 代码有 bug，内核没有。
  3. 一个**公开写入端点**最好的防护不是鉴权，而是**让它即使被完全攻陷也无事可做**。

---

### #55 安全扫描器的规则必须**窄** —— 宽规则会把真信号淹掉

- **背景**：写 `audit.mjs`（插件风险扫描）时，第一版规则很"直觉"，结果
  **对自家正常插件报了 27 项、风险分 0/100**，几乎全部是假阳性：
  - `fetch(` 一律算「外联」—— 但 **DSH 插件的浏览器半 `fetch` 自己的宿主路由
    （相对路径，如 `fetch('/dsh-wallpaper/report')`）是官方标准通信方式**，不是外联。
  - `\bcredentials\b` 一律算「读凭据」—— 但 `fetch(url, { credentials: 'omit' })`
    里的 `credentials` 是**选项名**，语义正好相反。
- **修法**：
  1. 外联只认**绝对 URL**：`/(fetch|axios)\s*\(\s*[`'"](https?:)?\/\//`，
     再单列一条规则管 `XMLHttpRequest` / `net.connect` / `dns.` 这类原生网络 API。
  2. 凭据只认**路径形态**：`.ssh/`、`id_rsa`、`.aws/`、`Login Data`… 而不是裸词。
  3. baseline 名字换成 `R05` / `R05B` 拆开，让两类行为可以分别解释。
- **另一个自我污染 bug**：扫描报告一开始写在**被扫描的目录里**。
  第一次扫描产出「报告正文」——正文里全是 `eval` / `child_process` 这些字样 ——
  第二次扫描就把**报告自己**当成恶意代码。修法：`src/` 与 `reports/` 做成**兄弟目录**。
- **验收方式（关键）**：**同时测两件事**
  - 对**真恶意样本**必须全中（子进程 / eval / postinstall / 二进制 / 读 SSH 私钥 /
    base64 藏代码 / 未声明外联域名）
  - 对**自家正常插件**必须基本干净
  只测一边的扫描器没有意义：只测恶意样本会做出一个「什么都报」的废物，
  只测正常插件会做出一个「什么都不报」的摆设。
- **教训**：
  1. **安全工具的假阳性是一种安全缺陷**：报得太多，人就不看了，等于没报。
  2. **规则要表示「语义」，不能只匹配「词」**。`credentials` 出现在
     `{credentials:'omit'}` 里和出现在 `readFile('.ssh/...')` 里，意思完全相反。
  3. 写扫描器前先明确**威胁模型**：这里的目标不是「找出所有有趣的东西」，
     而是「**分诊**：把 90% 明显干净的放过去，把剩下的标出来给人看」。

---

### #56 ⚠️ `Write-Host` **不进管道** —— 于是测试断言静默全空

- **症状**：写了个安装脚本的测试，断言 `$r.text -match '缺少'`。
  跑起来**安装器的输出在屏幕上清清楚楚地显示了「安装包缺少以下文件：plugin/client.js」**，
  但断言**全部失败**，理由栏是空的（`输出里没有说明：` ← 冒号后面什么都没有）。
  更迷惑的是：**检查退出码的断言全过**。
- **根因**：`Write-Host` **不写 success stream**，它直接写给宿主。
  所以 `$out = & $script 2>&1` **一个字都抓不到**：
  - `2>&1` 只把 **error stream** 合进来
  - `Write-Host` 走的是 information/host stream，5.1 下 `2>&1` 拿不到它
  ⇒ `$out` 是空字符串 ⇒ 所有 `-match` 断言必然失败，而 `$LASTEXITCODE` 是对的。
- **修法（推荐）**：**用真子进程跑，别用 `& $script`**：
  ```powershell
  $a = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$ps1, '-DshHome',$h)
  $out = (& powershell @a 2>&1 | Out-String)
  $code = $LASTEXITCODE
  ```
  理由有三条，每一条单独都够：
  1. 子进程的 stdout 能被完整捕获（`Write-Host` 也进了 stdout）
  2. **这正是用户双击 `.cmd` 时走的同一条路**（`.cmd` 里就是 `powershell -File ...`），
     测的是真实路径而不是"我以为是的那条路"
  3. 退出码是真的进程退出码，不受调用方作用域影响
- **教训**：
  1. **"屏幕上看得见" ≠ "程序收得到"。** 断言失败而现象正确时，
     先怀疑**你捕获的不是同一个流**，而不是怀疑被测代码。
  2. **一个断言群"全空"而不是"报错"，是个强烈的信号**：
     它不是逻辑错了，是**输入压根没进来**。这时候别改断言，去查采集方式。
  3. 测命令行工具时，**优先起真进程**。同进程调用省的那点时间，
     换来的是"测了一条与真实使用不同的路"。

---

### #57 ⚠️ 测试之间共享同一个可变 fixture，会造出「幽灵失败」

- **症状**：给一个新路由补 HTTP 测试，写法与文件里既有的路由测试**一模一样**，
  却抛 `Error: no route for GET /dstation-market/export`。
  而同一份文件靠前处的断言明明打印过「已注册 14 条路由：… , /export」。
  **两条信息直接矛盾**。
- **根因**：文件靠前的一个用例是**故意破坏性**的 —— 它遍历调用所有 disposer，
  就为了断言「卸载之后路由表被清空」：
  ```js
  for (const d of h.disposers) { if (typeof d === 'function') d(); }
  check('卸载后路由表清空', h.routes.size === 0);
  ```
  这一跑，`h.routes` 就**空了**。后面所有复用同一个 `h` 的用例全部失去路由。
  报错点离病根有 600 行，所以看起来像「新加的代码有问题」。
- **修法**：破坏性用例之后用一份**干净实例**：
  ```js
  const h2 = makeCtx();
  plugin.apply(h2.ctx);      // 新的一份 route 表
  ```
- **教训**：
  1. **共享可变 fixture 是幽灵失败的源头。** 一个用例把共享状态改坏，报应却落在
     后面无关的用例上 —— 排查方向会被彻底带偏。
  2. 判据：**当报错信息与已知事实互相矛盾时**（"注册了 14 条路由" vs "no route"），
     不要先怀疑新代码，先怀疑**「这两个断言看到的不是同一个对象」**。
  3. 写破坏性用例（清空 / 卸载 / 删除）时，**必须在注释里写明它会污染共享状态**，
     要么就地重建 fixture。上面那句修法注释就是为此写的。

---

### #58 🔴 伪造的 `res` 不跑框架校验 → 非法响应头一路穿到线上才炸

- **症状**：界面上的版本号变了（**host 半确实加载了新代码**）、路由也注册了，
  但导出接口回 **500**：
  ```
  {"ok":false,"error":"Invalid character in header content [\"content-disposition\"]"}
  ```
  而单元测试里**同一个接口是 200，还断言了 `content-type`、body 魔数、content-length**。
- **根因**：`Content-Disposition` 里直接塞了**中文文件名**（`…-分发包.zip`）。
  **HTTP 响应头只允许 latin-1**，Node 在 `writeHead` 里遇到非 ASCII 直接抛。
  测试为什么没抓到 —— 假 `res` 是这么写的：
  ```js
  res.writeHead = function (s, h) { this.statusCode = s; this.headers = h || {}; return this; };
  ```
  **它只把 headers 存进普通对象，从不调用 Node 的校验。**
  于是"违反 HTTP 规范"在测试里完全不可见，一路穿到真实请求才发作。
- **修法（两处，缺一不可）**：
  1. **业务代码按 RFC 5987 写**：`filename=` 用纯 ASCII 兜底，
     `filename*=UTF-8''<百分号编码>` 给现代浏览器：
     ```js
     const asciiFallback = `${name}-${version}-package.zip`;   // name/version 已被白名单校验为 ASCII
     'content-disposition':
       `attachment; filename="${asciiFallback}"; ` +
       `filename*=UTF-8''${encodeURIComponent(fileName)}`
     ```
     ⚠️ 别用"把中文替换成下划线"当兜底 —— 会得到 `.zip` 前面一串 `_` 的怪名字。
     用**已经过校验的字段**重组一个干净的 ASCII 名。
  2. **🔴 让假 `res` 和真 `res` 一样严格** —— 这才是根本修法，因为它保护**所有**路由：
     ```js
     import { validateHeaderValue } from 'node:http';
     res.writeHead = function (s, h) {
       this.statusCode = s; this.headers = h || {};
       for (const [k, v] of Object.entries(this.headers)) validateHeaderValue(k, v);
       return this;
     };
     ```
- **验收方式（关键）**：**把 bug 改回去，确认测试真的变红。**
  本次实测：改回去后 6 项失败，第一条正是
  `正常导出 → 200 — 实际 500 {"error":"Invalid character in header content…"}`——
  **测试复现了线上那条一模一样的报错**。这一步不能省：
  **"测试通过了"和"测试能抓到这个问题"是两件事。**
- **再补一条元测试**，防止这层保护本身是空的：
  ```js
  let caught = false;
  try { makeRes().writeHead(200, { 'content-disposition': 'attachment; filename="中文.zip"' }); }
  catch { caught = true; }
  check('元测试：假 res 真的会拒绝非法响应头', caught);
  ```
- **教训**：
  1. **假对象越宽松，测试越像安慰剂。** 凡是伪造框架对象（`res` / `req` / `ctx`），
     都要问一句：**"真对象会做的校验，我这里做了吗？"** 没做的地方就是盲区。
  2. 能复用框架的校验函数就复用（`validateHeaderValue` 就是白送的），
     别自己手写一个"看起来差不多"的。
  3. **HTTP 头是 latin-1，body 是 UTF-8。** 这个区别平时感觉不到，一放中文进 header 就炸。
     凡是把**用户可见的名字**塞进响应头的地方都要当心。
  4. 加完测试要**反向验证**：故意让 bug 复活，看它红不红。**不红的测试等于没写。**

---

### #59 🔴 `window.prompt` 在 Electron 里**直接抛异常** → 按钮「点了完全没反应」

- **症状**：D-STATION（Electron 壳）里点「导出」按钮，**什么都不发生** ——
  没有对话框、没有报错、没有下载、控制台之外毫无痕迹。
  而同一份代码在普通浏览器里是好的。
- **根因**：**Electron 只实现了 `alert` 与 `confirm`，`window.prompt` 会抛异常。**
  处理器第一行就是 `window.prompt(...)`，于是整个 `onClick` 在第一行炸掉，
  后面的逻辑（含错误提示）一行都没跑到。
  典型表现就是**「完全没反应」**——不是"慢"，不是"失败提示"，是**连反应都没有**。
- **怎么确认**（不用开浏览器）：
  1. 症状是"连 UI 都没出现"⇒ 处理器在**产生任何可见效果之前**就抛了
  2. 去 Electron 壳的源码里搜 `prompt` 的处理 / polyfill —— **通常是零匹配**，
     即没有任何兜底
  3. 同一个插件里 `window.confirm` 工作正常 ⇒ 说明不是"原生对话框全废"，
     而是**恰好那一个没实现**
- **修法**：**改用页面内表单**，不要依赖任何原生对话框。
  顺带把 UX 也修好了：两次串行的原生弹窗本来就难用。
  ```js
  // 状态：exportFor / exportName / exportWhere
  onClick: () => openExport(pkg, title)      // 展开表单
  // 表单里两个 <input> + 「开始」/「取消」
  ```
- **同时消灭「静默失败」**：把整个处理器体套进 `try/catch`，
  且 `catch` 里也保证写一条可见错误。**这是与"换掉 prompt"同等重要的一半** ——
  否则下次再踩到别的环境差异，用户看到的还是"没反应"。
- **防回归**：加一条直白的源码断言，比任何运行时测试都可靠：
  ```js
  check('client.js 不调用 window.prompt', !clientSrc.includes('window.prompt('));
  ```
- **教训**：
  1. **"在浏览器里能用"不等于"在这个 Electron 壳里能用"。** DSH 的界面跑在
     `contextIsolation: true / nodeIntegration: false` 的 Electron 渲染进程里，
     它与"标准浏览器"的差异是**真实存在的**，而且不报错、只沉默。
  2. **凡是"点了没反应"，先怀疑处理器第一行就抛了。** 正常失败至少有句错误文案；
     「什么都没有」意味着异常发生在**你能看到任何东西之前**。
  3. **原生对话框是环境依赖**。写给别人用的插件，输入交互尽量走页面内 DOM ——
     不依赖宿主实现了什么、没实现什么。
  4. 这个坑的代价提醒：**能力探测不要靠"我觉得它能用"**。要问的是
     **"宿主文档/源码里明确实现了吗"**。

---

### #60 🔴 同一种东西有**多个落盘位置**，只查一个 → 大部分实例漏网

- **症状**：新写的 `/export` 接口对用户点的插件回 `404 not found: dsh-agent-maker`，
  而**这个插件明明就在「已安装」列表里、还正常工作着**。
- **根因**：DSH 插件的落盘位置**不止一处**：
  - `profiles\<p>\node_modules\<pkg>\` —— bundle 通道与 profile-patch 通道都落在这里
  - `<DSH_HOME>\plugins\<pkg>\` —— 直接落盘（可能还没挂载）

  我只查了第二处。本机实测：**`node_modules` 下 19 个，`plugins` 下只有 4 个**
  ⇒ 这个功能对 **15/19 的插件根本不可用**。
  更糟的是**测试全绿**：测试样本恰好都建在 `plugins/` 下，正好是我查的那一处。
- **修法**：写一个「按优先级依次尝试所有已知位置」的解析函数，
  与**清单（inventory）用的是同一套位置来源**，别各写各的：
  ```js
  function resolveInstalledDir(ctx, pkg) {
    const candidates = [
      join(resolveProfile(ctx).dir, 'node_modules', pkg),
      join(pluginsRoot(), pkg)
    ];
    for (const c of candidates) {
      if (是目录(c) && 有package.json(c)) return c;
    }
    return null;
  }
  ```
  404 的文案也要**说清查过哪几处**，否则下一个人还会以为"这插件不存在"。
- **验收**：**用真实数据做批量预检**，而不是靠造样本。
  本次写了个脚本遍历本机全部 19 个已安装插件逐个试导出 —— 一次把剩下的坑全暴露出来
  （顺带发现了坑 #61）。**造 3 个样本 ≪ 跑全部真实实例。**
- **教训**：
  1. **"这个东西在哪"只要存在多个可能的位置，就必须写"依次尝试"的解析函数。**
     写死一处，等于对其他所有位置隐形。
  2. **测试样本的分布会掩盖 bug。** 样本都集中在一条通道上时，
     测试通过率与真实可用率可以差到 **4/19**。补样本时先问：
     **"真实数据里，这个对象都分布在哪些形态 / 哪些位置？"**
  3. **上线前用真实数据批量跑一遍**，成本极低，收益极高。

---

### #61 ⚠️ 处理 `package.json` 的 `exports` 必须认**条件对象**形态

- **症状**：`dsh-better-sidebar` / `dsh-canvas-preview` / `dsh-univer-office`
  这些**工作完全正常**的插件，被自己的自检判成「客户端文件不存在」而拒绝导出。
- **根因**：`exports["./client"]` 有两种**都合法**的写法：
  ```json
  "./client": "./client.js"                                        // 字符串
  "./client": { "types": "…", "default": "./lib/client.js" }       // 条件对象
  ```
  代码只按字符串处理，对象被 `String()` 成 `"[object Object]"`，
  拼出来的路径自然不存在 ⇒ 报"文件不存在"。**报错信息还很有误导性**
  （听起来像作者把包做坏了，其实是自检写窄了）。
- **修法**：写一个递归解析器，按 `default / import / require / node / browser`
  依次取，并且**支持嵌套**（`{ node: { default: … } }`）：
  ```js
  const walk = (v) => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      for (const k of ['default','import','require','node','browser']) {
        const hit = walk(v[k]); if (hit) return hit;
      }
    }
    return null;
  };
  ```
  本仓库里 **`tools/validate.mjs` 早就是这么写的** —— 新写的自检没对齐它。
  ⇒ **同类检查散落在多处时，新写的那份要去抄老的那份，别凭印象重写。**
- **连带发现（顺带加的一道闸门）**：`exports` 的入口必须**真的被打进包里**。
  `files` 白名单一旦漏掉入口，源目录检查会通过，而发出去的包是坏的。
  所以导出前还要断言「入口文件 ∈ 收集到的文件集合」。
- **教训**：
  1. **`exports` 的解析不是"取字符串"**，它是 Node 的解析算法（含条件与嵌套）。
     任何要读 `exports` 的代码都得按这个来。
  2. **自检写窄了比不写更危险**：它会把好插件拒之门外，而且理由看起来义正辞严，
     让人去查错方向（改插件而不是改自检）。
  3. 同一语义的检查在仓库里有多份实现时，**先找到那份"已经在线上跑通的"**，
     照抄它的边界条件。

---

### #62 🔴 输入白名单**写窄了** = 一整类合法输入被静默拒绝（与坑 #61 同族）

- **症状**：用户想导出 `@michengai/dsh-archive-manager`，接口回
  `400 bad package name`。而这个插件就在列表里、工作完全正常。
- **根因**：包名白名单是
  ```js
  const PKG_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;   // ← 不允许 "/"
  ```
  而 **scope 形态 `@scope/name` 是 npm 的正规写法**，第三方发布大量使用。
  ⇒ 这一整类插件被挡在门外，而且**报错信息毫无帮助**
  （用户看到 "bad package name"，只会去怀疑自己名字起错了）。
- **修法**：白名单要**吃下完整的合法输入空间**，同时仍然排除危险形态：
  ```js
  // 每段都必须以字母数字开头 ⇒ "." ".." "/abs" "a\b" "C:evil" 全进不来
  const PKG_NAME_RE = /^(@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,63}$/i;
  ```
  配套要把穿越用例**补全到 scope 形态**：`@scope/../x`、`@scope/`、`@/x`、`@scope/x/y`。
- **为什么测试也没抓到**：预检脚本枚举的是 `node_modules` 的**顶层**，
  而 scope 包在 `@scope/` 这一层**再往下一层** —— 预检报告「19/19 全过」，
  真实情况是**另外还有 3 个 scope 插件连试都没试过**。
- **教训**：
  1. **白名单的价值在于「恰好吃下全部合法输入」，不是「越严越好」。**
     写窄了和写宽了一样是 bug，而且更隐蔽 —— 它把责任推给用户。
  2. 校验失败时，**错误信息要指向真正的过错方**。
  3. **枚举数据时要主动想「还有哪些形态 / 层级没被枚举到」**：
     scope 包、嵌套目录、软链、大小写 —— 预检覆盖不到的地方就是盲区。
     修正后从 19 个变成 25 个，多出来的正是 scope 包，以及
     **被 profile 补丁挂载、package.json 里连 `dsh` 字段都没有**的那类
     （`dsh-daily-workspace`：只看 `dsh` 字段会把它当普通依赖漏掉）。

---

### #63 🔴🔴 `home\profiles\node_modules` 与 `profile\.dsh-module-fallback\node_modules` 是 **DSH 自管层**：必须是 symlink 或不存在，**真实目录会让启动硬失败**

**症状**：整包静态检查全绿（0 软链接、0 密钥、体积正常），原地启动直接崩：

```
Error: dsh: <...>\home\profiles\node_modules\@deepseek-ai\dsh exists and is not a
symlink or dsh-managed module proxy; remove it so dsh can manage the installation fallback
```

**根因**（源码 `app\node_modules\@deepseek-ai\dsh-app-boot\lib\index.js`）：

- `healProfilesModuleFallback()` 每次启动重建 `$DSH_HOME\profiles\node_modules`：
  为安装依赖闭包里的每个包写一条**指向本机安装目录的 junction**（`symlinkSync(target, link,'junction')`）。
- `healProfileModuleFallback()` 每次启动重建 `profile\.dsh-module-fallback\node_modules`。
- `ensureSymlink()` 遇到「已存在的真实目录」**直接抛错**（除非是 dsh 自己写的 proxy）。

**修法**：**这两层不进包**，让 DSH 在目标机器上按本机路径重建。
复制/打包工具（robocopy、Copy-Item）默认把 junction 物化成真实目录 —— 正好踩中，必须显式删。
代价：目标机器首次启动变慢（要装配插件树 + 重建两层；实测 42s vs 复用后 8s），
要在用户说明里写明。**这个坑静态检查查不出来，只有真启动才能发现。**

### #64 ⚠️ 打包时 junction「要跟、但只跟该跟的」

`robocopy /E` 默认跟随 junction 并把内容拷成真实目录 —— 这对
`home\profiles\web\node_modules\dsh-<自研插件>`（pnpm 建的 junction）是**必须的**，
否则换机器后它指向原安装目录的绝对路径，插件直接消失。所以：

- **不要加 `/XJ`**（加了就跳过 junction，等于断链）；
- `home\plugins\dsh-dstation-market` → `home\skill-sessions\...` 的 junction 也要跟随物化，
  即使 `skill-sessions` 本身在排除名单里（排除只影响"拷到哪"，源文件还在，能读到）；
- **例外**：坑 #63 那两层，物化完**再删掉**。

**校验口径**：成品 `reparse points = 0` —— 这一条同时证明了「断链的 junction 已物化」与
「自管层已删除」。

### #65 ⚠️ 用 `Invoke-WebRequest` 探测自己起没起来 → 会把**活着的服务误判成挂了**

**症状**：headless 启动的服务 stdout 明明打出了 `dsh web: http://127.0.0.1:PORT/?token=...`，
探测循环跑满 180s 却报「没起来」。

**根因**：DSH 的 web 路由需要会话凭据，裸请求返回 **401**；
而 `Invoke-WebRequest` **遇非 2xx 直接抛异常**，被 `try{}catch{}` 吞掉 ⇒ 永远等不到 200。

**修法**：用 `HttpWebRequest` + 捕获 `WebException` 读 `Response.StatusCode`，
**并挂 `CookieContainer`**（首次带 token 访问会下发会话 cookie，后续路由才 200）。
`/dsh-wallpaper/health`、`/dsh-media/health`、`/dsh-ollama/status` 都是判断「插件树真的装配了」的好探针。

### #66 ⚠️ 「补环境」不能无条件 prepend PATH —— 会顶掉用户已有的解释器

**症状**（设想中的事故）：绿色版自带 **可嵌入 Python**（无 pip、无 site-packages）用于补环境，
如果直接 `PATH = 自带 + 原 PATH`，那么**已经装了完整 Python 的用户**会被静默切到可嵌入版，
他 `pip install` 过的包全部 import 失败 —— 比「缺 Python」严重得多。

**修法**：**只在系统里没有该命令时才补**。自己走一遍 PATH 搜索（`existsSync(join(dir, exe))`），
找到就记为 `system-already-has-it` 并跳过。三种结局都要能从诊断路由读到：
`injected` / `skipped(reason)` / `presentBefore`。

**验证要双向**：① 剥空 PATH（只留 `system32`）模拟干净机器 ⇒ 应补齐并真跑通；
② 正常 PATH ⇒ 应 `injected: []` 且 PATH 一字不改。**只测一边等于没测。**

### #67 ⚠️ 注入环境变量别改外壳，也别指望 `.env`

- **别改 `resources\app\main.js`**：外壳属于 OTA 覆盖范围（清单替换 `resources\app\*`），
  写进去的补丁会被静默冲掉。走**插件 + patch**（数据层），可读可删可测。
- **`$DSH_HOME\.env` 走不通**：`loadLayeredEnv` 用的是 Node 的 `process.loadEnvFile`，
  **不做变量展开**（`${DSH_HOME}` 不会被替换），而 PATH 需要绝对路径 ⇒ 无法可移植地写进 `.env`。
  同理：`.env` 里的变量**只在 `process.env` 尚无该键时才生效**（继承的环境优先）。

### #68 ⚠️ 在本环境跑 PowerShell 脚本的四条硬约束

| 约束 | 症状 / 修法 |
|---|---|
| `.ps1` **必须纯 ASCII** | 带中文注释会被 ANSI 解析，报 `The string is missing the terminator` / `TerminatorExpectedAtEndOfString`。命令**内联**中文没问题；要中文就写成 `.txt`/`.md` 让 read 工具读 |
| PS 5.1 **没有 `if` 表达式** | `(if($x){'a'}else{'b'})` 报 `The term 'if' is not recognized`。改成先赋值再拼 |
| `robocopy` 可能被沙箱拒 | `Access is denied`（不是命令写错）。不可用时改 `Copy-Item`，或提权到 full-access |
| **别用 `Get-Content` 看 UTF-8 中文** | 控制台按 ANSI 解 ⇒ 乱码，会让你误以为文件坏了。看文件一律用 **read 工具** |

### #69 🔴 交付「拷到别的机器双击就能装」的安装包：四条契约会互相打架

> 场景：给「智能体工作台」加「一键打包我的智能体」——导出 zip，内含安装脚本，
> 对方解压后双击 `一键安装.cmd` 即可。代码写对了不难，难的是**编码与位置这四件事**，
> 每一条单独看都对，凑在一起就会互相破坏。

| 契约 | 为什么会打架 | 正确做法 |
|---|---|---|
| `.cmd` **必须纯 ASCII** | cmd.exe 按 OEM 代码页读批处理 | 打包器要有「发现非 ASCII 就抛」的硬闸门。**⚠️ 关键推论：`.cmd` 模板里绝不能引用含中文的模板变量**（如"全部智能体名字"拼成的 `@@AGENT_NAMES@@`）——渲染后必然触发闸门。`.cmd` 只引用**保证 ASCII 的变量**（id、数量） |
| `.ps1` / `.txt` **必须 UTF-8 带 BOM** | PS 5.1 按 ANSI 读无 BOM 的 `.ps1` ⇒ 中文乱码且**直接语法报错** | BOM 在**打包时**由导出器加（`'\ufeff' + text`），**模板文件本身不带 BOM** —— 这样模板还能被 read/edit 工具正常处理 |
| 安装器的**备份目录不能放在被扫描的目录里** | `.agent-presets\<id>.bak-<时间戳>` 会被宿主当成**另一个智能体**扫出来 ⇒ 列表里出现重复项 | 备份放到扫描根**之外**（如 `<DSH_HOME>\agent-preset-backups\`）。凡是"往某个会被自动发现的目录里塞东西"的设计，先问：**这个目录的扫描器会把我塞的也当成条目吗？** |
| 多行中文文本**不要注入 `.ps1` 模板** | 中文 + 换行 + 引号 + here-string 边界，任何一处没转义就让安装脚本语法报错 | 由 JS 生成一份独立的 `依赖清单.txt`，`.ps1` 只负责**读它并打印**。分工单向 ⇒ 零转义风险、零漂移 |

- **代价**：这四条如果漏掉任何一条，产出的包的症状都是「对方的机器上装不上」——
  而你自己的机器上一切正常（因为你不会去双击自己的包）。**这类 bug 只能靠测试防，靠自测发现不了。**
- **配套（强烈建议）**：`package.json` 的 `files` 白名单要把 `templates/` 一起列进去（坑 #22）——
  模板是**运行时读盘**的，漏了白名单，重装插件后模板消失，导出功能直接报「插件安装不完整」。

---

### #70 ⚠️ 「必须纯 ASCII」的测试脚本：三条自己给自己挖的坑（全部实测踩到）

1. **声明「本文件必须纯 ASCII」的那行注释本身可能就是非 ASCII。**
   我在纯 ASCII 的安装器测试脚本头部写了 `⚠️ THIS FILE MUST STAY PURE ASCII`，
   于是文件里多了 **6 个非 ASCII 字节**（`⚠` U+26A0 三字节 + 变体选择符 三字节）——
   正好破坏了它自己声明的约束。
   ⇒ **别靠自觉。** 加一条自动扫描，把它当成断言跑：
   ```powershell
   $bad = @([System.IO.File]::ReadAllBytes($p) | Where-Object { $_ -gt 127 })
   if ($bad.Count -gt 0) { Fail }
   ```
2. **`Append-Text` 这个 cmdlet 不存在**（它不是 `Out-File`/`Add-Content` 的别名）。
   追加文本要用 `[System.IO.File]::AppendAllText($p, $s, $enc)`。
   ⇒ 写 PS 时拿不准就查，别按"应该是这个名字"写。
3. **🔴 负向对照测试会被 `$ErrorActionPreference = 'Stop'` 提前终止。**
   为了验证「去掉 BOM 的 `.ps1` 必须失败」，我要故意运行一个会失败的子进程；
   该子进程把解析错误写到 **stderr**，而 PowerShell 在 `Stop` 模式下把
   **原生命令写 stderr** 升级成终止性 `NativeCommandError`
   ⇒ **整个测试脚本当场死掉，后面的断言一项都没跑**。
   现场证据就是那一串 `NativeCommandError` 加 `[exit code: 1]`。
   ⇒ **跑"预期会失败"的子进程之前，把 `$ErrorActionPreference` 降成 `'Continue'`**，
   改为每个步骤单独断言。模式切换要写在代码里并注释原因，否则下一个人会"顺手改回去"。

- **教训**：测试脚本自己也是代码，也会坏。**断言助手（`Check`）尤其不能坏** ——
  一个因为 PS 5.1 语法限制而异常退出的断言助手，会把**所有失败静默变成通过**。
  本次为此把 `$(if (...) {...} else {...})` 改成了显式的 `if` 语句块。

---

### #71 🔴 「装到别的机器」类产物，必须在**假目标环境**里跑真子进程做端到端验证

> 本文第四节说「每个坑都要变成一个失败得起的测试」。对一个**安装包**来说，
> 「单元测试全绿」几乎不说明问题：真正的失败模式是「在**另一台机器**上装不上」，
> 而那台机器你没有。

**做法（本次实测有效，29 项断言一次跑通）**：

1. **造包**（JS）与**装包**（PowerShell）分成两个脚本，通过**文件**交接期望值
   （把每个文件的 rel 路径 + sha256 写成一份 `expect.json`）。
   这样两边互不依赖对方实现细节，也避免了在纯 ASCII 的 `.ps1` 里写中文路径。
2. **用真子进程跑安装脚本** —— 而且要和用户双击时**走同一条路**：
   ```powershell
   $childArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$ps1,'-DshHome',$fakeHome)
   $out = (& powershell @childArgs 2>&1 | Out-String); $code = $LASTEXITCODE
   ```
   （同进程 `& $script` 测的不是那条路，见坑 #56。）
3. **目标环境是假的**：造一个只含 `profiles\` 的临时目录当 `<DSH_HOME>`，
   全程不碰真实安装。顺带验证了「自动探测 DSH_HOME」这条链路。
4. **断言要贴事实**，至少覆盖：
   - 装完的文件**逐个 sha256** 与清单一致（不是"复制没报错"）；
   - **装两次**：不产生重复条目 + 旧版本被备份 + **备份不在被扫描的目录里**；
   - `-KeepExisting` **真的跳过**（在目标里放一个标记文件，跑完它还在）；
   - **篡改包内文件后必须拒绝安装**，且**已装内容一字未动**（先记 sha256，再比对）；
   - **找不到 DSH_HOME 时必须失败**且提示如何手工指定（而不是"成功但什么都没装"）。
5. **🔴 必须有一条负向对照**：「把 BOM 去掉，安装脚本必须失败」。
   本次实测：去掉 BOM 后 PS 5.1 在第 21 行报解析错误 ——
   这条**证明了 BOM 断言真的在保护东西**。
   **没有负向对照的断言等于没写**（与坑 #58 的「把 bug 改回去，确认测试变红」同一条纪律）。
6. **探测未知位置前先自保**：测「找不到 DSH_HOME」时要把
   `DSH_HOME / USERPROFILE / APPDATA / LOCALAPPDATA` 全部指向沙箱，
   并**先确认**候选清单里的固定路径（如 `C:\D-STATION\home`）不存在，否则这个测试
   可能真的去动用户的真实安装。**测试的破坏半径也要设计。**

- **顺带的收获**：打包器里那道「**清单里声明的每一个文件都必须真的在 zip 里**」的自洽性闸门，
  **第一次运行就抓到了一个真 bug** —— zip 条目的路径少拼了根目录前缀，
  智能体会散落在压缩包根目录下。没有这道闸门，这个 bug 会一路穿到用户那句
  「对方装上打不开」。**打包器请默认带上这道闸门。**

### #72 🔴 第三方插件的**本地补丁**：会被静默还原，必须做成闸门而不是手改

**症状**：某个会话**此后每一次**模型请求都失败，报
`DeepSeek API stream from https://api.deepseek.com failed`（`TRANSPORT`）——
5 次指数退避重试全灭、重启 D-STATION 也没用；同时别的会话一切正常。
**看起来像上游/网络故障，其实是本地的。**

**判据（最快的那一条）**：**看单次尝试耗时**。用会话 JSONL 里 `llm/retry` 的 `delayMs`
与相邻时间戳反推，本次实测每次尝试只花了 **10~30 ms** ——
比一次 TLS+HTTP 往返（~500 ms）还短一个数量级 ⇒ **报文根本没发出去**，问题在本地准备阶段。

**根因链**（`dsh-univer-office` 0.2.14，2026-09-19 实测）：
1. `univer_screenshot` 回填给会话的附件描述符用了**渲染器声明的** `item.mediaType`（恒为 `image/png`）；
2. 附件仓库对**渲染后 > `2048×2048 = 4,194,304` 像素**的截图会**重编码**（有 alpha → WebP，无 alpha → JPEG）
   —— 注意**默认渲染倍率就是 2×**，所以页面积 > 约 104 万像素就会命中这条分支；
3. ⇒ 会话里存的引用与磁盘对象不一致（引用 `image/png`，字节是 RIFF/WEBP）；
4. ⇒ 之后每次请求在**准备请求图片**时抛 `AttachmentError`（`ATTACHMENT_CORRUPT` / `INVALID_IMAGE`）；
5. ⇒ 该错误**不是 `LlmError`**，被 `dsh-llm-deepseek` 的 `streamWithConnection` 兜底 catch 统一包成
   `LlmError("DeepSeek API stream from … failed", "TRANSPORT")` —— **错误文案与真实原因无关**。
   重试/重启无效是因为脏引用已经写进会话历史，每次都会重新投影那张图。

**排查手法（可复用，本次就是这么定位的）**：
① `session.jsonl.zstd` 是 **zstd 多帧拼接**，要按帧逐个解，`zstdDecompressSync` 只吃第一帧；
② 算单次尝试耗时（见上）；
③ 找出会话里**唯一新增的图片附件**，与首次失败的时间点对齐；
④ 直接读附件对象头字节判断真实格式，再用 `readImageFile(root, ref)` 验证引用自洽性；
⑤ 最后用**真实适配器**重放整段会话（system + tools + 全部 messages）证明"载荷无罪、上游无罪"，
   把嫌疑逼回那一条引用上。

**修法**：`lib\index.js` 里 `image{ … mediaType: item.mediaType }` → `ref.mediaType`。
⚠️ `saveImages` **入参**那个 `item.mediaType` 必须保留（它声明的是输入字节类型，仓库靠它校验）。

**🔴 补丁会被静默还原的两条路（都实测过）**：
- **OTA**：`resources\app\ota-core.js` 的 `WRITE_ALLOWLIST` 允许写 `^home/profiles/`；
  本地 `ota-index.json` 里该插件有 **810 条**受管路径（含 `lib\index.js`），补丁让该文件 sha256
  与索引记录不一致 ⇒ **下一次检查更新就判「需替换」并覆盖**。旁证：`ota-update.log` 里
  2026-09-14 那次 OTA 真覆盖过 40 个 `home\profiles\web\node_modules\...` 文件。
- **市场更新**：`dshmarket` 走 `dsh plugin --profile web add <pkg>@<ver>` → pnpm **整体替换包目录**。

**所以补丁不能只靠手改，要做成"可重放 + 会自检"的闸门**（本次落地形态）：
| 层 | 机制 |
|---|---|
| 补丁表 | `daily-use\reapply-local-plugin-patches.ps1` —— **表驱动**（`-List` 看条目、`-Check` 只检、`-Only <id>` 单条、默认全打）。新增补丁 = 加一个表项 |
| 打包前 | `build-green.ps1` **第 0 步**：先 `-Check`，缺就调补丁表**自动补**并复验；补不上才 `throw`（且中止发生在 `Remove-Item $Dst` **之前**，不会毁掉上一份成品）；`-NoAutoPatch` 改成只报警 |
| 打包后 | `_green-build\verify-clean.ps1` **E 段**：直接对成品跑补丁表 `-Check`（**不在消费方复制判定逻辑**，否则两边迟早漂移） |

**2026-09-19 扩展：这条规矩现在覆盖两条补丁**（表里两个表项）：

- `univer-media-type` —— `dsh-univer-office` 的截图附件 `mediaType`（本条坑的主角）
- `office-tools-sandbox` —— `dsh-office-tools` 的 `saveOfficeText` 没把会话沙箱策略透传给
  `ctx.fs.writeText` ⇒ 沙箱解析不到会话 cwd ⇒ 会话工作区不在部署根下时，
  `word_*` / `excel_*` 的**写**一律 `FS_SANDBOX_DENIED`（读不受影响）。
  ⚠️ `cordis.patch.yml` 里那条 `workspaceRoot` 只是**兜底**不是根治。

**复现校验（很值得抄的手法）**：找一份**未改过的原版**（本项目的绿色版成品往往就是上一个发布版，
其 sha256 与 `ota-index.json` 一致 ⇒ 可直接当原版用），让补丁表打一遍，
**产物应与手工改过的活装机逐字节一致**（本次实测 sha256 `ba34226b…`，`git diff --no-index` 退出 0）。
这比"跑完没报错"强得多 —— 它证明重放的是**同一个补丁**，而不是一个长得像的补丁。

> 通用教训：**给第三方插件打本地补丁，就要同时交付"重放脚本 + 打包/成品闸门 +
> 打包 Skill 里的一条铁律"**，否则它一定会在某次 OTA 或插件更新后静默消失，
> 而失败现场（会话整段报废、错误文案指向 DeepSeek）离原因非常远。
> 根治仍是把补丁提给上游。

### #73 🔴🔴 Node 的 `spawn` 在 Windows 上会**重拼命令行** → 参数自带引号被二次转义，静默失效

- **症状**：插件里 `spawn('explorer.exe', ['/select,"<路径>"'])` 打开资源管理器 ——
  **不报错、进程正常**，但 explorer 打开的是**「文档」默认位置**，
  而不是文件所在目录。用户描述为「文件夹按钮对应的不是文件所在的位置」。
- **根因**：**Node 在 Windows 上会把 argv 数组重新拼成一条命令行**（并对含空格的参数加引号），
  参数里**自带的引号会被再转义一层**，explorer 解析不出来 ⇒ 回退到默认位置。
- **实测五种写法**（目标故意用「带空格 + 中文」的文件名，最苛刻的样本）：
  | 写法 | 结果 |
  |---|---|
  | A `['/select,"<path>"']` 参数自带引号 | ❌ 打开「文档」 |
  | B `['/select,<path>']` 交给 Node 引 | ❌ 打开「文档」 |
  | **C `['/select,', '<path>']` 两个参数** | ✅ **正确打开目标目录并选中** |
  | D `cmd /c start /select,"<path>"` | ❓ 没有窗口 |
  | E `['/n', '/select,"<path>"']` | ❌ 打开「文档」 |
- **修法**：`spawn('explorer.exe', ['/select,', nativePath], { stdio: 'ignore' })`
  —— **两个元素、都不加引号**。目录则用 `[nativePath]`（对目录用 `/select,`
  会去选中它的**父**目录，是错的）。
  ⚠️ 另外两条：`stdio` 必须 `ignore`（坑 #10）；**explorer.exe 正常退出码也是 1**，
  不能拿退出码当失败判据。
- **🔴 最值钱的教训**：我先前用手动 `Start-Process -ArgumentList '/select,"<path>"'`
  测**是好的**，就以为这条路通了 —— **那条命令根本不经过 Node 的 argv 重拼**。
  **「换条路测通过」不等于「产品这条路能用」。**
  凡是"要传给另一个进程的参数"，验证必须走**产品自己用的那个入口**（spawn）。
- **配套**：把参数形态**逐字写进回归测试**（断言"两个元素、且任何元素都不含引号"），
  并留一个可直接跑的对照实验脚本（本插件 `test/spawn-probe.mjs`，五种写法一次比完）。

### #74 🔴 兄弟插件会 **shadow 掉官方的"唯一通道"** → 所有打开动作被静默改道

- **症状**：点对话里的路径 → **打开了右侧栏**，而不是系统默认程序。
  用户报「打开的是侧面板，不对」。
- **根因**：`dsh-better-sidebar` 用 `ctx.inject(['remote.session'], …)` **shadow 了
  `remote.session.openWorkspacePath`** —— 而那是**聊天侧文件打开的唯一漏斗**
  （工具行路径链接 / 产物行 / 正文提及 / 行内代码路径全走它）。
  它的源码注释写得明明白白：
  *"so opens land in the sidebar editor **instead of the Host OS**"*。
  默认值 `interceptOpenPath: true`（即**默认劫持**）。
- **判据（三步，都便宜）**：
  1. 宿主半路由正常、`/health` 200、你的代码没碰过侧栏 ⇒ **先怀疑别人**；
  2. `grep` 兄弟插件的客户端源码找 **`shadow` / `intercept` / `openWorkspacePath`**；
  3. 读它的注释 —— 这类"接管"通常作者自己写清了原因和开关。
- **修法**：改设置，别改代码。本插件把它写进 `<DSH_HOME>/settings.yaml`：
  ```yaml
  dsh-better-sidebar:
    interceptOpenPath: false
  ```
  改别人的配置文件 = 改数据库（坑 #45）：**先备份 → 最小改动 →
  用 DSH 自己的 yaml 库校验能解析 → 把回滚命令写给用户**。
- **教训**：**"我的代码是对的"和"用户看到的行为是对的"是两件事。**
  在插件生态里，你要打开的通道可能已经被别人接管了 ——
  排查顺序应该是「谁在这条路上」而不是「我的代码哪里错」。

### #75 🔴 诊断上报的节流会把**整份读数吞掉** → 宿主侧只剩下过期数据

- **症状**：`/status` 永远显示 `scans: 1, candidates: 0`，看起来"插件啥也没干"，
  而实际功能是好的。
- **根因**：客户端给上报加了 5 秒节流，而 `apply()` 一开始就报了「能力探测」，
  300ms 后**扫描完成**那次上报正好落在窗口里被**直接丢弃**；
  此后 DOM 不再变化 ⇒ 再也不会有上报 ⇒ 宿主侧永远只有最初那一份。
- **修法**：**被节流的上报要补发**，不能丢：
  ```js
  if (now - lastReportAt < THROTTLE && !force) {
    pendingReason = reason;                       // 记住
    if (timer === null) timer = setTimeout(() => {
      timer = null; const r = pendingReason; pendingReason = null;
      if (r !== null) report(r, true);            // 冷却结束补发
    }, THROTTLE - (Date.now() - lastReportAt) + 50);
    return;
  }
  ```
- **教训**：与坑 #8、#39 是同一个病：**诊断装置自己会骗人**。
  凡是有节流/去重/缓存的地方，都要问一句：**被丢掉的那份去哪了？**

### #76 🔴 计数器只在"顺手"的时刻被读走 → "用户到底点没点过"永远查不出来

- **症状**：`/status` 里 `clicks: 0`，据此判定"用户没点我的按钮"——
  而用户其实点了（只是报告是**点击之前**发的）。
- **根因**：`STATS` 只在**扫描触发上报**时被序列化发走，而点击之后通常**不再有 DOM 变化**，
  于是宿主读到的永远是点击前的旧值。
- **修法**：**交互类事件必须强制即时上报**（`report('click:open', true)`），
  不要指望"下一次扫描会把它带出去"。
- **教训**：**别用一个"不知道什么时候更新"的数字下结论。**
  下结论前先问：这个读数是什么时候采集的？（我这次就差一步据此把责任判错方向。）

### #77 🔴 React 替换块节点 → 标记随旧节点消失、**兄弟节点却活着** → 重复出条

- **症状**：同一个代码块下面挂出**两条**一模一样的功能条。
- **根因**：幂等靠的是块上的 `data-*-done` 标记；但 React 在流式结束/重渲染时
  可能**整块替换**该节点，标记跟着新节点一起没了，而插件挂在**兄弟位置**的条子留了下来
  ⇒ 重扫时又给新节点挂了一条。
- **修法**：**两道闸**，缺一不可：
  1. 块上 `data-*-done`（靠 `closest` 覆盖嵌套块）；
  2. 条子上写**内容键** `data-*-key`（如排序后的路径集合），
     插入前先查父节点下有没有同键的条子。
- **回归测试**：模拟"把块节点换成新节点"，断言条子数仍然是 1
  —— 并且**把闸门关掉确认测试会变红**（坑 #58 纪律）。
- **教训**：坑 #4 的家族成员。**只要你的节点挂在别人的 React 树旁边，
  就必须假设"它周边的节点会被重建"。**

### #78 🔴 测试样本的形态会**掩盖 bug**：用"不存在的越界文件"测根白名单 = 根本没测到

- **症状**：断言"路径白名单会拦住允许根之外的文件"一直是绿的，但那条闸门其实从没被测到。
- **根因**：样本是 `tmpdir()/nope.txt` —— **不存在的文件会先被 `not_found`(404) 挡下**，
  永远走不到根白名单那一步。测试绿，闸门其实没验。
- **修法**：样本必须**恰好只违反你想测的那一条**：
  测根白名单 → 用**真实存在、但在允许根之外**的文件（先 `writeFileSync` 造一个）。
- **同族**：某次 `SPAWN` 白名单测试的样本全建在同一个目录形态下（坑 #60/#62），
  于是"19/19 全过"而真实覆盖率只有 4/19。
- **教训**：写"应当被拒绝"的测试时，**必须确认拒绝你的正是那条规则**——
  否则你测的是另一条闸门，而目标闸门可能根本没接线。

### #79 ⚠️ 非 2xx 时把宿主的说明丢掉，只显示 `HTTP n` → 用户拿不到任何线索

- **症状**：宿主返回 `403` + `{"message":"路径不在任何允许的会话工作区之内"}`，
  界面上却只显示 `HTTP 403`，用户只能说"无效"，给不出任何有用信息。
- **根因**：XHR 的 `onload` 里把非 2xx 一律折叠成 `'HTTP ' + status`，**没解析响应体**。
- **修法**：非 2xx **也要解析 body**，优先用宿主的 `message`/`error`：
  ```js
  var parsed = null; try { parsed = JSON.parse(xhr.responseText); } catch {}
  if (status >= 200 && status < 300) finish({ ok: true, body: parsed });
  else finish({ ok: false, status, body: parsed,
                error: (parsed && (parsed.message || parsed.error)) || ('HTTP ' + status) });
  ```
- **配套**：**按钮必须有失败态**（配色 + 一行可见说明），否则任何失败在界面上都等于没发生。
- **教训**：与坑 #5、#17 同族 —— **"失败可见"不只是"要有错误态"，
  还包括"错误内容要真的传到底"。**

### #80 🔴 组合客户端包的 `rev` 是**整组内容的哈希** → 单独取 `/plugins/<包>/client.js` 必 404

- **症状**：想用"抓服务端发出的 bundle 再 grep 我的构建号"来证明新代码已下发（证据链 ①），
  单独请求 `/plugins/<pkg>/client.js` 或带 `rev` 都返回 **404**，让人以为插件没被下发。
- **根因**：组合 URL 的真实形态是
  ```
  /plugins/??<id1>/client.js,<id2>/client.js,…&rev=<整组内容的哈希>
  ```
  （`dsh-client-modules` 源码里拼出来的）。`rev` 是**整组内容**的哈希，
  没有"单个模块的 URL"这种东西；首页里那条 `src=` 往往**只含 `dsh-client-modules` 自己**
  （它是加载器，其余模块运行时再拉）。
- **修法 / 更好的证据链 ①**：**让客户端自己把构建号报回来**。
  客户端半把 `BUILD` 写进 DOM，并随诊断上报发给宿主
  （`{"source":"client","build":"v5-…"}`）。
  这个字符串**只存在于你的代码里** —— 浏览器报得出它，就同时证明了
  「服务端下发了新代码」+「浏览器解析并执行了它」，
  比 grep bundle **更强**（grep 只能证明"服务端愿意发"）。
- **教训**：**证据链要为"取不到"准备替代方案。**
  当一条取证路被架构挡住时，换一条**由被测方主动上报**的路，
  往往比死磕 URL 更可靠。


---

## 四、把调试沉淀成测试

**每个坑都要变成一个失败得起的测试**，否则下次改代码会静默重犯。

| 坑 | 对应的测试 |
|---|---|
| #2 跳过规则误伤 | 直接测跳过谓词：`<pre><code>` 跳过、行内 `<code>` 不跳过、属性容器跳过 |
| #3 抖动 | 自检页里种一个 `MutationObserver` 哨兵，断言"稳定后 0.6 秒内新增变更 = 0" |
| #4 元素重建 | 连续重绘 N 次后断言媒体元素是**同一个节点对象**（`===`） |
| #5 卡在确认中 | 断言"未登记也立刻渲染 `<img>`" + 断言 `src` 的确定性 URL |
| #6 编码器 | 用 `ffprobe` 回报 codec/profile/pix_fmt 作为证据 |
| #7 残留 src | 断言错误态卡片里**没有** `<img>` |
| #8 状态不刷新 | 断言扫描后 DOM 上的计数与真实一致 |
| #37 路由重复注册崩插件树 | 假 `ctx.webServer.register` **复刻真实行为**（重复 `(kind,path)` 就抛），断言 `apply()` 不抛 + 路由条数等于预期 |
| #39 诊断上报互相覆盖 | 先报 `source:'probe'`、再报 `source:'client'`，断言两个槽**都还在** |
| #40 shell 文本往返毁文件 | 改完代码必须 `node --check` 每一个源文件；更根本的是**不用 shell 做文本替换** |
| #41 视觉强度只看输入值 | 断言 `style.css` 里各 token 的**实际百分比**落在预期区间（而不是断言滑杆值） |
| #44 路径归一化静默失效 | 断言 `normalizeLocalPath('file:///C:/…')` **不以 `/` 或 `\` 紧跟盘符开头**，且 `.replace(/\\/g,'/').endsWith('/profiles/web/cordis.yml')` |
| #45 🔴 补丁层 `[]` 占位符会 brick profile | **往返测试**：同一文件"加一行 → 删一行"后与初始**逐字节一致**；并断言"删除后去掉注释的 trim() === `[]`"；再加一条"手写文件无占位符时自动补 `[]`" |
| #46 孤儿行 | 断言未知 entry id → **404**（而不是 200），且补丁文件未被修改 |
| #47 🔴🔴 坏包导致全站停机 | 用**故意造的坏包**撞闸门，6 组：缺 `package.json`／声明 `dsh.client` 无 `./client` 导出／导出指向缺文件／`dsh.bundle.patch` 指向缺文件／`name` 不匹配／自洽包必须成功。**每组都要额外断言"被拒之后目标目录不存在"** |
| #48 备份 ID 撞车 | 连调两次 `backupPlugin`（间隔 0ms），断言 **ID 不同** 且备份份数 = 2 |
| #49 latest 取错版本 | 打包两个版本后断言索引 `latest` 是**较高**版本，且 `totalSize` 与新版目录一致 |
| #50 目标目录被改名 | 更新后断言「目标目录本身仍存在且是目录」+「profile junction 仍能解析到 package.json」 |
| #69 安装包的四条编码/位置契约 | 打包器断言：`.cmd` 条目**逐字节无 ≥0x80**；`.ps1`/`.txt` 条目**前三字节是 `EF BB BF`**；模板变量渲染后**无残留 `@@X@@`**；安装包的备份目录**不在 `.agent-presets` 内** |
| #70 测试脚本自己坏了 | 断言脚本**断言助手本身**可用（先跑一条必然失败的 `Check` 并确认它被记为失败）；把「本文件必须纯 ASCII」变成一条**实际的字节扫描断言**，而不是一句注释 |
| #71 「装到别的机器」类产物 | 真子进程 + 假 `<DSH_HOME>` 端到端：装完逐文件 sha256 吻合／装两次不重复且旧版被备份／`-KeepExisting` 真跳过（标记文件还在）／篡改包被拒且已装内容未变／缺 DSH_HOME 时失败且有指引；**外加负向对照：去掉 BOM 必须失败** |

**给宿主半写离线测试的成本极低，收益极高**：本插件的 `index.js` 只 import Node 内置模块，
所以可以直接 `await import('../index.js')`，配一个假 ctx（`webServer.register` / `on` / `effect`）
就能把 `apply()` 和全部路由跑一遍 —— 61~67 项断言，**不需要起服务、不需要重启**。
两个细节必须做对：

1. 假 `res` **必须是真正的 `Writable` 流**（`new Writable({write})` 收集 chunk），
   否则文件路由里的 `createReadStream(path).pipe(res)` 会以
   `TypeError: dest.on is not a function` 崩掉。
2. 假 `req` 要带 `Symbol.asyncIterator` 异步生成器，因为 `readBody` 用的是 `for await`。
3. 断言要等响应**真正写完**（`res.on('finish')` 的 Promise），文件路由是异步 pipe。

给浏览器半写单测不需要 jsdom：写一个**最小 DOM 替身**（`createElement`/`createElementNS`/
`appendChild`/`replaceChildren`/`setAttribute`/`addEventListener`/`style`/`dataset`/
`textContent`/`querySelector(All)`），把源码用 `new Function('window','document',…)` 跑一遍，
取出 `__internals` 就能断言真实结构。**注意**：替身里 `setAttribute('class')` 不会自动
变成 `className`，所以自己的 `el()` 助手要显式处理 `className`——两边都要对齐真实语义。

---

## 五、运维命令

```powershell
# 插件装到哪
$profile = "$env:DSH_HOME\profiles\web"

# 找到当前服务进程（重启用；看门狗会自动拉起）
(Get-NetTCPConnection -LocalPort 3080 -State Listen).OwningProcess

# 重启（launcher 看门狗会在 ~15s 内自动恢复）
Stop-Process -Id <pid> -Force

# 拿本次启动的登录 token（拼 ?token=… 可换取 cookie）
Select-String -Path "$env:DSH_HOME\..\launcher.log" -Pattern 'token=' | Select-Object -Last 1
```

### 重启要这样做（否则你会把自己的工具调用一起杀掉）

**你的会话跑在 DSH 进程里。** 直接 `Stop-Process` 会让发命令的那次工具调用跟着死掉，
返回"结果未知"；更糟的是，你**紧接着发起的那次"等服务恢复"的轮询**也会在服务死掉的那一刻被杀，
于是你既不知道重启成没成、也不知道插件有没有加载失败（本次实测踩到，用户只看到一句"启动失败了"）。

正确做法：**让分离进程干完全部活并把结果落盘**，你的下一次工具调用只读那个文件。

```powershell
# restart-verify.ps1（分离执行）
param([int]$TargetPid, [string]$OutFile)
Start-Sleep -Seconds 3
Stop-Process -Id $TargetPid -Force
for ($i=1; $i -le 60; $i++) {
  Start-Sleep -Seconds 2
  try {
    $r = Invoke-WebRequest "$base/dsh-wallpaper/health" -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) { "UP after = $(($i*2))s" | Add-Content $OutFile; break }
  } catch { }
}
(Invoke-WebRequest "$base/dsh-wallpaper/status" -UseBasicParsing).Content | Add-Content $OutFile
```

```powershell
$exe = (Get-Process -Id $PID).Path      # pwsh 不一定在 PATH 上，用当前 shell 的绝对路径
Start-Process -FilePath $exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass',
  '-File', $script, '-TargetPid', "$pid3080", '-OutFile', $out) -WindowStyle Hidden
```

实测恢复耗时 **6~8 秒**（比坑 #21 里写的 ~15s 更快），三次重启全部一次成功。

> ⚠️ 再强调一次坑 #38：**只有宿主半（`index.js`）需要重启**。
> 客户端半（`client.js`）改了会热重载 —— 先确认服务端发的 `rev` 变了就行，别习惯性重启。

**安全提醒**：宿主自定义路由**没有 cookie 鉴权**（只有 `/api` 前缀有）。
所以任何开放本地文件/数据给浏览器的路由，**必须自己做白名单**：

1. 扩展名/类型白名单；
2. `realpath` 之后落在允许根之内。允许根应该是**四个来源的并集**（见坑 #16）：
   - **两份** `workspace.json`（`%DSH_HOME%` 与 `%USERPROFILE%\.dsh`）里登记的工作区 ← 最稳，重启后仍成立
   - 部署级 `sandboxPolicy.workspaceRoot`
   - 各 **live 会话**的 `header.cwd`（滚动新增的工作区立刻生效）
   - 环境变量逃生舱（如 `DSH_MEDIA_ROOTS`）
3. 拒绝点开头的文件与 `.ssh`/`.aws`/`node_modules` 等隐私或依赖目录段；
4. 只读。

用户正在用的平台可能开着更宽的沙箱策略（`danger-full-access`），但**插件不能假设这一点**。

---

## 六、开工顺序（踩了 20 多个坑换来的，别跳步）

**先问清需求，再搭最小可验证骨架，最后写功能。** 顺序反了就会一路靠猜。

1. **问清需求属于哪一类**（坑 #20）。例："预览生成的图片"至少有两条路：
   - A 路径驱动（对话里引用了路径 → 出卡）
   - B 主动浏览（不管有没有路径 → 一个面板列出工作区里的成果）
   两者机制完全不同，B 不依赖 A。**问一句，省一整轮返工。**
2. **先做最小可验证骨架**：宿主一条路由 + 客户端一个槽位按钮，
   用真实服务确认"**按钮能出现、能渲染**"（坑 #15 的教训）。
   契约没验证前，不要往里堆功能。
3. 再写核心逻辑，每步都用**证据链**验证（第二节）。
4. 最后补测试与文档，并回填本 Skill。

**禁止的操作**：
- ❌ 在浏览器里没验证过渲染就开始堆功能（会一路猜到底）
- ❌ 每改一行就重启服务（坑 #21，用户界面会被反复打断）
- ❌ 用户报现象后自己脑补根因并一路补丁（先取现场证据：DOM 属性、会话日志、宿主响应）

---

## 七、新插件 Checklist

- [ ] 三件套骨架照抄；`id` 与包名一致
- [ ] **`package.json` 的 `files` 白名单覆盖 `index.js` 运行时 import 的每一个同级模块**
      （漏一个 → 重装后被删 → 重启加载失败被看门狗禁用，坑 #22）；源目录与已安装目录**两份都要改**
- [ ] **需求先分类**（路径驱动 A / 主动浏览 B），别脑补（坑 #20）
- [ ] **槽位里的组件返回 React 元素**（坑 #15）；纯 DOM 只用于自己挂到 body 的浮层
- [ ] `BUILD` 构建号 + 写进 `<style data-plugin-build>` + `<html data-*-build>`
- [ ] 阶段状态写进 `<html data-*>`，浮层默认关闭、可开关
- [ ] 宿主半：必需服务进 `inject`，可选能力用 `ctx.get()` 探测并降级
- [ ] 宿主半：所有文件/数据访问过 PathGuard 式白名单，**允许根含两份 workspace.json**（坑 #16）
- [ ] 浏览器半：只用静态模块表里的库
- [ ] 任何"等网络"的状态都有超时 + 可见失败；**失败要留重试出口**（坑 #17）
- [ ] 幂等渲染：重建会导致副作用的元素（video/audio）之前先比 `{kind, src}`（坑 #4）
- [ ] 自检页 `/<前缀>/selftest`（宿主自检 + 真实 client.js + 抖动哨兵）
- [ ] 单测覆盖：纯函数 + 卡片结构 + 路由（含 Range/越界拒绝）+ 工具
- [ ] **单测里没有用固定 `setTimeout` 当同步屏障**（等异步结果一律轮询 + 超时，坑 #23）
- [ ] 装进 profile、**攒够改动一次性重启**（坑 #21）、用证据链 ① 确认服务端在发新构建号
- [ ] **确认 profile 里没有第二个插件在改同一片对话流 DOM**：
      同类渲染器只留一个；用各自的 `/health` 路由确认在线状态（坑 #24）
- [ ] **给模型用的 HTML 产物**：若要在侧栏预览，必须**单文件自包含**（内联 style/script、
      图片可外链、数据硬编码），生成后 `sidebar_open` 打开（坑 #25）
- [ ] **原生库（CUDA / GPU / 任何 `.node`）一律隔离到子进程**，不要在宿主进程里加载。
      宿主进程里崩掉的 `GGML_ABORT` 级错误是 `try/catch` 抓不到的，只能靠进程边界兜（坑 #26）。
      子进程 spawn **不要用管道 stdio**（沙箱下 EPERM），日志落文件 + 回环 HTTP 通信。
- [ ] **鸭子类型实现 LLM 适配器时，把基类 `LlmAdapter` 的 7 个方法全部补全**
      （`providerInfo` / `providerRetryPolicy` / `imageRequestPricing` / `listModels` /
      `resolveModel` / `prepareCall` / `stream`），漏一个就会在运行期才炸（坑 #27）。
- [ ] **接自定义模型要同时注册三件**：`registerAdapter` + `registerConfigurableProviders`
      + `settings.register`。少了目录条目，模型就"能用但不在设置页的列表里"。
- [ ] **`apply()` 里每一处外部访问都当作可能抛异常**：`ctx` 是 Proxy，访问未注入属性会抛，
      并**带崩整个插件树 → 被看门狗禁用**。配置读第二参数、日志包 `safeLog()`（坑 #29）。
- [ ] **接第三方模型时先查词表里特殊 token 的"类型"**：CONTROL 类 token 会被库的默认
      解码**静默丢弃**（表现为输出缺字符）。XML 式工具调用尤其容易中招（坑 #28）。
- [ ] **不要 import DSH 的包**（`@deepseek-ai/*`）：插件真实路径下解析不到，
      用注入的服务 + 按契约手工构造数据（坑 #30、#12）。
- [ ] **模型类插件的参数要能被用户改**（上下文窗口、GPU 层数、采样参数）：
      注册 settings 命名空间 + schema，默认值照上游官方推荐（如 min_p 必须显式设 0）。
- [ ] **注册 settings 命名空间后，自检路由必须暴露 `namespaceRegistered` 布尔值**。
      它失败时是静默的，不暴露就查不出来（坑 #30 的"最阴变体"）。
- [ ] **适配器要申报 `reasoning.efforts` 且覆盖 DSH 可能传来的全部标准档位**
      （`off`/`low`/`medium`/`high`），否则请求会在发起前被拒（坑 #31）。
- [ ] **接小模型时默认关掉思考链**，并把 `maxTokens` 按模型规模调小；
      推理层要有"每次生成"的现场日志（提示词大小/耗时/停止原因/token 数）（坑 #32）。
- [ ] **接小模型要提供 `promptMode` 开关**（chat = 短人设 + 不发工具 / agent = 完整人设与工具）。
      DSH 的 agent 提示词在真实规模下会把小模型压成"复述人设 / 拒绝回答 / 乱调工具"（坑 #32）。
- [ ] **验证模型接入时必须人工读一遍真实回答**，并且**在真实规模下测**
      （真实大小的系统提示词 + 真实数量的工具）。协议全绿 ≠ 回答正确。
- [ ] **给模型用的参数默认值照上游官方推荐写**，尤其别漏掉官方明确要求的值
      （例：MiniCPM5 要求显式设 `min_p=0.0`，llama.cpp 默认 0.05 会引发重复输出）。
- [ ] **读 settings 必须用 `scope.get()`，不是 `scope.value`**（后者不存在，
      会让插件静默忽略用户配置）；写完**立刻回读**验证接通（坑 #35）。
- [ ] **界面可改的配置**：字段定义单一来源 + 白名单校验 + 「恢复默认」，
      写入口走宿主路由；表单按字段定义动态渲染（坑 #35）。
- [ ] **重启前先分类 launcher.log 里的退出码**（`4294967295`=被强杀/是人重启，
      `3221226505`=真崩），别把"自己重启"误判成"插件崩溃"（坑 #21）。
- [ ] **重启次数要克制**：频繁重启会耗尽看门狗的重试预算，让它"停止重试"、
      服务直接停住，用户界面连不上（坑 #21 升级版）。
- [ ] **重启那一步用分离进程延迟执行**，否则"杀服务"的命令会把自己带走、
      工具调用被中断且结果未知（坑 #21）。更进一步：**让分离进程把"服务是否恢复 +
      `/status` 结果"写进文件**，因为连"等服务恢复"的轮询命令也会一起被杀（坑 #38）。
- [ ] **同一个 path 只注册一条宿主路由**（键是 `(kind, path)`，不含 method）。
      读/写靠 `req.method` 在 handler 内分派；重复注册会抛异常 → 带崩插件树 → 被看门狗禁用（坑 #37）。
- [ ] **宿主半离线测试**：假 `ctx.webServer.register` 要**复刻真实行为**（重复键就抛），
      并断言 `apply()` 不抛 + 路由条数符合预期。假 `res` 必须是真 `Writable` 流（坑 #37、第四节）。
- [ ] **改宿主半 ≠ 改客户端半**：`index.js` 要重启，`client.js` 会热重载。
      先抓组合 URL 的 `rev` 确认服务端在发新版，再决定要不要重启（坑 #38）。
- [ ] **浏览器侧诊断要分来源存**（`reports.probe` / `reports.client`），
      上报体里带 `source`；共用一个槽位会互相覆盖，让排查者拿着过期读数下结论（坑 #39）。
- [ ] **绝不用 `Get-Content` | `Set-Content` 做文本替换**（会以本机 ANSI/GBK 读 UTF-8，
      双重编码直接毁掉整个中文源文件，且**不可逆**）；改文本一律用 `edit`/`write` 工具，
      shell 里非做不可时用 `[System.IO.File]::ReadAllText/WriteAllText` 显式指定 UTF-8（坑 #40）。
- [ ] **构建号这类"到处都要改"的常量尽量只有一处定义**，别散在多文件里等着被批量替换（坑 #40）。
- [ ] **视觉强度类参数（透明度/缩放/阈值/权重）要用映射之后的实际值验收**，
      不能只看滑杆/输入值；用户说"没生效"时先分辨是**真没生效**还是**生效了但看不出来**（坑 #41）。
- [ ] **如果要在 `<head>` 注入样式去覆盖官方令牌**：选择器要用 `html body` 这类更高特异性的写法，
      因为官方样式表是运行时 append 进 `<head>` 的，文档顺序上一定晚于你的首屏注入（坑 #41 的前置发现）。
- [ ] **交付「拷到别的机器就能装」的产物时**：`.cmd` 逐字节纯 ASCII（且**模板里不引用含中文的变量**）、
      `.ps1`/`.txt` 打包时加 BOM、多行中文文本出独立 `.txt` 让 PS 读而不是注入模板、
      安装备份放在**被扫描目录之外**（坑 #69）。
- [ ] **安装器要有端到端测试**：真子进程 + 假 `<DSH_HOME>`，覆盖「装完 sha256 吻合 / 装两次不重复 /
      `-KeepExisting` 真跳过 / 篡改包被拒且已装内容未变 / 缺 DSH_HOME 时失败且有指引」，
      外加**负向对照**（去掉 BOM 必须失败）（坑 #71）。
- [ ] **打包器带「清单里的文件必须真的在包里」这道闸门**（坑 #71：它第一次运行就抓到了真 bug）。
- [ ] **写 `.ps1` 测试脚本时的三条**：别让非 ASCII 混进「必须纯 ASCII」的文件（并把这件事变成字节扫描断言）；
     别用不存在的 `Append-Text`；跑「预期失败」的子进程前把 `$ErrorActionPreference` 降成 `Continue`（坑 #70）。
- [ ] **给"另一个进程"传参数时，验证必须走产品自己用的那个入口**（`spawn`），
      不要用 `Start-Process`/`cmd start` 之类的旁路测 —— Node 在 Windows 上会重拼 argv，
      参数自带引号会被二次转义而**静默失效**（坑 #73）。
      参数形态要**逐字写进回归测试**（如"两个元素、任何元素都不含引号"）。
- [ ] **交互动作要即时上报**，不要指望"下次扫描会把它带出去"；
      **被节流/去重的上报必须补发**，否则宿主侧只剩过期读数（坑 #75、#76）。
- [ ] **挂到别人 React 树旁边的节点要假设"周边会被重建"**：
      幂等除了块上的 `done` 标记，还要给节点本身写**内容键**去重（坑 #77）。
- [ ] **"应当被拒绝"的测试，必须确认拒绝你的正是那条规则** ——
      样本要恰好只违反目标那一条（测根白名单就用"存在但越界"的文件，不能用不存在的路径）（坑 #78）。
- [ ] **非 2xx 也要解析响应体**，把宿主的 `message` 显示给用户；
      按钮必须有失败态 + 一行可见说明（坑 #79）。
- [ ] **给对话里的路径做"打开"类功能前，先查这条通道被谁接管了**：
      `grep` 兄弟插件源码的 `shadow`/`intercept`/`openWorkspacePath`（坑 #74）。
- [ ] **证据链 ①（服务端在发哪一版）优先用"客户端自报构建号"**，
      而不是 grep 组合 bundle（单个 `/plugins/<pkg>/client.js` 必 404，坑 #80）。
- [ ] **把这次的坑补进本文「坑清单」，把插件记进「插件台账」**

---

## 八、打包与分发（标准形态）

> 这一节是从一个**真实已发布插件**（`dsh-ui-appearance` v0.1.10，4119 下载）
> 的 npm tarball 里拆出来的，不是推测。

### 8.1 一件事先搞清楚：`dsh plugin` 是 pnpm 的薄包装

```sh
dsh plugin --profile web add <包名 | 本地路径 | git-url>
```

它把包加进 profile 的 `dependencies`、与 `dsh.profile.bundles` 对账，
**并自动合并该包自带的 `cordis.patch.yml`**。官方注释原话：

> the command reconciles `dsh.profile.bundles` against installed packages and,
> seeing this declaration, appends `dsh-better-sidebar` to the bundle stack.
> **No profile file edits needed — one command installs and mounts.**

### 8.2 包的标准形态

```
package.json          ← 核心：dsh.bundle.patch + dsh.client + peerDependencies
cordis.patch.yml      ← 把自己 insert 进插件树（通常只有 3 行）
LICENSE
README.md / README.en.md   ← 双语是惯例
lib/index.js          ← 宿主半
lib/client.js         ← 浏览器半（由 package.json 的 dsh.client 声明）
lib/*.d.ts + *.js.map ← 类型与 sourcemap（TS 工程才有；手写 JS 可省）
```

`cordis.patch.yml` 的内容就这么多，没有任何魔法：

```yaml
- insert:
    - id: ui-appearance
      name: 'dsh-ui-appearance'
```

### 8.3 `package.json` 里必须声明的三件事

```jsonc
{
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },   // 自带补丁，装机时自动应用
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-settings"] }
  },
  "peerDependencies": {                             // 版本兼容性闸门
    "react": "^18.2.0",
    "@deepseek-ai/cordis": "*",
    "@deepseek-ai/dsh-client-ui-theme": "*"
  },
  "engines": { "node": ">=18", "dsh": ">=0.1.2-rc.1 <0.2.0" },
  "files": ["index.js","client.js","cordis.patch.yml","LICENSE","README.md"]  // 见坑 #22，别漏运行时 import 的同级模块
}
```

`peerDependencies` / `engines.dsh` 就是**插件市场用来判断"能不能装在这个宿主上"的依据**，
两种写法生态里都在用。**不声明 = 别人不知道能不能装。**

### 8.4 四条分发路径

| 路 | 怎么做 |
|---|---|
| **npm（主流）** | `npm publish` → 用户 `dsh plugin --profile web add <包名>` |
| **Git 直装** | `dsh plugin --profile web add <git-url>`（CLI 明确支持 path-or-git-url） |
| **本地文件夹** | 自己写个 `install.ps1`（复制 + junction + 写 `dsh.profile.bundles`），或 `dsh plugin add <路径>` |
| **进目录站** | 提交到 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) / dshmarket.com（注册表 `plugins.json` 现约 3600 条） |

### 8.5 交付清单（照这个收尾）

- [ ] `cordis.patch.yml` + `package.json` 的 `dsh.bundle.patch`（坑 #42：**别和手工 mount 行并存**）
- [ ] `LICENSE` 文件（`package.json` 里写了 `license` 不等于有文件）
- [ ] 去掉 `"private": true`，否则 `npm publish` 直接拒绝
- [ ] `peerDependencies` / `engines.dsh` 声明实测过的版本线
- [ ] `files` 白名单覆盖所有运行时 import 的同级模块（坑 #22）
- [ ] **包名先在 npm 上查重**（`https://registry.npmjs.org/<name>/latest` 返回 200 就是被占了）
- [ ] `install.ps1` 的 `.ps1` **只用 ASCII**（坑 #43）
- [ ] 安装脚本自己检查"profile 里还有没有旧的手工 mount 行"并报警（坑 #42）
- [ ] 提供 `uninstall.ps1`，默认**保留用户数据**，删除要显式开关
- [ ] 交付前跑一遍：`node --check` 每个源文件 + 离线测试 + 非 ASCII 扫描

### 8.6 发之前先看一眼市场

`theme` 这一个分类就有 **128 个插件**，其中二十来个在做"自定义壁纸 + 面板半透明"，
下载量从几百到两万八。**先查重、再看自己有没有真实差异点**，
否则投入的时间大概率换不来注意力。

---

## 九、插件台账

> 每开发一个插件就在此处记一行。**这是本 Skill 要求强制更新的第二处。**

| 插件 | 干什么 | 关键设计 | 踩到的坑 | 源码位置 |
|---|---|---|---|---|
| `dsh-media-preview` | ①对话里内联预览图片/视频/音频+一键下载 ②底栏「最近生成」面板（翻看/下载工作区里的成果） | 宿主五条只读路由（file/**recent**/allow/health/selftest）+ PathGuard 白名单（四来源）；卡片纯 DOM 渲染；槽位按钮**必须 React 元素**；「最近生成」完全不依赖对话文本；**`package.json` 的 `files` 必须列全运行时 import 的同级模块**（坑 #22）；**同一 profile 里只允许一个对话流 DOM 渲染器**（被 `@wingsky-1/dsh-web-file-preview` 抢过同一片 DOM，见坑 #24） | #1 #2 #3 #4 #5 #6 #7 #8 #13 #15 #16 #17 #20 #21 #22 #23 **#24** | `D:\DSH\DH2\实验区\dsh-media-preview\`（已装进 `profiles/web`）<br>冻结点 `v10-20260913-react-button`，快照在 `dsh-plugin-skills\frozen\`（2026-09-13 冻结，用户确认正常）<br>⚠️ 冻结快照里的 `package.json` 仍是**未修正**的 `files` 白名单，从快照回退后若再跑 pnpm 仍会删文件（见坑 #22） |
| `dsh-composer-upload` | composer 底栏"上传文件"按钮 | 图片走合成 drop 复用 DSH 摄入通道；文档本地抽文本 + 落盘 + 仅插一条 @引用 | 先于本 Skill 存在，未回填 | `profiles/web/node_modules/dsh-composer-upload` |
| `aces-system`（技能，非插件） | 调用 ACES 创作平台：文生图/图生图/图生视频/BGM/数字人 | 落盘到会话工作区再打印绝对路径，媒体预览才能出卡；`data: null` 判空；KEY 路径按 `aces_client.KEY_FILE` 实际推导 | 见 `dsh-plugin-skills\aces-system-patches\` 的补丁记录 | `%DSH_HOME%\skills\aces-system\` |
| `@wingsky-1/dsh-web-file-preview` | 第三方市场插件：文件预览 Modal / HTML 预览 / Diff / Mermaid 渲染，并把聊天流里的路径变成可点预览 | **与 `dsh-media-preview` 在同一片对话流 DOM 上抢路径文本**（它用 `fetch → Blob → objectURL` 内联渲染，带 `AbortSignal`，被对方重建即 abort）→ 卡片"闪一下就没了"。**2026-09-13 已在 `profiles/web/cordis.patch.yml` 禁用**（`- id: ui-dsh-web-file-preview` / `disabled: true`），用户确认恢复正常 | #24 | `profiles/web/node_modules/@wingsky-1/dsh-web-file-preview`（第三方包，非本项目开发；**要恢复它必须先拆掉冲突**） |
| `dsh-better-sidebar` | 第三方市场插件：VSCode 式**右侧栏工作台**（文件树/编辑器/终端/Git/**内嵌浏览器**/HTML 预览/PDF/子会话/自由窗口），按会话隔离；向其他插件开放 `ctx.betterSidebar.registerTab / registerFileViewer`；向模型提供 `sidebar_open` 与 `terminal_*` 工具 | **HTML 产物一律走它的 `/sidebar/html` 路由在侧栏看，不要往对话里塞**（对话内联渲染风险高）。用它必须遵守"单文件自包含"约束（坑 #25）。内嵌浏览器对**回环白名单**内的地址额外给 `allow-same-origin`（ESM/HMR/fetch 可用），但**永远不给 GUI 自己的 origin** | #25 | `profiles/web/node_modules/dsh-better-sidebar`（含完整 `src/`，唯一可直接读源码的插件；第三方包，非本项目开发） |
| `dsh-minicpm-local` | 把开源模型 **MiniCPM5-2B**（Q8_0 GGUF，官方模板/工具调用全兼容）接成 DSH 的「自定义模型」，让它在**模型选择器**里可选、在**设置→模型**里有可配置的一行；**本地运行、不外发**，不依赖 Ollama 等任何外部服务 | **① 架构：模型跑在插件自带的子进程里**（`worker.js`），父进程（插件）只做管理与 HTTP 流式转发 —— 因为在 DSH 进程内加载 CUDA 会 `GGML_ABORT` 硬终止整个 DSH（坑 #26，实测反复重启用户界面）。② **必须同时注册三件东西**：`registerAdapter`（进选择器）+ `registerConfigurableProviders`（进设置页列表）+ `settings.register`（该行才有可解析的设置地址）；只注册适配器的话模型"能用但在设置页找不到"。③ **提示词与输出解析全部自己实现**：MiniCPM5 的工具调用是自定义 XML（`<function name=""><param name=""/></function>`）而非 OpenAI `tool_calls`，任何库的 function-calling 抽象都对不上；官方模板用 `<think>`/`</think>`（词表 id 8/9）区分思考。④ **解码必须 `detokenize(tokens, true, ...)`**：工具标签是 CONTROL 类 token，库默认解码会静默丢掉（坑 #28）。⑤ 采样照官方推荐 `temperature=1.0 / top_p=0.95 / **min_p=0.0**`——llama.cpp 默认 min_p=0.05 会引发重复输出。⑥ 上下文窗口等参数在 settings 命名空间里可改，默认 32768。⑦ **默认 `promptMode:'chat'`**：替换掉 DSH 的 agent 人设并丢弃工具定义（实测输入从 ~18500 tokens 降到 63，否则 2B 模型会复述人设/拒绝回答/乱调工具）；需要 agent 能力时切 `'agent'`。⑧ **settings 命名空间用自实现 schema（`schema.js`）**，不 import `@deepseek-ai/schemastery`——那条路会让命名空间静默注册失败、用户"在设置里看不到模型"（坑 #30 最阴变体） | #10 #12 #21 #22 **#26 #27 #28 #29 #30 #31 #32** | `%DSH_HOME%\plugins\dsh-minicpm-local\`（源码+依赖，含 `node_modules` 约 730MB）<br>profile 里是 junction：`profiles/web/node_modules/dsh-minicpm-local`<br>权重：`%DSH_HOME%\models\minicpm5-2b\MiniCPM5-2B-Q8_0.gguf`（2.56GB，ModelScope）<br>自检：`GET /dsh-minicpm-local/status` 与 `/selftest`<br>单测：`node test/run-tests.mjs`（19 项，含分块不变性） |
| `dsh-ollama` | 对接本机 **Ollama**：把它已安装的模型**动态读出**作为 DSH 可选模型；在「设置 → 模型 → Ollama（本地）」里可看/可选/可配。**零第三方依赖**，只用 Node 内置模块 | **① 模型跑在 Ollama 进程里**，插件只做协议翻译 + DSH 注册 ⇒ 没有坑 #26 那种原生库炸宿主的风险，模型列表还能动态读（`ollama pull` 后自动可选）。② 用**原生 `/api/chat`**：`thinking` 与 `content` 是分开的字段（不必解析 `</think>`），且直接给精确 token 用量与 `done_reason`。③ `/api/tags` 出列表 + **`/api/show` 逐模型复核能力**（实测 tags 会漏 tools/thinking/vision）。④ **显式下发 `think`**（思考型模型默认开思考）与 **`num_ctx`**（默认只有 4096，会被 18.5K 的 agent 提示词静默截断）。⑤ 转换层把 DSH 塞在 `user` 里的工具结果转成 Ollama 的 `tool` 角色，`tool_calls` 参数从字符串转对象。⑥ **图片/视觉**：`capabilities` 含 vision 的模型自动声明 `['text','image']`（`visionMode:'auto'`），图片经 `ctx.attachments.readImageRequest()` 解析成请求版本再转 base64 交给 Ollama 的 `message.images`；留 `visionExclude` 名单应对"报告有 vision 但实测不收图"的模型（默认排除 `gemma4`，实测依据见坑 #34）。**能力必须在 `listModels()` 与 `resolveModel()` 两处一致反映**，漏一处图片会被换成 sha256 文字占位符。⑦ **配置可在界面直接改**：卡片自带编辑器，表单按宿主返回的字段定义**动态渲染**；写入走宿主路由 `POST /dsh-ollama/config`，过白名单校验（未知字段拒绝、类型归一、非法值报错），另有「恢复默认」。读配置必须用 `scope.get()`（坑 #35）。⑧ **上下文按模型自适应**（`contextMode:'auto'`）：实际窗口 = `min(模型原生窗口, contextCeiling)`，且**同一个值同时用于**发给 Ollama 的 `num_ctx` 与申报给 DSH 的 `contextWindow`（两者不一致会让 DSH 误判可用空间）。⚠️ **不要做成"按对话长度动态自适应"**：实测 num_ctx 每变一次 Ollama 就整模型重载一次（2B 每次 ≈2.9~4.0s），越调越慢；且 num_ctx 直接决定显存（同一 2B：8192→2.9GB、32768→4.0GB）。 | #10 #12 #26 #27 #29 #30 **#31 #33 #34 #35** | `%DSH_HOME%\plugins\dsh-ollama\`（源码，零依赖）<br>profile 里是 junction：`profiles/web/node_modules/dsh-ollama`<br>诊断：`/dsh-ollama/status` `/models` `/config`(GET/POST) `/selftest`（支持 `?image=<绝对路径>` 做视觉端到端）<br>单测：`node test/run-tests.mjs`（37 项） |
| `dsh-daily-workspace` | 让「日常使用」分区以**相对位置**（`%DSH_HOME%\daily-use`）存在，与超级智能体/智能体编排/知识库/技能使用那几个插件自建的分区一致（原先它是手动添加的绝对路径 `D:\DSH\DH2\实验区`） | 宿主侧单文件、零依赖：启动时 `fs.mkdirSync` 建目录，再 `ctx.workspaceRegistry.create(dir, '日常使用')`。**必须先 mkdir**（create 要求目录已存在，否则以原始错误 reject），而 create 对同一 canonical path **幂等**（"return the existing entity without changing its title"），所以每轮启动调用安全。参照实现：`dsh-skill-panel` 的 `ensureSkillWorkspace`、`dsh-agent-maker` 的 `ensureWorkspace`。**不在 DSH 进程内加载任何原生库**。 | #29 #35 **#36** | `%DSH_HOME%\plugins\dsh-daily-workspace\`（含 `index.js` / `patch-dsh-daily-default.mjs` / `PATCH-dsh-daily-default.md` / `remove-legacy-daily.mjs`）<br>profile 里是 junction + 一条 insert |
| `dsh-wallpaper` | 给 DSH Web GUI 换**窗口背景**：纯色 / 渐变 / 图片壁纸，并让侧栏与卡片半透明以透出背景。入口在 **设置 → 通用 →「窗口背景」**，与官方自带的「外观」「正文字号」并排。补的是官方**没有**的那块（官方只有 light/dark/system + 字号） | **① 先盘点官方能力，再决定写什么**：`@deepseek-ai/dsh-client-ui-theme` 已提供明暗/跟随系统与字号，且开放了 `ctx.theme.register/overrideTokens`；本插件只补"自定义颜色/背景图"。② **走官方槽位** `settings.general.item`（它是 `settings.section` 注册项里用 `children` 声明的**子槽位**，不是顶层槽位），注册形状照抄 ui-theme 的 `AppearanceRow`。③ **首屏注入防闪烁**：宿主监听 `webserver/index-inject`，往 `<head>` 塞 `<style id="dsh-wallpaper-boot">`；客户端加载后取 `GET /style.css`（宿主与客户端**共用同一份 CSS 实现**）写回同一个元素。④ **令牌覆写的选择器必须是 `html body`**（不是 `body`）——官方样式表是运行时 append 进 head 的，同特异性下文档顺序必输。⑤ **颜色按官方调色板变量做半透明合成**（`color-mix(in srgb, var(--dsw-static-neutral-bluish-950) 35%, transparent)`），不硬编码色值，官方换配色自动跟随。⑥ **壁纸走上传而不是让用户填路径**：字节过魔数校验后按内容哈希落盘到 `%DSH_HOME%\wallpapers\files\`，取图路由只认 `^[0-9a-f]{40}\.(png\|jpg\|gif\|bmp\|webp)$` ⇒ 用户提供的任何路径都到不了文件系统。⑦ **诊断通道**：宿主注入一段探针脚本（不依赖客户端模块是否加载），把浏览器**计算后的** token 值/侧栏背景色/客户端阶段报回 `/report`，按 `source` 分槽存；另有 `GET /status`（配置+字段定义+两份上报）与 `/health`。⑧ **69 项离线测试**，用假 ctx 把 `apply()` 与全部路由跑通，不需要起服务。⑨ **令牌覆写必须带十六进制兜底**：`color-mix(in srgb, var(--dsw-static-x) N%, transparent)` 里的 `var()` 一旦解析失败（官方改令牌名），整条声明变成 invalid at computed-value time ⇒ 自定义属性退化成 guaranteed-invalid ⇒ `background` 回落到 initial = **全透明、面板直接消失**；写成 `var(--dsw-static-x, #151517)` 后最坏只是颜色略偏。测试里有断言专门盯这个。⑩ **按标准形态封装**：自带 `cordis.patch.yml` + `dsh.bundle.patch`，安装只走 `dsh.profile.bundles` 通道（**手工 mount 行必须删掉**，否则双重挂载启动失败，坑 #42）；`install.ps1` / `uninstall.ps1` 幂等且**只用 ASCII**（坑 #43）；不上 pnpm、不动别的插件 | #15 #21 #29 #35 **#37 #38 #39 #40 #41 #42 #43** | `%DSH_HOME%\plugins\dsh-wallpaper\`（**纯 JS，零依赖零构建**，97 KB / 9 个文件）<br>开发目录 = 会话工作区 `skill-sessions\dsh-wallpaper\`（两层 junction 指过来，改客户端半即热加载）<br>profile 里是 **junction + `dsh.profile.bundles` 一条**（2026-09-14 从手工 insert 迁移过来，已实测）<br>安装：`powershell -ExecutionPolicy Bypass -File install.ps1`（自带双重挂载检查）<br>诊断：`/dsh-wallpaper/health` `/status` `/config`(GET/POST) `/style.css` `/upload` `/file/<name>` `/report`<br>单测：`node test/run-tests.mjs`（69 项）<br>（用户确认侧栏/卡片明显透出壁纸；`engines.dsh` 声明 `>=0.1.2-rc.1 <0.2.0`） |
| `dsh-dstation-market` | D-STATION 插件市场（**阶段 0**）：在「设置 → 插件」里加一个「D-STATION 市场」标签页，列出已装插件、**热停用/启用**、重启。补的是 DSH 的一个真实空缺——**装完插件之后界面上没有任何地方能关掉它** | **① 停用/启用是热的，根本不需要重启**：机制是往 profile 的 `cordis.patch.yml` 写 `- id: <entryId>` / `disabled: true`（该文件有 live watcher，实测 2 秒生效）；而 `dsh.profile.bundles` 是启动时读的（实测不重启 12 秒全 404）⇒ **装/卸要重启，开关不用**。② **补丁文件语义整套抄 `dshmarket/lib/patch.js`**，包括那个会 brick profile 的 `[]` 占位符处理（坑 #45）。③ **重启交给 launcher 看门狗**：本 profile 里 dshmarket 的 `allowRestart` 被显式关掉（注释写明"重启交给 launcher 看门狗管理"），所以做法是**分离进程自杀 → 看门狗 6~8 秒拉起**（实测 4 次全部自动恢复），**不需要改 Electron 壳**。④ **清单要认两条通道**：`dsh.profile.bundles`（entry id 从各包自带的补丁解析）+ profile 补丁里的 `insert` 行（包名从 insert 的 `name` 取）+ `%DSH_HOME%\plugins\` 落盘但未挂载的。⑤ **受保护插件不允许停用**：`@deepseek-ai/*` 与市场自身。⑥ 变更类端点必须**本机同源**（回环 + 无转发头 + Origin === Host，本地自定义路由没有 cookie 鉴权）。⑦ 挂载点 `settings.plugins.tab`（官方「插件清单」用的同一个槽位）。⑧ 39 项离线测试 | #44 **#45 #46 #47 #48 #49 #50 #51 #52 #53 #54 #55 #56 #57 #58 #59 #60 #61 #62** | `%DSH_HOME%\plugins\dsh-dstation-market\`（零依赖，纯 JS）<br>**① 阶段 0**：`settings.plugins.tab` 里「D-STATION 市场」标签页，热停用/启用、重启。用户确认可用。<br>**② 阶段 1**：可下载列表 + 一键安装（逐文件 + sha256 + 暂存 + 自洽性闸门 + junction + bundles 注册）。**已上线 `https://your-market-host/plugins/`**（走 SSH 密钥传，不用云 API）。<br>**③ 阶段 2（OTA）**：`POST /update` —— 先完整备份 → 下载校验 → 自洽性闸门 → **清空内容再填充**（不能重命名目录，坑 #50）→ 失败**自动回滚**；`POST /rollback` + `GET /backups` 支持手动回滚。**端到端实测通过**：`dsh-wallpaper 1.0.0 → 1.0.1` 更新成功、回滚后 9 文件/99420 字节与原始完全一致。<br>**④ 曾造成全站停机**（坑 #47）：打包器漏打 `package.json` → 装出的包无元数据 → `dsh-client-modules` 组装失败 → **核心条目不可自动禁用** → DSH 起不来。已加三层闸门。<br>**⑤ 阶段 3（投稿/审核）**：**方案 A —— 不新增服务端**，走 GitHub PR 投稿 + 本地发布 CLI。公开浏览页 `https://your-market-host/plugins/`（自包含单文件：搜索、分类、卡片、一键复制安装说明、内含投稿指南）。<br>工具：`skill-sessions\_dstation-market-tools\`：`validate.mjs`（静态审核闸门：禁原生模块 `.node/.exe/.dll/.so/.dylib`、禁生命周期脚本、校验 `./client` 入口与相对 import 真实存在）、`pack-plugin.mjs`（生成产物+索引）、`verify-store.mjs`（上传前/线上逐文件 sha256）、`publish.mjs`（validate→pack→本地校验→scp→线上校验，五步一体，支持 `--no-upload` 干跑）。<br>诊断：`/health` `/state` `/catalog` `/operations` `/backups` `/source`；写操作 `/toggle` `/install` `/update` `/rollback` `/uninstall` `/remove-rows` `/restart`<br>单测：`node test/run-tests.mjs`（**118 项**）<br>**⑥ 阶段 4（投稿 + 审核，方案 B = 真一键）**：<br>· **收稿服务**（独立进程，**不碰 RunningHub 网关**，见坑 #54）：纯 Python 标准库 `submit_server.py`，systemd 单元 `dstation-plugins`，监听 `127.0.0.1:8100`，nginx `location = /plugins/submit` 精确匹配反代（转发头用 `$remote_addr` **不是** `$proxy_add_x_forwarded_for`，否则可伪造 IP 绕限流）。<br>· **投稿侧** `submit.mjs`：本地结构检查 + 风险扫描 → **纯 Node 自写 zip**（自带 CRC32，零第三方依赖、不 shell out）→ POST → 回执翻成人话。<br>· **审核侧** `audit.mjs` 风险扫描引擎（外联/凭据/子进程/eval/混淆/**相称性**）+ 服务器端 `review.mjs`（`list`/`show`/`files`/`cat`/`approve`/`reject`/`purge-rejected`）+ 本地包装 `review.ps1`（解决 Windows→ssh 引号问题，见坑 #52/#53）。<br>· **两个 skill**：`dsh-plugin-submit`（投稿人用，整个目录可打包转发给他人）、`dsh-plugin-review`（管理员用）。<br>· **关键安全设计**：管理端**完全不设 HTTP 接口**（走 SSH）⇒ 公开服务零提权入口；systemd 沙箱 `ProtectSystem=strict` + `ProtectHome=true` + `ReadWritePaths=/opt/dstation-plugins` ⇒ 收稿服务**物理上没有权限**改线上目录，被完全攻陷也只能往待审区塞垃圾。**AI 只做分诊，放行必须由人按按钮**（防提示注入）。<br>· **测试**：`node test-audit.mjs`（**18 项**，含真恶意样本必须全中 + 正常插件必须不炸）+ `python server/test_submit.py`（**28 项**，含目录穿越 / zip bomb / 符号链接 / 限流 / **超大 Content-Length 在读取前就拒绝**）+ `python server/probe_server_gate.py`（绕过自家工具直投线上接口做对抗性验证，实测 4/4 全部拦截）<br>**⑦ 阶段 5（导出成自包含安装包）**：`export.mjs` —— 任意插件 → `<名字>-<版本>-分发包.zip`，对方**解压双击就装好**，不需要命令行、不需要懂 DSH 目录结构。包内：`一键安装.cmd`（纯 ASCII，因为 cmd.exe 按 OEM 代码页读 .cmd）/ `install.ps1`·`uninstall.ps1`（**UTF-8 带 BOM**，所以在 PS 5.1 下中文提示正常 —— 这条更正了坑 #43）/ `安装说明.txt` / `MANIFEST.json`（逐文件 sha256）/ `plugin/`。<br>· **安装器做四件事**：自动探测 DSH_HOME 与 profile → **逐文件核对 sha256** → 复制 + 建 junction + 登记 `dsh.profile.bundles`（改前备份、改后**读回验证**）→ 检查「双重挂载」冲突。<br>· **它主动拦下的坏包**：缺文件 / 内容被篡改 / 声明了 `dsh.client` 却缺 `exports["./client"]`（**这一条正是坑 #47 全站停机的复发路径**）。拦下来时**不留下半成品**（bundles 未被改动）。<br>· **测试** `tools/test-export.ps1`（**36 项**）：在**假 DSH 环境**里真装一遍，并故意破坏包验证拦截；用**真子进程**调用（见坑 #56）。<br>**⑧ 阶段 5b（市场插件里的「导出」按钮）**：把导出能力搬进市场插件 —— 新增 `exporter.js`（纯 JS，**不 fork 子进程**）+ 随插件走的 `templates/`（进 `files` 白名单）+ `POST /dstation-market/export`（回 zip 字节，客户端 fetch 成 blob 再 `<a download>` 落地）。<br>· **用 POST 不用 GET**：能复用 `trustedMutation` 的同源闸门（GET 导航不带 `Origin`，没法做同样校验，会变成「任意外站都能触发下载」），且中文长文本放 JSON body 更稳。<br>· **`pkg` 拼进文件系统路径 ⇒ 两道闸门**：包名白名单正则 + 解析后路径断言仍在 `plugins\` 内。**10 种穿越写法全部 400**。<br>· **受保护插件也允许导出**（导出是只读操作，被限制的不是它是停用/卸载）。<br>· **结构不自洽的插件直接 400**，要求先修好再导出。<br>· **两份实现刻意分开**（Skill 侧要能独立转发给第三方，不能反向依赖"本机装了市场插件"）⇒ 用一条**漂移检测**测试兜底：两边的 zip writer 对同一组条目必须产出**逐字节相同**的包（zip writer 时间戳固定，这条测试才成立）。<br>· 测试 **151 项**（+33）。|
| `dsh-bundled-runtime` | 把包内自带的运行时（`runtime\python` 可嵌入 Python 3.13 / `runtime\git` MinGit / `runtime\node`）补进**内核进程的 PATH**，让绿色版在没装 Python/Git 的机器上也能跑 ACES 创作技能、插件市场审核工具（`home\skills\**\*.py`）与右侧栏 Git 面板。宿主半、零第三方依赖、无 client.js | **① 只在系统里没有该命令时才补**（自己走 PATH 搜索，找到就 skip）—— 否则自带的可嵌入 Python（无 pip/site-packages）会顶掉用户的完整 Python，他装过的包全部 import 失败（坑 #66）。② **改 `process.env.PATH` 而不是给调用点传绝对路径**：插件跑在内核进程里，pwsh 工具 / 右侧栏终端 / 技能 spawn 的脚本 / better-sidebar 的 git 全部继承；改技能正文既散又会被 OTA 覆盖。③ **不动 `resources\app\main.js`**（OTA 覆盖 `resources\app\*`，补丁会被静默冲掉，坑 #67）；也**不用 `$DSH_HOME\.env`**（`loadEnvFile` 无变量展开，写不了可移植的绝对路径，坑 #67）。④ 顺带设 `DSTATION_NODE`（`submit_server.py` 认它）+ `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8`。⑤ **诊断路由 `/dsh-bundled-runtime/health` 用改名后的 PATH 真跑一遍 `--version`** 并返回 `injected`/`skipped`/`presentBefore`/`probes` ⇒ 「通没通」不靠猜。⑥ 双向验证：`-ScrubPath`（只留 `system32`）应补齐并跑通 3.13.7/2.55.0/v22.20.0；正常 PATH 应 `injected: []` 且 PATH 不变（坑 #66） | #66 **#67 #68** | `%DSH_HOME%\plugins\dsh-bundled-runtime\`（源码，零依赖）<br>profile 里是**真实目录**（物化后的 junction）：`profiles/web/node_modules/dsh-bundled-runtime`<br>挂载：`profiles/web/cordis.patch.yml` 一条 insert（id `bundled-runtime`）<br>模板与构建：工作区 `daily-use\_green-build\plugin\dsh-bundled-runtime\`，由 `build-green.ps1` 第 5 步安装<br>自检：`GET /dsh-bundled-runtime/health` |
| `dsh-agent-maker` | 「智能体工作台」（侧边栏 footer 入口）—— 对话式创建智能体 + SUPER AGENTS 列表 + 知识库入口。**本次新增「一键打包我的智能体」**：每个智能体一个 📦 按钮 + SUPER AGENTS 顶部「📦 打包全部」，导出一个自包含安装包，拷到别的装了 D-STATION 的机器上解压双击 `一键安装.cmd` 即可装上 | **① 需求先分三类问清再动手**（粒度：单个/全部/两者；形态：自包含安装包 vs 纯 zip；依赖：本体+清单 vs 连全局技能一起打）—— 三个答案组合出的实现差异极大（坑 #20）。<br>**② 宿主半原本是空壳**（`index.js` 只有 16 行、一条路由都没有），打包能力全部新加：`agent-pack.js`（纯逻辑）+ `templates/`（3 个模板）+ `index.js`（3 条路由）。<br>**③ 智能体不是插件**：只往 `<DSH_HOME>\.agent-presets\<id>\` 放一个目录，**不碰** profile / node_modules / junction / bundles ⇒ 风险面远小于插件分发包。<br>**④ zip 写入器照抄 `dsh-dstation-market/exporter.js`**（纯 Node、CRC32、时间戳常量 ⇒ 同样输入产出同样字节），不重写不引依赖。<br>**⑤ 包结构对 1 个和 N 个智能体完全一致**（`agent/<id>/…` + MANIFEST 的 `agents[]` 数组），安装器只需一套逻辑。<br>**⑥ 安装脚本的编码契约**：`.cmd` 纯 ASCII（且因此**不能引用含中文的模板变量**）、`.ps1`/`.txt` 打包时加 BOM、多行中文依赖清单**单独出 txt 让 PS 读**而不是注入模板（坑 #69）。<br>**⑦ 备份放到 `.agent-presets` 之外**（`<DSH_HOME>\agent-preset-backups\`）—— 放里面会被当成额外的智能体扫出来，列表重复（坑 #69）。<br>**⑧ 打包前两道自洽性闸门**：缺 `agent.cordis.yml` / 空文件 / 无任何 `name:` 条目一律拒绝；且「清单里每个文件必须真的在 zip 里」——**这道闸门第一次运行就抓到了 zip 路径少拼根目录前缀的真 bug**（坑 #71）。<br>**⑨ id 来自客户端 ⇒ 当不可信输入**：白名单正则 + 拼路径前断言（`..`/绝对路径/盘符全挡掉）。<br>**⑩ export 用 POST + 同源回环闸门**（GET 导航不带 Origin，做不了同样校验），响应头按 RFC 5987 写 `filename*=UTF-8''`（中文包名会让 Node 抛 `Invalid character in header content`，坑 #58）。<br>**⑪ 依赖清单做的是分诊不是解析**：非 `@deepseek-ai/*` 的插件、`process.env.X`、疑似 `*_KEY/_TOKEN` 词、**绝对路径**（"拷过去就报错"的头号原因）、引用了哪个全局技能，全部列出并标明哪些是"疑似"。<br>**⑫ 客户端失败路径必须可见**：404 专判并提示「宿主半需要重启一次」（宿主半不热重载），403/400/500 分别给可读原因，绝不静默（坑 #59） | #20 #22 #37 #38 #40 #56 #58 #59 **#69 #70 #71** | 源码 = 安装位置（真实目录，非 junction）：`%DSH_HOME%\profiles\web\node_modules\dsh-agent-maker\`<br>挂载 = `profiles/web/cordis.patch.yml` 的手工 insert（id `agent-maker`）⇒ **改宿主半必须重启**（坑 #38）<br>新增文件：`agent-pack.js` / `templates/{install.ps1.tpl,一键安装.cmd.tpl,安装说明.txt.tpl}` / `index.js`（三条路由）/ `test/run-tests.mjs` / `test/test-install.ps1` / `test/make-bundle.mjs`<br>`package.json` 补了 `files` 白名单（含 `templates/`）<br>诊断：`GET /dsh-agent-maker/health` `/agents`；`POST /dsh-agent-maker/export`<br>测试：`node test/run-tests.mjs`（**126 项**）+ `powershell -File test/test-install.ps1`（**29 项**，真 PS 5.1 子进程 + 假目标环境）<br>备份：同目录 `*.bak-pack-20260919-100111` |
| `dsh-univer-office`（第三方市场包 **+ 本地补丁**） | DSH × Univer 办公套件：14 个 `univer_*` 工具（new/status/worktree/unit/import/execute/compile_svg/inspect/lint/screenshot/api/resources/export/print_pdf），外加内嵌 Gateway/Viewer 预览 | **① 本地补丁（一行）**：`univer_screenshot` 回填附件描述符时用 `ref.mediaType`，而不是渲染器声明的 `item.mediaType`。截图**渲染后** > `2048×2048 = 4,194,304` 像素时仓库会重编码（有 alpha → WebP，无 alpha → JPEG），否则引用与字节错位 ⇒ **该会话此后每一次请求**都报 `DeepSeek API stream from https://api.deepseek.com failed`（本地抛出、被包成 TRANSPORT，重试与重启均无效）。⚠️ `saveImages` **入参**那个 `item.mediaType` 保持不动（声明输入字节类型，仓库靠它校验）。<br>**② 补丁必须可重放**：OTA 的 `WRITE_ALLOWLIST` 含 `^home/profiles/`、市场更新走 pnpm 整体替换目录 ⇒ 两条路都会静默还原。落地形态 = `daily-use\reapply-univer-media-type-patch.ps1`（幂等，退出码 0/2/3/4/5，备份在包外）+ `build-green.ps1` **第 0 步自动补并复验**（补不上才中止，且中止发生在 `Remove-Item $Dst` 之前）+ `verify-clean.ps1` **E 段**把关（见坑 #72）。<br>**③ 渲染边界（实测）**：默认倍率 **2×**，页面积 > 约 104 万像素就进重编码分支；`screenshotMaxPixels` 默认 16,777,216 ⇒ **可渲染页面积上限约 `2048×2048`**，超过报 `SCREENSHOT_PIXEL_LIMIT_EXCEEDED`。<br>**④ 已做过 14/14 功能自检**（sheet/doc/slide/board/base + 导入导出闭环、公式、SVG 编译、lint、截图、resources），并核对过 xlsx/docx/pptx 的导出-再导入保真度 | **#72** | `profiles\web\node_modules\dsh-univer-office\`（第三方包 v0.2.14，**非本项目开发**）<br>补丁重放：`daily-use\reapply-univer-media-type-patch.ps1`<br>成品校验：`daily-use\_green-build\verify-clean.ps1` E 段<br>⚠️ **OTA 或市场更新插件后必须重放**，否则绿包里带的是未修版 |
| `dsh-file-opener` | 让对话里（**含代码块内**）的本地文件路径可点击：点文件名 → **系统默认程序打开**（`.docx/.xlsx` 走 WPS/Office、`.html` 走浏览器）；点文件夹图标 → `explorer /select,` 打开父目录**并选中该文件** | **① 先查官方能力再决定写什么**：宿主自带 `openNativePath`（Win 下 `Invoke-Item`）、RPC `session.openWorkspacePath` + 能力探测 `canOpenWorkspacePath`，所以"打开"不必自己造，也**不 spawn 任何进程**（`/reveal` 除外）。② **官方空缺**：只有「产物事件」会变可点提及（`dsh-client-ui-deliverables`），**正文/代码块里手写的路径无人处理** —— 补的就是这块。③ **与 `dsh-media-preview` 互补不竞争**：它管图片/视频且**不碰 `<pre>`**；本插件以 `<pre>` 为主战场、管任意后缀；跳过规则抄它已验证的那份（`[data-dsh-media-host]` / `.dsh-mmd` / `.cm-editor` / `[contenteditable]`）。④ **只装饰"确实存在"的路径**：候选批量送宿主 `/check`（只回元数据、**不传字节**）；⚠️ 校验未返回前**不许定案**，否则那个块永远出不来条。⑤ **不改正文文字节点，只在块后追加兄弟节点**——流式输出时文字节点每 token 都在变，拆文本会与 React 协调打架。⑥ **两道幂等闸**：块上 `done` 标记 + 节点上**内容键**（React 换块节点时标记会丢、兄弟节点却活着 ⇒ 重复出条，坑 #77）。⑦ **`/reveal` 用自己的路由**：`spawn('explorer.exe', ['/select,', path], {stdio:'ignore'})` —— **两个元素、都不加引号**（坑 #73，五种写法实测才定下来；**不能走 openWorkspacePath**，那个对已打开的目录往往只是切前台，用户会以为"没反应"）。⑧ 路径边界四道闸门（绝对路径 / 段级拒绝 / realpath 落根内 / 只读），允许根**四来源**含两份 `workspace.json`。⑨ 诊断：`<html data-dsfo-*>` + 分来源上报 + **点击即时上报 + 被节流的上报补发**（坑 #75/#76）；非 2xx 也解析宿主 `message`（坑 #79） | #10 #16 #22 #29 #37 #38 #39 #45 #57 #58 #68 **#73 #74 #75 #76 #77 #78 #79 #80** | 源码 = 会话工作区 `skill-sessions\dsh-file-opener\`（`index.js` / `client.js` / `path-guard.js` / `reveal.js` / `cordis.patch.yml` / `test/`）<br>两层 junction：`%DSH_HOME%\plugins\dsh-file-opener` → `profiles\web\node_modules\dsh-file-opener`<br>profile：`dependencies` 一条 `file:./node_modules/dsh-file-opener` + `dsh.profile.bundles` 追加一条（**bundles 只在启动时读 ⇒ 装/卸要重启**，客户端半刷新即可）<br>诊断路由：`/dsh-file-opener/health` `/status` `/check`(POST) `/reveal`(POST) `/report`(POST) `/selftest`<br>单测：`node test/run-tests.mjs`（**132 项**，含浏览器半的最小 DOM 替身）<br>取证/实验：`test/spawn-probe.mjs`（explorer 参数五写法对照）、`test/restart-and-verify-reveal.ps1`（重启+自验证；**用 WMI 启动才逃得出作业对象**）、`test/validate-settings.mjs`<br>⚠️ 依赖设置：`dsh-better-sidebar` 默认 `interceptOpenPath: true` 会 **shadow 掉打开通道**、把文件开进侧栏 ⇒ 已置 `false`（坑 #74；备份 `settings.yaml.bak-intercept-*`） |
| `dsh-office-tools`（第三方市场包 **+ 本地补丁**） | 给模型的 `word_*` / `excel_*` 办公文档工具（读、写、导出 `.docx` / `.xlsx`）；官方内核侧能力 | **本地补丁 `office-tools-sandbox`**：`saveOfficeText` 调 `ctx.fs.writeText` 时**没透传会话沙箱策略**，沙箱解析不到会话 cwd ⇒ 只要会话工作区不在部署根下，`word_*`/`excel_*` 的**写**一律 `FS_SANDBOX_DENIED`（**读不受影响**，所以症状看起来像"权限时好时坏"）。修法：新增 `officeSandboxPolicy(ctx, exec)`（`ctx.get?.("sandboxPolicy")` → `.resolve({ session: exec.agent.session })`）并作为 `writeText` **第 5 参**传入。<br>⚠️ `profiles\web\cordis.patch.yml` 里那条 `workspaceRoot` 只是**兜底**、不是根治：它把部署级可写根指到一个固定路径，会话工作区不在其下时救不了 —— 所以插件侧补丁才是根治。<br>⚠️ **同样会被 OTA / 市场更新静默还原**：它是补丁表里的第 2 条，由 `build-green.ps1` 第 0 步自动补、`verify-clean.ps1` E 段把关（见坑 #72） | **#72** | `profiles\web\node_modules\dsh-office-tools\`（第三方包 v1.0.0，**非本项目开发**）<br>补丁表：`daily-use\reapply-local-plugin-patches.ps1`（条目 id `office-tools-sandbox`）<br>复现校验：对未改过的原版打补丁 → 产物与活装机逐字节一致（sha256 `ba34226b…`）<br>⚠️ OTA 或市场更新后必须重放 |
| 既有第三方市场插件 | dsh-mermaid / dsh-canvas-preview / dsh-better-sidebar 等 | 第三方市场包，非本项目开发 | 未回填 | `profiles/web/node_modules/` |

填台账时请写：**干了什么 / 关键设计（为什么这么做）/ 踩到的坑编号 / 源码在哪**。
坑编号能跳回「坑清单」；如果出现重复的坑，说明 Checklist 漏了一条，回填它。
