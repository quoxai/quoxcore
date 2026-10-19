'use strict';

/**
 * webResearch.js: provider-agnostic web search and page read for the research
 * agent (SCHOLAR). Backs the web_search and web_read agent tools.
 *
 * Search provider is an org platform setting (RESEARCH_SEARCH_PROVIDER:
 * none | searxng | brave | tavily). Keys come from the org vault through
 * providerKeys, never from process.env, and are never logged. Page reads go
 * through the collector egress guard on EVERY redirect hop, and so does the search
 * provider fetch (FND_01M5AAZNW7E1S4N7RPFFF8J6VP).
 *
 * Evidence: each call emits an AEE envelope (quox.research.search or
 * quox.research.read) carrying provider, query or host and a result count.
 * Page content is never put in evidence.
 */

const TurndownService = require('turndown');
const configResolver = require('./configResolver.js');
const net = require('node:net');
const { pinnedFetch, pinnedLookup } = require('./pinnedHttp.js');
const { alwaysDeniedIpReason, interfaceCidrs, isSingleLabelHost } = require('./agentFetchEgressPolicy.js');

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

// SDK-TEAM #5002: the org agent-fetch allowlist store (same instance as web_fetch_allowlisted), wired once at startup.
let _allowlistStore = null;
// FND_01M5AE7GAQBRAPE798VNYAFS39: the server's audit sink (storeAuditEnvelope), wired once at startup like
// web_fetch_allowlisted's. A normal delegated turn carries no ctx.emitEnvelope, so without this a refused egress
// attempt left no AEE record.
let _audit = null;
function configureWebResearch({ store, audit } = {}) {
  if (store && typeof store.matchEntry === 'function') _allowlistStore = store;
  if (typeof audit === 'function') _audit = audit;
}

function resolveDeps(deps = {}) {
  return {
    allowlistStore: deps.agentFetchAllowlistStore || _allowlistStore,
    resolver: deps.resolver || require('node:dns').promises,
    networkInterfaces: deps.networkInterfaces || undefined,
    fetchImpl: deps.fetchImpl || pinnedFetch,
    getSetting: deps.getSetting || ((orgId, key) => {
      try { const r = configResolver.getSetting(orgId, key); return r && typeof r.value === 'string' ? r.value : ''; } catch { return ''; }
    }),
    getProviderKeys: deps.getProviderKeys || (async () => ({})),
    assertSafeEgressHost: deps.assertSafeEgressHost || ((h) => require('./securityDomainVerification.js').assertSafeEgressHost(h)),
    emit: deps.emit || null,
    agentId: deps.agentId || null,
  };
}

// DNS pinning: connect to the address the guard just checked. The real guard always returns {ips} (and throws
// when there are none); an injected guard that returns nothing simply yields an unpinned init.
function pinFor(host, checked) {
  const ip = checked && Array.isArray(checked.ips) ? checked.ips[0] : null;
  return ip ? { lookup: pinnedLookup(host, ip) } : {};
}

async function emitEvidence(d, intent, payload) {
  if (d.emit) {
    try { await d.emit({ intent, payload }); } catch { /* evidence is best-effort */ }
    return;
  }
  if (!_audit) return;
  try {
    await _audit({
      type: 'event', from: `agent.${d.agentId || 'unknown'}`, to: 'audit.system', intent,
      corr: `RESEARCH_${d.orgId || 'noorg'}`,
      payload: { org_id: d.orgId || null, agent_id: d.agentId || null, ...payload },
    });
  } catch (err) { console.error(`[webResearch] ${intent} receipt failed: ${err.message}`); }
}

// FND_01M5AAZNW7E1S4N7RPFFF8J6VP: the provider fetch goes through the egress guard on EVERY hop, exactly like
// web_read (RESEARCH_SEARXNG_URL is an org setting and could point inside the network): manual redirects re-checked
// up to MAX_HOPS, a timeout per hop, and the body capped at MAX_BYTES before it is parsed.
//
// SDK-TEAM #5002: for the SearXNG provider only, an origin the org's agent fetch allowlist names WITH allow_private
// (instance-admin set) may resolve to a private address. The always-denied set (loopback, link-local/metadata, the
// collector's own CIDRs, Docker bridge, single-label hosts) is refused even then, and a redirect may not leave that origin.
async function assertPrivateOriginHost(d, host) {
  if (isSingleLabelHost(host)) throw new Error(`blocked_host: ${host} is a single-label hostname (a container or service name), always refused`);
  let ips;
  if (net.isIP(host)) ips = [host];
  else {
    try { ips = (await d.resolver.lookup(host, { all: true })).map((r) => r.address); } catch { throw new Error(`dns_resolution_failed: ${host}`); }
  }
  if (!ips.length) throw new Error(`no_dns_records: ${host}`);
  const own = interfaceCidrs(d.networkInterfaces);
  for (const ip of ips) {
    const why = alwaysDeniedIpReason(ip, own);
    if (why) throw new Error(`blocked_host: ${host}: ${why}; always refused, whoever allowlisted it`);
  }
  return { ips };
}

