/**
 * 浏览器半测试：用最小 DOM 替身跑**真实的 client.js 源码**。
 *
 * 这是看不见浏览器时唯一的证据来源（技能 §四）。
 * 注意：替身里 `setAttribute('class')` 不会自动变成 `className`，
 * 所以 client.js 的 `el()` 助手与替身两边都显式处理了 className。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { check, makeDom, makeXhr, makeObserver } from './harness.mjs';

const CLIENT_SOURCE = readFileSync(
  fileURLToPath(new URL('../client.js', import.meta.url)),
  'utf8'
);

/** 可手动推进的假时钟，让 300ms 去抖在测试里瞬间跑完。 */
function makeClock() {
  let nextId = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const handle = ++nextId;
      timers.set(handle, { fn, ms: ms ?? 0 });
      return handle;
    },
    clearTimeout(handle) { timers.delete(handle); },
    runAll() {
      let guard = 0;
      while (timers.size > 0 && guard < 200) {
        guard += 1;
        const [handle, timer] = timers.entries().next().value;
        timers.delete(handle);
        timer.fn();
      }
    },
    pending() { return timers.size; }
  };
}

/** 加载一份全新的 client.js（每次调用都是干净状态）。 */
function loadClient(dom, clock, xhr) {
  const observer = makeObserver();
  let captured = null;
  const windowObj = {
    __ModuleLoader__: { load(mod) { captured = mod; } }
  };
  const factory = new Function(
    'window', 'document', 'MutationObserver', 'XMLHttpRequest',
    'location', 'setTimeout', 'clearTimeout',
    CLIENT_SOURCE
  );
  factory(
    windowObj, dom.document, observer.FakeObserver, xhr.FakeXhr,
    { href: 'http://127.0.0.1:3080/' }, clock.setTimeout, clock.clearTimeout
  );
  if (captured === null) throw new Error('client.js 没有注册到 __ModuleLoader__');
  const exportsObj = captured.factory((id) => {
    throw new Error(`unexpected require: ${id}`);
  });
  return { exports: exportsObj, observer };
}

/** 造一个假 ctx.remote，记录被打开的路径。 */
function makeRemote({ capable = true, openFails = false } = {}) {
  const opened = [];
  return {
    opened,
    remote: {
      session: {
        canOpenWorkspacePath() {
          return Promise.resolve({ ok: true, value: capable });
        },
        openWorkspacePath(request) {
          opened.push(request.path);
          if (openFails) return Promise.reject(new Error('宿主拒绝了'));
          return Promise.resolve({ ok: true });
        }
      }
    }
  };
}

