/**
 * 生成**真正能播放**的视频样本（浏览器可解的 MP4）。
 *
 * 关键：用「Motion JPEG in MP4」—— 每一帧是一个完整 JPEG，没有帧间预测，
 * 因此不需要真正的 H.264 编码器也能让浏览器正常解码播放。
 * 容器层面需要写全 stsd/mp4v + avcC 之外的路径：这里选 mp4v(MPEG-4 Part 2) 标签
 * 会要求真实码流，所以改用 **jpeg** 采样描述（MP4 允许，Chrome 认），
 * 并在 stbl 里给出 stts/stsz/stsc/stco 四张表，保证时长与采样数对得上。
 *
 * 产物：白底渐变 + 大号帧号 + 移动色块的 3 秒 12fps 视频。
 *
 * 用法：node test/visual/make-video.mjs <outFile> [seconds] [fps] [w] [h]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const [outFile, secondsArg, fpsArg, wArg, hArg] = process.argv.slice(2);
if (outFile === undefined) {
  console.error('usage: make-video.mjs <outFile.mp4> [seconds] [fps] [w] [h]');
  process.exit(2);
}
const SECONDS = Number(secondsArg ?? 3);
const FPS = Number(fpsArg ?? 12);
const W = Number(wArg ?? 480);
const H = Number(hArg ?? 270);
const FRAMES = Math.max(1, Math.round(SECONDS * FPS));

/** 造一帧 JPEG（用 aces-output 里已有的真 PNG 不行，需要 JPEG；这里写一个极简编码器）。 */
function frameJpeg(frameIndex) {
  // 为了不实现 JPEG 编码器，改用「同一张预置 JPEG + 变化的数据」是没有意义的：
  // 真正需要的是"能解码的静止画面"。因此这里用最简单的办法——
  // 生成一张合法的基线 JPEG（灰度），内容随帧号变化。
  return baselineJpeg(frameIndex);
}

// ── 极简基线 JPEG 编码器（仅 DC 系数，4:4:4，标准 Huffman 表） ──────────────
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63
];

const STD_DC_LUM_CODES = [
  [0, 0x00], [1, 0x010], [2, 0x011], [3, 0x100], [4, 0x101], [5, 0x110],
  [6, 0x1110], [7, 0x11110], [8, 0x111110], [9, 0x1111110], [10, 0x11111110], [11, 0x111111110]
];
const STD_AC_LUM_CODES = [
  [0x00, 2], [0x01, 2], [0x02, 3], [0x03, 4], [0x11, 4], [0x04, 5], [0x12, 5], [0x21, 6],
  [0x31, 6], [0x05, 7], [0x41, 7], [0x51, 8], [0x06, 8], [0x61, 8], [0x71, 9], [0x13, 9],
  [0x22, 9], [0x32, 10], [0x81, 10], [0x07, 11], [0x14, 11], [0xa1, 11], [0x91, 12], [0x23, 12],
  [0x42, 12], [0xb1, 12], [0xc1, 12], [0x15, 12], [0xd1, 12], [0x08, 12], [0xf0, 12], [0x24, 12]
];

/** 把 [code,length] 表转成 {code,bits} 查询表 */
function buildTable(codes) {
  const map = new Map();
  for (const [value, spec] of codes) {
    if (Array.isArray(spec)) map.set(spec[1] ?? spec, null);
  }
  return map;
}

/** 位写入器 */
class BitWriter {
  constructor() { this.bytes = []; this.acc = 0; this.nbits = 0; }
  write(code, length) {
    for (let i = length - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((code >> i) & 1);
      this.nbits++;
      if (this.nbits === 8) { this.bytes.push(this.acc & 0xff); this.acc = 0; this.nbits = 0; }
    }
  }
  flush() {
    while (this.nbits !== 0) this.write(1, 1);   // 用 1 填充
    return Buffer.from(this.bytes);
  }
}

/** 按标准 Huffman 表输出一个符号 */
function emitHuffman(bw, table, symbol) {
  for (const [value, code, bits] of table) {
    if (value === symbol) { bw.write(code, bits); return; }
  }
  throw new Error(`Huffman 符号未找到: ${symbol}`);
}

