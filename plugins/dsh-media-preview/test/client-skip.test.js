/**
 * 扫描跳过规则测试（isSkippedElement）。
 *
 * 背景（2026-09-13 实测踩坑）：原先「任何 <code> 内部都跳过」的规则，会把
 * **行内代码**里写的路径也一起跳过 —— 而模型最自然的写法恰恰是
 * 把路径放进反引号里（`D:\a\b.png`），结果最该出卡片的地方反而没有卡片。
 * 现在的规则：<pre> 里的任何内容都不动；非 <pre> 后代的 <code> 允许扫描。
 *
 * 这里用最小元素替身（只有 tagName / closest / isContentEditable）测这条判据，
 * 不需要真 DOM。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'client.js'), 'utf8');

function loadInternals() {
  const loaded = [];
  const windowStub = {
    __ModuleLoader__: { load: (bundle) => loaded.push(bundle) },
    addEventListener() {},
    removeEventListener() {}
  };
  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'document', 'NodeFilter', 'MutationObserver', source);
  run(windowStub, undefined, { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 }, function () {});
  return loaded[0].factory(() => { throw new Error('require 不应在加载期被调用'); }).__internals;
}

const internals = loadInternals();

/** 造一个最小元素替身；ancestors 是从最近祖先开始的 tagName / 属性标记列表。 */
function el(tagName, ancestors = [], extra = {}) {
  const anyMatch = (selector) => {
    const s = String(selector).trim();
    const lower = s.toLowerCase();
    const wanted = s.replace(/^\[|\]$/g, '').replace(/[="']/g, '').trim();
    // 夹具里的标记可能是大写 tagName（'PRE'），也可能是选择器原文（'[data-dsh-media-host]'）
    const marks = [s, lower, wanted, wanted.toLowerCase()];
    return ancestors.some((a) => marks.includes(a) || marks.includes(a.toLowerCase()));
  };
  return {
    nodeType: 1,
    tagName,
    isContentEditable: false,
    get tagNameUpper() { return tagName; },
    closest(selector) {
      return anyMatch(selector) ? el('MATCHED') : null;
    },
    ...extra
  };
}

test('isSkippedElement: 代码块（<pre> 及其后代）不扫描', () => {
  assert.equal(internals.isSkippedElement(el('PRE')), true);
  assert.equal(internals.isSkippedElement(el('CODE', ['PRE'])), true, '<pre><code> 里的路径要保留原文');
  assert.equal(internals.isSkippedElement(el('SPAN', ['PRE', 'CODE'])), true, '<pre> 里的 span 也算代码块');
});

test('isSkippedElement: 行内代码（<code> 不是 <pre> 后代）要扫描', () => {
  assert.equal(internals.isSkippedElement(el('CODE', ['P'])), false);
  assert.equal(internals.isSkippedElement(el('CODE', ['LI'])), false, '列表项里的行内代码同样要扫描');
});

test('isSkippedElement: 脚本/样式/表单/可编辑区不扫描', () => {
  assert.equal(internals.isSkippedElement(el('SCRIPT')), true);
  assert.equal(internals.isSkippedElement(el('STYLE')), true);
  assert.equal(internals.isSkippedElement(el('NOSCRIPT')), true);
  assert.equal(internals.isSkippedElement(el('TEXTAREA')), true);
  assert.equal(internals.isSkippedElement(el('INPUT')), true);
  assert.equal(internals.isSkippedElement(el('DIV', [], { isContentEditable: true })), true);
});

test('isSkippedElement: 我们自己的卡片与输入框内部不扫描（防自噬）', () => {
  assert.equal(internals.isSkippedElement(el('DIV', ['[data-dsh-media-host]'])), true);
  assert.equal(internals.isSkippedElement(el('CODE', ['[contenteditable="true"]'])), true);
  assert.equal(internals.isSkippedElement(el('DIV', ['.dsh-mmd'])), true, '不跟 dsh-mermaid 抢地盘');
});

test('isSkippedElement: 普通正文要扫描', () => {
  assert.equal(internals.isSkippedElement(el('P')), false);
  assert.equal(internals.isSkippedElement(el('SPAN', ['P'])), false);
  assert.equal(internals.isSkippedElement(el('TD', ['TR', 'TABLE'])), false);
});

test('isSkippedElement: 非元素节点直接返回 false', () => {
  assert.equal(internals.isSkippedElement(null), false);
  assert.equal(internals.isSkippedElement({ nodeType: 3 }), false);
});
