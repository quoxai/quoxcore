// QM-LTM Phase 1, conversation history semantic recall (dark-shipped).
//
// Entirely inert unless QM_LTM_ENABLED === 'true'. When on, captureConversation()
// summarises a completed Messages-API conversation (extractive, no extra LLM
// call) and upserts one vector per conversation into a new 'conversation-history'
// Qdrant collection, org_id + user_id scoped. recallConversations() queries that
// collection scoped by org/user so agents can surface past conversations via the
// memory_search tool chain.
//
// Bounded by design: one vector per conversation (deterministic point id,
// idempotent overwrite), a per-conversation throttle (no re-summarise inside
// QM_LTM_MIN_INTERVAL_MS), and a hard cap on the summary text. No full-history
// scans.

const crypto = require('crypto');

const QM_LTM_COLLECTION = 'conversation-history';
const QDRANT_VECTOR_SIZE = 768; // gemini-embedding-001, matches quoxchat.js convention
const QM_LTM_MIN_INTERVAL_MS = parseInt(process.env.QM_LTM_MIN_INTERVAL_MS || '', 10) || 120000;
const THROTTLE_MAP_MAX = 500;

// Per-process throttle: conversationId -> last capture timestamp (ms).
// Capped + FIFO-evicted so a long-running collector never grows this unbounded.
const _lastCaptureAt = new Map();

// Per-process "collection ensured" flag, mirroring the ensureQdrantCollection
// pattern in routes/quoxchat.js, avoids a PUT on every single capture.
let _collectionEnsured = false;

let _testOverrides = null;

// Production wiring set once at server boot via configure() (mirrors
// quoxchatRoutes.init() in server.js). getProviderKeys here MUST be the
// same org-scoped resolver the rest of the chat stack uses (server.js's
// getProviderKeys, itself a delegate to lib/providerKeys.js) — this module
// never resolves its own credentials, so there is exactly one
// vault-plus-legacy implementation in the process. Until configure() runs
// (e.g. in isolated unit tests), getProviderKeys degrades to a safe no-op
// that resolves {} — never throws, matches the module's non-fatal contract.
let _productionDeps = null;

function configure(deps) {
  _productionDeps = deps || null;
}

// Phase 25: QM_LTM_ENABLED reads through the org-scoped settings resolver.
// configure({ voltDb }) wires the same platform settings store the rest of
// the collector uses; until that runs (isolated unit tests, or a stray
// early call before boot finishes), getEffectiveFlag degrades to env-only,
// same behaviour as before this flag was settable.
const platformSettingsStore = require('./platformSettingsStore.js');
function isLtmEnabled(orgId = null) {
  const db = _productionDeps?.voltDb || null;
  return platformSettingsStore.getEffectiveFlag(db, orgId, 'QM_LTM_ENABLED').on;
}

// QCL-SECURITY P2-1: duplicated from routes/quoxchat.js resolveQdrantKey().
// Refuses the hardcoded 'dev-qdrant-key' default in production. Keep in sync
// with the original if its semantics change.
function _resolveQdrantKey() {
  const key = process.env.QDRANT_API_KEY;
  if (key) return key;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('QDRANT_API_KEY not configured, refusing to use the dev-qdrant-key default in production');
  }
  return 'dev-qdrant-key';
}

function resolveDeps(deps) {
  const base = {
    fetchImpl: typeof fetch === 'function' ? fetch : null,
    embedText: null,
    // Safe no-op until configure({ getProviderKeys }) runs at server boot —
    // never throws, resolves no keys (same as today's flag-off-adjacent
    // degrade), rather than this module resolving credentials on its own.
    getProviderKeys: async () => ({}),
    qdrantUrl: process.env.QDRANT_URL || 'http://qdrant:6333',
    qdrantKey: _resolveQdrantKey,
    now: () => Date.now(),
  };
  if (!base.embedText) {
    // Lazy require to dodge a load-order cycle with routes/quoxchat.js.
    base.embedText = async (text, providerKeys, opts) => {
      const { embedText: quoxchatEmbedText } = require('../routes/quoxchat.js');
      return quoxchatEmbedText(text, providerKeys, opts);
    };
  }
  return { ...base, ..._productionDeps, ..._testOverrides, ...deps };
}

