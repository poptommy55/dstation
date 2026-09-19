/**
 * 一次性连通性探针（开发用）：把若干 URL 的响应状态/头/片段写进文件，避免依赖
 * 终端输出（本沙箱下管道 stdio 受限）。
 *
 * 用法：node test/visual/probe.mjs <outFile> <url> [url...]
 */
import { writeFileSync } from 'node:fs';

const [outFile, ...urls] = process.argv.slice(2);
const lines = [];

for (const url of urls) {
  try {
    const r = await fetch(url, { redirect: 'manual' });
    const contentType = r.headers.get('content-type') ?? '';
    let body = '';
    if (contentType.includes('json') || contentType.includes('text')) {
      body = (await r.text()).slice(0, 800);
    } else {
      const buf = Buffer.from(await r.arrayBuffer());
      body = `<${buf.length} bytes> first16=${buf.subarray(0, 16).toString('hex')}`;
    }
    lines.push(`OK   ${url}`);
    lines.push(`     status=${r.status} type=${contentType} len=${r.headers.get('content-length') ?? '?'}`);
    lines.push(`     body=${body.replace(/\s+/g, ' ').slice(0, 500)}`);
  } catch (error) {
    lines.push(`FAIL ${url}`);
    lines.push(`     ${error?.message ?? error}`);
  }
}

writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
console.log(lines.join('\n'));
