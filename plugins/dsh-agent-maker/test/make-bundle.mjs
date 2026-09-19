/**
 * 造一个测试用的智能体安装包，并写出「期望结果」供安装脚本测试比对。
 *
 * 跑法：node test/make-bundle.mjs <outZip> <outExpectJson>
 *
 * 为什么单独一个脚本：安装脚本的测试要在**真 PowerShell 子进程**里跑
 * （见 dsh-plugin-dev 坑 #56：同进程调用测的不是用户双击走的那条路），
 * 而造包是 JS 的活。两边通过文件交接，互不依赖对方的实现细节。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

import { buildAgentBundle, collectPresetFiles } from '../agent-pack.js';

const outZip = process.argv[2];
const outExpect = process.argv[3];
if (!outZip || !outExpect) {
  console.error('用法: node test/make-bundle.mjs <outZip> <outExpectJson>');
  process.exit(2);
}

const AGENT_ID = 'install-smoke-agent';

const root = mkdtempSync(join(tmpdir(), 'agent-pack-fixture-'));
const dir = join(root, AGENT_ID);
mkdirSync(join(dir, 'skills', 'helper'), { recursive: true });

writeFileSync(join(dir, 'preset.yml'),
  'name: 安装冒烟测试体\ndescription: 只用于验证安装脚本\norder: 42\n', 'utf8');

/* agent.cordis.yml 里刻意放三类可被依赖扫描认出来的东西，
   这样「依赖清单」这条链路也会被真子进程读一遍。 */
writeFileSync(join(dir, 'agent.cordis.yml'), [
  '# 安装冒烟测试用',
  '- id: persona',
  "  name: '@deepseek-ai/dsh-persona'",
  '  config:',
  '    text: |-',
  '      你是安装冒烟测试体。',
  '- id: kb',
  "  name: 'some-third-party-plugin'",
  '  config:',
  '    key: process.env.SMOKE_TEST_KEY',
  ''
].join('\n'), 'utf8');

writeFileSync(join(dir, 'skills', 'helper', 'SKILL.md'), '# helper\n步骤……\n', 'utf8');

const r = buildAgentBundle(root, [AGENT_ID], { dshHome: 'C:\\Fake\\Source\\home' });

writeFileSync(outZip, r.data);

/* 期望值：每个文件的 rel 路径 + sha256（安装后要逐个比对） */
const files = {};
for (const rel of collectPresetFiles(dir)) {
  const data = (await import('node:fs')).readFileSync(join(dir, rel));
  files[rel.split('\\').join('/')] = createHash('sha256').update(data).digest('hex');
}

writeFileSync(outExpect, JSON.stringify({
  agentId: AGENT_ID,
  agentName: '安装冒烟测试体',
  rootName: r.fileName.replace(/-智能体包\.zip$/, ''),
  fileCount: Object.keys(files).length,
  files
}, null, 2), 'utf8');

rmSync(root, { recursive: true, force: true });
console.log(`bundle written: ${outZip}`);
