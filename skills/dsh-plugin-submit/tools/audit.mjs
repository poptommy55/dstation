#!/usr/bin/env node
/**
 * audit.mjs —— DSH 插件风险扫描引擎（投稿审核「第 2 层」）
 *
 * 它审的不是「代码写得好不好」，而是**「会不会伤害装它的人」**。
 * 因为 DSH 插件没有沙箱：宿主半直接跑在主进程里，一个恶意插件 = 任意代码执行。
 *
 * 用法：
 *   node audit.mjs <插件目录> [--json] [--out 报告文件]
 *   node audit.mjs <插件目录> --quiet      # 只输出一行结论（给脚本调用）
 *
 * 退出码：0 = 无 blocker；2 = 存在 blocker（建议拒绝）；1 = 用法/IO 错误
 *
 * 设计原则：
 *   1. **只读不执行**。全程只读文件文本做匹配，绝不 require / import 被审代码。
 *   2. **报告能力，不妄下结论**。找到什么就报什么，附文件名、行号、原文片段，
 *      由人（或上层 agent）判断相称性。
 *   3. **支持「声明式能力」**。作者可在 package.json 的 `dsh.capabilities` 里声明
 *      自己需要的能力，audit 会把「未声明的能力」单独标出来——这是判断"相称性"
 *      最客观的抓手。
 */

import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, extname, relative, sep } from 'node:path';

// ─────────────────────────────────────────────────────────────
// 常量表
// ─────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '__pycache__', 'dist', 'build']);

/** 文本类扩展名（会读进来做行级扫描） */
const SCAN_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx', '.json', '.yml', '.yaml']);

/** 二进制 / 可执行：直接阻断，没有任何理由出现在插件里 */
const BINARY_EXT = new Set([
  '.node', '.exe', '.dll', '.so', '.dylib', '.com', '.msi',
  '.bat', '.cmd', '.scr', '.jar', '.class', '.wasm',
]);

/** 脚本类：不阻断，但要提示「审核者需要读它」 */
const SCRIPT_EXT = new Set(['.ps1', '.sh', '.bash', '.py', '.rb', '.pl', '.vbs']);

/** 生命周期脚本：安装时自动执行 = 绕过审核的最佳路径，一律阻断 */
const LIFECYCLE_HOOKS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly'];

const SEV_ORDER = { blocker: 0, high: 1, medium: 2, low: 3, info: 4 };
const SEV_LABEL = { blocker: '阻断', high: '高危', medium: '中危', low: '低危', info: '提示' };
const SEV_PENALTY = { blocker: 40, high: 14, medium: 4, low: 1, info: 0 };

