/**
 * Short local copy of quox-signal/lib/sources.js's PLATFORMS URL builders —
 * no cross-repo import, same posture as lib/autonomy.js. Only the platforms
 * that resolve to a URL from a bare handle with no network round-trip are
 * listed here: youtube is deliberately excluded (the CLI's `signal follow
 * @handle --on youtube` does a live fetch to resolve the handle to a channel
 * id — see resolveSource()'s youtubeChannelId() — which this form has no
 * server-side equivalent for yet). A YouTube source can still be followed
 * here by pasting its full channel/feed URL directly (feed mode).
 */
export const ACCOUNT_PLATFORMS = ['tiktok', 'instagram', 'x'];

const URL_BUILDERS = {
  tiktok: (h) => `https://www.tiktok.com/@${h}`,
  instagram: (h) => `https://www.instagram.com/${h}/`,
  x: (h) => `https://x.com/${h}`
};

/** Builds the profile URL for a bare handle on one of ACCOUNT_PLATFORMS. Returns null for anything else (caller must supply a URL directly, e.g. youtube or a feed). */
export function accountUrlFor(platform, handle) {
  const builder = URL_BUILDERS[platform];
  if (!builder || !handle) return null;
  return builder(String(handle).replace(/^@/, ''));
}
