/**
 * feedNotionSource.js — The Feed's Notion OAuth-connected ingester
 * (BRAIN2-OAUTH-NOTION, per-provider design entry "notion").
 *
 * CONNECT, DON'T CONFIGURE — this is an 'oauth' connector
 * (feedSourceCatalog.js's `notion` entry), not a 'host' connector: there is
 * no path to type in. A user connects a Notion workspace through the
 * auth service's OAuth handshake (services/auth/routes/oauth-connect.js),
 * which writes the resulting integration credential into the existing
 * Vault-backed integrations model and then registers this org's
 * feed_sources row with `config.credentialId` pointing at it. This
 * ingester does exactly one thing with that config: hand credentialId to
 * feedOauthTokenClient.getAccessToken() to get a short-lived access token.
 * It never sees a refresh token or an OAuth client secret — those live
 * entirely on the auth-service side of the broker.
 *
 * INERT BY DEFAULT — four independent gates, any one of which alone keeps
 * this source silent and non-throwing:
 *   (a) feedScheduler.js only registers this ingester under
 *       SOURCE_INGESTERS when QUOXFEED_OAUTH_SOURCES_ENABLED === 'true'
 *       (see that module) — unset by default on every deployment, so the
 *       cockpit's derived status (feedApiHandlers.js LIVE_SOURCE_TYPES)
 *       stays 'available', never 'live', until an operator has actually
 *       witnessed a first successful sync.
 *   (b) No feed_sources row, or a row with no `config.credentialId`: this
 *       ingester returns `{skipped: 'not connected'}` immediately, the
 *       feedFolderSource.js "no path" idiom.
 *   (c) feedOauthTokenClient.getAccessToken() returns null (auth service
 *       down, credential revoked/deleted, INTERNAL_SERVICE_KEY unset, or
 *       the Notion OAuth app not configured at all): `result.error` is set
 *       to 'no access token, reconnect required', nothing is pushed, no
 *       watermark advances.
 *   (d) Any Notion API error (401/403 on a revoked grant, network failure,
 *       malformed response) is caught — a single failing page/database
 *       never aborts the whole batch, and a failing search call fails this
 *       tick only, never throws to the scheduler.
 *
 * WATERMARK — keyed per connection, `notion:<sha1(credentialId)-first12>`
 * (feedFolderSource.js's watermarkKeyForPath idiom), NOT the bare source
 * type: reconnecting a different workspace must never inherit a stale
 * cursor from a previous connection. Client-side strictly-after filter on
 * `last_edited_time` against the stored watermark (feedWisdomSource.js's
 * ORDERING CAVEAT applies identically here: a single bounded search page
 * can in principle miss a very large backlog's older-but-newly-edited
 * items past the page cutoff — accepted, same tradeoff as every other
 * ingester in this family).
 *
 * READ API — bounded, two calls per tick shape:
 *   1. POST /v1/search (Notion-Version 2022-06-28), sorted by
 *      last_edited_time descending, page_size capped at maxItems. Covers
 *      both pages and databases from one call.
 *   2. Per eligible page: GET /v1/blocks/{page_id}/children, paginated,
 *      hard-capped at MAX_BLOCKS_PER_PAGE blocks total and MAX_DEPTH
 *      levels of nesting. Per database: GET /v1/databases/{id} for the
 *      schema plus POST /v1/databases/{id}/query bounded to MAX_DB_ROWS.
 *   Per-item try/catch throughout — one bad page/database is skipped, the
 *   rest of the batch still ingests. A MAX_PAGES_PER_TICK cap additionally
 *   bounds the number of content fetches per tick (Notion's rate limit is
 *   ~3 req/s and block-children pagination multiplies calls per page).
 *
 * NOTE MAPPING — one doc per page (`notion/<page_id>.md`, kind
 * 'notion_page') or database (`notion/db_<database_id>.md`, kind
 * 'notion_database'). Blocks render to markdown (paragraphs, headings,
 * lists, to-dos, quotes, code, callouts, toggles); an unrecognised block
 * type degrades to its own rich-text concatenation rather than throwing.
 * child_page blocks render as relative markdown links to the sibling
 * relPath so the quoxbrain vault parser resolves them into note-to-note
 * graph edges the same way it already does for feedObsidianSource.js's
 * wikilinks — link RESOLUTION is the brain server's job, this ingester
 * only has to write resolvable link syntax. Every rendered body passes
 * through feedAiHistorySource.redactSecrets — Notion content is external,
 * user-supplied text under the same threat model as a chat export.
 */

