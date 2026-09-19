'use strict';
/**
 * D-STATION 本地文件桥 — 主进程模块
 *
 * 为什么需要它：
 *   DSH 的附件通道（dsh-attachment）架构上只接受光栅图片
 *   （README 原文：「只接受光栅格式（PNG、JPEG、WebP、GIF）……通用文件、音频和视频
 *   暂不支持」），而浏览器侧也没有任何写盘 API（session-controller 只有
 *   fileReferences 相关路由，没有任何 fs 写路由）。DSH 给模型文件的官方机制是
 *   @路径 mention（选中候选只插入文本、不附带内容，模型自己调工具读），
 *   前提是文件得先落在会话工作目录里 —— 本模块就是补上这一步。
 *
 * 安全边界（三道，缺一不可）：
 *   1. 目录白名单：目标目录必须落在某个允许根之内。允许根 = DSH 登记的工作区
 *      （home/storages/workspace.json）+ 环境变量 DSTATION_FILES_ROOTS 追加项。
 *      校验用 realpath 后的 isWithin，符号链接逃逸同样被拒。
 *   2. 文件名净洁：单段名，禁止路径分隔符 / .. / 控制字符 / Windows 保留名。
 *   3. 体积上限：单文件默认 100 MB。
 * 写入一律「临时文件 + rename」原子落盘，重名自动追加序号，绝不覆盖既有文件。
 *
 * 本模块导出两个工厂（2026-09-12 起）：
 *   · createFiles   —— 上传语义：写进工作区，不建目录、重名加序号、只写不读。
 *   · createSkills  —— 技能库语义：根固定死在 <BASE>/home/skills，允许 mkdir -p 与
 *                      覆盖写，并提供 list/read/write/remove 供技能面板使用。
 *   两者**故意不复用**：技能库是可以被反复覆盖写的通道，安全姿态必须比上传更紧
 *   （根写死、name 强制 kebab-case、叠加 realpath + isWithin 双重校验）。
 */
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 100 * 1024 * 1024;

const WIN_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
]);

function norm(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, '');
}

/** p 是否落在 root 之内（含相等） */
function isWithin(root, p) {
  const r = norm(root).toLowerCase();
  const q = norm(p).toLowerCase();
  if (!r || !q) return false;
  return q === r || q.indexOf(r + '/') === 0;
}

function realDir(p) {
  try { return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p); }
  catch (e) { return null; }
}

/** 把 DSH 注册表里登记的工作区路径收集为允许根 */
function workspacesFromRegistry(base) {
  const out = [];
  try {
    const f = path.join(base, 'home', 'storages', 'workspace.json');
    if (!fs.existsSync(f)) return out;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const tables = (j && j.tables && j.tables.workspaces) || {};
    Object.keys(tables).forEach(function (id) {
      const p = tables[id] && tables[id].path;
      if (p) out.push(p);
    });
  } catch (e) { /* 注册表读不到就退化为环境变量 + home 兜底 */ }
  return out;
}

