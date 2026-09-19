/**
 * 自检页探针：带 cookie 取 /dsh-media/selftest，把关键片段与结论写进文件。
 * 用法：node test/visual/selftest-probe.mjs <baseUrl> <token> <outDir>
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [baseUrl, token, outDir] = process.argv.slice(2);
const lines = [];

const first = await fetch(`${baseUrl}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
const cookie = (first.headers.getSetCookie ? first.headers.getSetCookie() : []).map((c) => c.split(';')[0]).join('; ');
lines.push(`auth status=${first.status} cookie=${cookie === '' ? '(none)' : 'yes'}`);

const res = await fetch(`${baseUrl}/dsh-media/selftest`, { headers: { cookie } });
const html = await res.text();
lines.push(`selftest status=${res.status} bytes=${html.length}`);

writeFileSync(join(outDir, 'selftest.html'), html, 'utf8');

for (const needle of ['宿主自检', '浏览器端出卡', 'dsh-mp-family', 'data-dsh-media-host', '构建=', '媒体预览示例']) {
  const at = html.indexOf(needle);
  lines.push(`needle ${JSON.stringify(needle)}: ${at < 0 ? 'NOT FOUND' : `at ${at}`}`);
}

// 把自检表格里的判定行抽出来
const rows = [...html.matchAll(/<tr class="(ok|bad)">([\s\S]*?)<\/tr>/g)].map((m) => {
  const cells = [...m[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1].replace(/<[^>]+>/g, '').trim());
  return `${m[1] === 'ok' ? 'OK ' : 'ERR'} | ${cells.join(' | ')}`;
});
lines.push('');
lines.push('=== 宿主自检表格 ===');
lines.push(rows.join('\n') || '(无行)');

writeFileSync(join(outDir, 'selftest-probe.txt'), lines.join('\n') + '\n', 'utf8');
console.log(lines.join('\n'));
