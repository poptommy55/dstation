/**
 * dsh-skill-panel — browser half
 *
 * 注册：window.__ModuleLoader__.load({ id, factory })；宿主通过
 * package.json -> dsh.client.platform==="web" + exports["./client"] 发现本 bundle。
 *
 * ── 这个面板到底是干什么的（2026-09-12 定稿）─────────────────────────────
 * DSH 原生技能体系的两条消费路径（都已实测通过）：
 *   ① 用户侧：输入框打 /名字（或从 / 菜单里选）→ 宿主 pre-step 抓这个 token，
 *      把 SKILL.md 正文注入「当轮」。菜单选中与手打完全等价（都只落字面文本）。
 *   ② 模型侧：每个「模型可调用」的技能会在会话首请求前注入一份目录，
 *      模型据此自己决定要不要调 skill 工具加载。
 * 「安装一个技能」= 往技能根放一个 <name>/SKILL.md，**没有别的步骤**。
 * 所以本面板不是「安装器」，是**发现 + 编辑 + 一键发起**三件事的顺手入口：
 *   · 发现：/ 菜单里现在已经是「7 条宿主命令 + 一串技能」，技能一多就得滚着找；
 *   · 编辑：原生没有任何编辑 UI（SKILL.md 是纯文本文件）；
 *   · 一键：新会话 + 自动发 /名字，省掉「新建 → 打斜杠 → 选」三步。
 *
 * ── 数据源是两条腿（缺一不可）────────────────────────────────────────
 *   · remote.skills.list({sessionId})  ← DSH 原生 RPC，**合并后的权威目录**
 *     （按该会话的 cwd + preset 取；含插件运行时注册的技能，如 dsh-univer-office
 *      的 8 个 univer-*）。只有它有 name/description/whenToUse/modelInvocable，
 *     **但没有路径、没有正文**。
 *   · window.__DSTATION_SKILLS__.list() ← 外壳桥自扫 home/skills
 *     （有路径、有正文、还知道「这份文件会不会真的生效」）。**但看不到插件注册的**。
 *   按 name join 之后，面板就能显示一个纯 RPC 或纯扫盘都做不到的状态：
 *   「文件在，但没生效」——通常是 frontmatter 写错或 name 与目录名不一致，
 *   DSH 会静默丢弃。这个正好是最容易踩、又最难自查的坑。
 *
 * ── 浮层行为（v2 定稿 2026-09-12；dsh-agent-maker 用同一套，两边必须对称）────
 *   · 互斥：打开时用 document 广播 'dsh:popover-open'，别的浮层收到即自关 ——
 *     两个面板不可能同时出现在屏幕上。走事件而非共享模块，插件间零耦合，
 *     将来新增面板只要照抄这段就自动纳入互斥。**这是消灭「重叠」的机制，不是约定。**
 *   · 关闭：Esc（先让内层编辑/删除确认吃掉）· 点击面板外 · 再点触发按钮。
 *   · 位置：默认仍从触发按钮向上展开；按住标题栏拖动 → 位置写 localStorage
 *     （key = dsh.popover.pos.<POPOVER_ID>）并做四边钳制；双击标题栏复位。
 *     这是「不挡主工作区」的解：挪一次永久生效，不必每次躲。
 *   · resize 重算；未拖过就重新贴按钮，拖过就重新钳制。
 *
 * ── 兼容约束（与 dsh-agent-maker 同源，实测得出）──────────────────────
 *   · DSH 注入的 react 里 useEffect/useRef/Component 不一定可用
 *     → 只用 useState；异步一律 Promise.resolve().then()；编辑框用**非受控**
 *       textarea（defaultValue + 保存时从 DOM 读值），规避受控组件的重渲染光标问题。
 *   · 组件可能被宿主重挂载（切会话时）→ 数据同时写进模块级 SP 缓存，
 *     重挂载后渲染时同步回填。
 *   · 渲染体全包 try/catch：任何异常返回可读诊断，不白屏。
 *
 * ── 技能根（为什么是 home/skills）──────────────────────────────────────
 *   DSH 的技能根按 rank 合并：100 <项目>/.dsh/skills · 200 <项目>/.agents/skills
 *   · 300 custom(SKILL_DOCS_DIR) · 400 <DSH_HOME>/skills · 500 ~/.agents/skills。
 *   选 400 的唯一理由：**它是「跨智能体可见」的那一层**——一键发起时不管新会话
 *   用哪个 preset 都能 / 到它。绑进某个 preset 的 skills/ 就只有该智能体的会话看得见，
 *   那样「一键发起」还得连带锁定 preset，不通用。
 *   本插件只写 400 这一层；300(插件自定义) 与 100/200(项目级) 只读展示、不介入。
 */
