/**
 * The Feed — cockpit API handlers (Qortex Phase B).
 * (docs/STREAM_QUOXBRAIN2_COCKPIT_DESIGN.md screen 2,
 *  docs/STREAM_QUOXBRAIN2_OVERNIGHT_BUILD.md Phase B)
 *
 * Testable, dependency-injected handler logic behind
 * GET /api/feed/sources, PUT /api/feed/sources/:sourceType and
 * GET /api/feed/status. Route wiring (auth + mount) lives in server.js —
 * mirrors lib/internalEmbedHandler.js's split.
 *
 * Bounded by design: FEED_SOURCE_CATALOG (feedSourceCatalog.js) is a small
 * static list, so every request does at most one feedWatermark.getSource()
 * point-lookup per catalog entry (indexed on the (org_id, source_type)
 * primary key) — never a full-table scan. Never touches feedScheduler.js
 * or the AEE/wedge-fix code.
 *
 * Org isolation: every read/write is scoped to the caller's own org_id,
 * resolved by resolveOrgId() — a JWT caller's req.user.org_id always wins;
 * a trusted service-key caller (req.service === true, set by
 * requireServiceOrUserAuth()) may pass org_id via query/body (same
 * convention as the other `req.service ? req.query.org_id : null` call
 * sites in server.js). No caller can read or write another org's row —
 * there is no path here that accepts an arbitrary org_id from a JWT-bearing
 * request.
 */

'use strict';

const brainFeedClient = require('./brainFeedClient.js');
const feedWatermark = require('./feedWatermark.js');
const { FEED_SOURCE_CATALOG } = require('./feedSourceCatalog.js');
const { ingestAiHistory, VALID_SOURCES } = require('./feedAiHistorySource.js');
const { SOURCE_INGESTERS } = require('./feedScheduler.js');
const { isPathInAllowedRoots } = require('./feedFolderSource.js');
const { isAdminUser } = require('../utils/httpAuth.js');

// Host-path source types and the config keys that name a filesystem path.
// A caller who sets one of these makes the collector read that path, so the
// write is org-admin only and the path must realpath inside the instance
// allowlist (FEED_FOLDER_ALLOWED_ROOTS). Service-key callers are exempt.
const HOST_PATH_CONFIG_KEYS = ['path', 'roots', 'memoryDir', 'vaultPath', 'dir'];
const HOST_PATH_SOURCE_TYPES = new Set(['folder', 'git', 'docs', 'obsidian', 'automemory', 'transcript']);

function collectConfigPaths(config) {
  const out = [];
  if (!config || typeof config !== 'object') return out;
  for (const key of HOST_PATH_CONFIG_KEYS) {
    const v = config[key];
    if (typeof v === 'string' && v) out.push(v);
    else if (Array.isArray(v)) out.push(...v.map((x) => (typeof x === 'string' ? x : '')));
    else if (v !== undefined && v !== null) out.push(''); // non-string path value: reject
  }
  return out;
}

function checkHostPathConfig(req, sourceType, config) {
  if (req.service === true) return null;
  if (!HOST_PATH_SOURCE_TYPES.has(sourceType)) return null;
  const paths = collectConfigPaths(config);
  if (paths.length === 0) return null;
  if (!isAdminUser(req)) return { status: 403, error: 'org admin role required to configure a host path source' };
  for (const p of paths) {
    if (!p || !isPathInAllowedRoots(p, undefined, { orgId: resolveOrgId(req) })) {
      return { status: 403, error: 'path is outside the instance allow-list (FEED_FOLDER_ALLOWED_ROOTS)' };
    }
  }
  return null;
}

const MAX_CONVERSATIONS_PER_REQUEST = 200;
const VALID_SCOPES = ['org', 'user'];

// Authoritative set of source types that actually have a live ingester. This is
// the single source of truth for a source's 'live' vs 'available' status, so the
// catalog's hand-maintained status string can never drift from reality (fleet
// ingests but was tagged 'available'; git/docs were shown connectable
// but have no ingester).
const LIVE_SOURCE_TYPES = new Set(Object.keys(SOURCE_INGESTERS));

