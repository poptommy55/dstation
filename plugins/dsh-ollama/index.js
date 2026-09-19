/**
 * dsh-ollama —— 直接对接本机 Ollama 的 DSH 模型插件。
 *
 * 与上一个（内嵌）方案的关键区别：**模型跑在 Ollama 自己的进程里**，
 * 本插件只做「协议翻译 + DSH 注册」，所以：
 *   · 不把原生库加载进 DSH 进程 ⇒ 没有 CUDA 硬终止/反复重启的风险；
 *   · 模型列表是**动态读**的（`/api/tags`）⇒ 你在 Ollama 里 pull 了新模型，
 *     插件这边自动就能选到，不用改任何配置。
 *
 * 三件注册缺一不可（上一轮踩过：只注册适配器会出现"能用但设置页里找不到"）：
 *   ① ctx.llm.registerAdapter                → 模型出现在模型选择器
 *   ② ctx.llm.registerConfigurableProviders  → 出现在「设置 → 模型」的供应商列表
 *   ③ ctx.settings.register('ollama')        → 该行才有可解析的设置地址
 *
 * 关于提示词模式：DSH 的 agent 提示词约 18.5K tokens + 几十个工具定义，
 * 小模型会被压成"复述人设 / 拒绝回答 / 乱调工具"（上一轮的实测结论）。
 * 因此默认 `promptMode: 'chat'`：用一句短人设替换掉 DSH 的 system，并**不发送工具定义**。
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import {
  getVersion, listTags, showModel, listRunning, chatStream,
} from './ollama.js';
import { toOllamaMessages, describeModel, mergeCapabilities, pickContextWindow } from './convert.js';
import { objectSchema, validatePatch } from './schema.js';

export const name = 'dsh-ollama';
// 只注入真正必需的。⚠️ 不要把 'config' 塞进 inject：全 DSH 插件树没有先例，
//    而且不可满足的 inject 会让插件永远等不到加载（比报错更难查）。
export const inject = ['llm', 'settings'];

const NAMESPACE = 'ollama';
const ROUTE = 'ollama';
const BUILD = 'v1-20260914-ollama-native';

export function apply(ctx, pluginConfigArg) {
  // 配置来源：apply 第二参数优先，其次 ctx.config（需要 inject，故包 try/catch），最后空对象。
  // 这里抛异常 = 插件树加载失败 = 被看门狗禁用，所以每一次外部访问都要兜住。
  let pluginConfig = pluginConfigArg;
  if (pluginConfig === undefined || pluginConfig === null) {
    try { pluginConfig = ctx.config; } catch { pluginConfig = {}; }
  }
  pluginConfig = (pluginConfig && typeof pluginConfig === 'object') ? pluginConfig : {};

  /** 诊断日志：任何情况下都不允许它把插件带崩。 */
  const log = (level, message) => {
    try {
      const logger = ctx.logger;
      if (!logger) return;
      const fn = typeof logger[level] === 'function' ? logger[level] : logger.info;
      if (typeof fn === 'function') fn.call(logger, message);
    } catch { /* 忽略 */ }
  };

  /** 附件服务（可选注入）：把 DSH 的 durable 图片引用解析成模型请求版本。 */
  const getAttachments = () => {
    try {
      const store = ctx.get?.('attachments');
      return store && typeof store.readImageRequest === 'function' ? store : null;
    } catch { return null; }
  };

  const defaults = {
    enabled: true,
    baseUrl: 'http://127.0.0.1:11434',
    // Ollama 默认 num_ctx 很小（2048~4096），而 DSH 的 agent 提示词约 18.5K，
    // 不显式设置就会被静默截断，所以必须显式设置。
    //
    // contextMode：
    //   'auto'（默认）= 每个模型取 min(自己的原生窗口, contextCeiling)
    //   'fixed'       = 所有模型统一用 contextSize
    //
    // 为什么"自适应"要**按模型**而不是"按对话长度"——实测依据（Ollama 0.30.10）：
    //   · num_ctx 每变一次，Ollama 就**整模型重载一次**（2B 每次 load ≈ 2.9~4.0 秒，
    //     大模型更久）⇒ 按对话长度动态调只会反复重载，越调越慢。
    //   · num_ctx 直接决定显存：同一 2B 模型 8192→2.9GB、32768→4.0GB。
    //   · 超过模型原生窗口时 Ollama 会自动夹取（要 262144 → 实给 131072）。
    // 按模型自适应的真正价值是**让申报给 DSH 的窗口与模型真实能力一致**：
    // 之前一律申报配置值，遇到原生窗口更小的模型会让 DSH 以为空间比实际大。
    contextMode: 'auto',
    /** contextMode='auto' 时的上限；实际值 = min(模型原生窗口, 本值)。 */
    contextCeiling: 32768,
    /** contextMode='fixed' 时所有模型统一使用的窗口。 */
    contextSize: 32768,
    maxTokens: 4096,
    temperature: 1.0,
    topP: 0.95,
    topK: 40,
    repeatPenalty: 1.0,
    // 模型在显存里保留多久（Ollama 原生参数）
    keepAlive: '5m',
    // 'chat' = 短人设 + 不发工具（默认，小模型友好）；'agent' = DSH 完整人设与工具
    promptMode: 'chat',
    chatPersona: '你是一个乐于助人的中文助手。请直接、简洁地回答用户的问题，不要推脱。',
    // 是否让模型产出思考链。默认关：长思考链会把输出预算烧光，表现为"卡住"。
    enableThinking: false,
    // 模型列表缓存毫秒数（避免每次选择器刷新都打 Ollama）
    modelCacheMs: 10000,
    // 取 /api/show 补全能力（比 /api/tags 准），结果按模型缓存
    probeCapabilities: true,
    // ── 图片/视觉 ────────────────────────────────────────────────────────
    // 'auto' = 凡 /api/show 报告 vision 的模型都声明可收图（默认，按要求）
    // 'off'  = 全部按纯文本处理
    visionMode: 'auto',
    // 强制不给图片的模型（应对"报告有 vision 但实际不收图"的模型）。
    // 默认已排除 gemma4 —— 实测依据见 convert.js 的 shouldEnableVision 注释：
    // 同一张图 qwen3.5 的 prompt_eval_count=2329 且描述准确，
    // gemma4 只有 68 且回答"没有看到图片"。清空此项即可让它也带图。
    visionExclude: 'gemma4',
    // 图片请求版本的预算：送进模型前会按此重编码（像素上限 + 字节目标）
    imageMaxPixels: 1280 * 1280,
    imageMaxBytes: 1048576,
  };

  let scope = null;
  /**
   * 读取当前生效配置。
   *
   * ⚠️ 必须用 `scope.get()`。`SettingsScope` 的接口只有
   * `get() / watch() / update() / replace()` —— **没有 `.value` 属性**。
   * 曾经写成 `scope?.value`，于是永远是 undefined：界面改的配置能写进
   * settings.yaml，插件却一路用默认值（症状是"改了没生效"，而且很难察觉，
   * 因为默认值看起来本来就对）。这个 bug 是"写入后回读的值没变"暴露出来的。
   */
  const readConfig = () => {
    let resolved = null;
    try { resolved = scope && typeof scope.get === 'function' ? scope.get() : null; } catch { resolved = null; }
    return { ...defaults, ...pluginConfig, ...(resolved && typeof resolved === 'object' ? resolved : {}) };
  };

  /**
   * 探测本机是否安装了 Ollama（不启动，只判断"能不能启动"）。
   * 优先级：常见安装路径（Windows 用户级/系统级）→ PATH（where/which）。
   * 返回可执行文件路径或 null。冷启动/无权限都不会抛异常。
   */
  const findOllama = () => {
    const candidates = [];
    try {
      const local = process.env.LOCALAPPDATA;
      if (local) candidates.push(path.join(local, 'Programs', 'Ollama', 'ollama.exe'));
    } catch { /* 忽略 */ }
    candidates.push('C:\\Program Files\\Ollama\\ollama.exe', 'C:\\Program Files (x86)\\Ollama\\ollama.exe');
    for (const c of candidates) {
      try { if (existsSync(c)) return c; } catch { /* 忽略 */ }
    }
    try {
      const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ollama'], { timeout: 5000, windowsHide: true });
      const out = (r.stdout || Buffer.from('')).toString().trim().split(/\r?\n/)[0];
      if (out && existsSync(out.trim())) return out.trim();
    } catch { /* 忽略 */ }
    return null;
  };

  // ── 配置字段定义（单一来源：schema 注册、界面渲染、写入校验都用它）──────────
  const configFields = {
    enabled: { type: 'boolean', default: defaults.enabled, description: '是否启用该供应商' },
    baseUrl: { type: 'string', default: defaults.baseUrl, description: 'Ollama 地址（默认 http://127.0.0.1:11434）' },
    contextMode: { type: 'string', default: defaults.contextMode, description: "'auto' = 每个模型取 min(原生窗口, ceiling)；'fixed' = 统一用 contextSize" },
    contextCeiling: { type: 'number', default: defaults.contextCeiling, min: 512, description: "contextMode='auto' 时的上限（实际 = min(模型原生窗口, 本值)）" },
    contextSize: { type: 'number', default: defaults.contextSize, min: 512, description: "contextMode='fixed' 时统一使用的上下文窗口" },
    maxTokens: { type: 'number', default: defaults.maxTokens, min: 1, description: '单次生成上限 num_predict' },
    temperature: { type: 'number', default: defaults.temperature, description: '采样温度' },
    topP: { type: 'number', default: defaults.topP, description: 'top_p' },
    topK: { type: 'number', default: defaults.topK, description: 'top_k' },
    repeatPenalty: { type: 'number', default: defaults.repeatPenalty, description: '重复惩罚；1.0 = 不惩罚' },
    keepAlive: { type: 'string', default: defaults.keepAlive, description: '模型在显存中保留时长，如 5m / 1h / -1（永久）' },
    promptMode: { type: 'string', default: defaults.promptMode, description: "'chat' = 短人设且不发工具（推荐）；'agent' = DSH 完整人设与工具" },
    chatPersona: { type: 'string', default: defaults.chatPersona, description: "promptMode='chat' 时使用的系统提示词" },
    enableThinking: { type: 'boolean', default: defaults.enableThinking, description: '是否开启思考链（小模型建议关闭）' },
    modelCacheMs: { type: 'number', default: defaults.modelCacheMs, min: 0, description: '模型列表缓存毫秒数' },
    probeCapabilities: { type: 'boolean', default: defaults.probeCapabilities, description: '是否用 /api/show 补全模型能力（更准，每模型一次调用）' },
    visionMode: { type: 'string', default: defaults.visionMode, description: "'auto' = 有 vision 能力的模型都启用图片；'off' = 全部按纯文本" },
    visionExclude: { type: 'string', default: defaults.visionExclude, description: '强制不给图片的模型（逗号分隔，支持前缀/包含匹配）' },
    imageMaxPixels: { type: 'number', default: defaults.imageMaxPixels, min: 4096, description: '送模型前图片的最大像素数（宽×高）' },
    imageMaxBytes: { type: 'number', default: defaults.imageMaxBytes, min: 1024, description: '送模型前图片的字节目标上限' },
  };

  // ── 设置命名空间：同步注册，自实现 schema（不 import @deepseek-ai/*）─────────
  let namespaceRegistered = false;
  let namespaceError = null;
  let schema = null;
  try {
    schema = objectSchema(configFields);
    scope = ctx.settings.register(NAMESPACE, schema, {});
    namespaceRegistered = true;
    // 配置变更 → 让模型元数据缓存失效（地址/视觉开关/能力探测都会影响元数据）
    try {
      if (typeof scope.watch === 'function') {
        scope.watch(() => { tagCache = { at: 0, models: [], error: null, key: null }; });
      }
    } catch { /* 观察失败不影响功能 */ }
    log('info', `设置命名空间 ${NAMESPACE} 已注册`);
  } catch (error) {
    namespaceError = error?.message ?? String(error);
    log('warn', `settings 注册失败，退回插件默认配置：${namespaceError}`);
  }

  // ── 模型列表：缓存 + 能力补全 ────────────────────────────────────────────
  let tagCache = { at: 0, models: [], error: null, key: null };
  const capabilityCache = new Map(); // modelId -> capabilities[]

  /** 影响模型元数据的配置指纹：变了就要让缓存失效（否则改了视觉开关不生效）。 */
  const modelsKey = (cfg) => JSON.stringify([cfg.baseUrl, cfg.probeCapabilities, cfg.visionMode, cfg.visionExclude]);

  async function readModels({ force = false } = {}) {
    const cfg = readConfig();
    const now = Date.now();
    const key = modelsKey(cfg);
    if (!force && tagCache.models.length > 0 && tagCache.key === key && now - tagCache.at < cfg.modelCacheMs) {
      return { models: tagCache.models, error: tagCache.error, cached: true };
    }
    try {
      const tags = await listTags(cfg.baseUrl);
      const visionConfig = { visionMode: cfg.visionMode, visionExclude: cfg.visionExclude };
      // tags 先给一份初值（没有 show 的情况下也能用；能力稍后由 /api/show 校正）
      let models = tags.map((tag) => describeModel(tag, ROUTE, { vision: false }));

      if (cfg.probeCapabilities) {
        // /api/tags 的 capabilities 实测会漏（同一模型 tags 说只有 completion，
        // /api/show 说 tools/thinking/completion），所以按模型补一次并缓存。
        models = await Promise.all(models.map(async (m) => {
          if (capabilityCache.has(m.id)) return mergeCapabilities(m, { capabilities: capabilityCache.get(m.id) }, visionConfig);
          try {
            const shown = await showModel(cfg.baseUrl, m.id);
            const caps = Array.isArray(shown?.capabilities) ? shown.capabilities : null;
            if (caps) capabilityCache.set(m.id, caps);
            return mergeCapabilities(m, shown, visionConfig);
          } catch { return m; }
        }));
      }

      tagCache = { at: now, models, error: null, key };
      const visionCount = models.filter((m) => m._vision).length;
      log('info', `读到 ${models.length} 个本地模型，其中 ${visionCount} 个启用图片输入`);
      return { models, error: null, cached: false };
    } catch (error) {
      const message = error?.message ?? String(error);
      // 保留上一次的好结果，只把错误挂出来（Ollama 挂了不该让选择器变空）
      tagCache = { at: tagCache.at, models: tagCache.models, error: message, key: tagCache.key };
      return { models: tagCache.models, error: message, cached: true };
    }
  }

  /** 按模型 id 取一份元数据（找不到也要给出可用的默认值 —— 目录是建议性的，不是准入）。 */
  async function lookupModel(modelId) {
    const { models } = await readModels();
    return models.find((m) => m.id === modelId) ?? null;
  }

  /**
   * 该模型**实际**使用的上下文窗口（见 convert.js 的 pickContextWindow，
   * 那里有完整的实测依据）。这里只是把配置喂进去。
   */
  function effectiveContext(modelInfo, cfg) {
    return pickContextWindow({
      mode: cfg.contextMode,
      ceiling: cfg.contextCeiling,
      fixed: cfg.contextSize,
      native: modelInfo?._contextLength,
    });
  }

  // ── 适配器（7 个方法全部实现）────────────────────────────────────────────
  const adapter = {
    providerInfo(provider) {
      return { id: provider, name: 'Ollama（本地）' };
    },
    providerRetryPolicy() {
      return undefined;
    },
    // 纯文本路由：不申报 provider 侧图片计价。
    // 基类 LlmAdapter 有默认实现，但鸭子类型实现必须自己补，否则运行期报
    // "adapter.imageRequestPricing is not a function"。
    imageRequestPricing() {
      return undefined;
    },

    async listModels(provider) {
      const cfg = readConfig();
      // 硬开关：禁用时模型列表返回空，Ollama 从模型选择器消失（stream 也已拦截）。
      if (cfg.enabled === false) return [];
      const { models } = await readModels();
      return models.map((m) => ({
        provider,
        id: m.id,
        name: m.name,
        ...(m.description ? { description: m.description } : {}),
        inputModalities: m.inputModalities,
      }));
    },

    async resolveModel(provider, model) {
      const cfg = readConfig();
      const info = await lookupModel(model);
      return {
        provider,
        id: model,
        name: info?.name ?? model,
        ...(info?.description ? { description: info.description } : {}),
        // ⚠️ 必须与 listModels 一致地反映 vision。DSH 的 LlmRuntime 正是靠
        //    **这个字段**决定「把 durable 图片引用投影成真实请求图片」还是
        //    「替换成含 sha256 的确定性文字占位符」。这里曾写死成 ['text']，
        //    结果图片被换成占位文字、模型答"sha256 哈希值无法还原图像"，
        //    是端到端实测才抓到的（协议全绿、图片也确实"附加成功"）。
        inputModalities: info?._vision === true ? ['text', 'image'] : ['text'],
        // 必须与发给 Ollama 的 num_ctx 一致（见 effectiveContext 注释）
        context: { contextWindow: effectiveContext(info, cfg) },
        defaultMaxTokens: cfg.maxTokens,
        // 必须申报思考档位，且**覆盖 DSH 可能传来的全部标准档位**：
        // 带了未申报的档位会在发起 provider I/O 之前被拒绝，表现为"选了模型却发不出消息"。
        reasoning: {
          efforts: [
            { id: 'off', name: '关闭思考', description: '直接回答（推荐）' },
            { id: 'low', name: '轻度思考', description: '简短思考' },
            { id: 'medium', name: '中等思考', description: '中等思考' },
            { id: 'high', name: '深度思考', description: '完整思考链，更慢' },
          ],
          defaultEffort: cfg.enableThinking === true ? 'high' : 'off',
        },
      };
    },

    // 基类默认实现是「绑定的 resolveModel + 本适配器的 stream」。
    // 鸭子类型必须自己写，漏了会报 "adapter.prepareCall is not a function"。
    async prepareCall(provider, model, signal) {
      return {
        model: await this.resolveModel(provider, model, signal),
        stream: (options) => this.stream(options),
      };
    },

    async *stream(options) {
      const cfg = readConfig();

      if (cfg.enabled === false) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'dsh-ollama 已在设置中停用', code: 'DISABLED' } } };
        return;
      }

      const agentMode = cfg.promptMode === 'agent';
      // ⚠️ 用显式 undefined 判断，**不能用 `||`**：空字符串是合法且有用的取值
      //    （= 不带系统提示词进入会话），而 `'' || default` 会把它悄悄换成默认人设。
      const persona = cfg.chatPersona === undefined ? defaults.chatPersona : cfg.chatPersona;
      const system = agentMode ? options.system : persona;
      const tools = agentMode ? options.tools : undefined;
      const enableThinking = cfg.enableThinking === true
        ? true
        : options.reasoningEffort !== undefined
          ? options.reasoningEffort !== 'off'
          : false;

      const messages = [];
      if (typeof system === 'string' && system.length > 0) messages.push({ role: 'system', content: system });
      messages.push(...toOllamaMessages(options.messages));

      if (messages.length === 0) {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: '没有可发送的消息', code: 'EMPTY_REQUEST' } } };
        return;
      }

      // 思考开关必须**显式下发**：Ollama 对思考型模型默认就开思考，不传 `think`
      // 等于放任它烧输出预算（实测漏了 32 字思考）。但没有 thinking 能力的模型
      // 不能传这个字段（可能直接报错），所以先查能力再决定传不传。
      const modelInfo = await lookupModel(options.model).catch(() => null);
      const supportsThinking = (modelInfo?._capabilities ?? []).includes('thinking');

      // 图片：DSH 的 ImageBlock 里只有 **durable 引用**，字节要通过附件服务解析成
      // 「模型请求版本」（按像素预算/字节目标重编码），再转 base64 给 Ollama。
      // 全链路都不猜：契约来自 dsh-attachment 的 readImageRequest()。
      const supportsVision = modelInfo?._vision === true;
      const attachments = getAttachments();
      let imageCount = 0;
      let imageError = null;
      for (const message of messages) {
        if (!Array.isArray(message._images)) continue;
        const blocks = message._images;
        delete message._images;

        if (!supportsVision) {
          // 模型不吃图：用一句确定性文字说明替代，**不静默丢弃**
          message.content = `${message.content}\n[当前模型不支持图片输入，已忽略 ${blocks.length} 张图片]`.trim();
          continue;
        }
        if (!attachments) {
          imageError = '宿主未提供 attachments 服务，无法读取图片';
          message.content = `${message.content}\n[图片无法读取：${imageError}]`.trim();
          continue;
        }

        const images = [];
        for (const block of blocks) {
          try {
            const request = await attachments.readImageRequest(
              block.attachment,
              { maxPixels: cfg.imageMaxPixels, maxBytes: cfg.imageMaxBytes },
              options.signal,
            );
            images.push(Buffer.from(request.data).toString('base64'));
            imageCount += 1;
          } catch (error) {
            imageError = error?.message ?? String(error);
            message.content = `${message.content}\n[有一张图片读取失败：${imageError}]`.trim();
          }
        }
        if (images.length > 0) message.images = images;
      }
      if (imageCount > 0) log('info', `本次请求附带 ${imageCount} 张图片`);

      // 回调 → 异步迭代器的桥
      const queue = [];
      let wake = null;
      const push = (item) => { queue.push(item); if (wake) { const w = wake; wake = null; w(); } };

      let settle = null;
      let running = true;

      chatStream(cfg.baseUrl, {
        model: options.model,
        messages,
        ...(supportsThinking ? { think: enableThinking } : {}),        ...(cfg.keepAlive ? { keep_alive: cfg.keepAlive } : {}),
        ...(Array.isArray(tools) && tools.length > 0
          ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) }
          : {}),
        options: {
          num_ctx: effectiveContext(modelInfo, cfg),
          num_predict: options.maxTokens ?? cfg.maxTokens,
          temperature: cfg.temperature,
          top_p: cfg.topP,
          top_k: cfg.topK,
          ...(cfg.repeatPenalty && cfg.repeatPenalty !== 1 ? { repeat_penalty: cfg.repeatPenalty } : {}),
        },
      }, {
        onThinking: (d) => push({ kind: 'thinking', text: d }),
        onContent: (d) => push({ kind: 'content', text: d }),
        signal: options.signal,
      })
        .then((result) => { settle = { ok: true, result }; })
        .catch((error) => { settle = { ok: false, error }; })
        .finally(() => { running = false; push({ kind: '__end' }); });

      let blockIndex = -1;
      let current = null; // { index, kind, text }
      let toolCallCount = 0;

      const closeCurrent = () => {
        if (!current) return null;
        const end = current.kind === 'reasoning'
          ? { type: 'block-end', index: current.index, block: { type: 'reasoning', text: current.text } }
          : { type: 'block-end', index: current.index, block: { type: 'text', text: current.text } };
        current = null;
        return end;
      };

      try {
        while (running || queue.length > 0) {
          if (queue.length === 0) { await new Promise((r) => { wake = r; }); continue; }
          const event = queue.shift();
          if (event.kind === '__end') continue;

          const wantKind = event.kind === 'thinking' ? 'reasoning' : 'text';
          if (!current || current.kind !== wantKind) {
            const end = closeCurrent();
            if (end) yield end;
            blockIndex += 1;
            current = { index: blockIndex, kind: wantKind, text: '' };
            yield { type: 'block-start', index: current.index, blockType: wantKind };
          }
          current.text += event.text;
          yield wantKind === 'reasoning'
            ? { type: 'reasoning-delta', index: current.index, text: event.text }
            : { type: 'text-delta', index: current.index, text: event.text };
        }

        const end = closeCurrent();
        if (end) yield end;

        if (!settle || !settle.ok) {
          const aborted = Boolean(options.signal?.aborted);
          yield {
            type: 'finish',
            reason: {
              kind: aborted ? 'aborted' : 'error',
              failure: {
                message: settle?.error instanceof Error ? settle.error.message : String(settle?.error ?? 'Ollama 推理失败'),
                code: aborted ? 'ABORTED' : 'OLLAMA_FAILED',
              },
            },
          };
          return;
        }

        const { result } = settle;

        // 工具调用（agent 模式下才会有；chat 模式没有工具定义，模型不会产出）
        for (const call of result.toolCalls ?? []) {
          const fn = call.function ?? call;
          const name = fn?.name ?? 'unknown';
          const args = typeof fn?.arguments === 'string' ? fn.arguments : JSON.stringify(fn?.arguments ?? {});
          blockIndex += 1;
          toolCallCount += 1;
          const id = `call_${toolCallCount}`;
          yield { type: 'block-start', index: blockIndex, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index: blockIndex, id, name, argumentsDelta: args };
          yield { type: 'block-end', index: blockIndex, block: { type: 'tool-call', id, name, arguments: args } };
        }

        const usage = result.usage ?? { inputTokens: 0, outputTokens: 0 };
        yield { type: 'usage', usage: { ...usage, totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) } };

        const reason = result.aborted
          ? { kind: 'aborted', failure: { message: '已取消', code: 'ABORTED' } }
          : toolCallCount > 0
            ? { kind: 'tool-calls' }
            : result.doneReason === 'length'
              ? { kind: 'max-tokens' }
              : { kind: 'stop' };
        yield { type: 'finish', reason };
      } catch (error) {
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { message: error instanceof Error ? error.message : String(error), code: 'OLLAMA_FAILED' } },
        };
      }
    },
  };

  // ── 三件注册 ────────────────────────────────────────────────────────────
  if (typeof ctx.llm.registerConfigurableProviders === 'function') {
    const directory = ctx.llm.registerConfigurableProviders([{
      provider: ROUTE,
      displayName: 'Ollama（本地）',
      settingsNs: NAMESPACE,
      settingsPath: [],
      declared: true,
    }]);
    ctx.effect(() => () => directory(), `${name}.directory`);
  }

  const registration = ctx.llm.registerAdapter([ROUTE], adapter);
  ctx.effect(() => () => registration(), `${name}.adapter`);

  // ── 诊断路由（只读；自定义路由没有 cookie 鉴权，所以只暴露非敏感信息）────────
  const webServer = ctx.get?.('webServer');
  if (webServer && typeof webServer.register === 'function') {
    const dispose = webServer.register({
      kind: 'prefix',
      path: '/dsh-ollama',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const cfg = readConfig();
        const send = (payload, status = 200) => {
          const body = JSON.stringify(payload, null, 2);
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
          res.end(body);
        };
        try {
          // ── 配置读写：让「设置 → 模型」里能直接改，不必手改 settings.yaml ──────
          // 读：返回当前生效值 + 字段定义（界面据此渲染表单）+ 默认值（用于"重置"）
          if (url.pathname === '/dsh-ollama/config' && req.method === 'GET') {
            send({
              ok: true,
              values: readConfig(),
              fields: configFields,
              defaults,
              namespaceRegistered,
              userLayer: readConfig(),
            });
            return;
          }
          // 写：只接受**已知字段**，按声明类型归一；非法值报错而不是静默取默认
          if (url.pathname === '/dsh-ollama/config' && req.method === 'POST') {
            const raw = await new Promise((resolve, reject) => {
              const parts = [];
              req.on('data', (c) => parts.push(c));
              req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
              req.on('error', reject);
            });
            let body;
            try { body = JSON.parse(raw); } catch (error) { send({ ok: false, error: `请求体不是 JSON：${error.message}` }, 400); return; }

            if (body?.reset === true) {
              if (!scope || typeof scope.replace !== 'function') { send({ ok: false, error: '设置命名空间不可用' }, 500); return; }
              await scope.replace({});
              tagCache = { at: 0, models: [], error: null, key: null }; // 配置变了，模型元数据要重算
              send({ ok: true, reset: true, values: readConfig() });
              return;
            }

            const { patch, rejected } = validatePatch(configFields, body?.patch ?? body);
            if (Object.keys(rejected).length > 0) { send({ ok: false, error: '有字段被拒绝', rejected }, 400); return; }
            if (Object.keys(patch).length === 0) { send({ ok: false, error: '没有要修改的字段' }, 400); return; }
            if (!scope || typeof scope.update !== 'function') { send({ ok: false, error: '设置命名空间不可用（settings 未注册）' }, 500); return; }

            await scope.update(patch);
            // 配置可能影响模型元数据（地址 / 视觉开关 / 能力探测）→ 让缓存失效
            tagCache = { at: 0, models: [], error: null, key: null };
            send({ ok: true, applied: patch, values: readConfig() });
            return;
          }

          if (url.pathname === '/dsh-ollama/status') {
            let version = null; let reachable = false; let error = null;
            try { version = await getVersion(cfg.baseUrl); reachable = true; } catch (e) { error = e?.message ?? String(e); }
            let running = [];
            if (reachable) { try { running = await listRunning(cfg.baseUrl); } catch { /* 忽略 */ } }
            const { models } = await readModels({ force: url.searchParams.get('refresh') === '1' });
            const ollamaPath = findOllama();
            send({
              ok: reachable,
              build: BUILD,
              route: ROUTE,
              namespace: NAMESPACE,
              registered: ctx.llm.listProviders?.().some((p) => p.id === ROUTE) ?? null,
              directory: ctx.llm.listConfigurableProviders?.() ?? null,
              namespaceRegistered,
              namespaceError,
              installed: !!ollamaPath,
              ollamaPath: ollamaPath || null,
              config: cfg,
              ollama: { baseUrl: cfg.baseUrl, reachable, version, error, runningModels: running.map((m) => m.name) },
              modelCount: models.length,
              visionCount: models.filter((m) => m._vision).length,
              models: models.map((m) => ({
                id: m.id,
                description: m.description,
                capabilities: m._capabilities,
                vision: m._vision,
                contextLength: m._contextLength,
                // 自适应后**实际**会用的窗口（即发给 Ollama 的 num_ctx，也是申报给 DSH 的值）
                effectiveContext: effectiveContext(m, cfg),
              })),
            });
            return;
          }
          if (url.pathname === '/dsh-ollama/models') {
            const { models, error } = await readModels({ force: url.searchParams.get('refresh') === '1' });
            send({ ok: !error, error, count: models.length, models });
            return;
          }
          // 端到端自检：不绕过 DSH，直接走 ctx.llm.stream()，验证协议与真实回答
          if (url.pathname === '/dsh-ollama/selftest') {
            const question = url.searchParams.get('prompt') ?? '用一句话介绍你自己';
            const model = url.searchParams.get('model');
            // ?image=<绝对路径>：把一张真实图片走**完整的 DSH 图片链路**发给模型。
            // 这是唯一能证明视觉链路真的通的方式（从 durable 引用解析 → 请求版本 → base64）。
            const imagePath = url.searchParams.get('image');
            const list = await adapter.listModels(ROUTE);
            const chosen = model && list.some((m) => m.id === model) ? model : list[0]?.id;
            if (!chosen) { send({ ok: false, error: 'Ollama 里没有任何模型' }, 200); return; }

            const content = [{ type: 'text', text: question }];
            const imageReport = { requested: Boolean(imagePath), attached: false, error: null, ref: null };

            if (imagePath) {
              try {
                const attachments = getAttachments();
                if (!attachments) throw new Error('宿主未提供 attachments 服务');
                const bytes = readFileSync(imagePath);
                // 从魔数判类型（SaveImageAttachment 会拿声明值与真实解码结果核对）
                const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
                const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
                const mediaType = isPng ? 'image/png' : isJpeg ? 'image/jpeg' : null;
                if (!mediaType) throw new Error('只支持 png / jpeg 测试图');
                const ref = await attachments.saveImage({ data: new Uint8Array(bytes), mediaType, name: 'selftest-image' });
                content.push({ type: 'image', attachment: ref });
                imageReport.attached = true;
                imageReport.ref = { id: String(ref.attachmentId), mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height };
              } catch (error) {
                imageReport.error = error?.message ?? String(error);
              }
            }

            const message = { id: `selftest-${Date.now()}`, role: 'user', content, source: { kind: 'user' } };
            const chunks = [];
            const started = Date.now();
            for await (const chunk of ctx.llm.stream({
              provider: ROUTE, model: chosen, system: '你是一个乐于助人的助手。', messages: [message], maxTokens: 256,
            })) {
              chunks.push(chunk);
              if (chunks.length > 5000) break;
            }
            const text = []; const reasoning = []; const toolCalls = [];
            let usage = null; let finish = null;
            for (const c of chunks) {
              if (c.type === 'text-delta') text.push(c.text);
              else if (c.type === 'reasoning-delta') reasoning.push(c.text);
              else if (c.type === 'tool-call-delta') toolCalls.push({ name: c.name, argumentsDelta: c.argumentsDelta });
              else if (c.type === 'usage') usage = c.usage;
              else if (c.type === 'finish') finish = c.reason;
            }
            const order = chunks.map((c) => c.type);
            const modelInfo = await lookupModel(chosen).catch(() => null);
            send({
              ok: finish?.kind !== 'error',
              build: BUILD,
              model: chosen,
              question,
              image: imageReport,
              modelVision: modelInfo?._vision === true,
              modelCapabilities: modelInfo?._capabilities ?? [],
              elapsedMs: Date.now() - started,
              protocolOk: order.length > 0 && order[order.length - 1] === 'finish' && order.indexOf('finish') === order.length - 1,
              chunkTypes: order,
              reasoning: reasoning.join(''),
              text: text.join(''),
              toolCalls,
              usage,
              finish,
            });
            return;
          }
          // 一键拉起本机 Ollama：先探测安装，再用 `serve` 独立进程启动（不阻塞宿主）。
          if (url.pathname === '/dsh-ollama/launch' && req.method === 'POST') {
            const exe = findOllama();
            if (!exe) {
              send({ ok: false, error: '未检测到 Ollama 安装，请先前往 https://ollama.com/download 下载并安装' }, 200);
              return;
            }
            try {
              const child = spawn(exe, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
              child.unref();
              send({ ok: true, launched: true, exe });
            } catch (e) {
              send({ ok: false, error: '启动失败：' + (e && e.message ? e.message : String(e)) }, 200);
            }
            return;
          }

          send({ ok: false, error: 'not found' }, 404);
        } catch (error) {
          send({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
        }
      },
    });
    ctx.effect(() => () => dispose(), `${name}.routes`);
  }

  log('info', `${name} ${BUILD} 已加载：路由 ${ROUTE}，Ollama ${defaults.baseUrl}`);
}

export default { name, inject, apply };
