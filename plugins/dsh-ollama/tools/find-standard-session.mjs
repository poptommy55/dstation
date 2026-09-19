/**
 * 扫描所有会话日志，找出哪个会话用的是 standard 预设（人设含
 * "You are a coding agent powered by"），并把它的完整系统提示词还原出来。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const DSH_HOME = process.env.DSH_HOME;

function decompressMultiFrame(buf) {
  const M = [0x28, 0xb5, 0x2f, 0xfd];
  const starts = [];
  for (let i = 0; i + 3 < buf.length; i += 1) if (buf[i] === M[0] && buf[i + 1] === M[1] && buf[i + 2] === M[2] && buf[i + 3] === M[3]) starts.push(i);
  if (!starts.length) return buf.toString('utf8');
  const parts = [];
  for (let k = 0; k < starts.length; k += 1) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8')); } catch { /* 跳过坏帧 */ }
  }
  return parts.join('');
}

function walk(dir, acc = []) {
  let list = [];
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of list) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.name === 'session.jsonl.zstd') acc.push({ file: full, mtime: fs.statSync(full).mtimeMs });
  }
  return acc;
}

const all = walk(path.join(DSH_HOME, 'sessions')).sort((a, b) => b.mtime - a.mtime);
console.log(`共 ${all.length} 个会话，扫描最近 25 个…\n`);

let hit = null;
const summary = [];
for (const s of all.slice(0, 25)) {
  const text = decompressMultiFrame(fs.readFileSync(s.file));
  const isStandard = text.includes('You are a coding agent powered by');
  const isHarness = text.includes('You are an AI agent powered by DeepSeek Harness');
  // 找一个够长的 system 记录
  let sys = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (!JSON.stringify(ev).includes('"system"')) continue;
    let best = '';
    const w = (n) => {
      if (typeof n === 'string') { if (n.length > best.length) best = n; return; }
      if (Array.isArray(n)) return n.forEach(w);
      if (n && typeof n === 'object') for (const v of Object.values(n)) w(v);
    };
    w(ev);
    if (best.length > (sys?.length ?? 0) && best.length > 2000) sys = best;
  }
  const name = path.basename(path.dirname(s.file));
  summary.push({ name, standard: isStandard, harness: isHarness, sysLen: sys?.length ?? 0, mtime: new Date(s.mtime).toLocaleString('zh-CN') });
  if (isStandard && sys && !hit) hit = { name, sys };
}

for (const r of summary.slice(0, 12)) {
  console.log(`  ${r.standard ? '★标准' : '     '} harness=${r.harness ? 'Y' : 'n'}  sys=${String(r.sysLen).padStart(6)}  ${r.name.slice(0, 30)}`);
}

if (!hit) { console.log('\n未在最近 25 个会话中找到 standard 预设的会话。'); process.exit(0); }

console.log(`\n${'='.repeat(72)}\n找到 standard 预设会话：${hit.name}\n系统提示词 ${hit.sys.length} 字符\n${'='.repeat(72)}`);
console.log(hit.sys);
