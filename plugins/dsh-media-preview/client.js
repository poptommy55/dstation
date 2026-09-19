/**
 * dsh-media-preview —— 浏览器半（client.js）
 *
 * 目标：模型在对话里提到/生成的图片、视频、音频，**就地**渲染成预览卡，
 * 能播放，能一键另存到本机。
 *
 * ── 为什么不走官方槽位（改前务必先读这段）────────────────────────────────
 * DSH 的对话渲染链是「Chat Node 渲染器」体系：assistant 文本行由
 * dsh-client-ui-chat 用 key="assistant-step" 注册在 conversation.chat.node 上，
 * 而该槽是 keyed 且**每个 key 只允许一个占用者**（duplicate throws）。第三方
 * 插件没有任何"包一层"的钩子：注册同名 key 会抛错，注册新 key 又没有节点会
 * 产生那个 kind。真正可用的扩展点只剩：
 *   · conversation.view —— 整块替换对话视图（等于重写 Chat，不可接受）
 *   · 各种 list/chain 槽位（composer 底栏、assistant-actions 动作条）—— 只能
 *     加按钮，不能把预览卡插到正文位置
 * 因此本插件采用**受控的 DOM 后处理**：扫描已渲染的正文，把「纯路径/URL 文本
 * 节点」换成预览卡。这与 dsh-mermaid（同样扫描 pre>code 并就地替换成图卡）
 * 是同一套已被生产验证的手法。
 *
 * ── DOM 后处理的安全纪律（越界就会踩 React 的 removeChild 崩溃）──────────
 * React 只在自己要卸载某个子节点却"找不到它"时抛 NotFoundError。据此定下三条：
 *   1. 绝不删除 React 渲染出来的节点，只 ① 加内联 style 隐藏 ② 在其父节点末尾
 *      append 我们自己的容器。React 重渲染时只按自己的记录操作，多余的兄弟节点
 *      与内联样式都不影响它。
 *   2. 我们自己的节点全部打 data-dsh-media-* 标记，扫描时跳过，防止自噬。
 *   3. 隐藏前记录原 display，卸载时还原；React 若已重建该节点，还原就是 no-op。
 *
 * ── 与宿主的契约 ──────────────────────────────────────────────────────
 * 所有"这个路径能不能读、是什么 MIME、URL 长什么样"的判断都归宿主
 * （见 index.js 的 /dsh-media/allow）。本文件不猜 MIME、不自己拼绝对 URL 之外
 * 的东西 —— 浏览器半只负责"识别候选、请求登记、渲染结果"。
 */

