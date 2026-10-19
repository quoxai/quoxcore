/**
 * Widget Routes for Quox Auth Service (CW-8.2)
 *
 * CRUD for website_widgets table.
 * Each widget has a backing assistant (FK) for personality/LLM config.
 */

import { ensureOrgWidgetEvidenceSigningKey, signWidgetEvidence } from '../lib/widgetEvidenceSigningKey.js';
import { isDevOnlyDomain } from '../lib/widgetDevDomains.js';
import { Router } from 'express';
import crypto from 'crypto';
import multer from 'multer';
import { prepare, getDb } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership } from '../middleware/org.js';
import { createAuditEvent, ulid, slugify, getPagination, formatPaginatedResponse } from '../utils/helpers.js';
import { mergeIdentifiedAttrs, summariseVisitor } from '../lib/widgetVisitorMemory.js';
import { classifyWidgetRisk } from '../lib/widgetRiskClassifier.js';
import { getEntitlements } from '../lib/widgetEntitlements.js';
import { resolveWidgetPlan } from '../lib/widgetPlan.js';
// LICENSE-LAUNCH LL-6a — the LICENCE entitlement resolver (signed leases),
// not to be confused with widgetEntitlements above, which is the plan-tier
// quota table. Two different questions: "may this org run QuoxChat at all"
// vs "how many widgets does its plan allow".
import { hasPlugin } from '../lib/entitlements.js';
import { evaluateComplianceReadiness } from '../lib/widgetComplianceReadiness.js';
// Pre-existing bug fix (found while adding CAPTCHA #127's captcha_secret
// PATCH field): checkPatchEntitlements was called at line ~945 but never
// imported — every PATCH /orgs/:orgId/widgets/:widgetId call with a
// non-empty body threw ReferenceError (500), including this feature's own
// save path. lib/widgetEntitlementGate.js already exported it correctly.
import { checkPatchEntitlements } from '../lib/widgetEntitlementGate.js';
import { detectSupersededSignal, isStrongSupersededSignal } from '../lib/knowledgeSupersededSignal.js';
import { extractPriceInfo, sourcesChangedByNotice } from '../lib/priceChangeNotice.js';
import { hasRoleLevel } from '../utils/policy.js';
import { checkPrivateEndpointChange } from '../lib/widgetPrivateEndpointGate.js';
import { seedDefaultWidgetTools, DEFAULT_TOOL_POLICIES } from '../lib/widgetDefaultTools.js';
// QUOXCHAT-EMAIL P2 — captcha_secret is encrypted at rest. Legacy plaintext
// rows still serve via the fallback in the internal meta route.
import { encrypt, decrypt } from '../utils/encryption.js';

const router = Router();

function safeCompare(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
}

// ── LICENSE-LAUNCH LL-6a — QuoxChat entitlement gate (auth side) ─────────
// The 2026-08-28 adversarial challenge found that widget CREATION gated only
// on the plan-tier widget_count_cap, and the knowledge/teach proxies gated on
// nothing at all — so an unlicensed org could configure widgets and drive
// collector-side embedding/LLM spend while only /quoxchat/message 402'd.
//
// Same mechanism the platform's other licence gates use: hasPlugin() against
// the signed, instance-bound, unexpired lease set (lib/entitlements.js), and
// the same 402 body shape as services/auth/routes/plugins.js.
//
// The env switch is the EXISTING collector cutover flag, deliberately not a
// new one: an install that set QUOXCHAT_LICENSE_ENFORCE=off because its
// licence issuance has not been cut over must not end up half-gated, with
// live widgets serving but their admin surface bricked.
const QUOXCHAT_LICENSE_ENFORCE = String(process.env.QUOXCHAT_LICENSE_ENFORCE || 'on').toLowerCase() !== 'off';

// Mount AFTER requireOrgMembership: req.org is the membership-validated org,
// and the path param is only the fallback for that same, already-checked id.
function requireQuoxchatEntitlement(req, res, next) {
  if (!QUOXCHAT_LICENSE_ENFORCE) return next();
  const orgId = req.org?.id || req.params.orgId;
  try {
    if (hasPlugin(getDb(), 'quoxchat', orgId)) return next();
    console.warn(`[widgets] quoxchat entitlement gate blocked: org=${orgId} path=${req.originalUrl}`);
  } catch (err) {
    console.error('[widgets] quoxchat entitlement check failed — failing CLOSED:', err.message);
  }
  return res.status(402).json({ error: 'LICENSE_REQUIRED', plugin: 'quoxchat' });
}

