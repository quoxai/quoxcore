/**
 * Shared helpers for command modules
 */

import { QuoxValidationError, QuoxNetworkError } from '../core/errors.js';

/**
 * Resolve the active org ID from --org flag or stored auth.
 * Throws if no org context is available.
 */
export function resolveOrgId(auth, program) {
  const orgId = auth.getOrgId(program.opts().org);
  if (!orgId) {
    // Ask about AUTH before blaming the org, because a logged-out user has no
    // org for the obvious reason, and telling them to switch org sends them
    // down a path that cannot work.
    //
    // 2026-08-18: a new-user setup audit ran `quox slot create audit-demo` on
    // a shell with no token. It answered "No active org. Use --org <id> or
    // `quox org switch <id>` first." Following that instruction gave a
    // DIFFERENT error, "No authentication token provided ... Run `quox login`".
    // Two errors, two dead ends, and the real first step named only in the
    // second one. The owner's standing complaint about this bundle is that it
    // is not "easy as pie" to set up; this was the very first command in that
    // path, and it misdirected.
    //
    // Every command that needs an org goes through here, so the fix lands once
    // for all of them.
    auth.requireAuth();

    // requireAuth() passing does NOT mean a USER is logged in. isLoggedIn()
    // also accepts an ambient QUOX_SERVICE_KEY as the automation fallback, and
    // a service key carries no organisation — so on any box that exports one
    // globally (every dev box here does) a logged-out user sails past the auth
    // check and lands on "No active org", which sends them to `quox org
    // switch` when the real first step is `quox login`.
    //
    // 2026-08-19: reproduced exactly that with `quox slot list --profile local`
    // on a shell with QUOX_SERVICE_KEY exported. This is the SAME misdirection
    // the 2026-08-18 note above set out to kill, arriving through the one door
    // that check cannot see: the fix asked "are you authenticated?" when the
    // question that matters is "authenticated AS WHOM?".
    const hasUserToken = Boolean(auth.getTokens?.()?.access_token);
    if (!hasUserToken) {
      throw new Error(
        'Authenticated with a service key, which has no organisation. '
        + 'Run `quox login` to act as a user, or pass --org <id> to name the org explicitly.'
      );
    }

    throw new Error('No active org. Use --org <id>, or pick one with `quox org list` then `quox org switch <id>`.');
  }
  return orgId;
}

/**
 * Safely parse a JSON string from CLI input.
 * Throws QuoxValidationError with a clear message on invalid JSON.
 */
export function parseJSON(value, label = 'JSON') {
  try {
    return JSON.parse(value);
  } catch {
    throw new QuoxValidationError(`Invalid ${label}: not valid JSON. Check your input and try again.`);
  }
}

/**
 * Build a query object from common list options.
 */
export function buildListQuery(options) {
  const query = {};
  if (options.limit) query.limit = options.limit;
  if (options.offset) query.offset = options.offset;
  if (options.search) query.search = options.search;
  if (options.status) query.status = options.status;
  if (options.sort) query.sort = options.sort;
  return query;
}

/**
 * Run a request; if it times out, rethrow with what timed out and how to narrow
 * it (still a QuoxNetworkError, so the exit code stays 7). A bare
 * "Request timed out after 30000ms" does not tell the operator which call hung
 * or what to try (quox#806, quox#807).
 */
export async function withTimeoutHint(what, hint, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof QuoxNetworkError && /timed out/i.test(err.message || '')) {
      throw new QuoxNetworkError(`${what} timed out (${err.message}). ${hint}`, err);
    }
    throw err;
  }
}
