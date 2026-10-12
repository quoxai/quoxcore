/**
 * SIGNAL-P4: evidence bundles for QuoxSignal proposals.
 *
 * The claim to prove: a roadmap entry born from a video can be traced back
 * to the second of audio it came from, with a receipt. This module builds
 * that receipt (buildProposalBundle) and re-checks it against a live
 * transcript (verifyProposalBundle) - evidence that cannot be re-verified
 * is not evidence.
 *
 * Field provenance (read from the real quox-signal server, not guessed):
 *   - item.content_hash: the DB dedupe hash written by the ingest pipeline
 *     (server/src/api/items.js) - its algorithm is opaque to us, so it is
 *     carried through as reference metadata only, never as a pass/fail
 *     input to verification.
 *   - item.engine: the ASR engine string, e.g. 'openai:whisper-1' (see
 *     server/test/api.items.test.js).
 *   - proposal.url / .author / .platform: source attribution fields that
 *     already exist on both items and proposals (server/src/api/proposals.js).
 *   - proposal.proposals[].evidence[]: { t, quote } pairs - the verbatim
 *     evidence quotes (server/src/planHandoff.js's evidenceBlock()).
 *   - proposal.model / .prompt_version: NOT currently written by the
 *     quox-signal server. Read defensively (undefined -> null) so the UI
 *     can show these as MISSING rather than fabricate a value.
 */

const crypto = require('crypto');

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * Deterministic AEE corr for a proposal's evidence thread. WHY deterministic
 * rather than time-based: a browser reload has no other way to rediscover
 * which corr a given proposal's receipt lives under (AEE envelope payloads
 * are encrypted at rest, so there is no cheap "search by proposal_id"
 * query) — deriving the same corr from the proposal id every time means the
 * evidence trail is reconstructable from server-stored data alone on a
 * fresh browser with an empty cache, per the house server-side-source-of-
 * truth rule. Both proposal.created and proposal.handed_off use this same
 * corr for the same proposal id, so their two envelopes land in one thread.
 *
 * The frontend mirrors this exact format (see
 * src/components/quoxsignal/lib/evidenceTrail.js's proposalEvidenceCorr) —
 * keep the two in sync if this ever changes.
 */
function proposalEvidenceCorr(proposalId) {
  return `SIGNAL_PROPOSAL_${proposalId}`;
}

/**
 * Join an item's transcript segments into one plain-text block, in seq
 * order. Falls back to item.text (the raw transcript field some ingest
 * paths write directly, see quox-signal server/src/api/items.js) when no
 * per-segment timestamps exist yet.
 */
function transcriptTextOf(item) {
  if (!item) return null;
  if (Array.isArray(item.segments) && item.segments.length > 0) {
    return item.segments
      .slice()
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
      .map((s) => s.text)
      .join(' ');
  }
  if (typeof item.text === 'string' && item.text.length > 0) return item.text;
  return null;
}

function findingsOf(proposal) {
  return Array.isArray(proposal?.proposals) ? proposal.proposals : [];
}

/**
 * Build an evidence bundle for one proposal: source URL and author, the
 * content hash of the transcript, the ASR engine used, the model and
 * prompt version, and every evidence quote with its timestamp.
 *
 * `item` is optional (a proposal can exist without its item being
 * fetchable, e.g. the QuoxSignal service being briefly unreachable when
 * the bundle is built) - every item-derived field degrades to null rather
 * than throwing, so a partial bundle is still an honest bundle.
 */
function buildProposalBundle(proposal, item) {
  if (!proposal) throw new Error('buildProposalBundle: proposal is required');

  const transcriptText = transcriptTextOf(item);
  // Only a hash WE compute with a known algorithm (sha256 over the joined
  // transcript) can later be independently re-verified by
  // verifyProposalBundle below - that is what content_hash_source: 'derived'
  // records. item.content_hash is real data, but its algorithm is opaque to
  // us, so it travels as source_content_hash (reference only).
  const derivedHash = transcriptText ? sha256Hex(transcriptText) : null;

  const quotes = [];
  for (const finding of findingsOf(proposal)) {
    for (const evidence of finding.evidence || []) {
      quotes.push({
        finding_title: finding.title || null,
        kind: finding.kind || null,
        timestamp: evidence.t ?? null,
        quote: evidence.quote ?? null,
      });
    }
  }

  return {
    bundle_version: '1',
    proposal_id: proposal.id || null,
    item_id: proposal.item_id || item?.id || null,
    created_ts: new Date().toISOString(),
    source: {
      url: proposal.url || item?.url || null,
      author: proposal.author || item?.author || null,
      platform: proposal.platform || item?.platform || null,
    },
    transcript: {
      content_hash: derivedHash,
      content_hash_source: derivedHash ? 'derived' : null,
      source_content_hash: item?.content_hash ?? null,
      asr_engine: item?.engine ?? null,
    },
    generation: {
      model: proposal.model ?? null,
      prompt_version: proposal.prompt_version ?? null,
    },
    quotes,
  };
}

/**
 * Re-check a bundle against an actual transcript text, rather than trusting
 * whatever the bundle already claims. Recomputes the transcript hash (only
 * when the bundle's hash is one we derived ourselves - see
 * content_hash_source above) and re-finds every quote verbatim in the
 * supplied text.
 *
 * @returns {{ ok: boolean, quotes: Array, hash: object }}
 */
function verifyProposalBundle(bundle, transcriptText) {
  const text = typeof transcriptText === 'string' ? transcriptText : '';
  const recomputedHash = text ? sha256Hex(text) : null;

  const hashChecked = bundle?.transcript?.content_hash_source === 'derived'
    && !!bundle?.transcript?.content_hash;
  const hashMatches = hashChecked ? bundle.transcript.content_hash === recomputedHash : null;

  const quotes = (bundle?.quotes || []).map((q) => ({
    ...q,
    verified: typeof q.quote === 'string' && q.quote.length > 0 && text.includes(q.quote),
  }));
  // A bundle with zero quotes has nothing verifiable in it - that is a
  // failure to verify, not a vacuous pass.
  const allQuotesVerified = quotes.length > 0 && quotes.every((q) => q.verified);

  const ok = allQuotesVerified && (hashChecked ? hashMatches : true);

  return {
    ok,
    quotes,
    hash: {
      checked: hashChecked,
      recomputed: recomputedHash,
      matches: hashMatches,
    },
  };
}

module.exports = { buildProposalBundle, verifyProposalBundle, sha256Hex, proposalEvidenceCorr };