function requireInternalAuth(req, res, next) {
  const expected = process.env.INTERNAL_SERVICE_KEY;
  if (!expected) return res.status(401).json({ error: 'Service key not configured' });
  const key = req.headers['x-service-key'];
  if (key && safeCompare(String(key), expected)) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// CAPTCHA #127 — captcha_secret is write-only: the org-admin API never
// echoes the stored value back (unlike identity_secret, which the admin
// needs to implement server-side HMAC). Strip it from every widget row
// destined for a JSON response and expose only whether one is configured.
function redactWidgetSecrets(w) {
  if (!w || typeof w !== 'object') return w;
  // QUOXCHAT-BRUTALOOP w5 D12: identity_secret is never echoed either; the
  // collector reads it over the internal meta route. Only a boolean leaves.
  const { captcha_secret, identity_secret, ...rest } = w;
  return { ...rest, captcha_secret_set: !!captcha_secret, identity_secret_set: !!identity_secret };
}

// PERSIST-TRUTH — best-effort purge of a widget's embedded-content Qdrant
// collection via the collector's internal endpoint. Never throws — callers
// (widget delete) must remain able to delete the DB row even when this
// fails; the caller is responsible for surfacing/auditing a failure loudly.
async function purgeWidgetKnowledge(widgetId) {
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (!serviceKey) {
    return { ok: false, collection: null, reason: 'INTERNAL_SERVICE_KEY not configured' };
  }
  const collectorUrl = process.env.COLLECTOR_URL || process.env.QUOX_COLLECTOR_URL || 'http://collector:9848';
  try {
    const resp = await fetch(`${collectorUrl}/quoxchat/internal/widget-knowledge/${encodeURIComponent(widgetId)}`, {
      method: 'DELETE',
      headers: { 'x-service-key': serviceKey },
      signal: AbortSignal.timeout(8000),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.success !== true) {
      return {
        ok: false,
        collection: data.collection || null,
        reason: `collector returned ${resp.status}: ${data.error || 'unknown_error'}`,
      };
    }
    return { ok: true, collection: data.collection, deleted: data.deleted };
  } catch (err) {
    return { ok: false, collection: null, reason: `fetch failed: ${err.message}` };
  }
}

// QCL-SECURITY P0-1 — collector's KB/admin endpoints (/quoxchat/knowledge/*,
// /quoxchat/teach/propose) now require x-service-key (Phase 2, mirrors the
// purgeWidgetKnowledge pattern above). These are the only legitimate callers
// — the public widget never hits them — so we forward here with the service
// key AFTER requireOrgMembership + widget-ownership have already verified
// the caller. Returns {status, data} so the route handler can relay the
// collector's response (including its error shape) unchanged.
async function forwardToCollectorJson(path, body, opts = {}) {
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (!serviceKey) return { status: 503, data: { error: 'service_key_not_configured' } };
  const collectorUrl = process.env.COLLECTOR_URL || process.env.QUOX_COLLECTOR_URL || 'http://collector:9848';
  try {
    const resp = await fetch(`${collectorUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-key': serviceKey },
      body: JSON.stringify(body),
      ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
    });
    const data = await resp.json().catch(() => ({}));
    return { status: resp.status, data };
  } catch (err) {
    return { status: 502, data: { error: 'collector_unreachable', message: err.message } };
  }
}

async function forwardToCollectorPatch(path, body) {
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (!serviceKey) return { status: 503, data: { error: 'service_key_not_configured' } };
  const collectorUrl = process.env.COLLECTOR_URL || process.env.QUOX_COLLECTOR_URL || 'http://collector:9848';
  try {
    const resp = await fetch(`${collectorUrl}${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-service-key': serviceKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const data = await resp.json().catch(() => ({}));
    return { status: resp.status, data };
  } catch (err) {
    return { status: 502, data: { error: 'collector_unreachable', message: err.message } };
  }
}

async function forwardToCollectorDelete(path) {
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (!serviceKey) return { status: 503, data: { error: 'service_key_not_configured' } };
  const collectorUrl = process.env.COLLECTOR_URL || process.env.QUOX_COLLECTOR_URL || 'http://collector:9848';
  try {
    const resp = await fetch(`${collectorUrl}${path}`, { method: 'DELETE', headers: { 'x-service-key': serviceKey }, signal: AbortSignal.timeout(15000) });
    const data = await resp.json().catch(() => ({}));
    return { status: resp.status, data };
  } catch (err) {
    return { status: 502, data: { error: 'collector_unreachable', message: err.message } };
  }
}

// Statuses an org admin may set directly. Going live is the publish action
// (POST .../publish), which runs the security checks. w6k: 'active' is no
// longer settable (existing 'active' rows keep serving, treated as published);
// 'published' is settable only to RESUME a paused widget that already holds a
// passing publish claim.
const PATCHABLE_WIDGET_STATUSES = ['draft', 'paused', 'archived'];

function checkPatchStatus(status, current, hasPassingPublish) {
  if (PATCHABLE_WIDGET_STATUSES.includes(status)) return null;
  if (status === 'published' && current === 'paused' && hasPassingPublish) return null;
  return {
    error: 'invalid_status',
    message: status === 'published' || status === 'active'
      ? "Use Go live (the publish action) to make a widget live: it runs the security checks first. A paused widget resumes directly only if it has already passed them."
      : `status must be one of: ${PATCHABLE_WIDGET_STATUSES.join(', ')}`,
  };
}

function normalizeGuardrails(g) {
  const okList = (v) => v === undefined || (Array.isArray(v) && v.every(x => typeof x === 'string'));
  if (!okList(g.always) || !okList(g.never)) return null;
  return { always: g.always || [], never: g.never || [] };
}

// Normalises guardrails_json (legacy array or {always,never}) for the collector.
function parseGuardrails(raw) {
  let g = null;
  try { g = raw ? JSON.parse(raw) : null; } catch { g = null; }
  if (Array.isArray(g)) return { always: [], never: g.filter(x => typeof x === 'string') };
  const pick = (v) => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);
  return { always: pick(g?.always), never: pick(g?.never) };
}

export const widgetsInternalRouter = Router();
widgetsInternalRouter.use(requireInternalAuth);

// QC-W18b: turns in the last hour whose grounding recorded retrieval_degraded
// (dense/embedding retrieval failed, keyword search only). Computed from the
// persisted per-turn grounding, so it survives restarts and works across replicas.
const _DEGRADED_WHERE = `dm.widget_id = w.id AND dm.role = 'assistant'
  AND dm.created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')
  AND json_extract(dm.context_json, '$.grounding.retrieval_degraded') = 'lexical_only'`;
const DEGRADED_COUNT_SQL = `(SELECT COUNT(*) FROM widget_messages dm WHERE ${_DEGRADED_WHERE})`;
const DEGRADED_LAST_SQL = `(SELECT json_object('provider', json_extract(dm.context_json, '$.grounding.retrieval_degraded_provider'), 'status', json_extract(dm.context_json, '$.grounding.retrieval_degraded_status')) FROM widget_messages dm WHERE ${_DEGRADED_WHERE} ORDER BY dm.created_at DESC LIMIT 1)`;
function withDegraded(row) {
  const { retrieval_degraded_last_json: lastJson, ...rest } = row;
  let last = null;
  try { last = lastJson ? JSON.parse(lastJson) : null; } catch { last = null; }
  return { ...rest, retrieval_degraded_count: Number(row.retrieval_degraded_count) || 0, retrieval_degraded_last: last };
}

/**
 * POST /internal/widgets/:widgetId/persist-message
 * Collector calls this after each /quoxchat/message exchange.
 * Creates or appends to a widget_conversations row and writes user+assistant messages.
 */
widgetsInternalRouter.post('/widgets/:widgetId/persist-message', async (req, res) => {
  try {
    const { widgetId } = req.params;
    const { visitor_id, conversation_id, correlation_id, user_message, assistant_message, sources, confidence, injection_score, page_url, tool_calls, context, blocked, cost_micro_usd, key_source, duration_ms } = req.body || {};

    // CW-SEC-1: accept either internal id or public_key (embed code uses public_key).
    const widget = prepare('SELECT id, org_id FROM website_widgets WHERE id = ? OR public_key = ?').get(widgetId, widgetId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });
    if (!visitor_id || !user_message || !assistant_message) return res.status(400).json({ error: 'visitor_id, user_message, assistant_message required' });

    let convId = conversation_id;
    let wasNewConversation = false;
    const isTestVisitor = typeof visitor_id === 'string' && (visitor_id.startsWith('sim_') || TEST_VISITOR_IDS.includes(visitor_id));
    const db = getDb();
    db.transaction(() => {
      if (!convId) {
        // reuse active conversation for this visitor if one exists in last hour
        const existing = prepare(`
          SELECT id FROM widget_conversations
          WHERE widget_id = ? AND visitor_id = ? AND status = 'active'
            AND datetime(last_message_at) > datetime('now','-1 hour')
          ORDER BY last_message_at DESC LIMIT 1
        `).get(widget.id, visitor_id);
        if (existing) {
          convId = existing.id;
        } else {
          convId = ulid();
          wasNewConversation = true;
          prepare(`
            INSERT INTO widget_conversations (id, widget_id, org_id, visitor_id, status, correlation_id, message_count, started_at, last_message_at, page_url)
            VALUES (?, ?, ?, ?, 'active', ?, 0, datetime('now'), datetime('now'), ?)
          `).run(convId, widget.id, widget.org_id, visitor_id, correlation_id || convId,
            typeof page_url === 'string' && /^(https?:\/\/|\/)/i.test(page_url) ? page_url.slice(0, 500) : null);
        }
      }

      const now = new Date().toISOString();
      // CW-FU: store org_id directly on message rows (defensive isolation).
      prepare(`
        INSERT INTO widget_messages (id, conversation_id, widget_id, org_id, role, content, injection_score, filtered, created_at)
        VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?)
      `).run(ulid(), convId, widget.id, widget.org_id, user_message, injection_score || 0, blocked === true ? 1 : 0, now);

      // QCX-5a: context_json captures the exact LLM input (system prompt +
      // RAG chunks + messages_sent + model/tier/tokens) so admin LogsTab
      // can root-cause bad answers. Nullable; user rows leave it NULL.
      prepare(`
        INSERT INTO widget_messages (id, conversation_id, widget_id, org_id, role, content, sources_json, confidence, tool_calls_json, context_json, response_ms, created_at)
        VALUES (?, ?, ?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ulid(), convId, widget.id, widget.org_id, assistant_message,
        sources ? JSON.stringify(sources) : null,
        confidence ?? null,
        (Array.isArray(tool_calls) && tool_calls.length) ? JSON.stringify(tool_calls) : null,
        context ? JSON.stringify(context) : null,
        // w5h: measured turn duration (blocked turns carry none: no LLM ran).
        Number.isFinite(duration_ms) && duration_ms >= 0 ? Math.round(duration_ms) : null,
        now,
      );

      // Conversations are usually created up front by ensure-conversation,
      // so "no conversation_id was passed" is not the test for a new one: the
      // first persisted exchange (message_count still 0) is. Prod 2026-10:
      // 1118 messages, 0 conversations counted, new_conversation alerts silent.
      const prior = prepare('SELECT message_count FROM widget_conversations WHERE id = ?').get(convId);
      if (prior && Number(prior.message_count) === 0) wasNewConversation = true;

      prepare(`
        UPDATE widget_conversations
        SET message_count = message_count + 2, last_message_at = datetime('now')
        WHERE id = ?
      `).run(convId);

      // Wave 7 #3: simulation / admin-test traffic (sim_*, knowledge-tab-test) is
      // stored (Logs shows it labelled Test) but is NOT customer usage: it must
      // not feed total_conversations, the monthly usage bucket, caps or billing.
      if (isTestVisitor) return;

      prepare(`
        UPDATE website_widgets
        SET total_messages = COALESCE(total_messages,0) + 2,
            total_conversations = (SELECT COUNT(*) FROM widget_conversations WHERE widget_id = ? AND NOT (visitor_id LIKE 'sim\\_%' ESCAPE '\\' OR visitor_id IN ('knowledge-tab-test', 'training_test', 'onboarding'))),
            last_conversation_at = datetime('now')
        WHERE id = ?
      `).run(widget.id, widget.id);

      // QCX-7b — bump the YYYY-MM usage bucket. INSERT OR IGNORE seeds
      // the row, then UPDATE increments. New conversations counted only
      // when this is the first message of the conversation (message_count
      // was 0 before our +2 update). tool_calls counted from the array.
      const month = new Date().toISOString().slice(0, 7); // YYYY-MM
      prepare(`
        INSERT OR IGNORE INTO widget_usage_monthly (widget_id, month) VALUES (?, ?)
      `).run(widget.id, month);
      const toolCallCount = Array.isArray(tool_calls) ? tool_calls.length : 0;
      // P7: LLM spend (integer micro-USD, from the collector's price table) and
      // the key source that answered. Blocked turns never reach an LLM: 0 / keep.
      const costMicro = Number.isFinite(cost_micro_usd) && cost_micro_usd > 0 ? Math.round(cost_micro_usd) : 0;
      const keySrc = typeof key_source === 'string' && key_source ? (KEY_SOURCES.includes(key_source) ? key_source : 'unknown') : null;
      prepare(`
        UPDATE widget_usage_monthly
           SET conversations = conversations + ?,
               messages = messages + 2,
               tool_calls = tool_calls + ?,
               llm_cost_micro_usd = llm_cost_micro_usd + ?,
               last_key_source = COALESCE(?, last_key_source),
               updated_at = datetime('now')
         WHERE widget_id = ? AND month = ?
      `).run(wasNewConversation ? 1 : 0, toolCallCount, costMicro, keySrc, widget.id, month);
    })();

    // QUOXCHAT-PRO P1: `created` tells the collector this exchange started a
    // brand-new conversation so it can emit the new_conversation org alert
    // exactly once (not on every message).
    res.json({ success: true, conversation_id: convId, created: wasNewConversation && !isTestVisitor });
  } catch (err) {
    console.error('Error persisting widget message:', err);
    res.status(500).json({ error: 'Failed to persist message' });
  }
});

/**
 * POST /internal/widgets/:widgetId/conversations/:conversationId/rating
 * Visitor thumbs up/down (collector POST /quoxchat/feedback calls this).
 * Writes widget_conversations.visitor_rating (+1 / -1), which is what the
 * Analytics Satisfaction stat and the Logs rating filter read. Before this
 * route nothing wrote the column, so Satisfaction could never populate.
 * Scoped like visitor-identity: the conversation must belong to the given
 * (widget, visitor) pair, so a leaked conversation id alone rates nothing.
 * Latest rating wins (a visitor may change their mind).
 */
widgetsInternalRouter.post('/widgets/:widgetId/conversations/:conversationId/rating', (req, res) => {
  try {
    const { widgetId, conversationId } = req.params;
    const { visitor_id, rating } = req.body || {};
    if (!visitor_id || typeof visitor_id !== 'string') return res.status(400).json({ error: 'visitor_id required' });
    if (rating !== 1 && rating !== -1) return res.status(400).json({ error: 'rating must be 1 or -1' });
    const widget = prepare('SELECT id FROM website_widgets WHERE id = ? OR public_key = ?').get(widgetId, widgetId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });
    const conv = prepare('SELECT id FROM widget_conversations WHERE id = ? AND widget_id = ? AND visitor_id = ?')
      .get(conversationId, widget.id, visitor_id);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    prepare('UPDATE widget_conversations SET visitor_rating = ? WHERE id = ?').run(rating, conv.id);
    res.json({ success: true, conversation_id: conv.id, rating });
  } catch (err) {
    console.error('Error rating conversation:', err);
    res.status(500).json({ error: 'Failed to store rating' });
  }
});

/**
 * POST /internal/widgets/:widgetId/ensure-conversation (CW-9.3)
 * Returns an existing active conversation for (widget, visitor) within the last hour,
 * or creates one. Called by collector BEFORE the LLM runs so tools have a conversation_id
 * to attach side effects to (leads, handoffs). Idempotent.
 * Body: { visitor_id, correlation_id? }
 */
widgetsInternalRouter.post('/widgets/:widgetId/ensure-conversation', (req, res) => {
  try {
    const { widgetId } = req.params;
    const { visitor_id, correlation_id } = req.body || {};
    if (!visitor_id) return res.status(400).json({ error: 'visitor_id required' });
    // CW-SEC-1: accept either internal id or public_key.
    const widget = prepare('SELECT id, org_id FROM website_widgets WHERE id = ? OR public_key = ?').get(widgetId, widgetId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });

    const existing = prepare(`
      SELECT id FROM widget_conversations
      WHERE widget_id = ? AND visitor_id = ? AND status = 'active'
        AND datetime(last_message_at) > datetime('now','-1 hour')
      ORDER BY last_message_at DESC LIMIT 1
    `).get(widget.id, visitor_id);
    if (existing) return res.json({ conversation_id: existing.id, created: false });

    const id = ulid();
    prepare(`
      INSERT INTO widget_conversations (id, widget_id, org_id, visitor_id, status, correlation_id, message_count, started_at, last_message_at)
      VALUES (?, ?, ?, ?, 'active', ?, 0, datetime('now'), datetime('now'))
    `).run(id, widget.id, widget.org_id, visitor_id, correlation_id || id);
    res.json({ conversation_id: id, created: true });
  } catch (err) {
    console.error('Error ensuring conversation:', err);
    res.status(500).json({ error: 'Failed to ensure conversation' });
  }
});

/**
 * POST /internal/widgets/:widgetId/knowledge-sources (CW-8.13)
 * Collector calls this after a successful upload/crawl/qa so the source row
 * persists beyond the Qdrant index. Mirrors the persist-message pattern.
 * Body: { source_type: 'file'|'url'|'qa', name, chunk_count, status, config, error_message? }
 */
widgetsInternalRouter.post('/widgets/:widgetId/knowledge-sources', async (req, res) => {
  try {
    const { widgetId } = req.params;
    const { source_type, name, chunk_count, status, config, error_message, file_object_id, size_bytes } = req.body || {};

    if (!source_type || !name) return res.status(400).json({ error: 'source_type and name required' });
    if (!['file', 'url', 'qa', 'connector'].includes(source_type)) return res.status(400).json({ error: 'invalid source_type' });

    // CW-SEC-1: accept either internal id or public_key.
    const widget = prepare('SELECT id, org_id FROM website_widgets WHERE id = ? OR public_key = ?').get(widgetId, widgetId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });

    // CW-FU: if file_object_id is provided, verify it belongs to the widget's org
    // — prevents cross-org reference. If missing we still insert (URL/Q&A rows).
    let resolvedFileId = null;
    if (file_object_id) {
      const foRow = prepare('SELECT id FROM file_objects WHERE id = ? AND org_id = ?').get(file_object_id, widget.org_id);
      if (foRow) resolvedFileId = foRow.id;
    }

    const id = ulid();
    prepare(`
      INSERT INTO widget_knowledge_sources
        (id, widget_id, org_id, source_type, name, config_json, status, chunk_count, error_message, file_object_id, size_bytes, last_sync_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      id,
      widget.id,
      widget.org_id,
      source_type,
      String(name).slice(0, 500),
      JSON.stringify(config || {}),
      status || 'indexed',
      Number.isFinite(chunk_count) ? chunk_count : 0,
      error_message || null,
      resolvedFileId,
      Number.isFinite(size_bytes) && size_bytes >= 0 ? Math.floor(size_bytes) : null,
    );

    res.json({ success: true, id, file_object_id: resolvedFileId });
  } catch (err) {
    console.error('Error creating knowledge source:', err);
    res.status(500).json({ error: 'Failed to persist knowledge source' });
  }
});

// Backfill rule for rows with NULL size_bytes (written before migration 112):
// a chunk is ~1000 chars of text with 200 overlap, so ~1 KB stored text per
// chunk. Estimates are always flagged (`estimated`), never silently summed.
const KNOWLEDGE_EST_BYTES_PER_CHUNK = 1000;

// Display-side mirror of the collector's KNOWLEDGE_STORAGE_LIMITS_BYTES
// (routes/quoxchat.js), which is what ENFORCES the cap. Keep the two in step.
const KNOWLEDGE_STORAGE_LIMITS_BYTES = { standard: 1_000_000_000, professional: 5_000_000_000 };

function knowledgeStorageForOrg(orgId) {
  const row = prepare(`
    SELECT COALESCE(SUM(CASE WHEN size_bytes IS NULL THEN 1 ELSE 0 END), 0) AS estimated_sources,
           COALESCE(SUM(CASE WHEN size_bytes IS NULL THEN COALESCE(chunk_count, 0) * ? ELSE size_bytes END), 0) AS bytes
    FROM widget_knowledge_sources WHERE org_id = ?
  `).get(KNOWLEDGE_EST_BYTES_PER_CHUNK, orgId);
  let tier = null;
  try {
    if (QUOXCHAT_LICENSE_ENFORCE) {
      if (hasPlugin(getDb(), 'quoxchat-pro', orgId)) tier = 'professional';
      else if (hasPlugin(getDb(), 'quoxchat', orgId)) tier = 'standard';
    }
  } catch { tier = null; }
  return {
    used_bytes: row.bytes,
    estimated_sources: row.estimated_sources,
    tier,
    limit_bytes: tier ? KNOWLEDGE_STORAGE_LIMITS_BYTES[tier] : null,
  };
}

/**
 * GET /internal/widgets/:widgetId/knowledge-usage
 * Knowledge storage used by the widget's ORG (the quota is per org across all
 * its widgets: the licence is per org and the pricing copy says "Unlimited
 * widgets ... 1 GB knowledge storage", i.e. storage is the org-level cap).
 * Returns { org_id, bytes, sources, estimated_sources }.
 */
widgetsInternalRouter.get('/widgets/:widgetId/knowledge-usage', (req, res) => {
  try {
    const { widgetId } = req.params;
    const widget = prepare('SELECT id, org_id FROM website_widgets WHERE id = ? OR public_key = ?').get(widgetId, widgetId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });
    const row = prepare(`
      SELECT COUNT(*) AS sources,
             COALESCE(SUM(CASE WHEN size_bytes IS NULL THEN 1 ELSE 0 END), 0) AS estimated_sources,
             COALESCE(SUM(CASE WHEN size_bytes IS NULL THEN COALESCE(chunk_count, 0) * ? ELSE size_bytes END), 0) AS bytes
      FROM widget_knowledge_sources
      WHERE org_id = ?
    `).get(KNOWLEDGE_EST_BYTES_PER_CHUNK, widget.org_id);
    res.json({
      org_id: widget.org_id,
      bytes: row.bytes,
      sources: row.sources,
      estimated_sources: row.estimated_sources,
    });
  } catch (err) {
    console.error('Error computing knowledge usage:', err);
    res.status(500).json({ error: 'Failed to compute knowledge usage' });
  }
});

/**
 * GET /internal/widgets/:widgetId/knowledge-sources (QCFT #213)
 * Service-key mirror of the org-scoped list, so the collector's corpus
 * sync surface (GET /quoxchat/knowledge/sources) can diff a widget's
 * persisted sources without a user session. Accepts internal id or
 * public_key (CW-SEC-1 convention). Row shape matches the org-scoped
 * route so consumers cannot drift.
 */
widgetsInternalRouter.get('/widgets/:widgetId/knowledge-sources', (req, res) => {
  try {
    const { widgetId } = req.params;
    const widget = prepare('SELECT id FROM website_widgets WHERE id = ? OR public_key = ?').get(widgetId, widgetId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });

    // QCX-SYNC-CAP: the old hard LIMIT 1000 was a silent cap — the corpus
    // sync diffs against this list, so a >1000-source widget re-created
    // everything past the cap on every run (904 duplicate rows on the
    // first >1000 corpus, 2026-09-04). Pagination + total makes the cap
    // visible and lets the sync walk every page.
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 1000, 1), 1000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const total = prepare('SELECT COUNT(*) AS c FROM widget_knowledge_sources WHERE widget_id = ?')
      .get(widget.id).c;
    const rows = prepare(`
      SELECT id, source_type, name, config_json, status, chunk_count, size_bytes, error_message, last_sync_at, created_at
      FROM widget_knowledge_sources
      WHERE widget_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(widget.id, limit, offset);

    res.json({
      total,
      limit,
      offset,
      widget_id: widget.id,
      sources: rows.map(r => {
        let config = {};
        try { config = JSON.parse(r.config_json || '{}'); } catch { /* noop */ }
        return {
          id: r.id,
          type: r.source_type,
          name: r.name,
          config,
          status: r.status,
          chunks: r.chunk_count,
          sizeBytes: r.size_bytes == null ? (r.chunk_count || 0) * KNOWLEDGE_EST_BYTES_PER_CHUNK : r.size_bytes,
          sizeEstimated: r.size_bytes == null,
          errorMessage: r.error_message,
          lastSync: r.last_sync_at,
          createdAt: r.created_at,
        };
      }),
    });
  } catch (err) {
    console.error('Error listing knowledge sources (internal):', err);
    res.status(500).json({ error: 'Failed to list knowledge sources' });
  }
});

/**
 * GET /internal/widgets/:widgetId/knowledge-sources/:sourceId (QCX-SYNC-CAP)
 * Fetch ONE source row directly. Exists so the collector's delete route can
 * resolve a row in a single call instead of walking the paginated listing
 * (three list calls per delete tripped the internal rate limit mid-dedupe,
 * 429 -> 502, 2026-09-04). Row shape matches the list route.
 */
widgetsInternalRouter.get('/widgets/:widgetId/knowledge-sources/:sourceId', (req, res) => {
  try {
    const { widgetId, sourceId } = req.params;
    const widget = prepare('SELECT id FROM website_widgets WHERE id = ? OR public_key = ?').get(widgetId, widgetId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });

    const r = prepare(`
      SELECT id, source_type, name, config_json, status, chunk_count, error_message, last_sync_at, created_at
      FROM widget_knowledge_sources
      WHERE id = ? AND widget_id = ?
    `).get(sourceId, widget.id);
    if (!r) return res.status(404).json({ error: 'Source not found' });

    let config = {};
    try { config = JSON.parse(r.config_json || '{}'); } catch { /* noop */ }
    res.json({
      id: r.id,
      type: r.source_type,
      name: r.name,
      config,
      status: r.status,
      chunkCount: r.chunk_count,
      errorMessage: r.error_message,
      lastSync: r.last_sync_at,
      createdAt: r.created_at,
    });
  } catch (err) {
    console.error('Error fetching knowledge source (internal):', err);
    res.status(500).json({ error: 'Failed to fetch knowledge source' });
  }
});

/**
 * PATCH /internal/widgets/:widgetId/knowledge-sources/:sourceId
 * Merge `config_patch` (flat object) into the row's config_json. Used by the
 * collector's superseded-source route after it has flagged the Qdrant points.
 */
widgetsInternalRouter.patch('/widgets/:widgetId/knowledge-sources/:sourceId', (req, res) => {
  try {
    const { widgetId, sourceId } = req.params;
    const patch = req.body && req.body.config_patch;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return res.status(400).json({ error: 'config_patch object required' });
    const widget = prepare('SELECT id FROM website_widgets WHERE id = ? OR public_key = ?').get(widgetId, widgetId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });
    const row = prepare('SELECT config_json FROM widget_knowledge_sources WHERE id = ? AND widget_id = ?').get(sourceId, widget.id);
    if (!row) return res.status(404).json({ error: 'Source not found' });
    let cfg = {};
    try { cfg = JSON.parse(row.config_json || '{}'); } catch { /* noop */ }
    const merged = { ...cfg, ...patch };
    prepare('UPDATE widget_knowledge_sources SET config_json = ? WHERE id = ? AND widget_id = ?').run(JSON.stringify(merged), sourceId, widget.id);
    res.json({ success: true, config: merged });
  } catch (err) {
    console.error('Error patching knowledge source (internal):', err);
    res.status(500).json({ error: 'Failed to update knowledge source' });
  }
});

/**
 * DELETE /internal/widgets/:widgetId/knowledge-sources/:sourceId (QCFT #213)
 * Service-key row delete, called by the collector's supersede primitive
 * (DELETE /quoxchat/knowledge/sources/:sourceId) AFTER it has removed the
 * source's Qdrant points. Row-only by design: vector cleanup is the
 * collector's job because only it can reach Qdrant.
 */
widgetsInternalRouter.delete('/widgets/:widgetId/knowledge-sources/:sourceId', (req, res) => {
  try {
    const { widgetId, sourceId } = req.params;
    const widget = prepare('SELECT id FROM website_widgets WHERE id = ? OR public_key = ?').get(widgetId, widgetId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });

    const result = prepare('DELETE FROM widget_knowledge_sources WHERE id = ? AND widget_id = ?').run(sourceId, widget.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Source not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting knowledge source (internal):', err);
    res.status(500).json({ error: 'Failed to delete knowledge source' });
  }
});

/**
 * GET /internal/widgets/:widgetId/meta (CW-FU)
 * Returns widget core metadata the collector needs for file_objects
 * persistence: id, org_id, created_by. Service-key guarded.
 */
widgetsInternalRouter.get('/widgets/:widgetId/meta', (req, res) => {
  try {
    const { widgetId } = req.params;
    // CW-SEC-1: accept either internal id or public_key.
    // QCL-IDENTITY P1: identity_secret included so the collector's
    // fetchWidgetMeta() call can HMAC-verify identify() user_hash payloads.
    // CAPTCHA #127: captcha_secret included so the collector can verify
    // bot_protection tokens server-side — this response only ever crosses
    // the internal service-key boundary (collector <-> auth), never the
    // browser. The widget-facing /quoxchat/config/:publicKey response is a
    // separate handler that hand-picks fields and MUST NEVER add this one.
    // QUOXCHAT-PRO P1: notification_settings_json / office_hours_json /
    // operator_online included so the collector can (a) emit org alerts on
    // new_conversation + handoff_requested and (b) compute the public
    // human_available flag for the widget config response. Same internal
    // service-key boundary caveat as identity_secret/captcha_secret above:
    // notification_settings_json contains operator emails / webhook URLs and
    // MUST NOT be copied into the widget-facing /quoxchat/config response.
    // QCX-BRAND: system_prompt_override included so the collector's prompt
    // assembly can speak as the CUSTOMER's brand instead of the built-in
    // Quox personas (it was stored here but never read by the message path).
    const row = prepare('SELECT id, org_id, created_by, name, embed_config_json, system_prompt_override, identity_secret, captcha_secret, notification_settings_json, office_hours_json, operator_online, status, guardrails_json, business_name FROM website_widgets WHERE id = ? OR public_key = ?').get(widgetId, widgetId);
    if (!row) return res.status(404).json({ error: 'Widget not found' });
    // QUOXCHAT-BRUTALOOP w5 D3: guardrails the Training tab saved, as {always,never}.
    row.guardrails = parseGuardrails(row.guardrails_json);
    delete row.guardrails_json;
    row.system_prompt_override = row.system_prompt_override || '';
    row.business_name = row.business_name || '';
    // Wave 7 #8: the public /quoxchat/config header name falls back to a
    // hardcoded 'Chat with us' unless embed_config.widget_name is set. Feed the
    // business name in as the display name when the admin set no explicit one.
    if (row.business_name) {
      try {
        const cfg = JSON.parse(row.embed_config_json || '{}');
        if (cfg && typeof cfg === 'object' && !(typeof cfg.widget_name === 'string' && cfg.widget_name.trim())) {
          row.embed_config_json = JSON.stringify({ ...cfg, widget_name: row.business_name });
        }
      } catch { /* malformed config: leave as-is */ }
    }
    // QUOXCHAT-EMAIL P2 — captcha_secret decrypts here; a row written before
    // encryption landed is served as-is (legacy plaintext fallback).
    if (row.captcha_secret) {
      try { row.captcha_secret = decrypt(row.captcha_secret); } catch { /* legacy plaintext */ }
    }
    res.json(row);
  } catch (err) {
    console.error('widget meta lookup:', err);
    res.status(500).json({ error: 'Failed to load widget meta' });
  }
});

/**
 * GET /internal/widgets/:widgetId/allowed-domains (CW-13.3)
 * Collector's domain guard calls this to read a widget's allowlist
 * before enforcing it on /quoxchat/message.
 */
widgetsInternalRouter.get('/widgets/:widgetId/allowed-domains', (req, res) => {
  try {
    const { widgetId } = req.params;
    // CW-SEC-1: accept either internal id or public_key.
    const row = prepare('SELECT id, allowed_domains_json FROM website_widgets WHERE id = ? OR public_key = ?').get(widgetId, widgetId);
    if (!row) return res.status(404).json({ error: 'Widget not found' });
    let domains = [];
    try { domains = JSON.parse(row.allowed_domains_json || '[]'); } catch { /* noop */ }
    // Return canonical internal id so collector can normalise caches/logs.
    res.json({ widget_id: row.id, allowed_domains: Array.isArray(domains) ? domains : [] });
  } catch (err) {
    console.error('allowed-domains lookup:', err);
    res.status(500).json({ error: 'Failed to load allowed domains' });
  }
});

/**
 * POST /internal/widgets/by-public-key/:publicKey/first-seen
 * Sets first_seen_at once when widget.js first loads on a real domain.
 */
widgetsInternalRouter.post('/widgets/by-public-key/:publicKey/first-seen', async (req, res) => {
  try {
    const { publicKey } = req.params;
    const widget = prepare('SELECT id, first_seen_at FROM website_widgets WHERE public_key = ?').get(publicKey);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });
    if (!widget.first_seen_at) {
      prepare('UPDATE website_widgets SET first_seen_at = datetime(\'now\') WHERE id = ?').run(widget.id);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Error setting first_seen_at:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

/**
 * QCX-3.2 — POST /internal/widgets/:widgetId/visitors/upsert
 * Collector calls this from /events/visitor-identified (with attrs) and
 * /message (bump last_seen + increment conversation_count). Upserts by
 * (widget_id, visitor_id). Merges identified_attrs under the allowlist
 * so random / malicious attrs are dropped at the persistence boundary.
 *
 * Body:
 *   { visitor_id: string,
 *     attrs?: object,           // identify-attrs to merge
 *     bump_conversation?: bool, // true on /message, false on identify-only
 *     verified?: bool,          // QCL-IDENTITY P1: collector HMAC-verified this call
 *     external_user_id?: string // QCL-IDENTITY P1: customer's stable id for the visitor }
 *
 * Returns the persisted visitor row + a `summary` preamble string the
 * collector can inject into the LLM system prompt.
 *
 * QCL-IDENTITY P1: `verified` is monotonic within a visitor's history —
 * once a valid HMAC has verified this visitor, later calls that carry no
 * hash (e.g. the plain /message bump_conversation call) never silently
 * downgrade it back to self-declared. Only an already-verified row or an
 * explicit verified:true this call sets it true.
 */
widgetsInternalRouter.post('/widgets/:widgetId/visitors/upsert', (req, res) => {
  try {
    const { widgetId } = req.params;
    // CW-SEC-1: accept id or public_key.
    const widget = prepare('SELECT id, org_id FROM website_widgets WHERE id = ? OR public_key = ?').get(widgetId, widgetId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });

    const { visitor_id, attrs, bump_conversation, verified, external_user_id, source } = req.body || {};
    if (!visitor_id || typeof visitor_id !== 'string') return res.status(400).json({ error: 'visitor_id required' });

    const existing = prepare('SELECT visitor_id, first_seen, last_seen, conversation_count, identified_attrs_json, external_user_id, verified FROM widget_visitors WHERE widget_id = ? AND visitor_id = ?').get(widget.id, visitor_id);

    let existingAttrs = {};
    if (existing?.identified_attrs_json) {
      try { existingAttrs = JSON.parse(existing.identified_attrs_json); } catch { /* noop */ }
    }

    // QUOXCHAT-EMAIL D2 — email provenance, computed HERE and only here.
    // The transcript recipient-trust matrix needs to know how the email
    // arrived: 'identify' (this call carries a verified HMAC identity),
    // 'chat' (the collector's executors captured it from the conversation,
    // body.source === 'chat'), 'declared' (identify() without a hash).
    // A caller-supplied attrs.email_source is stripped so neither the
    // collector nor a prompt-injected LLM can claim identify provenance
    // for a typed address. Provenance follows the CURRENT email: a chat
    // overwrite of an identify-sourced email downgrades to 'chat' even
    // though the visitor's verified flag stays monotonically true.
    let incomingAttrs = attrs;
    if (incomingAttrs && typeof incomingAttrs === 'object' && !Array.isArray(incomingAttrs)) {
      incomingAttrs = { ...incomingAttrs };
      delete incomingAttrs.email_source;
      if (typeof incomingAttrs.email === 'string' && incomingAttrs.email.trim()) {
        const sameEmail = typeof existingAttrs.email === 'string'
          && existingAttrs.email.trim().toLowerCase() === incomingAttrs.email.trim().toLowerCase();
        if (verified === true) {
          incomingAttrs.email_source = 'identify';
        } else if (sameEmail && existingAttrs.email_source === 'identify') {
          // Same address re-mentioned via a weaker channel: keep the
          // stronger provenance. Only a DIFFERENT email downgrades.
          incomingAttrs.email_source = 'identify';
        } else {
          incomingAttrs.email_source = source === 'chat' ? 'chat' : 'declared';
        }
      }
    }
    const mergedAttrs = mergeIdentifiedAttrs(existingAttrs, incomingAttrs);

    let newCount = existing?.conversation_count || 0;
    if (bump_conversation) newCount += 1;

    const wasVerified = !!existing?.verified;
    const newVerified = (wasVerified || !!verified) ? 1 : 0;
    const newExternalUserId = (typeof external_user_id === 'string' && external_user_id) ? external_user_id : (existing?.external_user_id || null);

    // QCX-ACTIONS P2 — per-visitor monthly action-quota override. Accepted
    // ONLY when THIS call carries a verified identity (verified === true,
    // i.e. the collector validated user_hash in the same payload) — an
    // unverified identify() can never grant itself a bigger quota. A
    // non-negative integer sets it; anything else leaves it untouched.
    // QCL-IDENTITY P2: the v1 hash covers user_id only, so `verified` alone
    // never licenses a limit. The collector must also mark the allowance as
    // signed-verified (limit_attrs_signed === true).
    const { action_quota_override, limit_attrs_signed } = req.body || {};
    const applyQuotaOverride = verified === true
      && limit_attrs_signed === true
      && Number.isInteger(action_quota_override)
      && action_quota_override >= 0;

    if (existing) {
      prepare(`
        UPDATE widget_visitors
        SET last_seen = datetime('now'),
            conversation_count = ?,
            identified_attrs_json = ?,
            external_user_id = ?,
            verified = ?,
            action_quota_override = CASE WHEN ? THEN ? ELSE action_quota_override END,
            updated_at = datetime('now')
        WHERE widget_id = ? AND visitor_id = ?
      `).run(newCount, JSON.stringify(mergedAttrs), newExternalUserId, newVerified,
             applyQuotaOverride ? 1 : 0, applyQuotaOverride ? action_quota_override : null,
             widget.id, visitor_id);
    } else {
      prepare(`
        INSERT INTO widget_visitors (visitor_id, widget_id, org_id, first_seen, last_seen, conversation_count, identified_attrs_json, external_user_id, verified, action_quota_override)
        VALUES (?, ?, ?, datetime('now'), datetime('now'), ?, ?, ?, ?, ?)
      `).run(visitor_id, widget.id, widget.org_id, newCount, JSON.stringify(mergedAttrs), newExternalUserId, newVerified,
             applyQuotaOverride ? action_quota_override : null);
    }

    const row = prepare('SELECT visitor_id, first_seen, last_seen, conversation_count, identified_attrs_json, external_user_id, verified, action_quota_override FROM widget_visitors WHERE widget_id = ? AND visitor_id = ?').get(widget.id, visitor_id);
    const record = {
      visitor_id: row.visitor_id,
      first_seen: row.first_seen,
      last_seen: row.last_seen,
      conversation_count: row.conversation_count,
      identified_attrs: (() => { try { return JSON.parse(row.identified_attrs_json); } catch { return {}; } })(),
      external_user_id: row.external_user_id || null,
      verified: !!row.verified,
      action_quota_override: Number.isInteger(row.action_quota_override) ? row.action_quota_override : null,
    };
    res.json({ visitor: record, summary: summariseVisitor(record) });
  } catch (err) {
    console.error('visitor upsert:', err);
    res.status(500).json({ error: 'Failed to upsert visitor' });
  }
});

// ── QCX-ACTIONS P2 — per-(widget, visitor, month) action metering ──────────
// The collector's tool executor consults + bumps these around every gated
// tool execution when the widget has an action quota configured. Month is
// UTC 'YYYY-MM'; rows are created lazily on first increment.

const actionUsageMonth = () => new Date().toISOString().slice(0, 7);

function lookupWidgetForActionUsage(widgetId) {
  return prepare('SELECT id, org_id FROM website_widgets WHERE id = ? OR public_key = ?').get(widgetId, widgetId);
}

widgetsInternalRouter.get('/widgets/:widgetId/visitors/:visitorId/action-usage', (req, res) => {
  try {
    const widget = lookupWidgetForActionUsage(req.params.widgetId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });
    const visitorId = String(req.params.visitorId || '');
    if (!visitorId) return res.status(400).json({ error: 'visitor_id required' });
    const month = actionUsageMonth();
    const usage = prepare('SELECT tool_calls, side_effect_calls FROM widget_visitor_usage_monthly WHERE widget_id = ? AND visitor_id = ? AND month = ?')
      .get(widget.id, visitorId, month);
    const visitor = prepare('SELECT action_quota_override FROM widget_visitors WHERE widget_id = ? AND visitor_id = ?')
      .get(widget.id, visitorId);
    res.json({
      month,
      tool_calls: usage?.tool_calls || 0,
      side_effect_calls: usage?.side_effect_calls || 0,
      action_quota_override: Number.isInteger(visitor?.action_quota_override) ? visitor.action_quota_override : null,
    });
  } catch (err) {
    console.error('action-usage get:', err);
    res.status(500).json({ error: 'Failed to read action usage' });
  }
});

widgetsInternalRouter.post('/widgets/:widgetId/visitors/:visitorId/action-usage/increment', (req, res) => {
  try {
    const widget = lookupWidgetForActionUsage(req.params.widgetId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });
    const visitorId = String(req.params.visitorId || '');
    if (!visitorId) return res.status(400).json({ error: 'visitor_id required' });
    const sideEffecting = req.body?.side_effecting === true;
    const month = actionUsageMonth();
    prepare(`INSERT INTO widget_visitor_usage_monthly (widget_id, visitor_id, month, tool_calls, side_effect_calls)
             VALUES (?, ?, ?, 0, 0)
             ON CONFLICT(widget_id, visitor_id, month) DO NOTHING`).run(widget.id, visitorId, month);
    prepare(`UPDATE widget_visitor_usage_monthly
             SET tool_calls = tool_calls + 1,
                 side_effect_calls = side_effect_calls + ?,
                 updated_at = datetime('now')
             WHERE widget_id = ? AND visitor_id = ? AND month = ?`)
      .run(sideEffecting ? 1 : 0, widget.id, visitorId, month);
    const usage = prepare('SELECT tool_calls, side_effect_calls FROM widget_visitor_usage_monthly WHERE widget_id = ? AND visitor_id = ? AND month = ?')
      .get(widget.id, visitorId, month);
    res.json({ month, tool_calls: usage.tool_calls, side_effect_calls: usage.side_effect_calls });
  } catch (err) {
    console.error('action-usage increment:', err);
    res.status(500).json({ error: 'Failed to increment action usage' });
  }
});

/**
 * QCX-3.3 — GET /internal/orgs/:orgId/widgets
 * Service-key guarded listing used by the MCP bridge so a developer on
 * Claude Desktop can enumerate widgets in their org without a user JWT.
 */
widgetsInternalRouter.get('/orgs/:orgId/widgets', (req, res) => {
  try {
    const { orgId } = req.params;
    // QC-PROOF: conversation/message totals (test/sim visitors excluded, same as
    // analytics) so "how many conversations has widget X had" is one call.
    const notTest = NOT_TEST_CONV_SQL.replace(/visitor_id/g, 'c.visitor_id');
    const rows = prepare(`
      SELECT w.id, w.public_key, w.name, w.status, w.deployment_type, w.operator_online,
             w.first_seen_at, w.created_at, w.updated_at,
             (SELECT COUNT(*) FROM widget_conversations c
                WHERE c.widget_id = w.id AND ${notTest}) AS total_conversations,
             (SELECT COUNT(*) FROM widget_messages m JOIN widget_conversations c ON c.id = m.conversation_id
                WHERE m.widget_id = w.id AND ${notTest}) AS total_messages,
             (SELECT MAX(c.last_message_at) FROM widget_conversations c
                WHERE c.widget_id = w.id AND ${notTest}) AS last_conversation_at
      FROM website_widgets w
      WHERE w.org_id = ?
      ORDER BY w.created_at DESC
      LIMIT 200
    `).all(orgId);
    res.json({ org_id: orgId, widgets: rows, count: rows.length });
  } catch (err) {
    console.error('internal list widgets:', err);
    res.status(500).json({ error: 'Failed to list widgets' });
  }
});

/**
 * QC-PROOF: GET /internal/orgs/:orgId/widgets/:widgetId/conversations
 * Org-scoped read for the quoxchat_list_conversations agent tool. The widget
 * must belong to :orgId (404 otherwise). Query: status?, limit? (1-50, def 20).
 */
widgetsInternalRouter.get('/orgs/:orgId/widgets/:widgetId/conversations', (req, res) => {
  try {
    const { orgId, widgetId } = req.params;
    const widget = prepare('SELECT id FROM website_widgets WHERE (id = ? OR public_key = ?) AND org_id = ?').get(widgetId, widgetId, orgId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });
    const status = ['active', 'handed_off', 'closed'].includes(req.query.status) ? req.query.status : null;
    const parsed = parseInt(req.query.limit, 10);
    const limit = Math.min(50, Math.max(1, Number.isFinite(parsed) ? parsed : 20));
    const where = 'widget_id = ? AND ' + NOT_TEST_CONV_SQL + (status ? ' AND status = ?' : '');
    const params = status ? [widget.id, status] : [widget.id];
    const total = prepare(`SELECT COUNT(*) AS n FROM widget_conversations WHERE ${where}`).get(...params).n;
    const rows = prepare(`
      SELECT id, status, started_at, last_message_at, message_count, visitor_id, visitor_name
      FROM widget_conversations WHERE ${where}
      ORDER BY last_message_at DESC, rowid DESC LIMIT ?
    `).all(...params, limit);
    const conversations = rows.map((c) => ({ ...c, handed_off: c.status === 'handed_off' }));
    res.json({ widget_id: widget.id, total, conversations });
  } catch (err) {
    console.error('internal list conversations:', err);
    res.status(500).json({ error: 'Failed to list conversations' });
  }
});

/**
 * QC-PROOF: GET /internal/orgs/:orgId/widgets/:widgetId/conversations/:conversationId/messages
 * Ordered transcript (max 200 messages) for the quoxchat_get_transcript tool.
 * Org + widget scoped: the conversation must belong to that widget in that org.
 */
widgetsInternalRouter.get('/orgs/:orgId/widgets/:widgetId/conversations/:conversationId/messages', (req, res) => {
  try {
    const { orgId, widgetId, conversationId } = req.params;
    const widget = prepare('SELECT id FROM website_widgets WHERE (id = ? OR public_key = ?) AND org_id = ?').get(widgetId, widgetId, orgId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });
    const conv = prepare('SELECT id, status, started_at, last_message_at, message_count FROM widget_conversations WHERE id = ? AND widget_id = ?').get(conversationId, widget.id);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    const messages = prepare(`
      SELECT role, content, created_at FROM widget_messages
      WHERE conversation_id = ? AND widget_id = ?
      ORDER BY created_at ASC, rowid ASC LIMIT 200
    `).all(conv.id, widget.id);
    res.json({ conversation: conv, messages, truncated: messages.length === 200 && (conv.message_count || 0) > 200 });
  } catch (err) {
    console.error('internal conversation messages:', err);
    res.status(500).json({ error: 'Failed to load transcript' });
  }
});

/**
 * QCX-3.2 — GET /internal/widgets/:widgetId/visitors/:visitorId
 * Read-only fetch of the visitor memory record + summary.
 */
widgetsInternalRouter.get('/widgets/:widgetId/visitors/:visitorId', (req, res) => {
  try {
    const { widgetId, visitorId } = req.params;
    const widget = prepare('SELECT id FROM website_widgets WHERE id = ? OR public_key = ?').get(widgetId, widgetId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });
    const row = prepare('SELECT visitor_id, first_seen, last_seen, conversation_count, identified_attrs_json, external_user_id, verified FROM widget_visitors WHERE widget_id = ? AND visitor_id = ?').get(widget.id, visitorId);
    if (!row) return res.status(404).json({ error: 'Visitor not found' });
    const record = {
      visitor_id: row.visitor_id,
      first_seen: row.first_seen,
      last_seen: row.last_seen,
      conversation_count: row.conversation_count,
      identified_attrs: (() => { try { return JSON.parse(row.identified_attrs_json); } catch { return {}; } })(),
      external_user_id: row.external_user_id || null,
      verified: !!row.verified,
    };
    res.json({ visitor: record, summary: summariseVisitor(record) });
  } catch (err) {
    console.error('visitor get:', err);
    res.status(500).json({ error: 'Failed to load visitor' });
  }
});

/**
 * GET /internal/widgets/:widgetId/visitors/:visitorId/recent-messages?limit=10
 * QC-BRUTALOOP: the collector rebuilds LLM history from PERSISTED turns
 * instead of trusting browser-supplied conversation_history (a forged
 * assistant turn planted a fake promotion). Returns the last `limit` (cap 20)
 * user/assistant messages of the visitor's active conversation (same window
 * persist-message/ensure-conversation reuse: status 'active', last message
 * within 1 hour), oldest-first.
 */
widgetsInternalRouter.get('/widgets/:widgetId/visitors/:visitorId/recent-messages', (req, res) => {
  try {
    const { widgetId, visitorId } = req.params;
    const widget = prepare('SELECT id FROM website_widgets WHERE id = ? OR public_key = ?').get(widgetId, widgetId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });
    if (!visitorId) return res.status(400).json({ error: 'visitor_id required' });
    const parsed = parseInt(req.query.limit, 10);
    const limit = Math.min(20, Math.max(1, Number.isFinite(parsed) ? parsed : 10));
    const conv = prepare(`
      SELECT id FROM widget_conversations
      WHERE widget_id = ? AND visitor_id = ? AND status = 'active'
        AND datetime(last_message_at) > datetime('now','-1 hour')
      ORDER BY last_message_at DESC LIMIT 1
    `).get(widget.id, visitorId);
    if (!conv) return res.json({ conversation_id: null, messages: [], actions: [] });
    const rows = prepare(`
      SELECT role, content, created_at FROM widget_messages
      WHERE conversation_id = ? AND widget_id = ? AND role IN ('user','assistant')
      ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(conv.id, widget.id, limit).reverse();
    // Action ledger (QuoxChat): compact outcome of every tool call in this
    // conversation, oldest first, so a later turn can be told what the
    // server actually DID. Deliberately excludes tool inputs (raw emails).
    const actions = [];
    try {
      const toolRows = prepare(`
        SELECT tool_calls_json FROM widget_messages
        WHERE conversation_id = ? AND widget_id = ? AND tool_calls_json IS NOT NULL
        ORDER BY created_at ASC, rowid ASC LIMIT 100
      `).all(conv.id, widget.id);
      for (const tr of toolRows) {
        let calls;
        try { calls = JSON.parse(tr.tool_calls_json); } catch { continue; }
        if (!Array.isArray(calls)) continue;
        for (const c of calls) {
          if (!c || typeof c.name !== 'string') continue;
          actions.push({
            name: c.name.slice(0, 60),
            ok: c.ok === true,
            ts: typeof c.ts === 'string' ? c.ts : null,
            reference: typeof c.reference === 'string' ? c.reference.slice(0, 40) : null,
            preferred_time: typeof c.preferred_time === 'string' ? c.preferred_time.slice(0, 120) : null,
            duplicate: c.duplicate === true,
          });
        }
      }
    } catch (e) {
      console.error('recent-messages actions:', e.message);
    }
    res.json({ conversation_id: conv.id, messages: rows, actions: actions.slice(-50) });
  } catch (err) {
    console.error('recent-messages get:', err);
    res.status(500).json({ error: 'Failed to load recent messages' });
  }
});

/**
 * QCX-7b / QCL-BACKEND-UX #131 — shared usage-bucket + entitlement-cap
 * computation. Both the internal (collector-facing) and org-scoped
 * (dashboard-facing) /usage/current endpoints call this so the two
 * response shapes cannot drift apart — the internal endpoint gates the
 * live /message hot path, so any divergence here is a real risk.
 *
 * `widget` must be a row with at least { id, org_id, embed_config_json }.
 */
// Which key answered: 'org' = a key resolved from the org's vault / setup store;
// 'instance_env' = the host's environment fallback; 'widget_endpoint' = the
// widget's own OpenAI-compatible endpoint. Anything else is stored as 'unknown'.
const KEY_SOURCES = ['org', 'instance_env', 'widget_endpoint'];
const BUDGET_ACTIONS = ['hide', 'unavailable', 'downgrade', 'message', 'continue'];

function computeWidgetUsagePayload(widget) {
  const org = prepare('SELECT plan FROM orgs WHERE id = ?').get(widget.org_id);
  const effectivePlan = resolveWidgetPlan(getDb(), widget.org_id, org?.plan);
  const ent = getEntitlements(effectivePlan);
  const month = new Date().toISOString().slice(0, 7);
  const usage = prepare(`
    SELECT conversations, messages, tool_calls, llm_cost_micro_usd, last_key_source
      FROM widget_usage_monthly
     WHERE widget_id = ? AND month = ?
  `).get(widget.id, month) || { conversations: 0, messages: 0, tool_calls: 0 };

  const conversationsCap = ent.conversations_per_month_cap;
  const remaining = conversationsCap === -1 ? -1 : Math.max(0, conversationsCap - usage.conversations);

  // QCL-SECURITY P1-1 — optional widget-configured LLM budget. Lives in
  // embed_config_json.llm_budget (no schema migration needed — the column
  // already exists and defaults to '{}'). SAFE DEFAULT: absent for every
  // widget until an admin explicitly sets it, so `caps.monthly_requests`
  // stays null and `exceeded.monthly_requests` stays false — the collector
  // gate this feeds (services/collector/routes/quoxchat.js QCX-7b) is a
  // guaranteed no-op until then. "requests" reuses the already-tracked
  // `messages` counter (2 rows persisted per turn: user + assistant) — no
  // new tracking/columns required. Token-level budgets are NOT implemented
  // here: nothing in the schema tracks a monthly token total today, and
  // wiring that would mean touching the persist-message hot path used by
  // every widget (including the live one) — out of scope for this pass.
  let llmBudget = null;
  try {
    const cfg = widget.embed_config_json ? JSON.parse(widget.embed_config_json) : null;
    if (cfg?.llm_budget && typeof cfg.llm_budget === 'object') llmBudget = cfg.llm_budget;
  } catch { /* malformed config — treat as unconfigured */ }

  const budgetRow = prepare('SELECT monthly_budget_cents, budget_action FROM website_widgets WHERE id = ?').get(widget.id) || {};
  const budgetCents = Number.isFinite(budgetRow.monthly_budget_cents) && budgetRow.monthly_budget_cents > 0
    ? budgetRow.monthly_budget_cents : null;
  const spentMicro = usage.llm_cost_micro_usd || 0;
  const requestCap = (Number.isFinite(llmBudget?.monthly_request_cap) && llmBudget.monthly_request_cap > 0)
    ? llmBudget.monthly_request_cap
    : null;
  const requests = Math.floor((usage.messages || 0) / 2);
  const requestExceeded = requestCap !== null && requests >= requestCap;
  const visitorDailyRequestCap = (Number.isFinite(llmBudget?.visitor_daily_request_cap) && llmBudget.visitor_daily_request_cap > 0)
    ? llmBudget.visitor_daily_request_cap
    : null;

  return {
    widget_id: widget.id,
    plan: effectivePlan,
    month,
    conversations: usage.conversations,
    messages: usage.messages,
    tool_calls: usage.tool_calls,
    requests,
    caps: {
      conversations: conversationsCap,
      tool_calls_per_day: ent.tool_calls_per_day_cap,
      monthly_requests: requestCap,
    },
    remaining: {
      conversations: remaining,
      monthly_requests: requestCap === null ? -1 : Math.max(0, requestCap - requests),
    },
    exceeded: {
      conversations: conversationsCap !== -1 && usage.conversations >= conversationsCap,
      monthly_requests: requestExceeded,
    },
    visitor_daily_request_cap: visitorDailyRequestCap,
    // P7: monthly LLM spend budget (monthly_budget_cents). Spend is estimated
    // from token counts x the collector's price table, so treat it as an
    // estimate. null budget = no cap, nothing exceeded.
    budget: {
      monthly_budget_cents: budgetCents,
      action: BUDGET_ACTIONS.includes(budgetRow.budget_action) ? budgetRow.budget_action : 'downgrade',
      spent_micro_usd: spentMicro,
      spent_cents: Math.floor(spentMicro / 10000),
      exceeded: budgetCents !== null && spentMicro >= budgetCents * 10000,
    },
    // Key that answered the most recent message this month (null until one has).
    llm_key_source: usage.last_key_source || null,
    // Professional-only features, resolved from the same licence-aware plan.
    // The collector reads smart_routing here to decide whether to tier models.
    features: {
      smart_routing: ent.smart_routing_enabled === true,
      simulation_arena: ent.simulation_arena_enabled === true,
      connector_framework: ent.connector_framework_enabled === true,
    },
  };
}

/**
 * QCX-7b — GET /internal/widgets/:widgetId/usage/current
 *
 * Returns the current calendar-month usage bucket + entitlement caps so
 * the collector can enforce quota cheaply on every /message turn (one
 * read per turn; cheap composite-PK lookup).
 */
widgetsInternalRouter.get('/widgets/:widgetId/usage/current', (req, res) => {
  try {
    const { widgetId } = req.params;
    const widget = prepare(
      'SELECT id, org_id, embed_config_json FROM website_widgets WHERE id = ? OR public_key = ?',
    ).get(widgetId, widgetId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });

    res.json(computeWidgetUsagePayload(widget));
  } catch (err) {
    console.error('Error reading usage:', err);
    res.status(500).json({ error: 'Failed to read usage' });
  }
});

/**
 * QCX-6a — GET /internal/widgets/:widgetId/visitors/:visitorId/export
 *
 * GDPR Article 15 — right of access. Returns the full conversation history
 * + messages + tool calls + token counts + sources for a (widget, visitor)
 * tuple. Strictly scoped: only rows where widget_id matches AND visitor_id
 * matches. Older messages without context_json simply have null token
 * fields.
 *
 * Visitor calls this via the public collector route which proxies here.
 * The collector enforces rate limiting + domain checks + VOLT-witnesses
 * the request; this endpoint is the read-side.
 */
widgetsInternalRouter.get('/widgets/:widgetId/visitors/:visitorId/export', (req, res) => {
  try {
    const { widgetId, visitorId } = req.params;
    const widget = prepare(
      'SELECT id, name, public_key, org_id FROM website_widgets WHERE id = ? OR public_key = ?',
    ).get(widgetId, widgetId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });

    // Proof of possession: a conversation id owned by this widget + visitor.
    const proofConv = typeof req.query.conversation_id === 'string' ? req.query.conversation_id.trim() : '';
    const owned = proofConv && prepare(
      'SELECT id FROM widget_conversations WHERE id = ? AND widget_id = ? AND visitor_id = ?',
    ).get(proofConv, widget.id, visitorId);
    if (!owned) return res.status(403).json({ error: 'conversation_id owned by this visitor is required' });

    const conversations = prepare(`
      SELECT id, status, started_at, last_message_at, message_count,
             visitor_rating, resolution, correlation_id, page_url, visitor_metadata_json
        FROM widget_conversations
       WHERE widget_id = ? AND visitor_id = ?
       ORDER BY started_at ASC
    `).all(widget.id, visitorId);

    const conversationIds = conversations.map(c => c.id);
    let messages = [];
    if (conversationIds.length > 0) {
      const placeholders = conversationIds.map(() => '?').join(',');
      const rows = prepare(`
        SELECT id, conversation_id, widget_id, role, content,
               sources_json, tool_calls_json, confidence,
               envelope_id, injection_score, filtered, context_json,
               created_at
          FROM widget_messages
         WHERE widget_id = ? AND conversation_id IN (${placeholders})
         ORDER BY created_at ASC
      `).all(widget.id, ...conversationIds);
      messages = rows.map(r => {
        const ctx = r.context_json ? safeJsonParse(r.context_json, null) : null;
        return {
          id: r.id,
          conversation_id: r.conversation_id,
          role: r.role,
          content: r.content,
          sources: safeJsonParse(r.sources_json, []),
          tool_calls: safeJsonParse(r.tool_calls_json, []),
          confidence: r.confidence,
          envelope_id: r.envelope_id,
          injection_score: r.injection_score,
          filtered: !!r.filtered,
          input_tokens: ctx && typeof ctx.input_tokens === 'number' ? ctx.input_tokens : null,
          output_tokens: ctx && typeof ctx.output_tokens === 'number' ? ctx.output_tokens : null,
          created_at: r.created_at,
        };
      });
    }

    createAuditEvent({
      orgId: widget.org_id,
      actorType: 'visitor',
      actorId: visitorId,
      action: 'widget.gdpr.export',
      targetType: 'widget',
      targetId: widget.id,
      metadata: { conversations: conversations.length, messages: messages.length },
    });

    res.json({
      visitor_id: visitorId,
      widget_id: widget.id,
      widget_name: widget.name,
      widget_public_key: widget.public_key,
      exported_at: new Date().toISOString(),
      conversations: conversations.map(c => ({
        ...c,
        visitor_metadata: safeJsonParse(c.visitor_metadata_json, {}),
        visitor_metadata_json: undefined,
      })),
      messages,
      counts: {
        conversations: conversations.length,
        messages: messages.length,
      },
      legal_basis: 'GDPR Article 15 — right of access by the data subject',
    });
  } catch (err) {
    console.error('Error exporting visitor data:', err);
    res.status(500).json({ error: 'Failed to export visitor data' });
  }
});

/**
 * Shared GDPR erase transaction: removes one visitor's messages, leads,
 * conversations and visitor-memory row for one widget. Used by the visitor
 * self-erase route (proof of possession) and the org-admin erase route.
 * Idempotent: a visitor with no data returns all-zero counts.
 */
function eraseVisitorRows(widgetId, visitorId) {
  let messagesDeleted = 0;
  let conversationsDeleted = 0;
  let visitorDeleted = 0;
  let leadsDeleted = 0;

  const db = getDb();
  db.transaction(() => {
    // Step 1 — delete messages first (FK from widget_messages.conversation_id).
    // Using a sub-select to bound by both widget_id and visitor_id to
    // prevent any chance of cross-widget collateral.
    const msgResult = prepare(`
      DELETE FROM widget_messages
       WHERE widget_id = ?
         AND conversation_id IN (
           SELECT id FROM widget_conversations
            WHERE widget_id = ? AND visitor_id = ?
         )
    `).run(widgetId, widgetId, visitorId);
    messagesDeleted = msgResult.changes;

    // Step 1b — the visitor's captured leads (personal data) go too, matched
    // by visitor id or by one of their conversations. Older DBs may lack it.
    try {
      leadsDeleted = prepare(`
        DELETE FROM widget_leads
         WHERE widget_id = ?
           AND (visitor_id = ? OR conversation_id IN (
             SELECT id FROM widget_conversations WHERE widget_id = ? AND visitor_id = ?))
      `).run(widgetId, visitorId, widgetId, visitorId).changes;
    } catch { leadsDeleted = 0; }

    // Step 2 — delete the conversations themselves.
    const convResult = prepare(
      `DELETE FROM widget_conversations WHERE widget_id = ? AND visitor_id = ?`,
    ).run(widgetId, visitorId);
    conversationsDeleted = convResult.changes;

    // Step 3 — drop the visitor memory record.
    try {
      const visResult = prepare(
        `DELETE FROM widget_visitors WHERE widget_id = ? AND visitor_id = ?`,
      ).run(widgetId, visitorId);
      visitorDeleted = visResult.changes;
    } catch {
      // Older DBs may lack widget_visitors table; treat as zero.
      visitorDeleted = 0;
    }
  })();
  return { messagesDeleted, conversationsDeleted, visitorDeleted, leadsDeleted };
}

/**
 * QCX-6b — DELETE /internal/widgets/:widgetId/visitors/:visitorId
 *
 * GDPR Article 17 — right to erasure. Cascades the visitor's data:
 *   widget_messages  (via conversation_id IN ...)
 *   widget_conversations
 *   widget_visitors
 *
 * Single transaction so a partial erasure cannot leave orphans. Idempotent:
 * a visitor with no data returns 200 with all-zero counts. A widget.gdpr.erase
 * audit event is created — the act of erasure is itself logged (with PII
 * already cleansed from the rows we're about to drop).
 *
 * Out of scope here (handled in later 6-series sub-phases): AEE envelope
 * tombstoning + Qdrant point cleanup. Visitor messages don't live in Qdrant
 * (only knowledge sources do); envelopes are append-only and require the
 * tombstone path from QCX-2.
 */
widgetsInternalRouter.delete('/widgets/:widgetId/visitors/:visitorId', (req, res) => {
  try {
    const { widgetId, visitorId } = req.params;
    const widget = prepare(
      'SELECT id, org_id FROM website_widgets WHERE id = ? OR public_key = ?',
    ).get(widgetId, widgetId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });

    // Proof of possession: visitor ids are client-chosen, so the caller must
    // also present a conversation id that belongs to this widget AND visitor.
    const proofConv = typeof req.query.conversation_id === 'string' ? req.query.conversation_id.trim() : '';
    const owned = proofConv && prepare(
      'SELECT id FROM widget_conversations WHERE id = ? AND widget_id = ? AND visitor_id = ?',
    ).get(proofConv, widget.id, visitorId);
    if (!owned) return res.status(403).json({ error: 'conversation_id owned by this visitor is required' });

    const { messagesDeleted, conversationsDeleted, visitorDeleted, leadsDeleted } = eraseVisitorRows(widget.id, visitorId);

    createAuditEvent({
      orgId: widget.org_id,
      actorType: 'visitor',
      actorId: visitorId,
      action: 'widget.gdpr.erase',
      targetType: 'widget',
      targetId: widget.id,
      metadata: {
        deleted: { messages: messagesDeleted, conversations: conversationsDeleted, visitor: visitorDeleted, leads: leadsDeleted },
      },
    });

    res.json({
      ok: true,
      deleted: {
        messages: messagesDeleted,
        conversations: conversationsDeleted,
        visitor: visitorDeleted,
        leads: leadsDeleted,
      },
      legal_basis: 'GDPR Article 17 — right to erasure',
    });
  } catch (err) {
    console.error('Error erasing visitor data:', err);
    res.status(500).json({ error: 'Failed to erase visitor data' });
  }
});

