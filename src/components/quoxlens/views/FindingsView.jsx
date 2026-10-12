import { useCallback, useMemo } from 'react';
import { api } from '../lib/api.js';
import { useAsync } from '../lib/useAsync.js';
import { groupFindings } from '../lib/findingsGrouping.js';
import AsyncBoundary from '../components/AsyncBoundary.jsx';

const fetchScopes = () => api.listFindingScopes();

function FindingRow({ record, scope, onViewEvidence }) {
  const finding = record.finding || {};
  const quote = Array.isArray(finding.evidence) && finding.evidence[0] ? finding.evidence[0].quote : null;
  const provenance = record.provenance?.lens_ref
    || (finding.provenance && finding.provenance.lens_ref)
    || `${scope.sweep || 'unknown'}@${record.fingerprint ? record.fingerprint.slice(0, 14) : 'unknown'}`;

  return (
    <div className="qx-card qx-card--compact" data-testid={`qx-finding-${record.fingerprint}`}>
      <div className="qx-stack qx-stack--tight">
        <div className="qx-row qx-row--apart">
          <span className={`qx-severity qx-severity--${finding.severity || 'info'}`}>{finding.severity || 'info'}</span>
          <span className={`qx-pill qx-pill--xs ${record.state === 'regressed' ? 'qx-pill--danger' : 'qx-pill--ghost'}`}>
            {record.state}
          </span>
        </div>
        <strong>{finding.class || 'finding'}</strong>
        {quote && (
          <div className="qx-evidence">
            <span className="qx-evidence__dot" />
            <span className="qx-evidence__source">&ldquo;{quote}&rdquo;</span>
          </div>
        )}
        <div className="qx-row qx-row--apart">
          <span className="qx-hint qx-hint--sm">{provenance}</span>
          <button
            type="button"
            className="qx-btn qx-btn--sm qx-btn--ghost"
            onClick={() => onViewEvidence(scope.scope, record.fingerprint)}
          >
            Evidence
          </button>
        </div>
      </div>
    </div>
  );
}

function FindingSection({ title, records, scope, emptyHint, onViewEvidence, testId }) {
  if (records.length === 0) {
    return emptyHint ? <div className="qx-hint qx-hint--sm">{emptyHint}</div> : null;
  }
  return (
    <div className="qx-stack qx-stack--compact" data-testid={testId}>
      <span className="qx-section-title">{title} ({records.length})</span>
      <div className="qx-stack qx-stack--tight">
        {records.map((record) => (
          <FindingRow key={record.fingerprint} record={record} scope={scope} onViewEvidence={onViewEvidence} />
        ))}
      </div>
    </div>
  );
}

/**
 * The findings lifecycle list, leading with what needs attention (new,
 * regressed, and accepted risks whose exemption has expired) and never
 * re-listing confirmed findings the owner has already seen — see
 * lib/findingsGrouping.js for the exact rule.
 */
export default function FindingsView({ scope: activeScopeId, onSelectScope, onViewEvidence }) {
  const { loading, error, data, retry } = useAsync(useCallback(fetchScopes, []), []);
  const scopes = data?.scopes || [];
  const activeScope = useMemo(
    () => scopes.find((s) => s.scope === activeScopeId) || scopes[0] || null,
    [scopes, activeScopeId]
  );

  const scopeFetch = useCallback(
    () => (activeScope ? api.getFindingScope(activeScope.scope) : Promise.resolve(null)),
    [activeScope]
  );
  const scopeState = useAsync(scopeFetch, [activeScope?.scope]);
  const groups = useMemo(
    () => groupFindings(scopeState.data?.findings || []),
    [scopeState.data]
  );

  return (
    <AsyncBoundary loading={loading} error={error} onRetry={retry} skeletonLines={4}>
      {scopes.length === 0 ? (
        <div className="qx-empty">
          <div className="qx-empty__title">No findings recorded yet</div>
          <div className="qx-empty__body">A scheduled sweep has not run for any target yet.</div>
        </div>
      ) : (
        <div className="qx-stack">
          {scopes.length > 1 && (
            <select
              className="qx-select qx-select--auto"
              value={activeScope?.scope || ''}
              onChange={(e) => onSelectScope(e.target.value)}
            >
              {scopes.map((s) => (
                <option key={s.scope} value={s.scope}>{s.scope}</option>
              ))}
            </select>
          )}

          <AsyncBoundary loading={scopeState.loading} error={scopeState.error} onRetry={scopeState.retry} skeletonLines={3}>
            {activeScope && (
              <div className="qx-stack">
                <FindingSection
                  title="Needs attention"
                  records={groups.needsAttention}
                  scope={activeScope}
                  emptyHint="Nothing needs attention in this scope right now."
                  onViewEvidence={onViewEvidence}
                  testId="qx-lens-findings-needs-attention"
                />
                <FindingSection
                  title="Accepted risk"
                  records={groups.acceptedRisk}
                  scope={activeScope}
                  onViewEvidence={onViewEvidence}
                  testId="qx-lens-findings-accepted-risk"
                />
                <FindingSection
                  title="Remediated"
                  records={groups.remediated}
                  scope={activeScope}
                  onViewEvidence={onViewEvidence}
                  testId="qx-lens-findings-remediated"
                />
                <FindingSection
                  title="Lapsed (not reported this run, artifact unchanged)"
                  records={groups.lapsed}
                  scope={activeScope}
                  onViewEvidence={onViewEvidence}
                  testId="qx-lens-findings-lapsed"
                />
                {groups.omittedConfirmed > 0 && (
                  <span className="qx-hint qx-hint--sm" data-testid="qx-lens-findings-omitted-confirmed">
                    {groups.omittedConfirmed} confirmed finding(s) already seen, not re-listed.
                  </span>
                )}
              </div>
            )}
          </AsyncBoundary>
        </div>
      )}
    </AsyncBoundary>
  );
}
