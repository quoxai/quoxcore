/**
 * First-run onboarding logic: the dashboard's mirror of quox-signal/lib/onboard.js.
 *
 * House rule: nothing ships without CLI support and the dashboard mirrors it. `signal
 * onboard` is the primary surface; this file walks the identical steps (discover, session
 * check, lens, autonomy + cap, first look) against the identical server routes through the
 * collector proxy. It is a short local copy rather than a cross-repo import, the same
 * posture as lib/autonomy.js and lib/sourcePlatforms.js in this directory. Keep the
 * wording in sync by hand: quox-signal/lib/onboard.js names this file in its header.
 *
 * Nothing new is invented here. Every step maps to an existing verb:
 *   discover -> resolveSource()/PLATFORMS      (quox-signal lib/sources.js)
 *   cookies  -> `signal cookies`               (session jars live on the CLI host, not here)
 *   lens     -> POST /sources { lens }         (same field `signal lens set` patches)
 *   autonomy -> POST /sources { autonomy_level }
 *   cap      -> PATCH /budgets/source/:id
 *
 * Topics are deliberately absent: they come out of triage output, so there is no topic
 * registry to seed and building one here would be a second store of something the pipeline
 * already produces.
 */

export const DEFAULT_ONBOARD_LENS = 'quox-roadmap';
export const DEFAULT_ONBOARD_AUTONOMY = 'manual';
/** quox-signal/lib/autonomy.js DEFAULT_DAILY_CAP_USD, and migration 009_budgets.sql's default. */
export const DEFAULT_ONBOARD_CAP_USD = 1.0;

/** The single least obvious concept in the product, said where the choice is made. */
export const LENS_EXPLAINER = 'A lens is the question triage asks about every item from this source. '
  + 'It decides what counts as relevant, so it is the one setting that changes what reaches you.';

/** Spending is an explicit choice at onboarding, never a default discovered on an invoice. */
export const SPEND_EXPLAINER = 'Autonomy decides how far the worker may go on this source without asking you, '
  + 'and every stage past discovery spends money. The daily cap is the ceiling that stops it.';

/* Mirrors quox-signal/lib/fetch.js platformOf(). */
export function platformOf(url) {
  if (/tiktok\.com/i.test(url)) return 'tiktok';
  if (/instagram\.com/i.test(url)) return 'instagram';
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
  if (/x\.com|twitter\.com/i.test(url)) return 'x';
  return 'web';
}

/* Mirrors quox-signal/lib/sources.js PLATFORMS, minus the URL builders (this surface only
   ever sees a pasted URL, never a bare handle needing a profile URL built for it). */
const PLATFORM_FACTS = {
  // Verified working without a session on 2026-07-27.
  tiktok: { needsCookies: false },
  // yt-dlp's instagram:user extractor is marked broken upstream, so account enumeration
  // does not work at any cookie level. Single reel/post URLs do work.
  instagram: { needsCookies: true, enumerationBroken: true },
  youtube: { needsCookies: false },
  x: { needsCookies: true }
};

const FEED_URL = /\.xml($|\?)|\/feed\/?$|\/rss\/?$|feeds\./i;

/** Mirrors quox-signal/lib/sources.js handleFromAccountUrl(). */
function handleFromAccountUrl(url) {
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean)[0];
    if (!segment) return null;
    return segment.replace(/^@/, '').trim() || null;
  } catch {
    return null;
  }
}

/** Mirrors quox-signal/lib/sources.js labelFromUrl(): last meaningful path segment, never a mid-word chop. */
export function labelFromUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return String(rawUrl).replace(/^https?:\/\//, '').split('/')[0] || String(rawUrl);
  }
  const host = u.hostname.replace(/^www\./, '');
  const segments = u.pathname.split('/').filter(Boolean);
  const generic = /^(feed|feeds|rss|atom|index|api|json|all)(\.\w+)?$/i;
  const versionish = /^v?\d+(\.\d+)*$/i;
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const seg = segments[i];
    if (!seg || generic.test(seg) || versionish.test(seg)) continue;
    const stem = seg.replace(/\.(json|xml|rss|atom|html?)$/i, '').replace(/[_\s]+/g, '-');
    return `${host}/${stem}`.slice(0, 60);
  }
  return host;
}

