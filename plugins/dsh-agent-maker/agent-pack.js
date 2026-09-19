/**
 * agent-pack.js —— 把用户的智能体（agent preset）打成「拷到别的 D-STATION 机器上、
 * 双击一下就能装好」的自包含安装包。
 *
 * 纯 JS，只用 Node 内置模块，**不 fork 子进程**。
 * 模板放在同目录的 templates/ 下，运行时按 UTF-8 读入。
 *
 * 设计契约（抄自 dsh-dstation-market/exporter.js，那边已经端到端验证过）：
 *   · zip 时间戳固定为 0x21（1980-01-01）⇒ 同样输入永远产出同样字节；
 *   · `.ps1` / `.txt` 写成 **UTF-8 带 BOM**，`.cmd` **必须是纯 ASCII**
 *     （PowerShell 5.1 按 ANSI 读无 BOM 的 .ps1 会乱码并语法报错；
 *      cmd.exe 按 OEM 代码页读 .cmd，中文同样乱码）；
 *   · 装之前先逐文件校验 sha256，坏包宁可在安装前就停下。
 *
 * 与插件分发包（市场）的区别：智能体不是插件，不碰 profile / node_modules /
 * junction / bundles —— 只是往 `<DSH_HOME>\.agent-presets\<id>\` 放一个目录。
 * 所以这里没有任何「改别人的插件清单」的动作，风险面小得多。
 */

import {
  existsSync, readFileSync, readdirSync, statSync
} from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const TPL_DIR = join(HERE, 'templates');

export const PRESET_DIR_NAME = '.agent-presets';
export const BUNDLE_SCHEMA = 'dstation-agent-bundle/v1';

/** 打包时跳过的目录名（智能体目录里正常不会出现，防御性处理） */
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '__pycache__', '.cache']);

/**
 * 基础设施型预设：由插件自己生成 / 属于别的插件，不是「用户的智能体」。
 * 与 client.js 的 SUPER AGENTS 列表口径保持一致（两处必须同步）。
 */
export const INFRA_PRESET_IDS = ['agent-orchestrator', 'kb-manager'];

/* ════════════════════════════════════════════════════════════ zip ══ */

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
 * 纯 Node 的 zip 写入器（store / deflate 自动取小，文件名标 UTF-8）。
 * 时间戳常量 ⇒ 输出确定，便于「同样输入产出同样字节」的漂移检测。
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
    lh.writeUInt16LE(0x0800, 6);
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

/* ═══════════════════════════════════════════════ 路径解析 ══ */

/**
 * 定位 DSH_HOME。
 *
 * 为什么不能只看环境变量：插件可能被别的加载路径拉起、或用户手工启动，
 * 那时 DSH_HOME 未必在 process.env 里。所以先信环境变量（但必须验它真的有
 * `profiles`），再从**插件自身位置**向上找第一个含 `profiles` 的祖先目录。
 *
 * 插件自身位置是 `<DSH_HOME>\profiles\<p>\node_modules\<pkg>`，
 * 向上的链里只有 DSH_HOME 那一层含 `profiles`，因此答案唯一。
 */
export function findDshHome(env = process.env, from = HERE) {
  const envHome = env && env.DSH_HOME ? String(env.DSH_HOME) : '';
  if (envHome && existsSync(join(envHome, 'profiles'))) return envHome;

  let cur = from;
  for (let i = 0; i < 12; i++) {
    const parent = dirname(cur);
    if (!parent || parent === cur) break;
    if (existsSync(join(parent, 'profiles'))) return parent;
    cur = parent;
  }
  return '';
}

/** 智能体预设的落盘根：`<DSH_HOME>\.agent-presets` */
export function presetsRoot(dshHome) {
  return dshHome ? join(dshHome, PRESET_DIR_NAME) : '';
}

/* ═════════════════════════════════════════ 预设元数据解析 ══ */

