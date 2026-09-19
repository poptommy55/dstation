/**
 * dsh-file-opener —— 宿主半。
 *
 * 干什么：让对话消息里出现的**本地文件路径**可点击打开。
 *  - 点文件名 → 用系统默认程序打开（.docx/.xlsx 走 WPS/Office，.html 走浏览器）
 *  - 路径旁的文件夹图标 → 在文件夹中显示（`explorer /select,` 打开父目录并选中）
 *
 * 为什么需要它：官方只有「产物事件」会变成可点提及（dsh-client-ui-deliverables），
 * 而模型在正文/代码块里**手写**的路径没有任何人处理 —— 用户看到的就是一串死文字。
 *
 * 宿主半的职责：
 *  - /check：只回答「存在吗 / 文件还是目录 / 多大」，**不传任何文件字节**；
 *  - /reveal：唯一会起子进程的地方（explorer.exe /select,）。**stdio 必须是 ignore**
 *    —— 沙箱下用管道会 EPERM（技能坑 #10），而且 explorer 正常退出码也是 1，
 *    不能拿退出码当失败判据。
 *  - 打开文件本身仍走官方 RPC `session.openWorkspacePath`（客户端直接调），宿主半不参与。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectPath, resolveRoots } from './path-guard.js';
import { revealInExplorer, toNativePath } from './reveal.js';

export const name = 'dsh-file-opener';

/** 只依赖 webServer；其余能力一律用 ctx.get() 探测并降级（坑 #29）。 */
export const inject = ['webServer'];

const PREFIX = '/dsh-file-opener';

/** 构建号：**改代码必须同时 +1**，否则"用户跑的是哪一版"说不清。 */
export const BUILD = 'v3-20260919-select-args';

/** 允许根缓存：workspace.json 读盘代价不低。 */
const WORKSPACE_CACHE_MS = 30_000;
let workspaceCache = { at: 0, roots: /** @type {string[]} */ ([]) };

/** 单次 /check 最多校验多少个路径。 */
const MAX_CHECK_PATHS = 40;

/**
 * 读 DSH 的**已登记工作区**（两份 workspace.json）。
 *
 * 为什么必须读两份：会话 home 与用户级 home 各有一份，用户在不同 home 下
 * 登记过的工作区可能只出现在其中一份。漏掉一份，重启后旧会话目录里的文件
 * 就会掉出白名单，历史消息里的路径集体失效（技能坑 #16 的原始教训）。
 * @returns {string[]}
 */
function registeredWorkspaces() {
  const now = Date.now();
  if (now - workspaceCache.at < WORKSPACE_CACHE_MS) return workspaceCache.roots;

  const roots = [];
  const candidates = [
    process.env.DSH_HOME ? join(process.env.DSH_HOME, 'storages', 'workspace.json') : null,
    process.env.USERPROFILE ? join(process.env.USERPROFILE, '.dsh', 'storages', 'workspace.json') : null
  ].filter((p) => p !== null);

  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      const table = parsed?.tables?.workspaces;
      if (table === null || typeof table !== 'object') continue;
      for (const record of Object.values(table)) {
        const p = record?.path;
        if (typeof p === 'string' && p.trim() !== '') roots.push(p.trim());
      }
    } catch {
      // 单份读失败不影响另一份
    }
  }
  workspaceCache = { at: now, roots };
  return roots;
}

/**
 * 收集允许根（四个来源，与 dsh-media-preview 对齐）。
 * @param {any} ctx
 * @returns {string[]}
 */
