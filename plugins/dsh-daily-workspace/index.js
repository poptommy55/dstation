/**
 * dsh-daily-workspace —— 让「日常使用」分区以**相对位置**存在。
 *
 * 为什么需要它：DSH 里其他几个分区（超级智能体、智能体编排、知识库、技能使用）
 * 都是插件用「DSH_HOME + 固定目录名」算出来并**幂等创建**的，
 * 所以它们与部署目录绑定、删了会自动重建。
 * 而「日常使用」原先是手动添加的绝对路径（D:\DSH\DH2\实验区），
 * 一旦换机器或换部署就失效。本插件把前者那套做法补齐。
 *
 * 依据（读源码确认，不是猜）：
 *   · `ctx.workspaceRegistry.create(path, title)` 的契约（dsh-workspace）：
 *       - "Create or reuse a workspace for an **existing directory**"
 *       - 路径不存在会以原始错误 reject ⇒ **必须先建目录**
 *       - "Repeated calls for the same canonical path return the existing
 *          entity without changing its title" ⇒ **天然幂等**，每轮启动调用安全
 *   · 参照实现：dsh-skill-panel 的 ensureSkillWorkspace（`home + sep + 'skill-sessions'`）
 *     与 dsh-agent-maker 的 ensureWorkspace（'super-agents' / 'agent-orchestration'）
 *
 * ⚠️ 本插件**不改任何 DSH 文件**，随时删掉即回退（分区登记会保留，属正常数据）。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const name = 'dsh-daily-workspace';
// 只注入真正必需的：分区注册表。
export const inject = ['workspaceRegistry'];

/** 落盘目录名（与 DSH_HOME 相对），标题是给用户看的。 */
const DIRNAME = 'daily-use';
const TITLE = '日常使用';

/** 解析 DSH home；与插件里其他包保持同一套兜底。 */
function dshHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
}

export function apply(ctx) {
  const log = (level, message) => {
    try {
      const logger = ctx.logger;
      if (!logger) return;
      const fn = typeof logger[level] === 'function' ? logger[level] : logger.info;
      if (typeof fn === 'function') fn.call(logger, message);
    } catch { /* 日志失败不影响功能 */ }
  };

  const dir = path.join(dshHome(), DIRNAME);

  // 第一步：目录必须先存在，否则 create() 会以原始错误 reject。
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    log('warn', `[${name}] 无法创建目录 ${dir}：${error?.message ?? error}`);
    return;
  }

  // 第二步：幂等注册。已存在则原样返回，不会改标题、不会动已有会话归属。
  let registry = null;
  try {
    registry = ctx.workspaceRegistry;
  } catch (error) {
    log('warn', `[${name}] 取不到 workspaceRegistry：${error?.message ?? error}`);
    return;
  }
  if (!registry || typeof registry.create !== 'function') {
    log('warn', `[${name}] workspaceRegistry.create 不可用，跳过分区注册`);
    return;
  }

  Promise.resolve()
    .then(() => registry.create(dir, TITLE))
    .then((workspace) => {
      log('info', `[${name}] 分区「${workspace?.title ?? TITLE}」就绪 → ${workspace?.path ?? dir}`);
    })
    .catch((error) => {
      log('warn', `[${name}] 注册分区失败：${error?.message ?? error}`);
    });
}

export default { name, inject, apply };
