/**
 * lensEvidence — QUOXLENS P6
 *
 * lensContract (P1) enforces the seven invariants and computes a stable
 * fingerprint per finding. lensPanel (P5) runs one or more Lenses and
 * returns a per-lens result: `{ lens_id, verdict, findings, applied,
 * violations, dropped }` — the same shape enforceContract() produces plus
 * the lens metadata a caller already has in hand. That result is a log line
 * today: it goes back to whoever called runPanel and, once the response is
 * sent, the fact that a Lens judged an artifact and WHY it judged it that
 * way is gone. This module turns one such result into two durable,
 * replayable artifacts:
 *
 *   - an AEE envelope (buildLensEnvelope) — the audit-trail fact that a
 *     Lens verdict happened, shaped exactly like every other envelope the
 *     collector already stores via storeAuditEnvelope() in server.js.
 *   - a VOLT evidence bundle (buildVoltBundle) — the full record of what
 *     the Lens actually said, including what it said and then had to throw
 *     away, so a reader can re-derive the verdict later and see what was
 *     dropped rather than being told only what survived.
 *
 * `attachProvenance` and `verifyBundle` are what make the bundle durable
 * rather than a nicer log line: provenance keeps a finding attributable to
 * the exact lens version that produced it even after the lens ships a new
 * version, and verifyBundle lets a reader check, later, whether the
 * evidence a bundle claims still actually exists in the artifact.
 *
 * Deliberately dependency-free, same reason as lensContract/lensPanel: no
 * external JSON Schema or hashing library in the collector's package.json,
 * and this module only needs Node's built-in crypto.
 *
 * This module does NOT call WARD or VOLT itself, and does NOT write to any
 * database. It builds plain objects; server.js is responsible for handing
 * the envelope to storeAuditEnvelope() (or witnessStoredEnvelope directly)
 * and the bundle to a VOLT emitter, at whatever governed boundary decides a
 * Lens verdict is worth recording. See the file header comment in
 * server.js's QuoxPlan proxy section for the pattern this mirrors.
 */

'use strict';

const crypto = require('crypto');

/**
 * sha256 hex, same normalisation policy as every other hash in this Lens
 * stack (lensContract's fingerprints, voltEmitter's canonicalJSON hash):
 * plain UTF-8 bytes in, lowercase hex out, "sha256-" prefixed so a reader
 * can tell the algorithm from the string alone without a schema lookup.
 *
 * @param {string} text
 * @returns {string}
 */
function hashArtifactText(text) {
  return `sha256-${crypto.createHash('sha256').update(String(text == null ? '' : text), 'utf8').digest('hex')}`;
}

/**
 * Same normalisation policy as lensContract.normalizeForMatch and
 * lensPanel.normalizeForMatch. Duplicated rather than imported: both of
 * those files keep their own copy for the same reason (no shared "lens
 * text utils" module exists yet, and this is a five-line pure function,
 * not worth adding a new inter-module dependency for).
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeForMatch(text) {
  return String(text == null ? '' : text)
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * AEE envelope id, same shape as server.js's generateEnvelopeId()
 * (ENV_<base36 timestamp>_<random>). Duplicated rather than imported:
 * server.js is owned by another agent working in parallel on the
 * QuoxSignal proxy right now, and this module has to work standalone
 * without importing from it (see file header + P6 task scope).
 *
 * @returns {string}
 */
function generateEnvelopeId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `ENV_${timestamp}_${random}`.toUpperCase();
}

/**
 * buildLensEnvelope — the AEE envelope for one Lens verdict, matching the
 * exact field set storeAuditEnvelope() persists in server.js (id, v, ts,
 * type, from, to, intent, corr, reply_to, payload, priority, org_id — see
 * aeeStatements.insert.run() in server.js). Nothing here invents a new
 * envelope shape; every field name and its meaning is copied from that
 * call site.
 *
 * `verdict` is a per-lens result in the shape lensPanel.runPanel() returns
 * per lens (and enforceContract() returns before lens metadata is added):
 * `{ verdict: {summary, disposition, confidence}, findings: [...],
 *   applied: {lens_id, version, model, depth, provider, unproven,
 *   blind_spots}, violations: [...], dropped: <number> }`.
 *
 * The payload is deliberately light — ids and outcome, not the full
 * evidence. The full evidence (quotes, dropped findings and why) belongs
 * in the VOLT bundle (buildVoltBundle), not duplicated into the AEE audit
 * trail, mirroring how storeAuditEnvelope's callers elsewhere in server.js
 * (emitQuoxplanAEE, emitWazuhAEE) keep payload to identifiers and status.
 *
 * @param {object} verdict - a per-lens result, see above
 * @param {object} [options]
 * @param {string|null} [options.orgId] - derived org, row attribute only
 * @param {string|null} [options.actor] - user id if a human triggered this apply; omitted for system/scheduled runs
 * @param {{id?: string, title?: string}} [options.artifact]
 * @returns {object} an AEE envelope ready for storeAuditEnvelope() / witnessStoredEnvelope()
 */