'use strict';

const crypto = require('crypto');
const feedWatermark = require('./feedWatermark.js');
const brainFeedClient = require('./brainFeedClient.js');
const feedBatchSupport = require('./feedBatchSupport.js');
const feedOauthTokenClient = require('./feedOauthTokenClient.js');
const { redactSecrets } = require('./feedAiHistorySource.js');

const SOURCE_TYPE = 'notion';
const VAULT_NAME = 'Notion';
const NOTION_VERSION = '2022-06-28';
const NOTION_API_BASE = 'https://api.notion.com/v1';

const DEFAULT_MAX_ITEMS = 25;
// Notion allows ~3 requests/second; block-children pagination multiplies
// calls per page, so the per-tick content-fetch count is capped
// independently of maxItems (search can return more matches than we're
// willing to fully fetch content for in one 30-minute tick).
const MAX_PAGES_PER_TICK = 25;
const MAX_BLOCKS_PER_PAGE = 200;
const MAX_BLOCK_DEPTH = 2;
const MAX_DOC_BYTES = 150 * 1024;
const MAX_DB_ROWS = 50;
const SEARCH_PAGE_SIZE_CAP = 100; // Notion's own page_size ceiling
// BRAIN2-W5 029: search is paged until exhausted (bounded), so a big workspace
// is fully discovered; maxItems bounds the content fetches per tick instead.
const MAX_SEARCH_PAGES = 50;

/**
 * Derives a short, stable, per-connection watermark key so reconnecting a
 * different Notion workspace under the same feed_sources row never
 * inherits a stale cursor from the previous connection — mirrors
 * feedFolderSource.js's watermarkKeyForPath().
 */
function watermarkKeyForCredential(credentialId) {
  const hash = crypto.createHash('sha1').update(String(credentialId)).digest('hex').slice(0, 12);
  return `${SOURCE_TYPE}:${hash}`;
}

function notionHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

/**
 * Renders a Notion rich_text array to markdown-ish plain text, preserving
 * inline links (`href`) as markdown links. Never throws on a malformed
 * array — degrades to ''.
 */
function renderRichText(richText) {
  if (!Array.isArray(richText)) return '';
  return richText
    .map((t) => {
      const text = t?.plain_text ?? '';
      const href = t?.href;
      return href ? `[${text}](${href})` : text;
    })
    .join('');
}

/**
 * Finds the page's title property (the one property whose type is
 * 'title') and renders it. Returns null (never throws) if none is found —
 * callers fall back to 'Untitled page'.
 */
function extractPageTitle(page) {
  const properties = page?.properties || {};
  for (const key of Object.keys(properties)) {
    const prop = properties[key];
    if (prop?.type === 'title') {
      const rendered = renderRichText(prop.title);
      if (rendered) return rendered;
    }
  }
  return null;
}

function extractDatabaseTitle(database) {
  const rendered = renderRichText(database?.title);
  return rendered || null;
}

/**
 * Renders one Notion block to a markdown-ish line. Unknown block types
 * degrade to the first rich_text-shaped field found on the block's own
 * type-keyed data (never throws, never drops the block silently if it has
 * ANY renderable text).
 */
function renderBlock(block) {
  const type = block?.type;
  const data = (type && block[type]) || {};

  switch (type) {
    case 'paragraph':
      return renderRichText(data.rich_text);
    case 'heading_1':
      return `# ${renderRichText(data.rich_text)}`;
    case 'heading_2':
      return `## ${renderRichText(data.rich_text)}`;
    case 'heading_3':
      return `### ${renderRichText(data.rich_text)}`;
    case 'bulleted_list_item':
      return `- ${renderRichText(data.rich_text)}`;
    case 'numbered_list_item':
      return `1. ${renderRichText(data.rich_text)}`;
    case 'to_do':
      return `- [${data.checked ? 'x' : ' '}] ${renderRichText(data.rich_text)}`;
    case 'quote':
      return `> ${renderRichText(data.rich_text)}`;
    case 'code':
      return '```' + (data.language || '') + '\n' + renderRichText(data.rich_text) + '\n```';
    case 'callout': {
      const emoji = data.icon?.emoji ? `${data.icon.emoji} ` : '';
      return `> ${emoji}${renderRichText(data.rich_text)}`.trim();
    }
    case 'toggle':
      return renderRichText(data.rich_text);
    case 'child_page':
      // Sibling relPath link — the vault parser resolves this into a
      // note-to-note edge the same way it resolves Obsidian wikilinks.
      return `[${data.title || 'Untitled page'}](${block.id}.md)`;
    default: {
      const anyRichText = Object.values(data).find((v) => Array.isArray(v));
      return anyRichText ? renderRichText(anyRichText) : '';
    }
  }
}

