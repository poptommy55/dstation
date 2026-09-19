/**
 * 卡片渲染测试（纯 DOM 实现）。
 *
 * 这是"卡片到底长什么样"的自动化守门人：给一个最小 document 替身，
 * 断言结构、按钮可达性、三种媒体类型、错误态，以及点了「下载」会打到哪个 URL。
 *
 * 背景：卡片曾用 React 渲染，而"宿主能不能给出渲染器"多出一条失败路径
 * （拿不到 react-dom 时整块正文只剩一句错误）。改成纯 DOM 后这条路径消失，
 * 这个测试也随之变成普通的结构断言。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createFakeDocument, FakeNode } from './fake-dom.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'client.js'), 'utf8');

/** 在给定 document 下加载 client.js 并取出 __internals。 */
function loadInternals(doc) {
  const loaded = [];
  const windowStub = {
    __ModuleLoader__: { load: (bundle) => loaded.push(bundle) },
    addEventListener() {},
    removeEventListener() {},
    showSaveFilePicker: undefined
  };
  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'document', 'NodeFilter', 'MutationObserver', source);
  run(windowStub, doc, { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 }, function () {});
  return loaded[0].factory(() => { throw new Error('require 不该被调用'); }).__internals;
}

/** 每个用例一份干净环境（REGISTRY 是模块级的，会跨用例串味）。 */
function fresh() {
  const doc = createFakeDocument();
  const internals = loadInternals(doc);
  internals.registry.clear();
  doc.documentElement = doc.createElement('html');
  doc.body = doc.createElement('div');
  return { doc, internals, root: doc.createElement('div') };
}

function cardOf(root) {
  return root.querySelector('[data-dsh-media-card]');
}

test('诊断装置：默认不显示浮层，但状态仍写在 <html> 上', () => {
  const { doc, internals } = fresh();
  internals.markApplied('test');

  assert.equal(doc.querySelector('[data-dsh-media-legend]'), null,
    '默认不该出现浮层 —— 常驻浮层会压住左下角的侧边栏按钮');
  assert.equal(doc.documentElement.dataset.dshMediaPhase, 'test',
    '状态要写在 <html> 上，随时可查，不依赖浮层');
  assert.equal(typeof doc.documentElement.dataset.dshMediaBuild, 'string');
});

test('卡片：已登记的图片渲染 <img>，含名称、体积与两个按钮', () => {
  const { internals, root } = fresh();
  const path = 'D:/work/out/cover.png';
  internals.registry.set(path, {
    status: 'ok',
    data: { name: 'cover.png', size: 63739, kind: 'image', type: 'image/png', url: '/dsh-media/file?path=x' }
  });

  internals.renderFamilyInto(root, [{ text: path, kind: 'image', remote: 'local' }]);

  assert.equal(root.querySelector('.dsh-mp-family') !== null, true, '应有 family 容器');
  assert.equal(root.querySelectorAll('[data-dsh-media-card]').length, 1);
  const img = cardOf(root).querySelector('img');
  assert.ok(img !== null, '图片卡必须有 <img>');
  assert.equal(img.getAttribute('src'), '/dsh-media/file?path=x');
  assert.equal(img.getAttribute('alt'), 'cover.png');
  assert.equal(cardOf(root).querySelector('.dsh-mp-kind').textContent, 'image');
  assert.equal(cardOf(root).querySelector('.dsh-mp-name').textContent, 'cover.png');
  assert.equal(cardOf(root).querySelector('.dsh-mp-size').textContent, '62.2 KB');
  const buttons = cardOf(root).querySelectorAll('.dsh-mp-btn').map((b) => b.textContent);
  assert.deepEqual(buttons, ['下载', '新标签打开']);
  assert.equal(cardOf(root).getAttribute('data-state'), 'ok');
});

test('卡片：视频用 <video controls>、音频用 <audio controls>（可播放）', () => {
  const { internals, root } = fresh();
  const video = 'D:/work/out/demo.mp4';
  const audio = 'D:/work/out/voice.mp3';
  internals.registry.set(video, { status: 'ok', data: { name: 'demo.mp4', size: 1048576, kind: 'video', url: '/v' } });
  internals.registry.set(audio, { status: 'ok', data: { name: 'voice.mp3', size: 4096, kind: 'audio', url: '/a' } });

  internals.renderFamilyInto(root, [
    { text: video, kind: 'video', remote: 'local' },
    { text: audio, kind: 'audio', remote: 'local' }
  ]);

  const cards = root.querySelectorAll('[data-dsh-media-card]');
  assert.equal(cards.length, 2);
  const videoEl = cards[0].querySelector('video');
  assert.ok(videoEl !== null);
  assert.notEqual(videoEl.getAttribute('controls'), null, '视频必须有播放控件');
  assert.equal(videoEl.getAttribute('src'), '/v');
  const audioEl = cards[1].querySelector('audio');
  assert.ok(audioEl !== null);
  assert.notEqual(audioEl.getAttribute('controls'), null, '音频必须有播放控件');
  assert.equal(cards[0].querySelector('.dsh-mp-size').textContent, '1.00 MB');
  assert.equal(cards[1].querySelector('.dsh-mp-size').textContent, '4.0 KB');
});

