/**
 * dsh-composer-upload — browser half（v5 · 上传文件 + 已上传列表）
 *
 * 目标：给 DSH 的 composer 底栏一个「上传文件」按钮，把图片、Office 文档、PDF、
 * 纯文本文件送进对话。
 *
 * 为什么需要它（2026-09-12 实测结论，勿凭直觉推翻）：
 *   - DSH 自带 composer【没有】任何 input[type=file]。底栏那个「+」按钮的 class 是
 *     InputBar_module_css_default.add、图标 IconPlusOutline16、无障碍名 t("input.commands")
 *     —— 它是【指令菜单】的开关，不是上传（ui-conversation/lib/client.js:15617-15631）。
 *   - 图片原本只有两条入口：粘贴（Lexical paste 命令，:14773）与拖放
 *     （ui-attachment/lib/client.js:563 的 document 级 drop 监听）。
 *
 * 两条完全不同的投递路径：
 *   ① 图片 → 合成 drop 事件交回 DSH 自己的摄入通道（方案 A）。
 *      只声明 inject:['slots']，不碰任何 DSH 内部服务。命中 ui-attachment 的 document 级
 *      监听器 → onAddImages → composer.intakeImages()，从而完整复用 DSH 自己的校验
 *      （媒体类型/张数/单张体积/消息总体积）与草稿图片栏。
 *   ② 文档 → DSH 的附件通道【架构上只收光栅图片】（dsh-attachment README 原文：
 *      「只接受光栅格式（PNG、JPEG、WebP、GIF）……通用文件、音频和视频暂不支持」），
 *      所以文档必须走官方另一条机制：@路径 mention（dsh-file-reference —— 选中候选
 *      「只作为普通提示词文本插入」「绝不读取或附带文件内容；模型必须调用文件系统
 *      工具才能查看文件」）。该机制的前提是文件位于【会话工作目录】内，而浏览器侧
 *      没有任何写盘 API（session-controller 无 fs 路由），故由本机 Electron 外壳的
 *      文件桥（window.__DSTATION_FILES__）落盘 —— 安全边界在主进程 files.js 里强制。
 *
 *   文档做两件事：
 *     a. 本地抽文本 → 记入「已上传」列表，需要时可一键「插入全文」灌进输入框；
 *     b. 原件落盘到会话工作目录，输入框【只插入一条 @引用】——选谁取决于格式：
 *        · docx/xlsx/pptx/pdf（模型自己啃不动）→ 另存一份纯文本侧车 <原名>.txt，
 *          输入框插 @"<原名>.txt"。侧车头行已写明「原始文件是同目录的 <原名>」，
 *          模型一次 read 拿到全文，需要原件时自行取用。
 *        · csv/txt/md/json 等明文类（r.kind === 'text'）→ 不写侧车，直接插
 *          @"<原名>"，避免出现 xxx.csv.txt 这种怪名字。
 *        （v6 定稿，2026-09-12：原先「原件 + 侧车」双引用导致一次上传在输入框显两条，
 *        用户要求只留一条。）
 *        （2026-09-12 实测：只给 @原件 时，模型不认识 PDF/Office，会自己
 *        Glob/Pwsh/python 摸一遍，8 轮工具调用还撞上本机坏掉的微软商店 python
 *        存根 0xc0000142。有了侧车，这条弯路彻底消失。）
 *        例外：抽取结果为空或侧车写入失败 → 退回 @"<原件>" 单引用。
 *
 * UI（2026-09-12 定稿，改前先看这段）：
 *   - 底栏只有一个槽位 conversation.input.left：`上传文件` + （有附件时才渲染）
 *     `≡ 已上传 N`（同源 .dcu-btn 基类）。无附件时第二个按钮根本不渲染 → 零占位。
 *   - 点「已上传」→ 在按钮【上方】弹出纯 DOM 浮层（position:fixed + 视口坐标）；
 *     上方空间不足自动翻到下方。点外部 / Esc / 再点按钮 / 列表清空 → 自动关闭。
 *   - 【上传成功后不自动弹开列表】——用户 2026-09-12 明确否掉了这个打扰；
 *     成功反馈只靠「已上传 N」徽标跳数。别"顺手"加回来。
 *     只有 抽取有保留(r.note) / 引用插不进去(!refOk) / 落盘失败 才飘一次 flash。
 *
 * 抽取器全部为零依赖前端实现（与 dsh-knowledge-base 的 OOXML 抽取器同源思路）：
 *   - .docx/.xlsx/.pptx：zip + OOXML XML，用浏览器原生 DecompressionStream('deflate-raw')
 *   - .pdf：自写轻量解析（对象扫描 + FlateDecode + content stream + 按 Tf 查 ToUnicode CMap）
 *   - 其余：按字节嗅探，文本直读，二进制明确拒绝
 *
 * 兼容约束（沿用同目录其他插件的经验）：
 *   - 不依赖 require('react') 的 useEffect / class / useRef，只用 React.createElement + useState。
 *   - 忙态判断用槽位注入的 useInput 标准 prop（不是 require('react') 的 hook）。
 */