// Deterministic UUID (v4-shaped, not truly random) derived from org+conversation
// so repeated captures of the same conversation overwrite the same point,
// one vector per conversation, no full-history scans.
function _deterministicPointId(orgId, conversationId) {
  const hash = crypto.createHash('sha256').update(`${orgId}:${conversationId}`).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-');
}

function _truncate(str, max) {
  if (typeof str !== 'string') return '';
  return str.length > max ? `${str.slice(0, max)}...` : str;
}

// Bounded extractive summary: agent name, up to the last 6 history turns
// (string content only, each truncated), the latest prompt, and the final
// response. Hard total cap so summaries never scan an entire long
// conversation into the embed call.
function _buildSummary({ agentId, prompt, responseText, historyTurns }) {
  const parts = [];
  if (agentId) parts.push(`Agent: ${agentId}`);

  const recentTurns = Array.isArray(historyTurns) ? historyTurns.slice(-6) : [];
  for (const turn of recentTurns) {
    if (!turn || typeof turn.content !== 'string') continue; // skip tool/array-content turns
    const role = turn.role || 'unknown';
    parts.push(`${role}: ${_truncate(turn.content, 280)}`);
  }

  if (typeof prompt === 'string' && prompt) {
    parts.push(`user: ${_truncate(prompt, 500)}`);
  }
  if (typeof responseText === 'string' && responseText) {
    parts.push(`assistant: ${_truncate(responseText, 700)}`);
  }

  return _truncate(parts.join('\n'), 4000);
}

