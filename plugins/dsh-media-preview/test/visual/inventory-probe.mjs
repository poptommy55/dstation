/**
 * 查「插件清单」接口里本插件长什么样（用户在设置里看到的列表就是从这来的）。
 * 用法：node test/visual/inventory-probe.mjs <baseUrl> <token> <outFile>
 */
import { writeFileSync } from 'node:fs';

const [baseUrl, token, outFile] = process.argv.slice(2);
const lines = [];

const first = await fetch(`${baseUrl}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
const cookie = (first.headers.getSetCookie ? first.headers.getSetCookie() : []).map((c) => c.split(';')[0]).join('; ');
lines.push(`auth=${first.status}`);

// 插件清单是内部 API；试几个可能的入口，找到能返回列表的那个
const candidates = [
  '/api/internal/plugin-inventory',
  '/api/plugin-inventory',
  '/sidebar/api/plugin.inventory',
  '/api/remote.mux'
];

for (const path of candidates) {
  try {
    const res = await fetch(baseUrl + path, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({})
    });
    const text = (await res.text()).slice(0, 300);
    lines.push(`${path} → ${res.status} ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
  } catch (e) {
    lines.push(`${path} → 异常 ${e.message}`);
  }
}

// 更可靠的办法：直接从客户端引导图里数插件行，并列出全部 id
const page = await (await fetch(new URL('/', baseUrl).toString(), { headers: { cookie } })).text();
const ids = [...page.matchAll(/\/plugins\/\?\?([^"'&]+)/g)]
  .flatMap((m) => m[1].split(','))
  .map((s) => s.replace(/\/client\.js$/, ''));
const unique = [...new Set(ids)];
lines.push('');
lines.push(`引导图里共 ${unique.length} 个客户端插件：`);
for (const id of unique) lines.push(`  ${id.includes('media') ? '→ ' : '  '}${id}`);

writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
console.log(lines.join('\n'));
