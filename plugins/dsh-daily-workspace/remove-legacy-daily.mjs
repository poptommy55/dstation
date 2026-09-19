/**
 * 从工作区注册表里删除「日常使用」的**旧登记**（绝对路径 D:\DSH\DH2\实验区）。
 *
 * 只摘登记，**不删文件夹、不删会话历史**（DSH 的语义：「removal never deletes
 * the folder or the session histories, which become ungrouped」）。
 * 那些会话会变成「未分组」，这是用户明确接受的。
 *
 * 幂等：已删除则报告"未找到"，不做任何写入。
 */
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.DSH_HOME;
const FILE = path.join(HOME, 'storages', 'workspace.json');
const TARGET_PATH = 'D:\\DSH\\DH2\\实验区';

const norm = (p) => String(p ?? '').replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
const want = norm(TARGET_PATH);

const raw = fs.readFileSync(FILE, 'utf8');
const doc = JSON.parse(raw);

const ids = doc?.global?.workspaceIds ?? [];
const table = doc?.tables?.workspaces ?? {};

const victims = [];
for (const [id, ws] of Object.entries(table)) {
  if (norm(ws?.path) === want) victims.push({ id, title: ws?.title, path: ws?.path, sessions: (ws?.sessionIds ?? []).length });
}
// 也兜一层：按标题匹配（万一路径写法不同）
if (victims.length === 0) {
  for (const [id, ws] of Object.entries(table)) {
    if (ws?.title === '日常使用') victims.push({ id, title: ws?.title, path: ws?.path, sessions: (ws?.sessionIds ?? []).length });
  }
}

if (victims.length === 0) {
  console.log('未找到匹配的工作区（可能已删除）。未做任何写入。');
  console.log('当前登记的工作区：');
  for (const [id, ws] of Object.entries(table)) console.log(`  - ${ws?.title}  ${ws?.path}  (${(ws?.sessionIds ?? []).length} 会话)`);
  process.exit(0);
}

console.log(`将删除 ${victims.length} 个工作区登记：`);
for (const v of victims) console.log(`  - 「${v.title}」 ${v.path}  含 ${v.sessions} 个会话`);

for (const v of victims) delete table[v.id];
doc.global.workspaceIds = ids.filter((id) => !victims.some((v) => v.id === id));

const backup = `${FILE}.bak-del-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)}`;
fs.copyFileSync(FILE, backup);
fs.writeFileSync(FILE, JSON.stringify(doc, null, 2) + '\n', 'utf8');

console.log(`\n已写入。备份：${backup}`);
console.log('剩余工作区：');
for (const ws of Object.values(doc.tables.workspaces)) console.log(`  - ${ws?.title}  ${ws?.path}  (${(ws?.sessionIds ?? []).length} 会话)`);
console.log(`\n注意：文件夹 ${TARGET_PATH} 与会话历史均未删除（只摘登记）。`);
