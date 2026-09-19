/**
 * 测试骨架：断言助手 + 假宿主 ctx + 最小 DOM 替身。
 *
 * 三条纪律（dsh-plugin-dev 技能 §四）：
 *  1. 假 `ctx.webServer.register` **必须复刻真实行为** —— 重复 (kind,path) 就抛，
 *     这样"路由表能不能装配起来"在不重启服务的前提下就能验证（坑 #37）。
 *  2. 假 `res` 必须是**真正的 Writable 流**，且 `writeHead` 要走 Node 的响应头校验
 *     （`validateHeaderValue`）—— 否则非法响应头在测试里完全不可见（坑 #58）。
 *  3. 假 `req` 要带 `Symbol.asyncIterator`，因为宿主用 `for await` 读体。
 */

import { Writable } from 'node:stream';
import { validateHeaderValue } from 'node:http';
import { finished } from 'node:stream/promises';

//#region ── 断言助手 ────────────────────────────────────────────────────

let passed = 0;
const failures = [];

/**
 * @param {string} label
 * @param {boolean} condition
 */
export function check(label, condition) {
  if (condition) {
    passed += 1;
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}

export function summary() {
  console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`);
  if (failures.length > 0) {
    console.log('失败清单：');
    for (const f of failures) console.log(`  - ${f}`);
  }
  return failures.length === 0;
}

export function resetCounters() {
  passed = 0;
  failures.length = 0;
}

//#endregion

//#region ── 假宿主 ──────────────────────────────────────────────────────

/**
 * 造一个假 ctx。`register` 复刻真实行为：重复键直接抛。
 * @param {{services?: Record<string, unknown>}} [options]
 */
export function makeCtx(options = {}) {
  const routes = new Map();
  const disposers = [];
  const services = options.services ?? {};
  const logs = [];

  const ctx = {
    logger: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m])
    },
    webServer: {
      register(route) {
        const key = `${route.kind} ${route.path}`;
        if (routes.has(key)) {
          throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
        }
        routes.set(key, route.handler);
        return () => {
          routes.delete(key);
        };
      }
    },
    get(name) {
      return services[name];
    },
    effect(fn) {
      const dispose = fn();
      disposers.push(dispose);
      return () => {};
    }
  };

  return { ctx, routes, disposers, logs };
}

/** 假 res：真 Writable + 走真实响应头校验。 */
export function makeRes() {
  const chunks = [];
  const res = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    }
  });
  res.statusCode = 0;
  res.headers = {};
  res.writeHead = function (status, headers) {
    this.statusCode = status;
    this.headers = headers || {};
    for (const [name, value] of Object.entries(this.headers)) {
      validateHeaderValue(name, value); // 坑 #58：非法响应头必须在这里就炸
    }
    return this;
  };
  res.text = () => Buffer.concat(chunks).toString('utf8');
  res.json = () => JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return res;
}

/** 假 req：带异步迭代器。 */
export function makeReq({ method = 'GET', body = '' } = {}) {
  const payload = Buffer.from(body, 'utf8');
  return {
    method,
    [Symbol.asyncIterator]: async function* () {
      if (payload.length > 0) yield payload;
    }
  };
}

/**
 * 发一次请求到假路由表，等响应真正写完。
 * @param {Map<string, Function>} routes
 * @param {string} path
 * @param {{method?: string, body?: string}} [options]
 */
export async function call(routes, path, options = {}) {
  const handler = routes.get(`exact ${path}`);
  if (handler === undefined) throw new Error(`no route for ${path}`);
  const res = makeRes();
  const req = makeReq(options);
  await handler(req, res);
  await finished(res).catch(() => {});
  let parsed = null;
  try {
    parsed = res.json();
  } catch {
    parsed = null;
  }
  return { status: res.statusCode, headers: res.headers, text: res.text(), body: parsed };
}

//#endregion

//#region ── 最小 DOM 替身 ───────────────────────────────────────────────

/**
 * 选择器匹配：只支持本项目真正用到的那几种形态
 * （标签名、.class、[attr]、[attr="value"]，以及逗号分隔的标签名列表）。
 */
function matches(el, selector) {
  const sel = selector.trim();

  let m = /^([a-zA-Z][\w-]*)$/.exec(sel);
  if (m !== null) return el.tagName === m[1].toLowerCase();

  m = /^\.([\w-]+)$/.exec(sel);
  if (m !== null) return String(el.className || '').split(/\s+/).includes(m[1]);

  m = /^\[([\w-]+)\]$/.exec(sel);
  if (m !== null) return el.attrs.has(m[1]);

  m = /^\[([\w-]+)="([^"]*)"\]$/.exec(sel);
  if (m !== null) return el.attrs.get(m[1]) === m[2];

  return false;
}

function matchesAny(el, selector) {
  return selector.split(',').some((part) => matches(el, part));
}

class FakeElement {
  constructor(tagName, doc) {
    this.tagName = String(tagName).toLowerCase();
    this.ownerDocument = doc;
    this.attrs = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = new Map();
    this._text = '';
    this.className = '';
    this._ns = null;
  }

  get nodeType() { return 1; }

  setAttribute(name, value) {
    this.attrs.set(String(name), String(value));
    if (name === 'class') this.className = String(value);
  }

  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }

  hasAttribute(name) { return this.attrs.has(name); }

  appendChild(node) {
    if (node.parentNode && typeof node.parentNode.removeChild === 'function') {
      node.parentNode.removeChild(node);
    }
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  insertBefore(node, reference) {
    if (node.parentNode && typeof node.parentNode.removeChild === 'function') {
      node.parentNode.removeChild(node);
    }
    node.parentNode = this;
    const index = reference === null || reference === undefined
      ? this.childNodes.length
      : this.childNodes.indexOf(reference);
    this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, node);
    return node;
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  get nextSibling() {
    if (this.parentNode === null) return null;
    const siblings = this.parentNode.childNodes;
    const index = siblings.indexOf(this);
    return index >= 0 && index + 1 < siblings.length ? siblings[index + 1] : null;
  }

  get firstChild() { return this.childNodes[0] ?? null; }

  get textContent() {
    if (this.childNodes.length === 0) return this._text;
    return this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this.childNodes = [];
    this._text = String(value);
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  /** 测试用：模拟点击。 */
  fire(type, event) {
    const handlers = this.listeners.get(type) ?? [];
    for (const handler of handlers) handler(event ?? { stopPropagation() {} });
    return handlers.length;
  }

  closest(selector) {
    let node = this;
    while (node && node.nodeType === 1) {
      if (matchesAny(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType !== 1) continue;
        if (matchesAny(child, selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

/**
 * 造一个最小文档。支持本项目 client.js 用到的全部 API。
 */
export function makeDom() {
  const documentElement = new FakeElement('html', null);
  const head = new FakeElement('head', null);
  const body = new FakeElement('body', null);
  documentElement.appendChild(head);
  documentElement.appendChild(body);

  const document = {
    documentElement,
    head,
    body,
    createElement(tag) { return new FakeElement(tag, document); },
    createElementNS(ns, tag) {
      const node = new FakeElement(tag, document);
      node._ns = ns;
      return node;
    },
    getElementById(id) {
      const found = documentElement.querySelectorAll(`[id="${id}"]`);
      return found[0] ?? null;
    },
    querySelector(selector) {
      if (matchesAny(documentElement, selector)) return documentElement;
      return documentElement.querySelector(selector);
    },
    querySelectorAll(selector) { return documentElement.querySelectorAll(selector); }
  };
  head.ownerDocument = document;
  body.ownerDocument = document;

  /** 简易 el() 帮助函数，测试里造 DOM 用。 */
  const el = (tag, attrs, text) => {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'className') node.className = v;
        else node.setAttribute(k, v);
      }
    }
    if (text !== undefined) node.textContent = text;
    return node;
  };

  return { document, documentElement, head, body, el };
}

/**
 * 假 XHR：请求进入队列，由测试用 `respond` 决定结果。
 */
export function makeXhr() {
  const pending = [];
  class FakeXhr {
    constructor() {
      this.method = null;
      this.url = null;
      this.timeout = 0;
      this.status = 0;
      this.responseText = '';
      this.onload = null;
      this.onerror = null;
      this.ontimeout = null;
      this.headers = {};
    }

    open(method, url) {
      this.method = method;
      this.url = url;
    }

    setRequestHeader(name, value) { this.headers[name] = value; }

    send(body) {
      pending.push({ xhr: this, body: body === undefined ? '' : String(body) });
    }
  }
  return {
    FakeXhr,
    pending,
    /** 让最早的一个待处理请求成功返回。 */
    respond(status, jsonBody) {
      const entry = pending.shift();
      if (entry === undefined) throw new Error('没有待处理的 XHR');
      entry.xhr.status = status;
      entry.xhr.responseText = typeof jsonBody === 'string' ? jsonBody : JSON.stringify(jsonBody);
      entry.xhr.onload?.();
      return entry;
    },
    /**
     * 按 URL 精确应答。
     * 必须能指定 URL —— 客户端会同时发出 /report 与 /check 两类请求，
     * 按"最早"应答会把结果发给错的那一个（这本身就是一个真实的测试陷阱）。
     */
    respondTo(url, status, jsonBody) {
      const index = pending.findIndex((entry) => entry.xhr.url === url);
      if (index < 0) throw new Error(`没有发往 ${url} 的待处理 XHR`);
      const [entry] = pending.splice(index, 1);
      entry.xhr.status = status;
      entry.xhr.responseText = typeof jsonBody === 'string' ? jsonBody : JSON.stringify(jsonBody);
      entry.xhr.onload?.();
      return entry;
    },
    /** 让最早的一个待处理请求失败（网络错误 / 超时）。 */
    fail(kind = 'error') {
      const entry = pending.shift();
      if (entry === undefined) throw new Error('没有待处理的 XHR');
      if (kind === 'timeout') entry.xhr.ontimeout?.();
      else entry.xhr.onerror?.();
      return entry;
    },
    /** 按 URL 让请求失败。 */
    failTo(url, kind = 'error') {
      const index = pending.findIndex((entry) => entry.xhr.url === url);
      if (index < 0) throw new Error(`没有发往 ${url} 的待处理 XHR`);
      const [entry] = pending.splice(index, 1);
      if (kind === 'timeout') entry.xhr.ontimeout?.();
      else entry.xhr.onerror?.();
      return entry;
    },
    /** 某个 URL 是否还有待处理请求。 */
    hasPending(url) {
      return pending.some((entry) => entry.xhr.url === url);
    }
  };
}

/** 假 MutationObserver：只记录回调，测试自己触发。 */
export function makeObserver() {
  const instances = [];
  class FakeObserver {
    constructor(callback) {
      this.callback = callback;
      this.observed = null;
      instances.push(this);
    }
    observe(target, options) { this.observed = { target, options }; }
    disconnect() { this.observed = null; }
  }
  return { FakeObserver, instances };
}

//#endregion
