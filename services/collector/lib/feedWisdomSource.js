/**
 * feedWisdomSource.js, The Feed's "Execution Wisdom" ingester
 * (docs/STREAM_QUOXBRAIN2_SOURCE_UNIVERSE.md, `tasks_execution_wisdom`).
 *
 * The tasks service's own execution_wisdom table (generalised operational
 * lessons: pattern, lesson, confidence, occurrence count) lives in the
 * tasks service's OWN SQLite db, in the `tasks` container: this collector
 * never touches that db directly. feedDbSource.js's db-adapter framework is
 * explicitly scoped to collector-local db files only (see that module's own
 * header, "a store owned by a DIFFERENT service is OUT of scope here; those
 * need an API-mode adapter"), so this is an API-mode ingester, mirroring
 * feedMemorySource.js's shape against the memory service: bounded HTTP read,
 * X-Service-Key + X-Org-Id authenticated, client-side watermark filter,
 * one doc per row, push via brainFeedClient, advance the watermark only
 * after a successful push.
 *
 * ORDERING CAVEAT (read before touching the fetch path): GET /api/wisdom
 * with no `q` calls listWisdom(orgId, { limit }), which orders by
 * `confidence DESC, occurrence_count DESC`, not by updated_at. A single
 * bounded page can therefore miss a newly-updated row that ranks below the
 * page cutoff once the table has more rows than the fetch limit. Accepted
 * for now: execution_wisdom is a curated, low-noise table (the tasks
 * analyser only records generalised patterns, not raw events), so a bounded
 * page comfortably covers it in practice, and the live memory source
 * carries the identical tradeoff already. If the table grows large, the fix
 * is a small ORDER BY updated_at option on the tasks route, out of scope
 * here.
 *
 * GLOBAL SEED ROWS: listWisdom's own WHERE clause is
 * `(org_id = ? OR org_id IS NULL) AND active = 1`, so rows with org_id NULL
 * are seed patterns intentionally shared to every org by the tasks service
 * itself. This ingester does not add any extra scoping on top of that; it
 * is the tasks API's own sharing semantics, not a leak introduced here.
 *
 * LOOP-SAFETY: no filter is needed. Nothing writes execution_wisdom from
 * brain-derived content: the only writers are the tasks analyser's own
 * recordWisdom() calls and the service-key-authenticated POST /api/wisdom
 * route (used by other internal services such as screencap), neither of
 * which reads back from Qortex.
 */

'use strict';

const feedWatermark = require('./feedWatermark.js');
const brainFeedClient = require('./brainFeedClient.js');

const SOURCE_TYPE = 'tasks_execution_wisdom';
const VAULT_NAME = 'Execution Wisdom';

// Same TASKS_HOST/TASKS_PORT convention as actionToolHandlers.js's own
// tasks-service URL construction.
const DEFAULT_TASKS_URL = `http://${process.env.TASKS_HOST || 'tasks'}:${process.env.TASKS_PORT || '3104'}`;
const DEFAULT_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || '';

const WISDOM_FETCH_LIMIT = 5000;
const DEFAULT_MAX_ITEMS = 50;

/**
 * tags is stored as a JSON array TEXT column on the wire, never a parsed
 * array. Malformed/legacy values degrade to an empty array rather than
 * throwing (this is a rendering concern only, never fatal to the row).
 */
