#!/usr/bin/env node
/**
 * Scan a source tree for credential-shaped strings.
 *
 * Reports the file, line, and which pattern matched. It never prints the matched
 * text: an audit tool that echoes secrets is itself a leak.
 *
 * Usage:
 *   node scripts/check-secrets.mjs [root...]
 *
 * Exit codes: 0 clean, 1 findings, 2 nothing was scanned (treated as failure, so
 * a typo in the path can never be mistaken for "clean").
 *
 * A self-test runs first: the scanner must flag a synthetic key in a temp file.
 * A scan that reports zero findings without a passing control proves nothing.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PATTERNS = [
  ['openai-style-api-key', /sk-[A-Za-z0-9_-]{20,}/g],
  ['google-api-key', /AIza[0-9A-Za-z_-]{20,}/g],
  ['aws-access-key-id', /AKIA[0-9A-Z]{12,}/g],
  ['github-token', /gh[pousr]_[A-Za-z0-9]{20,}/g],
  ['private-key-block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  [
    'assigned-credential',
    /(api[_-]?key|apikey|secret|passwd|password|access[_-]?key)["']?\s*[:=]\s*["'][A-Za-z0-9_/+-]{16,}/gi,
  ],
];

// Files that legitimately quote these shapes while documenting them.
const ALLOWLIST = new Set([
  'check-secrets.mjs',
  'ci.yml',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
]);

const SKIP_DIRS = new Set(['node_modules', '.git', '.vendor', 'dist', 'out']);
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.bmp', '.webp', '.avif', '.svg',
  '.exe', '.dll', '.node', '.so', '.dylib', '.zip', '.7z', '.gz', '.tar', '.rar',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.pdf', '.mp3', '.mp4', '.wav',
  '.wasm', '.bin', '.pak', '.dat', '.db', '.sqlite', '.class', '.jar',
  '.blend', '.glb', '.gltf', '.psd', '.ico',
]);

function isProbablyText(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
    return true;
  } catch {
    return false;
  }
}

function walk(root, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(p, out);
    } else if (e.isFile()) {
      if (SKIP_EXT.has(path.extname(e.name).toLowerCase())) continue;
      out.push(p);
    }
  }
  return out;
}

function scanFile(file) {
  if (ALLOWLIST.has(path.basename(file))) return [];
  if (!isProbablyText(file)) return [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/);
  const hits = [];
  for (const [label, re] of PATTERNS) {
    lines.forEach((line, i) => {
      re.lastIndex = 0;
      if (re.test(line)) hits.push({ label, line: i + 1 });
    });
  }
  return hits;
}

// ---------------------------------------------------------------- self-test
const controlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dstation-scan-'));
const controlFile = path.join(controlDir, 'control.txt');
fs.writeFileSync(controlFile, 'api_key = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"\n', 'utf8');
const controlHits = scanFile(controlFile);
fs.rmSync(controlDir, { recursive: true, force: true });

if (controlHits.length === 0) {
  console.error('SELF-TEST FAILED: the scanner did not flag a synthetic key.');
  console.error('Its results cannot be trusted. Aborting.');
  process.exit(2);
}
console.log(
  `self-test ok: ${controlHits.length} pattern(s) matched the synthetic key ` +
    `(${[...new Set(controlHits.map((h) => h.label))].join(', ')})`,
);

// -------------------------------------------------------------------- scan
const roots = process.argv.slice(2);
if (roots.length === 0) roots.push(process.cwd());

const files = [];
for (const r of roots) {
  const abs = path.resolve(r);
  if (!fs.existsSync(abs)) {
    console.error(`UNRESOLVED: ${r} does not exist. Refusing to report "clean".`);
    process.exit(2);
  }
  const st = fs.statSync(abs);
  if (st.isDirectory()) files.push(...walk(abs));
  else files.push(abs);
}

if (files.length === 0) {
  console.error('No files were scanned. Refusing to report "clean".');
  process.exit(2);
}

let findings = 0;
for (const f of files) {
  for (const h of scanFile(f)) {
    findings++;
    console.error(`${path.relative(process.cwd(), f)}:${h.line}: ${h.label}`);
  }
}

console.log(`scanned ${files.length} file(s), ${findings} finding(s)`);
if (findings > 0) {
  console.error('');
  console.error('If any of these is a real credential: revoke it now, then rewrite history.');
  console.error('Rotating the key is not optional -- it has been in a working tree.');
  process.exit(1);
}
console.log('clean');
