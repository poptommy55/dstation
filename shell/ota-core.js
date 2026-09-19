'use strict';
/**
 * D-STATION OTA v2 客户端核心 —— 内容寻址增量升级
 *
 * 为什么重写（实测依据，2026-09-15）：
 *   v1 的 stage() 按 manifest 逐文件 GET，94,047 个文件 / 2135.8 MB，无并发、
 *   无断点续传 ⇒ 一次升级约 85 分钟，失败即全量重来。而相邻两版之间实测
 *   **只有 3 个文件内容变化**（1.0.8→1.0.9：94,045 个共同文件中 3 个不同）。
 *   实测 v2 差集：已装 1.0.9 → 目标新版，只需下载 15 个对象 / 0.48 MB。
 *
 * 协议（manifest schema = dstation-ota/v2）：
 *   GET  manifest.json          { schema, version, gitCommit, notes, filesUrl, objectBase, objectShard }
 *   GET  files/<ver>.tsv.gz     完整映射：path <TAB> sha256 <TAB> size（gzip）
 *   GET  objects/<sha[0:2]>/<sha>   内容寻址对象
 *
 * 算法：
 *   目标对象集 = 映射表里所有 sha
 *   本地对象集 = 本机文件索引里所有 sha（**按内容算，不按路径** —— 改名的文件也能复用）
 *   需下载     = 目标对象集 − 本地对象集
 *   需应用     = 目标里 sha ≠ 本机该 path 的 sha 的路径
 *
 * 与升级器的接缝（关键设计）：
 *   本模块把「需要应用的文件」从对象**铺开**成 `<staging>/<相对路径>` 的完整目录树
 *   （优先硬链接，同盘零拷贝），于是 v1 那个经过实战验证的独立升级器
 *   `ota-updater.js`（等主进程退出 → 备份 → 覆盖 → 失败回滚 → 重启）**完全不用改**。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const INDEX_FILE = 'ota-index.json';
const OBJECTS_DIR = 'objects';
const UA = 'D-STATION-OTA/2.0';
const SCHEMA = 'dstation-ota/v2';

/* ============================ Phase 3：签名验证 ============================ */

/** 内置公钥（可公开；私钥在发布机 .ota-signing-key.pem，绝不入库） */
const OTA_PUBLIC_KEY = [
  '-----BEGIN PUBLIC KEY-----',
  'MCowBQYDK2VwAyEANvdTDi3nv1T8RGPTfp6OWVKVE3IUI1CI/VMJ+L86Ib0=',
  '-----END PUBLIC KEY-----',
  ''
].join('\n');

/**
 * 清单的规范化文本（签名/验签两侧必须逐字一致）。
 * ⚠️ 发布端 `_ota_pack_v2.cjs` 里有一份**逐字对应**的实现 —— 改这里就要同步改那里，
 *    由 `_ota_phase3_it.cjs` 用真实签名交叉验证。
 */
const CANONICAL_KEYS = ['schema', 'version', 'releasedAt', 'gitCommit', 'gitTag',
  'fileCount', 'objectCount', 'totalSize', 'filesUrl', 'objectBase'];
function canonicalManifest(m) {
  return CANONICAL_KEYS.map(function (k) { return k + '=' + (m[k] == null ? '' : String(m[k])); }).join('\n');
}

/**
 * 验签：防止「分发服务器被拿下 → 给所有装机推恶意包」。
 * 没有签名、签名不对、或验签异常 —— 一律拒绝（fail closed）。
 */
function verifyManifest(m) {
  if (!m || !m.sig || !m.sig.value) return { ok: false, error: '清单缺少签名（sig），拒绝使用' };
  if (m.sig.alg && m.sig.alg !== 'ed25519') return { ok: false, error: '不支持的签名算法: ' + m.sig.alg };
  try {
    const pub = crypto.createPublicKey(OTA_PUBLIC_KEY);
    const good = crypto.verify(null, Buffer.from(canonicalManifest(m), 'utf8'), pub, Buffer.from(m.sig.value, 'base64'));
    return good ? { ok: true } : { ok: false, error: '清单签名验证失败（内容被篡改或私钥不匹配）' };
  } catch (e) {
    return { ok: false, error: '验签异常: ' + (e && e.message) };
  }
}

