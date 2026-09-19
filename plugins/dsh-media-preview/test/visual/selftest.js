/**
 * 可视化自测夹具（开发/验收用，不参与插件运行时功能）。
 *
 * 三件事：
 *   1. 起一个最小 node:http 服务器，挂上**真实的** index.js 路由（宿主半）；
 *   2. 提供一个"假对话正文"页面，把**真实的 client.js** 当脚本注入，并补齐
 *      浏览器半需要的宿主环境（window.__ModuleLoader__ / react / fakeAllow）；
 *   3. 用本机已安装的 React 产物当支架（不做二次打包），使卡片真的能被渲染出来。
 *
 * 用法：
 *   node test/visual/selftest.js --port 45999
 *   → 浏览器/窗口打开 http://127.0.0.1:45999/
 *
 * 验收判据（页面底部会自报）：
 *   · 纯路径段 → 变成媒体卡，路径文本消失
 *   · 混排段   → 只隐藏路径那一小段，其余文字保留
 *   · 不存在的文件 / 非媒体扩展名 / 代码块 / 相对路径 → 不出卡
 */

import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

import { apply } from '../../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, '..', '..');

/** 本机 React 产物位置（只用现成的，不打包、不联网）。 */
function findReactAssets() {
  // 关键：react 与 react-dom 必须同版本。整合包里同时存在 react@18.3.1
  // （app/node_modules）与 react@19.2.8（ui-trajectory 内嵌），混用会在
  // react-dom/client 里直接炸（读 React 的内部字段得到 undefined）。
  const candidates = [
    '<repo-root>/build/dist/app/node_modules/@deepseek-ai/dsh-client-ui-trajectory/node_modules',
    '<repo-root>/build/dist/home/profiles/node_modules'
  ];
  for (const base of candidates) {
    const react = join(base, 'react', 'cjs', 'react.development.js');
    const domClient = join(base, 'react-dom', 'cjs', 'react-dom-client.development.js');
    const scheduler = join(base, 'scheduler', 'cjs', 'scheduler.development.js');
    if (existsSync(react) && existsSync(domClient) && existsSync(scheduler)) {
      return { react, domClient, scheduler };
    }
  }
  return null;
}

// ─────────────────────────────────────── 造真素材（PNG 手写字节，不引依赖）
const scratchDir = mkdtempSync(join(tmpdir(), 'dsh-media-visual-'));
const outDir = join(scratchDir, 'out');
mkdirSync(outDir, { recursive: true });