/**
 * Resolves the caller's org_id. JWT/MCP-token callers (req.user set by
 * requireServiceOrUserAuth()) always use their own token's org_id — this
 * is the only path for those callers, so a JWT caller can never read or
 * write another org's feed_sources row. A plain INTERNAL_SERVICE_KEY
 * caller (req.service === true, no req.user) has no org of its own, so it
 * must name one explicitly via query/body — same trust boundary as the
 * other `req.service ? req.query.org_id : null` call sites in server.js.
 */
function resolveOrgId(req) {
  if (req.user && req.user.org_id) return req.user.org_id;
  if (req.service) return req.query?.org_id || req.body?.org_id || null;
  return null;
}

function safeParseConfig(config) {
  if (config === null || config === undefined) return null;
  if (typeof config !== 'string') return config;
  try {
    return JSON.parse(config);
  } catch {
    return null;
  }
}

/** Merges one catalog entry with the org's feed_sources row (if any). */
function mergeSourceEntry(catalogEntry, row) {
  return {
    ...catalogEntry,
    // status is authoritative from the real ingester map (LIVE_SOURCE_TYPES),
    // never the catalog's hand-maintained string, so the cockpit and Explore
    // can never disagree about what actually ingests.
    status: LIVE_SOURCE_TYPES.has(catalogEntry.sourceType)
      ? 'live'
      : (catalogEntry.status === 'live' ? 'available' : catalogEntry.status),
    connected: !!row,
    enabled: row ? !!row.enabled : false,
    scope: row ? row.scope : catalogEntry.defaultScope,
    config: row ? safeParseConfig(row.config) : null,
    last_sync: row ? row.last_sync : null,
    last_status: row ? row.last_status : null,
    last_count: row ? (row.last_count || 0) : 0,
  };
}

/**
 * GET /api/feed/sources — the catalog merged with this org's feed_sources
 * rows. Connected/configured sources carry their live state; catalog
 * entries with no row show connected:false.
 */
function createGetSourcesHandler({ getSourceFn = feedWatermark.getSource, catalog = FEED_SOURCE_CATALOG, dbPath } = {}) {
  return function handleGetSources(req, res) {
    const orgId = resolveOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'org_id required' });

    try {
      const sources = catalog.map((entry) => mergeSourceEntry(entry, getSourceFn(orgId, entry.sourceType, { dbPath })));
      return res.json({ sources });
    } catch (err) {
      console.error(`[FeedAPI] org=${orgId}: GET /api/feed/sources failed — ${err.message}`);
      return res.status(500).json({ error: 'failed to load feed sources' });
    }
  };
}

/**
 * PUT /api/feed/sources/:sourceType — body { enabled?, scope?, config? }.
 * Both the enable/disable toggle and the connect-a-source write (Phase C
 * uses the same route to persist a folder/path config). 404s on any
 * sourceType not in the catalog before touching the DB.
 */
