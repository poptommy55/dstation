// dsh-launcher — Electron desktop shell for DeepSeek Harness web UI
// - spawns dsh web (bundled portable node) as sidecar, isolated DSH_HOME
// - picks a free port 3080..3099, single instance per directory (file lock)
// - loads the tokenized URL inside a native window (no browser)
// - close/minimize -> tray; real exit only via tray menu
// - watchdog: sidecar exit -> auto restart + reload; page load failure -> retry
'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, ipcMain, shell } = require('electron');

// ---- window-anchored dialogs ----
// A bare `dialog.*` call is owned by the OS/global window stack, so it can end up
// behind (or on top of) the web UI and looks like a foreign "Windows" popup.
// Passing the BrowserWindow makes Electron attach the dialog to our own window.
function liveWin() {
  try { return (win && !win.isDestroyed()) ? win : null; } catch (e) { return null; }
}
function showBox(opts) {
  const w = liveWin();
  return w ? dialog.showMessageBox(w, opts) : dialog.showMessageBox(opts);
}
function showError(message) {
  const w = liveWin();
  log('[错误框] ' + String(message).split('\n')[0]);
  if (w) {
    return dialog.showMessageBox(w, {
      type: 'error', title: APP_NAME, buttons: ['确定'], message: String(message)
    });
  }
  return dialog.showErrorBox(APP_NAME, String(message));
}
// GPU: hardware acceleration ON by default; if the GPU process crashes (rare
// machines/sandboxed envs), auto-relaunch once in software-render mode.
if (process.env.DSHLAUNCH_SW_RENDER === '1') app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('node:zlib');
// 在线升级模块（隔离加载：旧安装包里没有 ota.js 时不应导致外壳启动失败）
let createOta = null;
try { createOta = require('./ota').createOta; }
catch (e) { /* OTA 模块缺失，本次运行禁用升级功能 */ }

// 本地文件桥（同样隔离加载）：把 composer 上传的文件写进会话工作目录，
// 供 DSH 官方的 @路径 引用机制交给模型读取。见 files.js 顶部的安全边界说明。
// 同一模块另导出 createSkills —— 技能库（home/skills）的读写删通道，供技能面板使用；
// 根固定死在 <BASE>/home/skills，不与上传通道共用白名单逻辑（见 files.js 注释）。
let createFiles = null;
let createSkills = null;
try {
  const _files = require('./files');
  createFiles = _files.createFiles;
  createSkills = _files.createSkills;
} catch (e) { /* 文件桥缺失，上传文档的落盘功能禁用（抽文本仍可用） */ }

