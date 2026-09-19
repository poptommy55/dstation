/**
 * 探测：`explorer.exe /select,` 到底该怎么传给 Node 的 spawn。
 *
 * 背景（实测踩到）：我原本写的是 spawn('explorer.exe', ['/select,"<path>"'])，
 * 即**参数里自带引号**。但 Node 在 Windows 上会把整个 argv 重新拼成命令行，
 * 于是引号被再转义一层，explorer 解析不出来 —— 它会打开**默认位置（文档库）**，
 * 看起来就像"文件夹按钮跳到了别的地方"。
 *
 * 而手动用 `Start-Process -ArgumentList '/select,"<path>"'` 测是好的，
 * 因为那条路不做这层二次转义。**"换条路测通过"不等于"这条路能用"。**
 *
 * 用法：node spawn-probe.mjs <form> <target>
 * 本脚本只负责"起进程并把实际参数原样打出来"，窗口归属由外部枚举判定。
 */

import { spawn } from 'node:child_process';

const form = process.argv[2];
const target = process.argv[3];

/** 各种候选写法。 */
const FORMS = {
  // A：参数自带引号（我原来的写法，怀疑被二次转义）
  A: () => ['explorer.exe', [`/select,"${target}"`]],
  // B：不加引号，交给 Node 自己引（带空格的路径会被整段引起来）
  B: () => ['explorer.exe', [`/select,${target}`]],
  // C：拆成两个参数
  C: () => ['explorer.exe', ['/select,', target]],
  // D：走 cmd 的 start（由 cmd 负责解析引号）
  D: () => ['cmd.exe', ['/c', 'start', '', `/select,"${target}"`]],
  // E：/n 强制新窗口 + 自带引号
  E: () => ['explorer.exe', ['/n', `/select,"${target}"`]]
};

if (FORMS[form] === undefined) {
  console.log(`未知写法：${form}`);
  process.exit(2);
}

const [command, args] = FORMS[form]();
const child = spawn(command, args, { stdio: 'ignore', windowsHide: false });
child.on('error', (error) => {
  console.log(JSON.stringify({ form, error: String(error.message) }));
});
child.unref();

// 把实际使用的参数原样打出来，便于与"窗口落到哪"对照
console.log(JSON.stringify({ form, command, args }));
setTimeout(() => process.exit(0), 500);
