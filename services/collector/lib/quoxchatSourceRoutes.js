'use strict';
/**
 * Resolve corpus "# source:" hints (quox-website file paths) to public site
 * URLs, using the website router (src/App.jsx). Pure functions plus one thin
 * file reader. Never guesses: a source that is not a website page file with a
 * bare `<Route path="/x" element={<Component />} />` gets no URL.
 */
const fs = require('fs');
const path = require('path');
const { buildAllowedUrls, normaliseUrl } = require('./quoxchatGrounding');

const SITE_ORIGIN = 'https://quox.ai';

// Component identifier -> import path ('./pages/PricingPage'), from both
// `const X = lazy(() => import('...'))` and `import X from '...'`.
function parseImports(appSource) {
  const map = new Map();
  const lazyRe = /const\s+([A-Z][A-Za-z0-9_]*)\s*=\s*lazy\(\s*\(\)\s*=>\s*import\(\s*['"]([^'"]+)['"]\s*\)\s*\)/g;
  for (const m of appSource.matchAll(lazyRe)) map.set(m[1], m[2]);
  const impRe = /^import\s+([A-Z][A-Za-z0-9_]*)\s+from\s+['"](\.[^'"]+)['"]/gm;
  for (const m of appSource.matchAll(impRe)) map.set(m[1], m[2]);
  return map;
}

function stripExt(p) {
  return p.replace(/\.(jsx?|tsx?)$/, '');
}

// Build { 'src/pages/PricingPage' -> ['/pricing', ...] } (route order kept).
function buildRouteIndex(appSource) {
  const imports = parseImports(appSource);
  const byFile = new Map();
  // Drop JSX comments so commented-out routes never resolve.
  const src = String(appSource).replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  const routeRe = /<Route\s+path=["']([^"']+)["']\s+element=\{<([A-Z][A-Za-z0-9_]*)\s*\/>\}\s*\/>/g;
  for (const m of src.matchAll(routeRe)) {
    const routePath = m[1];
    const imp = imports.get(m[2]);
    if (!imp || !imp.startsWith('./')) continue;
    const file = path.posix.normalize(path.posix.join('src', imp));
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(routePath);
  }
  return byFile;
}

function isPublicRoute(r) {
  return typeof r === 'string' && r.startsWith('/') && !r.startsWith('/__') && !r.startsWith('/admin') && !/[:*]/.test(r);
}

// First website page file named by a "# source:" comment value, or null.
// Only the FIRST listed source counts; a non-website first source gets no URL.
function firstWebsiteSourceFile(sourceValue) {
  if (typeof sourceValue !== 'string') return null;
  const first = sourceValue.split(',')[0].trim().replace(/^quox-website\s+/, '');
  const m = first.match(/^(src\/[A-Za-z0-9_./-]+?\.(?:jsx?|tsx?))(?::[\d-]+)?(?:\s+\(.*\))?$/);
  return m ? m[1] : null;
}

// The products A-Z index (src/data/productsIndex.json) is cited by line; the
// cited line is the entry's "path". Only a path the router actually serves
// becomes a URL, so a stale index row can never produce a dead citation.
function resolveProductsIndexUrl(sourceValue, routeIndex) {
  if (typeof sourceValue !== 'string' || !routeIndex || !Array.isArray(routeIndex.productsLines)) return null;
  const first = sourceValue.split(',')[0].trim().replace(/^quox-website\s+/, '');
  const m = first.match(/^src\/data\/productsIndex\.json:(\d+)$/);
  if (!m) return null;
  const line = routeIndex.productsLines[Number(m[1]) - 1] || '';
  const pm = line.match(/"path"\s*:\s*"(\/[^"]*)"/);
  if (!pm) return null;
  const all = new Set([].concat(...[...routeIndex.values()]));
  if (!all.has(pm[1]) || !isPublicRoute(pm[1])) return null;
  return `${SITE_ORIGIN}${pm[1]}`;
}

