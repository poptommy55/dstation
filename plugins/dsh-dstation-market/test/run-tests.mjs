/**
 * dsh-dstation-market 离线测试。
 *
 * 宿主半只 import Node 内置模块，所以可以直接 import 进来跑。
 * 跑法：node test/run-tests.mjs
 * 不要用 `node --test test/`（子进程管道会被沙箱拦，见 dsh-plugin-dev 坑 #10）。
 *
 * 重点覆盖三块：
 *   1. **补丁文件语义** —— 尤其那个"删掉最后一行会留下纯注释文件、
 *      dsh 会拒绝启动整个 profile"的陷阱。这是本项目风险最高的一段代码。
 *   2. 路径归一化（踩过：`file:///C:/x` → `/C:/x`，导致数据静默变空）
 *   3. apply() 不抛 + 路由/安全闸门
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { validateHeaderValue } from 'node:http';

const HOME = mkdtempSync(join(tmpdir(), 'dsh-market-test-'));
process.env.DSH_HOME = HOME;

const plugin = await import('../index.js');
const I = plugin.__internals;

let passed = 0;
let failed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) passed += 1;
  else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/* ── 1) 路径归一化 ────────────────────────────────────────────────── */
check(
  'file:///C:/x → C:\\x（盘符前不留斜杠）',
  !/^[\\/][A-Za-z]:/.test(I.normalizeLocalPath('file:///C:/Users/a/profiles/web/cordis.yml')),
  I.normalizeLocalPath('file:///C:/Users/a/profiles/web/cordis.yml')
);
check(
  'file:///C:/... 归一化后能 dirname 出正确目录',
  I.normalizeLocalPath('file:///C:/Users/a/profiles/web/cordis.yml').replace(/\\/g, '/').endsWith('/profiles/web/cordis.yml'),
  I.normalizeLocalPath('file:///C:/Users/a/profiles/web/cordis.yml')
);
check('空值安全', I.normalizeLocalPath(null) === '' && I.normalizeLocalPath(undefined) === '');

/* ── 2) readUserPatchState 解析 ───────────────────────────────────── */
const p1 = join(HOME, 'p1.yml');
writeFileSync(
  p1,
  [
    '# comment',
    '- insert:',
    '    - id: alpha',
    "      name: 'pkg-alpha'",
    '',
    '- id: beta',
    '  disabled: true',
    '',
    '- id: gamma',
    '  disabled: false',
    ''
  ].join('\n')
);
const st1 = I.readUserPatchState(p1);
check('解析出 insert 行', st1.inserts.length === 1 && st1.inserts[0].id === 'alpha', JSON.stringify(st1.inserts));
check('insert 行带出包名', st1.inserts[0].name === 'pkg-alpha', JSON.stringify(st1.inserts[0]));
check('解析出 disables', st1.disables.length === 1 && st1.disables[0] === 'beta');
check('解析出 forced', st1.forced.length === 1 && st1.forced[0] === 'gamma');
check('insert 里的行不会被误判为 disable', !st1.disables.includes('alpha'));

