# DSH 补丁记录：隐藏内置"创作型模式"预设

> 本补丁修改的是 **DSH 本体 UI 包**，不属于 dsh-agent-maker 插件。
> **风险**：DSH 版本更新会覆盖 `client.js`，届时这 3 个模式会重新出现在选择器/菜单/设置面板。更新后按下方步骤 30 秒重打即可。

## 目标文件（绝对路径）
```
<repo-root>\build\dist\app\node_modules\@deepseek-ai\dsh-client-ui-agent-preset\lib\client.js
```
备份：`client.js.bak`（同目录，打补丁前生成）

## 目的
把 PTC / 极简 / 创造(cordis) 这 3 个内置"创作型模式"从所有预设选择器里隐藏，
仅保留 `standard`（基线通用体）+ 用户智能体（cfo/cmo/cto/coo/agent-orchestrator）。
**磁盘预设目录不删**，所以 `agentPresets.copy` 与编排师（自身有独立 agent.cordis.yml）等底层能力不受影响。

## 改动（共 3 处）
1. 在 `function presetOptions(presets) {`（约 line 480）**上方**插入常量：
   ```js
   const HIDDEN_PRESET_IDS = ["ptc", "minimal", "cordis"];
   ```
2. `presetOptions` 内部过滤（控制 开新会话模式菜单 / seat chip / 会话头 label）：
   ```js
   // 改前
   return presets.filter((preset) => preset.broken === void 0).map((preset) => ({
   // 改后
   return presets.filter((preset) => preset.broken === void 0 && !HIDDEN_PRESET_IDS.includes(preset.id)).map((preset) => ({
   ```
3. 设置面板 `rows`（控制 Agent presets 管理面板列表）：
   ```js
   // 改前
   rows: presets.map((preset) => ({ ...preset })),
   // 改后
   rows: presets.filter((preset) => !HIDDEN_PRESET_IDS.includes(preset.id)).map((preset) => ({ ...preset })),
   ```

## 重打步骤（DSH 更新后）
1. 确认 `client.js` 已被覆盖（3 处 `HIDDEN_PRESET_IDS` 消失）。
2. 用项目根目录 `_patch_preset_selector.py` 重新执行：
   ```
   <dsh-home>\binaries\python\versions\3.13.12\python.exe _patch_preset_selector.py
   ```
   脚本会断言每处锚点出现次数=1，写回后打印 `OK: 3 edits applied`。
3. 语法校验：`node --check client.js` 应输出 `SYNTAX_OK`。
4. 重启 D-STATION 验证：开新会话菜单 / 设置面板只显示 Standard + 用户智能体。

## 设计要点（为何这样改）
- DSH 的"模式"就是 preset；`dsh-client-ui-agent-preset` 用一次 `ctx.remote.agentPresets.list()` 拉全部 preset，按 `trust` 分 system(Built-in)/user(Custom) 渲染。**无 exclude 字段**，故只能改 UI 包过滤行。
- 渲染模式名的 UI 仅此一个包（grep `presetPtcName/presetMinimalName/presetCordisName` 全命中本文件），改这里即全局生效。
- 选方案 A（只隐藏不删文件）而非删预设目录：删 `cordis` 会让编排师依赖的"复制 cordis 模板"路径断裂。