function resolveSourceUrl(sourceValue, routeIndex) {
  const viaIndex = resolveProductsIndexUrl(sourceValue, routeIndex);
  if (viaIndex) return viaIndex;
  const file = firstWebsiteSourceFile(sourceValue);
  if (!file || !routeIndex) return null;
  const routes = (routeIndex.get(stripExt(file)) || []).filter(isPublicRoute);
  if (routes.length === 0) return null;
  return routes[0] === '/' ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}${routes[0]}`;
}

// Read the website router; null when the checkout is absent (skip gracefully).
function loadRouteIndex(websiteDir) {
  if (!websiteDir) return null;
  const appPath = path.join(websiteDir, 'src', 'App.jsx');
  if (!fs.existsSync(appPath)) return null;
  const idx = buildRouteIndex(fs.readFileSync(appPath, 'utf8'));
  const prodPath = path.join(websiteDir, 'src', 'data', 'productsIndex.json');
  if (fs.existsSync(prodPath)) idx.productsLines = fs.readFileSync(prodPath, 'utf8').split('\n');
  return idx;
}

// Map { corpus id -> raw "# source:" value } from faq.yaml text. The comment
// sits above its `- id:` line; blank and other comment lines may intervene.
function extractFaqSources(faqText) {
  const out = new Map();
  let pending = null;
  for (const line of String(faqText).split(/\r?\n/)) {
    const c = line.match(/^#\s*source:\s*(.+?)\s*$/);
    if (c) { pending = c[1]; continue; }
    const id = line.match(/^-\s+id:\s*["']?([^"'\s]+)["']?\s*$/);
    if (id) { if (pending) out.set(id[1], pending); pending = null; }
  }
  return out;
}

// Public reply sources: human title plus, ONLY when the chunk carries a
// source_url that is in the widget's allowed site-link set, a `url`. The same
// set the link gate uses, so a citation can never point where the gate would
// refuse. Operator-side persisted sources are built elsewhere and keep ids.
function buildPublicSources(chunks, { siteLinks, titleFn, limit = 3 } = {}) {
  // Same trust model as the link gate: a URL that is part of the operator's
  // own knowledge may be cited. A source_url is operator-supplied at ingest
  // (visitors never set it), https only, and must sit on a curated site-link
  // origin when site links exist, so a citation can never point at a host the
  // operator did not curate.
  const allowed = buildAllowedUrls({ siteLinks });
  const origins = new Set((Array.isArray(siteLinks) ? siteLinks : []).map((l) => { try { return new URL(l.url).origin; } catch { return null; } }).filter(Boolean));
  return (Array.isArray(chunks) ? chunks : []).slice(0, limit).map((c) => {
    const out = { title: titleFn(c), score: Math.round((c.score || 0) * 100) / 100, pinned: c.pinned || false };
    const raw = typeof c.source_url === 'string' ? c.source_url.trim() : '';
    let u = null;
    try { u = raw ? new URL(raw) : null; } catch { u = null; }
    if (u && u.protocol === 'https:') {
      const n = normaliseUrl(raw);
      if ((n && allowed.has(n)) || origins.size === 0 || origins.has(u.origin)) out.url = raw;
    }
    return out;
  });
}

/**
 * Chunks that actually support the reply: keep a chunk only when its text
 * shares at least two content words (or a number) with the answer, then
 * collapse duplicates by source. The claim verifier does not record which
 * knowledge items supported a reply, so lexical overlap is the evidence.
 * Order (retrieval rank) is preserved; an answer with no support cites nothing.
 */
// Words too generic to show a chunk supports an answer on their own.
const GENERIC_CITE_WORDS = new Set(['service', 'servic', 'customer', 'support', 'inform', 'information', 'contact', 'team', 'offer', 'price', 'cost', 'call', 'help', 'hour', 'open', 'year', 'month', 'week', 'day', 'time', 'includ', 'include', 'available', 'avail', 'pleas', 'please', 'visit', 'work', 'provid', 'provide', 'quot', 'detail', 'question', 'enquiri', 'enquiry', 'compani', 'company', 'busi', 'business', 'need', 'make', 'also', 'anyth', 'check', 'confirm', 'appoint', 'book']);
const SUPERSEDED_NAME_RE = /(?:^|[^a-z])(old|archive|archived|replaced|superseded|deprecated|outdated|legacy)(?:[^a-z]|$)/i;
const CITE_MIN_SCORE = 0.35;

function isSupersededSuggested(c) {
  return Boolean(c && (c.superseded === true || SUPERSEDED_NAME_RE.test(`${c.source || ''} ${c.title || ''} ${c.section || ''}`)));
}

/**
 * Chunks that actually support the reply: keep a chunk only when it scores at
 * least 0.35, shares at least two content words (or a figure) with the answer
 * and at least one of those is DISTINCTIVE (not a generic word) or a figure,
 * then collapse duplicates by source. A superseded-suggested source (OLD,
 * archive, replaced, superseded in its name, or flagged) is dropped whenever a
 * current source also supports the answer. The claim verifier does not record
 * which knowledge items supported a reply, so lexical overlap is the evidence.
 * Order (retrieval rank) is preserved; an answer with no support cites nothing.
 */
function selectCitedChunks(chunks, answer, { limit = 3 } = {}) {
  const { tokenize } = require('./quoxchatLexical');
  const ans = new Set(tokenize(answer));
  if (ans.size === 0) return [];
  const seen = new Set();
  const out = [];
  for (const c of Array.isArray(chunks) ? chunks : []) {
    if (typeof (c && c.score) === 'number' && c.score < CITE_MIN_SCORE) continue;
    const toks = new Set(tokenize(`${c && c.text ? c.text : ''} ${c && c.answer ? c.answer : ''}`));
    let shared = 0;
    let numeric = false;
    let distinctive = false;
    for (const t of toks) {
      if (!ans.has(t)) continue;
      shared++;
      if (/\d/.test(t)) { numeric = true; distinctive = true; } else if (!GENERIC_CITE_WORDS.has(t)) distinctive = true;
    }
    if ((shared < 2 && !numeric) || !distinctive) continue;
    // Q&A pairs share one source label but are distinct facts: key them by question.
    const q = /^Q:\s*([^\n]+)/.exec(c && c.text ? c.text : '');
    const key = (q ? `q:${q[1]}` : String((c && (c.source || c.source_url)) || (c && c.text) || '')).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  const current = out.filter((c) => !isSupersededSuggested(c));
  return (current.length > 0 ? current : out).slice(0, limit);
}

module.exports = { selectCitedChunks, buildPublicSources, SITE_ORIGIN, parseImports, buildRouteIndex, resolveSourceUrl, firstWebsiteSourceFile, loadRouteIndex, extractFaqSources, isPublicRoute };
