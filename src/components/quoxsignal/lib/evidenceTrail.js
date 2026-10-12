/**
 * SIGNAL-P4: pure helpers for the proposal evidence trail. The claim to
 * prove: a roadmap entry born from a video can be traced back to the
 * second of audio it came from, with a receipt. Kept side-effect free and
 * separate from EvidenceTrail.jsx so the stage-derivation logic (in
 * particular the MISSING rules) is unit-testable without React.
 */

/**
 * Deterministic AEE corr for a proposal's evidence thread. Must exactly
 * mirror services/collector/lib/signalEvidence.js's proposalEvidenceCorr —
 * kept as a per-side copy (same convention as lib/useAsync.js in this
 * directory) since the collector's lib/ isn't bundled into the frontend.
 */
export function proposalEvidenceCorr(proposalId) {
  return `SIGNAL_PROPOSAL_${proposalId}`;
}

/**
 * Build a URL that jumps to a specific second in the original post, when
 * the platform's URL scheme is known to support it. Returns null — never a
 * guess — when we don't know how to construct a timestamped link for the
 * platform; the caller decides whether to fall back to a plain link or
 * omit one, but must never point at the wrong moment.
 */
export function timestampedSourceUrl(url, platform, timestampSeconds) {
  if (!url || timestampSeconds === null || timestampSeconds === undefined) return null;
  const t = Math.floor(Number(timestampSeconds));
  if (!Number.isFinite(t) || t < 0) return null;
  const plat = (platform || '').toLowerCase();
  if (plat === 'youtube' || url.includes('youtube.com') || url.includes('youtu.be')) {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}t=${t}s`;
  }
  // Other platforms (tiktok, twitter/x, podcasts...) have no documented,
  // reliable deep-link timestamp param — return null rather than guess.
  return null;
}

/**
 * Every stage of the chain-of-custody trail: SOURCE -> TRANSCRIPT -> AEE ->
 * WARD. Each stage's `found` is independently derived from what was
 * actually returned, never inherited from an earlier stage — inheriting
 * "found" would hide a genuinely broken link as if it were fine, which is
 * exactly the honesty requirement this feature exists to satisfy.
 *
 * @param {object} proposal - the proposal object from the QuoxSignal API
 * @param {object|null} aeeBundleResponse - fetchEvidenceBundle()'s result,
 *   or null if it couldn't be fetched (missing corr, service down, etc.)
 */
export function buildEvidenceTrail(proposal, aeeBundleResponse) {
  const envelopes = aeeBundleResponse?.envelopes || [];
  const evidenceEnvelope = envelopes.find((e) => e.intent === 'signal.evidence.bundled');
  const mutationEnvelope = envelopes.find(
    (e) => e.intent === 'signal.proposal.created' || e.intent === 'signal.proposal.handed_off'
  );
  const bundle = evidenceEnvelope?.payload?.bundle || null;
  const ward = aeeBundleResponse?.ward || null;

  const stages = [
    {
      key: 'source',
      label: 'SOURCE',
      found: !!proposal?.url,
      detail: proposal?.url || null,
    },
    {
      key: 'transcript',
      label: 'TRANSCRIPT',
      found: !!bundle?.transcript?.content_hash,
      detail: bundle?.transcript?.content_hash || null,
    },
    {
      key: 'aee',
      label: 'AEE',
      found: !!mutationEnvelope,
      detail: mutationEnvelope?.id || null,
    },
    {
      key: 'ward',
      label: 'WARD',
      found: !!ward?.witnessed,
      detail: ward?.receipt?.hash || (typeof ward?.receipt === 'string' ? ward.receipt : null),
    },
  ];

  return {
    stages,
    bundle,
    quotes: bundle?.quotes || [],
  };
}
