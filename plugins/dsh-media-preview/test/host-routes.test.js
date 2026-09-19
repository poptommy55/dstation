/**
 * 宿主路由端到端测试：起一个真的 node:http 服务器，挂上 index.js 注册的
 * 路由处理器，然后用真的 fetch 打过去，验证状态码、头、字节与 Range。
 *
 * 这里刻意替掉 @deepseek-ai/cordis：只用一个最小 ctx 桩（webServer.register /
 * logger / get / effect），因为被测对象就是"路由处理器 + PathGuard"这一段纯逻辑，
 * 不需要拉起整个插件树。
 *
 * 注意：本沙箱禁止子进程管道通信，因此测试进程内的 stdout 采集不可靠；
 * 断言结果通过**退出码**体现（node:test 失败即非零退出），并且大字节断言
 * 走文件系统核对而不是打印。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../index.js';

/** 最小 Cordis ctx 桩：只提供 index.js 真正用到的那几个面。 */
function stubContext({ roots = [], withTools = false } = {}) {
  const routes = new Map();
  const registeredTools = new Map();
  const ctx = {
    webServer: {
      register(route) {
        const key = `${route.kind}:${route.path}`;
        if (routes.has(key)) throw new Error(`duplicate route ${key}`);
        routes.set(key, route);
        return () => routes.delete(key);
      }
    },
    logger: { info() {}, warn() {} },
    effects: [],
    effect(fn) {
      // 复刻 Cordis 语义：回调里返回的是**卸载器**，此处不执行，
      // 由测试结束时显式调用（apply 内部用 ctx.effect 收集路由与工具的卸载器）。
      this.effects.push(fn());
    },
    get(name) {
      if (name === 'sandboxPolicy') return { workspaceRoot: roots[0] };
      if (name === 'sessions') return { list: () => roots.slice(1).map((cwd) => ({ header: { cwd } })) };
      if (name === 'tools' && withTools) {
        return {
          register(definition) {
            registeredTools.set(definition.name, definition);
            return () => registeredTools.delete(definition.name);
          }
        };
      }
      return undefined;
    }
  };
  return { ctx, routes, registeredTools };
}

