/**
 * 在资源管理器中显示一个文件（Windows 原生的「在文件夹中显示」）。
 *
 * 为什么不用宿主自带的 `openNativePath`：
 * 它只能「打开」——对文件是**用默认程序打开文件**，对目录是打开该目录。
 * 而「在文件夹中显示」的原生语义是 **打开父目录并选中该文件**
 * （`explorer.exe /select,<file>`）。两者不是一回事：
 *   · 打开目录 → 若该目录已有一个资源管理器窗口开着，往往只是把它切到前台，
 *     在用户看来就是「点了没反应」；
 *   · /select → 每次都会高亮选中那个文件，变化可见。
 *
 * 🔴🔴 参数写法是**实测出来的**，别按直觉改（见 test/spawn-probe.mjs）。
 *
 * 实测五种写法（目标是带空格 + 中文的文件名，最苛刻的样本）：
 *   A  ['/select,"<path>"']   参数自带引号  → ❌ 打开了「文档」默认位置
 *   B  ['/select,<path>']     交给 Node 引   → ❌ 打开了「文档」默认位置
 *   C  ['/select,', '<path>'] 两个参数       → ✅ 正确打开目标目录并选中
 *   D  cmd /c start /select,"<path>"         → ❓ 没有窗口
 *   E  ['/n', '/select,"<path>"']            → ❌ 打开了「文档」默认位置
 *
 * 为什么 A 会错：**Node 在 Windows 上会把 argv 重新拼成一条命令行**，
 * 参数里自带的引号会被再转义一层，explorer 解析不出来 ⇒ 回退到默认位置。
 *
 * ⚠️ 陷阱记一笔：用手动 `Start-Process -ArgumentList '/select,"<path>"'` 测是**好的**，
 * 因为那条路不做二次转义。**"换条路测通过"不等于"这条路能用"。**
 * 所以这里必须用 spawn + 两个参数，并有回归测试钉死参数形态（test/reveal.test.mjs）。
 */

import { spawn as nodeSpawn } from 'node:child_process';

/**
 * 转成 Windows 原生反斜杠形式。
 * 宿主 `/check` 返回的 realpath 是正斜杠（`C:/a/b.docx`），
 * explorer.exe 对正斜杠的容忍度不如反斜杠。
 * @param {string} p
 * @returns {string}
 */
export function toNativePath(p) {
  return String(p).replace(/\//g, '\\');
}

/**
 * 构造 explorer.exe 的参数列表。
 *
 * - 文件 → `['/select,', '<file>']` —— **两个元素**，绝不要合并成一个字符串，
 *   也绝不要自己加引号（见文件头的实测表）。
 * - 目录 → `['<dir>']` —— 对目录用 `/select,` 会去选中它的**父**目录，是错的。
 * @param {string} nativePath
 * @param {'file'|'dir'} kind
 * @returns {string[]}
 */
export function explorerArgs(nativePath, kind) {
  return kind === 'dir' ? [nativePath] : ['/select,', nativePath];
}

/**
 * 起一个 explorer.exe 去显示该路径。
 *
 * ⚠️ 两个必须点：
 *  1. `stdio: 'ignore'` —— 沙箱下子进程用管道 stdio 会 EPERM（技能坑 #10）；
 *  2. explorer.exe **正常退出码也是 1**，所以绝不能把退出码当失败判据。
 * @param {string} nativePath
 * @param {'file'|'dir'} kind
 * @param {{spawn?: Function}} [options] 注入点，供单测使用
 * @returns {string[]} 实际使用的参数
 */
export function revealInExplorer(nativePath, kind, options = {}) {
  const spawn = options.spawn ?? nodeSpawn;
  const args = explorerArgs(nativePath, kind);
  const child = spawn('explorer.exe', args, { stdio: 'ignore', windowsHide: false });
  // explorer 立刻 detach，父进程不等它；错误事件必须有人接，否则会抛未捕获异常
  if (child && typeof child.on === 'function') child.on('error', () => {});
  if (child && typeof child.unref === 'function') child.unref();
  return args;
}
