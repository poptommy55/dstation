/**
 * dsh-wallpaper 离线测试。
 *
 * 为什么能离线跑：宿主半（index.js）只 import Node 内置模块，
 * 不依赖任何 @deepseek-ai/* 的包 —— 所以可以直接 import 进来，
 * 配一个假的 ctx 把 apply() 跑通。这条路正是坑 #12/#30 的正确姿势。
 *
 * 跑法：node test/run-tests.mjs
 * 注意：不要用 `node --test test/`（陷阱见 dsh-plugin-dev 坑 #10）。
 */

import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

/* ── 隔离的 DSH_HOME，别碰用户真实配置 ───────────────────────────── */
const HOME = mkdtempSync(join(tmpdir(), 'dsh-wallpaper-test-'));
process.env.DSH_HOME = HOME;

const plugin = await import('../index.js');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/* ── 假 ctx / req / res ──────────────────────────────────────────── */

function makeCtx() {
  const routes = new Map();
  const events = new Map();
  const disposers = [];
  return {
    routes,
    events,
    disposers,
    ctx: {
      webServer: {
        register(route) {
          /* 这里刻意复刻真实 WebServer 的行为：重复 (kind, path) 直接抛。
             坑 #37 就是被这一条抓住的。 */
          const key = `${route.kind} ${route.path}`;
          if (routes.has(key)) {
            throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
          }
          routes.set(key, route);
          return () => routes.delete(key);
        }
      },
      on(event, listener) {
        events.set(event, listener);
      },
      effect(callback) {
        const dispose = callback();
        disposers.push(dispose);
        return dispose;
      }
    }
  };
}

function makeReq(method, url, body) {
  const req = { method, url };
  req[Symbol.asyncIterator] = async function* iterator() {
    if (body !== undefined && body !== null) {
      yield Buffer.isBuffer(body) ? body : Buffer.from(body);
    }
  };
  return req;
}

/**
 * 假 res。必须是**真的 Writable 流** —— 文件路由用
 * createReadStream(path).pipe(res) 输出，普通对象没有 .on() 会直接崩。
 */
function makeRes() {
  const chunks = [];
  const res = new Writable({
    write(chunk, _enc, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    }
  });
  res.statusCode = 0;
  res.headers = {};
  res.writeHead = function writeHead(status, headers) {
    this.statusCode = status;
    this.headers = headers || {};
    return this;
  };
  Object.defineProperty(res, 'body', {
    get() {
      return Buffer.concat(chunks).toString('utf8');
    }
  });
  return res;
}

/** 调一条已注册路由，并等到响应真正写完（文件路由是异步 pipe）。 */
async function call(h, method, url, body) {
  const path = url.split('?')[0];
  const route =
    h.routes.get(`exact ${path}`) ||
    h.routes.get(`prefix ${path}`) ||
    [...h.routes.values()].find((r) => r.kind === 'prefix' && path.startsWith(`${r.path}/`));
  if (!route) throw new Error(`no route for ${method} ${url}`);
  const res = makeRes();
  const finished = new Promise((resolve) => res.on('finish', resolve));
  await route.handler(makeReq(method, url, body), res);
  await finished;
  return res;
}

const json = (res) => JSON.parse(res.body);

/* ── 0) 干净启动：apply 不抛、路由不重复 ─────────────────────────── */
const h = makeCtx();
let applyError = null;
try {
  plugin.apply(h.ctx);
} catch (err) {
  applyError = err;
}
check('apply() 不抛异常', applyError === null, applyError && applyError.message);
check('注册了 7 条路由', h.routes.size === 7, `实际 ${h.routes.size}: ${[...h.routes.keys()].join(', ')}`);
check(
  '注册了 webserver/index-inject 监听',
  typeof h.events.get('webserver/index-inject') === 'function'
);

/* ── 1) health / config 读 ───────────────────────────────────────── */
let res = await call(h, 'GET', '/dsh-wallpaper/health');
check('GET /health → 200', res.statusCode === 200);
check('GET /health 带 build', typeof json(res).build === 'string');