router.use(requireAuth);

/**
 * GET /orgs/:orgId/widgets
 * List widgets for an org
 */
router.get('/orgs/:orgId/widgets', requireOrgMembership, async (req, res) => {
  try {
    const { orgId } = req.params;
    const { status, search } = req.query;
    const pagination = getPagination(req.query);

    let where = 'WHERE w.org_id = ?';
    const params = [orgId];

    if (status) { where += ' AND w.status = ?'; params.push(status); }
    if (search) { where += ' AND (w.name LIKE ? OR w.public_key LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }

    const countRow = prepare(`SELECT COUNT(*) as total FROM website_widgets w ${where}`).get(...params);
    params.push(pagination.limit, pagination.offset);

    const widgets = prepare(`
      SELECT w.*, a.name as assistant_name, a.persona_json,
        (SELECT COUNT(*) FROM widget_conversations wc
          WHERE wc.widget_id = w.id AND NOT ${TEST_VISITOR_SQL('wc.')}) AS conversation_count,
        (SELECT COUNT(*) FROM widget_leads wl WHERE wl.widget_id = w.id AND wl.notification_failed = 1)
          + (SELECT COUNT(*) FROM widget_conversations wf WHERE wf.widget_id = w.id AND wf.notification_failed = 1) AS notification_failed_count,
        ${DEGRADED_COUNT_SQL} AS retrieval_degraded_count,
        ${DEGRADED_LAST_SQL} AS retrieval_degraded_last_json
      FROM website_widgets w
      LEFT JOIN assistants a ON w.assistant_id = a.id
      ${where}
      ORDER BY w.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params);

    res.json(formatPaginatedResponse(widgets.map(w => redactWidgetSecrets({
      ...withDegraded(w),
      allowed_domains: JSON.parse(w.allowed_domains_json || '[]'),
      embed_config: JSON.parse(w.embed_config_json || '{}'),
      persona: JSON.parse(w.persona_json || '{}'),
      usage_this_month: JSON.parse(w.usage_this_month_json || '{}'),
    })), countRow.total, pagination));
  } catch (err) {
    console.error('Error listing widgets:', err);
    res.status(500).json({ error: 'Failed to list widgets' });
  }
});

/**
 * GET /orgs/:orgId/widgets/:widgetId
 * Get a single widget
 */
router.get('/orgs/:orgId/widgets/:widgetId', requireOrgMembership, async (req, res) => {
  try {
    const { orgId, widgetId } = req.params;

    const widget = prepare(`
      SELECT w.*, a.name as assistant_name, a.persona_json,
        (SELECT COUNT(*) FROM widget_leads wl WHERE wl.widget_id = w.id AND wl.notification_failed = 1)
          + (SELECT COUNT(*) FROM widget_conversations wf WHERE wf.widget_id = w.id AND wf.notification_failed = 1) AS notification_failed_count,
        ${DEGRADED_COUNT_SQL} AS retrieval_degraded_count,
        ${DEGRADED_LAST_SQL} AS retrieval_degraded_last_json
      FROM website_widgets w
      LEFT JOIN assistants a ON w.assistant_id = a.id
      WHERE w.id = ? AND w.org_id = ?
    `).get(widgetId, orgId);

    if (!widget) return res.status(404).json({ error: 'Widget not found' });

    res.json({
      widget: redactWidgetSecrets({
        ...withDegraded(widget),
        allowed_domains: JSON.parse(widget.allowed_domains_json || '[]'),
        embed_config: JSON.parse(widget.embed_config_json || '{}'),
        persona: JSON.parse(widget.persona_json || '{}'),
        usage_this_month: JSON.parse(widget.usage_this_month_json || '{}'),
      })
    });
  } catch (err) {
    console.error('Error getting widget:', err);
    res.status(500).json({ error: 'Failed to get widget' });
  }
});

// Wave 12: allowed_domains (array of hostnames) is honoured on create, merged
// with the single `domain`; localhost is always kept.
const CREATE_HOST_RE = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/;
function resolveCreateDomains(domain, list) {
  const out = domain ? [domain] : [];
  if (list !== undefined) {
    if (!Array.isArray(list)) return { error: 'allowed_domains must be an array of hostnames' };
    for (const d of list) {
      const h = typeof d === 'string' ? d.trim().toLowerCase() : '';
      if (!h || h.length > 253 || !CREATE_HOST_RE.test(h)) return { error: `Invalid domain in allowed_domains: ${String(d).slice(0, 60)}` };
      out.push(h);
    }
  }
  return { domains: [...new Set(out.filter((d) => d !== 'localhost')), 'localhost'] };
}

/**
 * POST /orgs/:orgId/widgets
 * Create a new widget (+ backing assistant)
 */
router.post('/orgs/:orgId/widgets', requireOrgMembership, requireQuoxchatEntitlement, async (req, res) => {
  try {
    const { orgId } = req.params;
    const { name, greeting, domain, theme, position } = req.body;
    const userId = req.user.id;

    if (!name?.trim()) return res.status(400).json({ error: 'Name is required' });

    const dom = resolveCreateDomains(domain, req.body.allowed_domains);
    if (dom.error) return res.status(400).json({ error: dom.error });
    const createDomains = dom.domains;

    // QCX-7a — plan-tier quota: enforce widget_count_cap per plan.
    // -1 means unlimited (enterprise); N>0 → 402 with upgrade pointer.
    // LICENSE-LAUNCH LL-6a: this now layers strictly UNDER the licence gate
    // (requireQuoxchatEntitlement, in the route chain above). It answers "how
    // many widgets does this plan allow", never "may this org run QuoxChat" —
    // an org without the quoxchat entitlement never reaches this line, so a
    // generous orgs.plan value can no longer stand in for a licence.
    const org = prepare('SELECT plan FROM orgs WHERE id = ?').get(orgId);
    const effectivePlan = resolveWidgetPlan(getDb(), orgId, org?.plan);
    const entitlements = getEntitlements(effectivePlan);
    if (entitlements.widget_count_cap !== -1) {
      const existing = prepare('SELECT COUNT(*) AS n FROM website_widgets WHERE org_id = ?').get(orgId);
      if ((existing?.n || 0) >= entitlements.widget_count_cap) {
        return res.status(402).json({
          error: 'widget_count_cap_reached',
          message: `Your ${effectivePlan} plan allows up to ${entitlements.widget_count_cap} widget${entitlements.widget_count_cap === 1 ? '' : 's'}. Upgrade to add more.`,
          plan: effectivePlan,
          cap: entitlements.widget_count_cap,
          current: existing?.n || 0,
        });
      }
    }

    const db = getDb();
    const widgetId = ulid();
    const assistantId = ulid();
    const publicKey = `wid_${ulid().slice(0, 12).toLowerCase()}`;
    const slug = slugify(name);

    db.transaction(() => {
      // Create backing assistant
      prepare(`
        INSERT INTO assistants (id, org_id, name, slug, description, persona_json, status, created_by, is_template)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 0)
      `).run(
        assistantId, orgId, name, slug,
        `Chat widget for ${domain || 'website'}`,
        JSON.stringify({
          assistant_type: 'chatbot',
          system_prompt: greeting ? `You are ${name}. ${greeting}` : `You are ${name}, a helpful assistant.`,
          color: '#30ff90',
          shortName: name.slice(0, 2).toUpperCase(),
          role: 'specialist',
          level: 2,
          widget_config: { greeting: greeting || 'Hi! How can I help?', allowed_domains: createDomains, position: position || 'bottom-right', theme: theme || 'auto' },
        }),
        userId
      );

      // QCX-6d — auto-classify the new widget. risk_classification_inputs
      // is optional in the create body; absence → default tier (limited_risk
      // for chat assistants, with Art.52 transparency obligations).
      const classification = classifyWidgetRisk(req.body?.risk_classification_inputs);

      // QCL-IDENTITY P1: every widget gets its own HMAC secret so a host
      // can compute user_hash = HMAC-SHA256(user_id, identity_secret) for
      // verified identify() calls.
      const identitySecret = crypto.randomBytes(32).toString('hex');

      // Create widget record
      prepare(`
        INSERT INTO website_widgets (id, assistant_id, org_id, name, public_key, allowed_domains_json, deployment_type, embed_config_json, qdrant_namespace, status, created_by, risk_tier, risk_classification_json, identity_secret, operator_online, business_name)
        VALUES (?, ?, ?, ?, ?, ?, 'embed', ?, ?, 'draft', ?, ?, ?, ?, 0, ?)
      `).run(
        widgetId, assistantId, orgId, name, publicKey,
        JSON.stringify(createDomains),
        JSON.stringify({
          greeting: greeting || 'Hi! How can I help?', theme: theme || 'auto', position: position || 'bottom-right',
          // QUOXCHAT-EMAIL D4 — the policy switch ships WITH the tool switch.
          // The seeded builtin set marks email_transcript active, but the
          // default-deny side-effect policy needs the tool allow-listed too;
          // seeding one without the other left the marketed transcript action
          // silently dead on every widget ever created.
          tool_policies: DEFAULT_TOOL_POLICIES,
        }),
        `widget_${publicKey}`,
        userId,
        classification.tier,
        JSON.stringify({ ...classification, inputs: req.body?.risk_classification_inputs || {} }),
        identitySecret,
        typeof req.body?.business_name === 'string' ? req.body.business_name.trim().slice(0, 120) : '',
      );

      // QUOXCHAT-PRO — every new widget ships with the builtin tool set
      // (human_handoff/lead_capture/email_transcript/leave_message active;
      // book_appointment/schedule_demo present but disabled). Without these
      // rows the LLM has no tools at all and "speak to a human" gets brushed
      // off (the wid_01kpnyr1afay incident).
      seedDefaultWidgetTools({ widgetId, orgId });
    })();

    createAuditEvent({ orgId, actorType: 'user', actorId: userId, action: 'widget.create', targetType: 'widget', targetId: widgetId, metadata: { name, domain } });

    const widget = prepare('SELECT * FROM website_widgets WHERE id = ?').get(widgetId);

    // W16: localhost is added silently for preview; say so in the response.
    const notes = createDomains.includes('localhost')
      ? ['localhost is allowed for testing; remove it before launch']
      : [];
    res.status(201).json({
      widget: redactWidgetSecrets({
        ...widget,
        allowed_domains: JSON.parse(widget.allowed_domains_json || '[]'),
        embed_config: JSON.parse(widget.embed_config_json || '{}'),
      }),
      notes,
    });
  } catch (err) {
    console.error('Error creating widget:', err);
    res.status(500).json({ error: 'Failed to create widget' });
  }
});

/**
 * PATCH /orgs/:orgId/widgets/:widgetId
 * Update widget settings
 */
/**
 * w6k: deep-merge a PATCHed embed_config over the stored one so tabs that
 * hold a stale copy cannot erase each other's keys. Keys absent from the
 * patch are kept; an explicit null removes; plain objects merge recursively;
 * arrays and scalars replace.
 */
function mergeEmbedConfig(stored, patch) {
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(patch)) return patch;
  const out = isObj(stored) ? { ...stored } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (isObj(v) && isObj(out[k])) out[k] = mergeEmbedConfig(out[k], v);
    else out[k] = isObj(v) ? mergeEmbedConfig({}, v) : v;
  }
  return out;
}

const PATCHABLE_WIDGET_KEYS = new Set([
  'name', 'allowed_domains', 'allowed_domains_json', 'embed_config', 'embed_config_json', 'status',
  'business_name', 'monthly_budget_cents', 'budget_action', 'greeting', 'tested_at', 'theme_customised',
  'first_seen_at', 'system_prompt_override', 'guardrails', 'risk_classification_inputs',
  'retention_days_override', 'captcha_secret', 'notification_settings_json', 'office_hours_json',
  'operator_online', 'change_note', 'llm_key_vault_ref',
]);

router.patch('/orgs/:orgId/widgets/:widgetId', requireOrgMembership, async (req, res) => {
  try {
    const { orgId, widgetId } = req.params;
    const updates = { ...(req.body || {}) };

    // Wave 10: unknown top-level keys are a 400, never a silent 200 no-op.
    const unknownKeys = Object.keys(updates).filter((k) => !PATCHABLE_WIDGET_KEYS.has(k));
    if (unknownKeys.length > 0) {
      return res.status(400).json({ error: `Unknown field(s): ${unknownKeys.join(', ')}`, unknown_fields: unknownKeys });
    }
    // Wave 10: embed_config (object) is an alias of embed_config_json.
    if (updates.embed_config !== undefined) {
      if (!updates.embed_config || typeof updates.embed_config !== 'object' || Array.isArray(updates.embed_config)) {
        return res.status(400).json({ error: 'embed_config must be a JSON object' });
      }
      if (updates.embed_config_json === undefined) updates.embed_config_json = updates.embed_config;
      delete updates.embed_config;
    }

    const widget = prepare('SELECT * FROM website_widgets WHERE id = ? AND org_id = ?').get(widgetId, orgId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });

    // QCX-7c — entitlement gate. Block plan-locked fields (custom_css,
    // BYOK, custom_domain) BEFORE any database writes so the rejection
    // is clean.
    const orgRow = prepare('SELECT plan FROM orgs WHERE id = ?').get(orgId);
    const effectivePlan = resolveWidgetPlan(getDb(), orgId, orgRow?.plan);
    const gate = checkPatchEntitlements(effectivePlan, updates);
    if (!gate.allow) {
      return res.status(402).json({
        error: 'plan_upgrade_required',
        feature: gate.feature,
        message: gate.reason,
        plan: effectivePlan,
      });
    }

    if (updates.monthly_budget_cents !== undefined && updates.monthly_budget_cents !== null
      && !(Number.isInteger(updates.monthly_budget_cents) && updates.monthly_budget_cents >= 0)) {
      return res.status(400).json({ error: 'monthly_budget_cents must be a non-negative integer (or null for no budget)' });
    }
    if (updates.budget_action !== undefined && !BUDGET_ACTIONS.includes(updates.budget_action)) {
      return res.status(400).json({ error: `budget_action must be one of ${BUDGET_ACTIONS.join('|')}` });
    }

    // w6k: merge, never replace (cross-tab stale-copy overwrites), and keep
    // the greeting column and embed_config.greeting (what visitors read) in
    // step so the wizard's greeting reaches them.
    if (updates.embed_config_json || (typeof updates.greeting === 'string' && updates.greeting)) {
      let patchCfg = {};
      if (updates.embed_config_json) {
        try { patchCfg = typeof updates.embed_config_json === 'string' ? JSON.parse(updates.embed_config_json) : updates.embed_config_json; }
        catch { return res.status(400).json({ error: 'embed_config_json must be valid JSON' }); }
        if (!patchCfg || typeof patchCfg !== 'object' || Array.isArray(patchCfg)) {
          return res.status(400).json({ error: 'embed_config_json must be a JSON object' });
        }
      }
      if (typeof updates.greeting === 'string' && updates.greeting && !('greeting' in patchCfg)) patchCfg = { ...patchCfg, greeting: updates.greeting };
      let storedCfg = {};
      try { storedCfg = JSON.parse(widget.embed_config_json || '{}') || {}; } catch { storedCfg = {}; }
      updates.embed_config_json = JSON.stringify(mergeEmbedConfig(storedCfg, patchCfg));
    }

    // llm.allow_private_origin is a standing egress grant: org admin only.
    const pg = checkPrivateEndpointChange({ existingConfigJson: widget.embed_config_json, newConfigJson: updates.embed_config_json, role: req.orgMembership?.role });
    if (!pg.allow) return res.status(403).json({ error: 'insufficient_role', message: pg.reason });

    const fields = [];
    const values = [];

    if (updates.name) { fields.push('name = ?'); values.push(updates.name); }
    if (updates.allowed_domains_json) { fields.push('allowed_domains_json = ?'); values.push(updates.allowed_domains_json); }
    if (Array.isArray(updates.allowed_domains)) { fields.push('allowed_domains_json = ?'); values.push(JSON.stringify(updates.allowed_domains)); }
    if (updates.embed_config_json) { fields.push('embed_config_json = ?'); values.push(updates.embed_config_json); }
    if (updates.status !== undefined) {
      const claimRow = prepare('SELECT 1 AS ok FROM widget_publish_claims WHERE widget_id = ? AND (dev_only = 1 OR security_score >= 70) LIMIT 1').get(widgetId);
      const bad = checkPatchStatus(updates.status, widget.status, Boolean(claimRow));
      if (bad) return res.status(400).json(bad);
      fields.push('status = ?'); values.push(updates.status);
    }
    if (updates.business_name !== undefined) {
      if (typeof updates.business_name !== 'string' || updates.business_name.length > 120) {
        return res.status(400).json({ error: 'business_name must be a string of at most 120 characters' });
      }
      fields.push('business_name = ?'); values.push(updates.business_name.trim());
    }
    if (updates.monthly_budget_cents !== undefined) { fields.push('monthly_budget_cents = ?'); values.push(updates.monthly_budget_cents); }
    if (updates.budget_action !== undefined) { fields.push('budget_action = ?'); values.push(updates.budget_action); }
    // CW-8.9.2 — completion/truth-up fields
    if (updates.greeting !== undefined) { fields.push('greeting = ?'); values.push(updates.greeting); }
    if (updates.tested_at !== undefined) { fields.push('tested_at = ?'); values.push(updates.tested_at); }
    if (updates.theme_customised !== undefined) { fields.push('theme_customised = ?'); values.push(updates.theme_customised ? 1 : 0); }
    if (updates.first_seen_at !== undefined) { fields.push('first_seen_at = ?'); values.push(updates.first_seen_at); }
    if (updates.system_prompt_override !== undefined) { fields.push('system_prompt_override = ?'); values.push(updates.system_prompt_override); }
    if (Array.isArray(updates.guardrails)) { fields.push('guardrails_json = ?'); values.push(JSON.stringify(updates.guardrails)); }
    else if (updates.guardrails && typeof updates.guardrails === 'object') {
      const g = normalizeGuardrails(updates.guardrails);
      if (!g) return res.status(400).json({ error: 'guardrails.always and guardrails.never must be arrays of strings' });
      fields.push('guardrails_json = ?'); values.push(JSON.stringify(g));
    }
    // QCX-6d — re-classify when DPIA wizard inputs change. Tier + reasons
    // both update; existing tier is overwritten so the most-restrictive
    // classification wins on every save.
    if (updates.risk_classification_inputs && typeof updates.risk_classification_inputs === 'object') {
      const cls = classifyWidgetRisk(updates.risk_classification_inputs);
      fields.push('risk_tier = ?'); values.push(cls.tier);
      fields.push('risk_classification_json = ?');
      values.push(JSON.stringify({ ...cls, inputs: updates.risk_classification_inputs }));
    }
    // QCX-6c — retention_days_override. null is allowed (means "org default"),
    // 0 means "no retention enforced". Negative values are rejected as
    // nonsensical and would otherwise leak silently into the cleanup query.
    if (updates.retention_days_override !== undefined) {
      const v = updates.retention_days_override;
      if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 0)) {
        return res.status(400).json({ error: 'retention_days_override must be a non-negative integer or null' });
      }
      fields.push('retention_days_override = ?');
      values.push(v);
    }
    if (typeof updates.captcha_secret === 'string' || updates.captcha_secret === null) { // CAPTCHA #127
      // QUOXCHAT-EMAIL P2 — encrypted at rest. The completeness backstop
      // (encryptedStores.js) greps ciphertext-ish column NAMES only, so this
      // plaintext secret slipped through it; fixed at the write path.
      fields.push('captcha_secret = ?'); values.push(updates.captcha_secret ? encrypt(updates.captcha_secret) : null);
    }
    // QUOXCHAT-PRO P1 — alerts + availability config. JSON fields accept an
    // object (serialised here) or a pre-serialised string that must parse;
    // null clears. operator_online is a manual boolean toggle.
    if (updates.notification_settings_json !== undefined) {
      const v = updates.notification_settings_json;
      if (v === null) { fields.push('notification_settings_json = ?'); values.push(null); }
      else if (typeof v === 'object') { fields.push('notification_settings_json = ?'); values.push(JSON.stringify(v)); }
      else if (typeof v === 'string') {
        try { JSON.parse(v); } catch { return res.status(400).json({ error: 'notification_settings_json must be valid JSON' }); }
        fields.push('notification_settings_json = ?'); values.push(v);
      } else {
        return res.status(400).json({ error: 'notification_settings_json must be an object, JSON string, or null' });
      }
    }
    if (updates.office_hours_json !== undefined) {
      const v = updates.office_hours_json;
      if (v === null) { fields.push('office_hours_json = ?'); values.push(null); }
      else if (typeof v === 'object') { fields.push('office_hours_json = ?'); values.push(JSON.stringify(v)); }
      else if (typeof v === 'string') {
        try { JSON.parse(v); } catch { return res.status(400).json({ error: 'office_hours_json must be valid JSON' }); }
        fields.push('office_hours_json = ?'); values.push(v);
      } else {
        return res.status(400).json({ error: 'office_hours_json must be an object, JSON string, or null' });
      }
    }
    if (updates.operator_online !== undefined) {
      fields.push('operator_online = ?'); values.push(updates.operator_online ? 1 : 0);
    }

    if (fields.length === 0) return res.json({ widget: redactWidgetSecrets(widget) });

    fields.push("updated_at = datetime('now')");
    values.push(widgetId, orgId);

    // QCX-5f — snapshot the existing prompt/config into widget_prompt_versions
    // BEFORE applying the update, so the prior state is always recoverable.
    // Only triggers when the change actually touches prompt or embed config.
    const promptTouched =
      updates.system_prompt_override !== undefined
      || updates.embed_config_json !== undefined;
    if (promptTouched) {
      try {
        const lastVer = prepare(
          `SELECT MAX(version) AS v FROM widget_prompt_versions WHERE widget_id = ?`,
        ).get(widgetId);
        const nextVersion = (lastVer?.v || 0) + 1;
        prepare(`
          INSERT INTO widget_prompt_versions
            (id, widget_id, org_id, version, system_prompt, embed_config_json, change_note, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          ulid(), widgetId, orgId, nextVersion,
          widget.system_prompt_override || null,
          widget.embed_config_json || null,
          typeof updates.change_note === 'string' ? updates.change_note : null,
          req.user.id,
        );
      } catch (verErr) {
        console.warn('QCX-5f: prompt snapshot failed (non-fatal):', verErr.message);
      }
    }

    // Wave 11: a widget whose only passing claim is dev_only must not keep
    // serving once a public domain is added. Drop it to draft; Go live must
    // then pass the real security set.
    let requiresGoLive = false;
    if (updates.status === undefined && ['published', 'active'].includes(widget.status)
      && (Array.isArray(updates.allowed_domains) || updates.allowed_domains_json)) {
      let newDomains = [];
      try { newDomains = Array.isArray(updates.allowed_domains) ? updates.allowed_domains : JSON.parse(updates.allowed_domains_json); } catch { newDomains = []; }
      const hasPublic = Array.isArray(newDomains) && newDomains.some((d) => !isDevOnlyDomain(d));
      if (hasPublic) {
        const realClaim = prepare('SELECT 1 AS ok FROM widget_publish_claims WHERE widget_id = ? AND dev_only = 0 AND security_score >= 70 LIMIT 1').get(widgetId);
        if (!realClaim) {
          requiresGoLive = true;
        }
      }
    }

    prepare(`UPDATE website_widgets SET ${fields.join(', ')} WHERE id = ? AND org_id = ?`).run(...values);
    if (requiresGoLive) prepare("UPDATE website_widgets SET status = 'draft' WHERE id = ? AND org_id = ?").run(widgetId, orgId);

    createAuditEvent({ orgId, actorType: 'user', actorId: req.user.id, action: 'widget.update', targetType: 'widget', targetId: widgetId });

    const updated = prepare('SELECT * FROM website_widgets WHERE id = ?').get(widgetId);
    res.json({
      widget: redactWidgetSecrets({
        ...updated,
        allowed_domains: JSON.parse(updated.allowed_domains_json || '[]'),
        embed_config: JSON.parse(updated.embed_config_json || '{}'),
      }),
      ...(requiresGoLive ? { requires_go_live: true, message: 'A public domain was added. Run Go live: the security checks must pass before this widget serves again.' } : {}),
    });
  } catch (err) {
    console.error('Error updating widget:', err);
    res.status(500).json({ error: 'Failed to update widget' });
  }
});

