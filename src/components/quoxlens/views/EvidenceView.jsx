import { useCallback, useMemo } from 'react';
import { api } from '../lib/api.js';
import { useAsync } from '../lib/useAsync.js';
import { buildAppliedEvidenceTrail } from '../lib/evidenceTrail.js';
import AsyncBoundary from '../components/AsyncBoundary.jsx';
import EvidenceTrail from '../components/EvidenceTrail.jsx';

/**
 * For a selected verdict, the AEE -> VOLT -> WARD chain. Two entry points:
 *
 *  - `scope` + `fingerprint`: a finding from a findings-SCOPE file on disk
 *    (sweep.mjs output). Reachable with ?tab=evidence&scope=...&fp=... or
 *    via the "Evidence" button on a Findings row. Unchanged by
 *    EVIDENCE-LIVE — these still correctly render MISSING (see
 *    lib/evidenceTrail.js's module doc for why that stays true).
 *  - `corr`: a FRESHLY APPLIED verdict's `evidence.corr` (EVIDENCE-LIVE,
 *    POST /api/v1/lens/apply's response). Reachable with ?tab=evidence&corr=...
 *    — fetches the real stored AEE envelope + VOLT bundle back and renders
 *    them as genuinely found.
 */
export default function EvidenceView({ scope, fingerprint, corr }) {
  const fetchData = useCallback(() => {
    if (corr) return api.getVerdictEvidence(corr);
    if (scope) return api.getFindingScope(scope);
    return Promise.resolve(null);
  }, [scope, corr]);
  const { loading, error, data, retry } = useAsync(fetchData, [scope, corr]);

  const finding = useMemo(
    () => (corr ? null : (data?.findings || []).find((f) => f.fingerprint === fingerprint) || null),
    [data, fingerprint, corr]
  );
  const appliedTrail = useMemo(() => (corr ? buildAppliedEvidenceTrail(data) : null), [data, corr]);

  if (!scope && !corr) {
    return (
      <div className="qx-empty" data-testid="qx-lens-evidence-no-scope">
        <div className="qx-empty__title">No verdict selected</div>
        <div className="qx-empty__body">Pick a finding from the Findings tab to see its evidence chain.</div>
      </div>
    );
  }

  return (
    <AsyncBoundary loading={loading} error={error} onRetry={retry} skeletonLines={4}>
      <div className="qx-card qx-card--compact">
        {corr ? (
          <EvidenceTrail trail={appliedTrail} />
        ) : (
          <EvidenceTrail finding={finding} scopeMeta={data} />
        )}
      </div>
    </AsyncBoundary>
  );
}