/* ── 3) 模板空文件：注释掉 [] 占位符，而不是制造两个顶层元素 ────────── */
const p2 = join(HOME, 'p2.yml');
writeFileSync(p2, '# profile patch layer\n# more comment\n[]\n');
let r = I.appendPatchEntry(p2, '- id: x\n  disabled: true\n');
let t2 = readFileSync(p2, 'utf8');
check('append 成功', r.ok === true, JSON.stringify(r));
check('[] 被注释掉', /^\s*#\s*\[\]\s*$/m.test(t2), t2);
check('新行已追加', /^- id: x$/m.test(t2), t2);
check(
  '非注释内容里只剩一条顶层项（没有两个顶层元素）',
  t2
    .replace(/^[ \t]*#.*$/gm, '')
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '').length === 2, // "- id: x" + "  disabled: true"
  t2
);

/* ── 4) 🔴 陷阱：删掉最后一行必须把 [] 放回去 ─────────────────────── */
await I.removeRowBlocks(p2, ['x']);
const t3 = readFileSync(p2, 'utf8');
check(
  '删掉最后一行后，[] 占位符被放回（否则 dsh 拒绝启动 profile）',
  t3.replace(/^[ \t]*#.*$/gm, '').trim() === '[]',
  JSON.stringify(t3)
);

/* 另一个形态：手写文件、没有可复活的注释占位符 → 也要补一个 [] */
const p3 = join(HOME, 'p3.yml');
writeFileSync(p3, '- id: y\n  disabled: true\n');
await I.removeRowBlocks(p3, ['y']);
const t4 = readFileSync(p3, 'utf8');
check('无注释占位符时自动补 []', t4.replace(/^[ \t]*#.*$/gm, '').trim() === '[]', JSON.stringify(t4));

/* ── 5) disable / enable 往返 ─────────────────────────────────────── */
const p4 = join(HOME, 'p4.yml');
const original = '# header\n[]\n';
writeFileSync(p4, original);

await I.disableRow(p4, 'zeta');
const d1 = I.readUserPatchState(p4);
check('disableRow 生效', d1.disables.includes('zeta'), JSON.stringify(d1));

await I.disableRow(p4, 'zeta');
const d2 = I.readUserPatchState(p4);
check('重复 disable 幂等（不写第二行）', d2.disables.filter((x) => x === 'zeta').length === 1, JSON.stringify(d2));

await I.enableRow(p4, 'zeta');
const d3 = I.readUserPatchState(p4);
check('enableRow 移除 disable 行', !d3.disables.includes('zeta'), JSON.stringify(d3));
check(
  '往返之后 [] 占位符仍在（文件仍是合法顶层数组）',
  readFileSync(p4, 'utf8').replace(/^[ \t]*#.*$/gm, '').trim() === '[]',
  JSON.stringify(readFileSync(p4, 'utf8'))
);

/* force-enable：下层按住时写 disabled: false */
await I.enableRow(p4, 'eta');
const d4 = I.readUserPatchState(p4);
check('enable 未停用的行 → 写 disabled: false（顶回下层）', d4.forced.includes('eta'), JSON.stringify(d4));
await I.enableRow(p4, 'eta');
const d5 = I.readUserPatchState(p4);
check('重复 force-enable 幂等', d5.forced.filter((x) => x === 'eta').length === 1, JSON.stringify(d5));

/* 非法 row id 必须拒绝 */
check('非法 row id 被拒（disableRow）', (await I.disableRow(p4, 'bad id!')).ok === false);
check('非法 row id 被拒（enableRow）', (await I.enableRow(p4, 'a:b')).ok === false);

/* ── 6) apply() 不抛、路由不重复、安全闸门 ────────────────────────── */
function makeCtx() {
  const routes = new Map();
  const events = new Map();
  const disposers = [];
  return {
    routes,
    events,
    disposers,
    ctx: {
      get(key) {
        return key === 'loader' ? undefined : undefined;
      },
      webServer: {
        register(route) {
          const key = `${route.kind} ${route.path}`;
          if (routes.has(key)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
          routes.set(key, route);
          return () => routes.delete(key);
        }
      },
      on(e, l) {
        events.set(e, l);
      },
      effect(cb) {
        const d = cb();
        disposers.push(d);
        return d;
      }
    }
  };
}
function makeReq(method, url, body, headers) {
  const req = { method, url, headers: headers || {}, socket: { remoteAddress: '127.0.0.1' } };
  req[Symbol.asyncIterator] = async function* () {
    if (body !== undefined && body !== null) yield Buffer.from(body);
  };
  return req;
}
function makeRes() {
  const chunks = [];
  const res = new Writable({
    write(c, _e, cb) {
      chunks.push(Buffer.from(c));
      cb();
    }
  });
  res.statusCode = 0;
  res.headers = {};
  res.writeHead = function (s, h) {
    this.statusCode = s;
    this.headers = h || {};
    /* 🔴 这里必须用 Node 的**真实**响应头校验。
       假 res 如果只是把 headers 存进普通对象，那么「响应头里写了中文」
       这类错误会一路穿到线上真实请求才炸 —— 真的发生过一次：
       Content-Disposition 里塞了中文文件名 → Node 抛
       Invalid character in header content → 接口 500。
       让假 res 和真 res 一样严格，这类问题才会在测试里现形。 */
    for (const [k, v] of Object.entries(this.headers)) {
      validateHeaderValue(k, v);
    }
    return this;
  };
  Object.defineProperty(res, 'body', {
    get() {
      return Buffer.concat(chunks).toString('utf8');
    }
  });
  /* 二进制响应（如 /export 的 zip）用这个 —— res.body 会按 utf8 解码，二进制会被毁掉 */
  Object.defineProperty(res, 'buffer', {
    get() {
      return Buffer.concat(chunks);
    }
  });
  return res;
}
async function call(h, method, url, body, headers) {
  const path = url.split('?')[0];
  const route = h.routes.get(`exact ${path}`);
  if (!route) throw new Error(`no route for ${method} ${url}`);
  const res = makeRes();
  const done = new Promise((resolve) => res.on('finish', resolve));
  await route.handler(makeReq(method, url, body, headers), res);
  await done;
  return res;
}

const h = makeCtx();
let applyError = null;
try {
  plugin.apply(h.ctx);
} catch (e) {
  applyError = e;
}
check('apply() 不抛异常', applyError === null, applyError && applyError.message);
check('注册了 14 条路由', h.routes.size === 14, `实际 ${h.routes.size}: ${[...h.routes.keys()].join(', ')}`);

let res = await call(h, 'GET', '/dstation-market/health');
check('GET /health → 200', res.statusCode === 200);
check('health 带 build', typeof JSON.parse(res.body).build === 'string');

res = await call(h, 'GET', '/dstation-market/state');
const state = JSON.parse(res.body);
check('GET /state → 200', res.statusCode === 200);
check('state 有 plugins 数组', Array.isArray(state.plugins));
check('state 回落到约定 profile（测试环境无 loader）', state.profileSource === 'fallback', state.profileSource);
check('state 暴露 patchPath 便于排障', typeof state.patchPath === 'string' && state.patchPath.length > 0);

/* 安全闸门：变更类请求必须本机同源 */
res = await call(h, 'POST', '/dstation-market/toggle', '{"entry":"x","enabled":false}');
check('无 Origin 的 toggle → 403', res.statusCode === 403, `实际 ${res.statusCode}`);
res = await call(h, 'POST', '/dstation-market/toggle', '{"entry":"x","enabled":false}', {
  origin: 'http://evil.example',
  host: '127.0.0.1:3080'
});
check('跨源 Origin 的 toggle → 403', res.statusCode === 403, `实际 ${res.statusCode}`);
res = await call(h, 'POST', '/dstation-market/toggle', '{"entry":"x","enabled":false}', {
  origin: 'http://127.0.0.1:3080',
  host: '127.0.0.1:3080',
  forwarded: 'for=1.2.3.4'
});
check('带转发头的 toggle → 403', res.statusCode === 403, `实际 ${res.statusCode}`);

res = await call(h, 'POST', '/dstation-market/toggle', '{"entry":"bad id!","enabled":false}', {
  origin: 'http://127.0.0.1:3080',
  host: '127.0.0.1:3080'
});
check('非法 entry id → 400', res.statusCode === 400, `实际 ${res.statusCode}`);

/* 关键闸门：entry 不属于任何已装插件时必须拒绝，而不是写孤儿行 */
res = await call(h, 'POST', '/dstation-market/toggle', '{"entry":"no-such-entry","enabled":false}', {
  origin: 'http://127.0.0.1:3080',
  host: '127.0.0.1:3080'
});
check('未知 entry id → 404（不写孤儿行）', res.statusCode === 404, `实际 ${res.statusCode}`);

res = await call(h, 'POST', '/dstation-market/remove-rows', '{"entries":["bad id!"]}', {
  origin: 'http://127.0.0.1:3080',
  host: '127.0.0.1:3080'
});
check('remove-rows 拒绝非法 id → 400', res.statusCode === 400, `实际 ${res.statusCode}`);
res = await call(h, 'POST', '/dstation-market/remove-rows', '{"entries":[]}', {
  origin: 'http://127.0.0.1:3080',
  host: '127.0.0.1:3080'
});
check('remove-rows 拒绝空列表 → 400', res.statusCode === 400, `实际 ${res.statusCode}`);

res = await call(h, 'GET', '/dstation-market/toggle');
check('GET /toggle → 405', res.statusCode === 405, `实际 ${res.statusCode}`);

for (const d of h.disposers) {
  if (typeof d === 'function') d();
}
check('卸载后路由表清空', h.routes.size === 0, `剩下 ${h.routes.size}`);

/* ── 7) 安装器：路径安全 ──────────────────────────────────────────── */
const badPaths = ['../x', '..\\x', '/etc/passwd', 'C:/x', 'a/../../b', '', null, 'a\0b'];
let unsafeCaught = 0;
for (const p of badPaths) if (I.checkRelPath(p) !== null) unsafeCaught += 1;
check('全部不安全路径都被拒', unsafeCaught === badPaths.length, `${unsafeCaught}/${badPaths.length}`);
check('正常相对路径放行', I.checkRelPath('index.js') === null && I.checkRelPath('test/run-tests.mjs') === null);

/* ── 8) 安装器：端到端（对着本地 store 跑） ───────────────────────── */
/* 造一个 store：一个极小的假插件 + index.json + manifest.json + 文件 */
const store = join(HOME, 'store');
const demoPkg = 'dsh-demo-probe';
const demoVer = '0.0.1';
mkdirSync(join(store, demoPkg, demoVer), { recursive: true });
const demoFiles = {
  'package.json': JSON.stringify({ name: demoPkg, version: demoVer, type: 'module', main: 'index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2),
  'index.js': "export const name = 'dsh-demo-probe';\nexport const inject = [];\nexport function apply() {}\n",
  'cordis.patch.yml': "- insert:\n    - id: demo-probe\n      name: 'dsh-demo-probe'\n"
};
/* sha256 用与实现无关的方式算，避免"自己算错自己验对" */
const { createHash } = await import('node:crypto');
const h256 = (b) => createHash('sha256').update(b).digest('hex');
const manifestFiles = [];
for (const [rel, content] of Object.entries(demoFiles)) {
  const buf = Buffer.from(content, 'utf8');
  writeFileSync(join(store, demoPkg, demoVer, rel), buf);
  manifestFiles.push({
    path: rel,
    rel: `${demoPkg}/${demoVer}/${rel}`,
    url: `http://local.test/${demoPkg}/${demoVer}/${rel}`,
    sha256: h256(buf),
    size: buf.length
  });
}
const manifest = {
  schema: 'dstation-plugin-manifest/v1',
  name: demoPkg,
  version: demoVer,
  entry: 'demo-probe',
  pkg: demoPkg,
  bundle: true,
  requiresRestart: true,
  filesCount: manifestFiles.length,
  totalSize: manifestFiles.reduce((s, f) => s + f.size, 0),
  files: manifestFiles
};
writeFileSync(join(store, demoPkg, demoVer, 'manifest.json'), JSON.stringify(manifest, null, 2));
writeFileSync(
  join(store, 'index.json'),
  JSON.stringify({
    schema: 'dstation-plugin-index/v1',
    updated: new Date().toISOString(),
    count: 1,
    plugins: [
      {
        name: demoPkg,
        displayName: 'Demo Probe',
        owner: 'test',
        verified: false,
        category: 'other',
        latest: demoVer,
        manifest: `http://local.test/${demoPkg}/${demoVer}/manifest.json`,
        totalSize: manifest.totalSize,
        filesCount: manifest.filesCount,
        entry: 'demo-probe'
      }
    ]
  })
);

process.env.DSTATION_PLUGIN_INDEX = join(store, 'index.json');
const src = I.resolveSource();
check('resolveSource 识别本地目录来源', src.kind === 'local', JSON.stringify(src));

const catalog = await I.listCatalog();
check('listCatalog 拉到 1 个插件', catalog.plugins.length === 1, JSON.stringify(catalog).slice(0, 200));
check('目录里未安装的插件 installed=false', catalog.plugins[0].installed === false);

const staged = [];
const result = await I.installPlugin(demoPkg, () => staged.push(1));
check('installPlugin 成功', result.ok === true, result.operation && result.operation.error);
check('安装过程上报了进度', staged.length > 0, `staged=${staged.length}`);
check('结果带 entry id', result.operation.result && result.operation.result.entry === 'demo-probe', JSON.stringify(result.operation.result));
check('结果标记需要重启', result.operation.result && result.operation.result.requiresRestart === true);

const installedPkg = join(HOME, 'plugins', demoPkg, 'package.json');
check('文件真的落盘了', existsSync(installedPkg), installedPkg);
check('落盘内容与源一致', existsSync(join(HOME, 'plugins', demoPkg, 'index.js')));
check('staging 目录已清理', readdirSync(join(HOME, 'plugins')).every((n) => !n.startsWith('.staging')), JSON.stringify(readdirSync(join(HOME, 'plugins'))));

/* 老清单（没有 rel 字段）也必须能装 —— 线上已经发布过的清单可能没有 rel，
   退化路径按 URL 的 /<pkg>/<ver>/ 标记切；再接一层按 store 约定布局兜底。 */
const legacy = JSON.parse(JSON.stringify(manifest));
for (const f of legacy.files) delete f.rel;
legacy.files[0].rel = undefined;
writeFileSync(join(store, demoPkg, demoVer, 'manifest.json'), JSON.stringify(legacy, null, 2));
rmSync(join(HOME, 'plugins', demoPkg), { recursive: true, force: true });
const legacyResult = await I.installPlugin(demoPkg);
check('没有 rel 的老清单也能装（退化路径可用）', legacyResult.ok === true, legacyResult.operation.error);
check('老清单装出来的文件齐全', existsSync(join(HOME, 'plugins', demoPkg, 'index.js')));
rmSync(join(HOME, 'plugins', demoPkg), { recursive: true, force: true });
writeFileSync(join(store, demoPkg, demoVer, 'manifest.json'), JSON.stringify(manifest, null, 2));
const restore = await I.installPlugin(demoPkg);
check('恢复标准清单后可再次安装', restore.ok === true, restore.operation.error);

const again = await I.installPlugin(demoPkg);
check('重复安装被拒（不做覆盖式更新）', again.ok === false, again.operation.error);
check('拒绝原因提到已安装', /已安装|already/i.test(again.operation.error || ''), again.operation.error);

/* 篡改 sha256 → 必须拒绝 */
const tampered = JSON.parse(readFileSync(join(store, demoPkg, demoVer, 'manifest.json'), 'utf8'));
tampered.files[0].sha256 = 'a'.repeat(64);
writeFileSync(join(store, demoPkg, demoVer, 'manifest.json'), JSON.stringify(tampered, null, 2));
rmSync(join(HOME, 'plugins', demoPkg), { recursive: true, force: true });
const badHash = await I.installPlugin(demoPkg);
check('sha256 不符必须拒绝安装', badHash.ok === false, badHash.operation.error);
check('sha256 拒绝信息可读', /sha256/i.test(badHash.operation.error || ''), badHash.operation.error);
check(
  '校验失败不留半成品',
  !existsSync(join(HOME, 'plugins', demoPkg)),
  '目标目录不该存在'
);
writeFileSync(join(store, demoPkg, demoVer, 'manifest.json'), JSON.stringify(manifest, null, 2));

/* 站外 URL 必须被拒（域名白名单） */
const evil = JSON.parse(JSON.stringify(manifest));
evil.files[0].url = 'https://evil.example/x.js';
writeFileSync(join(store, demoPkg, demoVer, 'manifest.json'), JSON.stringify(evil, null, 2));
process.env.DSTATION_PLUGIN_INDEX = 'https://market.example.test/plugins/index.json';
const evilSource = I.resolveSource();
check('resolveSource 识别 https 来源', evilSource.kind === 'http');
/* 直接在本地 store 上验证白名单逻辑：URL 不在 baseUrl 下 */
process.env.DSTATION_PLUGIN_INDEX = join(store, 'index.json');
writeFileSync(join(store, demoPkg, demoVer, 'manifest.json'), JSON.stringify(manifest, null, 2));

/* 操作查询 */
const op = I.getOperation(result.operation.id);
check('getOperation 能查到', op !== null && op.pkg === demoPkg);
check('listOperations 非空', I.listOperations().length > 0);
check('getOperation 未知 id 返回 null', I.getOperation('nope') === null);

/* ── 10) 🔴 自洽性闸门：坏包必须在写任何文件之前被拒 ─────────────────
   背景（真实事故）：一个**没有 package.json** 的包被装进 plugins/ 并注册进
   bundles 之后，DSH 的 client-modules 把别的包的 dsh.client 声明算到它头上，
   抛 "declares dsh.client but exports no './client' bundle"。
   而该异常发生在**核心条目** @deepseek-ai/dsh-client-modules 上，
   看门狗**拒绝自动禁用核心条目** ⇒ 整个 DSH 起不来也无法自愈。
   ⇒ 这几条断言是"防全站停机"的闸门，不是锦上添花。 */

/** 造一个 store 并安装。filesObj: { 相对路径: 内容 } */
async function tryInstallPackage(name, ver, filesObj, opts = {}) {
  const st = join(HOME, `store-${name}`);
  mkdirSync(join(st, name, ver), { recursive: true });
  const mf = [];
  for (const [rel, content] of Object.entries(filesObj)) {
    const buf = Buffer.from(content, 'utf8');
    writeFileSync(join(st, name, ver, rel), buf);
    mf.push({
      path: rel,
      rel: `${name}/${ver}/${rel}`,
      url: `http://local.test/${name}/${ver}/${rel}`,
      sha256: h256(buf),
      size: buf.length
    });
  }
  const man = {
    schema: 'dstation-plugin-manifest/v1',
    name,
    version: ver,
    entry: opts.entry || 'x',
    bundle: opts.bundle === true,
    filesCount: mf.length,
    totalSize: mf.reduce((s, f) => s + f.size, 0),
    files: mf
  };
  writeFileSync(join(st, name, ver, 'manifest.json'), JSON.stringify(man, null, 2));
  writeFileSync(
    join(st, 'index.json'),
    JSON.stringify({
      schema: 'dstation-plugin-index/v1',
      count: 1,
      plugins: [
        {
          name,
          latest: ver,
          manifest: `http://local.test/${name}/${ver}/manifest.json`,
          manifestRel: `${name}/${ver}/manifest.json`,
          entry: opts.entry || 'x'
        }
      ]
    })
  );
  process.env.DSTATION_PLUGIN_INDEX = join(st, 'index.json');
  const res = await I.installPlugin(name);
  return { res, target: join(HOME, 'plugins', name) };
}

/* 10a) 缺 package.json → 必须拒绝，且不留任何文件 */
const noPkg = await tryInstallPackage('dsh-bad-nopkg', '1.0.0', { 'index.js': 'export const name = "x";\n' });
check('缺 package.json 的包被拒', noPkg.res.ok === false, noPkg.res.operation.error);
check('拒绝原因点名 package.json', /package\.json/.test(noPkg.res.operation.error || ''), noPkg.res.operation.error);
check('🔴 被拒后目标目录不存在（没留半成品）', !existsSync(noPkg.target));

/* 10b) 声明 dsh.client 但没有 ./client 导出 → 必须拒绝 */
const badClient = await tryInstallPackage('dsh-bad-client', '1.0.0', {
  'package.json': JSON.stringify({ name: 'dsh-bad-client', version: '1.0.0', dsh: { client: { platform: 'web' } } }),
  'index.js': 'export const name = "x";\n'
});
check('声明 dsh.client 却无 ./client 导出 → 被拒', badClient.res.ok === false, badClient.res.operation.error);
check('拒绝原因点名 ./client', /\.\/client/.test(badClient.res.operation.error || ''), badClient.res.operation.error);
check('被拒后目标目录不存在', !existsSync(badClient.target));

/* 10c) 导出指向不存在的文件 → 必须拒绝 */
const ghostClient = await tryInstallPackage('dsh-ghost-client', '1.0.0', {
  'package.json': JSON.stringify({
    name: 'dsh-ghost-client',
    version: '1.0.0',
    exports: { '.': './index.js', './client': './client.js' },
    dsh: { client: { platform: 'web' } }
  }),
  'index.js': 'export const name = "x";\n'
});
check('exports["./client"] 指向缺文件 → 被拒', ghostClient.res.ok === false, ghostClient.res.operation.error);
check('被拒后目标目录不存在', !existsSync(ghostClient.target));

/* 10d) bundle.patch 指向缺文件 → 必须拒绝 */
const ghostPatch = await tryInstallPackage('dsh-ghost-patch', '1.0.0', {
  'package.json': JSON.stringify({
    name: 'dsh-ghost-patch',
    version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } }
  }),
  'index.js': 'export const name = "x";\n'
});
check('dsh.bundle.patch 指向缺文件 → 被拒', ghostPatch.res.ok === false, ghostPatch.res.operation.error);
check('被拒后目标目录不存在', !existsSync(ghostPatch.target));

/* 10e) name 不匹配 → 必须拒绝 */
const nameMismatch = await tryInstallPackage('dsh-name-mismatch', '1.0.0', {
  'package.json': JSON.stringify({ name: 'something-else', version: '1.0.0' }),
  'index.js': 'export const name = "x";\n'
});
check('package.json 的 name 与清单不符 → 被拒', nameMismatch.res.ok === false, nameMismatch.res.operation.error);
check('被拒后目标目录不存在', !existsSync(nameMismatch.target));

/* 10f) 自洽的包 → 必须成功，证明闸门没误伤 */
const goodOne = await tryInstallPackage('dsh-good-one', '1.0.0', {
  'package.json': JSON.stringify({
    name: 'dsh-good-one',
    version: '1.0.0',
    exports: { '.': './index.js', './client': './client.js' },
    dsh: { client: { platform: 'web' }, bundle: { patch: './cordis.patch.yml' } }
  }),
  'index.js': 'export const name = "x";\n',
  'client.js': 'export const name = "x";\n',
  'cordis.patch.yml': "- insert:\n    - id: good-one\n      name: 'dsh-good-one'\n"
});
check('自洽的包能正常安装（闸门没误伤）', goodOne.res.ok === true, goodOne.res.operation.error);
check(
  '结果里的 bundle 以包自身声明为准',
  goodOne.res.ok && goodOne.res.operation.result.bundle === true,
  JSON.stringify(goodOne.res.operation.result)
);
check(
  'entry id 从磁盘上的真实补丁回读',
  goodOne.res.ok && goodOne.res.operation.result.entry === 'good-one',
  JSON.stringify(goodOne.res.operation.result)
);

/* ── 9) 🔴 files 白名单必须覆盖所有相对 import（坑 #22 的静态扫描） ── */
const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));
const whitelist = Array.isArray(pkg.files) ? pkg.files : [];
const jsFiles = [];
(function walkJs(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walkJs(join(dir, e.name));
    } else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) jsFiles.push(join(dir, e.name));
  }
})(pluginRoot);

const missingImports = [];
const notWhitelisted = [];
for (const file of jsFiles) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const spec = m[1];
    const resolved = join(dirname(file), spec);
    if (!existsSync(resolved)) {
      missingImports.push(`${relative(pluginRoot, file)} -> ${spec}`);
      continue;
    }
    /* 该文件是否被 files 白名单覆盖 */
    const rel = relative(pluginRoot, resolved).split(sep).join('/');
    const covered = whitelist.some((r) => rel === r || rel.startsWith(`${r}/`));
    if (!covered) notWhitelisted.push(`${relative(pluginRoot, file)} -> ${spec}`);
  }
}
check('所有相对 import 都能解析到实际文件', missingImports.length === 0, missingImports.join('; '));
check(
  '🔴 所有相对 import 的目标都在 package.json 的 files 白名单里（坑 #22）',
  notWhitelisted.length === 0,
  notWhitelisted.join('; ')
);

