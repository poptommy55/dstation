/**
 * dsh-wallpaper —— 宿主半（Node 侧）
 *
 * 职责边界（重要）：
 *   宿主只管「壁纸文件存哪、配置存哪、首屏怎么不闪」，**不做任何界面**。
 *   界面全部在浏览器半（client.js），走 DSH 官方的 settings.general.item 槽位。
 *
 * 三条设计决策，都有原因：
 *
 * ① **上传，而不是让用户填绝对路径。**
 *   DSH 的沙箱把可读范围限制在白名单根（工作区）之内，用户桌面上的壁纸
 *   大概率在范围之外、会被拒绝。所以本插件让图片字节经宿主校验后存进
 *   插件自己的数据目录，**文件名由宿主生成**。
 *   ⇒ 用户提供的任何路径都不会到达文件系统，天然没有路径穿越面。
 *
 * ② **首屏由宿主注入，而不是等客户端加载完再改。**
 *   经 webserver/index-inject 往 <head> 塞一段 <style>，页面第一帧就是带壁纸的，
 *   不会出现「先黑一下再变」。DSH 自己的主题包就是这么做的（bootThemeInjection）。
 *   客户端加载后再把自己那份 CSS 写进同一个 <style>，接管实时更新。
 *
 * ③ **颜色令牌按「原色 + 半透明」合成，不硬编码色值。**
 *   形如 color-mix(in srgb, var(--dsw-static-neutral-bluish-950) 55%, transparent)，
 *   引用的是官方调色板变量本身 ⇒ 官方换配色时本插件自动跟着对。
 *   （color-mix 在 DSH 自己的 CSS 里已在用，兼容性没问题。）
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
  statSync,
  createReadStream
} from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

export const name = 'dsh-wallpaper';
export const inject = ['webServer'];

/** 构建标识。改代码必须 +1，同时改 client.js 的同名常量。 */
const BUILD = 'v9-20260914-1.0.1';

/** 路由前缀。宿主自定义路由没有 cookie 鉴权，所以全部校验都在这里自己做。 */
const PREFIX = '/dsh-wallpaper';

/** 注入进 <head> 的 style 元素 id（客户端加载后会复用同一个元素，避免两份样式打架）。 */
const BOOT_STYLE_ID = 'dsh-wallpaper-boot';

/**
 * 宿主注入的浏览器侧探针。
 *
 * 为什么放在宿主注入里、而不是放在 client.js 里：
 *   client.js 有可能压根没加载（模块图问题 / apply 抛异常），
 *   那样它就什么都测不到了 —— 而"到底加载没有"恰恰是最需要知道的一件事。
 *   这段不依赖任何插件模块，页面一加载就把浏览器的**真实读数**（计算后的
 *   自定义属性值、谁声明了这些令牌、内联样式、客户端模块跑没跑）报回宿主，
 *   我就能用 GET /dsh-wallpaper/status 直接读到，不必开 DevTools。
 *
 * 注意：文本里绝不能出现 `</script`（会提前闭合元素）。
 */
