#!/usr/bin/env node
/**
 * export.mjs —— 把任意 DSH 插件导出成「发给朋友就能装上」的自包含安装包
 *
 * 产出：一个 zip，解压后双击「一键安装.cmd」即可，对方不需要命令行、
 *       不需要懂 DSH 的目录结构、不需要联网。
 *
 * 包里有什么：
 *   一键安装.cmd / 一键卸载.cmd     纯 ASCII（cmd.exe 用 OEM 代码页读 .cmd，中文会乱码）
 *   install.ps1 / uninstall.ps1     UTF-8 **带 BOM**（PS 5.1 读无 BOM 的 UTF-8 会当 ANSI）
 *   安装说明.txt                     UTF-8 带 BOM（记事本能认）
 *   MANIFEST.json                   逐文件 sha256，装之前会核对
 *   plugin/                         插件本体
 *
 * 为什么安装脚本要做这么多检查：
 *   一个「缺文件的插件包」曾经把 DSH 装到完全起不来（客户端模块组装失败 →
 *   核心条目不可自动禁用 → 全站停机）。所以安装器宁可提前停下，也不要把
 *   一个坏包装进去。
 *
 * 用法：
 *   node export.mjs <插件目录> [--out <输出目录>] [--name <显示名>] [--where <装完在哪看>]
 *                   [--ascii-names]
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { validatePlugin } from './validate.mjs';
import { makeZip } from './submit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TPL = join(HERE, 'templates');

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '__pycache__', 'dist', 'build', '.cache']);

const DEFAULT_WHERE = `这个插件没有附带专属说明，装好后请按作者的介绍使用。

如果一时找不到入口，常见的位置是：
  · DSH「设置」里新增的一个栏目
  · 侧边栏或对话区域新增的按钮
  · 插件自带的 README.md 里会写`;

// ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ascii-names') o.asciiNames = true;
    else if (a.startsWith('--')) o[a.slice(2)] = argv[++i];
    else o._.push(a);
  }
  return o;
}

function walk(dir, base = dir, acc = [], depth = 0) {
  if (depth > 12) return acc;
  let ents = [];
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, base, acc, depth + 1);
    } else if (e.isFile()) {
      acc.push(relative(base, full).split(sep).join('/'));
    }
  }
  return acc;
}

/** 尊重 package.json 的 files 白名单；package.json 永远包含 */
function collectFiles(srcDir, pkg) {
  const set = new Set();
  const addDir = (d) => { for (const f of walk(d, srcDir)) set.add(f); };

  if (Array.isArray(pkg.files) && pkg.files.length) {
    for (const entry of pkg.files) {
      const e = String(entry).replace(/^\.\//, '').replace(/\/$/, '');
      const full = join(srcDir, e);
      if (!existsSync(full)) continue;
      if (statSync(full).isDirectory()) addDir(full);
      else set.add(e);
    }
  } else {
    addDir(srcDir);
  }
  set.add('package.json');
  return [...set].sort();
}

/** 从插件自带的 cordis.patch.yml 里取 entry id */
function readEntryId(srcDir) {
  const p = join(srcDir, 'cordis.patch.yml');
  if (!existsSync(p)) return '';
  const text = readFileSync(p, 'utf8');
  const m = text.match(/^\s*-?\s*id:\s*['"]?([A-Za-z0-9._-]+)['"]?\s*$/m);
  return m ? m[1] : '';
}

function fill(tpl, vars) {
  return tpl.replace(/@@([A-Z_]+)@@/g, (all, key) => (key in vars ? String(vars[key]) : all));
}

function humanSize(n) {
  if (n < 1024) return `${n} 字节`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function die(msg) { console.error('\n✗ ' + msg + '\n'); process.exit(1); }

// ─────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));
  const srcDir = args._[0];
  if (!srcDir) {
    console.log(`用法: node export.mjs <插件目录> [选项]

选项:
  --out <目录>     输出目录（默认当前目录）
  --name <显示名>  给朋友看的名字（默认取 package.json 的 dsh.displayName，再退回包名）
  --where <文字>   安装说明里「装完在哪看到」那一段
  --ascii-names    包内文件名全用 ASCII（某些老解压工具对中文名不友好时用）

示例:
  node export.mjs ..\\dsh-wallpaper --name "窗口背景" --where "设置 → 通用 → 窗口背景"`);
    process.exit(1);
  }

  if (!existsSync(join(srcDir, 'package.json'))) {
    die(`目录里没有 package.json：${srcDir}`);
  }

  const pkg = JSON.parse(readFileSync(join(srcDir, 'package.json'), 'utf8'));
  const name = pkg.name;
  const version = pkg.version;
  if (!name || !version) die('package.json 缺少 name 或 version');

  // 导出前先体检：别把一个坏包发给朋友
  const v = validatePlugin(srcDir);
  if (!v.ok) {
    console.error('\n✗ 结构检查未通过，先修好再导出：\n');
    for (const e of v.errors) console.error('  · ' + e);
    console.error('');
    process.exit(1);
  }
  for (const w of v.warns || []) console.log('  ! ' + w);

  const prettyName = args.name || pkg.dsh?.displayName || name;
  const entryId = readEntryId(srcDir);
  const whereText = args.where || DEFAULT_WHERE;

  // 收集插件文件
  const rels = collectFiles(srcDir, pkg);
  const pluginFiles = rels.map((rel) => ({ rel, data: readFileSync(join(srcDir, rel)) }));
  const totalBytes = pluginFiles.reduce((n, f) => n + f.data.length, 0);

  // MANIFEST：路径按包内路径写，安装器按 plugin/ 前缀定位
  const manifest = {
    schema: 'dstation-plugin-bundle/v1',
    name,
    version,
    entryId,
    prettyName,
    builtAt: new Date().toISOString(),
    builtBy: 'dsh-plugin-export',
    files: pluginFiles.map((f) => ({
      path: `plugin/${f.rel}`,
      size: f.data.length,
      sha256: createHash('sha256').update(f.data).digest('hex'),
    })),
  };

  // 模板变量
  const vars = {
    PLUGIN_NAME: name,
    VERSION: version,
    ENTRY_ID: entryId,
    PRETTY_NAME: prettyName,
    WHERE_TO_LOOK: whereText,
    FILE_COUNT: pluginFiles.length,
    TOTAL_SIZE: humanSize(totalBytes),
    BUILT_AT: manifest.builtAt,
  };

  const readTpl = (f) => readFileSync(join(TPL, f), 'utf8');
  const ascii = !!args.asciiNames;

  const BOM = '\ufeff';
  // .ps1 与 .txt 必须带 BOM：
  //   PS 5.1 读「无 BOM 的 UTF-8 .ps1」会当 ANSI → 中文乱码 → 直接语法错误（已实测）
  //   记事本对无 BOM 的 UTF-8 也可能猜错编码
  const asPs1 = (t) => Buffer.from(BOM + fill(t, vars), 'utf8');
  const asTxt = (t) => Buffer.from(BOM + fill(t, vars), 'utf8');
  // .cmd 保持纯 ASCII：cmd.exe 用 OEM 代码页读 .cmd，中文会乱码
  const asCmd = (t) => Buffer.from(fill(t, vars), 'ascii');

  const root = `${name}-${version}`;
  const entries = [
    { name: `${root}/install.ps1`, data: asPs1(readTpl('install.ps1.tpl')) },
    { name: `${root}/uninstall.ps1`, data: asPs1(readTpl('uninstall.ps1.tpl')) },
    { name: `${root}/${ascii ? 'INSTALL.cmd' : '一键安装.cmd'}`, data: asCmd(readTpl('一键安装.cmd.tpl')) },
    { name: `${root}/${ascii ? 'UNINSTALL.cmd' : '一键卸载.cmd'}`, data: asCmd(readTpl('一键卸载.cmd.tpl')) },
    { name: `${root}/${ascii ? 'README.txt' : '安装说明.txt'}`, data: asTxt(readTpl('安装说明.txt.tpl')) },
    { name: `${root}/MANIFEST.json`, data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8') },
    ...pluginFiles.map((f) => ({ name: `${root}/plugin/${f.rel}`, data: f.data })),
  ];

  const zip = makeZip(entries);

  const outDir = args.out || process.cwd();
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${name}-${version}-分发包.zip`);
  writeFileSync(outFile, zip);

  console.log('');
  console.log(`✓ 已导出：${outFile}`);
  console.log(`  ${prettyName}  ${name}@${version}`);
  console.log(`  插件文件 ${pluginFiles.length} 个（${humanSize(totalBytes)}），压缩包 ${humanSize(zip.length)}`);
  console.log(`  包内共 ${entries.length} 个条目，顶层目录 ${root}/`);
  console.log('');
  console.log('  把这个 zip 发给朋友，对方：解压 → 双击「一键安装.cmd」→ 重启 DSH');
  console.log('');
}

// createHash 延迟引入，保持顶部 import 清爽
const isMain = (process.argv[1] || '').replace(/\\/g, '/').endsWith('/export.mjs');
if (isMain) main();