/**
 * DELETE /orgs/:orgId/widgets/:widgetId/visitors/:visitorId
 * Org-admin erasure of one data subject (GDPR Art. 17) for this widget: their
 * conversations, messages and leads. Admin or owner role required. Idempotent
 * (second call returns zero counts). Audited as widget.gdpr.erase.
 */
router.delete('/orgs/:orgId/widgets/:widgetId/visitors/:visitorId', requireOrgMembership, (req, res) => {
  try {
    const { orgId, widgetId, visitorId } = req.params;
    if (!hasRoleLevel(req.orgMembership?.role, 'admin')) {
      return res.status(403).json({ error: 'insufficient_role', message: 'Erasing a visitor requires the organisation admin role.' });
    }
    const widget = prepare('SELECT id, org_id FROM website_widgets WHERE id = ? AND org_id = ?').get(widgetId, orgId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });
    const r = eraseVisitorRows(widget.id, visitorId);
    const deleted = { messages: r.messagesDeleted, conversations: r.conversationsDeleted, visitor: r.visitorDeleted, leads: r.leadsDeleted };
    createAuditEvent({
      orgId, actorType: 'user', actorId: req.user.id, action: 'widget.gdpr.erase',
      targetType: 'widget', targetId: widget.id, metadata: { visitor_id: visitorId, via: 'org_admin', deleted },
    });
    res.json({ ok: true, deleted, legal_basis: 'GDPR Article 17 — right to erasure' });
  } catch (err) {
    console.error('Error erasing visitor data (admin):', err);
    res.status(500).json({ error: 'Failed to erase visitor data' });
  }
});