const PROBE_SCRIPT = `(function(){
  function probe(tag){
    var out = { source: 'probe', phase: tag, tokens: {}, decls: [], sheets: 0 };
    try {
      var b = getComputedStyle(document.body);
      ['--dsw-alias-bg-base','--dsw-alias-bg-layer-1','--dsw-alias-bg-layer-2','--dsw-specific-sidebar-fill','--dsw-specific-bubble']
        .forEach(function(k){ out.tokens[k] = String(b.getPropertyValue(k)).trim().slice(0,80); });
    } catch(e){ out.tokensError = String(e); }
    try {
      out.bodyInline = String(document.body.getAttribute('style') || '').slice(0, 400);
      out.htmlInline = String(document.documentElement.getAttribute('style') || '').slice(0, 200);
    } catch(e){}
    try {
      out.sheets = document.styleSheets.length;
      for (var i=0;i<document.styleSheets.length;i++){
        var ss = document.styleSheets[i], rules;
        try { rules = ss.cssRules; } catch(e){ continue; }
        if (!rules) continue;
        for (var j=0;j<rules.length && out.decls.length<40;j++){
          var r = rules[j];
          if (!r.style || !r.style.getPropertyValue) continue;
          var v1 = r.style.getPropertyValue('--dsw-specific-sidebar-fill');
          var v2 = r.style.getPropertyValue('--dsw-alias-bg-base');
          if (v1 || v2) out.decls.push({ sel: String(r.selectorText||'').slice(0,70), sidebar: String(v1||'').slice(0,60), base: String(v2||'').slice(0,60) });
        }
      }
    } catch(e){ out.declsError = String(e); }
    try {
      var root = document.getElementById('root');
      var f = root && root.firstElementChild;
      if (f) { out.frameCls = String(f.className).slice(0,60); out.frameBg = getComputedStyle(f).backgroundColor; }
      var col = document.querySelector('[class*="sidebarCol"]');
      if (col) out.sidebarBg = getComputedStyle(col).backgroundColor;
      var tagEl = document.getElementById('dsh-wallpaper-boot');
      out.styleTag = tagEl ? 'present' : 'MISSING';
      out.styleTagChars = tagEl ? String(tagEl.textContent||'').length : 0;
    } catch(e){ out.domError = String(e); }
    try {
      var d = document.documentElement.dataset;
      out.clientPhase = d.dshWallpaperPhase || 'none';
      out.clientBuild = d.dshWallpaperBuild || 'none';
      out.clientCssChars = d.dshWallpaperCss || 'none';
    } catch(e){}
    try { fetch('/dsh-wallpaper/report', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(out) }); } catch(e){}
  }
  function go(){ probe('probe:load'); setTimeout(function(){ probe('probe:settled'); }, 2500); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
  else go();
})();`;

/** 上传体积上限。壁纸不需要更大，也避免一次性读爆内存。 */
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;
/** 配置体上限。 */
const MAX_CONFIG_BYTES = 64 * 1024;

