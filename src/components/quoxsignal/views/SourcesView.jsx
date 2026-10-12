import { api } from '../lib/api.js';
import { useAsync } from '../lib/useAsync.js';
import { isHealthBad } from '../lib/health.js';
import AsyncBoundary from '../components/AsyncBoundary.jsx';
import SourceRow from '../components/SourceRow.jsx';
import AddSourceForm from '../components/AddSourceForm.jsx';
import OnboardingWizard from '../components/OnboardingWizard.jsx';
import RefreshControl from '../components/RefreshControl.jsx';

const fetchSources = (opts) => api.listSources(opts);

/**
 * Followed sources with their poll health. Ported from the standalone
 * app's SourcesView.jsx, rebuilt on `.qx-table`.
 *
 * SIGNAL-UX item 5: this used to be read-only — there was no way to follow
 * a source from the UI at all, only `signal follow` on the CLI. AddSourceForm
 * covers "add"; SourceRow (label edit, autonomy, remove) covers "manage".
 */
export default function SourcesView() {
  const { loading, error, data, retry, refreshing, updatedAt } = useAsync(fetchSources, []);
  const sources = data?.sources || [];
  const badCount = sources.filter((s) => isHealthBad(s.health)).length;
  /* SIGNAL-P8: zero sources is a FIRST RUN, not an empty table. The wizard replaces both
     the empty state and the everyday add-form here rather than sitting beside them, so
     there is one flow at a time: guided until something is followed, then the normal
     add-one-more form. It walks the same steps as `signal onboard` against the same routes.
     `data` is null until the first fetch resolves, so this must key off the resolved list,
     not off `sources.length` alone, or the wizard would flash during loading. */
  const firstRun = Boolean(data) && sources.length === 0;

  return (
    <AsyncBoundary loading={loading} error={error} onRetry={retry} skeletonLines={6}>
      <div className="qx-stack">
        <div className="qx-row qx-row--apart">
          <RefreshControl
            onRefresh={() => retry({ force: true, silent: true })}
            loading={refreshing}
            updatedAt={updatedAt}
          />
        </div>

        {firstRun ? <OnboardingWizard onDone={retry} /> : <AddSourceForm onAdded={retry} />}

        <div className="qx-row qx-row--apart">
          <span className="qx-hint">{sources.length} source(s) followed</span>
          {badCount > 0 && <span className="qx-pill qx-pill--danger qx-pill--xs">{badCount} need attention</span>}
        </div>

        {sources.length === 0 ? null : (
          <div className="qx-card qx-card--compact" style={{ overflow: 'auto' }}>
            <table className="qx-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Label</th>
                  <th>Platform</th>
                  <th>Kind</th>
                  <th>Autonomy</th>
                  <th>Health</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sources.map((source) => <SourceRow key={source.id} source={source} onChanged={retry} />)}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AsyncBoundary>
  );
}