/**
 * DELETE /orgs/:orgId/widgets/:widgetId
 * Delete a widget
 */
router.delete('/orgs/:orgId/widgets/:widgetId', requireOrgMembership, async (req, res) => {
  try {
    const { orgId, widgetId } = req.params;

    const widget = prepare('SELECT * FROM website_widgets WHERE id = ? AND org_id = ?').get(widgetId, orgId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });

    // PERSIST-TRUTH: purge the widget's embedded-content Qdrant collection
    // BEFORE deleting the row — best-effort, but a failure must be loud and
    // auditable, never silently swallowed. The DB row is deleted regardless
    // (a Qdrant outage must not make a widget undeletable); a failed purge
    // is logged with the widget id + collection so an operator can manually
    // clean it up, and recorded as its own audit event for traceability.
    const purgeResult = await purgeWidgetKnowledge(widgetId);

    prepare('DELETE FROM website_widgets WHERE id = ? AND org_id = ?').run(widgetId, orgId);

    createAuditEvent({ orgId, actorType: 'user', actorId: req.user.id, action: 'widget.delete', targetType: 'widget', targetId: widgetId, metadata: { name: widget.name } });

    if (purgeResult.ok) {
      createAuditEvent({
        orgId, actorType: 'user', actorId: req.user.id, action: 'widget.knowledge.purged',
        targetType: 'widget', targetId: widgetId,
        metadata: { collection: purgeResult.collection, deleted: purgeResult.deleted },
      });
    } else {
      console.error(
        `[widgets] Qdrant knowledge purge FAILED for widget=${widgetId} collection=${purgeResult.collection || 'unknown'} — manual cleanup required. Reason: ${purgeResult.reason}`,
      );
      createAuditEvent({
        orgId, actorType: 'user', actorId: req.user.id, action: 'widget.knowledge.purge_failed',
        targetType: 'widget', targetId: widgetId,
        status: 'failure',
        metadata: { collection: purgeResult.collection || null, reason: purgeResult.reason },
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting widget:', err);
    res.status(500).json({ error: 'Failed to delete widget' });
  }
});

/**
 * CW-8.9.2 — Completion/analytics read endpoints
 */

/**
 * GET /orgs/:orgId/widgets/:widgetId/knowledge/sources (CW-8.13)
 * List persisted knowledge sources for a widget.
 */
router.get('/orgs/:orgId/widgets/:widgetId/knowledge/sources', requireOrgMembership, requireQuoxchatEntitlement, async (req, res) => {
  try {
    const { orgId, widgetId } = req.params;
    const widget = prepare('SELECT id FROM website_widgets WHERE id = ? AND org_id = ?').get(widgetId, orgId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });

    const rows = prepare(`
      SELECT id, source_type, name, config_json, status, chunk_count, size_bytes, error_message, last_sync_at, created_at
      FROM widget_knowledge_sources
      WHERE widget_id = ?
      ORDER BY created_at DESC
      LIMIT 500
    `).all(widgetId);

    res.json({
      sources: rows.map(r => {
        const cfg = safeJsonParse(r.config_json, {}) || {};
        // Wave 7 #4: a quarantined source (injection scan) shows as such and its
        // chunks are not counted as usable knowledge.
        const quarantined = cfg.quarantined === true;
        return {
        id: r.id,
        type: r.source_type,
        name: r.name,
        config: cfg,
        status: quarantined ? 'quarantined' : r.status,
        chunks: quarantined ? 0 : r.chunk_count,
        ...(quarantined ? { quarantined: true, quarantinedChunks: r.chunk_count || 0 } : {}),
        sizeBytes: r.size_bytes == null ? (r.chunk_count || 0) * KNOWLEDGE_EST_BYTES_PER_CHUNK : r.size_bytes,
        sizeEstimated: r.size_bytes == null,
        errorMessage: r.error_message,
        lastSync: r.last_sync_at,
        createdAt: r.created_at,
        };
      }),
      storage: knowledgeStorageForOrg(orgId),
    });
  } catch (err) {
    console.error('Error listing knowledge sources:', err);
    res.status(500).json({ error: 'Failed to list knowledge sources' });
  }
});

/**
 * DELETE /orgs/:orgId/widgets/:widgetId/knowledge/sources/:sourceId (CW-8.13)
 * Soft-remove a knowledge source row. Qdrant chunks remain (cleanup in CW-FU).
 */
router.delete('/orgs/:orgId/widgets/:widgetId/knowledge/sources/:sourceId', requireOrgMembership, requireQuoxchatEntitlement, async (req, res) => {
  try {
    const { orgId, widgetId, sourceId } = req.params;
    const widget = prepare('SELECT id FROM website_widgets WHERE id = ? AND org_id = ?').get(widgetId, orgId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });

    const exists = prepare('SELECT id FROM widget_knowledge_sources WHERE id = ? AND widget_id = ?').get(sourceId, widgetId);
    if (!exists) return res.status(404).json({ error: 'Source not found' });

    // QUOXCHAT-BRUTALOOP w5 D1: purge the vectors FIRST via the collector's
    // supersede primitive (it also deletes the row once Qdrant succeeded).
    // A failed purge keeps the row so the operator can retry; deleting the
    // row alone left the content answerable from Qdrant forever.
    const purge = await forwardToCollectorDelete(`/quoxchat/knowledge/sources/${encodeURIComponent(sourceId)}?widget_id=${encodeURIComponent(widgetId)}`);
    if (purge.status === 404) {
      // collector says the row is already gone; fall through to idempotent row delete
    } else if (purge.status < 200 || purge.status >= 300) {
      console.error(`[widgets] knowledge source purge failed widget=${widgetId} source=${sourceId} status=${purge.status}`, purge.data);
      return res.status(502).json({ error: 'knowledge_purge_failed', message: 'Could not remove the source from the search index. Nothing was deleted; try again.', status: purge.status });
    }

    // The collector normally removed the row already; this is the idempotent backstop.
    prepare('DELETE FROM widget_knowledge_sources WHERE id = ? AND widget_id = ?').run(sourceId, widgetId);
    await reevaluateSuperseded(widgetId);
    reevaluatePriceChange(widgetId);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting knowledge source:', err);
    res.status(500).json({ error: 'Failed to delete knowledge source' });
  }
});

/**
 * QC-BRUTALOOP-W18: a price-change notice makes sibling price lists stale
 * without saying so. After any upload or delete, flag (changed_by_notice,
 * suggest_superseded with reason price_change_notice) every active priced source
 * whose category a notice changes, and clear flags whose notice is gone. Never
 * touches a source the admin decided on manually. Returns the flagged names.
 */
function reevaluatePriceChange(widgetId) {
  const flagged = [];
  try {
    const rows = prepare(`SELECT id, name, config_json FROM widget_knowledge_sources WHERE widget_id = ? AND source_type = 'file'`).all(widgetId);
    const hit = new Map(sourcesChangedByNotice(rows).map((h) => [String(h.id), h]));
    for (const r of rows) {
      const cfg = safeJsonParse(r.config_json, {}) || {};
      const h = hit.get(String(r.id));
      if (h && cfg.manual_superseded === undefined && cfg.superseded !== true) {
        const reasons = Array.isArray(cfg.superseded_reasons) ? cfg.superseded_reasons : [];
        if (!cfg.changed_by_notice || cfg.suggest_superseded !== true || !reasons.includes('price_change_notice')) {
          prepare('UPDATE widget_knowledge_sources SET config_json = ? WHERE id = ? AND widget_id = ?').run(JSON.stringify({ ...cfg, suggest_superseded: true, changed_by_notice: { notice: h.notice }, superseded_reasons: [...new Set([...reasons, 'price_change_notice'])] }), r.id, widgetId);
        }
        flagged.push(r.name);
      } else if (!h && cfg.changed_by_notice) {
        const reasons = (Array.isArray(cfg.superseded_reasons) ? cfg.superseded_reasons : []).filter((x) => x !== 'price_change_notice');
        const next = { ...cfg, superseded_reasons: reasons };
        delete next.changed_by_notice;
        if (reasons.length === 0 && cfg.superseded !== true) next.suggest_superseded = false;
        prepare('UPDATE widget_knowledge_sources SET config_json = ? WHERE id = ? AND widget_id = ?').run(JSON.stringify(next), r.id, widgetId);
      }
    }
  } catch (e) { console.warn('[widgets] price-change re-evaluation failed (non-fatal):', e?.message); }
  return flagged;
}

/**
 * QC-BRUTALOOP-W14: superseded detection must not depend on upload order. After
 * any upload or delete, re-run the signals for every other file source of the
 * widget. A source is promoted to auto reference-only only when ALL strong
 * signals now fire. Never touches a source the admin decided on manually
 * (manual_superseded) or one that is already reference-only: we only promote.
 * Returns the ids newly auto-superseded.
 */
async function reevaluateSuperseded(widgetId, exceptId = null) {
  const promoted = [];
  try {
    const rows = prepare(`SELECT id, name, config_json FROM widget_knowledge_sources WHERE widget_id = ? AND source_type = 'file'`).all(widgetId);
    for (const r of rows) {
      if (exceptId && r.id === exceptId) continue;
      const cfg = safeJsonParse(r.config_json, {}) || {};
      if (cfg.superseded || cfg.manual_superseded !== undefined) continue;
      const priorFirstLine = Array.isArray(cfg.superseded_reasons) && cfg.superseded_reasons.includes('first_line');
      const firstLine = typeof cfg.first_line === 'string' ? cfg.first_line : '';
      const others = rows.filter(o => o.id !== r.id).map(o => o.name);
      const othersFirst = rows.filter(o => o.id !== r.id).map(o => (safeJsonParse(o.config_json, {}) || {}).first_line).filter(l => typeof l === 'string');
      const lastLines = Array.isArray(cfg.last_lines) ? cfg.last_lines : [];
      const sig = detectSupersededSignal({ filename: r.name, firstLine, lastLines, existingNames: others, existingFirstLines: othersFirst });
      if (priorFirstLine && !sig.reasons.includes('first_line')) sig.reasons.push('first_line');
      if (!isStrongSupersededSignal(sig)) continue;
      const pr = await forwardToCollectorPatch(`/quoxchat/knowledge/sources/${encodeURIComponent(r.id)}`, { widget_id: widgetId, superseded: true });
      if (pr.status >= 200 && pr.status < 300) {
        prepare('UPDATE widget_knowledge_sources SET config_json = ? WHERE id = ? AND widget_id = ?').run(JSON.stringify({ ...cfg, superseded: true, suggest_superseded: false, auto_superseded: true, superseded_reasons: sig.reasons }), r.id, widgetId);
        promoted.push(r.id);
      } else {
        console.warn(`[widgets] re-evaluate auto reference-only failed widget=${widgetId} source=${r.id} status=${pr.status}`);
      }
    }
  } catch (e) { console.warn('[widgets] superseded re-evaluation failed (non-fatal):', e?.message); }
  return promoted;
}

/**
 * PATCH /orgs/:orgId/widgets/:widgetId/knowledge/sources/:sourceId
 * Body { superseded: boolean }. Marks a source reference-only: it stays listed
 * and searchable in admin, but visitor answers and citations stop using it.
 */
router.patch('/orgs/:orgId/widgets/:widgetId/knowledge/sources/:sourceId', requireOrgMembership, requireQuoxchatEntitlement, async (req, res) => {
  try {
    const { orgId, widgetId, sourceId } = req.params;
    const superseded = req.body && req.body.superseded;
    if (typeof superseded !== 'boolean') return res.status(400).json({ error: 'superseded (boolean) required' });
    const widget = prepare('SELECT id FROM website_widgets WHERE id = ? AND org_id = ?').get(widgetId, orgId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });
    const exists = prepare('SELECT id FROM widget_knowledge_sources WHERE id = ? AND widget_id = ?').get(sourceId, widgetId);
    if (!exists) return res.status(404).json({ error: 'Source not found' });
    const r = await forwardToCollectorPatch(`/quoxchat/knowledge/sources/${encodeURIComponent(sourceId)}`, { widget_id: widgetId, superseded });
    if (r.status === 422) return res.status(422).json({ error: 'cannot_supersede', message: 'This source type cannot be marked reference-only.' });
    if (r.status < 200 || r.status >= 300) {
      console.error(`[widgets] knowledge source supersede failed widget=${widgetId} source=${sourceId} status=${r.status}`, r.data);
      return res.status(502).json({ error: 'knowledge_supersede_failed', message: 'Could not update the search index. Nothing changed; try again.', status: r.status });
    }
    // w9: the admin has decided; the stored suggestion no longer applies.
    // W14: record the manual decision so re-evaluation never overrides it.
    try {
      const cur = prepare('SELECT config_json FROM widget_knowledge_sources WHERE id = ? AND widget_id = ?').get(sourceId, widgetId);
      const cfg = safeJsonParse(cur?.config_json, {}) || {};
      prepare('UPDATE widget_knowledge_sources SET config_json = ? WHERE id = ? AND widget_id = ?').run(JSON.stringify({ ...cfg, superseded, suggest_superseded: false, auto_superseded: false, manual_superseded: superseded }), sourceId, widgetId);
    } catch (e) { console.warn('[widgets] clear superseded suggestion failed (non-fatal):', e?.message); }
    res.json({ success: true, source_id: sourceId, superseded });
  } catch (err) {
    console.error('Error superseding knowledge source:', err);
    res.status(500).json({ error: 'Failed to update knowledge source' });
  }
});

