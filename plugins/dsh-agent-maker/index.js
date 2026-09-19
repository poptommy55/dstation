/**
 * dsh-agent-maker — server half
 *
 * 「一键打包我的智能体」的宿主侧实现。
 *
 * 三条路由（每个 path 只注册一次，读/写靠 req.method 分派 —— 见 dsh-plugin-dev 坑 #37：
 * 路由的冲突键是 (kind, path)，不含 method，同一 path 注册两次会抛异常并带崩插件树）：
 *
 *   GET  /dsh-agent-maker/health   构建号、DSH_HOME、预设根、数量
 *   GET  /dsh-agent-maker/agents   宿主侧权威的智能体清单（含文件数/体积/broken 原因）
 *   POST /dsh-agent-maker/export   { ids?: string[] } -> 智能体安装包 zip 字节
 *
 * 安全立场：
 *   · 本地自定义路由**没有 cookie 鉴权**，所以 export 必须过同源回环闸门；
 *   · ids 来自客户端 → 会拼进文件系统路径，必须过白名单正则（`..` / 绝对路径 / 盘符全挡掉）；
 *   · 只读 `.agent-presets`，不改任何东西。
 *
 * ⚠️ apply() 里任何一行抛异常 = 插件树挂掉 = 被看门狗禁用（坑 #29），
 *    所以入口整体包 try/catch，诊断日志也包 safeLog。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  BUNDLE_SCHEMA,
  buildAgentBundle,
  defaultPackableIds,
  findDshHome,
  listPresets,
  presetsRoot
} from './agent-pack.js';

export const name = 'agent-maker';
export const inject = ['webServer'];

const BUILD = 'v1-20260919-agent-pack';
const PREFIX = '/dsh-agent-maker';

/* ───────────────────────────────────────────── 小工具 ── */

function safeLog(ctx, level, msg) {
  try {
    const logger = ctx && ctx.logger;
    if (logger && typeof logger[level] === 'function') logger[level]('[agent-maker] ' + msg);
    else if (logger && typeof logger.info === 'function') logger.info('[agent-maker] ' + msg);
  } catch {
    /* 打日志本身绝不该把插件打死 */
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-dsh-agent-maker-build': BUILD
  });
  res.end(text);
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const err = new Error('payload too large');
      err.code = 'TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * 变更类请求必须是本机同源直连。
 * 语义照抄 dshmarket / dsh-dstation-market 的 trustedMutation（那边已实测可用）。
 */
function trustedMutation(req) {
  const address = req.socket && req.socket.remoteAddress;
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false;
  if (req.headers.forwarded !== undefined) return false;
  if (req.headers['x-forwarded-for'] !== undefined) return false;
  if (req.headers['x-real-ip'] !== undefined) return false;
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin === undefined || host === undefined) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host;
  } catch {
    return false;
  }
}

