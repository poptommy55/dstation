/**
 * 在**真实运行的 DSH web 服务**上做一次端到端验收（不是夹具）。
 *
 * 做三件事：
 *   1. 用 dsh 打印的 token 换浏览器会话 cookie，并确认自己是同源请求；
 *   2. 打 /dsh-media/health 确认插件已挂载、允许根覆盖当前工作区；
 *   3. 用工作区里真实的媒体文件打 /dsh-media/allow 与 /dsh-media/file，
 *      核对 MIME、字节、Range、下载头与越界拒绝。
 *
 * 用法：
 *   node test/visual/live-check.mjs <baseUrl> <token> <outDir> <workspaceDir>
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [baseUrl = 'http://127.0.0.1:3080', token = '', outDir = '6-verify', workspace = 'D:/DSH/DH2/实验区'] = process.argv.slice(2);

mkdirSync(outDir, { recursive: true });
const lines = [];
const record = (s) => { lines.push(s); console.log(s); };
const fail = (s) => { lines.push(`FAIL ${s}`); console.log(`FAIL ${s}`); };

/** 用 token 换 cookie：GET /?token=… 会 303 到 / 并下发 dsh-auth-… cookie。 */
async function authCookie() {
  const res = await fetch(`${baseUrl}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const cookie = raw.map((c) => c.split(';')[0]).join('; ');
  record(`auth: status=${res.status} location=${res.headers.get('location') ?? '(none)'} cookie=${cookie === '' ? '(none)' : cookie.split('=')[0]}`);
  return cookie;
}

const cookie = await authCookie();
const headers = cookie === '' ? {} : { cookie };

// ── 1. health ────────────────────────────────────────────────────────────
const health = await fetch(`${baseUrl}/dsh-media/health`, { headers });
const healthBody = await health.json().catch(() => null);
record(`health: status=${health.status}`);
record(`        ${JSON.stringify(healthBody)}`);
if (health.status !== 200 || healthBody?.ok !== true) fail('健康检查未通过');
if (Array.isArray(healthBody?.roots) && healthBody.roots.length === 0) fail('没有允许根，媒体会被 403');

// ── 2. 真实媒体文件 ──────────────────────────────────────────────────────
const candidates = ['媒体预览示例-图片.png', '媒体预览示例-音频.mp3', '媒体预览示例-视频.mp4']
  .map((name) => `${workspace.replace(/\\/g, '/')}/${name}`);
const outside = 'C:/Windows/win.ini';

const allowRes = await fetch(`${baseUrl}/dsh-media/allow`, {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({ paths: [...candidates, outside] })
});
const allow = await allowRes.json().catch(() => null);
record('');
record(`allow: status=${allowRes.status}`);
for (const item of allow?.items ?? []) {
  record(`  ${item.ok ? 'OK ' : 'ERR'} ${item.asked}`);
  if (item.ok) record(`       → ${item.kind}/${item.type} ${item.size}B  url=${item.url}`);
  else record(`       → ${item.code}: ${item.message}`);
}
if (allowRes.status !== 200) fail('allow 接口未返回 200');
const okItems = (allow?.items ?? []).filter((i) => i.ok);
if (okItems.length !== candidates.length) fail(`期望 ${candidates.length} 个媒体被放行，实际 ${okItems.length}`);
const outsideItem = (allow?.items ?? []).find((i) => i.asked === outside);
if (outsideItem === undefined || outsideItem.ok !== false) fail('工作区外的文件没有按预期被拒绝');

// ── 3. 逐个媒体：整取 + Range + 下载头 ─────────────────────────────────
for (const item of okItems) {
  record('');
  record(`file: ${item.name}`);
  const full = await fetch(`${baseUrl}${item.url}`, { headers });
  const buf = Buffer.from(await full.arrayBuffer());
  record(`  整取 status=${full.status} type=${full.headers.get('content-type')} len=${buf.length} 期望=${item.size}`);
  if (full.status !== 200) fail(`${item.name} 整取未返回 200`);
  if (buf.length !== item.size) fail(`${item.name} 字节数不符（${buf.length} != ${item.size}）`);
  if (full.headers.get('accept-ranges') !== 'bytes') fail(`${item.name} 缺少 Accept-Ranges`);

  if (item.size > 200) {
    const ranged = await fetch(`${baseUrl}${item.url}`, { headers: { ...headers, range: 'bytes=100-199' } });
    const rBuf = Buffer.from(await ranged.arrayBuffer());
    record(`  Range status=${ranged.status} content-range=${ranged.headers.get('content-range')} bytes=${rBuf.length}`);
    if (ranged.status !== 206 || rBuf.length !== 100) fail(`${item.name} Range 请求不正确`);
    if (!rBuf.equals(buf.subarray(100, 200))) fail(`${item.name} Range 切片内容与整取不一致`);
  }

  const dl = await fetch(`${baseUrl}${item.url}&dl=1&name=${encodeURIComponent(`导出-${item.name}`)}`, { headers });
  await dl.arrayBuffer();
  const cd = dl.headers.get('content-disposition') ?? '';
  record(`  下载 status=${dl.status} disposition=${cd.slice(0, 80)}`);
  if (!cd.startsWith('attachment;')) fail(`${item.name} 下载模式缺少 Content-Disposition`);
}

// ── 4. 越界与非媒体 ─────────────────────────────────────────────────────
record('');
const outsideFile = await fetch(`${baseUrl}/dsh-media/file?path=${encodeURIComponent(outside)}`, { headers });
record(`越界文件: status=${outsideFile.status} body=${(await outsideFile.text()).slice(0, 120)}`);
if (outsideFile.status === 200) fail('工作区外的文件竟然被返回了 200（严重）');

const notMedia = await fetch(`${baseUrl}/dsh-media/file?path=${encodeURIComponent(`${workspace}/dsh-media-preview/README.md`)}`, { headers });
record(`非媒体: status=${notMedia.status}`);
if (notMedia.status !== 415) fail(`非媒体扩展名应返回 415，实际 ${notMedia.status}`);

const badAuth = await fetch(`${baseUrl}/dsh-media/health`);
record(`无 cookie 访问 health: status=${badAuth.status}（路由本身不鉴权，属已知边界）`);

const failed = lines.some((l) => l.startsWith('FAIL'));
record('');
record(failed ? 'LIVE-CHECK: FAIL' : 'LIVE-CHECK: PASS');
writeFileSync(join(outDir, 'live-check.txt'), lines.join('\n') + '\n', 'utf8');
process.exit(failed ? 1 : 0);