/** 造一个假 ctx（只带 remote）。 */
function makeClientCtx(remote) {
  return {
    remote: remote.remote ?? remote,
    logger: { info() {}, warn() {} },
    provide() {},
    get() { return undefined; },
    effect() {}
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * 装好一个"对话 DOM + 已就绪的客户端"，并跑完 能力探测 → 扫描 → 校验 → 装饰 全链路。
 * @returns {Promise<object>}
 */
async function boot({ text = '', capable = true, checkItems = null, checkFails = false, mount } = {}) {
  const dom = makeDom();
  const clock = makeClock();
  const xhr = makeXhr();
  const { exports: client, observer } = loadClient(dom, clock, xhr);

  const remote = makeRemote({ capable });
  const ctx = makeClientCtx(remote);

  const rootEl = dom.el('div', { id: 'root' });
  dom.body.appendChild(rootEl);
  if (typeof mount === 'function') mount(dom, rootEl);
  else if (text !== '') {
    const wrapper = dom.el('div');
    const pre = dom.el('pre');
    const code = dom.el('code', null, text);
    pre.appendChild(code);
    wrapper.appendChild(pre);
    rootEl.appendChild(wrapper);
  }

  client.apply(ctx);
  await flush();
  clock.runAll();

  if (checkItems !== null || checkFails) {
    // 宿主不支持打开时客户端**故意**不发 /check（有断言盯这条），所以这里要判存在
    if (checkFails) {
      if (xhr.hasPending('/dsh-file-opener/check')) xhr.failTo('/dsh-file-opener/check');
    } else if (xhr.hasPending('/dsh-file-opener/check')) {
      xhr.respondTo('/dsh-file-opener/check', 200, { ok: true, items: checkItems });
    }
    await flush();
    clock.runAll();
  }

  return { dom, clock, xhr, client, remote, ctx, observer, rootEl };
}

export async function run() {
  //#region ── 纯函数：路径识别 ────────────────────────────────────────
  {
    const dom = makeDom();
    const { exports: client } = loadClient(dom, makeClock(), makeXhr());
    const extract = client.__internals.extractPaths;

    check('整行即路径：允许文件名带空格',
      JSON.stringify(extract('   C:\\out\\我的 报告.docx   ')) === JSON.stringify(['C:\\out\\我的 报告.docx']));

    check('行内路径：从正文里抠出来',
      JSON.stringify(extract('已经输出了，文件在磁盘上：C:\\out\\a.html 收工'))
        === JSON.stringify(['C:\\out\\a.html']));

    check('去掉包裹的引号与反引号',
      JSON.stringify(extract('`C:\\out\\a.docx`')) === JSON.stringify(['C:\\out\\a.docx']));

    check('相对路径不认',
      extract('out\\relative.docx').length === 0);

    check('多行多个路径都认',
      extract('C:\\a\\1.docx\n说明文字\nC:\\b\\2.xlsx').length === 2);

    check('大小写不同的同一个路径只留一个',
      extract('C:\\A\\x.docx\nc:\\a\\X.DOCX').length === 1);

    check('结尾的句号/括号被剥掉',
      JSON.stringify(extract('见 C:\\a\\b.docx。')) === JSON.stringify(['C:\\a\\b.docx']));

    check('超长字符串被丢弃',
      extract('C:\\a\\' + 'x'.repeat(600) + '.docx').length === 0);

    check('没有扩展名的路径不认（避免误伤盘符文本）',
      extract('C:\\a\\b').length === 0);

    //#region 跳过规则
    const foreign = dom.el('div', { 'data-dsh-media-host': '1' });
    const inside = dom.el('p', null, 'x');
    foreign.appendChild(inside);
    check('跳过 media-preview 的地盘', client.__internals.isForeign(inside) === true);

    const mermaid = dom.el('div', { className: 'dsh-mmd' });
    const inMermaid = dom.el('p');
    mermaid.appendChild(inMermaid);
    check('跳过 mermaid 的地盘', client.__internals.isForeign(inMermaid) === true);

    const editable = dom.el('div', { contenteditable: 'true' });
    const inEditable = dom.el('p');
    editable.appendChild(inEditable);
    check('跳过可编辑区（输入框）', client.__internals.isForeign(inEditable) === true);

    const pre = dom.el('pre');
    const inPre = dom.el('code');
    pre.appendChild(inPre);
    check('**不**跳过 <pre>（代码块正是本插件的主战场）',
      client.__internals.isForeign(inPre) === false);

    check('humanSize 可读', client.__internals.humanSize(2048) === '2.0 KB');
    check('humanSize 对 0 返回空串', client.__internals.humanSize(0) === '');
    //#endregion
  }
  //#endregion

  //#region ── 全链路：代码块里的路径出条 ──────────────────────────────
  const path = 'C:\\Users\\Example\\Documents\\quarterly-report.docx';
  {
    const r = await boot({
      text: path,
      checkItems: [{ asked: path, ok: true, kind: 'file', name: 'quarterly-report.docx', size: 10342, ext: '.docx', path }]
    });

    const bars = r.rootEl.querySelectorAll('[data-dsfo-bar]');
    check('代码块后面挂上了 chip 条', bars.length === 1);
    check('条里有 1 个文件 chip', bars[0]?.querySelectorAll('[data-dsfo-chip]').length === 1);
    check('条里有 1 个文件夹按钮', bars[0]?.querySelectorAll('[data-dsfo-folder]').length === 1);

    const chip = bars[0]?.querySelectorAll('[data-dsfo-chip]')[0];
    check('chip 上写着文件名', String(chip?.textContent).includes('quarterly-report.docx'));
    check('chip 上写着体积', String(chip?.textContent).includes('10.1 KB'));
    check('chip 的 title 是完整路径', String(chip?.getAttribute('title')).includes(path));

    check('块被标记为已处理', r.rootEl.querySelectorAll('pre')[0]?.getAttribute('data-dsfo-done') === 'yes');

    // 幂等：再扫一遍不该多出第二条
    r.client.__internals.scanOnce();
    r.clock.runAll();
    check('重复扫描不产生第二条（幂等，坑 #3/#4）',
      r.rootEl.querySelectorAll('[data-dsfo-bar]').length === 1);

    // React 在流式结束/重渲染时可能替换整块节点：标记随旧节点消失，
    // 但挂在兄弟位置的条子还在 ⇒ 必须靠"内容键"去重，否则会重复出条。
    const wrapper = r.rootEl.querySelectorAll('pre')[0].parentNode;
    const oldPre = r.rootEl.querySelectorAll('pre')[0];
    const newPre = r.dom.el('pre');
    newPre.appendChild(r.dom.el('code', null, path));
    wrapper.insertBefore(newPre, oldPre);
    wrapper.removeChild(oldPre);
    check('模拟 React 换掉块节点后，条子仍在（它是兄弟节点）',
      r.rootEl.querySelectorAll('[data-dsfo-bar]').length === 1);
    r.client.__internals.scanOnce();
    r.clock.runAll();
    check('块节点被替换后**不再重复出条**（内容键去重，坑 #4 同族）',
      r.rootEl.querySelectorAll('[data-dsfo-bar]').length === 1);

    // 点击 = 打开
    chip.fire('click');
    await flush();
    check('点 chip 调用了官方 RPC 且传的是完整路径', r.remote.opened[0] === path);

    // 点击必须立刻可见：STATS 只在扫描时被读走，点击后通常不再有 DOM 变化，
    // 不上报就等于"点没点过"永远查不出来（真实踩到：拿到的是过期读数，坑 #8 同族）
    const clickReports = r.xhr.pending
      .filter((entry) => entry.xhr.url === '/dsh-file-opener/report')
      .map((entry) => JSON.parse(entry.body));
    check('点击会**立刻**上报（宿主侧能实时看到）',
      clickReports.some((p) => p.reason === 'click:open'));

    // 文件夹按钮 = 在文件夹中显示（走自己的 /reveal 路由，用 explorer /select,）
    const folder = bars[0].querySelectorAll('[data-dsfo-folder]')[0];
    check('条里有文件夹按钮', folder !== undefined && folder !== null);
    folder.fire('click');
    const revealReq = r.xhr.pending.find((entry) => entry.xhr.url === '/dsh-file-opener/reveal');
    check('点文件夹按钮发往本插件的 /reveal（不再走 openWorkspacePath）', revealReq !== undefined);
    check('/reveal 的请求体里是完整路径',
      revealReq !== undefined && JSON.parse(revealReq.body).path === path);
    check('reveal **不会**被当成"打开文件"（没调 openWorkspacePath）', r.remote.opened.length === 1);

    r.xhr.respondTo('/dsh-file-opener/reveal', 200, { ok: true, revealed: 'C:\\x\\a.docx', kind: 'file' });
    await flush();
    check('reveal 成功后按钮进入 ok 态', folder.getAttribute('data-dsfo-state') === 'ok');

    // 失败必须**可见**（用户报"无效"时之所以给不出线索，就是因为失败是静默的）
    folder.fire('click');
    r.xhr.respondTo('/dsh-file-opener/reveal', 403, { ok: false, code: 'outside_roots', message: '路径不在任何允许的会话工作区之内' });
    await flush();
    check('reveal 失败后按钮进入 error 态', folder.getAttribute('data-dsfo-state') === 'error');
    check('reveal 失败原因写进了 title', String(folder.getAttribute('title')).includes('路径不在任何允许'));
    const note = bars[0].querySelectorAll('[data-dsfo-note]');
    check('reveal 失败在条上留下一行可见说明', note.length === 1);
    check('那行说明写着原因', String(note[0]?.textContent).includes('路径不在任何允许'));
    check('失败计数被记录', r.client.__internals.STATS.revealErrors === 1);

    check('诊断属性写进了 <html>', r.dom.documentElement.getAttribute('data-dsfo-build') !== null);
    check('扫描计数写进了 <html>', Number(r.dom.documentElement.getAttribute('data-dsfo-scans')) >= 1);
    check('能力探测结果写进了 <html>', r.dom.documentElement.getAttribute('data-dsfo-capability') === 'yes');
  }
  //#endregion

  //#region ── 不存在的路径不装饰（"别变吵"的关键行为）────────────────
  {
    const ghost = 'C:\\nope\\不存在的东西.docx';
    const r = await boot({
      text: ghost,
      checkItems: [{ asked: ghost, ok: false, code: 'not_found', message: '路径不存在或不可访问' }]
    });
    check('不存在的路径不出条', r.rootEl.querySelectorAll('[data-dsfo-bar]').length === 0);
    check('该块被标记为 empty（有确定答案才定案）',
      r.rootEl.querySelectorAll('pre')[0]?.getAttribute('data-dsfo-done') === 'empty');
  }
  //#endregion

  //#region ── 校验还没回来时不能提前定案 ────────────────────────────
  {
    const r = await boot({ text: path }); // 不发 XHR 响应 → 检查永远 pending
    check('校验未返回时不出条', r.rootEl.querySelectorAll('[data-dsfo-bar]').length === 0);
    check('校验未返回时也**不**标记为空（否则永远出不来）',
      r.rootEl.querySelectorAll('pre')[0]?.getAttribute('data-dsfo-done') === null);
    check('有一个待处理的 /check 请求', r.xhr.hasPending('/dsh-file-opener/check'));

    // 现在补上响应 → 应当出条
    r.xhr.respondTo('/dsh-file-opener/check', 200, {
      ok: true,
      items: [{ asked: path, ok: true, kind: 'file', name: 'a.docx', size: 100, ext: '.docx', path }]
    });
    await flush();
    r.clock.runAll();
    check('校验返回后才出条', r.rootEl.querySelectorAll('[data-dsfo-bar]').length === 1);
  }
  //#endregion

  //#region ── 传输失败：不缓存否定、不崩、可重试（坑 #17）──────────────
  {
    const r = await boot({ text: path, checkFails: true });
    check('校验请求失败时不崩', true);
    check('传输失败**不**写入缓存（否则永不重试）', r.client.__internals.checkCache.size === 0);
    check('传输失败被记进 <html data-dsfo-error>',
      r.dom.documentElement.getAttribute('data-dsfo-error') !== null);
    check('传输失败时不标记块为完成', r.rootEl.querySelectorAll('pre')[0]?.getAttribute('data-dsfo-done') === null);
  }
  //#endregion

  //#region ── 宿主不支持打开 → 整片不装饰 ────────────────────────────
  {
    const r = await boot({
      text: path,
      capable: false,
      checkItems: [{ asked: path, ok: true, kind: 'file', name: 'a.docx', size: 1, ext: '.docx', path }]
    });
    check('宿主不支持打开时不出条', r.rootEl.querySelectorAll('[data-dsfo-bar]').length === 0);
    check('宿主不支持打开时阶段写进 DOM',
      r.dom.documentElement.getAttribute('data-dsfo-phase') === 'unsupported');
    check('宿主不支持打开时不发 /check 请求', r.xhr.hasPending('/dsh-file-opener/check') === false);
  }
  //#endregion

  //#region ── 嵌套块只出一条；媒体地盘不碰 ──────────────────────────
  {
    const r = await boot({
      checkItems: [{ asked: path, ok: true, kind: 'file', name: 'a.docx', size: 1, ext: '.docx', path }],
      mount(dom, rootEl) {
        const quote = dom.el('blockquote');
        const p = dom.el('p', null, `产出在 ${path}`);
        quote.appendChild(p);
        rootEl.appendChild(quote);

        const mediaHost = dom.el('div', { 'data-dsh-media-host': '1' });
        const p2 = dom.el('p', null, `另一个 ${path}`);
        mediaHost.appendChild(p2);
        rootEl.appendChild(mediaHost);
      }
    });
    const bars = r.rootEl.querySelectorAll('[data-dsfo-bar]');
    check('嵌套块（blockquote > p）只出一条', bars.length === 1);
    check('media-preview 的地盘一个条都不加',
      r.rootEl.querySelectorAll('[data-dsh-media-host]')[0].querySelectorAll('[data-dsfo-bar]').length === 0);
    check('同一个路径只发一次 /check（候选去重）',
      r.xhr.hasPending('/dsh-file-opener/check') === false);
  }
  //#endregion

  //#region ── 打开失败要可见且可重试（坑 #5/#17）─────────────────────
  {
    const dom = makeDom();
    const clock = makeClock();
    const xhr = makeXhr();
    const { exports: client } = loadClient(dom, clock, xhr);
    const opened = [];
    const ctx = makeClientCtx({
      session: {
        canOpenWorkspacePath: () => Promise.resolve({ ok: true, value: true }),
        openWorkspacePath: (request) => {
          opened.push(request.path);
          return opened.length === 1
            ? Promise.reject(new Error('系统里没有能打开这个文件的程序'))
            : Promise.resolve({ ok: true });
        }
      }
    });
    const rootEl = dom.el('div', { id: 'root' });
    dom.body.appendChild(rootEl);
    const pre = dom.el('pre');
    pre.appendChild(dom.el('code', null, path));
    rootEl.appendChild(pre);

    client.apply(ctx);
    await flush();
    clock.runAll();
    xhr.respondTo('/dsh-file-opener/check', 200, {
      ok: true,
      items: [{ asked: path, ok: true, kind: 'file', name: 'a.docx', size: 1, ext: '.docx', path }]
    });
    await flush();
    clock.runAll();

    const chip = rootEl.querySelectorAll('[data-dsfo-chip]')[0];
    check('打开失败场景下 chip 仍然出现', chip !== undefined && chip !== null);
    chip.fire('click');
    await flush();
    check('打开失败后 chip 进入 error 态', chip.getAttribute('data-dsfo-state') === 'error');
    check('失败原因写在 chip 上（可见的失败）', String(chip.textContent).includes('打不开'));
    chip.fire('click');
    await flush();
    check('再点一次即重试（失败留有出口）', opened.length === 2);
    check('重试成功后回 ok 态', chip.getAttribute('data-dsfo-state') === 'ok');
  }
  //#endregion

  //#region ── 上报：分来源、带构建号、被节流的要补发 ───────────────
  {
    const r = await boot({
      text: path,
      checkItems: [{ asked: path, ok: true, kind: 'file', name: 'a.docx', size: 1, ext: '.docx', path }]
    });
    const reports = r.xhr.pending.filter((entry) => entry.xhr.url === '/dsh-file-opener/report');
    check('节流窗口内的扫描上报被**补发**了，没有丢读数（坑 #8 同族）', reports.length >= 2);

    const first = JSON.parse(reports[0].body);
    check('第一次上报是能力探测', first.reason === 'capability');
    check('上报里带 source=client（分来源分槽，坑 #39）', first.source === 'client');
    check('上报里带构建号', first.build === r.client.__internals.BUILD);

    const last = JSON.parse(reports[reports.length - 1].body);
    check('补发的那次报的是扫描完成（不是被吞掉）', last.reason === 'scan');
    check('补发的上报带真实扫描统计', last.stats.scans >= 1);
    check('补发的上报带候选路径数', last.stats.candidates >= 1);
    check('补发的上报带出条数', last.stats.decorated >= 1);
  }
  //#endregion
}