/** `<DSH_HOME>\skills` 下的技能名 —— 用来判断智能体正文引用了哪个全局技能 */
function knownSkillNames(dshHome) {
  if (!dshHome) return [];
  try {
    return readdirSync(join(dshHome, 'skills'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** 当前环境快照（三个路由共用，避免各写一份） */
function snapshot() {
  const dshHome = findDshHome();
  const root = presetsRoot(dshHome);
  const presets = listPresets(root);
  return {
    dshHome,
    root,
    rootExists: !!(root && existsSync(root)),
    presets,
    packable: defaultPackableIds(presets)
  };
}

/* ───────────────────────────────────────────── 插件主体 ── */

export function apply(ctx) {
  const disposers = [];
  try {
    const route = (path, handler) => ctx.webServer.register({ kind: 'exact', path, handler });

    /* ── GET /health ─────────────────────────────────────────── */
    disposers.push(
      route(`${PREFIX}/health`, (req, res) => {
        try {
          const snap = snapshot();
          sendJson(res, 200, {
            ok: true,
            build: BUILD,
            plugin: name,
            dshHome: snap.dshHome,
            presetsRoot: snap.root,
            presetsRootExists: snap.rootExists,
            presetCount: snap.presets.length,
            packableCount: snap.packable.length,
            broken: snap.presets.filter((p) => p.broken).map((p) => ({ id: p.id, broken: p.broken })),
            hasSkillIndex: knownSkillNames(snap.dshHome).length > 0
          });
        } catch (err) {
          sendJson(res, 500, { ok: false, build: BUILD, error: String((err && err.message) || err) });
        }
      })
    );

    /* ── GET /agents ── 宿主侧权威清单（也是排障现场） ────────── */
    disposers.push(
      route(`${PREFIX}/agents`, (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'GET only' });
          return;
        }
        try {
          const snap = snapshot();
          sendJson(res, 200, {
            ok: true,
            build: BUILD,
            dshHome: snap.dshHome,
            presetsRoot: snap.root,
            presetsRootExists: snap.rootExists,
            packable: snap.packable,
            schema: BUNDLE_SCHEMA,
            agents: snap.presets.map((p) => ({
              id: p.id,
              name: p.name,
              description: p.description,
              order: p.order,
              infra: p.infra,
              broken: p.broken,
              fileCount: p.fileCount,
              bytes: p.bytes,
              packable: !p.infra && !p.broken
            }))
          });
        } catch (err) {
          sendJson(res, 500, { ok: false, build: BUILD, error: String((err && err.message) || err) });
        }
      })
    );

    /* ── POST /export ── 出安装包 ─────────────────────────────── */
    disposers.push(
      route(`${PREFIX}/export`, async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'POST only' });
          return;
        }
        /* 这条是只读的（不落地、不改状态），本来不必这么严；
           但它会把**该机器上的智能体内容**吐给调用方，且能触发大量读盘，
           所以同样只允许本机同源窗口调用。 */
        if (!trustedMutation(req)) {
          sendJson(res, 403, { ok: false, error: 'same-origin loopback request required' });
          return;
        }

        let parsed = {};
        try {
          const raw = await readBody(req, 32768);
          if (raw.length) parsed = JSON.parse(raw.toString('utf8')) || {};
        } catch (err) {
          if (err && err.code === 'TOO_LARGE') {
            sendJson(res, 413, { ok: false, error: 'body too large' });
            return;
          }
          sendJson(res, 400, { ok: false, error: 'body must be JSON' });
          return;
        }

        try {
          const snap = snapshot();
          const ids = Array.isArray(parsed.ids) && parsed.ids.length ? parsed.ids : snap.packable;

          const r = buildAgentBundle(snap.root, ids, {
            dshHome: snap.dshHome,
            knownSkillNames: knownSkillNames(snap.dshHome)
          });

          /* HTTP 响应头只允许 latin-1。包名是中文，直接写进 filename= 会让 Node 抛
               Invalid character in header content ["content-disposition"]
             并回 500（见 dsh-plugin-dev 坑 #58）。正确做法是 RFC 5987：
               filename=  给不认 filename* 的老客户端的 ASCII 兜底
               filename*= 百分号编码的 UTF-8，现代浏览器都用这个
             ASCII 兜底用**已被白名单校验为 ASCII** 的 id 拼，不要去截中文。 */
          const asciiFallback = r.summary.agentCount === 1
            ? `${r.summary.agents[0].id}-agent-package.zip`
            : `${r.summary.agentCount}-agents-package.zip`;

          res.writeHead(200, {
            'content-type': 'application/zip',
            'content-length': r.data.length,
            'content-disposition':
              `attachment; filename="${asciiFallback}"; ` +
              `filename*=UTF-8''${encodeURIComponent(r.fileName)}`,
            'cache-control': 'no-store',
            'x-dsh-agent-maker-build': BUILD
          });
          res.end(r.data);
        } catch (err) {
          const msg = String((err && err.message) || err);
          /* 输入不合法 -> 400；其余按 500。这样界面能区分"你选错了"和"我坏了"。 */
          const status = /不合法|找不到智能体|没有可打包|缺少 agent\.cordis|是空的|没有任何 name/.test(msg)
            ? 400
            : 500;
          sendJson(res, status, { ok: false, build: BUILD, error: msg });
        }
      })
    );

    ctx.effect(
      () => () => {
        for (const d of disposers) {
          try {
            d();
          } catch {
            /* 卸载异常不该影响别的插件 */
          }
        }
      },
      'dsh-agent-maker: routes'
    );

    safeLog(ctx, 'info', `路由已注册于 ${PREFIX}（${BUILD}）`);
  } catch (err) {
    /* 宁可只有打包功能不可用，也不能带崩整棵插件树 */
    safeLog(ctx, 'error', '注册路由失败，打包功能不可用：' + String((err && err.message) || err));
  }
}

export default { name, inject, apply };

/** 仅供离线测试使用 */
export const __internals = {
  BUILD,
  PREFIX,
  trustedMutation,
  knownSkillNames,
  snapshot,
  sendJson,
  readBody
};
