/**
 * 单测：单进程运行（不用 node --test 扫目录，沙箱下会 EPERM）。
 * 运行：node test/run-tests.mjs
 */
import assert from 'node:assert/strict';
import { formatBytes, blocksToText, toOllamaMessages, describeModel, mergeCapabilities, collectImageBlocks, shouldEnableVision, pickContextWindow } from '../convert.js';
import { objectSchema, validatePatch } from '../schema.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { failed += 1; console.log(`  ✗ ${name}\n      ${error.message}`); }
}

console.log('\n== convert.js : 基础转换 ==');

test('formatBytes 人类可读', () => {
  assert.equal(formatBytes(0), '未知大小');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2679710881), '2.5 GB');
  assert.equal(formatBytes(12669646080), '11.8 GB');
});

test('blocksToText 拍平文本块', () => {
  assert.equal(blocksToText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab');
  assert.equal(blocksToText([{ type: 'reasoning', text: 'x' }, { type: 'text', text: 'y' }]), 'xy');
  assert.equal(blocksToText([]), '');
  assert.equal(blocksToText(null), '');
});

test('blocksToText 递归拍平 tool-result 内容', () => {
  const blocks = [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '结果' }] }];
  assert.equal(blocksToText(blocks), '结果');
});

console.log('\n== convert.js : DSH 消息 → Ollama 消息 ==');

test('普通 user / assistant 直通', () => {
  const out = toOllamaMessages([
    { role: 'user', content: [{ type: 'text', text: '你好' }] },
    { role: 'assistant', content: [{ type: 'text', text: '在的' }] },
  ]);
  assert.deepEqual(out, [{ role: 'user', content: '你好' }, { role: 'assistant', content: '在的' }]);
});

test('★ 工具结果必须转成 Ollama 的 tool 角色（DSH 把它塞在 user 里）', () => {
  const out = toOllamaMessages([
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '晴 25 度' }] }] },
  ]);
  assert.deepEqual(out, [{ role: 'tool', content: '晴 25 度' }]);
});

test('★ assistant 的工具调用转成 tool_calls 且参数是对象（Ollama 要对象不是字符串）', () => {
  const out = toOllamaMessages([
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'get_weather', arguments: '{"city":"北京"}' }] },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'assistant');
  assert.deepEqual(out[0].tool_calls, [{ function: { name: 'get_weather', arguments: { city: '北京' } } }]);
});

test('参数不是合法 JSON 时降级成空对象，不抛异常', () => {
  const out = toOllamaMessages([
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'f', arguments: '{坏掉的' }] },
  ]);
  assert.deepEqual(out[0].tool_calls, [{ function: { name: 'f', arguments: {} } }]);
});

test('滤掉空内容消息（Ollama 不接受）', () => {
  const out = toOllamaMessages([
    { role: 'user', content: [{ type: 'text', text: '' }] },
    { role: 'user', content: [{ type: 'text', text: '有内容' }] },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, '有内容');
});

test('纯思考块的历史不应被当成正文发给模型', () => {
  const out = toOllamaMessages([
    { role: 'assistant', content: [{ type: 'reasoning', text: '内心独白' }] },
    { role: 'user', content: [{ type: 'text', text: '继续' }] },
  ]);
  // assistant 正文为空 → 被过滤，只剩 user
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'user');
});

console.log('\n== convert.js : /api/tags 条目 → LlmModelInfo ==');

test('describeModel 提取大小/量化/能力', () => {
  const info = describeModel({
    name: 'gemma4:latest',
    size: 9608350718,
    details: { parameter_size: '8.0B', quantization_level: 'Q4_K_M', context_length: 262144 },
    capabilities: ['completion', 'tools', 'thinking'],
  }, 'ollama');
  assert.equal(info.id, 'gemma4:latest');
  assert.equal(info.provider, 'ollama');
  assert.deepEqual(info.inputModalities, ['text']);
  assert.equal(info._contextLength, 262144);
  assert.match(info.description, /8\.0B/);
  assert.match(info.description, /Q4_K_M/);
  assert.match(info.description, /tools\/thinking/);
});

test('★ 未显式开启 vision 时只声明 text 模态（少声明是安全方向）', () => {
  const info = describeModel({ name: 'qwen3.5:latest', capabilities: ['vision', 'tools'] }, 'ollama');
  assert.deepEqual(info.inputModalities, ['text']);
});

test('缺字段时不崩，给出可用的降级结果', () => {
  const info = describeModel({ name: 'x' }, 'ollama');
  assert.equal(info.id, 'x');
  assert.equal(info._contextLength, null);
  assert.equal(info.description, undefined);
});

test('mergeCapabilities 用 /api/show 的结果覆盖 tags（实测两者会不一致）', () => {
  const base = describeModel({ name: 'm:2b', details: { parameter_size: '2.5B' }, capabilities: ['completion'] }, 'ollama');
  assert.match(base.description, /completion/);
  const merged = mergeCapabilities(base, { capabilities: ['tools', 'thinking', 'completion'] });
  assert.deepEqual(merged._capabilities, ['tools', 'thinking', 'completion']);
  assert.match(merged.description, /tools\/thinking\/completion/);
  assert.doesNotMatch(merged.description, /能力：completion$/);
});

