/**
 * dsh-agent-maker — browser half (client bundle, 阶段 2, 兼容修复版 + 贴边美化)
 *
 * 注册：window.__ModuleLoader__.load({ id, factory })；宿主通过
 * package.json -> dsh.client.platform==="web" + exports["./client"] 发现本 bundle。
 *
 * 关键兼容约束（来自阶段2 实测"加载失败"的根因）：
 *   - DSH 注入的 require('react') 实例里 **useEffect / Component / useRef 不一定可用**，
 *     因此本插件【不使用 useEffect / class 组件 / useRef】，只用 useState + 运行时 DOM 测量。
 *   - 首次加载用 `if(!s.once) setState(...)` + Promise.resolve().then(...) 触发，
 *     不依赖任何生命周期 hook。
 *   - 整个渲染体包在 try/catch 内，任何渲染期异常都返回「可读诊断」而非崩溃。
 *
 * 美化方案（无 hook 前提下的可用手段）：
 *   - 在面板内渲染一个 <style> 元素 + className，从而支持 :hover / 渐变 / 圆角等真实 CSS，
 *     不依赖任何 react 生命周期。
 *   - 浮窗定位（2026-09-12 改版）：默认读 footer 触发按钮（id=agent-maker-trigger）的
 *     getBoundingClientRect，取右沿 +8px 作 left、从按钮上方往上展开（maxHeight = 按钮到屏顶
 *     的距离），并做左右边界钳制。按住标题栏可拖动 → 位置写 localStorage
 *     （key = dsh.popover.pos.dsh-agent-maker）并四边钳制；双击标题栏复位。
 *
 * 与 dsh-skill-panel 共用的浮层约定（**两边必须对称，改一个就得改另一个**）：
 *   - 互斥：打开时 document 广播 'dsh:popover-open'，别的浮层收到即自关
 *     —— 两个面板不可能同时出现，这是机制不是约定；
 *   - 关闭：Esc（内层弹层优先吃掉）· 点击面板外 · 再点触发按钮；
 *   - resize 重算：未拖过就重新贴按钮，拖过就重新钳制。
 *
 * 功能（运行时探测，API 存在才启用）：
 *   - SUPER AGENTS：ctx.remote.agentPresets.list() 动态渲染已安装用户智能体（trust==='user'）
 *   - 点击项：优先用 ctx.remote.session.create({ agentPreset: presetId }) 创建带预设会话，
 *            再用 ctx.sessions.open(sessionId) 直接打开；失败则回退到 uiWorkspace.startSession+select
 */
