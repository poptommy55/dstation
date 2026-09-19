'use strict';
/**
 * D-STATION 在线升级（OTA）— 主进程侧核心逻辑
 *
 * 由 main.js require 并注入依赖，运行在 Electron 主进程内。
 *
 * 设计要点：
 * 1. **内容寻址增量**（v2，2026-09-15 起）：只下载本机缺失的对象，不再逐文件全量拉取。
 *    见 `ota-core.js`；实测已装 1.0.9 → 新版只需 15 个对象 / 0.48 MB（旧方案 2.1GB / 85 分钟）。
 * 2. 用户数据绝不写入 —— 受保护前缀直接拒绝，且是"白名单式"：只写清单显式列出的
 *    相对路径，不做任何目录级拷贝。
 * 3. 真正的文件替换交给独立进程 ota-updater.js —— Windows 下 dsh-launcher.exe
 *    与 runtime/node/node.exe 被独占锁，本进程无法自替换。
 *    本模块把要应用的文件**铺成 <staging>/<相对路径> 的目录树**，于是升级器
 *    完全不需要知道对象库的存在（v1 那套经过实战验证的备份/回滚逻辑原封不动）。
 *
 * 环境变量 DSTATION_OTA_MANIFEST 可覆盖清单地址（本地联调用）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const core = require('./ota-core.js');

// This repository ships NO update server of its own. Point DSTATION_OTA_MANIFEST at
// your own manifest URL. When it is unset the updater reports a clear error instead of
// silently contacting somebody else's server.
const DEFAULT_MANIFEST_URL = '';
// 延迟读取：允许运行时/测试设置 DSTATION_OTA_MANIFEST 覆盖清单地址
function manifestUrl() {
  return process.env.DSTATION_OTA_MANIFEST || DEFAULT_MANIFEST_URL;
}

const VERSION_FILE = 'dstation-version.json';
const STAGING_DIR = 'ota-staging';

// 用户数据 / 运行时状态：永不被升级覆盖
const PROTECTED_PREFIXES = [
  'home/knowledge-bases',
  'home/storages',
  'home/agent-sessions',
  'electron-data',
  'backups',
  'ota-staging'
];

function normRel(rel) {
  return String(rel == null ? '' : rel).replace(/\\/g, '/').replace(/^\.?\//, '').trim();
}

function isProtected(rel) {
  const p = normRel(rel);
  if (!p) return true;
  if (p.indexOf('..') >= 0) return true;
  for (let i = 0; i < PROTECTED_PREFIXES.length; i++) {
    const x = PROTECTED_PREFIXES[i];
    if (p === x || p.indexOf(x + '/') === 0) return true;
  }
  return false;
}

// 拆分 core / prerelease：'1.2.3-rc1+build' -> ['1.2.3', 'rc1']
function splitVer(v) {
  let s = String(v == null ? '0' : v);
  const plus = s.indexOf('+');
  if (plus >= 0) s = s.slice(0, plus);       // build metadata 不参与比较
  const i = s.indexOf('-');
  if (i < 0) return [s, ''];
  return [s.slice(0, i), s.slice(i + 1)];
}

function parseVer(coreStr) {
  return String(coreStr || '0').split(/[.\-_]/).map(function (s) {
    const n = parseInt(s, 10);
    return isNaN(n) ? 0 : n;
  });
}

// 遵循 semver 直觉：1.0.1 > 1.0.0；1.0.0-rc1 < 1.0.0
function cmpVer(a, b) {
  const va = splitVer(a), vb = splitVer(b);
  const x = parseVer(va[0]), y = parseVer(vb[0]);
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const p = x[i] || 0, q = y[i] || 0;
    if (p > q) return 1;
    if (p < q) return -1;
  }
  const pa = va[1], pb = vb[1];
  if (pa && !pb) return -1;   // 带预发布后缀的版本更小
  if (!pa && pb) return 1;
  if (pa && pb) return pa < pb ? -1 : (pa > pb ? 1 : 0);
  return 0;
}

function createOta(deps) {
  deps = deps || {};
  const base = deps.base;
  const log = deps.log || function () {};
  const emit = deps.onProgress || function () {};
  if (!base) throw new Error('createOta 需要 base（安装根目录）');

  function versionFilePath() { return path.join(base, VERSION_FILE); }

  function readVersionInfo() {
    try { return JSON.parse(fs.readFileSync(versionFilePath(), 'utf8')); }
    catch (e) { return { version: '0.0.0', build: '', updatedAt: '' }; }
  }

  function readVersion() {
    return String(readVersionInfo().version || '0.0.0');
  }

  /** 拉清单并做协议校验（v2 才支持；遇到旧格式明确报错，而不是静默失败） */
  async function fetchManifest() {
    const url = manifestUrl();
    if (!url) {
      throw new Error('No update source configured: set DSTATION_OTA_MANIFEST to your own manifest URL.');
    }
    const m = await core.fetchJson(url);
    if (!m || !m.version) throw new Error('清单缺少 version 字段');
    if (m.schema !== core.SCHEMA) {
      throw new Error('升级源协议不支持：期望 ' + core.SCHEMA + '，收到 '
        + (m.schema || '（旧格式 v1）')
        + '。请重新安装整包后再使用在线升级。');
    }
    if (!m.filesUrl || !m.objectBase) throw new Error('清单缺少 filesUrl / objectBase 字段');
    // Phase 3：验签（fail closed —— 没签名、签名不对、验签异常都拒绝）
    const v = core.verifyManifest(m);
    if (!v.ok) throw new Error('清单未通过签名验证：' + v.error);
    log('[OTA] 清单签名验证通过（ed25519）');
    return m;
  }

  // 只查不装（v2 清单只有几百字节，不再需要拉 33MB 全量清单）
  async function check() {
    const cur = readVersion();
    const m = await fetchManifest();
    const latest = String(m.version);
    return {
      current: cur,
      latest: latest,
      hasUpdate: cmpVer(latest, cur) > 0,
      blocked: '',
      notes: m.notes || '',
      releasedAt: m.releasedAt || '',
      gitCommit: m.gitCommit || '',
      gitTag: m.gitTag || '',
      fileCount: Number(m.fileCount) || 0,
      objectCount: Number(m.objectCount) || 0,
      totalSize: Number(m.totalSize) || 0,
      mode: 'v2'
    };
  }

  /**
   * 下载 + 校验 + 落到暂存目录（不改动任何现有文件）
   * ① 拉文件映射表 → ② 受保护路径闸门 → ③ 刷新本地内容索引
   * ④ 算差集 → ⑤ 只下载缺失对象 → ⑥ 铺成 <staging>/<rel> 树交给升级器
   */
  async function stage() {
    const cur = readVersion();
    const m = await fetchManifest();
    const latest = String(m.version);
    if (cmpVer(latest, cur) <= 0) throw new Error('当前已是最新版本（' + cur + '）');

    emit({ phase: 'fetchmap', msg: '拉取文件映射表…' });
    const fm = await core.fetchFileMap(m.filesUrl);

    // 两道闸门（都拒整包，不是跳过那一条）：
    //   ① 受保护路径（黑名单）—— 用户数据绝不被写入
    //   ② 白名单外路径 —— **治本**：打包端漏了什么都不会写到用户目录
    for (const rel of fm.map.keys()) {
      if (isProtected(rel)) throw new Error('清单包含受保护路径，已拒绝整包：' + rel);
      if (!core.isAllowedToWrite(rel)) throw new Error('清单包含白名单外的路径，已拒绝整包：' + rel);
    }

    emit({ phase: 'index', done: 0, total: fm.map.size });
    const idx = await core.refreshIndex(base, fm.map, function (done, total, rel) {
      emit({ phase: 'index', done: done, total: total, file: rel });
    });
    const st = idx.stats || { reused: 0, hashed: 0 };
    log('[OTA] 本地索引：' + fm.map.size + ' 个路径（复用 ' + st.reused + ' / 重算 ' + st.hashed + '）');

    const plan = core.computePlan(idx.files, fm.map, fm.objectSizes);
    emit({
      phase: 'plan', needObjects: plan.needObjects.length,
      applyPaths: plan.applyPaths.length, same: plan.sameCount
    });
    log('[OTA] 差集：需下载对象 ' + plan.needObjects.length + ' 个，需应用文件 '
      + plan.applyPaths.length + ' 个，内容已一致 ' + plan.sameCount + ' 个');

    const staging = path.join(base, STAGING_DIR, latest);

    // 内容已与目标一致、只是版本号落后 —— 开发机常态（源码目录就是打包源）。
    // 这时**不需要下载也不需要替换任何文件**，只要推进版本号；仍然返回一个 job
    // 交给升级器（它会写版本号并重启，却一个文件都不换）。
    if (!plan.applyPaths.length) {
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging, { recursive: true });
      log('[OTA] 本机内容已与 ' + latest + ' 一致，只推进版本号（不下载、不替换文件）');
      emit({ phase: 'staged', total: 0, bytes: 0, needObjects: 0, noop: true });
      return {
        version: latest, fromVersion: cur, staging: staging, files: [],
        stats: {
          same: plan.sameCount, applyPaths: 0, needObjects: 0, bytes: 0,
          links: 0, copies: 0, noop: true, gitCommit: m.gitCommit || ''
        }
      };
    }

    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    const pruned = core.pruneStaging(base, latest);
    if (pruned.length) log('[OTA] 清理旧暂存: ' + pruned.join(', '));

    let dl = { downloaded: 0, bytes: 0 };
    if (plan.needObjects.length) {
      emit({ phase: 'download', done: 0, total: plan.needObjects.length, bytes: 0 });
      dl = await core.downloadObjects({
        needObjects: plan.needObjects,
        objectBase: m.objectBase,
        shard: Number(m.objectShard) || 2,
        staging: staging,
        concurrency: Number(process.env.DSTATION_OTA_CONCURRENCY) || 12,
        onProgress: function (p) {
          emit({
            phase: 'download', done: p.done, total: p.total, file: p.sha,
            bytes: p.bytes, failed: p.failed
          });
        }
      });
      log('[OTA] 对象下载完成：' + dl.downloaded + ' 个 / ' + (dl.bytes / 1048576).toFixed(2) + ' MB');
    } else {
      emit({ phase: 'download', done: 0, total: 0, bytes: 0, msg: '无需下载（本机已有全部内容）' });
    }

    // 铺成 <staging>/<rel>：升级器据此覆盖，无需知道对象库
    const mat = core.materialize(staging, base, plan.applyPaths);
    if (!mat.files.length) throw new Error('没有可应用的文件（对象缺失或铺开失败）');
    if (mat.missing.length) {
      log('[OTA] ⚠ 有 ' + mat.missing.length + ' 个文件未能铺开，已跳过: '
        + mat.missing.slice(0, 3).join(', '));
    }
    log('[OTA] 铺开 ' + mat.files.length + ' 个文件（硬链接 ' + mat.links + ' / 复制 ' + mat.copies + '）');

    // 预写索引：目标内容 + mtime=0。
    // mtime=0 保证下次刷新时这些文件会被重算（拿到真实 mtime），索引自动校正 ——
    // 万一升级器失败回滚，索引也不会停留在错误状态；其余路径的缓存继续生效。
    try {
      const next = core.readIndex(base);
      next.files = next.files || {};
      for (const item of plan.applyPaths) {
        next.files[item.rel] = { sha: item.sha, size: item.size, mtimeMs: 0 };
      }
      core.writeIndex(base, next);
      log('[OTA] 本地索引已预写 ' + plan.applyPaths.length + ' 条（mtime=0，下次自动校正）');
    } catch (e) {
      log('[OTA] 索引预写失败（不影响升级）: ' + (e && e.message));
    }

    emit({ phase: 'staged', total: mat.files.length, bytes: dl.bytes, needObjects: plan.needObjects.length });
    return {
      version: latest,
      fromVersion: cur,
      staging: staging,
      files: mat.files,
      stats: {
        same: plan.sameCount,
        applyPaths: plan.applyPaths.length,
        needObjects: plan.needObjects.length,
        bytes: dl.bytes,
        links: mat.links,
        copies: mat.copies,
        gitCommit: m.gitCommit || ''
      }
    };
  }

  /* ==================== Phase 2：快照与回滚 ==================== */

  /** 列出可回滚的版本快照（升级器每次 apply 都会留一份） */
  function listSnapshots() {
    const root = path.join(base, 'backups', 'versions');
    const out = [];
    let names = [];
    try { names = fs.readdirSync(root); } catch (e) { return out; }
    for (const name of names) {
      const dir = path.join(root, name);
      const metaPath = path.join(dir, '_snapshot.json');
      if (!fs.existsSync(metaPath)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        out.push({
          version: String(j.version || name),
          createdAt: j.createdAt || '',
          fileCount: (j.files || []).length,
          addedCount: (j.added || []).length,
          dir: dir
        });
      } catch (e) { /* 元数据坏了就跳过，不让它挡住其它快照 */ }
    }
    out.sort(function (a, b) { return cmpVer(b.version, a.version); });
    return out;
  }

  /** 事务日志：applying / done / rolling-back / rolled-back / failed（可用来识别「升级中途断电」） */
  function readTx() {
    try { return JSON.parse(fs.readFileSync(path.join(base, 'ota-tx.json'), 'utf8')); }
    catch (e) { return null; }
  }

  /**
   * 启动回滚（独立进程执行，会先等本进程退出再动文件）。
   * 不传 version 则回到「最新的那份快照」。
   */
  function startRollback(version) {
    const snaps = listSnapshots();
    if (!snaps.length) throw new Error('没有可用的回滚快照（还没通过 OTA 升级过？）');
    let target = null;
    if (version) target = snaps.filter(function (s) { return s.version === version; })[0] || null;
    else target = snaps[0];
    if (!target) throw new Error('找不到版本 ' + version + ' 的快照；可用：' + snaps.map(function (s) { return s.version; }).join(', '));
    const cur = readVersion();
    if (target.version === cur) throw new Error('当前已经是 ' + cur + '，无需回滚');
    log('[OTA] 启动回滚 ' + cur + ' → ' + target.version + '（快照含 ' + target.fileCount + ' 个文件）');
    return launchUpdater({
      mode: 'rollback',
      version: target.version,
      fromVersion: cur,
      snapshotDir: target.dir,
      staging: target.dir,
      files: []
    });
  }

  // 启动独立升级器（它会等本进程退出后替换文件并重启）
  // Phase 2 起 job 带 mode/fromVersion/snapshotDir —— 升级器据此决定「升级」还是「回滚」
  function launchUpdater(job) {
    const tmpDir = path.join(os.tmpdir(), 'dstation-ota-' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    // 用 runtime 里的 node 复制一份，避免升级 runtime/node 时自己锁住自己
    const nodeSrc = path.join(base, 'runtime', 'node', 'node.exe');
    let runner;
    if (fs.existsSync(nodeSrc)) {
      runner = path.join(tmpDir, 'node.exe');
      fs.copyFileSync(nodeSrc, runner);
    } else {
      runner = process.execPath;
    }

    const scriptSrc = path.join(__dirname, 'ota-updater.js');
    const script = path.join(tmpDir, 'ota-updater.js');
    fs.copyFileSync(scriptSrc, script);

    const jobFile = path.join(tmpDir, 'job.json');
    fs.writeFileSync(jobFile, JSON.stringify({
      base: base,
      mode: job.mode || 'apply',
      staging: job.staging || '',
      snapshotDir: job.snapshotDir || '',
      fromVersion: job.fromVersion || '',
      version: job.version,
      files: job.files || [],
      keepSnapshots: 2,
      parentPid: process.pid,
      exePath: process.execPath,
      logFile: path.join(base, 'ota-update.log'),
      backupRoot: path.join(base, 'backups')
    }, null, 2), 'utf8');

    const child = spawn(runner, [script, jobFile], {
      detached: true, stdio: 'ignore', windowsHide: true, cwd: tmpDir
    });
    child.unref();
    log('[OTA] 升级器已启动 PID=' + child.pid + ' 目标版本 ' + job.version);
    return child.pid;
  }

  return {
    readVersion: readVersion,
    readVersionInfo: readVersionInfo,
    check: check,
    stage: stage,
    launchUpdater: launchUpdater,
    listSnapshots: listSnapshots,
    startRollback: startRollback,
    readTx: readTx,
    manifestUrl: manifestUrl()
  };
}

module.exports = {
  createOta: createOta,
  isProtected: isProtected,
  cmpVer: cmpVer,
  normRel: normRel,
  manifestUrl: manifestUrl,
  DEFAULT_MANIFEST_URL: DEFAULT_MANIFEST_URL,
  PROTECTED_PREFIXES: PROTECTED_PREFIXES
};