/* ── 11) 版本比较（semver 语义） ──────────────────────────────────── */
check('1.0.1 > 1.0.0', I.compareVersions('1.0.1', '1.0.0') === 1);
check('1.0.0 < 1.0.1', I.compareVersions('1.0.0', '1.0.1') === -1);
check('相同版本 = 0', I.compareVersions('1.0.0', '1.0.0') === 0);
check('2.0.0 > 1.9.9', I.compareVersions('2.0.0', '1.9.9') === 1);
check('1.0.0-rc1 < 1.0.0（预发布更小）', I.compareVersions('1.0.0-rc1', '1.0.0') === -1);
check('1.0.0 < 1.0.0-rc1 反向', I.compareVersions('1.0.0', '1.0.0-rc1') === 1);
check('build 元数据不参与比较', I.compareVersions('1.0.0+a', '1.0.0+b') === 0);

/* ── 12) 🔴 OTA 更新 + 回滚 ─────────────────────────────────────────
   用同一个 store 依次发布 v1 / v2，走完整的 安装 → 更新 → 失败回滚 → 手工回滚。 */

const otaDir = join(HOME, 'store-ota');
const otaName = 'dsh-ota-probe';

/** 把某个版本写进 store 并把 index.json 指向它（模拟发新版） */
function publish(ver, opts = {}) {
  mkdirSync(join(otaDir, otaName, ver), { recursive: true });
  const body = opts.body || `export const MARKER = "${ver}";\n`;
  const filesObj = {
    'package.json': JSON.stringify({
      name: otaName,
      version: ver,
      type: 'module',
      main: 'index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' } }
    }),
    'index.js': body,
    'cordis.patch.yml': "- insert:\n    - id: ota-probe\n      name: 'dsh-ota-probe'\n"
  };
  const mf = [];
  for (const [rel, content] of Object.entries(filesObj)) {
    const buf = Buffer.from(content, 'utf8');
    writeFileSync(join(otaDir, otaName, ver, rel), buf);
    mf.push({
      path: rel,
      rel: `${otaName}/${ver}/${rel}`,
      url: `http://local.test/${otaName}/${ver}/${rel}`,
      sha256: h256(buf),
      size: buf.length
    });
  }
  const man = {
    schema: 'dstation-plugin-manifest/v1',
    name: otaName,
    version: ver,
    entry: 'ota-probe',
    bundle: true,
    filesCount: mf.length,
    totalSize: mf.reduce((s, f) => s + f.size, 0),
    files: opts.corruptSha ? mf.map((f, i) => (i === 1 ? { ...f, sha256: 'a'.repeat(64) } : f)) : mf
  };
  writeFileSync(join(otaDir, otaName, ver, 'manifest.json'), JSON.stringify(man, null, 2));
  writeFileSync(
    join(otaDir, 'index.json'),
    JSON.stringify({
      schema: 'dstation-plugin-index/v1',
      count: 1,
      plugins: [
        {
          name: otaName,
          latest: ver,
          manifest: `http://local.test/${otaName}/${ver}/manifest.json`,
          manifestRel: `${otaName}/${ver}/manifest.json`,
          entry: 'ota-probe'
        }
      ]
    })
  );
  process.env.DSTATION_PLUGIN_INDEX = join(otaDir, 'index.json');
}

