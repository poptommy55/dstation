/**
 * 重打补丁：让侧栏「新对话」默认落在「日常使用」分区。
 *
 * ⚠️ 需要打**两个**文件 —— 这是实测踩出来的：
 *
 *   1. **`@michengai/dsh-archive-manager/lib/client.js`** ← **真正生效的那一份**
 *      该插件自带侧栏与归档 UI，**把 `dsh-client-ui-workspace` 的客户端整个接管了**
 *      （内部有 WorkspaceBrowser / WorkspacePicker / startSession 的完整副本，
 *      且 `dsh-client-ui-workspace` 根本不出现在服务端发出的模块清单里）。
 *      判据：服务端发出的 bundle 里 `recentWorkspace()` 出现 2 次，
 *      而 workspace 包版本的 `recentWorkspace(workspace.items, sessions.byId)` 出现 **0 次**。
 *
 *   2. `@deepseek-ai/dsh-client-ui-workspace/lib/client.js` ← 后备
 *      当前不生效（被上面那个接管），但**若哪天卸载 archive-manager 它就会接管**，
 *      所以一并打上，避免那时默认失效。
 *
 * DSH / 插件更新会覆盖这两处，症状是「新建会话不再默认日常使用」。
 * 那时运行本脚本即可重打：幂等、自动备份、语法校验不过自动回滚。
 *
 * 用法：node patch-dsh-daily-default.mjs
 * 退出码：0 = 成功或本来就是最新；1 = 失败
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DIST = process.env.DSH_DIST;
if (!DIST) {
  console.error('请先用 DSH_DIST 指定 D-STATION 安装根目录（含 app/ 与 home/ 的那一级）。');
  process.exit(2);
}
const APP = path.join(DIST, 'app', 'node_modules', '@deepseek-ai');
const PROFILE = path.join(DIST, 'home', 'profiles', 'web', 'node_modules');

const MARKER = '[补丁 dsh-daily-default]';
const ANCHOR = 'const target = workspaceId ?? currentWorkspaceId ?? recent;';

const COMMENTS = [
  '// [补丁 dsh-daily-default] 新会话默认落在「日常使用」分区。',
  '// 按 canonical path 结尾匹配 daily-use，而不是按标题 —— 改标题不影响。',
  '// 未指定 workspaceId 时优先它，其次才继承当前/最近分区；',
  '// 用户在 hero 里显式改选时会带着 workspaceId 进来，所以改选仍落入他选的分区。',
];

/** 两个目标的局部变量名不同，所以替换文本分开写。 */
const TARGETS = [
  {
    label: 'archive-manager（真正生效）',
    file: path.join(PROFILE, '@michengai', 'dsh-archive-manager', 'lib', 'client.js'),
    indent: '\n            ',
    dailyLine: 'const dailyUseId = workspaceState.phase === "ready" ? (workspaceState.items ?? []).find((item) => typeof item.path === "string" && /[\\\\/]daily-use$/i.test(item.path))?.workspaceId : void 0;',
  },
  {
    label: 'dsh-client-ui-workspace（后备）',
    file: path.join(APP, 'dsh-client-ui-workspace', 'lib', 'client.js'),
    indent: '\n\t\t\t\t',
    dailyLine: 'const dailyUseId = workspace.phase === "ready" ? workspace.items.find((item) => typeof item.path === "string" && /[\\\\/]daily-use$/i.test(item.path))?.workspaceId : void 0;',
  },
];

let failures = 0;

for (const target of TARGETS) {
  const { label, file, indent, dailyLine } = target;
  if (!fs.existsSync(file)) {
    console.log(`- ${label}\n    文件不存在，跳过：${file}`);
    continue;
  }
  const source = fs.readFileSync(file, 'utf8');

  if (source.includes(MARKER)) {
    console.log(`✓ ${label}\n    补丁已存在，无需重打`);
    continue;
  }

  const occurrences = source.split(ANCHOR).length - 1;
  if (occurrences !== 1) {
    console.error(`✗ ${label}\n    锚点出现 ${occurrences} 次（应为 1 次），需人工重新定位：\n      ${ANCHOR}`);
    failures += 1;
    continue;
  }

  const replacement = [...COMMENTS, dailyLine, ANCHOR.replace('?? recent', '?? dailyUseId ?? recent')].join(indent);
  const backup = `${file}.bak-daily-default-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)}`;
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, source.replace(ANCHOR, replacement), 'utf8');

  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    fs.copyFileSync(backup, file);
    console.error(`✗ ${label}\n    语法校验失败，已回滚：${error?.message ?? error}`);
    failures += 1;
    continue;
  }
  console.log(`✓ ${label}\n    已打补丁，备份：${path.basename(backup)}`);
}

console.log('');
if (failures > 0) {
  console.error(`完成，但有 ${failures} 个目标失败。`);
  process.exit(1);
}
console.log('OK: 全部目标就绪。重启 DSH 后，点侧栏「新对话」应默认落在「日常使用」分区。');
