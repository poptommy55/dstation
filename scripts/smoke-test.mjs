#!/usr/bin/env node
/**
 * Boot a built bundle's sidecar and verify it actually serves the web UI.
 *
 * A successful build is not evidence that the app runs: the bundle can be
 * structurally complete and still fail to compose its plugin tree. This starts
 * the real DSH kernel out of the bundle, waits for its tokenised URL, fetches
 * it, and reports what it got.
 *
 * It uses a scratch port and its own process, so it will not disturb an
 * instance you already have running. It also never binds the default 3080.
 *
 * Usage:
 *   node scripts/smoke-test.mjs [--dist <dir>] [--port <n>] [--timeout <sec>]
 *
 * Exit codes: 0 healthy, 1 the sidecar failed or never served, 2 bad usage.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dist') out.dist = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--timeout') out.timeout = Number(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
    else { console.error(`Unknown argument: ${a}`); process.exit(2); }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('Usage: node scripts/smoke-test.mjs [--dist <dir>] [--port <n>] [--timeout <sec>]');
  process.exit(0);
}

const repoRoot = path.resolve(import.meta.dirname, '..');
const distDir = path.resolve(args.dist ?? path.join(repoRoot, 'dist'));
// 3080 is deliberately avoided: that is the default of a running instance.
const port = args.port ?? 3164;
const timeoutMs = (args.timeout ?? 180) * 1000;

const nodeExe = path.join(distDir, 'runtime', 'node', 'node.exe');
const sidecar = path.join(distDir, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const homeDir = path.join(distDir, 'home');

for (const [label, p] of [['portable Node runtime', nodeExe], ['DSH kernel', sidecar], ['DSH_HOME', homeDir]]) {
  if (!fs.existsSync(p)) {
    console.error(`Missing ${label}: ${p}`);
    console.error('Build the bundle first: powershell -ExecutionPolicy Bypass -File scripts/build.ps1');
    process.exit(2);
  }
}

console.log(`bundle  : ${distDir}`);
console.log(`port    : ${port}`);
console.log(`timeout : ${timeoutMs / 1000}s`);
console.log('');

const started = Date.now();
const child = spawn(nodeExe, [sidecar, 'web', '--port', String(port), '--no-open'], {
  env: { ...process.env, DSH_HOME: homeDir },
  cwd: distDir,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
let tokenUrl = null;
let exited = null;

child.stdout.on('data', (b) => {
  const s = b.toString();
  stdout += s;
  const m = s.match(/https?:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9._-]+/);
  if (m && !tokenUrl) tokenUrl = m[0];
});
child.stderr.on('data', (b) => { stderr += b.toString(); });
child.on('exit', (code) => { exited = code; });

async function waitFor(predicate, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    if (exited !== null && exited !== undefined && !predicate()) {
      console.error(`\nFAIL: the sidecar exited early with code ${exited}`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error(`\nFAIL: timed out waiting for ${label}`);
  return false;
}

let ok = true;
try {
  const ready = await waitFor(() => tokenUrl !== null, 'the tokenised URL');
  if (!ready) ok = false;

  if (ok) {
    console.log(`boot time : ${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log(`url       : ${tokenUrl.replace(/token=.*/, 'token=<redacted>')}`);

    // The token URL authenticates the first request and hands back a cookie; the
    // page itself is then served against that cookie. fetch() does not keep a
    // cookie jar across redirects, so follow it by hand.
    //
    // Note that a bare GET of "/" deliberately returns 401. That is the server
    // saying it is alive but unauthenticated, not that the app failed to start --
    // treating 401 as "down" is the classic false alarm here.
    let status = 0;
    let body = '';
    try {
      const first = await fetch(tokenUrl, { redirect: 'manual' });
      status = first.status;
      console.log(`token url : HTTP ${status}`);

      if (status >= 300 && status < 400) {
        const rawCookies = typeof first.headers.getSetCookie === 'function'
          ? first.headers.getSetCookie()
          : [first.headers.get('set-cookie') ?? ''].filter(Boolean);
        const cookie = rawCookies.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
        const second = await fetch(`http://127.0.0.1:${port}/`, {
          headers: cookie ? { cookie } : {},
          redirect: 'manual',
        });
        status = second.status;
        body = await second.text();
      } else {
        body = await first.text();
      }
      console.log(`page      : HTTP ${status}, ${body.length} bytes`);
    } catch (e) {
      console.error(`FAIL: could not fetch the page: ${e.message}`);
      ok = false;
    }

    if (ok) {
      if (status !== 200) { console.error(`FAIL: expected HTTP 200 for the authenticated page, got ${status}`); ok = false; }
      if (body.length < 1000) { console.error('FAIL: the page body is suspiciously small'); ok = false; }
      if (!/<\/(html|body)>/i.test(body)) { console.error('FAIL: the response does not look like HTML'); ok = false; }
    }
  }

  if (exited !== null && exited !== undefined) {
    console.error(`FAIL: the sidecar exited with code ${exited}`);
    ok = false;
  }

  if (/error signatures|Cannot find module|ERR_MODULE_NOT_FOUND|declares dsh\.client/i.test(stderr)) {
    console.error('FAIL: the sidecar logged an error signature:');
    console.error(stderr.split('\n').slice(0, 12).map((l) => '  ' + l).join('\n'));
    ok = false;
  }
} finally {
  try { child.kill(); } catch {}
  await new Promise((r) => setTimeout(r, 800));
  if (exited === null || exited === undefined) {
    try {
      const { execFileSync } = await import('node:child_process');
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {}
  }
}

console.log('');
if (!ok) {
  console.log('--- sidecar stderr (last 40 lines) ---');
  console.log(stderr.split('\n').slice(-40).join('\n') || '(empty)');
  console.log('');
  console.error('SMOKE TEST FAILED');
  process.exit(1);
}
console.log('SMOKE TEST PASSED: the bundled sidecar booted and served the web UI.');
