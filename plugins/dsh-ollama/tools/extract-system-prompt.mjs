/**
 * 从会话日志里还原**真实发给模型的系统提示词**。
 *
 * 依据：dsh-llm 的 README 明确写着 "every request is logged so it stays
 * reconstructable from the session log"。所以这是第一手证据，不是推断。
 *
 * ⚠️ 会话日志是**多帧 zstd**（每帧一段），直接用 zstdDecompressSync 只解第一帧
 *    （实测 4MB 文件只解出 180 字符）。必须按帧魔数 28 B5 2F FD 切开逐帧解。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const DSH_HOME = process.env.DSH_HOME;

/** 多帧 zstd 解压。 */
function decompressMultiFrame(buf) {
  const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
  const starts = [];
  for (let i = 0; i + 3 < buf.length; i += 1) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) starts.push(i);
  }
  if (starts.length === 0) return buf.toString('utf8');
  const parts = [];
  for (let k = 0; k < starts.length; k += 1) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    const frame = buf.subarray(starts[k], end);
    try { parts.push(zlib.zstdDecompressSync(frame).toString('utf8')); }
    catch (e) { parts.push(`\n<!-- 第 ${k} 帧解压失败: ${e.message} -->\n`); }
  }
  return parts.join('');
}

/** 递归找最新的 session.jsonl.zstd。 */
function findLatestSession(dir, acc = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findLatestSession(full, acc);
    else if (e.name === 'session.jsonl.zstd') acc.push({ file: full, mtime: fs.statSync(full).mtimeMs });
  }
  return acc;
}

const sessions = findLatestSession(path.join(DSH_HOME, 'sessions')).sort((a, b) => b.mtime - a.mtime);
console.log(`找到 ${sessions.length} 个会话日志`);
if (sessions.length === 0) process.exit(0);

// 取最近若干个，找其中含 system 提示词的那个
for (const s of sessions.slice(0, 8)) {
  const raw = fs.readFileSync(s.file);
  const text = decompressMultiFrame(raw);
  const lines = text.split('\n').filter(Boolean);
  let found = null;
  for (const line of lines) {
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    const str = JSON.stringify(ev);
    // 找含 system 提示词的请求记录
    if (str.includes('"system"') && str.length > 3000) { found = { ev, line }; break; }
  }
  console.log(`\n${'='.repeat(70)}\n${path.basename(path.dirname(s.file))}  (${(raw.length / 1024).toFixed(0)}KB → ${(text.length / 1024).toFixed(0)}KB, ${lines.length} 事件)`);
  if (!found) { console.log('  （未找到含 system 的请求记录）'); continue; }

  // 递归找最长的字符串字段，那通常就是系统提示词
  let best = '';
  const walk = (node, keyPath) => {
    if (typeof node === 'string') { if (node.length > best.length) best = node; return; }
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${keyPath}[${i}]`)); return; }
    if (node && typeof node === 'object') { for (const [k, v] of Object.entries(node)) walk(v, `${keyPath}.${k}`); }
  };
  walk(found.ev, '$');
  console.log(`  最长文本字段 ${best.length} 字符`);
  console.log('--- 前 1200 字符 ---');
  console.log(best.slice(0, 1200));
  console.log('--- 末 600 字符 ---');
  console.log(best.slice(-600));
  break;
}
