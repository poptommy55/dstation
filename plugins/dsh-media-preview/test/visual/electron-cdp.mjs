/**
 * 用 puppeteer 的 browserURL 连接模式驱动本机 Electron（不需要下载 Chrome，
 * 也不需要 Electron 的 main 里额外做手脚）。
 *
 * 背景：DSH 整合包里的 dsh-live-canvas 插件就是用 puppeteer-core + 整合包内的
 * Chromium 做真实浏览器预览的，说明这条链路在本机是可行的；本次踩的坑只是
 * Electron 不支持 Target.createTarget（不能自己 newPage）。因此这里改为连一个
 * 已经存在的 page：优先用 file:// 入口页，由脚本注入 iframe 加载夹具。
 *
 * 用法：node test/visual/electron-cdp.mjs <fixtureUrl> <outDir>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const [fixtureUrl, outDir] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const PROFILE_MODULES = '<repo-root>/build/dist/home/profiles/web/node_modules';
const ELECTRON_EXE = '<repo-root>/build/electron-app/node_modules/electron/dist/electron.exe';

const requireFromProfile = createRequire(pathToFileURL(join(PROFILE_MODULES, 'anchor.js')).href);
const puppeteer = requireFromProfile('puppeteer-core');

mkdirSync(outDir, { recursive: true });
const out = [];
const record = (s) => { out.push(s); console.log(s); };

const { spawn } = await import('node:child_process');
const userDataDir = join(outDir, 'electron-userdata-cdp');
mkdirSync(userDataDir, { recursive: true });
const DEBUG_PORT = 45200 + (process.pid % 400);

const entryHtml = join(outDir, 'runner.html');
writeFileSync(entryHtml, `<!doctype html><meta charset="utf-8"><title>runner</title>
<body><div id="host"></div></body>`, 'utf8');

const child = spawn(ELECTRON_EXE, [
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${userDataDir}`,
  '--no-sandbox',
  '--disable-gpu',
  pathToFileURL(entryHtml).href
], { stdio: ['ignore', 'ignore', 'ignore'] });

const url = `http://127.0.0.1:${DEBUG_PORT}`;
let browser = null;
const deadline = Date.now() + 60000;
while (Date.now() < deadline) {
  try {
    browser = await puppeteer.connect({ browserURL: url, defaultViewport: { width: 1100, height: 900 } });
    break;
  } catch (error) {
    record(`connect retry: ${error.message.split('\n')[0]}`);
    await new Promise((r) => setTimeout(r, 800));
  }
}

let failed = false;
try {
  if (browser === null) throw new Error(`60s 内无法通过 ${url} 连接 Electron`);
  const version = await browser.version();
  record(`connected: ${version}`);

  const pages = await browser.pages();
  record(`pages = ${pages.length}: ${pages.map((p) => p.url()).join(' , ')}`);
  const page = pages.find((p) => p.url().startsWith('file://')) ?? pages[0];
  record(`driver page = ${page.url()}`);

  // Electron 不支持 newPage，但直接驱动现有 page 去导航是可以的
  // （跨源 iframe 会被同源策略挡在 contentDocument 之外，所以必须整页导航）。
  await page.goto(fixtureUrl, { waitUntil: 'load', timeout: 30000 });
  record(`navigated to ${page.url()}`);

  // 等夹具自报完成
  try {
    await page.waitForFunction(() => {
      const el = document.getElementById('verdict');
      return el !== null && el.textContent.indexOf('夹具运行中') < 0;
    }, { timeout: 30000 });
  } catch (waitError) {
    // 不死等：把现场证据打出来，否则什么都看不到
    const diag = await page.evaluate(() => ({
      verdict: document.getElementById('verdict')?.textContent ?? '(none)',
      cardCount: document.querySelectorAll('[data-dsh-media-card]').length,
      hostCount: document.querySelectorAll('[data-dsh-media-host]').length,
      hasBundle: typeof window.__DSH_MEDIA_BUNDLE__ !== 'undefined',
      hasReact: typeof window.React !== 'undefined',
      hasReactDOMClient: typeof window.ReactDOMClient !== 'undefined',
      hasRequire: typeof window.require === 'function',
      env: typeof window.__FIXTURE_ENV__ === 'function' ? window.__FIXTURE_ENV__() : '(none)',
      scripts: [...document.scripts].map((s) => s.src || `inline#${s.id || ''}`),
      bodyStart: document.body.innerHTML.slice(0, 500)
    }));
    record('=== 夹具未完成的现场诊断 ===');
    record(JSON.stringify(diag, null, 2));
    throw waitError;
  }

  const report = await page.evaluate(() => {
    const d = document;
    const cards = [...d.querySelectorAll('[data-dsh-media-card]')].map((n) => {
      const img = n.querySelector('img');
      return {
        state: n.getAttribute('data-state'),
        kind: n.querySelector('.dsh-mp-kind')?.textContent ?? '',
        name: n.querySelector('.dsh-mp-name')?.textContent ?? '',
        size: n.querySelector('.dsh-mp-size')?.textContent ?? '',
        hasImg: img !== null,
        imgNatural: img === null ? 0 : img.naturalWidth,
        hasAudio: n.querySelector('audio') !== null,
        note: n.querySelector('.dsh-mp-status')?.textContent ?? '',
        buttons: [...n.querySelectorAll('.dsh-mp-btn')].map((b) => b.textContent.trim())
      };
    });
    return {
      verdict: d.getElementById('verdict')?.textContent ?? '(no verdict)',
      transcript: document.getElementById('mock-transcript')?.textContent.replace(/\s+/g, ' ') ?? '',
      cards
    };
  });

  record('');
  record('=== 夹具自报 ===');
  record(report.verdict);
  record('');
  record('=== 卡片清单 ===');
  record(JSON.stringify(report.cards, null, 2));
  record('');
  record('=== 正文可见文本 ===');
  record(report.transcript.slice(0, 1000));

  await page.screenshot({ path: join(outDir, 'fixture-cards.png') });

  const problems = [];
  const okCards = report.cards.filter((c) => c.state === 'ok');
  const errCards = report.cards.filter((c) => c.state === 'error');
  if (okCards.length !== 2) problems.push(`期望 2 张正常卡片，实际 ${okCards.length}`);
  if (errCards.length !== 1) problems.push(`期望 1 张错误卡片，实际 ${errCards.length}`);
  if (!okCards.some((c) => c.hasImg && c.imgNatural > 0)) problems.push('图片没有真正解码（naturalWidth=0）');
  if (!okCards.some((c) => c.hasAudio)) problems.push('没有渲染 <audio>');
  if (!report.cards.every((c) => c.buttons.includes('下载'))) problems.push('缺少「下载」按钮');
  if (report.transcript.includes('cover.png') || report.transcript.includes('voice.mp3')) problems.push('正文里仍有被取代的路径');
  if (!report.transcript.includes('这个文件其实不存在')) problems.push('正文其余文字被误删');
  if (!report.transcript.includes('不要动代码块')) problems.push('代码块被误删');
  if (!report.transcript.includes('D:\\tmp\\a.png')) problems.push('代码块内路径被误吃');

  record('');
  if (problems.length === 0) record('VERDICT: PASS');
  else { failed = true; record('VERDICT: FAIL'); problems.forEach((p) => record(`  - ${p}`)); }
} catch (error) {
  failed = true;
  record(`ERROR: ${error?.stack ?? error}`);
} finally {
  try { await browser?.disconnect(); } catch { /* ignore */ }
  try { child.kill(); } catch { /* ignore */ }
  writeFileSync(join(outDir, 'browser-verify.txt'), out.join('\n') + '\n', 'utf8');
}

process.exit(failed ? 1 : 0);