/* ====================== Phase 3：白名单写入（治本） ======================
 * 旧机制是「黑名单 + 客户端兜底 6 项」：保护用户资产**全靠打包端不漏项**，
 * 打包端 30 项漏掉任何一项，客户端都不会拦、会静默覆盖用户数据（1.0.8 就漏过
 * 用户自建智能体预设和 AGENTS.md）。
 * 改成白名单后：**打包端漏什么都不会写到用户目录**，因为白名单外的路径根本不被接受。
 * 代价：以后新增顶层目录（如 assets/）必须同步更新这份名单，否则整包被拒。
 */
const WRITE_ALLOWLIST = [
  /^resources\//,             // Electron 外壳（含 resources/app/）与程序资源（default_app.asar 等）
  /^app\//,                   // DSH 后端
  /^home\/plugins\//,         // 自有插件
  /^home\/profiles\//,        // profile 配置与插件运行副本
  /^locales\//,               // 本地化资源
  /^[^/]+$/                   // 顶层文件（LICENSE / *.dll / *.pak / *.cmd / 使用说明.txt …）
];

function isAllowedToWrite(rel) {
  const p = String(rel == null ? '' : rel).replace(/\\/g, '/');
  if (!p || p.indexOf('..') >= 0) return false;
  return WRITE_ALLOWLIST.some(function (re) { return re.test(p); });
}

/* ============================ HTTP ============================ */

function openStream(url, redirects) {
  redirects = redirects || 0;
  return new Promise(function (resolve, reject) {
    let lib;
    try { lib = String(url).indexOf('https:') === 0 ? https : http; }
    catch (e) { return reject(e); }
    const req = lib.get(url, { timeout: 60000, headers: { 'User-Agent': UA } }, function (res) {
      const code = res.statusCode;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (redirects >= 5) return reject(new Error('重定向次数过多: ' + url));
        return openStream(new URL(res.headers.location, url).toString(), redirects + 1).then(resolve, reject);
      }
      if (code !== 200) { res.resume(); return reject(new Error('HTTP ' + code + ' ' + url)); }
      resolve(res);
    });
    req.on('timeout', function () { req.destroy(new Error('请求超时: ' + url)); });
    req.on('error', reject);
  });
}

async function fetchBuffer(url) {
  const res = await openStream(url);
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return Buffer.concat(chunks);
}

async function fetchJson(url) {
  const sep = String(url).indexOf('?') >= 0 ? '&' : '?';
  const buf = await fetchBuffer(url + sep + 't=' + Date.now());
  try { return JSON.parse(buf.toString('utf8')); }
  catch (e) { throw new Error('清单不是合法 JSON: ' + buf.toString('utf8').slice(0, 120)); }
}

/** 下载 gzip 映射表并解析成 Map<path, sha> */
async function fetchFileMap(url) {
  const buf = await fetchBuffer(url);
  let text;
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    text = zlib.gunzipSync(buf).toString('utf8');   // 服务端发了 gzip
  } else {
    text = buf.toString('utf8');                    // 未压缩（本地测试服务器）
  }
  const map = new Map();
  const sizes = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    const p = line.split('\t');
    if (p.length < 3) continue;
    map.set(p[0], p[1]);
    sizes.set(p[1], parseInt(p[2], 10) || 0);
  }
  if (!map.size) throw new Error('映射表为空或格式不对');
  return { map: map, objectSizes: sizes };
}

/* ============================ 本地索引 ============================ */

function indexFile(base) { return path.join(base, INDEX_FILE); }

function readIndex(base) {
  try {
    const j = JSON.parse(fs.readFileSync(indexFile(base), 'utf8'));
    if (j && j.files && typeof j.files === 'object') return j;
  } catch (e) { /* 无索引或损坏 → 当作没有 */ }
  return { version: '', updatedAt: '', files: {} };
}

function writeIndex(base, idx) {
  idx.updatedAt = new Date().toISOString();
  const tmp = indexFile(base) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(idx), 'utf8');
  fs.renameSync(tmp, indexFile(base));   // 原子替换，避免半截索引
}

function sha256File(p) {
  return new Promise(function (resolve, reject) {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('data', function (c) { h.update(c); });
    s.on('end', function () { resolve(h.digest('hex')); });
    s.on('error', reject);
  });
}