function sanitizeName(raw) {
  let name = String(raw == null ? '' : raw);
  name = name.replace(/^.*[\\/]/, '');            // 丢掉任何路径部分
  name = name.replace(/[\u0000-\u001f\u007f]/g, ''); // 控制字符
  name = name.replace(/[<>:"|?*]/g, '_');          // Windows 非法字符
  name = name.replace(/^\.+/, '').replace(/[. ]+$/, ''); // 首部点、尾部点/空格
  if (!name) name = 'file';
  if (name.length > 120) {
    const ext = path.extname(name).slice(0, 16);
    name = name.slice(0, 120 - ext.length) + ext;
  }
  const stem = name.split('.')[0].toUpperCase();
  if (WIN_RESERVED.has(stem)) name = '_' + name;
  return name;
}

function splitExt(name) {
  const ext = path.extname(name);
  return { stem: ext ? name.slice(0, -ext.length) : name, ext: ext };
}

/** 在 dir 下为 name 找一个不冲突的落点 */
function uniqueTarget(dir, name) {
  const parts = splitExt(name);
  let target = path.join(dir, name);
  let i = 1;
  while (fs.existsSync(target)) {
    target = path.join(dir, parts.stem + ' (' + i + ')' + parts.ext);
    i += 1;
    if (i > 999) throw new Error('同名文件过多，请先清理工作目录');
  }
  return target;
}

function createFiles(opts) {
  const BASE = opts.base;
  const log = typeof opts.log === 'function' ? opts.log : function () {};
  let cachedRoots = null;

  function allowRoots() {
    if (cachedRoots) return cachedRoots;
    const list = [];
    const push = function (p) {
      if (!p) return;
      const abs = path.isAbsolute(p) ? p : path.resolve(BASE, p);
      const real = realDir(abs);
      if (real) list.push(real);
    };
    workspacesFromRegistry(BASE).forEach(push);
    String(process.env.DSTATION_FILES_ROOTS || '')
      .split(path.delimiter)
      .forEach(function (s) { if (String(s).trim()) push(String(s).trim()); });
    cachedRoots = list;
    log('[FILES] 允许根 ' + list.length + ' 个：' + list.join(' | '));
    return list;
  }

  function checkDir(dir) {
    if (!dir || typeof dir !== 'string') return { ok: false, error: '缺少目标目录' };
    const real = realDir(dir);
    if (!real) return { ok: false, error: '目标目录不存在：' + dir };
    if (!fs.statSync(real).isDirectory()) return { ok: false, error: '目标不是目录：' + dir };
    const roots = allowRoots();
    for (let i = 0; i < roots.length; i++) {
      if (isWithin(roots[i], real)) return { ok: true, dir: real };
    }
    if (roots.length === 0) {
      return { ok: false, error: '没有可用的允许根：请确认 DSH 工作区注册表可读，或设置 DSTATION_FILES_ROOTS' };
    }
    return { ok: false, error: '拒绝写入：目标目录不在允许的工作区之内' };
  }

  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (Array.isArray(data)) return Uint8Array.from(data);
    if (data && data.type === 'Buffer' && Array.isArray(data.data)) return Uint8Array.from(data.data);
    return null;
  }

  /** 保存一个文件到指定工作区目录；返回落点的绝对路径与相对该目录的路径 */
  function save(payload) {
    const p = payload || {};
    const chk = checkDir(p.dir);
    if (!chk.ok) return { ok: false, error: chk.error };

    const bytes = toBytes(p.data);
    if (!bytes) return { ok: false, error: '文件内容无法识别（期望 Uint8Array / ArrayBuffer）' };
    if (bytes.byteLength === 0) return { ok: false, error: '文件内容为空' };
    if (bytes.byteLength > MAX_BYTES) {
      return { ok: false, error: '文件过大（' + (bytes.byteLength / 1048576).toFixed(1) + ' MB，上限 ' + (MAX_BYTES / 1048576) + ' MB）' };
    }

    const name = sanitizeName(p.name);
    let target;
    try { target = uniqueTarget(chk.dir, name); }
    catch (e) { return { ok: false, error: String(e && e.message) }; }

    const tmp = target + '.dstn-part-' + process.pid + '-' + Date.now();
    try {
      fs.writeFileSync(tmp, bytes, { flag: 'wx' });
      fs.renameSync(tmp, target);
    } catch (e) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) {}
      return { ok: false, error: '写入失败：' + String(e && e.message) };
    }

    const rel = norm(path.relative(chk.dir, target));
    log('[FILES] 已写入 ' + rel + '（' + bytes.byteLength + ' 字节）');
    return { ok: true, path: target, dir: chk.dir, name: path.basename(target), rel: rel, size: bytes.byteLength };
  }

  return { save: save, allowRoots: allowRoots, checkDir: checkDir, MAX_BYTES: MAX_BYTES };
}

