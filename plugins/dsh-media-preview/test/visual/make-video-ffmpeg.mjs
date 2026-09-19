/**
 * 用 ffmpeg 生成**真能播放**的视频（H.264 MP4）。
 *
 * 为什么要重写：之前手写的 MJPEG-in-MP4 结构上完全合法（48/48 帧校验通过），
 * 但 Chromium 的 <video> 根本不准备解 MJPEG —— JPEG 只在 <img> 里能解。
 * 结论：容器合法 ≠ 浏览器能播，编解码器必须选浏览器真正支持的。
 *
 * 本机已有 ffmpeg（WinGet 装的 Gyan 8.1 full build），因此直接调它编 H.264：
 *   · yuv420p 像素格式 + baseline 级 H.264 → 兼容性最好
 *   · +faststart → moov 前置，浏览器不必下完整个文件就能开播
 *
 * 用法：node test/visual/make-video-ffmpeg.mjs <outFile.mp4> [seconds] [fps] [w] [h]
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';

const [outFile, secondsArg, fpsArg, wArg, hArg] = process.argv.slice(2);
if (outFile === undefined) {
  console.error('usage: make-video-ffmpeg.mjs <outFile.mp4> [seconds] [fps] [w] [h]');
  process.exit(2);
}
const SECONDS = Number(secondsArg ?? 4);
const FPS = Number(fpsArg ?? 15);
const W = Number(wArg ?? 480);
const H = Number(hArg ?? 270);

const FFMPEG = '<user-home>/AppData/Local/Microsoft/Winget/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1-full_build/bin/ffmpeg.exe';
const FFPROBE = '<user-home>/AppData/Local/Microsoft/Winget/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1-full_build/bin/ffprobe.exe';

// ── PNG 写入（每帧一张，交给 ffmpeg 读） ─────────────────────────────────
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
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
};
function makePng(w, h, paint) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(h * (1 + w * 3));
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;
    for (let x = 0; x < w; x++) {
      const c = paint((x + 0.5) / w, (y + 0.5) / h);
      raw[p++] = Math.max(0, Math.min(255, c.r | 0));
      raw[p++] = Math.max(0, Math.min(255, c.g | 0));
      raw[p++] = Math.max(0, Math.min(255, c.b | 0));
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))
  ]);
}

/**
 * 第 i 帧画面：底色渐变 + 随帧移动的圆盘 + 一条扫过的亮带 + 帧号进度条。
 * 元素足够多，肉眼能立刻判断"真的在播"而不是静止画面。
 */
function frame(i, total) {
  const t = i / total;
  const cx = 0.15 + 0.7 * t;
  const cy = 0.5 + 0.18 * Math.sin(t * Math.PI * 2);
  const band = 0.1 + 0.8 * t;
  const bars = Math.floor(total);
  return (u, v) => {
    let r = 24 + 60 * u, g = 28 + 40 * v, b = 52 + 90 * (1 - u);
    // 移动圆盘
    const d = Math.hypot(u - cx, v - cy);
    if (d < 0.16) { r = 255; g = 214; b = 102; }
    else if (d < 0.185) { r = 30; g = 32; b = 40; }
    // 移动亮带
    const db = Math.abs(u - band);
    if (db < 0.03) { r = Math.min(255, r + 140); g = Math.min(255, g + 140); b = Math.min(255, b + 120); }
    // 底部进度条
    if (v > 0.94 && v < 0.98) {
      if (u < t) { r = 62; g = 207; b = 142; } else { r = 50; g = 54; b = 62; }
    }
    return { r, g, b };
  };
}

const work = join(tmpdir(), `dsh-video-${process.pid}`);
mkdirSync(work, { recursive: true });

const totalFrames = Math.max(1, Math.round(SECONDS * FPS));
console.log(`渲染 ${totalFrames} 帧 PNG（${W}x${H}）…`);
for (let i = 0; i < totalFrames; i++) {
  writeFileSync(join(work, `f${String(i).padStart(4, '0')}.png`), makePng(W, H, frame(i, totalFrames)));
}

mkdirSync(dirname(outFile), { recursive: true });
console.log('调用 ffmpeg 编码 H.264 …');
const args = [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-framerate', String(FPS),
  '-i', join(work, 'f%04d.png'),
  '-c:v', 'libx264',
  '-profile:v', 'baseline',        // 兼容性最好的 H.264 档次
  '-level', '3.1',
  '-pix_fmt', 'yuv420p',           // 浏览器 <video> 实际要求
  '-movflags', '+faststart',       // moov 前置：不必下完整个文件就能开播
  '-crf', '26',
  outFile
];
execFileSync(FFMPEG, args, { stdio: ['ignore', 'inherit', 'inherit'] });

// 用 ffprobe 回报真实参数，作为"可播放"的证据
const probe = execFileSync(FFPROBE, [
  '-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=codec_name,profile,width,height,pix_fmt,nb_frames,r_frame_rate,duration',
  '-show_entries', 'format=format_name,duration,size',
  '-of', 'json', outFile
], { encoding: 'utf8' });

const info = JSON.parse(probe);
const s = info.streams?.[0] ?? {};
const f = info.format ?? {};
console.log(`\n${basename(outFile)}`);
console.log(`  codec     = ${s.codec_name} / ${s.profile}`);
console.log(`  尺寸      = ${s.width}x${s.height}  pix_fmt=${s.pix_fmt}`);
console.log(`  帧率/帧数 = ${s.r_frame_rate} / ${s.nb_frames ?? '?'}`);
console.log(`  时长      = ${s.duration ?? f.duration} 秒`);
console.log(`  容器/大小 = ${f.format_name} / ${f.size} 字节`);

rmSync(work, { recursive: true, force: true });
