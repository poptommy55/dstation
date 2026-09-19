/**
 * 对一个媒体 URL 做「整取 + Range 切片」字节核对（播放器拖进度条的前提）。
 * 用法：node test/visual/range-check.mjs <baseUrl> <token> <outFile> <absPath>
 */
import { writeFileSync, readFileSync } from 'node:fs';

const [baseUrl, token, outFile, absPath] = process.argv.slice(2);
const lines = [];

const first = await fetch(`${baseUrl}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
const cookie = (first.headers.getSetCookie ? first.headers.getSetCookie() : []).map((c) => c.split(';')[0]).join('; ');
const url = `${baseUrl}/dsh-media/file?path=${encodeURIComponent(absPath)}`;

const full = await fetch(url, { headers: { cookie } });
const buf = Buffer.from(await full.arrayBuffer());
lines.push(`整取 status=${full.status} type=${full.headers.get('content-type')} bytes=${buf.length}`);
lines.push(`accept-ranges=${full.headers.get('accept-ranges')} etag=${full.headers.get('etag')}`);
lines.push(`首 12 字节=${buf.subarray(0, 12).toString('hex')}`);

const local = readFileSync(absPath);
lines.push(`与磁盘原件一致 = ${buf.equals(local)}`);

for (const [start, end] of [[0, 99], [1000, 1099], [buf.length - 50, buf.length - 1]]) {
  const r = await fetch(url, { headers: { cookie, range: `bytes=${start}-${end}` } });
  const slice = Buffer.from(await r.arrayBuffer());
  const expect = local.subarray(start, end + 1);
  lines.push(`Range ${start}-${end}: status=${r.status} content-range=${r.headers.get('content-range')} bytes=${slice.length} 切片一致=${slice.equals(expect)}`);
}

const dl = await fetch(`${url}&dl=1&name=${encodeURIComponent('导出.mp4')}`, { headers: { cookie } });
await dl.arrayBuffer();
lines.push(`下载模式 status=${dl.status} disposition=${(dl.headers.get('content-disposition') ?? '').slice(0, 60)}`);

const ok = lines.every((l) => !/false/.test(l)) && full.status === 200;
lines.push(ok ? 'VERDICT: PASS' : 'VERDICT: FAIL');
writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
console.log(lines.join('\n'));
