/**
 * PathGuard —— /dsh-media 路由的文件访问边界。
 *
 * 这一层是安全核心，改动前先读完全文。
 *
 * 威胁模型：这条路由是**浏览器可直接 GET 的匿名路由**（不在 /api 前缀下，
 * 因此没有 dsh-client-connection 的 cookie 鉴权；见 dsh-host-webserver 与
 * dsh-client-connection 的 README）。它必须只服务「会话工作区里的媒体文件」，
 * 否则一旦本机有页面/脚本猜到端口，就能拿它当任意文件读取通道。
 *
 * 四道闸门，缺一不可：
 *   1. 扩展名白名单：只放行 MEDIA_TYPES 里的媒体后缀（mime.js）。
 *   2. 根白名单：realpath 之后必须落在某个允许根之内（含相等）。realpath 是关键
 *      —— 符号链接/junction 逃逸在这一步就被拆穿。
 *   3. 拒绝对隐私目录：.ssh/.aws/.gnupg 等路径段，以及以 . 开头的文件（.env 等）。
 *      这条是纵深防御：允许根通常就是工作区，但工作区里也可能被塞了密钥。
 *   4. 只读：本模块不提供任何写操作。
 */

import { realpathSync, statSync } from 'node:fs';
import { sep } from 'node:path';

/** 禁止出现在路径里的目录段（小写比较）。 */
const DENIED_SEGMENTS = new Set([
  '.ssh', '.aws', '.gnupg', '.gpg', '.kube', '.docker',
  'node_modules', '$recycle.bin', 'system volume information'
]);

/** 允许根列表里长度上限，避免畸形配置拖垮匹配。 */
const MAX_ROOTS = 64;

/**
 * 归一化：统一分隔符、去掉尾部分隔符、Windows 下小写（盘符大小写不敏感）。
 * @param {unknown} value
 * @returns {string}
 */
export function normalizePath(value) {
  let p = String(value ?? '').trim();
  if (!p) return '';
  // 统一分隔符，并折叠重复分隔符（保留 UNC 前缀的双反斜杠）
  p = p.replace(/[\\/]+/g, '/');
  if (/^[A-Za-z]:/.test(p)) p = p[0].toUpperCase() + p.slice(1);
  // 去尾部斜杠（根 "D:/" 除外）
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
 * realpath，失败返回 null（不存在的路径、权限不足、坏 junction…）。
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
 * 允许根本地化：逐个 realpath，丢掉不存在的。去重。
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
 * 检查路径段级别的拒绝项。
 * @param {string} normalizedPath - 已 normalizePath 的绝对路径
 * @returns {string|null} 拒绝原因；通过时为 null
 */
export function deniedBySegment(normalizedPath) {
  const segments = normalizedPath.split('/');
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg) continue;
    const lower = seg.toLowerCase();
    // 盘符段（D:）与 UNC 空段跳过
    if (/^[a-z]:$/.test(lower)) continue;
    if (DENIED_SEGMENTS.has(lower)) return `路径包含受保护目录 ${seg}`;
  }
  const base = segments[segments.length - 1] ?? '';
  if (base.startsWith('.')) return '点开头的文件不通过媒体路由暴露';
  return null;
}

/**
 * 一次解析结果。
 * @typedef {object} ResolveOk
 * @property {true} ok
 * @property {string} path - 真实绝对路径（realpath 之后）
 * @property {number} size
 * @property {number} mtimeMs
 * @property {{kind: string, type: string}} media
 * @property {string} name - 文件名
 *
 * @typedef {object} ResolveErr
 * @property {false} ok
 * @property {number} status
 * @property {string} code
 * @property {string} message
 */

export class PathGuard {
  /**
   * @param {object} options
   * @param {() => readonly string[]} options.roots - 每次调用都重新取根的提供者（根会随会话/工作区变化）
   */
  constructor(options) {
    /** @type {() => readonly string[]} */
    this.rootsOf = options.roots;
  }

  /** @returns {string[]} 当前允许根（已 realpath 去重） */
  roots() {
    return resolveRoots(this.rootsOf());
  }

  /**
   * 解析一个候选媒体路径。
   * @param {unknown} rawPath
   * @param {(p: string) => ({kind: string, type: string}|null)} mediaTypeOf
   * @returns {ResolveOk | ResolveErr}
   */
  resolve(rawPath, mediaTypeOf) {
    const asked = String(rawPath ?? '').trim().replace(/^"+|"+$/g, '');
    if (!asked) return err(400, 'missing_path', '缺少 path 参数');

    const normalized = normalizePath(asked);
    if (!/^([A-Za-z]:\/|\/\/|\/)/.test(normalized)) {
      return err(400, 'not_absolute', 'path 必须是绝对路径');
    }

    const media = mediaTypeOf(normalized);
    if (media === null) {
      return err(415, 'unsupported_media', '不是受支持的媒体扩展名（图片/视频/音频）');
    }

    const denied = deniedBySegment(normalized);
    if (denied !== null) return err(403, 'denied_path', denied);

    const real = safeRealpath(normalized);
    if (real === null) return err(404, 'not_found', '文件不存在或不可访问');

    const deniedReal = deniedBySegment(real);
    if (deniedReal !== null) return err(403, 'denied_path', deniedReal);

    let stat;
    try {
      stat = statSync(real);
    } catch {
      return err(404, 'not_found', '文件不可访问');
    }
    if (!stat.isFile()) return err(404, 'not_a_file', '目标不是一个普通文件');

    const roots = this.roots();
    if (roots.length === 0) {
      return err(403, 'no_root', '没有可用的允许根（工作区未确定且未配置 DSH_MEDIA_ROOTS）');
    }
    for (const root of roots) {
      if (isWithin(root, real)) {
        return {
          ok: true,
          path: real,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          media,
          name: real.slice(real.lastIndexOf('/') + 1) || real.split(sep).pop() || 'media'
        };
      }
    }
    return err(403, 'outside_roots', '拒绝访问：文件不在任何允许的会话工作区之内');
  }
}

/**
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @returns {ResolveErr}
 */
function err(status, code, message) {
  return { ok: false, status, code, message };
}
