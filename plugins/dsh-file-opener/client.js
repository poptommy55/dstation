/**
 * dsh-file-opener —— 浏览器半。
 *
 * 干什么：扫描对话里的块级元素，把其中的**本地绝对路径**变成可点击入口：
 *   · 点文件名   → 调官方 RPC `session.openWorkspacePath`（系统默认程序打开）
 *   · 点文件夹图标 → 打开所在目录（"在文件夹中显示"）
 *
 * 三条刻意的设计取舍（都是踩过的坑换来的，别随手改）：
 *
 *  1. **不改正文的文字节点，只在块后面追加兄弟节点。** 对话在流式输出时
 *     文字节点每个 token 都在变，把一段文本拆成「前/中/后」三个节点会与 React
 *     的协调打架（重复渲染/丢节点）。`dsh-media-preview` 用的也是"块后挂节点"，
 *     这条路已经被验证过（技能坑 #4 的同族教训：**渲染必须幂等**）。
 *
 *  2. **只处理"确实存在"的路径。** 先把候选路径批量送到宿主 `/check` 校验，
 *     不存在的路径不装饰 —— 否则每个像路径的字符串都长出一条按钮，比不做好。
 *
 *  3. **不与兄弟插件抢地盘。** 跳过 media-preview 的卡片、mermaid 的渲染结果、
 *     富文本编辑器与输入区（这几条抄自 media-preview 的跳过谓词，实测有效）。
 */