function createPutSourceHandler({ getSourceFn = feedWatermark.getSource, upsertSourceFn = feedWatermark.upsertSource, catalog = FEED_SOURCE_CATALOG, dbPath } = {}) {
  return function handlePutSource(req, res) {
    const orgId = resolveOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'org_id required' });

    const { sourceType } = req.params;
    const catalogEntry = catalog.find((entry) => entry.sourceType === sourceType);
    if (!catalogEntry) return res.status(404).json({ error: `unknown source type: ${sourceType}` });

    // BRAIN2-W5 015: enablement, scope and config all steer org-wide ingestion,
    // so every write needs org admin/owner (service-key callers are exempt via
    // isAdminUser). Members keep read access through GET.
    if (!isAdminUser(req)) return res.status(403).json({ error: 'org admin role required to change feed sources' });

    const { enabled, scope, config } = req.body || {};
    if (scope !== undefined && !VALID_SCOPES.includes(scope)) {
      return res.status(400).json({ error: `scope must be one of ${VALID_SCOPES.join(', ')}` });
    }
    const fields = {};
    if (enabled !== undefined) fields.enabled = !!enabled;
    if (scope !== undefined) fields.scope = scope;
    if (config !== undefined) fields.config = config;
    // BRAIN2-W12 B3: a private source belongs to the user who connected it; org scope has no owner.
    if (scope === 'org') fields.owner_user_id = null;
    else if (req.user?.id) {
      let existingRow = null;
      try { existingRow = getSourceFn(orgId, sourceType, { dbPath }); } catch { /* no row */ }
      const effective = scope ?? existingRow?.scope ?? catalogEntry.defaultScope;
      if (effective === 'user' && (scope === 'user' || !existingRow?.owner_user_id)) fields.owner_user_id = req.user.id;
    }

    // V2-8: the email source reads private mail and sends it to the Qortex embedding
    // model, so it can only be ON with explicit consent and user (never org) scope.
    if (sourceType === 'email') {
      let existing = null;
      try { existing = getSourceFn(orgId, sourceType, { dbPath }); } catch { /* no row */ }
      const effEnabled = enabled !== undefined ? !!enabled : !!existing?.enabled;
      if (effEnabled) {
        const effScope = scope ?? existing?.scope ?? catalogEntry.defaultScope;
        const effConfig = safeParseConfig(config !== undefined ? config : existing?.config);
        if (effScope !== 'user') return res.status(400).json({ error: 'email feed must use scope "user": mail is private to the connecting user and is never org-shared' });
        if (!effConfig || effConfig.consent !== true) return res.status(400).json({ error: 'email feed needs config {"consent": true}: email bodies are sent to the Qortex embedding/rerank model configured for this instance' });
      }
    }

    const denied = config !== undefined ? checkHostPathConfig(req, sourceType, safeParseConfig(config)) : null;
    if (denied) return res.status(denied.status).json({ error: denied.error });

    try {
      const ok = upsertSourceFn(orgId, sourceType, fields, { dbPath });
      if (!ok) return res.status(500).json({ error: 'failed to persist source' });
      const row = getSourceFn(orgId, sourceType, { dbPath });
      return res.json({ source: mergeSourceEntry(catalogEntry, row) });
    } catch (err) {
      console.error(`[FeedAPI] org=${orgId} source=${sourceType}: PUT /api/feed/sources failed — ${err.message}`);
      return res.status(500).json({ error: 'failed to persist source' });
    }
  };
}

/**
 * GET /api/feed/status — a cheap header-summary for the cockpit: per-source
 * last_sync/last_status/last_count plus org totals (notes = the brain's real
 * push-vault note count, null when unavailable; lastSyncPushed = sum of the
 * latest batch counts; connected = count of rows present).
 */
function createGetStatusHandler({ getSourceFn = feedWatermark.getSource, catalog = FEED_SOURCE_CATALOG, dbPath, getVaultTotalsFn = brainFeedClient.getPushVaultNoteTotals } = {}) {
  return async function handleGetStatus(req, res) {
    const orgId = resolveOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'org_id required' });

    try {
      let lastSyncPushed = 0;
      let connected = 0;
      const sources = catalog.map((entry) => {
        const row = getSourceFn(orgId, entry.sourceType, { dbPath });
        if (row) {
          connected += 1;
          lastSyncPushed += row.last_count || 0;
        }
        return {
          sourceType: entry.sourceType,
          last_sync: row ? row.last_sync : null,
          last_status: row ? row.last_status : null,
          last_count: row ? (row.last_count || 0) : 0,
        };
      });
      // BRAIN2-V3 A4: `notes` is the brain's real per-vault note count. The old
      // sum of each source's LATEST batch count read 0 after any empty sync.
      // `lastSyncPushed` is that old sum, honestly named. null = unavailable.
      let notes = null;
      try {
        const totals = await getVaultTotalsFn(orgId);
        if (totals && typeof totals.notes === 'number') notes = totals.notes;
      } catch (err) {
        console.error(`[FeedAPI] org=${orgId}: brain note total failed — ${err.message}`);
      }
      return res.json({ sources, totals: { notes, connected, lastSyncPushed } });
    } catch (err) {
      console.error(`[FeedAPI] org=${orgId}: GET /api/feed/status failed — ${err.message}`);
      return res.status(500).json({ error: 'failed to load feed status' });
    }
  };
}

