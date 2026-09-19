/**
 * 确认 GUI 真正在提供的客户端 bundle 里包含某段代码（默认查「行内代码」修复）。
 * 用法：node test/visual/bundle-probe.mjs <outFile> "<indexUrlWithToken>" [needle]
 */
import { writeFileSync } from 'node:fs';

const [outFile, url, needle = '行内代码'] = process.argv.slice(2);
const lines = [];

const first = await fetch(url, { redirect: 'manual' });
const cookie = (first.headers.getSetCookie ? first.headers.getSetCookie() : []).map((c) => c.split(';')[0]).join('; ');
const page = await (await fetch(new URL('/', url).toString(), { headers: { cookie } })).text();
lines.push(`index bytes = ${page.length}, cookie = ${cookie === '' ? '(none)' : 'yes'}`);

// 引导图里的组合脚本 URL（应用期那一条，包含 dsh-media-preview）
const combos = page.match(/\/plugins\/\?\?[^"'&]+/g) ?? [];
const appCombo = combos.find((c) => c.includes('dsh-media-preview/client.js'));
lines.push(`combos = ${combos.length}, 含本插件的 = ${appCombo === undefined ? 'NOT FOUND' : 'found'}`);
if (appCombo === undefined) { lines.push('VERDICT: 插件不在引导图里'); writeFileSync(outFile, lines.join('\n'), 'utf8'); process.exit(1); }

// 组合 URL 带 rev 参数，且在 HTML 里被转义成 &amp;rev=…：必须连着 rev 一起取，
// 否则服务端会按「未知 rev」返回 404（这正是第一版探针踩的坑）。
const revMatch = new RegExp(appCombo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:&amp;|&)(rev=[0-9a-f]+)').exec(page);
if (revMatch === null) {
  lines.push('找不到组合 URL 的 rev 参数');
  writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
  console.log(lines.join('\n'));
  process.exit(1);
}
const comboUrl = `${appCombo}&${revMatch[1]}`;
lines.push(`comboUrl = ${comboUrl.slice(0, 100)}…  rev=${revMatch[1]}`);

const bundleRes = await fetch(new URL(comboUrl, url).toString(), { headers: { cookie } });
const bundle = await bundleRes.text();
lines.push(`bundle status=${bundleRes.status} bytes=${bundle.length}`);
const at = bundle.indexOf(needle);
lines.push(`needle ${JSON.stringify(needle)}: ${at < 0 ? 'NOT FOUND（服务端还是旧字节）' : `found at ${at}`}`);
lines.push(`bundle 里 dsh-media-preview 出现次数 = ${(bundle.match(/dsh-media-preview/g) ?? []).length}`);
lines.push(at < 0 ? 'VERDICT: STALE' : 'VERDICT: FRESH');
writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
console.log(lines.join('\n'));
process.exit(at < 0 ? 1 : 0);
