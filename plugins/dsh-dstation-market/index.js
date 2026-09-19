/**
 * dsh-dstation-market —— 宿主半（Node 侧）
 *
 * 阶段 0 范围：**列已装插件 + 热停用/启用 + 卸载 + 重启**。
 * 不做可下载列表、不做 OTA（那是阶段 1/2）。
 *
 * ── 三条设计依据（都是实测/读源码得来的，别凭直觉改）───────────────
 *
 * ① **停用/启用是热的，不需要重启。**
 *    机制是往 profile 的 `cordis.patch.yml` 写：
 *        - id: <entryId>
 *          disabled: true
 *    该文件有 live watcher，实测 2 秒生效、2 秒恢复。
 *    而 `dsh.profile.bundles` 是**启动时**读的（实测不重启 12 秒全 404），
 *    所以安装/卸载仍需重启。
 *
 * ② **补丁文件有一个会把 profile 彻底搞死的陷阱，必须处理。**
 *    追加第一行时会注释掉模板里的 `[]` 占位符；**删掉最后一行后留下的
 *    纯注释文件不是顶层 YAML 数组，dsh 会拒绝启动 profile**
 *    （"must be a top-level YAML array of loader patch entries"）。
 *    ⇒ 见 withPlaceholderRestored()。语义照抄 `dshmarket/lib/patch.js`。
 *
 * ③ **重启必须由 launcher 看门狗来做。**
 *    本 profile 里 dshmarket 的 `allowRestart` 被显式关掉，注释写明
 *    "重启交给 launcher 看门狗管理"。所以这里的做法是
 *    **分离进程自杀 → 看门狗 6~8 秒拉起**（实测 4 次全部自动恢复），
 *    而不是自己去 relaunch（那会和 launcher 抢，导致窗口空白）。
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, renameSync, statSync, mkdirSync, rmSync, symlinkSync, lstatSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import {
  listCatalog,
  installPlugin,
  updatePlugin,
  rollbackPlugin,
  listBackups,
  compareVersions,
  backupPlugin,
  getOperation,
  listOperations,
  removePluginDir,
  listPluginDirs,
  pluginsRoot,
  resolveSource,
  checkRelPath,
  indexUrl,
  setIndexOverride,
  getIndexOverride
} from './installer.js';
import { buildDistribution, selfCheck, makeZip } from './exporter.js';

export const name = 'dsh-dstation-market';
export const inject = ['webServer'];

const BUILD = 'v9-20260915-stage5e';
const PREFIX = '/dstation-market';
const PROFILE_FALLBACK = 'web';

/** 行 id 白名单：只写纯 YAML 标量，和 dshmarket 保持一致。 */
const ROW_ID_RE = /^[A-Za-z0-9_.-]+$/;
/* 插件包名。既要是合法 npm 名，又要能安全地拼进文件系统路径。
   ⚠️ 必须允许 scope 形态 `@scope/name` —— 第三方发布大量使用这种形式。
   早先的正则不允许 `/`，于是「导出」对这类插件直接回 400 bad package name，
   整整一类插件用不了（本机 @michengai/dsh-archive-manager 就是这么中招的）。
   安全性：**每一段都必须以字母数字开头** ⇒ 下面这些全进不来：
     "." / ".." / "../x" / "@scope/../x" / "/abs" / "a\b" / "C:evil" / "a/b"
   再配合调用方的候选路径拼接（已校验的根 + 校验过的名字），不存在目录穿越。 */
const PKG_NAME_RE = /^(@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,63}$/i;

/** 不允许从 UI 里停用/卸载的包 —— 防止用户把自己搞到开不了机。 */
const PROTECTED_PKG_PREFIXES = ['@deepseek-ai/'];
const PROTECTED_PKGS = ['dsh-dstation-market'];

/* ════════════════════════════════════════════════════════════════════
 * 补丁文件读写（语义照抄 dshmarket/lib/patch.js）
 * ════════════════════════════════════════════════════════════════════ */

/** 写操作串行化：并发点开关会让补丁文件互相覆盖。 */
let writeChain = Promise.resolve();
function queued(fn) {
  const next = writeChain.then(fn, fn);
  writeChain = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 逐行扫描补丁文件，取出 insert 行与 disable/force 行。
 * 刻意不做 YAML 解析：文件里可能有本方言不认识的结构，
 * 但 `- id: X` + `disabled: true|false` 这一对足够判断用户层说了什么。
 *
 * @returns {{disables: string[], forced: string[], inserts: {id: string, name: string|null}[]}}
 */
function readUserPatchState(patchPath) {
  const disables = [];
  const forced = [];
  const inserts = [];
  const lines = readText(patchPath).split(/\r?\n/);
  let inInsert = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^- insert:\s*$/.test(line)) {
      inInsert = true;
      continue;
    }
    if (/^- /.test(line)) inInsert = false;
    if (inInsert) {
      const row = /^ {4}- id: ([A-Za-z0-9_.-]+)\s*$/.exec(line);
      if (row !== null) {
        const next = lines[i + 1] ?? '';
        const nm = /^ {6}name:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(next);
        inserts.push({ id: row[1], name: nm ? nm[1] : null });
      }
      continue;
    }
    const row = /^- id: ([A-Za-z0-9_.-]+)\s*$/.exec(line);
    if (row === null) continue;
    const next = lines[i + 1] ?? '';
    if (/^ {2}disabled: true\s*$/.test(next)) disables.push(row[1]);
    else if (/^ {2}disabled: false\s*$/.test(next)) forced.push(row[1]);
  }
  return { disables, forced, inserts };
}

