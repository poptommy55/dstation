/**
 * HTTP Range 解析（RFC 9110 §14）——视频拖动进度条与音频 seek 的前提。
 *
 * 只实现单区间语法 `bytes=a-b` / `bytes=a-` / `bytes=-n`；多区间（逗号）在
 * 播放器场景里没有实际收益，直接退化为「整文件 200」比伪造 multipart 更安全。
 */

/**
 * @typedef {object} RangeOk
 * @property {'ok'} status
 * @property {number} start - 闭区间起点
 * @property {number} end - 闭区间终点
 * @property {number} length
 *
 * @typedef {object} RangeUnsatisfiable
 * @property {'unsatisfiable'} status
 *
 * @typedef {object} RangeIgnored
 * @property {'ignored'} status
 * @property {string} [reason]
 */

/**
 * @param {string|undefined} header - 原始 Range 头
 * @param {number} size - 实体总字节数（必须 > 0）
 * @returns {RangeOk | RangeUnsatisfiable | RangeIgnored}
 */
export function parseRange(header, size) {
  if (typeof header !== 'string' || header.trim() === '') return { status: 'ignored', reason: 'absent' };
  const text = header.trim();
  const match = /^bytes=(.*)$/i.exec(text);
  if (match === null) return { status: 'ignored', reason: 'unit' };
  const spec = match[1].trim();
  if (spec === '') return { status: 'ignored', reason: 'empty' };
  if (spec.includes(',')) return { status: 'ignored', reason: 'multi-range' };
  const parts = /^(\d*)-(\d*)$/.exec(spec);
  if (parts === null) return { status: 'ignored', reason: 'syntax' };

  const [, rawFirst, rawLast] = parts;
  if (rawFirst === '' && rawLast === '') return { status: 'ignored', reason: 'syntax' };
  if (!Number.isSafeInteger(size) || size <= 0) return { status: 'unsatisfiable' };

  // 后缀语法：bytes=-N（最后 N 字节）
  if (rawFirst === '') {
    const suffix = Number(rawLast);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { status: 'unsatisfiable' };
    const start = Math.max(0, size - suffix);
    return { status: 'ok', start, end: size - 1, length: size - start };
  }

  const start = Number(rawFirst);
  if (!Number.isSafeInteger(start) || start < 0) return { status: 'ignored', reason: 'syntax' };
  if (start >= size) return { status: 'unsatisfiable' };

  // 开区间：bytes=N-
  if (rawLast === '') return { status: 'ok', start, end: size - 1, length: size - start };

  const last = Number(rawLast);
  if (!Number.isSafeInteger(last) || last < start) return { status: 'unsatisfiable' };
  const end = Math.min(last, size - 1);
  return { status: 'ok', start, end, length: end - start + 1 };
}

/**
 * 组装 Content-Range 头值。
 * @param {number} start
 * @param {number} end
 * @param {number} size
 * @returns {string}
 */
export function contentRange(start, end, size) {
  return `bytes ${start}-${end}/${size}`;
}