/**
 * Fetches one page of a block's children, paginated, bounded by
 * `maxBlocks`. Throws on a non-OK HTTP response (caller wraps this in its
 * own try/catch per page/block, so one failure never aborts the batch).
 */
async function fetchBlockChildren(token, blockId, { fetchImpl = fetch, maxBlocks = MAX_BLOCKS_PER_PAGE } = {}) {
  const results = [];
  let cursor = null;

  do {
    const url = new URL(`${NOTION_API_BASE}/blocks/${encodeURIComponent(blockId)}/children`);
    url.searchParams.set('page_size', String(Math.min(100, maxBlocks)));
    if (cursor) url.searchParams.set('start_cursor', cursor);

    const res = await fetchImpl(url.toString(), { headers: notionHeaders(token) });
    if (!res.ok) throw new Error(`GET /blocks/${blockId}/children failed HTTP ${res.status}`);
    const body = await res.json();

    for (const block of body?.results || []) {
      results.push(block);
      if (results.length >= maxBlocks) return results;
    }
    cursor = body?.has_more ? body?.next_cursor : null;
  } while (cursor && results.length < maxBlocks);

  return results;
}

/**
 * Renders a page's block content to markdown, walking at most
 * MAX_BLOCK_DEPTH levels of nesting and at most `maxBlocks` blocks total
 * across the whole walk. A failure fetching one block's children is
 * recorded inline as an HTML comment rather than aborting the render.
 */
async function renderPageContent(token, pageId, { fetchImpl = fetch, maxBlocks = MAX_BLOCKS_PER_PAGE, maxDepth = MAX_BLOCK_DEPTH } = {}) {
  const lines = [];
  let budgetUsed = 0;
  let truncated = false;

  async function walk(blockId, depth) {
    if (budgetUsed >= maxBlocks) { truncated = true; return; }

    // BRAIN2-W5 042: a failed child read THROWS (the page is then retried and
    // the cursor held) instead of embedding a comment and passing as complete.
    const children = await fetchBlockChildren(token, blockId, { fetchImpl, maxBlocks: maxBlocks - budgetUsed });

    for (const block of children) {
      if (budgetUsed >= maxBlocks) return;
      budgetUsed += 1;

      const rendered = renderBlock(block);
      if (rendered) lines.push(depth > 0 ? `${'  '.repeat(depth)}${rendered}` : rendered);

      if (block?.has_children) {
        if (depth < maxDepth - 1 && budgetUsed < maxBlocks) await walk(block.id, depth + 1);
        else truncated = true; // design limit, retrying cannot help: mark it visibly
      }
    }
  }

  await walk(pageId, 0);
  if (truncated) lines.push('<!-- notion: truncated, content beyond the block/depth limits was not captured -->');
  return lines.join('\n');
}

/**
 * Default POST /v1/search client, paged via start_cursor. The returned array
 * carries `.complete` (false when the page cap cut discovery short) so the
 * caller only reconciles deletions against a full listing.
 */
async function defaultSearchNotion(token, { pageSize = DEFAULT_MAX_ITEMS, fetchImpl = fetch } = {}) {
  const results = [];
  let cursor = null;
  let complete = false;
  for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
    const payload = {
      sort: { timestamp: 'last_edited_time', direction: 'descending' },
      page_size: SEARCH_PAGE_SIZE_CAP,
    };
    if (cursor) payload.start_cursor = cursor;
    const res = await fetchImpl(`${NOTION_API_BASE}/search`, {
      method: 'POST',
      headers: notionHeaders(token),
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`POST /search failed HTTP ${res.status}`);
    const body = await res.json();
    if (Array.isArray(body?.results)) results.push(...body.results);
    cursor = body?.has_more ? body?.next_cursor : null;
    if (!cursor) { complete = true; break; }
  }
  results.complete = complete;
  return results;
}

