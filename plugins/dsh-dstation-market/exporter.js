/**
 * exporter.js —— 把已安装的插件打成「发给朋友就能装上」的自包含分发包
 *
 * 纯 JS，不依赖任何第三方包，也**不 fork 子进程**。
 * 模板放在同目录的 templates/ 下，运行时按 UTF-8 读入。
 *
 * ⚠️ 与 skills/dsh-plugin-submit/tools/export.mjs 是**两份独立实现**。
 *    之所以不共用：export.mjs 要能跟着 Skill 单独转发给第三方，
 *    不能反过来依赖"本机装了市场插件"。
 *    代价是可能漂移 —— 所以有一条测试（test/run-tests.mjs 里的「漂移检测」）
 *    直接比对两者对同一插件产出的 zip 是否**逐字节相同**。改了这边别忘了那边。
 *
 * 为什么安装包要做这么多校验（见 install.ps1.tpl）：
 *    一个「缺文件的插件包」曾经把 DSH 装到完全起不来 —— 客户端模块组装失败，
 *    而那个条目属于核心条目、看门狗拒绝自动禁用。所以在装之前就要拦住坏包。
 */

import {
  existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync
} from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const TPL_DIR = join(HERE, 'templates');

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '__pycache__', 'dist', 'build', '.cache']);

const DEFAULT_WHERE = `这个插件没有附带专属说明，装好后请按作者的介绍使用。

如果一时找不到入口，常见的位置是：
  · DSH「设置」里新增的一个栏目
  · 侧边栏或对话区域新增的按钮
  · 插件自带的 README.md 里会写`;

/* ─────────────────────────────────────────────── zip（含 CRC32） ── */

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
 * 纯 Node 的 zip 写入器。
 * 时间戳固定为 0x21（1980-01-01）⇒ **同样的输入永远产出同样的字节**，
 * 这条性质是「漂移检测」测试能成立的前提。
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
    lh.writeUInt16LE(0x0800, 6);          /* 文件名标 UTF-8 */
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0x21, 12);
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

/* ─────────────────────────────────────────────── 文件收集 ── */