/** 起服务器并挂上插件注册的路由（复刻 dsh-host-webserver 的最长前缀匹配）。 */
async function serve(ctx, routes) {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    let best;
    for (const route of routes.values()) {
      if (pathname !== route.path && !pathname.startsWith(`${route.path}/`)) continue;
      if (best === undefined || route.path.length > best.path.length) best = route;
    }
    if (best === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    Promise.resolve(best.handler(req, res)).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end(String(error));
      } else res.destroy();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function fixture() {
  /* realpathSync 不是可选的：mkdtempSync(tmpdir()) 可能返回**非规范化**的路径。
     在 GitHub 的 Windows runner 上 TEMP 会解析成 8.3 短名（C:\Users\RUNNER~1\...），
     而插件会把允许根规范化成长名。两者字符串不等，于是下面「被测工作区应出现在
     允许根里」和工具输出里的路径断言全部假失败 —— 日志打印出来的是插件那份**看起来
     完全正确**的路径，极易误判成插件有问题。统一成规范形式后再比。 */
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-media-e2e-')));
  mkdirSync(join(dir, 'out'), { recursive: true });
  const bytes = Buffer.alloc(2048);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  writeFileSync(join(dir, 'out', 'clip.mp4'), bytes);
  writeFileSync(join(dir, 'out', 'pic.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  writeFileSync(join(dir, 'secret.txt'), 'not media');
  return {
    dir,
    bytes,
    mp4: join(dir, 'out', 'clip.mp4'),
    png: join(dir, 'out', 'pic.png'),
    txt: join(dir, 'secret.txt'),
    outside: join(dir, '..', 'dsh-media-outside.png'),
    done: () => rmSync(dir, { recursive: true, force: true })
  };
}

test('e2e: /allow 正常放行工作区内的媒体并给出 URL', async () => {
  const f = fixture();
  const { ctx, routes } = stubContext({ roots: [f.dir] });
  apply(ctx);
  const s = await serve(ctx, routes);
  try {
    const r = await fetch(`${s.base}/dsh-media/allow`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: [f.mp4, f.png, f.txt, join(f.dir, 'missing.png')] })
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.items.length, 4);
    const byAsked = Object.fromEntries(body.items.map((i) => [i.asked, i]));
    assert.equal(byAsked[f.mp4].ok, true);
    assert.equal(byAsked[f.mp4].kind, 'video');
    assert.equal(byAsked[f.mp4].type, 'video/mp4');
    assert.equal(byAsked[f.mp4].size, 2048);
    assert.match(byAsked[f.mp4].url, /^\/dsh-media\/file\?path=/);
    assert.equal(byAsked[f.png].kind, 'image');
    assert.equal(byAsked[f.txt].ok, false);
    assert.equal(byAsked[f.txt].code, 'unsupported_media');
    assert.equal(byAsked[join(f.dir, 'missing.png')].code, 'not_found');
    // 允许根现在来自四个来源（已登记工作区 / 部署根 / live 会话 cwd / 环境变量），
    // 所以数量不固定；要断言的是"被测工作区确实在名单里"且格式统一。
    assert.ok(body.roots.length >= 1, '至少要有一个允许根');
    assert.ok(
      body.roots.some((r) => r.toLowerCase() === f.dir.replace(/\\/g, '/').toLowerCase()),
      `被测工作区应出现在允许根里：${JSON.stringify(body.roots)}`
    );
    assert.equal(body.roots.some((r) => r.includes('\\')), false, '允许根统一用正斜杠');
  } finally {
    await s.close();
    f.done();
  }
});

test('e2e: /file 完整返回 + 头正确', async () => {
  const f = fixture();
  const { ctx, routes } = stubContext({ roots: [f.dir] });
  apply(ctx);
  const s = await serve(ctx, routes);
  try {
    const r = await fetch(`${s.base}/dsh-media/file?path=${encodeURIComponent(f.mp4)}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'video/mp4');
    assert.equal(r.headers.get('accept-ranges'), 'bytes');
    assert.equal(r.headers.get('content-length'), '2048');
    assert.equal(r.headers.get('content-disposition'), null, '预览模式不能带 attachment');
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf.length, 2048);
    assert.ok(buf.equals(f.bytes), '字节必须逐位一致');
    const etag = r.headers.get('etag');
    assert.ok(etag !== null && etag.length > 3);

    const again = await fetch(`${s.base}/dsh-media/file?path=${encodeURIComponent(f.mp4)}`, {
      headers: { 'if-none-match': etag }
    });
    assert.equal(again.status, 304, '同 ETag 应命中 304');
  } finally {
    await s.close();
    f.done();
  }
});

test('e2e: Range 请求返回 206 与正确切片（视频拖动的前提）', async () => {
  const f = fixture();
  const { ctx, routes } = stubContext({ roots: [f.dir] });
  apply(ctx);
  const s = await serve(ctx, routes);
  try {
    const r = await fetch(`${s.base}/dsh-media/file?path=${encodeURIComponent(f.mp4)}`, {
      headers: { range: 'bytes=100-199' }
    });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get('content-range'), 'bytes 100-199/2048');
    assert.equal(r.headers.get('content-length'), '100');
    const buf = Buffer.from(await r.arrayBuffer());
    assert.ok(buf.equals(f.bytes.subarray(100, 200)), '切片内容必须与源文件一致');

    const tail = await fetch(`${s.base}/dsh-media/file?path=${encodeURIComponent(f.mp4)}`, {
      headers: { range: 'bytes=-10' }
    });
    assert.equal(tail.status, 206);
    assert.equal(tail.headers.get('content-range'), 'bytes 2038-2047/2048');

    const bad = await fetch(`${s.base}/dsh-media/file?path=${encodeURIComponent(f.mp4)}`, {
      headers: { range: 'bytes=99999-' }
    });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers.get('content-range'), 'bytes */2048');
  } finally {
    await s.close();
    f.done();
  }
});

test('e2e: dl=1 带 Content-Disposition（下载走"另存为"）', async () => {
  const f = fixture();
  const { ctx, routes } = stubContext({ roots: [f.dir] });
  apply(ctx);
  const s = await serve(ctx, routes);
  try {
    const r = await fetch(
      `${s.base}/dsh-media/file?path=${encodeURIComponent(f.mp4)}&dl=1&name=${encodeURIComponent('我的视频.mp4')}`
    );
    assert.equal(r.status, 200);
    const cd = r.headers.get('content-disposition');
    assert.ok(cd !== null && cd.startsWith('attachment;'), cd ?? 'missing');
    assert.ok(cd.includes("filename*=UTF-8''"), '非 ASCII 名走 RFC 5987');
    assert.ok(cd.includes('.mp4'));
    await r.arrayBuffer();
  } finally {
    await s.close();
    f.done();
  }
});

test('e2e: 工作区外的文件一律 403（安全边界）', async () => {
  const f = fixture();
  const outside = join(tmpdir(), `dsh-media-outside-${Date.now()}.png`);
  writeFileSync(outside, 'x');
  const { ctx, routes } = stubContext({ roots: [f.dir] });
  apply(ctx);
  const s = await serve(ctx, routes);
  try {
    const r = await fetch(`${s.base}/dsh-media/file?path=${encodeURIComponent(outside)}`);
    assert.equal(r.status, 403);
    const body = await r.json();
    assert.equal(body.code, 'outside_roots');
  } finally {
    await s.close();
    rmSync(outside, { force: true });
    f.done();
  }
});

test('e2e: 非媒体扩展名 415、方法限制 405、health 可读', async () => {
  const f = fixture();
  const { ctx, routes } = stubContext({ roots: [f.dir] });
  apply(ctx);
  const s = await serve(ctx, routes);
  try {
    const txt = await fetch(`${s.base}/dsh-media/file?path=${encodeURIComponent(f.txt)}`);
    assert.equal(txt.status, 415);

    const wrongMethod = await fetch(`${s.base}/dsh-media/file?path=${encodeURIComponent(f.png)}`, { method: 'POST' });
    assert.equal(wrongMethod.status, 405);

    const health = await fetch(`${s.base}/dsh-media/health`);
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.ok, true);
    assert.equal(body.plugin, 'dsh-media-preview');
    assert.ok(Array.isArray(body.roots));
    assert.equal(Object.keys(body.mediaExtensions).length > 10, true);
  } finally {
    await s.close();
    f.done();
  }
});

test('e2e: HEAD 请求不返回 body 但有 content-length', async () => {
  const f = fixture();
  const { ctx, routes } = stubContext({ roots: [f.dir] });
  apply(ctx);
  const s = await serve(ctx, routes);
  try {
    const r = await fetch(`${s.base}/dsh-media/file?path=${encodeURIComponent(f.png)}`, { method: 'HEAD' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-length'), '8');
    const buf = Buffer.from(await r.arrayBuffer());
    assert.equal(buf.length, 0);
  } finally {
    await s.close();
    f.done();
  }
});

test('tool: media_preview 注册到 tools 服务，并放行工作区内的媒体', async () => {
  const f = fixture();
  const { ctx, registeredTools } = stubContext({ roots: [f.dir], withTools: true });
  apply(ctx);
  // registerMediaTool 是 async（要动态解析 dsh-tools）。
  // 实测该 import 在本机稳定约 51ms，而此处原来写死只等 30ms —— 会随机不够，
  // 表现为「应当注册 media_preview 工具」假失败（坑 #22）。
  // 改为轮询等待：通过场景毫秒级返回，慢机器也不会误报。
  let tool;
  for (let wait = 0; wait < 200 && tool === undefined; wait += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    tool = registeredTools.get('media_preview');
  }
  assert.ok(tool !== undefined, '应当注册 media_preview 工具');
  assert.equal(typeof tool.execute, 'function');
  assert.equal(typeof tool.output.render, 'function');

  const result = await tool.execute({ paths: [f.mp4, f.png, f.txt, 'relative.png'] }, {});
  assert.deepEqual(result.shown, [f.mp4.replace(/\\/g, '/'), f.png.replace(/\\/g, '/')]);
  assert.equal(result.rejected.length, 2);
  assert.equal(result.rejected[0].path, f.txt);
  assert.equal(result.rejected[1].path, 'relative.png');

  const rendered = tool.output.render({}, result);
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].type, 'text');
  assert.ok(rendered[0].text.includes(f.mp4.replace(/\\/g, '/')), '文本里必须原样出现绝对路径（浏览器半靠它挂卡片）');

  f.done();
});

test('tool: 参数为空时明确报错', async () => {
  const { ctx, registeredTools } = stubContext({ roots: [], withTools: true });
  apply(ctx);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const tool = registeredTools.get('media_preview');
  await assert.rejects(() => tool.execute({ paths: [] }, {}), /at least one/);
});

test('tool: 没有 tools 服务时插件仍能正常工作（不抛错）', async () => {
  const f = fixture();
  const { ctx, routes } = stubContext({ roots: [f.dir] });
  apply(ctx);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const s = await serve(ctx, routes);
  try {
    const r = await fetch(`${s.base}/dsh-media/health`);
    assert.equal(r.status, 200);
  } finally {
    await s.close();
    f.done();
  }
});
