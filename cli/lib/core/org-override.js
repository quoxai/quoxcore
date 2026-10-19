/**
 * org-override.js — what `--org` is allowed to mean (GRIPE-709).
 *
 * A user access token is bound to ONE org (its org_id claim). `--org` used to
 * be read only by verbs that build /api/orgs/<id>/... paths; every other verb
 * (notes, whoami, ...) ignored it and answered from the session org, so
 * `quox --org B notes ls` silently returned org A's data. The server offers no
 * per-request org header, only a governed switch (`quox org switch`), so the
 * safe contract is:
 *
 *   - flag absent                      -> fine
 *   - flag names the session org       -> fine (id, slug or name)
 *   - flag names ANY OTHER org while a
 *     user session is active           -> REFUSE, never fall back
 *   - service-key-only invocation      -> allowed (no session org to disagree
 *     with; the key's verbs take the org explicitly)
 */
import { QuoxValidationError } from './errors.js';

// Commands where --org legitimately means something other than "act in".
export const EXEMPT = new Set(['login', 'logout', 'signup', 'org switch', 'invites list', 'invites accept']);

export function commandPath(cmd) {
  const parts = [];
  for (let c = cmd; c && c.parent; c = c.parent) parts.unshift(c.name());
  return parts.join(' ');
}

/**
 * @param {object} args
 * @param {string|undefined} args.override  value of --org
 * @param {object|null} args.authData       stored auth (org_id/org_slug/org_name)
 * @param {boolean} args.hasUserToken
 * @param {string} [args.command]           e.g. 'notes ls'
 * @throws {QuoxValidationError} when the override differs from the session org
 */
export function assertOrgOverrideSafe({ override, authData, hasUserToken, command = '' }) {
  if (!override || !hasUserToken || EXEMPT.has(command)) return;
  const want = String(override).toLowerCase();
  const sid = authData?.org_id || null;
  const known = [sid, authData?.org_slug, authData?.org_name]
    .filter(Boolean).map(v => String(v).toLowerCase());
  if (known.includes(want)) return;
  const current = sid
    ? `${authData.org_slug || authData.org_name || sid}${authData.org_slug || authData.org_name ? ` (${sid})` : ''}`
    : 'none';
  throw new QuoxValidationError(
    `--org ${override} differs from your session org ${current}; `
    + `run \`quox org switch ${override}\` or use a profile for that org. `
    + 'Refusing to act in a different org than the one named.'
  );
}