// ==================== 技能库（<BASE>/home/skills）写盘 ====================
// DSH 原生技能体系：<技能根>/<name>/SKILL.md 或 <技能根>/<name>.md，只扫一层。
// 用户级根的路径由宿主定为 <DSH_HOME>/skills（main.js 启动时 mkdir，与 knowledge-bases 同款）。
// 面板据此展示/编辑/新建，故本工厂需要读写删三种能力——这与 createFiles 的「只写」是两码事。
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SKILL_MAX_BYTES = 2 * 1024 * 1024;

/** 解析 SKILL.md 的 YAML frontmatter（只取标量键；引号剥壳；刻意不引 yaml 依赖） */
function parseFrontmatter(text) {
  const src = String(text == null ? '' : text);
  const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { front: null, body: src, error: '缺少 frontmatter：文件必须以 --- 起头的一段元数据开头' };
  const front = {};
  m[1].split(/\r?\n/).forEach(function (line) {
    const t = line.trim();
    if (!t || t.charAt(0) === '#') return;
    const i = t.indexOf(':');
    if (i <= 0) return;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (v.length >= 2) {
      const a = v.charAt(0), b = v.charAt(v.length - 1);
      if ((a === '"' && b === '"') || (a === "'" && b === "'")) v = v.slice(1, -1);
    }
    front[k] = v;
  });
  return { front: front, body: src.slice(m[0].length), error: null };
}

// ==================== 技能导入（压缩包 / 松散文件） ====================
const SKILL_IMPORT_ZIP_MAX = 30 * 1024 * 1024;    // zip 原始字节上限
const SKILL_IMPORT_ENTRY_MAX = 5 * 1024 * 1024;    // 解压后单文件上限
const SKILL_IMPORT_TOTAL_MAX = 25 * 1024 * 1024;  // 解压后总大小上限
const SKILL_EXPORT_TOTAL_MAX = 25 * 1024 * 1024;  // 导出技能总大小上限（目录形态时遍历累加）