// ---- session self-heal (prevents "interrupted generation leaves a deadlocked
// conversation" across restarts) ----
// When a generation is interrupted mid-tool-call, dsh may persist a turn whose
// `request/header` never got an `assistant/*` reply, plus a `pending` marker in
// the projection cache. On next load the session is stuck: new messages queue
// forever. We fix it at launcher startup, before dsh web boots, by truncating
// each session at the last clean `session/end-seed` before the dangling turn.
// zstd is multi-frame (each append = one frame); we decode frames individually
// and only recompress the single frame that contains the cut, with the same
// checksummed zstd dsh uses, so the result stays byte-compatible.
const SH_ZSTD_MAGIC = 4247762216;
const SH_CHECKSUM_OPTIONS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
function sh_scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== SH_ZSTD_MAGIC) break;
    offset += 4;
    if (offset === buffer.length) break;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) break;
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) break;
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) break;
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}
function sh_decodeFrames(buffer, frames) {
  const out = [];
  for (const f of frames) out.push(zlib.zstdDecompressSync(buffer.subarray(f.start, f.end)));
  return Buffer.concat(out);
}
function sh_parseEvents(plaintext) {
  return plaintext.toString('utf-8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}
// index of first event of the first turn that contains a `request/header` with
// no `assistant/*` reply before its `turn/end`; -1 if none.
function sh_findDanglingTurnStart(events) {
  for (let i = 0; i < events.length; i++) {
    if (events[i].type !== 'request/header') continue;
    let bad = true;
    for (let j = i + 1; j < events.length; j++) {
      if (events[j].type === 'turn/start') break;
      if (events[j].type && events[j].type.startsWith('assistant/')) { bad = false; break; }
    }
    if (!bad) continue;
    let turnStart = i;
    for (let k = i; k >= 0; k--) {
      if (events[k].type === 'turn/start') { turnStart = k; break; }
    }
    let cut = turnStart;
    for (let k = turnStart - 1; k >= 0; k--) {
      if (events[k].type === 'session/end-seed') { cut = k + 1; break; }
    }
    return cut;
  }
  return -1;
}
function sh_healSessionBuffer(buffer) {
  const frames = sh_scanZstdFrames(buffer);
  if (frames.length === 0) return null;
  const events = sh_parseEvents(sh_decodeFrames(buffer, frames));
  const cutIndex = sh_findDanglingTurnStart(events);
  if (cutIndex <= 0 || cutIndex >= events.length) return null;
  let evCursor = 0, cutFrame = -1;
  const frameEventCounts = [];
  for (let fi = 0; fi < frames.length; fi++) {
    const cnt = sh_parseEvents(sh_decodeFrames(buffer, [frames[fi]])).length;
    frameEventCounts.push(cnt);
    if (cutFrame === -1) {
      if (evCursor + cnt > cutIndex) cutFrame = fi;
      evCursor += cnt;
    }
  }
  if (cutFrame === -1) cutFrame = frames.length - 1;
  const linesBeforeCutFrame = frameEventCounts.slice(0, cutFrame).reduce((a, b) => a + b, 0);
  const localCut = cutIndex - linesBeforeCutFrame;
  const parts = [];
  for (let fi = 0; fi < cutFrame; fi++) parts.push(buffer.subarray(frames[fi].start, frames[fi].end));
  const cutFrameLines = sh_parseEvents(sh_decodeFrames(buffer, [frames[cutFrame]]));
  const kept = cutFrameLines.slice(0, localCut);
  if (kept.length > 0) {
    parts.push(zlib.zstdCompressSync(Buffer.from(kept.join('\n') + '\n', 'utf-8'), SH_CHECKSUM_OPTIONS));
  }
  return Buffer.concat(parts);
}
function sh_readdirDirsSync(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (e) { return []; }
}
function sh_healAllSessions(homeDir, log) {
  const sessionsRoot = path.join(homeDir, 'sessions');
  if (!fs.existsSync(sessionsRoot)) { log('[自愈] sessions 目录不存在: ' + sessionsRoot); return; }
  let fixed = 0, checked = 0;
  // dsh stores sessions as sessions/<workspace-dir>/<session-uuid-dir>/session.jsonl.zstd
  for (const ws of sh_readdirDirsSync(sessionsRoot)) {
    const wsPath = path.join(sessionsRoot, ws);
    for (const sess of sh_readdirDirsSync(wsPath)) {
      const fp = path.join(wsPath, sess, 'session.jsonl.zstd');
      if (!fs.existsSync(fp)) continue;
      checked++;
      try {
        const buf = fs.readFileSync(fp);
        const healed = sh_healSessionBuffer(buf);
        if (healed && healed.length > 0 && !healed.equals(buf)) {
          fs.copyFileSync(fp, fp + '.bak-' + Date.now());
          fs.writeFileSync(fp, healed);
          fixed++;
          log('[自愈] 修复悬挂会话: ' + ws + '/' + sess);
        }
      } catch (e) {
        log('[自愈] 跳过 ' + ws + '/' + sess + ': ' + e.message);
      }
    }
  }
  if (fixed > 0) {
    for (const name of ['session_projcache', 'session_projcache_archive_manager_v2']) {
      const p = path.join(homeDir, 'storages', name);
      if (fs.existsSync(p)) {
        try { fs.rmSync(p, { recursive: true, force: true }); log('[自愈] 清除投影缓存: ' + name); }
        catch (e) { log('[自愈] 清缓存失败 ' + name + ': ' + e.message); }
      }
    }
  }
  log('[自愈] 检查 ' + checked + ' 个会话，修复 ' + fixed + ' 个');
}

// ---- base dir resolution ----
// packaged: exe sits in bundle root next to runtime\ app\ home\
// dev: use DSHLAUNCH_BASE env, fallback to __dirname
let BASE;
const exeDir = path.dirname(process.execPath);
if (fs.existsSync(path.join(exeDir, 'runtime', 'node', 'node.exe'))) {
  BASE = exeDir;
} else if (process.env.DSHLAUNCH_BASE) {
  BASE = process.env.DSHLAUNCH_BASE;
} else {
  BASE = __dirname;
}

const PORT_START = 3080, PORT_END = 3099;
const READY_TIMEOUT_MS = 180000;   // sidecar HTTP ready timeout (first boot assembles profile, can be slow)
const TOKEN_WAIT_MS = 20000;       // extra wait for the token URL line after HTTP is up
const SPLASH_MAX_MS = 150000;      // splash safety net: never outlive the sidecar wait
const CONTENT_PROBE_MS = 45000;    // how long to wait for the SPA to actually render before revealing
const MAX_RESTART = 5;             // watchdog: max auto-restarts of the sidecar
const RESTART_DELAY_MS = 2000;     // watchdog: delay before restarting sidecar
const LOAD_RETRY = 5;              // max page-load retries
const LOG_FILE = path.join(BASE, 'launcher.log');
const LOCK_FILE = path.join(BASE, 'launcher.lock');

let win = null;
let tray = null;
let child = null;
let splash = null;
let tokenUrl = null;
let pickedPort = 0;
let quitting = false;
let restartCount = 0;
let loadRetries = 0;
let sidecarNode = null;
let sidecarScript = null;
let revealed = false;   // has the main window been shown at least once?
let recentLog = '';     // rolling tail of sidecar output, used to detect fatal plugin errors
let lastPluginFailure = null;      // { id, pkg, reason, transient, core }
let pluginFailureHandled = false;  // only ask the user once per launch
let transientRetries = 0;          // how many times we cleared locks and retried
let rendererLog = '';              // rolling tail of renderer console errors
let frontendFailureHandled = false;

const APP_NAME = 'D-STATION';

// ---- plugin failure detection -------------------------------------------
// A plugin that fails to import (usually because it targets a newer dsh than
// the one bundled here) aborts the whole boot with "plugin tree failed to
// load". That is deterministic: restarting can never fix it, so burning all 5
// watchdog retries just shows a blank screen. Instead we identify the offending
// plugin and ask the user whether to disable it.
const PLUGIN_FAIL_RE = [
  /failed to import loader entry\s+([^\s(]+)\s*\(([^)]*)\)\s*:?\s*([^\n]*)/,
  /failed to apply loader entry\s+([^\s(]+)\s*\(([^)]*)\)\s*:?\s*([^\n]*)/
];

// Transient failures: the plugin code is fine, the environment was busy (e.g. a
// stale writer lock left behind by a killed process). Never disable anything for
// these — clearing the lock and retrying is the correct fix.
const TRANSIENT_ERR_RE = /timed out waiting for the writer lock|atomic-write|EBUSY|EAGAIN|ELOCKED|resource temporarily unavailable/i;

// Official / load-bearing entries must never be auto-disabled. Disabling one of
// these turns a small hiccup into a guaranteed boot failure for every plugin
// that depends on it (e.g. `connection` -> everything "waiting for service").
const CORE_ENTRY_IDS = new Set([
  'connection', 'web', 'settings', 'sandbox-policy', 'fs-sandbox',
  'session-log-export', 'client-connection', 'base', 'web-app'
]);
function isCoreEntry(id, pkg) {
  if (CORE_ENTRY_IDS.has(id)) return true;
  if (/^@deepseek-ai\//.test(pkg)) return true;   // any official package
  if (/^cordis:/.test(pkg)) return true;
  return false;
}

function detectPluginFailure(text) {
  if (!text) return null;
  // covers both sides: host-side boot abort AND renderer-side client-module failure
  if (!/plugin tree failed to load|does not provide an export|Cannot find package|Cannot find module|Failed to load plugins|missed the module table/.test(text)) return null;
  for (const re of PLUGIN_FAIL_RE) {
    const m = text.match(re);
    if (!m) continue;
    const id = (m[1] || '').trim();
    const pkg = (m[2] || '').trim();
    // skip internal loader plumbing entries (cordis:include etc.)
    if (!id || id.startsWith('cordis:') || id === 'include' || id === 'group') continue;
    const reason = (m[3] || '').trim();
    return {
      id,
      pkg: pkg || id,
      reason,
      transient: TRANSIENT_ERR_RE.test(reason) || TRANSIENT_ERR_RE.test(text),
      core: isCoreEntry(id, pkg || id)
    };
  }
  return null;
}

// Remove stale *.lock files under the dsh home. Only safe to call while no dsh
// process is alive (we call it from the watchdog after the sidecar has exited).
function clearStaleLocks() {
  const homeDir = path.join(BASE, 'home');
  let removed = 0;
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full, depth + 1); continue; }
      if (!/\.lock$/.test(e.name)) continue;
      try {
        const st = fs.statSync(full);
        // A live lock is held by a running process; a stale one is tiny and old.
        const ageMs = Date.now() - st.mtimeMs;
        if (st.size <= 64 && ageMs > 30000) {
          fs.unlinkSync(full);
          removed++;
          log('[锁] 已清理陈旧锁: ' + full + ' (' + st.size + 'B, ' + Math.round(ageMs / 1000) + 's 前)');
        }
      } catch (e) { /* best effort */ }
    }
  };
  walk(homeDir, 0);
  return removed;
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function patchHasDisable(text, id) {
  const lines = text.split(/\r?\n/);
  const idRe = new RegExp('^\\s*- id:\\s*' + escapeRe(id) + '\\s*$');
  for (let i = 0; i < lines.length; i++) {
    if (!idRe.test(lines[i])) continue;
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      if (/^\s*disabled:\s*true\s*$/.test(lines[j])) return true;
      if (/^\s*-\s+id:/.test(lines[j])) break;
    }
  }
  return false;
}

