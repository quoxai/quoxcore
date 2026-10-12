'use strict';

/**
 * ContactsQ evidence (contract invariant 4). AEE/WARD envelopes NEVER carry a
 * raw identifier, a name or notes. The payload is built from a closed
 * allowlist: org, contact_id, channel, outcome, counts, and `bi_ref` (first
 * 16 hex of sha256(blind_index)). Anything else a caller passes is dropped.
 */

const ALLOWED = ['contact_id', 'channel', 'outcome', 'bi_ref', 'projection', 'reason', 'count', 'candidate_created', 'suppressed', 'lease_id', 'grant_id', 'purpose',
  // P2: policy decisions and flag/stage/consent changes carry stable CODES only.
  'decision', 'reasons', 'pack', 'flags', 'stage', 'status', 'scope', 'counts',
  // P3: touchpoints and edges carry stable CODES / ids only.
  'surface', 'direction', 'edge_type', 'edge_id', 'touchpoint_id',
  // P4: erasure / DSAR / retention carry ids, codes and counts only.
  'erasure_id',
  // P5: import / merge / facts carry ids, codes and counts only.
  'merge_id', 'import_id', 'fact_id', 'format', 'sensitivity', 'review_state',
  // Recurring compliance report: report id + counts only.
  'report_id',
  // P7 sync: the source id, plus counts and outcome codes only.
  'source_id',
  // AOCL classification: set by the emitter only (classifyContactsAocl), never copied from a caller.
  'aocl'];

// Array-valued fields are reduced to short code-shaped strings: free text can never ride along.
const CODE_RE = /^[a-z0-9_.:-]{1,48}$/;
const CODE_ARRAYS = ['reasons', 'flags'];

function buildPayload(orgId, extra = {}) {
  const p = { orgId: orgId || null };
  for (const k of ALLOWED) {
    if (k === 'aocl' || extra[k] === undefined) continue;
    if (CODE_ARRAYS.includes(k)) {
      p[k] = Array.isArray(extra[k]) ? extra[k].filter((v) => typeof v === 'string' && CODE_RE.test(v)) : [];
    } else if (k === 'counts') {
      // Numbers only, keyed by code-shaped names: never free text.
      const c = {};
      for (const [n, v] of Object.entries(extra[k] || {})) if (CODE_RE.test(n) && Number.isFinite(v)) c[n] = v;
      p[k] = c;
    } else p[k] = extra[k];
  }
  return p;
}

/**
 * AOCL classification for every quox.contacts.* envelope, stamped here at the one emitter so no route can forget it
 * (same idea as quox.slot.* in devSlotEvidence.js). Layers per docs/AOCL.md: L3 Policy (is it allowed), L5 Context
 * (what do we know: reads), L7 Execute (writes and effects). Risk: HIGH for anything that reaches or reveals a person
 * or destroys data (leases, sends, full reads, erasure, lifting a tombstone); MEDIUM for bulk or reversible structure
 * changes; LOW for reads and small writes. Autonomy: FULL for scheduled service runs, ASSISTED otherwise.
 * An intent nobody has classified is MEDIUM at L7, never silently LOW.
 */
const AOCL_POLICY = new Set(['policy.decision', 'lease.denied', 'suppress_check']);
const AOCL_CONTEXT = new Set(['read', 'find', 'search', 'resolve', 'brief', 'timeline_read', 'facts_read', 'handoffs_read', 'duplicates', 'import_dry_run', 'sync_dry_run']);
const AOCL_HIGH = new Set(['lease.minted', 'lease.redeemed', 'lease.claimed', 'send', 'read_full', 'erased', 'retention_run', 'tombstone_lifted']);
const AOCL_MEDIUM = new Set(['merge', 'unmerge', 'import', 'rewrap', 'reindex', 'strict_names_applied', 'grant_create', 'grant_revoke', 'settings_update', 'sync_run', 'sync_source_add', 'sync_source_remove', 'sync_source_update', 'dsar_exported', 'processing_record_exported', 'lease.revoked']);
const AOCL_LOW_WRITES = new Set(['create', 'archive', 'consent', 'edge_add', 'edge_remove', 'fact_add', 'fact_proposed', 'fact_review', 'flags_changed', 'identifier_add', 'notice_sent', 'objection', 'photo_removed', 'photo_set', 'stage_changed', 'suppress', 'touchpoint', 'compliance_report']);

function classifyContactsAocl(intent, actor) {
  const k = String(intent || '').replace(/^quox\.contacts\./, '');
  const autonomy = actor === 'service' ? 'FULL' : 'ASSISTED';
  if (AOCL_POLICY.has(k)) return { layer: 3, risk: 'LOW', autonomy };
  if (AOCL_CONTEXT.has(k)) return { layer: 5, risk: 'LOW', autonomy };
  if (AOCL_HIGH.has(k)) return { layer: 7, risk: 'HIGH', autonomy };
  if (AOCL_MEDIUM.has(k)) return { layer: 7, risk: 'MEDIUM', autonomy };
  if (AOCL_LOW_WRITES.has(k)) return { layer: 7, risk: 'LOW', autonomy };
  return { layer: 7, risk: 'MEDIUM', autonomy };
}

function createEmitter(audit) {
  return function emit(intent, ctx, extra) {
    if (typeof audit !== 'function') return;
    try {
      const who = (ctx && ctx.actor) || 'service';
      const id = (ctx && (ctx.agentId || ctx.userId)) || 'unknown';
      audit({
        from: `${who === 'human' ? 'human' : who === 'agent' ? 'agent' : 'service'}.${id}`,
        type: 'action',
        intent,
        corr: (extra && extra.contact_id) || null,
        payload: { ...buildPayload(ctx && ctx.orgId, extra), aocl: classifyContactsAocl(intent, who) },
      });
    } catch (e) {
      // Evidence must never fail the caller's request; surface it in the log.
      console.error('[contactsq] evidence emit failed:', e && e.message);
    }
  };
}

module.exports = { createEmitter, buildPayload, ALLOWED, classifyContactsAocl };