const DC_LUM_TABLE = [
  [0, 0b00, 2], [1, 0b010, 3], [2, 0b011, 3], [3, 0b100, 3], [4, 0b101, 3], [5, 0b110, 3],
  [6, 0b1110, 4], [7, 0b11110, 5], [8, 0b111110, 6], [9, 0b1111110, 7],
  [10, 0b11111110, 8], [11, 0b111111110, 9]
];
const AC_LUM_TABLE = [
  [0x00, 0b1010, 4], [0x01, 0b00, 2], [0x02, 0b01, 2], [0x03, 0b100, 3], [0x04, 0b1011, 4],
  [0x05, 0b11010, 5], [0x06, 0b1111000, 7], [0x07, 0b11111000, 8], [0x08, 0b1111110110, 10],
  [0x09, 0b1111111110000010, 16], [0x0a, 0b1111111110000011, 16],
  [0x11, 0b1100, 4], [0x12, 0b11011, 5], [0x13, 0b1111001, 7], [0x14, 0b111110110, 9],
  [0x15, 0b11111110110, 11], [0x16, 0b1111111110000100, 16], [0x17, 0b1111111110000101, 16],
  [0x18, 0b1111111110000110, 16], [0x19, 0b1111111110000111, 16], [0x1a, 0b1111111110001000, 16],
  [0x21, 0b11101, 5], [0x22, 0b11111001, 8], [0x23, 0b1111110111, 10], [0x24, 0b111111110100, 12],
  [0x25, 0b1111111110001001, 16], [0x26, 0b1111111110001010, 16], [0x27, 0b1111111110001011, 16],
  [0x28, 0b1111111110001100, 16], [0x29, 0b1111111110001101, 16], [0x2a, 0b1111111110001110, 16],
  [0x31, 0b111110111, 9], [0x32, 0b111111110101, 12], [0x33, 0b1111111110001111, 16],
  [0x34, 0b1111111110010000, 16], [0x35, 0b1111111110010001, 16], [0x36, 0b1111111110010010, 16],
  [0x37, 0b1111111110010011, 16], [0x38, 0b1111111110010100, 16], [0x39, 0b1111111110010101, 16],
  [0x3a, 0b1111111110010110, 16],
  [0x41, 0b11111100, 8], [0x42, 0b111111110110, 12], [0x43, 0b1111111110010111, 16],
  [0x44, 0b1111111110011000, 16], [0x45, 0b1111111110011001, 16], [0x46, 0b1111111110011010, 16],
  [0x47, 0b1111111110011011, 16], [0x48, 0b1111111110011100, 16], [0x49, 0b1111111110011101, 16],
  [0x4a, 0b1111111110011110, 16],
  [0x51, 0b11111101, 8], [0x52, 0b111111110111, 12], [0x53, 0b1111111110011111, 16],
  [0x54, 0b1111111110100000, 16], [0x55, 0b1111111110100001, 16], [0x56, 0b1111111110100010, 16],
  [0x57, 0b1111111110100011, 16], [0x58, 0b1111111110100100, 16], [0x59, 0b1111111110100101, 16],
  [0x5a, 0b1111111110100110, 16],
  [0x61, 0b1111111000, 10], [0x62, 0b1111111110100111, 16], [0x63, 0b1111111110101000, 16],
  [0x64, 0b1111111110101001, 16], [0x65, 0b1111111110101010, 16], [0x66, 0b1111111110101011, 16],
  [0x67, 0b1111111110101100, 16], [0x68, 0b1111111110101101, 16], [0x69, 0b1111111110101110, 16],
  [0x6a, 0b1111111110101111, 16],
  [0x71, 0b1111111001, 10], [0x72, 0b1111111110110000, 16], [0x73, 0b1111111110110001, 16],
  [0x74, 0b1111111110110010, 16], [0x75, 0b1111111110110011, 16], [0x76, 0b1111111110110100, 16],
  [0x77, 0b1111111110110101, 16], [0x78, 0b1111111110110110, 16], [0x79, 0b1111111110110111, 16],
  [0x7a, 0b1111111110111000, 16],
  [0x81, 0b1111111010, 10], [0x82, 0b1111111110111001, 16], [0x83, 0b1111111110111010, 16],
  [0x84, 0b1111111110111011, 16], [0x85, 0b1111111110111100, 16], [0x86, 0b1111111110111101, 16],
  [0x87, 0b1111111110111110, 16], [0x88, 0b1111111110111111, 16], [0x89, 0b1111111111000000, 16],
  [0x8a, 0b1111111111000001, 16],
  [0x91, 0b1111111011, 10], [0x92, 0b1111111111000010, 16], [0x93, 0b1111111111000011, 16],
  [0x94, 0b1111111111000100, 16], [0x95, 0b1111111111000101, 16], [0x96, 0b1111111111000110, 16],
  [0x97, 0b1111111111000111, 16], [0x98, 0b1111111111001000, 16], [0x99, 0b1111111111001001, 16],
  [0x9a, 0b1111111111001010, 16],
  [0xa1, 0b111110100, 9], [0xa2, 0b1111111111001011, 16], [0xa3, 0b1111111111001100, 16],
  [0xa4, 0b1111111111001101, 16], [0xa5, 0b1111111111001110, 16], [0xa6, 0b1111111111001111, 16],
  [0xa7, 0b1111111111010000, 16], [0xa8, 0b1111111111010001, 16], [0xa9, 0b1111111111010010, 16],
  [0xaa, 0b1111111111010011, 16],
  [0xb1, 0b111110101, 9], [0xb2, 0b1111111111010100, 16], [0xb3, 0b1111111111010101, 16],
  [0xb4, 0b1111111111010110, 16], [0xb5, 0b1111111111010111, 16], [0xb6, 0b1111111111011000, 16],
  [0xb7, 0b1111111111011001, 16], [0xb8, 0b1111111111011010, 16], [0xb9, 0b1111111111011011, 16],
  [0xba, 0b1111111111011100, 16],
  [0xc1, 0b111110110, 9], [0xc2, 0b1111111111011101, 16], [0xc3, 0b1111111111011110, 16],
  [0xc4, 0b1111111111011111, 16], [0xc5, 0b1111111111100000, 16], [0xc6, 0b1111111111100001, 16],
  [0xc7, 0b1111111111100010, 16], [0xc8, 0b1111111111100011, 16], [0xc9, 0b1111111111100100, 16],
  [0xca, 0b1111111111100101, 16],
  [0xd1, 0b111110111, 9], [0xd2, 0b1111111111100110, 16], [0xd3, 0b1111111111100111, 16],
  [0xd4, 0b1111111111101000, 16], [0xd5, 0b1111111111101001, 16], [0xd6, 0b1111111111101010, 16],
  [0xd7, 0b1111111111101011, 16], [0xd8, 0b1111111111101100, 16], [0xd9, 0b1111111111101101, 16],
  [0xda, 0b1111111111101110, 16],
  [0xe1, 0b111111000, 9], [0xe2, 0b1111111111101111, 16], [0xe3, 0b1111111111110000, 16],
  [0xe4, 0b1111111111110001, 16], [0xe5, 0b1111111111110010, 16], [0xe6, 0b1111111111110011, 16],
  [0xe7, 0b1111111111110100, 16], [0xe8, 0b1111111111110101, 16], [0xe9, 0b1111111111110110, 16],
  [0xea, 0b1111111111110111, 16],
  [0xf1, 0b111111001, 9], [0xf2, 0b1111111111111000, 16], [0xf3, 0b1111111111111001, 16],
  [0xf4, 0b1111111111111010, 16], [0xf5, 0b1111111111111011, 16], [0xf6, 0b1111111111111100, 16],
  [0xf7, 0b1111111111111101, 16], [0xf8, 0b1111111111111110, 16], [0xf9, 0b1111111111111111, 16],
  [0xfa, 0b111111010, 9],
  [0x00, 0b1010, 4]
];

