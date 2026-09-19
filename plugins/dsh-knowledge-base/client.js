// dsh-knowledge-base — 知识库整理师智能体 + 整理管理面板
// ============================================================================
// 架构（分层，单向依赖：配置 → 状态 → 宿主 → 文件 → 会话 → LLM → 领域 → UI → 入口）
//   L0 CONFIG      常量与提示词
//   L1 STATE       运行时状态
//   L2 HOST        ctx 服务访问（cordis 注入守卫：用哪个服务就必须在 exports.inject 声明）
//   L3 KB STORE   localStorage 持久化（替代脆弱的 /sidebar/api/fs.* endpoint，该 host 对本插件返回 400）
//   L4 SESSION     会话创建/复用/命名（workspaceId 永不丢失 → 会话不会落「未分组」）
//   L5 LLM         prompt / 文本收集（follow 双封顶）
//   L6 DOMAIN      知识库领域：schema/索引/日志/缓存/摄入管线/文件列表
//   L7 UI          样式 + 面板 + 四个视图 + 划词浮条（复制 / 导入知识库）
//   L8 ENTRY       exports.inject / apply / 注册 conversation.view
// ============================================================================
(function () {
  'use strict';

  // ===================== L0 CONFIG =====================
  // 知识库根目录（KB 文件结构：<WORKSPACE_ROOT>/<kb>/wiki/{index.md,log.md,...}）。
  // 【v34.1】解析优先级：
  //   ① 可配置项 localStorage['dsh-kb:root']（面板「根目录」里填的绝对/相对路径）
  //   ② 相对默认 '../home/knowledge-bases'
  //      —— 相对 dsh sidecar 的 cwd（= 安装根/app，见 electron-app/main.js spawn 的 cwd），
  //         realpath 后 = <安装根>/home/knowledge-bases → 换机器自动跟随安装目录，不再写死 D: 盘。
  //      —— dsh-workspace.create 要求目录已存在，故 electron-app/main.js 启动时会 mkdir 该目录。
  // 工作区注册名 = "知识库"（user 在侧栏可识别，不要删！）
  var KB_ROOT_KEY = 'dsh-kb:root';
  var DEFAULT_KB_ROOT = '../home/knowledge-bases';
  function kbRoot() {
    try { var v = localStorage.getItem(KB_ROOT_KEY); if (v && v.trim()) return v.trim().replace(/\\/g, '/'); } catch (e) {}
    return DEFAULT_KB_ROOT;
  }
  function setKbRoot(v) {
    try { if (v && v.trim()) localStorage.setItem(KB_ROOT_KEY, v.trim()); else localStorage.removeItem(KB_ROOT_KEY); } catch (e) {}
  }
  var WORKSPACE_ROOT = kbRoot();
  var WORKSPACE_TITLE = '知识库';
  var ORCHESTRATOR_ID = 'agent-orchestrator';  // 摄入编排师预设（DSH 已注册）
  var KB_MANAGER_ID = 'kb-manager';            // 知识库管理师预设（已在 .agent-presets/kb-manager 注册：下拉框可见、可被 remote.session.create 创建）
  var TURN_TIMEOUT_MS = 180000;
  var KB_BUILD = 'v35-20260912-drop-skill-type';  // 【v35】删掉导入页的「类型」下拉（含误导性的 skill 选项）：那个值只影响 step1Prompt 的口吻，产物仍是 KB 里一篇 wiki 页，既不会被 skill 工具加载也不进 / 菜单。要造可调用技能请用「技能」面板（落 <DSH_HOME>/skills）。构建版本标记：重启后看「知识库插件已加载」首行即可确认是否加载到本版（用于排查部署/缓存未生效）。v33=新增本地文件上传(WORD/TXT/CSV/EXCEL/PPT)；v33.1=修复Step2偶发走工具而非文本：硬化提示词+首轮无FILE块自动纯文本重试；v33.2=新增手动刷新按钮；v33.3=刷新改为整页reload(等同F5)；v33.4=执行-摄入即刻跳到摄入会话并关闭KB面板；v34.0=彻底修复持久化：插件无fs故落盘改由kb-manager的tool-fs承担；v34.1=改为自动存盘(任何写入即防抖1.5s落盘，取消手动「同步磁盘」按钮)+根目录可配置(KB_ROOT_KEY='dsh-kb:root'，默认相对 ../home/knowledge-bases，随安装目录、换机可用)；v34.2=修复磁盘文件名双扩展名 xxx.md.md（kbListPages 返回的 rel 已含 .md，dumpKb/exportKbToDisk/syncDiskToLocal 与落盘提示词统一改用幂等 ensureMd）；侧栏工作区标题不再依赖 create（DSH RPC 层 create(request) 只透传 request.path、丢弃 title，故只能由 workspace.json 注册表维护）；v34.3=划词浮标升级为双按钮浮条「复制 / 导入知识库」（复制走 clipboard，失败降级 execCommand；导入完全沿用原「对话即存」链路 openKb+回填面板导入框）；浮条定位改 position:fixed + 视口坐标（修旧 absolute+window.scrollXY 在 DSH 内层滚动容器里的飘位）、划词结束/滚动/Esc 自动收起、输入框与可编辑区内划词不触发；v34.4=修正「导入知识库」行为：不再新建 kb-manager 会话/跳转/发欢迎词（v34.3 误用 openKb 所致），改为只 activateKbTab 切到知识库面板「导入」页并回填文本，必须用户手动点「摄入」才 ingestToKb 发起对话；切不到视图（空白会话无 tab 条）时只缓存文本+报错提示、不建会话；成功/失败各一条 kbToast 提示
  // 编排会话按库隔离：持久化键 = 'kb-orch-sid:<kb>'（见 ingestToKb 内 orchKey 构造）
  // 自动同步会话按库隔离：持久化键 = 'kb-sync-sid:<kb>'（见 persistKbToDisk）

  var SCHEMA_TEMPLATE = '# 知识库控制协议：<KB 名称>\n\n本文件定义该知识库的领域规则，Step1/Step2 提示词会读取它。\n\n## 领域定位\n<一句话说明这个 KB 装什么>\n\n## 页类型约定\n- entity：人 / 组织 / 产品 / 项目\n- concept：方法 / 框架 / 术语\n- source：单篇原始素材的摘要页\n- comparison：方案 A vs B 对比页\n- overview：领域综合判断，每次摄入刷新\n\n## 抽取重点\n<领域特有的抽取偏好>\n\n## 链接规范\n- 跨页用 [[title]] 双链\n- 实体页必须回链到引用它的 source 页\n\n## 矛盾处理\n- 技术结论冲突 → flag（并列双方，不覆盖）\n- typo / 过时描述 → merge（直接更新）\n\n## 输出语言\n中文为主，专有名词保留原文。\n';

  // 读取某库的概况摘要（用于「知识库管理师」进入对话时把当前库上下文喂给 agent）。
  // 读取现有条目标题、schema 领域定位、最近摄入记录；上限 40 篇，避免过长。
  function summarizeKb(kb) {
    return Promise.resolve().then(function () {
      if (!kb) return '';
      var pages = kbListPages(kb).slice(0, 40);
      var titles = [];
      pages.forEach(function (rel) {
        var c = kbReadPage(kb, rel);
        var m = c.match(/^title:\s*(.+)$/m);
        titles.push(m ? m[1].trim() : rel);
      });
      var schema = kbReadMeta(kb, 'schema');
      var log = kbReadMeta(kb, 'log');
      var lines = [];
      lines.push('· 库名：' + kb);
      lines.push('· 条目数：' + pages.length + (pages.length > 40 ? '（仅列前 40）' : ''));
      if (titles.length) lines.push('· 已有条目：' + titles.join('、'));
      if (schema) {
        var loc = schema.match(/##\s*领域定位\s*\n([^\n]+)/);
        if (loc) lines.push('· 领域定位：' + loc[1].trim());
      }
      if (log) {
        var tail = log.trim().split('\n').slice(-3).join('；');
        if (tail) lines.push('· 最近记录：' + tail);
      }
      return lines.join('\n');
    });
  }

  // 把某库完整内容打包成 FILE 区块文本（兜底：插件无法直写磁盘时，让 agent 自己写入）。
  function dumpKb(kb) {
    var pages = kbListPages(kb);
    var blocks = [];
    pages.forEach(function (rel) {
      var c = kbReadPage(kb, rel);
      blocks.push('=== FILE: ' + kb + '/wiki/' + ensureMd(rel) + ' ===\n' + c);
    });
    var schema = kbReadMeta(kb, 'schema'); if (schema) blocks.push('=== FILE: ' + kb + '/schema.md ===\n' + schema);
    var log = kbReadMeta(kb, 'log'); if (log) blocks.push('=== FILE: ' + kb + '/log.md ===\n' + log);
    return blocks.join('\n\n');
  }

  // 把本地缓存（localStorage）的某库导出到真实磁盘目录，供 kb-manager 的 fs 工具读写。
  // 走 cordis 的 ctx.fs（与 tool-fs 同一后端）；写操作可能受 sandbox 限制而对非会话调用抛错，
  // 因此逐文件 try/catch，整体返回是否至少成功导出一篇（空库也视为成功）。
  function exportKbToDisk(kb) {
    return Promise.resolve().then(function () {
      var fs; try { fs = svc().fs; } catch (e) { fs = null; }
      if (!fs || typeof fs.resolve !== 'function' || typeof fs.writeText !== 'function') {
        warn('[kb] ctx.fs 不可用，跳过磁盘导出（将走内容内嵌兜底）'); return false;
      }
      var base = WORKSPACE_ROOT + '/' + kb;
      function writeOne(rel, content) {
        var p = base + '/' + rel;
        return fs.resolve(p, {}).then(function (t) { return fs.writeText(t, content, undefined, undefined, undefined); })
          .then(function () { return p; })
          .catch(function (e) { warn('[kb] 磁盘导出失败 ' + p, e && e.message); return null; });
      }
      var jobs = [];
      kbListPages(kb).forEach(function (rel) { jobs.push(writeOne('wiki/' + ensureMd(rel), kbReadPage(kb, rel))); });
      var schema = kbReadMeta(kb, 'schema'); if (schema) jobs.push(writeOne('schema.md', schema));
      var log = kbReadMeta(kb, 'log'); if (log) jobs.push(writeOne('log.md', log));
      return Promise.all(jobs).then(function (res) {
        var ok = res.filter(Boolean).length;
        log('[kb] 磁盘导出 ' + kb + '：' + ok + '/' + jobs.length + ' 成功');
        return ok > 0 || jobs.length === 0;
      });
    }).catch(function (e) { warn('[kb] exportKbToDisk 异常', e && e.message); return false; });
  }

  // 从磁盘把某库（已知 slug）读回本地缓存，使「知识库」TAB 浏览/检索与 agent 的磁盘修改同步。
  function syncDiskToLocal(kb) {
    if (!kb) { kbToast('请先选择知识库'); return; }
    var fs; try { fs = svc().fs; } catch (e) { fs = null; }
    if (!fs || typeof fs.resolve !== 'function' || typeof fs.readText !== 'function') {
      kbToast('ctx.fs 不可用，无法从磁盘同步'); return;
    }
    var base = WORKSPACE_ROOT + '/' + kb;
    var slugs = kbListPages(kb);   // 以本地已知 slug 为清单（避免目录枚举依赖）
    var jobs = slugs.map(function (rel) {
      var p = base + '/wiki/' + ensureMd(rel);
      return fs.resolve(p, {}).then(function (t) { return fs.readText(t, undefined); })
        .then(function (txt) { if (txt != null) kbWritePage(kb, rel, txt); return rel; })
        .catch(function (e) { warn('[kb] 读磁盘失败 ' + p, e && e.message); return null; });
    });
    Promise.all(jobs).then(function (res) {
      var ok = res.filter(Boolean).length;
      kbToast('已从磁盘同步 ' + ok + ' 篇到本地「' + kb + '」');
      renderTab();
    });
  }

  // ---- 磁盘同步状态（UI 侧标记，不依赖 fs）----
  // 插件无法直读磁盘（无 'fs' 服务），故用 localStorage 记录「某库是否已发起过 kb-manager 落盘」，
  // 作为面板【已同步磁盘 / 仅本地缓存】状态的依据。true = 至少发起过一次落盘（目录已创建、内容已写入）。
  var KB_SYNC_KEY = KB_NS + 'synced';
  function getSyncedMap() { try { return JSON.parse(localStorage.getItem(KB_SYNC_KEY) || '{}'); } catch (e) { return {}; } }
  function markSynced(kb) { if (!kb) return; var m = getSyncedMap(); m[kb] = Date.now(); try { localStorage.setItem(KB_SYNC_KEY, JSON.stringify(m)); } catch (e) {} }
  function isSynced(kb) { var m = getSyncedMap(); return !!(m && m[kb]); }
  function clearSynced(kb) { if (!kb) return; var m = getSyncedMap(); delete m[kb]; try { localStorage.setItem(KB_SYNC_KEY, JSON.stringify(m)); } catch (e) {} }

  // 把本地缓存某库经 kb-manager（自带 tool-fs）全量落盘到 <KB根>/<kb>/。
  // 这是【唯一可靠】的落盘通道：插件无 fs，exportKbToDisk 恒返回 false（此前修过一次没修好，根因即此处）。
  // 【v34.1 自动存盘】取消手动按钮：任何内容写入（kbWritePage / kbWriteMeta）都会触发 scheduleAutoSync
  // （防抖 1.5s）→ 后台发起/复用「同步会话」把全库落盘，用户零干预。
  // 会话按库复用（STATE.syncSids / 'kb-sync-sid:<kb>'），避免每次变更都新建会话刷屏。
  // openView=true 跳转到该会话（用户可见落盘过程）；openView=false 后台静默、不抢视图。
  async function persistKbToDisk(kb, openView) {
    if (!kb) return false;
    var diskPath = WORKSPACE_ROOT + '/' + kb;
    var dump = dumpKb(kb);
    if (!dump.trim()) return false;
    var instruction = '【持久化指令 · 必须执行】你负责把知识库「' + kb + '」的内容写入真实磁盘，使用你的文件系统工具（write / create / mkdir）。\n'
      + '· 你的工作目录（cwd）就是知识库根目录；本库落在其子目录 ' + kb + '/（即 ' + diskPath + '）。\n'
      + '· 对 <KB_DUMP> 内每个 `=== FILE: ' + kb + '/wiki/<rel> ===` 区块：把区块正文原样写入【相对你 cwd 的路径】' + kb + '/wiki/<rel>（若目录不存在先创建；<rel> 已含 .md 扩展名，不要再补）。\n'
      + '· 把 `=== FILE: ' + kb + '/schema.md ===` 写入 ' + kb + '/schema.md；`=== FILE: ' + kb + '/log.md ===` 写入 ' + kb + '/log.md。\n'
      + '· 不要改写正文，原样落盘。写完后回复一行「已持久化 N 篇到 ' + kb + '/」。\n'
      + '此后你对该库的检索/修改都应直接基于这些磁盘文件（grep / read / edit / write），本库目录 ' + kb + '/ 即是真实知识库。\n\n'
      + '<KB_DUMP>\n' + dump + '\n</KB_DUMP>';
    try {
      // 复用按库隔离的「同步会话」：避免每次内容变更都新建会话刷屏；失活则重建。
      var syncKey = 'kb-sync-sid:' + kb;
      var sid = (STATE.syncSids && STATE.syncSids[kb]) || loadSid(syncKey);
      if (sid) {
        var aliveSync = await findSession(sid);
        if (!aliveSync) { sid = null; if (STATE.syncSids) { try { delete STATE.syncSids[kb]; } catch (e) {} } saveSid(syncKey, ''); }
      }
      if (!sid) {
        sid = await createSession({ agentPreset: KB_MANAGER_ID });
        if (!STATE.syncSids) STATE.syncSids = {};
        STATE.syncSids[kb] = sid; saveSid(syncKey, sid);
        try { remote().session.rename({ sessionId: sid, title: '知识库同步·' + kb }); } catch (e) {}
      }
      if (openView) { try { CTX.sessions.open(sid); } catch (e) {} }
      await sendPrompt(sid, instruction);
      markSynced(kb);
      try { renderSyncBadge(); } catch (e) {}
      log('[kb] ' + (openView ? '持久化' : '自动同步') + '已发起：' + kb + ' → ' + sid + (openView ? '（已打开）' : '（后台）'));
      return true;
    } catch (e) {
      warn('[kb] 自动同步失败', e && e.message);
      if (!openView) { try { kbToast('自动同步失败：' + (e && e.message), true); } catch (e2) {} }
      return false;
    }
  }

  // 【v34.1 自动存盘】防抖调度：连续写入（如摄入 27 页）合并为一次落盘；后台静默、不抢视图。
  // 挂在唯一写入入口 kbWritePage / kbWriteMeta 上（见 L3），故摄入/编辑/新建/改名后都会自动落盘。
  var _syncTimers = {};
  function scheduleAutoSync(kb) {
    if (!kb) return;
    try { if (_syncTimers[kb]) clearTimeout(_syncTimers[kb]); } catch (e) {}
    _syncTimers[kb] = setTimeout(function () {
      delete _syncTimers[kb];
      try { persistKbToDisk(kb, false); } catch (e) { warn('[kb] scheduleAutoSync 执行异常', e && e.message); }
    }, 1500);
  }

  // 知识库管理师（kb-manager）进入对话时的欢迎/引导词（返回 Promise<string>）。
  // 设计要点（来自用户）：
  //   · 点「知识库」主入口进来 → kb 为空 → 通用引导（不自动建库）。
  //   · 在「知识库」TAB 面板、下拉已选某库后点「知识库管理师」按钮 → kb 为当前库名
  //     → 角色变成「当前所选库的修改/完善助手」。
  //   · 本 UI 插件在 web profile 下【无 fs 服务】（声明 'fs' 会导致插件 pending 无法激活），
  //     故走「内嵌兜底」：把该库完整内容（FILE 区块）塞进首条消息，由 kb-manager 自带的 tool-fs
  //     「write」到真实磁盘目录 D:/DSH/DH/knowledge-bases/<kb>/，从而真正改到当前库、不报「库不存在」。
  //     （exportKbToDisk 仍保留，将来宿主开放 fs 给 UI 插件时可自动复活双向磁盘同步。）
  // createKbManagerSession 兼容 autoPrompt 为 Promise（见该函数）。
  var GENERIC_INTRO = '当前尚未选中具体的知识库（知识库工作区根目录：' + rootDisplay() + '）。\n\n' +
    '可选操作：\n' +
    '· 直接在对话里说「新建知识库 X」，插件会建好 <X> 库目录；\n' +
    '· 或打开「知识库」标签页，在「导入」里建库 / 选目标库并把素材摄入。\n\n' +
    '建好库后，到「知识库」标签页选该库再点「知识库管理师」，会自动绑定该库并由本智能体负责检索。\n' +
    '请告诉我你想要的库名或主题，即可建库并沉淀第一篇条目。';
  function buildKbManagerIntro(kb) {
    if (!kb) return Promise.resolve(GENERIC_INTRO);
    var diskPath = WORKSPACE_ROOT + '/' + kb;
    // 知识库绑定本智能体、由本智能体检索：正常路径首条给「索引概况」+ 磁盘检索指引（控 token）。
    // 但本插件在 web profile 下【未声明 'fs'】（声明会导致插件 pending 无法激活），故 svc().fs 恒为 undefined，
    // exportKbToDisk 永远返回 false（磁盘导出是空操作）。因此 exported=false 时【不再谎报磁盘目录】，
    // 改为诚实说明数据仅在本地缓存，并把全库内容内嵌（dumpKb），让 kb-manager 直接基于内嵌内容检索/回答。
    return exportKbToDisk(kb).then(function (exported) {
      return summarizeKb(kb).then(function (summary) {
        var body = summary
          ? '\n该库索引概况（仅目录，非全文）：\n' + summary + '\n'
          : '\n（该库还没有条目，告知主题即建立第一篇。）\n';
        var head, tail;
        if (exported) {
          head = '【当前绑定库】「' + kb + '」—— 磁盘位置：你的工作目录（cwd，即知识库根目录）下的 ' + kb + '/wiki/（根=' + diskPath + '）。\n';
          tail = '库已同步到磁盘。请用 grep/search 工具在 ' + kb + '/wiki/ 检索相关页面（相对你的 cwd），用 read 取正文、用 edit/write 增量修改。不要一次性读取全库。';
        } else {
          head = '【当前绑定库】「' + kb + '」—— 本库当前仅存于本地缓存（localStorage）。进入本会话时我会把它全量写入真实磁盘（你的工作目录 cwd = 知识库根目录）下的 ' + kb + '/wiki/，之后直接在磁盘上检索/修改。\n';
          tail = '下面 <KB_DUMP> 是该库完整内容（兜底用）。请先按以下三步把全部页面写入磁盘 ' + kb + '/（相对你的 cwd），再基于磁盘回答我的问题：\n'
            + '【第一步·必须】用你的文件系统工具把 <KB_DUMP> 内每个 `=== FILE: ' + kb + '/wiki/<rel> ===` 区块正文原样写入【相对你 cwd 的路径】' + kb + '/wiki/<rel>（目录不存在先创建；<rel> 已含 .md，勿重复补）；并写入 ' + kb + '/schema.md、' + kb + '/log.md。\n'
            + '【第二步】回复「已持久化 N 篇到 ' + kb + '/」。\n'
            + '【第三步】此后所有检索/修改都基于这些磁盘文件（grep / read / edit / write），本库目录 ' + kb + '/ 即是真实知识库。\n\n'
            + '<KB_DUMP>\n' + dumpKb(kb) + '\n</KB_DUMP>';
        }
        if (kb) markSynced(kb);   // 已向 kb-manager 发起落盘指令（UI 侧标记，不依赖 fs）
        return head + body + tail;
      });
    });
  }

  // ===================== L1 STATE =====================
  var STATE = {
    built: false,
    activeKb: null,
    kbs: [],                 // 缓存库清单（供导入视图「目标库」选择器同步）
    tab: 'overview',
    orchSids: {},            // 摄入编排会话：按库隔离（kb -> sid），杜绝跨库串味
    syncSids: {}             // 【v34.1】自动同步会话：按库隔离（kb -> sid），复用不刷屏
  };
  var CTX = null;
  var React = null;
  var KB_ROOT = WORKSPACE_ROOT;                // 仅用于日志展示（KB 逻辑根）；持久化已改 localStorage
  var WS_ID = null;         // workspaceId（决定会话是否归组）
  var PendingSelectionText = null;
  var FloatSelText = '';
  var KbSlotProps = null;
  var KB_MOUNT_PANEL = null;
  var selFloatEl = null;
  var HeaderGuardTimer = null;

  function log() { try { console.log.apply(console, ['[kb]'].concat([].slice.call(arguments))); } catch (e) {} }
  function warn() { try { console.warn.apply(console, ['[kb]'].concat([].slice.call(arguments))); } catch (e) {} }

  // ===================== L2 HOST =====================
  // cordis 守卫：apply 内只能访问 exports.inject 声明过的 ctx.X，否则抛
  // "cannot get property X without inject"。本插件用 remote / remote.session /
  // remote.workspace / sessions / slots，全部已声明（对齐 dsh-agent-maker）。
  function svc() { return CTX || {}; }
  function remote() { return (svc().remote) || {}; }

  // ===================== L3 KB STORE（localStorage 持久化）=====================
  // 早期版本通过 /sidebar/api/fs.* 落盘，该 host endpoint 对本插件返回 400（schema 不兼容），
  // 正是「无法建库 / 不能保存」长期未解的根因。改为插件侧 localStorage 持久化：
  // 功能完全一致（建库 / 摄入 / 浏览 / 检索），零外部依赖、100% 可控、不依赖磁盘或 fs endpoint。
  // 注：session.cwd 路由与 fs.* 无关，仍用于会话归属校验（见 ingestToKb 内编排会话）。
  function norm(p) { return String(p || '').replace(/\\/g, '/').replace(/\/+$/, ''); }
  // 路径归属校验：p 是否落在 root 内（p === root 或 p 以 root/ 开头）。用于会话 cwd 归属判断。
  function isWithin(root, p) { root = norm(root); p = norm(p); return p === root || p.indexOf(root + '/') === 0; }
  // 【v34.1】会话 cwd 是否落在知识库根内。
  // WORKSPACE_ROOT 可能是相对路径（默认 '../home/knowledge-bases'，随安装目录），而会话 cwd 是 realpath 后的
  // 绝对路径 —— 此时 isWithin 恒失配（会把正常会话误判为「游离」），故补一条「末段相等」启发式：
  // 根目录末段唯一（默认 'knowledge-bases'），会话 cwd 末段相同即视为同一根。
  function kbRootTail() { var segs = norm(WORKSPACE_ROOT).split('/').filter(Boolean); return segs.length ? segs[segs.length - 1] : ''; }
  // 展示用：相对路径时标注「相对 DSH 安装目录」，避免用户看到 ../home/... 困惑。
  function rootDisplay() {
    var r = norm(WORKSPACE_ROOT);
    var abs = /^[A-Za-z]:\//.test(r) || r.indexOf('//') === 0 || r.charAt(0) === '/';
    return WORKSPACE_ROOT + (abs ? '' : '（相对 DSH 安装目录）');
  }
  function cwdInKbRoot(cwd) {
    cwd = norm(cwd); if (!cwd) return false;
    if (isWithin(WORKSPACE_ROOT, cwd)) return true;   // 用户填绝对路径时直接命中
    var tail = kbRootTail();
    var segs = cwd.split('/').filter(Boolean);
    return !!tail && segs.length > 0 && segs[segs.length - 1] === tail;
  }
  async function api(method, payload) {
    var r = await fetch('/sidebar/api/' + method, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {})
    });
    var j = await r.json().catch(function () { return null; });
    if (!r.ok || !j || j.ok !== true) throw new Error((j && j.error && j.error.message) || (method + ' HTTP ' + r.status));
    return j.value;
  }
  var KB_NS = 'dsh-kb:';                            // localStorage 命名空间前缀
  function lsGet(k) { try { return localStorage.getItem(KB_NS + k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(KB_NS + k, v); } catch (e) {} }
  function lsGetJSON(k, def) { try { var s = lsGet(k); return s == null ? def : (JSON.parse(s) || def); } catch (e) { return def; } }
  function lsSetJSON(k, v) { lsSet(k, JSON.stringify(v)); }
  function kbIndex() { return lsGetJSON('__kbs', []); }
  function kbAddName(n) { var a = kbIndex(); if (a.indexOf(n) < 0) { a.push(n); lsSetJSON('__kbs', a); } }
  // 【v34.1 自动存盘】写入入口即触发防抖落盘（摄入/编辑/新建/改名后自动同步磁盘，无需手动）
  function kbWritePage(kb, rel, content) { lsSet('page:' + kb + ':' + norm(rel), content); scheduleAutoSync(kb); }
  function kbReadPage(kb, rel) { return lsGet('page:' + kb + ':' + norm(rel)) || ''; }
  function kbWriteMeta(kb, name, content) { lsSet('meta:' + kb + ':' + name, content); scheduleAutoSync(kb); }
  function kbReadMeta(kb, name) { return lsGet('meta:' + kb + ':' + name) || ''; }
  function kbListPages(kb) {
    var pre = KB_NS + 'page:' + kb + ':', out = [], n = 0;
    try { n = localStorage.length; } catch (e) {}
    for (var i = 0; i < n; i++) { try { var key = localStorage.key(i); if (key && key.indexOf(pre) === 0) out.push(key.slice(pre.length)); } catch (e) {} }
    return out.sort();
  }
  // 【v34.2 修复】kbListPages() 返回的 rel 本身已含 '.md'（写入时的 key 就带扩展名），
  // 旧代码又无条件拼 '.md' → 磁盘/落盘指令里出现 'xxx.md.md'（实测 35 个）。
  // ensureMd 做幂等补全：已带 .md 则原样返回，未带才补。
  function ensureMd(rel) {
    var r = String(rel == null ? '' : rel).replace(/\\/g, '/');
    return /\.md$/i.test(r) ? r : r + '.md';
  }
  function kbAppendLog(kb, line) { var existing = kbReadMeta(kb, 'log') || ''; kbWriteMeta(kb, 'log', existing + '- ' + new Date().toISOString().slice(0, 19) + ' ' + line + '\n'); }

  // ===================== L4 SESSION =====================
  function loadSid(key) { try { return localStorage.getItem(key) || ''; } catch (e) { return ''; } }
  function saveSid(key, v) { try { v ? localStorage.setItem(key, v) : localStorage.removeItem(key); } catch (e) {} }
  async function findSession(sid) {
    if (!sid) return null;
    try {
      var r = await remote().session.list({});
      var items = (r && r.value && r.value.items) || [];
      for (var i = 0; i < items.length; i++) if (items[i] && items[i].sessionId === sid) return items[i];
    } catch (e) {}
    return null;
  }
  // 注：remote.workspace 不提供 list（仅 create/rename/delete/...），工作区解析见下方 ensureWorkspaceId（只用幂等 create）。
  // 专用「知识库」工作区解析：list 优先精确匹配 → 兜底 ancestor 匹配 → 都失败则 ws.create 幂等确保
  // （dsh-workspace.create 要求 path 目录已存在；WORKSPACE_ROOT 路径必须先由 user/部署准备好）。
  // 关键：先验证缓存 WS_ID 是否仍存活（第 11 轮根因：user 删工作区后缓存的 wsId 仍被复用）。
  // 专用「知识库」工作区解析：host 的 remote.workspace 只暴露
  //   create / rename / delete / insertBefore / insertSessionBefore / follow ——【没有 list】，
  // 所以不能用 list 查/校验（之前的 remote.workspace.list is not a function 即源于此）。
  // 正确做法：每次都用 ws.create({path, title})，它按 path 幂等
  // （目录已存在则返回已有记录 / 被删则重建），直接拿到 workspaceId 用于 session.create 归组。
  // 【v34.2 已知上游限制】RPC 层 dsh-api-workspace-controller 的 create(request) 只透传 request.path
  //   （见其 lib/index.js：workspaceRegistry.create(request.path)），title 被丢弃 →
  //   底层 dsh-workspace 落回 basename(path) 作标题。故 title 参数在此"传了也没用"，
  //   侧栏显示名只能靠 workspace.json 注册表直接维护（同 path 幂等 create 不会覆盖已有 title）。
  //   此处仍传 title 是为了前向兼容（上游若修好即自动生效）。
  // 不缓存 WS_ID：user 删工作区后下次 create 自动重建，不会卡死在死 ID（这正是之前复发根因）。
  async function ensureWorkspaceId() {
    try {
      var ws = remote().workspace;
      if (ws && typeof ws.create === 'function') {
        var r = await ws.create({ path: WORKSPACE_ROOT, title: WORKSPACE_TITLE });
        var wid = (r && r.value && r.value.workspace && r.value.workspace.workspaceId)
                  || (r && r.value && r.value.workspaceId);   // 兼容两种返回形状
        if (wid) { WS_ID = wid; log('工作区已确保（create 幂等）-> workspaceId=' + WS_ID + '，title=' + WORKSPACE_TITLE); return WS_ID; }
      }
    } catch (e) { warn('remote.workspace.create 失败（请确认根目录存在：' + WORKSPACE_ROOT + '；可在面板右上「根目录」改为绝对路径）', e && e.message); }
    warn('⚠️ 未解析到 workspaceId，新建会话会落在「未分组」');
    return WS_ID;
  }
  // 统一会话创建 —— 严格对齐宿主真实契约（dsh-api-session-controller/lib/index.js:566-582）：
  //   ① session.create 的 workspaceId 与 cwd 【互斥】，同时传 → "accepts workspaceId or cwd, not both" 直接拒绝；
  //   ② 传 workspaceId → 会话 cwd 自动 = workspace.path，且 workspace.attachSession 会把会话【归组】；
  //   ③ 预设不存在 → rejectCreation，只去掉 agentPreset 重试，定位字段不动。
  // 因此本函数是定位字段的唯一裁决点：caller 只传 agentPreset，永不传 cwd/workspaceId。
  async function createSession(payload) {
    await ensureWorkspaceId();
    var p = Object.assign({}, payload || {});
    delete p.cwd;                                   // 契约：不允许 caller 指定 cwd
    if (WS_ID) p.workspaceId = WS_ID;               // 归组优先（唯一正确路径）
    else p.cwd = WORKSPACE_ROOT;                    // 无 wsId 才退 cwd（此时会落未分组，已在 ensureWorkspaceId 告警）
    var r = null;
    try { r = await remote().session.create(p); }
    catch (e) { r = { ok: false, error: { message: String((e && e.message) || e) } }; }
    if (r && r.ok && r.value && r.value.sessionId) return r.value.sessionId;
    var msg = (r && r.error && r.error.message) || '未返回 sessionId';
    if (p.agentPreset) {
      log('带预设创建失败（' + msg + '）→ 去掉预设重试（定位字段不变：' + (p.workspaceId ? 'workspaceId=' + p.workspaceId : 'cwd=' + p.cwd) + '）');
      delete p.agentPreset;
      var r2 = null;
      try { r2 = await remote().session.create(p); }
      catch (e2) { r2 = { ok: false, error: { message: String((e2 && e2.message) || e2) } }; }
      if (r2 && r2.ok && r2.value && r2.value.sessionId) return r2.value.sessionId;
      throw new Error((r2 && r2.error && r2.error.message) || '未返回 sessionId');
    }
    throw new Error(msg);
  }

  // ===================== L5 LLM =====================
  function flattenMessage(msg) {
    try {
      var out = '', c = msg && msg.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) {
        for (var i = 0; i < c.length; i++) {
          var b = c[i]; if (!b) continue;
          if (b.type === 'text') out += b.text || '';
          else if (typeof b.text === 'string') out += b.text;
        }
      }
      return out;
    } catch (e) { return ''; }
  }
  async function sendPrompt(sessionId, text) {
    var uuid = (crypto.randomUUID ? crypto.randomUUID() : 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    var r = await remote().session.prompt({ sessionId: sessionId, requestId: uuid, mode: 'queue', content: [{ type: 'text', text: text }] });
    if (!r || !r.ok) throw new Error('prompt 未确认：' + ((r && r.error && r.error.message) || 'unknown'));
    return r;
  }
  // follow 帧有两种封顶（typert.host.js）：
  //   {type:'event',  event:{type:'turn/end'|'assistant/message'|...}}
  //   {type:'chunks', event:{type:'chunkrow/text-chunks', data:{texts:[]}}} ← 文本块在这里
  // 只认 event 会把全部文本块跳过 → 收集结果恒为空。
  async function collectText(sessionId, timeoutMs) {
    var ac = new AbortController();
    var it = remote().session.follow({ address: { kind: 'session', sessionId: sessionId } }, ac.signal);
    await it.next();
    var text = '', done = false, timer = setTimeout(function () { ac.abort(); }, timeoutMs);
    try {
      while (true) {
        var r = await it.next();
        if (r.done) break;
        var frame = r.value; if (!frame) continue;
        var ev = frame.event;
        if (frame.type === 'chunks' || frame.type === 'event') {
          if (ev && ev.type === 'chunkrow/text-chunks' && ev.data && Array.isArray(ev.data.texts)) text += ev.data.texts.join('');
          else if (ev && ev.type === 'assistant/message' && !text && ev.data && ev.data.message) text += flattenMessage(ev.data.message);
          else if (ev && ev.type === 'turn/end') { done = true; break; }
        }
      }
    } finally { clearTimeout(timer); ac.abort(); }
    return { text: text, done: done };
  }

  // ===================== L6 DOMAIN =====================
  async function sha16(s) {
    try {
      var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
      return Array.prototype.map.call(new Uint8Array(buf).slice(0, 8), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    } catch (e) {
      var h = 0x811c9dc5; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
      return (h >>> 0).toString(16);
    }
  }
  async function ensureKb(kb) {
    kbAddName(kb);
    if (!kbReadMeta(kb, 'schema')) kbWriteMeta(kb, 'schema', SCHEMA_TEMPLATE.replace('<KB 名称>', kb));
    if (!kbReadMeta(kb, 'index')) kbWriteMeta(kb, 'index', '# 知识库索引：' + kb + '\n\n> 由 LLM-Wiki 摄入自动维护。每次摄入刷新本页。\n\n## 页清单\n（暂无）\n');
  }
  async function listKbs() { return kbIndex(); }
  function appendLog(kb, line) { kbAppendLog(kb, line); }
  function readCache(kb) { return lsGetJSON('cache:' + kb, {}); }
  function writeCache(kb, cache) { lsSetJSON('cache:' + kb, cache); }
  async function listWikiFiles(kb) {
    return kbListPages(kb).filter(function (n) { return /\.md$/i.test(n); });
  }
  // 正文标注选库：@kb:库名 → 复用；新建:库名 → 新建。供导入视图/摄入管线自动路由。
  function resolveKbFromText(text) {
    if (!text) return null;
    var m = text.match(/新建[:：]\s*([A-Za-z0-9_-]+)/);
    if (m) return { kb: m[1], isNew: true };
    m = text.match(/@kb[:：]?\s*([A-Za-z0-9_-]+)/i);
    if (m) return { kb: m[1], isNew: false };
    m = text.match(/(?:存到|存入|归到|放进|进)\s*([A-Za-z0-9_-]+)\s*库/i);
    if (m) return { kb: m[1], isNew: false };
    return null;
  }
  // 中文显示：目录名映射 + 优先 frontmatter.title（避免树状列表露出 concepts/entities/拼音 slug）
  var KB_DIR_CN = { concepts: '概念', entities: '实体', events: '事件', sources: '来源', overview: '概览', schema: '规则', argument: '论证' };
  function displayRel(kb, rel) {
    if (!rel) return rel;
    var c = kbReadPage(kb, rel) || '';
    var title = '';
    var fm = c.match(/^---\s*([\s\S]*?)\s*---/);
    if (fm) {
      var m = fm[1].match(/title:\s*(.+)/i);
      if (m) title = m[1].trim().replace(/^["']|["']$/g, '');
    }
    if (title) return title;
    var s = rel.replace(/\.md$/i, '');
    return s.replace(/^([^/]+)(?=\/)/, function (d) { return KB_DIR_CN[d] || d; });
  }
  // 索引归插件所有：遍历真实页，从 frontmatter 派生成干净 index.md，写入唯一权威键 meta:<kb>:index。
  // 不再由 LLM 凭记忆生成 → 鬼影「待落盘」/ 李白串库残留彻底消失，键不再分裂。
  async function rebuildIndex(kb) {
    var pages = kbListPages(kb).filter(function (n) {
      return /\.md$/i.test(n) && n !== 'index.md' && n !== 'wiki/index.md';
    });
    var byType = {};
    pages.forEach(function (rel) {
      var c = kbReadPage(kb, rel) || '';
      var title = rel.replace(/^wiki[\\/]/i, '').replace(/\.md$/i, '');
      var type = '';
      var fm = c.match(/^---\s*([\s\S]*?)\s*---/);
      if (fm) {
        var t = fm[1].match(/title:\s*(.+)/i); if (t) title = t[1].trim().replace(/^["']|["']$/g, '');
        var ty = fm[1].match(/type:\s*(.+)/i); if (ty) type = ty[1].trim().replace(/^["']|["']$/g, '');
      }
      (byType[type] = byType[type] || []).push({ title: title, rel: rel });
    });
    var lines = ['# 知识库索引：' + kb + '\n',
      '> 由插件从真实页自动维护（rebuildIndex），不依赖 LLM 记忆。每次摄入刷新。\n'];
    var order = ['overview', 'entity', 'concept', 'source', 'comparison', 'argument', 'event'];
    var keys = order.filter(function (k) { return byType[k]; }).concat(Object.keys(byType).filter(function (k) { return order.indexOf(k) < 0; }));
    keys.forEach(function (type) {
      lines.push('\n## ' + (type || '未分类'));
      byType[type].forEach(function (p) { lines.push('- [[' + p.title + ']]  (`' + p.rel + '`)'); });
    });
    lines.push('\n（共 ' + pages.length + ' 页）');
    kbWriteMeta(kb, 'index', lines.join('\n') + '\n');
  }
  function step1Prompt(rawContent, pageList, schemaMd, typeHint) {
    return '你是一个知识库架构师。任务：分析新摄入的素材，规划如何把它编译进结构化知识库。不要写任何文件，只输出规划 JSON。\n\n# 输入\n1. 新素材（raw）：\n' + rawContent + '\n2. 当前库真实页清单（由插件维护，非 LLM 生成，列出已有页；不要凭记忆编造不存在的页）：\n' + (pageList || '（空，首次摄入）') + '\n3. 领域规则（schema.md）：\n' + schemaMd + '\n4. 素材类型提示：\n' + (typeHint || 'knowledge') + '\n\n# 要求\n- 素材类型：' + (typeHint || 'knowledge') + '\n- 抽取四类节点：实体 entity / 概念 concept / 论证 argument / 事件 event\n- 识别与现有 wiki 页的关联，列出 [[wikilink]] 候选\n- 标记矛盾：若新素材与现有页冲突，记录冲突点，不要直接覆盖\n- 建议：需新增哪些页、更新哪些页、index.md 如何改\n- 文件路径用中文目录：实体 / 概念 / 事件 / 来源 / 论证（如 wiki/实体/曹操.md）；文件名用中文标题（不要拼音、不要英文 slug、不要空白）\n\n# 输出（严格 JSON，不要多余文字）\n{\n  "entities": [{"name":"","type":"","summary":"","related":["[[现有页title]]"]}],\n  "concepts": [{"name":"","summary":"","related":["[[现有页title]]"]}],\n  "arguments": [{"claim":"","evidence":""}],\n  "events": [{"date":"","what":"","who":""}],\n  "contradictions": [{"page":"wiki/...","point":"","evidence":"","resolution":"merge|flag"}],\n  "plan": {\n    "add_pages": [{"path":"wiki/实体/<中文标题>.md","type":"entity","title":""}],\n    "update_pages": [{"path":"","changes":""}],\n    "index_changes": "对 index.md 的增删改说明"\n  }\n}';
  }
  function step2Prompt(analyzeJson, rawContent, schemaMd) {
    return '你是一个技术文档写手。任务：基于分析结果，生成知识库 wiki 页面（markdown）。\n\n# 规则（必须遵守）\n- 每个 wiki 页开头必须有 YAML frontmatter（type/title/sources/related/created/updated）\n- 用 [[wikilink]] 双向链接关联相关页\n- 每页末尾 ## 来源 列出 sources[] 指向的原始文件相对路径\n- 中文输出，保留专有名词原文\n- 不编造事实；不确定标注 [待核实]\n- 矛盾 resolution=merge 融合；resolution=flag 用 > [!contradiction] 块并列双方，不删旧内容\n- 复用而非重复：已存在页只更新 diff\n- 目录与文件名用中文（实体 / 概念 / 事件 / 来源 / 论证），用中文标题命名，不要拼音或英文 slug\n\n# 输入\n分析结果 JSON：\n' + analyzeJson + '\n新素材：\n' + rawContent + '\nschema.md（领域规则）：\n' + schemaMd + '\n\n# 输出格式\n对 plan 中每个 add_pages / update_pages，依次输出：\n=== FILE: <相对路径> ===\n<完整 markdown 内容（含 frontmatter）>\n\n注意：不要输出 wiki/index.md，全局索引由插件自动维护（rebuildIndex），你只需写实体/概念等正文页。\n\n## 硬性约束（最高优先级，覆盖以上一切）\n- 你本次【只能输出文本】，禁止使用任何工具/函数/插件，禁止访问文件系统或工作区，禁止做任何检查/创建/写入动作。\n- 严禁输出「我先…」「让我检查…」「I\'ll start by…」之类的执行计划或思考独白。\n- 直接、立即输出 === FILE: <相对路径> === 文本块；路径直接沿用分析结果 plan 中已给出的路径，不要重新确认其是否存在。\n- 若 plan 为空或无可写内容，至少输出一个 === FILE: wiki/概览/摄入摘要.md === 块汇总素材，不要返回空文本或计划文本。';
  }
  function step2RetryPrompt(analyzeJson, rawContent, schemaMd) {
    return "【纯文本输出指令，最高优先级】你没有任何工具/函数/插件可调用，禁止访问文件系统、工作区或网络，禁止执行任何检查/创建/写入动作，禁止输出「我先…」「让我检查…」「I'll start by…」之类的计划或独白。你只能输出文本。\n请立即、直接地基于以下分析结果生成 wiki 页面，每个页面严格按如下格式输出：\n=== FILE: <相对路径> ===\n<完整 markdown 内容（含 YAML frontmatter）>\n路径直接沿用分析结果 plan.add_pages[].path（如 wiki/实体/中文标题.md），不要重新确认或检查路径是否存在。若 plan 为空，至少输出一个 === FILE: wiki/概览/摄入摘要.md === 块汇总素材。不要输出 wiki/index.md（索引由插件自动维护）。\n\n# 分析结果 JSON：\n" + analyzeJson + "\n\n# 新素材：\n" + rawContent + "\n\n# schema.md：\n" + schemaMd;
  }
  function extractJson(text) {
    if (!text) return null;
    var t = text.trim();
    try { return JSON.parse(t); } catch (e) {}
    var fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) { try { return JSON.parse(fence[1].trim()); } catch (e) {} }
    var start = t.indexOf('{');
    if (start >= 0) {
      var depth = 0, inStr = false, esc = false;
      for (var i = start; i < t.length; i++) {
        var c = t[i];
        if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
        else if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch (e) { break; } } }
      }
    }
    return null;
  }
  function parseFileBlocks(text) {
    if (!text) return [];
    var out = [], re = /=== FILE:\s*([^\n\r]+?)\s*===\s*\r?\n([\s\S]*?)(?=\r?\n=== FILE:\s*|$)/g, m;
    while ((m = re.exec(text)) !== null) out.push({ path: m[1].trim(), content: m[2].replace(/\r?\n+$/, '') });
    if (out.length) return out;
    // 宽松兜底：部分模型写成 ### FILE: 形式
    var re2 = /(?:^|\n)\s*###\s*FILE:\s*([^\n\r]+?)\s*\r?\n([\s\S]*?)(?=\r?\n\s*###\s*FILE:\s*|$)/gi;
    while ((m = re2.exec(text)) !== null) { var p = m[1].trim().replace(/^['"]+|['"]+$/g, ''); if (p) out.push({ path: p, content: m[2].replace(/\r?\n+$/, '') }); }
    return out;
  }

  // ===================== OOXML 本地文本提取（零依赖，纯浏览器 DecompressionStream）=====================
  // DOCX/XLSX/PPTX 都是 zip+xml；用浏览器原生 DecompressionStream('deflate-raw') 解压，无需任何第三方库。
  // 探针已实测（kb_local_parse_spike.mjs）：三种格式均可正确提取文本。
  async function inflateRaw(bytes) {
    var ds = new DecompressionStream('deflate-raw');
    var w = ds.writable.getWriter(); w.write(bytes); w.close();
    var r = ds.readable.getReader();
    var parts = [], x;
    while (!(x = await r.read()).done) parts.push(new Uint8Array(x.value));
    var len = parts.reduce(function (a, p) { return a + p.length; }, 0);
    var out = new Uint8Array(len); var off = 0;
    parts.forEach(function (p) { out.set(p, off); off += p.length; });
    return out;
  }
  function findEOCD(buf) {
    for (var i = buf.length - 22; i >= 0; i--) {
      if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) return i;
    }
    return -1;
  }
  async function unzipEntries(buf) {
    var eocd = findEOCD(buf);
    if (eocd < 0) throw new Error('不是有效的 Office 文件（缺少 EOCD）');
    var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    var cdOff = dv.getUint32(eocd + 16, true);
    var n = dv.getUint16(eocd + 10, true);
    var files = {};
    var p = cdOff;
    for (var i = 0; i < n; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      var method = dv.getUint16(p + 10, true);
      var csize = dv.getUint32(p + 20, true);
      var fnLen = dv.getUint16(p + 28, true);
      var exLen = dv.getUint16(p + 30, true);
      var cmLen = dv.getUint16(p + 32, true);
      var name = '';
      for (var j = 0; j < fnLen; j++) name += String.fromCharCode(buf[p + 46 + j]);
      var localOff = dv.getUint32(p + 42, true);
      var lfnLen = dv.getUint16(localOff + 26, true);
      var lexLen = dv.getUint16(localOff + 28, true);
      var dataStart = localOff + 30 + lfnLen + lexLen;
      var comp = buf.subarray(dataStart, dataStart + csize);
      var raw;
      if (method === 8) raw = await inflateRaw(comp);
      else if (method === 0) raw = comp;
      else throw new Error('不支持的压缩方式 ' + method);
      files[name] = new TextDecoder('utf-8').decode(raw);
      p += 46 + fnLen + exLen + cmLen;
    }
    return files;
  }
  async function extractOoxmlText(arrayBuffer, ext) {
    var buf = new Uint8Array(arrayBuffer);
    var entries = await unzipEntries(buf);
    var text = '';
    Object.keys(entries).forEach(function (k) {
      var xml = entries[k], m;
      if (ext === 'docx') {
        if (/word\/document\.xml$/.test(k)) { var re = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g; while ((m = re.exec(xml))) text += m[1]; }
      } else if (ext === 'xlsx') {
        if (/xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(k)) { var re = /<t[^>]*>([\s\S]*?)<\/t>/g; while ((m = re.exec(xml))) text += m[1] + '\n'; }
      } else if (ext === 'pptx') {
        if (/ppt\/slides\/slide\d+\.xml$/.test(k)) { var re = /<a:t>([\s\S]*?)<\/a:t>/g; while ((m = re.exec(xml))) text += m[1] + '\n'; }
      }
    });
    return text;
  }

  async function ingestToKb(opts) {
    var rawContent = opts.rawContent, type = opts.type || 'knowledge', force = opts.force;
    if (!rawContent || !rawContent.trim()) throw new Error('rawContent 为空');
    // 选库优先级：显式 kbName > 正文标注（@kb:/新建:）> 当前激活库
    var kb = opts.kbName;
    if (!kb) {
      var r0 = resolveKbFromText(rawContent);
      if (r0) { if (r0.isNew) await ensureKb(r0.kb); kb = r0.kb; }
    }
    if (!kb) kb = STATE.activeKb;
    if (!kb) throw new Error('未选择知识库（导入页选择/新建，或正文标注 @kb:库名 / 新建:库名）');
    await ensureKb(kb);
    var hash = await sha16(rawContent);
    var cache = await readCache(kb);
    if (!force && cache[hash] === true) return { skipped: true, reason: '源未变化（SHA256 命中）', hash: hash };

    // 编排会话按库隔离：每库一把专属会话，仅装该库记忆 → 跨库不串味（同主题库多次喂保留连续性）
    var orchKey = 'kb-orch-sid:' + kb;
    var sid = STATE.orchSids[kb] || loadSid(orchKey);
    if (sid) {
      var aliveOrch = await findSession(sid);
      if (!aliveOrch) { sid = null; }
      else {
        try {
          var cv2 = await api('session.cwd', { sessionId: sid });
          if (!(cv2 && cv2.cwd && cwdInKbRoot(cv2.cwd))) { sid = null; warn('编排会话 cwd 偏离知识库根（' + WORKSPACE_ROOT + '），视为游离重建'); }
        } catch (e) { sid = null; }
      }
      if (!sid) { delete STATE.orchSids[kb]; saveSid(orchKey, ''); }
    }
    if (!sid) {
      sid = await createSession({ agentPreset: ORCHESTRATOR_ID });
      STATE.orchSids[kb] = sid; saveSid(orchKey, sid);
      try { remote().session.rename({ sessionId: sid, title: '知识库摄入·' + kb }); } catch (e) {}
    }
    // 【v33.4】执行-摄入即发起对话：拿到 sid 立刻跳到该摄入会话，并让 KB 面板(conversation.view tab)失活=关闭面板
    try {
      if (CTX && CTX.sessions && typeof CTX.sessions.open === 'function') {
        CTX.sessions.open(sid);
        log('[kb] 摄入已发起会话 ' + sid + '，已跳转对话并关闭知识库面板');
      } else warn('[kb] CTX.sessions.open 不可用，无法自动跳转摄入会话');
    } catch (e) { warn('[kb] 摄入会话跳转失败', e && e.message); }
    var schemaV = '', pageListV = '';
    schemaV = kbReadMeta(kb, 'schema');
    pageListV = kbListPages(kb).filter(function (n) { return /\.md$/i.test(n); }).join('\n');

    await sendPrompt(sid, step1Prompt(rawContent, pageListV, schemaV, type));
    var r1 = await collectText(sid, TURN_TIMEOUT_MS);
    var analyze = extractJson(r1.text);
    if (!analyze || !analyze.plan) throw new Error('Step1 未解析出合法 analyze.plan；前200字：' + r1.text.slice(0, 200));

    await sendPrompt(sid, step2Prompt(JSON.stringify(analyze, null, 2), rawContent, schemaV));
    var r2 = await collectText(sid, TURN_TIMEOUT_MS);
    var files = parseFileBlocks(r2.text);
    log('摄入解析 → Step2 返回 ' + r2.text.length + ' 字，解析到 ' + files.length + ' 个 FILE 块');
    // 【v33.1 修复】Step2 偶发走工具而非文本（agent-orchestrator 自主行为）：首轮无 FILE 块时，用更严的纯文本提示词在同一会话重试一次
    if (!files.length) {
      warn('Step2 首轮未解析出 FILE 块，触发纯文本重试（前200字：' + r2.text.slice(0, 200) + '）');
      await sendPrompt(sid, step2RetryPrompt(JSON.stringify(analyze, null, 2), rawContent, schemaV));
      var r2b = await collectText(sid, TURN_TIMEOUT_MS);
      var files2 = parseFileBlocks(r2b.text);
      log('摄入解析 → Step2 重试返回 ' + r2b.text.length + ' 字，解析到 ' + files2.length + ' 个 FILE 块');
      if (files2.length) { r2 = r2b; files = files2; }
    }
    var written = [];
    if (!files.length) {
      // 兜底：LLM 未按规范返回 FILE 块，保存原始响应，避免空库
      warn('Step2 未解析出规范 FILE 块，启用兜底保存原始响应（前300字：' + r2.text.slice(0, 300) + '）');
      var fbRel = 'ingest-fallback.md';
      var fbContent = '# 摄入原始响应（未结构化）\n\n> 自动兜底：LLM 未返回规范 FILE 块，已保留原始响应便于排查。\n\n```text\n' + r2.text + '\n```\n';
      kbWritePage(kb, fbRel, fbContent);
      written.push(fbRel);
      files = [{ path: fbRel, content: fbContent }];
    } else {
      for (var i = 0; i < files.length; i++) {
        var rel = (files[i].path || '').replace(/^wiki[\\/]/i, '').replace(/^[/\\]+/, '').trim() || ('untitled-' + i + '.md');
        kbWritePage(kb, rel, files[i].content);
        written.push(rel);
      }
    }
    await rebuildIndex(kb);   // 索引归插件所有：从真实页派生，杜绝鬼影/李白残留与键分裂
    cache[hash] = true; await writeCache(kb, cache);
    await appendLog(kb, '摄入 [' + type + '] → 新增/更新 ' + written.length + ' 页（实体 ' + (analyze.entities || []).length + ' / 概念 ' + (analyze.concepts || []).length + '）');
    return { ok: true, sessionId: sid, hash: hash, files: written.length, written: written, analyze: analyze };
  }

  // ===================== L7 UI =====================
  var KB_CSS = '.kb-root{--kb-col:880px;height:100%;display:flex;flex-direction:column;font-family:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);box-sizing:border-box;}.kb-hd{display:flex;align-items:center;gap:10px;padding:14px 20px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:14px;font-weight:600;width:100%;max-width:var(--kb-col,880px);margin:0 auto;box-sizing:border-box;}.kb-hd .kb-spacer{margin-left:auto;}.kb-tabs{display:flex;gap:2px;padding:0 20px;border-bottom:1px solid var(--dsw-alias-border-l1);width:100%;max-width:var(--kb-col,880px);margin:0 auto;box-sizing:border-box;}.kb-tab{padding:8px 12px;font-size:13px;cursor:pointer;color:var(--dsw-alias-label-tertiary);border-bottom:2px solid transparent;margin-bottom:-1px;border-radius:6px 6px 0 0;}.kb-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);}.kb-tab.on{color:var(--dsw-alias-label-primary);font-weight:600;border-bottom-color:var(--dsw-alias-brand-primary);}.kb-body{flex:1;overflow:auto;padding:20px 0;}.kb-wrap{width:100%;max-width:var(--kb-col,880px);margin:0 auto;padding:0 20px;box-sizing:border-box;}.kb-card{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:14px 16px;margin-bottom:14px;}.kb-card-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:10px;}.kb-kpis{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px;}.kb-kpi{flex:1 1 160px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:12px 14px;}.kb-kpi .k{font-size:12px;color:var(--dsw-alias-label-secondary);}.kb-kpi .v{font-size:20px;font-weight:600;color:var(--dsw-alias-label-primary);margin-top:4px;word-break:break-all;}.kb-row{margin-bottom:12px;}.kb-label{font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:6px;}.kb-area{width:100%;min-height:160px;box-sizing:border-box;font-size:13px;line-height:1.6;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:6px;resize:vertical;font-family:inherit;}.kb-area:focus,.kb-sel:focus{outline:none;border-color:var(--dsw-alias-brand-primary);}.kb-sel{font-size:13px;height:30px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:6px;padding:0 8px;}.kb-btn{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);border:1px solid transparent;border-radius:6px;padding:6px 14px;font-size:13px;cursor:pointer;font-family:inherit;}.kb-btn:hover{background:var(--dsw-alias-button-primary-hover);}.kb-btn:disabled{opacity:.5;cursor:default;}.kb-btn.ghost{background:transparent;color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2);}.kb-btn.ghost:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}.kb-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}.kb-msg{font-size:12px;margin-top:10px;white-space:pre-wrap;color:var(--dsw-alias-label-secondary);line-height:1.6;}.kb-msg.ok{color:var(--dsw-alias-state-success-primary);}.kb-msg.err{color:var(--dsw-alias-state-error-primary);}.kb-msg.warn{color:var(--dsw-alias-state-warn-primary);}.kb-file{padding:8px 10px;border-radius:6px;font-size:13px;cursor:pointer;color:var(--dsw-alias-label-primary);line-height:1.5;}.kb-file:hover{background:var(--dsw-alias-interactive-bg-hover);}.kb-pre{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:10px;font-size:12px;white-space:pre-wrap;max-height:300px;overflow:auto;color:var(--dsw-alias-label-primary);line-height:1.6;}.kb-float{position:absolute;z-index:9500;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);border:none;border-radius:14px;padding:6px 12px;font-size:12px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25);}.kb-float-bar{position:fixed;z-index:9999;display:flex;align-items:center;gap:2px;padding:4px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 4px 16px rgba(0,0,0,.18);}.kb-float-btn{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border:none;background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1;border-radius:7px;cursor:pointer;font-family:inherit;white-space:nowrap;}.kb-float-btn:hover{background:var(--dsw-alias-interactive-bg-hover);}.kb-float-btn.ok{color:var(--dsw-alias-state-success-primary);}.kb-float-sep{width:1px;height:16px;background:var(--dsw-alias-border-l1);margin:0 2px;flex:0 0 auto;}.kb-float-ic{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;flex:0 0 auto;}';
  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'style') e.setAttribute('style', attrs[k]);
      else if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    });
    if (children) children.forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }
  function style() {
    if (document.getElementById('kb-style')) return;
    var s = document.createElement('style'); s.id = 'kb-style'; s.textContent = KB_CSS;
    s.textContent += '\n.kb-sync-badge{font-size:12px;font-weight:600;margin-left:12px;white-space:nowrap;}';
    document.head.appendChild(s);
  }
  function buildPanel(container) {
    style();
    if (!container) return;
    container.innerHTML = '';
    var root = el('div', { class: 'kb-root' });
    root.appendChild(el('div', { class: 'kb-hd' }, [
      el('span', { text: '知识库管理' }),
      el('span', { class: 'kb-spacer' }),
      el('button', { class: 'kb-btn', id: 'kb-open-libr', text: '知识库管理师', onClick: function () { createKbManagerSession(buildKbManagerIntro(STATE.activeKb)); } }),
      el('div', { class: 'kb-sel-host', id: 'kb-kbSel-host', title: '选择知识库' }),
      el('button', { class: 'kb-btn ghost', id: 'kb-refresh', text: '刷新', title: '整页刷新（等同 F5），强制同步所有状态', onClick: onRefreshKb }),
      el('button', { class: 'kb-btn ghost', id: 'kb-root', text: '根目录', title: '设置知识库根目录（磁盘落盘位置）。默认 ../home/knowledge-bases（随安装目录，换机可用）', onClick: onEditKbRoot }),
      el('span', { class: 'kb-sync-badge', id: 'kb-sync-badge', title: '本库磁盘同步状态（写入即自动同步，无需手动）' }),
      el('button', { class: 'kb-btn ghost', id: 'kb-newkb', text: '+ 新建库', onClick: onCreateKb }),
      el('button', { class: 'kb-btn ghost', id: 'kb-delkb', text: '删除库', style: 'color:#e5484d;border-color:#e5484d;', onClick: onDeleteKb })
    ]));
    root.appendChild(el('div', { class: 'kb-tabs' }, [
      tabBtn('overview', '概览'), tabBtn('browse', '浏览'), tabBtn('import', '导入'), tabBtn('search', '检索')
    ]));
    root.appendChild(el('div', { class: 'kb-body', id: 'kb-body' }));
    container.appendChild(root);
    KB_MOUNT_PANEL = root;
    STATE.built = true;
    var rootInDoc = (typeof document !== 'undefined' && document.querySelector) ? !!document.querySelector('.kb-root') : 'n/a(无querySelector)';
    log('[KB-DIAG] buildPanel 完成 → .kb-root 在文档=' + rootInDoc + '，root 尺寸=' + JSON.stringify(rectOf(root)) + '，offsetParent=' + (root.offsetParent ? '有' : '无(可能被父级 display/overflow 隐藏)'));
    mountKbSelect();
    startHeaderGuard();
  }
  // 头部库选择器隔离进 Shadow DOM：React 只能看到宿主 div（id=kb-kbSel-host），永远无法
  // reconcile shadowRoot 内部的真正 select（id=kb-kbSel）。这从根上消除「删库后原生下拉事件被
  // 宿主 React 重渲染卡住、需失焦/截图才恢复」的问题（v28 修复）。
  function getKbSelect() {
    var host = (typeof document !== 'undefined') ? document.getElementById('kb-kbSel-host') : null;
    return (host && host.shadowRoot) ? host.shadowRoot.getElementById('kb-kbSel') : null;
  }
  function mountKbSelect() {
    var host = (typeof document !== 'undefined') ? document.getElementById('kb-kbSel-host') : null;
    if (!host) return;
    var sr = host.shadowRoot;
    if (!sr) { try { sr = host.attachShadow({ mode: 'open' }); } catch (e) { warn('[kb] attachShadow 失败', e && e.message); return; } }
    if (!sr.getElementById('kb-sel-shadow-style')) {
      var st = document.createElement('style'); st.id = 'kb-sel-shadow-style';
      st.textContent =
        ':host{display:inline-block;vertical-align:middle;min-width:120px;}' +
        'select{width:100%;min-width:120px;box-sizing:border-box;font-size:13px;height:30px;border:1px solid var(--dsw-alias-border-l2,#555);background:var(--dsw-alias-bg-layer-2,#2a2a2a);color:var(--dsw-alias-label-primary,#eee);border-radius:6px;padding:0 8px;}' +
        'select:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4a7);}';
      sr.appendChild(st);
    }
    if (!sr.getElementById('kb-kbSel')) {
      var sel = document.createElement('select');
      sel.id = 'kb-kbSel';
      sel.addEventListener('change', function () { STATE.activeKb = this.value; renderTab(); });
      sr.appendChild(sel);
    }
  }
  function tabBtn(key, label) {
    return el('div', { class: 'kb-tab' + (STATE.tab === key ? ' on' : ''), id: 'kb-tab-' + key, text: label, onClick: function () { STATE.tab = key; syncTabs(); renderTab(); } });
  }
  function syncTabs() {
    ['overview', 'browse', 'import', 'search'].forEach(function (k) {
      var t = document.getElementById('kb-tab-' + k); if (t) t.className = 'kb-tab' + (STATE.tab === k ? ' on' : '');
    });
  }
  function renderSyncBadge() {
    var b = document.getElementById('kb-sync-badge');
    if (!b) return;
    var kb = STATE.activeKb;
    if (!kb) { b.textContent = ''; b.style.color = ''; return; }
    if (isSynced(kb)) { b.textContent = '🌐 已自动同步'; b.style.color = '#3fb950'; }
    else { b.textContent = '⏳ 待同步'; b.style.color = '#d29922'; }
  }
  // 【v34.1】知识库根目录设置入口：写 localStorage 后整页 reload 使新根生效（WORKSPACE_ROOT 为模块级取值）。
  function onEditKbRoot() {
    var cur = kbRoot();
    var v = (typeof window !== 'undefined' && window.prompt)
      ? window.prompt('知识库根目录（磁盘落盘位置）\n· 绝对路径示例：D:\\DSH\\DH\\knowledge-bases\n· 相对路径 ../home/knowledge-bases 会随安装目录（换机可用）\n· 留空 = 恢复默认（' + DEFAULT_KB_ROOT + '）', cur)
      : null;
    if (v === null) return;
    v = String(v).trim();
    setKbRoot(v);
    kbToast(v ? ('根目录已设为 ' + v + '，正在重载…') : ('已恢复默认根目录 ' + DEFAULT_KB_ROOT + '，正在重载…'));
    log('[kb] 根目录设置 → ' + (v || ('（默认）' + DEFAULT_KB_ROOT)));
    setTimeout(function () { try { location.reload(); } catch (e) {} }, 500);
  }
  function renderTab() {
    renderSyncBadge();
    var body = document.getElementById('kb-body'); if (!body) return;
    body.innerHTML = '';
    var wrap = el('div', { class: 'kb-wrap' });
    if (STATE.tab === 'overview') wrap.appendChild(overviewView());
    else if (STATE.tab === 'browse') wrap.appendChild(browseView());
    else if (STATE.tab === 'import') wrap.appendChild(importView());
    else if (STATE.tab === 'search') wrap.appendChild(searchView());
    body.appendChild(wrap);
  }
  function kpiCard(label, value, id) {
    var vAttr = { class: 'v', text: value };
    if (id) vAttr.id = id;
    return el('div', { class: 'kb-kpi' }, [el('div', { class: 'k', text: label }), el('div', vAttr)]);
  }
  function overviewView() {
    var wrap = el('div');
    // 三重提示：工作区归属 + 根目录 + 勿删（防止 user 误删专用工作区导致会话回未分组）
    var wsWarn = el('div', { class: 'kb-msg', id: 'kb-ov-ws', text: '会话归入【' + WORKSPACE_TITLE + '】工作区（勿删！删了会话会变未分组）' });
    wsWarn.style.cssText = 'border-left:3px solid #f5a524;background:rgba(245,165,36,.08);color:var(--dsw-alias-label-primary);font-size:12px;';
    wrap.appendChild(wsWarn);
    var wsInfo = el('div', { class: 'kb-msg', text: '知识库根：' + rootDisplay() + '  ·  会话 cwd = 库根  ·  KB 文件：<库名>/wiki/{index.md, log.md, ...}' });
    wsInfo.style.cssText = 'font-size:11px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,monospace;';
    wrap.appendChild(wsInfo);
    wrap.appendChild(el('div', { class: 'kb-kpis' }, [
      kpiCard('当前库', STATE.activeKb || '（无）', 'kb-ov-kb'),
      kpiCard('页面数', '—', 'kb-ov-count'),
      kpiCard('最近摄入', '—', 'kb-ov-last')
    ]));
    var msg = el('div', { class: 'kb-msg', id: 'kb-ov-msg', text: '加载中…' });
    wrap.appendChild(el('div', { class: 'kb-card' }, [el('div', { class: 'kb-card-title', text: '最近摄入' }), msg]));
    if (STATE.activeKb) {
      listWikiFiles(STATE.activeKb).then(function (files) {
        var cnt = document.getElementById('kb-ov-count'); if (cnt) cnt.textContent = String(files.length);
        return Promise.resolve(kbReadMeta(STATE.activeKb, 'log')).then(function (logTxt) {
          var recent = logTxt.split('\n').filter(function (l) { return l.trim(); }).slice(-6).join('\n');
          var last = document.getElementById('kb-ov-last');
          if (last) last.textContent = recent ? '有记录' : '无';
          if (!files.length) {
            var keys = [], pre = KB_NS + 'page:' + STATE.activeKb + ':';
            try { for (var i = 0; i < localStorage.length; i++) { var kk = localStorage.key(i); if (kk && kk.indexOf(pre) === 0) keys.push(kk.slice(pre.length)); } } catch (e) {}
            msg.textContent = '（空库，去「导入」投入素材）' + (keys.length ? '｜诊断：发现 ' + keys.length + ' 个非.md 键: ' + keys.join(', ') : '');
          } else {
            msg.textContent = recent || '（暂无摄入记录，去「导入」投入素材）';
          }
        }).catch(function () { msg.textContent = '（暂无摄入记录，去「导入」投入素材）'; });
      }).catch(function (e) { msg.textContent = '读取失败：' + e.message; msg.className = 'kb-msg err'; });
    }
    return wrap;
  }
  async function refreshKbSelect() {
    var sel = getKbSelect();
    if (!sel) { mountKbSelect(); sel = getKbSelect(); }   // 【v32】兜底：shadow select 丢失（宿主不支持/清掉）则重建
    if (!sel) { sel = (typeof document !== 'undefined') ? document.getElementById('kb-kbSel') : null; }  // 【v32】再降级：非 shadow 的原生 select（极端兜底，防 v28 shadow 在你环境失效）
    if (!sel) return;
    var kbs = [];
    try { kbs = await listKbs(); } catch (e) { kbs = []; }
    STATE.kbs = kbs;   // 缓存供导入视图「目标库」选择器同步
    // 【v31】校正 activeKb：必须落在真实库清单 __kbs 内；无库则 null，绝不再回退到幽灵 'main'
    if (!kbs.length) STATE.activeKb = null;
    else if (kbs.indexOf(STATE.activeKb) < 0) STATE.activeKb = kbs[0];
    sel.options.length = 0;   // 标准清空 options（比 innerHTML='' 更稳，避免某些宿主 select 内部状态卡死）
    if (!kbs.length) {
      var ph = document.createElement('option'); ph.value = ''; ph.textContent = '（请先建库）'; sel.appendChild(ph);
    } else {
      kbs.forEach(function (k) {
        var o = document.createElement('option'); o.value = k; o.textContent = k;
        if (k === STATE.activeKb) o.selected = true; sel.appendChild(o);
      });
    }
    if (kbs.length) STATE.activeKb = sel.value || kbs[0];   // 下拉填充后回写当前选中库，保证浏览/检索视图读到当前库
    // 主动触发 change，让宿主感知新 value
    try { var ev = document.createEvent('HTMLEvents'); ev.initEvent('change', true, false); sel.dispatchEvent(ev); } catch (e) {}
  }
  // 删除/改库后，就地重填 header 的库选择 select（不 replaceChild 换元素，避免与宿主 React 冲突），
  // 并触发 change 事件让宿主感知；同时 headerGuard 会在面板存活期间持续自愈。
  function rebuildKbHeader() {
    return refreshKbSelect();
  }
  // 比对当前 select 的 options 是否与真实库清单 __kbs 一致（空库时仅一个「请先建库」占位）。
  // 不一致（如删库后 options 数量/内容未变）即视为需重填——这是 v32 根治「删库后下拉不刷新」的核心。
  function headerOptionsMismatch(sel, kbs) {
    if (!sel || !sel.options) return true;
    if (!kbs.length) return !(sel.options.length === 1 && sel.options[0].value === '');
    if (sel.options.length !== kbs.length) return true;
    var set = {};
    for (var i = 0; i < sel.options.length; i++) set[sel.options[i].value] = 1;
    for (var j = 0; j < kbs.length; j++) if (!set[kbs[j]]) return true;
    return false;
  }
  // 守护：面板挂载后每 800ms 检查一次 header select 是否健在、且 options 是否与库清单一致。
  // v28 仅查「缺失/空」；v32 升级为「比对一致性」——删库后 options 数量变化即立即重填，
  // 不再依赖失焦/截图才恢复。重建面板时清旧 timer，避免多实例或指向旧 root。
  function startHeaderGuard() {
    if (HeaderGuardTimer) { clearInterval(HeaderGuardTimer); HeaderGuardTimer = null; }
    HeaderGuardTimer = setInterval(function () {
      if (!KB_MOUNT_PANEL) { clearInterval(HeaderGuardTimer); HeaderGuardTimer = null; return; }
      if (typeof document !== 'undefined' && document.contains && !document.contains(KB_MOUNT_PANEL)) return;
      var sel = getKbSelect();
      if (!sel) { mountKbSelect(); sel = getKbSelect(); }
      if (!sel) sel = (typeof document !== 'undefined') ? document.getElementById('kb-kbSel') : null;
      if (!sel || !sel.options || sel.options.length === 0) {
        log('[KB-DIAG] headerGuard 检测到 select 缺失/空，执行自愈');
        refreshKbSelect().catch(function () {});
        return;
      }
      listKbs().then(function (kbs) {
        if (headerOptionsMismatch(sel, kbs)) {
          log('[KB-DIAG] headerGuard 检测到 options 与库清单不一致，执行自愈');
          refreshKbSelect().catch(function () {});
        }
      }).catch(function () {});
    }, 800);
  }
  function browseView() {
    var wrap = el('div');
    var list = el('div', { id: 'kb-browse-list', style: 'display:flex;flex-direction:column;gap:6px;' }, [el('div', { text: '加载中…' })]);
    var preview = el('div', { id: 'kb-preview-panel', style: 'min-height:120px;', text: '点击左侧词条预览内容' });
    var treeCard = el('div', { class: 'kb-card', style: 'flex:0 0 260px;max-height:68vh;overflow:auto;' }, [
      el('div', { class: 'kb-card-title', text: 'Wiki 树（点击预览）' }), list
    ]);
    var previewCard = el('div', { class: 'kb-card', style: 'flex:1 1 0;max-height:68vh;overflow:auto;' }, [
      el('div', { class: 'kb-card-title', text: '内容预览' }), preview
    ]);
    wrap.appendChild(el('div', { style: 'display:flex;gap:16px;align-items:flex-start;' }, [treeCard, previewCard]));
    if (STATE.activeKb) {
      listWikiFiles(STATE.activeKb).then(function (files) {
        list.innerHTML = '';
        if (!files.length) { list.textContent = '（空库，去「导入」投入素材）'; return; }
        files.forEach(function (f) {
          list.appendChild(el('div', { class: 'kb-file', title: f, 'data-rel': f, text: displayRel(STATE.activeKb, f), onClick: function () { previewFile(STATE.activeKb, f); } }));
        });
      }).catch(function (e) { list.innerHTML = ''; list.textContent = '读取失败：' + e.message; list.className = 'kb-msg err'; });
    } else { list.innerHTML = ''; list.textContent = '请先选择知识库'; }
    return wrap;
  }
  function previewFile(kb, rel) {
    var panel = document.getElementById('kb-preview-panel');
    Promise.resolve(kbReadPage(kb, rel)).then(function (c) {
      if (!panel) return;
      panel.innerHTML = '';
      panel.appendChild(el('div', { class: 'kb-card-title', style: 'margin-bottom:8px;', text: displayRel(kb, rel) }));
      panel.appendChild(el('div', { class: 'kb-pre', text: c || '(空)' }));
      // 高亮选中词条
      var list = document.getElementById('kb-browse-list');
      if (list) Array.prototype.forEach.call(list.children, function (ch) {
        if (ch.getAttribute && ch.getAttribute('data-rel') === rel) ch.style.background = 'var(--dsw-alias-interactive-bg-active, rgba(80,120,255,.12))';
        else ch.style.background = '';
      });
    }).catch(function (e) { kbToast('读取失败：' + e.message, true); });
  }
  function importView() {
    var wrap = el('div');
    var ta = el('textarea', { class: 'kb-area', id: 'kb-import-ta', placeholder: '粘贴要摄入的素材 / 选中文本后点浮条「导入知识库」会自动填入\n可在正文标注 @kb:库名 或 新建:库名 来指定目标库' });
    var kbs = STATE.kbs || [];
    // 【v31】不再把不在真实库清单里的 activeKb 拼进目标库下拉，避免幽灵库
    var kbSel = el('select', { class: 'kb-sel', id: 'kb-import-kb' }, kbs.map(function (k) {
      return el('option', { value: k, text: k });
    }));
    if (STATE.activeKb) kbSel.value = STATE.activeKb;   // 默认=当前浏览库（支持浏览 MAIN 时存进 TEST）
    // 【v35】删除「类型」选择器。原选项里的 skill（可复用步骤）是个误导：那个值
    // 只会被塞进 step1Prompt 的口吻提示词，产物照样只是 KB 里的一篇 wiki 页 ——
    // 既不会被 DSH 的 skill 工具加载，也不会出现在输入框的 / 菜单里（技能根是
    // <DSH_HOME>/skills，本插件压根不碰）。真正可调用的技能请用「技能」面板创建。
    var msg = el('div', { class: 'kb-msg', id: 'kb-import-msg' });
    var fileInput = el('input', { type: 'file', id: 'kb-import-file', multiple: true, accept: '.txt,.md,.csv,.docx,.xlsx,.pptx', style: 'margin-top:4px;' });
    async function handleFiles(fileList) {
      var files = Array.prototype.slice.call(fileList || []);
      if (!files.length) return;
      var msgs = [];
      for (var i = 0; i < files.length; i++) {
        var f = files[i]; var name = f.name || ('file' + i); var ext = (name.split('.').pop() || '').toLowerCase();
        try {
          var txt = '';
          if (ext === 'txt' || ext === 'md' || ext === 'csv') txt = await f.text();
          else if (ext === 'docx' || ext === 'xlsx' || ext === 'pptx') txt = await extractOoxmlText(await f.arrayBuffer(), ext);
          else { msgs.push('⚠️ 暂不支持 .' + ext + '：' + name + '（请用新版 .docx/.xlsx/.pptx，或转文本/.csv）'); continue; }
          if (!txt || !txt.trim()) { msgs.push('⚠️ ' + name + ' 未提取到文本（可能是扫描版/图片，暂不支持）'); continue; }
          ta.value = (ta.value ? ta.value + '\n\n/* === 来源文件：' + name + ' === */\n' : '') + txt;
          msgs.push('✅ ' + name + ' 已提取 ' + txt.length + ' 字');
        } catch (e) { msgs.push('❌ ' + name + ' 解析失败：' + (e && e.message)); }
      }
      msg.className = 'kb-msg'; msg.textContent = msgs.join('\n');
    }
    fileInput.addEventListener('change', function (ev) { handleFiles(ev.target.files); ev.target.value = ''; });
    var btn = el('button', { class: 'kb-btn', id: 'kb-ingest-btn', text: '摄入', onClick: function () {
      var text = ta.value;
      if (!text.trim()) { msg.className = 'kb-msg warn'; msg.textContent = '内容为空'; return; }
      var kb = (document.getElementById('kb-import-kb') || {}).value || STATE.activeKb;
      var r = resolveKbFromText(text);   // 正文标注优先于下拉（@kb:TEST / 新建:TEST）
      if (r) {
        if (r.isNew && (STATE.kbs || []).indexOf(r.kb) < 0) { ensureKb(r.kb); STATE.kbs = (STATE.kbs || []).concat([r.kb]); }
        kb = r.kb;
      }
      if (!kb) { msg.className = 'kb-msg warn'; msg.textContent = '请先选择/新建知识库（下拉或 +新建库，或正文 @kb:库名）'; return; }
      btn.disabled = true; msg.className = 'kb-msg'; msg.textContent = '① 分析中…（两步 LLM，约数十~数百秒）';
      ingestToKb({ kbName: kb, rawContent: text }).then(function (res) {
        if (res.skipped) { msg.className = 'kb-msg warn'; msg.textContent = '⏭ 已跳过：' + res.reason; }
        else { msg.className = 'kb-msg ok'; msg.textContent = '✅ 已写入 ' + res.files + ' 页（库：' + kb + '）：\n' + (res.written || []).join('\n'); }
        PendingSelectionText = null; if (ta) ta.value = ''; btn.disabled = false;
        STATE.activeKb = kb;                 // 同步激活库（浏览/检索跟随）；跳转对话已由 ingestToKb 内 CTX.sessions.open 完成，这里不再抢回 KB 面板
        refreshKbSelect().catch(function () {});
        // 【v34.1】无需显式落盘：内容写入已由 kbWritePage 触发 scheduleAutoSync 自动同步磁盘
      }).catch(function (e) { msg.className = 'kb-msg err'; msg.textContent = '❌ ' + e.message; btn.disabled = false; });
    } });
    wrap.appendChild(el('div', { class: 'kb-card' }, [
      el('div', { class: 'kb-card-title', text: '素材内容' }),
      el('div', { class: 'kb-row', style: 'margin-bottom:10px;' }, [
        el('label', { class: 'kb-label', style: 'display:flex;flex-direction:column;gap:6px;' }, [
          el('span', { text: '从文件摄入（.txt / .md / .csv / .docx / .xlsx / .pptx）' }),
          fileInput
        ])
      ]),
      ta,
      el('div', { class: 'kb-row', style: 'margin-top:12px;display:flex;gap:16px;flex-wrap:wrap;align-items:flex-end;' }, [
        el('div', { class: 'kb-label', style: 'display:flex;flex-direction:column;gap:6px;' }, [el('span', { text: '目标库' }), kbSel])
      ])
    ]));
    wrap.appendChild(el('div', { class: 'kb-card' }, [
      el('div', { class: 'kb-card-title', text: '执行' }),
      el('div', { class: 'kb-actions' }, [btn]), msg
    ]));
    if (PendingSelectionText) { ta.value = PendingSelectionText; }
    return wrap;
  }
  function searchView() {
    var wrap = el('div');
    var input = el('input', { class: 'kb-area', id: 'kb-search-input', style: 'min-height:0;height:34px;', placeholder: '关键词 / 标签' });
    var msg = el('div', { class: 'kb-msg', id: 'kb-search-msg' });
    var btn = el('button', { class: 'kb-btn', text: '检索', onClick: function () {
      var q = input.value.trim().toLowerCase();
      if (!q) { msg.className = 'kb-msg warn'; msg.textContent = '请输入关键词'; return; }
      if (!STATE.activeKb) { msg.className = 'kb-msg warn'; msg.textContent = '请先选择知识库'; return; }
      msg.className = 'kb-msg'; msg.textContent = '检索中…';
      listWikiFiles(STATE.activeKb).then(function (files) {
        var pending = files.map(function (f) {
          return Promise.resolve(kbReadPage(STATE.activeKb, f)).then(function (content) {
            var c = content;
            return c.toLowerCase().indexOf(q) >= 0 ? { path: f, c: c } : null;
          }).catch(function () { return null; });
        });
        Promise.all(pending).then(function (res) {
          var hit = res.filter(Boolean);
          if (!hit.length) { msg.className = 'kb-msg'; msg.textContent = '无命中'; return; }
          msg.className = 'kb-msg'; msg.innerHTML = '';
          msg.appendChild(el('div', { text: '命中 ' + hit.length + ' 个文件：' }));
          hit.forEach(function (h) {
            var snip = h.c.length > 200 ? h.c.slice(0, 200) + '…' : h.c;
            msg.appendChild(el('div', { class: 'kb-file', text: h.path + '\n' + snip, onClick: function () {
              var ref = '@kb:' + h.path;
              if (navigator.clipboard) navigator.clipboard.writeText(ref);
              msg.appendChild(el('div', { class: 'kb-label', text: '已复制引用：' + ref }));
            } }));
          });
        });
      }).catch(function (e) { msg.className = 'kb-msg err'; msg.textContent = '❌ ' + e.message; });
    } });
    wrap.appendChild(el('div', { class: 'kb-card' }, [el('div', { class: 'kb-card-title', text: '跨库检索（命中可复制 @kb 引用）' }), input]));
    wrap.appendChild(el('div', { class: 'kb-card' }, [el('div', { class: 'kb-card-title', text: '结果' }), el('div', { class: 'kb-actions' }, [btn]), msg]));
    return wrap;
  }
  // ---- 沙箱安全弹层：DSH WebView 禁用 window.prompt / window.alert ----
  // （实测日志："[dsh-frontend] Error: prompt() is not supported"），一切交互走自渲染 DOM。
  function kbToast(text, isErr) {
    try {
      var old = document.getElementById('kb-toast');
      if (old && old.parentNode) old.parentNode.removeChild(old);
      var t = el('div', { id: 'kb-toast', text: text, style: 'position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:99999;background:var(--dsw-alias-bg-layer-2);color:' + (isErr ? '#e5484d' : 'var(--dsw-alias-label-primary)') + ';border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 16px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.18);max-width:70vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' });
      document.body.appendChild(t);
      setTimeout(function () { try { if (t.parentNode) t.parentNode.removeChild(t); } catch (e) {} }, 2600);
    } catch (e) { warn('toast 渲染失败', e && e.message); }
  }
  // 轻量命名弹窗（替代 prompt）：backdrop + 卡片 + 输入框 + 确认/取消；ESC/点背景关闭。
  function kbAskName(onOk) {
    var close = function () { try { if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop); } catch (e) {} };
    var input = el('input', { id: 'kb-modal-input', style: 'width:100%;box-sizing:border-box;font-size:13px;height:32px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:0 10px;outline:none;', value: '', placeholder: '请输入库名（小写字母数字开头，可含 - _）' });
    input.addEventListener('keydown', function (ev) {
      try {
        var k = ev && (ev.key || ev.keyCode);
        if (k === 'Escape' || k === 'Esc' || k === 27) { ev.preventDefault && ev.preventDefault(); close(); }
        if (k === 'Enter' || k === 13) { ev.preventDefault && ev.preventDefault(); confirm(); }
      } catch (e) {}
    });
    var confirm = function () {
      var name = (input.value !== undefined && input.value !== null && input.value !== '') ? input.value : (input.getAttribute('value') || '');
      close();
      onOk(name);
    };
    var card = el('div', { class: 'kb-card', style: 'width:340px;max-width:86vw;margin:0;box-shadow:0 8px 32px rgba(0,0,0,.28);' }, [
      el('div', { class: 'kb-card-title', text: '新建知识库' }),
      input,
      el('div', { class: 'kb-actions', style: 'margin-top:12px;display:flex;gap:8px;justify-content:flex-end;' }, [
        el('button', { class: 'kb-btn ghost', text: '取消', onClick: close }),
        el('button', { class: 'kb-btn', id: 'kb-modal-ok', text: '创建', onClick: confirm })
      ])
    ]);
    var backdrop = el('div', { id: 'kb-modal-backdrop', style: 'position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;' }, [card]);
    backdrop.addEventListener('click', function (ev) { if (ev && ev.target === backdrop) close(); });
    document.body.appendChild(backdrop);
    try { input.focus && input.focus(); } catch (e) {}
  }
  async function onCreateKb() {
    kbAskName(async function (name) {
      name = (name || '').trim();
      if (!name) return;
      if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) { kbToast('非法名称：小写字母数字开头，可含 - _', true); return; }
      try { await ensureKb(name); STATE.activeKb = name; await rebuildKbHeader(); STATE.tab = 'overview'; syncTabs(); renderTab(); kbToast('知识库「' + name + '」已就绪'); }
      catch (e) { kbToast('创建失败：' + e.message, true); }
    });
  }
  // 删除当前选中库：清空 localStorage 该库全部数据（页面 + meta + 索引），原生 confirm 二次确认。
  // 注：库本体就在本地缓存，直接清 localStorage 最安全；磁盘若已有管理师落盘内容清不掉（UI 插件无 fs），提示手动清理。
  async function onDeleteKb() {
    var kb = STATE.activeKb;
    if (!kb) { kbToast('请先在下拉选择一个要删除的库', true); return; }
    if (typeof window !== 'undefined' && window.confirm) {
      if (!window.confirm('确认删除知识库「' + kb + '」？\n将清空该库的全部本地数据（页面 / schema / 摄入记录），不可恢复。\n（磁盘 ' + WORKSPACE_ROOT + '/' + kb + ' 若已有管理师落盘内容需手动清理）')) return;
    }
    try {
      kbListPages(kb).forEach(function (rel) { try { localStorage.removeItem(KB_NS + 'page:' + kb + ':' + norm(rel)); } catch (e) {} });
      var metaPre = KB_NS + 'meta:' + kb + ':';
      for (var i = (localStorage.length || 0) - 1; i >= 0; i--) {
        try { var kk = localStorage.key(i); if (kk && kk.indexOf(metaPre) === 0) localStorage.removeItem(kk); } catch (e) {}
      }
      var idx = kbIndex().filter(function (n) { return n !== kb; });
      lsSetJSON('__kbs', idx);
      clearSynced(kb);   // 【v34】同步状态一并清除，避免删库后徽标误显示「已同步」
      if (STATE.orchSids) { try { delete STATE.orchSids[kb]; } catch (e) {} }
      if (STATE.syncSids) { try { delete STATE.syncSids[kb]; } catch (e) {} }
      saveSid('kb-sync-sid:' + kb, '');   // 【v34.1】自动同步会话记录一并清除
      STATE.activeKb = idx[0] || '';
      mountKbSelect();   // 【v32】兜底：删库后若 shadow host/select 被宿主清掉则重建，再重填
      await rebuildKbHeader();
      syncTabs(); renderTab();
      kbToast('已删除知识库「' + kb + '」（本地数据已清空）');
      log('[kb] 已删除本地库 ' + kb + '（磁盘残留请手动清理 ' + WORKSPACE_ROOT + '/' + kb + '）');
    } catch (e) { kbToast('删除失败：' + e.message, true); }
  }
  // 手动刷新：等同 F5 整页重载。删库/改名后面板不刷新的根因是宿主 React 层持有旧状态，
  // 仅重渲染插件子节点无效；只有整页 reload 才能彻底重新初始化并同步所有状态。
  async function onRefreshKb() {
    try {
      kbToast('正在刷新（整页重载，等同 F5）…');
      log('[kb] 手动刷新按钮 → location.reload()');
      if (typeof location !== 'undefined' && location.reload) location.reload();
      else if (typeof window !== 'undefined' && window.location && window.location.reload) window.location.reload();
      else if (typeof window !== 'undefined' && window.location) window.location.href = window.location.href;
    } catch (e) { kbToast('刷新失败：' + e.message, true); }
  }

  // ---- 视图切换（划词浮条「导入知识库」用）----
  function activateKbTab() {
    if (KbSlotProps && typeof KbSlotProps.openView === 'function') {
      try { KbSlotProps.openView('knowledge-base'); log('✅ 已用 openView 切到知识库视图'); return true; }
      catch (e) { warn('openView 失败，走兜底', e && e.message); }
    }
    try {
      var tabs = document.querySelectorAll('[role="tablist"] [role="tab"], [role="tablist"] button');
      for (var i = 0; i < tabs.length; i++) {
        if ((tabs[i].textContent || '').indexOf('知识库') >= 0) { tabs[i].click(); log('✅ 已模拟点击「知识库」tab'); return true; }
      }
    } catch (e) { warn('点击 tab 失败', e && e.message); }
    try {
      var all = document.querySelectorAll('button');
      for (var j = 0; j < all.length; j++) {
        if ((all[j].textContent || '').trim() === '知识库') { all[j].click(); log('✅ 已用文本匹配点击「知识库」按钮'); return true; }
      }
    } catch (e2) {}
    log('⚠️ 未找到「知识库」视图 tab（空白会话不渲染 tab 条）。请先打开一个会话再点「导入知识库」。');
    return false;
  }
  function fillImportAfterMount(txt) {
    if (KB_MOUNT_PANEL) {
      try {
        STATE.tab = 'import'; syncTabs(); renderTab();
        var ta = document.getElementById('kb-import-ta');
        if (ta && txt) ta.value = txt;
        PendingSelectionText = txt || PendingSelectionText;
        log('✅ 已把选中文本填入导入框（' + (txt ? txt.length : 0) + ' 字）');
        return;
      } catch (e) { warn('填入导入框失败', e && e.message); }
    }
    // 面板尚未挂载：保留 PendingSelectionText，KbTabComponent 挂载回调会在面板就绪后自动回填。
    // 不依赖固定 2s 轮询——openView 切视图是异步的，冷启动可能慢于 2s，但挂载回调不受时间上限约束，照样可靠填入。
    log('面板尚未挂载，已缓存待沉淀文本，面板就绪后自动填入导入框');
  }
  // ===== 划词浮条（v34.4）：复制 + 导入知识库 =====
  // 「复制」= 复制选中文本（clipboard API，失败降级 execCommand）。
  // 「导入知识库」= 只切到知识库面板「导入」页并回填文本（activateKbTab + fillImportAfterMount），
  //   【不新建会话、不跳转、不发消息】——必须由用户在面板里确认后手动点「摄入」，才 ingestToKb()→发起对话。
  //   ⚠️ v34.3 曾误用 openKb() 导致「点一下就跳到对话框并开始对话」，勿再改回。
  // 定位改用 position:fixed + 视口坐标：DSH 是内部滚动容器，旧写法 absolute + window.scrollXY 会飘位。
  var SEL_ICON_COPY = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5.3" y="1.9" width="8.8" height="8.8" rx="2"/><path d="M10.7 13.1H4a2 2 0 0 1-2-2V4.9"/></svg>';
  var SEL_ICON_CHECK = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.2 8.6 6.4 11.8 12.8 4.6"/></svg>';
  var SEL_ICON_IMPORT = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.9v8.3"/><path d="M4.9 7.3 8 10.4l3.1-3.1"/><path d="M2.5 13.5h11"/></svg>';
  var selCopyBtn = null, selCopyIc = null, selCopyTx = null, selCopyTimer = null;

  function hideSelFloat() { try { if (selFloatEl) selFloatEl.style.display = 'none'; } catch (e) {} }
  function selBarText() {
    var t = FloatSelText;
    if (!t) { try { t = (window.getSelection() || '').toString().trim(); } catch (e) {} }
    return t || '';
  }
  function clearSelRanges() { try { if (window.getSelection) window.getSelection().removeAllRanges(); } catch (e) {} }
  function resetCopyBtn() {
    if (!selCopyBtn) return;
    selCopyBtn.className = 'kb-float-btn';
    if (selCopyIc) selCopyIc.innerHTML = SEL_ICON_COPY;
    if (selCopyTx) selCopyTx.textContent = '复制';
  }
  function mkSelBtn(id, iconSvg, label, onClick) {
    var b = el('button', { class: 'kb-float-btn', id: id, onClick: onClick });
    var ic = el('span', { class: 'kb-float-ic' }); ic.innerHTML = iconSvg;
    var tx = el('span', { class: 'kb-float-tx', text: label });
    b.appendChild(ic); b.appendChild(tx);
    return b;
  }
  function onCopySelClicked() {
    var txt = selBarText();
    if (!txt) { hideSelFloat(); return; }
    var finish = function (ok) {
      if (selCopyIc) selCopyIc.innerHTML = ok ? SEL_ICON_CHECK : SEL_ICON_COPY;
      if (selCopyTx) selCopyTx.textContent = ok ? '已复制' : '复制失败';
      if (selCopyBtn) selCopyBtn.className = 'kb-float-btn' + (ok ? ' ok' : '');
      log('[kb] 划词复制' + (ok ? '成功' : '失败') + '，长度=' + txt.length);
      if (selCopyTimer) { clearTimeout(selCopyTimer); selCopyTimer = null; }
      selCopyTimer = setTimeout(function () {   // 反馈展示完再收起浮条 + 清选区
        resetCopyBtn(); hideSelFloat(); clearSelRanges(); selCopyTimer = null;
      }, 1300);
    };
    var fallback = function () {
      try {
        var ta = document.createElement('textarea');
        ta.value = txt; ta.setAttribute('readonly', 'readonly');
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
        document.body.appendChild(ta); ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        finish(!!ok);
      } catch (e) { warn('[kb] 划词复制失败', e && e.message); finish(false); }
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(function () { finish(true); }, function () { fallback(); });
      } else fallback();
    } catch (e) { fallback(); }
  }
  function onImportSelClicked() {
    var txt = selBarText();
    if (!txt) { hideSelFloat(); return; }
    PendingSelectionText = txt;
    log('📥 导入知识库点击，待沉淀文本长度=' + txt.length + '（只切到知识库面板「导入」页并回填，等你确认后手动点「摄入」）');
    // 【v34.4】只切视图，绝不建会话/跳转/发消息：
    // v34.3 曾误用 openKb()（=新建 kb-manager 会话 + sessions.open + 发欢迎词），导致点一下就被弹到新对话框并开始对话。
    var switched = false;
    try { switched = activateKbTab(); } catch (e) { warn('[kb] 切换知识库视图失败', e && e.message); }
    try { fillImportAfterMount(txt); } catch (e) { warn('[kb] 回填导入框失败', e && e.message); }
    if (switched) kbToast('已填入知识库「导入」框，确认内容后点「摄入」');
    else kbToast('没找到「知识库」视图，请先打开一个会话再点「导入知识库」', true);
    hideSelFloat();
    clearSelRanges();
  }
  function setupSelectionFloat() {
    if (selFloatEl) return;
    style();   // 浮条可能早于面板出现，先确保 .kb-float-* 样式已注入
    var bar = el('div', { class: 'kb-float-bar', id: 'kb-float-bar', style: 'display:none;' });
    selCopyBtn = mkSelBtn('kb-float-copy', SEL_ICON_COPY, '复制', function () { onCopySelClicked(); });
    selCopyIc = selCopyBtn.querySelector('.kb-float-ic');
    selCopyTx = selCopyBtn.querySelector('.kb-float-tx');
    bar.appendChild(selCopyBtn);
    bar.appendChild(el('div', { class: 'kb-float-sep' }));
    bar.appendChild(mkSelBtn('kb-float-import', SEL_ICON_IMPORT, '导入知识库', function () { onImportSelClicked(); }));
    // mousedown 阻止默认：否则按下浮条的瞬间浏览器会清空选区，点击时已拿不到文本
    bar.addEventListener('mousedown', function (ev) { try { ev.preventDefault(); } catch (e) {} });
    selFloatEl = bar;
    document.body.appendChild(bar);

    function inEditable(node) {
      try {
        var n = node;
        while (n && n.nodeType === 1 && n !== document.body) {
          var tn = (n.tagName || '').toLowerCase();
          if (tn === 'input' || tn === 'textarea' || tn === 'select' || n.isContentEditable) return true;
          n = n.parentNode;
        }
      } catch (e) {}
      return false;
    }
    document.addEventListener('mouseup', function (ev) {
      if (ev && ev.target && selFloatEl && (selFloatEl === ev.target || selFloatEl.contains(ev.target))) return;
      setTimeout(function () {
        var sel = window.getSelection();
        var txt = sel ? sel.toString().trim() : '';
        if (txt.length < 4) { FloatSelText = ''; hideSelFloat(); return; }
        if (ev && ev.target && inEditable(ev.target)) { FloatSelText = ''; hideSelFloat(); return; }  // 输入框/可编辑区内划词不打扰
        FloatSelText = txt;
        resetCopyBtn();
        try {
          var rect = sel.getRangeAt(0).getBoundingClientRect();
          if (!rect || (!rect.width && !rect.height)) { hideSelFloat(); return; }
          selFloatEl.style.display = 'flex';
          var w = selFloatEl.offsetWidth || 200;
          var left = rect.left + rect.width / 2 - w / 2;
          var top = rect.top - 46;
          if (top < 8) top = rect.bottom + 10;                                    // 上方不够 → 落到选区下方
          if (left < 8) left = 8;
          if (left + w > window.innerWidth - 8) left = window.innerWidth - 8 - w;
          selFloatEl.style.left = left + 'px';
          selFloatEl.style.top = top + 'px';
        } catch (e) { hideSelFloat(); }
      }, 10);
    });
    // 选区消失 → 收起
    document.addEventListener('selectionchange', function () {
      if (!selFloatEl || selFloatEl.style.display === 'none') return;
      try { var s = window.getSelection(); if (!s || !s.toString().trim()) { FloatSelText = ''; hideSelFloat(); } } catch (e) {}
    });
    document.addEventListener('keydown', function (ev) {
      if (ev && (ev.key === 'Escape' || ev.keyCode === 27)) { FloatSelText = ''; hideSelFloat(); }
    }, true);
    // 滚动（含内部滚动容器）→ 收起，避免浮条停在原地
    window.addEventListener('scroll', function () {
      if (selFloatEl && selFloatEl.style.display !== 'none') hideSelFloat();
    }, true);
  }

  // ---- 视图组件（回调 ref 挂载 vanilla 面板，不用 React hooks）----
  // 稳定 ref（模块级函数实例）：避免内联 ref 每次 re-render 触发 ref(null)→ref(node) 抖动，
  // 否则宿主重渲染会让 KB_MOUNT_PANEL 长期为 null、面板失自愈，并可能使注入的原生 header select 失活。
  function kbTabRef(node) {
    if (node && !node.__kbMounted) {
      node.__kbMounted = true;
      KB_MOUNT_PANEL = node;
      STATE.built = true;
      log('[KB-DIAG] ref 挂载 → node 尺寸=' + JSON.stringify(rectOf(node)) + '，parent 尺寸=' + JSON.stringify(rectOf(node && node.parentElement)));
      buildPanel(node);
      refreshKbSelect().then(renderTab).catch(renderTab);
      if (PendingSelectionText) {
        STATE.tab = 'import'; syncTabs(); renderTab();
        var ta = document.getElementById('kb-import-ta');
        if (ta) ta.value = PendingSelectionText;   // 不清除：openView 异步重渲染会重建 textarea，importView 每次渲染都会回填
      }
    } else if (!node) {
      KB_MOUNT_PANEL = null; STATE.built = false;
      if (HeaderGuardTimer) { clearInterval(HeaderGuardTimer); HeaderGuardTimer = null; }
    }
  }
  function KbTabComponent(props) {
    KbSlotProps = props || null;
    log('[KB-DIAG] KbTabComponent 渲染 → React=' + (typeof React) + '，propsKeys=' + (props ? Object.keys(props).join(',') : 'null') + '，构建=' + KB_BUILD);
    return React.createElement('div', { style: { height: '100%' }, ref: kbTabRef }, null);
  }
  function rectOf(n) { if (!n || !n.getBoundingClientRect) return 'n/a'; var r = n.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; }

  // ===================== L8 ENTRY =====================
  // 打开知识库：完全对齐「智能体工作台」的对话式创建逻辑（dsh-agent-maker openPresetSession）。
  // 点击「知识库」→ remote.session.create({agentPreset:'kb-manager', workspaceId}) 新建并打开一个 kb-manager 会话，
  // 并自动发欢迎词；不自动建库（用户可在对话里或 TAB 里建）。点一次 = 一个新会话，不复用。
  // 旧的「抽屉」方案已废弃（它绕开 conversation.view 插槽、与 TAB 面板冲突导致知识库消失）。
  function createKbManagerSession(autoPrompt) {
    // 先关闭智能体工作台面板（避免点完「知识库」后左侧浮层还挡着主界面）。
    // dsh-agent-maker 已暴露 window.__kbClosePanel；若不存在则忽略。
    try { if (typeof window !== 'undefined' && window.__kbClosePanel) window.__kbClosePanel(); } catch (e) {}
    var ctx = CTX;
    // 兼容 autoPrompt 为字符串或 Promise<string>（buildKbManagerIntro 返回 Promise）。
    var promptP = (autoPrompt && typeof autoPrompt.then === 'function') ? autoPrompt : Promise.resolve(autoPrompt);
    var doCreate = function (workspaceId, resolvedPrompt) {
      if (ctx.remote && ctx.remote.session && typeof ctx.remote.session.create === 'function' &&
          ctx.sessions && typeof ctx.sessions.open === 'function') {
        var payload = { agentPreset: KB_MANAGER_ID };
        if (workspaceId) payload.workspaceId = workspaceId;
        Promise.resolve(ctx.remote.session.create(payload))
          .then(function (r) {
            if (r && r.ok && r.value && r.value.sessionId) {
              ctx.sessions.open(r.value.sessionId);
              log('[kb] 已创建并打开 kb-manager 会话 ' + r.value.sessionId + (workspaceId ? ('，workspace=' + workspaceId) : ''));
              if (resolvedPrompt) {
                sendPrompt(r.value.sessionId, resolvedPrompt).catch(function (e) { warn('知识库管理师欢迎词发送失败', e && e.message); });
              }
            } else {
              warn('[kb] remote.session.create 未返回 ok，回退：', r && r.error && r.error.message);
              fallbackStartSession(KB_MANAGER_ID);
            }
          })
          .catch(function (e) { warn('[kb] remote.session.create 失败，回退：', e && e.message); fallbackStartSession(KB_MANAGER_ID); });
      } else {
        fallbackStartSession(KB_MANAGER_ID);
      }
    };
    // 确保知识库 workspace 已注册（归组，避免落未分组、避免 preset 被重置成 standard）
    // 先等 autoPrompt 解析（含当前库概况），再创建会话并发送。
    ensureWorkspaceId().then(function (wsId) { return promptP.then(function (p) { doCreate(wsId, p); }); })
      .catch(function () { promptP.then(function (p) { doCreate(null, p); }); });
  }
  // 兜底：remote.session.create 不可用时，用 uiWorkspace.startSession（会进 DSH 原生选择菜单）
  function fallbackStartSession(presetId) {
    try {
      var ws = svc().uiWorkspace;
      if (!(ws && typeof ws.startSession === 'function')) { warn('[kb] uiWorkspace.startSession 不可用，无法新建会话'); return; }
      ws.startSession();
      log('[kb] 已回退到 uiWorkspace.startSession（原生菜单）');
    } catch (e) { warn('[kb] fallbackStartSession 失败', e && e.message); }
  }
  // 入口：点击「知识库」按钮 → 对话式创建 kb-manager 会话（即「新建一个知识库分区的空白页 + 加载知识库管理师」）
  function openKb() {
    log('[kb] openKb 入口：对话式创建 kb-manager 会话（构建=' + KB_BUILD + '）');
    createKbManagerSession(buildKbManagerIntro(null));   // 主入口：通用引导，不绑定具体库
  }

  function apply(ctx) {
    CTX = ctx;
    try { window.__kbOpen = openKb; } catch (e) {}
    setupSelectionFloat();
    // 主工作区顶部 tab 条 = conversation.view slot（对话/轨迹同款）：作为浏览/导入/检索管理面板。
    // 「知识库」按钮走对话式创建（createKbManagerSession），与面板互不干扰。
    try {
      if (ctx.slots && typeof ctx.slots.inject === 'function' && typeof ctx.slots.register === 'function') {
        ctx.slots.inject('conversation.view', function () {
          return ctx.slots.register({ name: 'conversation.view', id: 'knowledge-base', order: 100, label: '知识库' }, KbTabComponent);
        });
        log('✅ 已注册主工作区「知识库」视图（conversation.view slot，order 100，与对话/轨迹并列）');
      } else warn('ctx.slots 不可用，主工作区视图注册失败');
    } catch (e) { warn('conversation.view 注册抛错', e && e.message); }
    log('知识库插件已加载（KB 根=' + KB_ROOT + '，摄入预设=' + ORCHESTRATOR_ID + '，管理师预设=' + KB_MANAGER_ID + '，构建=' + KB_BUILD + '）');
  }

  window.__ModuleLoader__.load({
    id: 'dsh-knowledge-base',
    factory: function (require) {
      var module = { exports: {} };
      var exports = module.exports;
      try { React = require('react'); } catch (e) { React = null; }
      if (!React && typeof window !== 'undefined' && window.React) { React = window.React; log('[KB-DIAG] require react 失败，改用 window.React 兜底'); }
      else if (React) log('[KB-DIAG] React 来源=require（typeof=' + (typeof React) + '）');
      else warn('[KB-DIAG] React 两路都拿不到，组件将无法渲染');
      exports.name = 'dsh-knowledge-base';
      // 必须声明实际用到的宿主服务，否则 cordis 抛 "cannot get property X without inject"
      // 注意：uiWorkspace 仅 fallbackStartSession 用，声明后不会报错；createKbManagerSession 主路径用 remote.session.create
      exports.inject = ['remote', 'remote.session', 'remote.workspace', 'sessions', 'slots', 'uiWorkspace'];
      exports.apply = apply;
      return module.exports;
    }
  });
})();