/** Default GET /v1/databases/{id} client — overridable via deps.fetchDatabaseFn (tests). */
async function defaultFetchDatabase(token, databaseId, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${NOTION_API_BASE}/databases/${encodeURIComponent(databaseId)}`, {
    headers: notionHeaders(token),
  });
  if (!res.ok) throw new Error(`GET /databases/${databaseId} failed HTTP ${res.status}`);
  return res.json();
}

/** Default POST /v1/databases/{id}/query client — overridable via deps.queryDatabaseFn (tests). */
async function defaultQueryDatabase(token, databaseId, { fetchImpl = fetch, pageSize = MAX_DB_ROWS } = {}) {
  const res = await fetchImpl(`${NOTION_API_BASE}/databases/${encodeURIComponent(databaseId)}/query`, {
    method: 'POST',
    headers: notionHeaders(token),
    body: JSON.stringify({ page_size: Math.min(pageSize, MAX_DB_ROWS) }),
  });
  if (!res.ok) throw new Error(`POST /databases/${databaseId}/query failed HTTP ${res.status}`);
  return res.json();
}

function provenanceUrl(item) {
  if (item?.url) return item.url;
  const compact = String(item?.id || '').replace(/-/g, '');
  return compact ? `https://notion.so/${compact}` : null;
}

/** Caps a rendered doc body at MAX_DOC_BYTES — truncated, never dropped, never thrown. */
function capContent(content, maxBytes = MAX_DOC_BYTES) {
  const str = String(content == null ? '' : content);
  if (Buffer.byteLength(str, 'utf8') <= maxBytes) return str;
  return `${str.slice(0, maxBytes)}\n\n<!-- truncated: exceeds ${maxBytes} byte cap -->`;
}

/**
 * Renders one Notion 'page' search-result object into a push-ingest
 * document. `contentMarkdown` is the already-rendered block content (see
 * renderPageContent()).
 */
function renderPageDoc(page, contentMarkdown, workspaceName) {
  const title = extractPageTitle(page) || 'Untitled page';
  const link = provenanceUrl(page);
  const provenance = link ? `[View in Notion](${link})` : '';
  const body = [`# ${title}`, '', provenance, '', contentMarkdown].filter((l) => l !== '').join('\n');

  return {
    relPath: `notion/${page.id}.md`,
    content: capContent(redactSecrets(body)),
    title,
    kind: 'notion_page',
    sourceType: SOURCE_TYPE,
    occurredAt: page.last_edited_time,
    tags: ['notion', workspaceName].filter(Boolean),
  };
}

/**
 * Renders one Notion 'database' search-result object (plus its schema and
 * a bounded row list) into a push-ingest document.
 */
function renderDatabaseDoc(database, rows, workspaceName) {
  const title = extractDatabaseTitle(database) || 'Untitled database';
  const link = provenanceUrl(database);
  const provenance = link ? `[View in Notion](${link})` : '';

  const schemaLines = Object.entries(database?.properties || {}).map(([name, prop]) => `- ${name} (${prop?.type || 'unknown'})`);
  const rowLines = (rows || []).slice(0, MAX_DB_ROWS).map((row) => `- ${extractPageTitle(row) || row.id}`);

  const body = [
    `# ${title}`,
    '',
    provenance,
    '',
    '## Schema',
    schemaLines.join('\n') || '(no properties)',
    '',
    '## Rows',
    rowLines.join('\n') || '(no rows)',
  ]
    .filter((l) => l !== '')
    .join('\n');

  return {
    relPath: `notion/db_${database.id}.md`,
    content: capContent(redactSecrets(body)),
    title,
    kind: 'notion_database',
    sourceType: SOURCE_TYPE,
    occurredAt: database.last_edited_time,
    tags: ['notion', workspaceName].filter(Boolean),
  };
}

/**
 * Ingests an org's connected Notion workspace (pages + databases) into the
 * "Notion" push vault. See module header for the full gating contract —
 * this function NEVER throws.
 *
 * @param {string} orgId
 * @param {{maxItems?: number, config?: {credentialId: string, workspaceName?: string}, dryRun?: boolean}} [opts]
 * @param {{
 *   getAccessTokenFn?: Function,   // (orgId, credentialId, {fetchImpl}) => Promise<string|null>
 *   fetchSearchFn?: Function,      // (token, {pageSize, fetchImpl}) => Promise<Array>
 *   fetchPageContentFn?: Function, // (token, pageId, {fetchImpl, maxBlocks, maxDepth}) => Promise<string>
 *   fetchDatabaseFn?: Function,    // (token, databaseId, {fetchImpl}) => Promise<object>
 *   queryDatabaseFn?: Function,    // (token, databaseId, {fetchImpl, pageSize}) => Promise<{results: Array}>
 *   getWatermarkFn?: Function,     // (orgId) => string|null
 *   setWatermarkFn?: Function,     // (orgId, ts) => void
 *   ensurePushVaultFn?: Function,  // defaults to brainFeedClient.ensurePushVault
 *   pushDocumentsFn?: Function,    // defaults to brainFeedClient.pushDocuments
 *   fetchImpl?: Function,          // forwarded everywhere (test injection)
 *   userId?: string,
 *   dbPath?: string,               // forwarded to feedWatermark (tests)
 * }} [deps]
 * @returns {Promise<{rowsRead: number, docsPushed: number, skipped: string|null, error: string|null}>}
 */
