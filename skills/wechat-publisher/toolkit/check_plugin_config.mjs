// 插件配置校验：对每一行调用插件自己的 resolveConfig()（如果导出了）。
//
// 为什么需要它：宿主的「发现」只查组合结构 + 包是否存在，插件自身的配置校验
// 要到【挂载】时才跑。漏一个必填配置 → 发现显示 OK、挂载抛异常 → 智能体被系统禁用。
// 这个脚本把挂载阶段会跑的那段代码提前跑一遍。
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

const APP = '<repo-root>/build/dist/app';
const rowsFile = process.argv[2];
// 去掉 BOM：Windows PowerShell 的 `Out-File -Encoding utf8` 会写入 BOM，
// 而 JSON.parse 遇到 BOM 直接抛 "Unexpected token"，看起来像文件内容坏了。
const raw = readFileSync(rowsFile, 'utf8').replace(/^\uFEFF/, '');
const rows = JSON.parse(raw);

const require = createRequire(APP + '/package.json');

let checked = 0, withResolver = 0, failed = 0;

for (const row of rows) {
  const { id, name, config } = row;
  if (!name || name.includes(':')) continue;   // cordis: 内置构造跳过
  checked++;
  let entry;
  try {
    entry = require.resolve(name);
  } catch (e) {
    console.log(`  ⚪ ${id.padEnd(24)} ${name} —— 无法解析入口，跳过`);
    continue;
  }
  let mod;
  try {
    mod = await import(pathToFileURL(entry).href);
  } catch (e) {
    console.log(`  ❌ ${id.padEnd(24)} ${name} —— 模块加载失败: ${String(e.message).slice(0, 120)}`);
    failed++;
    continue;
  }
  const resolver = mod.resolveConfig ?? mod.default?.resolveConfig;
  if (typeof resolver !== 'function') {
    console.log(`  ·  ${id.padEnd(24)} ${name} —— 无 resolveConfig，未校验配置`);
    continue;
  }
  withResolver++;
  try {
    resolver(config ?? {});
    console.log(`  ✅ ${id.padEnd(24)} ${name} —— 配置通过`);
  } catch (e) {
    console.log(`  ❌ ${id.padEnd(24)} ${name} —— 配置校验失败`);
    console.log(`       ${String(e.message).slice(0, 200)}`);
    failed++;
  }
}

console.log(`\n检查 ${checked} 个插件行，其中 ${withResolver} 个有 resolveConfig，失败 ${failed} 个`);
process.exit(failed ? 1 : 0);