function privateOriginFor(d, orgId, url) {
  if (!d.allowlistStore || !orgId) return null;
  try {
    const entry = d.allowlistStore.matchEntry({ orgId, url: url.toString() });
    return entry && entry.allow_private ? url.origin : null;
  } catch { return null; }
}

async function getJson(d, url, init, opts = {}) {
  let current = new URL(url);
  const privateOrigin = opts.allowPrivateFromAllowlist ? privateOriginFor(d, opts.orgId, current) : null;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') throw new Error('invalid_url: only http and https');
    const bare = current.hostname.replace(/^\[|\]$/g, '');
    if (privateOrigin && current.origin !== privateOrigin) throw new Error(`blocked_host: redirect to ${bare} leaves the admin-named origin`);
    const checked = privateOrigin ? await assertPrivateOriginHost(d, bare) : await d.assertSafeEgressHost(bare);
    const res = await d.fetchImpl(current.toString(), { ...init, redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), ...pinFor(bare, checked) });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers && res.headers.get && res.headers.get('location');
      if (!loc) throw new Error('bad_redirect');
      if (hop === MAX_HOPS) throw new Error('too_many_redirects');
      current = new URL(loc, current);
      continue;
    }
    if (!res.ok) throw new Error(`search provider returned HTTP ${res.status}`);
    // a real fetch Response always has a body (capped); a bare { json } object (injected fetch) is parsed as given
    const capped = (res.body && typeof res.body.getReader === 'function') || typeof res.text === 'function';
    return capped ? JSON.parse(await readBodyCapped(res)) : res.json();
  }
  throw new Error('too_many_redirects');
}

const PROVIDERS = {
  async searxng(d, { query, count, orgId }) {
    const base = clip(d.getSetting(orgId, 'RESEARCH_SEARXNG_URL'), 300).replace(/\/+$/, '');
    if (!base) return null;
    const j = await getJson(d, `${base}/search?q=${encodeURIComponent(query)}&format=json`, { headers: { Accept: 'application/json' } }, { orgId, allowPrivateFromAllowlist: true });
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
  d.orgId = orgId || null;
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
    const msg = clip(err && err.message, 200);
    const blocked = /blocked_host|dns_resolution_failed|no_dns_records/.test(msg);
    await emitEvidence(d, 'quox.research.search', { provider, query: q, resultCount: 0, ok: false, error: blocked ? 'blocked_host' : 'search_failed', reason: msg });
    if (blocked) return { success: false, error: 'blocked_host', message: `Web search refused (${provider}): ${msg}` };
    return { success: false, error: 'search_failed', message: `Web search failed (${provider}): ${msg}` };
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

async function webRead({ url, maxChars = 12000 } = {}, { orgId, deps } = {}) {
  const d = resolveDeps(deps);
  d.orgId = orgId || null;
  const limit = Math.min(Math.max(parseInt(maxChars, 10) || 12000, 500), 50000);
  let current;
  try { current = new URL(String(url || '').trim()); } catch { return { success: false, error: 'invalid_url' }; }

  let res = null;
  let host = current.hostname;
  try {
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      if (current.protocol !== 'http:' && current.protocol !== 'https:') return { success: false, error: 'invalid_url', message: 'Only http and https URLs can be read.' };
      host = current.hostname;
      const checked = await d.assertSafeEgressHost(host);
      res = await d.fetchImpl(current.toString(), {
        redirect: 'manual',
        ...pinFor(host, checked),
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
    const blocked = /blocked_host|dns_resolution_failed|no_dns_records/.test(msg);
    await emitEvidence(d, 'quox.research.read', { host, ok: false, resultCount: 0, error: blocked ? 'blocked_host' : 'fetch_failed', reason: msg });
    if (blocked) return { success: false, error: 'blocked_host', message: msg };
    return { success: false, error: 'fetch_failed', message: msg };
  }

  if (!res.ok) {
    await emitEvidence(d, 'quox.research.read', { host, ok: false, resultCount: 0, error: 'http_error', status: res.status });
    return { success: false, error: 'http_error', message: `The page returned HTTP ${res.status}.` };
  }
  const ctype = String((res.headers && res.headers.get && res.headers.get('content-type')) || '').toLowerCase();
  const isHtml = ctype.includes('text/html') || ctype.includes('application/xhtml');
  const isText = ctype.startsWith('text/plain');
  if (!isHtml && !isText) {
    await emitEvidence(d, 'quox.research.read', { host, ok: false, resultCount: 0, error: 'unsupported_content_type' });
    return { success: false, error: 'unsupported_content_type', message: `Cannot read content type "${clip(ctype, 60) || 'unknown'}".` };
  }

  let raw;
  try { raw = await readBodyCapped(res); } catch (err) {
    await emitEvidence(d, 'quox.research.read', { host, ok: false, resultCount: 0, error: err.message === 'too_large' ? 'too_large' : 'fetch_failed' });
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

module.exports = { webSearch, webRead, NO_PROVIDER, configureWebResearch };
