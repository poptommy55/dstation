/**
 * 生成**真实可用**的示例媒体（不是改后缀的假文件）。
 *
 * 产出三个文件到指定目录：
 *   cover.png   160x100 渐变图（真 PNG：IHDR + IDAT(zlib) + IEND）
 *   tone.wav    2 秒 440Hz 正弦 + 淡入淡出（真 RIFF/WAVE，浏览器能直接播）
 *   clip.mp4    结构完整的极简 MP4（ftyp + moov(mvhd/trak/mdia/minf/stbl) + mdat），
 *               **不含真实 H.264 码流**：浏览器能解析出时长/尺寸并显示播放器，
 *               但画面是黑的、不能真播。要真画面需要真正的编码器，这里不假装。
 *
 * 用法：node test/visual/make-samples.mjs <outDir>
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const outDir = process.argv[2];
if (outDir === undefined) {
  console.error('usage: make-samples.mjs <outDir>');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

// ── 真 PNG ────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function makePng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // truecolor RGB
  const raw = Buffer.alloc(height * (1 + width * 3));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0;  // filter: none
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1);
      const v = y / (height - 1);
      raw[p++] = Math.round(60 + 160 * u);            // R 横向渐变
      raw[p++] = Math.round(90 + 120 * v);            // G 纵向渐变
      raw[p++] = Math.round(240 - 120 * (u + v) / 2); // B 反向
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// ── 真 WAV（可播放） ──────────────────────────────────────────────────────
function makeWav(seconds = 2, sampleRate = 44100, freq = 440) {
  const frames = Math.floor(seconds * sampleRate);
  const data = Buffer.alloc(frames * 2);          // 16-bit mono
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    // 440Hz 基频 + 一点点 880Hz 泛音，听起来更像"提示音"而不是纯蜂鸣
    let sample = 0.55 * Math.sin(2 * Math.PI * freq * t) + 0.15 * Math.sin(2 * Math.PI * freq * 2 * t);
    // 淡入淡出 80ms，避免爆音
    const fade = Math.min(1, t / 0.08, (seconds - t) / 0.08);
    sample *= Math.max(0, fade);
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);          // fmt chunk size
  header.writeUInt16LE(1, 20);           // PCM
  header.writeUInt16LE(1, 22);           // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);  // byte rate
  header.writeUInt16LE(2, 32);           // block align
  header.writeUInt16LE(16, 34);          // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// ── 极简 MP4（容器合法、无真实码流） ──────────────────────────────────────
function box(type, ...payloads) {
  const body = Buffer.concat(payloads);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, body]);
}

function fullBox(type, version, flags, ...payloads) {
  const vf = Buffer.alloc(4);
  vf[0] = version;
  vf[1] = (flags >> 16) & 0xff;
  vf[2] = (flags >> 8) & 0xff;
  vf[3] = flags & 0xff;
  return box(type, vf, ...payloads);
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n & 0xffff, 0);
  return b;
}

function str(s) {
  return Buffer.from(s, 'ascii');
}

function makeMp4({ width = 320, height = 180, timescale = 1000, duration = 3000 } = {}) {
  const ftyp = box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso2'), str('avc1'), str('mp41'));
  const mvhd = fullBox('mvhd', 0, 0,
    u32(0), u32(0), u32(timescale), u32(duration),
    u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0),
    u32(0x00010000), u32(0), u32(0), u32(0),
    u32(0x00010000), u32(0), u32(0), u32(0),
    u32(0x40000000), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0),
    u32(0), u32(0), u32(0), u32(0), u32(0), u32(0),
    u32(0), u32(0), u32(0), u32(0), u32(0), u32(0),
    u32(2)
  );

  const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u16(0x55c4), u16(0));
  const hdlr = fullBox('hdlr', 0, 0, u32(0), str('vide'), u32(0), u32(0), u32(0), str('VideoHandler\0'));
  const vmhd = fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0));
  const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
  const avc1 = box('avc1',
    Buffer.alloc(6), u16(1),            // reserved + data_reference_index
    u16(0), u16(0), u32(0), u32(0), u32(0),   // pre_defined/reserved
    u16(width), u16(height),
    u32(0x00480000), u32(0x00480000),   // 72dpi
    u32(0), u16(1),                     // reserved + frame_count
    Buffer.alloc(32),                   // compressorname
    u16(0x0018), u16(0xffff)            // depth + pre_defined
  );
  const stsd = fullBox('stsd', 0, 0, u32(1), avc1);
  const stts = fullBox('stts', 0, 0, u32(0));
  const stsc = fullBox('stsc', 0, 0, u32(0));
  const stsz = fullBox('stsz', 0, 0, u32(0), u32(0));
  const stco = fullBox('stco', 0, 0, u32(0));
  const stbl = box('stbl', stsd, stts, stsc, stsz, stco);
  const minf = box('minf', vmhd, dinf, stbl);
  const mdia = box('mdia', mdhd, hdlr, minf);
  const tkhd = fullBox('tkhd', 0, 3,
    u32(0), u32(0), u32(1), u32(0), u32(duration),
    u32(0), u32(0), u16(0), u16(0), u16(0), u16(0),
    u32(0x00010000), u32(0), u32(0),
    u32(0), u32(0x00010000), u32(0),
    u32(0), u32(0), u32(0x40000000),
    u32(width << 16), u32(height << 16)
  );
  const trak = box('trak', tkhd, mdia);
  const moov = box('moov', mvhd, trak);
  const mdat = box('mdat', Buffer.alloc(1024));   // 占位数据（非真实码流）
  return Buffer.concat([ftyp, moov, mdat]);
}

const files = [
  ['示例-图片.png', makePng(160, 100)],
  ['示例-音频.wav', makeWav()],
  ['示例-视频.mp4', makeMp4()]
];

for (const [name, bytes] of files) {
  writeFileSync(join(outDir, name), bytes);
  console.log(`${name}  ${bytes.length} 字节  首 12 字节=${bytes.subarray(0, 12).toString('hex')}`);
}