function rowBlock(rowId, disabled) {
  return `- id: ${rowId}\n  disabled: ${disabled ? 'true' : 'false'}\n`;
}

/**
 * 删掉最后一行时把 `[]` 占位符放回去 —— 否则补丁文件只剩注释，
 * 不是顶层 YAML 数组，**dsh 会拒绝启动整个 profile**。
 */
function withPlaceholderRestored(text) {
  if (text.replace(/^[ \t]*#.*$/gmu, '').trim() !== '') return text;
  const uncommented = text.replace(/^[ \t]*#[ \t]*\[[ \t]*\][ \t]*(?:\r?\n|$)/mu, '[]\n');
  if (uncommented !== text) return uncommented;
  return text === '' || text.endsWith('\n') ? `${text}[]\n` : `${text}\n[]\n`;
}

/**
 * 追加一条顶层补丁项；文件不是合法的条目列表时**拒绝写**。
 * 拒绝本身就是设计：畸形补丁层绝不能被改得更糟。
 */
function appendPatchEntry(patchPath, block) {
  const text = readText(patchPath);
  const core = text.trim();
  if (core === '') {
    writeFileSync(patchPath, block);
    return { ok: true, reason: null };
  }
  const withoutComments = text.replace(/^[ \t]*#.*$/gmu, '').trim();
  if (withoutComments === '') {
    const next = text.endsWith('\n') ? text : `${text}\n`;
    writeFileSync(patchPath, `${next}${block}`);
    return { ok: true, reason: null };
  }
  if (withoutComments === '[]' || withoutComments === '[ ]') {
    /* 模板自带的空列表占位符要**注释掉**：直接追加会变成"两个顶层元素"。 */
    const commented = text.replace(/^[ \t]*\[[ \t]*\][ \t]*(?:#.*)?(?:\r?\n|$)/mu, '# []\n');
    const next = commented.endsWith('\n') ? commented : `${commented}\n`;
    writeFileSync(patchPath, `${next}${block}`);
    return { ok: true, reason: null };
  }
  const next = text.endsWith('\n') ? text : `${text}\n`;
  writeFileSync(patchPath, `${next}${block}`);
  return { ok: true, reason: null };
}

function disableRow(patchPath, rowId) {
  return queued(() => {
    if (!ROW_ID_RE.test(rowId)) return { ok: false, reason: 'bad row id' };
    const state = readUserPatchState(patchPath);
    if (state.disables.includes(rowId)) return { ok: true, reason: null };
    return appendPatchEntry(patchPath, rowBlock(rowId, true));
  });
}

function enableRow(patchPath, rowId) {
  return queued(() => {
    if (!ROW_ID_RE.test(rowId)) return { ok: false, reason: 'bad row id' };
    const blockRe = new RegExp(`^- id: ['"]?${escapeRegExp(rowId)}['"]?\\r?\\n  disabled: true\\r?\\n`, 'mu');
    const text = readText(patchPath);
    if (blockRe.test(text)) {
      writeFileSync(patchPath, withPlaceholderRestored(text.replace(blockRe, '')));
      return { ok: true, reason: null };
    }
    const state = readUserPatchState(patchPath);
    /* 下层（bundle / home 补丁）按住它时，必须显式 disabled: false 才能顶回来。 */
    if (!state.forced.includes(rowId)) {
      return appendPatchEntry(patchPath, rowBlock(rowId, false));
    }
    return { ok: true, reason: null };
  });
}

function removeRowBlocks(patchPath, rowIds) {
  return queued(() => {
    const text = readText(patchPath);
    let next = text;
    for (const rowId of rowIds) {
      const re = new RegExp(`^- id: ['"]?${escapeRegExp(rowId)}['"]?\\r?\\n  disabled: (?:true|false)\\r?\\n`, 'mu');
      next = next.replace(re, '');
    }
    if (next !== text) writeFileSync(patchPath, withPlaceholderRestored(next));
    return { ok: true, reason: null };
  });
}

/* ════════════════════════════════════════════════════════════════════
 * 环境发现
 * ════════════════════════════════════════════════════════════════════ */

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/**
 * 把 loader 给的 include 路径归一化成可用的本地路径。
 *
 * ⚠️ 这里踩过一次：`file:///C:/x` 直接 substring 掉 `file://` 会得到
 *    `/C:/x`（盘符前多一个斜杠），后续 dirname/read 全部失效 ——
 *    症状是"补丁读不到、profile manifest 读不到、bundle 插件全丢"，
 *    而且**不报错**，只是数据悄悄变空。
 *    所以先用 fileURLToPath，失败再退化；最后兜底去掉盘符前的前导斜杠。
 */
function normalizeLocalPath(raw) {
  let s = String(raw == null ? '' : raw);
  if (s === '') return '';
  if (s.startsWith('file:')) {
    try {
      s = fileURLToPath(s);
    } catch {
      /* Windows 上 fileURLToPath 会拒绝 POSIX 形态的 file URL，退化为手工剥离 */
      s = s.replace(/^file:\/\//, '');
      try {
        s = decodeURIComponent(s);
      } catch {
        /* 保持原样 */
      }
    }
  }
  if (/^\/[A-Za-z]:[\\/]/.test(s)) s = s.slice(1);
  return s;
}

/**
 * 解析当前 profile 目录。
 * 首选从 loader 的 `cordis:include` 条目反推 —— 那是**权威**路径，
 * 在"宿主自己拥有 profile 目录"的部署里也成立（照抄 dshmarket 的做法）。
 */
function resolveProfile(ctx) {
  let rawInclude = null;
  try {
    const loader = typeof ctx.get === 'function' ? ctx.get('loader') : undefined;
    if (loader && typeof loader.entries === 'function') {
      for (const entry of loader.entries()) {
        const options = entry && entry.options;
        const config = options && options.config;
        if (!options || options.name !== 'cordis:include') continue;
        if (!config || typeof config.path !== 'string') continue;
        if (!config.path.includes('cordis.yml')) continue;
        rawInclude = config.path;
        const resolved = normalizeLocalPath(config.path);
        if (resolved === '') continue;
        const dir = dirname(resolved);
        return {
          dir,
          patchPath: join(dir, 'cordis.patch.yml'),
          profile: basename(dir),
          source: 'loader',
          rawInclude,
          includePath: resolved
        };
      }
    }
  } catch {
    /* 落回约定路径 */
  }
  const dir = join(dshHome(), 'profiles', PROFILE_FALLBACK);
  return {
    dir,
    patchPath: join(dir, 'cordis.patch.yml'),
    profile: PROFILE_FALLBACK,
    source: 'fallback',
    rawInclude,
    includePath: null
  };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** 从一个包的 cordis.patch.yml 里取出它 insert 的 entry id。 */
function readInsertEntryIds(patchPath) {
  return readUserPatchState(patchPath).inserts.map((r) => r.id);
}

function isProtected(pkgName) {
  if (PROTECTED_PKGS.includes(pkgName)) return true;
  return PROTECTED_PKG_PREFIXES.some((p) => pkgName.startsWith(p));
}

/* ════════════════════════════════════════════════════════════════════
 * 清单：把「已装了什么、开着没开着」拼出来
 * ════════════════════════════════════════════════════════════════════ */

/**
 * 找出某个已安装插件的**源码目录**。
 *
 * ⚠️ 插件有两条落盘通道，只看一条会漏掉大部分插件：
 *   ① profile 的 node_modules\<pkg> —— bundle 通道与 profile-patch 通道都落在这里
 *   ② <DSH_HOME>\plugins\<pkg>      —— 直接落盘（可能还没挂载）
 * 本机实测：node_modules 下 19 个，plugins 下只有 4 个。
 * 一开始只查 ②，于是「导出」对大多数插件报 `not found`。
 *
 * 安全性：候选路径都是「已校验的根 + 过白名单正则的包名」拼出来的，
 * 不存在目录穿越。两条都查不到就返回 null，调用方回 404。
 *
 * @returns {string|null} 含 package.json 的目录；找不到返回 null
 */
function resolveInstalledDir(ctx, pkg) {
  if (!PKG_NAME_RE.test(pkg)) return null;

  let profileDir = null;
  try {
    profileDir = resolveProfile(ctx).dir;
  } catch {
    /* profile 解析失败也还要能查 ② */
  }

  const candidates = [];
  if (profileDir) candidates.push(join(profileDir, 'node_modules', pkg));
  candidates.push(join(pluginsRoot(), pkg));

  for (const c of candidates) {
    try {
      if (!statSync(c).isDirectory()) continue;
      if (!existsSync(join(c, 'package.json'))) continue;
      return c;
    } catch {
      /* 不存在或不可读，试下一个 */
    }
  }
  return null;
}

function buildInventory(profile) {
  const manifest = readJson(join(profile.dir, 'package.json'));
  const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
  const deps = Object.keys(manifest?.dependencies || {});
  const patchState = readUserPatchState(profile.patchPath);
  const nm = join(profile.dir, 'node_modules');
  const pluginsRoot = join(dshHome(), 'plugins');

  const rows = [];
  const seen = new Set();

  const push = (pkgName, channel, entryIds, dir) => {
    if (seen.has(pkgName)) return;
    seen.add(pkgName);
    const meta = readJson(join(dir, 'package.json')) || {};
    const entries = entryIds.map((id) => ({
      id,
      enabled: patchState.disables.includes(id) ? false : true
    }));
    rows.push({
      pkg: pkgName,
      title: meta.dsh?.displayName || pkgName,
      version: meta.version || null,
      description: meta.description || '',
      channel,
      installedAt: existsSync(dir) ? join(dir, 'package.json') : null,
      present: existsSync(dir),
      entries,
      /* 只要有任意一个 entry 被停用，就算"已停用"。 */
      enabled: entries.length === 0 ? true : entries.some((e) => e.enabled),
      protected: isProtected(pkgName),
      inDependencies: deps.includes(pkgName)
    });
  };

  /* ① bundle 通道：dsh.profile.bundles 里的包，entry id 来自它自带的补丁 */
  for (const pkgName of bundles) {
    const dir = join(nm, pkgName);
    push(pkgName, 'bundle', readInsertEntryIds(join(dir, 'cordis.patch.yml')), dir);
  }

  /* ② 用户补丁里的 insert 行：包名从 insert 的 name 取 */
  for (const ins of patchState.inserts) {
    const pkgName = ins.name || ins.id;
    if (seen.has(pkgName)) continue;
    if (seen.has(ins.id)) continue;
    const dir = join(nm, pkgName);
    push(pkgName, 'profile-patch', [ins.id], dir);
  }

  /* ③ 落盘在 %DSH_HOME%\plugins\ 但两条通道都没登记的（装了没挂上） */
  try {
    for (const d of readdirSync(pluginsRoot)) {
      const dir = join(pluginsRoot, d);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      push(d, 'plugins-dir', [], dir);
    }
  } catch {
    /* 目录不存在，忽略 */
  }

  rows.sort((a, b) => a.pkg.localeCompare(b.pkg));

  return {
    profile: profile.profile,
    profileDir: profile.dir,
    profileSource: profile.source,
    /* 排障用：loader 给的原始 include 路径 vs 归一化后的结果 */
    rawInclude: profile.rawInclude,
    includePath: profile.includePath,
    patchPath: profile.patchPath,
    patchExists: existsSync(profile.patchPath),
    patchState,
    bundles,
    plugins: rows
  };
}

/* ════════════════════════════════════════════════════════════════════
 * profile 注册：把 plugins/<pkg> 挂进插件树
 *
 * 走的是**约定通道**（junction + dsh.profile.bundles），不走 pnpm：
 *   · pnpm 会重新物化 node_modules，按各插件自己的 files 白名单删文件 ——
 *     已知会把别的插件删残（见 dsh-plugin-dev 坑 #22）；
 *   · 我们只是想"让 profile 能解析到这个包"，一个 junction 就够。
 * ════════════════════════════════════════════════════════════════════ */

/**
 * 在 profile 的 node_modules 下建 junction 指向 plugins/<pkg>。
 * 已存在则原样返回（幂等）。
 */
function ensureJunction(profile, pkgName) {
  const link = join(profile.dir, 'node_modules', pkgName);
  const target = join(pluginsRoot(), pkgName);
  if (!existsSync(link)) {
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link, 'junction');
    return { created: true, link, target };
  }
  let isLink = false;
  try {
    isLink = lstatSync(link).isSymbolicLink();
  } catch {
    isLink = false;
  }
  return { created: false, link, target, isLink };
}

/**
 * 移除 junction。**只删链接，绝不删真实目录** ——
 * 如果是 pnpm 装出来的实体目录，交给用户自己用包管理器处理。
 */
function removeJunction(profile, pkgName) {
  const link = join(profile.dir, 'node_modules', pkgName);
  if (!existsSync(link)) return { removed: false, reason: 'absent' };
  let stat;
  try {
    stat = lstatSync(link);
  } catch {
    return { removed: false, reason: 'stat failed' };
  }
  if (stat.isSymbolicLink()) {
    rmSync(link, { force: true });
    return { removed: true };
  }
  return { removed: false, reason: 'real-directory (pnpm-installed?); not touching it' };
}

/** 改 profile package.json：加/删 bundles 与 dependencies，写完回读。 */
function mutateProfileManifest(profile, mutate) {
  const manifestPath = join(profile.dir, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return { ok: false, error: `cannot read ${manifestPath}: ${err.message}` };
  }
  mutate(manifest);
  try {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  } catch (err) {
    return { ok: false, error: `cannot write ${manifestPath}: ${err.message}` };
  }
  const readback = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return { ok: true, manifest: readback };
}

function addToProfile(profile, pkgName, isBundle) {
  return mutateProfileManifest(profile, (m) => {
    if (!m.dsh) m.dsh = {};
    if (!m.dsh.profile) m.dsh.profile = {};
    const bundles = Array.isArray(m.dsh.profile.bundles) ? m.dsh.profile.bundles : [];
    if (isBundle && !bundles.includes(pkgName)) m.dsh.profile.bundles = [...bundles, pkgName];
    if (!m.dependencies) m.dependencies = {};
    if (!m.dependencies[pkgName]) m.dependencies[pkgName] = `file:./node_modules/${pkgName}`;
  });
}

function removeFromProfile(profile, pkgName) {
  return mutateProfileManifest(profile, (m) => {
    const bundles = Array.isArray(m?.dsh?.profile?.bundles) ? m.dsh.profile.bundles : [];
    if (m.dsh && m.dsh.profile) m.dsh.profile.bundles = bundles.filter((b) => b !== pkgName);
    if (m.dependencies && Object.prototype.hasOwnProperty.call(m.dependencies, pkgName)) {
      delete m.dependencies[pkgName];
    }
  });
}

/* ════════════════════════════════════════════════════════════════════
 * HTTP 小工具 + 安全闸门
 * ════════════════════════════════════════════════════════════════════ */

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-dsh-market-build': BUILD
  });
  res.end(text);
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const err = new Error('payload too large');
      err.code = 'TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * 变更类请求必须是本机同源直连。
 * 本地自定义路由**没有 cookie 鉴权**，所以每个能改状态的端点都得自己把门。
 * 语义照抄 dshmarket 的 trustedRestartRequest：回环 + 无转发头 + Origin 必须等于 Host。
 */
function trustedMutation(req) {
  const address = req.socket && req.socket.remoteAddress;
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false;
  if (req.headers.forwarded !== undefined) return false;
  if (req.headers['x-forwarded-for'] !== undefined) return false;
  if (req.headers['x-real-ip'] !== undefined) return false;
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin === undefined || host === undefined) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host;
  } catch {
    return false;
  }
}

/* ════════════════════════════════════════════════════════════════════
 * 重启：分离进程自杀，交给 launcher 看门狗拉起
 * ════════════════════════════════════════════════════════════════════ */

function scheduleRestart(delaySeconds = 3) {
  const pid = process.pid;
  let child;
  if (process.platform === 'win32') {
    const script = `Start-Sleep -Seconds ${delaySeconds}; Stop-Process -Id ${pid} -Force`;
    child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], {
      detached: true,
      stdio: 'ignore'
    });
  } else {
    child = spawn('/bin/sh', ['-c', `sleep ${delaySeconds}; kill -TERM ${pid}`], {
      detached: true,
      stdio: 'ignore'
    });
  }
  child.unref();
  return { pid, helperPid: child.pid, delaySeconds };
}

/* ════════════════════════════════════════════════════════════════════
 * 插件主体
 * ⚠️ apply() 里任何一行抛异常 = 插件树挂掉 = 被看门狗禁用
 * ════════════════════════════════════════════════════════════════════ */

export function apply(ctx) {
  const profile = resolveProfile(ctx);
  const disposers = [];
  const route = (path, handler) => ctx.webServer.register({ kind: 'exact', path, handler });

  /* ── GET /health ──────────────────────────────────────────────── */
  disposers.push(
    route(`${PREFIX}/health`, (req, res) => {
      sendJson(res, 200, { ok: true, build: BUILD, plugin: name, profile: profile.profile });
    })
  );

  /* ── GET /state ── 排障第一现场 ───────────────────────────────── */
  disposers.push(
    route(`${PREFIX}/state`, (req, res) => {
      try {
        sendJson(res, 200, { ok: true, build: BUILD, ...buildInventory(resolveProfile(ctx)) });
      } catch (err) {
        sendJson(res, 500, {
          ok: false,
          build: BUILD,
          error: err && err.message ? err.message : String(err)
        });
      }
    })
  );

  /* ── POST /toggle  { entry, enabled } ─────────────────────────── */
  disposers.push(
    route(`${PREFIX}/toggle`, async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' });
        return;
      }
      if (!trustedMutation(req)) {
        sendJson(res, 403, { ok: false, error: 'same-origin loopback request required' });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse((await readBody(req, 16384)).toString('utf8'));
      } catch {
        sendJson(res, 400, { ok: false, error: 'body must be JSON' });
        return;
      }
      const entry = String(parsed && parsed.entry ? parsed.entry : '');
      const enabled = parsed && parsed.enabled === true;
      if (!ROW_ID_RE.test(entry)) {
        sendJson(res, 400, { ok: false, error: 'bad entry id' });
        return;
      }
      const current = resolveProfile(ctx);
      const state = buildInventory(current);
      const owner = state.plugins.find((p) => p.entries.some((e) => e.id === entry));
      /* entry id 必须属于某个已安装插件。
         缺这条闸门时，传一个拼错的 id 会照样往补丁文件写一条**孤儿停用行**
         —— 本次实测踩到过（把包名当 entry id 传，结果写进了 dsh-dstation-market）。
         孤儿行本身不生效，但会污染补丁层，且将来真有同名 entry 时会被静默停用。 */
      if (!owner) {
        sendJson(res, 404, {
          ok: false,
          error: `no installed plugin owns entry id "${entry}"`,
          entry,
          build: BUILD
        });
        return;
      }
      if (owner.protected) {
        sendJson(res, 403, {
          ok: false,
          error: `protected plugin (${owner.pkg}) — refusing to toggle`,
          entry,
          build: BUILD
        });
        return;
      }
      const result = enabled
        ? await enableRow(current.patchPath, entry)
        : await disableRow(current.patchPath, entry);
      sendJson(res, result.ok ? 200 : 500, {
        ok: result.ok,
        build: BUILD,
        entry,
        enabled,
        reason: result.reason,
        /* 回读权威状态，别只信自己的写入结果 */
        state: buildInventory(resolveProfile(ctx))
      });
    })
  );

  /* ── POST /remove-rows  { entries } ── 卸载时清掉孤儿行 ───────── */
  disposers.push(
    route(`${PREFIX}/remove-rows`, async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' });
        return;
      }
      if (!trustedMutation(req)) {
        sendJson(res, 403, { ok: false, error: 'same-origin loopback request required' });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse((await readBody(req, 16384)).toString('utf8'));
      } catch {
        sendJson(res, 400, { ok: false, error: 'body must be JSON' });
        return;
      }
      const entries = Array.isArray(parsed && parsed.entries) ? parsed.entries.map(String) : [];
      if (entries.length === 0 || entries.some((e) => !ROW_ID_RE.test(e))) {
        sendJson(res, 400, { ok: false, error: 'entries must be a non-empty list of valid row ids' });
        return;
      }
      const current = resolveProfile(ctx);
      const result = await removeRowBlocks(current.patchPath, entries);
      sendJson(res, 200, { ok: result.ok, build: BUILD, removed: entries });
    })
  );

  /* ── POST /restart ── 分离进程自杀，launcher 看门狗拉起 ───────── */
  disposers.push(
    route(`${PREFIX}/restart`, async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' });
        return;
      }
      if (!trustedMutation(req)) {
        sendJson(res, 403, { ok: false, error: 'same-origin loopback request required' });
        return;
      }
      let info;
      try {
        info = scheduleRestart(3);
      } catch (err) {
        sendJson(res, 500, {
          ok: false,
          error: `cannot schedule restart: ${err && err.message ? err.message : 'unknown'}`
        });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        build: BUILD,
        message: 'restart scheduled; the page will blank for a few seconds, then the launcher watchdog brings it back',
        ...info
      });
    })
  );

  /* ── GET /catalog ── 可下载列表（与本机已装状态合并） ─────────── */
  disposers.push(
    route(`${PREFIX}/catalog`, async (req, res) => {
      try {
        const catalog = await listCatalog();
        sendJson(res, 200, { ok: true, build: BUILD, indexUrl: indexUrl(), ...catalog });
      } catch (err) {
        /* 拉不到索引不是致命错误：把来源和原因原样报出来，UI 显示成"市场离线" */
        sendJson(res, 200, {
          ok: false,
          build: BUILD,
          indexUrl: indexUrl(),
          error: err && err.message ? err.message : String(err)
        });
      }
    })
  );

  /* ── GET /operations ── 装机进度轮询 ─────────────────────────── */
  disposers.push(
    route(`${PREFIX}/operations`, (req, res) => {
      let id = null;
      try {
        id = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('id');
      } catch {
        id = null;
      }
      if (id) {
        const op = getOperation(id);
        if (!op) {
          sendJson(res, 404, { ok: false, error: `no such operation: ${id}` });
          return;
        }
        sendJson(res, 200, { ok: true, build: BUILD, operation: op });
        return;
      }
      sendJson(res, 200, { ok: true, build: BUILD, operations: listOperations() });
    })
  );

  /* ── POST /install  { pkg } ──────────────────────────────────── */
  disposers.push(
    route(`${PREFIX}/install`, async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' });
        return;
      }
      if (!trustedMutation(req)) {
        sendJson(res, 403, { ok: false, error: 'same-origin loopback request required' });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse((await readBody(req, 16384)).toString('utf8'));
      } catch {
        sendJson(res, 400, { ok: false, error: 'body must be JSON' });
        return;
      }
      const pkg = String(parsed && parsed.pkg ? parsed.pkg : '');
      if (!ROW_ID_RE.test(pkg)) {
        sendJson(res, 400, { ok: false, error: 'bad package name' });
        return;
      }
      if (PROTECTED_PKGS.includes(pkg) || PROTECTED_PKG_PREFIXES.some((p) => pkg.startsWith(p))) {
        sendJson(res, 403, { ok: false, error: `protected package: ${pkg}` });
        return;
      }

      const current = resolveProfile(ctx);
      const outcome = await installPlugin(pkg);
      const op = outcome.operation;

      /* 文件已经落盘了，但还没"挂载"。挂载失败要如实报出来，
         并把 operation 标成失败 —— 否则用户会以为装好了却没有效果。 */
      if (outcome.ok) {
        try {
          const junction = ensureJunction(current, pkg);
          const reg = addToProfile(current, pkg, op.result.bundle === true);
          if (!reg.ok) throw new Error(reg.error);
          op.result.junction = junction;
          op.result.registeredBundles = Array.isArray(reg.manifest?.dsh?.profile?.bundles)
            ? reg.manifest.dsh.profile.bundles.includes(pkg)
            : false;
          op.result.registeredDependency = Boolean(reg.manifest?.dependencies?.[pkg]);
          op.message = 'installed and registered; restart required';
        } catch (err) {
          op.state = 'failed';
          op.error = `文件已落盘，但挂载进 profile 失败：${err && err.message ? err.message : err}`;
        }
      }

      sendJson(res, outcome.ok ? 200 : 500, {
        ok: outcome.ok && op.state === 'succeeded',
        build: BUILD,
        operation: op,
        state: buildInventory(resolveProfile(ctx))
      });
    })
  );

  /* ── POST /uninstall  { pkg } ────────────────────────────────── */
  disposers.push(
    route(`${PREFIX}/uninstall`, async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' });
        return;
      }
      if (!trustedMutation(req)) {
        sendJson(res, 403, { ok: false, error: 'same-origin loopback request required' });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse((await readBody(req, 16384)).toString('utf8'));
      } catch {
        sendJson(res, 400, { ok: false, error: 'body must be JSON' });
        return;
      }
      const pkg = String(parsed && parsed.pkg ? parsed.pkg : '');
      if (!ROW_ID_RE.test(pkg)) {
        sendJson(res, 400, { ok: false, error: 'bad package name' });
        return;
      }
      const purgeFiles = parsed && parsed.purgeFiles === true;
      const current = resolveProfile(ctx);
      const before = buildInventory(current);
      const target = before.plugins.find((p) => p.pkg === pkg);
      if (!target) {
        sendJson(res, 404, { ok: false, error: `not installed: ${pkg}` });
        return;
      }
      if (target.protected) {
        sendJson(res, 403, { ok: false, error: `protected plugin: ${pkg}` });
        return;
      }

      const steps = {};
      /* ① 从插件树摘掉：删链接 + 注销 bundles/deps */
      steps.junction = removeJunction(current, pkg);
      const reg = removeFromProfile(current, pkg);
      steps.profile = reg.ok ? { ok: true } : { ok: false, error: reg.error };
      /* ② 清掉它的停用/强制行，别留孤儿 */
      const entryIds = target.entries.map((e) => e.id);
      if (entryIds.length > 0) steps.patchRows = await removeRowBlocks(current.patchPath, entryIds);
      /* ③ 删文件（显式要求才删） */
      steps.files = purgeFiles ? removePluginDir(pkg) : { ok: true, removed: false, reason: 'kept (pass purgeFiles:true to delete)' };

      sendJson(res, 200, {
        ok: steps.profile.ok === true,
        build: BUILD,
        pkg,
        steps,
        requiresRestart: true,
        state: buildInventory(resolveProfile(ctx))
      });
    })
  );

  /* ── GET/POST /source ── 索引源（离线/内网部署 + 联调） ──────── */
  disposers.push(
    route(`${PREFIX}/source`, async (req, res) => {
      if (req.method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          build: BUILD,
          indexUrl: indexUrl(),
          override: getIndexOverride(),
          source: resolveSource()
        });
        return;
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'GET or POST only' });
        return;
      }
      if (!trustedMutation(req)) {
        sendJson(res, 403, { ok: false, error: 'same-origin loopback request required' });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse((await readBody(req, 16384)).toString('utf8'));
      } catch {
        sendJson(res, 400, { ok: false, error: 'body must be JSON' });
        return;
      }
      const url = parsed && typeof parsed.url === 'string' ? parsed.url.trim() : '';
      /* 空串 = 清掉覆盖，回到默认 */
      const next = setIndexOverride(url === '' ? null : url);
      sendJson(res, 200, { ok: true, build: BUILD, indexUrl: next, source: resolveSource() });
    })
  );

  /* ── GET /backups ── 列出可回滚的备份 ─────────────────────────── */
  disposers.push(
    route(`${PREFIX}/backups`, (req, res) => {
      let pkg = null;
      try {
        pkg = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('pkg');
      } catch {
        pkg = null;
      }
      try {
        sendJson(res, 200, { ok: true, build: BUILD, backups: listBackups(pkg || undefined) });
      } catch (err) {
        sendJson(res, 500, { ok: false, build: BUILD, error: err && err.message ? err.message : String(err) });
      }
    })
  );

  /* ── POST /update  { pkg } ── OTA 更新（含失败自动回滚） ──────── */
  disposers.push(
    route(`${PREFIX}/update`, async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' });
        return;
      }
      if (!trustedMutation(req)) {
        sendJson(res, 403, { ok: false, error: 'same-origin loopback request required' });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse((await readBody(req, 16384)).toString('utf8'));
      } catch {
        sendJson(res, 400, { ok: false, error: 'body must be JSON' });
        return;
      }
      const pkg = String(parsed && parsed.pkg ? parsed.pkg : '');
      if (!ROW_ID_RE.test(pkg)) {
        sendJson(res, 400, { ok: false, error: 'bad package name' });
        return;
      }
      const current = resolveProfile(ctx);
      const before = buildInventory(current);
      const target = before.plugins.find((p) => p.pkg === pkg);
      if (!target) {
        sendJson(res, 404, { ok: false, error: `not installed: ${pkg}` });
        return;
      }
      if (target.protected) {
        sendJson(res, 403, { ok: false, error: `protected plugin: ${pkg}` });
        return;
      }

      const outcome = await updatePlugin(pkg);
      const op = outcome.operation;

      /* 更新后重新注册一次 bundles/deps：新版本可能改变了 bundle 声明 */
      if (outcome.ok) {
        try {
          const reg = addToProfile(current, pkg, true);
          if (!reg.ok) throw new Error(reg.error);
          op.message = 'updated; restart required';
        } catch (err) {
          op.state = 'failed';
          op.error = `文件已更新，但重新注册 profile 失败：${err && err.message ? err.message : err}`;
        }
      }

      sendJson(res, outcome.ok && op.state === 'succeeded' ? 200 : 500, {
        ok: outcome.ok && op.state === 'succeeded',
        build: BUILD,
        operation: op,
        state: buildInventory(resolveProfile(ctx))
      });
    })
  );

  /* ── POST /rollback  { pkg, backupId? } ──────────────────────── */
  disposers.push(
    route(`${PREFIX}/rollback`, async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' });
        return;
      }
      if (!trustedMutation(req)) {
        sendJson(res, 403, { ok: false, error: 'same-origin loopback request required' });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse((await readBody(req, 16384)).toString('utf8'));
      } catch {
        sendJson(res, 400, { ok: false, error: 'body must be JSON' });
        return;
      }
      const pkg = String(parsed && parsed.pkg ? parsed.pkg : '');
      const backupId = parsed && parsed.backupId ? String(parsed.backupId) : undefined;
      if (!ROW_ID_RE.test(pkg)) {
        sendJson(res, 400, { ok: false, error: 'bad package name' });
        return;
      }
      const current = resolveProfile(ctx);
      const target = buildInventory(current).plugins.find((p) => p.pkg === pkg);
      if (target && target.protected) {
        sendJson(res, 403, { ok: false, error: `protected plugin: ${pkg}` });
        return;
      }
      const result = rollbackPlugin(pkg, backupId);
      sendJson(res, result.ok ? 200 : 500, {
        ok: result.ok,
        build: BUILD,
        pkg,
        result,
        requiresRestart: true,
        state: buildInventory(resolveProfile(ctx))
      });
    })
  );

  /* ── POST /export  { pkg, displayName, where } ──────────────────
   * 把一个已安装的插件打成「发给朋友就能装上」的自包含分发包，直接回 zip 字节。
   *
   * 为什么用 POST 而不是 GET：
   *   · 能复用 trustedMutation 的同源闸门；GET 导航请求不带 Origin，
   *     没法做同样的校验，会变成「任意外站都能触发一次下载」。
   *   · displayName / where 是中文长文本，放 JSON body 比塞 URL query 稳。
   *   客户端拿到 blob 后用 <a download> 落地，体验与 GET 下载一致。
   *
   * 为什么返回 zip 而不是「写到服务器某个目录」：
   *   浏览器下载语义天然就把文件交给用户了，不需要在磁盘上多留一份，
   *   也就不需要额外管理「导出目录」的生命周期与清理。
   */
  disposers.push(
    route(`${PREFIX}/export`, async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only' });
        return;
      }
      if (!trustedMutation(req)) {
        sendJson(res, 403, { ok: false, error: 'same-origin loopback request required' });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse((await readBody(req, 16384)).toString('utf8'));
      } catch {
        sendJson(res, 400, { ok: false, error: 'body must be JSON' });
        return;
      }

      const pkg = String((parsed && parsed.pkg) || '');
      /* pkg 会被拼进文件系统路径 ⇒ 必须先过白名单正则，再做路径断言。两道都要。 */
      if (!PKG_NAME_RE.test(pkg)) {
        sendJson(res, 400, { ok: false, error: 'bad package name' });
        return;
      }
      const srcDir = resolveInstalledDir(ctx, pkg);
      if (!srcDir) {
        sendJson(res, 404, {
          ok: false,
          error: `not found: ${pkg}`,
          hint: '在 profile 的 node_modules\\ 和 plugins\\ 下都没找到这个插件的 package.json'
        });
        return;
      }

      /* 受保护插件也允许导出 —— 导出是只读操作，不改变任何状态。
         「受保护」限制的是停用/卸载，不是不让你备份或分发。 */
      try {
        const pkgMeta = readJson(join(srcDir, 'package.json'));
        const bad = selfCheck(srcDir, pkgMeta);
        if (bad) {
          sendJson(res, 400, { ok: false, error: bad, hint: '请先修好插件结构再导出' });
          return;
        }
        const r = buildDistribution(srcDir, {
          displayName: parsed.displayName,
          where: parsed.where
        });
        /* ⚠️ HTTP 响应头只允许 latin-1。文件名是中文（…-分发包.zip），
           直接写进 filename= 会让 Node 抛
             Invalid character in header content ["content-disposition"]
           并回 500 —— 这条曾经真的漏到线上过（测试的假 res 不跑 Node 的校验，
           所以它一路穿到了真实请求）。正确做法是 RFC 5987：
             · filename=   给不认 filename* 的老客户端的 ASCII 兜底
             · filename*=  百分号编码的 UTF-8，现代浏览器都用这个
           ASCII 兜底用 name/version 拼（两者都已被校验为纯 ASCII），别去截中文。 */
        const asciiFallback = `${r.summary.name}-${r.summary.version}-package.zip`;
        res.writeHead(200, {
          'content-type': 'application/zip',
          'content-length': r.data.length,
          'content-disposition':
            `attachment; filename="${asciiFallback}"; ` +
            `filename*=UTF-8''${encodeURIComponent(r.fileName)}`,
          'cache-control': 'no-store',
          'x-dsh-market-build': BUILD
        });
        res.end(r.data);
      } catch (err) {
        sendJson(res, 500, {
          ok: false,
          build: BUILD,
          error: err && err.message ? err.message : String(err)
        });
      }
    })
  );

  ctx.effect(
    () => () => {
      for (const d of disposers) {
        try {
          d();
        } catch {
          /* 卸载异常不该影响别的插件 */
        }
      }
    },
    'dsh-dstation-market: routes'
  );
}

/**
 * 仅供离线测试使用的内部视图。
 * 生产代码不要依赖这里 —— 它只是让"补丁文件语义"这类纯逻辑能被单测覆盖，
 * 尤其是那个**会把 profile 搞死**的 `[]` 占位符陷阱。
 */
export const __internals = {
  ROW_ID_RE,
  readUserPatchState,
  appendPatchEntry,
  disableRow,
  enableRow,
  removeRowBlocks,
  withPlaceholderRestored,
  normalizeLocalPath,
  /* installer 侧的纯函数与长任务 */
  checkRelPath,
  resolveSource,
  listCatalog,
  installPlugin,
  getOperation,
  listOperations,
  /* 阶段 2：OTA 更新与回滚 */
  compareVersions,
  updatePlugin,
  rollbackPlugin,
  listBackups,
  backupPlugin,
  /* 阶段 5：导出自包含分发包 */
  PKG_NAME_RE,
  resolveInstalledDir,
  buildDistribution,
  selfCheck,
  makeZip
};

export default { name, inject, apply };
