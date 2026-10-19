/**
 * APPROVAL-WHAT: the collector side of the "say what will happen" contract.
 *
 * Every approval item carries payload.what = { action, target | target_none, summary }.
 * The auth inbox route refuses (422) an approval without it; this helper lets each
 * collector creator build it and fail BEFORE the network call. Same rules as
 * services/auth/lib/approvalWhat.js (kept in step by both test files).
 * It only describes the item; it never changes who may approve it.
 */
'use strict';

const GENERIC = /^(?:approval(?:\s+(?:required|needed|requested|request))?|action|n\/?a|none|unknown|tool|run(?:\s+tool)?|approve|todo|tbd)\b[\s.:!-]*$/i;
const str = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : (typeof v === 'number' ? String(v) : ''));
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const generic = (s) => !s || GENERIC.test(s) || /^approval (?:required|needed)\b/i.test(s);

/** Returns { ok, what } or { ok:false, error }. */
function checkWhat(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'payload.what is missing' };
  const action = str(raw.action);
  const target = str(raw.target);
  const targetNone = str(raw.target_none ?? raw.targetNone);
  const summary = str(raw.summary);
  if (generic(action)) return { ok: false, error: `what.action must name the action or tool (got ${JSON.stringify(raw.action ?? null)})` };
  if (!target && !targetNone) return { ok: false, error: 'what needs a target (host, recipient, id) or target_none saying why there is none' };
  if (generic(summary) || summary.length < 4) return { ok: false, error: `what.summary must say in one line what will happen (got ${JSON.stringify(raw.summary ?? null)})` };
  return {
    ok: true,
    what: {
      action: clip(action, 120),
      target: target ? clip(target, 200) : null,
      ...(target ? {} : { target_none: clip(targetNone, 200) }),
      summary: clip(summary, 280),
    },
  };
}

/** Build a payload.what; throws approval_undescribed when it cannot say what will happen. */
function approvalWhat({ action, target = null, targetNone = null, target_none = null, summary } = {}) {
  const r = checkWhat({ action, target, target_none: targetNone || target_none, summary });
  if (!r.ok) throw new Error(`approval_undescribed: ${r.error}`);
  return r.what;
}

/** Guard for a mint: a kind 'approval' item must carry a valid payload.what. */
function assertApprovalWhat({ kind, payload } = {}) {
  if (kind !== 'approval') return;
  const r = checkWhat(payload && payload.what);
  if (!r.ok) throw new Error(`approval_undescribed: ${r.error}`);
}

module.exports = { approvalWhat, assertApprovalWhat, checkWhat };