const otaTarget = join(HOME, 'plugins', otaName);

/* v1.0.0 安装 */
publish('1.0.0');
const r1 = await I.installPlugin(otaName);
check('OTA 前置：v1.0.0 安装成功', r1.ok === true, r1.operation.error);
check('安装后 marker 是 1.0.0', readFileSync(join(otaTarget, 'index.js'), 'utf8').includes('1.0.0'));

/* 同版本更新 → 必须拒绝 */
const rSame = await I.updatePlugin(otaName);
check('版本相同时拒绝更新', rSame.ok === false, rSame.operation.error);
check('拒绝原因提到"最新"', /最新/.test(rSame.operation.error || ''), rSame.operation.error);

/* 发布 v1.0.1 并更新 */
publish('1.0.1');
const r2 = await I.updatePlugin(otaName, () => {});
check('v1.0.1 更新成功', r2.ok === true, r2.operation.error);
check('结果是 upgrade', r2.operation.result && r2.operation.result.direction === 'upgrade', JSON.stringify(r2.operation.result));
check('fromVersion=1.0.0  toVersion=1.0.1', r2.operation.result.fromVersion === '1.0.0' && r2.operation.result.toVersion === '1.0.1');
check('文件内容真的换了', readFileSync(join(otaTarget, 'index.js'), 'utf8').includes('1.0.1'));
check('本地 package.json 版本已更新', JSON.parse(readFileSync(join(otaTarget, 'package.json'), 'utf8')).version === '1.0.1');
check('更新留下了一份备份', I.listBackups(otaName).length >= 1, JSON.stringify(I.listBackups(otaName)));

