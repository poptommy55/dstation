/**
 * 自检页探针（可指定要检查的文件）。
 *
 * 用法：node test/visual/selftest-files.mjs <baseUrl> <token> <outFile> <file...>
 */
import { writeFileSync } from 'node:fs';

const [baseUrl, token, outFile, ...files] = process.argv.slice(2);
const lines = [];

const first = await fetch(`${baseUrl}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
const cookie = (first.headers.getSetCookie ? first.headers.getSetCookie() : []).map((c) => c.split(';')[0]).join('; ');
lines.push(`auth=${first.status} cookie=${cookie === '' ? 'none' : 'yes'}`);

const query = files.map((f) => `files=${encodeURIComponent(f)}`).join('&');
const res = await fetch(`${baseUrl}/dsh-media/selftest?${query}`, { headers: { cookie } });
const html = await res.text();
lines.push(`selftest status=${res.status} bytes=${html.length}`);

const rows = [...html.matchAll(/<tr class="(ok|bad)">([\s\S]*?)<\/tr>/g)].map((m) => {
  const cells = [...m[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1].replace(/<[^>]+>/g, '').trim());
  return `${m[1] === 'ok' ? 'OK ' : 'ERR'} | ${cells.join(' | ')}`;
});
lines.push('');
lines.push('=== 宿主自检 ===');
lines.push(rows.join('\n') || '(无行)');

writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
console.log(lines.join('\n'));
