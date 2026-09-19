'use strict';
/**
 * D-STATION OTA 独立升级器
 *
 * 由 ota.js 以「分离进程」方式启动（跑在临时目录里的 node 副本上）。
 * 为什么必须是独立进程：Windows 下正在运行的 dsh-launcher.exe 与
 * runtime/node/node.exe 被独占锁，主进程无法替换自己。
 *
 * ============================ Phase 2（2026-09-15）============================
 * 目标：把「升级」从"一次性覆盖 + 事后无法回头"变成"有快照、可回滚"。
 *
 * 为什么不用「版本化目录 + 指针切换」（那是最理想的原子切换）：
 *   DSH 把 <安装根>/app、/home、/resources/app 等路径写死在启动器与运行时里，
 *   把程序搬进 <根>/versions/<ver>/ 会让启动器找不到文件 —— 结构不能动。
 *
 * 所以改用**硬链接快照**：
 *   · 升级前把将被覆盖的每个文件**硬链接**到 backups/versions/<旧版本>/<相对路径>
 *     → 零内容拷贝、几乎不占额外空间（同盘同 inode）
 *   · 覆盖时**必须先 unlink 再写**（replaceFile）—— 否则 copyFile 会写穿快照的
 *     inode，把快照内容也一起改掉，快照就白做了（这是本方案最容易踩的坑）
 *   · 升级时**新建**的文件记进 added 列表，回滚时删除它们
 *   · 事务日志 ota-tx.json 记录 applying/done/rolled-back —— 用于识别「上次升级
 *     中途断电」这种中断态
 *
 * 两种模式（job.mode）：
 *   apply（默认） 等主进程退出 → 快照 → 覆盖 → 写版本号 → 重启
 *   rollback      等主进程退出 → 用快照恢复 → 删除新增文件 → 写回旧版本号 → 重启
 *
 * 用法：node ota-updater.js <job.json>
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const jobFile = process.argv[2];
if (!jobFile || !fs.existsSync(jobFile)) {
  try { process.stderr.write('ota-updater: job.json 不存在\n'); } catch (e) {}
  process.exit(2);
}

let job;
try { job = JSON.parse(fs.readFileSync(jobFile, 'utf8')); }
catch (e) { process.exit(2); }

const MODE = job.mode === 'rollback' ? 'rollback' : 'apply';
const LOG_FILE = job.logFile || path.join(job.base, 'ota-update.log');
const TX_FILE = path.join(job.base, 'ota-tx.json');
const VERSION_FILE = path.join(job.base, 'dstation-version.json');
const SNAPSHOT_ROOT = path.join(job.backupRoot || path.join(job.base, 'backups'), 'versions');
const KEEP_SNAPSHOTS = Number(job.keepSnapshots) || 2;

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg + '\n';
  try { fs.appendFileSync(LOG_FILE, line, 'utf8'); } catch (e) {}
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; }
}

async function waitExit(pid, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!pidAlive(pid)) return true;
    await sleep(400);
  }
  return false;
}

const PROTECTED_PREFIXES = [
  'home/knowledge-bases',
  'home/storages',
  'home/agent-sessions',
  'electron-data',
  'backups',
  'ota-staging'
];

// 宿主二进制/运行时：即使出现在清单里也绝不覆盖（被运行进程独占，覆盖会失败/损坏）。
// 与 _ota_rules.cjs 的 LOCKED_PREFIXES 保持一致。
const LOCKED_PREFIXES = [
  'dsh-launcher.exe',
  'runtime'
];

function isProtected(rel) {
  const p = String(rel == null ? '' : rel).replace(/\\/g, '/');
  if (!p || p.indexOf('..') >= 0) return true;
  for (let i = 0; i < PROTECTED_PREFIXES.length; i++) {
    const x = PROTECTED_PREFIXES[i];
    if (p === x || p.indexOf(x + '/') === 0) return true;
  }
  return false;
}

function isLocked(rel) {
  const p = String(rel == null ? '' : rel).replace(/\\/g, '/');
  for (let i = 0; i < LOCKED_PREFIXES.length; i++) {
    const x = LOCKED_PREFIXES[i];
    if (p === x || p.indexOf(x + '/') === 0) return true;
  }
  return false;
}

/* ============================ Phase 2 基础设施 ============================ */

/** 硬链接快照：零内容拷贝；跨盘/不支持时回退复制 */
function snapshotFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try { if (fs.existsSync(dst)) fs.unlinkSync(dst); } catch (e) {}
  try { fs.linkSync(src, dst); return 'link'; }
  catch (e) { fs.copyFileSync(src, dst); return 'copy'; }
}

