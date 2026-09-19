/**
 * 独立验证 Ollama 客户端层（不涉及 DSH）：
 *   ① 版本/连通性  ② 模型列表 + 能力补全  ③ 流式对话（思考与正文分离）
 *   ④ 用量与 done_reason 是否拿到  ⑤ 模型列表是否动态反映本地安装情况
 */
import { getVersion, listTags, showModel, listRunning, chatStream } from '../ollama.js';
import { describeModel, mergeCapabilities, toOllamaMessages } from '../convert.js';

const BASE = process.env.OLLAMA_BASE ?? 'http://127.0.0.1:11434';

console.log('=== ① 版本 / 连通性 ===');
const version = await getVersion(BASE);
console.log('  Ollama 版本:', version);

console.log('\n=== ② 模型列表（动态读取）===');
const tags = await listTags(BASE);
console.log(`  读到 ${tags.length} 个本地模型`);
let models = tags.map((t) => describeModel(t, 'ollama'));

console.log('\n=== ③ 用 /api/show 补全能力（tags 与 show 实测不一致）===');
for (let i = 0; i < models.length; i += 1) {
  const before = (models[i]._capabilities ?? []).join('/') || '(空)';
  try {
    const shown = await showModel(BASE, models[i].id);
    models[i] = mergeCapabilities(models[i], shown);
    const after = (models[i]._capabilities ?? []).join('/') || '(空)';
    console.log(`  ${models[i].id}`);
    console.log(`     tags=[${before}]  show=[${after}]${before !== after ? '  ← 已修正' : ''}`);
  } catch (e) {
    console.log(`  ${models[i].id}  取详情失败: ${e.message}`);
  }
}

console.log('\n=== ④ 已加载进显存的模型 ===');
try {
  const running = await listRunning(BASE);
  console.log('  ', running.length ? running.map((m) => `${m.name}(ctx=${m.context_length ?? '?'})`).join(', ') : '无');
} catch (e) { console.log('  取 ps 失败:', e.message); }

console.log('\n=== ⑤ 流式对话（思考与正文分离）===');
// 选一个带 thinking 能力的模型；没有就用第一个
const target = models.find((m) => (m._capabilities ?? []).includes('thinking')) ?? models[0];
console.log('  使用模型:', target.id);

const ollamaMessages = toOllamaMessages([
  { role: 'user', content: [{ type: 'text', text: '用一句话说明你是谁。' }] },
]);

let thinkingChars = 0;
let contentChars = 0;
const t0 = Date.now();
const result = await chatStream(BASE, {
  model: target.id,
  messages: [{ role: 'system', content: '你是一个乐于助人的中文助手。请直接、简洁地回答。' }, ...ollamaMessages],
  options: { num_ctx: 8192, num_predict: 256, temperature: 1.0, top_p: 0.95 },
}, {
  onThinking: (d) => { thinkingChars += d.length; },
  onContent: (d) => { contentChars += d.length; },
});

console.log(`  耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('  done_reason     :', result.doneReason);
console.log('  usage           :', JSON.stringify(result.usage));
console.log('  metrics         :', JSON.stringify(result.metrics));
console.log('  思考字符数      :', thinkingChars, '（流式回调累计）');
console.log('  正文字符数      :', contentChars);
console.log('  思考字段长度    :', result.thinking.length);
console.log('  正文内容        :', JSON.stringify(result.content.slice(0, 300)));

console.log('\n=== 判定 ===');
console.log('  流式回调与最终结果一致:', thinkingChars === result.thinking.length && contentChars === result.content.length ? '是 ✅' : '否 ❌');
console.log('  拿到精确 token 用量   :', result.usage && typeof result.usage.inputTokens === 'number' ? '是 ✅' : '否 ❌');
console.log('  思考与正文已分离      :', result.thinking !== undefined && result.content !== undefined ? '是 ✅' : '否 ❌');