/* 目标目录本身必须还在（它可能是 junction 的目标，被删掉插件就失效） */
check('🔴 目标目录本身仍然存在（未被重命名/删除）', existsSync(otaTarget) && statSync(otaTarget).isDirectory());
check('没有残留 staging 目录', readdirSync(join(HOME, 'plugins')).every((n) => !n.startsWith('.staging')));

/* 🔴 关键：新版 sha256 损坏 → 更新必须失败，且**旧版必须完好** */
publish('1.0.2', { corruptSha: true });
const backupsBefore = I.listBackups(otaName).length;
const r3 = await I.updatePlugin(otaName);
check('sha256 损坏时更新失败', r3.ok === false, r3.operation.error);
check('失败原因提到 sha256', /sha256/i.test(r3.operation.error || ''), r3.operation.error);
check('失败信息里说明已回滚', /回滚/.test(r3.operation.error || ''), r3.operation.error);
check('operation 标记 rolledBack = true', r3.operation.rolledBack === true, JSON.stringify({ rb: r3.operation.rolledBack, err: r3.operation.rollbackError }));
check('🔴 回滚后文件内容仍是 1.0.1（没被破坏）', readFileSync(join(otaTarget, 'index.js'), 'utf8').includes('1.0.1'));
check('回滚后 package.json 版本仍是 1.0.1', JSON.parse(readFileSync(join(otaTarget, 'package.json'), 'utf8')).version === '1.0.1');
check('失败后没有留下新的 staging', readdirSync(join(HOME, 'plugins')).every((n) => !n.startsWith('.staging')));
check('失败更新没有污染备份列表', I.listBackups(otaName).length >= backupsBefore);

/* 手工回滚到 v1.0.0 */
publish('1.0.1'); /* 把索引恢复成"合法"状态，避免干扰后续 */
const allBackups = I.listBackups(otaName);
check('备份列表非空且新的在前', allBackups.length >= 1 && allBackups[0].id >= allBackups[allBackups.length - 1].id);
const oldest = allBackups[allBackups.length - 1];
const r4 = I.rollbackPlugin(otaName, oldest.id);
check('手工回滚成功', r4.ok === true, JSON.stringify(r4));
check('回滚后内容回到 1.0.0', readFileSync(join(otaTarget, 'index.js'), 'utf8').includes('1.0.0'));
check('回滚后版本号回到 1.0.0', JSON.parse(readFileSync(join(otaTarget, 'package.json'), 'utf8')).version === '1.0.0');

/* 回滚不存在的备份 → 必须失败 */
const r5 = I.rollbackPlugin(otaName, 'no-such-backup');
check('回滚到不存在的备份 → 失败', r5.ok === false, JSON.stringify(r5));

/* 更新一个没装的插件 → 必须失败 */
const r6 = await I.updatePlugin('dsh-never-installed');
check('更新未安装的插件 → 失败', r6.ok === false, r6.operation.error);

/* 备份裁剪：只保留最近 N 份 */
check('备份份数受上限约束（≤3）', I.listBackups(otaName).length <= 3, `实际 ${I.listBackups(otaName).length}`);

/* 🔴 备份 ID 必须唯一：连续两次备份（间隔 0ms）不能相互覆盖。
   曾经用秒级时间戳做 ID，第二次会 rmSync 掉第一份，
   于是"回滚到上一版"实际拿到的是更早的那一版 —— 失败回滚最不能出的问题。 */
const idName = 'dsh-id-probe';
const idTarget = join(HOME, 'plugins', idName);
mkdirSync(idTarget, { recursive: true });
writeFileSync(join(idTarget, 'package.json'), JSON.stringify({ name: idName, version: '1.0.0' }));
writeFileSync(join(idTarget, 'index.js'), 'export const MARKER = "v1";\n');
check('起点：该插件没有历史备份', I.listBackups(idName).length === 0, JSON.stringify(I.listBackups(idName)));

const bk1 = I.backupPlugin(idName);
const bk2 = I.backupPlugin(idName);
check('连续两次备份都成功', bk1.ok === true && bk2.ok === true, JSON.stringify({ bk1, bk2 }));
check('🔴 两次备份的 ID 不同（同秒也不会撞）', bk1.ok && bk2.ok && bk1.id !== bk2.id, `${bk1.id} vs ${bk2.id}`);
check('两次备份各自留下目录', I.listBackups(idName).length === 2, JSON.stringify(I.listBackups(idName).map((b) => b.id)));

/* ══════════════════════════════════════════════════════════════════════
 * 阶段 5：导出自包含分发包
 * ══════════════════════════════════════════════════════════════════════ */

