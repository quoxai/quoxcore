// APPROVALS-AUDIT finding 1: a bulk yes (/yestoall, /approve all, /answer 1-3 y) never covers a risky ask.
// A held decision is walked one card at a time, with its full text and its own explicit yes.
// Mirror of services/auth/lib/bulkGuard.js (the server refuses the same set); a test pins the two together.
const LOOSEN = /loosen|\.test\.[a-z]+|\.spec\.[a-z]+|\/tests?\/|__tests__|test[- ]guard|\bguard\b|skip(ping)? (a |the )?test|re-?baseline/i;
const PRIV = /restart|daemon|privileged|elevated|sudo|\bgrant\b.*\btools?\b/i;

export function heldReason(it) {
  const p = it?.payload || {};
  if (p.high_risk === true) return 'high risk';
  if (p.privileged === true) return 'privileged';
  if (p.category === 'loosening' || p.category === 'test_change') return p.category;
  const text = [it?.title, p.why, p.category, ...(Array.isArray(p.paths) ? p.paths : []), p.approval_context?.reason].filter(Boolean).join(' ');
  if (LOOSEN.test(text)) return 'changes a test or guard';
  if (PRIV.test(String(it?.title || ''))) return 'privileged or restart';
  return null;
}
export const isHeldFromBulk = (it) => heldReason(it) !== null;
