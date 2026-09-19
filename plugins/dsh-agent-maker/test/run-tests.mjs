/**
 * dsh-agent-maker 离线测试 —— 不需要起服务、不需要重启。
 *
 * 设计要点（都是 dsh-plugin-dev 技能要求过的）：
 *   · 假 ctx.webServer.register **复刻真实行为**：重复 (kind,path) 直接抛，
 *     这样「路由表能不能装配起来」在不重启服务的前提下就能验证（坑 #37）。
 *   · 假 res 是**真 Writable 流**，且 writeHead 里调 Node 的 validateHeaderValue
 *     —— 否则非法响应头（中文文件名）会在假 res 上静默通过、到线上才 500（坑 #58）。
 *   · 假 req 带 Symbol.asyncIterator（readBody 用的是 for await）。
 *   · 等异步一律轮询/等 finish，不用固定 setTimeout 当同步屏障（坑 #23）。
 *
 * 跑法：node test/run-tests.mjs
 */

import { Writable } from 'node:stream';
import { validateHeaderValue } from 'node:http';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

import plugin from '../index.js';
import {
  BUNDLE_SCHEMA,
  INFRA_PRESET_IDS,
  buildAgentBundle,
  collectPresetFiles,
  defaultPackableIds,
  describeDependencies,
  findDshHome,
  listPresets,
  makeZip,
  parsePresetMeta,
  scanDependencies
} from '../agent-pack.js';

const HERE = dirname(fileURLToPath(import.meta.url));

let pass = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    pass++;
  } else {
    failures.push(name + (detail ? '  ← ' + detail : ''));
  }
}

function eq(name, actual, expected) {
  check(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/* ══════════════════════════════════════════════ 测试夹具 ══ */

let tmpRoot = '';

/** 造一个假的 `.agent-presets` 根 */
function makePresetsRoot() {
  const root = mkdtempSync(join(tmpdir(), 'agent-maker-test-'));
  return root;
}

function writePreset(root, id, { yml, meta, extra = {} } = {}) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'preset.yml'),
    meta || `name: 测试智能体-${id}\ndescription: 这是 ${id} 的描述\norder: 5\n`, 'utf8');
  writeFileSync(join(dir, 'agent.cordis.yml'),
    yml || [
      '# test preset',
      '- id: persona',
      "  name: '@deepseek-ai/dsh-persona'",
      '  config:',
      '    text: |-',
      '      你是一个测试智能体。',
      '- id: tool-web',
      "  name: '@deepseek-ai/dsh-tool-web'",
      ''
    ].join('\n'), 'utf8');
  for (const [rel, content] of Object.entries(extra)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return dir;
}

/* ══════════════════════════════════════════ 假 ctx / req / res ══ */

function makeCtx() {
  const routes = new Map();     // "kind path" -> handler
  const disposers = [];
  let effectCount = 0;
  const logged = [];

  const ctx = {
    webServer: {
      register(routeDef) {
        const { kind, path, handler } = routeDef || {};
        const key = `${kind} ${path}`;
        // 复刻真实行为：重复键抛（真实宿主原文：Duplicate (kind, path) throws）
        if (routes.has(key)) {
          throw new Error(`webserver: duplicate ${kind} route "${path}"`);
        }
        routes.set(key, handler);
        const dispose = () => routes.delete(key);
        disposers.push(dispose);
        return dispose;
      }
    },
    effect(fn) {
      effectCount++;
      const d = fn();
      if (typeof d === 'function') disposers.push(d);
      return d;
    },
    logger: {
      info: (m) => logged.push(['info', m]),
      warn: (m) => logged.push(['warn', m]),
      error: (m) => logged.push(['error', m])
    }
  };
  return { ctx, routes, disposers, logged, get effectCount() { return effectCount; } };
}

function makeRes() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); }
  });
  stream.statusCode = 0;
  stream.headers = {};
  stream.writeHead = function (status, headers) {
    this.statusCode = status;
    this.headers = headers || {};
    // ⚠️ 这一行是坑 #58 的根本修法：假 res 必须和真 res 一样严格地校验响应头，
    //    否则「中文文件名写进 content-disposition」这类 bug 永远测不出来。
    for (const [k, v] of Object.entries(this.headers)) validateHeaderValue(k, v);
    return this;
  };
  stream.body = () => Buffer.concat(chunks);
  stream.json = () => JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return stream;
}

