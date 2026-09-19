/**
 * 允许根来源测试 —— 锁住"重启后旧会话产物仍可预览"这条回归。
 *
 * 背景（2026-09-13 实测）：原先允许根只取「部署 workspaceRoot + 当前 live 会话 cwd」，
 * 重启后旧会话不再 live，它们目录里的文件全部变成
 * 「拒绝访问：文件不在任何允许的会话工作区之内」——历史消息里的卡片集体失效。
 * 修法是增加第四个来源：DSH 的**已登记工作区**（两份 workspace.json）。
 *
 * 这里不起 HTTP，直接验证 candidateRoots 的来源合并逻辑（通过 /allow 路由的响应间接断言，
 * 因为 candidateRoots 不对外导出）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../index.js';

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
      logger: { info() {}, warn() {} },
      effect() {},
      get(name) {
        if (name === 'sandboxPolicy') return { workspaceRoot: roots[0] };
        if (name === 'sessions') return { list: () => [] };   // 故意不给 live 会话
        return undefined;
      }
    }
  };
}

async function serve(routes) {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname;
    let best;
    for (const route of routes.values()) {
      if (pathname !== route.path && !pathname.startsWith(`${route.path}/`)) continue;
      if (best === undefined || route.path.length > best.path.length) best = route;
    }
    if (best === undefined) { res.writeHead(404); res.end(); return; }
    Promise.resolve(best.handler(req, res)).catch(() => { if (!res.headersSent) { res.writeHead(500); res.end(); } });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test('允许根：登记过的工作区（两份 workspace.json）必须被纳入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-media-roots-'));
  const png = join(dir, 'a.png');
  writeFileSync(png, Buffer.alloc(4096, 7));

  const { ctx, routes } = stubContext([dir]);
  apply(ctx);
  const s = await serve(routes);
  try {
    const r = await fetch(`${s.base}/dsh-media/allow`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: [png] })
    });
    const body = await r.json();

    assert.equal(body.items[0].ok, true, '被登记工作区里的文件应当放行');
    assert.ok(Array.isArray(body.roots) && body.roots.length > 0);

    // 机器上真实登记过的工作区（若存在）也应在名单里 —— 这正是本条回归的核心
    const { existsSync, readFileSync } = await import('node:fs');
    const dshHome = process.env.DSH_HOME;
    if (dshHome !== undefined && existsSync(join(dshHome, 'storages', 'workspace.json'))) {
      const reg = JSON.parse(readFileSync(join(dshHome, 'storages', 'workspace.json'), 'utf8'));
      const want = Object.values(reg?.tables?.workspaces ?? {})
        .map((w) => w?.path)
        .filter((p) => typeof p === 'string' && p !== '');
      const present = want.filter((p) => {
        const norm = p.replace(/\\/g, '/').toLowerCase();
        return body.roots.some((root) => root.toLowerCase() === norm);
      });
      assert.ok(
        present.length > 0,
        `登记的工作区一个都没进允许根：注册表=${JSON.stringify(want)} 实际=${JSON.stringify(body.roots)}`
      );
    }
  } finally {
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('允许根：live 会话 cwd 仍然是来源之一（滚动新增的工作区立刻生效）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-media-roots2-'));
  const sessionDir = mkdtempSync(join(tmpdir(), 'dsh-media-sess-'));
  const png = join(sessionDir, 'b.png');
  writeFileSync(png, Buffer.alloc(4096, 9));

  const routes = new Map();
  const ctx = {
    webServer: {
      register(route) { routes.set(`${route.kind}:${route.path}`, route); return () => routes.delete(`${route.kind}:${route.path}`); }
    },
    logger: { info() {}, warn() {} },
    effect() {},
    get(name) {
      if (name === 'sandboxPolicy') return { workspaceRoot: dir };
      if (name === 'sessions') return { list: () => [{ header: { cwd: sessionDir } }] };
      return undefined;
    }
  };
  apply(ctx);
  const s = await serve(routes);
  try {
    const r = await fetch(`${s.base}/dsh-media/allow`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: [png] })
    });
    const body = await r.json();
    assert.equal(body.items[0].ok, true, 'live 会话 cwd 里的文件应当放行');
  } finally {
    await s.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(sessionDir, { recursive: true, force: true });
  }
});
