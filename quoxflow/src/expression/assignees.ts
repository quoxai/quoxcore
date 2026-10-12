/**
 * assignTo normaliser
 *
 * The dashboard schema and WEAVER's prompt both say `assignTo` is an
 * array of user/team ULIDs (or `["*"]` for everyone). In practice WEAVER
 * routinely emits one of these wrong shapes:
 *
 *   - "admin@email.com"                       (single email string)
 *   - "*"                                    (string instead of array)
 *   - "{{PLACEHOLDER:your-team-id}}"         (unresolved template literal)
 *   - "${vars.recipient}"                    (expression that didn't resolve)
 *   - undefined                               (field omitted entirely)
 *
 * Coerce all of these to a sensible array. Email values are dropped
 * (the inbox routes by org membership, not address — emails are not IDs).
 * Empty / placeholder / unresolved values fall back to `["*"]`. If the
 * caller already passed an array, we filter out the same junk values.
 *
 * Used by human-task and notification-deliver. Centralised so that a
 * future third inbox-creating node type can't drift.
 */

const PLACEHOLDER_RE = /^\{\{.*\}\}$|^\$\{.*\}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isUsableId(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const trimmed = s.trim();
  if (trimmed.length === 0) return false;
  if (PLACEHOLDER_RE.test(trimmed)) return false;
  if (EMAIL_RE.test(trimmed)) return false;
  return true;
}

export function normaliseAssignTo(value: unknown): string[] {
  if (value === undefined || value === null) return ['*'];
  if (typeof value === 'string') {
    return isUsableId(value) ? [value.trim()] : ['*'];
  }
  if (Array.isArray(value)) {
    const filtered = value.filter(isUsableId).map(s => s.trim());
    return filtered.length > 0 ? filtered : ['*'];
  }
  return ['*'];
}