(function () {
  window.__ModuleLoader__.load({
    id: 'dsh-file-opener',
    factory: function (require) {
      var module = { exports: {} };
      var exports = module.exports;

      /** 构建号：改代码必须 +1，并写进 DOM 与 <style>，否则无法判断用户跑的是哪版。 */
      var BUILD = 'v5-20260919-select-in-explorer';
      var HOST = 'dsh-file-opener';

      /** 状态：写进 <html data-dsfo-*>，浏览器半"看不见"，只能靠它取证。 */
      var STATS = {
        scans: 0,
        blocks: 0,
        candidates: 0,
        resolved: 0,
        decorated: 0,
        clicks: 0,
        openErrors: 0,
        revealErrors: 0,
        checkErrors: 0
      };

      var CAPABILITY = 'unknown'; // unknown | yes | no
      var lastTransportError = null;
      var transportCooldownUntil = 0;

      /** 诊断上报节流窗口；被节流的会补发，不丢。 */
      var REPORT_THROTTLE_MS = 5000;
      var pendingReportReason = null;
      var reportTimer = null;

      /** path -> {ok, kind, name, size, ext, path} ; 只缓存宿主给出的确定答案。 */
      var checkCache = new Map();
      /** 正在请求中的路径。 */
      var pending = new Set();

      var selfMutating = false;
      var scheduled = false;
      var scanTimer = null;
      var lastFingerprint = '';
      var lastReportAt = 0;

      //#region ── DOM 小工具 ────────────────────────────────────────────────

      /**
       * 建元素。注意：替身 DOM 里 setAttribute('class') 不会自动变成 className，
       * 所以这里显式处理 className（测试替身也按同一语义实现）。
       */
      function el(tag, attrs, text) {
        var node = document.createElement(tag);
        if (attrs) {
          for (var key in attrs) {
            if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
            if (attrs[key] === null || attrs[key] === undefined) continue;
            if (key === 'className') node.className = attrs[key];
            else node.setAttribute(key, String(attrs[key]));
          }
        }
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
      }

      /** 这个元素是否属于「别人的地盘」——绝不在这些地方插节点。 */
      function isForeign(el2) {
        if (!el2 || typeof el2.closest !== 'function') return false;
        var rules = [
          '[data-dsfo-bar]',              // 自己的产物
          '[data-dsh-media-host]',        // dsh-media-preview 的卡片
          '.dsh-mmd',                     // dsh-mermaid 的渲染结果
          '.cm-editor',                   // CodeMirror（侧栏编辑器）
          '[contenteditable="true"]',     // 输入区
          'script', 'style', 'textarea', 'input', 'select'
        ];
        for (var i = 0; i < rules.length; i++) {
          if (el2.closest(rules[i]) !== null) return true;
        }
        return false;
      }

      /** 已装饰过的块（含其祖先）直接跳过，避免嵌套块重复出条。 */
      function alreadyDone(el2) {
        return typeof el2.closest === 'function' && el2.closest('[data-dsfo-done]') !== null;
      }

      //#endregion

      //#region ── 路径识别（纯函数，可单测） ──────────────────────────────

      /** 形如 C:\...\name.ext 或 C:/.../name.ext；不含空白与常见分隔标点。 */
      var INLINE_ABS = /[A-Za-z]:[\\/][^\s"'`<>|?*\r\n]*\.[A-Za-z0-9]{1,8}/g;
      /** 整行就是一个路径（模型最常见的写法：代码块里单独一行）。 */
      var WHOLE_LINE_ABS = /^["'`]?([A-Za-z]:[\\/].+\.[A-Za-z0-9]{1,8})["'`]?$/;
      /** 一段路径最长多少字符（防畸形文本）。 */
      var MAX_PATH_LEN = 512;

      /**
       * 从一个块的文本里提取候选绝对路径。
       *
       * 两条规则并用：
       *  ① **整行即路径** —— 允许文件名带空格（"我的 报告.docx"）。这是代码块里的主场景。
       *  ② **行内路径** —— 不允许空格，避免把后面的正文一起吃进来。
       *
       * @param {string} text
       * @returns {string[]} 去重后的候选路径
       */
      function extractPaths(text) {
        var found = [];
        var seen = new Set();
        var lines = String(text || '').split(/\r?\n/);

        var push = function (candidate) {
          var value = String(candidate || '').trim().replace(/[.,;:)\]]+$/, '');
          if (value.length === 0 || value.length > MAX_PATH_LEN) return;
          var key = value.toLowerCase();
          if (seen.has(key)) return;
          seen.add(key);
          found.push(value);
        };

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (line.length === 0) continue;

          var whole = WHOLE_LINE_ABS.exec(line);
          if (whole !== null) {
            push(whole[1]);
            continue; // 整行已经吃掉了，不再做行内匹配（否则空格文件名会被截断）
          }

          INLINE_ABS.lastIndex = 0;
          var match;
          while ((match = INLINE_ABS.exec(line)) !== null) push(match[0]);
        }
        return found;
      }

      //#endregion

      //#region ── 与宿主通信 ─────────────────────────────────────────────

      /** 相对路径 fetch 自己的宿主路由是本项目的标准通信方式（不是"外联"）。 */
      function postJson(url, payload, timeoutMs, onDone) {
        var xhr = new XMLHttpRequest();
        var settled = false;
        var finish = function (result) {
          if (settled) return;
          settled = true;
          onDone(result);
        };
        try {
          xhr.open('POST', url, true);
          xhr.timeout = timeoutMs;
          xhr.setRequestHeader('content-type', 'application/json');
          xhr.onload = function () {
            var parsed = null;
            try {
              parsed = JSON.parse(xhr.responseText);
            } catch {
              parsed = null;
            }
            if (xhr.status >= 200 && xhr.status < 300) {
              finish({ ok: true, status: xhr.status, body: parsed });
              return;
            }
            // 🔴 4xx/5xx **也要把宿主的说明捞出来**。
            // 只显示 "HTTP 403" 等于把"为什么失败"丢掉，用户只能看到一句无用的话。
            var detail = parsed && (parsed.message || parsed.error);
            finish({
              ok: false,
              status: xhr.status,
              body: parsed,
              error: detail || ('HTTP ' + xhr.status)
            });
          };
          xhr.onerror = function () { finish({ ok: false, error: '网络错误' }); };
          xhr.ontimeout = function () { finish({ ok: false, error: '超时 ' + timeoutMs + 'ms' }); };
          xhr.send(JSON.stringify(payload));
        } catch (error) {
          finish({ ok: false, error: String((error && error.message) || error) });
        }
      }

      /**
       * 批量校验路径是否存在。
       * 失败**不写缓存**（坑 #17：记住一次失败就再也不会重试），只记冷却时间。
       */
      function ensureChecks(paths) {
        var missing = [];
        for (var i = 0; i < paths.length; i++) {
          var p = paths[i];
          if (checkCache.has(p) || pending.has(p)) continue;
          if (missing.length >= 40) break;
          missing.push(p);
        }
        if (missing.length === 0) return;
        if (Date.now() < transportCooldownUntil) return;

        for (var j = 0; j < missing.length; j++) pending.add(missing[j]);

        postJson('/dsh-file-opener/check', { paths: missing }, 8000, function (result) {
          for (var k = 0; k < missing.length; k++) pending.delete(missing[k]);
          if (!result.ok) {
            STATS.checkErrors += 1;
            lastTransportError = result.error;
            transportCooldownUntil = Date.now() + 5000;
            // 必须把失败同步进 DOM 诊断属性：只记在内存变量里的失败，
            // 排查时等于不存在（技能坑 #8：显示错误数字的诊断装置比没有更糟）。
            setPhase('check:error');
            report('check:error');
            return;
          }
          var items = (result.body && result.body.items) || [];
          for (var m = 0; m < items.length; m++) {
            var item = items[m];
            if (!item || typeof item.asked !== 'string') continue;
            if (item.ok) {
              checkCache.set(item.asked, item);
              STATS.resolved += 1;
            } else if (item.code === 'not_found' || item.code === 'denied_path' ||
                       item.code === 'outside_roots' || item.code === 'no_root') {
              // 宿主给了**确定**的否定答案：缓存它，不再重复问
              checkCache.set(item.asked, { ok: false, code: item.code, message: item.message });
            }
            // 其它错误（400/500 等）不缓存，下次还能重试
          }
          lastTransportError = null;
          report('check:done');
          schedule(0);
        });
      }

      /**
       * 上报诊断（分来源分槽，坑 #39）。节流 5 秒。
       *
       * ⚠️ 被节流掉的上报**必须补发**，不能直接丢弃。
       * 实测踩到：`apply()` 一上报「能力探测」就把窗口占满，300ms 后
       * 「扫描完成」那次上报正好落在窗口里被丢掉；此后 DOM 不再变化 ⇒
       * 宿主侧**永远只有那一份能力探测读数**，扫描结果（候选数/出条数）
       * 一个都看不到。诊断装置自己把证据吞了 —— 与坑 #8 是同一个病。
       */
      function report(reason, force) {
        var now = Date.now();
        if (force !== true && now - lastReportAt < REPORT_THROTTLE_MS) {
          pendingReportReason = reason;
          if (reportTimer === null) {
            reportTimer = setTimeout(function () {
              reportTimer = null;
              var queued = pendingReportReason;
              pendingReportReason = null;
              if (queued !== null) report(queued, true);
            }, Math.max(0, REPORT_THROTTLE_MS - (Date.now() - lastReportAt)) + 50);
          }
          return;
        }
        lastReportAt = now;
        postJson('/dsh-file-opener/report', {
          source: 'client',
          build: BUILD,
          reason: reason,
          phase: document.documentElement.getAttribute('data-dsfo-phase'),
          capability: CAPABILITY,
          stats: STATS,
          transportError: lastTransportError,
          cacheSize: checkCache.size,
          href: location.href
        }, 5000, function () { /* 上报失败无所谓 */ });
      }

      //#endregion

      //#region ── 装饰 ──────────────────────────────────────────────────

      /** 元素清单：只扫这些块级标签。 */
      var BLOCK_SELECTOR = 'pre, p, li, td, blockquote, h1, h2, h3, h4, h5, h6';

      function style() {
        if (document.querySelector('style[data-dsfo-css="1"]') !== null) return;
        var css = [
          '[data-dsfo-bar]{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0 10px;padding:0}',
          '[data-dsfo-chip],[data-dsfo-folder]{display:inline-flex;align-items:center;gap:6px;',
          'font:12px/1.4 system-ui,"Segoe UI",sans-serif;padding:3px 9px;border-radius:6px;cursor:pointer;',
          'border:1px solid rgba(127,127,127,.35);background:rgba(127,127,127,.10);color:inherit;',
          'max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
          '[data-dsfo-chip]:hover,[data-dsfo-folder]:hover{background:rgba(127,127,127,.22)}',
          '[data-dsfo-folder]{padding:3px 7px}',
          '[data-dsfo-chip][data-dsfo-state="busy"]{opacity:.6;cursor:progress}',
          '[data-dsfo-chip][data-dsfo-state="ok"]{border-color:rgba(80,200,120,.6)}',
          '[data-dsfo-chip][data-dsfo-state="error"]{border-color:rgba(230,90,90,.7);color:#e06464}',
          // 文件夹按钮也要有状态：之前它失败时毫无视觉变化，用户只能说"无效"
          '[data-dsfo-folder][data-dsfo-state="busy"]{opacity:.6;cursor:progress}',
          '[data-dsfo-folder][data-dsfo-state="ok"]{border-color:rgba(80,200,120,.6)}',
          '[data-dsfo-folder][data-dsfo-state="error"]{border-color:rgba(230,90,90,.7);color:#e06464}',
          '[data-dsfo-note]{font:12px/1.4 system-ui,"Segoe UI",sans-serif}',
          '[data-dsfo-note][data-dsfo-state="error"]{color:#e06464}',
          '[data-dsfo-size]{opacity:.6}'
        ].join('');
        var node = el('style', { 'data-dsfo-css': '1', 'data-dsfo-build': BUILD }, css);
        var head = document.head || document.documentElement;
        head.appendChild(node);
      }

      /** 小文件夹图标（纯 SVG，不引任何外部资源）。 */
      function folderIcon() {
        var ns = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('width', '13');
        svg.setAttribute('height', '13');
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('fill', 'currentColor');
        var path = document.createElementNS(ns, 'path');
        path.setAttribute('d', 'M1.5 3.5h4l1.5 2h7.5v7h-13z');
        svg.appendChild(path);
        return svg;
      }

      /** 人类可读的体积。 */
      function humanSize(bytes) {
        if (typeof bytes !== 'number' || bytes <= 0) return '';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1024 / 1024).toFixed(1) + ' MB';
      }

      /** 把一个 chip 切到某个状态；错误态自带重试（坑 #17）。 */
      function setChipState(chip, state, message) {
        chip.setAttribute('data-dsfo-state', state);
        if (state !== 'error') return;
        chip.textContent = '';
        chip.appendChild(el('span', null, '打不开：' + (message || '未知原因') + ' —— 点此重试'));
      }

      /**
       * 打开一个路径。
       * @param {string} path
       * @param {HTMLElement} chip
       */
      function openPath(ctx, path, chip) {
        STATS.clicks += 1;
        // 点击必须**立刻**上报：STATS 只在扫描时才会被读走，
        // 而点击之后通常不会再有 DOM 变化 ⇒ 不上报就等于"点没点过"查不出来。
        report('click:open', true);
        setChipState(chip, 'busy');
        var call;
        try {
          call = ctx.remote.session.openWorkspacePath({ path: path });
        } catch (error) {
          STATS.openErrors += 1;
          setChipState(chip, 'error', String((error && error.message) || error));
          return;
        }
        Promise.resolve(call).then(function (result) {
          if (result && result.ok === false) {
            var detail = (result.error && result.error.message) || '宿主拒绝了这次打开';
            STATS.openErrors += 1;
            setChipState(chip, 'error', detail);
            return;
          }
          setChipState(chip, 'ok');
        }, function (error) {
          STATS.openErrors += 1;
          setChipState(chip, 'error', String((error && error.message) || error));
        });
      }

      /**
       * 「在文件夹中显示」。
       *
       * 走**自己的宿主路由** `/reveal`（`explorer /select,` 打开父目录并选中该文件），
       * 不再走 `openWorkspacePath`。原因（实测）：后者只能"打开"——
       * 对一个**已经开着资源管理器窗口**的目录，往往只是把那个窗口切到前台，
       * 在用户看来就是「点了没反应」；而 `/select,` 每次都会高亮选中文件，变化可见。
       *
       * 失败**必须可见**：按钮变红 + 标题写原因 + 条上出现一行错误文字。
       * 只改内部属性而不显示，用户就只能说"无效"却给不出任何线索。
       */
      function revealPath(path, button) {
        STATS.clicks += 1;
        report('click:reveal', true);
        button.setAttribute('data-dsfo-state', 'busy');
        postJson('/dsh-file-opener/reveal', { path: path }, 8000, function (result) {
          var body = result.body;
          if (result.ok && body && body.ok === true) {
            button.setAttribute('data-dsfo-state', 'ok');
            button.setAttribute('title', '已在文件夹中选中：' + body.revealed);
            return;
          }
          STATS.revealErrors += 1;
          var reason = (body && (body.message || body.error)) || result.error || '未知原因';
          button.setAttribute('data-dsfo-state', 'error');
          button.setAttribute('title', '在文件夹中显示失败：' + reason);
          showBarError(button, reason);
          report('reveal:error', true);
        });
      }

      /** 在条上补一行可见的错误说明（同一个条只留一行）。 */
      function showBarError(button, reason) {
        var bar = button.parentNode;
        if (!bar || typeof bar.appendChild !== 'function') return;
        if (typeof bar.querySelector === 'function' && bar.querySelector('[data-dsfo-note]') !== null) return;
        markSelfMutating();
        bar.appendChild(el('span', { 'data-dsfo-note': '1', 'data-dsfo-state': 'error' },
          '在文件夹中显示失败：' + reason));
      }

      /**
       * 一组路径的内容键。
       * 用于**第二道幂等闸**：React 在流式结束时可能把整个块节点替换掉，
       * `data-dsfo-done` 标记会跟着新节点一起消失，而我挂的条子是**兄弟节点**、
       * 反而活了下来 ⇒ 只看标记会重复出条（坑 #4「渲染必须幂等」的同族陷阱）。
       */
      function barKeyOf(usable) {
        return usable.map(function (info) { return info.path; }).sort().join('|');
      }

      /** 父节点下是否已经有一条内容相同的条子。 */
      function hasExistingBar(block, key) {
        var parent = block.parentNode;
        if (!parent || typeof parent.querySelectorAll !== 'function') return false;
        var bars = parent.querySelectorAll('[data-dsfo-bar]');
        for (var i = 0; i < bars.length; i++) {
          if (bars[i].getAttribute('data-dsfo-key') === key) return true;
        }
        return false;
      }

      /**
       * 给一个块追加 chip 条。**幂等**：已经挂过的块直接返回。
       * @returns {number} 这次真正装饰的路径数
       */
      function decorateBlock(ctx, block, infos) {
        if (alreadyDone(block)) return 0;
        var usable = [];
        for (var i = 0; i < infos.length; i++) {
          if (infos[i] && infos[i].ok) usable.push(infos[i]);
        }
        if (usable.length === 0) {
          block.setAttribute('data-dsfo-done', 'empty');
          return 0;
        }

        var key = barKeyOf(usable);
        if (hasExistingBar(block, key)) {
          block.setAttribute('data-dsfo-done', 'yes');
          return 0;
        }

        var bar = el('div', {
          className: 'dsfo-bar',
          'data-dsfo-bar': '1',
          'data-dsfo-key': key,
          'data-dsfo-build': BUILD
        });
        for (var j = 0; j < usable.length; j++) {
          /* eslint-disable no-loop-func -- 每个 chip 绑定自己的闭包副本 */
          (function (info) {
            var chip = el('button', {
              className: 'dsfo-chip',
              'data-dsfo-chip': '1',
              type: 'button',
              title: '用默认程序打开：' + info.path
            });
            chip.appendChild(el('span', null, info.name));
            var size = humanSize(info.size);
            if (size !== '') chip.appendChild(el('span', { 'data-dsfo-size': '1' }, size));
            chip.addEventListener('click', function (event) {
              if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
              openPath(ctx, info.path, chip);
            });
            bar.appendChild(chip);

            var folder = el('button', {
              className: 'dsfo-folder',
              'data-dsfo-folder': '1',
              type: 'button',
              title: '在文件夹中显示'
            });
            folder.appendChild(folderIcon());
            folder.addEventListener('click', function (event) {
              if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
              revealPath(info.path, folder);
            });
            bar.appendChild(folder);
          })(usable[j]);
          /* eslint-enable no-loop-func */
        }

        markSelfMutating();
        if (block.parentNode && typeof block.parentNode.insertBefore === 'function') {
          block.parentNode.insertBefore(bar, block.nextSibling);
        }
        block.setAttribute('data-dsfo-done', 'yes');
        STATS.decorated += usable.length;
        return usable.length;
      }

      function markSelfMutating() {
        selfMutating = true;
        setTimeout(function () { selfMutating = false; }, 0);
      }

      //#endregion

      //#region ── 扫描 ──────────────────────────────────────────────────

      function setPhase(phase) {
        try {
          document.documentElement.setAttribute('data-dsfo-phase', phase);
          document.documentElement.setAttribute('data-dsfo-build', BUILD);
          document.documentElement.setAttribute('data-dsfo-scans', String(STATS.scans));
          document.documentElement.setAttribute('data-dsfo-decorated', String(STATS.decorated));
          document.documentElement.setAttribute('data-dsfo-candidates', String(STATS.candidates));
          document.documentElement.setAttribute('data-dsfo-capability', CAPABILITY);
          if (lastTransportError !== null) {
            document.documentElement.setAttribute('data-dsfo-error', String(lastTransportError));
          }
        } catch {
          /* 诊断失败不影响功能 */
        }
      }

      function schedule(delayMs) {
        if (scheduled) return;
        scheduled = true;
        if (scanTimer !== null) clearTimeout(scanTimer);
        scanTimer = setTimeout(function () {
          scheduled = false;
          scanTimer = null;
          try {
            scanOnce();
          } catch (error) {
            document.documentElement.setAttribute('data-dsfo-error', String((error && error.message) || error));
          }
        }, delayMs === undefined ? 300 : delayMs);
      }

      /**
       * 一轮扫描。**必须幂等**：同样的 DOM 再扫一遍不产生任何变化（坑 #3 的防抖动）。
       */
      function scanOnce() {
        if (selfMutating) return;
        if (CAPABILITY === 'no') {
          setPhase('unsupported');
          return;
        }
        STATS.scans += 1;

        var rootEl = document.getElementById('root') || document.body;
        if (!rootEl || typeof rootEl.querySelectorAll !== 'function') {
          setPhase('no-root');
          return;
        }

        var blocks = rootEl.querySelectorAll(BLOCK_SELECTOR);
        var plan = [];       // [{block, paths: []}]
        var allPaths = [];
        var seenPath = new Set();
        var fingerprintParts = [];

        for (var i = 0; i < blocks.length; i++) {
          var block = blocks[i];
          if (isForeign(block) || alreadyDone(block)) continue;
          var text = block.textContent || '';
          if (text.length === 0 || text.length > 4000) continue;

          var paths = extractPaths(text);
          if (paths.length === 0) continue;

          // 父块已被装饰过的，子块自动跳过（closest 已经覆盖，这里是双保险）
          var parentDone = block.parentNode && typeof block.parentNode.closest === 'function'
            ? block.parentNode.closest('[data-dsfo-done]')
            : null;
          if (parentDone !== null && parentDone !== undefined) continue;

          plan.push({ block: block, paths: paths });
          fingerprintParts.push(paths.join('|'));
          for (var k = 0; k < paths.length; k++) {
            if (!seenPath.has(paths[k])) {
              seenPath.add(paths[k]);
              allPaths.push(paths[k]);
            }
          }
        }

        STATS.blocks = plan.length;
        STATS.candidates = allPaths.length;

        var fingerprint = fingerprintParts.join('§');
        if (fingerprint === lastFingerprint && allPaths.length === 0) {
          setPhase('stable');
          return;
        }
        lastFingerprint = fingerprint;

        // 先补齐"存在性"答案，再决定谁能出条
        if (allPaths.length > 0) ensureChecks(allPaths);

        for (var n = 0; n < plan.length; n++) {
          var infos = [];
          var determined = true;
          for (var m = 0; m < plan[n].paths.length; m++) {
            var cached = checkCache.get(plan[n].paths[m]);
            if (cached === undefined) {
              // 🔴 还没拿到宿主的确定答案：**绝不能现在就定案**。
              // 否则会把这个块标成 done=empty，等校验回来后永远不会再出条。
              determined = false;
              continue;
            }
            infos.push(cached);
          }
          if (!determined) continue;
          decorateBlock(currentCtx, plan[n].block, infos);
        }

        setPhase(allPaths.length === 0 ? 'scan:none' : 'scan:done');
        report('scan');
      }

      //#endregion

      // ── 入口 ────────────────────────────────────────────────────────

      /** 只依赖真正用到的服务。多写一个不可满足的 inject 会让插件永远等不到加载（坑 #29）。 */
      exports.inject = ['remote', 'remote.session'];

      /** apply 里用到的 ctx，供 scanOnce 内部取 remote（避免闭包到处传）。 */
      var currentCtx = null;

      exports.apply = function (ctx) {
        currentCtx = ctx;
        try {
          document.documentElement.setAttribute('data-dsfo-build', BUILD);
          document.documentElement.setAttribute('data-dsfo-phase', 'apply:start');
        } catch { /* 诊断失败不影响功能 */ }

        try {
          style();
        } catch (error) {
          document.documentElement.setAttribute('data-dsfo-error', 'style: ' + String((error && error.message) || error));
        }

        // 能力探测：宿主能不能真的打开路径。不能就整片不装饰，而不是出一堆点了没反应的按钮。
        try {
          var probe = ctx.remote.session.canOpenWorkspacePath();
          Promise.resolve(probe).then(function (result) {
            CAPABILITY = result && result.ok && result.value ? 'yes' : 'no';
            setPhase('capability:' + CAPABILITY);
            report('capability');
            if (CAPABILITY === 'yes') schedule(0);
          }, function () {
            CAPABILITY = 'no';
            setPhase('capability:error');
          });
        } catch (error) {
          CAPABILITY = 'no';
          setPhase('capability:throw');
        }

        // 观察整棵文档：对话是流式插入的，块会不断出现。
        try {
          var observer = new MutationObserver(function () {
            if (selfMutating) return;
            schedule(300);
          });
          observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        } catch (error) {
          document.documentElement.setAttribute('data-dsfo-observer', 'failed');
        }

        setPhase('apply:ok');
        schedule(0);
      };

      /** 单测入口（生产不使用）。 */
      exports.__internals = {
        BUILD: BUILD,
        extractPaths: extractPaths,
        isForeign: isForeign,
        alreadyDone: alreadyDone,
        humanSize: humanSize,
        STATS: STATS,
        checkCache: checkCache,
        setCtx: function (ctx) { currentCtx = ctx; },
        setCapability: function (value) { CAPABILITY = value; },
        scanOnce: scanOnce,
        decorateBlock: decorateBlock
      };

      return module.exports;
    }
  });
})();