function candidateRoots(ctx) {
  const roots = [];
  for (const p of registeredWorkspaces()) roots.push(p);

  const policy = safeGet(ctx, 'sandboxPolicy');
  if (policy !== undefined && typeof policy.workspaceRoot === 'string') {
    roots.push(policy.workspaceRoot);
  }

  const sessions = safeGet(ctx, 'sessions');
  if (sessions !== undefined && typeof sessions.list === 'function') {
    try {
      for (const session of sessions.list()) {
        const cwd = session?.header?.cwd;
        if (typeof cwd === 'string' && cwd.length > 0) roots.push(cwd);
      }
    } catch {
      // sessions 服务存在但 list() 抛错：不影响其它来源
    }
  }

  const extra = String(process.env.DSH_FILE_OPENER_ROOTS ?? '');
  if (extra.trim() !== '') {
    for (const part of extra.split(process.platform === 'win32' ? ';' : ':')) {
      if (part.trim() !== '') roots.push(part.trim());
    }
  }
  return roots;
}

/**
 * ctx 是 Proxy，访问未注入的属性会抛（坑 #29）。所有探测都包起来。
 * @param {any} ctx
 * @param {string} key
 * @returns {any}
 */
function safeGet(ctx, key) {
  try {
    return ctx.get(key);
  } catch {
    return undefined;
  }
}

/**
 * 日志同样可能抛，绝不能让"打日志"把插件打死（坑 #29）。
 * @param {any} ctx
 * @param {'info'|'warn'} level
 * @param {string} message
 */
function safeLog(ctx, level, message) {
  try {
    const logger = ctx.logger;
    if (logger && typeof logger[level] === 'function') logger[level](`[dsh-file-opener] ${message}`);
  } catch {
    /* 日志失败是允许的 */
  }
}

/**
 * 写 JSON。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text)
  });
  res.end(text);
}

/**
 * 读请求体（上限 1MB）。
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string>}
 */
async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 1_048_576) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 解析 JSON 请求体。
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<any>}
 */
async function readJson(req) {
  const raw = await readBody(req);
  if (raw.trim() === '') return {};
  return JSON.parse(raw);
}

/** 客户端上报按来源分槽（坑 #39：共用一个槽位会互相覆盖）。 */
const reports = { client: null };

/**
 * 转义源码里的 `</script`（坑 #9）。
 *
 * client.js 里任何字符串只要含 `</script`，把它注进内联 `<script>` 就会**提前闭合** HTML，
 * 自检页只渲染到一半就崩。导出成独立函数是为了能被单测直接钉住 ——
 * 只断言"页面里出现过 `<\/script`"是空谈：源码里没有那种字符串时，断言必然失败。
 * @param {string} source
 * @returns {string}
 */
export function escapeScriptClose(source) {
  // 保留原始大小写：`</SCRIPT` 也要变成 `<\/SCRIPT`，不能一律改写成小写
  return String(source).replace(/<\/script/gi, (match) => `<\\/${match.slice(2)}`);
}

/**
 * 组装自检页：上半页是宿主真读盘的结果，下半页注入**真实的 client.js**。
 * @param {any} ctx
 * @returns {string}
 */