(function () {
  'use strict';

  var HOST = 'dsh-media-preview';
  /**
   * 构建标识。排障第一现场：页面里 `style[data-plugin-css="dsh-media-preview"]`
   * 的 data-plugin-build 就是浏览器当前实际在跑的这一版。
   * 改代码后必须同步 +1，否则无法判断"用户拿到的是新版还是缓存"。
   */
  var BUILD = 'v10-20260913-react-button';
  var API_BASE = '/dsh-media';
  /** 扫描折叠窗口：React 连续重渲染时合并成一次。 */
  var SCAN_DEBOUNCE_MS = 120;
  /** 正文里单个媒体文件的大小上限提示（宿主只读，超过就只给下载按钮由浏览器决定）。 */
  var MAX_INLINE_IMAGE_BYTES = 64 * 1024 * 1024;
  /** 超过这个体积就不走 blob 下载（会把整个文件读进内存），直接交给浏览器。 */
  var BLOB_SAFE_BYTES = 24 * 1024 * 1024;

  /** 媒体扩展名 → 粗判类型（真正的类型判定在宿主）。 */
  var EXT_KIND = {
    png: 'image', jpg: 'image', jpeg: 'image', jfif: 'image', webp: 'image',
    gif: 'image', bmp: 'image', avif: 'image', svg: 'image', ico: 'image',
    mp4: 'video', m4v: 'video', webm: 'video', ogv: 'video', mov: 'video', mkv: 'video',
    mp3: 'audio', m4a: 'audio', aac: 'audio', wav: 'audio', flac: 'audio',
    ogg: 'audio', oga: 'audio', opus: 'audio', weba: 'audio'
  };
  var EXT_ALTERNATION = Object.keys(EXT_KIND).join('|');

  /**
   * 本地绝对路径候选：
   *   Windows 盘符  D:\a\b.png  /  D:/a/b.png
   *   UNC           \\server\share\a.png
   *   POSIX         /home/u/a.png
   * 允许路径里出现空格与中文，但不允许引号/换行/竖线，避免把整段话吞进来。
   */
  var RE_LOCAL_PATH = new RegExp(
    '(?:[A-Za-z]:[\\\\/]|\\\\\\\\|/)' +
    '[^\\s"\'<>|*?\\r\\n]*?' +
    '\\.(?:' + EXT_ALTERNATION + ')\\b',
    'gi'
  );

  /** http(s) 直链候选（模型经常直接给 CDN 链接）。 */
  var RE_HTTP_MEDIA = new RegExp(
    'https?://[^\\s"\'<>()\\[\\]]*?\\.(?:' + EXT_ALTERNATION + ')(?:\\?[^\\s"\'<>()\\[\\]]*)?',
    'gi'
  );

  /** file:// 直链候选：DSH 的 deliverables/media_preview 工具会输出这种形式。 */
  var RE_FILE_URL = new RegExp(
    'file:///[^\\s"\'<>()\\[\\]]*?\\.(?:' + EXT_ALTERNATION + ')\\b',
    'gi'
  );

  /** file:///D:/a/b.png → D:/a/b.png（含 Windows 上多余的盘符前斜杠）。 */
  function fileUrlToPath(u) {
    var s = String(u || '');
    if (!/^file:\/\//i.test(s)) return s;
    s = s.replace(/^file:\/\//i, '');
    try { s = decodeURIComponent(s); } catch (e) { /* 非法转义就按原样用 */ }
    // file:///D:/a.png → /D:/a.png → D:/a.png
    if (/^\/[A-Za-z]:/.test(s)) s = s.slice(1);
    return s;
  }

  var CSS = [
    '.dsh-mp-family{display:flex;flex-wrap:wrap;gap:10px;margin:8px 0 10px;align-items:flex-start}',
    '.dsh-mp-card{position:relative;display:flex;flex-direction:column;gap:6px;width:min(320px,100%);',
    'padding:8px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));',
    'background:var(--dsw-alias-bg-layer-3,var(--dsw-specific-menu,rgba(127,127,127,.06)));',
    'color:var(--dsw-alias-label-primary,inherit);box-sizing:border-box}',
    '.dsh-mp-card[data-state="error"]{border-color:var(--dsw-alias-border-l4,rgba(200,60,60,.5))}',
    '.dsh-mp-stage{position:relative;display:flex;align-items:center;justify-content:center;',
    'width:100%;min-height:120px;max-height:320px;overflow:hidden;border-radius:8px;',
    'background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.10))}',
    '.dsh-mp-stage>img{display:block;max-width:100%;max-height:320px;width:auto;height:auto;object-fit:contain}',
    '.dsh-mp-stage>video{display:block;width:100%;max-height:320px;background:#000;border-radius:8px}',
    '.dsh-mp-stage>audio{display:block;width:100%}',
    '.dsh-mp-fallback{padding:14px 10px;font-size:12px;line-height:1.6;text-align:center;',
    'color:var(--dsw-alias-label-secondary,inherit);word-break:break-all}',
    '.dsh-mp-meta{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:12px;line-height:1.4}',
    '.dsh-mp-kind{flex:none;padding:1px 6px;border-radius:999px;font-size:10px;letter-spacing:.04em;',
    'text-transform:uppercase;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));',
    'color:var(--dsw-alias-label-secondary,inherit)}',
    '.dsh-mp-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
    'font-weight:500}',
    '.dsh-mp-size{flex:none;color:var(--dsw-alias-label-secondary,inherit);font-variant-numeric:tabular-nums}',
    '.dsh-mp-acts{display:flex;flex-wrap:wrap;gap:6px}',
    '.dsh-mp-btn{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 10px;border:0;',
    'border-radius:999px;cursor:pointer;font:inherit;font-size:12px;line-height:1;white-space:nowrap;',
    'background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));',
    'color:var(--dsw-alias-label-primary,inherit)}',
    '.dsh-mp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.28))}',
    '.dsh-mp-btn:disabled{opacity:.5;cursor:default}',
    '.dsh-mp-btn[data-primary]{background:var(--dsw-alias-button-primary-fill,#4d6bfe);',
    'color:var(--dsw-alias-label-primary-foreground,#fff)}',
    '.dsh-mp-btn[data-primary]:hover:not(:disabled){filter:brightness(1.08)}',
    '.dsh-mp-btn>svg{display:block;width:13px;height:13px;flex:none}',
    '.dsh-mp-status{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,inherit);',
    'word-break:break-all}',
    '.dsh-mp-status[data-tone="error"]{color:var(--dsw-alias-label-error,#e5484d)}',
    '.dsh-mp-caption{padding:8px 0;font-size:13px;color:var(--dsw-alias-label-secondary,inherit)}',
    '@media print{.dsh-mp-acts{display:none}}'
  ].join('');

  function log() {
    try { console.log.apply(console, ['[' + HOST + ']'].concat([].slice.call(arguments))); } catch (e) {}
  }
  function warn() {
    try { console.warn.apply(console, ['[' + HOST + ']'].concat([].slice.call(arguments))); } catch (e) {}
  }

  // ─────────────────────────────────────────────────── 状态自报（默认静默）
  //
  // 排障时最难受的是"插件到底跑没跑"无从判断：只能让用户开 DevTools。
  // 所以把运行时事实写进 DOM —— 但**默认不显示**，只在显式开启时才浮出：
  //   · URL 带 ?dsh-media-debug=1
  //   · 或页面里预先设了 window.__DSH_MEDIA_DEBUG__ = true
  // 默认静默的原因很实际：常驻浮层会压住左下角的侧边栏按钮（2026-09-13 实测），
  // 一个诊断工具不该干扰主界面。
  //
  // 无论是否显示，属性都写在 <html> 上，因此随时可以查：
  //   document.documentElement.dataset.dshMediaBuild / Phase / Scans / Cards

  var STATS = { scans: 0, groups: 0, candidates: 0, cards: 0, lastError: '' };

  /** 是否显示浮出的自报标签（默认否）。 */
  function legendEnabled() {
    try {
      if (typeof window !== 'undefined' && window.__DSH_MEDIA_DEBUG__ === true) return true;
      if (typeof location !== 'undefined' && location.search !== undefined
          && /[?&]dsh-media-debug=1\b/.test(location.search)) return true;
    } catch (e) { /* 无 location 的环境（测试）按默认处理 */ }
    return false;
  }

  /**
   * 记录一次运行事实。属性永远写；浮层只在开启调试时出现。
   * @param {string} reason - 当前阶段（apply:start / apply:ok / scan:done 等）
   */
  function markApplied(reason) {
    try {
      if (typeof document === 'undefined') return null;
      var root = document.documentElement;
      if (root !== null && root.dataset !== undefined) {
        root.dataset.dshMediaBuild = BUILD;
        root.dataset.dshMediaPhase = reason;
        root.dataset.dshMediaScans = String(STATS.scans);
        root.dataset.dshMediaCandidates = String(STATS.candidates);
        root.dataset.dshMediaCards = String(STATS.cards);
        if (STATS.lastError !== '') root.dataset.dshMediaError = STATS.lastError;
      }
      if (!legendEnabled() || !document.body) return null;

      var el = document.querySelector('[data-dsh-media-legend]');
      if (el === null) {
        el = document.createElement('div');
        el.setAttribute('data-dsh-media-legend', '1');
        el.setAttribute('style', [
          'position:fixed', 'left:10px', 'bottom:10px', 'z-index:2147483000',
          'max-width:min(520px,60vw)', 'padding:4px 9px', 'border-radius:9px',
          'font:11.5px/1.5 ui-monospace,Consolas,"Microsoft YaHei",monospace',
          'background:var(--dsw-specific-menu,#1b1e24)', 'color:var(--dsw-alias-label-secondary,#98a2b3)',
          'border:1px solid var(--dsw-alias-border-l2,#2a2f37)', 'pointer-events:none',
          'white-space:pre-wrap', 'opacity:.92'
        ].join(';'));
        document.body.appendChild(el);
      }
      el.setAttribute('data-dsh-media-build', BUILD);
      el.setAttribute('data-dsh-media-phase', reason);
      el.textContent =
        '媒体预览 ' + BUILD + ' · ' + reason
        + '\n扫描 ' + STATS.scans + ' 轮 · 候选 ' + STATS.candidates + ' · 卡片 ' + STATS.cards
        + (STATS.lastError === '' ? '' : '\n最后错误：' + STATS.lastError);
      return el;
    } catch (e) { return null; }
  }

  function ensureCss() {
    try {
      if (typeof document === 'undefined') return;
      // data-plugin-css 是幂等键（保持稳定，不要带版本）；data-plugin-build 是
      // "页面上跑的到底是哪一版"的唯一可查事实 —— 排障时先看它。
      if (document.querySelector('style[data-plugin-css="' + HOST + '"]') !== null) return;
      var tag = document.createElement('style');
      tag.dataset.plugin = HOST;
      tag.dataset.pluginCss = HOST;
      tag.dataset.pluginBuild = BUILD;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    } catch (e) { warn('注入样式失败', e && e.message); }
  }

  // ─────────────────────────────────────────────────────────── 路径识别

  /** 去掉尾随的标点（模型常在句末写 "…/a.png。" 或 "…/a.png"，我把它剥掉） */
  function trimTrailingPunctuation(raw) {
    var s = String(raw == null ? '' : raw);
    // 中文标点与英文标点都算；但路径本身可能含中文，只剥"明显句尾"的那一两个字符
    while (s.length > 0 && /[.,;:!?、。，；：！？）)\]】》"']/.test(s.charAt(s.length - 1))) {
      s = s.slice(0, -1);
    }
    return s;
  }

  function kindOfPath(p) {
    var m = /\.([A-Za-z0-9]+)$/.exec(String(p || ''));
    if (!m) return null;
    return EXT_KIND[m[1].toLowerCase()] || null;
  }

  /**
   * 从一个文本节点里抽出所有媒体候选。
   * @returns {{start:number,end:number,text:string,kind:string,remote:boolean}[]}
   */
  function extractCandidates(text) {
    var out = [];
    var src = String(text == null ? '' : text);
    var seen = {};

    function take(re, remote) {
      var m;
      re.lastIndex = 0;
      while ((m = re.exec(src)) !== null) {
        var raw = trimTrailingPunctuation(m[0]);
        if (raw === '') continue;
        var kind = kindOfPath(raw);
        if (kind === null) continue;
        if (seen[raw] === true) continue;
        seen[raw] = true;
        out.push({ start: m.index, end: m.index + raw.length, text: raw, kind: kind, remote: remote });
      }
    }

    take(RE_HTTP_MEDIA, 'remote');
    take(RE_FILE_URL, 'fileurl');
    // 本地路径要排除掉已被 http/file 候选覆盖的区间（那些链接里也含 "/" 和 ".png"）
    var localRe = new RegExp(RE_LOCAL_PATH.source, 'gi');
    var m;
    while ((m = localRe.exec(src)) !== null) {
      var raw = trimTrailingPunctuation(m[0]);
      if (raw === '') continue;
      var start = m.index;
      var end = start + raw.length;
      var overlaps = false;
      for (var i = 0; i < out.length; i++) {
        if (start < out[i].end && end > out[i].start) { overlaps = true; break; }
      }
      if (overlaps) continue;
      if (seen[raw] === true) continue;
      var kind = kindOfPath(raw);
      if (kind === null) continue;
      // 相对路径（既没有盘符也不是 / 开头）不作为本地路径候选 —— 宿主只接受绝对路径
      if (!/^([A-Za-z]:[\\/]|\\\\|\/)/.test(raw)) continue;
      // 单斜杠开头的候选可能是从 "out/a.png" 这类相对路径里被咬出来的尾巴。
      // 判据：它前面必须是空白或明显的边界符，否则按相对路径丢掉。
      if (raw.charAt(0) === '/') {
        var before = start > 0 ? src.charAt(start - 1) : '';
        if (before !== '' && !/[\s\u3000(\[（【"'`：:,，]/.test(before)) continue;
      }
      seen[raw] = true;
      out.push({ start: start, end: end, text: raw, kind: kind, remote: 'local' });
    }

    out.sort(function (a, b) { return a.start - b.start; });
    return out;
  }

  // ─────────────────────────────────────────────────────────── 登记缓存
  // key = 原始候选文本（本地路径或 URL），value = { status, data?, error? }
  var REGISTRY = new Map();
  var INFLIGHT = new Map();

  function registryGet(key) {
    if (!REGISTRY.has(key)) REGISTRY.set(key, { status: 'pending' });
    return REGISTRY.get(key);
  }

  /**
   * 向宿主登记一批本地路径。
   *
   * 只跳过"已成功"和"在飞"的；**失败过的允许重试**。
   * 这一点很重要：宿主侧的限制（比如允许根）可能后来被修好，
   * 而卡片状态一旦粘在 error 上，用户就只能整页刷新才能恢复 —— 那不合理
   * （2026-09-13 实测：宿主已放行，卡片却仍显示"拒绝访问"）。
   * 重试很便宜（本机 POST），所以每次扫描都允许失败项重来。
   * @param {string[]} paths
   */
  function registerPaths(paths) {
    var need = [];
    for (var i = 0; i < paths.length; i++) {
      var p = paths[i];
      var entry = REGISTRY.get(p);
      if (entry !== undefined && entry.status === 'ok') continue;   // 已成功，不动
      if (INFLIGHT.has(p)) continue;                                // 在飞，别重复发
      need.push(p);
    }
    if (need.length === 0) {
      notify();
      return;
    }
    for (var j = 0; j < need.length; j++) {
      REGISTRY.set(need[j], { status: 'pending' });
      INFLIGHT.set(need[j], true);
    }

    // 看门狗：登记超过 12 秒还没结果，就把"正在向宿主确认"换成明确失败。
    // 卡在 pending 是最糟的表现——用户不知道是慢还是坏了。
    setTimeout(function () {
      for (var k = 0; k < need.length; k++) {
        var current = REGISTRY.get(need[k]);
        if (current !== undefined && current.status === 'pending') {
          REGISTRY.set(need[k], { status: 'error', error: '宿主在 12 秒内没有回应登记请求（可刷新页面重试）' });
        }
      }
      notify();
    }, 12000);

    requestAllow(need).then(function (body) {
      var items = body !== null && Array.isArray(body.items) ? body.items : [];
      var byAsked = {};
      for (var i = 0; i < items.length; i++) byAsked[items[i].asked] = items[i];
      for (var k = 0; k < need.length; k++) {
        var asked = need[k];
        var item = byAsked[asked];
        if (item === undefined || item.ok !== true) {
          REGISTRY.set(asked, {
            status: 'error',
            error: item && item.message ? item.message : '宿主没有返回该路径的判定'
          });
        } else {
          REGISTRY.set(asked, { status: 'ok', data: item });
        }
      }
    }).catch(function (e) {
      var reason = (e && e.message) || String(e);
      for (var k = 0; k < need.length; k++) {
        REGISTRY.set(need[k], { status: 'error', error: '宿主媒体通道不可达：' + reason });
      }
    }).then(function () {
      for (var k = 0; k < need.length; k++) INFLIGHT.delete(need[k]);
      notify();
    });
  }

  /**
   * 向宿主登记一批路径。
   *
   * 用 XMLHttpRequest 而不是 fetch：这是本地回环请求，XHR 在所有 Electron/浏览器
   * 组合下都稳；而且它**一定**会以 error/timeout 结束，不会像 fetch 那样在
   * 极端情况下既不 resolve 也不 reject —— 卡片会永远停在"正在向宿主确认这个文件…"。
   * 这正是 2026-09-13 实测遇到的最后一颗钉子（宿主侧 200 正常，页面侧却一直 pending）。
   *
   * @param {string[]} paths
   * @returns {Promise<object|null>} 解析后的 JSON 体
   */
  function requestAllow(paths) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        try { xhr.abort(); } catch (e) { /* ignore */ }
        reject(new Error('请求超时（15 秒）'));
      }, 15000);

      xhr.open('POST', API_BASE + '/allow', true);
      xhr.setRequestHeader('content-type', 'application/json');
      xhr.onload = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error('HTTP ' + xhr.status + (xhr.responseText ? ' ' + String(xhr.responseText).slice(0, 160) : '')));
          return;
        }
        try { resolve(JSON.parse(xhr.responseText)); }
        catch (e) { reject(new Error('响应不是合法 JSON：' + ((e && e.message) || e))); }
      };
      xhr.onerror = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('网络错误（状态 ' + xhr.status + '）'));
      };
      xhr.ontimeout = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('请求超时'));
      };
      try {
        xhr.send(JSON.stringify({ paths: paths }));
      } catch (e) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('无法发送请求：' + ((e && e.message) || e)));
      }
    });
  }

  // ─────────────────────────────────────────────────────────── 订阅（让卡片自己重渲染）
  var SUBSCRIBERS = new Set();
  function notify() {
    SUBSCRIBERS.forEach(function (fn) { try { fn(); } catch (e) {} });
  }

  // ─────────────────────────────────────────────────────────── 下载
  function fileNameOf(item, fallback) {
    if (item !== undefined && item !== null && typeof item.name === 'string' && item.name !== '') return item.name;
    var s = String(fallback || 'media');
    var at = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return at >= 0 ? s.slice(at + 1) : s;
  }

  function pickSaveHandle(name) {
    if (typeof window === 'undefined' || typeof window.showSaveFilePicker !== 'function') {
      return Promise.resolve(null);
    }
    return window.showSaveFilePicker({ suggestedName: name }).catch(function () { return null; });
  }

  /**
   * 取一个 URL 的二进制内容（下载用）。
   *
   * 与 requestAllow 同理用 XHR：本地回环请求下它一定会以 load/error/timeout 结束，
   * 不会让「保存中…」永远转下去。超时上限 60 秒（媒体文件可能不小）。
   * @param {string} url
   * @returns {Promise<Blob>}
   */
  function fetchBlob(url) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        try { xhr.abort(); } catch (e) { /* ignore */ }
        reject(new Error('下载超时（60 秒）'));
      }, 60000);

      xhr.open('GET', url, true);
      xhr.responseType = 'blob';
      xhr.onload = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error('HTTP ' + xhr.status));
          return;
        }
        resolve(xhr.response);
      };
      xhr.onerror = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('网络错误（状态 ' + xhr.status + '）'));
      };
      xhr.ontimeout = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('下载超时'));
      };
      try {
        xhr.send(null);
      } catch (e) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('无法发起下载：' + ((e && e.message) || e)));
      }
    });
  }

  function anchorDownload(url, name) {
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { try { a.remove(); } catch (e) {} }, 0);
  }

  function humanSize(bytes) {
    var n = Number(bytes);
    if (!isFinite(n) || n < 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(2) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }

  // ─────────────────────────────────────────────────────────── 卡片渲染（纯 DOM）
  //
  // 为什么不用 React：DSH 的客户端模块表里确实有 react，但"能不能拿到渲染器"
  // 会多出一整条失败路径（曾出现宿主拿不到 react-dom 时整块正文只剩一句错误）。
  // 卡片本身只是图片/播放器 + 两个按钮，用原生 DOM 反而更短、更可控，也彻底
  // 去掉了与 DSH 内部 React 实例纠缠的风险。React 树由 DSH 自己维护，
  // 我们只往它旁边插节点 —— 这条纪律不变。

  var SVG_NS = 'http://www.w3.org/2000/svg';

  /** 造元素的小工具：el('div', {className:'x'}, [子节点或字符串]) */
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs !== undefined && attrs !== null) {
      for (var key in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
        var value = attrs[key];
        if (value === null || value === undefined || value === false) continue;
        if (key === 'text') node.textContent = String(value);
        else if (key === 'className') node.className = String(value);   // 走属性而不是 setAttribute，与真实 DOM 语义一致
        else if (key === 'style') node.setAttribute('style', String(value));
        else if (key.indexOf('on') === 0 && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else node.setAttribute(key, value === true ? '' : String(value));
      }
    }
    if (children !== undefined && children !== null) {
      var list = Array.isArray(children) ? children : [children];
      for (var i = 0; i < list.length; i++) {
        var child = list[i];
        if (child === null || child === undefined || child === false) continue;
        node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
      }
    }
    return node;
  }

  /** 16x16 空心描边图标（与 DSH 图标风格一致，不依赖其图标库）。 */
  function icon(paths) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.4');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < paths.length; i++) {
      var p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', paths[i]);
      svg.appendChild(p);
    }
    return svg;
  }

  function downloadIcon() {
    return icon(['M8 2.4v7.6', 'M5 7.2 8 10.2l3-3', 'M3 12.6h10']);
  }

  function openIcon() {
    return icon(['M6.4 3H3.2v9.8h9.8V9.6', 'M9.4 2.6h4v4', 'M13.2 2.8 7.4 8.6']);
  }

  /**
   * 一张媒体卡（纯 DOM 实现，自带重渲染）。
   * @param {object} candidate - { text, kind, remote }
   */
  function MediaCardView(candidate) {
    // candidate.remote: 'local'（本地绝对路径，需宿主登记）| 'remote'（http 直链）| 'fileurl'（file:// 直链）
    var mode = candidate.remote;
    var isLocal = mode === 'local';
    var entry = null;
    var item = null;
    var src = null;
    var kind = candidate.kind;
    var name = '';
    var sizeText = '';
    var busy = false;
    var failure = null;
    var loadError = false;
    /** 舞台当前挂的是什么：'none' | 'image' | 'video' | 'audio' | 'toolarge' + 对应 src */
    var stageKind = 'init';
    var stageSrc = null;
    var stageNode = null;

    var stageEl = el('div', { className: 'dsh-mp-stage' });
    var kindEl = el('span', { className: 'dsh-mp-kind' });
    var nameEl = el('span', { className: 'dsh-mp-name' });
    var sizeEl = el('span', { className: 'dsh-mp-size' });
    var noteEl = el('div', { className: 'dsh-mp-status' });
    /** 出错时才加进来的「重试」按钮（见 render 末尾）。 */
    var retryBtn = null;
    var downloadBtn = el('button', {
      type: 'button',
      className: 'dsh-mp-btn',
      'data-primary': '',
      title: '保存到本机'
    });
    var openBtn = el('button', {
      type: 'button',
      className: 'dsh-mp-btn',
      title: '在新标签页打开原文件',
      onclick: function () {
        var target = effectiveUrl(false);
        if (target !== null) window.open(target, '_blank', 'noopener');
      }
    });
    /** 动作行容器：重试按钮会动态加进来 / 移除。 */
    var actsEl = el('div', { className: 'dsh-mp-acts' }, [downloadBtn, openBtn]);

    var cardEl = el('div', {
      className: 'dsh-mp-card',
      'data-state': 'ok',
      'data-dsh-media-card': '1'
    }, [
      stageEl,
      el('div', { className: 'dsh-mp-meta' }, [kindEl, nameEl, sizeEl]),
      actsEl,
      noteEl
    ]);

    function fallbackName() {
      var from = isLocal ? candidate.text : fileUrlToPath(candidate.text);
      var clean = isLocal ? from : String(from).split('?')[0].split('#')[0];
      return fileNameOf(undefined, clean);
    }

    /** 当前可预览/可打开/可下载的 URL（file:// 已在 render 里换成宿主通道 URL）。 */
    function effectiveUrl(download) {
      if (item === null) return null;
      // 远端直链原样返回；走宿主通道的（file:// 转换而来）在下载时补上 dl=1
      if (item.remote === true) {
        return download && item.viaHost === true
          ? item.url + '&dl=1&name=' + encodeURIComponent(name)
          : item.url;
      }
      return download ? item.url + '&dl=1&name=' + encodeURIComponent(name) : item.url;
    }

    function setBusy(next) {
      busy = next;
      render();
    }

    function doDownload() {
      var url = effectiveUrl(true);
      if (url === null || busy) return;
      failure = null;
      var size = item !== null && typeof item.size === 'number' ? item.size : null;
      var canPick = typeof window.showSaveFilePicker === 'function';
      // 大文件又不支持「选保存位置」时，直接把下载交给浏览器（不经过内存）
      if (size !== null && size > BLOB_SAFE_BYTES && !canPick) {
        anchorDownload(url, name);
        render();
        return;
      }
      if (canPick) {
        setBusy(true);
        pickSaveHandle(name).then(function (handle) {
          if (handle === null) { setBusy(false); return; }
          return fetchBlob(url).then(function (blob) {
            return handle.createWritable().then(function (w) {
              return w.write(blob).then(function () { return w.close(); });
            });
          }).then(function () {
            setBusy(false);
          }).catch(function (e) {
            failure = '保存失败：' + ((e && e.message) || e);
            setBusy(false);
          });
        });
        return;
      }
      // 退化：blob 下载 —— 失败或超时就直接交给浏览器，避免按钮卡在「保存中」
      setBusy(true);
      var settled = false;
      var bail = setTimeout(function () {
        if (settled) return;
        settled = true;
        setBusy(false);
        anchorDownload(url, name);
      }, 8000);
      fetchBlob(url).then(function (blob) {
        if (settled) return;
        settled = true;
        clearTimeout(bail);
        var objectUrl = URL.createObjectURL(blob);
        anchorDownload(objectUrl, name);
        setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 30000);
        setBusy(false);
      }).catch(function () {
        if (settled) return;
        settled = true;
        clearTimeout(bail);
        setBusy(false);
        anchorDownload(url, name);
      });
    }

    downloadBtn.addEventListener('click', doDownload);

    /** 把当前状态画进 DOM（这个函数是唯一的渲染入口）。 */
    function render() {
      var loadNote = null;
      var pendingEnrich = false;

      if (!isLocal) {
        // file:// 直链也要走宿主通道：HTTP 页面读不了 file://，浏览器会直接拒绝。
        item = {
          name: name,
          url: mode === 'fileurl'
            ? API_BASE + '/file?path=' + encodeURIComponent(fileUrlToPath(candidate.text))
            : candidate.text,
          remote: true,
          viaHost: mode === 'fileurl'
        };
        src = item.url;
        kind = candidate.kind;
        name = fallbackName();
        sizeText = '';
        if (mode === 'fileurl') loadNote = '这是 file:// 直链，预览已通过本地媒体通道转发；下载请用「下载」。';
      } else if (entry !== null && entry.status === 'ok') {
        item = entry.data;
        src = item.url;
        kind = item.kind || kind;
        name = item.name || fallbackName();
        sizeText = humanSize(item.size);
      } else if (entry !== null && entry.status === 'error') {
        // 宿主明确拒绝 —— 这时才不给预览（例如文件在工作区之外）。
        // 必须显式清掉上一轮可能已经算出来的 src/item：render 会在
        // "未登记 → 明确拒绝"之间被调用多次，残留的 src 会让被拒文件照样尝试加载
        // （2026-09-13 实测：错误卡里仍出现 <img>）。
        loadNote = entry.error;
        src = null;
        item = null;
      } else {
        // 关键设计：登记只是"补充信息"，**不是预览的前置条件**。
        // 客户端本来就能拼出确定性 URL（与宿主同一套约定），所以立刻交给
        // 浏览器去加载；登记回来后再补上体积与权威类型。
        // 这样即使那次往返卡住/失败，用户依然能看到图和播放器 —— 之前把预览
        // 押在一次 HTTP 往返上，结果就是卡片永远停在"正在确认"（2026-09-13 实测）。
        item = {
          name: name,
          url: localMediaUrl(candidate.text),
          remote: false
        };
        src = item.url;
        name = fallbackName();
        pendingEnrich = true;
      }

      // ── 舞台：只在"需要的东西变了"的时候重建 ──────────────────────────
      //
      // render() 会因为登记回包、卡片状态变化而被反复调用。之前每次都用
      // replaceChildren() 重建 <video>/<audio>，而在浏览器里"重建元素"等于
      // 重新加载媒体：视频会不停回到第一帧并闪黑（图片有缓存所以看不出来）。
      // 因此这里记住当前舞台挂的是什么，只有换了才动 DOM。
      if (src === null) {
        if (stageKind !== 'none') {
          stageEl.replaceChildren();
          stageKind = 'none';
          stageSrc = null;
          stageNode = el('div', { className: 'dsh-mp-fallback' });   // 先建节点再挂，避免首帧拿到 undefined
          stageEl.appendChild(stageNode);
        }
        stageNode.textContent = loadNote || '无法预览';
      } else {
        var tooBig = isLocal && entry !== null && entry.status === 'ok' && item !== null
          && typeof item.size === 'number' && item.size > MAX_INLINE_IMAGE_BYTES;
        var wantedKind = tooBig ? 'toolarge'
          : (kind === 'video' ? 'video' : (kind === 'audio' ? 'audio' : 'image'));
        if (wantedKind !== stageKind || src !== stageSrc) {
          stageEl.replaceChildren();
          var fresh;
          if (wantedKind === 'video') {
            fresh = el('video', {
              controls: true, preload: 'metadata', playsinline: true,
              onerror: function () { loadError = true; render(); }
            });
            fresh.setAttribute('src', src);
          } else if (wantedKind === 'audio') {
            fresh = el('audio', {
              controls: true, preload: 'metadata',
              onerror: function () { loadError = true; render(); }
            });
            fresh.setAttribute('src', src);
          } else if (wantedKind === 'toolarge') {
            fresh = el('div', { className: 'dsh-mp-fallback' });
          } else {
            fresh = el('img', { alt: name, loading: 'lazy', decoding: 'async',
              onerror: function () { loadError = true; render(); } });
            fresh.setAttribute('src', src);
          }
          stageEl.appendChild(fresh);
          stageKind = wantedKind;
          stageSrc = src;
          stageNode = fresh;
        }
        // 已经挂好的元素只更新"可变量"，绝不重建
        if (wantedKind === 'toolarge' && item !== null) {
          stageNode.textContent = '图片较大（' + humanSize(item.size) + '），已跳过内联预览，可直接下载。';
        } else if (wantedKind === 'image') {
          stageNode.setAttribute('alt', name);
        }
      }
      // 体积未知时留空，不用"正在确认"这种阻断式文案
      if (pendingEnrich) sizeText = '';

      // 元信息
      kindEl.textContent = kind || 'media';
      nameEl.textContent = name;
      nameEl.title = candidate.text;
      sizeEl.textContent = sizeText;

      // 按钮
      downloadBtn.replaceChildren();
      downloadBtn.disabled = src === null || busy;
      downloadBtn.title = busy ? '正在保存…' : '保存到本机';
      downloadBtn.appendChild(busy ? el('span', { className: 'dsh-mp-spin' }) : downloadIcon());
      downloadBtn.appendChild(el('span', { text: busy ? '保存中…' : '下载' }));

      openBtn.replaceChildren();
      openBtn.disabled = src === null;
      openBtn.appendChild(openIcon());
      openBtn.appendChild(el('span', { text: '新标签打开' }));

      // 状态行
      var shown = failure !== null ? failure
        : (loadError ? '媒体加载失败：文件可能已被移动，或格式不被浏览器支持。' : loadNote);
      noteEl.textContent = shown === null ? '' : shown;
      noteEl.style.display = shown === null ? 'none' : '';
      var isError = failure !== null || loadError || (entry !== null && entry.status === 'error');
      noteEl.setAttribute('data-tone', isError ? 'error' : 'info');
      cardEl.setAttribute('data-state', isError ? 'error' : 'ok');

      // 出错时给一个「重试」按钮。
      // 为什么需要：卡片状态是内存里的登记结果；宿主侧的限制（例如允许根）可能后来被
      // 修好，但卡片会一直停在 error 上，用户只能整页刷新——这不合理。
      // 重试做的事就是清掉本地记录、重新向宿主问一次。
      var wantRetry = (entry !== null && entry.status === 'error') || loadError;
      if (wantRetry && retryBtn === null) {
        retryBtn = el('button', {
          type: 'button',
          className: 'dsh-mp-btn',
          title: '重新向宿主确认这个文件',
          text: '重试',
          onclick: onRetry
        });
        actsEl.appendChild(retryBtn);
      } else if (!wantRetry && retryBtn !== null) {
        try { retryBtn.remove(); } catch (e) { /* ignore */ }
        retryBtn = null;
      }
    }

    /** 清掉本地记录并重新登记（用于错误态手动恢复）。 */
    function onRetry() {
      loadError = false;
      failure = null;
      REGISTRY.delete(candidate.text);
      render();
      registerPaths([candidate.text]);
    }

    /** 登记结果到达时被调用。 */
    function setEntry(next) {
      entry = next;
      render();
    }

    render();
    return { el: cardEl, setEntry: setEntry, key: candidate.text };
  }

  /** 一组相邻媒体合成一个 family 容器（同一段落里发现的多个路径）。 */
  function MediaFamilyView(candidates) {
    var views = [];
    var hostEl = el('div', { className: 'dsh-mp-family', 'data-dsh-media-host': '1', 'data-dsh-media-build': BUILD });
    for (var i = 0; i < candidates.length; i++) {
      var view = MediaCardView(candidates[i]);
      views.push(view);
      hostEl.appendChild(view.el);
    }
    return {
      el: hostEl,
      /** 把 REGISTRY 里对应 key 的最新状态推给每张卡。 */
      sync: function () {
        for (var i = 0; i < views.length; i++) {
          views[i].setEntry(REGISTRY.get(views[i].key) || null);
        }
      }
    };
  }

  // ─────────────────────────────────────────────────────────── DOM 扫描

  /** 每个宿主容器对应的清理函数：还原被隐藏的节点。 */
  var MOUNTED = new Map();

  /** 找到应承载卡片的正文容器（id=root 是 web 应用的挂载点）。 */
  function transcriptRoot() {
    var root = document.getElementById('root') || document.body;
    // 自报标签挂在 body 下、不在 #root 里，正常不会被扫到；这一层是兜底：
    // 万一它被移进正文区域，也不能参与扫描。
    return root;
  }

  /** 是否是本插件自己产生的节点（自报标签、卡片宿主等）。 */
  function isOwnNode(el) {
    if (el === null || el.nodeType !== 1) return false;
    if (typeof el.closest !== 'function') return false;
    if (el.closest('[data-dsh-media-legend]') !== null) return true;
    if (el.closest('[data-dsh-media-host]') !== null) return true;
    return false;
  }

  /**
   * 本地绝对路径 → 宿主媒体 URL。
   *
   * 这是客户端与宿主之间**唯一的约定**（`/dsh-media/file?path=<encodeURIComponent(绝对路径)>`）。
   * 之所以允许客户端自己拼：预览是只读操作，且宿主对每个请求都会重新做
   * 「扩展名白名单 + realpath + 允许根」三道校验 —— 客户端拼错或伪造路径，
   * 结果只是拿到 403/415，不会绕过任何边界。
   *
   * 这条约定让预览**不依赖那次 /allow 往返**：登记只用来补体积与权威类型。
   * @param {string} path
   * @returns {string}
   */
  function localMediaUrl(path) {
    return API_BASE + '/file?path=' + encodeURIComponent(String(path));
  }

  function isSkippedElement(el) {
    if (el === null || el.nodeType !== 1) return false;
    var tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return true;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    // 代码块（<pre> 及其**后代**）里的路径绝不动 —— 那是用户要复制的原文。
    // 注意后代不只是 <code>：语法高亮会把每个 token 包成 <span>，
    // 所以判据必须是「祖先里有 pre」，不能只看直接父节点。
    // 但**行内代码**（正文里被反引号包住的一小段）不算：模型很爱把路径写成
    // `D:\a\b.png`，把它也跳过的话最自然的写法反而看不到卡片（实测踩过）。
    if (tag === 'PRE') return true;
    if (typeof el.closest === 'function' && el.closest('pre') !== null) return true;
    if (el.isContentEditable === true) return true;
    if (typeof el.closest === 'function') {
      if (el.closest('[data-dsh-media-host]') !== null) return true;
      if (el.closest('.dsh-mmd') !== null) return true;  // 别跟 dsh-mermaid 抢地盘
      if (el.closest('[contenteditable="true"]') !== null) return true;
    }
    return false;
  }

  /** 取最近的"块级"祖先，卡片插在它后面。 */
  function blockAncestor(node, stopAt) {
    var el = node.parentElement;
    var last = null;
    while (el !== null && el !== stopAt) {
      var tag = el.tagName;
      if (tag === 'P' || tag === 'LI' || tag === 'TD' || tag === 'TH' ||
          tag === 'DD' || tag === 'DT' || tag === 'BLOCKQUOTE' || tag === 'DIV' ||
          tag === 'SECTION' || tag === 'ARTICLE' || tag === 'FIGCAPTION') {
        last = el;
        break;
      }
      el = el.parentElement;
    }
    return last;
  }

  /** 一段文本是否"除了路径就没别的了"（用来决定要不要整段藏掉）。 */
  function isPathOnlyText(text) {
    var stripped = String(text || '')
      .replace(RE_LOCAL_PATH, '')
      .replace(RE_HTTP_MEDIA, '')
      .replace(/[\s\u3000:：,，.。;；!！?？\-—–_()（）\[\]【】"'`「」『』]/g, '');
    return stripped === '';
  }

  var scanTimer = null;
  var scanning = false;
  /**
   * 我们自己正在改 DOM 时为 true。MutationObserver 必须据此忽略回调 ——
   * 否则会形成自激循环：我们写 DOM → 观察器触发 → 重新扫描 → 重建卡片 → 再触发……
   * 表现就是页面上文字与图片**不停抖动**（2026-09-13 实测踩到，左边那个自报标签
   * 就是被这个循环反复重建，所以永远停在"扫描 0 轮"）。
   */
  var selfMutating = false;

  /**
   * 上一轮扫描的指纹：正文里出现过的候选文本（排序后拼接）。
   * 内容没变就整轮跳过，避免无意义的重建 —— 这是抖动的第二道防线。
   */
  var lastSignature = null;

  function scheduleScan() {
    if (scanTimer !== null) return;
    scanTimer = setTimeout(function () {
      scanTimer = null;
      try { scan(); } catch (e) { warn('扫描失败', e && e.message); }
    }, SCAN_DEBOUNCE_MS);
  }

  function scan() {
    if (scanning) return;
    scanning = true;
    selfMutating = true;
    STATS.scans += 1;
    var candidateCount = 0;
    var groupCount = 0;
    var cardCount = 0;
    try {
      var root = transcriptRoot();
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
          var text = node.nodeValue;
          if (text === null || text.length < 5) return NodeFilter.FILTER_REJECT;
          if (!/\.(?:png|jpe?g|webp|gif|bmp|avif|svg|ico|mp4|m4v|webm|ogv|mov|mkv|mp3|m4a|aac|wav|flac|ogg|oga|opus|weba)\b/i.test(text)) {
            return NodeFilter.FILTER_REJECT;
          }
          var parent = node.parentElement;
          if (parent === null) return NodeFilter.FILTER_REJECT;
          if (isSkippedElement(parent)) return NodeFilter.FILTER_REJECT;
          // 本插件自己的节点（自报标签等）绝不参与扫描 —— 它们的文本里也有
          // 插件名与路径，扫到就是自噬。
          if (isOwnNode(parent)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });

      /** @type {Map<Element, {candidates: object[], nodes: Text[], textNodes: Text[]}>} */
      var groups = new Map();
      var nodes = [];
      var n;
      while ((n = walker.nextNode()) !== null) nodes.push(n);

      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        // React 可能已经重建过这个文本节点：只有仍挂在文档里的才算数
        if (!node.isConnected) continue;
        var candidates = extractCandidates(node.nodeValue || '');
        if (candidates.length === 0) continue;
        var block = blockAncestor(node, root);
        if (block === null) continue;
        if (block.closest === undefined || block.closest('[data-dsh-media-host]') !== null) continue;
        var group = groups.get(block);
        if (group === undefined) {
          group = { candidates: [], nodes: [], textNodes: [] };
          groups.set(block, group);
        }
        group.nodes.push(node);
        group.textNodes.push(node);
        for (var c = 0; c < candidates.length; c++) {
          var candidate = candidates[c];
          var dup = false;
          for (var g = 0; g < group.candidates.length; g++) {
            if (group.candidates[g].text === candidate.text) { dup = true; break; }
          }
          if (!dup) group.candidates.push(candidate);
        }
      }

      var localPaths = [];
      /** 本轮正文里出现的候选（排序后拼成指纹，用于判断"内容真的变了吗"）。 */
      var signatureParts = [];

      groups.forEach(function (group, block) {
        // React 若已把该块拆掉，放弃这一组（下次扫描会重新发现）
        if (!block.isConnected) return;

        var candidateKey = group.candidates.map(function (c) { return c.text; }).sort().join('\u0001');
        signatureParts.push(candidateKey);
        candidateCount += group.candidates.length;
        groupCount += 1;

        // ② 收起旧卡片（同一块可能因 React 重渲染换了承载节点）
        var stale = block.nextElementSibling;
        var existing = stale !== null && stale.dataset.dshMediaHost === '1' ? stale : null;

        // 内容与上一轮完全一致 → 什么都不动。
        // 这是防抖动的关键：重建卡片会让 <img> 重新加载并闪烁，也会再次触发
        // MutationObserver。只有指纹变了才值得重建（2026-09-13 实测：没有这道
        // 判断时页面会自激循环，文字与图片一直在抖）。
        if (existing !== null && existing.dataset.dshMediaKey === candidateKey) {
          if (block.parentNode === null) return;
          for (var q = 0; q < group.candidates.length; q++) {
            if (group.candidates[q].remote !== true) localPaths.push(group.candidates[q].text);
          }
          return;
        }

        // ① 让路径文本从正文里消失，但不删任何 React 节点。
        //    文本节点本身不能设 style，所以套一层我们的 span 再 display:none；
        //    卸载时只移除这一层 span 并把文本节点放回原位 —— React 只管自己的
        //    子节点集合，多余的包装节点不影响它后续的 diff/removeChild。
        var hidden = [];
        for (var t = 0; t < group.textNodes.length; t++) {
          var tn = group.textNodes[t];
          if (!tn.isConnected) continue;
          var parent = tn.parentNode;
          if (parent === null) continue;
          // 行内代码（<code> 只装了这一个路径文本）：整块藏掉，不留空的代码框。
          // 只藏 display，不删节点 —— React 若重建该 code，还原逻辑是 no-op。
          var codeHost = tn.parentElement !== null && tn.parentElement.tagName === 'CODE'
            && tn.parentElement.childNodes.length === 1
            && isPathOnlyText(tn.nodeValue || '')
            ? tn.parentElement
            : null;
          if (codeHost !== null) {
            var prevDisplay = codeHost.style.display || '';
            codeHost.style.display = 'none';
            hidden.push({ veil: null, text: null, displayHost: codeHost, prevDisplay: prevDisplay });
            continue;
          }
          var veil = document.createElement('span');
          veil.dataset.dshMediaVeil = '1';
          veil.style.display = 'none';
          try {
            parent.insertBefore(veil, tn);
            veil.appendChild(tn);
            hidden.push({ veil: veil, text: tn, parent: parent });
          } catch (e) {
            try { veil.remove(); } catch (e2) {}
          }
        }

        if (existing !== null) unmountHost(existing);

        // ③ 挂新卡片：插在块之后
        var host = document.createElement('div');
        host.dataset.dshMediaHost = '1';
        host.dataset.dshMediaKey = candidateKey;
        if (block.parentNode === null) return;
        block.parentNode.insertBefore(host, block.nextSibling);
        MOUNTED.set(host, { veils: hidden });
        mountFamily(host, group.candidates);

        for (var p = 0; p < group.candidates.length; p++) {
          if (group.candidates[p].remote !== true) localPaths.push(group.candidates[p].text);
        }
      });

      var signature = signatureParts.sort().join('\u0002');
      STATS.lastSignatureChanged = signature !== lastSignature;
      lastSignature = signature;

      // 记录本轮真实读数（之前只在 apply 时刷新，所以浮层永远停在"扫描 0 轮"——
      // 一个显示错数字的诊断装置比没有更糟）。
      STATS.candidates = candidateCount;
      STATS.groups = groupCount;
      STATS.cards = MOUNTED.size;

      if (localPaths.length > 0) registerPaths(localPaths);
    } catch (e) {
      STATS.lastError = (e && e.message) || String(e);
      warn('扫描失败', STATS.lastError);
    } finally {
      scanning = false;
      markApplied('scan:done');
      // 观察器回调是微任务，会在本轮同步 DOM 操作之后才跑；用一个延时把
      // "自己造成的变更"这段时间标记干净，避免自激循环。
      setTimeout(function () { selfMutating = false; }, 0);
    }
  }

  /**
   * 往宿主容器里挂一组卡片（纯 DOM，见上面 MediaFamilyView）。
   * 失败只影响这一组卡片，不会连累正文。
   */
  function mountFamily(host, candidates) {
    try {
      var family = MediaFamilyView(candidates);
      host.appendChild(family.el);
      host.__dshMediaFamily = family;
      family.sync();
    } catch (e) {
      warn('渲染卡片失败', e && e.message);
      host.textContent = '媒体预览渲染失败：' + ((e && e.message) || e);
    }
  }

  function unmountHost(host) {
    var record = MOUNTED.get(host);
    if (record !== undefined) {
      // 把被藏起来的文本节点放回原父节点，然后丢掉包装 span（行内 code 则还原 display）
      for (var i = 0; i < record.veils.length; i++) {
        var entry = record.veils[i];
        try {
          if (entry.displayHost !== undefined) {
            entry.displayHost.style.display = entry.prevDisplay || '';
            continue;
          }
          if (entry.text.isConnected && entry.parent.isConnected) {
            entry.parent.insertBefore(entry.text, entry.veil);
          }
          entry.veil.remove();
        } catch (e) { /* 父节点可能已被 React 拆掉，忽略 */ }
      }
      MOUNTED.delete(host);
    }
    try {
      host.remove();
    } catch (e) {
      try { host.textContent = ''; } catch (e2) {}
    }
  }

  /** 会话切换时清空已挂卡片，避免新会话正文里出现上一个会话的残留。 */
  function unmountAll() {
    var hosts = document.querySelectorAll('[data-dsh-media-host]');
    for (var i = 0; i < hosts.length; i++) unmountHost(hosts[i]);
    MOUNTED.clear();
  }

  /** 把 REGISTRY 的最新状态推给每个已挂载的卡片（登记回包到达后调用）。 */
  function repaintAll() {
    MOUNTED.forEach(function (record, host) {
      if (host.__dshMediaFamily !== undefined) {
        try { host.__dshMediaFamily.sync(); } catch (e) { /* 单张卡失败不影响其他 */ }
      }
    });
  }

  // ─────────────────────────────────────────────── 「最近生成」面板（需求 B）
  //
  // 需求原话："不管对话里有没有路径，只要工作区里生成了新图片，就能在界面上翻看并下载"。
  // 所以这一块**完全不依赖对话文本、不依赖模型写路径**：点按钮 → 调宿主 /recent →
  // 列出工作区里最近的媒体文件 → 缩略图 + 下载。
  //
  // 面板用纯 DOM 实现（不进 React 树），理由同卡片：少一条失败路径，
  // 而且浮层需要脱离输入框的 overflow 裁剪。

  var PANEL_CSS = [
    '.dsh-mr-btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;',
    'border:0;border-radius:999px;flex:none;white-space:nowrap;font-family:inherit;font-size:12px;line-height:1;',
    'background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));color:var(--dsw-alias-label-primary,inherit);cursor:pointer}',
    '.dsh-mr-btn:hover{background:var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.28))}',
    '.dsh-mr-btn>svg{display:block;width:14px;height:14px;flex:none}',
    '.dsh-mr-mask{position:fixed;inset:0;z-index:2147482000;background:rgba(0,0,0,.45)}',
    '.dsh-mr-panel{position:fixed;z-index:2147482001;left:50%;top:50%;transform:translate(-50%,-50%);',
    'width:min(880px,calc(100vw - 32px));height:min(640px,calc(100vh - 80px));display:flex;flex-direction:column;',
    'border-radius:14px;overflow:hidden;border:1px solid var(--dsw-alias-border-l2,#2a2f37);',
    'background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-3,#1b1e24));color:var(--dsw-alias-label-primary,#e6e8ec);',
    'box-shadow:0 18px 60px rgba(0,0,0,.42);font:13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}',
    '.dsh-mr-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,#2a2f37)}',
    '.dsh-mr-title{font-size:14px;font-weight:600}',
    '.dsh-mr-count{color:var(--dsw-alias-label-secondary,#98a2b3);font-size:12px}',
    '.dsh-mr-spacer{flex:1 1 auto}',
    '.dsh-mr-close{width:28px;height:28px;padding:0;justify-content:center;font-size:14px}',
    '.dsh-mr-body{flex:1 1 auto;overflow:auto;padding:14px}',
    '.dsh-mr-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}',
    '.dsh-mr-item{display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:10px;min-width:0;',
    'border:1px solid var(--dsw-alias-border-l2,#2a2f37);background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06))}',
    '.dsh-mr-thumb{position:relative;display:flex;align-items:center;justify-content:center;width:100%;height:120px;',
    'border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.12))}',
    '.dsh-mr-thumb>img,.dsh-mr-thumb>video{width:100%;height:100%;object-fit:cover;display:block}',
    '.dsh-mr-ph{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#98a2b3)}',
    '.dsh-mr-name{font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dsh-mr-sub{font-size:11px;color:var(--dsw-alias-label-secondary,#98a2b3);font-variant-numeric:tabular-nums}',
    '.dsh-mr-acts{display:flex;gap:6px;margin-top:auto}',
    '.dsh-mr-act{flex:1 1 0;height:26px;padding:0 8px;border:0;border-radius:8px;cursor:pointer;font-family:inherit;font-size:12px;',
    'background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));color:var(--dsw-alias-label-primary,inherit)}',
    '.dsh-mr-act:hover{background:var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.28))}',
    '.dsh-mr-act[data-primary]{background:var(--dsw-alias-button-primary-fill,#4d6bfe);color:var(--dsw-alias-label-primary-foreground,#fff)}',
    '.dsh-mr-msg{padding:18px;text-align:center;color:var(--dsw-alias-label-secondary,#98a2b3)}',
    '.dsh-mr-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147482002;',
    'padding:8px 14px;border-radius:10px;font-size:12.5px;background:var(--dsw-specific-menu,#1b1e24);',
    'border:1px solid var(--dsw-alias-border-l2,#2a2f37);color:var(--dsw-alias-label-primary,#e6e8ec);box-shadow:0 8px 24px rgba(0,0,0,.35)}'
  ].join('');

  function ensurePanelCss() {
    try {
      if (document.querySelector('style[data-plugin-css="' + HOST + '-panel"]') !== null) return;
      var tag = document.createElement('style');
      tag.dataset.plugin = HOST;
      tag.dataset.pluginCss = HOST + '-panel';
      tag.textContent = PANEL_CSS;
      document.head.appendChild(tag);
    } catch (e) { /* 样式失败不该阻断功能 */ }
  }

  /** 底部轻提示（面板内的下载反馈用）。 */
  var toastTimer = null;
  function toast(text) {
    try {
      var prev = document.getElementById('dsh-mr-toast');
      if (prev !== null) prev.remove();
      var node = document.createElement('div');
      node.id = 'dsh-mr-toast';
      node.className = 'dsh-mr-toast';
      node.setAttribute('role', 'status');
      node.textContent = text;
      document.body.appendChild(node);
      if (toastTimer !== null) clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { try { node.remove(); } catch (e) {} }, 3200);
    } catch (e) { /* ignore */ }
  }

  function relTime(ms) {
    try {
      var d = Date.now() - Number(ms);
      if (!isFinite(d) || d < 0) return '';
      if (d < 60e3) return '刚刚';
      if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
      if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前';
      return Math.floor(d / 86400e3) + ' 天前';
    } catch (e) { return ''; }
  }

  /**
   * 用 XHR 拉 JSON。本地回环请求下 XHR 一定会以 load/error/timeout 结束，
   * 不像 fetch 那样可能既不 resolve 也不 reject（实测踩过这个坑）。
   */
  function requestJson(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        try { xhr.abort(); } catch (e) { /* ignore */ }
        reject(new Error('请求超时'));
      }, timeoutMs || 30000);
      xhr.open('GET', url, true);
      xhr.onload = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (xhr.status < 200 || xhr.status >= 300) { reject(new Error('HTTP ' + xhr.status)); return; }
        try { resolve(JSON.parse(xhr.responseText)); } catch (e) { reject(new Error('响应不是合法 JSON')); }
      };
      xhr.onerror = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('网络错误'));
      };
      xhr.send(null);
    });
  }

  /** 面板状态（单例）。 */
  var panel = { root: null, body: null, count: null, items: [], loading: false, onKey: null };

  function closePanel() {
    if (panel.root === null) return;
    try {
      panel.root.mask.remove();
      panel.root.panel.remove();
    } catch (e) { /* ignore */ }
    panel.root = null;
    panel.body = null;
    panel.count = null;
    if (panel.onKey !== null) document.removeEventListener('keydown', panel.onKey, true);
  }

  function gridIcon() {
    return icon([
      'M2.6 3.4h4.2v4.2H2.6z', 'M9.2 3.4h4.2v4.2H9.2z',
      'M2.6 9.2h4.2v4.2H2.6z', 'M9.2 9.2h4.2v4.2H9.2z'
    ]);
  }

  /** 下载：优先「另存为」让用户选位置；否则 XHR blob；最后交给浏览器。 */
  function downloadFromPanel(item, btn) {
    var url = item.url + '&dl=1&name=' + encodeURIComponent(item.name);
    var original = btn.textContent;
    btn.disabled = true;
    btn.textContent = '保存中…';
    var done = function (note) {
      btn.disabled = false;
      btn.textContent = original;
      if (note !== undefined) toast(note);
    };

    if (typeof window.showSaveFilePicker === 'function') {
      pickSaveHandle(item.name).then(function (handle) {
        if (handle === null) { done(); return; }
        return fetchBlob(url).then(function (blob) {
          return handle.createWritable().then(function (w) {
            return w.write(blob).then(function () { return w.close(); });
          });
        }).then(function () { done('已保存：' + item.name); })
          .catch(function (e) { done('保存失败：' + ((e && e.message) || e)); });
      });
      return;
    }

    fetchBlob(url).then(function (blob) {
      var objectUrl = URL.createObjectURL(blob);
      anchorDownload(objectUrl, item.name);
      setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 30000);
      done('已下载：' + item.name);
    }).catch(function () {
      anchorDownload(url, item.name);
      done();
    });
  }

  /** 单个条目：缩略图 + 名称 + 体积/时间 + 下载/打开。 */
  function buildRecentItem(item) {
    var thumb;
    if (item.kind === 'image') {
      thumb = el('img', { alt: item.name, loading: 'lazy', decoding: 'async' });
      thumb.setAttribute('src', item.url);
    } else if (item.kind === 'video') {
      thumb = el('video', { preload: 'metadata', muted: true, playsinline: true });
      thumb.setAttribute('src', item.url);
    } else {
      thumb = el('span', { className: 'dsh-mr-ph', text: 'audio' });
    }

    var downloadBtn = el('button', {
      type: 'button', className: 'dsh-mr-act', 'data-primary': '', text: '下载',
      onclick: function () { downloadFromPanel(item, downloadBtn); }
    });
    var openBtn = el('button', {
      type: 'button', className: 'dsh-mr-act', text: '打开',
      onclick: function () { window.open(item.url, '_blank', 'noopener'); }
    });

    return el('div', { className: 'dsh-mr-item' }, [
      el('div', { className: 'dsh-mr-thumb' }, [thumb]),
      el('div', { className: 'dsh-mr-name', title: item.path, text: item.name }),
      el('div', { className: 'dsh-mr-sub', text: humanSize(item.size) + ' · ' + relTime(item.mtimeMs) }),
      el('div', { className: 'dsh-mr-acts' }, [downloadBtn, openBtn])
    ]);
  }

  function renderRecent() {
    if (panel.body === null) return;
    panel.body.replaceChildren();
    if (panel.items.length === 0) {
      panel.body.appendChild(el('div', {
        className: 'dsh-mr-msg',
        text: '在工作区里没找到图片 / 视频 / 音频文件。'
      }));
      return;
    }
    var grid = el('div', { className: 'dsh-mr-grid' });
    for (var i = 0; i < panel.items.length; i++) grid.appendChild(buildRecentItem(panel.items[i]));
    panel.body.appendChild(grid);
  }

  function loadRecent() {
    if (panel.loading) return;
    panel.loading = true;
    if (panel.body !== null) {
      panel.body.replaceChildren(el('div', { className: 'dsh-mr-msg', text: '正在读取工作区…' }));
    }
    requestJson(API_BASE + '/recent?limit=200').then(function (body) {
      panel.loading = false;
      panel.items = Array.isArray(body && body.items) ? body.items : [];
      if (panel.count !== null) panel.count.textContent = '共 ' + panel.items.length + ' 个';
      renderRecent();
    }).catch(function (e) {
      panel.loading = false;
      if (panel.body === null) return;
      panel.body.replaceChildren(el('div', {
        className: 'dsh-mr-msg',
        text: '读取失败：' + ((e && e.message) || e)
      }));
    });
  }

  function openPanel() {
    ensurePanelCss();
    if (panel.root !== null) { loadRecent(); return; }

    var mask = el('div', { className: 'dsh-mr-mask', onclick: closePanel });
    var count = el('span', { className: 'dsh-mr-count', text: '' });
    var refreshBtn = el('button', { type: 'button', className: 'dsh-mr-btn', text: '刷新', onclick: loadRecent });
    var closeBtn = el('button', {
      type: 'button', className: 'dsh-mr-btn dsh-mr-close', title: '关闭（Esc）', text: '✕', onclick: closePanel
    });
    var body = el('div', { className: 'dsh-mr-body' });
    var panelEl = el('div', { className: 'dsh-mr-panel', role: 'dialog', 'aria-label': '最近生成的媒体' }, [
      el('div', { className: 'dsh-mr-head' }, [
        el('span', { className: 'dsh-mr-title', text: '最近生成' }),
        count,
        el('span', { className: 'dsh-mr-spacer' }),
        refreshBtn,
        closeBtn
      ]),
      body
    ]);

    panel.onKey = function (e) { if (e && e.key === 'Escape') { e.stopPropagation(); closePanel(); } };
    document.addEventListener('keydown', panel.onKey, true);

    document.body.appendChild(mask);
    document.body.appendChild(panelEl);
    panel.root = { mask: mask, panel: panelEl };
    panel.body = body;
    panel.count = count;
    loadRecent();
  }

  /**
   * 底栏按钮（注册到 conversation.input.left 槽位）。
   *
   * ⚠️ 必须返回 **React 元素**，不能是原生 DOM 节点。
   * 槽位是 React 渲染的（renderSlot → react_jsx_runtime），给它 DOM 节点会渲染失败，
   * 表现是"按钮根本不出现、也没有可见报错"（2026-09-13 实测踩到）。
   * 面板内部仍用纯 DOM（它挂在 document.body 上、不在 React 树里），两者互不影响。
   */
  function RecentButton() {
    var React = null;
    try { React = require('react'); } catch (e) { React = null; }
    if (!React) return null;
    var iconEl = React.createElement(
      'svg',
      { key: 'icon', viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      [
        React.createElement('rect', { key: 'a', x: 2.6, y: 3.4, width: 4.2, height: 4.2, rx: 0.6 }),
        React.createElement('rect', { key: 'b', x: 9.2, y: 3.4, width: 4.2, height: 4.2, rx: 0.6 }),
        React.createElement('rect', { key: 'c', x: 2.6, y: 9.2, width: 4.2, height: 4.2, rx: 0.6 }),
        React.createElement('rect', { key: 'd', x: 9.2, y: 9.2, width: 4.2, height: 4.2, rx: 0.6 })
      ]
    );
    return React.createElement(
      'button',
      {
        type: 'button',
        className: 'dsh-mr-btn',
        title: '查看工作区里最近生成的图片 / 视频 / 音频',
        'aria-label': '最近生成',
        onClick: function () { openPanel(); }
      },
      [iconEl, React.createElement('span', { key: 'label' }, '最近生成')]
    );
  }

  // ─────────────────────────────────────────────────────────── 装配

  function apply(ctx) {
    ensureCss();
    // 自报装置要**先**装：这样"模块加载了但后面某步抛错"也能在页面上看出来
    // （此时标记会停在 phase=apply:error，而不是像以前那样静默什么都不发生）。
    markApplied('apply:start');
    try { require('react'); } catch (e) { /* 无所谓，卡片渲染不依赖它 */ }

    // 底栏「最近生成」按钮 —— 需求 B 的入口。
    // 用 conversation.input.left（DSH 预留、官方未占用的插件槽位），
    // 与 dsh-composer-upload 用的是同一个槽，互不冲突。
    try {
      if (ctx.slots !== undefined && typeof ctx.slots.inject === 'function') {
        ctx.slots.inject('conversation.input.left', function () {
          return ctx.slots.register(
            { name: 'conversation.input.left', id: 'media-recent', order: 90, label: '最近生成' },
            RecentButton
          );
        });
        log('已注册「最近生成」按钮（conversation.input.left）');
      } else {
        warn('ctx.slots 不可用，「最近生成」按钮未注册');
      }
    } catch (e) {
      warn('注册「最近生成」按钮失败', e && e.message);
    }

    ctx.effect(function () {
      var observer = new MutationObserver(function (mutations) {
        // 有我们自己造成的变更 → 这一批全部忽略。
        // 没有这道闸，就会自激循环（我们写 DOM → 观察器 → 重扫 → 重建 → 再触发），
        // 表现为页面上文字与图片不停抖动。
        if (selfMutating) return;
        for (var i = 0; i < mutations.length; i++) {
          var target = mutations[i].target;
          if (target === null) continue;
          var el = target.nodeType === 1 ? target : target.parentElement;
          if (el !== null && el.closest !== undefined
              && el.closest('[data-dsh-media-host]') !== null) continue;
          scheduleScan();
          return;
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });

      var onKey = function (e) {
        if (e && e.altKey && (e.key === 'm' || e.key === 'M')) {
          unmountAll();
          setTimeout(scan, 0);
        }
      };
      var onRefresh = function () {
        unmountAll();
        setTimeout(scan, 0);
      };
      document.addEventListener('keydown', onKey);
      document.addEventListener('dsh-media-refresh', onRefresh);
      scheduleScan();

      return function () {
        observer.disconnect();
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('dsh-media-refresh', onRefresh);
        unmountAll();
      };
    }, 'dsh-media-preview.scan');

    markApplied('apply:ok');
    log('媒体预览已装配（构建=' + BUILD + '）');
  }

  window.__ModuleLoader__.load({
    id: HOST,
    factory: function (require) {
      var module = { exports: {} };
      var exports = module.exports;

      exports.name = HOST;
      // 只依赖槽位系统（虽然本插件主要做 DOM 后处理，保留 slots 便于未来接动作条）。
      exports.inject = ['slots'];
      exports.apply = apply;

      exports.__internals = {
        BUILD: BUILD,
        extractCandidates: extractCandidates,
        fileUrlToPath: fileUrlToPath,
        isSkippedElement: isSkippedElement,
        trimTrailingPunctuation: trimTrailingPunctuation,
        kindOfPath: kindOfPath,
        isPathOnlyText: isPathOnlyText,
        humanSize: humanSize,
        registry: REGISTRY,
        scan: scan,
        unmountAll: unmountAll,
        markApplied: markApplied,
        repaintAll: repaintAll,
        /**
         * 往容器里渲染一组卡片并同步登记状态。暴露给测试用：卡片是纯 DOM 实现，
         * 给一个最小 document 替身就能在 Node 里断言真实结构。
         */
        renderFamilyInto: function (container, candidates) {
          var family = MediaFamilyView(candidates);
          container.appendChild(family.el);
          // 与真实扫描路径保持同一套契约：登记到 MOUNTED，并把 family 挂在容器上，
          // 这样 repaintAll() 也能刷到它（测试与生产走的是同一条路）。
          container.dataset.dshMediaHost = '1';
          container.__dshMediaFamily = family;
          MOUNTED.set(container, { veils: [] });
          family.sync();
          return family;
        }
      };
      return module.exports;
    }
  });
})();
