/**
 * 浏览器半的纯函数测试：把 client.js 当成一个只在 window 上注册工厂的脚本加载，
 * 取出 __internals 后只测不依赖 DOM 的部分（路径识别、大小格式化）。
 *
 * 为什么这样加载：client.js 是为浏览器写的 IIFE，靠 `window.__ModuleLoader__.load`
 * 注册工厂。这里用一个最小的 window 桩接住它，就能在 Node 里直接跑被测函数，
 * 不必拉 jsdom —— 被测函数本身是纯字符串处理。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'client.js'), 'utf8');

/** 在函数作用域里跑一遍源码，返回注册好的插件工厂产物。 */
function loadClientInternals() {
  const loaded = [];
  const windowStub = {
    __ModuleLoader__: { load: (bundle) => loaded.push(bundle) },
    addEventListener() {},
    removeEventListener() {}
  };
  // 用 Function 构造器隔离作用域，只把 window 桩塞进去。
  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'document', 'NodeFilter', 'MutationObserver', source);
  run(windowStub, undefined, { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 }, function () {});
  assert.equal(loaded.length, 1, 'client.js 应当注册恰好一个模块');
  const bundle = loaded[0];
  assert.equal(bundle.id, 'dsh-media-preview');
  const exports = bundle.factory(() => { throw new Error('require 不应在加载期被调用'); });
  return exports.__internals;
}

const internals = loadClientInternals();

test('extractCandidates: 认出 Windows 绝对路径与 http 直链', () => {
  const sentence = '已生成 D:\\DSH\\DH2\\实验区\\out\\cover.png 和 https://cdn.example.com/a/b.mp4 两张。';
  const found = internals.extractCandidates(sentence);
  assert.deepEqual(found.map((c) => c.text).sort(), [
    'D:\\DSH\\DH2\\实验区\\out\\cover.png',
    'https://cdn.example.com/a/b.mp4'
  ]);
  assert.equal(found.find((c) => c.text.startsWith('http')).remote, 'remote');
  assert.equal(found.find((c) => c.text.startsWith('D:')).remote, 'local');
  assert.equal(found.find((c) => c.text.startsWith('D:')).kind, 'image');
  assert.equal(found.find((c) => c.text.startsWith('http')).kind, 'video');
});

test('extractCandidates: file:// 直链被识别为需要过宿主通道的候选', () => {
  const found = internals.extractCandidates('产物：file:///D:/out/movie.mp4 请查收');
  assert.equal(found.length, 1);
  assert.equal(found[0].remote, 'fileurl');
  assert.equal(found[0].kind, 'video');
  assert.equal(internals.fileUrlToPath('file:///D:/out/movie.mp4'), 'D:/out/movie.mp4');
  assert.equal(internals.fileUrlToPath('file:///home/u/%E5%9B%BE.png'), '/home/u/图.png');
});

test('extractCandidates: 正斜杠路径与 POSIX 路径同样识别', () => {
  const found = internals.extractCandidates('两个：D:/tmp/a.webp 与 /var/tmp/b.mp3');
  assert.deepEqual(found.map((c) => c.text), ['D:/tmp/a.webp', '/var/tmp/b.mp3']);
  assert.deepEqual(found.map((c) => c.kind), ['image', 'audio']);
});

test('extractCandidates: 剥掉句尾标点', () => {
  const found = internals.extractCandidates('看这个 /tmp/x/voice.mp3。');
  assert.deepEqual(found.map((c) => c.text), ['/tmp/x/voice.mp3']);
  const found2 = internals.extractCandidates('见（/tmp/x/pic.png）');
  assert.deepEqual(found2.map((c) => c.text), ['/tmp/x/pic.png']);
});

test('extractCandidates: 非媒体扩展名不认', () => {
  assert.deepEqual(internals.extractCandidates('D:\\a\\b.txt 与 D:\\a\\c.zip'), []);
  assert.deepEqual(internals.extractCandidates('没有路径，只有一段话。'), []);
});

test('extractCandidates: 相对路径不作为本地候选（宿主只收绝对路径）', () => {
  // 行首的相对路径：正则即便从 "out" 之后咬出 "/a.png"，前置字符检查也会把它丢掉。
  // 已知边界：若整段就是 "out/a.png"（斜杠恰好在字符 0），仍会被当成 POSIX 绝对路径 ——
  // 这种歧义无法从文本本身消解，交给宿主按允许根拒绝即可（见 host-routes 的 403 用例）。
  assert.deepEqual(internals.extractCandidates('看 out/a.png 这个产物'), []);
  assert.deepEqual(internals.extractCandidates('见文件夹 assets/cover.png'), []);
});

test('extractCandidates: 同一路径不重复出卡', () => {
  const found = internals.extractCandidates('/tmp/a.png /tmp/a.png');
  assert.equal(found.length, 1);
});

test('extractCandidates: 中文目录名与空格路径可用', () => {
  const found = internals.extractCandidates('产物在 D:\\我的 项目\\输出 目录\\封面 图.png 里');
  // 空格会把路径切断，这是刻意的保守策略：宁可少认，不可把整段话吞进来
  assert.equal(found.length, 0);
  const found2 = internals.extractCandidates('产物在 D:\\我的项目\\输出目录\\封面图.png 里');
  assert.deepEqual(found2.map((c) => c.text), ['D:\\我的项目\\输出目录\\封面图.png']);
});

test('isPathOnlyText: 判断"整段只有路径"', () => {
  assert.equal(internals.isPathOnlyText('/tmp/a.png'), true);
  assert.equal(internals.isPathOnlyText('看这个 /tmp/a.png'), false);
});

test('humanSize: 单位换算', () => {
  assert.equal(internals.humanSize(512), '512 B');
  assert.equal(internals.humanSize(2048), '2.0 KB');
  assert.equal(internals.humanSize(3 * 1048576), '3.00 MB');
  assert.equal(internals.humanSize(Number.NaN), '');
});

test('kindOfPath: 扩展名 → 粗判类型', () => {
  assert.equal(internals.kindOfPath('a.PNG'), 'image');
  assert.equal(internals.kindOfPath('a.MP4'), 'video');
  assert.equal(internals.kindOfPath('a.flac'), 'audio');
  assert.equal(internals.kindOfPath('a.txt'), null);
});
