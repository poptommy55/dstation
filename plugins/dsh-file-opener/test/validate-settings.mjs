/**
 * 校验 settings.yaml 改完仍然能被 DSH 自己用的那个 yaml 库解析。
 * 为什么必须做：settings.yaml 解析失败可能让 DSH 起不来，
 * 改别人的配置文件 = 改数据库（技能坑 #45 的纪律）。
 *
 * 用 createRequire 从 app 目录解析 `yaml`，跟 DSH 运行时用的是同一份依赖。
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const APP = '<repo-root>/build/dist/app';
const SETTINGS = '<repo-root>/build/dist/home/settings.yaml';

const require = createRequire(`${APP}/package.json`);
const YAML = require('yaml');

let text = readFileSync(SETTINGS, 'utf8');
if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

let doc;
try {
  doc = YAML.parse(text);
} catch (error) {
  console.log(`FAIL 解析失败：${error.message}`);
  process.exit(1);
}

const section = doc?.['dsh-better-sidebar'];
console.log('OK   settings.yaml 解析成功');
console.log(`顶层键：${Object.keys(doc).join(', ')}`);
console.log(`dsh-better-sidebar = ${JSON.stringify(section)}`);
console.log(`interceptOpenPath  = ${section?.interceptOpenPath}`);
console.log(`agentOpenTools     = ${section?.agentOpenTools}`);
console.log(`workspaceFence     = ${section?.workspaceFence}`);
console.log(section?.interceptOpenPath === false
  ? 'PASS 劫持已关闭（聊天里的路径将用系统默认程序打开）'
  : 'WARN 劫持仍然是开启的');
