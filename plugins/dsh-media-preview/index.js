/**
 * dsh-media-preview —— 宿主半（Node 侧）
 *
 * 职责只有一件事：**把会话工作区里的媒体文件安全地喂给浏览器**。
 * 预览与下载的全部 UI 都在浏览器半（client.js），这里只提供两条路由：
 *
 *   GET  /dsh-media/file?path=<绝对路径>[&dl=1][&name=<下载名>]
 *        → 流式返回媒体字节。支持单区间 Range（视频拖动/音频 seek）、ETag、
 *          并且总是带 Accept-Ranges。dl=1 时附 Content-Disposition: attachment，
 *          浏览器据此走「另存为」。
 *   POST /dsh-media/allow   { paths: string[] }
 *        → 批量白名单登记：告诉浏览器半「这些路径合法、这类媒体、多大、什么 URL」。
 *          浏览器半不自己拼 URL 也不自己猜 MIME，一切以宿主判定为准。
 *   GET  /dsh-media/health
 *        → 排障用：返回当前允许根。文件被 403 时先看这里。
 *
 * 安全边界在 lib/path-guard.js 里，务必连注释一起读。要点：这条路由不以 /api
 * 开头，因此没有 dsh-client-connection 的 cookie 鉴权，它必须靠自己只服务
 * 「允许根之内的媒体文件」。
 *
 * 为什么需要它：DSH 的附件通道架构上只收光栅图片，且浏览器侧没有任何读本地
 * 文件的 API；模型生成的成品（png/mp4/mp3…）要能在对话里直接看、直接下载，
 * 就必须由宿主开一条只读的媒体通道。
 */

import { createReadStream, statSync, openSync, readSync, closeSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mediaTypeOf, extensionOf, MEDIA_TYPES as MEDIA_TYPE_TABLE } from './mime.js';
import { PathGuard } from './path-guard.js';
import { parseRange, contentRange } from './http-range.js';

/** Cordis 函数插件名。 */
export const name = 'dsh-media-preview';

/**
 * 可选服务：tools（给模型一个 media_preview 工具）。缺了只是模型不知道这条路，
 * 浏览器端对正文里出现的媒体路径照样会出卡 —— 因此不列为必需。
 */
export const inject = ['webServer'];

/** 工具名（模型可见）。 */
const TOOL_NAME = 'media_preview';

const TOOL_DESCRIPTION =
  'Render local images, videos, or audio as inline preview cards in the conversation so the human can watch them and download them with one click. '
  + 'Call this once after you generate or save any media file (png/jpg/webp/gif/svg, mp4/webm/mov/mkv, mp3/wav/m4a/flac/ogg). '
  + 'Pass ABSOLUTE file paths. The file must live inside the current session workspace (or an operator-configured media root); '
  + 'anything else is rejected. The tool returns the confirmed paths — after calling it, also mention those paths in your reply text, '
  + 'because the preview cards are attached to the message that names them.';

/** 路由前缀。故意不挂在 /api 下（那里是 RPC + cookie 鉴权的领地）。 */
const ROUTE_PREFIX = '/dsh-media';

/**
 * health / allow 响应里回显扩展名 → MIME 的表，便于排障（"为什么 .mov 能预览"）。
 * 直接从唯一事实源 mime.js 派生，不手写第二份列表。
 */
const MEDIA_TYPES_FOR_HEALTH = (() => {
  const out = {};
  for (const ext of Object.keys(MEDIA_TYPE_TABLE)) out[ext] = MEDIA_TYPE_TABLE[ext].type;
  return out;
})();

/** 工作区注册表读取结果的缓存（根是低频事实，没必要每次请求都读盘）。 */
let workspaceCache = { at: 0, roots: [] };
const WORKSPACE_CACHE_MS = 30_000;

