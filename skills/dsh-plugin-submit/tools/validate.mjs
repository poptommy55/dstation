/**
 * D-STATION 插件投稿校验器
 *
 * 对**插件源码目录**做投稿前的静态审查。第三方作者自己就能跑，
 * 也可以直接接进 CI —— 目标是让"审核"这件事尽量机械化。
 *
 * 用法：
 *   node validate.mjs --src <插件目录> [--json]
 *
 * 退出码：0 = 通过；1 = 有 ERROR（必须修）；2 = 参数错误
 * WARN 不影响退出码，但会在报告里列出，供人工复核。
 *
 * ── 为什么查这些（每一条都对应一次真实事故或已知攻击面）────────────
 *   · 自洽性（dsh.client ↔ exports["./client"]）：缺了会让 DSH 的
 *     client-modules 组装失败；而它是**核心条目**，看门狗拒绝自动禁用
 *     ⇒ 整个 DSH 起不来且无法自愈。（本项目真实事故）
 *   · files 白名单覆盖所有相对 import：漏一个文件就会在"重装/更新"后
 *     被删掉，插件随即加载失败。
 *   · 拒绝生命周期脚本：postinstall/prepare 会在**安装时执行任意代码**，
 *     是插件体系最大的攻击面。
 *   · 拒绝原生模块/可执行文件：.node 加载进宿主进程可以硬终止整个 DSH。
 *   · 拒绝包内绝对路径 / ..：防止写到插件目录之外。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep, extname, basename } from 'node:path';

const NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const ROW_ID_RE = /^[A-Za-z0-9_.-]+$/;

/** 安装时会被执行的生命周期脚本 —— 一律拒绝。 */
const FORBIDDEN_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly'];

/**
 * 危险扩展名分两级 —— 判据是"**会不会被自动执行 / 能不能加载进宿主进程**"：
 *
 *   ERROR（直接拒绝）：
 *     原生模块与二进制。`.node` 一旦被加载进 DSH 进程，崩的是**整个 DSH**
 *     （本项目真实事故：CUDA 上下文冲突 → GGML_ABORT → 进程硬终止、无法 catch）。
 *     .exe/.dll/.so/.dylib 同理，且内容不可审。
 *
 *   WARN（不拒绝，但人工复核）：
 *     脚本类。市场**不会**自动执行它们（它只按文件清单落盘 + 注册插件树），
 *     所以风险等级不同于生命周期脚本。但用户可能手动去跑，
 *     所以要求投稿者在 README 里说明它是干什么的。
 */
const FORBIDDEN_EXT = new Set(['.node', '.exe', '.dll', '.so', '.dylib', '.com', '.msi']);
const SCRIPT_EXT = new Set(['.ps1', '.sh', '.bat', '.cmd', '.py']);

/** 单文件 / 整包体积上限（与安装器保持一致）。 */
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;

/** 永远不会被打包的目录。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.github', '__pycache__', '.vscode', '.idea']);

const allErrors = [];
const allWarns = [];
const allNotes = [];
let errors = allErrors;
let warns = allWarns;
let notes = allNotes;
function err(msg) {
  errors.push(msg);
}
function warn(msg) {
  warns.push(msg);
}
function note(msg) {
  notes.push(msg);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    if (k === 'json') out.json = true;
    else out[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : true;
  }
  return out;
}

function toPosix(p) {
  return String(p).split(sep).join('/');
}

function walk(root, dir = root, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(root, join(dir, e.name), acc);
    } else if (e.isFile()) {
      acc.push(toPosix(relative(root, join(dir, e.name))));
    }
  }
  return acc;
}

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** 从 package.json 的 exports 里解析 "./client" 指向的文件。 */
function clientExportFile(pkg) {
  const exp = pkg.exports;
  if (!exp) return null;
  let c = null;
  if (typeof exp === 'object') c = exp['./client'];
  if (typeof c === 'string') return c;
  if (c && typeof c === 'object') return c.default || c.import || c.require || null;
  return null;
}

/** 抓出所有 `from './x'` 形式的相对 import。 */
function relativeImports(text) {
  const out = [];
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) out.push(m[1]);
  return out;
}