/**
 * Per-platform truth at the moment the user pastes a URL, never a footnote. Mirrors
 * quox-signal/lib/onboard.js sourceNotes(), minus the cookie-jar file check: the jars live
 * on the machine running the CLI worker, not in the browser, so this surface can say a
 * session is REQUIRED but must never claim to know whether one is present.
 *
 * Nothing here blocks. A source that needs a session is added and marked, never refused.
 */
export function sourceNotes({ platform, kind }) {
  const facts = PLATFORM_FACTS[platform];
  const notes = [];

  if (!facts) {
    if (kind === 'account') {
      notes.push({
        level: 'warn',
        code: 'kind-guess',
        text: 'No known platform matched this URL, and its path does not look like a feed (no .xml, /feed, /rss), '
          + 'so it was read as an account and would be polled with yt-dlp. '
          + 'If this is actually an RSS or Atom feed, switch the kind to "feed": a feed needs no session and no yt-dlp.'
      });
    }
    return notes;
  }

  if (kind === 'account' && facts.enumerationBroken) {
    notes.push({
      level: 'broken',
      code: 'enumeration-broken',
      text: `${platform} account following is BROKEN upstream in yt-dlp: its ${platform}:user extractor is marked broken, `
        + 'so account enumeration returns nothing at any cookie level and no session fixes it. '
        + `Single ${platform} post/reel URLs DO work: follow one of those instead, or add this account now `
        + 'and expect it to sit at health "extractor-broken" until yt-dlp fixes the extractor upstream.'
    });
  }

  if (kind === 'account' && facts.needsCookies) {
    notes.push({
      level: 'warn',
      code: 'cookies-required',
      text: `${platform} account feeds are session-gated. The cookie jar lives on the machine running the QuoxSignal `
        + `worker, not in this browser: export a Netscape cookies.txt for ${platform} from your logged-in browser to `
        + `~/.quox-signal/cookies/${platform}.txt and check it with "signal cookies". `
        + 'Adding it now anyway: it gets followed and marked, and starts working the moment the cookie lands.'
    });
  }

  return notes;
}

/** True when a plan carries a note that means the first poll cannot succeed yet. */
export function isDegraded(plan) {
  return (plan.notes || []).some((n) => n.level === 'broken' || n.level === 'warn');
}

/**
 * Step (a): turn a pasted URL into a described, editable draft. Mirrors the URL branch of
 * quox-signal/lib/sources.js resolveSource() plus lib/onboard.js describeTarget().
 */
export function describeUrl(rawUrl, { kind = null } = {}) {
  const url = String(rawUrl || '').trim();
  if (!url) throw new Error('paste a URL to follow');
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('paste a full URL starting with http(s). A bare @handle can only be followed from the CLI '
      + '(signal follow @handle --on <platform>), which resolves it against the platform first.');
  }
  const platform = platformOf(url);
  const resolvedKind = kind || (FEED_URL.test(url) ? 'feed' : 'account');
  const handle = resolvedKind === 'account' && PLATFORM_FACTS[platform] ? handleFromAccountUrl(url) : null;
  return {
    url,
    platform,
    kind: resolvedKind,
    handle,
    label: handle || labelFromUrl(url),
    lens: DEFAULT_ONBOARD_LENS,
    autonomy: DEFAULT_ONBOARD_AUTONOMY,
    daily_cap_usd: DEFAULT_ONBOARD_CAP_USD,
    notes: sourceNotes({ platform, kind: resolvedKind })
  };
}