function renderSelftest(ctx) {
  let clientSource = '';
  let clientError = null;
  try {
    // 坑 #44：file:///C:/… 必须过 fileURLToPath，不能手工剥前缀
    const clientPath = fileURLToPath(new URL('./client.js', import.meta.url));
    clientSource = readFileSync(clientPath, 'utf8');
  } catch (error) {
    clientError = error instanceof Error ? error.message : String(error);
  }

  const roots = resolveRoots(candidateRoots(ctx));
  const probes = [];
  for (const root of roots.slice(0, 6)) {
    for (const candidate of [root, join(root, 'README.md'), join(root, '__definitely_missing__')]) {
      const result = inspectPath(candidate, roots);
      probes.push({ asked: candidate, ...result });
    }
  }

  // 坑 #9：client.js 里任何 `</script` 字符串都会提前闭合注入的脚本
  const safeSource = escapeScriptClose(clientSource);

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>dsh-file-opener 自检</title>
<style>
 body{font:14px/1.6 system-ui,Segoe UI,sans-serif;margin:24px;background:#16181d;color:#e6e6e6}
 h1{font-size:18px} h2{font-size:15px;margin-top:28px;border-top:1px solid #333;padding-top:14px}
 table{border-collapse:collapse;width:100%;margin-top:8px}
 th,td{border:1px solid #333;padding:4px 8px;text-align:left;font-size:12px}
 th{background:#22252c} code{background:#22252c;padding:1px 4px;border-radius:3px}
 .ok{color:#5ddc7a}.bad{color:#ff7a7a}.muted{color:#8b93a1}
 .fake-chat{border:1px solid #333;border-radius:8px;padding:12px;margin-top:8px;background:#1b1e24}
 pre{background:#0f1116;border:1px solid #2a2e37;border-radius:6px;padding:8px;overflow:auto}
</style></head><body>
<h1>dsh-file-opener 自检 <code>${BUILD}</code></h1>
<p class="muted">上半页：宿主真读盘的结果。下半页：注入<b>真实的 client.js</b>，对合成 DOM 现场出效果。</p>

<h2>① 宿主允许根（realpath 之后）</h2>
<table><tr><th>#</th><th>root</th></tr>
${roots.map((r, i) => `<tr><td>${i + 1}</td><td><code>${escapeHtml(r)}</code></td></tr>`).join('') || '<tr><td colspan="2" class="bad">没有任何允许根</td></tr>'}
</table>

<h2>② /check 真读盘结果（含一个必然不存在的对照）</h2>
<table><tr><th>asked</th><th>ok</th><th>kind</th><th>size</th><th>原因</th></tr>
${probes.map((p) => `<tr><td><code>${escapeHtml(p.asked)}</code></td>
<td class="${p.ok ? 'ok' : 'bad'}">${p.ok}</td><td>${p.ok ? p.kind : '-'}</td>
<td>${p.ok ? p.size : '-'}</td><td>${escapeHtml(p.ok ? '' : p.message)}</td></tr>`).join('')}
</table>

<h2>③ 客户端模块（真实源码注入）</h2>
<p>client.js 读取：<span class="${clientError === null ? 'ok' : 'bad'}">${clientError === null ? '成功，' + clientSource.length + ' 字符' : '失败：' + escapeHtml(String(clientError))}</span></p>
<div class="fake-chat" id="fake-chat">
  <p>已经输出了，文件在磁盘上：</p>
  <pre><code>__SAMPLE_PATH__</code></pre>
</div>
<h2>④ 现场读数</h2>
<pre id="probe-out">等待客户端模块…</pre>

<script>window.__ModuleLoader__ = { load: function (mod) { window.__DSFO_MODULE__ = mod; } };</script>
<script>${safeSource}</script>
<script>
(function () {
  var out = document.getElementById('probe-out');
  function show(text) { out.textContent = text; }
  var mod = window.__DSFO_MODULE__;
  if (!mod || typeof mod.factory !== 'function') { show('客户端模块没有注册到 __ModuleLoader__'); return; }
  var sample = ${JSON.stringify(probes.find((p) => p.ok && p.kind === 'file')?.path ?? '')};
  document.getElementById('fake-chat').innerHTML =
    document.getElementById('fake-chat').innerHTML.replace('__SAMPLE_PATH__', sample);
  var opened = [];
  var exportsObj = mod.factory(function (id) {
    if (id === 'react') return { createElement: function () { return { __react: true }; } };
    throw new Error('unexpected require: ' + id);
  });
  try {
    exportsObj.apply({
      provide: function () {},
      get: function () { return undefined; },
      logger: { info: function () {}, warn: function () {} },
      effect: function () {},
      remote: { session: { openWorkspacePath: function (r) { opened.push(r.path); return Promise.resolve({ ok: true }); } } }
    });
  } catch (error) { show('apply() 抛异常：' + error.message); return; }
  show('模块已加载：' + exportsObj.name + ' ｜ inject=' + JSON.stringify(exportsObj.inject) + '\\n'
    + '（自检页只做冒烟；真实效果请看对话里的代码块）');
  window.__DSFO_SELFTEST__ = { opened: opened };
})();
</script>
</body></html>`;
}

/**
 * HTML 转义。
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
}

/**
 * 宿主半入口。
 *
 * @param {any} ctx
 * @param {{spawn?: Function}} [pluginConfig] 第二参数取配置（**不要**把 config 塞进
 *   inject —— 那会让插件永远等不到加载，技能坑 #29）。
 *   这里唯一的用途是给单测注入一个假的 spawn，避免测试真的弹出资源管理器窗口。
 */
export function apply(ctx, pluginConfig) {
  const disposers = [];
  const spawnImpl = pluginConfig && typeof pluginConfig.spawn === 'function'
    ? pluginConfig.spawn
    : undefined;

  /** 注册一条路由并登记卸载（坑 #37：一个 path 只能注册一次，方法在 handler 内分派）。 */
  const route = (path, handler) => {
    const dispose = ctx.webServer.register({ kind: 'exact', path, handler });
    if (typeof dispose === 'function') disposers.push(dispose);
  };

  route(`${PREFIX}/health`, (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
    const roots = resolveRoots(candidateRoots(ctx));
    sendJson(res, 200, {
      ok: true,
      plugin: name,
      build: BUILD,
      rootCount: roots.length,
      roots,
      workspaceRegistryRoots: registeredWorkspaces().length
    });
  });

  route(`${PREFIX}/status`, (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
    sendJson(res, 200, {
      ok: true,
      plugin: name,
      build: BUILD,
      roots: resolveRoots(candidateRoots(ctx)),
      reports,
      env: { DSH_FILE_OPENER_ROOTS: process.env.DSH_FILE_OPENER_ROOTS ?? null }
    });
  });

  route(`${PREFIX}/check`, async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
    let body;
    try {
      body = await readJson(req);
    } catch {
      return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
    }
    const asked = Array.isArray(body?.paths) ? body.paths : [];
    if (asked.length === 0) return sendJson(res, 400, { ok: false, error: '缺少 paths 数组' });
    if (asked.length > MAX_CHECK_PATHS) {
      return sendJson(res, 400, { ok: false, error: `一次最多校验 ${MAX_CHECK_PATHS} 个路径` });
    }
    const roots = resolveRoots(candidateRoots(ctx));
    const items = asked.map((p) => {
      const result = inspectPath(p, roots);
      return { asked: String(p ?? ''), ...result };
    });
    sendJson(res, 200, { ok: true, build: BUILD, roots: roots.length, items });
  });

  route(`${PREFIX}/report`, async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
    let body;
    try {
      body = await readJson(req);
    } catch {
      return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
    }
    const source = body?.source === 'probe' ? 'probe' : 'client';
    reports[source] = { at: new Date().toISOString(), source, ...body };
    sendJson(res, 200, { ok: true });
  });

  route(`${PREFIX}/reveal`, async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
    if (process.platform !== 'win32') {
      return sendJson(res, 501, {
        ok: false,
        code: 'unsupported_platform',
        message: `本路由只在 Windows 上实现（当前 ${process.platform}）`
      });
    }
    let body;
    try {
      body = await readJson(req);
    } catch {
      return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
    }
    const roots = resolveRoots(candidateRoots(ctx));
    const result = inspectPath(body?.path, roots);
    if (result.ok !== true) {
      return sendJson(res, result.status || 400, {
        ok: false,
        code: result.code,
        message: result.message
      });
    }
    const native = toNativePath(result.path);
    try {
      revealInExplorer(native, result.kind, spawnImpl === undefined ? {} : { spawn: spawnImpl });
    } catch (error) {
      return sendJson(res, 500, {
        ok: false,
        code: 'spawn_failed',
        message: String((error && error.message) || error)
      });
    }
    sendJson(res, 200, { ok: true, build: BUILD, revealed: native, kind: result.kind });
  });

  route(`${PREFIX}/selftest`, (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
    const html = renderSelftest(ctx);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store'
    });
    res.end(html);
  });

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* 卸载失败不阻断 */
      }
    }
  }, 'dsh-file-opener.routes');

  safeLog(ctx, 'info', `已注册 5 条路由，build=${BUILD}`);
}

export default { name, inject, apply };