/**
 * 校验一个插件源码目录。
 * 导出成函数是为了让 publish.mjs 直接 import 调用（避免起子进程）。
 * @param {string} src - 插件目录
 * @returns {{ok:boolean,src:string,package:string|null,version:string|null,errors:string[],warns:string[],notes:string[],files:number,bytes:number}}
 */
export function validatePlugin(src) {
  allErrors.length = 0;
  allWarns.length = 0;
  allNotes.length = 0;
  errors = allErrors;
  warns = allWarns;
  notes = allNotes;

  if (!src || !existsSync(src)) {
    err(`插件目录不存在：${src}`);
    return { ok: false, src, package: null, version: null, errors, warns, notes, files: 0, bytes: 0 };
  }

  /* ── 1) 包元数据 ─────────────────────────────────────────────── */
  const pkgPath = join(src, 'package.json');
  const pkg = readJson(pkgPath);
  if (!pkg) {
    err('package.json 缺失或不是合法 JSON（没有它，装上去会让 DSH 把别的包的 dsh.client 声明算到自己头上）');
  } else {
    if (!pkg.name) err('package.json 缺 name');
    else if (!NAME_RE.test(pkg.name)) err(`包名不合规（须小写、可带 @scope/）：${pkg.name}`);
    else note(`包名 ${pkg.name}`);
    if (!pkg.version) err('package.json 缺 version（没有版本号就没法做更新）');
    else note(`版本 ${pkg.version}`);
    if (!pkg.license) warn('package.json 未声明 license');
    if (pkg.private === true) warn('package.json 里 private: true（发布前建议去掉）');

    /* 生命周期脚本：安装时会执行任意代码，直接拒绝 */
    const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    for (const k of FORBIDDEN_SCRIPTS) {
      if (scripts[k]) err(`包含安装期生命周期脚本 "${k}" —— 会在安装时执行任意代码，投稿不允许`);
    }
  }

  /* ── 2) 收集文件 ─────────────────────────────────────────────── */
  let all = [];
  try {
    all = walk(src).sort();
  } catch (e) {
    err(`无法遍历目录：${e.message}`);
  }
  note(`目录内共 ${all.length} 个文件（已排除 node_modules/.git 等）`);

  /* 白名单过滤（与打包器一致） */
  const whitelist = pkg && Array.isArray(pkg.files) ? pkg.files.map(toPosix) : null;
  let picked = all;
  if (whitelist && whitelist.length > 0) {
    picked = all.filter((rel) => whitelist.some((r) => rel === r || rel.startsWith(`${r.replace(/\/+$/, '')}/`)));
  }
  if (!picked.includes('package.json') && pkg) picked = ['package.json', ...picked];
  note(`按 files 白名单选中 ${picked.length} 个文件`);

  /* ── 3) 路径安全 ─────────────────────────────────────────────── */
  let total = 0;
  const scriptFiles = [];
  for (const rel of picked) {
    if (rel.includes('..')) err(`路径含 ..：${rel}`);
    if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) err(`路径是绝对路径：${rel}`);
    const ext = extname(rel).toLowerCase();
    if (FORBIDDEN_EXT.has(ext)) {
      err(`包含原生模块/二进制文件（禁止 —— 它们能被加载进宿主进程并硬终止整个 DSH）：${rel}`);
    } else if (SCRIPT_EXT.has(ext)) {
      scriptFiles.push(rel);
    }
    let size = 0;
    try {
      size = statSync(join(src, rel.split('/').join(sep))).size;
    } catch {
      err(`文件读不到：${rel}`);
      continue;
    }
    total += size;
    if (size > MAX_FILE_BYTES) err(`单文件超过上限 ${MAX_FILE_BYTES} 字节：${rel}`);
  }
  if (scriptFiles.length) {
    warn(`包里含脚本（市场不会自动执行，但用户可能手动跑，请在 README 里说明用途）：${scriptFiles.join(', ')}`);
  }
  if (total > MAX_PACKAGE_BYTES) err(`包体超过上限 ${MAX_PACKAGE_BYTES} 字节（实际 ${total}）`);
  note(`选中文件合计 ${total} 字节`);

  /* ── 4) 自洽性：dsh.client / dsh.bundle.patch ────────────────── */
  const dsh = pkg && pkg.dsh ? pkg.dsh : null;
  if (dsh && dsh.client) {
    const file = clientExportFile(pkg);
    if (!file) {
      err('声明了 dsh.client，但 exports 里没有 "./client" —— 会让 dsh-client-modules 组装失败（核心条目，不可自动禁用）');
    } else {
      const rel = String(file).replace(/^\.\//, '');
      if (!picked.includes(rel)) err(`exports["./client"] 指向 ${rel}，但它不在包里`);
      else note(`dsh.client -> ${rel} ✓`);
    }
  } else {
    note('未声明 dsh.client（纯宿主半插件）');
  }
  if (dsh && dsh.bundle && dsh.bundle.patch) {
    const rel = String(dsh.bundle.patch).replace(/^\.\//, '');
    if (!picked.includes(rel)) err(`dsh.bundle.patch 指向 ${rel}，但它不在包里`);
    else {
      note(`dsh.bundle.patch -> ${rel} ✓`);
      /* entry id 必须是纯标量，否则市场写不了停用行 */
      const text = readFileSync(join(src, rel.split('/').join(sep)), 'utf8');
      const m = /^- insert:\s*\r?\n\s{4}- id:\s*([^\s'"]+)/m.exec(text);
      if (!m) err(`${rel} 里没有 "\- insert:" + 4 空格缩进的 "- id:" 结构 —— 市场无法解析它的入口`);
      else if (!ROW_ID_RE.test(m[1])) err(`entry id 含特殊字符：${m[1]}`);
      else note(`entry id = ${m[1]} ✓`);
    }
  }

  /* ── 5) files 白名单必须覆盖所有相对 import ──────────────────── */
  const missing = [];
  const notListed = [];
  for (const rel of picked) {
    if (!/\.(m?js|cjs)$/.test(rel)) continue;
    const text = readFileSync(join(src, rel.split('/').join(sep)), 'utf8');
    for (const spec of relativeImports(text)) {
      const target = toPosix(join(dirname(rel), spec).split(sep).join('/'));
      if (!existsSync(join(src, target.split('/').join(sep)))) {
        missing.push(`${rel} -> ${spec}`);
        continue;
      }
      if (!picked.includes(target)) notListed.push(`${rel} -> ${spec}（${target} 不在包内）`);
    }
  }
  if (missing.length) err(`相对 import 指向不存在的文件：\n      ${missing.join('\n      ')}`);
  if (notListed.length) err(`相对 import 的目标不在 files 白名单里（重装后会被删掉）：\n      ${notListed.join('\n      ')}`);
  if (!missing.length && !notListed.length) note('所有相对 import 都能解析且在包内 ✓');

  /* ── 6) 体积之外的提醒 ──────────────────────────────────────── */
  if (!picked.some((r) => r === 'README.md')) warn('包里没有 README.md（建议补上，用户会看）');
  if (!picked.some((r) => r === 'LICENSE')) warn('包里没有 LICENSE 文件（package.json 声明 license 不等于有文件）');

  /* ── 输出 ───────────────────────────────────────────────────── */
  return {
    ok: errors.length === 0,
    src,
    package: pkg ? pkg.name : null,
    version: pkg ? pkg.version : null,
    errors: [...errors],
    warns: [...warns],
    notes: [...notes],
    files: picked.length,
    bytes: total
  };
}

/* ── CLI 入口（被 import 时不执行）──────────────────────────────── */
function isMain() {
  try {
    return process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
  } catch {
    return false;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const src = args.src ? String(args.src) : null;
  if (!src) {
    console.error('用法: node validate.mjs --src <插件目录> [--json]');
    process.exit(2);
  }
  const r = validatePlugin(src);

  if (args.json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`\n投稿校验：${r.src}\n`);
    if (r.package) console.log(`  ${r.package}@${r.version}`);
    console.log('');
    for (const n of r.notes) console.log(`  ·  ${n}`);
    for (const w of r.warns) console.log(`  ⚠  ${w}`);
    for (const e of r.errors) console.log(`  ✗  ${e}`);
    console.log(`\n结果：${r.ok ? '通过 ✅' : '不通过 ❌'}   （${r.errors.length} 个错误 / ${r.warns.length} 个提醒）`);
    if (r.ok) console.log('可以投稿：把整个插件目录提 PR 到 dstation-runtime-patches，或直接跑 publish.mjs。');
  }
  process.exit(r.ok ? 0 : 1);
}

if (isMain()) main();