/**
 * 解析 preset.yml —— **刻意不引 YAML 库**。
 * 这个文件由 dsh-agent-presets 生成，结构固定为若干顶层标量键
 * （实测只有 name / description / order），所以按行解析足够，
 * 而且容错更好：解析不了就当没有，不影响打包。
 */
export function parsePresetMeta(text) {
  const out = { name: '', description: '', order: null };
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    // 去掉成对引号（单/双），以及 YAML 的块标量记号（>、|）——那些的多行内容这里不解析
    if ((val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
        (val.startsWith("'") && val.endsWith("'") && val.length >= 2)) {
      val = val.slice(1, -1);
    }
    if (val === '>' || val === '|' || val === '>-' || val === '|-') val = '';
    if (key === 'name') out.name = val;
    else if (key === 'description') out.description = val;
    else if (key === 'order') out.order = Number.isFinite(Number(val)) ? Number(val) : null;
  }
  return out;
}

/* ═══════════════════════════════════════════ 文件收集 ══ */

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

/** 收集一个智能体目录下的全部文件（相对路径，正斜杠） */
export function collectPresetFiles(dir) {
  return walk(dir, dir, []).sort();
}

/* ═══════════════════════════════════════════ 依赖扫描 ══ */

const RE_PLUGIN_NAME = /^\s*name\s*:\s*['"]?([^'"\s#]+)['"]?\s*$/gm;
const RE_PROCESS_ENV = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g;
const RE_ENVISH = /\b([A-Z][A-Z0-9_]{3,}(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_ENDPOINT))\b/g;
const RE_ABS_PATH = /(?:[A-Za-z]:\\[^"'\r\n,)\]}]{2,}|\/(?:Users|home|opt|srv|mnt|data)\/[^"'\r\n,)\]}]{2,})/g;

/**
 * 扫描一个智能体的外部依赖。
 *
 * ⚠️ 立场说明：这里做的是**分诊**，不是完整解析。目标是「让对方知道可能要自备什么」，
 * 所以宁可多列一条让人看一眼，也不要漏。所有「疑似」项都在文案里标明是疑似。
 *
 * @param {string} presetDir      智能体目录
 * @param {object} opts           { knownSkillNames?: string[] }
 * @returns {object}              结构化依赖
 */
export function scanDependencies(presetDir, opts = {}) {
  const ymlPath = join(presetDir, 'agent.cordis.yml');
  let text = '';
  try { text = readFileSync(ymlPath, 'utf8'); } catch { text = ''; }

  /* ① 编排里挂载的插件：@deepseek-ai/* 是 DSH 自带，对方一定有；
        其余（第三方插件 / 自研插件）对方未必装得上 —— 这才是真正要提醒的。 */
  const builtin = new Set();
  const external = new Set();
  RE_PLUGIN_NAME.lastIndex = 0;
  let m;
  while ((m = RE_PLUGIN_NAME.exec(text)) !== null) {
    const n = m[1];
    if (!n || n === 'cordis:group') continue;
    if (n.startsWith('@deepseek-ai/') || n.startsWith('cordis:')) builtin.add(n);
    else external.add(n);
  }

  /* ② 环境变量 / 凭据：显式的 process.env.X 一定要列；
        另用后缀启发式捞「看着像 KEY 的全大写词」，标注为疑似。 */
  const envVars = new Set();
  RE_PROCESS_ENV.lastIndex = 0;
  while ((m = RE_PROCESS_ENV.exec(text)) !== null) envVars.add(m[1]);
  const envish = new Set();
  RE_ENVISH.lastIndex = 0;
  while ((m = RE_ENVISH.exec(text)) !== null) {
    if (!envVars.has(m[1])) envish.add(m[1]);
  }

  /* ③ 绝对路径：对方机器上多半不存在（工作区、知识库、数据文件…）。
        这条最容易被忽略，却是「拷过去就报错」的头号原因。 */
  const absPaths = new Set();
  RE_ABS_PATH.lastIndex = 0;
  while ((m = RE_ABS_PATH.exec(text)) !== null) {
    const p = m[0].replace(/[.,;:]+$/, '');
    // 排掉 URL 与包名残留
    if (/^https?:/i.test(p)) continue;
    absPaths.add(p);
  }

  /* ④ 随包自带的技能（preset 目录里的 skills/），对方装了包就有 */
  const bundledSkills = [];
  try {
    const sd = join(presetDir, 'skills');
    for (const e of readdirSync(sd, { withFileTypes: true })) {
      if (e.isDirectory()) bundledSkills.push(e.name);
    }
  } catch { /* 没有 skills 目录是常态 */ }

  /* ⑤ 全局技能引用：智能体正文里提到某个已安装技能名 —— 对方也得有这个技能。
        判据是「确实在 <DSH_HOME>\skills 里存在这个名字」，避免瞎猜。 */
  const known = Array.isArray(opts.knownSkillNames) ? opts.knownSkillNames : [];
  const globalSkills = known.filter((n) => {
    if (!n || bundledSkills.includes(n)) return false;
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9_-])${esc}([^A-Za-z0-9_-]|$)`).test(text);
  });

  return {
    builtinPlugins: [...builtin].sort(),
    externalPlugins: [...external].sort(),
    envVars: [...envVars].sort(),
    suspectedEnvVars: [...envish].sort(),
    absPaths: [...absPaths].sort(),
    bundledSkills: bundledSkills.sort(),
    globalSkills: globalSkills.sort()
  };
}

/** 把结构化依赖渲染成人话清单（进安装说明，也进 API 返回给界面） */
export function describeDependencies(dep) {
  const lines = [];
  if (dep.externalPlugins.length) {
    lines.push('⚠️ 这个智能体挂载了**非 DSH 自带**的插件：' + dep.externalPlugins.join('、'));
    lines.push('   对方机器上如果没装这些插件，智能体拉起后会缺少对应能力。请先让对方装好。');
  }
  if (dep.envVars.length) {
    lines.push('🔑 需要环境变量 / API KEY：' + dep.envVars.join('、'));
    lines.push('   装好后请在对方机器上把这些变量配好，否则相关功能会失败。');
  }
  if (dep.suspectedEnvVars.length) {
    lines.push('🔑 疑似还需要（文中出现过，请人工确认）：' + dep.suspectedEnvVars.join('、'));
  }
  if (dep.globalSkills.length) {
    lines.push('🧩 引用了全局技能：' + dep.globalSkills.join('、'));
    lines.push('   这些技能不在本安装包里，对方也需要有同名技能。');
  }
  if (dep.bundledSkills.length) {
    lines.push('✅ 自带技能（已打进本包，对方无需另装）：' + dep.bundledSkills.join('、'));
  }
  if (dep.absPaths.length) {
    lines.push('📁 文中出现绝对路径（对方机器上可能不存在，需要时请自行调整）：');
    for (const p of dep.absPaths.slice(0, 12)) lines.push('     ' + p);
    if (dep.absPaths.length > 12) lines.push('     …另有 ' + (dep.absPaths.length - 12) + ' 条');
  }
  if (!lines.length) {
    lines.push('✅ 没扫到明显的额外依赖：只用 DSH 自带能力，对方装完即可用。');
  }
  return lines;
}

/* ═══════════════════════════════════════════ 清单 ══ */

function humanSize(n) {
  if (n < 1024) return n + ' 字节';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function fill(tpl, vars) {
  return tpl.replace(/@@([A-Z_]+)@@/g, (all, key) => (key in vars ? String(vars[key]) : all));
}

/**
 * 列出 `<DSH_HOME>\.agent-presets` 下的智能体（宿主侧权威视图）。
 * 目录里但读不出 agent.cordis.yml 的，标 broken 而不是静默丢掉 ——
 * 「SUPER AGENTS 里看不见」这类问题必须先能看见原因。
 */
export function listPresets(root, opts = {}) {
  const out = [];
  if (!root || !existsSync(root)) return out;
  let ents = [];
  try { ents = readdirSync(root, { withFileTypes: true }); } catch { return out; }

  for (const e of ents) {
    if (!e.isDirectory()) continue;
    const dir = join(root, e.name);
    const ymlPath = join(dir, 'agent.cordis.yml');
    const item = {
      id: e.name,
      dir,
      name: '',
      description: '',
      order: null,
      infra: INFRA_PRESET_IDS.includes(e.name),
      broken: '',
      fileCount: 0,
      bytes: 0
    };
    if (!existsSync(ymlPath)) {
      item.broken = '目录里没有 agent.cordis.yml（宿主会把它标成 broken，且不出现在 SUPER AGENTS）';
    }
    try {
      const meta = parsePresetMeta(readFileSync(join(dir, 'preset.yml'), 'utf8'));
      item.name = meta.name || '';
      item.description = meta.description || '';
      item.order = meta.order;
    } catch { /* preset.yml 缺失是常态，用 id 兜底 */ }
    try {
      const files = collectPresetFiles(dir);
      item.fileCount = files.length;
      item.bytes = files.reduce((n, rel) => {
        try { return n + statSync(join(dir, rel)).size; } catch { return n; }
      }, 0);
    } catch { /* 忽略 */ }
    out.push(item);
  }

  out.sort((a, b) => {
    const ao = a.order === null ? 1e9 : a.order;
    const bo = b.order === null ? 1e9 : b.order;
    if (ao !== bo) return ao - bo;
    return String(a.name || a.id).localeCompare(String(b.name || b.id), 'zh');
  });
  return out;
}

/** 默认打包集合：排除基础设施预设（与界面 SUPER AGENTS 口径一致） */
export function defaultPackableIds(all) {
  return all
    .filter((p) => !p.infra && !p.broken)
    .map((p) => p.id);
}

/* ═══════════════════════════════════════════ 打包 ══ */

function stampForName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * 生成智能体分发包。
 *
 * 包结构（对 1 个或多个智能体**完全一致**，安装器只需一套逻辑）：
 *   <root>/一键安装.cmd        纯 ASCII，双击入口
 *   <root>/install.ps1         UTF-8 带 BOM，干实事的
 *   <root>/安装说明.txt          UTF-8 带 BOM，含依赖清单
 *   <root>/MANIFEST.json       逐文件 sha256
 *   <root>/agent/<id>/...      智能体本体
 *
 * @param {string} root   预设根目录（<DSH_HOME>\.agent-presets）
 * @param {string[]} ids  要打包的智能体 id
 * @param {object} opts   { knownSkillNames, dshHome, builtAt }
 * @returns {{ fileName: string, data: Buffer, summary: object }}
 * @throws {Error} 任何自洽性检查不通过
 */
export function buildAgentBundle(root, ids, opts = {}) {
  if (!root) throw new Error('找不到 DSH 主目录，无法定位 .agent-presets');

  /* id 名单来自客户端，**必须**当成不可信输入：
     它会被拼进文件系统路径与 zip 内路径。 */
  const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
  function normalizeIds(list) {
    const out = [];
    for (const raw of list) {
      const id = String(raw || '');
      if (!ID_RE.test(id)) throw new Error(`智能体 id 不合法：${JSON.stringify(id)}`);
      if (!out.includes(id)) out.push(id);
    }
    return out;
  }

  /* ⚠️ 顺序有讲究：**显式传入**的 id 必须先在下面过形状闸门，再去看目录在不在。
     反过来写的话，在还没有任何用户智能体的机器上（全新安装就是这样）目录检查会
     先抛错，路径穿越 / 绝对路径这类**形状非法**的 id 就永远走不到闸门 ——
     客户端收到的是 500「智能体目录不存在」而不是 400「id 不合法」，
     这条安全闸门也就失去了被验证的机会（CI 上就是这么暴露的）。 */
  const explicit = Array.isArray(ids) && ids.length > 0;
  const explicitIds = explicit ? normalizeIds(ids) : null;

  if (!existsSync(root)) throw new Error(`智能体目录不存在：${root}（这台机器上还没有用户智能体）`);

  const safeIds = explicit ? explicitIds : normalizeIds(defaultPackableIds(listPresets(root)));
  if (!safeIds.length) throw new Error('没有可打包的智能体（列表为空）');

  const templates = ['install.ps1.tpl', '一键安装.cmd.tpl', '安装说明.txt.tpl'];
  for (const t of templates) {
    if (!existsSync(join(TPL_DIR, t))) {
      throw new Error('插件安装不完整：缺少模板 templates/' + t + '（请重装 dsh-agent-maker）');
    }
  }

  const builtAt = opts.builtAt || new Date().toISOString();
  const agents = [];
  const allDeps = [];

  for (const id of safeIds) {
    const dir = join(root, id);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new Error(`找不到智能体：${id}`);
    }
    /* 自洽性闸门：缺 agent.cordis.yml 的目录在对方机器上同样是 broken，
       打包出去只会把问题复制一份。宁可在这里停下。 */
    const ymlPath = join(dir, 'agent.cordis.yml');
    if (!existsSync(ymlPath)) {
      throw new Error(`智能体「${id}」缺少 agent.cordis.yml，无法打包（请先在工作台里修好它）`);
    }
    const ymlText = readFileSync(ymlPath, 'utf8');
    if (!ymlText.trim()) {
      throw new Error(`智能体「${id}」的 agent.cordis.yml 是空的，无法打包`);
    }
    RE_PLUGIN_NAME.lastIndex = 0;
    if (!RE_PLUGIN_NAME.test(ymlText)) {
      throw new Error(`智能体「${id}」的 agent.cordis.yml 里没有任何 name: 条目，装到对方机器上也起不来`);
    }

    const meta = (() => {
      try { return parsePresetMeta(readFileSync(join(dir, 'preset.yml'), 'utf8')); }
      catch { return { name: '', description: '', order: null }; }
    })();

    const rels = collectPresetFiles(dir);
    if (!rels.length) throw new Error(`智能体「${id}」的目录是空的`);

    const dep = scanDependencies(dir, { knownSkillNames: opts.knownSkillNames });
    allDeps.push({ id, name: meta.name || id, dep });

    agents.push({
      id,
      name: meta.name || id,
      description: meta.description || '',
      dir: 'agent/' + id,
      files: rels.map((rel) => {
        const data = readFileSync(join(dir, rel));
        return {
          path: 'agent/' + id + '/' + rel,
          size: data.length,
          sha256: createHash('sha256').update(data).digest('hex')
        };
      }),
      _payload: rels.map((rel) => ({
        name: 'agent/' + id + '/' + rel,
        data: readFileSync(join(dir, rel))
      }))
    });
  }

  const depText = allDeps
    .map((a) => {
      const lines = describeDependencies(a.dep);
      return agents.length > 1 ? [`【${a.name}（${a.id}）】`, ...lines] : lines;
    })
    .flat()
    .join('\n');

  const fileCount = agents.reduce((n, a) => n + a.files.length, 0);
  const totalBytes = agents.reduce((n, a) => n + a.files.reduce((k, f) => k + f.size, 0), 0);

  const manifest = {
    schema: BUNDLE_SCHEMA,
    kind: 'agent-preset',
    builtAt,
    builtBy: 'dsh-agent-maker',
    sourceHome: opts.dshHome || '',
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      dir: a.dir,
      files: a.files
    })),
    dependencies: allDeps.map((a) => ({ id: a.id, name: a.name, ...a.dep }))
  };

  const rootName = agents.length === 1
    ? `智能体-${agents[0].name}-${agents[0].id}`
    : `我的智能体-${agents.length}个-${stampForName(new Date(builtAt))}`;

  const vars = {
    AGENT_COUNT: agents.length,
    AGENT_IDS: agents.map((a) => a.id).join(', '),
    AGENT_NAMES: agents.map((a) => a.name).join('、'),
    BUILT_AT: builtAt,
    SOURCE_HOME: opts.dshHome || '(未记录)',
    DEPS_TEXT: depText,
    FILE_COUNT: fileCount,
    TOTAL_SIZE: humanSize(totalBytes)
  };

  const readTpl = (f) => readFileSync(join(TPL_DIR, f), 'utf8');
  const BOM = '\ufeff';

  const asPs1 = (t) => Buffer.from(BOM + fill(t, vars), 'utf8');
  const asTxt = (t) => Buffer.from(BOM + fill(t, vars), 'utf8');
  const asCmd = (t) => {
    const text = fill(t, vars);
    // .cmd 必须纯 ASCII：与其发一个「能装但命令是坏的」包，不如在这里就失败。
    const bad = /[^\x00-\x7F]/.exec(text);
    if (bad) {
      throw new Error('一键安装.cmd 模板里出现了非 ASCII 字符（' + JSON.stringify(bad[0]) +
        '）：.cmd 必须是纯 ASCII，否则 cmd.exe 会乱码。请改模板。');
    }
    return Buffer.from(text, 'ascii');
  };

  const entries = [
    { name: rootName + '/install.ps1', data: asPs1(readTpl('install.ps1.tpl')) },
    { name: rootName + '/一键安装.cmd', data: asCmd(readTpl('一键安装.cmd.tpl')) },
    { name: rootName + '/安装说明.txt', data: asTxt(readTpl('安装说明.txt.tpl')) },
    /* 依赖清单单独出一份纯文本：安装脚本直接打印它。
       不在 install.ps1 里重新拼这段文字 —— 注入中文多行文本到 .ps1 模板里
       要处理转义与 here-string 边界，任何一处出错都会让安装脚本语法报错。
       由 JS 生成、PS 只负责读，是这里唯一不会漂移的分工。 */
    { name: rootName + '/依赖清单.txt', data: asTxt(depText + '\n') },
    { name: rootName + '/MANIFEST.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8') },
    /* ⚠️ 这里必须补上 rootName 前缀。_payload 里的 name 是包内相对路径
       （agent/<id>/…），少了前缀智能体就会散落在 zip 根目录下，
       安装器按 manifest 的 path 找不到文件 —— 而这一步由下面那道
       「清单里的文件必须真的在 zip 里」的闸门兜住（写这个模块时它真的抓到了这个 bug）。 */
    ...agents.flatMap((a) => a._payload.map((p) => ({ name: rootName + '/' + p.name, data: p.data })))
  ];

  /* 自洽性：清单里声明的每一个文件都必须真的进了 zip。
     少一个文件 = 对方装出一个残废的智能体，而且要到运行时才发现。 */
  const entryNames = new Set(entries.map((e) => e.name));
  for (const a of manifest.agents) {
    for (const f of a.files) {
      if (!entryNames.has(rootName + '/' + f.path)) {
        throw new Error(`内部错误：${f.path} 没有被打进包里`);
      }
    }
  }
  if (manifest.agents.reduce((n, a) => n + a.files.length, 0) !== fileCount) {
    throw new Error('内部错误：清单文件数与实际不符');
  }

  return {
    fileName: rootName + '-智能体包.zip',
    data: makeZip(entries),
    summary: {
      agentCount: agents.length,
      agents: agents.map((a) => ({ id: a.id, name: a.name, fileCount: a.files.length })),
      fileCount,
      totalBytes,
      entryCount: entries.length,
      dependencies: allDeps.map((a) => ({ id: a.id, name: a.name, ...a.dep }))
    }
  };
}

/** 仅供离线测试使用的内部视图 */
export const __internals = {
  crc32,
  humanSize,
  fill,
  stampForName,
  SKIP_DIRS,
  RE_PLUGIN_NAME,
  RE_PROCESS_ENV,
  RE_ENVISH,
  RE_ABS_PATH,
  TPL_DIR
};