async function _ensureCollection(deps) {
  if (_collectionEnsured) return true;
  try {
    const qdrantKey = typeof deps.qdrantKey === 'function' ? deps.qdrantKey() : deps.qdrantKey;
    const resp = await deps.fetchImpl(`${deps.qdrantUrl}/collections/${QM_LTM_COLLECTION}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'api-key': qdrantKey },
      body: JSON.stringify({ vectors: { size: QDRANT_VECTOR_SIZE, distance: 'Cosine' } }),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok && resp.status !== 409) {
      const txt = await resp.text().catch(() => '');
      if (!/already exists/i.test(txt)) {
        console.warn(`[QM-LTM] collection ensure returned ${resp.status} ${txt.slice(0, 120)}`);
      }
    }
    // Best-effort keyword payload indexes for org_id/user_id filtering.
    // Failures here are non-fatal, search still works unindexed, just slower.
    for (const field of ['org_id', 'user_id']) {
      try {
        await deps.fetchImpl(`${deps.qdrantUrl}/collections/${QM_LTM_COLLECTION}/index`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'api-key': qdrantKey },
          body: JSON.stringify({ field_name: field, field_schema: 'keyword' }),
          signal: AbortSignal.timeout(5000),
        });
      } catch { /* non-fatal, best effort */ }
    }
    _collectionEnsured = true;
    return true;
  } catch (err) {
    console.warn(`[QM-LTM] collection ensure failed (non-fatal): ${err.message}`);
    return false;
  }
}

function _throttled(conversationId, now) {
  const last = _lastCaptureAt.get(conversationId);
  return typeof last === 'number' && (now - last) < QM_LTM_MIN_INTERVAL_MS;
}

function _markCaptured(conversationId, now) {
  if (_lastCaptureAt.size >= THROTTLE_MAP_MAX && !_lastCaptureAt.has(conversationId)) {
    // FIFO eviction, Map preserves insertion order.
    const oldestKey = _lastCaptureAt.keys().next().value;
    if (oldestKey !== undefined) _lastCaptureAt.delete(oldestKey);
  }
  _lastCaptureAt.set(conversationId, now);
}

// Summarise + vectorise a completed conversation and upsert one point into
// the conversation-history collection. Never throws, every failure path
// resolves { captured: false, reason } so this can never break the chat path.
async function captureConversation(input, depsOverride) {
  const { orgId, userId, agentId, conversationId, prompt, responseText, historyTurns } = input || {};
  if (!isLtmEnabled(orgId)) return { captured: false, reason: 'flag_off' };

  if (!orgId || !conversationId) return { captured: false, reason: 'missing_ids' };

  const deps = resolveDeps(depsOverride);
  const now = deps.now();

  if (_throttled(conversationId, now)) return { captured: false, reason: 'throttled' };

  try {
    const summary = _buildSummary({ agentId, prompt, responseText, historyTurns });
    const turnCount = Array.isArray(historyTurns) ? historyTurns.length : 0;

    const providerKeys = await deps.getProviderKeys(orgId);
    const embedResult = await deps.embedText(summary, providerKeys, {});
    const vector = embedResult?.vector;
    if (!Array.isArray(vector) || vector.length === 0) {
      console.warn('[QM-LTM] capture skipped: embed returned no vector');
      return { captured: false, reason: 'embed_failed' };
    }

    await _ensureCollection(deps);

    const qdrantKey = typeof deps.qdrantKey === 'function' ? deps.qdrantKey() : deps.qdrantKey;
    const pointId = _deterministicPointId(orgId, conversationId);
    const point = {
      id: pointId,
      vector,
      payload: {
        kind: 'conversation_summary',
        org_id: orgId,
        user_id: userId || null,
        agent_id: agentId || null,
        conversation_id: conversationId,
        summary,
        turn_count: turnCount,
        updated_at: new Date(now).toISOString(),
      },
    };

    const resp = await deps.fetchImpl(`${deps.qdrantUrl}/collections/${QM_LTM_COLLECTION}/points?wait=true`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'api-key': qdrantKey },
      body: JSON.stringify({ points: [point] }),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      console.warn(`[QM-LTM] upsert declined: ${resp.status} ${txt.slice(0, 200)}`);
      return { captured: false, reason: 'upsert_failed' };
    }

    _markCaptured(conversationId, now);
    return { captured: true, pointId };
  } catch (err) {
    console.warn(`[QM-LTM] capture failed (non-fatal): ${err.message}`);
    return { captured: false, reason: 'error' };
  }
}

// Query the conversation-history collection, scoped to org (and user, when
// provided). Never throws, resolves [] on any failure.
async function recallConversations(input, depsOverride) {
  const { query, orgId, userId, limit } = input || {};
  if (!isLtmEnabled(orgId)) return [];

  if (!orgId) return [];

  const deps = resolveDeps(depsOverride);

  try {
    const providerKeys = await deps.getProviderKeys(orgId);
    const embedResult = await deps.embedText(query, providerKeys, {});
    const vector = embedResult?.vector;
    if (!Array.isArray(vector) || vector.length === 0) return [];

    const qdrantKey = typeof deps.qdrantKey === 'function' ? deps.qdrantKey() : deps.qdrantKey;
    const must = [{ key: 'org_id', match: { value: orgId } }];
    if (userId) must.push({ key: 'user_id', match: { value: userId } });

    const cappedLimit = Math.min(limit || 3, 10);

    const resp = await deps.fetchImpl(`${deps.qdrantUrl}/collections/${QM_LTM_COLLECTION}/points/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': qdrantKey },
      body: JSON.stringify({
        vector,
        limit: cappedLimit,
        with_payload: true,
        filter: { must },
      }),
      signal: AbortSignal.timeout(3000),
    });

    if (!resp.ok) return [];
    const data = await resp.json();
    const result = Array.isArray(data?.result) ? data.result : [];

    return result.map(r => ({
      conversation_id: r.payload?.conversation_id,
      agent_id: r.payload?.agent_id,
      summary: r.payload?.summary,
      updated_at: r.payload?.updated_at,
      score: r.score,
    }));
  } catch (err) {
    console.warn(`[QM-LTM] recall failed (non-fatal): ${err.message}`);
    return [];
  }
}

// Test-only hooks: inject deps and reset module-level state between cases.
const _testHooks = {
  setDeps(overrides) {
    _testOverrides = overrides || null;
  },
  reset() {
    _testOverrides = null;
    _lastCaptureAt.clear();
    _collectionEnsured = false;
  },
};

function _resetStateForTest() {
  _testHooks.reset();
}

module.exports = {
  QM_LTM_COLLECTION,
  isLtmEnabled,
  configure,
  captureConversation,
  recallConversations,
  _testOverrides: _testHooks,
  _resetStateForTest,
};
