/**
 * 直接从宿主这一侧打 /dsh-media/allow，看看它到底返回什么。
 * 用法：node test/visual/allow-probe.mjs <baseUrl> <token> <outFile> <path...>
 */
import { writeFileSync } from 'node:fs';

const [baseUrl, token, outFile, ...paths] = process.argv.slice(2);
const lines = [];

const first = await fetch(`${baseUrl}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
const cookie = (first.headers.getSetCookie ? first.headers.getSetCookie() : []).map((c) => c.split(';')[0]).join('; ');
lines.push(`auth=${first.status}`);

for (const body of [
  { label: '反斜杠原样（消息里就是这么写的）', paths },
  { label: '正斜杠', paths: paths.map((p) => p.replace(/\\/g, '/')) }
]) {
  const res = await fetch(`${baseUrl}/dsh-media/allow`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ paths: body.paths })
  });
  const text = await res.text();
  lines.push('');
  lines.push(`=== ${body.label} ===`);
  lines.push(`POST /dsh-media/allow  status=${res.status}  content-type=${res.headers.get('content-type')}`);
  lines.push(`cookie 是否发出：${cookie === '' ? 'NO（这就是问题）' : 'yes'}`);
  lines.push(`body=${text.slice(0, 1200)}`);
}

writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
console.log(lines.join('\n'));