console.log('\n== schema.js : 自实现 schema（满足 dsh-settings 的最小契约）==');

test('可调用，并按类型归一', () => {
  const s = objectSchema({
    a: { type: 'string', default: 'x' },
    n: { type: 'number', default: 5, min: 1 },
    b: { type: 'boolean', default: false },
  });
  assert.equal(typeof s, 'function');
  assert.deepEqual(s({}), { a: 'x', n: 5, b: false });
  assert.deepEqual(s({ a: 'y', n: 0, b: true }), { a: 'y', n: 1, b: true });
  assert.deepEqual(s(null), { a: 'x', n: 5, b: false });
  assert.deepEqual(s({ n: 'abc' }), { a: 'x', n: 5, b: false }, '非法数字应回退默认值');
});

test('toJSON 输出设置页渲染表单所需的结构', () => {
  const s = objectSchema({ a: { type: 'string', default: 'x', description: '说明' } });
  const json = s.toJSON();
  assert.equal(json.type, 'object');
  assert.deepEqual(json.meta.default, { a: 'x' });
  assert.equal(json.dict.a.type, 'string');
  assert.equal(json.dict.a.meta.description, '说明');
});

console.log('\n== convert.js : 图片 / 视觉 ==');

test('★ collectImageBlocks 递归收集（图片可能嵌在 tool-result 里）', () => {
  const blocks = [
    { type: 'text', text: '看这个' },
    { type: 'image', attachment: { attachmentId: 'a1' } },
    { type: 'tool-result', toolCallId: 'c', content: [{ type: 'image', attachment: { attachmentId: 'a2' } }] },
  ];
  const found = collectImageBlocks(blocks);
  assert.equal(found.length, 2);
  assert.equal(found[0].attachment.attachmentId, 'a1');
  assert.equal(found[1].attachment.attachmentId, 'a2');
});

