/**
 * 极小 DOM 替身（仅供 Node 单测使用，不是 jsdom 的替代品）。
 *
 * 只实现卡片渲染真正用到的那几个接口：createElement / createElementNS /
 * createTextNode，以及元素上的 appendChild / replaceChildren / setAttribute /
 * addEventListener / style / dataset / textContent / childNodes / 属性赋值。
 * 目的是在 Node 里断言"卡片 DOM 真的长出来了、按钮真的在、错误态真的变红"，
 * 而不是等到浏览器里才发现问题。
 *
 * 被 __internals.renderFamilyInto 使用（见 client.js 导出）。
 */

class FakeNode {
  constructor(tagName, ns = null) {
    this.tagName = String(tagName).toUpperCase();
    this.namespaceURI = ns;
    this.childNodes = [];
    this.attributes = new Map();
    this.style = { display: '' };
    this.dataset = {};
    this.listeners = new Map();
    this._textContent = null;
    this.parentNode = null;
    this.isConnected = true;
  }

  get children() {
    return this.childNodes.filter((n) => n instanceof FakeNode);
  }

  appendChild(child) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  replaceChildren(...nodes) {
    this.childNodes = [];
    for (const node of nodes.flat()) {
      if (node === null || node === undefined) continue;
      this.appendChild(node);
    }
  }

  remove() {
    if (this.parentNode !== null) {
      const at = this.parentNode.childNodes.indexOf(this);
      if (at >= 0) this.parentNode.childNodes.splice(at, 1);
    }
    this.isConnected = false;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    // 真实 DOM 里 class 是 className 属性；这里同步一份，方便断言
    if (name === 'class') this.className = String(value);
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = String(value);
    }
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  /** 测试用：手动触发一次事件，验证点击处理器真的接上了。 */
  dispatchEvent(type, event = {}) {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  get textContent() {
    if (this._textContent !== null) return this._textContent;
    return this.childNodes.map((n) => (n instanceof FakeNode ? n.textContent : String(n.data ?? ''))).join('');
  }

  set textContent(value) {
    this._textContent = String(value);
    this.childNodes = [];
  }

  /** 测试用：按 class / tag / [data-attr] 找后代（只支持这三种形式）。 */
  matches(selector) {
    const s = String(selector).trim();
    if (s.startsWith('.')) return String(this.className ?? '').split(/\s+/).includes(s.slice(1));
    if (s.startsWith('[')) {
      const name = s.slice(1, -1).replace(/=.*$/, '').trim();
      return this.attributes.has(name);
    }
    return this.tagName === s.toUpperCase();
  }

  querySelector(selector) {
    for (const node of this.childNodes) {
      if (!(node instanceof FakeNode)) continue;
      if (node.matches(selector)) return node;
      const deep = node.querySelector(selector);
      if (deep !== null) return deep;
    }
    return null;
  }

  querySelectorAll(selector) {
    const out = [];
    for (const node of this.childNodes) {
      if (!(node instanceof FakeNode)) continue;
      if (node.matches(selector)) out.push(node);
      out.push(...node.querySelectorAll(selector));
    }
    return out;
  }
}

class FakeText {
  constructor(data) {
    this.data = String(data);
    this.nodeType = 3;
    this.parentNode = null;
  }
  get textContent() { return this.data; }
}

/** 造一个最小 document。 */
export function createFakeDocument() {
  return {
    createElement: (tag) => new FakeNode(tag),
    createElementNS: (ns, tag) => new FakeNode(tag, ns),
    createTextNode: (text) => new FakeText(text),
    /** 测试里没有真实 head，样式注入直接丢弃 */
    head: new FakeNode('head'),
    querySelector: () => null
  };
}

export { FakeNode, FakeText };
