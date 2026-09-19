/**
 * reveal.js 的参数构造测试。
 *
 * 为什么单独测这一层、而且测得这么死：`explorer.exe /select,` 的参数是
 * **最容易静默出错**的地方，而且错了之后不报错 —— explorer 只是打开「文档」默认位置。
 * 实测（见 spawn-probe.mjs）只有「两个参数、都不加引号」这一种写法是对的，
 * 所以这里把参数形态**逐字钉死**，防止有人"顺手改成更自然的样子"。
 */

import { check } from './harness.mjs';
import { toNativePath, explorerArgs, revealInExplorer } from '../reveal.js';

export async function run() {
  check('正斜杠转 Windows 原生反斜杠',
    toNativePath('C:/Users/x/daily-use/a.docx') === 'C:\\Users\\x\\daily-use\\a.docx');

  check('反斜杠路径原样保留',
    toNativePath('C:\\a\\b.docx') === 'C:\\a\\b.docx');

  // ── 参数形态：下面这几条就是那个实测 bug 的回归测试 ──────────────
  const fileArgs = explorerArgs('C:\\a b\\c.docx', 'file');
  check('文件参数是**两个**元素（实测唯一正确的写法 C）',
    Array.isArray(fileArgs) && fileArgs.length === 2);
  check('第一个元素是裸的 /select,（不带路径、不带引号）', fileArgs[0] === '/select,');
  check('第二个元素是裸的路径（**自己加引号会被 Node 二次转义而失效**）',
    fileArgs[1] === 'C:\\a b\\c.docx');
  check('整个参数里没有任何引号', fileArgs.every((a) => !a.includes('"')));
  check('带中文的路径同样处理',
    JSON.stringify(explorerArgs('C:\\目录\\策划案.docx', 'file'))
      === JSON.stringify(['/select,', 'C:\\目录\\策划案.docx']));

  check('目录直接打开（对目录用 /select 会去选中它的**父**目录，是错的）',
    JSON.stringify(explorerArgs('C:\\a\\b', 'dir')) === JSON.stringify(['C:\\a\\b']));

  // ── 调用形态 ──────────────────────────────────────────────────
  const calls = [];
  const fakeSpawn = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return { on() {}, unref() {} };
  };

  revealInExplorer('C:\\a b\\c.docx', 'file', { spawn: fakeSpawn });
  check('调用的是 explorer.exe', calls[0]?.cmd === 'explorer.exe');
  check('传下去的也是两个参数（没有被中途合并）',
    JSON.stringify(calls[0]?.args) === JSON.stringify(['/select,', 'C:\\a b\\c.docx']));
  check('stdio 必须是 ignore（沙箱下管道会 EPERM，坑 #10）', calls[0]?.options?.stdio === 'ignore');

  let unrefCalled = false;
  revealInExplorer('C:\\a.docx', 'file', {
    spawn: () => ({ on() {}, unref() { unrefCalled = true; } })
  });
  check('子进程被 unref（不拖住父进程）', unrefCalled === true);

  let threw = false;
  try {
    revealInExplorer('C:\\a.docx', 'file', {
      spawn: () => { throw new Error('spawn 被拒绝'); }
    });
  } catch {
    threw = true;
  }
  check('spawn 抛错时向上传播（路由会转成可读错误）', threw === true);
}
