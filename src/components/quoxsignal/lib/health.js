/**
 * Source health classification. A source that is "error", "empty" or
 * "needs-cookies" must look obviously wrong at a glance in the Sources view
 * — see the standalone app's README (TikTok stale-feed failure mode), the
 * exact case this exists to surface instead of hiding.
 *
 * Ported verbatim from quox-signal/web/src/lib/health.js.
 */
export const BAD_HEALTH = new Set(['error', 'empty', 'needs-cookies']);

export function isHealthBad(health) {
  return BAD_HEALTH.has(health);
}

export function healthLabel(health) {
  if (!health || health === 'unknown') return 'unknown';
  return health;
}

/**
 * A source can report health "ok" and still be silently dead.
 *
 * The dangerous case, straight from the source code's own comment: TikTok answers a request
 * for several posts with one stale post and this is deliberately treated as healthy, because
 * a small account and a throttled one look identical from outside. So "ok" cannot be trusted
 * on its own, and a green pill for a feed that has not produced anything in days is the worst
 * kind of dishonesty: there is no error for the user to notice.
 *
 * last_polled is the one honest signal the client already has. A source that has not been
 * polled within the window is reported as "ok, stale" rather than a confident green.
 */
export const STALE_POLL_HOURS = 36;

export function isStalePoll(lastPolled, now = Date.now()) {
  if (!lastPolled) return true;
  const t = new Date(lastPolled).getTime();
  if (!Number.isFinite(t)) return true;
  return now - t > STALE_POLL_HOURS * 3600 * 1000;
}

/**
 * Split sources into the two ways a feed lies to you, for surfacing on the Feed itself.
 *
 * WHY this is not left to the Sources tab: health there is per-row and correct, but the Feed
 * is the surface the user actually lives in, and both failure modes below are INVISIBLE from
 * it. A broken source and a source with genuinely nothing new produce the identical Feed: a
 * calm list. The user reads calm as "nothing happened" when it may mean "I stopped looking".
 * Health has to be where the absence is felt, not one click away behind a tab the user has no
 * reason to open precisely when it matters most.
 *
 * `bad` is an explicit failure the poller reported. `stale` is the quieter one: health says
 * "ok" but nothing has been polled inside the window, which is the TikTok throttle case in
 * isStalePoll's note above. They are kept separate because the honest wording differs, one is
 * "this is broken" and the other is only "this has gone quiet, it may be fine".
 */
export function unhealthySources(sources = [], now = Date.now()) {
  const bad = [];
  const stale = [];
  for (const s of sources) {
    if (isHealthBad(s?.health)) bad.push(s);
    else if (isStalePoll(s?.last_polled, now)) stale.push(s);
  }
  return { bad, stale };
}