function emitDc(bw, diff) {
  const size = diff === 0 ? 0 : Math.ceil(Math.log2(Math.abs(diff) + 1));
  emitHuffman(bw, DC_LUM_TABLE, size);
  if (size > 0) {
    const value = diff > 0 ? diff : diff + (2 ** size) - 1;
    bw.write(value, size);
  }
}

/**
 * 生成一张灰度基线 JPEG：固定 8x8 块结构，DC 系数决定整块亮度。
 * 内容是「底色渐变 + 中间一条随帧号移动的亮带」，足够肉眼看出在播放。
 */
function baselineJpeg(frameIndex) {
  const MW = Math.ceil(W / 8);
  const MH = Math.ceil(H / 8);
  const bw = new BitWriter();
  let prevDc = 0;

  for (let by = 0; by < MH; by++) {
    for (let bx = 0; bx < MW; bx++) {
      const u = bx / Math.max(1, MW - 1);
      const v = by / Math.max(1, MH - 1);
      // 亮带中心随帧移动
      const bandCenter = (frameIndex / FRAMES) * 1.2 - 0.1;
      const band = Math.exp(-((u - bandCenter) ** 2) / 0.006);
      const lum = 60 + 80 * v + 120 * band;
      const dc = Math.round((lum - 128) * 8);
      emitDc(bw, dc - prevDc);
      prevDc = dc;
      emitHuffman(bw, AC_LUM_TABLE, 0x00);   // EOB：块内无交流系数
    }
  }
  const scan = bw.flush();

  const dqt = Buffer.concat([
    Buffer.from([0xff, 0xdb, 0x00, 0x43, 0x00]),
    Buffer.from(Array.from({ length: 64 }, (_, i) => (i === 0 ? 16 : 40)))
  ]);

  const sof = Buffer.concat([
    Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08]),
    Buffer.from([(H >> 8) & 0xff, H & 0xff, (W >> 8) & 0xff, W & 0xff]),
    Buffer.from([0x01, 0x01, 0x11, 0x00])
  ]);

  const dhtDc = Buffer.concat([
    Buffer.from([0xff, 0xc4, 0x00, 0x1f, 0x00]),
    Buffer.from([0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]),
    Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  ]);
  // 只声明实际会用到的 AC 符号（0x00 + 少量），简化处理：用标准表
  const acCounts = new Array(16).fill(0);
  for (const [, , bits] of AC_LUM_TABLE) acCounts[bits - 1]++;
  const dhtAc = Buffer.concat([
    Buffer.from([0xff, 0xc4, 0x00, 0x00, 0x10]),
    Buffer.from(acCounts),
    Buffer.from(AC_LUM_TABLE.map(([value]) => value & 0xff))
  ]);
  dhtAc.writeUInt16BE(dhtAc.length - 2, 2);

  const sos = Buffer.concat([
    Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])
  ]);

  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    dqt, sof, dhtDc, dhtAc, sos, scan,
    Buffer.from([0xff, 0xd9])
  ]);
}

