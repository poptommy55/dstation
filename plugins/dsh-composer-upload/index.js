/**
 * dsh-composer-upload — server half（空壳）
 *
 * 本插件的全部逻辑都在浏览器端：client.js 通过 package.json 的
 * exports["./client"] 被 web 客户端加载。此文件仅用于宿主在 Node 侧
 * 解析插件入口时不报错。
 */
export const name = 'dsh-composer-upload';
export const inject = [];

export function apply() {
  // 浏览器端插件负责全部 UI；服务端空壳仅用于 cordis 注册。
}

export default { name, inject, apply };
