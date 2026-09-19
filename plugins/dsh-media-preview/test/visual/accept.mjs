/**
 * 对夹具做一次端到端验收（开发用）：POST /allow + GET /file，把结论写进文件。
 * 用法：node test/visual/accept.mjs <outFile> <baseUrl> <pngPath> <mp3Path>
 */
import { writeFileSync } from 'node:fs';

const [outFile, base, png, mp3] = process.argv.slice(2);
const lines = [];

const allow = await fetch(`${base}/dsh-media/allow`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ paths: [png, mp3, `${png}.nope`] })
});
const allowBody = await allow.json();
lines.push(`allow status=${allow.status} roots=${JSON.stringify(allowBody.roots)}`);
for (const item of allowBody.items) {
  lines.push(`  ${item.ok ? 'OK ' : 'ERR'} ${item.asked} => ${item.ok ? `${item.kind}/${item.type} ${item.size}B url=${item.url}` : `${item.code}: ${item.message}`}`);
}

const img = await fetch(`${base}/dsh-media/file?path=${encodeURIComponent(png)}`);
const imgBuf = Buffer.from(await img.arrayBuffer());
lines.push(`png GET status=${img.status} type=${img.headers.get('content-type')} len=${img.headers.get('content-length')} bytes=${imgBuf.length} magic=${imgBuf.subarray(0, 8).toString('hex')}`);

const ranged = await fetch(`${base}/dsh-media/file?path=${encodeURIComponent(mp3)}`, {
  headers: { range: 'bytes=100-199' }
});
const rBuf = Buffer.from(await ranged.arrayBuffer());
lines.push(`mp3 RANGE status=${ranged.status} content-range=${ranged.headers.get('content-range')} bytes=${rBuf.length}`);

const dl = await fetch(`${base}/dsh-media/file?path=${encodeURIComponent(mp3)}&dl=1&name=${encodeURIComponent('旁白 音频.mp3')}`);
await dl.arrayBuffer();
lines.push(`mp3 DL status=${dl.status} disposition=${dl.headers.get('content-disposition')}`);

const outside = await fetch(`${base}/dsh-media/file?path=${encodeURIComponent('C:/Windows/System32/win.ini')}`);
lines.push(`outside txt status=${outside.status} body=${(await outside.text()).slice(0, 120)}`);

writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
console.log(lines.join('\n'));