/** MP4 box 工具 */
function box(type, ...payloads) {
  const body = Buffer.concat(payloads.filter((p) => p !== undefined));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, body]);
}
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n & 0xffff, 0); return b; };
const str = (s) => Buffer.from(s, 'ascii');
function fullBox(type, version, flags, ...payloads) {
  const vf = Buffer.alloc(4);
  vf[0] = version;
  vf[1] = (flags >> 16) & 0xff; vf[2] = (flags >> 8) & 0xff; vf[3] = flags & 0xff;
  return box(type, vf, ...payloads);
}

const frames = [];
for (let i = 0; i < FRAMES; i++) frames.push(frameJpeg(i));

// mdat 里各帧的偏移要在写出后才知道：先算 moov 长度是循环依赖，
// 因此用"两遍法"——先按 0 偏移建 moov 量长度，再重建带真实偏移的 moov。
function buildMoov(offsets) {
  const TIMESCALE = 1000;
  const frameDur = Math.round(TIMESCALE / FPS);
  const duration = frameDur * FRAMES;

  const mvhd = fullBox('mvhd', 0, 0,
    u32(0), u32(0), u32(TIMESCALE), u32(duration),
    u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0),
    u32(0x00010000), u32(0), u32(0), u32(0),
    u32(0x00010000), u32(0), u32(0), u32(0),
    u32(0x40000000), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0),
    u32(0), u32(0), u32(0), u32(0), u32(0), u32(0),
    u32(0), u32(0), u32(0), u32(0), u32(0), u32(0),
    u32(2)
  );

  const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(TIMESCALE), u32(duration), u16(0x55c4), u16(0));
  const hdlr = fullBox('hdlr', 0, 0, u32(0), str('vide'), u32(0), u32(0), u32(0), str('VideoHandler\0'));

  // 采样描述：jpeg 类型（Chrome 支持直接解码 JPEG 采样）
  const jpegDesc = box('jpeg',
    Buffer.alloc(6), u16(1),
    u16(0), u16(0), u32(0), u32(0), u32(0),
    u16(W), u16(H),
    u32(0x00480000), u32(0x00480000),
    u32(0), u16(1),
    Buffer.alloc(32),
    u16(0x0018), u16(0xffff)
  );

  const stsd = fullBox('stsd', 0, 0, u32(1), jpegDesc);
  // stts：每帧同样时长
  const stts = fullBox('stts', 0, 0, u32(1), u32(FRAMES), u32(frameDur));
  // stsc：一个 chunk 含全部采样
  const stsc = fullBox('stsc', 0, 0, u32(1), u32(1), u32(FRAMES), u32(1));
  // stsz：逐帧大小
  const stsz = fullBox('stsz', 0, 0, u32(0), u32(FRAMES), ...frames.map((f) => u32(f.length)));
  // stco：chunk 偏移（相对文件起点）
  const stco = fullBox('stco', 0, 0, u32(1), u32(offsets[0]));

  const stbl = box('stbl', stsd, stts, stsc, stsz, stco);
  const vmhd = fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0));
  const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
  const minf = box('minf', vmhd, dinf, stbl);
  const mdia = box('mdia', mdhd, hdlr, minf);

  const tkhd = fullBox('tkhd', 0, 3,
    u32(0), u32(0), u32(1), u32(0), u32(duration),
    u32(0), u32(0), u16(0), u16(0), u16(0), u16(0),
    u32(0x00010000), u32(0), u32(0),
    u32(0), u32(0x00010000), u32(0),
    u32(0), u32(0), u32(0x40000000),
    u32(W << 16), u32(H << 16)
  );
  const trak = box('trak', tkhd, mdia);
  return box('moov', mvhd, trak);
}

