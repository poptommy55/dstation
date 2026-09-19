/**
 * dsh-skill-panel — server half（空壳）
 *
 * 本插件的全部能力都在浏览器侧（client.js）：列技能、编辑 SKILL.md、一键发起。
 * · 技能目录读写走外壳 preload 桥 window.__DSTATION_SKILLS__（主进程 IPC），
 *   不需要在本半注册任何 RPC；
 * · 技能清单走 DSH 原生 remote.skills.list —— 也不归本半管。
 * 故这里只声明 cordis 插件，确保宿主加载 client 半时不报错。
 *
 * 格式对齐 dsh-agent-maker/index.js。
 */
export const name = 'dsh-skill-panel';
export const inject = [];

export function apply() {
  // 空壳：无宿主侧逻辑。
}

export default { name, inject, apply };
