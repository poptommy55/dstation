/**
 * PathGuard —— /dsh-file-opener 路由的路径边界。
 *
 * 语义与 `dsh-media-preview/path-guard.js` 对齐（那份已在生产里跑通），
 * 但**收得更紧**：本模块只回答「这个路径存在吗、是文件还是目录、多大」，
 * 不提供任何文件字节。因此即使被匿名 GET 猜到，也拿不到文件内容。
 *
 * 威胁模型：宿主自定义路由**没有 cookie 鉴权**（只有 /api 前缀有）。
 * 所以任何把本地路径信息暴露给浏览器的路由都必须自己做白名单。
 *
 * 四道闸门：
 *   1. 必须是绝对路径（拒绝相对路径与裸文件名）。
 *   2. 段级拒绝：受保护目录段、点开头的文件。
 *   3. realpath 之后必须落在**允许根**之内（含相等）——符号链接/junction
 *      逃逸在这一步被拆穿。
 *   4. 只读：不提供任何写操作。
 */

import { realpathSync, statSync } from 'node:fs';

/** 禁止出现在路径里的目录段（小写比较）。 */
const DENIED_SEGMENTS = new Set([
  '.ssh', '.aws', '.gnupg', '.gpg', '.kube', '.docker',
  'node_modules', '$recycle.bin', 'system volume information'
]);

/** 允许根列表长度上限，避免畸形配置拖垮匹配。 */
const MAX_ROOTS = 64;

/**
 * 归一化：统一分隔符、收紧尾部分隔符、盘符大写。
 * @param {unknown} value
 * @returns {string}
 */
export function normalizePath(value) {
  let p = String(value ?? '').trim();
  if (!p) return '';
  p = p.replace(/[\\/]+/g, '/');
  if (/^[A-Za-z]:/.test(p)) p = p[0].toUpperCase() + p.slice(1);
  if (p.length > 1 && p.endsWith('/') && !/^[A-Za-z]:\/$/.test(p)) p = p.replace(/\/+$/, '');
  return p;
}

/**
 * 比较用的折叠形式（Windows 不区分大小写）。
 * @param {string} p
 * @returns {string}
 */
function foldKey(p) {
  const n = normalizePath(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

/**
 * child 是否在 root 之内（含相等）。
 * @param {string} root
 * @param {string} child
 * @returns {boolean}
 */
export function isWithin(root, child) {
  const r = foldKey(root);
  const c = foldKey(child);
  if (!r || !c) return false;
  if (r === c) return true;
  const withSep = r.endsWith('/') ? r : `${r}/`;
  return c.startsWith(withSep);
}

/**
 * realpath，失败返回 null（不存在、权限不足、坏 junction…）。
 * @param {string} p
 * @returns {string|null}
 */
export function safeRealpath(p) {
  try {
    return normalizePath(realpathSync.native ? realpathSync.native(p) : realpathSync(p));
  } catch {
    return null;
  }
}

/**
 * 允许根本地化：逐个 realpath，丢掉不存在的，去重。
 * @param {readonly unknown[]} roots
 * @returns {string[]}
 */
export function resolveRoots(roots) {
  const out = [];
  const seen = new Set();
  for (const raw of roots) {
    if (out.length >= MAX_ROOTS) break;
    const text = String(raw ?? '').trim();
    if (!text) continue;
    const real = safeRealpath(text);
    if (real === null) continue;
    const key = foldKey(real);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(real);
  }
  return out;
}

/**
 * 段级拒绝检查。
 * @param {string} normalizedPath - 已 normalizePath 的绝对路径
 * @returns {string|null} 拒绝原因；通过时为 null
 */
export function deniedBySegment(normalizedPath) {
  const segments = normalizedPath.split('/');
  for (const seg of segments) {
    if (!seg) continue;
    const lower = seg.toLowerCase();
    if (/^[a-z]:$/.test(lower)) continue;
    if (DENIED_SEGMENTS.has(lower)) return `路径包含受保护目录 ${seg}`;
  }
  const base = segments[segments.length - 1] ?? '';
  if (base.startsWith('.')) return '点开头的文件不通过本路由暴露';
  return null;
}

/**
 * 取扩展名（小写，含点）；没有则空串。
 * @param {string} p
 * @returns {string}
 */
export function extensionOf(p) {
  const base = normalizePath(p).split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot).toLowerCase();
}

/**
 * 一次解析结果。
 * @typedef {object} InspectOk
 * @property {true} ok
 * @property {string} path - realpath 之后的真实绝对路径
 * @property {string} name - 文件名
 * @property {'file'|'dir'} kind
 * @property {string} ext
 * @property {number} size
 * @property {number} mtimeMs
 *
 * @typedef {object} InspectErr
 * @property {false} ok
 * @property {number} status
 * @property {string} code
 * @property {string} message
 */

/**
 * 校验一个候选路径并返回元数据。
 * @param {unknown} rawPath
 * @param {readonly string[]} roots - 已 realpath 的允许根
 * @returns {InspectOk | InspectErr}
 */
export function inspectPath(rawPath, roots) {
  const asked = String(rawPath ?? '').trim().replace(/^"+|"+$/g, '');
  if (!asked) return fail(400, 'missing_path', '缺少 path');

  const normalized = normalizePath(asked);
  if (!/^([A-Za-z]:\/|\/\/|\/)/.test(normalized)) {
    return fail(400, 'not_absolute', '只接受绝对路径');
  }

  const denied = deniedBySegment(normalized);
  if (denied !== null) return fail(403, 'denied_path', denied);

  const real = safeRealpath(normalized);
  if (real === null) return fail(404, 'not_found', '路径不存在或不可访问');

  const deniedReal = deniedBySegment(real);
  if (deniedReal !== null) return fail(403, 'denied_path', deniedReal);

  if (roots.length === 0) {
    return fail(403, 'no_root', '没有可用的允许根（工作区未确定且未配置 DSH_FILE_OPENER_ROOTS）');
  }
  if (!roots.some((root) => isWithin(root, real))) {
    return fail(403, 'outside_roots', '路径不在任何允许的会话工作区之内');
  }

  let stat;
  try {
    stat = statSync(real);
  } catch {
    return fail(404, 'not_found', '路径不可访问');
  }

  const isDir = stat.isDirectory();
  if (!isDir && !stat.isFile()) return fail(415, 'not_regular', '目标既不是普通文件也不是目录');

  const segments = real.split('/');
  const name = segments[segments.length - 1] ?? real;

  return {
    ok: true,
    path: real,
    name,
    kind: isDir ? 'dir' : 'file',
    ext: isDir ? '' : extensionOf(real),
    size: isDir ? 0 : stat.size,
    mtimeMs: stat.mtimeMs
  };
}

/**
 * @returns {InspectErr}
 */
function fail(status, code, message) {
  return { ok: false, status, code, message };
}