/** 任意字符串转 kebab-case（小写、空白/下划线转连字符、去非法字符） */
function toKebab(s) {
  return String(s == null ? '' : s)
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** 若 SKILL.md 的 frontmatter 缺 name/description，补上以保证导入后即生效（与 list 生效口径一致） */
function ensureFrontmatter(body, name, description) {
  const pf = parseFrontmatter(body);
  const front = pf.front || {};
  const need = {};
  if (!front.name) need.name = name;
  if (!front.description) need.description = description || name;
  if (!Object.keys(need).length) return body;
  const keys = Object.keys(front).concat(Object.keys(need));
  let block = '---\n';
  keys.forEach(function (k) { block += k + ': ' + (front[k] || need[k]) + '\n'; });
  block += '---\n';
  return block + (pf.body || '');
}

function createSkills(opts) {
  const BASE = opts.base;
  const log = typeof opts.log === 'function' ? opts.log : function () {};
  // 删除走回收站（由主进程注入 shell.trashItem）。缺省则退回硬删 —— 但会在返回值
  // 里如实标注 trashed:false，面板据此提示用户「这是永久删除」。
  const trash = typeof opts.trash === 'function' ? opts.trash : null;
  const ROOT = path.join(BASE, 'home', 'skills');

  function ensureRoot() {
    fs.mkdirSync(ROOT, { recursive: true });
    return ROOT;
  }

  function checkName(raw) {
    const n = String(raw == null ? '' : raw).trim();
    if (!n) return { ok: false, error: '缺少技能名' };
    if (!SKILL_NAME_RE.test(n)) {
      return { ok: false, error: '技能名只能是小写字母/数字/连字符（kebab-case）、以字母或数字开头、最长 64 字符：' + n };
    }
    return { ok: true, name: n };
  }

  /** 技能目录绝对路径；isWithin 兜底（即便 name 绕过正则也逃不出 ROOT） */
  function dirOf(name) {
    const d = path.join(ROOT, name);
    return isWithin(ROOT, d) ? d : null;
  }

  /** 扫一层技能根，返回「元数据 + 是否真的会生效 + 不生效的原因」 */
  function list() {
    const out = [];
    try { ensureRoot(); } catch (e) { return out; }
    let entries = [];
    try { entries = fs.readdirSync(ROOT, { withFileTypes: true }); } catch (e) { return out; }
    entries.forEach(function (ent) {
      const nm = ent.name;
      if (nm.charAt(0) === '.') return;   // 隐藏项 / 落盘临时残留
      const item = { name: '', layout: '', relPath: '', size: 0, mtime: '', parsed: null, valid: false, reason: '' };
      let file = null;
      try {
        if (ent.isDirectory()) {
          file = path.join(ROOT, nm, 'SKILL.md');
          item.layout = 'dir';
          item.relPath = nm + '/SKILL.md';
          if (!fs.existsSync(file)) {
            item.name = nm; item.reason = '目录里没有 SKILL.md'; out.push(item); return;
          }
          if (!fs.statSync(file).isFile()) {
            item.name = nm; item.reason = 'SKILL.md 不是一个文件'; out.push(item); return;
          }
        } else if (/\.md$/i.test(nm)) {
          file = path.join(ROOT, nm);
          item.layout = 'file';
          item.relPath = nm;
        } else {
          return;   // 非 .md 的散文件直接忽略（宿主也不认）
        }
        item.name = item.name || (item.layout === 'file' ? nm.slice(0, -3) : nm);
        const st = fs.statSync(file);
        item.size = st.size;
        item.mtime = st.mtime.toISOString();
        const pf = parseFrontmatter(fs.readFileSync(file, 'utf8'));
        item.parsed = pf.front;
        // 与 dsh-skill-filesystem 的校验口径对齐：没有这些就静默丢弃，不会出现在 / 菜单里
        if (pf.error) item.reason = pf.error;
        else if (!pf.front || !pf.front.name) item.reason = 'frontmatter 缺 name（必填）';
        else if (pf.front.name !== item.name) item.reason = 'frontmatter 的 name 与' + (item.layout === 'file' ? '文件名' : '目录名') + '不一致（必须完全相同）';
        else if (!pf.front.description) item.reason = 'frontmatter 缺 description（模型靠它判断要不要用）';
        else item.valid = true;
      } catch (e) {
        item.name = item.name || nm;
        item.reason = String(e && e.message);
      }
      out.push(item);
    });
    out.sort(function (a, b) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); });
    return out;
  }

  function read(name) {
    const c = checkName(name);
    if (!c.ok) return { ok: false, error: c.error };
    const d = dirOf(c.name);
    if (!d) return { ok: false, error: '路径非法' };
    const cands = [path.join(d, 'SKILL.md'), path.join(ROOT, c.name + '.md')];
    for (let i = 0; i < cands.length; i++) {
      try {
        if (fs.existsSync(cands[i])) {
          const text = fs.readFileSync(cands[i], 'utf8');
          return { ok: true, name: c.name, path: cands[i], layout: i === 0 ? 'dir' : 'file', text: text, bytes: Buffer.byteLength(text) };
        }
      } catch (e) { return { ok: false, error: String(e && e.message) }; }
    }
    return { ok: false, error: '技能不存在：' + c.name };
  }

  /** 覆盖写 <root>/<name>/SKILL.md（mkdir -p + 临时文件 + rename 原子落盘） */
  function write(name, text) {
    const c = checkName(name);
    if (!c.ok) return { ok: false, error: c.error };
    const body = String(text == null ? '' : text);
    if (!body.trim()) return { ok: false, error: '内容为空' };
    const bytes = Buffer.byteLength(body);
    if (bytes > SKILL_MAX_BYTES) {
      return { ok: false, error: '内容过大（' + (bytes / 1048576).toFixed(2) + ' MB，上限 ' + (SKILL_MAX_BYTES / 1048576) + ' MB）' };
    }
    const d = dirOf(c.name);
    if (!d) return { ok: false, error: '路径非法' };
    // 同名的「单文件形态」已存在时拒绝，避免一个技能两份文件语义打架
    try {
      if (fs.existsSync(path.join(ROOT, c.name + '.md'))) {
        return { ok: false, error: '已存在同名单文件技能 ' + c.name + '.md，请先删除它再改为目录形态' };
      }
    } catch (e) {}
    const target = path.join(d, 'SKILL.md');
    const tmp = target + '.dstn-part-' + process.pid + '-' + Date.now();
    try {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(tmp, body, { flag: 'wx' });
      try {
        fs.renameSync(tmp, target);
      } catch (e1) {
        // Windows 上目标被占用/已存在时 rename 可能 EPERM/EEXIST → 退回「先删再改名」。
        // 有极小窗口期文件不存在，但这是覆盖写语义，可接受；失败则原文件已删、临时文件仍在。
        fs.rmSync(target, { force: true });
        fs.renameSync(tmp, target);
      }
    } catch (e) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) {}
      return { ok: false, error: '写入失败：' + String(e && e.message) };
    }
    log('[SKILLS] 已写入 ' + c.name + '/SKILL.md（' + bytes + ' 字节）');
    return { ok: true, name: c.name, path: target, layout: 'dir', bytes: bytes };
  }

  /** 删除技能（目录形态连目录一起）。返回 Promise —— 回收站通道是异步的。 */
  function remove(name) {
    const c = checkName(name);
    if (!c.ok) return Promise.resolve({ ok: false, error: c.error });
    const d = dirOf(c.name);
    if (!d) return Promise.resolve({ ok: false, error: '路径非法' });
    let target = null;
    try {
      if (fs.existsSync(path.join(d, 'SKILL.md'))) target = d;
      else if (fs.existsSync(path.join(ROOT, c.name + '.md'))) target = path.join(ROOT, c.name + '.md');
    } catch (e) {}
    if (!target) return Promise.resolve({ ok: false, error: '技能不存在：' + c.name });
    if (trash) {
      return Promise.resolve(trash(target)).then(function () {
        log('[SKILLS] 已移入回收站 ' + c.name);
        return { ok: true, name: c.name, trashed: true };
      }).catch(function (e) {
        return { ok: false, error: '移入回收站失败：' + String(e && e.message) };
      });
    }
    try {
      fs.rmSync(target, { recursive: true, force: true });
      log('[SKILLS] 已删除（硬删：本机未提供回收站通道）' + c.name);
      return Promise.resolve({ ok: true, name: c.name, trashed: false });
    } catch (e) { return Promise.resolve({ ok: false, error: String(e && e.message) }); }
  }

  // ---- 压缩包 / 多文件导入（新增 2026-09-12） ----
  // fflate 位于 DSH 后端 node_modules（resources/app 侧无 node_modules），用绝对路径引入
  let _fflate = null;
  function loadFflate() {
    if (_fflate) return _fflate;
    try { _fflate = require(path.resolve(BASE, 'app', 'node_modules', 'fflate')); }
    catch (e) { try { _fflate = require('fflate'); } catch (e2) { _fflate = null; } }
    return _fflate;
  }

  function toBytesLocal(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (Array.isArray(data)) return Uint8Array.from(data);
    if (data && data.type === 'Buffer' && Array.isArray(data.data)) return Uint8Array.from(data.data);
    return null;
  }

  /** 临时文件 + rename 原子落盘 */
  function atomicWrite(target, bytes) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = target + '.dstn-part-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, bytes, { flag: 'wx' });
    try { fs.renameSync(tmp, target); }
    catch (e1) { fs.rmSync(target, { force: true }); fs.renameSync(tmp, target); }
  }

  /** 把相对路径解析为 ROOT 下的绝对落点，拒绝穿越 / 非法名；失败返回 null */
  function safeTarget(rel) {
    const clean = String(rel == null ? '' : rel).replace(/\\/g, '/').replace(/^\.?\//, '');
    if (!clean) return null;
    if (/(^|\/)\.\.(\/|$)/.test(clean)) return null;          // 拒绝路径穿越
    // 拒绝控制字符（纯 ASCII 判定，避免源码里出现裸控制字节）
    for (let i = 0; i < clean.length; i++) {
      const c = clean.charCodeAt(i);
      if (c < 32 || c === 127) return null;
    }
    const full = path.join(ROOT, clean);
    return isWithin(ROOT, full) ? full : null;
  }

  function bytesLen(b) { return (typeof b === 'string') ? Buffer.byteLength(b) : b.length; }

  /**
   * 从 .zip 字节导入一个技能。兼容两种结构（自动识别）：
   *   ① 单一顶层文件夹 <name>/SKILL.md（及任意子资源，含 .json/.yaml/.yml）
   *   ② 顶层直接 SKILL.md（及同层 .json/.yaml/.yml 等资源）
   * 技能名一律取 SKILL.md 的 frontmatter.name（与 list 生效口径一致）。
   */
  function importZip(buffer, opts) {
    const buf = toBytesLocal(buffer);
    if (!buf) return { ok: false, error: '压缩包内容无法识别（期望 Uint8Array / Buffer / base64 对象）' };
    if (buf.byteLength === 0) return { ok: false, error: '压缩包为空' };
    if (buf.byteLength > SKILL_IMPORT_ZIP_MAX) {
      return { ok: false, error: '压缩包过大（' + (buf.byteLength / 1048576).toFixed(1) + ' MB，上限 ' + (SKILL_IMPORT_ZIP_MAX / 1048576) + ' MB）' };
    }
    const fl = loadFflate();
    if (!fl || typeof fl.unzipSync !== 'function') {
      return { ok: false, error: '解压库不可用（fflate 未安装）' };
    }
    let unzipped;
    try { unzipped = fl.unzipSync(buf); }
    catch (e) { return { ok: false, error: 'zip 解压失败：' + String(e && e.message) }; }

    // 归一化为 { 相对路径(去除前导 ./ 与反斜杠): Uint8Array }
    const map = {};
    Object.keys(unzipped).forEach(function (k) {
      const n = String(k).replace(/^\.?\//, '').replace(/\\/g, '/');
      if (n && !n.endsWith('/')) map[n] = unzipped[k];
    });
    const entries = Object.keys(map);
    if (!entries.length) return { ok: false, error: '压缩包内没有文件' };

    // 顶层文件夹分布：>1 视为多技能包，拒绝
    const tops = new Set(entries.map(function (n) { return n.includes('/') ? n.slice(0, n.indexOf('/')) : ''; }));
    if (tops.size > 1) {
      return { ok: false, error: '不支持一次导入多个技能（压缩包含多个顶层目录），请一次只打一个技能' };
    }
    const sharedTop = (tops.size === 1 && [...tops][0] !== '') ? [...tops][0] : null;

    const skillRel = entries.find(function (n) { return /(^|\/)SKILL\.md$/i.test(n); });
    if (!skillRel) return { ok: false, error: '压缩包内未找到 SKILL.md' };

    const skillBytes = map[skillRel];
    const skillBody = (typeof skillBytes === 'string') ? skillBytes : Buffer.from(skillBytes).toString('utf8');
    const pf = parseFrontmatter(skillBody);
    const name0 = (pf.front && pf.front.name) ? String(pf.front.name) : null;
    const cn = name0 ? checkName(name0) : { ok: false, error: 'SKILL.md 的 frontmatter 缺少 name（必填，且须为 kebab-case）' };
    if (!cn.ok) return { ok: false, error: cn.error };
    const name = cn.name;

    if (fs.existsSync(path.join(ROOT, name))) {
      return { ok: false, error: '同名技能已存在：' + name + '，请先删除再导入' };
    }

    // 总大小 / 单文件上限
    let total = 0;
    for (const n of entries) {
      const len = bytesLen(map[n]);
      if (len > SKILL_IMPORT_ENTRY_MAX) return { ok: false, error: '文件过大：' + n + '（' + (len / 1048576).toFixed(1) + ' MB，上限 ' + (SKILL_IMPORT_ENTRY_MAX / 1048576) + ' MB）' };
      total += len;
      if (total > SKILL_IMPORT_TOTAL_MAX) return { ok: false, error: '解压后总大小超限（上限 ' + (SKILL_IMPORT_TOTAL_MAX / 1048576) + ' MB）' };
    }

    const written = [];
    const warnings = [];
    for (const n of entries) {
      let rel = n;
      if (sharedTop && rel.startsWith(sharedTop + '/')) rel = rel.slice(sharedTop.length + 1);
      // 全部落进 <ROOT>/<name>/ 下（技能专属目录），name 来自 frontmatter，已 checkName 校验
      const target = safeTarget(path.join(name, rel));
      if (!target) { warnings.push('已跳过非法路径：' + n); continue; }
      const b = map[n];
      const bytes = (typeof b === 'string') ? Buffer.from(b, 'utf8') : Buffer.from(b);
      try { atomicWrite(target, bytes); written.push(rel); }
      catch (e) { warnings.push('写入失败 ' + n + '：' + (e && e.message)); }
    }
    if (!written.length) return { ok: false, error: '没有可写入的文件' };
    log('[SKILLS] 已导入(zip) ' + name + '（' + written.length + ' 个文件）');
    return { ok: true, name: name, path: path.join(ROOT, name), files: written, warnings: warnings };
  }

  /**
   * 从一组松散文件（每项 { name, data: base64 }）导入一个技能：
   *   · 必须恰好一个 .md/.markdown/.txt 作为 SKILL.md（优先 frontmatter.name，缺则取文件名）
   *   · 其余 .json/.yaml/.yml/.txt 等作为资源原样落盘
   * 支持 MD 等格式直接上传，无需先打包成 zip。
   */
  function importFiles(items, opts) {
    if (!Array.isArray(items) || !items.length) return { ok: false, error: '未收到任何文件' };
    const parsed = [];
    for (const it of items) {
      const rawName = String((it && it.name) || '');
      const data = it && it.data;
      if (!rawName || !data) continue;
      let bytes;
      try { bytes = Buffer.from(String(data), 'base64'); }
      catch (e) { return { ok: false, error: '文件 ' + rawName + ' 数据无法解码（期望 base64）' }; }
      if (bytes.length > SKILL_IMPORT_ENTRY_MAX) return { ok: false, error: '文件过大：' + rawName + '（上限 ' + (SKILL_IMPORT_ENTRY_MAX / 1048576) + ' MB）' };
      parsed.push({ name: rawName, bytes: bytes });
    }
    if (!parsed.length) return { ok: false, error: '没有可识别的文件' };

    const skillItems = parsed.filter(function (p) { return /\.(md|markdown|txt)$/i.test(p.name); });
    if (skillItems.length !== 1) {
      return { ok: false, error: skillItems.length
        ? ('只支持一个 SKILL.md（检测到 ' + skillItems.length + ' 个文本文件）；请把其余文件作为资源一起选，或打包成 zip')
        : '缺少 SKILL.md（请选择 .md / .markdown / .txt 文件）' };
    }
    const skill = skillItems[0];
    const body = skill.bytes.toString('utf8');
    const pf = parseFrontmatter(body);
    const name0 = (pf.front && pf.front.name) ? String(pf.front.name) : toKebab(skill.name.replace(/\.[^.]+$/, ''));
    const cn = checkName(name0);
    if (!cn.ok) return { ok: false, error: cn.error };
    const name = cn.name;

    if (fs.existsSync(path.join(ROOT, name))) {
      return { ok: false, error: '同名技能已存在：' + name + '，请先删除再导入' };
    }

    const finalBody = ensureFrontmatter(body, name, name);
    try {
      atomicWrite(path.join(ROOT, name, 'SKILL.md'), Buffer.from(finalBody, 'utf8'));
    } catch (e) { return { ok: false, error: '写入 SKILL.md 失败：' + (e && e.message) }; }

    const written = ['SKILL.md'];
    const warnings = [];
    for (const p of parsed) {
      if (p === skill) continue;
      const safe = sanitizeName(p.name);
      // 资源落进 <ROOT>/<name>/ 下（与 SKILL.md 同目录）
      const target = safeTarget(path.join(name, safe));
      if (!target) { warnings.push('已跳过非法文件名：' + p.name); continue; }
      try { atomicWrite(target, p.bytes); written.push(safe); }
      catch (e) { warnings.push('写入失败 ' + p.name + '：' + (e && e.message)); }
    }
    log('[SKILLS] 已导入(files) ' + name + '（' + written.length + ' 个文件）');
    return { ok: true, name: name, path: path.join(ROOT, name), files: written, warnings: warnings };
  }

  /** 导出技能为 .zip（base64）：目录形态 <name>/ 与单文件形态 <name>.md 都支持；
   *  统一打包成单层顶目录 <name>/...，与 importZip 的「单顶层目录」分支完全兼容（导出即可被他人导入）。 */
  function exportSkill(name) {
    const c = checkName(name);
    if (!c.ok) return { ok: false, error: c.error };
    const dirPath = path.join(ROOT, c.name);
    const filePath = path.join(ROOT, c.name + '.md');
    let files = [];   // { rel: '<name>/xxx', full: 绝对路径 }
    if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
      // 递归遍历（技能目录一般扁平，但允许嵌套资源）
      const walk = function (dir, base) {
        const ents = fs.readdirSync(dir);
        for (let i = 0; i < ents.length; i++) {
          const full = path.join(dir, ents[i]);
          const st = fs.statSync(full);
          if (st.isDirectory()) walk(full, path.join(base, ents[i]));
          else if (st.isFile()) files.push({ rel: path.join(base, ents[i]).replace(/\\/g, '/'), full: full });
        }
      };
      walk(dirPath, c.name);
    } else if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      files.push({ rel: c.name + '/SKILL.md', full: filePath });
    } else {
      return { ok: false, error: '技能不存在：' + c.name };
    }
    if (!files.length) return { ok: false, error: '技能目录为空，无可导出文件：' + c.name };

    const fflate = loadFflate();
    if (!fflate || !fflate.zipSync) return { ok: false, error: '压缩库不可用（fflate 未安装）' };

    const obj = {};
    let total = 0;
    for (let i = 0; i < files.length; i++) {
      const data = fs.readFileSync(files[i].full);
      total += data.length;
      if (total > SKILL_EXPORT_TOTAL_MAX) {
        return { ok: false, error: '技能过大（' + (total / 1048576).toFixed(1) + ' MB，上限 ' + (SKILL_EXPORT_TOTAL_MAX / 1048576) + ' MB）' };
      }
      obj[files[i].rel] = new Uint8Array(data);
    }
    let zipped;
    try { zipped = fflate.zipSync(obj, { level: 6 }); }
    catch (e) { return { ok: false, error: '压缩失败：' + String(e && e.message ? e.message : e) }; }
    return {
      ok: true, name: c.name, zip: Buffer.from(zipped).toString('base64'),
      count: files.length, bytes: zipped.length
    };
  }

  return {
    list: list, read: read, write: write, remove: remove,
    importZip: importZip, importFiles: importFiles, exportSkill: exportSkill,
    root: ROOT, ensureRoot: ensureRoot, checkName: checkName,
    MAX_BYTES: SKILL_MAX_BYTES
  };
}

module.exports = {
  createFiles: createFiles,
  createSkills: createSkills,
  isWithin: isWithin,
  sanitizeName: sanitizeName,
  parseFrontmatter: parseFrontmatter
};
