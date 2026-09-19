/**
 * dsh-knowledge-base — server half (MVP 空壳)
 *
 * 浏览器端真实逻辑在 client.js，通过 package.json exports["./client"] 加载。
 * 此文件仅用于宿主在 Node 侧解析插件入口时不报错。
 */
export const name = 'dsh-knowledge-base';
export const inject = [];

export function apply() {
  // MVP：浏览器端插件负责全部 UI 与文件 I/O；服务端空壳仅用于 cordis 注册。
}

export default { name, inject, apply };