res = await call(h, 'GET', '/dsh-wallpaper/config');
const initial = json(res);
check('GET /config → 200', res.statusCode === 200);
check('GET /config 返回默认 mode=none', initial.config.mode === 'none');
check('GET /config 返回字段定义', Array.isArray(initial.fields) && initial.fields.length === 10);
check('GET /config 带 BUILD 头', typeof res.headers['x-dsh-wallpaper-build'] === 'string');

/* ── 2) 默认「无背景」时 style.css 必须为空 ──────────────────────── */
res = await call(h, 'GET', '/dsh-wallpaper/style.css');
check('mode=none 时 style.css 为空', res.body === '', JSON.stringify(res.body.slice(0, 80)));

/* ── 3) 写配置：白名单校验 ───────────────────────────────────────── */

/* 3a) 未知字段必须被拒绝，而不是静默忽略 */
res = await call(h, 'POST', '/dsh-wallpaper/config', JSON.stringify({ mode: 'solid', bogus: 1 }));
check('未知字段 → 400', res.statusCode === 400, `实际 ${res.statusCode}`);
check('未知字段错误信息点名该字段', /unknown field: bogus/.test(json(res).error || ''), json(res).error);

/* 3b) 枚举越界 */
res = await call(h, 'POST', '/dsh-wallpaper/config', JSON.stringify({ mode: 'rainbow' }));
check('非法枚举 → 400', res.statusCode === 400);

/* 3c) 颜色格式 */
res = await call(h, 'POST', '/dsh-wallpaper/config', JSON.stringify({ color: 'red' }));
check('非法颜色 → 400', res.statusCode === 400);

/* 3d) 整数越界 */
res = await call(h, 'POST', '/dsh-wallpaper/config', JSON.stringify({ panelOpacity: 101 }));
check('越界整数 → 400', res.statusCode === 400);

res = await call(h, 'POST', '/dsh-wallpaper/config', JSON.stringify({ panelOpacity: 12.5 }));
check('小数 → 400', res.statusCode === 400);

/* 3e) 非法文件名（防穿越） */
res = await call(h, 'POST', '/dsh-wallpaper/config', JSON.stringify({ image: '../../../etc/passwd' }));
check('非法图片文件名 → 400', res.statusCode === 400);

/* 3f) 合法写入 + 立刻回读 */
res = await call(h, 'POST', '/dsh-wallpaper/config', JSON.stringify({ mode: 'gradient', panelOpacity: 50 }));
const saved = json(res);
check('合法写入 → 200', res.statusCode === 200);
check('回读 mode=gradient', saved.config.mode === 'gradient');
check('回读 panelOpacity=50', saved.config.panelOpacity === 50);
check('未提供的字段保持原值', saved.config.color === initial.config.color);
check('配置落盘', existsSync(join(HOME, 'wallpapers', 'config.json')));

const onDisk = JSON.parse(readFileSync(join(HOME, 'wallpapers', 'config.json'), 'utf8'));
check('磁盘内容与回读一致', onDisk.mode === 'gradient' && onDisk.panelOpacity === 50);