/**
 * 为「目标清单里出现的路径」建立/刷新本机索引。
 *
 * 加速技巧：索引里存了 size + mtimeMs。若两者都没变，直接沿用缓存的 sha，
 * **不读文件内容** —— 于是后续升级的索引刷新几乎瞬时完成，只有真正动过的
 * 文件才重算哈希。（首次没有索引时仍需全量读一遍，实测 94055 文件 / 2132 MB
 * 约 165 秒，一次性成本，相比旧方案 85 分钟可忽略。）
 *
 * @param base      安装根
 * @param targetMap Map<rel, sha> 目标清单（只索引这些路径，避免读无关文件）
 * @param onProgress (done, total, rel)
 */
async function refreshIndex(base, targetMap, onProgress) {
  const prev = readIndex(base);
  const prevFiles = prev.files || {};
  const files = {};
  const paths = [...targetMap.keys()];
  let done = 0, reused = 0, hashed = 0;

  for (const rel of paths) {
    const abs = path.join(base, rel);
    let st = null;
    try { st = fs.statSync(abs); } catch (e) { /* 文件不存在 → 记为空 */ }
    if (!st) { files[rel] = { sha: '', size: -1, mtimeMs: 0 }; done++; continue; }

    const old = prevFiles[rel];
    if (old && old.size === st.size && old.mtimeMs === st.mtimeMs && old.sha) {
      files[rel] = old;
      reused++;
    } else {
      let sha = '';
      try { sha = await sha256File(abs); } catch (e) { sha = ''; }
      files[rel] = { sha: sha, size: st.size, mtimeMs: st.mtimeMs };
      hashed++;
    }
    done++;
    if (onProgress && (done % 2000 === 0 || done === paths.length)) onProgress(done, paths.length, rel);
  }

  const idx = {
    version: prev.version || '',
    updatedAt: new Date().toISOString(),
    base: base,
    files: files,
    stats: { total: paths.length, reused: reused, hashed: hashed },
  };
  writeIndex(base, idx);
  return idx;
}

/* ============================ 差集 ============================ */

/**
 * @returns { needObjects: [sha], applyPaths: [{rel, sha, size, srcRel}], sameCount }
 *   srcRel = 本机已有该内容的某个路径（可复用，免下载）；null 表示必须下载
 */
function computePlan(indexFiles, targetMap, objectSizes) {
  const localShas = new Map();          // sha -> 本机某个拥有它的相对路径
  for (const [rel, rec] of Object.entries(indexFiles)) {
    if (rec && rec.sha && !localShas.has(rec.sha)) localShas.set(rec.sha, rel);
  }

  const targetShas = new Set(targetMap.values());
  const needObjects = [];
  for (const sha of targetShas) if (!localShas.has(sha)) needObjects.push(sha);

  const needSet = new Set(needObjects);
  const applyPaths = [];
  let sameCount = 0;
  for (const [rel, sha] of targetMap) {
    const rec = indexFiles[rel];
    if (rec && rec.sha === sha) { sameCount++; continue; }
    applyPaths.push({
      rel: rel,
      sha: sha,
      size: objectSizes.get(sha) || 0,
      srcRel: needSet.has(sha) ? null : (localShas.get(sha) || null),
    });
  }
  return { needObjects: needObjects, applyPaths: applyPaths, sameCount: sameCount };
}

/* ============================ 对象下载 ============================ */

function objectRel(sha, shard) { return sha.slice(0, shard || 2) + '/' + sha; }

/**
 * 并发下载缺失对象到 <staging>/objects/<shard>/<sha>，逐个校验 sha256。
 * 并发默认 12：实测单连接约 1100 文件/分，并发后可到 ~1 万/分，
 * 且**断了只重试失败的那几个**（v1 是全量重来）。
 */
