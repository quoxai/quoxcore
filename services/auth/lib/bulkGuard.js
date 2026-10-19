// APPROVALS-AUDIT finding 1, defence in depth: the respond route refuses a bulk yes to a risky decision.
// Mirror of cli/lib/quoxon/bulkRisk.js (a test pins the two together).
const LOOSEN = /loosen|\.test\.[a-z]+|\.spec\.[a-z]+|\/tests?\/|__tests__|test[- ]guard|\bguard\b|skip(ping)? (a |the )?test|re-?baseline/i;
const PRIV = /restart|daemon|privileged|elevated|sudo|\bgrant\b.*\btools?\b/i;

export function bulkHeldReason(title, p = {}) {
  if (p.high_risk === true) return 'high risk';
  if (p.privileged === true) return 'privileged';
  if (p.category === 'loosening' || p.category === 'test_change') return p.category;
  const text = [title, p.why, p.category, ...(Array.isArray(p.paths) ? p.paths : []), p.approval_context?.reason].filter(Boolean).join(' ');
  if (LOOSEN.test(text)) return 'changes a test or guard';
  if (PRIV.test(String(title || ''))) return 'privileged or restart';
  return null;
}
