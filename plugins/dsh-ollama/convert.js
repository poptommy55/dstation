/**
 * 纯转换层：DSH 的消息/模型结构 ↔ Ollama 的报文结构。
 * 无副作用、无 I/O，可单测。
 *
 * DSH 的 Message.content 是**块数组**（text / reasoning / image / tool-call / tool-result），
 * 而 Ollama 的 /api/chat 只认 `{role, content}`（外加可选的 tool_calls / images）。
 * 这个错配必须在这一层拍平。
 */

/** 字节数 → 人类可读。 */
export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '未知大小';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 把 DSH 的块数组拍成纯文本（本插件只声明 text 模态，所以图片等会被略过）。 */
export function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'reasoning' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'tool-result') parts.push(blocksToText(block.content));
  }
  return parts.join('');
}

/** 工具调用的参数：DSH 存的是 JSON 字符串，Ollama 要的是对象。 */
function parseArguments(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

/**
 * 递归收集内容块里的图片块。
 * 必须递归：DSH 的图片既可以出现在消息顶层，也可以**嵌在 tool-result 的 content 里**
 * （工具返回的截图等），只扫顶层会漏。
 * @param blocks - ContentBlock[]
 * @returns ImageBlock[]
 */
export function collectImageBlocks(blocks) {
  const out = [];
  const walk = (list) => {
    for (const block of list) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'image' && block.attachment) out.push(block);
      else if (block.type === 'tool-result' && Array.isArray(block.content)) walk(block.content);
    }
  };
  walk(Array.isArray(blocks) ? blocks : []);
  return out;
}

/**
 * DSH Message[] → Ollama messages[]。
 *
 * 关键映射：
 *   · role='user' 且含 tool-result 块 ⇒ Ollama 的 role='tool'
 *     （DSH 把工具结果塞进 user 消息，Ollama 有自己的 tool 角色，混用会让模型困惑）
 *   · assistant 带 tool-call 块 ⇒ tool_calls 数组
 *   · 图片不在这里解析成字节（那是 I/O），只把 ImageBlock 挂到 `_images` 上，
 *     由调用方用 ctx.attachments 解析后写入 `images`（base64 数组）。
 */
export function toOllamaMessages(messages) {
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    const blocks = Array.isArray(message.content) ? message.content : [];
    const toolResults = blocks.filter((b) => b && b.type === 'tool-result');

    if (toolResults.length > 0) {
      for (const tr of toolResults) {
        const entry = { role: 'tool', content: blocksToText(tr.content) };
        const images = collectImageBlocks(tr.content);
        if (images.length > 0) entry._images = images;
        out.push(entry);
      }
      continue;
    }

    const text = blocksToText(blocks.filter((b) => b && b.type !== 'reasoning'));
    const images = collectImageBlocks(blocks);

    if (message.role === 'assistant') {
      const toolCalls = blocks.filter((b) => b && b.type === 'tool-call');
      const entry = { role: 'assistant', content: text };
      if (toolCalls.length > 0) {
        entry.tool_calls = toolCalls.map((tc) => ({ function: { name: tc.name, arguments: parseArguments(tc.arguments) } }));
      }
      out.push(entry);
      continue;
    }

    const entry = { role: message.role === 'system' ? 'system' : 'user', content: text };
    if (images.length > 0) entry._images = images;
    out.push(entry);
  }
  // 过滤空消息（Ollama 不接受），但保留有 tool_calls 或有图片的
  return out.filter((m) => (typeof m.content === 'string' && m.content.length > 0)
    || Array.isArray(m.tool_calls)
    || Array.isArray(m._images));
}

/**
 * /api/tags 的一个模型条目 → DSH 的 LlmModelInfo。
 * @param tag - /api/tags 的 models[] 元素
 * @param provider - 路由 id
 * @param options.vision - 是否标记为可接收图片（由 /api/show 的能力决定）
 */
export function describeModel(tag, provider, options = {}) {
  const details = tag?.details ?? {};
  const capabilityList = Array.isArray(tag?.capabilities) ? tag.capabilities : [];
  const bits = [];
  if (details.parameter_size) bits.push(details.parameter_size);
  if (details.quantization_level) bits.push(details.quantization_level);
  if (tag?.size) bits.push(formatBytes(tag.size));
  if (capabilityList.length > 0) bits.push(`能力：${capabilityList.join('/')}`);

  return {
    provider,
    id: tag?.name ?? tag?.model ?? '',
    name: tag?.name ?? tag?.model ?? '',
    description: bits.join(' · ') || undefined,
    // 有 vision 才声明 image：**少声明是安全方向**（图片会被提前拒绝），
    // 过度声明会让 DSH 把图片发过来、模型却忽略它（实测 gemma4 就是这种）。
    inputModalities: options.vision === true ? ['text', 'image'] : ['text'],
    // 以下为插件自用（DSH 会忽略未知字段）
    _capabilities: capabilityList,
    _vision: options.vision === true,
    _contextLength: typeof details.context_length === 'number' ? details.context_length : null,
    _sizeBytes: typeof tag?.size === 'number' ? tag.size : null,
    _family: details.family ?? null,
  };
}

