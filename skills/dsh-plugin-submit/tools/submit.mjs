#!/usr/bin/env node
/**
 * submit.mjs —— 把本地插件投稿到 D-STATION 插件市场
 *
 * 一句话投稿的全部逻辑都在这里。流程：
 *   1. 定位插件目录，读 package.json
 *   2. 本地预检：validate.mjs（结构）+ audit.mjs（风险）
 *      —— 不合格就地停下，别浪费一次网络往返
 *   3. 生成 submission.json（上架元数据）
 *   4. 打成 zip（纯 Node 实现，不依赖任何库，也不 shell out）
 *   5. POST 到收稿服务
 *   6. 打印回执
 *
 * 用法：
 *   node submit.mjs <插件目录> --author 张三 --category 外观 --summary "一句话简介"
 *                     [--contact 邮箱] [--homepage URL] [--license MIT]
 *                     [--endpoint URL] [--dry-run] [--yes]
 *
 * 作者信息可存在 %DSH_HOME%\plugin-author.json 里复用，命令行参数优先。
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join, relative, sep, extname, dirname, basename } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { validatePlugin } from './validate.mjs';
import { auditPlugin, formatReport } from './audit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// This repository ships NO submission server. Pass --endpoint or set DSTATION_SUBMIT_URL.
const DEFAULT_ENDPOINT = '';
const CATEGORIES = ['外观', '效率', '集成', '开发', '数据', '其他'];
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '__pycache__', 'dist', 'build', '.cache']);

// ─────────────────────────────────────────────────────────────
// 纯 Node 的 zip 打包（含 CRC32）
// ─────────────────────────────────────────────────────────────

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * @param {Array<{name:string, data:Buffer}>} files
 * @returns {Buffer}
 */
export function makeZip(files) {
  const local = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = f.data;
    const crc = crc32(data);
    const deflated = deflateRawSync(data, { level: 9 });
    const useStore = deflated.length >= data.length;
    const payload = useStore ? data : deflated;
    const method = useStore ? 0 : 8;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);            // 文件名用 UTF-8
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x21, 12);             // 1980-01-01，固定时间戳 ⇒ 同样内容永远同样字节
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(payload.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, nameBuf, payload);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(payload.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + payload.length;
  }

  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...local, cd, eocd]);
}

// ─────────────────────────────────────────────────────────────
// 选文件：尊重 package.json 的 files 白名单
// ─────────────────────────────────────────────────────────────

function collectFiles(srcDir, pkg) {
  const out = [];
  const seen = new Set();

  const push = (rel) => {
    const norm = rel.split(sep).join('/');
    if (seen.has(norm)) return;
    const full = join(srcDir, rel);
    if (!existsSync(full) || !statSync(full).isFile()) return;
    seen.add(norm);
    out.push({ name: norm, data: readFileSync(full), size: statSync(full).size });
  };

  if (Array.isArray(pkg.files) && pkg.files.length) {
    for (const entry of pkg.files) {
      const e = String(entry).replace(/^\.\//, '').replace(/\/$/, '');
      const full = join(srcDir, e);
      if (!existsSync(full)) continue;
      if (statSync(full).isDirectory()) {
        walk(join(srcDir, e), srcDir, push);
      } else {
        push(e);
      }
    }
  } else {
    walk(srcDir, srcDir, push);
  }
  return out;
}

function walk(dir, base, push, depth = 0) {
  if (depth > 12) return;
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(join(dir, e.name), base, push, depth + 1);
    } else if (e.isFile()) {
      push(relative(base, join(dir, e.name)));
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 参数
// ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--yes' || a === '-y') o.yes = true;
    else if (a === '--json') o.json = true;
    else if (a.startsWith('--')) { o[a.slice(2)] = argv[++i]; }
    else o._.push(a);
  }
  return o;
}

function authorConfigPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'plugin-author.json');
}

function loadAuthorConfig() {
  const p = authorConfigPath();
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; }
}