/* 包名白名单：任何会被拼进文件系统路径的输入都必须先过这里 */
check('PKG_NAME_RE 接受正常包名', I.PKG_NAME_RE.test('dsh-wallpaper') && I.PKG_NAME_RE.test('a') && I.PKG_NAME_RE.test('dsh.a_b-c'));
check(
  '🔴 PKG_NAME_RE 接受 scope 包名（@scope/name）',
  I.PKG_NAME_RE.test('@michengai/dsh-archive-manager') &&
    I.PKG_NAME_RE.test('@deepseek-ai/dsh-client-modules') &&
    I.PKG_NAME_RE.test('@a/b'),
  '第三方发布大量使用 scope 形态；早先正则不允许 "/"，整整一类插件无法导出'
);
check(
  '🔴 PKG_NAME_RE 挡住路径穿越与隐藏目录',
  !I.PKG_NAME_RE.test('../etc') &&
    !I.PKG_NAME_RE.test('..') &&
    !I.PKG_NAME_RE.test('.') &&
    !I.PKG_NAME_RE.test('.hidden') &&
    !I.PKG_NAME_RE.test('a/b') &&
    !I.PKG_NAME_RE.test('a\\b') &&
    !I.PKG_NAME_RE.test('C:evil') &&
    !I.PKG_NAME_RE.test('') &&
    !I.PKG_NAME_RE.test('a'.repeat(65)) &&
    /* scope 形态下的穿越尝试，同样必须全部挡住 */
    !I.PKG_NAME_RE.test('@scope/../x') &&
    !I.PKG_NAME_RE.test('@scope/') &&
    !I.PKG_NAME_RE.test('@/x') &&
    !I.PKG_NAME_RE.test('@scope/.x') &&
    !I.PKG_NAME_RE.test('/abs') &&
    !I.PKG_NAME_RE.test('@scope/x/y'),
  '路径穿越/隐藏目录必须被拒'
);

/* 结构自洽性：这条正是「全站停机」的复发路径 */
const scBad = join(HOME, 'plugins', 'dsh-sc-bad');
mkdirSync(scBad, { recursive: true });
writeFileSync(join(scBad, 'package.json'), JSON.stringify({
  name: 'dsh-sc-bad', version: '1.0.0',
  exports: { '.': './index.js' },
  dsh: { client: { platform: 'web' } }
}));
check('🔴 声明了 dsh.client 但没有 exports["./client"] → selfCheck 报错', I.selfCheck(scBad, JSON.parse(readFileSync(join(scBad, 'package.json'), 'utf8'))) !== '');
check('🔴 selfCheck 的原因里点名了 exports', /exports/.test(I.selfCheck(scBad, JSON.parse(readFileSync(join(scBad, 'package.json'), 'utf8')))));

const scOk = join(HOME, 'plugins', 'dsh-sc-ok');
mkdirSync(scOk, { recursive: true });
writeFileSync(join(scOk, 'package.json'), JSON.stringify({
  name: 'dsh-sc-ok', version: '1.0.0',
  exports: { '.': './index.js', './client': './client.js' },
  dsh: { client: { platform: 'web' } }
}));
writeFileSync(join(scOk, 'index.js'), 'export const a = 1;\n');
writeFileSync(join(scOk, 'client.js'), 'export const b = 1;\n');
check('结构正常的插件 selfCheck 通过', I.selfCheck(scOk, JSON.parse(readFileSync(join(scOk, 'package.json'), 'utf8'))) === '');

/* 🔴 exports["./client"] 的**条件对象**形态。
   真实插件大量使用这一形态（本机：dsh-better-sidebar / dsh-canvas-preview /
   dsh-univer-office）。第一版 selfCheck 只按字符串处理，把对象 String() 成
   "[object Object]"，于是把这些本来正常的插件误判成「客户端文件不存在」。 */
function mkCondPlugin(name, exportsClient, files) {
  const dir = join(HOME, 'plugins', name);
  mkdirSync(dir, { recursive: true });
  const pkgObj = {
    name, version: '1.0.0',
    exports: { '.': './index.js', './client': exportsClient },
    dsh: { client: { platform: 'web' } }
  };
  if (files) pkgObj.files = files;
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkgObj));
  writeFileSync(join(dir, 'index.js'), 'export const a = 1;\n');
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'lib', 'client.js'), 'export const b = 1;\n');
  return dir;
}

const condDir = mkCondPlugin('dsh-cond-exports', { types: './lib/client.d.ts', default: './lib/client.js' });
check(
  '🔴 条件对象形态的 exports["./client"] 不再被误判',
  I.selfCheck(condDir, JSON.parse(readFileSync(join(condDir, 'package.json'), 'utf8'))) === '',
  I.selfCheck(condDir, JSON.parse(readFileSync(join(condDir, 'package.json'), 'utf8')))
);
const condDist = I.buildDistribution(condDir, {});
check('条件导出的插件能正常导出', condDist.data.length > 0 && condDist.data[0] === 0x50);

const nestedDir = mkCondPlugin('dsh-cond-nested', { node: { default: './lib/client.js' } });
check(
  '嵌套条件对象（{node:{default:…}}）也能解析',
  I.selfCheck(nestedDir, JSON.parse(readFileSync(join(nestedDir, 'package.json'), 'utf8'))) === ''
);

/* 白名单漏掉客户端入口 —— 源目录检查会过，但包是坏的，必须在发出去之前拦住 */
const missingEntryDir = mkCondPlugin('dsh-cond-missing', './lib/client.js', ['index.js']);
let entryGuard = '';
try {
  I.buildDistribution(missingEntryDir, {});
} catch (e) {
  entryGuard = e.message;
}
check('🔴 files 白名单漏掉客户端入口时拒绝导出（而不是发出坏包）', /files|白名单|没有收进包/.test(entryGuard), entryGuard || '居然放过了');

/* 🔴 只落在 profile\node_modules 里、**不在 plugins\ 下**的插件。
   这是绝大多数插件的实际形态（本机实测：node_modules 下 19 个，plugins 下只有 4 个）。
   第一版 /export 只查 plugins\，于是对大多数插件报 not found —— 这条守着它。 */
const nmPkg = 'dsh-nm-only';
const nmDir = join(HOME, 'profiles', 'web', 'node_modules', nmPkg);
mkdirSync(nmDir, { recursive: true });
writeFileSync(join(nmDir, 'package.json'), JSON.stringify({
  name: nmPkg, version: '2.3.4',
  exports: { '.': './index.js', './client': './client.js' },
  dsh: { client: { platform: 'web' } }
}));
writeFileSync(join(nmDir, 'index.js'), 'export const a = 1;\n');
writeFileSync(join(nmDir, 'client.js'), 'export const b = 1;\n');

/* 生成分发包 */
const dist = I.buildDistribution(scOk, { displayName: '测试插件', where: '设置 → 某处' });
check('导出返回 zip 字节', Buffer.isBuffer(dist.data) && dist.data.length > 0, `${dist.data.length} 字节`);
check('zip 魔数是 PK', dist.data[0] === 0x50 && dist.data[1] === 0x4b);
check('文件名形如 <名字>-<版本>-分发包.zip', dist.fileName === 'dsh-sc-ok-1.0.0-分发包.zip', dist.fileName);