function makeReq({ method = 'GET', url = '/', headers = {}, body = null, remote = '127.0.0.1' } = {}) {
  const bufs = [];
  if (body !== null) bufs.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'));
  const req = {
    method,
    url,
    headers,
    socket: { remoteAddress: remote },
    async *[Symbol.asyncIterator]() {
      for (const b of bufs) yield b;
    }
  };
  return req;
}

function sameOriginHeaders(host = '127.0.0.1:3080') {
  return { host, origin: `http://${host}`, 'content-type': 'application/json' };
}

/** 调一条已注册路由，等响应真正写完 */
async function callRoute(h, path, reqOpts) {
  const handler = h.routes.get(`exact ${path}`);
  if (!handler) throw new Error(`no route for ${path}`);
  const req = makeReq(reqOpts);
  const res = makeRes();
  const done = new Promise((resolve) => res.on('finish', resolve));
  await handler(req, res);
  await done;
  return res;
}

/* ══════════════════════════════════════════════ 极简 zip 读取器 ══ */

/**
 * 解 zip 并校验每个条目的 CRC32。
 * 「能产出 zip 字节」和「产出的 zip 真的能解开」是两件事 —— 这里验后者。
 */
function readZip(buf) {
  // 找 EOCD（从尾部往前扫）
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD not found: not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error(`bad central header at ${off}`);
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const compSize = buf.readUInt32LE(off + 20);
    const rawSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');

    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const payload = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 0 ? Buffer.from(payload) : inflateRawSync(payload);

    if (data.length !== rawSize) throw new Error(`${name}: size mismatch`);
    entries.push({ name, data, crc, method });

    off += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

/* ══════════════════════════════════════════════ ① 纯函数 ══ */

{
  const m = parsePresetMeta([
    '# 注释',
    'name: 天气播报员',
    'description: "带引号的描述: 里面有冒号"',
    "order: 8",
    '',
    'unknownKey: 忽略我'
  ].join('\n'));
  eq('parsePresetMeta: name', m.name, '天气播报员');
  eq('parsePresetMeta: 双引号剥掉且保留内部冒号', m.description, '带引号的描述: 里面有冒号');
  eq('parsePresetMeta: order 转成数字', m.order, 8);

  const m2 = parsePresetMeta('name: 只有名字\n');
  eq('parsePresetMeta: 缺字段时给默认值', m2.description, '');
  eq('parsePresetMeta: 缺 order 时为 null', m2.order, null);

  const m3 = parsePresetMeta('name: 块标量\ndescription: >\n  这一行不该被当成描述\n');
  eq('parsePresetMeta: 块标量记号不当作内容', m3.description, '');

  const m4 = parsePresetMeta('');
  eq('parsePresetMeta: 空输入不炸', m4.name, '');
}

/* ══════════════════════════════════════════════ ② 依赖扫描 ══ */

{
  if (!tmpRoot) tmpRoot = makePresetsRoot();
  const dir = writePreset(tmpRoot, 'depscan', {
    yml: [
      '- id: persona',
      "  name: '@deepseek-ai/dsh-persona'",
      '  config:',
      '    text: |-',
      '      你是一个行情智能体。用 awesome-skill 技能做分析。',
      '      数据放在 D:\\DSH\\data\\quotes.csv 里。',
      '- id: kb',
      "  name: 'dsh-knowledge-base'",
      '- id: tool',
      "  name: 'my-custom-plugin'",
      '  config:',
      '    apiKey: process.env.MY_API_KEY',
      '    staticKey: SOME_SERVICE_TOKEN',
      '- id: g',
      '  name: cordis:group',
      '  config: []',
      ''
    ].join('\n'),
    extra: { 'skills/awesome-local/SKILL.md': '# 自带技能\n' }
  });

  const dep = scanDependencies(dir, { knownSkillNames: ['awesome-skill', 'unrelated-skill', 'awesome-local'] });

  check('依赖扫描: 内置插件归到 builtinPlugins', dep.builtinPlugins.includes('@deepseek-ai/dsh-persona'));
  check('依赖扫描: cordis:group 不算插件', !dep.builtinPlugins.includes('cordis:group') && !dep.externalPlugins.includes('cordis:group'));
  check('依赖扫描: 第三方插件归到 externalPlugins',
    dep.externalPlugins.includes('dsh-knowledge-base') && dep.externalPlugins.includes('my-custom-plugin'),
    JSON.stringify(dep.externalPlugins));
  check('依赖扫描: process.env 的变量被列出', dep.envVars.includes('MY_API_KEY'), JSON.stringify(dep.envVars));
  check('依赖扫描: 疑似凭据词进 suspectedEnvVars', dep.suspectedEnvVars.includes('SOME_SERVICE_TOKEN'), JSON.stringify(dep.suspectedEnvVars));
  check('依赖扫描: 绝对路径被列出', dep.absPaths.some((p) => p.includes('quotes.csv')), JSON.stringify(dep.absPaths));
  check('依赖扫描: 引用到的全局技能被列出', dep.globalSkills.includes('awesome-skill'), JSON.stringify(dep.globalSkills));
  check('依赖扫描: 未引用的全局技能不列', !dep.globalSkills.includes('unrelated-skill'));
  check('依赖扫描: 自带的技能不算全局依赖', !dep.globalSkills.includes('awesome-local'));
  check('依赖扫描: 自带技能被识别', dep.bundledSkills.includes('awesome-local'));

  const text = describeDependencies(dep).join('\n');
  check('依赖清单人话: 提到第三方插件', text.includes('dsh-knowledge-base'));
  check('依赖清单人话: 提到环境变量', text.includes('MY_API_KEY'));

  const clean = describeDependencies({
    builtinPlugins: [], externalPlugins: [], envVars: [], suspectedEnvVars: [],
    absPaths: [], bundledSkills: [], globalSkills: []
  }).join('\n');
  check('依赖清单人话: 干净时给出正面结论', clean.includes('没扫到明显'));
}

/* ══════════════════════════════════════════════ ③ 清单 ══ */

{
  const root = makePresetsRoot();
  writePreset(root, 'aaa-agent', { meta: 'name: 甲\norder: 2\n' });
  writePreset(root, 'zzz-agent', { meta: 'name: 乙\norder: 1\n' });
  writePreset(root, 'agent-orchestrator', { meta: 'name: 编排师\norder: 0\n' });
  // 故意造一个 broken 的：没有 agent.cordis.yml
  mkdirSync(join(root, 'broken-one'), { recursive: true });
  writeFileSync(join(root, 'broken-one', 'preset.yml'), 'name: 坏的\n', 'utf8');

  const list = listPresets(root);
  eq('清单: 数量和实际目录一致', list.length, 4);
  eq('清单: order 小的排前面', list[0].id, 'agent-orchestrator');
  check('清单: 编排师被标为基础设施', list.find((p) => p.id === 'agent-orchestrator').infra === true);
  const broken = list.find((p) => p.id === 'broken-one');
  check('清单: 缺 agent.cordis.yml 的被标 broken 而不是静默丢掉', !!broken.broken, JSON.stringify(broken));
  check('清单: broken 项带可读原因', broken.broken.includes('agent.cordis.yml'), broken.broken);
  check('清单: 统计了文件数', list.find((p) => p.id === 'aaa-agent').fileCount >= 2);
  check('清单: 统计了体积', list.find((p) => p.id === 'aaa-agent').bytes > 0);

  const packable = defaultPackableIds(list);
  check('清单: 默认打包集合排除基础设施', !packable.includes('agent-orchestrator'), JSON.stringify(packable));
  check('清单: 默认打包集合排除 broken', !packable.includes('broken-one'), JSON.stringify(packable));
  check('清单: 默认打包集合留下正常的', packable.includes('aaa-agent') && packable.includes('zzz-agent'));
  check('清单: INFRA_PRESET_IDS 含编排师与知识库管理师',
    INFRA_PRESET_IDS.includes('agent-orchestrator') && INFRA_PRESET_IDS.includes('kb-manager'));

  rmSync(root, { recursive: true, force: true });
}

/* ══════════════════════════════════════════════ ④ 打包 ══ */

let builtBundle = null;

{
  const root = makePresetsRoot();
  writePreset(root, 'weather-reporter', {
    meta: 'name: 天气播报员\ndescription: 任意城市天气\norder: 8\n',
    extra: { 'skills/weather-helper/SKILL.md': '# 辅助技能\n步骤……\n' }
  });
  writePreset(root, 'second-agent', { meta: 'name: 第二个\norder: 9\n' });

  // 单个
  const one = buildAgentBundle(root, ['weather-reporter'], { dshHome: 'C:\\Fake\\home' });
  check('打包: 返回 zip 字节', Buffer.isBuffer(one.data) && one.data.length > 0);
  check('打包: 文件名叫智能体包', one.fileName.endsWith('-智能体包.zip'), one.fileName);
  eq('打包: 单智能体计数', one.summary.agentCount, 1);

  let entries = readZip(one.data);
  const names = entries.map((e) => e.name);
  const rootName = names[0].split('/')[0];
  check('打包: 顶层只有一个根目录', names.every((n) => n.startsWith(rootName + '/')), names.slice(0, 3).join(', '));
  check('打包: 含一键安装.cmd', names.includes(`${rootName}/一键安装.cmd`));
  check('打包: 含 install.ps1', names.includes(`${rootName}/install.ps1`));
  check('打包: 含安装说明.txt', names.includes(`${rootName}/安装说明.txt`));
  check('打包: 含依赖清单.txt', names.includes(`${rootName}/依赖清单.txt`));
  check('打包: 含 MANIFEST.json', names.includes(`${rootName}/MANIFEST.json`));
  check('打包: 智能体本体在 agent/<id>/ 下', names.includes(`${rootName}/agent/weather-reporter/agent.cordis.yml`));
  check('打包: 自带技能也进包', names.includes(`${rootName}/agent/weather-reporter/skills/weather-helper/SKILL.md`));

  /* 编码契约 —— 这三条各自都会让「能装」变成「装不上」 */
  const cmdEntry = entries.find((e) => e.name.endsWith('一键安装.cmd'));
  const nonAscii = [...cmdEntry.data].filter((b) => b > 0x7f);
  check('打包: 一键安装.cmd 是纯 ASCII（cmd.exe 按 OEM 代码页读）', nonAscii.length === 0,
    `${nonAscii.length} 个非 ASCII 字节`);
  const ps1Entry = entries.find((e) => e.name.endsWith('install.ps1'));
  check('打包: install.ps1 带 UTF-8 BOM（PS 5.1 否则按 ANSI 读会语法报错）',
    ps1Entry.data[0] === 0xef && ps1Entry.data[1] === 0xbb && ps1Entry.data[2] === 0xbf);
  const txtEntry = entries.find((e) => e.name.endsWith('安装说明.txt'));
  check('打包: 安装说明.txt 带 UTF-8 BOM', txtEntry.data[0] === 0xef && txtEntry.data[1] === 0xbb && txtEntry.data[2] === 0xbf);

  /* 模板变量必须都被替换掉 —— 残留的 @@X@@ 会让说明变成天书 */
  const txt = txtEntry.data.toString('utf8');
  check('打包: 安装说明里没有未替换的 @@变量@@', !/@@[A-Z_]+@@/.test(txt), (txt.match(/@@[A-Z_]+@@/) || [])[0]);
  check('打包: 安装说明写进了智能体名', txt.includes('天气播报员'));
  /* 这个夹具自带 skills/weather-helper，所以依赖清单应该报「自带技能」而不是
     「没扫到依赖」—— 断言要跟着事实走，别把代码的正确行为判成失败。 */
  check('打包: 安装说明写进了依赖清单（自带技能）',
    txt.includes('自带技能') && txt.includes('weather-helper'),
    txt.split('\n').filter((l) => l.includes('技能')).join(' | '));

  const ps1 = ps1Entry.data.toString('utf8');
  check('打包: install.ps1 里没有未替换的 @@变量@@', !/@@[A-Z_]+@@/.test(ps1));

  /* MANIFEST 的 sha256 必须和 zip 里的真实字节一致 */
  const mfEntry = entries.find((e) => e.name.endsWith('MANIFEST.json'));
  const manifest = JSON.parse(mfEntry.data.toString('utf8'));
  eq('打包: manifest schema', manifest.schema, BUNDLE_SCHEMA);
  eq('打包: manifest kind', manifest.kind, 'agent-preset');
  let shaOk = true;
  let shaBad = '';
  for (const a of manifest.agents) {
    for (const f of a.files) {
      const e = entries.find((x) => x.name === `${rootName}/${f.path}`);
      if (!e) { shaOk = false; shaBad = 'missing ' + f.path; break; }
      const h = createHash('sha256').update(e.data).digest('hex');
      if (h !== f.sha256) { shaOk = false; shaBad = f.path; break; }
      if (e.data.length !== f.size) { shaOk = false; shaBad = 'size ' + f.path; break; }
    }
  }
  check('打包: MANIFEST 的 sha256/大小与 zip 内真实字节完全一致', shaOk, shaBad);
  check('打包: manifest 里记了依赖', Array.isArray(manifest.dependencies) && manifest.dependencies.length === 1);

  /* 确定性：同样输入必须产出同样字节（否则没法做漂移检测） */
  const again = buildAgentBundle(root, ['weather-reporter'], { dshHome: 'C:\\Fake\\home', builtAt: manifest.builtAt });
  check('打包: 同样输入产出逐字节相同的 zip', again.data.equals(one.data));

  /* 多个智能体：结构和单个一致，只是根目录名与 agent/ 下多一个 */
  const many = buildAgentBundle(root, ['weather-reporter', 'second-agent'], { dshHome: 'C:\\Fake\\home' });
  eq('打包: 多智能体计数', many.summary.agentCount, 2);
  const mNames = readZip(many.data).map((e) => e.name);
  const mRoot = mNames[0].split('/')[0];
  check('打包: 多智能体时根目录名反映数量', mRoot.includes('2个'), mRoot);
  check('打包: 多智能体时两个本体都在',
    mNames.includes(`${mRoot}/agent/weather-reporter/agent.cordis.yml`) &&
    mNames.includes(`${mRoot}/agent/second-agent/agent.cordis.yml`));

  /* 多智能体包里，second-agent 没有任何额外依赖 —— 依赖清单必须对「干净的那一个」
     给出正面结论，而不是只字不提。这条同时验证了多智能体时的分段渲染。 */
  const manyEntries = readZip(many.data);
  const manyDeps = manyEntries.find((e) => e.name === `${mRoot}/依赖清单.txt`).data.toString('utf8');
  check('打包: 多智能体时依赖清单按智能体分段', manyDeps.includes('【') && manyDeps.includes('second-agent'), manyDeps.slice(0, 200));
  check('打包: 干净的那个智能体得到正面结论', manyDeps.includes('没扫到明显'), manyDeps.slice(0, 300));

  // 不传 ids → 自动取可打包集合
  const auto = buildAgentBundle(root, null, { dshHome: 'C:\\Fake\\home' });
  eq('打包: 不传 ids 时自动打包全部可打包项', auto.summary.agentCount, 2);

  builtBundle = { root, one, rootName };

  /* ── 闸门：坏输入必须被拒 ── */
  const t = (name, fn, needle) => {
    let threw = '';
    try { fn(); } catch (e) { threw = String(e.message || e); }
    check(name, !!threw && threw.includes(needle), `实际: ${threw || '(没抛)'}`);
  };

  t('闸门: 路径穿越 id 被拒', () => buildAgentBundle(root, ['../escape'], {}), '不合法');
  t('闸门: 绝对路径 id 被拒', () => buildAgentBundle(root, ['C:\\Windows'], {}), '不合法');
  t('闸门: 带斜杠的 id 被拒', () => buildAgentBundle(root, ['a/b'], {}), '不合法');
  t('闸门: 空 id 被拒', () => buildAgentBundle(root, [''], {}), '不合法');
  t('闸门: 不存在的 id 被拒', () => buildAgentBundle(root, ['nope-not-here'], {}), '找不到智能体');
  t('闸门: 缺 agent.cordis.yml 被拒', () => buildAgentBundle(root, ['broken-pkg'], {}), '找不到智能体');

  // 造一个真的缺 yml 的
  mkdirSync(join(root, 'no-yml'), { recursive: true });
  writeFileSync(join(root, 'no-yml', 'preset.yml'), 'name: 无编排\n', 'utf8');
  t('闸门: 目录存在但缺 agent.cordis.yml 被拒', () => buildAgentBundle(root, ['no-yml'], {}), '缺少 agent.cordis.yml');

  // 空的 yml
  mkdirSync(join(root, 'empty-yml'), { recursive: true });
  writeFileSync(join(root, 'empty-yml', 'agent.cordis.yml'), '   \n', 'utf8');
  t('闸门: 空 agent.cordis.yml 被拒', () => buildAgentBundle(root, ['empty-yml'], {}), '是空的');

  // 没有 name: 条目的 yml
  mkdirSync(join(root, 'no-name'), { recursive: true });
  writeFileSync(join(root, 'no-name', 'agent.cordis.yml'), '- id: x\n  config: {}\n', 'utf8');
  t('闸门: 没有任何 name: 条目被拒', () => buildAgentBundle(root, ['no-name'], {}), '没有任何 name');

  t('闸门: 不存在的根目录被拒', () => buildAgentBundle(join(root, 'no-such-root'), ['x'], {}), '不存在');
  t('闸门: 空根目录字符串被拒', () => buildAgentBundle('', ['x'], {}), '找不到 DSH 主目录');

  rmSync(root, { recursive: true, force: true });
}

/* ══════════════════════════════════════════ ⑤ 路由装配 ══ */

const EXPECTED_ROUTES = [
  'exact /dsh-agent-maker/health',
  'exact /dsh-agent-maker/agents',
  'exact /dsh-agent-maker/export'
];

{
  const h = makeCtx();
  let threw = null;
  try { plugin.apply(h.ctx); } catch (e) { threw = e; }
  check('路由: apply() 不抛异常（抛了会带崩整棵插件树）', threw === null, threw && threw.message);
  eq('路由: 注册条数符合预期', h.routes.size, EXPECTED_ROUTES.length);
  for (const r of EXPECTED_ROUTES) {
    check(`路由: 已注册 ${r}`, h.routes.has(r));
  }
  check('路由: 注册了清理 effect', h.effectCount >= 1);
  check('路由: 声明了 webServer 注入', Array.isArray(plugin.inject) && plugin.inject.includes('webServer'),
    JSON.stringify(plugin.inject));

  /* 元测试：假 register 真的会在重复键上抛（否则上面那条断言毫无意义） */
  let caught = false;
  try {
    h.ctx.webServer.register({ kind: 'exact', path: '/dsh-agent-maker/health', handler: () => {} });
  } catch { caught = true; }
  check('元测试: 假 register 真的会拒绝重复的 (kind,path)', caught);

  /* 元测试：假 res 真的会拒绝非法响应头（坑 #58 的元测试） */
  let headerCaught = false;
  try {
    makeRes().writeHead(200, { 'content-disposition': 'attachment; filename="中文.zip"' });
  } catch { headerCaught = true; }
  check('元测试: 假 res 真的会拒绝非法响应头', headerCaught);
}

/* ══════════════════════════════════════════ ⑥ 路由行为 ══ */

{
  // 用真实机器上的 .agent-presets 跑一遍只读接口（有才有意义）
  const h = makeCtx();
  plugin.apply(h.ctx);

  const health = await callRoute(h, '/dsh-agent-maker/health', { method: 'GET' });
  eq('GET /health -> 200', health.statusCode, 200);
  const hb = health.json();
  eq('GET /health: ok', hb.ok, true);
  check('GET /health: 带构建号', typeof hb.build === 'string' && hb.build.length > 0, hb.build);
  check('GET /health: 报告了预设根路径', typeof hb.presetsRoot === 'string', hb.presetsRoot);
  check('GET /health: 报告了预设数量', Number.isInteger(hb.presetCount));

  const agents = await callRoute(h, '/dsh-agent-maker/agents', { method: 'GET' });
  eq('GET /agents -> 200', agents.statusCode, 200);
  const ab = agents.json();
  check('GET /agents: 返回 agents 数组', Array.isArray(ab.agents));
  check('GET /agents: 返回 packable 数组', Array.isArray(ab.packable));
  check('GET /agents: 每一项都有 packable 布尔值',
    ab.agents.every((a) => typeof a.packable === 'boolean'));

  const wrongMethod = await callRoute(h, '/dsh-agent-maker/agents', { method: 'POST' });
  eq('POST /agents -> 405', wrongMethod.statusCode, 405);

  /* ── export 的闸门 ── */
  const noOrigin = await callRoute(h, '/dsh-agent-maker/export', {
    method: 'POST', headers: { host: '127.0.0.1:3080' }, body: '{}'
  });
  eq('POST /export 无 Origin -> 403', noOrigin.statusCode, 403);

  const forwarded = await callRoute(h, '/dsh-agent-maker/export', {
    method: 'POST',
    headers: Object.assign(sameOriginHeaders(), { 'x-forwarded-for': '1.2.3.4' }),
    body: '{}'
  });
  eq('POST /export 带转发头 -> 403', forwarded.statusCode, 403);

  const remote = await callRoute(h, '/dsh-agent-maker/export', {
    method: 'POST', headers: sameOriginHeaders(), body: '{}', remote: '10.0.0.9'
  });
  eq('POST /export 非回环来源 -> 403', remote.statusCode, 403);

  const crossOrigin = await callRoute(h, '/dsh-agent-maker/export', {
    method: 'POST',
    headers: { host: '127.0.0.1:3080', origin: 'http://evil.example', 'content-type': 'application/json' },
    body: '{}'
  });
  eq('POST /export 跨源 Origin -> 403', crossOrigin.statusCode, 403);

  const badMethod = await callRoute(h, '/dsh-agent-maker/export', { method: 'GET' });
  eq('GET /export -> 405', badMethod.statusCode, 405);

  const badJson = await callRoute(h, '/dsh-agent-maker/export', {
    method: 'POST', headers: sameOriginHeaders(), body: 'not json'
  });
  eq('POST /export 非 JSON body -> 400', badJson.statusCode, 400);

  const badId = await callRoute(h, '/dsh-agent-maker/export', {
    method: 'POST', headers: sameOriginHeaders(), body: JSON.stringify({ ids: ['../../etc/passwd'] })
  });
  eq('POST /export 穿越 id -> 400', badId.statusCode, 400);
  check('POST /export 穿越 id 的错误信息说明是 id 不合法',
    String(badId.json().error).includes('不合法'), badId.json().error);

  const unknownId = await callRoute(h, '/dsh-agent-maker/export', {
    method: 'POST', headers: sameOriginHeaders(), body: JSON.stringify({ ids: ['definitely-not-installed'] })
  });
  eq('POST /export 未知 id -> 400', unknownId.statusCode, 400);

  /* 真机器上如果确实有可打包的智能体，就跑一次完整导出 */
  const realPackable = Array.isArray(ab.packable) ? ab.packable : [];
  if (realPackable.length > 0) {
    const ok = await callRoute(h, '/dsh-agent-maker/export', {
      method: 'POST',
      headers: sameOriginHeaders(),
      body: JSON.stringify({ ids: realPackable })
    });
    eq('POST /export 真实数据 -> 200', ok.statusCode, 200);
    check('POST /export: content-type 是 zip',
      String(ok.headers['content-type']).includes('zip'), ok.headers['content-type']);
    check('POST /export: 体积与 content-length 一致',
      ok.body().length === ok.headers['content-length'],
      `${ok.body().length} vs ${ok.headers['content-length']}`);
    const body = ok.body();
    check('POST /export: body 真的是 zip（PK 魔数）',
      body[0] === 0x50 && body[1] === 0x4b && body[2] === 0x03 && body[3] === 0x04);
    check('POST /export: content-disposition 同时给了 ASCII 兜底与 filename*',
      String(ok.headers['content-disposition']).includes('filename="') &&
      String(ok.headers['content-disposition']).includes("filename*=UTF-8''"),
      ok.headers['content-disposition']);
    const real = readZip(body);
    check('POST /export: 真实数据产出的 zip 能解开（CRC 与结构都合法）', real.length > 5,
      `${real.length} 个条目`);
    check('POST /export: zip 里的 install.ps1 带 BOM',
      real.find((e) => e.name.endsWith('install.ps1')).data[0] === 0xef);
  } else {
    console.log('  （本机 .agent-presets 里没有可打包的智能体，跳过真实数据导出）');
  }
}

/* ══════════════════════════════════════════ ⑦ 路径探测 ══ */

{
  const home = findDshHome();
  check('findDshHome: 从插件自身位置向上找到了 DSH_HOME', !!home && existsSync(join(home, 'profiles')),
    home || '(空)');
  check('findDshHome: 忽略不含 profiles 的 DSH_HOME 环境变量',
    findDshHome({ DSH_HOME: 'C:\\definitely\\not\\a\\dsh\\home' }) === home ||
    !existsSync(join('C:\\definitely\\not\\a\\dsh\\home', 'profiles')));
}

{
  // 造一个假的 home：应从 HERE 向上找不到，但 env 能命中
  const fake = mkdtempSync(join(tmpdir(), 'fake-home-'));
  mkdirSync(join(fake, 'profiles'), { recursive: true });
  eq('findDshHome: 环境变量命中时优先用它',
    findDshHome({ DSH_HOME: fake }, HERE), fake);
  rmSync(fake, { recursive: true, force: true });
}

/* ══════════════════════════════════════════ ⑧ zip 写入器 ══ */

{
  const z = makeZip([{ name: 'a.txt', data: Buffer.from('hello 世界', 'utf8') }]);
  const r = readZip(z);
  eq('makeZip: 单条目可解', r.length, 1);
  eq('makeZip: 内容一致', r[0].data.toString('utf8'), 'hello 世界');
  const z2 = makeZip([{ name: 'a.txt', data: Buffer.from('hello 世界', 'utf8') }]);
  check('makeZip: 确定性（同样输入同样字节）', z.equals(z2));

  // 大文件走 deflate 分支
  const big = Buffer.alloc(50000, 65);
  const z3 = makeZip([{ name: 'big.bin', data: big }]);
  const r3 = readZip(z3);
  eq('makeZip: 大文件走压缩分支后可解', r3[0].data.length, big.length);
  check('makeZip: 大文件确实被压缩了', z3.length < big.length, `${z3.length} vs ${big.length}`);
  eq('makeZip: 大文件 method=8', r3[0].method, 8);
}

/* ══════════════════════════════════════════ 收尾 ══ */

/* ══════════════════════════════════════ ⑨ 客户端半静态一致性 ══ */

{
  const clientSrc = readFileSync(join(HERE, '..', 'client.js'), 'utf8');
  const hostSrc = readFileSync(join(HERE, '..', 'index.js'), 'utf8');

  /* 两边的前缀必须一致 —— 不然按钮点了永远 404，而且没有任何报错线索。 */
  const clientPrefix = /PACK_PREFIX\s*=\s*'([^']+)'/.exec(clientSrc);
  const hostPrefix = /const PREFIX\s*=\s*'([^']+)'/.exec(hostSrc);
  check('一致性: 客户端声明了 PACK_PREFIX', !!clientPrefix);
  check('一致性: 宿主声明了 PREFIX', !!hostPrefix);
  eq('一致性: 客户端与宿主的路径前缀完全相同',
    clientPrefix && clientPrefix[1], hostPrefix && hostPrefix[1]);

  /* 客户端引用的每条路由，宿主都必须真的注册了 */
  for (const suffix of ['/export', '/agents', '/health']) {
    check(`一致性: 宿主注册了 ${suffix}`, hostSrc.includes('${PREFIX}' + suffix));
  }

  /* 坑 #59：window.prompt 在 Electron 里直接抛异常，按钮会「点了完全没反应」 */
  check('客户端: 不调用 window.prompt（Electron 未实现，会静默不响应）',
    !clientSrc.includes('window.prompt('));

  /* 两个入口都得在（每个智能体一个 + 顶部打包全部） */
  check('客户端: 有「打包全部」入口', clientSrc.includes('打包全部'));
  check('客户端: 打包逻辑存在', clientSrc.includes('function packAgents('));
  check('客户端: 打包失败会写出可见错误（不留静默失败）',
    clientSrc.includes('packErr') && clientSrc.includes('打包失败'));
  check('客户端: 成功提示里带导出的文件名', /已导出「/.test(clientSrc));
}

if (tmpRoot) { try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {} }

console.log('');
console.log(`  通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) {
  console.log('');
  for (const f of failures) console.log('  FAIL  ' + f);
  process.exit(1);
}
console.log('  全部通过 ✅');
