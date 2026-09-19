/**
 * 宿主半离线测试。
 *
 * 不需要起服务、不需要重启：index.js 只 import Node 内置模块，
 * 配一个假 ctx 就能把 apply() 与全部路由跑一遍。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { check, makeCtx, makeRes, call, summary } from './harness.mjs';
import * as plugin from '../index.js';

export async function run() {
  const sandbox = mkdtempSync(join(tmpdir(), 'dsfo-host-'));
  const root = join(sandbox, 'workspace');
  mkdirSync(root, { recursive: true });
  const docx = join(root, 'quarterly-report.docx');
  writeFileSync(docx, 'x'.repeat(2048));
  const folder = join(root, 'daily-use');
  mkdirSync(folder);
  const secretDir = join(root, '.ssh');
  mkdirSync(secretDir);
  const secret = join(secretDir, 'id_rsa');
  // 一个**存在但不在允许根内**的文件：用来证明根白名单真的在拦，
  // 而不是靠"文件不存在"蒙对（不存在的路径会先被 404 挡下，测不到根闸门）
  const outsideFile = join(sandbox, 'outside.txt');
  writeFileSync(outsideFile, 'x');

  const services = {
    sandboxPolicy: { workspaceRoot: root },
    sessions: { list: () => [{ header: { cwd: root } }] }
  };

  // ── 装配 ────────────────────────────────────────────────────────
  const h = makeCtx({ services });
  // 注入假 spawn：否则跑测试会真的在用户屏幕上弹出资源管理器窗口
  const spawnCalls = [];
  const fakeSpawn = (cmd, args, options) => {
    spawnCalls.push({ cmd, args, options });
    return { on() {}, unref() {} };
  };
  let threw = null;
  try {
    plugin.apply(h.ctx, { spawn: fakeSpawn });
  } catch (error) {
    threw = error;
  }
  check('apply() 不抛异常', threw === null);
  check('注册了 6 条路由', h.routes.size === 6);

  // 元测试：假 ctx 真的会拒绝重复注册（否则这条测试是安慰剂）
  let duplicateCaught = false;
  try {
    h.ctx.webServer.register({ kind: 'exact', path: '/dsh-file-opener/health', handler: () => {} });
  } catch {
    duplicateCaught = true;
  }
  check('元测试：假 ctx 拒绝重复 (kind,path) 注册', duplicateCaught);

  // 元测试：假 res 真的会拒绝非法响应头（坑 #58）
  let headerCaught = false;
  try {
    makeRes().writeHead(200, { 'content-disposition': 'attachment; filename="中文.zip"' });
  } catch {
    headerCaught = true;
  }
  check('元测试：假 res 拒绝非法响应头', headerCaught);

  // ── /health ─────────────────────────────────────────────────────
  const health = await call(h.routes, '/dsh-file-opener/health');
  check('/health → 200', health.status === 200);
  check('/health 报出自己的构建号', health.body?.build === plugin.BUILD);
  check('/health 报出允许根（含部署根）', Array.isArray(health.body?.roots) && health.body.roots.length > 0);
  check('/health 的 content-type 是 JSON', String(health.headers['content-type']).includes('application/json'));

  const healthPost = await call(h.routes, '/dsh-file-opener/health', { method: 'POST' });
  check('/health 不接受 POST（405）', healthPost.status === 405);

  // ── /check ──────────────────────────────────────────────────────
  const okCheck = await call(h.routes, '/dsh-file-opener/check', {
    method: 'POST',
    body: JSON.stringify({ paths: [docx, folder] })
  });
  check('/check → 200', okCheck.status === 200);
  const fileItem = okCheck.body?.items?.[0];
  const dirItem = okCheck.body?.items?.[1];
  check('/check 认出存在的文件', fileItem?.ok === true && fileItem.kind === 'file');
  check('/check 报出体积', fileItem?.size === 2048);
  check('/check 认出目录', dirItem?.ok === true && dirItem.kind === 'dir');
  check('/check 给出扩展名', fileItem?.ext === '.docx');

  const missing = await call(h.routes, '/dsh-file-opener/check', {
    method: 'POST',
    body: JSON.stringify({ paths: [join(root, '没有这个文件.docx')] })
  });
  check('/check 对不存在的路径回 not_found', missing.body?.items?.[0]?.code === 'not_found');
  check('/check 对不存在的路径不与文件混淆', missing.body?.items?.[0]?.ok === false);

  const relative = await call(h.routes, '/dsh-file-opener/check', {
    method: 'POST',
    body: JSON.stringify({ paths: ['相对/路径.docx'] })
  });
  check('/check 拒绝相对路径（not_absolute）', relative.body?.items?.[0]?.code === 'not_absolute');

  const outside = await call(h.routes, '/dsh-file-opener/check', {
    method: 'POST',
    body: JSON.stringify({ paths: [join(tmpdir(), '别处.txt')] })
  });
  check('/check 拒绝允许根之外的路径（outside_roots）',
    outside.body?.items?.[0]?.code === 'outside_roots' || outside.body?.items?.[0]?.code === 'not_found');

  const denied = await call(h.routes, '/dsh-file-opener/check', {
    method: 'POST',
    body: JSON.stringify({ paths: [secret] })
  });
  check('/check 拒绝 .ssh 段（denied_path）', denied.body?.items?.[0]?.code === 'denied_path');

  const empty = await call(h.routes, '/dsh-file-opener/check', {
    method: 'POST',
    body: JSON.stringify({ paths: [] })
  });
  check('/check 拒绝空 paths（400）', empty.status === 400);

  const tooMany = await call(h.routes, '/dsh-file-opener/check', {
    method: 'POST',
    body: JSON.stringify({ paths: Array.from({ length: 41 }, (_, i) => `${root}\\f${i}.txt`) })
  });
  check('/check 拒绝超过上限的批量（400）', tooMany.status === 400);

  const badJson = await call(h.routes, '/dsh-file-opener/check', { method: 'POST', body: '{不是 JSON' });
  check('/check 对非法 JSON 回 400', badJson.status === 400);

  const checkGet = await call(h.routes, '/dsh-file-opener/check');
  check('/check 不接受 GET（405）', checkGet.status === 405);

  // ── /reveal：在文件夹中显示（唯一会起子进程的路由）──────────────
  const reveal = await call(h.routes, '/dsh-file-opener/reveal', {
    method: 'POST',
    body: JSON.stringify({ path: docx })
  });
  check('/reveal → 200', reveal.status === 200);
  check('/reveal 用的是 realpath', reveal.body?.revealed?.endsWith('quarterly-report.docx') === true);
  check('/reveal 转成了 Windows 原生反斜杠', String(reveal.body?.revealed).includes('\\'));
  check('/reveal 报出 kind=file', reveal.body?.kind === 'file');
  check('/reveal 起了**一个** explorer.exe', spawnCalls.length === 1);
  check('/reveal 调的是 explorer.exe', spawnCalls[0]?.cmd === 'explorer.exe');
  check('/reveal 的参数是两个元素 ["/select,", 路径]（实测唯一正确的写法）',
    spawnCalls[0]?.args?.length === 2
      && spawnCalls[0].args[0] === '/select,'
      && spawnCalls[0].args[1] === reveal.body.revealed);
  check('/reveal 的参数里没有引号（自带引号会被 Node 二次转义而失效）',
    spawnCalls[0]?.args?.every((a) => !a.includes('"')) === true);
  check('/reveal 的 stdio 是 ignore（沙箱下管道会 EPERM，坑 #10）',
    spawnCalls[0]?.options?.stdio === 'ignore');

  const revealDir = await call(h.routes, '/dsh-file-opener/reveal', {
    method: 'POST',
    body: JSON.stringify({ path: folder })
  });
  check('/reveal 对目录直接打开（一个参数、不加引号、不加 /select）',
    revealDir.body?.kind === 'dir'
      && JSON.stringify(spawnCalls[1]?.args) === JSON.stringify([revealDir.body.revealed]));

  const revealOutside = await call(h.routes, '/dsh-file-opener/reveal', {
    method: 'POST',
    body: JSON.stringify({ path: outsideFile })
  });
  check('/reveal 拒绝允许根之外的路径（outside_roots）',
    revealOutside.status === 403 && revealOutside.body?.code === 'outside_roots');
  check('/reveal 被拒时**不起进程**', spawnCalls.length === 2);

  const revealDenied = await call(h.routes, '/dsh-file-opener/reveal', {
    method: 'POST',
    body: JSON.stringify({ path: secret })
  });
  check('/reveal 拒绝 .ssh 段且不起进程',
    revealDenied.status === 403 && spawnCalls.length === 2);

  const revealRelative = await call(h.routes, '/dsh-file-opener/reveal', {
    method: 'POST',
    body: JSON.stringify({ path: 'a/b.docx' })
  });
  check('/reveal 拒绝相对路径', revealRelative.status === 400 && spawnCalls.length === 2);

  const revealGet = await call(h.routes, '/dsh-file-opener/reveal');
  check('/reveal 不接受 GET（405）', revealGet.status === 405);

  // ── /report：分来源分槽，互不覆盖（坑 #39）────────────────────────
  await call(h.routes, '/dsh-file-opener/report', {
    method: 'POST',
    body: JSON.stringify({ source: 'probe', note: '来自探针' })
  });
  await call(h.routes, '/dsh-file-opener/report', {
    method: 'POST',
    body: JSON.stringify({ source: 'client', note: '来自客户端' })
  });
  const status = await call(h.routes, '/dsh-file-opener/status');
  check('/status → 200', status.status === 200);
  check('/report 的 probe 槽没有被覆盖', status.body?.reports?.probe?.note === '来自探针');
  check('/report 的 client 槽没有被覆盖', status.body?.reports?.client?.note === '来自客户端');

  // ── /selftest ───────────────────────────────────────────────────
  const selftest = await call(h.routes, '/dsh-file-opener/selftest');
  check('/selftest → 200', selftest.status === 200);
  check('/selftest 返回 HTML', String(selftest.headers['content-type']).includes('text/html'));
  check('/selftest 内含构建号', selftest.text.includes(plugin.BUILD));
  check('/selftest 注入了真实的 client.js', selftest.text.includes('__ModuleLoader__'));
  check('转义助手把 </script 变成 <\\/script（坑 #9）',
    plugin.escapeScriptClose('a</script>b') === 'a<\\/script>b');
  check('转义助手大小写不敏感', plugin.escapeScriptClose('x</SCRIPT>y') === 'x<\\/SCRIPT>y');
  check('/selftest 的 <script> 标签成对（注入没有截断 HTML）',
    (selftest.text.match(/<script/g) ?? []).length === (selftest.text.match(/<\/script/g) ?? []).length);
  check('/selftest 列出允许根', selftest.text.includes('允许根'));

  // ── 卸载：破坏性用例放最后（坑 #57）──────────────────────────────
  for (const dispose of h.disposers) {
    if (typeof dispose === 'function') dispose();
  }
  check('卸载后路由表清空', h.routes.size === 0);

  rmSync(sandbox, { recursive: true, force: true });
}

// 供 run-tests.mjs 单独调用
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await run();
  process.exit(summary() ? 0 : 1);
}