/**
 * 该模型**实际**使用的上下文窗口。
 *
 * 这个值必须**同时**用于两处，否则会不一致：
 *   · 发给 Ollama 的 `options.num_ctx`（真正决定窗口与显存占用）
 *   · 申报给 DSH 的 `context.contextWindow`（DSH 的压缩/裁剪据此计算）
 *
 * 'auto' = min(模型原生窗口, ceiling)；原生未知时退化为 ceiling。
 * 依据（实测）：超过原生窗口时 Ollama 会自动夹取（要 262144 → 实给 131072），
 * **但它不会告诉我们夹了**，所以必须自己算准。
 *
 * ⚠️ 自适应是**按模型**，不是按对话长度：实测 num_ctx 每变一次就整模型重载一次
 * （2B 每次 ≈ 2.9~4.0 秒），按对话长度动态调只会反复重载、越调越慢。
 *
 * @param options.mode - 'auto' | 其它（视为 fixed）
 * @param options.ceiling - auto 模式的上限
 * @param options.fixed - fixed 模式使用的值
 * @param options.native - 模型自报的原生窗口（可能为 null/undefined）
 */
export function pickContextWindow({ mode, ceiling, fixed, native }) {
  if (mode !== 'auto') return fixed;
  const cap = typeof ceiling === 'number' && ceiling > 0 ? ceiling : 32768;
  if (typeof native !== 'number' || !Number.isFinite(native) || native <= 0) return cap;
  return Math.min(native, cap);
}

/**
 * 判断某模型是否应当接收图片。
 *
 * 规则（按用户要求：有 vision 的都加上）：
 *   · `visionMode='off'` ⇒ 一律不加；
 *   · 否则看 /api/show 报的 capabilities 是否含 `vision`；
 *   · 再减去 `visionExclude` 里列出的模型。
 *
 * ⚠️ 为什么要留 exclude —— 实测证据（2026-09-14，Ollama 0.30.10）：
 *   `gemma4:latest` 在 /api/show 里报告 `completion, vision, audio, tools, thinking`，
 *   tensors 里也有 661 个视觉投影权重（`mm.a.fc.weight` 等），
 *   **但同一张图实测它根本不收**：
 *     · qwen3.5:latest → prompt_eval_count=2329，准确描述了画面内容；
 *     · gemma4:latest  → prompt_eval_count=68，回答"我目前没有看到任何图片"。
 *   （换成 60KB 小图结论不变，排除尺寸因素。）
 *   即 **"报告有能力" ≠ "实际能用"**。这种模型若不排除，DSH 会把图片发过去、
 *   模型却答"没有图片"，用户会以为是本插件的 bug。
 *
 * @param capabilities - /api/show 的能力数组
 * @param modelId - 模型 id
 * @param config - { visionMode, visionExclude }
 */
export function shouldEnableVision(capabilities, modelId, config = {}) {
  if (config.visionMode === 'off') return false;
  if (!Array.isArray(capabilities) || !capabilities.includes('vision')) return false;
  const patterns = String(config.visionExclude ?? '')
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const pattern of patterns) {
    if (modelId === pattern || modelId.startsWith(pattern) || modelId.includes(pattern)) return false;
  }
  return true;
}

/**
 * 由 /api/show 的结果补全能力（比 /api/tags 准，实测两者会不一致）。
 */
export function mergeCapabilities(modelInfo, showResult, config = {}) {
  const caps = Array.isArray(showResult?.capabilities) ? showResult.capabilities : null;
  if (!caps) return modelInfo;
  const vision = shouldEnableVision(caps, modelInfo.id, config);
  return {
    ...modelInfo,
    _capabilities: caps,
    _vision: vision,
    inputModalities: vision ? ['text', 'image'] : ['text'],
    description: (() => {
      const base = modelInfo.description ?? '';
      const withoutOld = base.replace(/\s*能力：[^·]*$/, '').trim();
      const capsText = `能力：${caps.join('/')}`;
      const suffix = caps.includes('vision') && !vision ? '（图片已禁用）' : '';
      return withoutOld ? `${withoutOld} · ${capsText}${suffix}` : `${capsText}${suffix}`;
    })(),
  };
}
