/**
 * SIGNAL-AUDIT 2026-09-18: discard moved SERVER-SIDE (items.dismissed_at via
 * POST /items/:id/dismiss). The original client-only localStorage set was
 * written when the API had no dismissed column; that column now exists, and
 * the localStorage posture violated the house persistence rule the moment
 * the owner expected discards to actually stick ("no way to discard posts" —
 * they did not survive/travel). This file now only drains the legacy set
 * into the server, once, then removes the key.
 */
const LEGACY_KEY = 'quoxsignal.discarded-ids';

/**
 * One-shot migration: push any localStorage-era discarded ids to the server,
 * then clear the key so this never runs again. Failures leave the key in
 * place (retried next mount); unknown ids (404) are dropped silently — the
 * item is gone, there is nothing left to discard.
 * @returns {Promise<number>} how many ids were migrated
 */
export async function drainLegacyDiscards(api) {
  let ids = [];
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    ids = raw ? JSON.parse(raw) : [];
  } catch {
    return 0;
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    try { localStorage.removeItem(LEGACY_KEY); } catch { /* nothing to clean */ }
    return 0;
  }

  let migrated = 0;
  for (const id of ids) {
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential on purpose: tiny list, avoids hammering the proxy
      await api.dismissItem(id);
      migrated += 1;
    } catch (err) {
      if (err?.status !== 404) throw err; // real failure: keep the key, retry next mount
    }
  }
  try { localStorage.removeItem(LEGACY_KEY); } catch { /* best effort */ }
  return migrated;
}