async function downloadObjects(opts) {
  const need = opts.needObjects || [];
  const objectBase = String(opts.objectBase || '').replace(/\/+$/, '');
  const shard = opts.shard || 2;
  const dest = opts.staging;
  const concurrency = opts.concurrency || 12;
  const onProgress = opts.onProgress || function () {};
  const retries = opts.retries == null ? 3 : opts.retries;
  const total = need.length;
  let done = 0, bytes = 0, failed = [];

  const queue = need.slice();
  async function worker() {
    while (queue.length) {
      const sha = queue.shift();
      const out = path.join(dest, OBJECTS_DIR, sha.slice(0, shard), sha);
      let lastErr = null;
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          if (fs.existsSync(out)) {
            const h = await sha256File(out);
            if (h === sha) { lastErr = null; break; }
          }
          fs.mkdirSync(path.dirname(out), { recursive: true });
          const buf = await fetchBuffer(objectBase + '/' + objectRel(sha, shard));
          const h = crypto.createHash('sha256').update(buf).digest('hex');
          if (h !== sha) throw new Error('哈希不符（期望 ' + sha.slice(0, 12) + ' 实得 ' + h.slice(0, 12) + '）');
          fs.writeFileSync(out + '.part', buf);
          fs.renameSync(out + '.part', out);
          bytes += buf.length;
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (attempt < retries) await new Promise(function (r) { setTimeout(r, 400 * attempt); });
        }
      }
      done++;
      if (lastErr) failed.push({ sha: sha, error: lastErr.message });
      onProgress({ done: done, total: total, sha: sha, bytes: bytes, failed: failed.length });
    }
  }
  const workers = [];
  for (let i = 0; i < Math.max(1, Math.min(concurrency, total)); i++) workers.push(worker());
  await Promise.all(workers);
  if (failed.length) {
    throw new Error('有 ' + failed.length + ' 个对象下载失败（其余已就绪，可重试）：'
      + failed.slice(0, 3).map(function (f) { return f.sha.slice(0, 12) + ' ' + f.error; }).join(' | '));
  }
  return { downloaded: total, bytes: bytes };
}

/* ============================ 铺开（给升级器用）============================ */

function linkOrCopy(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try { if (fs.existsSync(dst)) fs.unlinkSync(dst); } catch (e) {}
  try { fs.linkSync(src, dst); return 'link'; }
  catch (e) { fs.copyFileSync(src, dst); return 'copy'; }
}

/**
 * 把「需要应用的文件」铺成 <staging>/<相对路径> 的目录树。
 * 优先硬链接（同盘零拷贝），跨盘自动回退复制。
 * 产出 `files` 列表交给独立升级器 —— **升级器因此完全不需要改**。
 */
function materialize(staging, base, applyPaths) {
  const links = [], copies = [], missing = [];
  for (const item of applyPaths) {
    const dst = path.join(staging, item.rel);
    let src = path.join(staging, OBJECTS_DIR, item.sha.slice(0, 2), item.sha);
    if (!fs.existsSync(src)) {
      if (item.srcRel) src = path.join(base, item.srcRel);   // 复用本机已有内容
      if (!fs.existsSync(src)) { missing.push(item.rel); continue; }
    }
    const how = linkOrCopy(src, dst);
    (how === 'link' ? links : copies).push(item.rel);
  }
  return {
    files: applyPaths.map(function (x) { return x.rel; }).filter(function (r) { return missing.indexOf(r) < 0; }),
    links: links.length, copies: copies.length, missing: missing,
  };
}

/** 清理旧暂存（保留当前版本目录） */
function pruneStaging(base, keepVersion) {
  const root = path.join(base, 'ota-staging');
  let entries = [];
  try { entries = fs.readdirSync(root); } catch (e) { return []; }
  const removed = [];
  for (const name of entries) {
    if (name === keepVersion) continue;
    try { fs.rmSync(path.join(root, name), { recursive: true, force: true }); removed.push(name); }
    catch (e) { /* 占用中则跳过，下次再说 */ }
  }
  return removed;
}

function dirSize(p) {
  let t = 0;
  const walk = function (d) {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const abs = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(abs);
        else if (e.isFile()) t += fs.statSync(abs).size;
      } catch (err) {}
    }
  };
  walk(p);
  return t;
}

module.exports = {
  SCHEMA, INDEX_FILE, OBJECTS_DIR, OTA_PUBLIC_KEY, WRITE_ALLOWLIST,
  canonicalManifest, verifyManifest, isAllowedToWrite,
  fetchJson, fetchBuffer, fetchFileMap,
  readIndex, writeIndex, refreshIndex, indexFile,
  computePlan, downloadObjects, materialize,
  pruneStaging, dirSize, objectRel, sha256File,
};
