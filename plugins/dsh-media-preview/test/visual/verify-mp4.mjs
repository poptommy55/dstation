/**
 * 校验生成的 MP4：容器结构 + 每帧偏移是否真的指向 JPEG 起始标记。
 * 用法：node test/visual/verify-mp4.mjs <file.mp4>
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const buf = readFileSync(file);
const out = [];
const say = (s) => { out.push(s); console.log(s); };

/** 遍历 box 树 */
function walk(start, end, depth, visit) {
  let p = start;
  while (p + 8 <= end) {
    const size = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    if (size < 8 || p + size > end) { visit(p, 0, type, depth, true); break; }
    visit(p, size, type, depth, false);
    if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf'].includes(type)) walk(p + 8, p + size, depth + 1, visit);
    if (type === 'stsd') walk(p + 16, p + size, depth + 1, visit);
    p += size;
  }
}

let stszCount = 0;
let stszSizes = [];
let stcoOffset = 0;
let stsdType = '';
const boxes = [];
walk(0, buf.length, 0, (pos, size, type, depth, broken) => {
  boxes.push(`${'  '.repeat(depth)}${type} @${pos} size=${size}${broken ? ' (BROKEN)' : ''}`);
  if (type === 'stsz') {
    stszCount = buf.readUInt32BE(pos + 16);
    for (let i = 0; i < stszCount; i++) stszSizes.push(buf.readUInt32BE(pos + 20 + i * 4));
  }
  if (type === 'stco') stcoOffset = buf.readUInt32BE(pos + 16);
  if (['jpeg', 'avc1', 'mp4v'].includes(type)) stsdType = type;
});

say(`文件 ${file}`);
say(`大小 ${buf.length} 字节`);
say('--- box 树 ---');
say(boxes.join('\n'));
say('--- 关键字段 ---');
say(`采样描述类型 = ${stsdType || '(未找到)'}`);
say(`stsz 帧数 = ${stszCount}`);
say(`首个 chunk 偏移(stco) = ${stcoOffset}`);
say(`帧大小合计 = ${stszSizes.reduce((a, b) => a + b, 0)}`);

// 逐帧按 stco + 累加 stsz 推导偏移，检查是否落在 JPEG SOI (FFD8) 上
let at = stcoOffset;
let okFrames = 0;
for (let i = 0; i < stszSizes.length; i++) {
  const soi = buf[at] === 0xff && buf[at + 1] === 0xd8;
  const eoi = buf[at + stszSizes[i] - 2] === 0xff && buf[at + stszSizes[i] - 1] === 0xd9;
  if (soi && eoi) okFrames++;
  else if (i < 3 || i === stszSizes.length - 1) say(`  帧 ${i}: 偏移 ${at} SOI=${soi} EOI=${eoi} 大小=${stszSizes[i]}`);
  at += stszSizes[i];
}
say(`帧完整性：${okFrames}/${stszSizes.length} 帧含正确的 JPEG SOI…EOI`);
say(`mdat 之后剩余字节 = ${buf.length - at}`);
say(okFrames === stszSizes.length && stszSizes.length > 0 ? 'VERDICT: 结构 OK' : 'VERDICT: 结构有问题');