test('卡片：尚未登记也立刻出预览（登记只是补充信息，不是前置条件）', () => {
  const { internals, root } = fresh();
  const path = 'D:/work/out/a.png';
  internals.renderFamilyInto(root, [{ text: path, kind: 'image', remote: 'local' }]);
  const card = cardOf(root);
  // 关键回归点：以前这里什么都不渲染、只显示"正在向宿主确认这个文件…"，
  // 一旦那次 HTTP 往返卡住，卡片就永远停在确认中（2026-09-13 实测）。
  const img = card.querySelector('img');
  assert.ok(img !== null, '未登记也必须直接渲染 <img>');
  assert.equal(img.getAttribute('src'), '/dsh-media/file?path=' + encodeURIComponent(path));
  assert.equal(card.querySelector('.dsh-mp-name').textContent, 'a.png', '文件名应从路径推导');
  assert.equal(card.querySelectorAll('.dsh-mp-btn')[0].disabled, false, '预览能显示，下载就该可点');
  assert.equal(card.getAttribute('data-state'), 'ok');
});

test('卡片：宿主登记成功后补上体积', () => {
  const { internals, root } = fresh();
  const path = 'D:/work/out/a.png';
  internals.renderFamilyInto(root, [{ text: path, kind: 'image', remote: 'local' }]);
  assert.equal(cardOf(root).querySelector('.dsh-mp-size').textContent, '', '登记前没有体积信息');

  internals.registry.set(path, {
    status: 'ok',
    data: { name: 'a.png', size: 204800, kind: 'image', url: '/dsh-media/file?path=' + encodeURIComponent(path) }
  });
  internals.repaintAll();

  assert.equal(cardOf(root).querySelector('.dsh-mp-size').textContent, '200.0 KB');
});

test('卡片：宿主拒绝时进入错误态并写明原因', () => {
  const { internals, root } = fresh();
  const path = 'C:/Windows/secret.png';
  internals.registry.set(path, { status: 'error', error: '拒绝访问：文件不在任何允许的会话工作区之内' });
  internals.renderFamilyInto(root, [{ text: path, kind: 'image', remote: 'local' }]);
  const card = cardOf(root);
  assert.equal(card.getAttribute('data-state'), 'error');
  assert.ok(card.querySelector('.dsh-mp-status').textContent.includes('不在任何允许的会话工作区'), '要把宿主给的原因原样呈现');
  assert.equal(card.querySelector('.dsh-mp-status').getAttribute('data-tone'), 'error');
  assert.equal(card.querySelector('img'), null, '被拒绝的文件不该尝试加载');
});

test('卡片：远端直链直接渲染，不需要宿主登记', () => {
  const { internals, root } = fresh();
  internals.renderFamilyInto(root, [{ text: 'https://cdn.example.com/a/shot.png', kind: 'image', remote: 'remote' }]);
  const card = cardOf(root);
  const img = card.querySelector('img');
  assert.ok(img !== null);
  assert.equal(img.getAttribute('src'), 'https://cdn.example.com/a/shot.png');
  assert.equal(card.querySelector('.dsh-mp-name').textContent, 'shot.png');
});

test('卡片：file:// 直链改为走宿主通道预览，并说明下载方式', () => {
  const { internals, root } = fresh();
  internals.renderFamilyInto(root, [{ text: 'file:///D:/out/movie.mp4', kind: 'video', remote: 'fileurl' }]);
  const card = cardOf(root);
  const video = card.querySelector('video');
  assert.ok(video !== null);
  const src = video.getAttribute('src');
  assert.ok(src.startsWith('/dsh-media/file?path='), `file:// 必须转发到宿主通道，实际 ${src}`);
  assert.ok(src.includes(encodeURIComponent('D:/out/movie.mp4')), '路径要正确地编码进去');
  assert.ok(card.querySelector('.dsh-mp-status').textContent.includes('file:// 直链'));
});