/**
 * 读 DSH 的**已登记工作区**列表（可能有两份：会话 home 与用户级 home）。
 *
 * 为什么必须加这一条来源：原先只取「部署 workspaceRoot + 当前 live 会话的 cwd」，
 * 于是**重启之后**旧会话（不再 live）目录里的文件全部落到白名单外 ——
 * 历史消息里原本正常的卡片会集体变成「拒绝访问：文件不在任何允许的会话工作区之内」。
 * 而"用户登记过的工作区"本就该长期可读，不该随会话生死而失效（2026-09-13 实测踩到）。
 *
 * 两份注册表都要读：隔离的 DSH home 里那份，和用户级 `~/.dsh` 里那份
 * （用户在不同 home 下登记过的工作区可能只在其中一份）。
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
 * 收集允许根。
 *
 * 四个来源，全部 realpath 之后取并集：
 *   1. **已登记的工作区**（两份 workspace.json）—— 与「用户登记过就能长期访问」的预期一致，
 *      也是重启后旧会话产物仍可预览的关键。
 *   2. sandboxPolicy.workspaceRoot —— 部署级的 workspace-write 边界。
 *   3. 每个 live session 的 header.cwd —— 会话级工作目录（滚动新增的工作区靠它立刻生效）。
 *   4. 环境变量 DSH_MEDIA_ROOTS（; 分隔）—— 逃生舱。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {string[]}
 */
function candidateRoots(ctx) {
  const roots = [];
  for (const p of registeredWorkspaces()) roots.push(p);
  const policy = ctx.get('sandboxPolicy');
  if (policy !== undefined && typeof policy.workspaceRoot === 'string') {
    roots.push(policy.workspaceRoot);
  }
  const sessions = ctx.get('sessions');
  if (sessions !== undefined && typeof sessions.list === 'function') {
    for (const session of sessions.list()) {
      const cwd = session?.header?.cwd;
      if (typeof cwd === 'string' && cwd.length > 0) roots.push(cwd);
    }
  }
  const extra = String(process.env.DSH_MEDIA_ROOTS ?? '');
  if (extra.trim() !== '') {
    for (const part of extra.split(process.platform === 'win32' ? ';' : ':')) {
      if (part.trim() !== '') roots.push(part.trim());
    }
  }
  return roots;
}

/**
 * 写一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'cache-control': 'no-store'
  });
  res.end(text);
}

/**
 * 读请求体（有上限，避免恶意大包）。
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<string|null>}
 */
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

/**
 * 只允许 RFC 5987 之外的 ASCII 下载名走 filename=，其余走 filename*=。
 * @param {string} rawName
 * @returns {string}
 */
function contentDisposition(rawName) {
  const safe = String(rawName ?? 'media').replace(/[\r\n"\\]/g, '_').slice(0, 160) || 'media';
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(safe);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * 流式发送媒体字节，处理 Range/ETag/HEAD。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {import('./path-guard.js').ResolveOk} resolved
 * @param {{ download: boolean, downloadName: string }} options
 */
function streamMedia(req, res, resolved, options) {
  const { path: filePath, size, mtimeMs, media } = resolved;
  const etag = `W/"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;

  const headers = {
    'content-type': media.type,
    'accept-ranges': 'bytes',
    etag,
    'cache-control': 'private, max-age=0, must-revalidate'
  };
  if (media.kind === 'image' && media.type === 'image/svg+xml') {
    // 用户直接把 SVG 当文档打开时不执行脚本、不加载外部资源。
    headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  }
  if (options.download) {
    headers['content-disposition'] = contentDisposition(options.downloadName || resolved.name);
  }

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  const range = parseRange(req.headers.range, size);
  if (range.status === 'unsatisfiable') {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` });
    res.end();
    return;
  }

  const start = range.status === 'ok' ? range.start : 0;
  const end = range.status === 'ok' ? range.end : Math.max(0, size - 1);
  const length = range.status === 'ok' ? range.length : size;

  const status = range.status === 'ok' ? 206 : 200;
  const outHeaders = {
    ...headers,
    'content-length': String(length)
  };
  if (range.status === 'ok') outHeaders['content-range'] = contentRange(start, end, size);

  if (req.method === 'HEAD') {
    res.writeHead(status, outHeaders);
    res.end();
    return;
  }

  if (readableEnded(req)) {
    res.writeHead(status, outHeaders);
    res.end();
    return;
  }

  res.writeHead(status, outHeaders);
  const stream = createReadStream(filePath, { start, end });
  stream.on('error', () => {
    if (!res.writableEnded) res.destroy();
  });
  req.on('close', () => stream.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

/**
 * HEAD 请求没有 body —— 直接用 statSync 的读数即可，不必开流。
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function readableEnded(req) {
  return req.method === 'HEAD' || req.method === 'OPTIONS';
}

/**
 * 从允许根里挑前 N 个媒体文件（自检页缺省样本）。
 *
 * 递归两层的理由：成品通常放在 <工作区>/<子目录>/ 里（例如「媒体预览示例/」），
 * 只扫一层会在真实工作区里永远挑不到东西 —— 自检页因此显示"没有样本"，
 * 反而让人误以为插件坏了。同时用目录数/条目数上限封顶，避免在巨目录里扫穿磁盘。
 * @param {PathGuard} guard
 * @param {number} count
 * @returns {string[]}
 */
function firstMediaFiles(guard, count) {
  const out = [];
  const MAX_DIRS = 300;
  const MAX_ENTRIES = 4000;
  let visited = 0;
  let seen = 0;

  const walk = (dir, depth) => {
    if (out.length >= count || visited >= MAX_DIRS || seen >= MAX_ENTRIES) return;
    visited += 1;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const subdirs = [];
    for (const entry of entries) {
      if (out.length >= count || seen >= MAX_ENTRIES) return;
      seen += 1;
      if (entry.name.startsWith('.') || entry.name.startsWith('$')) continue;
      const candidate = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 2) subdirs.push(candidate);
        continue;
      }
      if (!entry.isFile()) continue;
      if (mediaTypeOf(candidate) === null) continue;
      out.push(candidate);
    }
    for (const sub of subdirs) walk(sub, depth + 1);
  };

  for (const root of guard.roots()) {
    walk(root, 1);
    if (out.length >= count) break;
  }
  return out;
}