/**
 * 覆盖文件 —— **必须先 unlink 再写**。
 * 直接 copyFileSync 到已存在的路径会写穿它，而快照正是靠硬链接共享同一个 inode，
 * 那样等于把快照也改掉了（Phase 2 最关键的细节）。
 */
function replaceFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try { if (fs.existsSync(dst)) fs.unlinkSync(dst); } catch (e) {}
  fs.copyFileSync(src, dst);
}

function writeJson(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, p);
  } catch (e) { log('⚠ 写 ' + path.basename(p) + ' 失败: ' + (e && e.message)); }
}

/** 事务日志：用于识别「上次升级中途断电」的中断态 */
function writeTx(phase, extra) {
  const cur = readTx() || {};
  writeJson(TX_FILE, Object.assign(cur, extra || {}, {
    phase: phase,
    updatedAt: new Date().toISOString(),
  }));
}
function readTx() {
  try { return JSON.parse(fs.readFileSync(TX_FILE, 'utf8')); } catch (e) { return null; }
}

function readVersionFile() {
  try { return JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8')); } catch (e) { return { version: '0.0.0' }; }
}

/** 只保留最近 N 个版本快照（连同老式 ota-<ts> 备份不动，那是历史遗留） */
function pruneSnapshots(keepDir) {
  let dirs = [];
  try {
    dirs = fs.readdirSync(SNAPSHOT_ROOT, { withFileTypes: true })
      .filter(function (d) { return d.isDirectory(); })
      .map(function (d) { return d.name; });
  } catch (e) { return []; }
  dirs.sort();                       // 版本号字典序 ≈ 时间序（x.y.z）
  const doomed = dirs.filter(function (n) { return n !== keepDir; }).slice(0, Math.max(0, dirs.length - KEEP_SNAPSHOTS));
  const removed = [];
  for (const n of doomed) {
    try { fs.rmSync(path.join(SNAPSHOT_ROOT, n), { recursive: true, force: true }); removed.push(n); }
    catch (e) { /* 占用中则下次再清 */ }
  }
  return removed;
}

function relaunch() {
  try {
    const c = spawn(job.exePath, [], { detached: true, stdio: 'ignore', cwd: job.base });
    c.unref();
    log('已重新启动: ' + job.exePath);
  } catch (e) {
    log('启动失败: ' + (e && e.message));
  }
}

/* ============================ apply ============================ */

async function doApply() {
  const files = job.files || [];
  const fromVersion = String(job.fromVersion || readVersionFile().version || '0.0.0');
  const snapshotDir = path.join(SNAPSHOT_ROOT, fromVersion);

  log('=== OTA 升级器启动 === [apply] 目标版本 ' + job.version + ' 文件数 ' + files.length
    + ' （源版本 ' + fromVersion + '）');

  try { fs.mkdirSync(snapshotDir, { recursive: true }); } catch (e) {}
  log('快照目录: ' + snapshotDir);

  const snapFiles = [];    // 被备份的原文件（回滚时恢复）
  const added = [];        // 升级时新建的文件（回滚时删除）
  const applied = [];
  const skipped = [];
  let linkCount = 0, copyCount = 0;

  writeTx('applying', {
    fromVersion: fromVersion,
    toVersion: job.version,
    startedAt: new Date().toISOString(),
    snapshotDir: snapshotDir,
    total: files.length,
  });

  for (let i = 0; i < files.length; i++) {
    const rel = files[i];
    if (isProtected(rel)) { log('跳过受保护路径: ' + rel); continue; }
    if (isLocked(rel)) { log('跳过锁定二进制（交由安装包升级）: ' + rel); continue; }

    const src = path.join(job.staging, rel);
    const dst = path.join(job.base, rel);
    if (!fs.existsSync(src)) { log('暂存缺失，跳过: ' + rel); skipped.push(rel); continue; }

    // 单文件写入失败（多为仍被运行进程占用）→ 跳过 + 告警，不回滚整包，
    // 避免"一个文件锁住导致全部更新回滚"。其余文件照常更新。
    try {
      if (fs.existsSync(dst)) {
        const bak = path.join(snapshotDir, rel);
        if (!fs.existsSync(bak)) {
          const how = snapshotFile(dst, bak);
          if (how === 'link') linkCount++; else copyCount++;
          snapFiles.push(rel);
        }
      } else {
        added.push(rel);
      }
      replaceFile(src, dst);
      applied.push(rel);
      log('已更新 (' + (i + 1) + '/' + files.length + '): ' + rel);
    } catch (e) {
      log('⚠ 跳过（写入失败，可能仍被占用）: ' + rel + ' — ' + ((e && e.message) || e));
      skipped.push(rel);
    }
  }

  // 快照元数据（回滚的依据）
  writeJson(path.join(snapshotDir, '_snapshot.json'), {
    version: fromVersion,
    createdAt: new Date().toISOString(),
    files: snapFiles,
    added: added,
    note: '硬链接快照 ' + linkCount + ' / 复制 ' + copyCount + '；回滚时恢复 files 并删除 added',
  });

  if (fs.existsSync(VERSION_FILE)) fs.copyFileSync(VERSION_FILE, path.join(snapshotDir, '_dstation-version.json'));
  fs.writeFileSync(VERSION_FILE, JSON.stringify({
    version: job.version,
    build: new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14),
    updatedAt: new Date().toISOString()
  }, null, 2), 'utf8');
  log('版本号已写入 -> ' + job.version);

  writeTx('done', {
    finishedAt: new Date().toISOString(),
    applied: applied.length, skipped: skipped.length,
    snapshotFiles: snapFiles.length, added: added.length,
  });

  const pruned = pruneSnapshots(fromVersion);
  if (pruned.length) log('清理旧快照: ' + pruned.join(', '));

  log('升级成功：替换 ' + applied.length + ' 个文件（快照 ' + snapFiles.length
    + ' 个：硬链接 ' + linkCount + ' / 复制 ' + copyCount + '；新增 ' + added.length + '）'
    + (skipped.length ? '，跳过 ' + skipped.length + ' 个被占用文件' : ''));
  if (skipped.length) log('⚠ 有 ' + skipped.length + ' 个文件因被占用未更新（多为运行时/宿主二进制），建议重启后再次检查更新或重装。');
  relaunch();
  log('=== 升级器结束 ===');
}

