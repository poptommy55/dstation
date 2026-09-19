/**
 * Ollama HTTP 客户端。
 *
 * 全部照**实测报文**实现（2026-09-14 在本机 Ollama 0.30.10 上抓的真实响应），
 * 不是照文档记忆写的：
 *
 *   GET  /api/version   → {"version":"0.30.10"}
 *   GET  /api/tags      → {"models":[{name, model, modified_at, size, digest,
 *                                     details:{context_length, parameter_size,
 *                                              quantization_level, family, format},
 *                                     capabilities:[...]}]}
 *   POST /api/show      → {capabilities:["tools","thinking","completion"],
 *                          parameters:"temperature 1\ntop_p 0.95", template:"..."}
 *   POST /api/chat      → NDJSON，每行：
 *        {"model","created_at","message":{"role":"assistant",
 *                                         "content":"…","thinking":"…"},
 *         "done":false}
 *        末行额外带 {"done":true,"done_reason":"stop",
 *                    "prompt_eval_count":13,"eval_count":32,
 *                    "load_duration":…,"eval_duration":…}
 *
 * 关键收益（相对自己内嵌推理）：**`thinking` 与 `content` 是分离的两个字段**，
 * 不需要解析 `<think>` 标记；且有精确的 token 用量与 done_reason。
 */

import http from 'node:http';
import { URL } from 'node:url';

/** 把 baseUrl 归一成 {hostname, port, basePath}，避免 URL 拼接出错。 */
function parseBase(baseUrl) {
  let u;
  try { u = new URL(baseUrl); } catch { throw new Error(`Ollama 地址不是合法 URL：${baseUrl}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`Ollama 地址必须是 http/https：${baseUrl}`);
  return { hostname: u.hostname, port: u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80), basePath: u.pathname.replace(/\/$/, '') };
}

/** 发一个普通 HTTP 请求，返回解析后的 JSON（或抛可读错误）。 */
function requestJson(baseUrl, method, path, body, timeoutMs = 30000) {
  const { hostname, port, basePath } = parseBase(baseUrl);
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        hostname, port, method, path: `${basePath}${path}`,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
      },
      (res) => {
        const parts = [];
        res.on('data', (c) => parts.push(c));
        res.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8');
          if (res.statusCode !== 200) {
            reject(new Error(`Ollama ${path} 返回 HTTP ${res.statusCode}：${text.slice(0, 300)}`));
            return;
          }
          try { resolve(JSON.parse(text)); }
          catch { reject(new Error(`Ollama ${path} 返回的不是 JSON：${text.slice(0, 200)}`)); }
        });
        res.on('error', reject);
      },
    );
    req.on('error', (error) => {
      reject(new Error(`连接 Ollama（${baseUrl}）失败：${error.message}。请确认 Ollama 已启动。`));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`Ollama ${path} 超时（${timeoutMs}ms）`)); });
    if (payload) req.write(payload);
    req.end();
  });
}

/** 读版本；同时充当连通性探测。 */
export async function getVersion(baseUrl) {
  const r = await requestJson(baseUrl, 'GET', '/api/version', undefined, 8000);
  return r?.version ?? 'unknown';
}

/** 列出本地已安装模型（原始结构）。 */
export async function listTags(baseUrl) {
  const r = await requestJson(baseUrl, 'GET', '/api/tags', undefined, 15000);
  return Array.isArray(r?.models) ? r.models : [];
}

/** 取单个模型的详情（capabilities 比 /api/tags 更准，详见文件头说明）。 */
export async function showModel(baseUrl, model) {
  return requestJson(baseUrl, 'POST', '/api/show', { model }, 20000);
}

/** 当前已加载进显存的模型（ollama ps 的接口形态）。 */
export async function listRunning(baseUrl) {
  const r = await requestJson(baseUrl, 'GET', '/api/ps', undefined, 10000);
  return Array.isArray(r?.models) ? r.models : [];
}

/**
 * 流式对话。
 *
 * @param baseUrl - Ollama 地址
 * @param body - /api/chat 请求体
 * @param handlers.onThinking - (delta) => void   思考增量（独立字段）
 * @param handlers.onContent  - (delta) => void   正文增量
 * @param handlers.signal     - AbortSignal
 * @returns {content, thinking, toolCalls, usage, doneReason, metrics}
 */
export function chatStream(baseUrl, body, handlers = {}) {
  const { hostname, port, basePath } = parseBase(baseUrl);
  const payload = Buffer.from(JSON.stringify({ ...body, stream: true }), 'utf8');

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname, port, method: 'POST', path: `${basePath}/api/chat`,
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      },
      (res) => {
        if (res.statusCode !== 200) {
          const parts = [];
          res.on('data', (c) => parts.push(c));
          res.on('end', () => reject(new Error(`Ollama /api/chat 返回 HTTP ${res.statusCode}：${Buffer.concat(parts).toString('utf8').slice(0, 300)}`)));
          return;
        }

        let buffer = '';
        let content = '';
        let thinking = '';
        const toolCalls = [];
        let usage = null;
        let doneReason = null;
        let metrics = null;

        res.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          for (;;) {
            const nl = buffer.indexOf('\n');
            if (nl < 0) break;
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            let ev;
            try { ev = JSON.parse(line); } catch { continue; }

            const msg = ev.message;
            if (msg) {
              // 思考与正文是两个独立字段 —— 直接分流，无需解析标记
              if (typeof msg.thinking === 'string' && msg.thinking.length > 0) {
                thinking += msg.thinking;
                handlers.onThinking?.(msg.thinking);
              }
              if (typeof msg.content === 'string' && msg.content.length > 0) {
                content += msg.content;
                handlers.onContent?.(msg.content);
              }
              if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                for (const tc of msg.tool_calls) toolCalls.push(tc);
              }
            }

            if (ev.done) {
              doneReason = ev.done_reason ?? null;
              usage = {
                inputTokens: typeof ev.prompt_eval_count === 'number' ? ev.prompt_eval_count : 0,
                outputTokens: typeof ev.eval_count === 'number' ? ev.eval_count : 0,
              };
              metrics = {
                totalDurationMs: Math.round((ev.total_duration ?? 0) / 1e6),
                loadDurationMs: Math.round((ev.load_duration ?? 0) / 1e6),
                evalDurationMs: Math.round((ev.eval_duration ?? 0) / 1e6),
              };
            }
          }
        });

        res.on('end', () => resolve({ content, thinking, toolCalls, usage, doneReason, metrics }));
        res.on('error', reject);
        if (handlers.signal) {
          const abort = () => { try { res.destroy(); } catch { /* 忽略 */ } resolve({ content, thinking, toolCalls, usage, doneReason, metrics, aborted: true }); };
          if (handlers.signal.aborted) abort();
          else handlers.signal.addEventListener('abort', abort, { once: true });
        }
      },
    );

    req.on('error', (error) => reject(new Error(`连接 Ollama（${baseUrl}）失败：${error.message}。请确认 Ollama 已启动。`)));
    if (handlers.signal) {
      if (handlers.signal.aborted) { req.destroy(); reject(new Error('aborted')); return; }
      handlers.signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    }
    req.write(payload);
    req.end();
  });
}