router.get('/orgs/:orgId/widgets/:widgetId/knowledge/stats', requireOrgMembership, async (req, res) => {
  try {
    const { orgId, widgetId } = req.params;
    const widget = prepare('SELECT id FROM website_widgets WHERE id = ? AND org_id = ?').get(widgetId, orgId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });

    const sources = prepare(`
      SELECT source_type as type, COUNT(*) as n,
             COALESCE(SUM(CASE WHEN COALESCE(json_extract(config_json, '$.quarantined'), 0) IN (1, 'true') THEN 0 ELSE chunk_count END),0) as chunks
      FROM widget_knowledge_sources WHERE widget_id = ? GROUP BY source_type
    `).all(widgetId);

    let totalChunks = 0, totalSources = 0, qaCount = 0;
    for (const s of sources) {
      totalSources += s.n;
      totalChunks += s.chunks || 0;
      if (s.type === 'qa') qaCount += s.n;
    }

    const msgRow = prepare('SELECT COUNT(*) as n FROM widget_messages WHERE widget_id = ?').get(widgetId);
    const convRow = prepare('SELECT COUNT(*) as n FROM widget_conversations WHERE widget_id = ?').get(widgetId);

    res.json({
      totalChunks, totalSources, qaCount,
      messageCount: msgRow?.n || 0,
      conversationCount: convRow?.n || 0,
    });
  } catch (err) {
    console.error('Error getting knowledge stats:', err);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

/**
 * QCL-BACKEND-UX #131 — GET /orgs/:orgId/widgets/:widgetId/usage/current
 *
 * Org-scoped equivalent of the internal (service-key-only) usage/current
 * endpoint above, so the dashboard can show a usage-vs-cap burn panel
 * without a service key. Guarded by requireOrgMembership + an explicit
 * ownership check (id + org_id), mirroring the org-scoped KB proxy routes
 * below. Returns the exact same payload shape as the internal endpoint —
 * both call computeWidgetUsagePayload() so they cannot drift.
 */
router.get('/orgs/:orgId/widgets/:widgetId/usage/current', requireOrgMembership, (req, res) => {
  try {
    const { orgId, widgetId } = req.params;
    const widget = prepare(
      'SELECT id, org_id, embed_config_json FROM website_widgets WHERE id = ? AND org_id = ?',
    ).get(widgetId, orgId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });

    res.json(computeWidgetUsagePayload(widget));
  } catch (err) {
    console.error('Error reading org-scoped usage:', err);
    res.status(500).json({ error: 'Failed to read usage' });
  }
});

// ── QCL-SECURITY P0-1/P0-3 — org-scoped KB/teach admin proxy ────────────
// The collector's /quoxchat/knowledge/{qa,search,crawl,upload} and
// /quoxchat/teach/propose are now service-key gated (Phase 2 collector
// change) because they trusted a client-supplied widget_id — any internet
// caller could poison/read a widget's KB. Only the admin dashboard
// legitimately calls these (KnowledgeTab, TrainingTab, LogsTab); the public
// widget never does. These routes verify org membership + widget ownership,
// inject widget_id from the validated path (never trust the body), then
// forward with x-service-key.

function loadOwnedWidget(widgetId, orgId) {
  return prepare('SELECT id FROM website_widgets WHERE id = ? AND org_id = ?').get(widgetId, orgId);
}

router.post('/orgs/:orgId/widgets/:widgetId/knowledge/qa', requireOrgMembership, requireQuoxchatEntitlement, async (req, res) => {
  try {
    const { orgId, widgetId } = req.params;
    if (!loadOwnedWidget(widgetId, orgId)) return res.status(404).json({ error: 'Widget not found' });

    const { question, answer, category, source_conversation_id, source_message_id } = req.body || {};
    const { status, data } = await forwardToCollectorJson('/quoxchat/knowledge/qa', {
      widget_id: widgetId,
      question,
      answer,
      category,
      source_conversation_id: source_conversation_id || null,
      source_message_id: source_message_id || null,
      // QCL-SECURITY P0-3: corrected_by comes from the authenticated
      // session, NEVER the client body — the audit flagged attribution
      // spoofing as an explicit risk (a caller claiming to be someone
      // else's admin in the correction provenance trail).
      // QC-W14: only attribute when this is a real correction (provenance
      // supplied). A plain Q&A pair has none, else the collector would file
      // every manual pair under the 'correction' category.
      corrected_by: (source_conversation_id || source_message_id) ? (req.user?.email || null) : null,
    });
    res.status(status).json(data);
  } catch (err) {
    console.error('Error proxying knowledge/qa:', err);
    res.status(502).json({ error: 'Failed to reach knowledge service' });
  }
});

router.post('/orgs/:orgId/widgets/:widgetId/knowledge/search', requireOrgMembership, requireQuoxchatEntitlement, async (req, res) => {
  try {
    const { orgId, widgetId } = req.params;
    if (!loadOwnedWidget(widgetId, orgId)) return res.status(404).json({ error: 'Widget not found' });

    const { query, limit } = req.body || {};
    const { status, data } = await forwardToCollectorJson('/quoxchat/knowledge/search', {
      widget_id: widgetId,
      query,
      limit,
    });
    // Wave 7 #4: mark chunks that belong to quarantined sources so the admin
    // can see they exist but are excluded from answers.
    if (status >= 200 && status < 300 && data && Array.isArray(data.chunks)) {
      const qNames = new Set(prepare(`SELECT name, config_json FROM widget_knowledge_sources WHERE widget_id = ?`).all(widgetId)
        .filter(r => (safeJsonParse(r.config_json, {}) || {}).quarantined === true).map(r => r.name));
      if (qNames.size > 0) {
        data.chunks = data.chunks.map(c => (qNames.has(c.source)
          ? { ...c, quarantined: true, label: 'quarantined (excluded from answers)' } : c));
      }
    }
    res.status(status).json(data);
  } catch (err) {
    console.error('Error proxying knowledge/search:', err);
    res.status(502).json({ error: 'Failed to reach knowledge service' });
  }
});

// QC-BRUTALOOP-W17b: the crawl is a background job. It used to run synchronously
// behind nginx, so a slow site timed out the request and the crawled content was
// lost silently. POST returns 202 + job_id at once; GET .../crawl/jobs/:jobId
// reports it (mirrors the simulate job). A failure writes/updates the source row
// with status 'error' + error_message so the Knowledge tab shows it after a
// reload. `?wait=1` keeps the old synchronous response. Jobs live in memory; the
// durable record is the widget_knowledge_sources row.
const CRAWL_JOB_TIMEOUT_MS = 15 * 60 * 1000;
const CRAWL_JOB_TTL_MS = 60 * 60 * 1000;
const crawlJobs = new Map();
function pruneCrawlJobs() {
  const cutoff = Date.now() - CRAWL_JOB_TTL_MS;
  for (const [id, j] of crawlJobs) if (j.finished_ms && j.finished_ms < cutoff) crawlJobs.delete(id);
}
function publicCrawlJob(j) {
  const { org_id, widget_id, finished_ms, ...rest } = j; // eslint-disable-line no-unused-vars
  return rest;
}
function recordCrawlError(widgetId, orgId, url, depth, jobId, message) {
  const msg = String(message || 'Crawl failed').slice(0, 500);
  try {
    const existing = prepare(`SELECT id FROM widget_knowledge_sources WHERE widget_id = ? AND source_type = 'url' AND name = ?`).get(widgetId, String(url).slice(0, 500));
    if (existing) {
      prepare(`UPDATE widget_knowledge_sources SET status = 'error', error_message = ?, last_sync_at = datetime('now') WHERE id = ?`).run(msg, existing.id);
      return existing.id;
    }
    const id = ulid();
    prepare(`
      INSERT INTO widget_knowledge_sources (id, widget_id, org_id, source_type, name, config_json, status, chunk_count, error_message, last_sync_at)
      VALUES (?, ?, ?, 'url', ?, ?, 'error', 0, ?, datetime('now'))
    `).run(id, widgetId, orgId, String(url).slice(0, 500), JSON.stringify({ url, depth, crawl_job_id: jobId }), msg);
    return id;
  } catch (err) {
    console.error('Error recording crawl failure:', err);
    return null;
  }
}

router.post('/orgs/:orgId/widgets/:widgetId/knowledge/crawl', requireOrgMembership, requireQuoxchatEntitlement, async (req, res) => {
  try {
    const { orgId, widgetId } = req.params;
    if (!loadOwnedWidget(widgetId, orgId)) return res.status(404).json({ error: 'Widget not found' });

    const { url, depth } = req.body || {};
    const payload = { widget_id: widgetId, url, depth };
    if (req.query.wait === '1' || req.query.wait === 'true') {
      const { status, data } = await forwardToCollectorJson('/quoxchat/knowledge/crawl', payload);
      return res.status(status).json(data);
    }
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'URL is required' });

    pruneCrawlJobs();
    for (const j of crawlJobs.values()) {
      if (j.widget_id === widgetId && j.url === url && j.status === 'running') {
        return res.status(409).json({ error: 'crawl_already_running', job_id: j.job_id, status: 'running' });
      }
    }
    const job = { job_id: ulid(), org_id: orgId, widget_id: widgetId, url, depth: depth ?? null, status: 'running', started_at: new Date().toISOString() };
    crawlJobs.set(job.job_id, job);
    forwardToCollectorJson('/quoxchat/knowledge/crawl', payload, { timeoutMs: CRAWL_JOB_TIMEOUT_MS })
      .then(({ status, data }) => {
        if (status >= 200 && status < 300 && data?.success !== false) {
          job.status = 'done'; job.http_status = status; job.result = data;
        } else {
          job.status = 'error'; job.http_status = status;
          job.error = data?.message || data?.error || `collector_${status}`;
          recordCrawlError(widgetId, orgId, url, depth ?? null, job.job_id, job.error);
        }
      })
      .catch((err) => {
        job.status = 'error'; job.error = err?.message || 'collector_unreachable';
        recordCrawlError(widgetId, orgId, url, depth ?? null, job.job_id, job.error);
      })
      .finally(() => { job.finished_ms = Date.now(); job.finished_at = new Date().toISOString(); });
    res.status(202).json(publicCrawlJob(job));
  } catch (err) {
    console.error('Error proxying knowledge/crawl:', err);
    res.status(502).json({ error: 'Failed to reach knowledge service' });
  }
});

router.get('/orgs/:orgId/widgets/:widgetId/knowledge/crawl/jobs/:jobId', requireOrgMembership, requireQuoxchatEntitlement, (req, res) => {
  const { orgId, widgetId, jobId } = req.params;
  const job = crawlJobs.get(jobId);
  if (!job || job.org_id !== orgId || job.widget_id !== widgetId) return res.status(404).json({ error: 'Job not found' });
  res.json(publicCrawlJob(job));
});

router.post('/orgs/:orgId/widgets/:widgetId/teach/propose', requireOrgMembership, requireQuoxchatEntitlement, async (req, res) => {
  try {
    const { orgId, widgetId } = req.params;
    if (!loadOwnedWidget(widgetId, orgId)) return res.status(404).json({ error: 'Widget not found' });

    const { messages } = req.body || {};
    const { status, data } = await forwardToCollectorJson('/quoxchat/teach/propose', {
      widget_id: widgetId,
      messages,
    });
    res.status(status).json(data);
  } catch (err) {
    console.error('Error proxying teach/propose:', err);
    res.status(502).json({ error: 'Failed to reach knowledge service' });
  }
});

// Multipart upload proxy — memoryStorage so the buffer can be re-wrapped
// into a fresh FormData/Blob for the collector hop (Node 20's global
// fetch/FormData/Blob make this a plain re-stream, no temp files needed).
const knowledgeUploadProxy = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