/**
 * POST /api/feed/sources/:sourceType/sync?org_id=... — BRAIN2-FABLE11 "sync now".
 * Service-key callers only (a trusted caller names the org, like the other
 * service routes here). Kicks the scheduler's own ingest for one org+source
 * and returns 202 at once; progress shows in GET /api/feed/status.
 */
function createSyncNowHandler({ syncNowFn } = {}) {
  return async function handleSyncNow(req, res) {
    if (req.service !== true) return res.status(403).json({ error: 'service key required' });
    const orgId = resolveOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'org_id required' });
    try {
      const fn = syncNowFn || require('./feedScheduler.js').syncNow;
      const r = await fn(orgId, req.params.sourceType);
      if (!r.ok) return res.status(r.status || 500).json({ error: r.error, busy: !!r.busy });
      return res.status(202).json({ started: true, orgId, sourceType: req.params.sourceType });
    } catch (err) {
      console.error(`[FeedAPI] org=${orgId}: POST sync failed, ${err.message}`);
      return res.status(500).json({ error: 'failed to start sync' });
    }
  };
}

/**
 * POST /api/feed/ai-history: pushes an already-parsed batch of AI-chat-export
 * conversations (see feedAiHistorySource.js for the expected shape) into the
 * "AI History" push vault via ingestAiHistory(). Batches are capped at
 * MAX_CONVERSATIONS_PER_REQUEST per call; the client is responsible for
 * splitting a larger export into multiple requests. This is a one-shot,
 * user-triggered import, not a watermarked autopilot source.
 */
function createIngestAiHistoryHandler({ ingestFn = ingestAiHistory } = {}) {
  return async function handleIngestAiHistory(req, res) {
    const orgId = resolveOrgId(req);
    if (!orgId) return res.status(400).json({ error: 'org_id required' });

    const { conversations, source, scope } = req.body || {};

    if (!Array.isArray(conversations) || conversations.length === 0) {
      return res.status(400).json({ error: 'conversations must be a non-empty array' });
    }

    if (!VALID_SOURCES.includes(source)) {
      return res.status(400).json({ error: `source must be one of ${VALID_SOURCES.join(', ')}` });
    }

    // BRAIN2-W5 023: personal chat history is private by default; sharing with
    // the org is an explicit choice.
    if (scope !== undefined && !VALID_SCOPES.includes(scope)) {
      return res.status(400).json({ error: `scope must be one of ${VALID_SCOPES.join(', ')}` });
    }
    const vaultScope = scope || 'user';
    if (vaultScope === 'user' && !req.user?.id) {
      return res.status(400).json({ error: 'a signed-in user is required for a private (user scope) import; pass scope "org" to share' });
    }

    if (conversations.length > MAX_CONVERSATIONS_PER_REQUEST) {
      return res.status(413).json({ error: `Batch too large, send at most ${MAX_CONVERSATIONS_PER_REQUEST} conversations per request` });
    }

    try {
      const result = await ingestFn(orgId, {
        conversations,
        source,
        userId: req.user?.id,
        maxItems: MAX_CONVERSATIONS_PER_REQUEST,
        vaultScope,
      }, {});

      if (!result.ok) {
        return res.status(502).json({ error: result.error });
      }

      return res.json({ pushed: result.pushed, skipped: result.skipped, redacted: result.redacted });
    } catch (err) {
      console.error(`[FeedAPI] org=${orgId}: POST /api/feed/ai-history failed, ${err.message}`);
      return res.status(500).json({ error: 'failed to ingest AI history' });
    }
  };
}

module.exports = {
  createSyncNowHandler,
  createGetSourcesHandler,
  createPutSourceHandler,
  createGetStatusHandler,
  createIngestAiHistoryHandler,
  resolveOrgId,
};