function saveAuthorConfig(cfg) {
  const p = authorConfigPath();
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    return p;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────

function fail(msg) {
  console.error('\n✗ ' + msg + '\n');
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const srcArg = args._[0];
  if (!srcArg) {
    console.log(`用法: node submit.mjs <插件目录> --author 你的名字 --category <${CATEGORIES.join('|')}> --summary "一句话简介"
可选: --contact --homepage --license --endpoint URL --dry-run`);
    process.exit(1);
  }
  const srcDir = srcArg;

  if (!existsSync(join(srcDir, 'package.json'))) {
    fail(`目录里没有 package.json：${srcDir}\n  请指向插件目录本身（含 package.json / index.js / client.js）。`);
  }

  const pkg = JSON.parse(readFileSync(join(srcDir, 'package.json'), 'utf8'));
  const saved = loadAuthorConfig();
  const pick = (k) => args[k] ?? saved[k];

  const author = pick('author');
  const category = pick('category');
  const summary = pick('summary');
  const contact = pick('contact') || '';
  const homepage = pick('homepage') || '';
  const license = pick('license') || pkg.license || '';

  const missing = [];
  if (!author) missing.push('--author（署名）');
  if (!category) missing.push(`--category（${CATEGORIES.join('/')}）`);
  if (!summary) missing.push('--summary（一句话简介）');
  if (missing.length) {
    fail(`缺少上架信息：\n  ${missing.join('\n  ')}\n\n` +
         `这些信息会显示在插件市场里。示例：\n` +
         `  node submit.mjs "${srcDir}" --author 张三 --category 外观 --summary "给 DSH 换窗口背景"`);
  }
  if (!CATEGORIES.includes(category)) {
    fail(`分类必须是以下之一：${CATEGORIES.join('、')}（收到的是「${category}」）`);
  }

  const name = pkg.name;
  const version = pkg.version;
  if (!name || !version) fail('package.json 缺少 name 或 version');
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) {
    fail(`插件名不合法：${name}\n  只允许小写字母、数字、. _ -，且以字母或数字开头，最长 64 字符。`);
  }
  if (!/^\d+\.\d+\.\d+[0-9A-Za-z.\-+]*$/.test(version)) {
    fail(`版本号必须是 x.y.z 形式：${version}`);
  }

  const out = (s) => { if (!args.json) console.log(s); };
  out(`\n投稿：${name}@${version}`);
  out(`  目录：${srcDir}`);
  out(`  作者：${author}    分类：${category}`);
  out(`  简介：${summary}`);
  out('');

  // ── 1) 结构预检 ──────────────────────────────────────────
  const v = validatePlugin(srcDir);
  if (!v.ok) {
    console.error('✗ 结构检查未通过：\n');
    for (const e of v.errors) console.error('  · ' + e);
    console.error('\n改完之后重新运行即可。');
    process.exit(1);
  }
  out(`✓ 结构检查通过（${v.files} 个文件，${v.bytes} 字节）`);
  for (const w of v.warns || []) out(`  ! ${w}`);

  // ── 2) 风险预检 ──────────────────────────────────────────
  const a = auditPlugin(srcDir);
  if (!a.ok) {
    console.error('\n✗ 风险扫描发现阻断项，投稿会被服务器拒绝：\n');
    console.error(formatReport(a, srcDir));
    process.exit(1);
  }
  out(`✓ 风险扫描通过（等级 ${a.level}，风险分 ${a.score}/100）`);
  const highs = (a.findings || []).filter((f) => f.sev === 'high');
  for (const h of highs) {
    out(`  ! 高危：${h.label}（${h.file}${h.line ? ':' + h.line : ''}）`);
  }
  if (a.undeclared?.length) {
    out(`  ! 建议在 package.json 的 dsh.capabilities 里声明能力，审核会更快：` +
        a.undeclared.map((u) => u.detail).join('、'));
  }

  // ── 3) 打包 ──────────────────────────────────────────────
  const submission = {
    schema: 'dstation-plugin-submission/v1',
    name, version, author, category, summary,
    ...(contact ? { contact } : {}),
    ...(homepage ? { homepage } : {}),
    ...(license ? { license } : {}),
    ...(pkg.description ? { description: pkg.description } : {}),
    submittedAt: new Date().toISOString(),
    submittedBy: 'dsh-plugin-submit',
  };

  const files = collectFiles(srcDir, pkg);
  const withSubmission = [
    ...files.filter((f) => f.name !== 'submission.json'),
    { name: 'submission.json', data: Buffer.from(JSON.stringify(submission, null, 2) + '\n', 'utf8'), size: 0 },
  ];
  // package.json 必须在包里
  if (!withSubmission.some((f) => f.name === 'package.json')) {
    withSubmission.unshift({ name: 'package.json', data: readFileSync(join(srcDir, 'package.json')), size: 0 });
  }
  withSubmission.sort((x, y) => x.name.localeCompare(y.name));

  const zip = makeZip(withSubmission);
  out(`✓ 已打包：${withSubmission.length} 个文件，${zip.length} 字节`);

  if (args.dryRun) {
    const dryPath = join(process.cwd(), `${name}-${version}-submission.zip`);
    writeFileSync(dryPath, zip);
    out(`\n--dry-run：未上传。包已写到：${dryPath}`);
    return;
  }

  // ── 4) 投递 ──────────────────────────────────────────────
  const endpoint = args.endpoint || process.env.DSTATION_SUBMIT_URL || DEFAULT_ENDPOINT;
  if (!endpoint) {
    fail('No submission endpoint configured.\n' +
         '  Pass --endpoint <url>, or set DSTATION_SUBMIT_URL.\n' +
         '  Use --dry-run to only produce the submission package and send it yourself.');
  }
  out(`\n正在投递到 ${endpoint} …`);

  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip', 'Content-Length': String(zip.length) },
      body: zip,
    });
  } catch (e) {
    fail(`无法连接投稿服务器：${e.message}\n` +
         `  请检查网络，或用 --endpoint 指定别的地址。\n` +
         `  也可以先用 --dry-run 只生成投稿包，再手动发送。`);
  }

  let body;
  try { body = await res.json(); } catch { fail(`服务器返回了非 JSON 内容（HTTP ${res.status}）`); }

  if (res.status === 200 && body.ok) {
    out('');
    out('✓ 投稿成功，已进入待审队列');
    out(`  编号：${body.id}`);
    out(`  说明：${body.message}`);
    const at = body.audit || {};
    out(`  机器初审：等级 ${at.level ?? '?'}，风险分 ${at.score ?? '?'}/100，` +
        `高危项 ${at.high ?? 0} 个`);
    out('');
    out('  人工审核通过后，插件会自动出现在市场索引里。');
    if (author || contact) {
      const savedPath = saveAuthorConfig({ author, contact, homepage, license });
      if (savedPath) out(`  （已记住你的作者信息，下次不用再填：${savedPath}）`);
    }
    return;
  }

  console.error(`\n✗ 投稿被拒绝（HTTP ${res.status}）\n`);
  console.error(body.message || '(服务器没有给出说明)');
  if (body.report) {
    console.error('\n--- 风险扫描报告 ---\n');
    console.error(body.report);
  }
  process.exit(1);
}

const isMain = (process.argv[1] || '').replace(/\\/g, '/').endsWith('/submit.mjs');
if (isMain) main().catch((e) => fail(e.stack || String(e)));