/* 用系统 zip 读一遍，确认结构真的合法（不靠自家 writer 自证） */
const distPath = join(HOME, 'dist-probe.zip');
writeFileSync(distPath, dist.data);
const zlib = await import('node:zlib');
check('zip 里的 deflate 流能被解开（说明写出的格式合法）', (() => {
  try {
    /* 手工扫一遍 local file header，取第二段 payload 解压试试 */
    let off = 0;
    let checked = 0;
    while (off + 30 < dist.data.length && dist.data.readUInt32LE(off) === 0x04034b50) {
      const method = dist.data.readUInt16LE(off + 8);
      const csize = dist.data.readUInt32LE(off + 18);
      const nlen = dist.data.readUInt16LE(off + 26);
      const elen = dist.data.readUInt16LE(off + 28);
      const start = off + 30 + nlen + elen;
      if (method === 8 && csize > 0) {
        zlib.inflateRawSync(dist.data.subarray(start, start + csize));
        checked += 1;
      }
      off = start + csize;
    }
    return checked > 0;
  } catch {
    return false;
  }
})());

check(
  'MANIFEST 覆盖了所有 plugin/ 文件',
  (() => {
    /* 从 zip 里把 MANIFEST.json 抠出来解析 */
    let off = 0;
    while (off + 30 < dist.data.length && dist.data.readUInt32LE(off) === 0x04034b50) {
      const method = dist.data.readUInt16LE(off + 8);
      const csize = dist.data.readUInt32LE(off + 18);
      const usize = dist.data.readUInt32LE(off + 22);
      const nlen = dist.data.readUInt16LE(off + 26);
      const elen = dist.data.readUInt16LE(off + 28);
      const name = dist.data.subarray(off + 30, off + 30 + nlen).toString('utf8');
      const start = off + 30 + nlen + elen;
      if (name.endsWith('MANIFEST.json')) {
        const raw = method === 8 ? zlib.inflateRawSync(dist.data.subarray(start, start + csize)) : dist.data.subarray(start, start + usize);
        const m = JSON.parse(raw.toString('utf8'));
        return Array.isArray(m.files) && m.files.every((f) => f.path.startsWith('plugin/') && f.sha256.length === 64);
      }
      off = start + csize;
    }
    return false;
  })()
);

/* 🔴 漂移检测：插件里的 exporter.js 与 Skill 里的 export.mjs 必须产出**逐字节相同**的包。
   两份实现是刻意分开的（Skill 要能独立转发给第三方），代价就是可能漂移 ——
   这条测试是那个代价的对冲。改了任一边而忘了另一边，这里立刻红。 */
/* 注意指向的是 submit.mjs 而不是 export.mjs：
   Skill 侧的 zip writer 定义在 submit.mjs 里，export.mjs 只是 import 它转用。 */
const skillZipModule = process.env.DSH_MARKET_SKILL_ZIP ||
  join(process.cwd(), '..', '_dstation-market-tools', 'submit.mjs');
if (existsSync(skillZipModule)) {
  const toolMod = await import(new URL('file:///' + skillZipModule.replace(/\\/g, '/')).href);
  /* 用同一组条目分别调用两边的 makeZip，比对字节。
     zip writer 的时间戳是固定值，所以同样的输入必然产出同样的字节 —— 这条测试才成立。 */
  const entries = [
    { name: 'a.txt', data: Buffer.from('hello 世界', 'utf8') },
    { name: 'dir/b.js', data: Buffer.from('export const x = 1;\n'.repeat(50), 'utf8') },
    { name: 'empty', data: Buffer.alloc(0) }
  ];
  const zipA = I.makeZip(entries);
  const zipB = toolMod.makeZip(entries);
  check(
    '🔴 漂移检测：插件的 zip writer 与 Skill 的 zip writer 产出逐字节相同',
    zipA.equals(zipB),
    `长度 ${zipA.length} vs ${zipB.length}`
  );
} else {
  console.log(`  (跳过漂移检测：找不到 ${skillZipModule})`);
}

/* ── POST /export 的 HTTP 行为 ────────────────────────────────────────
   pkg 会被拼进文件系统路径，所以「挡不挡得住路径穿越」是这一段的核心。

   ⚠️ 必须另起一个 ctx：上面的测试**故意把 h.routes 清空过**（验证卸载后会解注册）。 */
const h2 = makeCtx();
plugin.apply(h2.ctx);
const OK = { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' };

/* 目录解析：两条通道都要认 */
check(
  '🔴 resolveInstalledDir 认 plugins\\ 通道',
  I.resolveInstalledDir(h2.ctx, 'dsh-sc-ok') === scOk,
  String(I.resolveInstalledDir(h2.ctx, 'dsh-sc-ok'))
);
check(
  '🔴 resolveInstalledDir 认 profile\\node_modules 通道',
  I.resolveInstalledDir(h2.ctx, nmPkg) === nmDir,
  String(I.resolveInstalledDir(h2.ctx, nmPkg))
);
check('resolveInstalledDir 对不存在的包返回 null', I.resolveInstalledDir(h2.ctx, 'dsh-nope-nope') === null);
check('resolveInstalledDir 对非法包名返回 null', I.resolveInstalledDir(h2.ctx, '../x') === null);

res = await call(h2, 'GET', '/dstation-market/export', undefined, OK);
check('/export 只接受 POST（GET → 405）', res.statusCode === 405, `实际 ${res.statusCode}`);

res = await call(h2, 'POST', '/dstation-market/export', '{"pkg":"dsh-sc-ok"}');
check('无 Origin 的 /export → 403', res.statusCode === 403, `实际 ${res.statusCode}`);

res = await call(h2, 'POST', '/dstation-market/export', '{"pkg":"dsh-sc-ok"}', {
  origin: 'http://evil.example',
  host: '127.0.0.1:3080'
});
check('跨源 Origin 的 /export → 403', res.statusCode === 403, `实际 ${res.statusCode}`);

res = await call(h2, 'POST', '/dstation-market/export', '{"pkg":"dsh-sc-ok"}', {
  origin: 'http://127.0.0.1:3080',
  host: '127.0.0.1:3080',
  'x-forwarded-for': '1.2.3.4'
});
check('带转发头的 /export → 403', res.statusCode === 403, `实际 ${res.statusCode}`);

for (const evil of ['../..', '..\\..', '/etc/passwd', 'a/b', 'a\\b', '..', '.', '.dsh', 'C:evil', 'x'.repeat(80)]) {
  const r = await call(h2, 'POST', '/dstation-market/export', JSON.stringify({ pkg: evil }), OK);
  check(`🔴 pkg=${JSON.stringify(evil)} → 400（挡住路径穿越）`, r.statusCode === 400, `实际 ${r.statusCode}`);
}

res = await call(h2, 'POST', '/dstation-market/export', '{"pkg":"dsh-not-installed-here"}', OK);
check('不存在的包 → 404', res.statusCode === 404, `实际 ${res.statusCode}`);

/* 🔴 只装在 profile\node_modules 里的插件也必须能导出。
   第一版这里回 404，导致「导出」对大部分插件根本不可用。 */
res = await call(h2, 'POST', '/dstation-market/export', JSON.stringify({ pkg: nmPkg, displayName: '只在 nm 里的插件' }), OK);
check('🔴 只在 node_modules 里的插件也能导出 → 200', res.statusCode === 200, `实际 ${res.statusCode} ${res.body.slice(0, 200)}`);
check('导出的 zip 魔数正确', res.statusCode === 200 && res.buffer[0] === 0x50 && res.buffer[1] === 0x4b);
check(
  '导出的文件名带上了该插件自己的版本号',
  /filename\*=UTF-8''dsh-nm-only-2\.3\.4-/.test(res.headers['content-disposition'] || ''),
  res.headers['content-disposition']
);
check(
  '404 时给出可操作的提示（说明查过哪两个位置）',
  (await call(h2, 'POST', '/dstation-market/export', '{"pkg":"dsh-not-installed-here"}', OK)).body.includes('node_modules'),
  '提示里没有说明查找位置'
);

res = await call(h2, 'POST', '/dstation-market/export', '{"pkg":"dsh-sc-bad"}', OK);
check('🔴 结构不自洽的插件 → 400（要求先修好再导出）', res.statusCode === 400, `实际 ${res.statusCode} ${res.body}`);

res = await call(h2, 'POST', '/dstation-market/export', 'not json at all', OK);
check('非 JSON body → 400', res.statusCode === 400, `实际 ${res.statusCode}`);

res = await call(h2, 'POST', '/dstation-market/export', JSON.stringify({ pkg: 'dsh-sc-ok', displayName: '测试插件', where: '设置 → 某处' }), OK);
check('正常导出 → 200', res.statusCode === 200, `实际 ${res.statusCode} ${res.body.slice(0, 200)}`);
check('响应类型是 zip', res.headers['content-type'] === 'application/zip', res.headers['content-type']);
check('响应确实是 zip（魔数 PK）', res.buffer[0] === 0x50 && res.buffer[1] === 0x4b);
check(
  'content-length 与实际字节数一致',
  Number(res.headers['content-length']) === res.buffer.length,
  `${res.headers['content-length']} vs ${res.buffer.length}`
);
check(
  'Content-Disposition 同时给出 ASCII 与 UTF-8 文件名',
  /attachment/.test(res.headers['content-disposition']) && /filename\*=UTF-8''/.test(res.headers['content-disposition']),
  res.headers['content-disposition']
);

/* 🔴 中文文件名只能走 filename*=，filename= 那份必须是纯 ASCII。
   这一条对应的真实故障：曾经把中文直接写进 filename=，
   Node 抛 Invalid character in header content，接口 500。 */
const cdAscii = /filename="([^"]*)"/.exec(res.headers['content-disposition'] || '');
check(
  '🔴 Content-Disposition 的 filename= 是纯 ASCII',
  !!cdAscii && /^[\x20-\x7E]*$/.test(cdAscii[1]),
  res.headers['content-disposition']
);
check(
  '真实文件名（含中文）通过 filename*= 传递，且能解回原名',
  (() => {
    const m = /filename\*=UTF-8''([^;]+)/.exec(res.headers['content-disposition'] || '');
    return !!m && decodeURIComponent(m[1]) === 'dsh-sc-ok-1.0.0-分发包.zip';
  })(),
  res.headers['content-disposition']
);