/** 只按魔数认图片，不信任扩展名、不信任 Content-Type。 */
const IMAGE_TYPES = [
  { ext: 'png', mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { ext: 'jpg', mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { ext: 'gif', mime: 'image/gif', magic: [0x47, 0x49, 0x46, 0x38] },
  { ext: 'bmp', mime: 'image/bmp', magic: [0x42, 0x4d] },
  { ext: 'webp', mime: 'image/webp', magic: [0x52, 0x49, 0x46, 0x46], offset4: [0x57, 0x45, 0x42, 0x50] }
];

/** 已存壁纸的文件名形状：内容哈希 + 扩展名。任何其它形状一律拒绝。 */
const FILE_NAME_RE = /^[0-9a-f]{40}\.(png|jpg|gif|bmp|webp)$/;

/* ════════════════════════════════════════════════════════════════════
 * 配色令牌：官方调色板引用（浅色 / 深色两套）
 *
 * 这些映射是从 @deepseek-ai/dsh-client-ui-theme 的实际样式表里读出来的，
 * 不是猜的。浅色在 body{}，深色在 body[data-ds-dark-theme]{}。
 *
 * ⚠️ 每个 var() 都必须带十六进制兜底值，这不是可选的：
 *    color-mix(in srgb, var(--dsw-static-xxx) 35%, transparent)
 *    里的 var() 一旦解析失败（官方改了令牌名），整条声明会变成
 *    **invalid at computed-value time** ⇒ 自定义属性退化成
 *    "guaranteed-invalid" ⇒ 用它的 background 回落到 initial = **全透明**。
 *    也就是说面板会直接消失，而不是"退回官方样式"。
 *    写成 var(--dsw-static-xxx, #151517) 之后，最坏情况只是颜色略有偏差，
 *    界面始终可读。兜底值取的是 0.1.2-rc.1 的实际色值。
 * ════════════════════════════════════════════════════════════════════ */

const TOKENS = {
  light: {
    '--dsw-alias-bg-base': 'var(--dsw-static-neutral-bluish-00, #fff)',
    '--dsw-alias-bg-layer-1': 'var(--dsw-static-neutral-bluish-00, #fff)',
    '--dsw-alias-bg-layer-2': 'var(--dsw-static-neutral-bluish-00, #fff)',
    '--dsw-alias-bg-layer-3': 'var(--dsw-static-neutral-bluish-00, #fff)',
    '--dsw-alias-bg-module-platform': 'var(--dsw-static-neutral-bluish-60, #f5f6f7)',
    '--dsw-alias-bg-overlay': 'var(--dsw-static-neutral-bluish-150, #e9ecf2)',
    '--dsw-specific-sidebar-fill': 'var(--dsw-static-neutral-bluish-50, #f9fafb)',
    '--dsw-specific-input-major': 'var(--dsw-static-neutral-bluish-00, #fff)',
    '--dsw-specific-selector': 'var(--dsw-static-neutral-bluish-60, #f5f6f7)',
    '--dsw-specific-menu': 'var(--dsw-static-neutral-bluish-00, #fff)',
    '--dsw-specific-tip': 'var(--dsw-static-neutral-bluish-60, #f5f6f7)',
    '--dsw-specific-bubble': 'var(--dsw-static-deepseek-50, #edf3fe)'
  },
  dark: {
    '--dsw-alias-bg-base': 'var(--dsw-static-neutral-bluish-950, #151517)',
    '--dsw-alias-bg-layer-1': 'var(--dsw-static-neutral-bluish-875, #232324)',
    '--dsw-alias-bg-layer-2': 'var(--dsw-static-neutral-bluish-850, #2c2c2e)',
    '--dsw-alias-bg-layer-3': 'var(--dsw-static-neutral-bluish-800, #353638)',
    '--dsw-alias-bg-module-platform': 'var(--dsw-static-neutral-bluish-800, #353638)',
    '--dsw-alias-bg-overlay': 'var(--dsw-static-neutral-bluish-700, #61666b)',
    '--dsw-specific-sidebar-fill': 'var(--dsw-static-neutral-bluish-900, #1b1b1c)',
    '--dsw-specific-input-major': 'var(--dsw-static-neutral-bluish-850, #2c2c2e)',
    '--dsw-specific-selector': 'var(--dsw-static-neutral-bluish-800, #353638)',
    '--dsw-specific-menu': 'var(--dsw-static-neutral-bluish-800, #353638)',
    '--dsw-specific-tip': 'var(--dsw-static-neutral-bluish-800, #353638)',
    '--dsw-specific-bubble': 'var(--dsw-static-neutral-bluish-850, #2c2c2e)'
  }
};

/**
 * 面板不透明度滑杆 → 每个令牌的实际透明度。
 *
 * 为什么不是一个值走天下：主窗口面积最大，可以让它最透（壁纸看得见）；
 * 而弹窗/输入框/气泡这些是要读文字的地方，必须更实一些，否则看不清。
 * 滑杆拉满时全部收敛到 100%（= 完全关闭通透效果）。
 *
 * 偏移量是实测调出来的，不是拍脑袋定的：
 *   第一批偏移写的 +12/+22/+26，滑杆 60 时侧栏实际是 **72% 不透明**，
 *   叠在深色照片上肉眼几乎看不出差别，用户当场判为"侧栏还是实的、没生效"。
 *   整体压到 +10/+18/+22、默认滑杆值降到 38 之后，侧栏 48%、卡片 48~60%，
 *   效果才明确可辨。
 *   ⇒ 教训：半透明"能不能看出来"要用**计算后的实际 alpha** 验收，
 *     不能只看滑杆数字。探针读回来的 sidebarBg 才是判据。
 *
 * @param {number} panel - 0..100，用户滑杆值
 * @returns {Record<string, number>} 令牌名 → 透明度百分比
 */
function alphaMap(panel) {
  const p = Math.max(0, Math.min(100, Number(panel))) / 100;
  const clamp = (v) => Math.max(0, Math.min(1, v)) * 100;
  return {
    '--dsw-alias-bg-base': clamp(p),
    '--dsw-specific-sidebar-fill': clamp(p + 0.1),
    '--dsw-alias-bg-layer-1': clamp(p + 0.1),
    '--dsw-alias-bg-layer-2': clamp(p + 0.18),
    '--dsw-alias-bg-layer-3': clamp(p + 0.22),
    '--dsw-alias-bg-module-platform': clamp(p + 0.18),
    '--dsw-alias-bg-overlay': clamp(p + 0.22),
    '--dsw-specific-input-major': clamp(p + 0.22),
    '--dsw-specific-selector': clamp(p + 0.22),
    '--dsw-specific-menu': clamp(p + 0.22),
    '--dsw-specific-tip': clamp(p + 0.22),
    '--dsw-specific-bubble': clamp(p + 0.25)
  };
}

/* ════════════════════════════════════════════════════════════════════
 * 配置：默认值、白名单、归一化
 * ════════════════════════════════════════════════════════════════════ */

const MODES = ['none', 'solid', 'gradient', 'image'];
const FITS = ['cover', 'contain', 'tile'];
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const DEFAULTS = {
  mode: 'none',
  color: '#1b1b1c',
  gradientFrom: '#2b1055',
  gradientTo: '#7597de',
  gradientAngle: 160,
  image: null,
  imageFit: 'cover',
  blur: 0,
  dim: 28,
  panelOpacity: 38
};

/** 字段定义：schema、界面渲染、写入校验**共用这一份**（单一来源，加字段只改这里）。 */
const FIELDS = [
  { key: 'mode', type: 'enum', values: MODES, label: '背景类型' },
  { key: 'color', type: 'color', label: '纯色' },
  { key: 'gradientFrom', type: 'color', label: '渐变起色' },
  { key: 'gradientTo', type: 'color', label: '渐变止色' },
  { key: 'gradientAngle', type: 'int', min: 0, max: 360, label: '渐变角度' },
  { key: 'image', type: 'stringOrNull', label: '图片文件名' },
  { key: 'imageFit', type: 'enum', values: FITS, label: '图片填充方式' },
  { key: 'blur', type: 'int', min: 0, max: 60, label: '背景模糊' },
  { key: 'dim', type: 'int', min: 0, max: 90, label: '背景压暗' },
  { key: 'panelOpacity', type: 'int', min: 0, max: 100, label: '面板不透明度' }
];

/**
 * 按字段定义归一化一份外部输入。
 * 未知字段直接拒绝（不静默忽略）——静默忽略会让"改了没生效"极难排查。
 *
 * @param {unknown} input - 待归一化的对象
 * @param {object} base - 缺省时回退的基准值
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
function normalizeConfig(input, base) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'config must be a plain object' };
  }
  const known = new Set(FIELDS.map((f) => f.key));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) return { ok: false, error: `unknown field: ${key}` };
  }
  const out = { ...base };
  for (const field of FIELDS) {
    if (!(field.key in input)) continue;
    const raw = input[field.key];
    switch (field.type) {
      case 'enum':
        if (typeof raw !== 'string' || !field.values.includes(raw)) {
          return { ok: false, error: `${field.key} must be one of ${field.values.join('|')}` };
        }
        out[field.key] = raw;
        break;
      case 'color':
        if (typeof raw !== 'string' || !HEX_RE.test(raw)) {
          return { ok: false, error: `${field.key} must be #rrggbb` };
        }
        out[field.key] = raw.toLowerCase();
        break;
      case 'int': {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < field.min || n > field.max) {
          return { ok: false, error: `${field.key} must be an integer in ${field.min}..${field.max}` };
        }
        out[field.key] = n;
        break;
      }
      case 'stringOrNull':
        if (raw === null) {
          out[field.key] = null;
          break;
        }
        if (typeof raw !== 'string' || !FILE_NAME_RE.test(raw)) {
          return { ok: false, error: `${field.key} must be null or a stored file name` };
        }
        out[field.key] = raw;
        break;
      default:
        return { ok: false, error: `unsupported field type: ${field.type}` };
    }
  }
  return { ok: true, value: out };
}

/* ════════════════════════════════════════════════════════════════════
 * 磁盘：目录、配置读写
 * ════════════════════════════════════════════════════════════════════ */

/** 插件数据目录：%DSH_HOME%\wallpapers\。用 DSH_HOME 推导，换部署不会失效。 */
function dataDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'wallpapers');
}

