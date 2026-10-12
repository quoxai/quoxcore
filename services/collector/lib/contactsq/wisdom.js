'use strict';

/**
 * ContactsQ -> QuoxMind outcome recorder. Every governed outcome that teaches something about how the
 * contacts layer is used (a lease released, a lease denied by policy with its reason codes, an objection,
 * a committed import, an erasure) is recorded to the tasks wisdom store, the same sink NotesQ uses
 * (lib/notesqWisdom.js). CODES AND COUNTS ONLY: the input is the already-allowlisted evidence payload,
 * and this module re-filters it, so a name, identifier value or free text can never reach QuoxMind.
 * Fail-soft: it never throws and never blocks the caller; failures are counted and logged rate-limited.
 */

const CODE_RE = /^[a-z0-9_.:-]{1,48}$/;
const FETCH_TIMEOUT_MS = 5000;
const LOG_EVERY_MS = 60000;

const TASKS_URL = () => `http://${process.env.TASKS_HOST || 'tasks'}:${process.env.TASKS_PORT || '3104'}`;
const KEY = () => process.env.INTERNAL_SERVICE_KEY || '';

const code = (v) => (typeof v === 'string' && CODE_RE.test(v) ? v : null);
const reasonCodes = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter((s) => CODE_RE.test(s)) : []);
const countsText = (c) => Object.entries(c || {}).filter(([k, n]) => CODE_RE.test(k) && Number.isFinite(n)).map(([k, n]) => `${k}=${n}`).join(' ');

/**
 * Map one evidence event to zero or more outcome records { pattern_name, lesson, severity, tags }.
 * Pure. Returns [] for events that are not outcomes worth teaching.
 */
function toOutcomes(intent, extra = {}) {
  const e = extra || {};
  switch (intent) {
    case 'quox.contacts.lease.redeemed': {
      const proj = code(e.projection);
      const kind = proj === 'context' ? 'context' : (code(e.channel) || 'unknown');
      return [{ pattern_name: `contactsq:lease_redeemed:${kind}`, lesson: `A ContactsQ ${kind} lease was redeemed (released to the caller).`, severity: 'info', tags: ['contactsq', 'lease_redeemed', kind] }];
    }
    case 'quox.contacts.lease.denied': {
      const reasons = reasonCodes(e.reason);
      const list = reasons.length ? reasons : ['unspecified'];
      return list.map((r) => ({ pattern_name: `contactsq:lease_denied:${r}`, lesson: `A ContactsQ lease was denied by policy (reason code ${r}).`, severity: 'low', tags: ['contactsq', 'lease_denied', r] }));
    }
    case 'quox.contacts.objection': {
      const scope = code(e.scope) || 'unknown';
      return [{ pattern_name: `contactsq:objection:${scope}`, lesson: `An objection was recorded (scope ${scope}, purposes ${Number.isFinite(e.count) ? e.count : 0}).`, severity: 'info', tags: ['contactsq', 'objection', scope] }];
    }
    case 'quox.contacts.import': {
      const c = countsText(e.counts);
      return [{ pattern_name: 'contactsq:import_committed', lesson: `A contacts import was committed${c ? ` (${c})` : ''}.`, severity: 'info', tags: ['contactsq', 'import_committed'] }];
    }
    case 'quox.contacts.erased': {
      // The retention reaper erases in bulk: it is taught once through retention_run, not once per contact.
      if (e.reason === 'retention_expired') return [];
      const scope = code(e.scope) || 'unknown';
      const c = countsText(e.counts);
      return [{ pattern_name: `contactsq:erased:${scope}`, lesson: `A contact erasure was executed (scope ${scope}${c ? `, ${c}` : ''}).`, severity: 'info', tags: ['contactsq', 'erased', scope] }];
    }
    case 'quox.contacts.retention_run': {
      const status = code(e.outcome) || 'unknown';
      const c = countsText(e.counts);
      return [{ pattern_name: `contactsq:retention_run:${status}`, lesson: `The ContactsQ retention reaper ran (${status}${c ? `, ${c}` : ''}).`, severity: status === 'ok' ? 'info' : 'low', tags: ['contactsq', 'retention_run', status] }];
    }
    default:
      return [];
  }
}

/** Default sink: POST to the tasks wisdom store. Returns true on success. Throws on failure (the recorder counts it). */
async function postWisdom(orgId, o) {
  if (!KEY()) return false;
  const res = await fetch(`${TASKS_URL()}/api/wisdom`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Key': KEY(), 'X-Org-Id': orgId || 'default' },
    body: JSON.stringify({
      org_id: orgId || 'default', pattern_name: o.pattern_name, category: 'contactsq', lesson: o.lesson,
      directive: 'Track how often this ContactsQ outcome occurs before changing policy or agent behaviour around it.',
      severity: o.severity, tags: o.tags,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return true;
}

/** @param {{ record?: (orgId: string, outcome: object) => Promise<any>|any }} deps record = injectable sink (tests use a stub). */
function createOutcomeRecorder({ record = postWisdom } = {}) {
  let failures = 0;
  let lastLogAt = 0;
  function noteFailure(err) {
    failures += 1;
    const now = Date.now();
    if (now - lastLogAt >= LOG_EVERY_MS) {
      lastLogAt = now;
      console.warn(`[contactsq] QuoxMind outcome record failed (non-fatal, ${failures} total): ${err && err.message ? err.message : 'error'}`);
    }
  }
  /** Fire-and-forget. Never throws, never returns a rejecting promise. */
  function observe(intent, ctx, extra) {
    try {
      const orgId = ctx && ctx.orgId;
      if (!orgId) return;
      for (const o of toOutcomes(intent, extra)) {
        Promise.resolve().then(() => record(orgId, o)).catch(noteFailure);
      }
    } catch (e) { noteFailure(e); }
  }
  return { observe, failureCount: () => failures };
}

module.exports = { toOutcomes, createOutcomeRecorder, postWisdom };