/**
 * Steps (b/c/d), committed. Mirrors quox-signal/lib/onboard.js applyOnboarding():
 *
 *  - IDEMPOTENT BY URL. An already-followed source is reported and left exactly as it is.
 *    Re-running must never quietly re-apply a spend ceiling, and the server's own 409 on a
 *    duplicate url is caught as the second line of defence.
 *  - A degraded source is still created. The gap is environmental, so the note travels with
 *    the result instead of the source being refused.
 *  - The cap is a second write (it lives on the budgets table). A cap that fails to apply is
 *    reported: a source running on an unconfirmed ceiling must never read as fully configured.
 */
export async function applyOnboarding(drafts, { existingSources = [], createSource, setSourceDailyCap }) {
  const byUrl = new Map((existingSources || []).map((s) => [s.url, s]));
  const results = [];

  for (const draft of drafts) {
    const already = byUrl.get(draft.url);
    if (already) {
      results.push({
        url: draft.url,
        label: already.label,
        status: 'existing',
        source: already,
        lens: already.lens || DEFAULT_ONBOARD_LENS,
        autonomy_level: already.autonomy_level,
        notes: draft.notes || []
      });
      continue;
    }

    let created;
    try {
      created = await createSource({
        url: draft.url,
        platform: draft.platform,
        kind: draft.kind,
        handle: draft.handle ?? null,
        label: draft.label,
        lens: draft.lens,
        autonomy_level: draft.autonomy
      });
    } catch (e) {
      if (e.status === 409) {
        results.push({ url: draft.url, label: draft.label, status: 'existing', notes: draft.notes || [] });
        continue;
      }
      results.push({
        url: draft.url,
        label: draft.label,
        status: 'error',
        error: e.body?.error || e.message,
        notes: draft.notes || []
      });
      continue;
    }

    let capUsd = null;
    let capError = null;
    try {
      const budget = await setSourceDailyCap(created.id, draft.daily_cap_usd);
      capUsd = budget.daily_cap_usd;
    } catch (e) {
      capError = e.body?.error || e.message;
    }

    byUrl.set(draft.url, created);
    results.push({
      url: draft.url,
      label: created.label,
      status: 'created',
      source: created,
      lens: created.lens || draft.lens,
      autonomy_level: created.autonomy_level,
      daily_cap_usd: capUsd,
      cap_error: capError,
      notes: draft.notes || []
    });
  }

  return results;
}

/**
 * Step (e), honestly.
 *
 * The CLI runs a real poll here (`signal poll` / lib/poll.js). THIS SURFACE CANNOT: polling
 * shells out to yt-dlp and reads feeds from the worker host, and the QuoxSignal server
 * exposes no poll route for a browser to call, see server/src/app.js, which mounts the API
 * router and nothing else. So the dashboard shows what discovery has ACTUALLY produced for
 * the new sources and says plainly who does the polling. Presenting a "poll complete" step
 * that never polled is exactly the failure the honesty rule forbids.
 */
export const FIRST_POLL_NOTE = 'The dashboard cannot start a poll: discovery runs in the QuoxSignal worker on its '
  + 'schedule, or on demand with "signal poll" on the CLI. This is what has been discovered for these sources so far.';

/** Summarises a first look for the created sources, per source, with the degraded ones called out. */
export function summariseFirstLook(results, items) {
  const byLabel = new Map();
  for (const item of items || []) {
    const key = item.source_label;
    byLabel.set(key, (byLabel.get(key) || 0) + 1);
  }
  return results
    .filter((r) => r.status !== 'error')
    .map((r) => {
      const broken = (r.notes || []).find((n) => n.level === 'broken');
      const count = byLabel.get(r.label) || 0;
      if (count > 0) return { label: r.label, status: 'items', count };
      if (broken) return { label: r.label, status: 'blocked', count: 0, reason: broken.text };
      return { label: r.label, status: 'waiting', count: 0 };
    });
}
