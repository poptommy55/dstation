/**
 * dsh-web-search-bing
 *
 * Keyless web search provider registered into the dsh `ctx.web` seam.
 * Scrapes cn.bing.com result pages, so it needs no API key and does not touch
 * DeepSeek's official endpoint. Written for dsh 0.1.2-rc.1, which does NOT
 * export `installSettingsSection` from dsh-settings (older community plugins
 * that import it fail to load on this version).
 *
 * This version additionally installs a Settings section, so the endpoint,
 * result count and timeout can be edited from
 * Settings > Plugins > Plugin configuration.
 */

import z from '@deepseek-ai/schemastery';

const PROVIDER_ID = 'bing-keyless';
const SETTINGS_NAMESPACE = 'web-search-bing';
const DEFAULT_ENDPOINT = 'https://cn.bing.com/search';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const Config = z.object({
  endpoint: z.string().default(DEFAULT_ENDPOINT),
  maxResults: z.number().step(1).min(1).max(20).default(8),
  timeoutMs: z.number().step(1000).min(3000).max(60000).default(20000),
});

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&ensp;': ' ',
  '&emsp;': ' ',
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
  '&ldquo;': '“',
  '&rdquo;': '”',
  '&lsquo;': '‘',
  '&rsquo;': '’',
  '&middot;': '·',
};

function decodeHtml(input) {
  return String(input)
    .replace(/&[a-z]+;|&#\d+;/gi, (m) => {
      if (ENTITIES[m]) return ENTITIES[m];
      const num = m.match(/&#(\d+);/);
      return num ? String.fromCharCode(Number(num[1])) : m;
    })
    .trim();
}

function stripTags(html) {
  return decodeHtml(String(html).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/** cn.bing.com wraps external hits in `/ck/a?...&u=<base64>`; unwrap when present. */
function normalizeUrl(raw) {
  if (!raw) return '';
  let url = decodeHtml(raw);
  if (url.startsWith('//')) url = 'https:' + url;
  if (url.startsWith('/')) url = 'https://cn.bing.com' + url;
  try {
    const parsed = new URL(url);
    const u = parsed.searchParams.get('u');
    if (u && (parsed.pathname === '/ck/a' || u.startsWith('a1'))) {
      const decoded = Buffer.from(u.replace(/^a1/, ''), 'base64').toString('utf8');
      if (decoded.startsWith('http')) return decoded;
    }
  } catch {
    /* keep original when it is not a parseable absolute URL */
  }
  return url;
}

function parseBing(html, maxResults) {
  const sources = [];
  const blocks = html.split(/<li class="b_algo/).slice(1);
  for (const block of blocks) {
    const anchor = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const url = normalizeUrl(anchor[1]);
    const title = stripTags(anchor[2]);
    if (!url || !title || !/^https?:\/\//i.test(url)) continue;
    if (sources.some((s) => s.url === url)) continue;
    const caption = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = caption ? stripTags(caption[1]) : '';
    sources.push(snippet ? { url, title, snippet } : { url, title });
    if (sources.length >= maxResults) break;
  }
  return sources;
}

async function runSearch(request, config, signal) {
  const query = String(request?.query ?? '').trim();
  if (!query) throw new Error('query must be a non-empty string');
  const maxResults = Number(request?.maxResults ?? config?.maxResults ?? 8);
  const base = String(config?.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const timeoutMs = Number(config?.timeoutMs ?? 20000);
  const endpoint = `${base}?q=${encodeURIComponent(query)}&ensearch=0&count=20`;

  const timeout = AbortSignal.timeout(timeoutMs);
  const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const response = await fetch(endpoint, {
    headers: {
      'user-agent': UA,
      'accept-language': 'zh-CN,zh;q=0.9',
      accept: 'text/html,application/xhtml+xml',
    },
    signal: abort,
  });
  if (!response.ok) throw new Error(`Bing 返回 HTTP ${response.status}`);
  const html = await response.text();
  const sources = parseBing(html, maxResults);
  if (sources.length === 0) throw new Error('Bing 未返回可解析结果（可能触发反爬验证）');
  return { sources, truncated: false };
}

export const name = 'web-search-bing';
export const inject = ['web'];

export function apply(ctx, config = {}) {
  // Kept as a thunk: once the Settings section is installed, the authoritative
  // config becomes whatever the user saved there, not the bootstrap object.
  let current = () => config;

  // Guard kept so the plugin still works in contexts without the settings
  // service (older hosts, headless harnesses): search degrades, never crashes.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (settingsCtx) => {
      const settings = settingsCtx?.settings;
      if (!settings || typeof settings.installSection !== 'function') return;
      settings.installSection(ctx, SETTINGS_NAMESPACE, Config, config, {
        setSource: (source) => {
          current = source;
        },
        onChange: () => {},
      });
    });
  }

  const provider = {
    id: PROVIDER_ID,
    available: () => true,
    search: (request, signal) => runSearch(request, current(), signal),
  };

  if (typeof ctx.effect === 'function') {
    ctx.effect(function* () {
      const dispose = ctx.web.registerSearchProvider(provider);
      yield () => dispose();
    });
  } else {
    ctx.web.registerSearchProvider(provider);
  }
}

export default { name, inject, Config, apply };
