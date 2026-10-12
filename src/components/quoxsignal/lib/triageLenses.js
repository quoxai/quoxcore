/**
 * The built-in triage lens presets, with the one line each that says what question it asks.
 *
 * Short local copy of quox-signal/lib/lenses/*.json, same posture as lib/autonomy.js and
 * lib/sourcePlatforms.js in this directory. It is a copy rather than an API call because
 * the presets are JSON FILES shipped inside the quox-signal repo, not rows: the server's
 * GET /triage-lenses returns tier-1 (user-defined) lenses only, and deliberately so, see
 * server/src/api/triageLenses.js's header. Custom lenses are merged in at runtime by
 * mergeLenses() below, so the picker shows exactly what `signal lens list` shows.
 *
 * Keep the ids and purposes in sync by hand with quox-signal/lib/lenses/.
 */
export const DEFAULT_LENS_ID = 'quox-roadmap';

export const PRESET_LENSES = [
  {
    id: 'quox-roadmap',
    name: 'Quox roadmap fit',
    purpose: 'Decide whether this social post is worth a deeper look by an expensive model, judging usefulness to what Quox builds.',
    tier: 'preset'
  },
  {
    id: 'competitor-watch',
    name: 'Competitor watch',
    purpose: "Judge positioning and market threat: what a competitor or adjacent player is doing, claiming, or shipping, and what it means for Quox's position in the market. Buildability is NOT the criterion.",
    tier: 'preset'
  },
  {
    id: 'founder-mindset',
    name: 'Founder mindset',
    purpose: 'Judge personal and operational insight to the Quox owner as a founder: staying operational under load, decision quality, burnout, recovery, focus. A post with no technical content at all can still score high.',
    tier: 'preset'
  },
  {
    id: 'security-intel',
    name: 'Security intel',
    purpose: 'Judge exposure to the actual Quox stack: CVEs, security advisories, and supply-chain risk in dependencies or infrastructure Quox actually runs, not general security awareness.',
    tier: 'preset'
  },
  {
    id: 'tech-news',
    name: 'Tech news',
    purpose: 'Judge market and technology context worth knowing: broad industry shifts, new platforms, notable releases. Low scores for hype restated without new information.'
  }
].map((l) => ({ ...l, tier: 'preset' }));

/**
 * Presets plus this org's custom lenses. A custom lens may deliberately shadow a preset id
 * (quox-signal/lib/lenses.js tier 1 wins), so it replaces rather than duplicates.
 */
export function mergeLenses(customLenses) {
  const byId = new Map(PRESET_LENSES.map((l) => [l.id, l]));
  for (const l of customLenses || []) {
    if (!l || !l.id) continue;
    byId.set(l.id, { id: l.id, name: l.name || l.id, purpose: l.purpose || '', tier: 'custom' });
  }
  return [...byId.values()];
}
