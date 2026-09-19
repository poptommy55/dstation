/**
 * D-STATION 插件市场 —— 安装器（宿主半）
 *
 * 把「可下载列表里的一个插件」装到本机。整个流程刻意做成**两段式**：
 *   下载+校验 → staging（不改动任何现有文件）
 *   staging   → 原子落盘到 %DSH_HOME%\plugins\<pkg>\
 * 任何一步失败都不留下半成品。
 *
 * ── 安全模型（自建市场 = 自己成为分发方，这几条缺一不可）──────────
 *   ① 每个文件强制 sha256 校验，缺一个就拒绝安装
 *   ② 下载域名白名单：文件 URL 必须以索引的 baseUrl 开头（拒绝 302 到站外）
 *   ③ 路径白名单：无 `..`、无绝对路径、无盘符
 *   ④ 受保护前缀：只允许写 plugins/<pkg>/ 之下
 *   ⑤ 目标已存在则拒绝（不做覆盖式更新 —— 那是阶段 2 的事，要带回滚）
 *
 * ── 为什么逐文件而不是压缩包 ────────────────────────────────────
 *   Node 没有内置 unzip；引依赖或外调 tar 都会破坏"零依赖"这个前提。
 *   逐文件还顺带得到增量更新与细粒度校验。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname, sep, basename } from 'node:path';
import { homedir } from 'node:os';

/** 索引来源。与 D-STATION 应用级 OTA 的 DSTATION_OTA_MANIFEST 同一个套路。 */
// This repository ships NO plugin market server. Set DSTATION_PLUGIN_INDEX, or fill in
// the "index source" field in Settings -> D-STATION Market.
const DEFAULT_INDEX_URL = '';

/** 下载单个文件的体积上限（防止被喂一个超大文件打爆内存）。 */
const MAX_FILE_BYTES = 16 * 1024 * 1024;

/** 整个包的体积上限。 */
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;

const ROW_ID_RE = /^[A-Za-z0-9_.-]+$/;

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/**
 * 运行时索引源覆盖（内存态，不落盘）。
 * 用途：内网/离线部署把市场指到内部镜像；开发时指到本地目录。
 * 优先级：运行时覆盖 > 环境变量 > 内置默认。
 */
let indexOverride = null;

export function setIndexOverride(url) {
  indexOverride = url === null || url === undefined || url === '' ? null : String(url);
  return indexUrl();
}

export function getIndexOverride() {
  return indexOverride;
}

/** 取索引地址：运行时覆盖优先，其次环境变量，最后内置默认。 */
export function indexUrl() {
  return indexOverride || process.env.DSTATION_PLUGIN_INDEX || DEFAULT_INDEX_URL;
}

/* ════════════════════════════════════════════════════════════════════
 * 来源解析：既支持 https，也支持本地目录（离线/联调用）
 * ════════════════════════════════════════════════════════════════════ */

/**
 * 把索引地址解析成「来源描述」。
 * 本地目录形态（以盘符/斜杠开头，或以 file: 开头）会走磁盘读取，
 * 这样在没有服务器的情况下也能把整条安装链路测通。
 */