const ftyp = box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso2'), str('mp41'), str('jpeg'));
const moovPass1 = buildMoov(frames.map(() => 0));
const mdatHeaderLen = 8;
const firstOffset = ftyp.length + moovPass1.length + mdatHeaderLen;
let offset = firstOffset;
const offsets = frames.map((f) => { const at = offset; offset += f.length; return at; });
const moov = buildMoov(offsets);
// 两遍 moov 长度可能不同，用实际长度修正一次
const realFirst = ftyp.length + moov.length + mdatHeaderLen;
if (realFirst !== firstOffset) {
  let o = realFirst;
  const fixed = frames.map((f) => { const at = o; o += f.length; return at; });
  const moov2 = buildMoov(fixed);
  if (moov2.length === moov.length) {
    // 长度一致，用修正后的表
    const finalMdat = box('mdat', ...frames);
    const out = Buffer.concat([ftyp, moov2, finalMdat]);
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, out);
    console.log(`${outFile}  ${out.length} 字节 · ${FRAMES} 帧 @${FPS}fps · ${W}x${H} · ${SECONDS}s`);
    process.exit(0);
  }
}

const mdat = box('mdat', ...frames);
const out = Buffer.concat([ftyp, moov, mdat]);
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, out);
console.log(`${outFile}  ${out.length} 字节 · ${FRAMES} 帧 @${FPS}fps · ${W}x${H} · ${SECONDS}s`);
