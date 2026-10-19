/**
 * CLI-ERRORS (owner 2026-10-17): "Already approved by <who> at <time>; nothing to do".
 * Mirrors services/auth/lib/alreadyResolved.js so an older server (no `resolution` in its
 * 400 body) still gets the same one-line answer from the card itself.
 */
import { QuoxUserError } from './errors.js';

const APPROVE = new Set(['approve', 'approved', 'accept', 'accepted', 'grant', 'granted']);
const DENY = new Set(['deny', 'denied', 'dismissed', 'reject', 'rejected']);

function normalise(action) {
  const a = String(action || '').trim().toLowerCase();
  if (APPROVE.has(a)) return 'approved';
  if (DENY.has(a)) return 'rejected';
  if (a === 'answer') return 'answered';
  if (a === 'defer') return 'deferred';
  if (a === 'request_changes') return 'changes requested';
  return a ? 'resolved' : null;
}

/** A y/n decision answered "y" reads as approved, "n" as rejected; another option as answered "<key>". */
function outcomeOf(prior) {
  const opt = prior && typeof prior.option === 'string' ? prior.option : null;
  if (opt === 'y') return 'approved';
  if (opt === 'n') return 'rejected';
  const n = normalise(prior?.action);
  return n === 'answered' && opt ? `answered "${opt}"` : n;
}

function toIso(ts) {
  if (!ts) return null;
  const s = String(ts);
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function humanUtc(iso) {
  return iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : 'an unknown time';
}

export function resolutionFromItem(item, requestedAction) {
  if (!item || !item.id) return null;
  const response = item.response || null;
  const outcome = item.status === 'expired' ? 'expired' : item.status === 'cancelled' ? 'cancelled' : (outcomeOf(response) || 'resolved');
  const name = item.resolved_by_name || response?.responded_by_name || null;
  const at = toIso(item.resolved_at) || toIso(response?.responded_at) || null;
  const requested = String(requestedAction || '').trim().toLowerCase() || null;
  const matches = Boolean(requested) && outcome !== 'expired' && outcome !== 'cancelled' && normalise(requested) === outcome;
  let message;
  if (outcome === 'expired') message = `This approval expired at ${humanUtc(at)}; nothing was approved. Ask for it again.`;
  else if (outcome === 'cancelled') message = `This item was cancelled at ${humanUtc(at)}${name ? ` by ${name}` : ''}; there is nothing to respond to.`;
  else {
    const head = `Already ${outcome}${name ? ` by ${name}` : ''} at ${humanUtc(at)}`;
    message = matches || !requested ? `${head}; nothing to do.` : `${head}; your ${requested} was not applied.`;
  }
  return { item_id: item.id, status: item.status, outcome, resolved_by: item.resolved_by || null, resolved_by_name: name, resolved_at: at, requested, matches, message };
}

/** A respond whose outcome does NOT match what is already recorded: exit 6 (conflict). */
export function alreadyResolvedError(resolution, cause) {
  return new QuoxUserError(resolution.message, {
    next: `\`quox inbox show ${resolution.item_id}\` shows the decision.`,
    exitCode: 6, code: 'already_resolved', status: cause?.status, body: cause?.body,
  });
}