window.__ModuleLoader__.load({
  id: 'dsh-skill-panel',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var react = require('react');
    var jsxRuntime = require('react/jsx-runtime');
    var render = jsxRuntime.jsx;

    /** jsx(type, props, children...) — jsx-runtime 要求 children 挂在 props 上。 */
    function h(type, props) {
      var children = Array.prototype.slice.call(arguments, 2);
      var cfg = props ? Object.assign({}, props) : {};
      if (children.length === 1) cfg.children = children[0];
      else if (children.length > 1) cfg.children = children;
      return render(type, cfg);
    }

    var BUILD = 'v2-20260912-popover-behavior';
    var SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

    // ---- 内联样式表（<style> + className；不依赖任何 react 生命周期）----
    var CSS = [
      // footerActions 容器默认 flex(row)，两个按钮会并排各占半宽；
      // 强制纵向排列 + 子项拉伸，让「技能」与「智能体工作台」上下同宽（与后者一致的观感）。
      // 注意 hHd-Xa_footerActions 是 DSH 的哈希 class，宿主升级后可能变名 —— 变了只是
      // 退化成并排，不影响功能（所以这里不做兼容探测，保持简单）。
      '.hHd-Xa_footerActions{display:flex !important;flex-direction:column !important;',
      'align-items:stretch !important;width:100% !important}',
      '.sp-footer-btn{display:flex;align-items:center;justify-content:center;width:100% !important;',
      'box-sizing:border-box;padding:9px 12px;margin:4px 0;cursor:pointer;',
      'background:rgba(255,255,255,0.05);color:#e8e8ea;border:1px solid rgba(255,255,255,0.1);',
      'border-radius:9px;font-size:13px;font-weight:500;',
      'transition:background .12s ease,border-color .12s ease}',
      '.sp-footer-btn:hover{background:rgba(124,156,255,0.16);border-color:rgba(124,156,255,0.4)}',
      // box-sizing:border-box 必须显式写：默认 content-box 下 width:412px + padding:16px
      // 实际占 446px，导致 max-width 与钳制计算都偏小 34px（窄窗口真的会溢出去）。
      '.sp-panel{position:fixed;box-sizing:border-box;width:412px;max-width:calc(100vw - 16px);max-height:78vh;overflow:auto;z-index:9999;',
      'background:#1f1f24;color:#e8e8ea;border:1px solid rgba(255,255,255,0.09);',
      'border-radius:14px;padding:16px;box-shadow:0 12px 40px rgba(0,0,0,0.55);',
      'font-size:13px;line-height:1.5}',
      '.sp-hd{display:flex;justify-content:space-between;align-items:center;font-size:15px;font-weight:600;',
      'cursor:move;user-select:none}',
      '.sp-hd:active{cursor:grabbing}',
      '.sp-close{cursor:pointer;opacity:.6;font-size:15px;padding:0 4px;user-select:none}',
      '.sp-close:hover{opacity:1}',
      '.sp-sub{font-size:11px;opacity:.45;margin-top:5px;word-break:break-all;',
      'font-family:ui-monospace,Menlo,Consolas,monospace}',
      '.sp-tabs{display:flex;gap:6px;margin:13px 0 10px}',
      '.sp-tab{flex:1;cursor:pointer;text-align:center;background:rgba(255,255,255,0.05);',
      'color:#e8e8ea;border:1px solid rgba(255,255,255,0.1);border-radius:8px;',
      'padding:7px 8px;font-size:12px;transition:background .12s,border-color .12s}',
      '.sp-tab:hover{background:rgba(124,156,255,0.14)}',
      '.sp-tab.on{background:rgba(124,156,255,0.2);border-color:rgba(124,156,255,0.5);font-weight:600}',
      '.sp-tools{display:flex;gap:8px;align-items:center;margin-bottom:9px}',
      '.sp-item{position:relative;display:flex;align-items:flex-start;gap:8px;margin-bottom:7px;',
      'background:rgba(255,255,255,0.035);border:1px solid rgba(255,255,255,0.08);',
      'border-radius:10px;padding:9px 11px;transition:background .12s,border-color .12s}',
      '.sp-item:hover{background:rgba(124,156,255,0.1);border-color:rgba(124,156,255,0.3)}',
      '.sp-item.bad{border-color:rgba(255,107,107,0.35)}',
      '.sp-item-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}',
      '.sp-name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
      'font-family:ui-monospace,Menlo,Consolas,monospace}',
      '.sp-desc{font-size:11.5px;opacity:.62;display:-webkit-box;-webkit-line-clamp:2;',
      '-webkit-box-orient:vertical;overflow:hidden}',
      '.sp-badges{display:flex;gap:5px;flex-wrap:wrap;margin-top:2px}',
      '.sp-badge{font-size:10px;padding:1px 6px;border-radius:5px;background:rgba(255,255,255,0.08);',
      'opacity:.85;white-space:nowrap}',
      '.sp-badge.ok{background:rgba(95,212,138,0.16);color:#7fe0a5}',
      '.sp-badge.off{background:rgba(255,255,255,0.07);color:rgba(232,232,234,0.6)}',
      '.sp-badge.bad{background:rgba(255,107,107,0.18);color:#ff9b9b}',
      '.sp-badge.gray{background:rgba(255,255,255,0.06);color:rgba(232,232,234,0.5)}',
      '.sp-acts{display:flex;align-items:center;gap:2px;flex-shrink:0;opacity:.6;transition:opacity .12s}',
      '.sp-item:hover .sp-acts{opacity:1}',
      '.sp-icon{cursor:pointer;width:26px;height:26px;border-radius:7px;border:none;background:transparent;',
      'color:#e8e8ea;font-size:14px;line-height:1;display:flex;align-items:center;justify-content:center;',
      'transition:background .12s}',
      '.sp-icon:hover{background:rgba(255,255,255,0.12)}',
      '.sp-icon.go{font-size:12px;width:auto;padding:0 9px;font-weight:600;color:#a9c0ff}',
      '.sp-icon.go:hover{background:rgba(124,156,255,0.2)}',
      /* 星标与「展开全部」。样式对齐 .sp-icon / .sp-icon.go，视觉上不突兀。 */
      '.sp-pin{font-size:13px}',
      '.sp-pin.on{color:#ffd66b}',
      '.sp-link{display:block;width:100%;margin-top:6px;padding:5px 0;background:transparent;',
      'border:none;color:#a9c0ff;font-size:11.5px;cursor:pointer;border-radius:7px;text-align:center}',
      '.sp-link:hover{background:rgba(124,156,255,0.14)}',
      '.sp-empty{font-size:12px;opacity:.5;padding:9px 2px}',
      '.sp-msg{font-size:11.5px;line-height:1.55;margin-top:9px;white-space:pre-wrap;word-break:break-word;opacity:.78}',
      '.sp-msg.ok{color:#5fd48a;opacity:1}',
      '.sp-msg.err{color:#ff6b6b;opacity:1}',
      '.sp-msg.warn{color:#ffc86b;opacity:1}',
      '.sp-err{font-size:11.5px;color:#ffb0b0;background:rgba(255,107,107,0.1);',
      'border:1px solid rgba(255,107,107,0.25);border-radius:8px;padding:7px 9px;margin-bottom:8px}',
      '.sp-note{font-size:11px;opacity:.5;margin-top:6px;line-height:1.5}',
      '.sp-modal{position:absolute;inset:0;background:rgba(0,0,0,0.62);display:flex;',
      'align-items:center;justify-content:center;padding:14px;z-index:10;border-radius:14px}',
      '.sp-card{background:#2a2a30;border:1px solid rgba(255,255,255,0.12);border-radius:12px;',
      'padding:15px;width:100%;max-height:92%;overflow:auto}',
      '.sp-card-h{display:flex;justify-content:space-between;align-items:center;font-weight:600;margin-bottom:10px}',
      '.sp-field{font-size:11px;opacity:.6;margin:9px 0 3px}',
      '.sp-input,.sp-area{width:100%;box-sizing:border-box;background:rgba(255,255,255,0.05);',
      'color:#e8e8ea;border:1px solid rgba(255,255,255,0.14);border-radius:8px;padding:8px 10px;',
      'font-size:12.5px;font-family:ui-monospace,Menlo,Consolas,monospace}',
      '.sp-input:focus,.sp-area:focus{outline:none;border-color:rgba(124,156,255,0.55)}',
      '.sp-area{min-height:230px;resize:vertical;line-height:1.55}',
      '.sp-actions{display:flex;gap:8px;margin-top:14px}',
      '.sp-btn{flex:1;cursor:pointer;border-radius:8px;padding:8px 0;font-size:13px;',
      'border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.06);color:#e8e8ea}',
      '.sp-btn:hover:not(:disabled){background:rgba(255,255,255,0.12)}',
      '.sp-btn:disabled{opacity:.45;cursor:default}',
      '.sp-btn-primary{background:rgba(124,156,255,0.2);border-color:rgba(124,156,255,0.45)}',
      '.sp-btn-primary:hover:not(:disabled){background:rgba(124,156,255,0.32)}',
      '.sp-btn-danger{background:rgba(255,107,107,0.18);border-color:rgba(255,107,107,0.45);color:#ff9b9b}',
      '.sp-btn-danger:hover:not(:disabled){background:rgba(255,107,107,0.3)}',
      '.sp-kv{font-size:12px;margin:3px 0;opacity:.85;word-break:break-all}',
      '.sp-code{background:#1a1a1f;border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:9px;',
      'font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;white-space:pre-wrap;',
      'word-break:break-word;max-height:150px;overflow:auto;margin-top:6px;color:#c8c8d0}'
    ].join('');

    var panelBase = { position: 'fixed', width: 412, overflow: 'auto', zIndex: 9999 };

    // ---- 模块级缓存：组件被宿主重挂载后，渲染时同步回填，不丢已加载的数据 ----
    var SP = {
      native: [], nativeErr: null,   // remote.skills.list 的结果
      disk: [], diskErr: null,       // 外壳桥扫 home/skills 的结果
      root: ''                       // 技能根绝对路径（桥回传）
    };

    // ---- 外壳技能库桥（preload 注入；旧版外壳没有 → 只读模式）----
    function skillBridge() {
      try {
        var b = (typeof window !== 'undefined') ? window.__DSTATION_SKILLS__ : null;
        return (b && b.available) ? b : null;
      } catch (e) { return null; }
    }

    // ---- 上传技能：支持 .zip 压缩包，或单独的 .md/.markdown/.txt + .json/.yaml/.yml 等文件 ----
    function abToBase64(buf) {
      var bytes = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf);
      var binary = '';
      var chunk = 0x8000;
      for (var i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(binary);
    }

    /** 调外壳桥导入：zip 走 importZip，其余走 importFiles（.md 当 SKILL.md，其余当资源） */
    function importSkillFiles(ctx, setS, patch, fileList) {
      var br = skillBridge();
      if (!br) { patch({ msg: '技能库通道不可用，请重启 D-STATION 后再试', msgKind: 'err' }); return; }
      var files = Array.prototype.slice.call(fileList || []);
      if (!files.length) return;
      patch({ msg: '正在导入 ' + files.length + ' 个文件…', msgKind: '' });
      Promise.all(files.map(function (f) {
        return new Promise(function (res, rej) {
          var r = new FileReader();
          r.onerror = function () { rej(new Error('读取失败：' + f.name)); };
          r.onload = function () { res({ name: f.name, data: abToBase64(r.result) }); };
          r.readAsArrayBuffer(f);
        });
      })).then(function (items) {
        var zipItem = items.find(function (it) { return /\.zip$/i.test(it.name); });
        var call = zipItem ? br.importZip({ data: zipItem.data }) : br.importFiles({ items: items });
        Promise.resolve(call).then(function (r) {
          if (r && r.ok) {
            var warn = (r.warnings && r.warnings.length) ? ('（' + r.warnings.length + ' 个文件被跳过，见控制台）') : '';
            patch({ msg: '已导入技能「' + r.name + '」' + warn, msgKind: 'ok' });
            if (r.warnings && r.warnings.length) console.warn('[skill-panel] 导入跳过的文件：', r.warnings);
            setTimeout(function () { loadDisk(setS); loadCatalog(ctx, setS); }, 350);
          } else {
            patch({ msg: '导入失败：' + ((r && r.error) || '未知错误'), msgKind: 'err' });
          }
        }).catch(function (e) {
          patch({ msg: '导入异常：' + (e && e.message ? e.message : e), msgKind: 'err' });
        });
      }).catch(function (e) {
        patch({ msg: '读取文件异常：' + (e && e.message ? e.message : e), msgKind: 'err' });
      });
    }

    /** 弹出系统文件选择框（多选），accept 覆盖 .zip/.md/.markdown/.txt/.json/.yaml/.yml */
    function openImportPicker(ctx, setS, patch) {
      try {
        var input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = '.zip,.md,.markdown,.txt,.json,.yaml,.yml';
        input.style.display = 'none';
        input.onchange = function () {
          if (input.files && input.files.length) importSkillFiles(ctx, setS, patch, input.files);
          if (input.parentNode) input.parentNode.removeChild(input);
        };
        input.onerror = function () { if (input.parentNode) input.parentNode.removeChild(input); };
        document.body.appendChild(input);
        input.click();
      } catch (e) {
        patch({ msg: '无法打开文件选择框：' + (e && e.message ? e.message : e), msgKind: 'err' });
      }
    }

    // 导出技能：调桥 -> 主进程弹「另存为」写出 .zip -> 提示路径
    function exportSkill(ctx, setS, patch, name) {
      var br = skillBridge();
      if (!br) { patch({ msg: SP.diskErr || '技能库文件通道不可用', msgKind: 'warn' }); return; }
      patch({ msg: '正在导出 ' + name + ' …', msgKind: '' });
      Promise.resolve(br.exportSkill(name)).then(function (r) {
        if (r && r.ok) {
          patch({ msg: '已导出 ' + name + '.zip（' + (r.count || 0) + ' 个文件）→ ' + (r.path || ''), msgKind: 'ok' });
        } else if (r && r.cancelled) {
          patch({ msg: '已取消导出', msgKind: '' });
        } else {
          patch({ msg: '导出失败：' + ((r && r.error) || '未知错误'), msgKind: 'err' });
        }
      }).catch(function (e) {
        patch({ msg: '导出失败：' + (e && e.message ? e.message : e), msgKind: 'err' });
      });
    }

    // ---- 当前会话 id（与 dsh-agent-maker 同一取法）----
    function currentSessionId(ctx) {
      try {
        var l = ctx.sessions && ctx.sessions.list;
        var snap = (l && typeof l.getSnapshot === 'function') ? l.getSnapshot() : null;
        return (snap && snap.current) || null;
      } catch (e) { return null; }
    }

    // ================= 浮层窗口行为（与 dsh-agent-maker 同一套约定） =================
    // 1) 互斥：任一浮层打开时广播 dsh:popover-open，其余浮层自动关闭 —— 同一时刻只留一个，
    //    从机制上消灭「两个面板叠在一起」。走 document 事件而非共享模块，故插件零耦合，
    //    将来新增任何面板只要照抄这段就自动纳入互斥。
    // 2) 关闭手势：Esc / 点击面板外 / 再次点触发按钮。监听器只在面板打开时生效。
    // 3) 位置：默认仍从触发按钮向上展开；按住标题栏可拖动，位置写进 localStorage 并做
    //    四边钳制（拖不出视口）；双击标题栏复位。这是「不挡主工作区」的解 —— 挪一次即永久生效。
    var POPOVER_ID = 'dsh-skill-panel';
    var POS_KEY = 'dsh.popover.pos.' + POPOVER_ID;
    var PANEL_SEL = '.sp-panel';
    var TRIGGER_SEL = '#skill-panel-trigger';
    var EDGE = 8;
    var PANEL_W = 412;

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

/* ---- 星标（置顶）--------------------------------------------------------
   和「智能体工作台」(dsh-agent-maker) 同一套做法：星标写进 localStorage，
   列表里星标的排前面，默认只显示前 3 条，其余折起来。
   目的：技能一多，面板就要滚很久才能找到常用的那个。            */
var PIN_KEY = 'dsh.skill-panel.pinned';
function loadPinned() {
  try {
    var raw = window.localStorage.getItem(PIN_KEY);
    var arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function savePinned(arr) {
  try { window.localStorage.setItem(PIN_KEY, JSON.stringify(arr)); } catch (e) {}
}

    function panelW(vw) { return Math.min(PANEL_W, Math.max(220, (vw || 0) - EDGE * 2)); }
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

    // ---- 锚点：点击按钮瞬间记录按钮位置，面板按它向上展开 ----
    function readTriggerRect() {
      try {
        var el = document.getElementById('skill-panel-trigger');
        if (el && el.getBoundingClientRect) return el.getBoundingClientRect();
      } catch (e) {}
      return null;
    }
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
          if (vw && left + w + EDGE > vw) left = Math.max(EDGE, vw - w - EDGE);
          return {
            left: left,
            bottom: Math.round(vh - r.top + EDGE),
            maxHeight: Math.max(120, Math.round(r.top - 20))
          };
        }
      } catch (e) {}
      return { left: 72, top: 56, maxHeight: '78vh' };
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
        // Esc：先让内层弹层（编辑/删除确认）吃掉，否则关面板
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
        // 视口变化 → 重算（拖动过就重新钳制，没拖过就重新贴按钮）
        window.addEventListener('resize', function () {
          try { if (WIN.isOpen && WIN.isOpen() && WIN.reposition) WIN.reposition(); } catch (e) {}
        });
      } catch (e) {}
    }

    // ---- 命令式重定位：直接改 style，不触发重渲染（拖动/resize/复位后用）----
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

    // 插件加载时取回上次拖动过的位置（没有就是 null → 跟随触发按钮）
    try { dragPos = readSavedPos(); } catch (e) {}

    // ---- 状态写入：模块级缓存 + 组件 state 双写 ----
    function applyState(setS, kv) {
      for (var k in kv) { if (Object.prototype.hasOwnProperty.call(kv, k)) SP[k] = kv[k]; }
      setS(function (p) {
        var n = Object.assign({}, p);
        for (var k2 in kv) { if (Object.prototype.hasOwnProperty.call(kv, k2)) n[k2] = kv[k2]; }
        return n;
      });
    }

    // ---- 数据源 1：DSH 原生合并目录（按会话的 cwd + preset 取）----
    function loadCatalog(ctx, setS) {
      var sid = currentSessionId(ctx);
      var svc = ctx.remote && ctx.remote.skills;
      if (!(svc && typeof svc.list === 'function')) {
        applyState(setS, { native: [], nativeErr: 'remote.skills 不可用：当前 DSH 组合未挂载技能 UI 插件（dsh-client-ui-skill）' });
        return;
      }
      if (!sid) {
        applyState(setS, { native: [], nativeErr: '当前没有打开的会话 —— 原生技能目录是「按会话」取的（依赖该会话的 cwd + preset）。打开任意会话后即可在此看到完整列表。' });
        return;
      }
      try {
        Promise.resolve(svc.list({ sessionId: sid })).then(function (res) {
          if (!res || !res.ok) {
            var em = (res && res.error && (res.error.code + ': ' + res.error.message)) || 'skills/list 调用失败';
            applyState(setS, { nativeErr: em });
            return;
          }
          applyState(setS, { native: (res.value && res.value.skills) || [], nativeErr: null });
        }).catch(function (e) {
          applyState(setS, { nativeErr: 'skills/list 异常：' + (e && e.message ? e.message : e) });
        });
      } catch (e) {
        applyState(setS, { nativeErr: 'skills/list 抛出：' + (e && e.message ? e.message : e) });
      }
    }

    // ---- 数据源 2：外壳桥扫 home/skills（有路径/正文/生效判定）----
    function loadDisk(setS) {
      var br = skillBridge();
      if (!br) {
        applyState(setS, { disk: [], diskErr: '未检测到技能库文件通道：可以浏览与发起，但不能新建/编辑/删除。原因通常是外壳版本较旧（该通道随 2026-09-12 的外壳更新引入），重启一次 D-STATION 即可。' });
        return;
      }
      try {
        Promise.resolve(br.list()).then(function (r) {
          if (!r || !r.ok) { applyState(setS, { diskErr: (r && r.error) || '技能根扫描失败' }); return; }
          applyState(setS, { disk: r.skills || [], root: r.root || '', diskErr: null });
        }).catch(function (e) {
          applyState(setS, { diskErr: '技能根扫描异常：' + (e && e.message ? e.message : e) });
        });
      } catch (e) {
        applyState(setS, { diskErr: '技能根扫描抛出：' + (e && e.message ? e.message : e) });
      }
    }

    /**
     * 两腿 join（按 name）→ 两个分组：
     *   mine   = home/skills 里有文件的（可编辑/删除）—— 含「文件在但没生效」的
     *   plugin = 只在原生目录里出现的（插件运行时注册，如 univer-*）—— 只读
     */
    function groupSkills(native, disk) {
      var diskMap = {};
      (disk || []).forEach(function (d) { if (d && d.name) diskMap[d.name] = d; });
      var seen = {};
      var mine = [], plugin = [];
      (native || []).forEach(function (n) {
        if (!n || !n.name) return;
        seen[n.name] = true;
        var d = diskMap[n.name];
        var row = {
          name: n.name,
          description: n.description || '',
          whenToUse: n.whenToUse || '',
          modelInvocable: !!n.modelInvocable,
          effective: true,
          disk: d || null
        };
        if (d) mine.push(row); else plugin.push(row);
      });
      (disk || []).forEach(function (d) {
        if (!d || !d.name || seen[d.name]) return;
        var pf = d.parsed || {};
        mine.push({
          name: d.name,
          description: pf.description || '',
          whenToUse: pf.whenToUse || '',
          modelInvocable: String(pf['disable-model-invocation'] || '') !== 'true',
          effective: false,
          disk: d
        });
      });
      var byName = function (a, b) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); };
      mine.sort(byName);
      plugin.sort(byName);
      return { mine: mine, plugin: plugin };
    }

    /** 新建技能的文件模板（frontmatter 必填项 + 两个开关的注释说明） */
    function skillTemplate(name) {
      var n = name || 'my-skill';
      return [
        '---',
        'name: ' + n,
        'description: 一句话说明这个技能做什么、什么时候该用它（模型就是靠这句话判断要不要自动加载）。',
        '---',
        '',
        '# ' + n,
        '',
        '在这里写正文：步骤 / 规则 / 示例。',
        '',
        '<!-- 可选开关（放在上面 --- 之间）：',
        '     disable-model-invocation: true  只允许手动打 /' + n + ' 调用，不进模型目录（零常驻 token）',
        '     user-invocable: false           反过来：只让模型自己用，不进 / 菜单 -->',
        ''
      ].join('\n');
    }

    /** 读当前会话的 cwd / agentPreset（用于把新会话置成与当前同源，避免弹预设选择页） */
    function readCurrentContext(ctx, sid, cb) {
      try {
        var rs = ctx.remote && ctx.remote.session;
        if (!(rs && typeof rs.list === 'function') || !sid) { cb(null); return; }
        Promise.resolve(rs.list({})).then(function (r) {
          if (!(r && r.ok)) { cb(null); return; }
          var items = (r.value && r.value.items) || [];
          for (var i = 0; i < items.length; i++) {
            if (items[i].sessionId !== sid) continue;
            var pv = (items[i].projections && items[i].projections.values) || {};
            cb({ preset: pv.agentPreset || '', cwd: items[i].cwd || '' });
            return;
          }
          cb(null);
        }).catch(function () { cb(null); });
      } catch (e) { cb(null); }
    }

    // ================= 「技能使用」分区（技能会话的专属归属）=================
    // 为什么必须这么做：分区（workspace）是按 path 归属的，而 session.create 的
    // workspaceId 与 cwd 是【互斥】的（同时传会被服务端直接拒）。旧实现只传 cwd
    // （且取的是「当前会话」的 cwd），一旦取不到或被拒就降级成 create({}) ——
    // cwd 随即变成 DSH 服务进程自己的工作目录（<dist>/app），而它不属于任何分区，
    // ⇒ 会话落「未分组」。现在统一走 workspaceId：ensureSkillWorkspace() 幂等拿 id。
    var SKILL_WS_TITLE = '技能使用';
    var SKILL_WS_DIRNAME = 'skill-sessions';
    var _skillWsId = '';   // 模块级缓存；workspace.create 按 path 幂等，缓存丢了也能自愈

    // 解析 DSH home 绝对路径（【可移植】，不依赖原生能力/异步磁盘扫描）：
    // 当前会话的 cwd 形如 <home>/<分区名>（如 .../build/dist/home/agent-orchestration），
    // 向上找第一个含 skills 子目录的祖先即为 home。换机/换路径也能正确归组。
    // 兜底（仅当无当前会话 cwd 时）：process.env.DSH_HOME → 写死开发机路径（与 agent-maker 同策略）。
    function homeFromCwd(cwd) {
      if (!cwd || typeof require !== 'function') return '';
      var fsx = require('fs');
      if (!fsx || typeof fsx.existsSync !== 'function' || typeof fsx.statSync !== 'function') return '';
      var p = String(cwd).replace(/[\\/]+$/, '');
      var sep = p.indexOf('\\') >= 0 ? '\\' : '/';
      while (true) {
        try {
          if (fsx.existsSync(p) && fsx.statSync(p).isDirectory() && fsx.existsSync(p + sep + 'skills')) return p;
        } catch (e) {}
        var idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
        if (idx <= 0) break;
        p = p.slice(0, idx);
      }
      return '';
    }
    function fallbackHomeSync() {
      try { if (typeof process !== 'undefined' && process.env && process.env.DSH_HOME) return process.env.DSH_HOME; } catch (e) {}
      // No reliable way to derive home: return '' so callers degrade instead of
      // guessing a path that only exists on the developer's machine.
      return '';
    }
    // 由 home 推出「技能使用」分区目录（home/skill-sessions）
    function skillSessionsDir(home) {
      if (!home) return '';
      var sep = home.indexOf('\\') >= 0 ? '\\' : '/';
      return home.replace(/[\\/]+$/, '') + sep + SKILL_WS_DIRNAME;
    }

    /** 幂等确保「技能使用」分区存在；成功回传 workspaceId，失败回传 ''。
     *  home 由调用方从【当前会话 cwd】推导后传入（可移植）；拿不到则降级 cwd 兜底。 */
    function ensureSkillWorkspace(ctx, home, cb) {
      if (_skillWsId) { cb(_skillWsId); return; }
      // ⚠️ 必须整段包 try：DSH 的注入代理对**未声明的深层属性**不是返回 undefined，
      //    而是直接 throw（cannot get property "remote.workspace" without inject），
      //    旧的 `ctx && ctx.remote && ...` 守卫挡不住 → 异常一路冒泡出 launch()，
      //    面板永久停在「正在新建会话…」。所以这里无论怎么错都要 cb('') 让主流程继续。
      var ws = null;
      try { ws = ctx && ctx.remote && ctx.remote.workspace; } catch (e) { ws = null; }
      if (!(ws && typeof ws.create === 'function')) { console.warn('[skill-panel] remote.workspace 不可用，跳过分区归类'); cb(''); return; }
      if (!home) { console.warn('[skill-panel] 无法解析 home 目录（无当前会话 cwd），跳过分区归类'); cb(''); return; }
      var dir = skillSessionsDir(home);
      console.info('[skill-panel] 技能使用分区目录 =', dir);
      // 注：workspaceRegistry.create 只认 path，title 会被忽略（自动取目录名 skill-sessions），
      // 因此创建后再用 rename 改成「技能使用」。本插件 bundle 里 require('fs') 不可用
      // （与 agent-maker 不同上下文），但 create 自身会建目录，无需手动兜底。
      Promise.resolve(ws.create({ path: dir, title: SKILL_WS_TITLE }))
        .then(function (r) {
          if (!(r && r.ok)) { console.warn('[skill-panel] remote.workspace.create 未返回 ok，降级 cwd:', r && r.error && r.error.message); cb(''); return; }
          console.info('[skill-panel] remote.workspace.create ->', JSON.stringify(r && r.value));
          var wid = (r && r.value && r.value.workspace && r.value.workspace.workspaceId)
                 || (r && r.value && r.value.workspaceId);   // 兼容两种返回形状
          console.info('[skill-panel] 解析到 workspaceId =', wid);
          if (!wid) { cb(''); return; }
          // 改名成「技能使用」：create 的 title 被忽略，必须 rename（fire-and-forget，不改流程）
          try {
            if (typeof ws.rename === 'function') {
              Promise.resolve(ws.rename({ workspaceId: wid, title: SKILL_WS_TITLE }))
                .then(function () { console.info('[skill-panel] 分区已改名为「技能使用」'); })
                .catch(function (e) { console.warn('[skill-panel] 分区改名失败（保留 skill-sessions 标题）:', e && e.message); });
            }
          } catch (e) { /* 改名失败不致命，分区已存在即可 */ }
          cb(wid);
        })
        .catch(function (e) { console.warn('[skill-panel] workspace.create 失败，降级 cwd:', e && e.message); cb(''); });
    }

    /** 面板主体 */
    function SkillPanel(props) {
      var ctx = props.ctx;
      var st = react.useState(function () {
        return {
          open: false, anchor: null, once: false, tab: 'mine',
          busy: '', msg: '', msgKind: '',
          pinned: loadPinned(),   // 星标技能名（有序：星标顺序 = 置顶顺序）
          expanded: false,        // false = 只显示前 3 条，其余折起来
          edit: null,      // { name, text, isNew, loading, busy, err }
          del: null,       // { name, busy, err }
          native: SP.native, nativeErr: SP.nativeErr,
          disk: SP.disk, diskErr: SP.diskErr, root: SP.root
        };
      });
      var s = st[0], setS = st[1];

      if (!s.once) {
        setS(function (p) { var n = Object.assign({}, p); n.once = true; return n; });
        Promise.resolve().then(function () { loadCatalog(ctx, setS); loadDisk(setS); });
      }

      function patch(kv) {
        setS(function (p) { var n = Object.assign({}, p); for (var k in kv) n[k] = kv[k]; return n; });
      }

      /* 星标/取消星标。写法与「智能体工作台」一致：
         先算新数组 → 落 localStorage → 再 patch 进状态。
         localStorage 失败也不影响本次会话（只是下次打开记不住）。 */
      function togglePin(name) {
        var next = s.pinned.slice();
        var i = next.indexOf(name);
        if (i >= 0) next.splice(i, 1);
        else next.unshift(name);        // 新星标放最前 → 置顶顺序 = 你点星标的顺序
        savePinned(next);
        patch({ pinned: next });
      }
      function toggleOpen() {
        if (s.open) { patch({ open: false }); return; }
        announceOpen();                 // 先广播，让别的浮层让位（互斥）
        patch({ open: true, anchor: readTriggerRect() });
        // 每次打开都刷新一次：技能可能在别处（手改文件、别的插件）刚变过
        Promise.resolve().then(function () { loadCatalog(ctx, setS); loadDisk(setS); });
        // 挂载后按真实高度再钳一次（内容高度这一刻才知道，拖动位置才不会出界）
        setTimeout(function () { try { if (dragPos) repositionPanel(); } catch (e) {} }, 30);
      }

      // 双击标题栏：丢掉记住的位置，回到「贴着触发按钮向上展开」的默认态
      function resetPos() {
        dragPos = null; dragHeight = 0; clearSavedPos();
        patch({ anchor: readTriggerRect() });
        setTimeout(function () { try { repositionPanel(); } catch (e) {} }, 30);
      }

      // ================= 一键发起：新会话 + 自动发 /名字 =================
      // 复用 dsh-agent-maker 已验证的链路（workspace.create → session.create →
      // sessions.open → session.prompt）。差异：
      //   · 技能是「全局可见」的，所以不需要锁定任何 preset，用**当前会话的 preset** 最自然；
      //   · 用 session/list 读当前会话的 cwd + agentPreset（投影里有），
      //     比 agent-maker 自建专用 workspace 更轻 —— 新会话跟当前会话同目录同智能体。
      function launch(name) {
        if (s.busy) return;
        // 顶层兜底：任何异常都必须落到面板提示并解除 busy。
        // 教训（2026-09-12）：DSH 注入代理对未声明深层属性是【抛异常】而非返回 undefined，
        // 旧代码在 patch({busy}) 之后抛 → 面板永久停在「正在新建会话…」、按钮 disabled，
        // 用户看到的就是「发起后卡死 / 死链」，而不是一条错误提示。
        function fail(e) {
          patch({ busy: '', msg: '发起失败：' + (e && e.message ? e.message : String(e)), msgKind: 'err' });
        }
        try {
          if (!(ctx.remote && ctx.remote.session && typeof ctx.remote.session.create === 'function')) {
            patch({ msg: 'DSH 的 remote.session.create 不可用，无法新建会话', msgKind: 'err' });
            return;
          }
          patch({ busy: name, msg: '正在新建会话…', msgKind: '' });
          // 先读当前会话 cwd 推出 home（可移植），再幂等确保「技能使用」分区，最后建会话
          try {
            readCurrentContext(ctx, currentSessionId(ctx), function (info) {
              var payload = {};
              if (info && info.preset) payload.agentPreset = info.preset;
              // 从当前会话 cwd 向上找含 skills 的祖先 = home（不依赖原生能力/异步扫描）
              var home = homeFromCwd(info && info.cwd) || fallbackHomeSync();
              ensureSkillWorkspace(ctx, home, function (wid) {
                try {
                  if (wid) {
                    payload.workspaceId = wid;          // ← 归组（首选路径）
                    createSession(ctx, payload, name, setS, patch, wid, home);
                    return;
                  }
                  // 分区没拿到 → 用 home/skill-sessions 作为 cwd 兜底（绝不用 DSH 服务 cwd）
                  if (home) payload.cwd = skillSessionsDir(home);
                  createSession(ctx, payload, name, setS, patch, '', home);
                } catch (e) { fail(e); }
              });
            });
          } catch (e) { fail(e); }
        } catch (e) { fail(e); }
      }

      // 分级降级，但【永远不丢定位字段】—— 旧实现「失败就 create({})」正是会话落
      // 「未分组」的直接原因（cwd 会退成 DSH 服务自己的工作目录 <dist>/app）。
      //   ① agentPreset 被拒 → 只去掉它，定位字段不动；
      //   ② workspaceId 被拒 → 换成等价的 cwd（同一目录，同样能归组），不留空。
      function createSession(ctx, payload, name, setS, patch, wid, home) {
        try {
          Promise.resolve(ctx.remote.session.create(payload)).then(function (r) {
            if (!(r && r.ok && r.value && r.value.sessionId)) {
              if (payload.agentPreset) {
                var p1 = Object.assign({}, payload); delete p1.agentPreset;
                createSession(ctx, p1, name, setS, patch, wid, home); return;
              }
              if (payload.workspaceId) {
                // workspaceId 被拒 → 换成等价的 cwd（同一目录，同样能归组），不留空。
                var p2 = Object.assign({}, payload); delete p2.workspaceId;
                if (home) p2.cwd = skillSessionsDir(home);
                createSession(ctx, p2, name, setS, patch, '', home);
                return;
              }
              patch({ busy: '', msg: '新建会话失败：' + ((r && r.error && r.error.message) || '未返回 sessionId'), msgKind: 'err' });
              return;
            }
            var sid = r.value.sessionId;
            try { if (ctx.sessions && typeof ctx.sessions.open === 'function') ctx.sessions.open(sid); } catch (e) {}
            patch({ msg: '已新建会话（技能使用分区），正在发送 /' + name + ' …' });
            sendSlash(ctx, sid, name, setS, patch, 0);
          }).catch(function (e) {
            if (payload.agentPreset) {
              var p3 = Object.assign({}, payload); delete p3.agentPreset;
              createSession(ctx, p3, name, setS, patch, wid, home); return;
            }
            patch({ busy: '', msg: '新建会话异常：' + (e && e.message ? e.message : e), msgKind: 'err' });
          });
        } catch (e) {
          patch({ busy: '', msg: '新建会话抛出：' + (e && e.message ? e.message : e), msgKind: 'err' });
        }
      }

      // 会话刚建好时 agent 可能还没就绪，prompt 会被拒 → 短重试（与 agent-maker 同策略）
      function sendSlash(ctx, sid, name, setS, patch, attempt) {
        var DELAY = 400, MAX = 15;
        try {
          var rs = ctx.remote && ctx.remote.session;
          if (!(rs && typeof rs.prompt === 'function')) { patch({ busy: '', msg: 'remote.session.prompt 不可用', msgKind: 'err' }); return; }
          var uuid = (typeof crypto !== 'undefined' && crypto.randomUUID)
            ? crypto.randomUUID()
            : ('sp-' + Date.now() + '-' + Math.random().toString(36).slice(2));
          Promise.resolve(rs.prompt({
            sessionId: sid, requestId: uuid, mode: 'queue',
            content: [{ type: 'text', text: '/' + name }]
          })).then(function (r) {
            if (r && r.ok) {
              patch({ busy: '', msg: '已在新会话发起 /' + name + '（左手边新会话里就能看到技能正文生效）', msgKind: 'ok' });
            } else if (attempt < MAX) {
              setTimeout(function () { sendSlash(ctx, sid, name, setS, patch, attempt + 1); }, DELAY);
            } else {
              patch({ busy: '', msg: '发送 /' + name + ' 失败：' + ((r && r.error && r.error.message) || '未确认'), msgKind: 'err' });
            }
          }).catch(function (e) {
            if (attempt < MAX) setTimeout(function () { sendSlash(ctx, sid, name, setS, patch, attempt + 1); }, DELAY);
            else patch({ busy: '', msg: '发送异常：' + (e && e.message ? e.message : e), msgKind: 'err' });
          });
        } catch (e) {
          patch({ busy: '', msg: '发送抛出：' + (e && e.message ? e.message : e), msgKind: 'err' });
        }
      }

      // ================= 编辑 / 新建 / 删除（走外壳技能库桥）=================
      function openEditor(name, isNew) {
        var br = skillBridge();
        if (!br) { patch({ msg: SP.diskErr || '技能库文件通道不可用', msgKind: 'warn' }); return; }
        if (isNew) { patch({ edit: { name: '', text: skillTemplate(''), isNew: true, loading: false, busy: false, err: null } }); return; }
        patch({ edit: { name: name, text: '', isNew: false, loading: true, busy: false, err: null } });
        Promise.resolve(br.read(name)).then(function (r) {
          if (r && r.ok) patch({ edit: { name: name, text: r.text, isNew: false, loading: false, busy: false, err: null } });
          else patch({ edit: { name: name, text: '', isNew: false, loading: false, busy: false, err: (r && r.error) || '读取失败' } });
        }).catch(function (e) {
          patch({ edit: { name: name, text: '', isNew: false, loading: false, busy: false, err: String(e && e.message ? e.message : e) } });
        });
      }

      function doSave() {
        var ed = s.edit;
        if (!ed || ed.busy) return;
        var br = skillBridge();
        if (!br) return;
        // 非受控输入：保存这一刻才从 DOM 读值（避开受控组件的重渲染光标问题）
        var nameEl = document.getElementById('sp-edit-name');
        var taEl = document.getElementById('sp-edit-ta');
        var name = String(ed.isNew ? ((nameEl && nameEl.value) || '') : ed.name).trim();
        var text = (taEl && taEl.value) || '';
        if (!SKILL_NAME_RE.test(name)) {
          patch({ edit: Object.assign({}, ed, { err: '技能名只能是小写字母/数字/连字符（kebab-case），且以字母或数字开头' }) });
          return;
        }
        if (!text.trim()) { patch({ edit: Object.assign({}, ed, { err: '内容不能为空' }) }); return; }
        patch({ edit: Object.assign({}, ed, { busy: true, err: null }) });
        Promise.resolve(br.write({ name: name, text: text })).then(function (r) {
          if (r && r.ok) {
            patch({ edit: null, msg: '已保存 ' + name + ' —— 宿主有文件监听，下一个模型步即生效，不用重启', msgKind: 'ok' });
            setTimeout(function () { loadDisk(setS); loadCatalog(ctx, setS); }, 350);
          } else {
            patch({ edit: Object.assign({}, ed, { busy: false, err: (r && r.error) || '保存失败' }) });
          }
        }).catch(function (e) {
          patch({ edit: Object.assign({}, ed, { busy: false, err: String(e && e.message ? e.message : e) }) });
        });
      }

      function doRemove() {
        var d = s.del;
        if (!d || d.busy) return;
        var br = skillBridge();
        if (!br) return;
        patch({ del: Object.assign({}, d, { busy: true, err: null }) });
        Promise.resolve(br.remove(d.name)).then(function (r) {
          if (r && r.ok) {
            patch({ del: null, msg: '已删除 ' + d.name + (r.trashed ? '（已移入回收站）' : '（永久删除，未走回收站）'), msgKind: 'ok' });
            setTimeout(function () { loadDisk(setS); loadCatalog(ctx, setS); }, 350);
          } else {
            patch({ del: Object.assign({}, d, { busy: false, err: (r && r.error) || '删除失败' }) });
          }
        }).catch(function (e) {
          patch({ del: Object.assign({}, d, { busy: false, err: String(e && e.message ? e.message : e) }) });
        });
      }

      // ================= 渲染 =================
      try {
        var groups = groupSkills(s.native, s.disk);
        var rows = s.tab === 'plugin' ? groups.plugin : groups.mine;

        /* 星标排前面、其余保持原顺序；未展开时只显示前 3 条。
           与「智能体工作台」同一套规则：点了星标的浮到最上，
           其余的靠「展开全部 (N)」再看 —— 面板就不会一打开就长得要滚。 */
        var sorted = rows.slice().sort(function (a, b) {
          var ia = s.pinned.indexOf(a.name), ib = s.pinned.indexOf(b.name);
          if (ia === -1 && ib === -1) return 0;   // 都没星标：保持原顺序（稳定排序）
          if (ia === -1) return 1;
          if (ib === -1) return -1;
          return ia - ib;
        });
        var visible = s.expanded ? sorted : sorted.slice(0, 3);
        /* 只数**当前分区里**星标的条数 —— s.pinned 里可能留着已被删掉的技能名 */
        var pinnedHere = sorted.filter(function (x) { return s.pinned.indexOf(x.name) >= 0; }).length;
        var pos = computePanelPos(s.anchor);
        var canEdit = !!skillBridge();

        // 每次渲染刷新浮层行为槽位：模块级监听器只注册一次，靠这三个闭包操作当前组件
        WIN.isOpen = function () { return !!s.open; };
        WIN.close = function () { try { patch({ open: false }); } catch (e) {} };
        WIN.esc = function () {   // 返回 true = 内层弹层吃掉了 Esc，不再关面板
          if (s.edit) { patch({ edit: null }); return true; }
          if (s.del) { patch({ del: null }); return true; }
          return false;
        };
        WIN.reposition = repositionPanel;
        WIN.anchor = s.anchor;

        return h('div', null,
          h('style', null, CSS),
          h('div', {
            id: 'skill-panel-trigger', role: 'button', className: 'sp-footer-btn',
            title: '技能：浏览 / 编辑 / 一键发起（DSH 原生技能库）',
            onClick: toggleOpen
          }, '技能'),
          s.open
            ? h('div', { className: 'sp-panel', style: Object.assign({}, panelBase, pos) },
                h('div', { className: 'sp-hd', title: '按住拖动移动面板 · 双击复位',
                  onMouseDown: startDrag, onDoubleClick: resetPos },
                  '技能库',
                  h('span', { role: 'button', className: 'sp-close', title: '关闭', onClick: function () { patch({ open: false }); } }, '✕')),
                h('div', { className: 'sp-sub' }, s.root || '技能根：<DSH_HOME>/skills'),

                // 分区切换
                h('div', { className: 'sp-tabs' },
                  h('div', { className: 'sp-tab' + (s.tab === 'mine' ? ' on' : ''), role: 'button',
                    onClick: function () { patch({ tab: 'mine' }); } },
                    '我的技能 (' + groups.mine.length + ')'),
                  h('div', { className: 'sp-tab' + (s.tab === 'plugin' ? ' on' : ''), role: 'button',
                    onClick: function () { patch({ tab: 'plugin' }); } },
                    '插件自带 (' + groups.plugin.length + ')')),

                // 工具行
                s.tab === 'mine'
                  ? h('div', { className: 'sp-tools' },
                      h('button', { className: 'sp-btn', style: { flex: '0 0 auto', padding: '6px 12px', fontSize: '12px' },
                        disabled: !canEdit, title: canEdit ? '在 home/skills 下新建一个技能' : '需要技能库文件通道（重启一次 D-STATION）',
                        onClick: function () { openEditor('', true); } }, '＋ 新建技能'),
                      h('button', { className: 'sp-btn', style: { flex: '0 0 auto', padding: '6px 12px', fontSize: '12px' },
                        disabled: !canEdit, title: '改用本地文件夹直接编辑（SKILL.md 就是普通文本文件）',
                        onClick: function () { patch({ msg: s.root ? ('技能根：' + s.root) : '技能根路径未知', msgKind: '' }); } }, '路径'),
                      h('button', { className: 'sp-btn', style: { flex: '0 0 auto', padding: '6px 12px', fontSize: '12px' },
                        disabled: !canEdit, title: canEdit ? '上传技能包（.zip）或单个 .md/.json/.yaml 等文件' : '需要技能库文件通道（重启一次 D-STATION）',
                        onClick: function () { openImportPicker(ctx, setS, patch); } }, '⬆ 上传技能'))
                  : null,

                // 报错块（两条数据源各自的）
                (s.diskErr && s.tab === 'mine') ? h('div', { className: 'sp-err' }, s.diskErr) : null,
                s.nativeErr ? h('div', { className: 'sp-err' }, s.nativeErr) : null,

                // 列表
                rows.length === 0
                  ? h('div', { className: 'sp-empty' },
                      s.tab === 'plugin'
                        ? '当前会话看不到插件注册的技能（或确实没有）。'
                        : (canEdit ? '还没有自己的技能，点「＋ 新建技能」写一个。' : '没有可显示的技能。'))
                  : visible.map(function (it) {
                      var d = it.disk || {};
                      return h('div', { key: it.name, className: 'sp-item' + (it.effective ? '' : ' bad') },
                        h('div', { className: 'sp-item-main' },
                          h('div', { className: 'sp-name' }, it.name),
                          it.description
                            ? h('div', { className: 'sp-desc' }, it.description)
                            : h('div', { className: 'sp-desc' }, it.effective ? '（没有描述：模型不会自动用它，只在你手动打 /名字 时生效）' : '（没有可用描述）'),
                          h('div', { className: 'sp-badges' },
                            it.effective
                              ? (it.modelInvocable
                                  ? h('span', { className: 'sp-badge ok' }, '模型可自动用')
                                  : h('span', { className: 'sp-badge off' }, '仅手动调用'))
                              : h('span', { className: 'sp-badge bad' }, '未生效'),
                            it.disk ? h('span', { className: 'sp-badge gray' }, d.relPath) : h('span', { className: 'sp-badge gray' }, '插件注册'),
                            it.whenToUse ? h('span', { className: 'sp-badge gray' }, '有 whenToUse') : null),
                          (!it.effective && d.reason) ? h('div', { className: 'sp-note' }, '　→ ' + d.reason) : null),
                        h('div', { className: 'sp-acts' },
                          /* 星标放最前：它是「显示哪些」的开关，不是对技能本身的操作，
                             跟后面的编辑/导出/删除区分开。 */
                          (function () {
                            var on = s.pinned.indexOf(it.name) >= 0;
                            return h('button', {
                              className: 'sp-icon sp-pin' + (on ? ' on' : ''),
                              title: on ? '取消星标（不再置顶）' : '加星标（置顶显示）',
                              onClick: function (e) { e.stopPropagation(); togglePin(it.name); }
                            }, on ? '★' : '☆');
                          })(),
                          h('button', { className: 'sp-icon go', disabled: !!s.busy, title: '新建会话并自动发送 /' + it.name,
                            onClick: function () { launch(it.name); } }, s.busy === it.name ? '…' : '发起'),
                          it.disk
                            ? h('button', { className: 'sp-icon', disabled: !canEdit, title: '编辑 SKILL.md 正文', onClick: function () { openEditor(it.name, false); } }, '✎')
                            : null,
                          it.disk
                            ? h('button', { className: 'sp-icon', disabled: !canEdit, title: '导出为 .zip（可分享给他人）', onClick: function () { exportSkill(ctx, setS, patch, it.name); } }, '⬇')
                            : null,
                          it.disk
                            ? h('button', { className: 'sp-icon', disabled: !canEdit, title: '删除这个技能', onClick: function () { patch({ del: { name: it.name, busy: false, err: null } }); } }, '🗑')
                            : null));
                    }),

                /* 展开 / 收起。只有超过 3 条时才需要这个按钮。
                   文案与「智能体工作台」保持一致。 */
                sorted.length > 3
                  ? h('button', { className: 'sp-link', onClick: function () { patch({ expanded: !s.expanded }); } },
                      s.expanded
                        ? '收起'
                        : ('展开全部 (' + sorted.length + ')' + (pinnedHere ? ' · 已星标 ' + pinnedHere + ' 个' : '')))
                  : null,

                s.tab === 'plugin'
                  ? h('div', { className: 'sp-note' }, '这些技能由插件在运行时注册（正文在插件包内部），没有磁盘文件，因此不可编辑。「发起」对它们同样可用。')
                  : null,

                s.msg ? h('div', { className: 'sp-msg ' + (s.msgKind || '') }, s.msg) : null,
                h('div', { className: 'sp-note' }, '装一个技能 = 往技能根放一个 <name>/SKILL.md，没有别的步骤。用户侧打 /名字（或菜单选），宿主会把正文注入当轮；模型侧也会收到一份目录，自己判断要不要加载。'),
                h('div', { className: 'sp-note' }, '面板：按住标题栏拖动（位置会记住，双击标题栏复位）· Esc 或点击面板外即关 · 本面板与智能体工作台互斥，开一个自动关另一个。'),

                // 编辑/新建弹层
                s.edit
                  ? h('div', { className: 'sp-modal' },
                      h('div', { className: 'sp-card' },
                        h('div', { className: 'sp-card-h' },
                          s.edit.isNew ? '新建技能' : ('编辑 ' + s.edit.name),
                          h('span', { role: 'button', className: 'sp-close', onClick: function () { patch({ edit: null }); } }, '✕')),
                        s.edit.isNew
                          ? h('div', null,
                              h('div', { className: 'sp-field' }, '技能名（kebab-case，会成为目录名，也是 /名字 里的名字）'),
                              h('input', { className: 'sp-input', id: 'sp-edit-name', defaultValue: '', placeholder: 'my-skill', spellCheck: false }))
                          : h('div', { className: 'sp-kv' }, '技能名：' + s.edit.name),
                        s.edit.loading
                          ? h('div', { className: 'sp-note' }, '读取中…')
                          : h('div', null,
                              h('div', { className: 'sp-field' }, 'SKILL.md 全文'),
                              h('textarea', { className: 'sp-area', id: 'sp-edit-ta', defaultValue: s.edit.text, spellCheck: false })),
                        s.edit.err ? h('div', { className: 'sp-err', style: { marginTop: '10px' } }, s.edit.err) : null,
                        h('div', { className: 'sp-actions' },
                          h('button', { className: 'sp-btn', onClick: function () { patch({ edit: null }); } }, '取消'),
                          h('button', { className: 'sp-btn sp-btn-primary', disabled: !!s.edit.busy || !!s.edit.loading,
                            onClick: doSave }, s.edit.busy ? '保存中…' : '保存'))))
                  : null,

                // 删除确认弹层（危险操作二次确认）
                s.del
                  ? h('div', { className: 'sp-modal' },
                      h('div', { className: 'sp-card' },
                        h('div', { className: 'sp-card-h' }, '删除技能', h('span', null, '')),
                        h('div', null, '确定删除技能「' + s.del.name + '」吗？会把它从技能根移除（优先移入回收站）。'),
                        s.del.err ? h('div', { className: 'sp-err', style: { marginTop: '10px' } }, s.del.err) : null,
                        h('div', { className: 'sp-actions' },
                          h('button', { className: 'sp-btn', onClick: function () { patch({ del: null }); } }, '取消'),
                          h('button', { className: 'sp-btn sp-btn-danger', disabled: !!s.del.busy, onClick: doRemove },
                            s.del.busy ? '删除中…' : '删除'))))
                  : null)
            : null
        );
      } catch (e) {
        return h('div', { style: { fontSize: 12, color: '#e5484d' }, title: String(e && e.stack ? e.stack : e) },
          '技能面板(加载失败): ' + (e && e.message ? e.message : e));
      }
    }

    /**
     * 本客户端插件声明的能力（cordis 规则：访问 ctx.remote.X 深层属性须声明完整带点
     * inject 名，且该名必须已被某个已加载插件 provide，否则插件会永久 pending）：
     *   · 'slots'         注册 sidebar.footer.action 里的入口按钮
     *   · 'remote'        ctx.remote 根服务
     *   · 'remote.skills' 由 dsh-client-ui-skill provide —— 取合并后的权威技能目录
     *   · 'remote.session'由 dsh-api-session-controller provide —— create / prompt / list
     *   · 'remote.workspace' 由 dsh-api-workspace-controller provide —— create({path,title})
     *                        注册「技能使用」专用分区，使技能会话归属明确（不进未分组）。
     *                        ⚠️ 2026-09-12 修复：此前漏声明此名 → 访问 ctx.remote.workspace
     *                        时 DSH 注入代理【抛异常】（不是返回 undefined），launch() 中断，
     *                        面板卡在「正在新建会话…」，会话根本没建 ⇒ 表现为「落未分组 + 死链」。
     *                        与 dsh-agent-maker 的声明保持一致。
     *   · home 来源（改 partition 目录用）：从【当前会话 cwd】向上找含 skills 子目录的祖先 =
     *                        DSH_HOME。⚠️ 不依赖 remote.directoryPicker —— 该能力在网页渲染进程里
     *                        返回 directory-picker/unavailable（需要原生文件对话框），故不可用于此处；
     *                        也不依赖异步 skillBridge.list() 回传的 SP.root（点得快时还没回来 → 退化到
     *                        <dist>/app 即未分组）。cwd 推导法天然可移植（换机/换路径自动正确）。
     *   · 'sessions'      UI 会话服务：list.getSnapshot().current 取当前会话、open() 打开新会话
     */
    var inject = ['slots', 'remote', 'remote.skills', 'remote.session', 'remote.workspace', 'sessions'];
    var name = 'dsh-skill-panel';

    function apply(ctx) {
      // 浮层的全局监听（互斥广播 / Esc / 点击外部 / resize 重算）只注册一次，组件渲染时回填槽位
      bindPopoverGlobal();
      ctx.slots.inject('sidebar.footer.action', function () {
        return ctx.slots.register(
          // order 110：排在 dsh-agent-maker(100) 之后，「智能体工作台」在上、「技能」在下
          { name: 'sidebar.footer.action', id: 'skill-panel-entry', order: 110, label: '技能' },
          function () { return h(SkillPanel, { ctx: ctx }); }
        );
      });
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    exports.BUILD = BUILD;
    return module.exports;
  }
});