export function resolveSource() {
  const raw = indexUrl();
  if (!raw) return { kind: 'none', index: '', baseUrl: '' };
  const isHttp = /^https?:\/\//i.test(raw);
  if (isHttp) {
    return { kind: 'http', index: raw, baseUrl: raw.replace(/\/index\.json.*$/i, '') };
  }
  let p = raw;
  if (p.startsWith('file:')) p = p.replace(/^file:\/\//, '');
  if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
  const base = p.replace(/[\\/]index\.json$/i, '');
  return { kind: 'local', index: join(base, 'index.json'), baseUrl: base };
}

/**
 * 把一个清单条目映射到本地磁盘路径。
 *
 * ⚠️ 这里有两次踩坑，都是"URL 空间 ↔ 磁盘空间"没对齐：
 *   ① 拿 url 按 baseUrl 的**长度** slice —— 本地来源下 baseUrl 是磁盘路径、
 *      url 是绝对 HTTP 地址，长度对不上，切出垃圾 → EISDIR。
 *   ② 按 URL 的 pathname 直接拼 —— 线上 URL 带路径前缀（`.../plugins/...`），
 *      本地 store 根**不含**那一段 → 多出一层目录 → ENOENT。
 *   所以：**优先用清单/索引里显式给出的 rel**，退化时才去猜。
 *
 * @param {object} source - resolveSource() 的结果
 * @param {object} item - 清单里的一个文件条目
 * @param {{pkg: string, version: string}} ctx - 包名与版本，供退化用
 */
function localPathFor(source, item, ctx) {
  /* 首选显式 rel；退化：URL 末尾三段 <pkg>/<ver>/<file> */
  const rel = relForUrl(item.url, typeof item.rel === 'string' && item.rel !== '' ? item.rel : null, 3);
  if (ctx && ctx.pkg && !rel.startsWith(`${ctx.pkg}/`)) {
    throw new Error(`清单条目的 rel(${rel}) 与包名(${ctx.pkg}) 不匹配`);
  }
  return join(source.baseUrl, rel.split('/').join(sep));
}

/**
 * 把「一个 URL」映射到本地 store 里的相对路径。
 * @param {string} url - 完整 URL
 * @param {string|null} explicitRel - 显式相对路径（首选）
 * @param {number} [tailSegments] - 退化时取 URL 末尾几段
 */
function relForUrl(url, explicitRel, tailSegments) {
  if (typeof explicitRel === 'string' && explicitRel !== '') {
    const unsafe = checkRelPath(explicitRel);
    if (unsafe) throw new Error(`相对路径不安全 ${explicitRel} (${unsafe})`);
    return explicitRel;
  }
  if (!tailSegments) throw new Error(`这个地址没有显式相对路径，无法在本地定位: ${url}`);
  let pathname = '';
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = String(url);
  }
  const parts = pathname.split('/').filter((s) => s !== '');
  if (parts.length < tailSegments) throw new Error(`URL 结构不足以定位: ${url}`);
  const rel = parts.slice(parts.length - tailSegments).join('/');
  const unsafe = checkRelPath(rel);
  if (unsafe) throw new Error(`相对路径不安全 ${rel} (${unsafe})`);
  return rel;
}

/**
 * 取一个 JSON 资源（索引或清单）。
 * @param {object} source
 * @param {string} url
 * @param {string|null} [explicitRel] - 本地来源下的相对路径（首选）
 * @param {number} [tailSegments] - 本地来源下的退化段数
 */
async function getJson(source, url, explicitRel = null, tailSegments = 0) {
  if (source.kind === 'none') {
    throw new Error('No plugin index source configured: set DSTATION_PLUGIN_INDEX, or fill in the index source field in the market panel.');
  }
  if (source.kind === 'local') {
    const rel = /index\.json$/i.test(url) && !explicitRel ? 'index.json' : relForUrl(url, explicitRel, tailSegments);
    const full = join(source.baseUrl, rel.split('/').join(sep));
    try {
      return JSON.parse(readFileSync(full, 'utf8'));
    } catch (e) {
      throw new Error(`本地读取失败 ${full}: ${e.message}`);
    }
  }
  let res;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch (e) {
    throw new Error(`请求失败 ${url}: ${e.message}`);
  }
  if (!res.ok) throw new Error(`${url} 返回 HTTP ${res.status}`);
  try {
    return await res.json();
  } catch (e) {
    throw new Error(`${url} 不是合法 JSON: ${e.message}`);
  }
}

/**
 * 取一个文件的字节。
 * ⚠️ 域名白名单在这里强制：文件 URL 必须以 baseUrl 开头。
 * 少了这条，清单里塞一个站外 URL 就能把任意内容拉进来。
 */
async function getBytes(source, url, item, ctx) {
  if (source.kind === 'local') {
    const p = localPathFor(source, item, ctx);
    const buf = readFileSync(p);
    if (buf.length > MAX_FILE_BYTES) throw new Error(`文件超过单文件上限: ${item.path}`);
    return buf;
  }
  if (!url.startsWith(`${source.baseUrl}/`) && url !== source.baseUrl) {
    throw new Error(`拒绝从站外下载（不在白名单内）: ${url}`);
  }
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} 返回 HTTP ${res.status}`);
  /* 跟随重定向之后要复核最终地址，防止白名单被 302 绕过 */
  if (res.url && !res.url.startsWith(`${source.baseUrl}/`) && res.url !== source.baseUrl) {
    throw new Error(`拒绝重定向到站外: ${res.url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_FILE_BYTES) throw new Error(`文件超过单文件上限: ${url}`);
  return buf;
}

/* ════════════════════════════════════════════════════════════════════
 * 路径安全
 * ════════════════════════════════════════════════════════════════════ */

/**
 * 校验一个包内相对路径。
 * @returns {string|null} 不安全时返回原因，安全返回 null
 */