function buildLensEnvelope(verdict, options = {}) {
  if (!verdict || typeof verdict !== 'object') {
    throw new Error('buildLensEnvelope: verdict is required');
  }
  const { orgId = null, actor = null, artifact = null } = options;
  const applied = verdict.applied || {};
  const summary = verdict.verdict || {};

  // Same from-resolution as emitQuoxplanAEE/emitWazuhAEE in server.js:
  // an identified human actor gets attributed, everything else (scheduled
  // sweeps, CI, agent-triggered applies) is "system" rather than a guess.
  const from = actor ? `human.${actor}` : 'system';

  return {
    v: '1',
    id: generateEnvelopeId(),
    ts: new Date().toISOString(),
    type: 'event',
    from,
    // No lens-facing chat agent is registered in agentRegistry — a Lens
    // judges, it does not converse (LENS_CONTRACT invariant 5) — so this
    // addresses the evidence sink the same way emitAgentSession addresses
    // 'audit.agent_stream' rather than a conversational agent id. Confirm
    // this address with whoever wires the real route; see this file's
    // header for the "does not call WARD/VOLT itself" boundary.
    to: 'audit.lens',
    intent: 'lens.applied',
    corr: `LENS_${Date.now()}`,
    reply_to: null,
    payload: {
      lens_id: applied.lens_id || verdict.lens_id || null,
      version: applied.version || null,
      artifact_id: (artifact && artifact.id) || verdict.artifact_id || null,
      disposition: summary.disposition || null,
      confidence: typeof summary.confidence === 'number' ? summary.confidence : null,
      findings_count: Array.isArray(verdict.findings) ? verdict.findings.length : 0,
      dropped_count: typeof verdict.dropped === 'number' ? verdict.dropped : 0,
      unproven: !!applied.unproven,
      model: applied.model || null,
      depth: applied.depth || null,
      provider: applied.provider || null,
    },
    priority: 'normal',
    org_id: orgId,
  };
}

/**
 * buildVoltBundle — the full evidence record for one Lens application.
 * Everything a reader needs to re-derive the verdict later and see what
 * was thrown away, per the P6 brief: dropped findings are part of the
 * evidence, not an omission.
 *
 * `verdict` is the same per-lens result shape buildLensEnvelope takes,
 * with one addition the caller is expected to merge in before calling this:
 * `artifact: { id, text? , content? }` — needed to hash the artifact text.
 * A verdict with no artifact text produces a bundle with `artifact_hash:
 * null` rather than throwing, since a caller may legitimately be
 * rebuilding a bundle from a stored verdict where only the id survived;
 * that gap is visible in the bundle rather than silently hidden.
 *
 * Each finding's `provenance` (see attachProvenance) is carried through
 * UNCHANGED — this bundle's own `version` field reflects the lens version
 * THIS apply ran under, but a finding stamped by an earlier version (via
 * attachProvenance at the time it was produced) keeps that earlier
 * version. That is the whole point of provenance: a finding survives a
 * lens version bump with its original attribution intact.
 *
 * @param {object} verdict - a per-lens result, see buildLensEnvelope; plus optional `artifact: {id, text|content}`
 * @returns {object} a VOLT evidence bundle
 */
