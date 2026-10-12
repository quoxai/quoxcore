/**
 * Pure builder for a Lens finding's AEE -> VOLT -> WARD evidence chain.
 *
 * EVIDENCE-LIVE (services/collector/routes/quoxlens.js POST /apply) wires
 * lensEvidence.js's buildLensEnvelope/buildVoltBundle into a real route now,
 * so a FRESHLY APPLIED verdict genuinely has a stored AEE envelope and VOLT
 * bundle — see buildAppliedEvidenceTrail below, which is what EvidenceView
 * uses for that flow.
 *
 * buildEvidenceTrail (this function) stays exactly as honest as before for
 * the OTHER flow it serves: a finding read back from a findings-SCOPE file
 * on disk (sweep.mjs output). Sweep has not been wired to call POST /apply
 * in this phase — a scope-sourced finding genuinely has no AEE envelope, no
 * VOLT bundle, and no WARD receipt, so it must keep rendering MISSING. Do
 * not "fix" this function to match buildAppliedEvidenceTrail; that would be
 * exactly the false tick this file exists to prevent.
 *
 * What IS real today for a scope finding: its own SOURCE (the swept
 * artifact's URL) and its verbatim evidence quote(s), both already
 * persisted in the findings JSON on disk.
 */

const NOT_WIRED = {
  aee: 'no lens.applied AEE envelope has ever been recorded for a Lens verdict — lensEvidence.js built the envelope builder (P6) but the collector does not call it yet',
  volt: 'no VOLT evidence bundle has ever been persisted for a Lens verdict — buildVoltBundle() exists but is not wired to any store',
  ward: 'WARD witnessing depends on a stored AEE envelope, which does not exist for Lens verdicts yet',
};

/**
 * @param {object|null} finding - one lifecycle record from a findings scope,
 *   e.g. { fingerprint, state, finding: { evidence: [{quote, at}], ... } }
 * @param {{ url?: string|null }|null} scopeMeta - the findings scope's own
 *   metadata (see routes/quoxlens.js's GET /findings/*scope)
 * @returns {{ stages: Array<object>, quotes: Array<{quote: string, at: string|null}> }}
 */
export function buildEvidenceTrail(finding, scopeMeta) {
  const inner = finding?.finding || null;
  const quotes = Array.isArray(inner?.evidence) ? inner.evidence.filter((e) => e && e.quote) : [];

  const stages = [
    {
      key: 'source',
      label: 'SOURCE',
      found: !!scopeMeta?.url,
      detail: scopeMeta?.url || null,
    },
    {
      key: 'aee',
      label: 'AEE',
      found: false,
      detail: NOT_WIRED.aee,
    },
    {
      key: 'volt',
      label: 'VOLT',
      found: false,
      detail: NOT_WIRED.volt,
    },
    {
      key: 'ward',
      label: 'WARD',
      found: false,
      detail: NOT_WIRED.ward,
    },
  ];

  return { stages, quotes };
}

/**
 * EVIDENCE-LIVE: the AEE -> VOLT -> WARD trail for a FRESHLY APPLIED verdict
 * (api.applyLens's response, correlated via its `evidence.corr`), built from
 * the collector's shared GET /aee/conversation/:corr/bundle response — the
 * SAME endpoint quoxsignal/lib/evidenceTrail.js already reads for its own
 * proposal evidence, not a second parallel lookup.
 *
 * Every stage is derived independently from what the bundle response
 * actually contains, same discipline as buildEvidenceTrail above:
 *
 *  - AEE is found only if an envelope with intent "lens.applied" is present.
 *  - VOLT is found only if a "lens.evidence.recorded" VOLT event carrying
 *    the actual bundle payload is present (routes/quoxlens.js emits this via
 *    the real voltEmitter — see POST /apply's evidence persistence step).
 *  - WARD is found only if the bundle response's own `ward.witnessed` flag
 *    says so. As of this build that flag is a genuine, KNOWN gap: WARD's
 *    write-side hooks (wardHookAEE / wardHookVOLT) DO fire for real on every
 *    envelope and VOLT bundle in this app (not just Lens), but the
 *    read-back this trail depends on only reports `witnessed: true` when a
 *    bundle's stored JSON carries a `ward_receipt` field, which nothing in
 *    the collector currently writes onto a VOLT auto-bundle. WARD therefore
 *    renders MISSING here honestly — see this component's rendered hint
 *    when only WARD is missing, which says exactly this rather than hiding it.
 *
 * @param {object|null} bundleResponse - api.getVerdictEvidence()'s result, or null
 * @returns {{ stages: Array<object>, quotes: Array<{quote: string, at: string|null}>, findings: Array<object>, bundle: object|null }}
 */
export function buildAppliedEvidenceTrail(bundleResponse) {
  const envelopes = Array.isArray(bundleResponse?.envelopes) ? bundleResponse.envelopes : [];
  const aeeEnvelope = envelopes.find((e) => e && e.intent === 'lens.applied') || null;

  // volt.events rows are raw DB rows (see server.js's /aee/conversation/:corr/bundle
  // — it deliberately does NOT JSON.parse them, unlike /volt/runs/:runId/events),
  // so `data` is a JSON string containing the full VOLT eventObj; the lens
  // bundle itself lives at eventObj.payload.bundle.
  const rawVoltEvents = Array.isArray(bundleResponse?.volt?.events) ? bundleResponse.volt.events : [];
  let bundle = null;
  for (const row of rawVoltEvents) {
    try {
      const parsed = typeof row?.data === 'string' ? JSON.parse(row.data) : row?.data;
      if (parsed?.event_type === 'lens.evidence.recorded' && parsed?.payload?.bundle) {
        bundle = parsed.payload.bundle;
        break;
      }
    } catch {
      // an unparsable event row is skipped, not treated as evidence
    }
  }

  const ward = bundleResponse?.ward || null;
  const findings = Array.isArray(bundle?.findings) ? bundle.findings : [];
  const quotes = findings.flatMap((f) => (Array.isArray(f?.evidence) ? f.evidence.filter((e) => e && e.quote) : []));

  const stages = [
    {
      key: 'source',
      label: 'SOURCE',
      found: !!bundle?.artifact_id,
      detail: bundle?.artifact_id || null,
    },
    {
      key: 'aee',
      label: 'AEE',
      found: !!aeeEnvelope,
      detail: aeeEnvelope ? aeeEnvelope.id : 'no lens.applied envelope found for this corr',
    },
    {
      key: 'volt',
      label: 'VOLT',
      found: !!bundle,
      detail: bundle ? (bundle.artifact_hash || bundle.lens_id) : 'no VOLT bundle found for this corr',
    },
    {
      key: 'ward',
      label: 'WARD',
      found: !!ward?.witnessed,
      detail: ward?.witnessed
        ? (ward.receipt?.hash || (typeof ward.receipt === 'string' ? ward.receipt : 'witnessed'))
        : 'WARD hooks fire on write, but the bundle read-back does not yet surface a receipt for this shape — known gap, not hidden',
    },
  ];

  return { stages, quotes, findings, bundle };
}