export function checkRelPath(rel) {
  if (typeof rel !== 'string' || rel === '') return 'empty path';
  if (rel.includes('..')) return 'contains ..';
  if (rel.startsWith('/') || rel.startsWith('\\')) return 'absolute path';
  if (/^[A-Za-z]:/.test(rel)) return 'drive letter';
  if (rel.includes('\0')) return 'nul byte';
  return null;
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * 🔴 装机前的自洽性校验 —— 最后一道闸门。
 *
 * 为什么必须有它（真实事故）：
 *   一个**没有 package.json** 的包被装进 %DSH_HOME%\plugins\ 并注册进 bundles 之后，
 *   DSH 的 client-modules 会向上找到别的 package.json，把不属于它的 `dsh.client`
 *   声明算到它头上，于是抛：
 *       client-modules: <pkg> declares dsh.client but exports no "./client" bundle
 *   而这个异常发生在 `@deepseek-ai/dsh-client-modules`（**核心条目**）上，
 *   看门狗的策略是**拒绝自动禁用核心条目** ⇒ 整个 DSH 起不来、也不会自愈，
 *   只能人工介入。
 *   ⇒ 结论：**一个坏包能造成全站停机，所以校验必须在写入插件树之前完成。**
 *
 * @param {string} staging - 暂存目录
 * @param {string} pkgName - 期望的包名
 * @returns {{ pkg: object, patchRel: string|null }}
 * @throws {Error} 任何不自洽都抛
 */
function validateStagedPackage(staging, pkgName) {
  const pkgPath = join(staging, 'package.json');
  if (!existsSync(pkgPath)) {
    throw new Error(
      '包里没有 package.json —— 拒绝安装。（缺少包元数据会让 DSH 把别的包的 dsh.client ' +
        '声明算到它头上，进而让核心条目组装失败、整个服务起不来）'
    );
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch (err) {
    throw new Error(`package.json 不是合法 JSON: ${err.message}`);
  }
  if (!pkg || pkg.name !== pkgName) {
    throw new Error(`package.json 的 name(${pkg && pkg.name}) 与清单(${pkgName}) 不一致`);
  }
  if (!pkg.version) throw new Error('package.json 缺 version');

  const existsInStaging = (rel) =>
    existsSync(join(staging, String(rel).replace(/^\.\//, '').split('/').join(sep)));

  /* 声明了 dsh.client → 必须真的能解析出 ./client 束 */
  if (pkg.dsh && pkg.dsh.client) {
    const exp = pkg.exports && typeof pkg.exports === 'object' ? pkg.exports['./client'] : null;
    const file =
      typeof exp === 'string'
        ? exp
        : exp && typeof exp === 'object'
          ? exp.default || exp.import || exp.require || null
          : null;
    if (!file) {
      throw new Error(
        'package.json 声明了 dsh.client，但 exports 里没有 "./client" —— 拒绝安装（会让 dsh-client-modules 组装失败）'
      );
    }
    if (!existsInStaging(file)) {
      throw new Error(`exports["./client"] 指向 ${file}，但包里没有这个文件 —— 拒绝安装`);
    }
  }

  /* 声明了 bundle patch → 补丁文件必须在 */
  const patchRel = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch ? String(pkg.dsh.bundle.patch) : null;
  if (patchRel && !existsInStaging(patchRel)) {
    throw new Error(`dsh.bundle.patch 指向 ${patchRel}，但包里没有这个文件 —— 拒绝安装`);
  }

  return { pkg, patchRel };
}

/** 从补丁文本里取第一个 insert 的 entry id。 */
function firstInsertId(text) {
  const m = /^- insert:\s*\r?\n\s{4}- id:\s*([A-Za-z0-9_.-]+)/m.exec(String(text || ''));
  return m ? m[1] : null;
}

/* ════════════════════════════════════════════════════════════════════
 * 目录状态
 * ════════════════════════════════════════════════════════════════════ */

export function pluginsRoot() {
  return join(dshHome(), 'plugins');
}

function readLocalVersion(pkgName) {
  try {
    const pkg = JSON.parse(readFileSync(join(pluginsRoot(), pkgName, 'package.json'), 'utf8'));
    return pkg && pkg.version ? String(pkg.version) : null;
  } catch {
    return null;
  }
}

/* ════════════════════════════════════════════════════════════════════
 * 目录（可下载列表）
 * ════════════════════════════════════════════════════════════════════ */

/**
 * 拉取索引并把「可下载列表」和本机已装状态合并。
 * @returns {Promise<object>}
 */
export async function listCatalog() {
  const source = resolveSource();
  const index = await getJson(source, source.index);
  if (!index || !Array.isArray(index.plugins)) {
    throw new Error('索引格式不对：缺少 plugins 数组');
  }
  const rows = index.plugins.map((p) => {
    const installedVersion = readLocalVersion(p.name);
    return {
      name: p.name,
      displayName: p.displayName || p.name,
      owner: p.owner || 'unknown',
      verified: p.verified === true,
      category: p.category || 'other',
      description: p.description && typeof p.description === 'object' ? p.description : { zh: String(p.description || ''), en: '' },
      license: p.license || '',
      version: p.latest || null,
      manifest: p.manifest,
      totalSize: Number(p.totalSize) || 0,
      filesCount: Number(p.filesCount) || 0,
      requiresRestart: p.requiresRestart !== false,
      entry: p.entry || null,
      installed: installedVersion !== null,
      installedVersion,
      /* 用 semver 比较，而不是 `!==` —— 否则索引里版本更低时也会显示"有新版本" */
      updateAvailable:
        installedVersion !== null && p.latest ? compareVersions(String(p.latest), installedVersion) > 0 : false
    };
  });
  return {
    source: { kind: source.kind, index: source.index, baseUrl: source.baseUrl },
    updated: index.updated || null,
    count: rows.length,
    plugins: rows
  };
}

/* ════════════════════════════════════════════════════════════════════
 * 操作（Install operation）：长任务 + 轮询进度
 * ════════════════════════════════════════════════════════════════════ */

const operations = new Map();
let opSeq = 0;

function newOperation(kind, pkgName) {
  opSeq += 1;
  const id = `op-${Date.now().toString(36)}-${opSeq}`;
  const op = {
    id,
    kind,
    pkg: pkgName,
    state: 'running',
    phase: 'resolve',
    filesDone: 0,
    filesTotal: 0,
    bytesDone: 0,
    bytesTotal: 0,
    message: '',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    result: null,
    error: null
  };
  operations.set(id, op);
  /* 只保留最近 30 条，避免长跑进程里无限增长 */
  if (operations.size > 30) {
    const oldest = [...operations.keys()][0];
    operations.delete(oldest);
  }
  return op;
}

export function getOperation(id) {
  return operations.get(String(id)) || null;
}

export function listOperations() {
  return [...operations.values()].reverse();
}

/**
 * 安装一个插件。
 *
 * @param {string} pkgName - 索引里的包名
 * @param {(op: object) => void} [onProgress]
 * @returns {Promise<{ ok: boolean, operation: object }>} 不会抛：失败也返回 operation
 */
export async function installPlugin(pkgName, onProgress) {
  const op = newOperation('install', pkgName);
  const tick = () => {
    if (typeof onProgress === 'function') onProgress(op);
  };

  try {
    if (!ROW_ID_RE.test(pkgName)) throw new Error(`包名不合法: ${pkgName}`);

    const source = resolveSource();
    op.phase = 'catalog';
    tick();
    const index = await getJson(source, source.index);
    const entry = (index.plugins || []).find((p) => p.name === pkgName);
    if (!entry) throw new Error(`索引里没有这个插件: ${pkgName}`);
    if (!entry.manifest) throw new Error('索引条目缺 manifest 地址');

    /* ① 目标已存在则拒绝：阶段 1 不做覆盖式更新（更新要带回滚，属于阶段 2） */
    const target = join(pluginsRoot(), pkgName);
    if (existsSync(target)) {
      const v = readLocalVersion(pkgName);
      throw new Error(`本机已安装 ${pkgName}${v ? ' v' + v : ''}；更新功能属于阶段 2，请先卸载或等待新版本`);
    }

    op.phase = 'manifest';
    tick();
    const manifest = await getJson(
      source,
      entry.manifest,
      typeof entry.manifestRel === 'string' ? entry.manifestRel : null,
      3
    );
    if (!manifest || !Array.isArray(manifest.files) || manifest.files.length === 0) {
      throw new Error('manifest 格式不对：files 为空');
    }
    if (manifest.name !== pkgName) {
      throw new Error(`manifest.name(${manifest.name}) 与索引(${pkgName}) 不一致`);
    }

    /* ② 先做全量静态校验，一个不合格就整体拒绝 —— 别下到一半才发现 */
    let total = 0;
    for (const f of manifest.files) {
      const unsafe = checkRelPath(f.path);
      if (unsafe) throw new Error(`路径不安全 ${f.path} (${unsafe})`);
      if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(f.sha256)) {
        throw new Error(`文件缺合法 sha256: ${f.path}`);
      }
      total += Number(f.size) || 0;
    }
    if (total > MAX_PACKAGE_BYTES) throw new Error(`包体超过上限 ${MAX_PACKAGE_BYTES} 字节`);

    /* ③ 下载 + 校验到 staging（此时不动任何现有文件） */
    const staging = join(pluginsRoot(), `.staging-${pkgName}-${Date.now().toString(36)}`);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });

    op.phase = 'download';
    op.filesTotal = manifest.files.length;
    op.bytesTotal = total;
    tick();

    /* 校验结果要留到 try 外面用（结果里的 bundle 以包自己的声明为准） */
    let validated = null;
    let installedEntry = manifest.entry || null;

    try {
      for (let i = 0; i < manifest.files.length; i += 1) {
        const f = manifest.files[i];
        const buf = await getBytes(source, f.url, f, { pkg: pkgName, version: manifest.version });
        if (buf.length !== Number(f.size)) {
          throw new Error(`${f.path} 大小不符（清单 ${f.size} / 实际 ${buf.length}）`);
        }
        const h = sha256(buf);
        if (h.toLowerCase() !== String(f.sha256).toLowerCase()) {
          throw new Error(`${f.path} sha256 校验失败（清单 ${String(f.sha256).slice(0, 12)}… / 实际 ${h.slice(0, 12)}…）`);
        }
        const dest = join(staging, f.path.split('/').join(sep));
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, buf);
        op.filesDone = i + 1;
        op.bytesDone += buf.length;
        op.message = f.path;
        tick();
      }

      /* ④ 🔴 自洽性校验：必须在**碰任何现有文件之前**做完 */
      op.phase = 'validate';
      tick();
      validated = validateStagedPackage(staging, pkgName);

      /* ⑤ 原子落盘：staging 里的东西整体搬到 plugins/<pkg> */
      op.phase = 'install';
      tick();
      mkdirSync(pluginsRoot(), { recursive: true });
      if (existsSync(target)) throw new Error(`目标目录在安装过程中被占用: ${target}`);
      mkdirSync(target, { recursive: true });
      for (const f of manifest.files) {
        const from = join(staging, f.path.split('/').join(sep));
        const to = join(target, f.path.split('/').join(sep));
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }

    /* ⑥ 返回结果。注册进 profile（bundles / dependencies）由调用方做 ——
           因为那需要 profile 路径与补丁语义，属于 index.js 的职责。
           注意：`bundle` 以**包自己 package.json 的声明**为准，不信索引里的缓存值。 */
    const ownBundle = Boolean(validated && validated.patchRel);
    if (validated && validated.patchRel) {
      /* 装完之后从**磁盘上的真实补丁**回读 entry id，而不是信索引里的缓存值 */
      const id = firstInsertId(readFileSync(join(target, validated.patchRel), 'utf8'));
      if (id) installedEntry = id;
    }
    op.state = 'succeeded';
    op.phase = 'done';
    op.result = {
      pkg: pkgName,
      version: manifest.version || null,
      entry: installedEntry,
      bundle: ownBundle,
      installedTo: target,
      filesCount: op.filesDone,
      totalBytes: op.bytesDone,
      requiresRestart: manifest.requiresRestart !== false
    };
    op.finishedAt = new Date().toISOString();
    tick();
    return { ok: true, operation: op };
  } catch (err) {
    op.state = 'failed';
    op.error = err && err.message ? err.message : String(err);
    op.finishedAt = new Date().toISOString();
    tick();
    return { ok: false, operation: op };
  }
}

/**
 * 删除一个插件的落盘目录（卸载的第一步）。
 * 刻意只删 plugins/<pkg>/，不碰 profile 注册 —— 那是调用方的职责。
 */
export function removePluginDir(pkgName) {
  if (!ROW_ID_RE.test(pkgName)) return { ok: false, error: 'bad package name' };
  const target = join(pluginsRoot(), pkgName);
  if (!existsSync(target)) return { ok: true, removed: false, path: target };
  /* 双保险：解析后的目录名必须等于包名，绝不允许删到外面去 */
  if (basename(target) !== pkgName) return { ok: false, error: 'refusing to remove unexpected path' };
  rmSync(target, { recursive: true, force: true });
  return { ok: true, removed: true, path: target };
}

/** 列出 plugins/ 下现存目录（诊断用）。 */
export function listPluginDirs() {
  try {
    return readdirSync(pluginsRoot(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/* ════════════════════════════════════════════════════════════════════
 * 版本比较（语义照抄 D-STATION 应用级 OTA，保持两套行为一致）
 * ════════════════════════════════════════════════════════════════════ */

/** 拆出 核心版本 / 预发布后缀：'1.2.3-rc1+build' -> ['1.2.3','rc1'] */
function splitVersion(v) {
  let s = String(v == null ? '0' : v);
  const plus = s.indexOf('+');
  if (plus >= 0) s = s.slice(0, plus);
  const i = s.indexOf('-');
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
}

function parseNumeric(core) {
  return String(core || '0')
    .split(/[.\-_]/)
    .map((x) => {
      const n = parseInt(x, 10);
      return isNaN(n) ? 0 : n;
    });
}

/**
 * semver 语义的版本比较：1.0.1 > 1.0.0；1.0.0-rc1 < 1.0.0。
 * @returns {number} a>b 返回 1，a<b 返回 -1，相等返回 0
 */
export function compareVersions(a, b) {
  const va = splitVersion(a);
  const vb = splitVersion(b);
  const x = parseNumeric(va[0]);
  const y = parseNumeric(vb[0]);
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    const p = x[i] || 0;
    const q = y[i] || 0;
    if (p > q) return 1;
    if (p < q) return -1;
  }
  const pa = va[1];
  const pb = vb[1];
  if (pa && !pb) return -1;
  if (!pa && pb) return 1;
  if (pa && pb) return pa < pb ? -1 : pa > pb ? 1 : 0;
  return 0;
}

/* ════════════════════════════════════════════════════════════════════
 * 备份 / 回滚
 *
 * ⚠️ 一个必须遵守的约束：`plugins/<pkg>` 是 profile 里 junction 的**目标**。
 *    所以更新时**不能重命名这个目录**（会让 junction 悬空、插件直接失效）。
 *    只能"清空内容 + 重新填充"，因此**原子性靠备份来兜**：
 *    先完整备份 → 再替换 → 失败就整目录还原。
 * ════════════════════════════════════════════════════════════════════ */

export function backupsRoot() {
  return join(dshHome(), 'backups', 'plugins');
}

/** 递归复制目录树。 */
function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const s = join(from, e.name);
    const d = join(to, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else if (e.isFile()) copyFileSync(s, d);
  }
}

/**
 * 清空目录**内容**但保留目录本身。
 * 保留目录本身是硬要求 —— junction 指向它，删掉目录会让插件直接失效。
 */
function emptyDirContents(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir)) {
    rmSync(join(dir, e), { recursive: true, force: true });
  }
}

/**
 * 备份 ID 用的时间戳 + 进程内自增序号。
 *
 * ⚠️ 只精确到秒会**撞 ID**：同一秒内做两次备份，第二次会 rmSync 掉第一份，
 *    于是"回滚到上一版"实际拿到的是更早的那一版 —— 这是失败回滚最不能出的问题。
 *    微秒级时间戳 + 自增序号后，实际不可能重复。
 */
let backupSeq = 0;
function backupStamp() {
  backupSeq += 1;
  const iso = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23);
  return `${iso}-${String(backupSeq).padStart(3, '0')}`;
}

/**
 * 备份一个插件目录。
 * @returns {{ ok: boolean, id?: string, path?: string, bytes?: number, error?: string }}
 */
export function backupPlugin(pkgName) {
  if (!ROW_ID_RE.test(pkgName)) return { ok: false, error: 'bad package name' };
  const target = join(pluginsRoot(), pkgName);
  if (!existsSync(target)) return { ok: false, error: `not installed: ${pkgName}` };
  const stamp = backupStamp();
  const dest = join(backupsRoot(), pkgName, stamp);
  try {
    rmSync(dest, { recursive: true, force: true });
    copyTree(target, dest);
    let bytes = 0;
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else bytes += statSync(join(d, e.name)).size;
      }
    };
    walk(dest);
    return { ok: true, id: stamp, path: dest, bytes };
  } catch (err) {
    return { ok: false, error: `backup failed: ${err && err.message ? err.message : err}` };
  }
}

