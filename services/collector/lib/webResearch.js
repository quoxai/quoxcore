'use strict';

/**
 * webResearch.js: provider-agnostic web search and page read for the research
 * agent (SCHOLAR). Backs the web_search and web_read agent tools.
 *
 * Search provider is an org platform setting (RESEARCH_SEARCH_PROVIDER:
 * none | searxng | brave | tavily). Keys come from the org vault through
 * providerKeys, never from process.env, and are never logged. Page reads go
 * through the collector egress guard on EVERY redirect hop.
 *
 * Evidence: each call emits an AEE envelope (quox.research.search or
 * quox.research.read) carrying provider, query or host and a result count.
 * Page content is never put in evidence.
 */

const TurndownService = require('turndown');
const configResolver = require('./configResolver.js');

const NO_PROVIDER = {
  success: false,
  error: 'no_search_provider',
  message: 'Web search is not set up for this organisation. An admin can choose a provider in Settings (RESEARCH_SEARCH_PROVIDER).',
};

const MAX_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10000;
const MAX_HOPS = 3;
const TITLE_MAX = 200;
const SNIPPET_MAX = 400;
const QUERY_MAX = 400;

function clip(v, n) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
}

function normalise(items) {
  return items
    .filter((i) => i && i.url)
    .map((i) => ({ title: clip(i.title, TITLE_MAX), url: String(i.url).trim(), snippet: clip(i.snippet, SNIPPET_MAX) }));
}

function resolveDeps(deps = {}) {
  return {
    fetchImpl: deps.fetchImpl || (typeof fetch === 'function' ? fetch : null),
    getSetting: deps.getSetting || ((orgId, key) => {
      try { const r = configResolver.getSetting(orgId, key); return r && typeof r.value === 'string' ? r.value : ''; } catch { return ''; }
    }),
    getProviderKeys: deps.getProviderKeys || (async () => ({})),
    assertSafeEgressHost: deps.assertSafeEgressHost || ((h) => require('./securityDomainVerification.js').assertSafeEgressHost(h)),
    emit: deps.emit || null,
  };
}

async function emitEvidence(d, intent, payload) {
  if (!d.emit) return;
  try { await d.emit({ intent, payload }); } catch { /* evidence is best-effort */ }
}

async function getJson(d, url, init) {
  const res = await d.fetchImpl(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`search provider returned HTTP ${res.status}`);
  return res.json();
}

