/**
 * 扩展名 → Content-Type 映射（宿主与浏览器两侧共用同一份事实）。
 *
 * 只列出本插件真正会预览/下载的媒体类型；不在表内的扩展名一律拒绝（404），
 * 这是安全边界的一部分：本路由只服务「媒体」，不是通用文件服务器。
 */

/** @typedef {'image'|'video'|'audio'} MediaKind */

/** @type {Readonly<Record<string, { kind: MediaKind, type: string }>>} */
export const MEDIA_TYPES = Object.freeze({
  // 图片
  png: { kind: 'image', type: 'image/png' },
  jpg: { kind: 'image', type: 'image/jpeg' },
  jpeg: { kind: 'image', type: 'image/jpeg' },
  jfif: { kind: 'image', type: 'image/jpeg' },
  webp: { kind: 'image', type: 'image/webp' },
  gif: { kind: 'image', type: 'image/gif' },
  bmp: { kind: 'image', type: 'image/bmp' },
  avif: { kind: 'image', type: 'image/avif' },
  svg: { kind: 'image', type: 'image/svg+xml' },
  ico: { kind: 'image', type: 'image/x-icon' },
  // 视频
  mp4: { kind: 'video', type: 'video/mp4' },
  m4v: { kind: 'video', type: 'video/mp4' },
  webm: { kind: 'video', type: 'video/webm' },
  ogv: { kind: 'video', type: 'video/ogg' },
  mov: { kind: 'video', type: 'video/quicktime' },
  mkv: { kind: 'video', type: 'video/x-matroska' },
  // 音频
  mp3: { kind: 'audio', type: 'audio/mpeg' },
  m4a: { kind: 'audio', type: 'audio/mp4' },
  aac: { kind: 'audio', type: 'audio/aac' },
  wav: { kind: 'audio', type: 'audio/wav' },
  flac: { kind: 'audio', type: 'audio/flac' },
  ogg: { kind: 'audio', type: 'audio/ogg' },
  oga: { kind: 'audio', type: 'audio/ogg' },
  opus: { kind: 'audio', type: 'audio/ogg' },
  weba: { kind: 'audio', type: 'audio/webm' }
});

/** 浏览器侧「这段文本里可能是媒体路径」的粗筛正则用到的扩展名（含点号）。 */
export const MEDIA_EXTENSIONS = Object.freeze(
  Object.keys(MEDIA_TYPES).map((ext) => `.${ext}`)
);

/**
 * 取路径的扩展名（小写、不含点号）。
 * @param {string} filePath
 * @returns {string}
 */
export function extensionOf(filePath) {
  const name = String(filePath ?? '');
  const at = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  const base = at >= 0 ? name.slice(at + 1) : name;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/**
 * 按扩展名判定媒体类型。
 * @param {string} filePath
 * @returns {{ kind: MediaKind, type: string } | null}
 */
export function mediaTypeOf(filePath) {
  const ext = extensionOf(filePath);
  return Object.prototype.hasOwnProperty.call(MEDIA_TYPES, ext) ? MEDIA_TYPES[ext] : null;
}