/**
 * 列出工作区里最近的媒体文件（供客户端「最近生成」面板用）。
 *
 * 与 firstMediaFiles 的区别：这个按**修改时间倒序**返回元数据，面向"我刚生成的东西在哪"，
 * 不是随便挑几个样本；并且限制扫描规模，避免在巨目录里扫穿磁盘。
 *
 * @param {PathGuard} guard
 * @param {number} limit
 * @returns {Array<{path:string,name:string,size:number,mtimeMs:number,kind:string,type:string}>}
 */
function listRecentMedia(guard, limit) {
  const MAX_DIRS = 400;
  const MAX_ENTRIES = 12000;
  let visited = 0;
  let seen = 0;
  const found = [];

  const walk = (dir, depth) => {
    if (visited >= MAX_DIRS || seen >= MAX_ENTRIES) return;
    visited += 1;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= MAX_DIRS || seen >= MAX_ENTRIES) return;
      seen += 1;
      // 跳过隐藏项与依赖目录：那里不会有"我们生成的成品"
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name.startsWith('$')) continue;
      const candidate = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 3) walk(candidate, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const media = mediaTypeOf(candidate);
      if (media === null) continue;
      let stat;
      try {
        stat = statSync(candidate);
      } catch {
        continue;
      }
      found.push({
        path: normalizeSlash(candidate),
        name: entry.name,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        kind: media.kind,
        type: media.type
      });
    }
  };

  for (const root of guard.roots()) walk(root, 1);

  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found.slice(0, limit);
}

/** 统一用正斜杠，免得客户端拼 URL 时踩转义坑。 */
function normalizeSlash(p) {
  return String(p).replace(/\\/g, '/');
}

/**
 * 生成自检页：上半页是宿主自检表格，下半页把真实 client.js 注入进来对真实路径出卡。
 * @param {{items:unknown[], roots:string[], version:string, electron:string}} input
 * @returns {string}
 */