function safeParseTags(tags) {
  if (Array.isArray(tags)) return tags;
  if (typeof tags !== 'string' || !tags) return [];
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Renders one execution_wisdom row into a push-ingest document. Throws if
 * `id` is missing (relPath is not derivable); the caller skips this one
 * row via a per-row try/catch rather than failing the whole batch.
 */
function renderWisdomDoc(row) {
  if (!row || !row.id) throw new Error('wisdom row missing id');

  const title = row.pattern_name || SOURCE_TYPE;
  const tags = safeParseTags(row.tags);

  const frontmatter = [
    `category: ${row.category || 'execution'}`,
    `severity: ${row.severity || 'unknown'}`,
    `confidence: ${row.confidence != null ? row.confidence : 'unknown'}`,
    `occurrence_count: ${row.occurrence_count != null ? row.occurrence_count : 'unknown'}`,
    `first_seen_at: ${row.first_seen_at || 'unknown'}`,
    `last_seen_at: ${row.last_seen_at || 'unknown'}`,
  ].join('\n');

  const bodyParts = [`# ${title}`, '', String(row.lesson || '')];
  if (row.decomposition_directive) {
    bodyParts.push('', '## Directive', String(row.decomposition_directive));
  }
  if (tags.length > 0) {
    bodyParts.push('', `Tags: ${tags.join(', ')}`);
  }

  const occurredAt = row.updated_at || row.created_at || new Date().toISOString();

  return {
    relPath: `tasks_execution_wisdom/${row.id}.md`,
    content: bodyParts.join('\n'),
    title,
    kind: SOURCE_TYPE,
    sourceType: SOURCE_TYPE,
    occurredAt,
    // ONE-BRAIN A1 (QuoxPlan #493): this doc IS execution_wisdom row `row.id`
    // — stamp the canonical origin at write time so Qortex can dedup at
    // recall instead of relying solely on the boot-time rel_path backfill.
    originStore: 'wisdom',
    originId: row.id,
  };
}

/**
 * Default wisdom-list client: GET /api/wisdom?limit=N (bounded, org-scoped
 * per the tasks API's own listWisdom() filter). Overridable via
 * deps.fetchWisdomFn (tests never touch the network).
 */
async function defaultFetchWisdom(orgId, { limit, tasksUrl, serviceKey, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${tasksUrl}/api/wisdom?limit=${encodeURIComponent(limit)}`, {
    headers: { 'X-Service-Key': serviceKey, 'X-Org-Id': orgId },
  });
  if (!res.ok) throw new Error(`GET /api/wisdom failed HTTP ${res.status}`);
  const body = await res.json().catch(() => null);
  return Array.isArray(body?.wisdom) ? body.wisdom : [];
}

/**
 * Ingests the org's execution_wisdom patterns into the "Execution Wisdom"
 * push vault, incrementally (client-side watermark filter, see module
 * header's ORDERING CAVEAT).
 *
 * @param {string} orgId
 * @param {{config?: {maxItems?: number}, maxItems?: number, dryRun?: boolean}} [opts]
 * @param {{
 *   fetchWisdomFn?: Function,      // (orgId, {limit,tasksUrl,serviceKey,fetchImpl}) => Array<row> (tests)
 *   getWatermarkFn?: Function,     // (orgId) => string|null
 *   setWatermarkFn?: Function,     // (orgId, ts) => void
 *   ensurePushVaultFn?: Function,  // defaults to brainFeedClient.ensurePushVault
 *   pushDocumentsFn?: Function,    // defaults to brainFeedClient.pushDocuments
 *   fetchImpl?: Function,          // forwarded to the brain client + default wisdom client (test injection)
 *   tasksUrl?: string,             // overrides DEFAULT_TASKS_URL (tests)
 *   serviceKey?: string,           // overrides DEFAULT_SERVICE_KEY (tests)
 *   userId?: string,               // forwarded to ensurePushVault/pushDocuments (optional)
 *   dbPath?: string,               // forwarded to feedWatermark (tests)
 * }} [deps]
 * @returns {Promise<{rowsRead: number, docsPushed: number, error: string|null}>}
 */
async function ingestWisdom(orgId, opts = {}, deps = {}) {
  const result = { rowsRead: 0, docsPushed: 0, error: null };

  const {
    fetchWisdomFn = defaultFetchWisdom,
    getWatermarkFn = (org) => feedWatermark.getWatermark(org, SOURCE_TYPE, { dbPath: deps.dbPath }),
    setWatermarkFn = (org, ts) => feedWatermark.setWatermark(org, SOURCE_TYPE, ts, { dbPath: deps.dbPath }),
    ensurePushVaultFn = brainFeedClient.ensurePushVault,
    pushDocumentsFn = brainFeedClient.pushDocuments,
    fetchImpl,
    tasksUrl = DEFAULT_TASKS_URL,
    serviceKey = DEFAULT_SERVICE_KEY,
    userId,
  } = deps;

  const config = opts.config || null;
  const maxItems = config?.maxItems || opts.maxItems || DEFAULT_MAX_ITEMS;
  const dryRun = !!opts.dryRun;

  let storedWatermark = null;
  try {
    storedWatermark = await getWatermarkFn(orgId);
  } catch (err) {
    console.error(`[FeedWisdomSource] org=${orgId}: watermark read failed, treating as no watermark: ${err.message}`);
  }

  const docs = [];
  let newWatermark = storedWatermark || null;

  try {
    // BRAIN2-W5 028: GET /api/wisdom has no offset and ranks by confidence, so
    // a page of maxItems never reaches the tail. Ask for the whole (curated,
    // bounded) table; maxItems still bounds the work done per tick below.
    const rows = (await fetchWisdomFn(orgId, { limit: WISDOM_FETCH_LIMIT, tasksUrl, serviceKey, fetchImpl })) || [];
    // Compound (ts, id) cursor (BRAIN2-V3 A4).
    const allEligible = rows
      .map((row) => ({ row, ts: row?.updated_at || row?.last_seen_at || row?.created_at, id: row?.id }))
      .filter(({ ts, id }) => ts && feedWatermark.isAfterCursor(storedWatermark, ts, id))
      .sort(feedWatermark.compareByTsId);
    const eligible = allEligible.slice(0, maxItems);
    const remaining = allEligible.slice(maxItems).map(({ ts, id }) => ({ ts, id }));
    const processed = [];

    for (const { row, ts, id } of eligible) {
      try {
        docs.push(renderWisdomDoc(row));
        result.rowsRead++;
        if (ts) processed.push({ ts, id });
      } catch (err) {
        console.error(`[FeedWisdomSource] org=${orgId}: skipping malformed row: ${err.message}`);
      }
    }
    newWatermark = feedWatermark.nextCursor(processed, remaining) || newWatermark;
  } catch (err) {
    result.error = `list wisdom failed: ${err.message}`;
    console.error(`[FeedWisdomSource] org=${orgId}: ${result.error}`);
    return result;
  }

  if (docs.length === 0) return result;

  if (dryRun) return result; // tallies rowsRead, pushes/advances nothing

  try {
    const vaultId = await ensurePushVaultFn(orgId, VAULT_NAME, { scope: 'org', userId, fetchImpl });
    if (!vaultId) {
      result.error = 'ensurePushVault returned no vaultId';
      console.error(`[FeedWisdomSource] org=${orgId}: ${result.error}, not advancing watermark`);
      return result;
    }

    const pushResult = await pushDocumentsFn(orgId, vaultId, docs, { userId, fetchImpl });
    if (pushResult?.error) {
      result.error = pushResult.error;
      console.error(`[FeedWisdomSource] org=${orgId}: push failed: ${pushResult.error}, not advancing watermark`);
      return result;
    }

    result.docsPushed = docs.length;

    if (newWatermark && newWatermark !== storedWatermark) {
      try {
        await setWatermarkFn(orgId, newWatermark);
      } catch (err) {
        console.error(`[FeedWisdomSource] org=${orgId}: watermark write failed: ${err.message}`);
      }
    }
  } catch (err) {
    result.error = `push failed: ${err.message}`;
    console.error(`[FeedWisdomSource] org=${orgId}: ${result.error}, not advancing watermark`);
  }

  return result;
}

module.exports = {
  ingestWisdom,
  renderWisdomDoc,
  safeParseTags,
  SOURCE_TYPE,
  VAULT_NAME,
  DEFAULT_MAX_ITEMS,
};