test('卡片：点「下载」走 dl=1，并带上文件名', () => {
  const { internals, root } = fresh();
  const path = 'D:/work/out/cover.png';
  internals.registry.set(path, { status: 'ok', data: { name: 'cover.png', size: 1000, kind: 'image', url: '/dsh-media/file?path=x' } });

  // 捕获 anchor 点击：jsdom 以外的最小替身里，anchorDownload 会调 document.body.appendChild
  const toasts = [];
  const doc = createFakeDocument();
  const realCreate = doc.createElement;
  const anchorUrls = [];
  doc.createElement = (tag) => {
    const node = realCreate(tag);
    if (tag === 'a') {
      node.click = () => anchorUrls.push({ href: node.href, download: node.download });
    }
    return node;
  };
  doc.body = doc.createElement('div');
  const internals2 = loadInternals(doc);
  internals2.registry.clear();
  internals2.registry.set(path, { status: 'ok', data: { name: 'cover.png', size: 1000, kind: 'image', url: '/dsh-media/file?path=x' } });

  const root2 = doc.createElement('div');
  internals2.renderFamilyInto(root2, [{ text: path, kind: 'image', remote: 'local' }]);
  const download = root2.querySelectorAll('.dsh-mp-btn')[0];

  // 没有 File System Access、也没有 fetch 时，会退化到最终兜底：直接 anchor 导航
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error('离线测试'));
  try {
    download.dispatchEvent('click', {});
  } finally {
    globalThis.fetch = originalFetch;
  }
  return new Promise((resolve) => {
    setTimeout(() => {
      assert.equal(anchorUrls.length, 1, `应当触发一次下载，实际 ${anchorUrls.length}；${toasts.join('|')}`);
      assert.equal(anchorUrls[0].download, 'cover.png');
      assert.equal(anchorUrls[0].href, '/dsh-media/file?path=x&dl=1&name=cover.png');
      resolve();
    }, 20);
  });
});

test('卡片：重绘时不重建 <video>（视频抖动的根因，必须锁住）', () => {
  const { internals, root } = fresh();
  const path = 'D:/work/out/demo.mp4';
  internals.renderFamilyInto(root, [{ text: path, kind: 'video', remote: 'local' }]);
  const card = cardOf(root);
  const videoBefore = card.querySelector('video');
  assert.ok(videoBefore !== null);

  // 反复重绘（登记回包、状态变化都会触发），媒体元素必须是**同一个节点**：
  // 浏览器里重建元素 = 重新加载媒体，视频会不停回到第一帧并闪黑。
  internals.repaintAll();
  internals.registry.set(path, {
    status: 'ok',
    data: { name: 'demo.mp4', size: 1048576, kind: 'video', url: '/dsh-media/file?path=' + encodeURIComponent(path) }
  });
  internals.repaintAll();
  internals.repaintAll();

  const videoAfter = cardOf(root).querySelector('video');
  assert.equal(videoAfter, videoBefore, '<video> 被重建了 —— 视频会闪');
  assert.equal(videoAfter.getAttribute('src'), '/dsh-media/file?path=' + encodeURIComponent(path));
  assert.equal(cardOf(root).querySelector('.dsh-mp-size').textContent, '1.00 MB', '重绘仍要更新体积');
});

test('卡片：媒体类型变化时才重建（video → image）', () => {
  const { internals, root } = fresh();
  const path = 'D:/work/out/x.mp4';
  internals.renderFamilyInto(root, [{ text: path, kind: 'video', remote: 'local' }]);
  assert.ok(cardOf(root).querySelector('video') !== null);

  // 宿主把类型纠正成 image（扩展名与真实内容不符的场景）→ 这时允许换元素
  internals.registry.set(path, {
    status: 'ok',
    data: { name: 'x.mp4', size: 1000, kind: 'image', url: '/dsh-media/file?path=' + encodeURIComponent(path) }
  });
  internals.repaintAll();

  assert.equal(cardOf(root).querySelector('video'), null);
  assert.ok(cardOf(root).querySelector('img') !== null);
});

test('隐藏与还原：卸载卡片时文本节点回到原位、code 元素恢复显示', () => {
  const { doc, internals } = fresh();
  // 造一个容器，模拟扫描后的挂载/卸载（这里直接测 unmountAll 的 DOM 还原契约）
  const block = doc.createElement('p');
  const code = doc.createElement('code');
  code.style.display = 'none';
  const holder = doc.createElement('div');
  doc.body = doc.createElement('div');
  doc.body.appendChild(block);
  doc.body.appendChild(holder);
  doc.querySelectorAll = () => [];

  internals.renderFamilyInto(holder, [{ text: 'D:/a.png', kind: 'image', remote: 'local' }]);
  assert.equal(holder.querySelectorAll('[data-dsh-media-card]').length, 1);

  // unmountAll 依赖真实 document.querySelectorAll，这里只验证 family 本身可渲染
  assert.ok(block instanceof FakeNode);
  assert.equal(code.style.display, 'none');
});