const PROVIDERS = {
  async searxng(d, { query, count, orgId }) {
    const base = clip(d.getSetting(orgId, 'RESEARCH_SEARXNG_URL'), 300).replace(/\/+$/, '');
    if (!base) return null;
    const j = await getJson(d, `${base}/search?q=${encodeURIComponent(query)}&format=json`, { headers: { Accept: 'application/json' } });
    return normalise((j.results || []).slice(0, count).map((r) => ({ title: r.title, url: r.url, snippet: r.content })));
  },
  async brave(d, { query, count, orgId }) {
    const key = (await d.getProviderKeys(orgId))?.brave_api_key;
    if (!key) return null;
    const j = await getJson(d, `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': key },
    });
    return normalise(((j.web && j.web.results) || []).slice(0, count).map((r) => ({ title: r.title, url: r.url, snippet: r.description })));
  },
  async tavily(d, { query, count, orgId }) {
    const key = (await d.getProviderKeys(orgId))?.tavily_api_key;
    if (!key) return null;
    const j = await getJson(d, 'https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query, max_results: count }),
    });
    return normalise((j.results || []).slice(0, count).map((r) => ({ title: r.title, url: r.url, snippet: r.content })));
  },
};

async function webSearch({ query, count = 6 } = {}, { orgId, deps } = {}) {
  const d = resolveDeps(deps);
  const q = clip(query, QUERY_MAX);
  if (!q) return { success: false, error: 'query is required' };
  const n = Math.min(Math.max(parseInt(count, 10) || 6, 1), 10);
  const provider = clip(d.getSetting(orgId, 'RESEARCH_SEARCH_PROVIDER'), 20) || 'none';
  const impl = PROVIDERS[provider];
  if (!impl) return { ...NO_PROVIDER };
  let results;
  try {
    results = await impl(d, { query: q, count: n, orgId });
  } catch (err) {
    await emitEvidence(d, 'quox.research.search', { provider, query: q, resultCount: 0, ok: false });
    return { success: false, error: 'search_failed', message: `Web search failed (${provider}): ${clip(err.message, 200)}` };
  }
  if (results === null) return { ...NO_PROVIDER };
  await emitEvidence(d, 'quox.research.search', { provider, query: q, resultCount: results.length, ok: true });
  return { success: true, provider, query: q, count: results.length, results };
}

let _td = null;
function turndown() {
  if (!_td) {
    _td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    _td.remove(['script', 'style', 'nav', 'footer', 'iframe', 'noscript', 'svg', 'form']);
  }
  return _td;
}

function stripBoilerplate(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|nav|footer|noscript|svg)\b[\s\S]*?<\/\1>/gi, '');
}

async function readBodyCapped(res) {
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) { try { await reader.cancel(); } catch { /* ignore */ } throw new Error('too_large'); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const text = await res.text();
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('too_large');
  return text;
}

async function webRead({ url, maxChars = 12000 } = {}, { deps } = {}) {
  const d = resolveDeps(deps);
  const limit = Math.min(Math.max(parseInt(maxChars, 10) || 12000, 500), 50000);
  let current;
  try { current = new URL(String(url || '').trim()); } catch { return { success: false, error: 'invalid_url' }; }

  let res = null;
  let host = current.hostname;
  try {
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      if (current.protocol !== 'http:' && current.protocol !== 'https:') return { success: false, error: 'invalid_url', message: 'Only http and https URLs can be read.' };
      host = current.hostname;
      await d.assertSafeEgressHost(host);
      res = await d.fetchImpl(current.toString(), {
        redirect: 'manual',
        headers: { Accept: 'text/html,text/plain;q=0.9', 'User-Agent': 'QuoxResearch/1.0' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers && res.headers.get && res.headers.get('location');
        if (!loc) return { success: false, error: 'bad_redirect' };
        if (hop === MAX_HOPS) return { success: false, error: 'too_many_redirects' };
        current = new URL(loc, current);
        continue;
      }
      break;
    }
  } catch (err) {
    const msg = clip(err && err.message, 200);
    await emitEvidence(d, 'quox.research.read', { host, ok: false, resultCount: 0 });
    if (/blocked_host|dns_resolution_failed|no_dns_records/.test(msg)) return { success: false, error: 'blocked_host', message: msg };
    return { success: false, error: 'fetch_failed', message: msg };
  }

  if (!res.ok) {
    await emitEvidence(d, 'quox.research.read', { host, ok: false, resultCount: 0 });
    return { success: false, error: 'http_error', message: `The page returned HTTP ${res.status}.` };
  }
  const ctype = String((res.headers && res.headers.get && res.headers.get('content-type')) || '').toLowerCase();
  const isHtml = ctype.includes('text/html') || ctype.includes('application/xhtml');
  const isText = ctype.startsWith('text/plain');
  if (!isHtml && !isText) {
    await emitEvidence(d, 'quox.research.read', { host, ok: false, resultCount: 0 });
    return { success: false, error: 'unsupported_content_type', message: `Cannot read content type "${clip(ctype, 60) || 'unknown'}".` };
  }

  let raw;
  try { raw = await readBodyCapped(res); } catch (err) {
    await emitEvidence(d, 'quox.research.read', { host, ok: false, resultCount: 0 });
    return err.message === 'too_large'
      ? { success: false, error: 'too_large', message: 'The page is larger than 2 MB.' }
      : { success: false, error: 'fetch_failed', message: clip(err.message, 200) };
  }

  let title = '';
  let md;
  if (isHtml) {
    const m = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    title = clip(m ? m[1] : '', TITLE_MAX);
    md = turndown().turndown(stripBoilerplate(raw)).replace(/\n{3,}/g, '\n\n').trim();
  } else {
    md = raw.trim();
  }
  const truncated = md.length > limit;
  await emitEvidence(d, 'quox.research.read', { host, ok: true, resultCount: 1 });
  return {
    success: true,
    url: String(url).trim(),
    final_url: current.toString(),
    title,
    content_markdown: truncated ? md.slice(0, limit) : md,
    truncated,
    fetched_at: new Date().toISOString(),
  };
}

module.exports = { webSearch, webRead, NO_PROVIDER };