/* ============================ rollback ============================ */

async function doRollback() {
  log('=== OTA 升级器启动 === [rollback] 回滚到 ' + job.version);

  const snapDir = job.snapshotDir || path.join(SNAPSHOT_ROOT, String(job.version));
  const metaPath = path.join(snapDir, '_snapshot.json');
  if (!fs.existsSync(metaPath)) {
    log('!! 找不到快照元数据，放弃回滚（未做任何改动）: ' + metaPath);
    process.exit(3);
  }
  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); }
  catch (e) { log('!! 快照元数据损坏，放弃回滚: ' + e.message); process.exit(3); }

  writeTx('rolling-back', {
    fromVersion: job.fromVersion || '',
    toVersion: meta.version,
    startedAt: new Date().toISOString(),
    snapshotDir: snapDir,
  });

  let restored = 0, removed = 0, failed = 0;
  for (const rel of (meta.files || [])) {
    if (isProtected(rel) || isLocked(rel)) continue;
    const src = path.join(snapDir, rel);
    const dst = path.join(job.base, rel);
    if (!fs.existsSync(src)) { log('快照缺失，跳过: ' + rel); failed++; continue; }
    try { replaceFile(src, dst); restored++; log('已恢复: ' + rel); }
    catch (e) { failed++; log('⚠ 恢复失败: ' + rel + ' — ' + ((e && e.message) || e)); }
  }

  // 升级时新建的文件：回滚时删除（它们本来不存在）
  for (const rel of (meta.added || [])) {
    const dst = path.join(job.base, rel);
    try { if (fs.existsSync(dst)) { fs.unlinkSync(dst); removed++; } }
    catch (e) { failed++; log('⚠ 删除失败: ' + rel + ' — ' + ((e && e.message) || e)); }
  }

  fs.writeFileSync(VERSION_FILE, JSON.stringify({
    version: meta.version,
    build: new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14),
    updatedAt: new Date().toISOString(),
    rolledBackFrom: job.fromVersion || '',
  }, null, 2), 'utf8');

  writeTx('rolled-back', {
    finishedAt: new Date().toISOString(),
    restored: restored, removed: removed, failed: failed,
  });

  log('回滚完成：恢复 ' + restored + ' 个文件，删除 ' + removed + ' 个新增文件'
    + (failed ? '，失败 ' + failed + ' 个' : '') + ' → 版本 ' + meta.version);
  relaunch();
  log('=== 升级器结束 ===');
}

/* ============================ 入口 ============================ */

(async function main() {
  log('等待主进程退出 PID=' + job.parentPid);
  const exited = await waitExit(job.parentPid, 90000);
  if (!exited) {
    log('主进程 90 秒内未退出，放弃操作（未做任何改动，程序仍在正常运行）');
    process.exit(3);
  }
  await sleep(2000); // 等文件句柄彻底释放

  try {
    if (MODE === 'rollback') await doRollback();
    else await doApply();
    process.exit(0);
  } catch (e) {
    log('!! 失败: ' + ((e && e.stack) || e));
    writeTx('failed', { finishedAt: new Date().toISOString(), error: String((e && e.message) || e) });
    process.exit(1);
  }
})();
