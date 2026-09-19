/**
 * 验证 Ollama 的图片输入接口：确认字段名、编码格式，以及视觉模型是否真能读图。
 * 用真实 PNG 当样本（DSH 附件目录里的截图）。
 */
import fs from 'node:fs';
import http from 'node:http';

const BASE = 'http://127.0.0.1:11434';
const IMAGE = process.argv[2];

if (!IMAGE || !fs.existsSync(IMAGE)) { console.error('需要一个真实图片路径作为参数'); process.exit(1); }

const bytes = fs.readFileSync(IMAGE);
const b64 = bytes.toString('base64');
console.log('样本图片:', IMAGE.split('\\').pop());
console.log('字节数  :', bytes.length, '  base64 长度:', b64.length);
console.log('魔数    :', [...bytes.subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join(' '));

function post(path, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({ hostname: '127.0.0.1', port: 11434, method: 'POST', path, headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length } }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`)); return; }
        try { resolve(JSON.parse(text)); } catch { reject(new Error('非 JSON: ' + text.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

// 候选视觉模型
const candidates = ['qwen3.5:latest', 'gemma4:latest'];
for (const model of candidates) {
  console.log(`\n${'='.repeat(60)}\n### ${model}\n${'='.repeat(60)}`);
  try {
    const started = Date.now();
    const r = await post('/api/chat', {
      model,
      messages: [{ role: 'user', content: '这张图片里有什么？用中文简短描述。', images: [b64] }],
      stream: false,
      think: false,
      options: { num_ctx: 8192, num_predict: 200 },
    });
    console.log(`耗时 ${((Date.now() - started) / 1000).toFixed(1)}s  done_reason=${r.done_reason}`);
    console.log('prompt_eval_count =', r.prompt_eval_count, '（若图片生效，应显著大于纯文本的十几个 token）');
    console.log('回答:', r.message?.content);
  } catch (error) {
    console.log('失败:', error.message);
  }
}