function renderSelftestPage(input) {
  const here = fileURLToPath(new URL('.', import.meta.url));
  let clientSource = '';
  try {
    clientSource = readFileSync(join(here, 'client.js'), 'utf8');
  } catch (error) {
    clientSource = `window.__SELFTEST_CLIENT_ERROR__ = ${JSON.stringify(String(error))};`;
  }
  // 内嵌脚本里出现 </script 会提前闭合标签，必须转义
  const safeClient = clientSource.replace(/<\/script/gi, '<\\/script');

  const rows = input.items.map((item) => {
    if (item.ok !== true) {
      return `<tr class="bad"><td>${escapeHtml(String(item.asked))}</td><td>拒绝</td><td colspan="3">${escapeHtml(item.code)} — ${escapeHtml(item.message)}</td></tr>`;
    }
    return `<tr class="ok"><td>${escapeHtml(item.path)}</td><td>通过</td><td>${escapeHtml(item.kind)} / ${escapeHtml(item.type)}</td><td>${item.size} B</td><td><code>${escapeHtml(item.magic)}</code></td></tr>`;
  }).join('\n');

  const paths = input.items.filter((i) => i.ok === true).map((i) => i.path);
  const previewBlocks = input.items.filter((i) => i.ok === true).map((item) => `
    <p class="src">${escapeHtml(item.path)}</p>`).join('\n');

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>dsh-media-preview 自检</title>
<style>
 body{margin:0;padding:22px 26px 60px;background:#14161a;color:#e6e8ec;
   font:14px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
 h1{margin:0 0 4px;font-size:19px}
 h2{margin:26px 0 8px;font-size:15px;color:#aab2c0}
 .hint{color:#8b93a1;font-size:12.5px;margin:0 0 14px}
 table{border-collapse:collapse;width:100%;font-size:12.5px}
 th,td{border:1px solid #2a2f37;padding:7px 9px;text-align:left;vertical-align:top}
 th{background:#191c21;color:#aab2c0;font-weight:500}
 tr.ok td:first-child{border-left:3px solid #3ecf8e}
 tr.bad td:first-child{border-left:3px solid #e5484d}
 code{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;color:#8b93a1}
 .src{margin:10px 0 0;padding:7px 9px;border-radius:8px;background:#191c21;
   font-family:ui-monospace,Consolas,monospace;font-size:12px;word-break:break-all}
 .box{border:1px dashed #2c323b;border-radius:10px;padding:14px 18px;margin-top:8px}
 .verdict{margin-top:18px;padding:10px 12px;border-radius:10px;background:#191c21;
   border:1px solid #2a2f37;font:12.5px/1.7 ui-monospace,Consolas,monospace;white-space:pre-wrap}
 .ok-txt{color:#3ecf8e}.bad-txt{color:#e5484d}
</style></head>
<body>
<h1>dsh-media-preview · 自检</h1>
<p class="hint">这一页同时验两件事：上半页是<strong>宿主</strong>真的读文件的结果；
下半页把<strong>真实的 client.js</strong> 注入到这段真实路径上，用你正在用的这个浏览器出卡。
上半页绿、下半页有卡片 = 插件两侧都正常。任一侧红，就说明问题出在那一侧。</p>

<h2>① 宿主自检（真实读盘）</h2>
<p class="hint">允许根：${escapeHtml(input.roots.join('  |  ')) || '(无)'}　·　node ${escapeHtml(input.version)}</p>
<table><thead><tr><th>路径</th><th>判定</th><th>类型</th><th>大小</th><th>首 12 字节</th></tr></thead>
<tbody>
${rows || '<tr class="bad"><td colspan="5">没有可用的媒体样本 —— 允许根里没找到媒体文件，或用 ?files= 指定</td></tr>'}
</tbody></table>

<h2>② 浏览器端出卡（真实 client.js）</h2>
<p class="hint">下面这段文本就是"模型回复"里会出现的样子。卡片应当出现在每一行路径的下方。</p>
<div class="box" id="selftest-transcript">
${previewBlocks || '<p class="src">（没有可预览的样本）</p>'}
</div>

<div class="verdict" id="selftest-verdict">等待 client.js 运行…</div>

<script>
window.__ModuleLoader__ = { load: function (bundle) { window.__SELFTEST_BUNDLE__ = bundle; } };
/* 抖动哨兵：在 client.js 跑之前先盯着正文容器。若发生自激循环（自己改 DOM →
   自己的观察器触发 → 重扫 → 重建），这里的计数会很快涨到几百上千。 */
window.__SELFTEST_MUTATIONS__ = 0;
(function () {
  var box = document.getElementById('selftest-transcript');
  if (box === null || typeof MutationObserver !== 'function') return;
  new MutationObserver(function (records) {
    window.__SELFTEST_MUTATIONS__ += records.length;
  }).observe(box, { childList: true, subtree: true, characterData: true });
})();
/* 只提供 client.js 需要的 require；它现在不依赖 React 渲染，这里给空对象也能工作 */
window.require = function (name) {
  if (name === 'react') return { createElement: function () { return null; }, useState: function () { return [null, function () {}]; }, useEffect: function () {} };
  if (name === 'react-dom/client') return {};
  if (name === 'react-dom') return {};
  return {};
};
</script>
<script>${safeClient}</script>
<script>
(function () {
  var lines = [];
  function say(cls, text) { lines.push('<span class="' + cls + '">' + text + '</span>'); }
  function flush() { document.getElementById('selftest-verdict').innerHTML = lines.join('\\n'); }
  try {
    if (window.__SELFTEST_CLIENT_ERROR__) { say('bad-txt', 'FAIL 读取 client.js 失败：' + window.__SELFTEST_CLIENT_ERROR__); flush(); return; }
    var bundle = window.__SELFTEST_BUNDLE__;
    if (!bundle) { say('bad-txt', 'FAIL client.js 没有注册模块'); flush(); return; }
    say('ok-txt', 'OK   client.js 已加载并注册模块');

    var ctx = { effect: function (fn) { window.__selftestDispose = fn(); } };
    var mod = bundle.factory(window.require);
    mod.apply(ctx);
    say('ok-txt', 'OK   apply() 执行成功');

    var buildTag = document.querySelector('style[data-plugin-css="dsh-media-preview"]');
    say(buildTag ? 'ok-txt' : 'bad-txt',
      (buildTag ? 'OK   ' : 'FAIL ') + '页面上实际运行的构建 = ' + (buildTag ? buildTag.dataset.pluginBuild : '(样式未注入)'));

    setTimeout(function () {
      var hosts = document.querySelectorAll('[data-dsh-media-host]').length;
      var cards = document.querySelectorAll('[data-dsh-media-card]').length;
      var imgs = document.querySelectorAll('.dsh-mp-stage img').length;
      var audios = document.querySelectorAll('.dsh-mp-stage audio').length;
      var videos = document.querySelectorAll('.dsh-mp-stage video').length;
      var decodeOk = 0;
      document.querySelectorAll('.dsh-mp-stage img').forEach(function (i) { if (i.naturalWidth > 0) decodeOk++; });
      say(cards > 0 ? 'ok-txt' : 'bad-txt', (cards > 0 ? 'OK   ' : 'FAIL ') + '卡片数 = ' + cards + '（宿主容器 ' + hosts + '）');
      say('ok-txt', '     元素：img=' + imgs + ' audio=' + audios + ' video=' + videos);
      say(decodeOk > 0 ? 'ok-txt' : (imgs === 0 ? 'ok-txt' : 'bad-txt'), '     图片真实解码数 = ' + decodeOk + '/' + imgs);
      var statuses = [].map.call(document.querySelectorAll('.dsh-mp-status'), function (n) { return n.textContent; }).filter(Boolean);
      if (statuses.length) say('ok-txt', '     卡片提示：' + statuses.join(' / '));

      // 抖动哨兵读数：稳定后应该是 0（1.5 秒里没有任何新变更）
      setTimeout(function () {
        var first = window.__SELFTEST_MUTATIONS__;
        setTimeout(function () {
          var second = window.__SELFTEST_MUTATIONS__;
          var still = second - first;
          say(still === 0 ? 'ok-txt' : 'bad-txt',
            (still === 0 ? 'OK   ' : 'FAIL ') + '抖动检测：稳定后 0.6 秒内新变更 = ' + still + '（累计 ' + second + '）');
          var badge = document.querySelector('[data-dsh-media-legend]');
          say(badge ? 'ok-txt' : 'bad-txt',
            (badge ? 'OK   ' : 'FAIL ') + '自报标签：' + (badge ? badge.textContent.replace('\\n', ' · ') : '(不存在)'));
          flush();
          document.title = 'selftest: cards=' + cards + ' still=' + still;
        }, 600);
      }, 300);
    }, 1500);
  } catch (e) {
    say('bad-txt', 'FAIL 异常：' + (e && e.message));
    say('bad-txt', String(e && e.stack).split('\\n').slice(0, 4).join('\\n'));
    flush();
  }
})();
</script>
</body></html>`;
}

/**
 * 极简 HTML 转义（自检页会把路径直接写进 HTML）。
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 注册 media_preview 工具。
 *
 * 契约要点（踩过才知道）：
 *   · defineTool 的 output 是必填的，且必须带 render()；render 返回的文本块就是
 *     模型与对话里看到的内容。本工具故意把**绝对路径**原样放进文本 —— 浏览器半
 *     靠扫描正文里的路径来挂卡片，这条文本就是卡片出现的锚点。
 *   · 工具在 ctx 上全局注册（非 agent 作用域），新会话即可用。
 *   · defineTool 是从 DSH 自身安装目录解析的（插件所在的 profile 目录能回退到它），
 *     因此在插件被复制到工作区外单独跑测试时解析会失败 —— 这里做成"拿不到就用
 *     恒等函数"，让工具注册逻辑本身仍可被单测覆盖。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {PathGuard} guard
 * @returns {Promise<() => void>} 卸载器（tools 服务缺失时是 no-op）
 */
async function registerMediaTool(ctx, guard) {
  const tools = ctx.get('tools');
  if (tools === undefined || typeof tools.register !== 'function') {
    ctx.logger?.info?.('dsh-media-preview: 未发现 tools 服务，跳过 media_preview 工具注册');
    return () => {};
  }
  let defineTool = (definition) => definition;
  try {
    ({ defineTool } = await import('@deepseek-ai/dsh-tools'));
  } catch (error) {
    ctx.logger?.warn?.(`dsh-media-preview: 无法加载 dsh-tools（${error instanceof Error ? error.message : String(error)}），以恒等形式注册工具`);
  }
  try {
    const dispose = tools.register(defineTool({
      name: TOOL_NAME,
      description: TOOL_DESCRIPTION,
      parameters: {
        paths: {
          type: 'array',
          required: true,
          description: 'Absolute paths of the media files to preview (1-20 items).',
          items: { type: 'string', description: 'Absolute path, e.g. D:\\work\\out\\cover.png' }
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            shown: {
              type: 'array',
              required: true,
              items: { type: 'string', description: 'Confirmed absolute path now shown as a card.' }
            },
            rejected: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  path: { type: 'string', required: true },
                  reason: { type: 'string', required: true }
                }
              }
            }
          }
        },
        render: (_args, value) => {
          const lines = [];
          for (const p of value.shown) lines.push(`Media preview ready: ${p}`);
          for (const r of value.rejected) lines.push(`Not shown — ${r.path} (${r.reason})`);
          return [{ type: 'text', text: lines.join('\n') }];
        }
      },
      async execute(args) {
        const asked = Array.isArray(args?.paths) ? args.paths.filter((p) => typeof p === 'string' && p.trim() !== '') : [];
        if (asked.length === 0) throw new Error('media_preview requires at least one non-empty path');
        const shown = [];
        const rejected = [];
        for (const candidate of asked.slice(0, 20)) {
          const resolved = guard.resolve(candidate, mediaTypeOf);
          if (resolved.ok) shown.push(resolved.path);
          else rejected.push({ path: candidate.trim(), reason: resolved.message });
        }
        return Promise.resolve({ shown, rejected });
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'Preview media',
        kind: 'read',
        rawInput: args?.paths
      })
    }));
    ctx.logger?.info?.(`dsh-media-preview: 已注册工具 ${TOOL_NAME}`);
    return dispose;
  } catch (error) {
    ctx.logger?.warn?.(`dsh-media-preview: 注册 ${TOOL_NAME} 失败 — ${error instanceof Error ? error.message : String(error)}`);
    return () => {};
  }
}

/**
 * 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const guard = new PathGuard({
    roots: () => candidateRoots(ctx)
  });

  /** 部署级默认根（不含会话），health 里单列，便于区分「哪个来源给的根」。 */
  const deploymentRoot = () => {
    const policy = ctx.get('sandboxPolicy');
    return typeof policy?.workspaceRoot === 'string' ? policy.workspaceRoot : null;
  };

  const disposeFile = ctx.webServer.register({
    kind: 'prefix',
    path: `${ROUTE_PREFIX}/file`,
    handler: async (req, res) => {
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, code: 'method_not_allowed', message: '只支持 GET/HEAD' });
          return;
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const resolved = guard.resolve(url.searchParams.get('path'), mediaTypeOf);
        if (!resolved.ok) {
          sendJson(res, resolved.status, { ok: false, code: resolved.code, message: resolved.message });
          return;
        }
        const download = url.searchParams.get('dl') === '1';
        const asked = url.searchParams.get('name');
        streamMedia(req, res, resolved, {
          download,
          downloadName: asked !== null && asked.trim() !== '' ? asked : basename(resolved.path)
        });
      } catch (error) {
        ctx.logger?.warn?.(`dsh-media-preview: file route failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!res.headersSent) sendJson(res, 500, { ok: false, code: 'internal', message: '内部错误' });
        else res.destroy();
      }
    }
  });

  /**
   * /dsh-media/recent —— 「最近生成」列表。
   *
   * 需求来源（2026-09-13，用户明确）："不管对话里有没有路径，只要工作区里生成了新图片，
   * 就能在界面上翻看并下载"。所以这条路由只做一件事：把工作区里最近的媒体文件列出来。
   * 不依赖对话文本、不依赖模型写路径。
   *
   * 参数：?limit=N（默认 60，上限 300）
   */
  const disposeRecent = ctx.webServer.register({
    kind: 'prefix',
    path: `${ROUTE_PREFIX}/recent`,
    handler: async (req, res) => {
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, code: 'method_not_allowed', message: '只支持 GET/HEAD' });
          return;
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const rawLimit = Number(url.searchParams.get('limit') ?? '60');
        const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(300, Math.floor(rawLimit))) : 60;

        const items = listRecentMedia(guard, limit).map((item) => ({
          ...item,
          url: `${ROUTE_PREFIX}/file?path=${encodeURIComponent(item.path)}`
        }));
        sendJson(res, 200, { ok: true, count: items.length, items, roots: guard.roots() });
      } catch (error) {
        ctx.logger?.warn?.(`dsh-media-preview: recent route failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!res.headersSent) sendJson(res, 500, { ok: false, code: 'internal', message: '内部错误' });
        else res.destroy();
      }
    }
  });

  const disposeAllow = ctx.webServer.register({
    kind: 'prefix',
    path: `${ROUTE_PREFIX}/allow`,
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, code: 'method_not_allowed', message: '只支持 POST' });
          return;
        }
        const raw = await readBody(req);
        if (raw === null) {
          sendJson(res, 413, { ok: false, code: 'body_too_large', message: '请求体过大' });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(raw === '' ? '{}' : raw);
        } catch {
          sendJson(res, 400, { ok: false, code: 'bad_json', message: '请求体不是合法 JSON' });
          return;
        }
        const asked = Array.isArray(parsed?.paths) ? parsed.paths : [];
        if (asked.length === 0) {
          sendJson(res, 200, { ok: true, items: [], roots: guard.roots() });
          return;
        }
        if (asked.length > 200) {
          sendJson(res, 413, { ok: false, code: 'too_many_paths', message: '一次最多 200 个路径' });
          return;
        }
        const items = asked.map((candidate) => {
          const resolved = guard.resolve(candidate, mediaTypeOf);
          if (!resolved.ok) {
            return {
              asked: typeof candidate === 'string' ? candidate : '',
              ok: false,
              code: resolved.code,
              message: resolved.message
            };
          }
          return {
            asked: typeof candidate === 'string' ? candidate : '',
            ok: true,
            path: resolved.path,
            name: resolved.name,
            size: resolved.size,
            mtimeMs: resolved.mtimeMs,
            kind: resolved.media.kind,
            type: resolved.media.type,
            url: `${ROUTE_PREFIX}/file?path=${encodeURIComponent(resolved.path)}`
          };
        });
        sendJson(res, 200, { ok: true, items, roots: guard.roots() });
      } catch (error) {
        ctx.logger?.warn?.(`dsh-media-preview: allow route failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!res.headersSent) sendJson(res, 500, { ok: false, code: 'internal', message: '内部错误' });
        else res.destroy();
      }
    }
  });

  const disposeHealth = ctx.webServer.register({
    kind: 'prefix',
    path: `${ROUTE_PREFIX}/health`,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, code: 'method_not_allowed', message: '只支持 GET/HEAD' });
        return;
      }
      const configured = String(process.env.DSH_MEDIA_ROOTS ?? '');
      sendJson(res, 200, {
        ok: true,
        plugin: name,
        deploymentRoot: deploymentRoot(),
        envRoots: configured === '' ? [] : configured.split(process.platform === 'win32' ? ';' : ':').filter((s) => s.trim() !== ''),
        liveSessionRoots: (() => {
          const sessions = ctx.get('sessions');
          if (sessions === undefined || typeof sessions.list !== 'function') return [];
          return sessions.list().map((s) => s?.header?.cwd).filter((cwd) => typeof cwd === 'string' && cwd !== '');
        })(),
        roots: guard.roots(),
        mediaExtensions: Object.keys(MEDIA_TYPES_FOR_HEALTH)
      });
    }
  });

  /**
   * /dsh-media/selftest —— 自检页。
   *
   * 为什么要有它：卡片不出现时，"宿主没把文件喂出来"和"浏览器端没扫到/没渲染"
   * 是两条完全不同的故障线，光看对话界面分不出来。这个页面把两件事一次说清：
   *   ① 上半部分是**宿主自检**：真的去 resolve 每个文件、真的读一段字节核对；
   *   ② 下半部分把**真实的 client.js** 加载进来，在真实浏览器里对一段真实路径出卡。
   * 打开它就能判断问题在哪一侧，不必再猜。
   *
   * 参数：?files=<绝对路径>（可重复；缺省则自动挑允许根下的媒体文件）
   */
  const disposeSelftest = ctx.webServer.register({
    kind: 'prefix',
    path: `${ROUTE_PREFIX}/selftest`,
    handler: async (req, res) => {
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, code: 'method_not_allowed', message: '只支持 GET/HEAD' });
          return;
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        let asked = url.searchParams.getAll('files').filter((p) => p.trim() !== '');
        if (asked.length === 0) asked = firstMediaFiles(guard, 3);

        const items = asked.map((candidate) => {
          const resolved = guard.resolve(candidate, mediaTypeOf);
          if (!resolved.ok) {
            return { asked: candidate, ok: false, code: resolved.code, message: resolved.message };
          }
          let magic = '';
          try {
            const fd = openSync(resolved.path, 'r');
            const head = Buffer.alloc(12);
            const read = readSync(fd, head, 0, 12, 0);
            closeSync(fd);
            magic = head.subarray(0, Math.max(0, read)).toString('hex');
          } catch (error) {
            magic = `读取失败: ${error instanceof Error ? error.message : String(error)}`;
          }
          return {
            asked: candidate,
            ok: true,
            path: resolved.path,
            name: resolved.name,
            size: resolved.size,
            kind: resolved.media.kind,
            type: resolved.media.type,
            magic,
            url: `${ROUTE_PREFIX}/file?path=${encodeURIComponent(resolved.path)}`
          };
        });

        const html = renderSelftestPage({
          items,
          roots: guard.roots(),
          version: process.versions?.node ?? '?',
          electron: req.headers['user-agent'] ?? ''
        });
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': String(Buffer.byteLength(html)),
          'cache-control': 'no-store'
        });
        res.end(html);
      } catch (error) {
        ctx.logger?.warn?.(`dsh-media-preview: selftest failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!res.headersSent) sendJson(res, 500, { ok: false, code: 'internal', message: '内部错误' });
        else res.destroy();
      }
    }
  });

  const disposeTools = registerMediaTool(ctx, guard);

  ctx.effect(() => () => {
    disposeFile();
    disposeRecent();
    disposeAllow();
    disposeHealth();
    disposeSelftest();
    Promise.resolve(disposeTools).then((dispose) => dispose()).catch(() => {});
  }, 'dsh-media-preview.routes');

  ctx.logger?.info?.(
    `dsh-media-preview: 已挂载 ${ROUTE_PREFIX}/file · ${ROUTE_PREFIX}/recent · ${ROUTE_PREFIX}/allow · ${ROUTE_PREFIX}/health · ${ROUTE_PREFIX}/selftest`
  );

  // 让宿主日志里能看到允许根，排障时不必先开 health 页面。
  setTimeout(() => {
    try {
      const roots = guard.roots();
      ctx.logger?.info?.(
        roots.length === 0
          ? 'dsh-media-preview: 警告 —— 当前没有任何允许根，媒体文件会被 403；请设置 DSH_MEDIA_ROOTS'
          : `dsh-media-preview: 允许根 ${roots.length} 个 → ${roots.join(' | ')}`
      );
    } catch { /* 日志失败不影响功能 */ }
  }, 0);
}

export default { name, inject, apply };