function filesDir() {
  return join(dataDir(), 'files');
}

function configPath() {
  return join(dataDir(), 'config.json');
}

function ensureDirs() {
  for (const d of [dataDir(), filesDir()]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

function loadConfig() {
  try {
    const raw = readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    const result = normalizeConfig(parsed, DEFAULTS);
    return result.ok ? result.value : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveConfig(cfg) {
  const path = configPath();
  const tmp = `${path}.tmp-${process.pid}`;
  /* 先写临时文件再 rename：避免进程中途死掉留下半截 JSON。 */
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

/* ════════════════════════════════════════════════════════════════════
 * 图片识别
 * ════════════════════════════════════════════════════════════════════ */

/**
 * 按魔数识别图片类型。
 * @param {Buffer} buf - 文件头
 * @returns {{ ext: string, mime: string } | null} 识别结果，未命中返回 null
 */
function detectImage(buf) {
  for (const t of IMAGE_TYPES) {
    if (buf.length < t.magic.length) continue;
    let hit = true;
    for (let i = 0; i < t.magic.length; i += 1) {
      if (buf[i] !== t.magic[i]) {
        hit = false;
        break;
      }
    }
    if (!hit) continue;
    if (t.offset4) {
      if (buf.length < 12) continue;
      let ok = true;
      for (let i = 0; i < 4; i += 1) {
        if (buf[8 + i] !== t.offset4[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
    }
    return { ext: t.ext, mime: t.mime };
  }
  return null;
}

/** 已存文件的权威 MIME（同样按魔数，不信扩展名）。 */
function mimeOfStored(fileName) {
  try {
    const head = readFileSync(join(filesDir(), fileName));
    const hit = detectImage(head.subarray(0, 16));
    return hit ? hit.mime : 'application/octet-stream';
  } catch {
    return 'application/octet-stream';
  }
}

/* ════════════════════════════════════════════════════════════════════
 * CSS 生成（宿主与客户端共用同一份实现：客户端直接取 /style.css）
 * ════════════════════════════════════════════════════════════════════ */

/** 夹掉任何可能提前闭合 <style> 的字符。 */
function safeCss(value) {
  return String(value).replace(/[<>]/g, '');
}

/**
 * 由配置生成完整的壁纸 CSS。
 * 返回空字符串代表「不生效」（mode: none）——此时不应注入任何东西。
 *
 * @param {object} cfg - 归一化后的配置
 * @returns {string} CSS 文本
 */
function buildCss(cfg) {
  if (cfg.mode === 'none') return '';

  const parts = [];

  /* ── 1) 壁纸层 ────────────────────────────────────────────────────
   * 画在 html::before 上（fixed + z-index:-1）：
   *   · z-index:-1 在根堆叠上下文里排在 canvas 背景之后、正常流块背景之前；
   *   · .AppFrame 是 position:relative（z-index auto），排在它在之上；
   *   · 于是「壁纸垫底 → 半透明的 AppFrame 覆在上面」这个层次是确定的。
   */
  let background;
  if (cfg.mode === 'solid') {
    background = `background-color:${safeCss(cfg.color)};`;
  } else if (cfg.mode === 'gradient') {
    background =
      `background-image:linear-gradient(${safeCss(cfg.gradientAngle)}deg,` +
      `${safeCss(cfg.gradientFrom)},${safeCss(cfg.gradientTo)});`;
  } else {
    background =
      `background-image:url("${PREFIX}/file/${safeCss(cfg.image)}");` +
      (cfg.imageFit === 'contain'
        ? 'background-size:contain;background-repeat:no-repeat;'
        : cfg.imageFit === 'tile'
          ? 'background-size:auto;background-repeat:repeat;'
          : 'background-size:cover;background-repeat:no-repeat;');
    background += 'background-position:center center;';
  }

  const blur = Number(cfg.blur) || 0;
  /* 高清屏上 blur 会在边缘露出发虚的透明边，放大一点点盖住。 */
  const scale = blur > 0 ? `transform:scale(${(1 + blur / 100).toFixed(3)});` : '';

  parts.push(
    'html::before{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;' +
      background +
      (blur > 0 ? `filter:blur(${blur}px);` : '') +
      scale +
      '}'
  );

  /* ── 2) 压暗层：让亮壁纸上的字仍然看得清 ───────────────────────── */
  const dim = Number(cfg.dim) || 0;
  if (dim > 0) {
    parts.push(
      'html::after{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;' +
        `background:rgb(0 0 0 / ${(dim / 100).toFixed(3)});}`
    );
  }

  /* ── 3) 令牌半透明化：两套配色各一份，成对给出 ───────────────────
   *
   * ⚠️ 选择器必须写成 `html body` 而不是 `body`。
   *    官方主题包声明的就是 `body{--dsw-alias-bg-base:…}`，
   *    同特异性下**由文档顺序决定胜负**；而官方那几张样式表是客户端插件
   *    在运行时 appendChild 进 <head> 的，位置一定晚于宿主首屏注入的这段。
   *    用后代选择器把特异性提到 (0,0,2) / (0,1,2)，就与顺序无关了。
   */
  const alphas = alphaMap(cfg.panelOpacity);
  for (const scheme of ['light', 'dark']) {
    const decls = [];
    for (const [token, base] of Object.entries(TOKENS[scheme])) {
      const pct = alphas[token];
      if (pct === undefined) continue;
      /* 100% 就不必写了，交回官方原值。 */
      if (pct >= 100) continue;
      decls.push(`${token}:color-mix(in srgb, ${base} ${pct.toFixed(1)}%, transparent)`);
    }
    if (decls.length === 0) continue;
    const selector = scheme === 'light' ? 'html body' : 'html body[data-ds-dark-theme]';
    parts.push(`${selector}{${decls.join(';')}}`);
  }

  const css = parts.join('\n');
  /* 兜底：注入进 <style> 的文本绝不能含能提前闭合元素的序列。 */
  if (/<\/style/i.test(css)) return '';
  return css;
}

/* ════════════════════════════════════════════════════════════════════
 * HTTP 小工具
 * ════════════════════════════════════════════════════════════════════ */

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-dsh-wallpaper-build': BUILD
  });
  res.end(text);
}

function sendText(res, status, text, type) {
  res.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-dsh-wallpaper-build': BUILD
  });
  res.end(text);
}

/** 读请求体并限长。超限直接抛，由调用方转成 413。 */
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

/* ════════════════════════════════════════════════════════════════════
 * 插件主体
 *
 * ⚠️ apply() 里任何一行抛异常 = 插件树挂掉 = 被看门狗禁用。
 *    所以入口的每一处外部访问都包了 try/catch。
 * ════════════════════════════════════════════════════════════════════ */

export function apply(ctx) {
  const dir = dataDir();
  try {
    ensureDirs();
  } catch {
    /* 目录建不出来时仍然注册路由，让 /status 能报告这个事实。 */
  }

  /**
   * 浏览器侧上报的运行时诊断（我看不见 DOM，让页面自己报回来）。
   *
   * ⚠️ 必须**按来源分开存**：宿主注入的探针和客户端模块都会上报，
   *    共用一个槽位的话后到的会把先到的整个冲掉 ——
   *    实测踩到了：客户端报完 phase:"saved" 之后，
   *    探针那份"侧栏计算背景色到底是多少"的读数整个消失了。
   *    一个会互相覆盖的诊断装置比没有诊断装置更糟。
   */
  const reports = { probe: null, client: null };

  const route = (path, handler) => ctx.webServer.register({ kind: 'exact', path, handler });

  const disposers = [];

  /* ── GET /dsh-wallpaper/health ─────────────────────────────────── */
  disposers.push(
    route(`${PREFIX}/health`, (req, res) => {
      sendJson(res, 200, { ok: true, build: BUILD, plugin: name });
    })
  );

  /* ── GET /dsh-wallpaper/status  （排障第一现场） ───────────────── */
  disposers.push(
    route(`${PREFIX}/status`, (req, res) => {
      sendJson(res, 200, {
        ok: true,
        build: BUILD,
        plugin: name,
        dataDir: dir,
        configPath: configPath(),
        config: loadConfig(),
        fields: FIELDS,
        defaults: DEFAULTS,
        stored: statSyncSafe(filesDir()),
        reports,
        /* 兼容字段：老的排障习惯是读 clientReport，指向最近一次客户端模块上报。 */
        clientReport: reports.client
      });
    })
  );

  /* ── GET / POST /dsh-wallpaper/config ──────────────────────────────
   * ⚠️ 读与写**必须是同一条路由注册**。
   *    WebServer.register 对重复的 (kind, path) 直接抛
   *    `webserver: duplicate exact route "…"`；而 apply() 里抛出会带崩
   *    整棵插件树，进而被看门狗写回 disabled: true（本次就是这么翻的车）。
   *    所以方法只能靠 req.method 分派，不能在同一个 path 上注册两次。
   */
  disposers.push(
    route(`${PREFIX}/config`, async (req, res) => {
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, build: BUILD, config: loadConfig(), fields: FIELDS });
        return;
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'GET or POST only', build: BUILD });
        return;
      }
      let raw;
      try {
        raw = await readBody(req, MAX_CONFIG_BYTES);
      } catch (err) {
        sendJson(res, err && err.code === 'TOO_LARGE' ? 413 : 400, {
          ok: false,
          error: 'cannot read body',
          build: BUILD
        });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        sendJson(res, 400, { ok: false, error: 'body is not JSON', build: BUILD });
        return;
      }
      const current = loadConfig();
      const result = normalizeConfig(parsed, current);
      if (!result.ok) {
        /* 非法值报错而不是静默取默认——"改了没生效"比报错难查十倍。 */
        sendJson(res, 400, { ok: false, error: result.error, build: BUILD });
        return;
      }
      try {
        saveConfig(result.value);
      } catch (err) {
        sendJson(res, 500, {
          ok: false,
          error: `cannot persist config: ${err && err.message ? err.message : 'unknown'}`,
          build: BUILD
        });
        return;
      }
      /* 写完立刻回读：这是唯一能证明"配置真的接通了"的做法。 */
      const readback = loadConfig();
      sendJson(res, 200, { ok: true, build: BUILD, config: readback, fields: FIELDS });
    })
  );

  /* ── GET /dsh-wallpaper/style.css  （客户端取同一份实现） ──────── */
  disposers.push(
    route(`${PREFIX}/style.css`, (req, res) => {
      sendText(res, 200, buildCss(loadConfig()), 'text/css; charset=utf-8');
    })
  );

  /* ── POST /dsh-wallpaper/upload ────────────────────────────────── */
  disposers.push(
    route(`${PREFIX}/upload`, async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'POST only', build: BUILD });
        return;
      }
      let buf;
      try {
        buf = await readBody(req, MAX_UPLOAD_BYTES);
      } catch (err) {
        sendJson(res, err && err.code === 'TOO_LARGE' ? 413 : 400, {
          ok: false,
          error:
            err && err.code === 'TOO_LARGE'
              ? `image larger than ${MAX_UPLOAD_BYTES} bytes`
              : 'cannot read body',
          build: BUILD
        });
        return;
      }
      if (buf.length === 0) {
        sendJson(res, 400, { ok: false, error: 'empty body', build: BUILD });
        return;
      }
      const hit = detectImage(buf);
      if (!hit) {
        sendJson(res, 415, {
          ok: false,
          error: 'not a supported image (png / jpg / webp / gif / bmp)',
          build: BUILD
        });
        return;
      }
      ensureDirs();
      /* 内容寻址：同样的图重复上传不会堆积，也天然免疫文件名注入。 */
      const hash = createHash('sha1').update(buf).digest('hex');
      const fileName = `${hash}.${hit.ext}`;
      const target = join(filesDir(), fileName);
      try {
        if (!existsSync(target)) writeFileSync(target, buf);
      } catch (err) {
        sendJson(res, 500, {
          ok: false,
          error: `cannot store image: ${err && err.message ? err.message : 'unknown'}`,
          build: BUILD
        });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        build: BUILD,
        name: fileName,
        bytes: buf.length,
        mime: hit.mime,
        url: `${PREFIX}/file/${fileName}`
      });
    })
  );

  /* ── GET /dsh-wallpaper/file/<name> ────────────────────────────── */
  disposers.push(
    ctx.webServer.register({
      kind: 'prefix',
      path: `${PREFIX}/file`,
      handler: (req, res) => {
        let fileName = '';
        try {
          const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
          fileName = decodeURIComponent(pathname.slice(`${PREFIX}/file/`.length));
        } catch {
          fileName = '';
        }
        /* 只认内容哈希形状的文件名 —— 也就是说，用户根本没有任何途径
           把任意路径喂进来（basename 只是双保险）。 */
        if (!FILE_NAME_RE.test(fileName) || basename(fileName) !== fileName) {
          sendJson(res, 400, { ok: false, error: 'bad file name', build: BUILD });
          return;
        }
        const path = join(filesDir(), fileName);
        if (!existsSync(path)) {
          sendJson(res, 404, { ok: false, error: 'no such wallpaper', build: BUILD });
          return;
        }
        const mime = mimeOfStored(fileName);
        res.writeHead(200, {
          'content-type': mime,
          'cache-control': 'public, max-age=31536000, immutable',
          'x-content-type-options': 'nosniff',
          'x-dsh-wallpaper-build': BUILD
        });
        createReadStream(path).pipe(res);
      }
    })
  );

  /* ── POST /dsh-wallpaper/report  （浏览器把状态报回来） ──────────── */
  disposers.push(
    route(`${PREFIX}/report`, async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      try {
        const raw = await readBody(req, MAX_CONFIG_BYTES);
        const parsed = JSON.parse(raw.toString('utf8'));
        /* 按 source 分槽，探针与客户端模块互不覆盖。 */
        const source = parsed && parsed.source === 'probe' ? 'probe' : 'client';
        reports[source] = { at: new Date().toISOString(), ...parsed };
      } catch {
        reports.client = { at: new Date().toISOString(), error: 'unparsable report' };
      }
      res.writeHead(204).end();
    })
  );

  /* ── 首屏注入：让页面第一帧就带壁纸 ───────────────────────────── */
  try {
    ctx.on('webserver/index-inject', (table) => {
      let css = '';
      try {
        css = buildCss(loadConfig());
      } catch {
        css = '';
      }
      if (!css) return;
      table.push({
        kind: 'html',
        placement: 'head',
        html: `<style id="${BOOT_STYLE_ID}" data-dsh-wallpaper="${BUILD}">${css}</style>`
      });
      /* 探针故意放在**宿主注入**里而不是客户端模块里：
         客户端模块可能压根没加载，那样就什么都测不到了。 */
      table.push({ kind: 'script', placement: 'body', text: PROBE_SCRIPT });
    });
  } catch {
    /* 拿不到注入点时静默降级：客户端仍会在加载后自行套用。 */
  }

  ctx.effect(
    () => () => {
      for (const d of disposers) {
        try {
          d();
        } catch {
          /* 卸载时的异常不该影响别的插件 */
        }
      }
    },
    'dsh-wallpaper: routes'
  );
}

/** 列出已存壁纸文件（只读目录，不递归）。 */
function statSyncSafe(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => FILE_NAME_RE.test(f))
      .map((f) => {
        let bytes = 0;
        try {
          bytes = statSync(join(dir, f)).size;
        } catch {
          bytes = 0;
        }
        return { name: f, bytes };
      });
  } catch {
    return [];
  }
}

export default { name, inject, apply };