function buildVoltBundle(verdict) {
  if (!verdict || typeof verdict !== 'object') {
    throw new Error('buildVoltBundle: verdict is required');
  }
  const applied = verdict.applied || {};
  const summary = verdict.verdict || {};
  const artifact = verdict.artifact || null;
  const artifactText = artifact ? String(artifact.text || artifact.content || '') : null;
  const findings = Array.isArray(verdict.findings) ? verdict.findings : [];
  const violations = Array.isArray(verdict.violations) ? verdict.violations : [];

  return {
    bundle_version: '0.1',
    lens_id: applied.lens_id || verdict.lens_id || null,
    version: applied.version || null,
    model: applied.model || null,
    depth: applied.depth || null,
    evidence_bar: applied.evidence_bar || null,
    artifact_id: (artifact && artifact.id) || verdict.artifact_id || null,
    // null (not a hash of an empty string) when no artifact text was
    // supplied at all — "unknown" must stay distinguishable from "hash of
    // empty content", which is a real, different, valid artifact.
    artifact_hash: artifact ? hashArtifactText(artifactText) : null,
    disposition: summary.disposition || null,
    confidence: typeof summary.confidence === 'number' ? summary.confidence : null,
    unproven: !!applied.unproven,
    // Full evidence, verbatim quotes and all — this is the record a reader
    // re-derives the verdict from, not a summary of it.
    findings: findings.map((finding) => ({ ...finding })),
    // Contract violations dropped before the response ever left
    // enforceContract — each carries its own `reason` (see lensContract's
    // verifyEvidence / enforceContract). This is the "what was thrown away
    // and why" half of the bundle; without it a dropped finding is
    // indistinguishable from a finding that was never raised at all.
    dropped_findings: violations.map((violation) => ({ ...violation })),
    dropped_count: typeof verdict.dropped === 'number' ? verdict.dropped : violations.length,
    created_at: new Date().toISOString(),
  };
}

/**
 * attachProvenance — stamp `lens_id@version` plus the model onto a single
 * finding at the point it is produced, so the finding stays attributable
 * to that exact lens version even after the lens ships a newer one.
 * Returns a new object; the input finding is never mutated (same
 * immutability discipline as lensContract.enforceContract's `{ ...finding,
 * fingerprint }` pattern).
 *
 * @param {object} finding - a finding, typically post-enforceContract (has .fingerprint)
 * @param {{lensId: string, version: string, model?: string}} options
 * @returns {object} the finding with a `.provenance` field attached
 */
function attachProvenance(finding, options = {}) {
  if (!finding || typeof finding !== 'object') {
    throw new Error('attachProvenance: finding is required');
  }
  const { lensId = null, version = null, model = null } = options;
  return {
    ...finding,
    provenance: {
      lens_id: lensId,
      version,
      lens_ref: lensId ? `${lensId}@${version || 'unknown'}` : null,
      model,
    },
  };
}

/**
 * verifyBundle — re-check every finding's evidence quotes against a fresh
 * copy of the artifact text and report which findings still verify.
 * Evidence that cannot be re-verified later is not evidence (this is the
 * durability half of the P6 brief): a bundle is not trustworthy just
 * because it was produced correctly once, it has to still check out when
 * someone re-derives it.
 *
 * A finding verifies only if EVERY one of its evidence quotes is still
 * found (post-normalisation, same policy as lensContract.verifyEvidence)
 * in the supplied artifact text. A finding with zero evidence entries can
 * never verify — that finding should not have survived enforceContract in
 * the first place (invariant 1), and this function does not paper over
 * that by treating "nothing to check" as "verified".
 *
 * @param {object} bundle - a VOLT evidence bundle, see buildVoltBundle
 * @param {string} artifactText - the artifact text to re-check evidence against
 * @returns {{ verified_at: string, artifact_hash: string, artifact_hash_matches: boolean|null, verified: Array<string>, unverified: Array<{fingerprint: string, reason: string}>, all_verified: boolean }}
 */
function verifyBundle(bundle, artifactText) {
  if (!bundle || typeof bundle !== 'object') {
    throw new Error('verifyBundle: bundle is required');
  }
  const findings = Array.isArray(bundle.findings) ? bundle.findings : [];
  const haystack = normalizeForMatch(artifactText);
  const currentHash = hashArtifactText(artifactText);

  const verified = [];
  const unverified = [];

  for (const finding of findings) {
    const evidence = Array.isArray(finding && finding.evidence) ? finding.evidence : [];
    const allQuotesPresent = evidence.length > 0 && evidence.every((item) => {
      const quote = normalizeForMatch(item && item.quote);
      return quote.length > 0 && haystack.includes(quote);
    });

    if (allQuotesPresent) {
      verified.push(finding.fingerprint);
    } else {
      unverified.push({
        fingerprint: finding && finding.fingerprint,
        reason: evidence.length === 0 ? 'finding has no evidence to verify' : 'evidence quote no longer found in artifact',
      });
    }
  }

  return {
    verified_at: new Date().toISOString(),
    artifact_hash: currentHash,
    artifact_hash_matches: bundle.artifact_hash ? bundle.artifact_hash === currentHash : null,
    verified,
    unverified,
    all_verified: findings.length > 0 && unverified.length === 0,
  };
}

module.exports = {
  hashArtifactText,
  buildLensEnvelope,
  buildVoltBundle,
  attachProvenance,
  verifyBundle,
};