function disablePluginInPatch(entryId) {
  const p = path.join(BASE, 'home', 'profiles', 'web', 'cordis.patch.yml');
  let text = '';
  try { text = fs.readFileSync(p, 'utf8'); } catch (e) { text = ''; }
  if (patchHasDisable(text, entryId)) return { skipped: true, file: p };
  try { if (text) fs.writeFileSync(p + '.bak-' + Date.now(), text, 'utf8'); } catch (e) {}
  const block = '\n# [auto] 看门狗自动禁用：该插件加载失败导致 dsh 无法启动。\n'
    + '# 删除下面两行即可恢复；或在插件市场卸载。\n'
    + '- id: ' + entryId + '\n  disabled: true\n';
  fs.writeFileSync(p, text.replace(/\s*$/, '') + '\n' + block, 'utf8');
  return { skipped: false, file: p };
}

async function askAboutPluginFailure() {
  const f = lastPluginFailure;
  const name = f.pkg || f.id;
  const detail = (f.reason || '(无详细信息)').slice(0, 400);
  if (revealed) closeSplash(); else setSplashStatus('插件加载失败：' + name, '正在等待你处理');
  log('[看门狗] 检测到确定性插件错误，停止无意义重试: ' + name);

  // test hook: run the detection path without popping a modal (used by the
  // fault-injection self-test so it never blocks an unattended machine)
  if (process.env.DSH_LAUNCHER_TEST_NO_DIALOG) {
    log('[测试] 静默模式：已识别插件 ' + f.id + '（pkg=' + f.pkg + '），本应弹出禁用询问框');
    return;
  }

  const res = await showBox({
    type: 'error',
    buttons: ['禁用该插件并重启', '我自己处理（退出）'],
    defaultId: 0,
    cancelId: 1,
    title: APP_NAME + ' - 插件导致启动失败',
    message: '插件「' + name + '」加载失败，dsh 服务无法启动。',
    detail: '一般是该插件要求更新版本的 dsh，与当前版本不兼容。\n\n'
      + '错误：' + detail + '\n\n'
      + '· 禁用该插件并重启：在 home\\profiles\\web\\cordis.patch.yml 写入 disabled: true，然后自动重启 dsh。\n'
      + '· 我自己处理（退出）：程序退出，你可以到插件市场卸载它。'
  });
  if (quitting) return;

  if (res.response !== 0) {
    log('[看门狗] 用户选择自行处理，退出。');
    try {
      await showBox({
        type: 'info', title: APP_NAME, buttons: ['确定'],
        message: '请重新启动后在「插件市场」里卸载「' + name + '」。',
        detail: '也可以手动编辑 home\\profiles\\web\\cordis.patch.yml，加入：\n\n- id: ' + f.id + '\n  disabled: true'
      });
    } catch (e) {}
    realQuit();
    return;
  }

  try {
    const r = disablePluginInPatch(f.id);
    log('[看门狗] 已禁用 ' + f.id + (r.skipped ? '（patch 中已存在，未重复写入）' : ''));
    restartCount = 0;
    lastPluginFailure = null;
    recentLog = '';
    setSplashStatus('已禁用「' + name + '」，正在重启…', '');
    startSidecar();
    const ready = await waitHttpReady(pickedPort, READY_TIMEOUT_MS);
    if (quitting) return;
    if (!ready) { log('[看门狗] 禁用后服务仍未就绪（进程若再退出会继续由看门狗接管）'); return; }
    const url = (await waitToken(TOKEN_WAIT_MS)) || ('http://127.0.0.1:' + pickedPort);
    if (quitting) return;
    if (win && !win.isDestroyed()) { log('[看门狗] 服务已恢复，重载页面'); navigate(win, url); }
    else { log('[看门狗] 服务已恢复，重建主窗口'); createWindow(url); }
  } catch (e) {
    log('[看门狗] 自动禁用失败: ' + e.message);
    showError('自动禁用失败：' + e.message + '\n请手动编辑 home\\profiles\\web\\cordis.patch.yml');
  }
}

// ---- renderer-side (client module) plugin failures ------------------------
// Some plugins load fine on the host but their browser bundle requires a
// @deepseek-ai client package that this dsh build does not ship. The sidecar
// stays alive in that case, so the host-side watchdog never sees it - only the
// UI dies ("Failed to load plugins"). We watch renderer console output and,
// when we recognize a plugin, offer to strip just its client entry so the rest
// of the app (and the plugin's host-side tools) keep working.
function stripPluginClient(pkgName) {
  const p = path.join(BASE, 'home', 'profiles', 'web', 'node_modules', pkgName, 'package.json');
  const raw = fs.readFileSync(p, 'utf8');
  const j = JSON.parse(raw);
  let changed = false;
  if (j.exports && j.exports['./client']) { delete j.exports['./client']; changed = true; }
  if (j.dsh && j.dsh.client) { delete j.dsh.client; changed = true; }
  if (!changed) return { skipped: true, file: p };
  fs.writeFileSync(p + '.bak-' + Date.now(), raw, 'utf8');
  fs.writeFileSync(p, JSON.stringify(j, null, 2), 'utf8');
  return { skipped: false, file: p };
}

function maybeHandleFrontendPluginFailure() {
  if (frontendFailureHandled) return;
  const f = detectPluginFailure(rendererLog);
  if (!f) return;
  frontendFailureHandled = true;
  log('[前端] 插件加载失败: pkg=' + f.pkg + ' entryId=' + f.id + ' | ' + (f.reason || '').slice(0, 200));
  askAboutFrontendPluginFailure(f).catch((e) => log('[前端] 处理异常: ' + e.message));
}

async function askAboutFrontendPluginFailure(f) {
  const name = f.pkg || f.id;
  if (process.env.DSH_LAUNCHER_TEST_NO_DIALOG) {
    log('[测试] 静默模式：前端插件 ' + name + ' 加载失败，本应弹出询问框');
    return;
  }
  const res = await showBox({
    type: 'error',
    buttons: ['停用它的界面并重启', '退出，我自己卸载'],
    defaultId: 0,
    cancelId: 1,
    title: APP_NAME + ' - 插件界面加载失败',
    message: '插件「' + name + '」的界面模块加载失败，主界面已卡住。',
    detail: '它的浏览器端代码依赖当前 dsh 版本里不存在的模块，通常是插件版本太新。\n\n'
      + '错误：' + (f.reason || '(无详细信息)').slice(0, 300) + '\n\n'
      + '· 停用它的界面并重启：移除该插件的客户端入口（保留服务端功能），然后重启 dsh。\n'
      + '· 退出，我自己卸载：程序退出，你可以到插件市场卸载「' + name + '」。'
  });
  if (quitting) return;

  if (res.response !== 0) {
    log('[前端] 用户选择自行处理，退出。');
    realQuit();
    return;
  }

  try {
    const r = stripPluginClient(name);
    log('[前端] 已移除 ' + name + ' 的客户端入口' + (r.skipped ? '（本来就没有 client 入口）' : ''));
    rendererLog = '';
    // the client boot manifest is generated by the host, so the sidecar must
    // restart for the change to take effect
    cleanupChild();
    await new Promise((r2) => setTimeout(r2, 800));
    restartCount = 0;
    startSidecar();
    const ready = await waitHttpReady(pickedPort, READY_TIMEOUT_MS);
    if (quitting) return;
    if (!ready) { log('[前端] 重启后服务未就绪'); return; }
    const url = (await waitToken(TOKEN_WAIT_MS)) || ('http://127.0.0.1:' + pickedPort);
    if (quitting) return;
    if (win && !win.isDestroyed()) { log('[前端] 服务恢复，重载页面'); navigate(win, url); }
    else { log('[前端] 服务恢复，重建窗口'); createWindow(url); }
  } catch (e) {
    log('[前端] 停用客户端失败: ' + e.message);
    showError('停用失败：' + e.message + '\n请手动删除 home\\profiles\\web\\node_modules\\' + name + ' 目录。');
  }
}

