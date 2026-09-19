#!/usr/bin/env node
/**
 * Structural checks on the repository tree.
 *
 * Catches the classes of mistake that are cheap to make and expensive to publish:
 * a credential file left in the tree, a machine-specific path baked into source,
 * a plugin that would break the runtime on load, or a missing asset.
 *
 * Usage: node scripts/verify-tree.mjs [root]
 * Exit codes: 0 all checks passed, 1 at least one check failed.
 */

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..'));

const failures = [];
const warnings = [];
function fail(msg) { failures.push(msg); }
function warn(msg) { warnings.push(msg); }

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '.vendor' || e.name === 'dist') continue;
      walk(p, out);
    } else if (e.isFile()) {
      out.push(p);
    }
  }
  return out;
}

const files = walk(root);
const rel = (f) => path.relative(root, f).split(path.sep).join('/');

// ---------------------------------------------------- 1. credential files
const CREDENTIAL_NAMES = [
  '.aceskey',
  '.credentials.yaml',
  '.anonymous-user-id',
  'tokens.json',
  'accounts.json',
  '.env',
];
for (const f of files) {
  const base = path.basename(f);
  if (CREDENTIAL_NAMES.includes(base)) fail(`credential file present: ${rel(f)}`);
  if (base.endsWith('.pem') || base.endsWith('.key')) {
    if (base.endsWith('.example')) continue;
    fail(`key file present: ${rel(f)}`);
  }
}
// the template must exist; the real file must not
if (!fs.existsSync(path.join(root, 'skills/aces-system/.aceskey.example'))) {
  warn('skills/aces-system/.aceskey.example is missing, so users have no template to copy');
}

// ------------------------------------------------- 2. machine-specific paths
// Two tiers, because a blanket "no drive letters" rule is unusable: docs and
// test fixtures legitimately show examples such as D:\DSH or D:/work.
//
//   error   - a path into a real user profile. That means somebody's own
//             machine leaked into the tree, which is what we actually care about.
//   warning - any other absolute drive path. A human decides whether it is an
//             example or a bug.
//
// Names that are obviously placeholders, not people, are not errors.
const GENERIC_USERS = new Set([
  'example', 'public', 'user', 'users', 'me', 'you', 'someone', 'test', 'tester',
  'default', 'wdagutilityaccount', 'a', 'x', 'foo', 'bar', 'username', 'yourname',
]);
const USER_PATH_RE = /\b[A-Z]:[\\/]+Users[\\/]+([A-Za-z0-9._-]+)/gi;
const DRIVE_PATH_RE = /\b[A-Z]:[\\/]+[A-Za-z0-9._-]+/g;

const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.yml', '.yaml', '.md', '.txt', '.ps1', '.bat', '.cmd', '.tpl', '.frag', '.html', '.py', '.sh', '.example']);
const driveWarnings = new Map();

for (const f of files) {
  const ext = path.extname(f).toLowerCase();
  if (ext !== '' && !TEXT_EXT.has(ext)) continue;
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
  text.split(/\r?\n/).forEach((line, i) => {
    if (/[<>]/.test(line)) return;   // an obvious placeholder such as <repo-root>
    USER_PATH_RE.lastIndex = 0;
    let m;
    while ((m = USER_PATH_RE.exec(line)) !== null) {
      const name = m[1];
      // "C:/Users/..." and similar are placeholders, not somebody's account.
      if (/^\.+$/.test(name)) continue;
      if (!GENERIC_USERS.has(name.toLowerCase())) {
        fail(`${rel(f)}:${i + 1}: path into a real user profile "${m[0]}"`);
      }
    }
    DRIVE_PATH_RE.lastIndex = 0;
    if (DRIVE_PATH_RE.test(line)) {
      driveWarnings.set(rel(f), (driveWarnings.get(rel(f)) ?? 0) + 1);
    }
  });
}
if (driveWarnings.size > 0) {
  const total = [...driveWarnings.values()].reduce((a, b) => a + b, 0);
  const top = [...driveWarnings.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  warn(`${total} absolute drive path(s) across ${driveWarnings.size} file(s); likely examples, worth a skim: ` +
    top.map(([f, n]) => `${f} (${n})`).join(', ') +
    (driveWarnings.size > top.length ? ', ...' : ''));
}

// ------------------------------------------------------- 3. plugin sanity
const pluginRoot = path.join(root, 'plugins');
if (!fs.existsSync(pluginRoot)) {
  fail('plugins/ directory is missing');
} else {
  const pluginDirs = [];
  for (const e of fs.readdirSync(pluginRoot, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('@')) {
      for (const s of fs.readdirSync(path.join(pluginRoot, e.name), { withFileTypes: true })) {
        if (s.isDirectory()) pluginDirs.push({ name: `${e.name}/${s.name}`, dir: path.join(pluginRoot, e.name, s.name) });
      }
    } else {
      pluginDirs.push({ name: e.name, dir: path.join(pluginRoot, e.name) });
    }
  }
  if (pluginDirs.length === 0) fail('no plugins found under plugins/');
  for (const p of pluginDirs) {
    const pkgPath = path.join(p.dir, 'package.json');
    if (!fs.existsSync(pkgPath)) { fail(`plugins/${p.name} has no package.json`); continue; }
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch (e) { fail(`plugins/${p.name}/package.json is not valid JSON: ${e.message}`); continue; }
    if (!pkg.name) fail(`plugins/${p.name}/package.json has no "name"`);

    // A server-only plugin that declares dsh.client without shipping a client
    // bundle makes the whole runtime fail to compose.
    const declaresClient = Boolean(pkg.dsh && pkg.dsh.client);
    if (declaresClient) {
      const hasBundle = fs.existsSync(path.join(p.dir, 'client.js'))
        || (pkg.exports && typeof pkg.exports === 'object' && pkg.exports['./client']);
      if (!hasBundle) {
        fail(`plugins/${p.name} declares dsh.client but ships no client bundle -- the runtime will not compose`);
      }
    }
  }
  console.log(`plugins checked: ${pluginDirs.length}`);
}

// ------------------------------------------------------- 4. skills sanity
const skillRoot = path.join(root, 'skills');
if (!fs.existsSync(skillRoot)) {
  fail('skills/ directory is missing');
} else {
  const skillDirs = fs.readdirSync(skillRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const s of skillDirs) {
    if (!fs.existsSync(path.join(skillRoot, s.name, 'SKILL.md'))) {
      warn(`skills/${s.name} has no SKILL.md and will not be loadable as a skill`);
    }
  }
  console.log(`skills checked: ${skillDirs.length}`);
}

// ------------------------------------------------------ 5. required assets
const REQUIRED = [
  'README.md',
  'README.zh-CN.md',
  'LICENSE',
  'NOTICE',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'CHANGELOG.md',
  '.gitignore',
  '.gitattributes',
  '.github/workflows/ci.yml',
  'shell/main.js',
  'shell/ota-core.js',
  'shell/package.json',
  'scripts/setup.ps1',
  'scripts/build.ps1',
  'scripts/start.ps1',
  'profiles/web/cordis.yml',
  'profiles/web/cordis.patch.yml',
];
for (const r of REQUIRED) {
  if (!fs.existsSync(path.join(root, r))) fail(`required file missing: ${r}`);
}

// ------------------------------------------------------------------ report
console.log('');
if (warnings.length) {
  console.log(`${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  ! ${w}`);
  console.log('');
}
if (failures.length) {
  console.log(`${failures.length} check(s) FAILED:`);
  for (const f of failures) console.log(`  x ${f}`);
  process.exit(1);
}
console.log('all structural checks passed');
