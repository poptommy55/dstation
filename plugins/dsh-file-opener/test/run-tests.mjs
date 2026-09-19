/**
 * 测试入口：**在同一个进程里** import 全部测试文件。
 *
 * 为什么不 `node --test test/`：DSH 的文件沙箱禁止子进程通过管道通信，
 * 按目录跑多进程会直接 `spawn EPERM`（技能坑 #10）。
 * 也不要用 PowerShell 管道接 node 输出，直接跑、让输出原样回显。
 */

import { summary } from './harness.mjs';
import { run as runReveal } from './reveal.test.mjs';
import { run as runHost } from './host.test.mjs';
import { run as runClient } from './client.test.mjs';

console.log('— 参数构造 —');
await runReveal();

console.log('\n— 宿主半 —');
await runHost();

console.log('\n— 浏览器半 —');
await runClient();

process.exit(summary() ? 0 : 1);