/** 列出某个插件（或全部）的备份，新的在前。 */
export function listBackups(pkgName) {
  const root = backupsRoot();
  const out = [];
  const scanPkg = (name) => {
    const dir = join(root, name);
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = join(dir, e.name);
      let bytes = 0;
      let files = 0;
      const walk = (d) => {
        for (const x of readdirSync(d, { withFileTypes: true })) {
          if (x.isDirectory()) walk(join(d, x.name));
          else {
            files += 1;
            try {
              bytes += statSync(join(d, x.name)).size;
            } catch {
              /* ignore */
            }
          }
        }
      };
      try {
        walk(p);
      } catch {
        /* ignore */
      }
      out.push({ pkg: name, id: e.name, path: p, files, bytes });
    }
  };
  try {
    if (pkgName) scanPkg(pkgName);
    else for (const e of readdirSync(root, { withFileTypes: true })) if (e.isDirectory()) scanPkg(e.name);
  } catch {
    /* 目录不存在 = 没有备份 */
  }
  out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return out;
}

/** 只保留最近 N 份备份，避免无限增长。 */
function pruneBackups(pkgName, keep = 3) {
  const all = listBackups(pkgName);
  for (const b of all.slice(keep)) {
    try {
      rmSync(b.path, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * 用一份备份还原插件目录。
 * @param {string} pkgName
 * @param {string} [backupId] - 省略则用最新一份
 */
export function rollbackPlugin(pkgName, backupId) {
  if (!ROW_ID_RE.test(pkgName)) return { ok: false, error: 'bad package name' };
  const target = join(pluginsRoot(), pkgName);
  if (!existsSync(target)) return { ok: false, error: `plugin dir missing: ${target}` };
  const all = listBackups(pkgName);
  if (all.length === 0) return { ok: false, error: `no backup for ${pkgName}` };
  const pick = backupId ? all.find((b) => b.id === backupId) : all[0];
  if (!pick) return { ok: false, error: `backup not found: ${backupId}` };
  if (!existsSync(join(pick.path, 'package.json'))) {
    return { ok: false, error: `backup is not a valid package (no package.json): ${pick.path}` };
  }
  try {
    emptyDirContents(target);
    copyTree(pick.path, target);
    return { ok: true, restoredFrom: pick.id, path: target };
  } catch (err) {
    return { ok: false, error: `rollback failed: ${err && err.message ? err.message : err}` };
  }
}

/* ════════════════════════════════════════════════════════════════════
 * 更新（OTA）
 * ════════════════════════════════════════════════════════════════════ */

/**
 * 更新一个已安装的插件。
 *
 * 流程（**每一步都为"可回滚"服务**）：
 *   1. 解析索引 + 清单；比对版本（相同则拒绝）
 *   2. **完整备份**当前目录（备份失败就绝不继续）
 *   3. 下载新版本到 staging，逐文件 sha256 校验
 *   4. 🔴 自洽性闸门（与安装同一套，一条都不能省）
 *   5. 清空目标目录**内容** → 从 staging 重新填充
 *      ⚠️ 不能重命名目标目录（junction 指着它）
 *   6. 任一步失败 → 用备份整目录还原，并把错误如实报出
 *   7. 成功后清理 staging、裁剪旧备份
 *
 * @param {string} pkgName
 * @param {(op: object) => void} [onProgress]
 * @returns {Promise<{ ok: boolean, operation: object }>} 不抛异常
 */
export async function updatePlugin(pkgName, onProgress) {
  const op = newOperation('update', pkgName);
  const tick = () => {
    if (typeof onProgress === 'function') onProgress(op);
  };

  const target = join(pluginsRoot(), pkgName);
  let backup = null;

  try {
    if (!ROW_ID_RE.test(pkgName)) throw new Error(`包名不合法: ${pkgName}`);
    if (!existsSync(target)) throw new Error(`本机没装这个插件: ${pkgName}`);

    const localVersion = readLocalVersion(pkgName);
    if (!localVersion) throw new Error('读不到本地版本（plugins/<pkg>/package.json 缺 version）');

    const source = resolveSource();
    op.phase = 'catalog';
    tick();
    const index = await getJson(source, source.index);
    const entry = (index.plugins || []).find((p) => p.name === pkgName);
    if (!entry) throw new Error(`索引里没有这个插件: ${pkgName}`);
    if (!entry.manifest) throw new Error('索引条目缺 manifest 地址');

    op.phase = 'manifest';
    tick();
    const manifest = await getJson(
      source,
      entry.manifest,
      typeof entry.manifestRel === 'string' ? entry.manifestRel : null,
      3
    );
    if (!manifest || !Array.isArray(manifest.files) || manifest.files.length === 0) {
      throw new Error('manifest 格式不对：files 为空');
    }
    if (manifest.name !== pkgName) {
      throw new Error(`manifest.name(${manifest.name}) 与目标(${pkgName}) 不一致`);
    }

    const remoteVersion = String(manifest.version || '');
    if (!remoteVersion) throw new Error('清单缺 version');
    const cmp = compareVersions(remoteVersion, localVersion);
    if (cmp === 0) throw new Error(`已是最新版本（${localVersion}）`);
    op.fromVersion = localVersion;
    op.toVersion = remoteVersion;
    op.direction = cmp > 0 ? 'upgrade' : 'downgrade';

    /* ② 先备份 —— 备份失败就绝不继续动目标目录 */
    op.phase = 'backup';
    tick();
    backup = backupPlugin(pkgName);
    if (!backup.ok) throw new Error(`备份失败，已中止更新：${backup.error}`);
    op.backupId = backup.id;

    /* ③ 静态校验 + 下载到 staging */
    let total = 0;
    for (const f of manifest.files) {
      const unsafe = checkRelPath(f.path);
      if (unsafe) throw new Error(`路径不安全 ${f.path} (${unsafe})`);
      if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(f.sha256)) {
        throw new Error(`文件缺合法 sha256: ${f.path}`);
      }
      total += Number(f.size) || 0;
    }
    if (total > MAX_PACKAGE_BYTES) throw new Error(`包体超过上限 ${MAX_PACKAGE_BYTES} 字节`);

    const staging = join(pluginsRoot(), `.staging-${pkgName}-${Date.now().toString(36)}`);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });

    op.phase = 'download';
    op.filesTotal = manifest.files.length;
    op.bytesTotal = total;
    tick();

    let patchRel = null;
    try {
      for (let i = 0; i < manifest.files.length; i += 1) {
        const f = manifest.files[i];
        const buf = await getBytes(source, f.url, f, { pkg: pkgName, version: manifest.version });
        if (buf.length !== Number(f.size)) {
          throw new Error(`${f.path} 大小不符（清单 ${f.size} / 实际 ${buf.length}）`);
        }
        const h = sha256(buf);
        if (h.toLowerCase() !== String(f.sha256).toLowerCase()) {
          throw new Error(`${f.path} sha256 校验失败（清单 ${String(f.sha256).slice(0, 12)}… / 实际 ${h.slice(0, 12)}…）`);
        }
        const dest = join(staging, f.path.split('/').join(sep));
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, buf);
        op.filesDone = i + 1;
        op.bytesDone += buf.length;
        op.message = f.path;
        tick();
      }

      /* ④ 自洽性闸门（与安装同一套，一条都不能省） */
      op.phase = 'validate';
      tick();
      const validated = validateStagedPackage(staging, pkgName);
      patchRel = validated ? validated.patchRel : null;

      /* ⑤ 替换：清空内容再填充（不能重命名目录，junction 指着它） */
      op.phase = 'install';
      tick();
      emptyDirContents(target);
      copyTree(staging, target);
    } catch (err) {
      /* ⑥ 失败 → 用备份整目录还原 */
      op.phase = 'rollback';
      tick();
      const restored = rollbackPlugin(pkgName, backup.id);
      op.rolledBack = restored.ok === true;
      op.rollbackError = restored.ok ? null : restored.error;
      throw new Error(
        `${err && err.message ? err.message : err}｜已回滚到 ${localVersion}` +
          (restored.ok ? '' : `（但回滚也失败了：${restored.error}）`)
      );
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }

    pruneBackups(pkgName, 3);

    const entryId =
      patchRel && existsSync(join(target, patchRel))
        ? firstInsertId(readFileSync(join(target, patchRel), 'utf8'))
        : null;

    op.state = 'succeeded';
    op.phase = 'done';
    op.result = {
      pkg: pkgName,
      fromVersion: localVersion,
      toVersion: remoteVersion,
      direction: op.direction,
      entry: entryId,
      installedTo: target,
      backupId: backup.id,
      filesCount: op.filesDone,
      totalBytes: op.bytesDone,
      requiresRestart: manifest.requiresRestart !== false
    };
    op.finishedAt = new Date().toISOString();
    tick();
    return { ok: true, operation: op };
  } catch (err) {
    op.state = 'failed';
    op.error = err && err.message ? err.message : String(err);
    op.finishedAt = new Date().toISOString();
    tick();
    return { ok: false, operation: op };
  }
}
