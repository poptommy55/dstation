/**
 * 带 token 抓取 GUI 首页并检查引导图里有没有本插件的客户端模块。
 * 用法：node test/visual/boot-probe.mjs <outFile> "<indexUrlWithToken>"
 */
import { writeFileSync } from 'node:fs';

const [outFile, url] = process.argv.slice(2);
const lines = [];

const r = await fetch(url, { redirect: 'manual' });
lines.push(`GET ${url} -> ${r.status} ${r.headers.get('location') ?? ''}`);
const setCookie = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
lines.push(`set-cookie: ${setCookie.map((c) => c.split(';')[0]).join(' | ') || '(none)'}`);
const html = await r.text();
lines.push(`html bytes = ${html.length}`);

const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
const r2 = await fetch(new URL('/', url).toString(), { headers: cookie === '' ? {} : { cookie } });
lines.push(`GET / -> ${r2.status}`);
const page = await r2.text();
lines.push(`page bytes = ${page.length}`);
writeFileSync(outFile.replace(/\.txt$/, '.html'), page, 'utf8');

for (const needle of ['dsh-media-preview', '__DSH_BOOT__', '/plugins/??', 'dsh-mermaid']) {
  const at = page.indexOf(needle);
  lines.push(`needle ${needle}: ${at < 0 ? 'NOT FOUND' : `at ${at}`}`);
  if (at >= 0 && needle === 'dsh-media-preview') {
    lines.push('  context: ' + page.slice(Math.max(0, at - 220), at + 220).replace(/\s+/g, ' '));
  }
  if (at >= 0 && needle === '/plugins/??') {
    lines.push('  combos: ' + (page.match(/\/plugins\/\?\?[^"'&]*/g) ?? []).slice(0, 3).join(' | ').slice(0, 400));
  }
}

writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
console.log(lines.join('\n'));