router.post('/orgs/:orgId/widgets/:widgetId/knowledge/upload', requireOrgMembership, requireQuoxchatEntitlement, knowledgeUploadProxy.single('file'), async (req, res) => {
  try {
    const { orgId, widgetId } = req.params;
    if (!loadOwnedWidget(widgetId, orgId)) return res.status(404).json({ error: 'Widget not found' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const serviceKey = process.env.INTERNAL_SERVICE_KEY;
    if (!serviceKey) return res.status(503).json({ error: 'service_key_not_configured' });
    const collectorUrl = process.env.COLLECTOR_URL || process.env.QUOX_COLLECTOR_URL || 'http://collector:9848';

    // w6k D11: an upload whose filename matches an existing file source
    // REPLACES it. Purge the old vectors first (same path as source delete),
    // then index the new file; a failed purge aborts so nothing is doubled.
    const replacedIds = [];
    const dupes = prepare(`SELECT id FROM widget_knowledge_sources WHERE widget_id = ? AND source_type = 'file' AND name = ?`).all(widgetId, req.file.originalname);
    for (const d of dupes) {
      const purge = await forwardToCollectorDelete(`/quoxchat/knowledge/sources/${encodeURIComponent(d.id)}?widget_id=${encodeURIComponent(widgetId)}`);
      if (purge.status !== 404 && (purge.status < 200 || purge.status >= 300)) {
        console.error(`[widgets] upload replace purge failed widget=${widgetId} source=${d.id} status=${purge.status}`, purge.data);
        return res.status(502).json({ error: 'knowledge_purge_failed', message: `Could not replace the existing "${req.file.originalname}". Nothing was changed; try again.`, status: purge.status });
      }
      prepare('DELETE FROM widget_knowledge_sources WHERE id = ? AND widget_id = ?').run(d.id, widgetId);
      replacedIds.push(d.id);
    }

    const fd = new FormData();
    fd.append('widget_id', widgetId);
    fd.append('file', new Blob([req.file.buffer], { type: req.file.mimetype || 'application/octet-stream' }), req.file.originalname);

    const resp = await fetch(`${collectorUrl}/quoxchat/knowledge/upload`, {
      method: 'POST',
      headers: { 'x-service-key': serviceKey },
      body: fd,
    });
    const data = await resp.json().catch(() => ({}));
    // Wave 7 #4: suggest "reference only" when the file looks old/replaced.
    if (resp.ok && data && typeof data === 'object') {
      try {
        const textish = /^text\//i.test(req.file.mimetype || '') || /\.(txt|md|csv|json)$/i.test(req.file.originalname || '');
        const firstLine = textish ? req.file.buffer.toString('utf8', 0, 600).split(/\r?\n/).find(l => l.trim()) || '' : '';
        const lastLines = textish ? req.file.buffer.toString('utf8').split(/\r?\n/).filter(l => l.trim()).slice(-3).map(l => l.slice(0, 300)) : [];
        const existingRows = prepare(`SELECT id, name, config_json FROM widget_knowledge_sources WHERE widget_id = ? AND source_type = 'file'`).all(widgetId);
        const existingNames = existingRows.map(r => r.name);
        const existingFirstLines = existingRows.filter(r => String(r.id) !== String(data.source_id)).map(r => (safeJsonParse(r.config_json, {}) || {}).first_line).filter(l => typeof l === 'string');
        const sig = detectSupersededSignal({ filename: req.file.originalname, firstLine, existingNames, existingFirstLines, lastLines });
        data.suggest_superseded = sig.suggest_superseded;
        if (sig.suggest_superseded) data.superseded_reasons = sig.reasons;
        // W14: keep the first line so later uploads can re-run the signals.
        if (firstLine && data.source_id) {
          const fr = prepare('SELECT config_json FROM widget_knowledge_sources WHERE id = ? AND widget_id = ?').get(String(data.source_id), widgetId);
          if (fr) prepare('UPDATE widget_knowledge_sources SET config_json = ? WHERE id = ? AND widget_id = ?').run(JSON.stringify({ ...(safeJsonParse(fr.config_json, {}) || {}), first_line: String(firstLine).slice(0, 300), last_lines: lastLines }), String(data.source_id), widgetId);
        }
        // W18: keep the price digest / price-change notice so the check is order independent.
        if (textish && data.source_id) {
          const pi = extractPriceInfo({ filename: req.file.originalname, text: req.file.buffer.toString('utf8') });
          if (pi.price_notice || pi.price_digest) {
            const pr0 = prepare('SELECT config_json FROM widget_knowledge_sources WHERE id = ? AND widget_id = ?').get(String(data.source_id), widgetId);
            if (pr0) prepare('UPDATE widget_knowledge_sources SET config_json = ? WHERE id = ? AND widget_id = ?').run(JSON.stringify({ ...(safeJsonParse(pr0.config_json, {}) || {}), ...(pi.price_notice ? { price_notice: pi.price_notice } : {}), ...(pi.price_digest ? { price_digest: pi.price_digest } : {}) }), String(data.source_id), widgetId);
          }
        }
        // w9: persist the suggestion on the source row so it survives a reload
        // until the admin decides (the PATCH below clears it).
        if (sig.suggest_superseded && data.source_id) {
          const row = prepare('SELECT config_json FROM widget_knowledge_sources WHERE id = ? AND widget_id = ?').get(String(data.source_id), widgetId);
          if (row) {
            const merged = { ...(safeJsonParse(row.config_json, {}) || {}), suggest_superseded: true, superseded_reasons: sig.reasons };
            prepare('UPDATE widget_knowledge_sources SET config_json = ? WHERE id = ? AND widget_id = ?').run(JSON.stringify(merged), String(data.source_id), widgetId);
            // QC-BRUTALOOP-W13: ALL strong signals together (filename, first line,
            // older year) default the source to reference-only. Anything less
            // stays a suggestion. Undo = the normal PATCH superseded:false.
            if (isStrongSupersededSignal(sig)) {
              const pr = await forwardToCollectorPatch(`/quoxchat/knowledge/sources/${encodeURIComponent(String(data.source_id))}`, { widget_id: widgetId, superseded: true });
              if (pr.status >= 200 && pr.status < 300) {
                const cur = safeJsonParse(prepare('SELECT config_json FROM widget_knowledge_sources WHERE id = ? AND widget_id = ?').get(String(data.source_id), widgetId)?.config_json, {}) || {};
                prepare('UPDATE widget_knowledge_sources SET config_json = ? WHERE id = ? AND widget_id = ?').run(JSON.stringify({ ...cur, superseded: true, suggest_superseded: false, auto_superseded: true, superseded_reasons: sig.reasons }), String(data.source_id), widgetId);
                data.superseded = true;
                data.auto_superseded = true;
              } else {
                console.warn(`[widgets] auto reference-only failed widget=${widgetId} source=${data.source_id} status=${pr.status}; left as suggestion`);
              }
            }
          }
        }
      } catch (e) { console.warn('[widgets] superseded signal failed (non-fatal):', e?.message); }
      // W14: a newer file can make OLDER sources strong-signal; order must not matter.
      const priceFlagged = reevaluatePriceChange(widgetId);
      if (priceFlagged.length) {
        data.price_change_flagged = priceFlagged;
        if (data.source_id && priceFlagged.includes(req.file.originalname)) {
          data.suggest_superseded = true;
          data.superseded_reasons = [...new Set([...(data.superseded_reasons || []), 'price_change_notice'])];
        }
      }
      const promoted = await reevaluateSuperseded(widgetId, data.source_id ? String(data.source_id) : null);
      if (promoted.length) data.auto_superseded_others = promoted;
    }
    if (replacedIds.length > 0 && data && typeof data === 'object') {
      data.replaced = replacedIds;
      data.replaced_note = `Replaced the earlier upload of ${req.file.originalname}.`;
    }
    res.status(resp.status).json(data);
  } catch (err) {
    console.error('Error proxying knowledge/upload:', err);
    res.status(502).json({ error: 'Failed to reach knowledge service' });
  }
});

// ── CW-11 helpers ──────────────────────────────────────────────────────
function safeJsonParse(raw, fallback = null) {
  if (raw == null) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function csvEscape(value) {
  if (value == null) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildConversationFilters(widgetId, query) {
  const where = ['widget_id = ?'];
  const params = [widgetId];
  if (typeof query.status === 'string' && query.status.length > 0) {
    where.push('status = ?'); params.push(query.status);
  }
  if (query.rating === 'positive') { where.push('visitor_rating > 0'); }
  else if (query.rating === 'negative') { where.push('visitor_rating < 0'); }
  else if (query.rating === 'unrated') { where.push('visitor_rating IS NULL'); }
  if (typeof query.from === 'string' && query.from.length > 0) {
    where.push("started_at >= ?"); params.push(query.from);
  }
  if (typeof query.to === 'string' && query.to.length > 0) {
    where.push("started_at <= ?"); params.push(query.to);
  }
  // Wave 5: blocked injection turns are persisted with filtered=1 on the
  // visitor message, so Logs can show only the conversations that hit one.
  if (query.blocked === '1' || query.blocked === 'true') {
    where.push(`EXISTS (
      SELECT 1 FROM widget_messages bm
       WHERE bm.conversation_id = widget_conversations.id AND bm.filtered = 1
    )`);
  }
  // w9: the operator desk / CLI / live pill pass exclude_test=1 so simulation
  // (sim_*) and knowledge-tab test conversations never look like real traffic.
  // Logs omits it and keeps them (labelled is_test).
  // Wave 10: excluded BY DEFAULT (lists, totals, exports); include_test=1 opts in.
  const includeTest = query.include_test === '1' || query.include_test === 'true';
  if (!includeTest || query.exclude_test === '1' || query.exclude_test === 'true') {
    where.push(`NOT ${TEST_VISITOR_SQL()}`);
  }
  // QCX-5k — exact visitor_id filter.
  if (typeof query.visitor_id === 'string' && query.visitor_id.length > 0) {
    where.push('visitor_id = ?'); params.push(query.visitor_id);
  }
  // QCX-5k — full-text search across visitor identity fields + a content
  // EXISTS-subquery on widget_messages. SQLite LIKE is case-insensitive
  // for ASCII; good enough without an FTS5 index for moderate volumes.
  if (typeof query.q === 'string' && query.q.trim().length > 0) {
    const needle = `%${query.q.trim()}%`;
    where.push(`(
      visitor_id LIKE ? OR visitor_email LIKE ? OR visitor_name LIKE ?
      OR EXISTS (
        SELECT 1 FROM widget_messages m
         WHERE m.conversation_id = widget_conversations.id
           AND m.content LIKE ?
      )
    )`);
    params.push(needle, needle, needle, needle);
  }
  return { where: where.join(' AND '), params };
}

router.get('/orgs/:orgId/widgets/:widgetId/conversations', requireOrgMembership, async (req, res) => {
  try {
    const { orgId, widgetId } = req.params;
    const widget = prepare('SELECT id FROM website_widgets WHERE id = ? AND org_id = ?').get(widgetId, orgId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });

    const pagination = getPagination(req.query);
    const { where, params } = buildConversationFilters(widgetId, req.query);
    // QCL-BACKEND-UX #130: correlated subqueries (mirrors the
    // widget_messages EXISTS pattern in buildConversationFilters above)
    // pull the visitor's verified flag + identified_attrs from
    // widget_visitors without touching the WHERE clause or risking
    // ambiguous-column joins against widget_conversations.
    const rows = prepare(`
      SELECT *,
        (SELECT verified FROM widget_visitors wv
          WHERE wv.widget_id = widget_conversations.widget_id
            AND wv.visitor_id = widget_conversations.visitor_id) AS visitor_verified,
        (SELECT identified_attrs_json FROM widget_visitors wv
          WHERE wv.widget_id = widget_conversations.widget_id
            AND wv.visitor_id = widget_conversations.visitor_id) AS visitor_identified_attrs_json,
        (SELECT 1 FROM widget_messages bm
          WHERE bm.widget_id = widget_conversations.widget_id
            AND bm.conversation_id = widget_conversations.id
            AND bm.filtered = 1 LIMIT 1) AS has_blocked,
        (SELECT role FROM widget_messages wm
          WHERE wm.widget_id = widget_conversations.widget_id
            AND wm.conversation_id = widget_conversations.id
          ORDER BY wm.created_at DESC, wm.rowid DESC LIMIT 1) AS last_message_role,
        (SELECT substr(content, 1, 140) FROM widget_messages wm
          WHERE wm.widget_id = widget_conversations.widget_id
            AND wm.conversation_id = widget_conversations.id
          ORDER BY wm.created_at DESC, wm.rowid DESC LIMIT 1) AS last_message_preview,
        ${TEST_VISITOR_SQL('widget_conversations.')} AS is_test
      FROM widget_conversations
      WHERE ${where}
      ORDER BY last_message_at DESC LIMIT ? OFFSET ?
    `).all(...params, pagination.limit, pagination.offset);
    const count = prepare(`SELECT COUNT(*) as n FROM widget_conversations WHERE ${where}`).get(...params);
    // w5h: admin test traffic stays in Logs, labelled (excluded from analytics).
    res.json(formatPaginatedResponse(rows.map((r) => ({ ...r, is_test: r.is_test === 1 })), count.n, pagination));
  } catch (err) {
    console.error('Error listing conversations:', err);
    res.status(500).json({ error: 'Failed to list conversations' });
  }
});

router.get('/orgs/:orgId/widgets/:widgetId/conversations/:conversationId/messages', requireOrgMembership, async (req, res) => {
  try {
    const { orgId, widgetId, conversationId } = req.params;
    const widget = prepare('SELECT id FROM website_widgets WHERE id = ? AND org_id = ?').get(widgetId, orgId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });

    const rows = prepare(`
      SELECT * FROM widget_messages
      WHERE widget_id = ? AND conversation_id = ?
      ORDER BY created_at ASC
    `).all(widgetId, conversationId);
    const messages = rows.map(r => {
      // QCX-5k — surface token counts from the captured context. Falls back
      // to null so older rows (pre-5a) don't render bogus zeros.
      const ctx = r.context_json ? safeJsonParse(r.context_json, null) : null;
      const input_tokens = ctx && typeof ctx.input_tokens === 'number' ? ctx.input_tokens : null;
      const output_tokens = ctx && typeof ctx.output_tokens === 'number' ? ctx.output_tokens : null;
      return {
        id: r.id,
        conversation_id: r.conversation_id,
        widget_id: r.widget_id,
        role: r.role,
        content: r.content,
        // QUOXCHAT-PRO Matrix-less handoff: operator rows carry the human
        // replier's display name; null for user/assistant rows.
        sender_name: r.sender_name || null,
        sources: safeJsonParse(r.sources_json, []),
        tool_calls: safeJsonParse(r.tool_calls_json, []),
        confidence: r.confidence,
        envelope_id: r.envelope_id,
        injection_score: r.injection_score,
        filtered: !!r.filtered,
        created_at: r.created_at,
        input_tokens,
        output_tokens,
      };
    });
    res.json({ messages });
  } catch (err) {
    console.error('Error listing messages:', err);
    res.status(500).json({ error: 'Failed to list messages' });
  }
});

/**
 * QCX-5e — POST /orgs/:orgId/widgets/:widgetId/clone
 *
 * Forks an existing widget into a new one under the same org. Duplicates:
 *   - assistants  (new id)
 *   - website_widgets (new id, new public_key, new qdrant_namespace, fresh stats)
 *   - widget_knowledge_sources (new ids)
 *   - widget_connectors (new ids)
 *
 * History (widget_conversations + widget_messages) is NOT copied — the
 * clone starts fresh. Knowledge chunks in Qdrant are not re-indexed by
 * this endpoint; the source rows are duplicated with status='pending' so
 * an admin can re-trigger ingestion.
 *
 * Body: { name?: string }   defaults to "<source name> (copy)"
 */
router.post('/orgs/:orgId/widgets/:widgetId/clone', requireOrgMembership, async (req, res) => {
  try {
    const { orgId, widgetId } = req.params;
    const userId = req.user.id;
    const overrideName = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim() : null;

    // Source widget — strict org scope (no cross-org reads).
    const source = prepare(
      `SELECT * FROM website_widgets WHERE id = ? AND org_id = ?`,
    ).get(widgetId, orgId);
    if (!source) return res.status(404).json({ error: 'Widget not found' });

    const sourceAssistant = prepare(`SELECT * FROM assistants WHERE id = ?`).get(source.assistant_id);
    if (!sourceAssistant) return res.status(404).json({ error: 'Source assistant missing' });

    const newWidgetId = ulid();
    const newAssistantId = ulid();
    const newPublicKey = `wid_${ulid().slice(0, 12).toLowerCase()}`;
    const cloneName = overrideName || `${source.name} (copy)`;
    const newQdrantNamespace = `widget_${newPublicKey}`;

    const db = getDb();
    db.transaction(() => {
      // 1. Clone the assistant.
      prepare(`
        INSERT INTO assistants (id, org_id, name, slug, description, persona_json, status, created_by, is_template)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 0)
      `).run(
        newAssistantId, orgId, cloneName, slugify(cloneName),
        sourceAssistant.description || `Cloned from ${source.name}`,
        sourceAssistant.persona_json || '{}',
        userId,
      );

      // 2. Clone the widget row. Stats reset; usage reset; first_seen null.
      prepare(`
        INSERT INTO website_widgets (
          id, assistant_id, org_id, name, public_key,
          allowed_domains_json, deployment_type, embed_config_json,
          knowledge_folder_path, qdrant_namespace,
          llm_key_vault_ref, monthly_budget_cents, budget_action,
          usage_this_month_json,
          total_conversations, total_messages, last_conversation_at,
          status, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, 'draft', ?)
      `).run(
        newWidgetId, newAssistantId, orgId, cloneName, newPublicKey,
        source.allowed_domains_json || '[]',
        source.deployment_type || 'embed',
        source.embed_config_json || '{}',
        source.knowledge_folder_path || null,
        newQdrantNamespace,
        source.llm_key_vault_ref || null,
        source.monthly_budget_cents || null,
        source.budget_action || 'downgrade',
        '{}',
        userId,
      );

      // 3. Clone widget_knowledge_sources. Reset status to 'pending' so
      //    the new widget's index can be rebuilt; chunk_count zeroed.
      const knowledgeRows = prepare(
        `SELECT * FROM widget_knowledge_sources WHERE widget_id = ?`,
      ).all(widgetId);
      for (const row of knowledgeRows) {
        prepare(`
          INSERT INTO widget_knowledge_sources
            (id, widget_id, org_id, source_type, name, config_json,
             status, chunk_count, content_hash, error_message,
             last_sync_at, sync_schedule)
          VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, ?)
        `).run(
          ulid(), newWidgetId, orgId,
          row.source_type, row.name, row.config_json || '{}',
          row.sync_schedule || null,
        );
      }

      // 4. Clone widget_connectors. Reset usage counters; vault_ref kept
      //    (admin can rotate after clone if they want isolation).
      const connectorRows = prepare(
        `SELECT * FROM widget_connectors WHERE widget_id = ?`,
      ).all(widgetId);
      for (const row of connectorRows) {
        prepare(`
          INSERT INTO widget_connectors
            (id, widget_id, org_id, connector_type, name, config_json,
             vault_ref, status, last_used_at, use_count, error_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, 0, 0)
        `).run(
          ulid(), newWidgetId, orgId,
          row.connector_type, row.name, row.config_json || '{}',
          row.vault_ref || null,
        );
      }
    })();

    createAuditEvent({
      orgId,
      actorType: 'user',
      actorId: userId,
      action: 'widget.clone',
      targetType: 'widget',
      targetId: newWidgetId,
      metadata: { source_widget_id: widgetId, name: cloneName },
    });

    const widget = prepare('SELECT * FROM website_widgets WHERE id = ?').get(newWidgetId);
    res.status(201).json({
      widget: redactWidgetSecrets({
        ...widget,
        allowed_domains: JSON.parse(widget.allowed_domains_json || '[]'),
        embed_config: JSON.parse(widget.embed_config_json || '{}'),
      }),
      source_widget_id: widgetId,
    });
  } catch (err) {
    console.error('Error cloning widget:', err);
    res.status(500).json({ error: 'Failed to clone widget' });
  }
});

/**
 * QCX-5f — Widget system-prompt version history.
 *
 * GET    /orgs/:orgId/widgets/:widgetId/prompt-versions          list (newest first)
 * GET    /orgs/:orgId/widgets/:widgetId/prompt-versions/:version single record (for diff)
 * POST   /orgs/:orgId/widgets/:widgetId/prompt-versions/:version/rollback
 *        Restore that version's system_prompt + embed_config; the current
 *        state is snapshotted as a NEW version first so rollback is itself
 *        reversible.
 */
router.get('/orgs/:orgId/widgets/:widgetId/prompt-versions', requireOrgMembership, async (req, res) => {
  try {
    const { orgId, widgetId } = req.params;
    const widget = prepare('SELECT id FROM website_widgets WHERE id = ? AND org_id = ?').get(widgetId, orgId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });
    const rows = prepare(`
      SELECT id, version, system_prompt, embed_config_json, change_note, created_by, created_at
        FROM widget_prompt_versions
       WHERE widget_id = ? AND org_id = ?
       ORDER BY version DESC
       LIMIT 200
    `).all(widgetId, orgId);
    res.json({
      versions: rows.map(r => ({
        ...r,
        embed_config: r.embed_config_json ? safeJsonParse(r.embed_config_json, {}) : null,
      })),
    });
  } catch (err) {
    console.error('Error listing prompt versions:', err);
    res.status(500).json({ error: 'Failed to list prompt versions' });
  }
});

router.get('/orgs/:orgId/widgets/:widgetId/prompt-versions/:version', requireOrgMembership, async (req, res) => {
  try {
    const { orgId, widgetId, version } = req.params;
    const v = parseInt(version, 10);
    if (!Number.isFinite(v) || v < 1) return res.status(400).json({ error: 'invalid version' });
    const row = prepare(`
      SELECT id, version, system_prompt, embed_config_json, change_note, created_by, created_at
        FROM widget_prompt_versions
       WHERE widget_id = ? AND org_id = ? AND version = ?
    `).get(widgetId, orgId, v);
    if (!row) return res.status(404).json({ error: 'Version not found' });
    res.json({
      version: {
        ...row,
        embed_config: row.embed_config_json ? safeJsonParse(row.embed_config_json, {}) : null,
      },
    });
  } catch (err) {
    console.error('Error reading prompt version:', err);
    res.status(500).json({ error: 'Failed to read prompt version' });
  }
});

router.post('/orgs/:orgId/widgets/:widgetId/prompt-versions/:version/rollback', requireOrgMembership, async (req, res) => {
  try {
    const { orgId, widgetId, version } = req.params;
    const userId = req.user.id;
    const v = parseInt(version, 10);
    if (!Number.isFinite(v) || v < 1) return res.status(400).json({ error: 'invalid version' });

    const widget = prepare('SELECT * FROM website_widgets WHERE id = ? AND org_id = ?').get(widgetId, orgId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });

    const target = prepare(`
      SELECT system_prompt, embed_config_json FROM widget_prompt_versions
       WHERE widget_id = ? AND org_id = ? AND version = ?
    `).get(widgetId, orgId, v);
    if (!target) return res.status(404).json({ error: 'Version not found' });

    const db = getDb();
    db.transaction(() => {
      // Snapshot current state as a fresh version BEFORE overwriting — so
      // rolling back is itself reversible.
      const lastVer = prepare(`SELECT MAX(version) AS v FROM widget_prompt_versions WHERE widget_id = ?`).get(widgetId);
      const nextVersion = (lastVer?.v || 0) + 1;
      prepare(`
        INSERT INTO widget_prompt_versions
          (id, widget_id, org_id, version, system_prompt, embed_config_json, change_note, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ulid(), widgetId, orgId, nextVersion,
        widget.system_prompt_override || null,
        widget.embed_config_json || null,
        `pre-rollback to v${v}`,
        userId,
      );
      // Apply the chosen version.
      prepare(`
        UPDATE website_widgets
           SET system_prompt_override = ?, embed_config_json = ?, updated_at = datetime('now')
         WHERE id = ? AND org_id = ?
      `).run(target.system_prompt || null, target.embed_config_json || widget.embed_config_json, widgetId, orgId);
    })();

    createAuditEvent({
      orgId,
      actorType: 'user',
      actorId: userId,
      action: 'widget.prompt_rollback',
      targetType: 'widget',
      targetId: widgetId,
      metadata: { rolled_back_to_version: v },
    });

    const updated = prepare('SELECT * FROM website_widgets WHERE id = ?').get(widgetId);
    res.json({
      widget: redactWidgetSecrets({
        ...updated,
        allowed_domains: safeJsonParse(updated.allowed_domains_json, []),
        embed_config: safeJsonParse(updated.embed_config_json, {}),
      }),
      restored_version: v,
    });
  } catch (err) {
    console.error('Error rolling back prompt:', err);
    res.status(500).json({ error: 'Failed to roll back prompt' });
  }
});

/**
 * QCX-10a — GET /orgs/:orgId/widgets/:widgetId/compliance-readiness
 *
 * Returns the QCX-6 compliance checklist for the widget. Each item carries
 * {id, passed, severity, message, fix?}. ready=true means no blocker has
 * failed (warnings can still be present). The admin UI (Compliance tab)
 * surfaces the list with green/red indicators.
 */
router.get('/orgs/:orgId/widgets/:widgetId/compliance-readiness', requireOrgMembership, (req, res) => {
  try {
    const { orgId, widgetId } = req.params;
    const widget = prepare(`
      SELECT id, name, status, risk_tier, risk_classification_json,
             retention_days_override, embed_config_json
        FROM website_widgets WHERE id = ? AND org_id = ?
    `).get(widgetId, orgId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });

    const embedConfig = safeJsonParse(widget.embed_config_json, {});
    const classification = safeJsonParse(widget.risk_classification_json, null) || {
      tier: widget.risk_tier || 'limited_risk',
    };

    const result = evaluateComplianceReadiness(widget, embedConfig, classification);
    res.json({
      widget_id: widget.id,
      tier: widget.risk_tier || 'limited_risk',
      ready: result.ready,
      checks: result.checks,
      summary: {
        total: result.checks.length,
        passed: result.checks.filter(c => c.passed).length,
        blockers_failing: result.checks.filter(c => c.severity === 'blocker' && !c.passed).length,
        warnings: result.checks.filter(c => c.severity === 'warning' && !c.passed).length,
      },
    });
  } catch (err) {
    console.error('Error reading compliance readiness:', err);
    res.status(500).json({ error: 'Failed to read compliance readiness' });
  }
});

/**
 * QCX-6g — POST /orgs/:orgId/widgets/:widgetId/evidence-export?period=YYYY-Q[1-4]|YYYY-MM
 *
 * Auditor-grade compliance bundle for a widget over a period. Returns
 * canonical JSON (sorted keys) with sha256 hash + HMAC-SHA256 signature
 * in response headers so a third party can verify the bundle's integrity
 * later. Period parser accepts:
 *   2026-Q1 .. 2026-Q4  (calendar quarters, UTC)
 *   2026-04             (calendar month, UTC)
 *
 * The bundle includes the widget snapshot (status + risk_tier +
 * retention_days_override), every conversation that started in the
 * window, every message in those conversations, and aggregate counts.
 * PDF rendering + Ed25519 signing land in a later sub-phase; HMAC over
 * the canonical JSON is enough to prove non-tampering today.
 */
function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

function parseEvidencePeriod(period) {
  if (typeof period !== 'string') return null;
  const q = period.match(/^(\d{4})-Q([1-4])$/);
  if (q) {
    const year = parseInt(q[1], 10);
    const quarter = parseInt(q[2], 10);
    const fromMonth = (quarter - 1) * 3;
    const from = new Date(Date.UTC(year, fromMonth, 1));
    const to = new Date(Date.UTC(year, fromMonth + 3, 1));
    return { from: from.toISOString(), to: to.toISOString(), label: period };
  }
  const m = period.match(/^(\d{4})-(\d{2})$/);
  if (m) {
    const year = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    if (month < 1 || month > 12) return null;
    const from = new Date(Date.UTC(year, month - 1, 1));
    const to = new Date(Date.UTC(year, month, 1));
    return { from: from.toISOString(), to: to.toISOString(), label: period };
  }
  return null;
}

/** GET /orgs/:orgId/evidence-signing-key: public half of the org's evidence signing key. */
router.get('/orgs/:orgId/evidence-signing-key', requireOrgMembership, (req, res) => {
  try {
    const k = ensureOrgWidgetEvidenceSigningKey(getDb(), req.params.orgId);
    res.json({ algorithm: k.algorithm, key_id: k.key_id, public_key_hex: k.public_key_hex, created_at: k.created_at });
  } catch (err) {
    console.error('evidence signing key', err);
    res.status(500).json({ error: 'Failed to load evidence signing key' });
  }
});

router.post('/orgs/:orgId/widgets/:widgetId/evidence-export', requireOrgMembership, async (req, res) => {
  try {
    const { orgId, widgetId } = req.params;
    const userId = req.user.id;
    // Accept the period from the query string or the JSON body.
    const period = parseEvidencePeriod(req.query.period ?? req.body?.period);
    if (!period) {
      return res.status(400).json({ error: 'period (query string or JSON body) must be YYYY-Q1..Q4 or YYYY-MM' });
    }

    const widget = prepare(`
      SELECT id, name, public_key, status, risk_tier, risk_classification_json,
             retention_days_override, allowed_domains_json, created_at
        FROM website_widgets WHERE id = ? AND org_id = ?
    `).get(widgetId, orgId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });

    // Wave 7 #3: simulation / admin-test conversations are not customer
    // activity; keep them out of the evidence bundle and report how many.
    const conversations = prepare(`
      SELECT id, visitor_id, status, started_at, last_message_at, message_count,
             visitor_rating, resolution, correlation_id, page_url
        FROM widget_conversations
       WHERE widget_id = ?
         AND datetime(started_at) >= datetime(?)
         AND datetime(started_at) < datetime(?)
         AND ${NOT_TEST_CONV_SQL}
       ORDER BY started_at ASC
    `).all(widgetId, period.from, period.to);
    const testConversationsExcluded = prepare(`
      SELECT COUNT(*) AS n FROM widget_conversations
       WHERE widget_id = ?
         AND datetime(started_at) >= datetime(?)
         AND datetime(started_at) < datetime(?)
         AND ${TEST_VISITOR_SQL()}
    `).get(widgetId, period.from, period.to).n;

    let messages = [];
    if (conversations.length > 0) {
      const placeholders = conversations.map(() => '?').join(',');
      const ids = conversations.map(c => c.id);
      messages = prepare(`
        SELECT id, conversation_id, role, content,
               sources_json, tool_calls_json, confidence,
               envelope_id, injection_score, filtered, created_at
          FROM widget_messages
         WHERE widget_id = ? AND conversation_id IN (${placeholders})
         ORDER BY created_at ASC
      `).all(widgetId, ...ids).map(r => ({
        id: r.id,
        conversation_id: r.conversation_id,
        role: r.role,
        content: r.content,
        sources: safeJsonParse(r.sources_json, []),
        tool_calls: safeJsonParse(r.tool_calls_json, []),
        confidence: r.confidence,
        envelope_id: r.envelope_id,
        injection_score: r.injection_score,
        filtered: !!r.filtered,
        created_at: r.created_at,
      }));
    }

    const totalToolCalls = messages.reduce((acc, m) => acc + (Array.isArray(m.tool_calls) ? m.tool_calls.length : 0), 0);
    const injectionsFlagged = messages.filter(m => (m.injection_score || 0) > 0).length;

    const bundle = {
      bundle_kind: 'quoxchat-evidence-export',
      bundle_version: '1.0',
      period: period.label,
      from: period.from,
      to: period.to,
      widget: {
        id: widget.id,
        name: widget.name,
        public_key: widget.public_key,
        status: widget.status,
        risk_tier: widget.risk_tier,
        risk_classification: safeJsonParse(widget.risk_classification_json, null),
        retention_days_override: widget.retention_days_override,
        allowed_domains: safeJsonParse(widget.allowed_domains_json, []),
        created_at: widget.created_at,
      },
      conversations,
      messages,
      counts: {
        conversations: conversations.length,
        messages: messages.length,
        tool_calls: totalToolCalls,
        injections_flagged: injectionsFlagged,
        test_conversations_excluded: testConversationsExcluded,
      },
      org_id: orgId,
      exported_by: userId,
      exported_at: new Date().toISOString(),
    };

    // Canonical JSON: stable key order + no extra whitespace. The
    // hash + signature both lock onto this exact byte sequence so a
    // verifier reproduces them precisely.
    // Wave 7: the old array-replacer form (JSON.stringify(bundle, topKeys))
    // is a key WHITELIST applied at every depth, so it dropped every nested
    // key (messages, conversations) and the hash never covered the transcript.
    // canonicalJson sorts keys recursively and covers everything.
    const canonical = canonicalJson(bundle);
    const hash = crypto.createHash('sha256').update(canonical).digest('hex');
    // H3 fix: never fall back to a public/known constant signing key — that
    // would let anyone forge X-Bundle-Signature. If the real service key
    // isn't configured, refuse to sign at all (caught below, returns 500).
    const signingKey = process.env.INTERNAL_SERVICE_KEY;
    if (!signingKey) {
      throw new Error('INTERNAL_SERVICE_KEY not configured — refusing to sign evidence bundle');
    }
    const signature = crypto.createHmac('sha256', signingKey).update(canonical).digest('hex');

    createAuditEvent({
      orgId, actorType: 'user', actorId: userId,
      action: 'widget.evidence.export',
      targetType: 'widget', targetId: widgetId,
      metadata: { period: period.label, counts: bundle.counts, hash },
    });

    // Wave 11: org-scoped Ed25519 signature over the same canonical bytes,
    // verifiable offline with only the public key. HMAC kept for compatibility.
    const ed = signWidgetEvidence(getDb(), orgId, Buffer.from(canonical, 'utf8').toString('hex'));

    res.setHeader('X-Bundle-Hash', hash);
    res.setHeader('X-Bundle-Signature', signature);
    res.setHeader('X-Bundle-Signature-Ed25519', ed.signature);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="evidence-${widgetId}-${period.label}.json"`);
    return res.send(JSON.stringify({ ...bundle, _verification: { algorithm: 'HMAC-SHA256', canonicalization: 'recursive-sorted-keys-v2', hash, signature, ed25519: { algorithm: 'Ed25519', key_id: ed.key_id, public_key_hex: ed.public_key_hex, signature: ed.signature, signed_bytes: 'utf8 of canonicalization over the bundle without _verification' } } }, null, 2));
  } catch (err) {
    console.error('Error exporting evidence:', err);
    res.status(500).json({ error: 'Failed to export evidence' });
  }
});

/**
 * QCX-6c — POST /orgs/:orgId/widgets/:widgetId/retention/run
 *
 * Executes the retention cascade for a single widget. Reads
 * retention_days_override on the widget; null/0 means "no retention enforced"
 * and the cascade is a no-op. Otherwise prunes widget_messages → widget_conversations
 * older than NOW() - retention_days_override days. Single transaction.
 *
 * Designed to be invoked manually from the admin UI today; a daily cron will
 * call the same endpoint for every widget in a later sub-phase.
 */
router.post('/orgs/:orgId/widgets/:widgetId/retention/run', requireOrgMembership, async (req, res) => {
  try {
    const { orgId, widgetId } = req.params;
    const userId = req.user.id;

    const widget = prepare(
      'SELECT id, retention_days_override FROM website_widgets WHERE id = ? AND org_id = ?',
    ).get(widgetId, orgId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });

    // Skip when no retention is configured (null or 0). Audited as no-op so
    // the run is on the audit trail regardless.
    if (widget.retention_days_override == null || widget.retention_days_override <= 0) {
      createAuditEvent({
        orgId, actorType: 'user', actorId: userId,
        action: 'widget.retention.run',
        targetType: 'widget', targetId: widgetId,
        metadata: { skipped: 'no_retention_configured' },
      });
      return res.json({
        ok: true,
        skipped: true,
        reason: 'no retention configured for widget',
        deleted: { messages: 0, conversations: 0 },
      });
    }

    const days = widget.retention_days_override;
    let messagesDeleted = 0;
    let conversationsDeleted = 0;

    const db = getDb();
    db.transaction(() => {
      // Step 1 — messages first (FK dependency on conversation_id).
      const msgResult = prepare(`
        DELETE FROM widget_messages
         WHERE widget_id = ?
           AND conversation_id IN (
             SELECT id FROM widget_conversations
              WHERE widget_id = ?
                AND datetime(last_message_at) < datetime('now', ?)
           )
      `).run(widgetId, widgetId, `-${days} days`);
      messagesDeleted = msgResult.changes;

      // Step 2 — conversations.
      const convResult = prepare(`
        DELETE FROM widget_conversations
         WHERE widget_id = ?
           AND datetime(last_message_at) < datetime('now', ?)
      `).run(widgetId, `-${days} days`);
      conversationsDeleted = convResult.changes;
    })();

    createAuditEvent({
      orgId, actorType: 'user', actorId: userId,
      action: 'widget.retention.run',
      targetType: 'widget', targetId: widgetId,
      metadata: { days, deleted: { messages: messagesDeleted, conversations: conversationsDeleted } },
    });

    res.json({
      ok: true,
      retention_days: days,
      deleted: { messages: messagesDeleted, conversations: conversationsDeleted },
    });
  } catch (err) {
    console.error('Error running retention:', err);
    res.status(500).json({ error: 'Failed to run retention' });
  }
});

// QCX-5a — full LLM input context for a specific message. Powers the
// admin LogsTab drill-down: "what did the LLM actually see?". Returns
// 404 when context_json is NULL (older rows + user messages).
router.get('/orgs/:orgId/widgets/:widgetId/messages/:messageId/context', requireOrgMembership, async (req, res) => {
  try {
    const { orgId, widgetId, messageId } = req.params;
    const widget = prepare('SELECT id FROM website_widgets WHERE id = ? AND org_id = ?').get(widgetId, orgId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });
    const row = prepare(
      `SELECT id, widget_id, org_id, role, context_json, created_at
         FROM widget_messages
        WHERE id = ? AND widget_id = ? AND org_id = ?`,
    ).get(messageId, widgetId, orgId);
    if (!row) return res.status(404).json({ error: 'Message not found' });
    if (!row.context_json) return res.status(404).json({ error: 'Message context not found' });
    const context = safeJsonParse(row.context_json, null);
    if (!context) return res.status(404).json({ error: 'Message context not found' });
    res.json({
      message_id: row.id,
      widget_id: row.widget_id,
      role: row.role,
      created_at: row.created_at,
      context,
    });
  } catch (err) {
    console.error('Error reading message context:', err);
    res.status(500).json({ error: 'Failed to read context' });
  }
});