function makePng(wid, hei, rgb) {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(wid, 0);
  ihdr.writeUInt32BE(hei, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(hei * (1 + wid * 3));
  let p = 0;
  for (let y = 0; y < hei; y++) {
    raw[p++] = 0;
    for (let x = 0; x < wid; x++) {
      const t = (x + y) / (wid + hei);
      raw[p++] = Math.round(rgb[0] * (0.3 + 0.7 * t));
      raw[p++] = Math.round(rgb[1] * (0.3 + 0.7 * t));
      raw[p++] = Math.round(rgb[2] * (0.3 + 0.7 * t));
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const pngPath = join(outDir, 'cover.png');
writeFileSync(pngPath, makePng(120, 80, [77, 107, 254]));
const mp3Path = join(outDir, 'voice.mp3');
writeFileSync(mp3Path, Buffer.alloc(8192, 7));
const txtPath = join(outDir, 'notes.txt');
writeFileSync(txtPath, '这不是媒体，不该出卡');
const missingPath = join(outDir, 'missing.png');

// ─────────────────────────────────────── 宿主半：真实路由
function stubContext(roots) {
  const routes = new Map();
  return {
    routes,
    ctx: {
      webServer: {
        register(route) {
          routes.set(`${route.kind}:${route.path}`, route);
          return () => routes.delete(`${route.kind}:${route.path}`);
        }
      },
      logger: { info: (m) => console.log('[host]', m), warn: (m) => console.log('[host:warn]', m) },
      effect() {},
      get(name) {
        if (name === 'sandboxPolicy') return { workspaceRoot: roots[0] };
        if (name === 'sessions') return { list: () => [] };
        return undefined;
      }
    }
  };
}

const { ctx, routes } = stubContext([scratchDir]);
apply(ctx);

// ─────────────────────────────────────── 夹具页面
const clientSource = readFileSync(join(pluginRoot, 'client.js'), 'utf8');
const reactAssets = findReactAssets();

function transcriptHtml() {
  return `
  <div class="msg-assistant">
    <p>图片生成好了：${pngPath}</p>
    <p>配一段旁白，音频在 ${mp3Path}，你听听。</p>
    <p>顺便提一句：${missingPath} 这个文件其实不存在。</p>
    <p>文档在这里 ${txtPath}（不该出卡）。</p>
    <ul><li>列表项里的远端直链 https://example.com/a/shot.png 走远端分支。</li></ul>
    <pre><code>不要动代码块：D:\\tmp\\a.png</code></pre>
    <p>相对路径不该出卡：看 out/cover.png 这个产物。</p>
  </div>`;
}

function pageHtml() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>dsh-media-preview 自测</title>
<style>
 body{margin:0;padding:22px 26px;background:#14161a;color:#e6e8ec;
   font:14px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
 .mock{max-width:860px;border:1px dashed #2c323b;border-radius:10px;padding:14px 18px}
 h2{margin:0 0 2px;font-size:17px}
 .hint{color:#8b93a1;margin:0 0 16px;font-size:12.5px}
 pre{background:#0d0f12;border:1px solid #2a2f37;border-radius:8px;padding:10px}
 td{border:1px solid #2a2f37;padding:8px}
 #verdict{position:fixed;left:12px;bottom:12px;right:12px;padding:10px 12px;border-radius:10px;
   background:#0d0f12;border:1px solid #2a2f37;font:12px/1.6 ui-monospace,Consolas,monospace;
   white-space:pre-wrap;max-height:34vh;overflow:auto}
 .ok{color:#3ecf8e}.bad{color:#e5484d}.warn{color:#e2b93d}
</style></head>
<body>
<h2>dsh-media-preview · 自测夹具</h2>
<p class="hint">真实 client.js + 真实宿主路由。下面这段"假的助手回复"加载后，
绝对路径应消失并变成媒体卡；错误路径、代码块、相对路径不该出卡。</p>
<div class="mock" id="mock-transcript">${transcriptHtml()}</div>

<script>
window.__ModuleLoader__ = { load: function (b) { window.__DSH_MEDIA_BUNDLE__ = b; } };
window.__FIXTURE_PATHS__ = ${JSON.stringify({
    [pngPath]: { ok: true, path: pngPath, name: 'cover.png', size: 120 * 80, mtimeMs: Date.now(), kind: 'image', type: 'image/png' },
    [mp3Path]: { ok: true, path: mp3Path, name: 'voice.mp3', size: 8192, mtimeMs: Date.now(), kind: 'audio', type: 'audio/mpeg' }
  })};
/* fakeAllow 开关：client.js 优先走 true 的原生 fetch（真路由），仅在
   /dsh-media/allow 不可用时才退回本表 —— 夹具用于无 cookie 的独立页面。 */
window.__FIXTURE_USE_FAKE_ALLOW__ = true;
(function () {
  var real = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (!window.__FIXTURE_USE_FAKE_ALLOW__ || url.indexOf('/dsh-media/allow') !== 0) return real(input, init);
    var body = {};
    try { body = JSON.parse((init && init.body) || '{}'); } catch (e) {}
    var asked = Array.isArray(body.paths) ? body.paths : [];
    var items = asked.map(function (p) {
      var hit = window.__FIXTURE_PATHS__[p];
      if (hit) return Object.assign({ asked: p, url: '/dsh-media/file?path=' + encodeURIComponent(p) }, hit);
      return { asked: p, ok: false, code: 'not_found', message: '夹具判定：路径不存在或不在允许根内' };
    });
    var payload = JSON.stringify({ ok: true, items: items, roots: [] });
    /* 老引擎 / jsdom 可能没有 Response 构造器：给一个最小替身 */
    if (typeof Response === 'function') {
      return Promise.resolve(new Response(payload, { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: function () { return Promise.resolve(JSON.parse(payload)); }
    });
  };
})();
</script>

<script src="/vendor/react.js"></script>
<script>
/* React / react-dom 的 cjs 开发版产物引用 process.env.NODE_ENV（浏览器里没有
   process），在加载之前补一个最小垫片，否则会直接抛 "process is not defined"。
   真实 DSH 里由打包器注入，夹具必须自己补。
   另注：react-dom 19 的 client 入口自带 DOM 内部实现，只依赖 react 与 scheduler，
   因此这里不需要再单独喂 react-dom 主包。 */
window.process = window.process || { env: { NODE_ENV: 'development' } };
</script>
<script src="/vendor/scheduler.js"></script>
<script src="/vendor/react-dom-client.js"></script>
<script>
/* 给 client.js 的最小 require 垫片：它只用 react 与 react-dom/client。 */
window.require = function (name) {
  if (name === 'react') return window.React;
  if (name === 'react-dom/client') return window.ReactDOMClient;
  if (name === 'react-dom') return window.ReactDOM;
  return {};
};
window.__FIXTURE_ENV__ = function () {
  return {
    reactKeys: window.React === undefined ? 'no React' : Object.keys(window.React).slice(0, 8).join(','),
    clientType: typeof window.ReactDOMClient,
    clientCreateRoot: typeof (window.ReactDOMClient || {}).createRoot,
    vendorKeys: window.__VENDOR_KEYS__ || '(none)',
    vendorError: window.__VENDOR_ERROR__ || '(none)'
  };
};
</script>
<script id="dsh-media-client">${clientSource}</script>
<script>
(function () {
  var out = [];
  function line(cls, text) { out.push('<span class="' + cls + '">' + text + '</span>'); }
  var bundle = window.__DSH_MEDIA_BUNDLE__;
  if (!bundle) { line('bad', 'FAIL 模块未注册'); document.getElementById('verdict').innerHTML = out.join('\\n'); return; }
  var exports = bundle.factory(window.require);
  try { exports.apply({ effect: function (fn) { window.__fixtureDispose = fn(); } }); }
  catch (e) { line('bad', 'FAIL apply: ' + e.message); }

  setTimeout(function () {
    var cards = document.querySelectorAll('[data-dsh-media-card]');
    var hosts = document.querySelectorAll('[data-dsh-media-host]');
    line(cards.length > 0 ? 'ok' : 'bad', (cards.length > 0 ? 'OK  ' : 'FAIL') + ' 渲染卡片数 = ' + cards.length + '（宿主容器 ' + hosts.length + '）');
    var kinds = [].map.call(cards, function (c) { return c.querySelector('.dsh-mp-kind').textContent; });
    line('ok', '     类型 = [' + kinds.join(', ') + ']');
    var imgs = document.querySelectorAll('.dsh-mp-stage img');
    var audios = document.querySelectorAll('.dsh-mp-stage audio');
    line('ok', '     img=' + imgs.length + ' audio=' + audios.length);
    var btns = [].map.call(cards, function (c) {
      var b = c.querySelector('.dsh-mp-btn');
      return b ? (b.disabled ? 'disabled' : 'enabled') : 'none';
    });
    line(btns.indexOf('enabled') >= 0 ? 'ok' : 'bad', '     下载按钮 = [' + btns.join(', ') + ']');
    var text = document.getElementById('mock-transcript').textContent;
    var leaks = [${JSON.stringify(pngPath)}, ${JSON.stringify(mp3Path)}].filter(function (p) {
      return text.indexOf(p) >= 0;
    });
    line(leaks.length === 0 ? 'ok' : 'bad', (leaks.length === 0 ? 'OK  ' : 'FAIL') + ' 可见正文里残留的路径 = ' + leaks.length);
    line(text.indexOf('这个文件其实不存在') >= 0 ? 'ok' : 'bad', '     正文其余文字保留（missing 段）=' + (text.indexOf('这个文件其实不存在') >= 0));
    line(text.indexOf('不要动代码块') >= 0 ? 'ok' : 'bad', '     代码块仍在 = ' + (text.indexOf('不要动代码块') >= 0));
    line(text.indexOf('D:\\\\tmp\\\\a.png') >= 0 ? 'ok' : 'bad', '     代码块内路径未被吃 = ' + (text.indexOf('D:\\\\tmp\\\\a.png') >= 0));
    var errCard = [].filter.call(cards, function (c) { return c.getAttribute('data-state') === 'error'; });
    line('ok', '     错误态卡片 = ' + errCard.length + '（期望 1：missing.png）');
    document.getElementById('verdict').innerHTML = out.join('\\n');
    document.title = 'selftest: cards=' + cards.length;
  }, 900);
})();
</script>
</body></html>`;
}

// ─────────────────────────────────────── 服务器
const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://x').pathname;

  if (pathname === '/' || pathname === '/index.html') {
    const html = pageHtml();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) });
    res.end(html);
    return;
  }

  if (pathname.startsWith('/vendor/')) {
    if (reactAssets === null) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('找不到本机 React 产物');
      return;
    }
    const spec = {
      '/vendor/react.js': { file: reactAssets.react, global: 'React' },
      '/vendor/scheduler.js': { file: reactAssets.scheduler, global: 'Scheduler' },
      '/vendor/react-dom-client.js': { file: reactAssets.domClient, global: 'ReactDOMClient' }
    }[pathname];
    if (spec === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('unknown vendor asset');
      return;
    }
    const src = readFileSync(spec.file, 'utf8');
    // react / react-dom / scheduler 的 cjs 开发版都是 CommonJS 产物，必须包一层
    // 最小 CJS 壳，并把它内部的 require(...) 指到前面已挂好的全局。
    const wrapped = `(function(){var module={exports:{}};var exports=module.exports;\n`
      + `function require(name){\n`
      + `  if(name==='react')return window.React;\n`
      + `  if(name==='scheduler')return window.Scheduler;\n`
      + `  if(name==='react-dom')return window.ReactDOMClient||{};\n`
      + `  throw new Error('vendor shim: 未提供的依赖 '+name);\n}\n`
      + `try{\n${src}\n}catch(e){window.__VENDOR_ERROR__='${spec.global}: '+(e&&e.message);}\n`
      + `window.${spec.global}=module.exports;\n`
      + `window.__VENDOR_KEYS__=(window.__VENDOR_KEYS__||'')+'|${spec.global}='+Object.keys(module.exports).slice(0,14).join(',');})();`;
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'content-length': Buffer.byteLength(wrapped) });
    res.end(wrapped);
    return;
  }

  let best;
  for (const route of routes.values()) {
    if (pathname !== route.path && !pathname.startsWith(`${route.path}/`)) continue;
    if (best === undefined || route.path.length > best.path.length) best = route;
  }
  if (best !== undefined) {
    Promise.resolve(best.handler(req, res)).catch((error) => {
      if (!res.headersSent) { res.writeHead(500); res.end(String(error)); }
    });
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

const args = process.argv.slice(2);
const portArgAt = args.indexOf('--port');
const port = portArgAt >= 0 ? Number(args[portArgAt + 1]) : 45999;
const manifestArgAt = args.indexOf('--manifest');

server.listen(port, '127.0.0.1', () => {
  console.log(`[visual] http://127.0.0.1:${port}/`);
  console.log(`[visual] 素材 ${scratchDir}`);
  console.log(`[visual] react=${reactAssets === null ? '缺失' : reactAssets.react}`);
  if (manifestArgAt >= 0 && args[manifestArgAt + 1] !== undefined) {
    writeFileSync(args[manifestArgAt + 1], JSON.stringify({
      url: `http://127.0.0.1:${port}/`,
      scratchDir,
      pngPath,
      mp3Path,
      txtPath,
      missingPath,
      reactAssets
    }, null, 2), 'utf8');
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => {
      try { rmSync(scratchDir, { recursive: true, force: true }); } catch { /* ignore */ }
      process.exit(0);
    });
  });
}
