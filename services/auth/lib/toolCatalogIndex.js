/**
 * toolCatalogIndex.js — In-memory inverted index over the Quox tool catalog.
 *
 * Loads src/config/tool-library-index.json at boot, tokenises each entry's
 * name + description + category + subcategory fields, and builds:
 *   - Map<token, Set<tool_id>>  — inverted index
 *   - Map<tool_id, ToolEntry>   — lookup table
 *
 * Search scoring:
 *   - token_overlap_count  (how many query tokens appear in the entry)
 *   - idf_weighted_sum     (rarer tokens count more)
 *   - exact_name_bonus     (+20 when query === entry.name, case-insensitive)
 *   - subcategory_bonus    (+10 when subcategory token appears in query)
 *
 * Filters (applied after ranking): subcategory, executor_type, source_list.
 * Dev: rebuilds when file mtime changes (~5s poll). Prod: builds once at boot.
 */

import { readFileSync, watchFile, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const CATALOG_PATH = join(__dirname, '../../../src/config/tool-library-index.json');

// ── Stop words ────────────────────────────────────────────────────────────────
// Copied from scripts/rebuild-tool-library.mjs (line ~210).
// These are too generic to be meaningful match signals.
const STOP_WORDS = new Set([
  'tool', 'tools', 'agent', 'agents', 'ai', 'ml', 'api', 'server', 'service',
  'mcp', 'llm', 'gpt', 'via', 'with', 'and', 'for', 'the', 'an', 'or',
  'of', 'in', 'on', 'to', 'from', 'by', 'at', 'as', 'is', 'it', 'be',
  'using', 'based', 'powered', 'integration', 'management',
  'data', 'code', 'language', 'model', 'system', 'platform', 'framework',
  'open', 'source', 'free', 'app', 'cloud', 'multi', 'auto', 'smart',
  'advanced', 'simple', 'fast', 'new', 'best', 'top', 'pro',
  'console', 'hub', 'studio', 'lab', 'kit', 'suite', 'engine',
  'assistant', 'chat', 'bot', 'copilot', 'helper', 'manager',
]);

// ── Tokeniser ─────────────────────────────────────────────────────────────────
function tokenise(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

// ── Index state ───────────────────────────────────────────────────────────────
let _invertedIndex = new Map();  // token → Set<tool_id>
let _lookup        = new Map();  // tool_id → entry
let _df            = new Map();  // token → document frequency count
let _docCount      = 0;
let _lastMtime     = 0;
let _ready         = false;

// ── Build index from catalog ──────────────────────────────────────────────────
function buildIndex(entries) {
  const invertedIndex = new Map();
  const lookup        = new Map();
  const df            = new Map();

  for (const entry of entries) {
    const id   = entry.id;
    lookup.set(id, entry);

    const text = [
      entry.name        || '',
      entry.description || '',
      entry.category    || '',
      entry.subcategory || '',
    ].join(' ');

    const tokens = new Set(tokenise(text));

    for (const token of tokens) {
      if (!invertedIndex.has(token)) invertedIndex.set(token, new Set());
      invertedIndex.get(token).add(id);

      df.set(token, (df.get(token) || 0) + 1);
    }
  }

  _invertedIndex = invertedIndex;
  _lookup        = lookup;
  _df            = df;
  _docCount      = entries.length;
  _ready         = true;
}

// ── Load + (re)build ──────────────────────────────────────────────────────────
function loadCatalog() {
  try {
    const stat  = statSync(CATALOG_PATH);
    const mtime = stat.mtimeMs;
    if (mtime === _lastMtime && _ready) return;  // Nothing changed
    _lastMtime = mtime;

    const raw     = readFileSync(CATALOG_PATH, 'utf8');
    const catalog = JSON.parse(raw);
    const entries = Array.isArray(catalog.tools) ? catalog.tools : [];
    buildIndex(entries);
    console.log(`[toolCatalogIndex] Built index: ${entries.length} entries`);
  } catch (err) {
    console.error('[toolCatalogIndex] Failed to load catalog:', err.message);
  }
}

// Boot-time load
loadCatalog();

// Dev: watch for file changes (5s poll).
// Prod: skip watcher (one-time build is enough).
if (process.env.NODE_ENV !== 'production') {
  watchFile(CATALOG_PATH, { interval: 5000 }, () => {
    _lastMtime = 0;  // Force rebuild
    loadCatalog();
  });
}

// ── Executor-type derivation (mirrors src/lib/catalogExecutorTypes.js) ────────
// Kept server-side so auth routes don't import frontend modules.
// When a new executor type ships, update BOTH files.
/**
 * @param {object} entry
 * @returns {string|null}
 */
function deriveExecutorType(entry) {
  if (!entry) return null;
  // Hand-curated entries with explicit executor_type already set
  if (entry.executor_type) return entry.executor_type;
  const ref = entry.reference;
  const sub = entry.subcategory;
  // MCP servers — three detection paths (kept in sync with src/lib/catalogExecutorTypes.js):
  //   1. densified subcategory='mcp-server'
  //   2. hand-curated subcategory='mcp'
  //   3. hand-curated with function-domain subcategory but reference URL contains
  //      'mcp' (e.g. slack-mcp-server, github-mcp-server)
  const isGithubRef = ref?.includes('github.com/');
  const refLooksLikeMcpRepo = isGithubRef && /\/[^/]*mcp[^/]*$|\/[^/]*mcp[^/]*\//i.test(ref);
  if (isGithubRef && (sub === 'mcp-server' || sub === 'mcp' || refLooksLikeMcpRepo)) {
    return 'mcp_hosted';
  }
  // Public APIs → http_api
  if (sub === 'public-api') {
    return 'http_api';
  }
  return null;
}

// ── IDF helper ────────────────────────────────────────────────────────────────
function idf(token) {
  const freq = _df.get(token) || 0;
  if (freq === 0 || _docCount === 0) return 0;
  return Math.log((_docCount + 1) / (freq + 1)) + 1;
}

// ── Search ────────────────────────────────────────────────────────────────────
/**
 * Search the catalog.
 *
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.limit=20]  Max results (capped at 50)
 * @param {object} [opts.filters]
 * @param {string} [opts.filters.subcategory]
 * @param {string} [opts.filters.executor_type]   (graceful no-op; field not in v1 catalog)
 * @param {string} [opts.filters.source_list]
 * @returns {{ matches: Array, total_in_catalog: number }}
 */
export function searchCatalog(query, { limit = 20, filters = {} } = {}) {
  if (!_ready) loadCatalog();

  const cap = Math.min(Math.max(1, limit), 50);
  const queryTokens = tokenise(query);
  const queryLower  = (query || '').toLowerCase().trim();

  if (queryTokens.length === 0) {
    return { matches: [], total_in_catalog: _docCount };
  }

  // Collect candidate tool_ids — union of all token hits
  const candidateIds = new Set();
  for (const token of queryTokens) {
    const hits = _invertedIndex.get(token);
    if (hits) {
      for (const id of hits) candidateIds.add(id);
    }
  }

  // Score each candidate
  const scored = [];
  for (const id of candidateIds) {
    const entry = _lookup.get(id);
    if (!entry) continue;

    let score = 0;

    // Token overlap + IDF weighting
    for (const token of queryTokens) {
      const hits = _invertedIndex.get(token);
      if (hits && hits.has(id)) {
        score += 1;           // overlap count
        score += idf(token);  // idf weight
      }
    }

    // Exact name match bonus
    if (queryLower === (entry.name || '').toLowerCase().trim()) {
      score += 20;
    }

    // Subcategory match bonus — if any subcategory token appears in query tokens
    if (entry.subcategory) {
      const subcatTokens = tokenise(entry.subcategory);
      for (const st of subcatTokens) {
        if (queryTokens.includes(st)) {
          score += 10;
          break;
        }
      }
    }

    scored.push({ entry, score });
  }

  // Sort descending by score
  scored.sort((a, b) => b.score - a.score);

  // Apply filters
  let filtered = scored;
  if (filters.subcategory) {
    const fc = filters.subcategory.toLowerCase();
    filtered = filtered.filter(({ entry }) =>
      (entry.subcategory || '').toLowerCase() === fc
    );
  }
  if (filters.source_list) {
    const fs = filters.source_list.toLowerCase();
    filtered = filtered.filter(({ entry }) =>
      (entry.source_list || '').toLowerCase().includes(fs)
    );
  }
  if (filters.executor_type) {
    const fe = filters.executor_type.toLowerCase();
    filtered = filtered.filter(({ entry }) =>
      (entry.executor_type || '').toLowerCase() === fe
    );
  }

  const matches = filtered.slice(0, cap).map(({ entry, score }) => ({
    id:              entry.id,
    name:            entry.name,
    description:     entry.description,
    subcategory:     entry.subcategory,
    parent_category: entry.parent_category || null,
    category:        entry.category,
    reference:       entry.reference || null,
    source_list:     entry.source_list || null,
    executor_type:   deriveExecutorType(entry),
    score:           Math.round(score * 100) / 100,
  }));

  return { matches, total_in_catalog: _docCount };
}

/**
 * Force a rebuild (useful for tests or manual refresh).
 */
export function rebuildIndex(entries) {
  buildIndex(entries);
}

export { tokenise, STOP_WORDS };