(function () {
  var HOST = 'dsh-composer-upload';
  var BUILD = 'v6-20260912-one-ref-plain-skip';
  var SLOT = 'conversation.input.left';
  var ENTRY_ID = 'composer-upload';
  var ReactRef = null;

  var ACCEPT = 'image/*,.docx,.xlsx,.pptx,.pdf,.txt,.md,.markdown,.csv,.tsv,.json,'
    + '.log,.xml,.html,.htm,.yml,.yaml,.ini,.conf,.sql,.js,.ts,.py';

  var EXT_OOXML = { docx: 1, xlsx: 1, pptx: 1 };
  var TEXTUAL = {
    txt: 1, text: 1, md: 1, markdown: 1, csv: 1, tsv: 1, json: 1, log: 1, xml: 1,
    html: 1, htm: 1, yml: 1, yaml: 1, ini: 1, conf: 1, cfg: 1, sql: 1, js: 1, mjs: 1,
    cjs: 1, ts: 1, tsx: 1, jsx: 1, py: 1, java: 1, c: 1, h: 1, cpp: 1, go: 1, rs: 1,
    sh: 1, bat: 1, ps1: 1, css: 1, scss: 1, srt: 1, vtt: 1
  };

  function log() {
    try { console.log.apply(console, ['[' + HOST + ']'].concat([].slice.call(arguments))); } catch (e) {}
  }
  function warn() {
    try { console.warn.apply(console, ['[' + HOST + ']'].concat([].slice.call(arguments))); } catch (e) {}
  }

  // ---------------------------------------------------------------- 样式
  // 沿用 DSH 的主题 token（--dsw-alias-*），自动跟随深浅色；不用硬编码颜色。
  var CSS = [
    '.dcu-btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px 0 8px;',
    'border:0;border-radius:999px;flex:none;white-space:nowrap;font-family:inherit;font-size:12px;line-height:1;',
    'background:var(--dsw-specific-selector,var(--dsw-alias-interactive-bg-hover));',
    'color:var(--dsw-alias-label-primary);cursor:pointer}',
    '.dcu-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
    '.dcu-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}',
    '.dcu-btn:disabled{opacity:.45;cursor:default}',
    '.dcu-btn>svg{display:block;flex:none;width:14px;height:14px}',
    '.dcu-spin{display:inline-block;width:10px;height:10px;border-radius:50%;flex:none;',
    'border:1.5px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-label-primary)}',
    '.dcu-flash{position:fixed;z-index:99999;max-width:320px;padding:6px 10px;border-radius:8px;pointer-events:none;',
    'background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);',
    'border:1px solid var(--dsw-alias-border-l2);font-size:12px;line-height:1.5;white-space:pre-wrap}',
    // 按钮组：与宿主的「+」「完全权限」同处一行，用 inline-flex 不留额外盒。
    '.dcu-bar{display:inline-flex;align-items:center;gap:6px;flex:none}',
    '.dcu-cnt{opacity:.62;font-variant-numeric:tabular-nums;font-size:11px}',
    // 「已上传」浮层：position:fixed + 视口坐标，向上展开，绝不被输入框下沿裁切。
    '.dcu-pop{position:fixed;z-index:99998;min-width:300px;max-width:min(560px,calc(100vw - 24px));',
    'padding:6px;border-radius:12px;background:var(--dsw-alias-bg-layer-3);',
    'border:1px solid var(--dsw-alias-border-l2);box-shadow:0 10px 30px rgba(0,0,0,.18);',
    'font-size:12px;line-height:1.4;color:var(--dsw-alias-label-primary)}',
    '.dcu-pop-head{display:flex;align-items:center;gap:6px;padding:3px 8px 6px;',
    'color:var(--dsw-alias-label-secondary);font-size:11px}',
    '.dcu-pop-n{font-variant-numeric:tabular-nums}',
    '.dcu-pop-list{display:flex;flex-direction:column;gap:2px;max-height:264px;overflow:auto}',
    '.dcu-pop-empty{padding:10px 8px;color:var(--dsw-alias-label-secondary)}',
    '.dcu-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:8px}',
    '.dcu-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
    '.dcu-row-ico{flex:none;display:flex;width:14px;height:14px;color:var(--dsw-alias-label-secondary)}',
    '.dcu-row-ico>svg{display:block;width:14px;height:14px}',
    '.dcu-row-name{flex:1 1 auto;min-width:0;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.dcu-row-meta{flex:none;color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums}',
    '.dcu-row-acts{flex:none;display:flex;align-items:center;gap:2px}',
    '.dcu-row-act,.dcu-row-x{height:22px;padding:0 8px;border:0;border-radius:999px;cursor:pointer;flex:none;',
    'font-family:inherit;font-size:11px;line-height:1;background:transparent;',
    'color:var(--dsw-alias-label-secondary);opacity:0;transition:opacity .12s ease}',
    '.dcu-row:hover .dcu-row-act,.dcu-row:hover .dcu-row-x,',
    '.dcu-row-act:focus-visible,.dcu-row-x:focus-visible{opacity:1}',
    '.dcu-row-act:hover,.dcu-row-x:hover{background:var(--dsw-alias-interactive-bg-active);',
    'color:var(--dsw-alias-label-primary)}',
    '.dcu-row-x{width:22px;padding:0;font-size:13px}'
  ].join('');

  function ensureCss() {
    try {
      if (typeof document === 'undefined') return;
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(HOST) + ']') !== null) return;
      var tag = document.createElement('style');
      tag.dataset.plugin = HOST;
      tag.dataset.pluginCss = HOST;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    } catch (e) { warn('注入样式失败', e && e.message); }
  }

  // ------------------------------------------------------- 轻量提示（避免依赖 DSH Toast）
  var flashTimer = null;

  function flash(anchor, text) {
    try {
      var prev = document.getElementById('dcu-flash');
      if (prev !== null) prev.remove();
      var el = document.createElement('div');
      el.id = 'dcu-flash';
      el.className = 'dcu-flash';
      el.setAttribute('role', 'status');
      el.textContent = text;
      document.body.appendChild(el);
      var r = anchor !== null && typeof anchor.getBoundingClientRect === 'function' ? anchor.getBoundingClientRect() : null;
      if (r !== null && r.width > 0) {
        el.style.left = Math.max(8, r.left) + 'px';
        el.style.top = Math.max(8, r.top - el.offsetHeight - 8) + 'px';
      } else {
        el.style.left = '50%';
        el.style.top = '96px';
      }
      if (flashTimer !== null) clearTimeout(flashTimer);
      flashTimer = setTimeout(function () {
        try { el.remove(); } catch (e) {}
      }, 3600);
    } catch (e) {}
  }

  // ============================================================ 压缩与解包
  async function inflate(bytes, mode) {
    var ds = new DecompressionStream(mode || 'deflate-raw');
    var w = ds.writable.getWriter();
    w.write(bytes);
    w.close();
    var r = ds.readable.getReader();
    var parts = [], x, len = 0;
    while (!(x = await r.read()).done) { parts.push(x.value); len += x.value.length; }
    var out = new Uint8Array(len), off = 0;
    for (var i = 0; i < parts.length; i++) { out.set(parts[i], off); off += parts[i].length; }
    return out;
  }
  async function inflateAny(bytes) {
    var errs = [];
    var modes = ['deflate', 'deflate-raw'];
    for (var i = 0; i < modes.length; i++) {
      try { return await inflate(bytes, modes[i]); }
      catch (e) { errs.push(modes[i] + ':' + (e && e.message)); }
    }
    throw new Error('解压失败（' + errs.join('; ') + '）');
  }
  function latin1(bytes) {
    var CH = 8192, out = [], i;
    for (i = 0; i < bytes.length; i += CH) {
      out.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length))));
    }
    return out.join('');
  }
  function utf8(bytes) {
    try { return new TextDecoder('utf-8', { fatal: false }).decode(bytes); }
    catch (e) { return latin1(bytes); }
  }

  // ---- zip（OOXML 三兄弟都是 zip+xml）----
  function findEOCD(buf) {
    for (var i = buf.length - 22; i >= 0; i--) {
      if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) return i;
    }
    return -1;
  }
  async function unzipEntries(bytes) {
    var eocd = findEOCD(bytes);
    if (eocd < 0) throw new Error('不是有效的 Office 文件（缺少 EOCD）');
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var cdOff = dv.getUint32(eocd + 16, true);
    var n = dv.getUint16(eocd + 10, true);
    var files = {}, p = cdOff;
    for (var i = 0; i < n; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      var method = dv.getUint16(p + 10, true);
      var csize = dv.getUint32(p + 20, true);
      var fnLen = dv.getUint16(p + 28, true);
      var exLen = dv.getUint16(p + 30, true);
      var cmLen = dv.getUint16(p + 32, true);
      var name = '';
      for (var j = 0; j < fnLen; j++) name += String.fromCharCode(bytes[p + 46 + j]);
      var localOff = dv.getUint32(p + 42, true);
      var lfnLen = dv.getUint16(localOff + 26, true);
      var lexLen = dv.getUint16(localOff + 28, true);
      var dataStart = localOff + 30 + lfnLen + lexLen;
      var comp = bytes.subarray(dataStart, dataStart + csize);
      if (method === 8) files[name] = await inflate(comp, 'deflate-raw');
      else if (method === 0) files[name] = comp;
      else warn('zip 条目不支持的压缩方式 ' + method + '：' + name);
      p += 46 + fnLen + exLen + cmLen;
    }
    return files;
  }
  function xmlText(bytes) {
    var s = utf8(bytes);
    return s
      .replace(/<w:tab[^>]*\/>/g, '\t')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<\/a:p>/g, '\n')
      .replace(/<\/row>/g, '\n')
      .replace(/<\/c>/g, '\t');
  }
  function decodeXml(s) {
    return s
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&#(\d+);/g, function (_m, d) { return String.fromCharCode(parseInt(d, 10)); })
      .replace(/&amp;/g, '&');
  }
  async function extractOoxml(bytes, ext) {
    var entries = await unzipEntries(bytes);
    var out = '';
    var keys = Object.keys(entries);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i], xml, m, re;
      if (ext === 'docx') {
        if (/^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/i.test(k)) {
          xml = xmlText(entries[k]);
          re = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
          var seg = '';
          while ((m = re.exec(xml)) !== null) seg += decodeXml(m[1]);
          if (seg.trim()) out += (out ? '\n' : '') + seg;
        }
      } else if (ext === 'xlsx') {
        if (/^xl\/sharedStrings\.xml$/i.test(k)) {
          xml = xmlText(entries[k]);
          re = /<si>([\s\S]*?)<\/si>/g;
          while ((m = re.exec(xml)) !== null) {
            var pieces = '', re2 = /<t[^>]*>([\s\S]*?)<\/t>/g, m2;
            while ((m2 = re2.exec(m[1])) !== null) pieces += decodeXml(m2[1]);
            out += pieces + '\n';
          }
        } else if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(k)) {
          xml = xmlText(entries[k]);
          re = /<t[^>]*>([\s\S]*?)<\/t>|<v>([\s\S]*?)<\/v>/g;
          var rows = '';
          while ((m = re.exec(xml)) !== null) rows += decodeXml(m[1] || m[2] || '');
          if (rows.trim()) out += rows + '\n';
        }
      } else if (ext === 'pptx') {
        if (/^ppt\/(slides|notesSlides)\/slide\d*\.xml$/i.test(k)) {
          xml = xmlText(entries[k]);
          re = /<a:t>([\s\S]*?)<\/a:t>/g;
          var sl = '';
          while ((m = re.exec(xml)) !== null) sl += decodeXml(m[1]);
          if (sl.trim()) out += (out ? '\n\n' : '') + sl;
        }
      }
    }
    return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // ============================================================ PDF 文本抽取
  // PDF 是字节格式：结构用 latin1 逐字节扫描，stream 单独取二进制再解压。
  // 抽取链路：扫对象 → 找 Page → 取 /Resources /Font → 每个字体的 /ToUnicode CMap
  //          → 解 /Contents 流 → 状态机抓 Tj/TJ → 按当前 Tf 字体查 CMap 解码。
  function pdfScanObjects(s) {
    var re = /(?:^|[^0-9])(\d{1,7})\s+(\d{1,5})\s+obj\b/g, m;
    var list = [];
    while ((m = re.exec(s)) !== null) {
      var num = parseInt(m[1], 10);
      var start = m.index + m[0].length;
      list.push({ num: num, start: start });
    }
    return list;
  }
  function pdfDictEnd(s, from) {
    var i = s.indexOf('stream', from);
    return i < 0 ? -1 : i;
  }
  function pdfObjectRange(s, obj) {
    var streamIdx = pdfDictEnd(s, obj.start);
    var endObj = s.indexOf('endobj', obj.start);
    if (endObj < 0) endObj = s.length;
    if (streamIdx < 0 || streamIdx > endObj) return { dict: s.slice(obj.start, endObj), streamAt: -1 };
    return { dict: s.slice(obj.start, streamIdx), streamAt: streamIdx };
  }
  function pdfStreamBytes(bytes, s, obj, dict) {
    var idx = pdfDictEnd(s, obj.start);
    if (idx < 0) return null;
    var real = idx;   // pdfDictEnd 返回的已是绝对偏移
    // 跳到 stream 关键字后的换行
    while (real < s.length && s[real] !== '\n' && s[real] !== '\r') real++;
    if (s[real] === '\r') real++;
    if (s[real] === '\n') real++;
    var len = null, m = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    if (m) len = parseInt(m[1], 10);
    var end;
    if (len !== null && len > 0 && real + len <= bytes.length) {
      // 用 /Length 后仍校验 endstream 是否在合理距离内
      end = real + len;
      var probe = s.indexOf('endstream', end);
      if (probe < 0 || probe - end > 8) end = -1;
    } else end = -1;
    if (end < 0) {
      end = s.indexOf('endstream', real);
      if (end < 0) return null;
      while (end > real && (s[end - 1] === '\n' || s[end - 1] === '\r')) end--;
    }
    return bytes.subarray(real, end);
  }
  function hexToStr(h) {
    var s = '';
    for (var i = 0; i < h.length; i += 4) {
      var part = h.substr(i, 4);
      if (part.length < 4) part = part + '0'.repeat(4 - part.length);
      s += String.fromCharCode(parseInt(part, 16));
    }
    return s;
  }
  function parseCMap(txt) {
    var map = {}, m;
    var width = 1;
    var cr = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(txt);
    if (cr) {
      var f = /<([0-9A-Fa-f]+)>/.exec(cr[1]);
      if (f) width = Math.max(1, Math.round(f[1].length / 2));
    }
    var reChar = /beginbfchar([\s\S]*?)endbfchar/g;
    while ((m = reChar.exec(txt)) !== null) {
      var re2 = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g, mm;
      while ((mm = re2.exec(m[1])) !== null) map[parseInt(mm[1], 16)] = hexToStr(mm[2]);
    }
    var reRange = /beginbfrange([\s\S]*?)endbfrange/g;
    while ((m = reRange.exec(txt)) !== null) {
      var re3 = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<([0-9A-Fa-f]*)>|\[([\s\S]*?)\])/g, m3;
      while ((m3 = re3.exec(m[1])) !== null) {
        var lo = parseInt(m3[1], 16), hi = parseInt(m3[2], 16), c;
        if (hi - lo > 65535) hi = lo + 65535;
        if (m3[4] !== undefined) {
          var dst = parseInt(m3[4] || '0', 16);
          for (c = lo; c <= hi; c++) map[c] = String.fromCharCode(dst + (c - lo));
        } else if (m3[5] !== undefined) {
          var arr = m3[5].match(/<([0-9A-Fa-f]*)>/g) || [];
          for (var i = 0; i < arr.length; i++) {
            c = lo + i;
            if (c > hi) break;
            map[c] = hexToStr(arr[i].slice(1, -1));
          }
        }
      }
    }
    return { map: map, width: width };
  }
  function readPdfLiteral(s, i) {
    // s[i] === '(' —— 返回 { bytes: Uint8Array-ish array of char codes, next }
    var depth = 0, out = [], j = i;
    if (s.charAt(j) === '(') j++;   // 跳过起始左括号（它不参与嵌套计数）
    for (; j < s.length; j++) {
      var c = s[j];
      if (c === '\\') {
        var nx = s[j + 1];
        if (nx === 'n') { out.push(10); j++; }
        else if (nx === 'r') { out.push(13); j++; }
        else if (nx === 't') { out.push(9); j++; }
        else if (nx === 'b') { out.push(8); j++; }
        else if (nx === 'f') { out.push(12); j++; }
        else if (nx === '(' || nx === ')' || nx === '\\') { out.push(nx.charCodeAt(0)); j++; }
        else if (nx >= '0' && nx <= '7') {
          var oct = '', k = j + 1;
          while (k < s.length && oct.length < 3 && s[k] >= '0' && s[k] <= '7') { oct += s[k]; k++; }
          out.push(parseInt(oct, 8) & 0xff);
          j = k - 1;
        } else if (nx === '\n') { j++; }
        else if (nx !== undefined) { out.push(nx.charCodeAt(0) & 0xff); j++; }
        continue;
      }
      if (c === '(') { depth++; out.push(40); continue; }
      if (c === ')') { if (depth === 0) break; depth--; out.push(41); continue; }
      out.push(c.charCodeAt(0) & 0xff);
    }
    return { codes: out, next: j + 1 };
  }
  function codesToBytes(codes) {
    var b = new Uint8Array(codes.length);
    for (var i = 0; i < codes.length; i++) b[i] = codes[i] & 0xff;
    return b;
  }
  function decodeByFont(bytes, font) {
    var out = '';
    var width = font && font.width >= 2 ? 2 : 1;
    var map = font && font.map;
    if (width === 2) {
      for (var i = 0; i + 1 < bytes.length; i += 2) {
        var code = (bytes[i] << 8) | bytes[i + 1];
        if (map && map[code] !== undefined) out += map[code];
        else if (!map) out += '';
      }
    } else {
      for (var j = 0; j < bytes.length; j++) {
        var c1 = bytes[j];
        if (map && map[c1] !== undefined) out += map[c1];
        else out += String.fromCharCode(c1);
      }
    }
    return out;
  }
  function hexToBytes(str) {
    var hex = String(str).replace(/[^0-9A-Fa-f]/g, '');
    var out = new Uint8Array(Math.ceil(hex.length / 2));
    for (var i = 0; i < out.length; i++) {
      var pair = hex.substr(i * 2, 2);
      out[i] = parseInt(pair.length === 1 ? pair + '0' : pair, 16) || 0;
    }
    return out;
  }
  function pdfContentText(content, fonts) {
    var out = [];
    var cur = null;
    // 七类 token：① /Fx n Tf ② <hex> Tj ③ (lit) Tj|T' ④ [..] TJ ⑤ (lit) " ⑥ BT/ET/T* ⑦ Td/TD/Tm
    // ② 必须单列：Identity-H（中文 CID 字体）的文本一律以十六进制串出现，
    // 只认字面量字符串会整篇抽不出内容（2026-09-12 实测踩过）。
    var re = /(\/[^\s\/\[\]<>()]+\s+[\d.]+\s+Tf)|(<[0-9A-Fa-f\s]*>\s*Tj)|(\((?:[^()\\]|\\[\s\S])*\)\s*T[j'])|(\[(?:[^\[\]\\]|\\[\s\S])*\]\s*TJ)|(\((?:[^()\\]|\\[\s\S])*\)\s*")|(BT|ET|T\*)|((?:[-\d.]+\s+){2,6}(?:Td|TD|Tm))/g;
    var m;
    while ((m = re.exec(content)) !== null) {
      var tok = m[0];
      if (m[1]) {
        var nm = /^\/([^\s\/\[\]<>()]+)/.exec(tok);
        if (nm) cur = fonts[nm[1]] || null;
        continue;
      }
      // 换行：BT 不换（文本块开头）；ET / T* / Td / TD / Tm / " 都换
      if (m[6]) { if (m[6] !== 'BT') out.push('\n'); continue; }
      if (m[7] || m[5]) out.push('\n');
      var body = tok.replace(/^\s+/, '');
      if (m[2] || body.charAt(0) === '<') {
        out.push(decodeByFont(hexToBytes(body), cur));
      } else if (body.charAt(0) === '(') {
        var lit = readPdfLiteral(content, m.index + tok.indexOf('('));
        out.push(decodeByFont(codesToBytes(lit.codes), cur));
      } else if (body.charAt(0) === '[') {
        var inner = body.replace(/\s*TJ\s*$/, '');
        var re2 = /\((?:[^()\\]|\\[\s\S])*\)|<[0-9A-Fa-f\s]*>|-?[\d.]+/g, m3;
        while ((m3 = re2.exec(inner)) !== null) {
          var t = m3[0];
          if (t.charAt(0) === '(') {
            var l2 = readPdfLiteral(inner, m3.index);
            out.push(decodeByFont(codesToBytes(l2.codes), cur));
          } else if (t.charAt(0) === '<') {
            out.push(decodeByFont(hexToBytes(t), cur));
          }
        }
      }
    }
    return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ');
  }
  async function extractPdf(bytes, onNote) {
    var s = latin1(bytes);
    var objs = pdfScanObjects(s);
    if (!objs.length) throw new Error('不是有效的 PDF（未找到任何对象）');
    var byNum = {};
    objs.forEach(function (o) { byNum[o.num] = o; });

    var inflight = {};
    async function streamOf(num) {
      if (inflight[num]) return inflight[num];
      inflight[num] = (async function () {
        var o = byNum[num];
        if (!o) return null;
        var r = pdfObjectRange(s, o);
        var raw = pdfStreamBytes(bytes, s, o, r.dict);
        if (!raw) return null;
        var filter = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(r.dict);
        var f = filter ? filter[1] : '';
        var isFlate = /FlateDecode|\/Fl\b/.test(f);
        var isNone = f === '';
        if (isFlate) {
          try { return await inflateAny(raw); }
          catch (e) { warn('PDF 流解压失败 obj=' + num + '：' + (e && e.message)); return null; }
        }
        if (isNone) return raw;
        warn('PDF 流过滤链暂不支持：' + f + '（obj=' + num + '）');
        return null;
      })();
      return inflight[num];
    }

    var fontCache = {};
    async function fontFor(num) {
      if (fontCache[num]) return fontCache[num];
      fontCache[num] = (async function () {
        var o = byNum[num];
        if (!o) return null;
        var r = pdfObjectRange(s, o);
        var mu = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(r.dict);
        if (!mu) return { map: null, width: 1 };
        var tb = await streamOf(parseInt(mu[1], 10));
        if (!tb) return { map: null, width: 1 };
        return parseCMap(utf8(tb));
      })();
      return fontCache[num];
    }

    var pageNums = [];
    objs.forEach(function (o) {
      var r = pdfObjectRange(s, o);
      if (/\/Type\s*\/Page[^s]/.test(r.dict)) pageNums.push(o.num);
    });
    if (!pageNums.length) throw new Error('PDF 里没有可抽取的页面');
    pageNums.sort(function (a, b) { return a - b; });

    var pages = [];
    for (var pi = 0; pi < pageNums.length; pi++) {
      var pn = pageNums[pi];
      var pd = pdfObjectRange(s, byNum[pn]);
      var fonts = {};
      var fm = /\/Font\s*<<([\s\S]*?)>>/.exec(pd.dict);
      if (fm) {
        var reF = /\/([^\s\/\[\]<>()]+)\s+(\d+)\s+\d+\s+R/g, mf;
        var pending = [];
        while ((mf = reF.exec(fm[1])) !== null) pending.push([mf[1], parseInt(mf[2], 10)]);
        for (var fi = 0; fi < pending.length; fi++) {
          var fobj = await fontFor(pending[fi][1]);
          if (fobj) fonts[pending[fi][0]] = fobj;
        }
      }
      var chunk = '';
      var cm = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(pd.dict);
      if (cm) {
        var cb = await streamOf(parseInt(cm[1], 10));
        if (cb) chunk = pdfContentText(latin1(cb), fonts);
      } else {
        var cArr = /\/Contents\s*\[([\s\S]*?)\]/.exec(pd.dict);
        if (cArr) {
          var reC = /(\d+)\s+\d+\s+R/g, mc;
          while ((mc = reC.exec(cArr[1])) !== null) {
            var cbn = await streamOf(parseInt(mc[1], 10));
            if (cbn) chunk += pdfContentText(latin1(cbn), fonts);
          }
        }
      }
      if (chunk.trim()) pages.push('--- 第 ' + (pi + 1) + ' 页 ---\n' + chunk.trim());
    }

    var text = pages.join('\n\n').trim();
    if (!text) {
      throw new Error('未抽到文本：该 PDF 可能是扫描版（图片），或使用了暂不支持的编码/过滤链');
    }
    // 乱码体检：替换字符或私有区占比过高时给出提示（多半是子集字体缺 ToUnicode）
    var bad = (text.match(/[\uFFFD\uE000-\uF8FF]/g) || []).length;
    if (bad > 0 && bad / text.length > 0.05 && typeof onNote === 'function') {
      onNote('该 PDF 的字体可能缺少 Unicode 映射，抽出的文本有乱码风险');
    }
    return text;
  }

  // ============================================================ 统一入口
  function extOf(name) {
    var m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }
  function looksBinary(bytes) {
    var n = Math.min(bytes.length, 4096);
    for (var i = 0; i < n; i++) if (bytes[i] === 0) return true;
    return false;
  }
  /**
   * 抽取文件文本。
   * @returns { text, kind, note } —— text 为空表示没抽到可读文本
   */
  async function extractText(file, bytes) {
    var ext = extOf(file.name);
    if (EXT_OOXML[ext]) {
      var t = await extractOoxml(bytes, ext);
      return { text: t, kind: ext, note: '' };
    }
    if (ext === 'pdf') {
      var note = '';
      var p = await extractPdf(bytes, function (n) { note = n; });
      return { text: p, kind: 'pdf', note: note };
    }
    if (TEXTUAL[ext]) {
      return { text: utf8(bytes), kind: 'text', note: '' };
    }
    if (looksBinary(bytes)) {
      throw new Error('.'
        + (ext || '未知') + ' 是二进制格式，暂不支持抽取（可支持的：Office 三件套 / PDF / 纯文本）');
    }
    return { text: utf8(bytes), kind: 'text', note: '' };
  }

  // ============================================================ 附件状态（模块级）
  // composer.dock 与 composer.input.left 是两个独立槽位，共享本模块的这份状态。
  var ATT = [];
  var ATT_SUBS = [];
  var ATT_SEQ = 0;
  // 浮层是纯 DOM（不进 React 树），拿不到 props，所以每次渲染按钮时把最新 props 存这里。
  var CUR_PROPS = null;

  function attList() { return ATT; }
  function attEmit() {
    for (var i = 0; i < ATT_SUBS.length; i++) { try { ATT_SUBS[i](); } catch (e) {} }
  }
  function attSub(fn) {
    ATT_SUBS.push(fn);
    return function () {
      var i = ATT_SUBS.indexOf(fn);
      if (i >= 0) ATT_SUBS.splice(i, 1);
    };
  }
  function attAdd(item) {
    item.id = 'att' + (++ATT_SEQ);
    ATT.push(item);
    attEmit();
    return item;
  }
  function attRemove(id) {
    for (var i = 0; i < ATT.length; i++) {
      if (ATT[i].id === id) { ATT.splice(i, 1); break; }
    }
    attEmit();
  }
  function attFind(id) {
    for (var i = 0; i < ATT.length; i++) if (ATT[i].id === id) return ATT[i];
    return null;
  }

  // ============================================================ 会话工作目录
  function sessionIdOf(props) {
    try { return (props && props.sessionId) || null; } catch (e) { return null; }
  }
  async function apiPost(method, payload) {
    var r = await fetch('/sidebar/api/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {})
    });
    var j = await r.json().catch(function () { return null; });
    if (!r.ok || !j || j.ok !== true) {
      throw new Error((j && j.error && j.error.message) || (method + ' HTTP ' + r.status));
    }
    return j.value;
  }
  var CWD_CACHE = {};
  async function resolveCwd(sessionId) {
    if (!sessionId) return '';
    if (CWD_CACHE[sessionId]) return CWD_CACHE[sessionId];
    try {
      var v = await apiPost('session.cwd', { sessionId: sessionId });
      var cwd = (v && v.cwd) || '';
      if (cwd) CWD_CACHE[sessionId] = cwd;
      return cwd;
    } catch (e) {
      warn('取会话工作目录失败：' + (e && e.message));
      return '';
    }
  }

  // ============================================================ 落盘 + 引用插入
  function fileBridge() {
    try { return (typeof window !== 'undefined' && window.__DSTATION_FILES__) || null; }
    catch (e) { return null; }
  }
  async function putFile(cwd, name, data) {
    var br = fileBridge();
    if (!br || typeof br.save !== 'function') return { ok: false, error: '当前外壳不含文件桥（旧安装包）' };
    if (!cwd) return { ok: false, error: '拿不到会话工作目录' };
    try {
      return await br.save({ dir: cwd, name: name, data: data });
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
  function saveToWorkspace(cwd, file, bytes) {
    return putFile(cwd, file.name, bytes);
  }
  /**
   * 文本侧车：把抽取出的纯文本写成 <原文件名>.txt，与原件同目录。
   * 目的是让模型用自带的 read 工具一次拿到全文，不必自己去解析 PDF/Office
   * —— 2026-09-12 实测：只给 @原件 时模型会 Glob → Pwsh → python 摸一遍，
   * 8 轮工具调用，还撞上本机坏掉的商店 python 存根（0xc0000142 弹窗）。
   * 头一行注明来源与「可直接阅读」，避免模型仍去啃源文件。
   */
  async function saveTextSidecar(cwd, srcName, text) {
    var body = '【本文本由 D-STATION 在本地从「' + srcName + '」解析得出，可直接阅读；'
      + '原始文件是同目录的 ' + srcName + '】\n\n' + text;
    return await putFile(cwd, srcName + '.txt', new TextEncoder().encode(body));
  }
  function refTextFor(rel) {
    return '@' + (/\s/.test(rel) ? '"' + rel + '"' : rel);
  }
  /**
   * 把若干 @引用 追加进输入框草稿（用槽位注入的 inputActions.setDraft）。
   * ⚠️ 必须一次性拼好再 setDraft：draft 是点击那一刻的快照，连续调两次会互相覆盖，
   *    导致先插的引用被后一次 setDraft 冲掉。
   * 去重用 indexOf —— 若同批要插 @a.pdf 与 @a.pdf.txt 这类「一个名字是另一个前缀」
   *   的组合，调用方必须按「短名在前、长名在后」传，否则长名会把短名当子串误判成已存在。
   *   正常路径（v6 起）只传一条，不存在该问题。
   */
  function insertReferences(props, draft, rels) {
    var actions = props && props.inputActions;
    if (!actions || typeof actions.setDraft !== 'function') return false;
    var next = String(draft == null ? '' : draft).replace(/\s+$/, '');
    var added = 0;
    for (var i = 0; i < rels.length; i++) {
      if (!rels[i]) continue;
      var ref = refTextFor(rels[i]);
      if (next.indexOf(ref) >= 0) continue;
      next = next ? (next + ' ' + ref) : ref;
      added++;
    }
    if (added) actions.setDraft(next);
    return true;
  }
  function insertReference(props, draft, rel) {
    return insertReferences(props, draft, [rel]);
  }

  // ============================================================ 图片投递（原方案 A）
  function isImage(file) {
    return /^image\//i.test((file && file.type) || '');
  }
  /**
   * 把浏览器 File 交给 DSH 自己的 drop 通道。
   * 链路：document 上的合成 drop → ui-attachment 的 onDrop → onAddImages(files)
   *      → composer 的 intakeImages()（含全部限额校验与提示）。
   */
  function deliverDrop(files, anchor) {
    var images = [];
    var i;
    for (i = 0; i < files.length; i++) if (isImage(files[i])) images.push(files[i]);
    if (images.length === 0) return false;

    var dt;
    try {
      dt = new DataTransfer();
    } catch (e) {
      flash(anchor, '当前环境不支持文件传输对象，请改用粘贴或直接拖拽。');
      return false;
    }
    for (i = 0; i < images.length; i++) {
      try { dt.items.add(images[i]); } catch (e) { warn('加入 DataTransfer 失败', e && e.message); }
    }
    if (dt.files.length === 0) {
      flash(anchor, '文件装载失败，请改用粘贴或直接拖拽。');
      return false;
    }

    var ev = null;
    try {
      ev = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
    } catch (e) {
      try {
        ev = new Event('drop', { bubbles: true, cancelable: true });
        ev.dataTransfer = dt;
      } catch (e2) { ev = null; }
    }
    if (ev === null) {
      flash(anchor, '无法合成拖放事件，请改用粘贴或直接拖拽。');
      return false;
    }
    document.dispatchEvent(ev);
    log('已派发合成 drop，图片数 =', images.length);
    return true;
  }

  // ============================================================ 文档投递
  async function handleItem(file, props, anchor, draft) {
    var name = file.name || '未命名文件';
    if (file.size > 100 * 1024 * 1024) {
      flash(anchor, name + '：超过 100 MB 上限，已跳过。');
      return null;
    }
    var bytes = new Uint8Array(await file.arrayBuffer());
    if (isImage(file)) {
      deliverDrop([file], anchor);
      return null;
    }

    var r;
    try { r = await extractText(file, bytes); }
    catch (e) {
      // 抽取失败仍尝试落盘 + 引用，让模型自己处理（有 bash/read 工具）
      var cwd0 = await resolveCwd(sessionIdOf(props));
      var s0 = await saveToWorkspace(cwd0, file, bytes);
      if (s0 && s0.ok) {
        insertReference(props, draft, s0.rel);
        attAdd({
          name: s0.name, rel: s0.rel, chars: 0, kind: extOf(name) || 'file', text: '',
          saved: true, saveError: '', err: String(e && e.message)
        });
        flash(anchor, name + '：本地抽取失败（' + (e && e.message) + '）\n已放入工作目录并插入引用，由模型自行读取。');
      } else {
        flash(anchor, name + ' 处理失败：' + (e && e.message));
      }
      return null;
    }

    var cwd = await resolveCwd(sessionIdOf(props));
    var saved = await saveToWorkspace(cwd, file, bytes);
    var rel = (saved && saved.ok) ? saved.rel : name;

    // 侧车：仅对「模型自己啃不动」的格式（docx/xlsx/pptx/pdf）写 <原名>.txt。
    // 明文类（r.kind === 'text'：csv/txt/md/json…，含字节嗅探判为文本的）不写侧车
    // —— 原件本来就能被 read，再生成一份 xxx.csv.txt 只会让输入框里的名字变怪。
    var sideRel = '';
    if (saved && saved.ok && r.text && r.kind !== 'text') {
      var side = await saveTextSidecar(cwd, (saved.name || name), r.text);
      if (side && side.ok) sideRel = side.rel;
      else warn('文本侧车写入失败：' + ((side && side.error) || '未知原因'));
    }

    // 单引用（v6，用户 2026-09-12 定稿）：只插侧车 .txt 一条。
    // 侧车头行已写明「原始文件是同目录的 <原名>」，模型一次 read 拿到全文；
    // 原件仍在工作目录 +「已上传」浮层里，需要时可自行取用。
    // 只在「没有侧车」（抽取结果为空，如二进制）时才退回原件单引用。
    var refs = sideRel ? [sideRel] : [rel];
    var refOk = insertReferences(props, draft, refs);
    attAdd({
      name: (saved && saved.ok) ? saved.name : name,
      rel: rel,
      sidecar: sideRel,
      chars: (r.text || '').length,
      kind: r.kind,
      text: r.text || '',
      saved: !!(saved && saved.ok),
      saveError: (saved && saved.ok) ? '' : (saved && saved.error) || ''
    });

    var kb = Math.max(1, Math.round(file.size / 1024));
    if (saved && saved.ok) {
      // 上传后不自动弹列表（用户明确不要这个打扰）：成功与否看「已上传 N」徽标跳数即可。
      // 只有「抽取有保留」或「引用插不进去」这类需要用户知道的情况才额外飘一条。
      if (r.note || !refOk) {
        var wn = name + ' 已处理';
        if (r.note) wn += '\n注意：' + r.note;
        if (!refOk) wn += '\n（输入框引用插入不可用，请手动输入 ' + refs.map(refTextFor).join(' ') + '）';
        flash(anchor, wn);
      }
    } else {
      var msg = name + ' 已处理：抽取 ' + (r.text || '').length + ' 字（' + kb + ' KB）';
      if (r.note) msg += '\n注意：' + r.note;
      msg += '\n未能写入工作目录（' + ((saved && saved.error) || '未知原因') + '）';
      msg += '\n内容已记入「已上传」列表，可用「插入全文」送进对话。';
      flash(anchor, msg);
    }
    return rel;
  }

  // ============================================================ 文件选择
  function pick(anchor, onFiles) {
    try {
      var input = document.createElement('input');
      input.type = 'file';
      input.accept = ACCEPT;
      input.multiple = true;
      input.tabIndex = -1;
      input.setAttribute('aria-hidden', 'true');
      input.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0';
      document.body.appendChild(input);

      var cleaned = false;
      var onBack = function () {
        window.removeEventListener('focus', onBack);
        setTimeout(cleanup, 800);
      };
      var cleanup = function () {
        if (cleaned) return;
        cleaned = true;
        try { window.removeEventListener('focus', onBack); } catch (e) {}
        try { input.remove(); } catch (e) {}
      };

      input.addEventListener('change', function () {
        var files = input.files ? [].slice.call(input.files) : [];
        cleanup();
        if (files.length > 0) onFiles(files);
      });
      window.addEventListener('focus', onBack);
      input.click();
    } catch (e) {
      warn('打开文件选择器失败', e && e.message);
      flash(anchor, '无法打开文件选择器，请改用粘贴或直接拖拽。');
    }
  }

  // ============================================================ 共享读取
  function readPhase(props) {
    try {
      if (props && typeof props.useInput === 'function') {
        var phase = props.useInput(function (s) { return s && s.phase ? s.phase : 'plain'; });
        return phase || 'plain';
      }
    } catch (e) { warn('读取输入态失败', e && e.message); }
    return 'plain';
  }
  function readDraft(props) {
    try {
      if (props && typeof props.useInput === 'function') {
        var d = props.useInput(function (s) { return (s && s.draft) || ''; });
        return d || '';
      }
    } catch (e) {}
    return '';
  }

  /** 计数器订阅只挂一次（宿主 react 没有 useEffect，靠模块级哨兵防重复） */
  var COUNT_SUBBED = false;

  // ============================================================ 组件：上传按钮 + 已上传按钮
  function UploadButton(props) {
    var React = ReactRef;
    if (!React) return null;

    CUR_PROPS = props;

    var phase = readPhase(props);
    var busy = phase === 'adjudicating' || phase === 'submitting';
    var draft = readDraft(props);
    var working = React.useState(false);
    var isWorking = working[0], setWorking = working[1];

    // 附件数变化（上传/移除）要驱动「已上传 N」的计数刷新
    var tick = React.useState(0);
    var setTick = tick[1];
    if (!COUNT_SUBBED) {
      COUNT_SUBBED = true;
      attSub(function () { try { setTick(function (x) { return x + 1; }); } catch (e) {} });
    }
    var count = attList().length;

    var icon = React.createElement('svg', {
      key: 'ico',
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.3,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true
    }, [
      React.createElement('path', { key: 'doc', d: 'M9.2 1.8H4.6a1.4 1.4 0 0 0-1.4 1.4v9.6a1.4 1.4 0 0 0 1.4 1.4h6.8a1.4 1.4 0 0 0 1.4-1.4V5.4z' }),
      React.createElement('path', { key: 'fold', d: 'M9.2 1.8v3.6h3.6' }),
      React.createElement('path', { key: 'up', d: 'M8 12.2V7.4' }),
      React.createElement('path', { key: 'tip', d: 'M6.2 9.1 8 7.3l1.8 1.8' })
    ]);

    var listIcon = React.createElement('svg', {
      key: 'ico2',
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.3,
      strokeLinecap: 'round',
      'aria-hidden': true
    }, [
      React.createElement('circle', { key: 'c1', cx: 3.1, cy: 4.6, r: .95, fill: 'currentColor', stroke: 'none' }),
      React.createElement('path', { key: 'a1', d: 'M6.2 4.6h7' }),
      React.createElement('circle', { key: 'c2', cx: 3.1, cy: 8, r: .95, fill: 'currentColor', stroke: 'none' }),
      React.createElement('path', { key: 'a2', d: 'M6.2 8h7' }),
      React.createElement('circle', { key: 'c3', cx: 3.1, cy: 11.4, r: .95, fill: 'currentColor', stroke: 'none' }),
      React.createElement('path', { key: 'a3', d: 'M6.2 11.4h4.4' })
    ]);

    var upBtn = React.createElement('button', {
      key: 'up',
      type: 'button',
      className: 'dcu-btn',
      title: '选择文件：图片走附件通道；Office / PDF / 文本抽取文本并放入工作目录',
      'aria-label': '上传文件',
      disabled: busy || isWorking,
      onMouseDown: function (e) { e.preventDefault(); },
      onClick: function (e) {
        var node = e && e.currentTarget ? e.currentTarget : null;
        if (busy || isWorking) return;
        pick(node, function (files) {
          setWorking(true);
          var chain = Promise.resolve();
          var imgs = [], docs = [];
          for (var i = 0; i < files.length; i++) {
            if (isImage(files[i])) imgs.push(files[i]); else docs.push(files[i]);
          }
          if (imgs.length) chain = chain.then(function () { return deliverDrop(imgs, node); });
          for (var d = 0; d < docs.length; d++) {
            chain = chain.then((function (f) {
              return function () { return handleItem(f, props, node, draft); };
            })(docs[d]));
          }
          return chain
            .catch(function (err) { flash(node, '处理失败：' + ((err && err.message) || err)); })
            .then(function () { setWorking(false); });
        });
      }
    }, [
      isWorking ? React.createElement('span', { key: 'spin', className: 'dcu-spin' }) : icon,
      React.createElement('span', { key: 'txt' }, '上传文件')
    ]);

    // 无附件时整个按钮不渲染 —— 不占位、不打扰。
    if (!count) return React.createElement('div', { className: 'dcu-bar' }, [upBtn]);

    var listBtn = React.createElement('button', {
      key: 'list',
      type: 'button',
      className: 'dcu-btn dcu-btn-open',
      title: '查看已上传的 ' + count + ' 个文件',
      'aria-label': '已上传 ' + count + ' 个文件',
      // 必须反映真实开关态：写死 'false' 会在浮层已打开时被 React 重渲染盖掉
      'aria-expanded': popShown ? 'true' : 'false',
      onMouseDown: function (e) { e.preventDefault(); },
      onClick: function (e) {
        popToggle(e && e.currentTarget ? e.currentTarget : null);
      }
    }, [
      listIcon,
      React.createElement('span', { key: 'txt' }, '已上传'),
      React.createElement('span', { key: 'n', className: 'dcu-cnt' }, String(count))
    ]);

    return React.createElement('div', { className: 'dcu-bar' }, [upBtn, listBtn]);
  }

  // ============================================================ 「已上传」浮层（纯 DOM）
  // 刻意不进 React 树：① 宿主 react 缺 useEffect/useRef，事件订阅只能手管；
  // ② 浮层必须脱离输入框的布局与 overflow 裁剪 —— position:fixed + 视口坐标最稳
  //    （与划词浮条同一套已验证手法），并统一向上展开，避免被输入框下沿切掉。
  var POP_ID = 'dcu-pop';
  var popShown = false;
  var popAnchor = null;   // 定位基准（「已上传」按钮）
  var popSub = null;      // 附件变化订阅（只挂一次）
  var popBound = false;   // 全局监听只绑一次

  function popEl() { try { return document.getElementById(POP_ID); } catch (e) { return null; } }

  function popSyncBtn() {
    try {
      var b = document.querySelector('.dcu-btn-open');
      if (b !== null && typeof b.setAttribute === 'function') {
        b.setAttribute('aria-expanded', popShown ? 'true' : 'false');
      }
    } catch (e) {}
  }

  function popMeta(it) {
    var m = it.err ? '抽取失败' : (it.chars ? (it.chars + ' 字') : '无文本');
    if (!it.saved) m += ' · 未落盘';
    else if (it.sidecar) m += ' · 文本已落盘';
    return m;
  }

  function popInsert(it) {
    var actions = CUR_PROPS && CUR_PROPS.inputActions;
    if (!actions || typeof actions.setDraft !== 'function') {
      flash(popAnchor, '输入框不可写，请手动输入 @' + (it.rel || it.name));
      return;
    }
    var head = it.saved ? ('【文件：' + it.rel + '】\n') : ('【文件：' + it.name + '】\n');
    var cur = String(readDraft(CUR_PROPS) || '').replace(/\s+$/, '');
    actions.setDraft((cur ? cur + '\n\n' : '') + head + it.text);
    flash(popAnchor, '已插入《' + it.name + '》全文');
  }

  function popRow(it) {
    var row = document.createElement('div');
    row.className = 'dcu-row';

    var ico = document.createElement('span');
    ico.className = 'dcu-row-ico';
    ico.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"'
      + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + '<path d="M9.2 1.8H4.6a1.4 1.4 0 0 0-1.4 1.4v9.6a1.4 1.4 0 0 0 1.4 1.4h6.8a1.4 1.4 0 0 0 1.4-1.4V5.4z"/>'
      + '<path d="M9.2 1.8v3.6h3.6"/></svg>';
    row.appendChild(ico);

    var name = document.createElement('span');
    name.className = 'dcu-row-name';
    name.textContent = it.name;
    name.title = it.sidecar ? (it.rel + '\n纯文本：' + it.sidecar) : it.rel;
    row.appendChild(name);

    var meta = document.createElement('span');
    meta.className = 'dcu-row-meta';
    meta.textContent = popMeta(it);
    row.appendChild(meta);

    var acts = document.createElement('span');
    acts.className = 'dcu-row-acts';
    if (it.text) {
      var ins = document.createElement('button');
      ins.type = 'button';
      ins.className = 'dcu-row-act';
      ins.textContent = '插入全文';
      ins.title = '把抽取的文本追加到输入框';
      ins.addEventListener('click', function () { popInsert(it); });
      acts.appendChild(ins);
    }
    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'dcu-row-x';
    del.textContent = '×';
    del.title = '从列表移除（不影响已写入的文件）';
    del.setAttribute('aria-label', '移除');
    del.addEventListener('click', function () { attRemove(it.id); });
    acts.appendChild(del);
    row.appendChild(acts);

    return row;
  }

  function popRender() {
    var el = popEl();
    if (el === null) return;
    var list = el.querySelector('.dcu-pop-list');
    if (list === null) return;

    while (list.firstChild) list.removeChild(list.firstChild);

    var items = attList();
    if (!items.length) { popClose(); return; }

    var n = el.querySelector('.dcu-pop-n');
    if (n !== null) n.textContent = String(items.length);
    for (var i = 0; i < items.length; i++) list.appendChild(popRow(items[i]));
    popPlace();
  }

  function popPlace() {
    var el = popEl();
    if (el === null) return;
    var r = popAnchor !== null && typeof popAnchor.getBoundingClientRect === 'function'
      ? popAnchor.getBoundingClientRect() : null;
    if (r === null || !r.width) return;
    var w = el.offsetWidth || 300;
    var left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - w - 8));
    el.style.left = Math.round(left) + 'px';
    el.style.top = 'auto';
    el.style.bottom = Math.max(8, Math.round(window.innerHeight - r.top + 8)) + 'px';
  }

  function popOpen(anchor) {
    try {
      if (typeof document === 'undefined') return;
      if (anchor) popAnchor = anchor;
      var el = popEl();
      if (el === null) {
        if (popAnchor === null) return;
        el = document.createElement('div');
        el.id = POP_ID;
        el.className = 'dcu-pop';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-label', '已上传文件');

        var head = document.createElement('div');
        head.className = 'dcu-pop-head';
        var t = document.createElement('span');
        t.textContent = '已上传文件';
        var n = document.createElement('span');
        n.className = 'dcu-pop-n';
        n.textContent = '0';
        head.appendChild(t);
        head.appendChild(n);
        el.appendChild(head);

        var list = document.createElement('div');
        list.className = 'dcu-pop-list';
        el.appendChild(list);

        document.body.appendChild(el);
      }
      popShown = true;
      popSyncBtn();
      popRender();

      if (!popBound) {
        popBound = true;
        document.addEventListener('mousedown', popOutside, true);
        document.addEventListener('keydown', popKey, true);
        window.addEventListener('resize', popClose, true);
        window.addEventListener('scroll', popScroll, true);
      }
      if (popSub === null) {
        popSub = attSub(function () { if (popShown) popRender(); });
      }
    } catch (e) { warn('浮层打开失败', e && e.message); }
  }

  function popClose() {
    popShown = false;
    var el = popEl();
    if (el !== null) { try { el.remove(); } catch (e) {} }
    popSyncBtn();
  }

  function popOutside(e) {
    if (!popShown) return;
    var t = e && e.target;
    var el = popEl();
    if (el !== null && t && el.contains(t)) return;
    // 点在按钮组（含「上传文件」「已上传」）上不算外部 —— 交给 onClick 做 toggle
    if (t && typeof t.closest === 'function' && t.closest('.dcu-bar') !== null) return;
    popClose();
  }

  function popKey(e) {
    if (!popShown) return;
    if (e && (e.key === 'Escape' || e.keyCode === 27)) popClose();
  }

  function popScroll(e) {
    if (!popShown) return;
    var el = popEl();
    var t = e && e.target;
    // 面板自身内部滚动不算「页面动了」，否则长列表一滚就自关
    if (el !== null && t && t.nodeType === 1 && el.contains(t)) return;
    popClose();
  }

  function popToggle(anchor) {
    if (popShown) popClose();
    else popOpen(anchor);
  }

  // ============================================================ 装配
  function apply(ctx) {
    ensureCss();
    try {
      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function' || typeof ctx.slots.register !== 'function') {
        warn('ctx.slots 不可用，「上传文件」注册失败');
        return;
      }
      ctx.slots.inject(SLOT, function () {
        return ctx.slots.register(
          { name: SLOT, id: ENTRY_ID, order: 100, label: '上传文件' },
          UploadButton
        );
      });
      log('已注册「上传文件 / 已上传」按钮组（构建=' + BUILD + '）');
    } catch (e) {
      warn('注册失败', e && e.message);
    }
  }

  window.__ModuleLoader__.load({
    id: HOST,
    factory: function (require) {
      var module = { exports: {} };
      var exports = module.exports;
      try {
        ReactRef = require('react');
      } catch (e) { ReactRef = null; }
      if (!ReactRef && typeof window !== 'undefined' && window.React) ReactRef = window.React;
      if (!ReactRef) warn('两条路都拿不到 react 实例，界面无法渲染');

      exports.name = HOST;
      // 只依赖槽位服务；未声明任何框架内部服务
      exports.inject = ['slots'];
      exports.apply = apply;
      // 自验用内部导出（宿主只读 name/inject/apply，不会因此受影响）
      exports.__internals = {
        BUILD: BUILD,
        extractText: extractText,
        extractOoxml: extractOoxml,
        extractPdf: extractPdf,
        parseCMap: parseCMap,
        pdfContentText: pdfContentText,
        looksBinary: looksBinary,
        attList: attList,
        attAdd: attAdd,
        attRemove: attRemove,
        saveTextSidecar: saveTextSidecar,
        insertReferences: insertReferences
      };
      return module.exports;
    }
  });
})();