function walk(dir, base, acc, depth = 0) {
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
export function collectPluginFiles(srcDir, pkg) {
  const set = new Set();
  if (Array.isArray(pkg.files) && pkg.files.length) {
    for (const entry of pkg.files) {
      const e = String(entry).replace(/^\.\//, '').replace(/\/$/, '');
      const full = join(srcDir, e);
      if (!existsSync(full)) continue;
      try {
        if (statSync(full).isDirectory()) { for (const f of walk(full, srcDir, [])) set.add(f); }
        else set.add(e);
      } catch { /* 忽略不可读条目 */ }
    }
  } else {
    for (const f of walk(srcDir, srcDir, [])) set.add(f);
  }
  set.add('package.json');
  return [...set].sort();
}

/** 从插件自带的 cordis.patch.yml 取 entry id（装错时用来查双重挂载） */
export function readEntryId(srcDir) {
  try {
    const text = readFileSync(join(srcDir, 'cordis.patch.yml'), 'utf8');
    const m = text.match(/^\s*-?\s*id:\s*['"]?([A-Za-z0-9._-]+)['"]?\s*$/m);
    return m ? m[1] : '';
  } catch { return ''; }
}

function humanSize(n) {
  if (n < 1024) return n + ' 字节';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function fill(tpl, vars) {
  return tpl.replace(/@@([A-Z_]+)@@/g, (all, key) => (key in vars ? String(vars[key]) : all));
}

/* ─────────────────────────────────────────────── 主入口 ── */

/**
 * 从 package.json 的 exports 里解析 "./client" 指向的文件。
 *
 * ⚠️ `exports["./client"]` 有两种**都合法**的形态，必须都认：
 *     字符串：  "./client": "./client.js"
 *     条件对象："./client": { "types": "…", "default": "./lib/client.js" }
 *   真实插件里两种都有 —— 本机实测 dsh-better-sidebar / dsh-canvas-preview /
 *   dsh-univer-office 用的都是条件对象。
 *   第一版只按字符串处理，`String(对象)` 得到 "[object Object]"，
 *   于是把这些**本来工作正常的插件**误判成「客户端文件不存在」而拒绝导出。
 *
 * 键的优先级与 tools/validate.mjs 保持一致（那边已验证过，别改歪）。
 */
export function clientExportFile(pkg) {
  const exp = pkg && pkg.exports;
  if (!exp || typeof exp !== 'object') return null;
  const walk = (v) => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      for (const k of ['default', 'import', 'require', 'node', 'browser']) {
        const hit = walk(v[k]);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(exp['./client']);
}

/**
 * 结构自洽性检查 —— 只查那一条「会让 DSH 起不来」的。
 * （完整的 validate.mjs 在 Skill 那边，插件不该依赖它。）
 * @returns {string} 空字符串表示通过，否则是错误说明
 */
export function selfCheck(srcDir, pkg) {
  const hasClient = !!(pkg && pkg.dsh && pkg.dsh.client);
  if (!hasClient) return '';
  const rel = clientExportFile(pkg);
  if (!rel) {
    return 'package.json 声明了 dsh.client，但 exports 里没有 "./client"。' +
           '这种包会让 DSH 的客户端模块组装失败，直接导致 DSH 起不来。';
  }
  const file = join(srcDir, String(rel).replace(/^\.\//, ''));
  if (!existsSync(file)) {
    return 'exports 指向的客户端文件不存在：' + rel;
  }
  return '';
}

/**
 * 生成分发包。
 *
 * @param {string} srcDir   插件目录（必须是真实目录，不能是不可读的链接）
 * @param {object} opts     { displayName, where }
 * @returns {{ fileName: string, data: Buffer, summary: object }}
 * @throws {Error} 结构不自洽 / 模板缺失
 */
export function buildDistribution(srcDir, opts = {}) {
  const pkgPath = join(srcDir, 'package.json');
  if (!existsSync(pkgPath)) throw new Error('目录里没有 package.json：' + srcDir);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const name = pkg.name;
  const version = pkg.version;
  if (!name || !version) throw new Error('package.json 缺少 name 或 version');

  const bad = selfCheck(srcDir, pkg);
  if (bad) throw new Error(bad);

  for (const t of ['install.ps1.tpl', 'uninstall.ps1.tpl', '一键安装.cmd.tpl', '一键卸载.cmd.tpl', '安装说明.txt.tpl']) {
    if (!existsSync(join(TPL_DIR, t))) {
      throw new Error('插件安装不完整：缺少模板 templates/' + t + '（请重新安装市场插件）');
    }
  }

  const displayName = String(opts.displayName || pkg.dsh?.displayName || name).trim() || name;
  const where = String(opts.where || '').trim() || DEFAULT_WHERE;
  const entryId = readEntryId(srcDir);

  const rels = collectPluginFiles(srcDir, pkg);

  /* 客户端入口必须真的在包里。
     selfCheck 只确认「文件在源目录里存在」，但 collectPluginFiles 会受
     package.json 的 files 白名单裁剪 —— 白名单漏掉入口的话，
     源目录检查会通过，而发出去的包是坏的。发之前必须拦住。 */
  const clientRel = clientExportFile(pkg);
  if (clientRel) {
    const norm = String(clientRel).replace(/^\.\//, '');
    if (!rels.includes(norm)) {
      throw new Error(
        `exports["./client"] 指向的 ${norm} 没有被收进包里。` +
        `请检查 package.json 的 files 白名单 —— 漏掉入口的包会让对方装不上。`
      );
    }
  }

  const pluginFiles = rels.map((rel) => ({ rel, data: readFileSync(join(srcDir, rel)) }));
  const totalBytes = pluginFiles.reduce((n, f) => n + f.data.length, 0);

  const manifest = {
    schema: 'dstation-plugin-bundle/v1',
    name,
    version,
    entryId,
    prettyName: displayName,
    builtAt: new Date().toISOString(),
    builtBy: 'dsh-dstation-market',
    files: pluginFiles.map((f) => ({
      path: 'plugin/' + f.rel,
      size: f.data.length,
      sha256: createHash('sha256').update(f.data).digest('hex')
    }))
  };

  const vars = {
    PLUGIN_NAME: name,
    VERSION: version,
    ENTRY_ID: entryId,
    PRETTY_NAME: displayName,
    WHERE_TO_LOOK: where,
    FILE_COUNT: pluginFiles.length,
    TOTAL_SIZE: humanSize(totalBytes),
    BUILT_AT: manifest.builtAt
  };

  const readTpl = (f) => readFileSync(join(TPL_DIR, f), 'utf8');
  const BOM = '\ufeff';

  /* 编码规则（实测踩出来的）：
     · .ps1 与 .txt → UTF-8 **带 BOM**。PowerShell 5.1 读无 BOM 的 UTF-8 .ps1 会当 ANSI，
       中文乱码且直接语法报错；记事本对无 BOM 的 UTF-8 也可能猜错编码。
     · .cmd → **纯 ASCII**。cmd.exe 按 OEM 代码页读批处理，中文会乱码。 */
  const asPs1 = (t) => Buffer.from(BOM + fill(t, vars), 'utf8');
  const asCmd = (t) => {
    const text = fill(t, vars);
    // .cmd 必须是纯 ASCII。Buffer.from(x,'ascii') 会把非 ASCII 静默换成 '?'，
    // 与其发一个「能装但命令是坏的」包出去，不如在这里直接失败。
    const bad = /[^\x00-\x7F]/.exec(text);
    if (bad) {
      throw new Error('模板 ' + ' 里出现了非 ASCII 字符（' + JSON.stringify(bad[0]) +
        '）：.cmd 必须是纯 ASCII，否则 cmd.exe 会乱码。请改模板。');
    }
    return Buffer.from(text, 'ascii');
  };

  const root = name + '-' + version;
  const entries = [
    { name: root + '/install.ps1', data: asPs1(readTpl('install.ps1.tpl')) },
    { name: root + '/uninstall.ps1', data: asPs1(readTpl('uninstall.ps1.tpl')) },
    { name: root + '/一键安装.cmd', data: asCmd(readTpl('一键安装.cmd.tpl')) },
    { name: root + '/一键卸载.cmd', data: asCmd(readTpl('一键卸载.cmd.tpl')) },
    { name: root + '/安装说明.txt', data: Buffer.from(BOM + fill(readTpl('安装说明.txt.tpl'), vars), 'utf8') },
    { name: root + '/MANIFEST.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8') },
    ...pluginFiles.map((f) => ({ name: root + '/plugin/' + f.rel, data: f.data }))
  ];

  return {
    fileName: name + '-' + version + '-分发包.zip',
    data: makeZip(entries),
    summary: {
      name, version, displayName, entryId,
      fileCount: pluginFiles.length,
      totalBytes,
      entryCount: entries.length,
      zipBytes: 0 /* 由调用方按 data.length 填 */
    }
  };
}

/** 把分发包直接写到磁盘（给 CLI / 测试用） */
export function writeDistribution(srcDir, outDir, opts = {}) {
  const r = buildDistribution(srcDir, opts);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, r.fileName);
  writeFileSync(outPath, r.data);
  return { ...r, outPath };
}