/* ── 4) style.css 内容正确性 ─────────────────────────────────────── */
res = await call(h, 'GET', '/dsh-wallpaper/style.css');
const css = res.body;
check('gradient 模式产出 linear-gradient', css.includes('linear-gradient('), css.slice(0, 120));
check('产出 html::before 壁纸层', css.includes('html::before{'), css.slice(0, 200));
check(
  '令牌覆写用 html body 提高特异性（不依赖文档顺序）',
  css.includes('html body{') && css.includes('html body[data-ds-dark-theme]{'),
  css
);
check('light/dark 两套都给了', (css.match(/color-mix\(/g) || []).length >= 20);
check('引用了官方调色板变量而不是硬编码色值', css.includes('var(--dsw-static-neutral-bluish-'));
check('CSV 里不含能提前闭合 <style> 的序列', !/<\/style/i.test(css));

/* 每个 var() 都必须带十六进制兜底：
   官方一旦改令牌名，没有兜底的 var() 会让整条声明变成
   "invalid at computed-value time"，自定义属性退化成 guaranteed-invalid，
   用它的 background 回落到 initial = 全透明 —— 面板直接消失，
   而不是"退回官方样式"。这条断言就是防那个的。 */
const bareVars = (css.match(/var\(--dsw-static-[a-z0-9-]+\)/g) || []);
check(
  'CSS 里没有不带兜底值的 var(--dsw-static-*)',
  bareVars.length === 0,
  `发现 ${bareVars.length} 处：${bareVars.slice(0, 3).join(', ')}`
);
const withFallback = (css.match(/var\(--dsw-static-[a-z0-9-]+, #[0-9a-f]{3,8}\)/g) || []);
check('每个 var 都带 #hex 兜底', withFallback.length >= 20, `实际 ${withFallback.length}`);

/* panelOpacity=100 时应当完全不再产出令牌覆写 */
await call(h, 'POST', '/dsh-wallpaper/config', JSON.stringify({ panelOpacity: 100 }));
res = await call(h, 'GET', '/dsh-wallpaper/style.css');
check('panelOpacity=100 时不产出令牌覆写', !res.body.includes('color-mix('));

await call(h, 'POST', '/dsh-wallpaper/config', JSON.stringify({ panelOpacity: 68, mode: 'none' }));
res = await call(h, 'GET', '/dsh-wallpaper/style.css');
check('切回 mode=none 后 style.css 归零', res.body === '');

/* ── 5) 上传 ─────────────────────────────────────────────────────── */

/* 5a) 非图片必须被拒（认魔数，不认扩展名/Content-Type） */
res = await call(h, 'POST', '/dsh-wallpaper/upload', Buffer.from('this is definitely not an image'));
check('非图片 → 415', res.statusCode === 415, `实际 ${res.statusCode}`);

/* 5b) 空体 */
res = await call(h, 'POST', '/dsh-wallpaper/upload', Buffer.alloc(0));
check('空体 → 400', res.statusCode === 400);

/* 5c) 合法 PNG（魔数正确即可） */
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0x00)
]);
res = await call(h, 'POST', '/dsh-wallpaper/upload', png);
const up = json(res);
check('合法 PNG → 200', res.statusCode === 200, res.body.slice(0, 200));
check('返回内容寻址文件名', /^[0-9a-f]{40}\.png$/.test(up.name || ''), up.name);
check('返回可用的 file URL', up.url === `/dsh-wallpaper/file/${up.name}`);
check('文件落盘', existsSync(join(HOME, 'wallpapers', 'files', up.name)));

/* 5d) 重复上传同一张图 → 同一个文件名（内容寻址，不堆积） */
res = await call(h, 'POST', '/dsh-wallpaper/upload', png);
check('重复上传得到同一文件名', json(res).name === up.name);

/* ── 6) 文件通道的路径安全 ───────────────────────────────────────── */

/* 6a) 非法文件名 */
for (const bad of ['..%2F..%2Fconfig.json', 'config.json', 'abc.png', `${'a'.repeat(40)}.svg`, `${'a'.repeat(40)}.png%00`]) {
  res = await call(h, 'GET', `/dsh-wallpaper/file/${bad}`);
  check(`非法文件名被拒：${bad}`, res.statusCode === 400, `实际 ${res.statusCode}`);
}

/* 6b) 形状合法但不存在 */
res = await call(h, 'GET', `/dsh-wallpaper/file/${'b'.repeat(40)}.png`);
check('形状合法但不存在 → 404', res.statusCode === 404, `实际 ${res.statusCode}`);

/* 6c) 真实文件可读，且 MIME 来自魔数、带 nosniff */
res = await call(h, 'GET', `/dsh-wallpaper/file/${up.name}`);
check('已存壁纸 → 200', res.statusCode === 200);
check('MIME 为 image/png', res.headers['content-type'] === 'image/png', res.headers['content-type']);
check('带 X-Content-Type-Options: nosniff', res.headers['x-content-type-options'] === 'nosniff');

/* ── 7) 首屏注入 ─────────────────────────────────────────────────── */
await call(h, 'POST', '/dsh-wallpaper/config', JSON.stringify({ mode: 'solid', color: '#123456' }));
const table = [];
h.events.get('webserver/index-inject')(table);
check('注入表恰好两行（样式 + 探针脚本）', table.length === 2, `实际 ${table.length}`);
check('首行是 head 里的 html', table[0] && table[0].kind === 'html' && table[0].placement === 'head');
check('首行带 id 便于客户端接管', /id="dsh-wallpaper-boot"/.test(table[0] ? table[0].html : ''));
check('首行含用户设的纯色', /#123456/.test(table[0] ? table[0].html : ''));
check('次行是 body 里的内联探针脚本', table[1] && table[1].kind === 'script' && table[1].placement === 'body');
check('探针脚本不含能提前闭合的序列', table[1] && !/<\/script/i.test(table[1].text));
check('探针会读客户端模块的 DOM 标记', table[1] && /dshWallpaperPhase/.test(table[1].text));
check('探针会把读数报回宿主', table[1] && /dsh-wallpaper\/report/.test(table[1].text));
check('探针上报带 source=probe（否则会冲掉客户端槽）', table[1] && /source:\s*'probe'/.test(table[1].text));

await call(h, 'POST', '/dsh-wallpaper/config', JSON.stringify({ mode: 'none' }));
const table2 = [];
h.events.get('webserver/index-inject')(table2);
check('mode=none 时不注入任何东西', table2.length === 0, `实际 ${table2.length}`);

/* ── 8) 客户端上报通道 ───────────────────────────────────────────── */
res = await call(h, 'POST', '/dsh-wallpaper/report', JSON.stringify({ phase: 'ready', cssBytes: 42 }));
check('POST /report → 204', res.statusCode === 204);
res = await call(h, 'GET', '/dsh-wallpaper/status');
const st = json(res);
check('status 带回客户端上报', st.reports.client && st.reports.client.cssBytes === 42, JSON.stringify(st.reports.client));
check('clientReport 兼容字段指向客户端槽', st.clientReport && st.clientReport.cssBytes === 42);
check('status 列出已存壁纸', Array.isArray(st.stored) && st.stored.some((f) => f.name === up.name));

/* 两类上报必须各占一槽 —— 共用一个槽位时后到的会把先到的整个冲掉，
   实测踩过：客户端报完 phase=saved 之后，探针那份侧栏计算背景色就没了。 */
await call(h, 'POST', '/dsh-wallpaper/report', JSON.stringify({ source: 'probe', phase: 'probe:settled', sidebarBg: 'rgba(27,27,28,0.47)' }));
res = await call(h, 'GET', '/dsh-wallpaper/status');
const st2 = json(res);
check('探针上报进 probe 槽', st2.reports.probe && st2.reports.probe.phase === 'probe:settled', JSON.stringify(st2.reports.probe));
check('探针上报不会冲掉客户端槽', st2.reports.client && st2.reports.client.cssBytes === 42, JSON.stringify(st2.reports.client));
await call(h, 'POST', '/dsh-wallpaper/report', JSON.stringify({ phase: 'saved' }));
res = await call(h, 'GET', '/dsh-wallpaper/status');
const st3 = json(res);
check('缺 source 的上报默认进 client 槽', st3.reports.client && st3.reports.client.phase === 'saved');
check('客户端上报不会冲掉探针槽', st3.reports.probe && st3.reports.probe.sidebarBg === 'rgba(27,27,28,0.47)');

/* ── 9) 方法限制 ─────────────────────────────────────────────────── */
res = await call(h, 'DELETE', '/dsh-wallpaper/config');
check('DELETE /config → 405', res.statusCode === 405, `实际 ${res.statusCode}`);

/* ── 10) 卸载会撤掉路由 ──────────────────────────────────────────── */
for (const d of h.disposers) d();
check('卸载后路由表清空', h.routes.size === 0, `剩下 ${h.routes.size}`);

/* ── 结果 ────────────────────────────────────────────────────────── */
rmSync(HOME, { recursive: true, force: true });

console.log(`\ndsh-wallpaper: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