/** 行级规则：id / 严重度 / 中文名 / 正则 / 为什么危险 */
const LINE_RULES = [
  {
    id: 'R01', sev: 'blocker', label: '动态执行 eval',
    re: /\beval\s*\(/,
    why: 'eval 可以把字符串当代码跑，审核者无法知道它到底会执行什么。',
  },
  {
    id: 'R02', sev: 'blocker', label: '动态构造函数 new Function',
    re: /\bnew\s+Function\s*\(/,
    why: '与 eval 等价：绕过静态阅读，代码可以在运行时才拼出来。',
  },
  {
    id: 'R03', sev: 'blocker', label: '调用子进程',
    re: /(^|[^.\w$])child_process\b|\bexecSync\s*\(|\bspawnSync\s*\(|\bexecFileSync\s*\(|\bspawn\s*\(\s*['"`]/,
    why: '能起子进程 = 能在你机器上跑任意命令，插件没有这种正当需求。',
  },
  {
    id: 'R04', sev: 'blocker', label: '使用 vm / 隔离域模块',
    re: /require\s*\(\s*['"](?:node:)?vm['"]\s*\)|from\s+['"](?:node:)?vm['"]/,
    why: 'vm 常被用来在运行时解出并执行隐藏代码。',
  },
  {
    // ⚠️ 只有「绝对 URL」才算外联。DSH 插件的浏览器半 fetch 自己的宿主路由
    //    （相对路径，如 fetch('/foo/report')）是**标准通信方式**，绝不能误报。
    id: 'R05', sev: 'high', label: '对外发起网络请求（绝对 URL）',
    re: /(?:\bfetch|\baxios)\s*\(\s*[`'"](?:https?:)?\/\//,
    why: '外联意味着插件能把你的数据发到别人的服务器。要看它连的是不是它自己声明的域名。',
  },
  {
    id: 'R05B', sev: 'high', label: '使用原生网络 API',
    re: /XMLHttpRequest|\bhttps?\.(?:request|get)\s*\(|net\.(?:connect|createConnection)\s*\(|dns\.(?:lookup|resolve)\s*\(|new\s+WebSocket\s*\(|\bnew\s+XMLHttpRequest/,
    why: '这些 API 的存在本身就说明有网络行为，静态看往往看不出连的是谁。',
  },
  {
    // 只认「路径形态」的凭据位置。曾经把 fetch 的 `credentials: 'omit'` 选项
    // 当成了读凭据，制造大量假阳性 —— 规则必须窄。
    id: 'R06', sev: 'high', label: '读取凭据 / 敏感路径',
    re: /\.ssh[/\\]|\bid_rsa\b|\bid_ed25519\b|\.aws[/\\]|\.npmrc\b|\.netrc\b|\.git-credentials|Login\s*Data|Local\s*State|(?:\/|\\)\.env(?:\.|["'`\s]|$)|keychain/i,
    why: '这些路径下是密钥与登录态。一个 GUI 插件没有任何理由去读它们。',
  },
  {
    id: 'R07', sev: 'medium', label: '读取环境变量',
    re: /process\.env/,
    why: 'DSH 插件读 process.env.DSH_HOME 是正常的；但环境变量里也可能有 API key / token，需确认读的是哪一个、会不会被外发。',
  },
  {
    id: 'R08', sev: 'medium', label: '写文件 / 删文件',
    re: /writeFileSync\s*\(|writeFile\s*\(|appendFileSync\s*\(|createWriteStream\s*\(|rmSync\s*\(|unlinkSync\s*\(|rmdirSync\s*\(|(^|[^.\w$])rm\s*\(/,
    why: '写盘本身正常（插件要存配置），但要确认写的位置在插件自己的数据目录里，且不会递归删除。',
  },
  {
    id: 'R09', sev: 'medium', label: '动态 require / import',
    re: /require\s*\(\s*[^'"\s)]|import\s*\(\s*[^'"\s)]/,
    why: '非字面量的模块名意味着「加载什么」在运行时才决定，静态审查看不到。',
  },
  {
    id: 'R10', sev: 'info', label: '出现凭据相关字样',
    re: /password|passwd|\bsecret\b|api[_-]?key|\btoken\b/i,
    why: '只是提示，让审核者看一眼上下文（可能是正常的功能命名）。',
  },
];

/** 常见的良性域名：不是外联风险，标出来是为了减少噪音 */
const BENIGN_HOSTS = new Set([
  'localhost', '127.0.0.1', '0.0.0.0', '::1',
  'www.w3.org', 'w3.org', 'schema.org', 'creativecommons.org', 'opensource.org',
  'registry.npmjs.org', 'npmjs.com', 'github.com', 'raw.githubusercontent.com',
  'developer.mozilla.org', 'react.dev', 'unpkg.com', 'esm.sh', 'cdn.jsdelivr.net',
]);

// ─────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────

function walk(dir, base = dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.env.example') {
      if (e.isDirectory()) continue;
    }
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, base, out);
    } else if (e.isFile()) {
      out.push({ full, rel: relative(base, full).split(sep).join('/'), name: e.name });
    } else if (e.isSymbolicLink()) {
      out.push({ full, rel: relative(base, full).split(sep).join('/'), name: e.name, symlink: true });
    }
  }
  return out;
}

function truncateLine(s, n = 160) {
  const t = s.replace(/\t/g, '  ').trimEnd();
  return t.length > n ? t.slice(0, n) + ' …' : t;
}

function readJsonSafe(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

// ─────────────────────────────────────────────────────────────
// 主扫描
// ─────────────────────────────────────────────────────────────

/**
 * @param {string} srcDir  插件源码目录
 * @returns {{ok:boolean, score:number, level:string, verdict:string, findings:Array,
 *            capabilities:object, declared:object, undeclared:Array, files:Array,
 *            errors:string[], warnings:string[], stats:object}}
 */
export function auditPlugin(srcDir) {
  const findings = [];
  const errors = [];
  const warnings = [];
  const add = (f) => findings.push(f);

  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) {
    return {
      ok: false, score: 0, level: 'reject', verdict: `目录不存在：${srcDir}`,
      findings: [], capabilities: {}, declared: {}, undeclared: [], files: [],
      errors: [`目录不存在：${srcDir}`], warnings: [], stats: {},
    };
  }

  const files = walk(srcDir);
  const pkg = readJsonSafe(join(srcDir, 'package.json'));

  // ── 声明式能力 ────────────────────────────────────────────
  // 区分三种情况，审核者需要能分清：
  //   provided=false                 → 作者压根没用这个机制（不罚，降级为 info）
  //   provided=true 且 raw 为空       → 作者明确声明「不需要任何能力」（最强承诺）
  //   provided=true 且 raw 非空       → 可以核对「说的」和「做的」是否一致
  const capsProvided = Array.isArray(pkg?.dsh?.capabilities);
  const declaredCaps = capsProvided ? pkg.dsh.capabilities.map(String) : [];
  const declaredHosts = new Set(
    declaredCaps.filter((c) => c.startsWith('network:')).map((c) => c.slice(8).toLowerCase()),
  );

  // ── 文件级检查 ────────────────────────────────────────────
  const hosts = new Set();
  const hostHits = [];              // {host, file, line}
  let totalBytes = 0;
  let scannedFiles = 0;

  if (!pkg) {
    add({
      rule: 'MISSING-PKG', sev: 'blocker', label: '缺少 package.json',
      file: 'package.json', line: 0, snippet: '',
      why: '没有 package.json 的包装进去会让 DSH 的客户端模块组装失败，历史上直接导致过一次全站起不来。',
    });
  } else {
    // 生命周期脚本
    for (const hook of LIFECYCLE_HOOKS) {
      const v = pkg.scripts?.[hook];
      if (v && String(v).trim()) {
        add({
          rule: 'LIFECYCLE', sev: 'blocker', label: `生命周期脚本 ${hook}`,
          file: 'package.json', line: 0, snippet: `${hook}: ${String(v).slice(0, 120)}`,
          why: '生命周期脚本会在「安装时」自动执行——这是绕过人工审核最直接的路径。审核只看得到源码，看不到它装的时候做了什么。',
        });
      }
    }
    // 声明的入口是否真实存在
    for (const [key, val] of [['main', pkg.main], ['client', pkg.dsh?.client], ['exports..client', pkg.exports?.['./client']]]) {
      if (!val || typeof val !== 'string') continue;
      const rel = val.replace(/^\.\//, '').split('/')[0] && val;
      if (!existsSync(join(srcDir, val.replace(/^\.\//, '')))) {
        warnings.push(`package.json 声明的 ${key} 指向的文件不存在：${val}`);
      }
    }
  }

  for (const f of files) {
    const ext = extname(f.name).toLowerCase();
    let st;
    try { st = statSync(f.full); } catch { continue; }
    totalBytes += st.size;

    // 符号链接
    if (f.symlink) {
      add({
        rule: 'SYMLINK', sev: 'blocker', label: '包含符号链接',
        file: f.rel, line: 0, snippet: '',
        why: '符号链接会让「包里的文件」指向包外，打包/安装时会指到别处去。',
      });
      continue;
    }

    // 二进制 / 可执行
    if (BINARY_EXT.has(ext)) {
      add({
        rule: 'BINARY', sev: 'blocker', label: `可执行 / 二进制文件 ${ext}`,
        file: f.rel, line: 0, snippet: `${st.size} 字节`,
        why: '二进制无法人工阅读，等于要求审核者无条件信任作者。纯 JS 插件不需要它。',
      });
      continue;
    }

    // 脚本文件
    if (SCRIPT_EXT.has(ext)) {
      add({
        rule: 'SCRIPT', sev: 'low', label: `包含脚本文件 ${ext}`,
        file: f.rel, line: 0, snippet: `${st.size} 字节`,
        why: '脚本不一定会被执行，但审核者必须读一遍，确认它不会被自动触发。',
      });
    }

    if (st.size > 2 * 1024 * 1024) {
      add({
        rule: 'BIGFILE', sev: 'medium', label: '单文件超过 2 MB',
        file: f.rel, line: 0, snippet: `${Math.round(st.size / 1024)} KB`,
        why: '体积异常通常意味着塞了资源或混淆代码，人工不可能读完。',
      });
    }

    if (!SCAN_EXT.has(ext)) continue;

    let text;
    try { text = readFileSync(f.full, 'utf8'); } catch { continue; }
    scannedFiles++;
    const lines = text.split(/\r?\n/);

    // 过长行 / base64 块（混淆迹象）
    lines.forEach((ln, i) => {
      if (ln.length > 1500) {
        add({
          rule: 'OBF-LONG', sev: 'low', label: '存在超长单行（可能已压缩/混淆）',
          file: f.rel, line: i + 1, snippet: truncateLine(ln, 100),
          why: '若这是构建产物可忽略；若源码就是一行，说明作者不想让人读。',
        });
      }
      // base64：不能只看长度。短 blob 才是常见的藏代码手法，
      // 长 blob 反而经常是合法的内嵌图片（data URI）。
      // 正确判据是「解出来的东西像不像代码」。
      const b64m = ln.match(/[A-Za-z0-9+/]{40,}={0,2}/);
      if (b64m) {
        let decoded = '';
        try { decoded = Buffer.from(b64m[0], 'base64').toString('utf8'); } catch {}
        const printable = decoded.length ? (decoded.match(/[\t\n\r\x20-\x7e\u4e00-\u9fa5]/g) || []).length / decoded.length : 0;
        const looksLikeCode = /\b(require|import|function|eval|exec|writeFile|readFile|process\.|https?:\/\/|=>|\bvar\b|\bconst\b|\blet\b)/.test(decoded);
        if (decoded.length >= 12 && printable > 0.85 && looksLikeCode) {
          add({
            rule: 'OBF-B64-CODE', sev: 'blocker', label: 'base64 里藏着代码',
            file: f.rel, line: i + 1,
            snippet: `原文 ${b64m[0].slice(0, 40)}…  解出：${truncateLine(decoded, 120)}`,
            why: '把代码 base64 之后再 eval 是最典型的「不想让人读」手法。解出来的内容就是它真正要做的事。',
          });
        } else if (b64m[0].length >= 1000) {
          add({
            rule: 'OBF-B64', sev: 'low', label: '大段 base64 数据（可能是内嵌图片）',
            file: f.rel, line: i + 1, snippet: truncateLine(b64m[0], 80),
            why: '常见于 data URI 内嵌图片，但也可能是藏起来的数据。看一眼体积是否与功能相称。',
          });
        }
      }
    });

    // 行级规则
    for (const rule of LINE_RULES) {
      let count = 0;
      lines.forEach((ln, i) => {
        if (!rule.re.test(ln)) return;
        count++;
        if (count <= 5) {
          add({
            rule: rule.id, sev: rule.sev, label: rule.label,
            file: f.rel, line: i + 1, snippet: truncateLine(ln),
            why: rule.why,
          });
        }
      });
      if (count > 5) {
        add({
          rule: rule.id, sev: rule.sev, label: `${rule.label}（另有 ${count - 5} 处）`,
          file: f.rel, line: 999999, snippet: '', why: rule.why,
        });
      }
    }

    // 抽取外联域名
    const urlRe = /https?:\/\/([a-zA-Z0-9._-]+)/g;
    let m;
    while ((m = urlRe.exec(text)) !== null) {
      const host = m[1].toLowerCase();
      if (hosts.has(host)) continue;
      hosts.add(host);
      const line = text.slice(0, m.index).split(/\r?\n/).length;
      hostHits.push({ host, file: f.rel, line });
    }
  }

  // ── 相称性：未声明的能力 ──────────────────────────────────
  const undeclared = [];

  for (const h of hostHits) {
    if (BENIGN_HOSTS.has(h.host)) continue;
    if (declaredHosts.has(h.host)) continue;
    // 允许声明父域覆盖子域
    const covered = [...declaredHosts].some((d) => h.host === d || h.host.endsWith('.' + d));
    if (covered) continue;
    undeclared.push({ kind: 'network', detail: h.host, file: h.file, line: h.line });
  }

  const capIds = new Set(findings.map((f) => f.rule));
  const capMap = [
    ['exec', ['R01', 'R02', 'R03', 'R04']],
    ['network', ['R05', 'R05B']],
    ['secrets', ['R06']],
    ['env', ['R07']],
    ['fs-write', ['R08']],
    ['dynamic-load', ['R09']],
  ];
  const capabilities = {};
  for (const [name, rules] of capMap) {
    if (rules.some((r) => capIds.has(r))) capabilities[name] = true;
  }

  const declaredNames = new Set(declaredCaps.map((c) => c.split(':')[0]));
  for (const name of Object.keys(capabilities)) {
    if (!declaredNames.has(name)) {
      undeclared.push({ kind: 'capability', detail: name, file: 'package.json', line: 0 });
    }
  }

  for (const u of undeclared) {
    // 分两种情况，严重度完全不同：
    //   A. 作者压根没用声明机制 → 只是「未提供信息」，提示级（不能因为一个新约定罚所有人）
    //   B. 作者用了声明机制（哪怕声明的是空数组）却漏了这项 → 「言行不一」，高危
    //      空数组意味着「我不需要任何能力」，是最强的承诺 —— 违背它比漏报更严重。
    const partial = capsProvided;
    const declaredPart = partial
      ? (declaredCaps.length
        ? `作者已声明 [${declaredCaps.join(', ')}]，但没有声明这一项。`
        : '作者声明了「不需要任何额外能力」（dsh.capabilities 为空数组），却出现了这一项。')
      : '作者未提供 dsh.capabilities，无法核对声明。';
    add({
      rule: 'UNDECLARED',
      sev: !partial ? 'info' : (u.kind === 'network' ? 'high' : 'medium'),
      label: u.kind === 'network'
        ? `未声明的外联域名：${u.detail}`
        : `未声明的能力：${u.detail}`,
      file: u.file, line: u.line, snippet: '',
      why: `${declaredPart} 能力与声明是否一致，是判断「相称性」最客观的抓手。`,
    });
  }

  // ── 打分 ──────────────────────────────────────────────────
  let score = 100;
  for (const f of findings) score -= SEV_PENALTY[f.sev] ?? 0;
  score = Math.max(0, Math.min(100, score));

  const blockers = findings.filter((f) => f.sev === 'blocker');
  const highs = findings.filter((f) => f.sev === 'high');

  let level, verdict;
  if (blockers.length) {
    level = 'reject';
    verdict = `存在 ${blockers.length} 条阻断项，建议拒绝`;
  } else if (score < 60 || highs.length >= 3) {
    level = 'manual';
    verdict = '机械检查通过但风险偏高，必须逐条人工确认';
  } else if (highs.length) {
    level = 'manual';
    verdict = `有 ${highs.length} 项高危能力需要人工确认相称性`;
  } else {
    level = 'clean';
    verdict = '机械检查未发现高风险行为（仍不构成安全保证）';
  }

  findings.sort((a, b) => (SEV_ORDER[a.sev] - SEV_ORDER[b.sev]) || a.file.localeCompare(b.file) || (a.line - b.line));

  return {
    ok: blockers.length === 0,
    score, level, verdict,
    findings,
    capabilities,
    declared: { raw: declaredCaps, hosts: [...declaredHosts], provided: capsProvided },
    undeclared,
    files: files.map((f) => f.rel),
    errors, warnings,
    stats: {
      fileCount: files.length,
      scannedFiles,
      totalBytes,
      hosts: [...hosts],
      blockerCount: blockers.length,
      highCount: highs.length,
      mediumCount: findings.filter((f) => f.sev === 'medium').length,
      lowCount: findings.filter((f) => f.sev === 'low').length,
      infoCount: findings.filter((f) => f.sev === 'info').length,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 文本报告
// ─────────────────────────────────────────────────────────────

export function formatReport(r, srcDir = '') {
  const L = [];
  const line = (s = '') => L.push(s);

  line(`插件风险扫描报告${srcDir ? `  —  ${srcDir}` : ''}`);
  line('='.repeat(72));
  line(`结论：${r.verdict}`);
  line(`风险分：${r.score}/100    等级：${r.level}`);
  line(`文件：${r.stats.fileCount} 个（扫描 ${r.stats.scannedFiles} 个文本文件，共 ${Math.round((r.stats.totalBytes || 0) / 1024)} KB）`);
  line('');

  const byCap = Object.keys(r.capabilities);
  line(`检测到的能力：${byCap.length ? byCap.join('、') : '无（纯展示型）'}`);
  if (r.declared.raw.length) line(`作者已声明：${r.declared.raw.join('、')}`);
  else if (r.declared.provided) line(`作者已声明：（空数组 —— 明确表示不需要任何额外能力）`);
  else line(`作者已声明：无（package.json 未提供 dsh.capabilities）`);
  if (r.stats.hosts?.length) line(`出现的外联域名：${r.stats.hosts.join('、')}`);
  line('');

  const counts = [
    ['blocker', r.stats.blockerCount], ['high', r.stats.highCount],
    ['medium', r.stats.mediumCount], ['low', r.stats.lowCount], ['info', r.stats.infoCount],
  ].filter(([, n]) => n > 0);

  if (!r.findings.length) {
    line('未发现任何可疑项。');
  } else {
    line(`发现 ${r.findings.length} 项，按严重度排列：`);
    line('');
    let lastSev = null;
    for (const f of r.findings) {
      if (f.sev !== lastSev) {
        line(`── ${SEV_LABEL[f.sev]}（${f.sev}）${'─'.repeat(Math.max(0, 50 - SEV_LABEL[f.sev].length * 2))}`);
        lastSev = f.sev;
      }
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      line(`  [${f.rule}] ${f.label}`);
      line(`      位置：${loc}`);
      if (f.snippet) line(`      原文：${f.snippet}`);
      line(`      理由：${f.why}`);
      line('');
    }
  }

  if (r.errors.length) {
    line('错误：');
    for (const e of r.errors) line(`  - ${e}`);
    line('');
  }
  if (r.warnings.length) {
    line('提示：');
    for (const w of r.warnings) line(`  - ${w}`);
    line('');
  }

  line('─'.repeat(72));
  line('注意：本扫描只做静态阅读，「未发现问题」不等于「安全」。');
  line('放行与否必须由人决定——尤其是上架意味着别人会把任意代码装进自己机器。');

  return L.join('\n');
}

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    console.log('用法: node audit.mjs <插件目录> [--json] [--out 报告文件] [--quiet]');
    process.exit(argv.length ? 0 : 1);
  }
  const srcDir = argv[0];
  const asJson = argv.includes('--json');
  const quiet = argv.includes('--quiet');
  const outIdx = argv.indexOf('--out');
  const outFile = outIdx >= 0 ? argv[outIdx + 1] : null;

  const r = auditPlugin(srcDir);

  if (asJson) {
    const json = JSON.stringify(r, null, 2);
    if (outFile) writeFileSync(outFile, json, 'utf8');
    else console.log(json);
  } else {
    const text = formatReport(r, srcDir);
    if (outFile) writeFileSync(outFile, text, 'utf8');
    else console.log(text);
  }

  if (quiet) {
    console.log(`AUDIT ${r.level} score=${r.score} blocker=${r.stats.blockerCount ?? 0} high=${r.stats.highCount ?? 0}`);
  }
  process.exit(r.ok ? 0 : 2);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` ||
  (process.argv[1] || '').replace(/\\/g, '/').endsWith('/audit.mjs');
if (isMain) main();