test('★ 只有图片没有文字的消息不能被丢掉', () => {
  const out = toOllamaMessages([
    { role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a1' } }] },
  ]);
  assert.equal(out.length, 1, '纯图片消息被误过滤了');
  assert.equal(out[0]._images.length, 1);
});

test('图片被挂到 _images 上交给调用方解析（纯函数不做 I/O）', () => {
  const out = toOllamaMessages([
    { role: 'user', content: [{ type: 'text', text: '这是什么' }, { type: 'image', attachment: { attachmentId: 'a1' } }] },
  ]);
  assert.equal(out[0].content, '这是什么');
  assert.equal(out[0]._images.length, 1);
  assert.equal(out[0].images, undefined, '纯函数阶段不应有 base64');
});

test('describeModel 默认不带 image 模态', () => {
  const info = describeModel({ name: 'x', details: {} }, 'ollama');
  assert.deepEqual(info.inputModalities, ['text']);
  assert.equal(info._vision, false);
});

test('describeModel 在 vision 为真时声明 image 模态', () => {
  const info = describeModel({ name: 'x', details: {} }, 'ollama', { vision: true });
  assert.deepEqual(info.inputModalities, ['text', 'image']);
  assert.equal(info._vision, true);
});

test('★ shouldEnableVision：有 vision 才开', () => {
  assert.equal(shouldEnableVision(['completion', 'vision'], 'a', {}), true);
  assert.equal(shouldEnableVision(['completion', 'tools'], 'a', {}), false, '无 vision 不该开');
  assert.equal(shouldEnableVision(undefined, 'a', {}), false, '能力未知不该开');
});

test('★ shouldEnableVision：visionMode=off 一律关', () => {
  assert.equal(shouldEnableVision(['vision'], 'a', { visionMode: 'off' }), false);
});

test('★ shouldEnableVision：排除名单支持精确/前缀/包含匹配', () => {
  assert.equal(shouldEnableVision(['vision'], 'gemma4:latest', { visionExclude: 'gemma4' }), false, '前缀匹配应生效');
  assert.equal(shouldEnableVision(['vision'], 'gemma4:latest', { visionExclude: 'qwen, gemma4' }), false, '逗号分隔 + 空格应生效');
  assert.equal(shouldEnableVision(['vision'], 'qwen3.5:latest', { visionExclude: 'gemma4' }), true, '未列出的应保持开启');
  assert.equal(shouldEnableVision(['vision'], 'a', { visionExclude: '' }), true, '空名单不排除任何模型');
});

test('mergeCapabilities 按配置决定 image 模态并标注禁用原因', () => {
  const base = describeModel({ name: 'gemma4:latest', details: {} }, 'ollama');
  const shown = { capabilities: ['completion', 'vision'] };
  const enabled = mergeCapabilities(base, shown, { visionExclude: '' });
  assert.deepEqual(enabled.inputModalities, ['text', 'image']);
  const disabled = mergeCapabilities(base, shown, { visionExclude: 'gemma4' });
  assert.deepEqual(disabled.inputModalities, ['text']);
  assert.match(disabled.description, /图片已禁用/);
});

console.log('\n== schema.js : 写入校验（界面改配置的关口）==');

const FIELDS = {
  enabled: { type: 'boolean', default: true },
  baseUrl: { type: 'string', default: 'http://127.0.0.1:11434' },
  contextSize: { type: 'number', default: 32768, min: 512 },
  promptMode: { type: 'string', default: 'chat' },
};

test('★ 未知字段必须被拒绝（不能让 HTTP 端点写任意键）', () => {
  const { patch, rejected } = validatePatch(FIELDS, { contextSize: 8192, evilKey: 'x' });
  assert.deepEqual(patch, { contextSize: 8192 });
  assert.equal(rejected.evilKey, '未知配置项');
});

test('★ 界面传来的字符串要按声明类型转换', () => {
  const { patch, rejected } = validatePatch(FIELDS, { contextSize: '8192', enabled: 'false' });
  assert.equal(patch.contextSize, 8192, '字符串应转成数字');
  assert.equal(patch.enabled, false, '字符串 false 应转成布尔');
  assert.deepEqual(rejected, {});
});

test('★ 非法数字要报错而不是静默取默认', () => {
  const { rejected } = validatePatch(FIELDS, { contextSize: 'abc' });
  assert.equal(rejected.contextSize, '需要数字');
});

test('★ 越界数字要报错', () => {
  assert.equal(validatePatch(FIELDS, { contextSize: 100 }).rejected.contextSize, '不能小于 512');
});

test('空字符串视为清空 → 回默认值', () => {
  assert.equal(validatePatch(FIELDS, { contextSize: '' }).patch.contextSize, 32768);
});

test('类型不符要报错', () => {
  assert.equal(validatePatch(FIELDS, { baseUrl: 123 }).rejected.baseUrl, '需要字符串');
  assert.equal(validatePatch(FIELDS, { enabled: 'maybe' }).rejected.enabled, '需要布尔值');
});

test('非对象请求体要整体拒绝', () => {
  assert.equal(validatePatch(FIELDS, 'nope').rejected._, '请求体必须是对象');
  assert.equal(validatePatch(FIELDS, [1, 2]).rejected._, '请求体必须是对象');
});

test('只提交改动的字段（局部补丁语义）', () => {
  const { patch } = validatePatch(FIELDS, { promptMode: 'agent' });
  assert.deepEqual(Object.keys(patch), ['promptMode'], '不应把其他字段的默认值一起写进去');
});

console.log('\n== convert.js : 上下文窗口自适应 ==');

test('★ auto：原生窗口比上限大时受上限约束', () => {
  assert.equal(pickContextWindow({ mode: 'auto', ceiling: 32768, fixed: 32768, native: 131072 }), 32768);
  assert.equal(pickContextWindow({ mode: 'auto', ceiling: 131072, fixed: 32768, native: 131072 }), 131072, '上限放开 → 用原生值');
});

test('★ auto：原生窗口比上限小时取原生值（这才是自适应的价值）', () => {
  assert.equal(pickContextWindow({ mode: 'auto', ceiling: 32768, fixed: 32768, native: 8192 }), 8192,
    '小窗口模型不该被申报成 32768，否则 DSH 会以为空间比实际大');
});

test('★ auto：原生窗口未知时退化为上限', () => {
  assert.equal(pickContextWindow({ mode: 'auto', ceiling: 16384, fixed: 32768, native: null }), 16384);
  assert.equal(pickContextWindow({ mode: 'auto', ceiling: 16384, fixed: 32768, native: 0 }), 16384);
  assert.equal(pickContextWindow({ mode: 'auto', ceiling: 16384, fixed: 32768, native: 'x' }), 16384);
});

test('★ fixed：忽略原生窗口，一律用配置值', () => {
  assert.equal(pickContextWindow({ mode: 'fixed', ceiling: 32768, fixed: 8192, native: 262144 }), 8192);
});

test('上限非法时用 32768 兜底（仍与原生窗口取较小者），不产生 NaN/0', () => {
  // ceiling 非法 → cap 兜底为 32768，然后照常与原生窗口取 min
  assert.equal(pickContextWindow({ mode: 'auto', ceiling: 0, fixed: 1, native: 999 }), 999, '原生更小 → 取原生');
  assert.equal(pickContextWindow({ mode: 'auto', ceiling: 0, fixed: 1, native: 100000 }), 32768, '原生更大 → 取兜底上限');
  assert.equal(pickContextWindow({ mode: 'auto', ceiling: -5, fixed: 1, native: 100000 }), 32768);
  assert.ok(Number.isFinite(pickContextWindow({ mode: 'auto', ceiling: NaN, fixed: 1, native: NaN })), '不能返回 NaN');
});

console.log(`\n${'='.repeat(56)}\n通过 ${passed}，失败 ${failed}\n${'='.repeat(56)}`);
process.exit(failed === 0 ? 0 : 1);