// CW-11.3 — conversations export (JSON + CSV)
router.get('/orgs/:orgId/widgets/:widgetId/conversations.json', requireOrgMembership, async (req, res) => {
  try {
    const { orgId, widgetId } = req.params;
    const widget = prepare('SELECT id FROM website_widgets WHERE id = ? AND org_id = ?').get(widgetId, orgId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });
    const { where, params } = buildConversationFilters(widgetId, req.query);
    const rows = prepare(`SELECT *, ${TEST_VISITOR_SQL()} AS is_test FROM widget_conversations WHERE ${where} ORDER BY last_message_at DESC LIMIT 5000`).all(...params)
      .map((r) => ({ ...r, is_test: r.is_test === 1 }));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="widget-${widgetId}-conversations.json"`);
    // w6k: ?transcripts=1 adds every message of each conversation. The default
    // stays metadata-only so existing consumers do not get heavier.
    if (req.query.transcripts === '1' || req.query.transcripts === 'true') {
      const msgs = prepare(`SELECT id, role, content, created_at FROM widget_messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 2000`);
      for (const r of rows) r.messages = msgs.all(r.id);
    }
    res.json({ widget_id: widgetId, exported_at: new Date().toISOString(), total: rows.length, conversations: rows });
  } catch (err) {
    console.error('Error exporting conversations (json):', err);
    res.status(500).json({ error: 'Failed to export' });
  }
});

router.get('/orgs/:orgId/widgets/:widgetId/conversations.csv', requireOrgMembership, async (req, res) => {
  try {
    const { orgId, widgetId } = req.params;
    const widget = prepare('SELECT id FROM website_widgets WHERE id = ? AND org_id = ?').get(widgetId, orgId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });
    const { where, params } = buildConversationFilters(widgetId, req.query);
    const rows = prepare(`
      SELECT id, visitor_id, visitor_name, visitor_email, status, resolution, message_count, visitor_rating,
             started_at, last_message_at, resolved_at, ${TEST_VISITOR_SQL()} AS is_test
      FROM widget_conversations WHERE ${where} ORDER BY last_message_at DESC LIMIT 5000
    `).all(...params);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="widget-${widgetId}-conversations.csv"`);
    // visitor_name added (night audit B1): the JSON export always carried
    // it, the CSV silently dropped identified visitors back to raw ids.
    const header = ['id','visitor_id','visitor_name','visitor_email','status','resolution','message_count','visitor_rating','started_at','last_message_at','resolved_at','is_test'];
    const lines = [header.join(',')];
    for (const r of rows) lines.push(header.map(k => csvEscape(r[k])).join(','));
    res.end(lines.join('\r\n'));
  } catch (err) {
    console.error('Error exporting conversations (csv):', err);
    res.status(500).json({ error: 'Failed to export' });
  }
});

// Admin test traffic (w5h): the Knowledge tab "Test knowledge" chat uses the
// visitor id 'knowledge-tab-test' and Simulation Arena scenarios run as
// 'sim_<scenario>_<nonce>'. They are real conversations (Logs keeps them,
// labelled is_test) but must not pollute customer-facing analytics. Matching
// on visitor_id also cleans up rows persisted before this tag existed.
const TEST_VISITOR_IDS = ['knowledge-tab-test', 'training_test', 'onboarding'];
const TEST_VISITOR_SQL = (alias = '') =>
  `(${alias}visitor_id LIKE 'sim\\_%' ESCAPE '\\' OR ${alias}visitor_id IN ('knowledge-tab-test', 'training_test', 'onboarding'))`;
const NOT_TEST_CONV_SQL = `NOT ${TEST_VISITOR_SQL()}`;
// For widget_messages tables (no visitor_id column): exclude by conversation.
const NOT_TEST_MSG_SQL = (alias = '') =>
  `${alias}conversation_id NOT IN (SELECT id FROM widget_conversations WHERE ${TEST_VISITOR_SQL()})`;

// CW-11.4 — analytics endpoints
//
// Wave 5: every analytics route honours ?from&to (the UI always sent them,
// the server ignored them). datetime() normalises both the ISO strings the
// UI sends and the 'YYYY-MM-DD HH:MM:SS' strings SQLite defaults write.
function analyticsRange(query, col) {
  let sql = '';
  const params = [];
  if (typeof query.from === 'string' && query.from.length > 0) {
    sql += ` AND datetime(${col}) >= datetime(?)`; params.push(query.from);
  }
  if (typeof query.to === 'string' && query.to.length > 0) {
    sql += ` AND datetime(${col}) <= datetime(?)`; params.push(query.to);
  }
  return { sql, params };
}

/**
 * Classify one assistant turn from the grounding verdict the collector
 * persists in context_json.grounding. Returns null when the turn cannot be
 * assessed (pre-grounding rows, blocked turns, tool-only replies).
 *   error           the turn failed (llm_error, timeout, no_api_key); error_outcome set
 *   withheld        verifier outage, the reply was replaced by an apology
 *   stripped        the grounding gate removed the reply's content
 *   no_knowledge    nothing in the knowledge base matched the question
 *   low_confidence  only weak matches backed the answer
 *   answered        strong knowledge match, nothing stripped or withheld
 */
// Wave 13: the answer itself says the documents do not cover the question.
// That is a knowledge gap whatever retrieval confidence the turn had.
const KNOWLEDGE_GAP_RE = /\b(?:(?:information|documents?|details?|knowledge|content)(?:\s+(?:provided|available|i have|we have))?\s+(?:does\s*n[o']t|do\s*n[o']t|doesn't|don't|did\s*n[o']t)\s+(?:mention|say|state|cover|include|specify|contain|list)|i\s+(?:do\s*n[o']t|don't|can(?:no|')t)\s+see\b[^.!?\n]{0,120}?\b(?:mentioned|listed|stated|covered|included)\b|(?:not|isn't|aren't)\s+(?:mentioned|listed|covered|stated)\s+in\s+the\s+(?:information|documents?|details))/i;
function isKnowledgeGapText(text) {
  return typeof text === 'string' && KNOWLEDGE_GAP_RE.test(text);
}

function classifyGrounding(ctx, answerText) {
  if (!ctx || ctx.blocked === true) return null;
  // Wave 14: a failed turn (llm_error, timeout, no_api_key) is its own verdict.
  if (typeof ctx.error_outcome === 'string' && ctx.error_outcome) return 'error';
  const g = ctx.grounding;
  if (!g || typeof g !== 'object') return null;
  if (g.withheld === true) return 'withheld';
  if (g.stripped === true) return 'stripped';
  if (g.confidence === 'none') return 'no_knowledge';
  if ((g.confidence === 'weak' || g.confidence === 'strong') && isKnowledgeGapText(answerText)) return 'no_knowledge';
  if (g.confidence === 'weak') return 'low_confidence';
  if (g.confidence === 'strong') return 'answered';
  return null;
}

// QC-BRUTALOOP-W15: overlay flags (not exclusive with the verdict buckets), so
// a confidently wrong answer that still counts as "answered" can be found.
// corrected: the gate or verifier acted on the reply (stripped, regenerated,
// figures removed, or unsupported claims found).
function wasCorrected(ctx) {
  const g = ctx && ctx.grounding;
  if (!g || typeof g !== 'object') return false;
  return g.stripped === true || g.corrected === true
    || (Array.isArray(g.unsupported_figures) && g.unsupported_figures.length > 0)
    || Boolean(g.claims && Array.isArray(g.claims.unsupported) && g.claims.unsupported.length > 0);
}
// used_outdated_source: the collector flagged that a chunk behind the reply came
// from a superseded / suggested-superseded source.
function usedOutdatedSource(ctx) {
  return Boolean(ctx && ctx.grounding && ctx.grounding.used_outdated_source === true);
}

function scanAssistantTurns(widgetId, query, limit = 5000) {
  const r = analyticsRange(query, 'created_at');
  return prepare(`
    SELECT id, conversation_id, content, context_json, created_at
      FROM widget_messages
     WHERE widget_id = ? AND role = 'assistant' AND context_json IS NOT NULL AND ${NOT_TEST_MSG_SQL()}${r.sql}
     ORDER BY created_at DESC LIMIT ${limit}
  `).all(widgetId, ...r.params);
}

function responseTimeDeltas(widgetId, query) {
  // w5h: the measured per-answer duration (response_ms, written by
  // persist-message) is the sample. Legacy rows have none, and their
  // user/assistant timestamps were identical, so they yield no pair and are
  // skipped rather than reported as 0 ms.
  const r = analyticsRange(query, 'created_at');
  const rows = prepare(`
    SELECT response_ms FROM widget_messages
     WHERE widget_id = ? AND role = 'assistant' AND response_ms IS NOT NULL AND ${NOT_TEST_MSG_SQL()}${r.sql}
     ORDER BY created_at DESC LIMIT 2000
  `).all(widgetId, ...r.params);
  const deltas = [];
  for (const row of rows) {
    const ms = Number(row.response_ms);
    if (Number.isFinite(ms) && ms >= 0) deltas.push(ms);
  }
  // Rows without a measured duration: pair the user message with the next
  // assistant message by timestamp (older rows / non-collector writers).
  const pr = analyticsRange(query, 'u.created_at');
  const pairs = prepare(`
    SELECT u.created_at AS user_at, a.created_at AS assistant_at
    FROM widget_messages u
    JOIN widget_messages a
      ON a.conversation_id = u.conversation_id
     AND a.role = 'assistant' AND a.response_ms IS NULL
     AND a.created_at > u.created_at
     AND NOT EXISTS (
       SELECT 1 FROM widget_messages m
       WHERE m.conversation_id = u.conversation_id
         AND m.created_at > u.created_at AND m.created_at < a.created_at
     )
    WHERE u.widget_id = ? AND u.role = 'user' AND ${NOT_TEST_MSG_SQL('u.')}${pr.sql}
    LIMIT 2000
  `).all(widgetId, ...pr.params);
  for (const row of pairs) {
    const ms = new Date(row.assistant_at).getTime() - new Date(row.user_at).getTime();
    if (Number.isFinite(ms) && ms >= 0) deltas.push(ms);
  }
  deltas.sort((a, b) => a - b);
  return deltas;
}

// Whole-range summary computed in SQL, so the Analytics stat cards no longer
// depend on page 1 (limit 20) of the conversations list. "Resolved" is not
// reported: nothing in the product ever sets a conversation to resolved
// (statuses in use: active, handed_off, closed), so the old stat was a
// permanent zero. answer_quality is derived from the grounding verdict the
// collector stores per answer, not from knowledge-base size.
router.get('/orgs/:orgId/widgets/:widgetId/analytics/summary', requireOrgMembership, async (req, res) => {
  try {
    const { orgId, widgetId } = req.params;
    const widget = prepare('SELECT id FROM website_widgets WHERE id = ? AND org_id = ?').get(widgetId, orgId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });

    const cr = analyticsRange(req.query, 'started_at');
    const statusRows = prepare(`
      SELECT status, COUNT(*) AS n FROM widget_conversations
       WHERE widget_id = ? AND ${NOT_TEST_CONV_SQL}${cr.sql} GROUP BY status
    `).all(widgetId, ...cr.params);
    const by_status = {};
    let total = 0;
    for (const r of statusRows) { by_status[r.status] = r.n; total += r.n; }
    const convAgg = prepare(`
      SELECT COALESCE(SUM(message_count), 0) AS msgs,
             SUM(CASE WHEN visitor_rating IS NOT NULL THEN 1 ELSE 0 END) AS rated,
             SUM(CASE WHEN visitor_rating = 1 THEN 1 ELSE 0 END) AS up
        FROM widget_conversations WHERE widget_id = ? AND ${NOT_TEST_CONV_SQL}${cr.sql}
    `).get(widgetId, ...cr.params);

    const mr = analyticsRange(req.query, 'created_at');
    const total_messages = prepare(
      `SELECT COUNT(*) AS n FROM widget_messages WHERE widget_id = ? AND ${NOT_TEST_MSG_SQL()}${mr.sql}`,
    ).get(widgetId, ...mr.params).n;
    const blocked_turns = prepare(
      `SELECT COUNT(*) AS n FROM widget_messages WHERE widget_id = ? AND role = 'user' AND filtered = 1 AND ${NOT_TEST_MSG_SQL()}${mr.sql}`,
    ).get(widgetId, ...mr.params).n;

    const lr = analyticsRange(req.query, 'captured_at');
    const leads = prepare(
      `SELECT COUNT(*) AS n FROM widget_leads WHERE widget_id = ?${lr.sql}`,
    ).get(widgetId, ...lr.params).n;

    const deltas = responseTimeDeltas(widgetId, req.query);
    const avg_response_ms = deltas.length ? Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length) : null;

    const quality = { assessed: 0, answered: 0, low_confidence: 0, no_knowledge: 0, stripped: 0, withheld: 0, error: 0, unassessed: 0, corrected: 0, used_outdated_source: 0, answered_rate: null };
    for (const row of scanAssistantTurns(widgetId, req.query)) {
      const sctx = safeJsonParse(row.context_json, null);
      const verdict = classifyGrounding(sctx, row.content);
      if (!verdict) { quality.unassessed += 1; continue; }
      quality.assessed += 1;
      quality[verdict] += 1;
      if (wasCorrected(sctx)) quality.corrected += 1;
      if (usedOutdatedSource(sctx)) quality.used_outdated_source += 1;
    }
    // Assistant turns with no context_json at all are also unassessed.
    const noCtx = prepare(
      `SELECT COUNT(*) AS n FROM widget_messages WHERE widget_id = ? AND role = 'assistant' AND context_json IS NULL AND ${NOT_TEST_MSG_SQL()}${mr.sql}`,
    ).get(widgetId, ...mr.params).n;
    quality.unassessed += noCtx;
    if (quality.assessed > 0) quality.answered_rate = Math.round((quality.answered / quality.assessed) * 100) / 100;

    res.json({
      total_conversations: total,
      total_messages,
      by_status,
      handed_off: by_status.handed_off || 0,
      closed: by_status.closed || 0,
      active: by_status.active || 0,
      leads,
      blocked_turns,
      avg_messages: total > 0 ? Math.round(convAgg.msgs / total) : 0,
      rating: { rated: convAgg.rated || 0, thumbs_up: convAgg.up || 0 },
      avg_response_ms,
      response_samples: deltas.length,
      answer_quality: quality,
    });
  } catch (err) {
    console.error('Error computing analytics summary:', err);
    res.status(500).json({ error: 'Failed to compute analytics summary' });
  }
});

// Wave 7 #2: does an assistant reply read as a decline / abstain?
const ABSTAIN_RE = /\b(?:i\s+(?:cannot|can't|can not|could not|couldn't|am unable to|'m unable to|do not|don't)\s+(?:confirm|find|provide|answer|say|help|have)|(?:unable|not able) to (?:confirm|find|provide|answer)|i(?:'m| am) not sure|i don't know|no (?:information|details) (?:on|about)|please contact (?:us|the team|our team))/i;
function isAbstainText(text) {
  return typeof text === 'string' && ABSTAIN_RE.test(text);
}

// Unanswered / low-confidence feed: assistant turns whose stored grounding
// verdict says the knowledge base did not (fully) back the reply.
router.get('/orgs/:orgId/widgets/:widgetId/analytics/unanswered', requireOrgMembership, async (req, res) => {
  try {
    const { orgId, widgetId } = req.params;
    const widget = prepare('SELECT id FROM website_widgets WHERE id = ? AND org_id = ?').get(widgetId, orgId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const items = [];
    const corrected = [];
    const prevUser = prepare(`
      SELECT content FROM widget_messages
       WHERE conversation_id = ? AND role = 'user' AND created_at <= ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1
    `);
    // w6k: the feed is only turns the bot could not answer (no_knowledge) or
    // held back (withheld). Weak-retrieval answers were mostly correct, so
    // they are not listed. Stripped turns go in `corrected`, and only when
    // the verifier actually found something: a verifier-ok turn with no
    // unsupported claims is a correct answer and is never listed.
    for (const row of scanAssistantTurns(widgetId, req.query)) {
      const ctx = safeJsonParse(row.context_json, null);
      const verdict = classifyGrounding(ctx, row.content);
      // Wave 7 #2: wrong abstains. A figure-gate correction (corrected:true) or
      // a decline reply while retrieval was strong is a likely wrong abstain
      // the customer must be able to see, not only legitimate no_knowledge.
      const gr = (ctx && ctx.grounding) || {};
      const removedFigures = Array.isArray(gr.unsupported_figures) ? gr.unsupported_figures : [];
      let extraReason = null;
      if (verdict !== 'stripped' && verdict !== 'withheld' && verdict !== 'error' && usedOutdatedSource(ctx)) {
        extraReason = 'used_outdated_source';
      } else if (verdict !== 'stripped' && verdict !== 'withheld' && verdict !== 'error' && gr.corrected === true && removedFigures.length > 0) {
        extraReason = 'figure_gate';
      } else if (verdict === 'answered' && isAbstainText(row.content)
        || (verdict === 'low_confidence' && Number(gr.top_score) >= 0.6 && isAbstainText(row.content))) {
        extraReason = 'possible_wrong_abstain';
      }
      if (extraReason) {
        if (items.length < limit) {
          const q = prevUser.get(row.conversation_id, row.created_at);
          items.push({
            message_id: row.id,
            conversation_id: row.conversation_id,
            question: q ? q.content : null,
            answer: typeof row.content === 'string' ? row.content.slice(0, 300) : '',
            reason: extraReason,
            ...(extraReason === 'figure_gate' ? { removed_figures: removedFigures } : {}),
            top_score: Number.isFinite(Number(gr.top_score)) ? Number(gr.top_score) : null,
            created_at: row.created_at,
          });
        }
        continue;
      }
      if (verdict !== 'no_knowledge' && verdict !== 'withheld' && verdict !== 'stripped' && verdict !== 'error') continue;
      if (verdict === 'stripped') {
        const g = ctx.grounding || {};
        const claims = g.claims;
        const cleanClaims = claims && claims.ok === true && (!Array.isArray(claims.unsupported) || claims.unsupported.length === 0);
        if (cleanClaims && !(Array.isArray(g.unsupported_figures) && g.unsupported_figures.length > 0)) continue;
      }
      const target = verdict === 'stripped' ? corrected : items;
      if (target.length >= limit) continue;
      const q = prevUser.get(row.conversation_id, row.created_at);
      target.push({
        message_id: row.id,
        conversation_id: row.conversation_id,
        question: q ? q.content : null,
        answer: typeof row.content === 'string' ? row.content.slice(0, 300) : '',
        reason: verdict === 'stripped' ? 'answer_corrected' : verdict,
        ...(verdict === 'stripped' && typeof gr.served_unsupported === 'boolean' ? { served_unsupported: gr.served_unsupported } : {}),
        created_at: row.created_at,
      });
      if (items.length >= limit && corrected.length >= limit) break;
    }
    res.json({ items, corrected });
  } catch (err) {
    console.error('Error computing unanswered feed:', err);
    res.status(500).json({ error: 'Failed to compute unanswered feed' });
  }
});

router.get('/orgs/:orgId/widgets/:widgetId/analytics/top-questions', requireOrgMembership, async (req, res) => {
  try {
    const { orgId, widgetId } = req.params;
    const widget = prepare('SELECT id FROM website_widgets WHERE id = ? AND org_id = ?').get(widgetId, orgId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const r = analyticsRange(req.query, 'created_at');
    const rows = prepare(`
      SELECT lower(trim(content)) AS question, COUNT(*) AS count
      FROM widget_messages
      WHERE widget_id = ? AND role = 'user' AND length(trim(content)) > 0 AND COALESCE(filtered, 0) = 0 AND ${NOT_TEST_MSG_SQL()}${r.sql}
      GROUP BY lower(trim(content))
      ORDER BY count DESC
      LIMIT ?
    `).all(widgetId, ...r.params, limit);
    res.json({ items: rows });
  } catch (err) {
    console.error('Error computing top questions:', err);
    res.status(500).json({ error: 'Failed to compute top questions' });
  }
});

router.get('/orgs/:orgId/widgets/:widgetId/analytics/source-utilisation', requireOrgMembership, async (req, res) => {
  try {
    const { orgId, widgetId } = req.params;
    const widget = prepare('SELECT id FROM website_widgets WHERE id = ? AND org_id = ?').get(widgetId, orgId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });
    const r = analyticsRange(req.query, 'created_at');
    const rows = prepare(`
      SELECT sources_json FROM widget_messages
      WHERE widget_id = ? AND role = 'assistant' AND sources_json IS NOT NULL AND ${NOT_TEST_MSG_SQL()}${r.sql}
      ORDER BY created_at DESC LIMIT 5000
    `).all(widgetId, ...r.params);
    const counts = {};
    for (const row of rows) {
      const sources = safeJsonParse(row.sources_json, []);
      if (!Array.isArray(sources)) continue;
      for (const s of sources) {
        const key = (s && (s.source || s.name)) || '(unknown)';
        counts[key] = (counts[key] || 0) + 1;
      }
    }
    const items = Object.entries(counts)
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 50);
    res.json({ items, sampled: rows.length });
  } catch (err) {
    console.error('Error computing source utilisation:', err);
    res.status(500).json({ error: 'Failed to compute source utilisation' });
  }
});

router.get('/orgs/:orgId/widgets/:widgetId/analytics/response-times', requireOrgMembership, async (req, res) => {
  try {
    const { orgId, widgetId } = req.params;
    const widget = prepare('SELECT id FROM website_widgets WHERE id = ? AND org_id = ?').get(widgetId, orgId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });
    const deltas = responseTimeDeltas(widgetId, req.query);
    const pct = p => deltas.length ? deltas[Math.min(Math.floor(deltas.length * p), deltas.length - 1)] : null;
    res.json({
      samples: deltas.length,
      p50: pct(0.5), p90: pct(0.9), p99: pct(0.99),
      min: deltas[0] ?? null, max: deltas[deltas.length - 1] ?? null,
    });
  } catch (err) {
    console.error('Error computing response times:', err);
    res.status(500).json({ error: 'Failed to compute response times' });
  }
});

export default router;