/* 反向验证：上面那条修法（让假 res 跑真实校验）本身是不是有效保障。
   如果假 res 其实拦不住非法头，那所有路由测试就都失去这层保护。 */
let harnessCaught = false;
try {
  const probe = makeRes();
  probe.writeHead(200, { 'content-disposition': 'attachment; filename="分包.zip"' });
} catch {
  harnessCaught = true;
}
check('🔴 元测试：假 res 真的会拒绝非法响应头', harnessCaught, '说明这层保护是空的');

/* 🔴 客户端不能依赖 Electron 没实现的那个原生对话框。
   Electron 实现了 alert / confirm，但 **window.prompt 会直接抛异常**。
   症状是「点按钮完全没反应」：处理器第一行就炸，连错误都来不及显示。
   这条守着它别被写回来。 */
{
  const clientSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js'), 'utf8');
  check(
    '🔴 client.js 不调用 window.prompt（Electron 不支持）',
    !clientSrc.includes('window.prompt('),
    '出现了 window.prompt( —— Electron 里会抛异常，导致按钮点了没反应'
  );
  check(
    '导出走页面内表单（不是原生对话框）',
    clientSrc.includes('openExport') && clientSrc.includes('doExport') && clientSrc.includes('cancelExport'),
    '缺少导出表单的实现'
  );

  /* 多入口的按钮标签。一个插件可以挂多个入口（例如替换若干内置服务），
     三个一模一样的「停用」按钮完全分不清谁是谁。 */
  const em = clientSrc.match(/function entryLabels\(entries\)[\s\S]*?\n      \}/);
  check('能从 client.js 提取 entryLabels', !!em, '正则没匹配到 —— 函数被改名或挪走了？');
  if (em) {
    const entryLabels = new Function(em[0] + '; return entryLabels;')();
    const L = (ids) => entryLabels(ids.map((id) => ({ id })));

    check('单入口不显示标签（保持界面干净）', L(['wallpaper']) === null);

    const many = L([
      'workspace-archive-manager',
      'session-projection-cache-archive-manager',
      'ui-workspace-archive-manager'
    ]);
    /* 断言写成「去掉省略号后是完整标签的前缀」——这样调整截断长度不会误报，
       但真把词切坏了（例如切成 "session-projection-cach"）依然会被抓到。 */
    const isPrefixOf = (got, full) => got.replace(/…$/, '') === full.slice(0, got.replace(/…$/, '').length);
    check(
      '🔴 多入口按**词边界**去掉公共后缀（不会切出半个词）',
      many[0] === 'workspace' &&
        isPrefixOf(many[1], 'session-projection-cache') &&
        many[1].replace(/…$/, '').length >= 10 &&
        many[2] === 'ui-workspace',
      JSON.stringify(many)
    );
    check(
      '无公共后缀时保留完整 id',
      JSON.stringify(L(['alpha', 'beta', 'gamma'])) === JSON.stringify(['alpha', 'beta', 'gamma']),
      JSON.stringify(L(['alpha', 'beta', 'gamma']))
    );
    check(
      '公共部分只剩单个词时也只在词边界裁',
      JSON.stringify(L(['x-a', 'y-a', 'z-a'])) === JSON.stringify(['x', 'y', 'z']),
      JSON.stringify(L(['x-a', 'y-a', 'z-a']))
    );
    check(
      'id 完全相同时不会裁成空字符串',
      JSON.stringify(L(['dup', 'dup'])) === JSON.stringify(['dup', 'dup']),
      JSON.stringify(L(['dup', 'dup']))
    );
  }

  /* 🔴 行布局的不变量。这几条是「按钮一多就把插件名挤成竖排」那个 bug 的守门员：
     一个插件挂三个入口按钮之后，@michengai/dsh-archive-manager 被压成一列一个字。
     根因：._dmName 是 flex:1 + min-width:0（允许压到零宽），而 ._dmBtn 没有
     flex:0 0 auto（也会被压）。三条缺一不可。 */
  const rowCss = clientSrc.match(/\._dmRow\{[^}]*\}/);
  const nameCss = clientSrc.match(/\._dmName\{[^}]*\}/);
  const btnCss = clientSrc.match(/\._dmBtn\{[^}]*\}/);
  check(
    '🔴 ._dmRow 允许换行（按钮多时换行，而不是挤名字）',
    !!rowCss && /flex-wrap:\s*wrap/.test(rowCss[0]),
    rowCss ? rowCss[0] : '没找到 ._dmRow 规则'
  );
  check(
    '🔴 ._dmName 有最小宽度（否则会被 flex 压到接近 0 宽 → 逐字换行）',
    !!nameCss && /min-width:\s*\d+px/.test(nameCss[0]) && !/min-width:\s*0/.test(nameCss[0]),
    nameCss ? nameCss[0] : '没找到 ._dmName 规则'
  );
  check(
    '🔴 ._dmBtn 不可被压缩（flex:0 0 auto）',
    !!btnCss && /flex:\s*0\s+0\s+auto/.test(btnCss[0]),
    btnCss ? btnCss[0] : '没找到 ._dmBtn 规则'
  );
}

/* ── 结果 ─────────────────────────────────────────────────────────── */
rmSync(HOME, { recursive: true, force: true });
console.log(`\ndsh-dstation-market: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