window.__ModuleLoader__.load({
  id: 'dsh-agent-maker',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var react = require('react');
    var jsxRuntime = require('react/jsx-runtime');
    var render = jsxRuntime.jsx;

    /** jsx(type, props, children...) — jsx-runtime takes children on props. */
    function h(type, props) {
      var children = Array.prototype.slice.call(arguments, 2);
      var cfg = props ? Object.assign({}, props) : {};
      if (children.length === 1) cfg.children = children[0];
      else if (children.length > 1) cfg.children = children;
      return render(type, cfg);
    }

    // ---- 内联样式表（无 hook 前提下的美化手段：<style> + className 支持 :hover）----
    var CSS = [
      // DSH footerActions 容器默认 width:auto，导致子按钮无法占满；强制它拉伸以匹配「新会话」宽度
      // footerActions 默认 display:flex(row) → 「新会话」与本按钮并排各占半宽；
      // 改为纵向排列 + 子项拉伸占满，使本按钮与「新会话」上下同宽
      '.hHd-Xa_footerActions{display:flex !important;flex-direction:column !important;',
      'align-items:stretch !important;width:100% !important}',
      '.am-footer-btn{display:flex;align-items:center;justify-content:center;width:100% !important;',
      'box-sizing:border-box;padding:9px 12px;margin:4px 0;cursor:pointer;',
      'background:rgba(255,255,255,0.05);color:#e8e8ea;border:1px solid rgba(255,255,255,0.1);',
      'border-radius:9px;font-size:13px;font-weight:500;',
      'transition:background .12s ease,border-color .12s ease}',
      '.am-footer-btn:hover{background:rgba(124,156,255,0.16);border-color:rgba(124,156,255,0.4)}',
      // box-sizing:border-box 必须显式写：默认 content-box 下 width:340px + padding:16px
      // 实际占 374px，导致 max-width 与钳制计算都偏小 34px（窄窗口真的会溢出去）。
      '.am-panel{position:fixed;box-sizing:border-box;width:340px;max-width:calc(100vw - 16px);max-height:78vh;overflow:auto;z-index:9999;',
      'background:#1f1f24;color:#e8e8ea;border:1px solid rgba(255,255,255,0.09);',
      'border-radius:14px;padding:16px;box-shadow:0 12px 40px rgba(0,0,0,0.55);',
      'font-size:13px;line-height:1.5}',
      '.am-hd{display:flex;justify-content:space-between;align-items:center;font-size:15px;',
      'font-weight:600;margin-bottom:12px;cursor:move;user-select:none}',
      '.am-hd:active{cursor:grabbing}',
      '.am-close{cursor:pointer;opacity:.6;font-size:15px;padding:0 4px;user-select:none}',
      '.am-close:hover{opacity:1}',
      '.am-sec{font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.55;',
      'margin:14px 0 7px;display:flex;align-items:center;gap:6px}',
      '.am-sec::before{content:"";width:3px;height:12px;background:#7c9cff;border-radius:2px;display:inline-block}',
      '.am-pills{display:flex;gap:8px}',
      '.am-pill{flex:1;cursor:pointer;text-align:left;background:rgba(255,255,255,0.06);',
      'color:#e8e8ea;border:1px solid rgba(255,255,255,0.12);border-radius:9px;',
      'padding:9px 11px;font-size:13px;transition:background .12s,border-color .12s}',
      '.am-pill:hover{background:rgba(124,156,255,0.16);border-color:rgba(124,156,255,0.4)}',
      '.am-hint{font-size:11px;opacity:.45;margin-top:7px}',
      '.am-agent{position:relative;display:flex;align-items:center;gap:8px;margin-bottom:8px;',
      'background:rgba(255,255,255,0.035);border:1px solid rgba(255,255,255,0.08);',
      'border-radius:10px;padding:9px 11px;cursor:pointer;transition:background .12s,border-color .12s}',
      '.am-agent:hover{background:rgba(124,156,255,0.12);border-color:rgba(124,156,255,0.32)}',
      '.am-agent-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.am-agent-name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.am-agent-desc{font-size:11px;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.am-actions{display:flex;align-items:center;gap:2px;flex-shrink:0}',
      '.am-icon{cursor:pointer;width:26px;height:26px;border-radius:7px;border:none;background:transparent;',
      'color:#e8e8ea;font-size:16px;line-height:1;display:flex;align-items:center;justify-content:center;',
      'transition:background .12s,opacity .12s;opacity:.75}',
      '.am-icon:hover{background:rgba(255,255,255,0.1);opacity:1}',
      '.am-pin.on{opacity:1;color:#ffd66b}',
      '.am-menu{position:absolute;right:8px;top:calc(100% - 4px);z-index:10000;min-width:142px;',
      'background:#2a2a31;border:1px solid rgba(255,255,255,0.12);border-radius:10px;',
      'box-shadow:0 10px 28px rgba(0,0,0,0.5);padding:5px;overflow:hidden}',
      '.am-menu-item{display:block;width:100%;text-align:left;cursor:pointer;background:none;border:none;',
      'color:#e8e8ea;font-size:12px;padding:8px 10px;border-radius:7px;transition:background .12s}',
      '.am-menu-item:hover{background:rgba(124,156,255,0.18)}',
      '.am-menu-item.del{color:#ff9b9b}',
      '.am-menu-item.del:hover{background:rgba(255,107,107,0.16)}',
      '.am-menu-sep{height:1px;background:rgba(255,255,255,0.08);margin:4px 2px}',
      '.am-link{cursor:pointer;background:none;border:none;color:#7c9cff;font-size:12px;',
      'padding:4px 0;text-decoration:underline}',
      '.am-input{width:100%;box-sizing:border-box;margin-top:4px;background:rgba(255,255,255,0.05);',
      'color:rgba(255,255,255,0.6);border:1px solid rgba(255,255,255,0.12);border-radius:8px;',
      'padding:7px 10px;font-size:13px}',
      '.am-modal{position:absolute;inset:0;background:rgba(0,0,0,0.62);display:flex;',
      'align-items:center;justify-content:center;padding:14px;z-index:10;border-radius:14px}',
      '.am-card{background:#2a2a30;border:1px solid rgba(255,255,255,0.12);border-radius:12px;',
      'padding:15px;width:100%;max-height:92%;overflow:auto}',
      '.am-card-h{display:flex;justify-content:space-between;align-items:center;font-weight:600;margin-bottom:10px}',
      '.am-code{background:#1a1a1f;border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:10px;',
      'font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;white-space:pre-wrap;',
      'word-break:break-word;max-height:300px;overflow:auto;margin-top:8px;color:#c8c8d0}',
      '.am-kv{font-size:12px;margin:3px 0;opacity:.85}',
      '.am-actions{display:flex;gap:8px;margin-top:14px}',
      '.am-btn{flex:1;cursor:pointer;border-radius:8px;padding:8px 0;font-size:13px;',
      'border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.06);color:#e8e8ea}',
      '.am-btn:hover{background:rgba(255,255,255,0.12)}',
      '.am-btn-danger{background:rgba(255,107,107,0.18);border-color:rgba(255,107,107,0.45);color:#ff9b9b}',
      '.am-btn-danger:hover{background:rgba(255,107,107,0.3)}',
      '.am-err{font-size:12px;color:#ff6b6b;margin-top:4px}',
      // 打包按钮 = 分区标题右侧的小胶囊。.am-sec 带 uppercase + letter-spacing，
      // 子元素必须显式复位这两条，否则中文会被拉宽字号也偏小。
      '.am-mini{cursor:pointer;background:rgba(124,156,255,0.14);border:1px solid rgba(124,156,255,0.35);',
      'color:#b9c8ff;font-size:10px;letter-spacing:0;text-transform:none;padding:2px 7px;',
      'border-radius:6px;white-space:nowrap;flex-shrink:0;transition:background .12s,border-color .12s}',
      '.am-mini:hover{background:rgba(124,156,255,0.28);border-color:rgba(124,156,255,0.6)}',
      '.am-mini.off{opacity:.35;cursor:default}',
      '.am-mini.off:hover{background:rgba(124,156,255,0.14);border-color:rgba(124,156,255,0.35)}',
      '.am-ok{font-size:11px;color:#7ddba0;margin-top:6px;word-break:break-all;line-height:1.45}',
      '.am-ota{margin-top:16px;padding-top:13px;border-top:1px solid rgba(255,255,255,0.09)}',
      '.am-ota-row{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin:5px 0;font-size:12px}',
      '.am-ota-k{opacity:.55;flex-shrink:0}',
      '.am-ota-v{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;opacity:.9;text-align:right;word-break:break-all}',
      '.am-ota-btns{display:flex;gap:8px;margin-top:11px}',
      '.am-ota-btn{flex:1;cursor:pointer;border-radius:8px;padding:8px 0;font-size:12px;',
      'border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.06);color:#e8e8ea;',
      'transition:background .12s,border-color .12s}',
      '.am-ota-btn:hover:not(:disabled){background:rgba(124,156,255,0.16);border-color:rgba(124,156,255,0.4)}',
      '.am-ota-btn:disabled{opacity:.45;cursor:default}',
      '.am-ota-msg{font-size:11.5px;line-height:1.55;margin-top:9px;white-space:pre-wrap;word-break:break-word;opacity:.75}',
      '.am-ota-msg.ok{color:#5fd48a;opacity:1}',
      '.am-ota-msg.err{color:#ff6b6b;opacity:1}',
      '.am-ota-msg.warn{color:#ffc86b;opacity:1}'
    ].join('');

    var panelBase = { position: 'fixed', width: 340, overflow: 'auto', zIndex: 9999 };

    // ===== 「版本 · 更新」（OTA）：走外壳 preload 暴露的 window.__DSTATION_OTA__ =====
    // 通道说明：页面是 contextIsolation 沙箱，走 Electron IPC（preload+contextBridge），
    // 不开新端口、不受页面 CSP connect-src 限制。外壳缺失时降级为提示，不影响面板其它功能。
    // 与知识库面板实现的关键差异：
    //   · 本面板是条件渲染（s.open ? 面板 : null）→ DOM 每次开关都重建。故结果同时存进 state
    //     与模块级 OTA_CACHE，渲染时同步读取 → 「重开面板自动回填上次结果」，不依赖 DOM 反查。
    //   · 本插件的 react 里 hook 不全（无 useEffect/useRef）→ 只用 useState + Promise.resolve().then。
    //   · 只有点「检查更新」才发网络请求；打开面板只读本地版本号。
    var OTA_CACHE = { ready: false, cur: '', build: '', latest: '', hasUpdate: false, msg: '', msgKind: '', busy: false, snaps: [], tx: null };
    var OTA_SUB = null;   // 进度订阅只注册一次
    var OTA_PUSH = null;  // 组件侧 patch 回调（组件重建时刷新指向，避免闭包过期）
    function otaBridge() {
      try { return (typeof window !== 'undefined' && window.__DSTATION_OTA__) ? window.__DSTATION_OTA__ : null; }
      catch (e) { return null; }
    }

    // ---- 面板锚点：点击按钮时把按钮 rect 存进 state，面板据此定位 ----
    function readTriggerRect() {
      try {
        var el = document.getElementById('agent-maker-trigger');
        if (el && el.getBoundingClientRect) return el.getBoundingClientRect();
      } catch (e) {}
      return null;
    }

    // ================= 浮层窗口行为（与 dsh-skill-panel 同一套，必须对称） =================
    // 1) 互斥：任一浮层打开时广播 dsh:popover-open，其余浮层自动关闭 —— 同一时刻只留一个，
    //    从机制上消灭「两个面板叠在一起」。走 document 事件而非共享模块，插件零耦合。
    // 2) 关闭手势：Esc / 点击面板外 / 再次点触发按钮。
    // 3) 位置：默认仍从触发按钮向上展开；按住标题栏可拖动，位置写 localStorage 并四边钳制；
    //    双击标题栏复位。这是「不挡主工作区」的解：挪一次永久生效。
    var POPOVER_ID = 'dsh-agent-maker';
    var POS_KEY = 'dsh.popover.pos.' + POPOVER_ID;
    var PANEL_SEL = '.am-panel';
    var TRIGGER_SEL = '#agent-maker-trigger';
    var EDGE = 8;
    var PANEL_W = 340;

    var WIN = { bound: false, close: null, isOpen: null, esc: null, reposition: null, anchor: null };
    var dragPos = null;      // { left, top }：用户拖动并记住的位置；null = 跟随触发按钮
    var dragHeight = 0;

    function readSavedPos() {
      try {
        var raw = window.localStorage.getItem(POS_KEY);
        if (!raw) return null;
        var o = JSON.parse(raw);
        if (o && typeof o.left === 'number' && typeof o.top === 'number') return { left: o.left, top: o.top };
      } catch (e) {}
      return null;
    }
    function saveSavedPos(p) {
      try { window.localStorage.setItem(POS_KEY, JSON.stringify({ left: Math.round(p.left), top: Math.round(p.top) })); }
      catch (e) {}
    }
    function clearSavedPos() { try { window.localStorage.removeItem(POS_KEY); } catch (e) {} }

    function panelW(vw) { return Math.min(PANEL_W, Math.max(200, (vw || 0) - EDGE * 2)); }
    function clampPos(left, top, w, h) {
      var vw = (typeof window !== 'undefined' && window.innerWidth) || 0;
      var vh = (typeof window !== 'undefined' && window.innerHeight) || 0;
      var maxL = Math.max(EDGE, vw - (w || 0) - EDGE);
      var maxT = Math.max(EDGE, vh - (h || 0) - EDGE);
      return {
        left: Math.min(Math.max(EDGE, left), maxL),
        top: Math.min(Math.max(EDGE, top), maxT)
      };
    }

    // ---- 拖动：按住标题栏移动，落点写进 localStorage ----
    function startDrag(ev) {
      try {
        if (ev && typeof ev.button === 'number' && ev.button !== 0) return;
        var el = document.querySelector(PANEL_SEL);
        if (!el) return;
        if (ev && ev.preventDefault) ev.preventDefault();
        var rect = el.getBoundingClientRect();
        // 从「bottom 定位」固化成「top/left 定位」，否则拖动时面板会跟着底边乱跑
        el.style.bottom = 'auto';
        el.style.top = Math.round(rect.top) + 'px';
        el.style.left = Math.round(rect.left) + 'px';
        var offX = (ev ? ev.clientX : 0) - rect.left;
        var offY = (ev ? ev.clientY : 0) - rect.top;
        var moved = false;
        function onMove(e2) {
          try {
            moved = true;
            var p = clampPos(e2.clientX - offX, e2.clientY - offY, el.offsetWidth, el.offsetHeight);
            el.style.left = p.left + 'px';
            el.style.top = p.top + 'px';
            el.style.maxHeight = Math.max(140, ((window.innerHeight || 0) - p.top - EDGE)) + 'px';
          } catch (e) {}
        }
        function onUp() {
          try {
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('mouseup', onUp, true);
            try { document.body.style.userSelect = ''; } catch (e) {}
            if (moved) {
              // 落位终钳：拖动途中 maxHeight 跟着 top 变 → 元素高度随之变，所以中间态算出的
              // 坐标可能差几像素（实测能差 20px、越过屏底）。以最终几何再钳一次，保证必不越界。
              var fp = clampPos(el.offsetLeft, el.offsetTop, el.offsetWidth, el.offsetHeight);
              el.style.left = fp.left + 'px';
              el.style.top = fp.top + 'px';
              el.style.maxHeight = Math.max(140, ((window.innerHeight || 0) - fp.top - EDGE)) + 'px';
              dragPos = { left: fp.left, top: fp.top };
              dragHeight = el.offsetHeight;
              saveSavedPos(dragPos);
            }
          } catch (e) {}
        }
        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('mouseup', onUp, true);
        try { document.body.style.userSelect = 'none'; } catch (e) {}
      } catch (e) {}
    }

    function announceOpen() {
      try {
        if (typeof CustomEvent === 'function') {
          document.dispatchEvent(new CustomEvent('dsh:popover-open', { detail: { id: POPOVER_ID } }));
        }
      } catch (e) {}
    }

    function bindPopoverGlobal() {
      if (WIN.bound) return;
      WIN.bound = true;
      try {
        // 别的浮层打开了 → 我关掉（互斥）
        document.addEventListener('dsh:popover-open', function (ev) {
          try {
            var id = ev && ev.detail && ev.detail.id;
            if (id && id !== POPOVER_ID && WIN.isOpen && WIN.isOpen() && WIN.close) WIN.close();
          } catch (e) {}
        }, true);
        // Esc：先让内层弹层（详情/删除确认）吃掉，否则关面板
        document.addEventListener('keydown', function (ev) {
          try {
            if (!ev) return;
            var isEsc = (ev.key === 'Escape' || ev.key === 'Esc' || ev.keyCode === 27);
            if (!isEsc) return;
            if (!(WIN.isOpen && WIN.isOpen())) return;
            if (WIN.esc && WIN.esc()) {
              if (ev.preventDefault) ev.preventDefault();
              if (ev.stopPropagation) ev.stopPropagation();
              return;
            }
            if (WIN.close) WIN.close();
          } catch (e) {}
        }, true);
        // 点击面板外 → 关（点在触发按钮上不算，交给按钮自己的 toggle，否则会闪一下又开）
        document.addEventListener('mousedown', function (ev) {
          try {
            if (!(WIN.isOpen && WIN.isOpen())) return;
            var t = ev && ev.target;
            if (!t || !t.closest) return;
            if (t.closest(PANEL_SEL)) return;
            if (t.closest(TRIGGER_SEL)) return;
            if (WIN.close) WIN.close();
          } catch (e) {}
        }, true);
        // 视口变化 → 重算
        window.addEventListener('resize', function () {
          try { if (WIN.isOpen && WIN.isOpen() && WIN.reposition) WIN.reposition(); } catch (e) {}
        });
      } catch (e) {}
    }

    // ---- 命令式重定位：直接改 style，不触发重渲染 ----
    function repositionPanel() {
      try {
        var el = document.querySelector(PANEL_SEL);
        if (!el) return;
        var vw = (window.innerWidth || 0), vh = (window.innerHeight || 0);
        var w = panelW(vw);
        el.style.width = w + 'px';
        if (dragPos) {
          var p = clampPos(dragPos.left, dragPos.top, w, dragHeight || el.offsetHeight || 260);
          dragPos = { left: p.left, top: p.top };
          saveSavedPos(dragPos);
          el.style.bottom = 'auto';
          el.style.left = p.left + 'px';
          el.style.top = p.top + 'px';
          el.style.maxHeight = Math.max(140, vh - p.top - EDGE) + 'px';
        } else {
          var pos = computePanelPos(WIN.anchor);
          if (typeof pos.left === 'number') el.style.left = pos.left + 'px';
          if (typeof pos.bottom === 'number') { el.style.bottom = pos.bottom + 'px'; el.style.top = 'auto'; }
          if (typeof pos.maxHeight === 'number') el.style.maxHeight = pos.maxHeight + 'px';
        }
      } catch (e) {}
    }

    // ---- 置顶持久化（localStorage）----
    var PIN_KEY = 'agent-maker-pinned';
    // 编排师本身只是「创建器」，不计入 SUPER AGENTS 成品列表（只通过 AGENT MAKER 区按钮拉起）
    var ORCHESTRATOR_ID = 'agent-orchestrator';
    // 知识库管理师是知识库插件专属的「库修改助手」，也不进入 SUPER AGENTS 列表（只通过「知识库」按钮拉起）
    var KB_MANAGER_ID = 'kb-manager';
    // 「对话式创建」自动欢迎词：代码发一条引导消息，由编排师 LLM 生成欢迎/使用说明
    var ORCH_WELCOME = '（系统引导）请向用户问好并自我介绍：你是「智能体编排师」，可以通过自然语言对话帮助用户创建、编排自定义智能体（如 CFO/CMO/CTO/COO 等角色）。请简要说明本对话的用法：用户只需用自然语言描述想要什么样的智能体（职责、工具、风格），你便会与之逐步澄清需求并编排出可用的智能体预设。结尾给 2-3 个可立即对话的示例开场。';
    // 专门给「智能体编排」用的 workspace 目录（相对 DSH home）
    var ORCH_WS_DIR = 'agent-orchestration';
    var SUPER_AGENTS_WS_DIR = 'super-agents';

    // ---- 「一键打包我的智能体」----
    // 宿主半（index.js）提供三条路由，客户端只负责触发下载。
    // 注意：宿主半**不参与热重载**（改它必须重启 D-STATION），所以这里的失败路径
    // 必须能优雅降级 —— 老进程里这三条路由是 404，要给出「重启一次就好」而不是
    // 一个看不懂的 HTTP 错误。
    var PACK_PREFIX = '/dsh-agent-maker';
    var PACK_INFLIGHT = false;

    /** 从 content-disposition 里取回中文文件名（优先 RFC 5987 的 filename*） */
    function packFileNameFrom(cd) {
      if (!cd) return 'agent-package.zip';
      var star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
      if (star) { try { return decodeURIComponent(star[1]); } catch (e) {} }
      var plain = /filename="([^"]+)"/i.exec(cd);
      if (plain) return plain[1];
      return 'agent-package.zip';
    }

    /** 把 zip 字节交给浏览器存盘。blob + <a download> 是唯一不依赖宿主能力的路子。 */
    function saveBlob(blob, fileName) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      // 立刻 revoke 会让下载中断，留 2 秒再清
      setTimeout(function () {
        try { document.body.removeChild(a); } catch (e) {}
        try { URL.revokeObjectURL(url); } catch (e) {}
      }, 2000);
    }
    // 待挂载的预设：点击「对话式创建/SUPER AGENTS 项」后、startSession 前设置；
    // 由 apply(ctx) 注册的 sessions.list.subscribe（会话成为 current 第一刻）或兜底轮询消费
    var pendingPreset = null;
    function loadPinned() {
      try { return JSON.parse(localStorage.getItem(PIN_KEY) || '[]'); } catch (e) { return []; }
    }
    function savePinned(arr) {
      try { localStorage.setItem(PIN_KEY, JSON.stringify(arr)); } catch (e) {}
    }
    function currentId(ctx) {
      try { return ctx.sessions && ctx.sessions.list && ctx.sessions.list.getSnapshot
        ? ctx.sessions.list.getSnapshot().current : undefined; } catch (e) { return undefined; }
    }

    // 把预设挂到指定会话（底层 agentPresets.select 仅在 blank 会话有效，见
    // dsh-agent-presets/lib/index.js swap(): 会话发消息后即 agent-preset/locked）。
    // 新会话成为 current 的瞬间 agent 可能尚未就绪，首次 select 可能失败，故重试。
    function applyPreset(ctx, sessionId, presetId, attempt) {
      attempt = attempt || 0;
      try {
        if (ctx.remote && ctx.remote.agentPresets && ctx.remote.agentPresets.select) {
          Promise.resolve(ctx.remote.agentPresets.select(sessionId, presetId))
            .then(function (r) {
              if (r && r.ok) {
                console.info('[agent-maker] 已为会话', sessionId, '挂载预设', presetId);
              } else if (attempt < 4) {
                console.warn('[agent-maker] select 未 ok，重试', attempt + 1, (r && r.error && r.error.message));
                setTimeout(function () { applyPreset(ctx, sessionId, presetId, attempt + 1); }, 200);
              } else {
                console.warn('[agent-maker] select 最终失败:', r && r.error && r.error.message);
              }
            })
            .catch(function (e) {
              if (attempt < 4) {
                console.warn('[agent-maker] select err，重试', attempt + 1, String(e));
                setTimeout(function () { applyPreset(ctx, sessionId, presetId, attempt + 1); }, 200);
              } else console.warn('[agent-maker] select 最终 err', e);
            });
        } else {
          console.warn('[agent-maker] remote.agentPresets.select 不可用');
        }
      } catch (e) { console.warn('[agent-maker] applyPreset', e); }
    }

    // ---- 浮窗定位：没拖过 = 从按钮处向上弹出；拖过 = 用记住的绝对位置（四边钳制）----
    function computePanelPos(anchor) {
      var vw = (typeof window !== 'undefined' && window.innerWidth) || 0;
      var vh = (typeof window !== 'undefined' && window.innerHeight) || 0;
      var w = panelW(vw);
      if (dragPos) {
        var c = clampPos(dragPos.left, dragPos.top, w, dragHeight || 260);
        return { left: c.left, top: c.top, maxHeight: Math.max(140, vh - c.top - EDGE) };
      }
      try {
        var r = anchor || readTriggerRect();
        if (r && (r.width || r.height) && vh) {
          var left = Math.round(r.right) + EDGE;
          // 右边界钳制：窄窗口下面板不再溢出屏幕
          if (vw && left + w + EDGE > vw) left = Math.max(EDGE, vw - w - EDGE);
          // 面板底部位于按钮上方 8px，整体向上展开
          var bottom = Math.round(vh - r.top + EDGE);
          // 最大高度 = 按钮到屏幕顶的距离 - 留边 20px
          var maxHeight = Math.max(120, Math.round(r.top - 20));
          return { left: left, bottom: bottom, maxHeight: maxHeight };
        }
      } catch (e) {}
      // 兜底：贴左上但留出侧边栏常见宽度
      return { left: 72, top: 56, maxHeight: '78vh' };
    }

    // 插件加载时取回上次拖动过的位置（没有就是 null → 跟随触发按钮）
    try { dragPos = readSavedPos(); } catch (e) {}

    // ---- 加载已安装 presets（运行时探测，安全降级）----
    function loadPresets(ctx, setS) {
      try {
        if (!ctx.remote || !ctx.remote.agentPresets) {
          setS(function (p) { var n = Object.assign({}, p); n.err = 'agentPresets 服务不可用（ctx.remote.agentPresets 缺失）'; return n; });
          return;
        }
        var r = ctx.remote.agentPresets.list();
        Promise.resolve(r).then(function (res) {
          if (res && res.ok) {
            var all = (res.value && res.value.presets) || [];
            setS(function (p) { var n = Object.assign({}, p);
              n.userPresets = all.filter(function (x) { return x.trust === 'user' && x.id !== ORCHESTRATOR_ID && x.id !== KB_MANAGER_ID; });
              n.err = null; return n; });
          } else {
            setS(function (p) { var n = Object.assign({}, p); n.err = (res && res.error && res.error.message) || 'list failed'; return n; });
          }
        }).catch(function (e) { setS(function (p) { var n = Object.assign({}, p); n.err = String(e); return n; }); });
      } catch (e) {
        setS(function (p) { var n = Object.assign({}, p); n.err = String(e); return n; });
      }
    }

    /** 工作台面板：单 useState + 惰性加载 + 全包裹 try/catch（不依赖 useEffect / class）。 */
    function AgentMakerPanel(props) {
      var ctx = props.ctx;
      // 唯一 hook：useState（阶段1 已验证可用）
      var st = react.useState(function () {
        return { open: false, anchor: null, userPresets: [], pinned: loadPinned(), expanded: false, err: null, once: false, detail: null, del: null, delErr: null, menuFor: null, ota: OTA_CACHE, packBusy: false, packMsg: '', packErr: null };
      });
      var s = st[0], setS = st[1];

      // 首次渲染触发异步加载（不依赖 useEffect）
      if (!s.once) {
        setS(function (p) { var n = Object.assign({}, p); n.once = true; return n; });
        Promise.resolve().then(function () { loadPresets(ctx, setS); loadOtaInfo(); });
      }

      function patch(kv) {
        setS(function (p) { var n = Object.assign({}, p); for (var k in kv) n[k] = kv[k]; return n; });
      }

      // 双击标题栏：丢掉记住的位置，回到「贴着触发按钮向上展开」的默认态
      function resetPos() {
        dragPos = null; dragHeight = 0; clearSavedPos();
        patch({ anchor: readTriggerRect() });
        setTimeout(function () { try { repositionPanel(); } catch (e) {} }, 30);
      }

      // ---- 「版本 · 更新」逻辑（state + 模块级缓存双写，保证重开面板可见）----
      function otaPatch(kv) {
        setS(function (p) {
          var n = Object.assign({}, p);
          n.ota = Object.assign({}, p.ota, kv);
          OTA_CACHE = n.ota;      // 模块级兜底：面板重建后仍能回填
          return n;
        });
      }
      // 首渲染调用一次：只读本地版本号（不联网）+ 订阅进度事件
      function loadOtaInfo() {
        OTA_PUSH = otaPatch;      // 让进度回调始终指向最新组件实例
        var br = otaBridge();
        if (!br) { otaPatch({ ready: true, cur: '', msg: '未检测到外壳升级通道（旧版外壳或浏览器中打开）。', msgKind: 'warn' }); return; }
        try { if (!OTA_SUB) OTA_SUB = br.subscribe(function (p) { onOtaProgress(p); }); } catch (e) {}
        if (OTA_CACHE.ready) return;   // 已读过，沿用缓存（重渲染不重复 IPC）
        try {
          Promise.resolve(br.getInfo()).then(function (r) {
            if (r && r.ok) {
              var info = r.info || {};
              otaPatch({ ready: true, cur: info.version || '', build: info.build || '' });
              loadSnapshots();   // Phase 2：顺带列出可回滚版本
            } else {
              otaPatch({ ready: true, cur: '', msg: (r && r.error) || '读取版本失败', msgKind: 'warn' });
            }
          }).catch(function (e) { otaPatch({ ready: true, cur: '', msg: '读取版本失败：' + (e && e.message ? e.message : e), msgKind: 'warn' }); });
        } catch (e) { otaPatch({ ready: true, msg: '读取版本异常：' + (e && e.message ? e.message : e), msgKind: 'warn' }); }
      }
      function onOtaProgress(p) {
        if (!p || !OTA_PUSH) return;
        // v2 的事件序列：fetchmap → index → plan → download → staged
        if (p.phase === 'fetchmap') {
          OTA_PUSH({ msg: '正在获取文件映射表…', msgKind: '' });
        } else if (p.phase === 'index') {
          OTA_PUSH({ msg: '正在校验本机文件 ' + (p.done || 0) + '/' + (p.total || '?') + '（首次会慢一些，之后有索引缓存）', msgKind: '' });
        } else if (p.phase === 'plan') {
          OTA_PUSH({
            msg: '差集完成：需下载 ' + (p.needObjects || 0) + ' 个对象、更新 ' + (p.applyPaths || 0)
              + ' 个文件（内容已一致 ' + (p.same || 0) + ' 个）',
            msgKind: ''
          });
        } else if (p.phase === 'download') {
          var mb = p.bytes ? ' · ' + (p.bytes / 1048576).toFixed(2) + ' MB' : '';
          OTA_PUSH({
            msg: '下载中 ' + (p.done || 0) + '/' + (p.total || 0) + mb + (p.failed ? ' · 失败 ' + p.failed : ''),
            msgKind: ''
          });
        } else if (p.phase === 'staged') {
          OTA_PUSH({
            msg: p.noop
              ? '本机内容已是最新，只需更新版本号，正在准备安装…'
              : ('下载完成（' + (p.needObjects || 0) + ' 个对象），正在准备安装…'),
            msgKind: 'ok'
          });
        }
      }
      function onOtaCheck() {
        var br = otaBridge();
        if (!br) return;
        if (OTA_CACHE.busy) return;
        otaPatch({ busy: true, msg: '正在检查…', msgKind: '' });
        try {
          Promise.resolve(br.check()).then(function (r) {
            if (!r || !r.ok) throw new Error((r && r.error) || '检查失败');
            var d = r.result || {};
            if (d.blocked) { otaPatch({ busy: false, latest: d.latest || '', hasUpdate: false, msg: d.blocked, msgKind: 'err' }); return; }
            if (d.hasUpdate) {
              otaPatch({
                busy: false, latest: d.latest || '', hasUpdate: true, msgKind: 'ok',
                msg: '发现新版本 ' + d.latest + (d.gitCommit ? '（' + d.gitCommit + '）' : '')
                  + '\n增量升级：只下载本机缺失的内容块，不是全量 ' + ((d.totalSize || 0) / 1048576).toFixed(0) + ' MB'
                  + (d.notes ? '\n' + d.notes : '')
              });
            } else {
              otaPatch({ busy: false, latest: d.latest || d.current || '', hasUpdate: false, msgKind: 'ok', msg: '当前已是最新版本（' + d.current + '）' });
            }
          }).catch(function (e) {
            otaPatch({ busy: false, msg: '检查失败：' + (e && e.message ? e.message : e), msgKind: 'err' });
          });
        } catch (e) {
          otaPatch({ busy: false, msg: '检查异常：' + (e && e.message ? e.message : e), msgKind: 'err' });
        }
      }
      function onOtaApply() {
        var br = otaBridge();
        if (!br || !OTA_CACHE.hasUpdate || OTA_CACHE.busy) return;
        var go = true;
        try {
          go = (typeof window.confirm === 'function')
            ? window.confirm('确定升级到 ' + OTA_CACHE.latest + ' 吗？\n\n将先计算本机与目标的差集，只下载缺失的内容块（不是全量包），随后自动重启 D-STATION。')
            : true;
        } catch (e) {}
        if (!go) return;
        otaPatch({ busy: true, msg: '开始下载…', msgKind: '' });
        try {
          Promise.resolve(br.apply()).then(function (r) {
            if (!r || !r.ok) throw new Error((r && r.error) || '升级失败');
            otaPatch({ busy: false, msgKind: 'ok', msg: '已暂存 ' + r.files + ' 个文件，D-STATION 即将重启完成升级…' });
          }).catch(function (e) {
            otaPatch({ busy: false, msg: '升级失败：' + (e && e.message ? e.message : e), msgKind: 'err' });
          });
        } catch (e) {
          otaPatch({ busy: false, msg: '升级异常：' + (e && e.message ? e.message : e), msgKind: 'err' });
        }
      }
      // ---- Phase 2：版本快照与回滚 ----
      // 升级器每次 apply 都会在 backups/versions/<旧版本>/ 留一份硬链接快照，
      // 这里把它列出来给用户一个"后悔药"入口。
      function loadSnapshots() {
        var br = otaBridge();
        if (!br || typeof br.snapshots !== 'function') return;   // 旧外壳没有这条桥
        try {
          Promise.resolve(br.snapshots()).then(function (r) {
            if (!r || !r.ok) return;
            var cur = r.current || OTA_CACHE.cur || '';
            var snaps = (r.snapshots || []).filter(function (s) { return s.version !== cur; });
            otaPatch({ snaps: snaps, tx: r.tx || null });
          }).catch(function () { /* 拿不到快照列表不影响升级本身 */ });
        } catch (e) {}
      }
      function onOtaRollback(version) {
        var br = otaBridge();
        if (!br || OTA_CACHE.busy || typeof br.rollback !== 'function') return;
        var go = true;
        try {
          go = (typeof window.confirm === 'function')
            ? window.confirm('确定回滚到 ' + version + ' 吗？\n\n将用该版本的快照恢复文件（升级时新增的文件会被删除），随后自动重启 D-STATION。')
            : true;
        } catch (e) {}
        if (!go) return;
        otaPatch({ busy: true, msg: '正在启动回滚…', msgKind: '' });
        try {
          Promise.resolve(br.rollback(version)).then(function (r) {
            if (!r || !r.ok) throw new Error((r && r.error) || '回滚失败');
            otaPatch({ busy: false, msgKind: 'ok', msg: '回滚已启动，D-STATION 即将重启并回到 ' + version + '…' });
          }).catch(function (e) {
            otaPatch({ busy: false, msg: '回滚失败：' + (e && e.message ? e.message : e), msgKind: 'err' });
          });
        } catch (e) {
          otaPatch({ busy: false, msg: '回滚异常：' + (e && e.message ? e.message : e), msgKind: 'err' });
        }
      }

      // 「版本 · 更新」区块：渲染时同步读 state（已含模块级缓存回填），重开面板内容不丢
      function otaSection(st) {
        var o = (st && st.ota) || OTA_CACHE;
        var curTxt = o.cur ? (o.cur + (o.build ? '  (' + o.build + ')' : '')) : (o.ready ? '不可用' : '读取中…');
        return h('div', { className: 'am-ota' },
          h('div', { className: 'am-sec' }, '版本 · 更新'),
          h('div', { className: 'am-ota-row' },
            h('span', { className: 'am-ota-k' }, '当前版本'),
            h('span', { className: 'am-ota-v', id: 'am-ota-cur' }, curTxt)),
          h('div', { className: 'am-ota-row' },
            h('span', { className: 'am-ota-k' }, '服务器版本'),
            h('span', { className: 'am-ota-v', id: 'am-ota-new' }, o.latest || '—')),
          h('div', { className: 'am-ota-btns' },
            h('button', { className: 'am-ota-btn', id: 'am-ota-check', disabled: !!o.busy, onClick: onOtaCheck }, o.busy ? '检查中…' : '检查更新'),
            o.hasUpdate ? h('button', { className: 'am-ota-btn', id: 'am-ota-apply', disabled: !!o.busy, onClick: onOtaApply }, '立即升级') : null,
            (o.snaps && o.snaps.length) ? h('button', {
              className: 'am-ota-btn am-ota-rb', id: 'am-ota-rollback', disabled: !!o.busy,
              onClick: function () { onOtaRollback(o.snaps[0].version); }
            }, '回滚到 ' + o.snaps[0].version) : null),
          (o.tx && o.tx.phase === 'applying')
            ? h('div', { className: 'am-ota-msg warn', id: 'am-ota-tx' }, '⚠ 上次升级在「应用」阶段中断（断电或被强杀）。可点「检查更新」重新升级，或回滚到上一个版本。')
            : null,
          o.msg ? h('div', { className: 'am-ota-msg ' + (o.msgKind || ''), id: 'am-ota-msg' }, o.msg) : null);
      }

      // 新建并打开会话 + 直接写入 preset。
      // 根因：uiWorkspace.startSession() 只能创建 blank 会话，blank 会话打开后会显示 DSH 的
      // 混合 preset 选择菜单（标准/PTC/极简/创造 + 用户智能体全部混在一起），无法“独立出来”。
      // DSH 底层 remote.session.create 支持 {agentPreset: string} 参数，创建时即挂载预设，
      // 打开后直接进入该 preset 的会话，不再弹出选择菜单。
      // 这里优先使用 remote.session.create + sessions.open；失败时回退到原 startSession+select。
      function openPresetSession(presetId, autoPrompt) {
        try {
          patch({ open: false });
          var isOrch = presetId === ORCHESTRATOR_ID;
          // 编排师：先确保「智能体编排」专用 workspace 注册，再把会话归属它并自动发欢迎词；
          // 成品智能体（cfo/cmo/cto/coo 等）：不强求 workspace，直接创建带预设会话（保持现状）。
          var doCreate = function (workspaceId) {
            if (ctx.remote && ctx.remote.session && typeof ctx.remote.session.create === 'function' &&
                ctx.sessions && typeof ctx.sessions.open === 'function') {
              var payload = { agentPreset: presetId };
              if (workspaceId) payload.workspaceId = workspaceId;
              Promise.resolve(ctx.remote.session.create(payload))
                .then(function (r) {
                  if (r && r.ok && r.value && r.value.sessionId) {
                    ctx.sessions.open(r.value.sessionId);
                    console.info('[agent-maker] 已创建并打开带预设会话', r.value.sessionId, presetId, workspaceId ? ('workspace=' + workspaceId) : '');
                    if (autoPrompt) sendWelcome(ctx, r.value.sessionId, autoPrompt);
                    else if (isOrch) sendWelcome(ctx, r.value.sessionId);
                  } else {
                    console.warn('[agent-maker] remote.session.create 未返回 ok，回退:', r && r.error && r.error.message);
                    fallbackStartSession(presetId);
                  }
                })
                .catch(function (e) {
                  console.warn('[agent-maker] remote.session.create 失败，回退:', e);
                  fallbackStartSession(presetId);
                });
            } else {
              fallbackStartSession(presetId);
            }
          };
          // 编排师与成品智能体都先解析各自专用 workspace，再 session.create({workspaceId, agentPreset}) 原子打开，
          // 避免缺 workspaceId 导致 DSH 打开原生配置屏、把 agentPreset 重置成 standard。
          ensureWorkspace(ctx, isOrch ? ORCH_WS_DIR : SUPER_AGENTS_WS_DIR, doCreate);
        } catch (e) {
          console.error('[agent-maker] openPresetSession', e);
          fallbackStartSession(presetId);
        }
      }

      // 编辑已有智能体：读取其当前内容，拉起编排师会话并附带「原地更新」引导消息。
      function editAgent(id) {
        try {
          patch({ open: false });
          var ap = ctx.remote && ctx.remote.agentPresets;
          if (!(ap && typeof ap.read === 'function')) {
            console.warn('[agent-maker] agentPresets.read 不可用，无法直接编辑');
            fallbackStartSession(ORCHESTRATOR_ID);
            return;
          }
          Promise.resolve(ap.read(id)).then(function (res) {
            if (res && res.ok && res.value) {
              var nm = res.value.name || id;
              var meta = '智能体 id=' + id + (nm ? ('，名称=' + nm) : '') + (res.value.description ? ('，描述=' + res.value.description) : '');
              var msg = '（系统引导·编辑已有智能体）用户希望**修改**已有智能体：' + meta + '。\n当前 agent.cordis.yml 内容如下：\n```\n' + (res.value.content || '') + '\n```\n请使用 editing-cordis-compositions 技能，与用户确认修改目标，并**原地更新**该智能体（preset id 保持「' + id + '」不变）：必要时先 deletePreset 再 copy 回原 id，或直接改写其 agent.cordis.yml，并通过 standingKeyFor 完成挂载校验。完成后告知用户已更新。';
              openPresetSession(ORCHESTRATOR_ID, msg);
            } else {
              console.warn('[agent-maker] read 失败，回退普通编排会话', res && res.error && res.error.message);
              openPresetSession(ORCHESTRATOR_ID);
            }
          }).catch(function (e) { console.warn('[agent-maker] read 异常，回退普通编排会话', e); openPresetSession(ORCHESTRATOR_ID); });
        } catch (e) { console.error('[agent-maker] editAgent', e); openPresetSession(ORCHESTRATOR_ID); }
      }

      // 兜底：remote.session.create 不可用时，用 uiWorkspace.startSession + select（会进菜单）
      function fallbackStartSession(presetId) {
        try {
          var ws = safeGet(ctx, 'uiWorkspace');
          if (!(ws && typeof ws.startSession === 'function')) {
            console.warn('[agent-maker] uiWorkspace.startSession 不可用，无法新建会话');
            return;
          }
          var before = currentId(ctx);
          pendingPreset = { id: presetId, before: before };
          ws.startSession();
          var tries = 0;
          var timer = setInterval(function () {
            if (!pendingPreset) { clearInterval(timer); return; }
            var now = currentId(ctx);
            if (now && now !== pendingPreset.before) {
              clearInterval(timer);
              var pend = pendingPreset; pendingPreset = null;
              applyPreset(ctx, now, pend.id);
            } else if (++tries > 60) {
              clearInterval(timer);
              if (pendingPreset) { console.warn('[agent-maker] 3s 内未检测到会话切换，跳过预设加载', pendingPreset.id); pendingPreset = null; }
            }
          }, 50);
        } catch (e) {
          console.error('[agent-maker] fallbackStartSession', e);
          pendingPreset = null;
        }
      }

      // 异步解析 DSH home 绝对路径：优先 remote.directoryPicker.list(undefined) 返回的 DirectoryListing.home；
      // 兜底 process.env.DSH_HOME；再兜底已知开发机 home（部署路径变更时请更新此处注释）。
      function resolveHomeAsync(ctx, cb) {
        try {
          var dp = ctx.remote && ctx.remote.directoryPicker;
          if (dp && typeof dp.list === 'function') {
            Promise.resolve(dp.list(undefined)).then(function (res) {
              var h = res && res.ok && res.value && res.value.home ? res.value.home : null;
              if (h) { console.info('[agent-maker] directoryPicker 拿到 home =', h); cb(h); }
              else fallbackHome(ctx, cb);
            }).catch(function () { fallbackHome(ctx, cb); });
            return;
          }
        } catch (e) { console.warn('[agent-maker] resolveHomeAsync directoryPicker 异常', e && e.message); }
        fallbackHome(ctx, cb);
      }
      function fallbackHome(ctx, cb) {
        try { if (typeof process !== 'undefined' && process.env && process.env.DSH_HOME) { cb(process.env.DSH_HOME); return; } } catch (e) {}
        console.warn('[agent-maker] 无法推导 home 路径，跳过（可设 DSH_HOME 环境变量显式指定）');
        cb('');
      }
      // 确保指定目录的专用 workspace 已注册（幂等）：编排师=agent-orchestration，成品智能体=super-agents；
      // 回调返回 workspaceId 或 null（降级）。
      function ensureWorkspace(ctx, wsDir, cb) {
        try {
          var ws = ctx.remote && ctx.remote.workspace;
          if (!(ws && typeof ws.create === 'function')) { console.warn('[agent-maker] remote.workspace 不可用，跳过 workspace 归类'); cb(null); return; }
          resolveHomeAsync(ctx, function (home) {
            if (!home) { console.warn('[agent-maker] 无法解析 home 目录，跳过 workspace 归类'); cb(null); return; }
            var dir = (home + '/').split('\\').join('/');
            if (dir.charAt(dir.length - 1) === '/') dir = dir.slice(0, -1);
            dir = dir + '/' + wsDir;
            // workspaceRegistry.create 要求目录已存在，否则抛 workspace/invalid-path；renderer 内尝试用 fs 兜底创建
            try {
              if (typeof require === 'function') {
                var fsx = require('fs');
                if (fsx && typeof fsx.mkdirSync === 'function' && !fsx.existsSync(dir)) fsx.mkdirSync(dir, { recursive: true });
              }
            } catch (e) { console.warn('[agent-maker] 创建', wsDir, '目录兜底失败（若目录已存在可忽略）:', e && e.message); }
            Promise.resolve(ws.create({ path: dir }))
              .then(function (r) {
                if (!(r && r.ok)) { console.warn('[agent-maker] remote.workspace.create 未返回 ok，降级:', r && r.error && r.error.message); cb(null); return; }
                console.info('[agent-maker] remote.workspace.create ->', JSON.stringify(r && r.value));
                var wid = r && r.value && r.value.workspace ? r.value.workspace.workspaceId : null;
                console.info('[agent-maker] 解析到 workspaceId =', wid);
                cb(wid);
              })
              .catch(function (e) { console.warn('[agent-maker] workspaces.create 失败，降级:', e && e.message); cb(null); });
          });
        } catch (e) { console.warn('[agent-maker] ensureWorkspace', e); cb(null); }
      }
      // 会话 open 后自动发欢迎词（仅编排师）。走 remote.session.prompt({sessionId,...})——
      // 与 remote.session.create 同命名空间（已证可达）；ctx.sessions 仅有 open、无 get，故不能拿实例调 prompt。
      function sendWelcome(ctx, sessionId, text, attempt) {
        attempt = attempt || 0;
        var MAX = 15, DELAY = 400;
        try {
          var rs = ctx.remote && ctx.remote.session;
          if (!(rs && typeof rs.prompt === 'function')) { console.warn('[agent-maker] remote.session.prompt 不可用，跳过欢迎词'); return; }
          var uuid = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : ('req-' + Date.now() + '-' + Math.random().toString(36).slice(2));
          Promise.resolve(rs.prompt({ sessionId: sessionId, requestId: uuid, mode: 'queue', content: [{ type: 'text', text: (text || ORCH_WELCOME) }] }))
            .then(function (r) {
              if (r && r.ok) console.info('[agent-maker] 欢迎词已发送', sessionId);
              else if (attempt < MAX) { console.warn('[agent-maker] 欢迎词未确认，重试', attempt, r && r.error && r.error.message); setTimeout(function () { sendWelcome(ctx, sessionId, attempt + 1); }, DELAY); }
              else console.warn('[agent-maker] 欢迎词发送最终失败', sessionId, r && r.error && r.error.message);
            })
            .catch(function (e) {
              if (attempt < MAX) { console.warn('[agent-maker] 欢迎词发送异常，重试', attempt, e && e.message); setTimeout(function () { sendWelcome(ctx, sessionId, attempt + 1); }, DELAY); }
              else console.warn('[agent-maker] 欢迎词发送最终异常', sessionId, e && e.message);
            });
        } catch (e) { console.warn('[agent-maker] sendWelcome', e); }
      }

      // applyPreset 已提升为模块级（带 select 重试 + 诊断日志），组件内不再重复定义


      function openBlank() {
        try {
          var ws = (ctx.get && typeof ctx.get === 'function') ? safeGet(ctx, 'uiWorkspace') : null;
          if (ws && typeof ws.startSession === 'function') { ws.startSession(); patch({ open: false }); }
          else console.warn('[agent-maker] openBlank：uiWorkspace 不可用');
        } catch (e) { console.error('[agent-maker] openBlank', e); }
      }
      // 暴露给知识库插件：其 window.__kbOpen 可借此开一个空白「整理师」会话
      try { window.__kbOpenBlank = openBlank; } catch (e) {}
      // 暴露给知识库插件：关闭智能体工作台 modal，避免与右侧抽屉浮层冲突
      try { window.__kbClosePanel = function () { try { patch({ open: false }); } catch (e) {} }; } catch (e) {}

      function safeGet(c, name) {
        try { return c.get(name); } catch (e) { return null; }
      }

      /* ── 一键打包我的智能体 ────────────────────────────────────────────
       * ids = null / [] → 打包全部（宿主自己决定可打包集合）；
       * ids = [id]     → 只打包这一个。
       * 整条链路都在 try/catch 里，且**任何**失败都会写出一条可见错误 ——
       * 「点了没反应」是这类按钮最糟的失败方式（见 dsh-plugin-dev 坑 #59）。
       */
      function packAgents(ids) {
        if (PACK_INFLIGHT) return;
        var one = !!(ids && ids.length === 1);
        // 先分清「用户选了什么」和「宿主怎么理解」——打包全部时不让客户端猜集合，
        // 一律由宿主按 .agent-presets 的真实内容决定，避免两边口径漂移。
        var body = one ? { ids: ids } : {};

        PACK_INFLIGHT = true;
        patch({
          packBusy: true,
          packErr: null,
          packMsg: one ? '正在打包这个智能体…' : '正在打包全部智能体…'
        });

        fetch(PACK_PREFIX + '/export', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        }).then(function (res) {
          if (res.status === 404) {
            // 宿主半还没加载（改完 index.js 必须重启 D-STATION 才生效）
            throw new Error('打包服务未加载：控件已就位，但需要重启一次 D-STATION 让宿主半生效。');
          }
          if (res.status === 403) {
            throw new Error('宿主拒绝了这次请求（非本机同源窗口）。请从 D-STATION 窗口里操作。');
          }
          if (!res.ok) {
            return res.text().then(function (t) {
              var msg = t;
              try { var j = JSON.parse(t); if (j && j.error) msg = j.error; } catch (e) {}
              throw new Error('HTTP ' + res.status + '：' + msg);
            });
          }
          var name = packFileNameFrom(res.headers && res.headers.get ? res.headers.get('content-disposition') : '');
          return res.blob().then(function (blob) { return { blob: blob, name: name }; });
        }).then(function (r) {
          saveBlob(r.blob, r.name);
          var kb = Math.round(r.blob.size / 1024);
          console.info('[agent-maker] 已导出智能体包', r.name, kb + 'KB');
          patch({
            packBusy: false,
            packErr: null,
            packMsg: '已导出「' + r.name + '」（' + kb + 'KB，在浏览器下载目录）。拷到别的电脑解压后双击「一键安装.cmd」即可。'
          });
          setTimeout(function () {
            try { patch({ packMsg: '' }); } catch (e) {}
          }, 12000);
        }).catch(function (e) {
          console.error('[agent-maker] 打包失败', e);
          patch({
            packBusy: false,
            packMsg: '',
            packErr: (e && e.message) ? e.message : String(e)
          });
        }).then(function () {
          PACK_INFLIGHT = false;
        });
      }

      function togglePin(id) {
        var next = s.pinned.slice();
        var i = next.indexOf(id);
        if (i >= 0) next.splice(i, 1); else next.push(id);
        savePinned(next);
        patch({ pinned: next });
      }

      // 详情：read(id) 拉取预设全文，面板内弹层只读展示
      function showDetail(id) {
        try {
          patch({ detail: { id: id, loading: true } });
          var ap = ctx.remote && ctx.remote.agentPresets;
          if (!(ap && typeof ap.read === 'function')) { patch({ detail: { id: id, error: 'agentPresets.read 不可用', loading: false } }); return; }
          Promise.resolve(ap.read(id)).then(function (res) {
            if (res && res.ok && res.value) {
              patch({ detail: { id: id, name: res.value.name, description: res.value.description, trust: res.value.trust, content: res.value.content || '', loading: false } });
            } else {
              patch({ detail: { id: id, error: (res && res.error && res.error.message) || 'read failed', loading: false } });
            }
          }).catch(function (e) { patch({ detail: { id: id, error: String(e), loading: false } }); });
        } catch (e) { patch({ detail: { id: id, error: String(e), loading: false } }); }
      }
      // 删除确认：二次确认弹窗 + deletePreset + 刷新列表（铁律：危险操作需确认）
      function askDelete(id, name) { patch({ del: { id: id, name: name || id }, delErr: null }); }
      function doDelete() {
        var d = s.del; if (!d) return;
        try {
          var ap = ctx.remote && ctx.remote.agentPresets;
          if (!(ap && typeof ap.deletePreset === 'function')) { console.warn('[agent-maker] deletePreset 不可用'); patch({ del: null }); return; }
          Promise.resolve(ap.deletePreset(d.id)).then(function (res) {
            if (res && res.ok) { console.info('[agent-maker] 已删除智能体', d.id); patch({ del: null }); loadPresets(ctx, setS); }
            else { console.warn('[agent-maker] deletePreset 未 ok', res && res.error && res.error.message); patch({ delErr: (res && res.error && res.error.message) || '删除失败' }); }
          }).catch(function (e) { console.warn('[agent-maker] deletePreset 异常', e); patch({ delErr: String(e) }); });
        } catch (e) { console.error('[agent-maker] doDelete', e); patch({ delErr: String(e) }); }
      }

      // ---- 渲染（全包裹 try/catch，任何异常返回可读诊断）----
      try {
        var sorted = s.userPresets.slice().sort(function (a, b) {
          var ia = s.pinned.indexOf(a.id), ib = s.pinned.indexOf(b.id);
          if (ia === -1 && ib === -1) return 0;
          if (ia === -1) return 1;
          if (ib === -1) return -1;
          return ia - ib;
        });
        var visible = s.expanded ? sorted : sorted.slice(0, 3);
        var pos = computePanelPos(s.anchor);

        // 每次渲染刷新浮层行为槽位：模块级监听器只注册一次，靠这几个闭包操作当前组件
        WIN.isOpen = function () { return !!s.open; };
        WIN.close = function () { try { patch({ open: false }); } catch (e) {} };
        WIN.esc = function () {   // 返回 true = 内层弹层吃掉了 Esc，不再关面板
          if (s.detail) { patch({ detail: null }); return true; }
          if (s.del) { patch({ del: null }); return true; }
          if (s.menuFor) { patch({ menuFor: null }); return true; }
          return false;
        };
        WIN.reposition = repositionPanel;
        WIN.anchor = s.anchor;

        return h('div', null,
          h('style', null, CSS),
          // footer 触发按钮（美化：渐变小图标 + 圆角按钮）
          h('div', {
            id: 'agent-maker-trigger',
            role: 'button',
            onClick: function () {
              if (s.open) { patch({ open: false, anchor: null }); return; }
              // 先广播互斥（让技能面板先让位），再记录按钮位置，确保面板首次渲染就在按钮旁边
              announceOpen();
              patch({ open: true, anchor: readTriggerRect() });
              // 挂载后按真实高度再钳一次（内容高度这一刻才知道，拖动位置才不会出界）
              setTimeout(function () { try { if (dragPos) repositionPanel(); } catch (e) {} }, 30);
            },
            className: 'am-footer-btn',
            title: '智能体工作台'
          }, '智能体工作台'),
          s.open
            ? h('div', { className: 'am-panel', style: Object.assign({}, panelBase, pos), onClick: function () { if (s.menuFor) patch({ menuFor: null }); } },
                h('div', { className: 'am-hd', title: '按住拖动移动面板 · 双击复位',
                  onMouseDown: startDrag, onDoubleClick: resetPos },
                  '智能体工作台',
                  h('span', { role: 'button', onClick: function () { patch({ open: false }); }, className: 'am-close' }, '✕')),
                // AGENT MAKER
                h('div', { className: 'am-sec' }, 'AGENT MAKER'),
                h('div', { className: 'am-pills' },
                  h('button', { onClick: function () { openPresetSession(ORCHESTRATOR_ID); }, className: 'am-pill' }, '对话式创建'),
                  h('button', { onClick: function () { if (window.__kbOpen) window.__kbOpen(); else openBlank(); }, className: 'am-pill', title: '唤起知识库智能体（整理师）+ 管理面板' }, '知识库')),
                h('div', { className: 'am-hint' }, '点击「对话式创建」与编排师自然语言对话即可生成智能体 · 知识库阶段5'),
                // SUPER AGENTS（仅用户/市场发布的智能体，trust==='user'）
                h('div', { className: 'am-sec' },
                  'SUPER AGENTS',
                  h('span', { style: { flex: 1 } }),
                  s.userPresets.length > 0
                    ? h('span', {
                        role: 'button',
                        title: '把这里全部智能体打成一个安装包（自带一键安装脚本），拷到别的装了 D-STATION 的电脑上双击就能装',
                        className: 'am-mini' + (s.packBusy ? ' off' : ''),
                        onClick: function (e) {
                          e.stopPropagation();
                          if (!s.packBusy) packAgents(null);
                        }
                      }, s.packBusy ? '打包中…' : '📦 打包全部')
                    : null),
                s.err
                  ? h('div', { className: 'am-err' }, '加载失败：' + s.err)
                  : (visible.length === 0
                      ? h('div', { className: 'am-hint' }, '暂无用户智能体 · 编排发布后会出现在这里')
                      : visible.map(function (p) {
                          var isPin = s.pinned.indexOf(p.id) >= 0;
                          return h('div', { className: 'am-agent', key: p.id, onClick: function () { openPresetSession(p.id); } },
                            h('div', { className: 'am-agent-main' },
                              h('div', { className: 'am-agent-name' }, p.name || p.id),
                              p.description ? h('div', { className: 'am-agent-desc' }, p.description) : null),
                            h('div', { className: 'am-actions' },
                              h('span', { role: 'button', title: isPin ? '取消置顶' : '置顶',
                                className: 'am-icon am-pin' + (isPin ? ' on' : ''),
                                onClick: function (e) { e.stopPropagation(); togglePin(p.id); } }, isPin ? '★' : '☆'),
                              h('span', { role: 'button', title: '打包这个智能体（导出成可拷到别的电脑安装的包）',
                                className: 'am-icon', onClick: function (e) { e.stopPropagation(); patch({ menuFor: null }); packAgents([p.id]); } }, '📦'),
                              h('span', { role: 'button', title: '更多',
                                className: 'am-icon', onClick: function (e) { e.stopPropagation(); patch({ menuFor: s.menuFor === p.id ? null : p.id }); } }, '⋮'),
                              s.menuFor === p.id
                                ? h('div', { className: 'am-menu', onClick: function (e) { e.stopPropagation(); } },
                                    h('button', { className: 'am-menu-item', onClick: function (e) { e.stopPropagation(); patch({ menuFor: null }); editAgent(p.id); } }, '编辑'),
                                    h('button', { className: 'am-menu-item', onClick: function (e) { e.stopPropagation(); patch({ menuFor: null }); showDetail(p.id); } }, '详情'),
                                    h('div', { className: 'am-menu-sep' }),
                                    h('button', { className: 'am-menu-item del', onClick: function (e) { e.stopPropagation(); patch({ menuFor: null }); askDelete(p.id, p.name || p.id); } }, '删除'))
                                : null));
                        })),
                sorted.length > 3
                  ? h('button', { onClick: function () { patch({ expanded: !s.expanded }); }, className: 'am-link' },
                      s.expanded ? '收起' : '展开全部 (' + sorted.length + ')')
                  : null,
                // 打包的结果反馈：成功与失败都要看得见（「点了没反应」是最糟的失败方式）
                s.packErr
                  ? h('div', { className: 'am-err' }, '打包失败：' + s.packErr)
                  : null,
                s.packMsg
                  ? h('div', { className: 'am-ok' }, s.packMsg)
                  : null,
                // 「版本 · 更新」（OTA）—— 面板最下方（详情/删除弹层之前）
                otaSection(s),
                // 详情弹层（面板内 overlay）
                s.detail
                  ? h('div', { className: 'am-modal' },
                      h('div', { className: 'am-card' },
                        h('div', { className: 'am-card-h' },
                          '智能体详情',
                          h('span', { role: 'button', onClick: function () { patch({ detail: null }); }, className: 'am-close' }, '✕')),
                        s.detail.loading
                          ? h('div', { className: 'am-hint' }, '读取中…')
                          : s.detail.error
                            ? h('div', { className: 'am-err' }, '读取失败：' + s.detail.error)
                            : h('div', null,
                                h('div', { className: 'am-kv' }, 'ID：' + s.detail.id),
                                h('div', { className: 'am-kv' }, '名称：' + (s.detail.name || '—')),
                                h('div', { className: 'am-kv' }, '信任：' + (s.detail.trust || '—')),
                                h('div', { className: 'am-kv' }, '描述：' + (s.detail.description || '—')),
                                h('div', { className: 'am-kv' }, 'agent.cordis.yml：'),
                                h('div', { className: 'am-code' }, s.detail.content || '(空)'))))
                  : null,
                // 删除确认弹层（二次确认，铁律）
                s.del
                  ? h('div', { className: 'am-modal' },
                      h('div', { className: 'am-card' },
                        h('div', { className: 'am-card-h' }, '删除智能体', h('span', null, '')),
                        h('div', null, '确定删除智能体「' + s.del.name + '」(id=' + s.del.id + ') 吗？此操作不可恢复。'),
                        s.delErr ? h('div', { className: 'am-err' }, s.delErr) : null,
                        h('div', { className: 'am-actions' },
                          h('button', { onClick: function () { patch({ del: null, delErr: null }); }, className: 'am-btn' }, '取消'),
                          h('button', { onClick: function () { doDelete(); }, className: 'am-btn am-btn-danger' }, '删除'))))
                  : null
              )
            : null
        );
      } catch (e) {
        return h('div', { style: { fontSize: 12, color: '#e5484d' }, title: String(e && e.stack ? e.stack : e) },
          '智能体工作台(加载失败): ' + (e && e.message ? e.message : e));
      }
    }

    /** 本客户端插件声明的能力（DSH cordis 规则：访问 ctx.remote.X 深层属性须声明完整
     *  带点 inject 名，且该名必须被某已加载插件 provide 过，否则插件会永久 pending 无法激活）：
     *   - 'slots'              : 注册侧边栏 footer 按钮（阶段1 已验证）
     *   - 'remote'             : ctx.remote 根服务（dsh-api-remotes 提供）
     *   - 'remote.agentPresets': dsh-client-ui-agent-preset 插件 provide，访问 list/select 必须声明
     *   - 'remote.session'     : dsh-api-session-controller 提供，访问 remote.session.create({agentPreset})
     *                            以创建带预设的会话（避免 blank 会话弹出混合选择菜单）
     *   - 'remote.workspace'   : dsh-api-workspace-controller 提供，访问 remote.workspace.create({path})
     *                            注册「智能体编排」专用 workspace，使对话式创建归属明确工作区（不进未分组）
     *   - 'sessions'           : 顶层服务（dsh-api-session-controller 在 2307 行 provide("sessions")），
     *                            ctx.sessions.list.getSnapshot().current 取当前会话 id
     *   - 'uiWorkspace'        : ctx.get('uiWorkspace').startSession() 新建并打开会话（官方路径，兜底）
     *   注：不存在 'remote.sessionController' 这个可注入名，故不声明（sessionController 无法 inject）。
     */
    var inject = ['slots', 'remote', 'remote.agentPresets', 'remote.session', 'remote.workspace', 'remote.directoryPicker', 'sessions', 'uiWorkspace'];
    var name = 'dsh-agent-maker';

    function apply(ctx) {
      // 浮层的全局监听（互斥广播 / Esc / 点击外部 / resize 重算）只注册一次，组件渲染时回填槽位
      bindPopoverGlobal();
      // 会话成为 current 时，若有待挂载预设，立即 select（比轮询更早，最大化 blank 窗口成功率）
      try {
        if (ctx.sessions && ctx.sessions.list && typeof ctx.sessions.list.subscribe === 'function') {
          ctx.sessions.list.subscribe(function () {
            if (!pendingPreset) return;
            var now = currentId(ctx);
            if (now && now !== pendingPreset.before) {
              var pend = pendingPreset; pendingPreset = null;
              applyPreset(ctx, now, pend.id);
            }
          });
        }
      } catch (e) { console.warn('[agent-maker] subscribe sessions.list', e); }
      ctx.slots.inject('sidebar.footer.action', function () {
        return ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'agent-maker-entry',
            order: 100,
            label: '智能体工作台'
          },
          function () {
            return h(AgentMakerPanel, { ctx: ctx });
          }
        );
      });
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