function log(msg) {
  const line = '[' + new Date().toTimeString().slice(0, 8) + '] ' + msg;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
}

function readConfiguredPort() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(BASE, 'config.json'), 'utf8'));
    if (cfg && Number.isInteger(cfg.port) && cfg.port > 0) return cfg.port;
  } catch (e) {}
  return 0;
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

async function pickPort() {
  const configured = readConfiguredPort();
  if (configured > 0) {
    if (await portIsFree(configured)) return configured;
    log('config.json 指定的端口 ' + configured + ' 被占用，改用自动分配');
  }
  for (let p = PORT_START; p <= PORT_END; p++) {
    if (await portIsFree(p)) return p;
  }
  return -1;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

function writeLock(token) {
  try { fs.writeFileSync(LOCK_FILE, process.pid + '|' + pickedPort + '|' + (token || '')); } catch (e) {}
}

function releaseLock() {
  try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch (e) {}
}

function killTree(pid) {
  try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch (e) {}
}

function cleanupChild() {
  if (child && child.exitCode === null) killTree(child.pid);
}

// HTTP-level readiness: TCP accept alone is not enough, require a real HTTP response
function httpAlive(port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs || 2500 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.once('timeout', () => { req.destroy(); resolve(false); });
    req.once('error', () => resolve(false));
  });
}

async function waitHttpReady(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) return false;
    if (await httpAlive(port)) return true;
    await new Promise((r) => setTimeout(r, 600));
  }
  return false;
}

async function waitToken(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!tokenUrl && Date.now() < deadline) {
    if (child && child.exitCode !== null) return null;
    await new Promise((r) => setTimeout(r, 300));
  }
  return tokenUrl;
}

// ---- splash (loading) window ----
function createSplash() {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'splash.png'));
    const sz = img.getSize();
    let w = sz.width || 800, h = sz.height || 500;
    const maxW = 900, scale = w > maxW ? maxW / w : 1;
    w = Math.round(w * scale); h = Math.round(h * scale);
    splash = new BrowserWindow({
      width: w,
      height: h,
      frame: false,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      // NOTE: no `alwaysOnTop` — the splash must not block other windows. It stays
      // visible (transparent, skipTaskbar) until the main window is ready, so the
      // user never sees a blank screen during a 30s+ cold boot. We intentionally
      // do NOT hide on blur — see the note below the ready-to-show handler.
      center: true,
      transparent: true,
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    splash.loadFile(path.join(__dirname, 'splash.html'));
    splash.once('ready-to-show', () => { if (splash) splash.show(); });
    // The splash is a courtesy, not a roadblock: it must not steal focus or block
    // other windows, but it must NOT disappear on blur. During a cold boot the main
    // window is not created for 30s+, so hiding on blur would leave a blank screen
    // and the user would think the app had vanished. Keep it visible until `revealed`
    // (main window ready) or the SPLASH_MAX_MS safety net below destroys it.
    // safety net: the splash must never outlive the sidecar wait. It used to be
    // a hard 10s which, on a cold boot (30-60s), left a blank window behind.
    const s2 = splash;
    setTimeout(() => {
      if (s2 && !s2.isDestroyed()) {
        log('[splash] ' + (SPLASH_MAX_MS / 1000) + 's 兜底强制关闭');
        try { s2.destroy(); } catch (e) {}
        if (splash === s2) splash = null;
      }
    }, SPLASH_MAX_MS);
  } catch (e) { log('[splash] 创建失败: ' + e.message); splash = null; }
}

// update the phase text shown on the splash (cold boot can take a while)
function setSplashStatus(text, tip) {
  if (!splash || splash.isDestroyed()) return;
  const js = '(function(){ if (window.setStatus) { window.setStatus(' +
    JSON.stringify(text || '') + ', ' + JSON.stringify(tip === undefined ? '' : tip) + '); } })()';
  try { splash.webContents.executeJavaScript(js).catch(() => {}); } catch (e) {}
}

function closeSplash() {
  if (!splash || splash.isDestroyed()) { splash = null; return; }
  log('[splash] 开始淡出（0.5s）');
  const s = splash;
  splash = null;
  const DURATION = 500; // 0.5s fade-out
  const start = Date.now();
  const timer = setInterval(() => {
    try {
      if (s.isDestroyed()) { clearInterval(timer); return; }
      const t = (Date.now() - start) / DURATION;
      if (t >= 1) { clearInterval(timer); s.destroy(); log('[splash] 已关闭'); return; }
      s.setOpacity(1 - t);
    } catch (e) { clearInterval(timer); try { s.destroy(); } catch (e2) {} }
  }, 30);
}

function showWindow() {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  // 启动中（win 尚未就绪）：把可能被隐藏/残留的 splash 重新唤回，
  // 避免二次点击 ICON 或托盘「显示窗口」时毫无反应。
  if (splash && !splash.isDestroyed()) {
    try { splash.show(); splash.focus(); } catch (e) {}
  } else {
    // 极端兜底：splash 已销毁但主窗口还没出来，重建一个提示窗。
    try { createSplash(); setSplashStatus('正在启动，请稍候…', '本地服务装配中'); } catch (e) {}
  }
}

function navigate(win2, url) {
  try { win2.loadURL(url); } catch (e) { log('[窗口] loadURL 异常: ' + e.message); }
}

// L1 止血方案：中断大模型后 composer 可能卡死（发出去的消息不渲染、再输入无响应）。
// 此时只重载前端页面即可恢复 —— 不动 dsh 服务、不杀 sidecar、会话与历史全部保留。
// 触发方式：窗口内 F5 / Ctrl+R / Cmd+R / Ctrl+F5，或托盘菜单「重新加载界面」。
// 注意：重载会丢掉输入框里尚未发送的内容（等同浏览器刷新）。
function reloadFrontend(reason) {
  if (!win || win.isDestroyed()) return;
  let target = tokenUrl || '';
  if (!target && win.webContents) {
    try { target = win.webContents.getURL() || ''; } catch (e) { target = ''; }
  }
  if (!target) target = 'http://127.0.0.1:' + pickedPort;
  log('[前端] 手动重载界面（' + (reason || '手动') + '）url=' + target);
  navigate(win, target);
}