async function ingestNotion(orgId, opts = {}, deps = {}) {
  const result = { rowsRead: 0, docsPushed: 0, skipped: null, error: null };

  const config = opts.config || null;
  const credentialId = config?.credentialId;
  if (!credentialId) {
    result.skipped = 'not connected';
    return result;
  }

  const {
    getAccessTokenFn = (org, credId, { fetchImpl } = {}) => feedOauthTokenClient.getAccessToken(org, SOURCE_TYPE, credId, { fetchImpl }),
    fetchSearchFn = defaultSearchNotion,
    fetchPageContentFn = renderPageContent,
    fetchDatabaseFn = defaultFetchDatabase,
    queryDatabaseFn = defaultQueryDatabase,
    getWatermarkFn,
    setWatermarkFn,
    ensurePushVaultFn = brainFeedClient.ensurePushVault,
    pushDocumentsFn = brainFeedClient.pushDocuments,
    fetchImpl,
    userId,
    dbPath,
  } = deps;

  const watermarkKey = watermarkKeyForCredential(credentialId);
  const getWM = getWatermarkFn || ((org) => feedWatermark.getWatermark(org, watermarkKey, { dbPath }));
  const setWM = setWatermarkFn || ((org, ts) => feedWatermark.setWatermark(org, watermarkKey, ts, { dbPath }));

  const maxItems = opts.maxItems || DEFAULT_MAX_ITEMS;
  const dryRun = !!opts.dryRun;
  const workspaceName = config?.workspaceName || null;

  let token = null;
  try {
    token = await getAccessTokenFn(orgId, credentialId, { fetchImpl });
  } catch (err) {
    result.error = `token broker failed: ${err.message}`;
    console.error(`[FeedNotionSource] org=${orgId}: ${result.error}`);
    return result;
  }
  if (!token) {
    result.error = 'no access token, reconnect required';
    console.error(`[FeedNotionSource] org=${orgId}: ${result.error}`);
    return result;
  }

  let storedWatermark = null;
  try {
    storedWatermark = await getWM(orgId);
  } catch (err) {
    console.error(`[FeedNotionSource] org=${orgId}: watermark read failed, treating as no watermark — ${err.message}`);
  }

  let searchResults = [];
  try {
    searchResults = (await fetchSearchFn(token, { pageSize: Math.min(maxItems, SEARCH_PAGE_SIZE_CAP), fetchImpl })) || [];
  } catch (err) {
    result.error = `search failed: ${err.message}`;
    console.error(`[FeedNotionSource] org=${orgId}: ${result.error}`);
    return result;
  }

  const searchComplete = searchResults.complete !== false;
  const stateStore = feedBatchSupport.resolveStateStore(deps, !!getWatermarkFn);
  const guard = await feedBatchSupport.createFailureGuard(stateStore, orgId, watermarkKey);

  // Compound (last_edited_time, id) cursor (BRAIN2-V3 A4).
  const allEligible = searchResults
    .map((item) => ({ item, ts: item?.last_edited_time, id: item?.id }))
    .filter(({ ts, id }) => ts && feedWatermark.isAfterCursor(storedWatermark, ts, id))
    .sort(feedWatermark.compareByTsId);
  const eligible = allEligible.slice(0, maxItems);
  const processed = [];

  const docs = [];
  let newWatermark = storedWatermark || null;
  let pagesProcessed = 0;
  let held = false; // set at the first failed item: later items still push, the cursor does not move past it

  for (const { item, ts, id } of eligible) {
    if (pagesProcessed >= MAX_PAGES_PER_TICK) break;

    try {
      let doc = null;
      if (item.object === 'page') {
        const contentMarkdown = await fetchPageContentFn(token, item.id, { fetchImpl, maxBlocks: MAX_BLOCKS_PER_PAGE, maxDepth: MAX_BLOCK_DEPTH });
        doc = renderPageDoc(item, contentMarkdown, workspaceName);
      } else if (item.object === 'database') {
        const database = await fetchDatabaseFn(token, item.id, { fetchImpl });
        const queried = await queryDatabaseFn(token, item.id, { fetchImpl, pageSize: MAX_DB_ROWS });
        doc = renderDatabaseDoc(database, queried?.results || [], workspaceName);
      } else {
        continue; // unrecognised search-result object type — skip, never throw
      }

      docs.push(doc);
      result.rowsRead += 1;
      pagesProcessed += 1;
      guard.clear(id);
      if (ts && !held) processed.push({ ts, id });
    } catch (err) {
      // BRAIN2-W5 026/042: hold the cursor at the first failed item so it is
      // retried; only after repeated failures is it passed over (loudly).
      const n = guard.record(id);
      console.error(`[FeedNotionSource] org=${orgId}: ${item.object || 'item'} ${item.id} failed (${n}/${feedBatchSupport.MAX_ITEM_ATTEMPTS}) — ${err.message}`);
      if (guard.shouldSkip(id)) { if (ts && !held) processed.push({ ts, id }); continue; }
      held = true;
      result.error = result.error || `read ${item.object || 'item'} ${item.id} failed — ${err.message}`;
      continue;
    }
  }
  await guard.flush();

  // Everything eligible but not processed (cap, per-tick page limit, skipped type, failure) is owed.
  const doneIds = new Set(processed.map((p) => p.id));
  const remaining = allEligible.filter((e) => !doneIds.has(e.id)).map(({ ts, id }) => ({ ts, id }));
  newWatermark = feedWatermark.nextCursor(processed, remaining) || newWatermark;

  if (dryRun) return result; // tallies rowsRead, pushes/advances nothing

  const ensureVault = async () => ensurePushVaultFn(orgId, VAULT_NAME, { scope: 'org', userId, fetchImpl });

  try {
    if (docs.length > 0) {
      const vaultId = await ensureVault();
      if (!vaultId) {
        result.error = 'ensurePushVault returned no vaultId';
        console.error(`[FeedNotionSource] org=${orgId}: ${result.error} — not advancing watermark`);
        return result;
      }

      const pushResult = await pushDocumentsFn(orgId, vaultId, docs, { userId, fetchImpl });
      if (pushResult?.error) {
        result.error = pushResult.error;
        console.error(`[FeedNotionSource] org=${orgId}: push failed — ${pushResult.error} — not advancing watermark`);
        return result;
      }

      result.docsPushed = docs.length;

      if (newWatermark && newWatermark !== storedWatermark) {
        try {
          await setWM(orgId, newWatermark);
        } catch (err) {
          console.error(`[FeedNotionSource] org=${orgId}: watermark write failed — ${err.message}`);
        }
      }
    }

    // BRAIN2-W5 024: a complete search is a full snapshot, so pages/databases
    // that vanished (deleted, archived, access revoked) get tombstones.
    if (searchComplete && stateStore) {
      const seen = searchResults
        .filter((i) => i?.id && (i.object === 'page' || i.object === 'database'))
        .map((i) => (i.object === 'database' ? `notion/db_${i.id}.md` : `notion/${i.id}.md`));
      const r = await feedBatchSupport.reconcileDeletions({
        store: stateStore, orgId, key: watermarkKey, seen, complete: true, ensureVault,
        pushDeletionsFn: deps.pushDeletionsFn || brainFeedClient.pushDeletions, pushOpts: { userId, fetchImpl },
      });
      if (r.deleted > 0) result.deleted = r.deleted;
      if (r.error) { result.error = r.error; console.error(`[FeedNotionSource] org=${orgId}: ${r.error}`); }
    }
  } catch (err) {
    result.error = `push failed — ${err.message}`;
    console.error(`[FeedNotionSource] org=${orgId}: ${result.error} — not advancing watermark`);
  }

  return result;
}

module.exports = {
  ingestNotion,
  renderRichText,
  extractPageTitle,
  extractDatabaseTitle,
  renderBlock,
  renderPageContent,
  renderPageDoc,
  renderDatabaseDoc,
  fetchBlockChildren,
  watermarkKeyForCredential,
  capContent,
  SOURCE_TYPE,
  VAULT_NAME,
  DEFAULT_MAX_ITEMS,
  MAX_PAGES_PER_TICK,
  MAX_BLOCKS_PER_PAGE,
  MAX_BLOCK_DEPTH,
  MAX_DOC_BYTES,
  MAX_DB_ROWS,
};
