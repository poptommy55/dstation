/**
 * 生成一批**真实可用**的测试样本（图片 / 音频 / 视频），供人工在对话里试预览与下载。
 *
 * 与 make-samples.mjs 的区别：这个脚本产出的每一样都是"能看/能听/能播"的：
 *   · PNG：真彩色渐变 + 几何图形，三种尺寸（宽屏 / 竖版 / 方形）
 *   · WAV：三音和弦琶音，比纯正弦更像"内容"
 *   · MP4：调用 make-video.mjs 产出的 MJPEG-in-MP4（真能播放）
 *
 * 用法：node test/visual/make-showcase.mjs <outDir>
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const outDir = process.argv[2];
if (outDir === undefined) {
  console.error('usage: make-showcase.mjs <outDir>');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
};

/**
 * 造一张 24 位 PNG。
 * @param {number} w
 * @param {number} h
 * @param {(u:number,v:number)=>{r:number,g:number,b:number}} paint
 */
function makePng(w, h, paint) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(h * (1 + w * 3));
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    for (let x = 0; x < w; x++) {
      const c = paint((x + 0.5) / w, (y + 0.5) / h);
      raw[p++] = Math.max(0, Math.min(255, Math.round(c.r)));
      raw[p++] = Math.max(0, Math.min(255, Math.round(c.g)));
      raw[p++] = Math.max(0, Math.min(255, Math.round(c.b)));
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** 圆盘 + 渐变：既能看清颜色，也能一眼看出图片被正确缩放 */
function disc(cx, cy, r, color) {
  return (u, v) => {
    const d = Math.hypot(u - cx, v - cy);
    return d < r ? color : null;
  };
}

function compose(...layers) {
  return (u, v) => {
    for (const layer of layers) {
      const c = layer(u, v);
      if (c !== null) return c;
    }
    return { r: 20, g: 22, b: 28 };
  };
}

const images = [
  {
    name: '示例-图片-宽屏.png',
    w: 960, h: 540,
    paint: compose(
      disc(0.28, 0.45, 0.2, { r: 255, g: 214, b: 102 }),
      disc(0.5, 0.45, 0.2, { r: 102, g: 214, b: 255 }),
      disc(0.72, 0.45, 0.2, { r: 255, g: 120, b: 160 }),
      (u, v) => ({ r: 24 + 40 * u, g: 26 + 30 * v, b: 46 })
    )
  },
  {
    name: '示例-图片-竖版.png',
    w: 480, h: 800,
    paint: compose(
      (u, v) => ({ r: 20 + 90 * (1 - v), g: 30 + 130 * u, b: 40 + 160 * v })
    )
  },
  {
    name: '示例-图片-方形.png',
    w: 600, h: 600,
    paint: compose(
      disc(0.5, 0.5, 0.42, { r: 62, g: 207, b: 142 }),
      disc(0.5, 0.5, 0.24, { r: 20, g: 22, b: 28 }),
      (u, v) => ({ r: 30 + 60 * u, g: 30 + 20 * v, b: 36 })
    )
  }
];

for (const img of images) {
  const bytes = makePng(img.w, img.h, img.paint);
  const file = join(outDir, img.name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  console.log(`${img.name}  ${bytes.length} 字节  ${img.w}x${img.h}`);
}

/** 造 WAV：三音琶音 + 和弦，4 秒，44.1kHz 立体声 */
function makeArpeggioWav(seconds = 4, rate = 44100) {
  const frames = Math.floor(seconds * rate);
  const data = Buffer.alloc(frames * 4);   // 16-bit stereo
  const chord = [220, 277.18, 329.63, 440];   // A3 / C#4 / E4 / A4
  const stepDur = seconds / chord.length;
  for (let i = 0; i < frames; i++) {
    const t = i / rate;
    const idx = Math.min(chord.length - 1, Math.floor(t / stepDur));
    const f0 = chord[idx];
    let s = 0.42 * Math.sin(2 * Math.PI * f0 * t)
      + 0.18 * Math.sin(2 * Math.PI * f0 * 2 * t)
      + 0.10 * Math.sin(2 * Math.PI * f0 * 3 * t);
    // 每个音头淡入，避免爆音
    const localT = t - idx * stepDur;
    s *= Math.min(1, localT / 0.03);
    // 整段淡出
    s *= Math.min(1, Math.max(0, (seconds - t) / 0.25));
    const v = Math.max(-32768, Math.min(32767, Math.round(s * 22000)));
    data.writeInt16LE(v, i * 4);
    data.writeInt16LE(v, i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);          // stereo
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const wav = makeArpeggioWav();
const wavFile = join(outDir, '示例-音频-琶音.wav');
writeFileSync(wavFile, wav);
console.log(`示例-音频-琶音.wav  ${wav.length} 字节  4 秒 立体声 44.1kHz`);

// 视频交给 make-video.mjs（MJPEG-in-MP4，真能播）
const here = dirname(fileURLToPath(import.meta.url));
const videoFile = join(outDir, '示例-视频-可播放.mp4');
try {
  const output = execFileSync(process.execPath, [join(here, 'make-video.mjs'), videoFile, '4', '12', '480', '270'], { encoding: 'utf8' });
  console.log(output.trim());
} catch (error) {
  console.error('视频生成失败：', error.message);
}

console.log('\n全部写入：' + outDir);