// dsh is an SPA: "ready-to-show" fires on the first painted frame, which is still
// an empty shell. Reveal only once real content is in the DOM, otherwise a cold
// boot shows a blank window for tens of seconds.
function waitContentReady(w, timeoutMs) {
  const probe = `(function(){
    try {
      var r = document.getElementById('root');
      if (r && r.childElementCount > 0) return true;
      var b = document.body;
      if (b && b.innerText && b.innerText.trim().length > 20) return true;
    } catch (e) {}
    return false;
  })()`;
  return (async () => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!w || w.isDestroyed()) return false;
      try {
        if (await w.webContents.executeJavaScript(probe)) return true;
      } catch (e) {}
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  })();
}

function revealWindow(reason) {
  if (revealed) return;
  revealed = true;
  if (win && !win.isDestroyed()) { win.show(); win.focus(); }
  log('[窗口] 显示主窗口（' + reason + '）');
  closeSplash();
}

async function waitAndReveal() {
  const ok = await waitContentReady(win, CONTENT_PROBE_MS);
  if (quitting) return;
  revealWindow(ok ? '页面内容已渲染' : '内容探测超时，强制显示');
}

function createWindow(url) {
  revealed = false;
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    title: APP_NAME,
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: '#1a1d24',
    show: false,
    webPreferences: (function () {
      const wp = { contextIsolation: true, nodeIntegration: false };
      const pre = path.join(__dirname, 'ota-preload.js');
      if (fs.existsSync(pre)) wp.preload = pre;   // 旧安装包无此文件时保持原行为
      return wp;
    })()
  });
  win.setMenuBarVisibility(false);
  navigate(win, url);
  // collect renderer errors: this is where client-module plugin failures show up.
  // Electron ships both the legacy (level, message, ...) and the new
  // (event.level / event.message) signatures - accept either.
  win.webContents.on('console-message', (event, legacyLevel, legacyMessage) => {
    let level = legacyLevel;
    let message = legacyMessage;
    if (event && typeof event.level === 'string') { level = event.level; message = event.message; }
    const isError = typeof level === 'string'
      ? (level === 'error' || level === 'warning')
      : (Number(level) >= 1);
    if (!isError) return;
    rendererLog = (rendererLog + '\n' + String(message)).slice(-8000);
    maybeHandleFrontendPluginFailure();
  });
  win.webContents.on('did-finish-load', () => {
    // funnel uncaught page errors into console so the listener above sees them
    win.webContents.executeJavaScript(
      "window.addEventListener('error',function(e){console.error('[dsh-frontend] '+(e.message||'')+' '+((e.error&&e.error.stack)||''))});"
      + "window.addEventListener('unhandledrejection',function(e){var r=e.reason;console.error('[dsh-frontend] '+((r&&(r.stack||r.message))||r))});"
    ).catch(() => {});
  });
  // window stays hidden until real content is rendered (see waitContentReady)
  win.webContents.on('did-finish-load', () => {
    log('[窗口] 页面加载完成，等待内容渲染...');
    waitAndReveal();
  });
  // hard fallback: never keep the user staring at the splash forever
  setTimeout(() => revealWindow('兜底超时'), CONTENT_PROBE_MS + 10000);
  // D-STATION brand injection on every page load (replaces dsh logo/wordmark in DOM)
  win.webContents.on('did-finish-load', () => {
    loadRetries = 0; // successful load resets the retry counter
    try {
      const js = fs.readFileSync(path.join(__dirname, 'brand-inject.js'), 'utf8')
        .replace('__DSTATION_LOGO_B64__', fs.readFileSync(path.join(__dirname, 'icon.png')).toString('base64'));
      win.webContents.executeJavaScript(js).then(() => {
        log('[品牌] D-STATION 注入完成');
      }).catch((e) => log('[品牌] 注入失败: ' + e.message));
    } catch (e) { log('[品牌] 读取注入脚本失败: ' + e.message); }
  });
  // the dsh page sets its own <title>; block it so the window always shows D-STATION
  win.on('page-title-updated', (e) => { e.preventDefault(); });

  // L1 止血：F5 / Ctrl+R / Cmd+R / Ctrl+Shift+R -> 只重载前端（服务与会话保留）
  win.webContents.on('before-input-event', (event, input) => {
    if (!input || input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    const k = input.key;
    if (k === 'F5' || (mod && (k === 'r' || k === 'R'))) {
      event.preventDefault();
      reloadFrontend(mod ? 'Ctrl/Cmd+R' : 'F5');
    }
  });

  // 关闭/最小化 -> 任务栏最小化（窗口保留任务栏图标；真正退出仅从托盘菜单）
  win.on('close', (e) => {
    if (!quitting) { e.preventDefault(); win.minimize(); }
  });
  win.on('closed', () => { win = null; });

  // page load failure -> auto retry (server restarting, slow boot, etc.)
  win.webContents.on('did-fail-load', (e, code, desc, url2) => {
    log('[窗口] 页面加载失败 code=' + code + ' ' + desc + ' url=' + url2);
    if (code === -3) return; // ERR_ABORTED: navigation superseded, not an error
    if (quitting) return;
    if (loadRetries < LOAD_RETRY) {
      loadRetries++;
      log('[窗口] 2s 后自动重试加载（第 ' + loadRetries + '/' + LOAD_RETRY + ' 次）');
      setTimeout(() => {
        if (!quitting && win && !win.isDestroyed()) {
          navigate(win, tokenUrl || ('http://127.0.0.1:' + pickedPort));
        }
      }, 2000);
    }
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME + ' (dsh-launcher)');
  const menu = Menu.buildFromTemplate([
    { label: '打开主窗口', click: () => showWindow() },
    { label: '重新加载界面 (F5)', click: () => { showWindow(); reloadFrontend('托盘菜单'); } },
    { type: 'separator' },
    { label: '检查更新…', click: () => trayCheckUpdate() },
    { label: '重启系统', click: () => relaunchApp() },
    { label: '退出（停止 dsh 服务）', click: () => realQuit() }
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', () => showWindow());
  tray.on('click', () => showWindow());
}

function realQuit() {
  if (quitting) return;
  quitting = true;
  log('托盘退出：正在停止 dsh 服务...');
  cleanupChild();
  releaseLock();
  try { if (tray) tray.destroy(); } catch (e) {}
  try { if (win) win.destroy(); } catch (e) {}
  app.exit(0);
}

// 托盘菜单「重启系统」：停止 dsh 服务与当前外壳，再整应用重新拉起（含 sidecar）。
// 必须先 cleanupChild + releaseLock，否则新实例会因端口/锁冲突启动失败。
function relaunchApp() {
  if (quitting) return;
  quitting = true;
  log('托盘重启：正在停止 dsh 服务并重新启动 ' + APP_NAME + '...');
  cleanupChild();
  releaseLock();
  try { if (tray) tray.destroy(); } catch (e) {}
  try { if (win) win.destroy(); } catch (e) {}
  try { app.relaunch({ args: process.argv.slice(1) }); } catch (e) { log('[重启] relaunch 失败: ' + e.message); }
  app.exit(0);
}

// ==================== 在线升级（OTA）集成 ====================
// 三块：① 初始化 ota 模块 ② 托盘「检查更新…」 ③ 给插件面板用的 IPC 接口
// 安全边界：所有写盘都发生在 ota.js 的暂存目录 + 独立升级器 ota-updater.js，
// 本进程不直接覆盖任何运行中的文件。
let ota = null;

function onOtaProgress(p) {
  try { if (win && !win.isDestroyed()) win.webContents.send('dstation:ota:progress', p); } catch (e) {}
}

function initOta() {
  if (!createOta) { log('[OTA] 模块缺失，升级功能禁用（旧安装包属正常）'); return null; }
  try {
    ota = createOta({ base: BASE, log: log, onProgress: onOtaProgress });
    log('[OTA] 就绪 | 当前版本 ' + ota.readVersion() + ' | 清单 ' + ota.manifestUrl);
  } catch (e) {
    ota = null;
    log('[OTA] 初始化失败: ' + (e && e.message));
  }
  return ota;
}

// 托盘菜单「检查更新…」：查一次并弹窗告知结果，有更新则询问是否升级
async function trayCheckUpdate() {
  if (!ota) {
    await showBox({
      type: 'info', title: APP_NAME, buttons: ['确定'],
      message: '当前安装包不含在线升级模块。'
    });
    return;
  }
  try {
    showWindow();
    const r = await ota.check();
    if (r.blocked) throw new Error(r.blocked);
    if (!r.hasUpdate) {
      await showBox({
        type: 'info', title: APP_NAME + ' 更新', buttons: ['确定'],
        message: '当前已是最新版本。',
        detail: '当前版本：' + r.current + '\n服务器版本：' + r.latest
      });
      return;
    }
    const mb = (r.totalSize / 1048576).toFixed(2);
    const res = await showBox({
      type: 'question', title: APP_NAME + ' 更新', buttons: ['立即升级', '稍后'],
      defaultId: 0, cancelId: 1,
      message: '发现新版本 ' + r.latest,
      detail: '当前版本：' + r.current
        + '\n待更新文件：' + r.fileCount + ' 个（约 ' + mb + ' MB）'
        + (r.notes ? '\n\n更新说明：' + r.notes : '')
        + '\n\n升级会下载并逐文件校验，随后自动重启 ' + APP_NAME + '。'
    });
    if (res.response !== 0) return;
    await doOtaInstall();
  } catch (e) {
    await showError('检查更新失败：' + (e && e.message ? e.message : e));
  }
}

// 下载 → SHA256 校验 → 落暂存 → 启动独立升级器 → 退出本进程
async function doOtaInstall() {
  if (!ota) throw new Error('升级模块不可用');
  log('[OTA] 开始下载新版本…');
  const staged = await ota.stage();
  log('[OTA] 已暂存 ' + staged.files.length + ' 个文件，目标版本 ' + staged.version);
  await showBox({
    type: 'info', title: APP_NAME + ' 更新', buttons: ['确定'],
    message: '新版本已下载并校验通过',
    detail: '版本：' + staged.version + '\n升级文件：' + staged.files.length + ' 个'
      + '\n\n点击「确定」后 ' + APP_NAME + ' 将重启以完成升级（约数秒）。'
  });
  ota.launchUpdater(staged);
  // 让升级器接管：先停服务、再退出外壳（升级器在等本进程退出）
  setTimeout(function () {
    try { realQuit(); } catch (e) { app.exit(0); }
  }, 700);
}

function registerOtaIpc() {
  ipcMain.handle('dstation:ota:version', function () {
    if (!ota) return { ok: false, error: '当前安装包不含在线升级模块' };
    try { return { ok: true, info: ota.readVersionInfo(), manifest: ota.manifestUrl }; }
    catch (e) { return { ok: false, error: String(e && e.message) }; }
  });

  ipcMain.handle('dstation:ota:check', async function () {
    if (!ota) return { ok: false, error: '当前安装包不含在线升级模块' };
    try { return { ok: true, result: await ota.check() }; }
    catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  });

  ipcMain.handle('dstation:ota:install', async function () {
    if (!ota) return { ok: false, error: '当前安装包不含在线升级模块' };
    try {
      const staged = await ota.stage();
      ota.launchUpdater(staged);
      setTimeout(function () { try { realQuit(); } catch (e) { app.exit(0); } }, 700);
      return {
        ok: true, version: staged.version, files: staged.files.length,
        noop: !!(staged.stats && staged.stats.noop),
        stats: staged.stats || null
      };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  // Phase 2：列出可回滚的快照 + 事务日志（识别「上次升级中途断电」的中断态）
  ipcMain.handle('dstation:ota:snapshots', function () {
    if (!ota) return { ok: false, error: '当前安装包不含在线升级模块' };
    try {
      return { ok: true, current: ota.readVersion(), snapshots: ota.listSnapshots(), tx: ota.readTx() };
    } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  });

  // Phase 2：回滚到某个快照版本（不传则回最新的一份）。同样要退出主进程，由升级器接手。
  ipcMain.handle('dstation:ota:rollback', function (_evt, version) {
    if (!ota) return { ok: false, error: '当前安装包不含在线升级模块' };
    try {
      const pid = ota.startRollback(version || '');
      setTimeout(function () { try { realQuit(); } catch (e) { app.exit(0); } }, 700);
      return { ok: true, pid: pid };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });
}

// ==================== 本地文件桥（composer 上传文档落盘） ====================
// 目的：给「上传文件」按钮一条把文件写进会话工作目录的通路，落点由 DSH 官方的
// @路径 引用机制消费（模型据此调工具读取）。安全边界全部在 files.js 内强制执行。
let files = null;
let skills = null;

function initFiles() {
  // 技能库通道：即使上传桥缺失也独立尝试（两者互不依赖）
  if (createSkills) {
    try {
      skills = createSkills({ base: BASE, log: log, trash: function (p) { return shell.trashItem(p); } });
      log('[SKILLS] 就绪，根 = ' + skills.root);
    } catch (e) {
      skills = null;
      log('[SKILLS] 初始化失败: ' + (e && e.message));
    }
  } else {
    log('[SKILLS] 模块缺失，技能面板的文件操作禁用');
  }
  if (!createFiles) { log('[FILES] 模块缺失，文档落盘功能禁用'); return null; }
  try {
    files = createFiles({ base: BASE, log: log });
    log('[FILES] 就绪');
  } catch (e) {
    files = null;
    log('[FILES] 初始化失败: ' + (e && e.message));
  }
  return files;
}

function registerFilesIpc() {
  ipcMain.handle('dstation:files:roots', function () {
    if (!files) return { ok: false, error: '当前安装包不含文件桥模块' };
    try { return { ok: true, roots: files.allowRoots(), maxBytes: files.MAX_BYTES }; }
    catch (e) { return { ok: false, error: String(e && e.message) }; }
  });

  ipcMain.handle('dstation:files:save', function (_event, payload) {
    if (!files) return { ok: false, error: '当前安装包不含文件桥模块' };
    try { return files.save(payload); }
    catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  });
}

// ==================== 技能库 IPC（技能面板专用） ====================
// 与 files 桥分离注册：技能面板需要 list/read/write/remove 四个动作，
// 且全部锁定在 <BASE>/home/skills（路径校验在 files.js 内，这里只做参数转发）。
function registerSkillsIpc() {
  const guard = function () {
    if (!skills) return { ok: false, error: '当前安装包不含技能库模块（请升级 D-STATION）' };
    return null;
  };

  ipcMain.handle('dstation:skills:list', function () {
    const g = guard(); if (g) return g;
    try { return { ok: true, root: skills.root, skills: skills.list() }; }
    catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  });

  ipcMain.handle('dstation:skills:read', function (_event, name) {
    const g = guard(); if (g) return g;
    try { return skills.read(name); }
    catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  });

  ipcMain.handle('dstation:skills:write', function (_event, payload) {
    const g = guard(); if (g) return g;
    try {
      const p = payload || {};
      return skills.write(p.name, p.text);
    } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  });

  ipcMain.handle('dstation:skills:remove', function (_event, name) {
    const g = guard(); if (g) return g;
    try { return Promise.resolve(skills.remove(name)); }
    catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  });

  // 导入技能：压缩包（base64 字节）或一组松散文件（每项 { name, data: base64 }）
  ipcMain.handle('dstation:skills:import-zip', function (_event, payload) {
    const g = guard(); if (g) return g;
    try {
      const p = payload || {};
      return skills.importZip(p.buffer != null ? p.buffer : p.data);
    } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  });

  ipcMain.handle('dstation:skills:import-files', function (_event, payload) {
    const g = guard(); if (g) return g;
    try {
      const p = payload || {};
      return skills.importFiles(p.items || p.files);
    } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
  });

  // 导出技能：内核打包为 base64 zip -> 弹「另存为」对话框让用户选路径 -> 写出文件
  ipcMain.handle('dstation:skills:export', function (_event, name) {
    const g = guard(); if (g) return g;
    return Promise.resolve()
      .then(function () { return skills.exportSkill(name); })
      .then(function (r) {
        if (!r || !r.ok) return { ok: false, error: (r && r.error) || '导出失败' };
        const opts = {
          title: '导出技能为 .zip',
          defaultPath: (r.name || 'skill') + '.zip',
          filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }]
        };
        const dlg = liveWin() ? dialog.showSaveDialog(liveWin(), opts) : dialog.showSaveDialog(opts);
        return Promise.resolve(dlg).then(function (res) {
          if (!res || res.canceled || !res.filePath) return { ok: false, cancelled: true };
          try {
            fs.writeFileSync(res.filePath, Buffer.from(r.zip, 'base64'));
          } catch (e) { return { ok: false, error: '写入文件失败：' + String(e && e.message ? e.message : e) }; }
          return { ok: true, path: res.filePath, name: r.name, count: r.count, bytes: r.bytes };
        });
      })
      .catch(function (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; });
  });
}

// ---- sidecar lifecycle ----
function startSidecar() {
  tokenUrl = null;
  recentLog = '';
  rendererLog = '';
  const dshHome = path.join(BASE, 'home');
  try { fs.mkdirSync(dshHome, { recursive: true }); } catch (e) {}
  // 知识库根目录：与 dsh-knowledge-base 插件的相对默认 '../home/knowledge-bases' 对应
  // （相对 sidecar cwd = <BASE>/app 解析 → <BASE>/home/knowledge-bases）。
  // dsh-workspace.create 要求目标目录已存在，故启动时先确保；换机器随安装目录自动跟随，不写死盘符。
  try { fs.mkdirSync(path.join(dshHome, 'knowledge-bases'), { recursive: true }); } catch (e) {}
  // 技能库根目录：DSH 原生「用户级」技能根 = <DSH_HOME>/skills（内核 rank 400，
  // 路径由 dsh-skill-filesystem 决定）。该根不会被自动创建，而技能面板要往里写，
  // 故启动时先确保存在；换机器随安装目录自动跟随，不写死盘符。
  try { fs.mkdirSync(path.join(dshHome, 'skills'), { recursive: true }); } catch (e) {}
  // self-heal any session left deadlocked by an interrupted generation (before dsh boots)
  try { sh_healAllSessions(dshHome, log); } catch (e) { log('[自愈] 运行异常: ' + e.message); }
  const childEnv = Object.assign({}, process.env, { DSH_HOME: dshHome });
  // strip env-provided key so the API key field in the UI is editable (stored in home\settings.yaml)
  delete childEnv.DEEPSEEK_API_KEY;
  child = spawn(sidecarNode, [sidecarScript, 'web', '--port', String(pickedPort), '--no-open'], {
    cwd: path.join(BASE, 'app'),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  const urlRe = /http:\/\/(127\.0\.0\.1|localhost):(\d+)\/\?[^\s]+/g;
  function pump(chunk) {
    const text = chunk.toString();
    log('[dsh] ' + text.trim());
    recentLog = (recentLog + text).slice(-8000);
    if (!lastPluginFailure) {
      const f = detectPluginFailure(recentLog);
      if (f) { lastPluginFailure = f; log('[插件] 检测到加载失败: id=' + f.id + ' pkg=' + f.pkg + ' | ' + f.reason); }
    }
    if (!tokenUrl) {
      const m = text.match(urlRe);
      if (m && m[0]) { tokenUrl = m[0].trim(); writeLock(tokenUrl); }
    }
  }
  child.stdout.on('data', pump);
  child.stderr.on('data', (c) => pump(c));
  child.on('exit', (code) => {
    log('dsh 进程已退出（退出码 ' + code + '）。');
    if (!quitting) handleSidecarExit(code).catch((e) => log('[看门狗] 处理 sidecar 退出时异常: ' + e.message));
  });
}

// watchdog: sidecar died unexpectedly -> restart it and reload the page
async function handleSidecarExit(code) {
  // last chance: the failure text may only be complete now that the process exited
  if (!lastPluginFailure) {
    const f = detectPluginFailure(recentLog);
    if (f) { lastPluginFailure = f; log('[插件] 退出时确认加载失败: id=' + f.id + ' pkg=' + f.pkg); }
  }
  // Classify the failure before deciding what to do.
  if (lastPluginFailure && !pluginFailureHandled) {
    // (1) Transient: environment was busy (stale writer lock, EBUSY...). The
    //     plugin itself is fine — clear the lock and retry, disable nothing.
    if (lastPluginFailure.transient && transientRetries < 2) {
      transientRetries++;
      log('[看门狗] 暂时性错误（非插件代码问题）：' + lastPluginFailure.reason.slice(0, 80));
      const n = clearStaleLocks();
      log('[看门狗] 清理陈旧锁 ' + n + ' 个，重试启动（第 ' + transientRetries + '/2 次）');
      restartCount = 0;
      lastPluginFailure = null;
      setSplashStatus('正在清理残留锁并重试…', '这不是插件问题，无需禁用任何插件');
      // fall through to the normal restart path
    } else if (lastPluginFailure.core) {
      // (2) Official / load-bearing entry: auto-disabling it would take down
      //     every plugin depending on it, so refuse and explain instead.
      pluginFailureHandled = true;
      log('[看门狗] 核心条目失败，拒绝自动禁用: ' + lastPluginFailure.pkg);
      closeSplash();
      showError(
        'dsh 启动失败：核心组件「' + lastPluginFailure.pkg + '」加载出错。\n\n' +
        '这是官方内置组件，自动禁用会导致更多插件连锁失败，因此已停止重试。\n\n' +
        '原因：' + lastPluginFailure.reason.slice(0, 300) + '\n\n' +
        '建议：直接重新启动 D-STATION（多数情况是残留锁，重开即可）。\n' +
        '若反复出现，删除 home 目录下的 *.lock 文件后重试。');
      realQuit();
      return;
    } else {
      // (3) Third-party plugin: deterministic, safe to offer disabling it.
      pluginFailureHandled = true;
      await askAboutPluginFailure();
      return;
    }
  }
  // If the window was never revealed, keep the splash up (with a reason) instead
  // of dropping the user onto a blank screen while the watchdog restarts dsh.
  if (revealed) closeSplash();
  else setSplashStatus('服务异常，正在自动重启…', '看门狗已接管，最多重试 ' + MAX_RESTART + ' 次');
  if (restartCount >= MAX_RESTART) {
    log('[看门狗] 已连续重启 ' + restartCount + ' 次仍失败，停止重试。');
    showError('dsh 服务连续重启失败（共 ' + restartCount + ' 次，最近退出码 ' + code + '）。\n请查看 launcher.log 后重新启动。');
    realQuit();
    return;
  }
  restartCount++;
  log('[看门狗] ' + (RESTART_DELAY_MS / 1000) + 's 后自动重启 dsh（第 ' + restartCount + '/' + MAX_RESTART + ' 次）...');
  setTimeout(async () => {
    if (quitting) return;
    startSidecar();
    const ready = await waitHttpReady(pickedPort, READY_TIMEOUT_MS);
    if (quitting) return;
    if (!ready) {
      log('[看门狗] 重启后服务未就绪（进程若再退出会继续由看门狗接管）');
      return; // if the process dies again, its exit event re-enters the watchdog
    }
    const url = (await waitToken(TOKEN_WAIT_MS)) || ('http://127.0.0.1:' + pickedPort);
    if (quitting) return;
    if (win && !win.isDestroyed()) {
      log('[看门狗] 服务已恢复，重载页面: ' + url);
      navigate(win, url);
    } else {
      log('[看门狗] 服务已恢复，重建主窗口: ' + url);
      createWindow(url);
    }
    log('[看门狗] 恢复完成');
  }, RESTART_DELAY_MS);
}

app.whenReady().then(async () => {
  log('==============================================');
  log('dsh-launcher (Electron) 启动 | ' + BASE);
  // 【shell-v2】任务栏/应用身份显示为 D-STATION（替代未打包运行时的默认 "Electron"）：
  // Windows 任务栏按 AppUserModelID 分组与命名；必须在创建任何 BrowserWindow 之前设置才会生效。
  try { app.setName('D-STATION'); } catch (e) { log('[警告] app.setName 失败: ' + (e && e.message)); }
  try { app.setAppUserModelId('com.dstation.desktop'); } catch (e) { log('[警告] setAppUserModelId 失败: ' + (e && e.message)); }
  createSplash(); // show loading screen ASAP
  setSplashStatus('正在初始化…', '首次启动需要装配环境，请耐心等待');

  app.setPath('userData', path.join(BASE, 'electron-data'));
  if (!app.requestSingleInstanceLock()) {
    log('已有实例在运行，本次启动退出。');
    app.exit(0);
    return;
  }
  app.on('second-instance', () => showWindow());

  sidecarNode = path.join(BASE, 'runtime', 'node', 'node.exe');
  sidecarScript = path.join(BASE, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!fs.existsSync(sidecarNode) || !fs.existsSync(sidecarScript)) {
    closeSplash();
    showError('整合包不完整：缺少 runtime\\node 或 app\\node_modules。\n请重新解压完整安装包。\n\n' + BASE);
    app.exit(1);
    return;
  }

  createTray();

  // 在线升级：初始化模块并挂上 IPC（面板「关于 · 更新」用）
  initOta();
  try { registerOtaIpc(); } catch (e) { log('[OTA] 注册 IPC 失败: ' + (e && e.message)); }
  initFiles();
  try { registerFilesIpc(); } catch (e) { log('[FILES] 注册 IPC 失败: ' + (e && e.message)); }
  try { registerSkillsIpc(); } catch (e) { log('[SKILLS] 注册 IPC 失败: ' + (e && e.message)); }

  pickedPort = await pickPort();
  if (pickedPort < 0) {
    closeSplash();
    showError(PORT_START + '~' + PORT_END + ' 端口全部被占用，无法启动。');
    realQuit();
    return;
  }
  log('使用端口: ' + pickedPort);
  writeLock('');

  log('正在启动 dsh web（首次启动需装配 profile，可能需要 1-3 分钟）...');
  // Proactively clear stale locks before every launch: a killed dsh can leave a
  // writer lock behind, which then makes the next boot fail with a bogus error.
  try {
    const cleared = clearStaleLocks();
    if (cleared) log('[锁] 启动前清理陈旧锁 ' + cleared + ' 个');
  } catch (e) { log('[锁] 启动前清理失败（忽略）: ' + e.message); }
  setSplashStatus('正在启动本地服务…', '正在读取运行环境，文件较多时较慢');
  startSidecar();

  log('等待服务就绪(HTTP): http://127.0.0.1:' + pickedPort);
  const ready = await waitHttpReady(pickedPort, READY_TIMEOUT_MS);
  if (ready) setSplashStatus('服务已就绪，正在打开界面…', '');
  if (!ready) {
    if (child && child.exitCode !== null) {
      closeSplash();
      showError('dsh 启动失败（退出码 ' + child.exitCode + '），请查看 launcher.log。');
      realQuit();
    } else {
      log('[警告] 等待超时（服务仍在启动中），窗口将打开并在就绪后自动重试加载');
    }
    // don't quit: watchdog + load-retry will keep trying
  }

  const url = (await waitToken(TOKEN_WAIT_MS)) || ('http://127.0.0.1:' + pickedPort);
  if (tokenUrl) {
    log('服务就绪，打开主窗口: ' + url);
  } else {
    log('未捕获 token，使用基础地址打开: ' + url);
  }
  setSplashStatus('正在加载界面…', '');
  createWindow(url);
  log('运行中。关闭或最小化窗口会收到托盘；托盘右键 -> 退出 才会停止服务。');
});

app.on('before-quit', () => { if (!quitting) { quitting = true; cleanupChild(); releaseLock(); } });
app.on('child-process-gone', (e, details) => {
  if (details && details.type === 'GPU' && process.env.DSHLAUNCH_SW_RENDER !== '1' && !quitting) {
    log('[GPU] GPU 进程崩溃，自动切换软件渲染并重启...');
    app.relaunch({ args: process.argv.slice(1), env: Object.assign({}, process.env, { DSHLAUNCH_SW_RENDER: '1' }) });
    app.exit(0);
  }
});
app.on('window-all-closed', () => { /* keep running in tray */ });
