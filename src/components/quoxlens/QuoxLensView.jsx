/**
 * QuoxLensView — QuoxLens mounted as a native Quox dashboard view.
 *
 * QUOXLENS-UI: QuoxLens had six phases of working engine
 * (lensComposer/lensContract/unprovenGate/lensFindings/lensPanel/
 * lensEvidence) and no UI at all. This is the surface. Follows the same
 * RepoBrainView/QuoxSignalView pattern every other dashboard view uses: a
 * single `qx-view` with a command-strip header (health dot/pill +
 * `.qx-tabs`) and the tab content below. No ported chrome from anywhere
 * else — the dashboard's own chrome is the only chrome.
 *
 * Lenses/Findings/Evidence are `?tab=` query-param panes, same idiom as
 * QuoxSignalView's Feed/Sources/Proposals. Findings and Evidence share two
 * more query params (`scope`, `fp`) so a specific finding's evidence chain
 * is directly linkable — clicking "Evidence" on a Findings row sets all
 * three params in one shot.
 *
 * QUOXLENS-GATING: unlicensed users get QuoxLensLocked instead of the tab
 * panes, same mechanism (isPluginLicensed) and same posture as
 * QuoxSignalView -- currently a no-op in practice since quoxlens is not yet
 * in the server's LICENSE_GOVERNED_PLUGINS set, see docs/QUOXLENS_GATING.md.
 */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from './lib/api.js';
import LensesView from './views/LensesView.jsx';
import FindingsView from './views/FindingsView.jsx';
import EvidenceView from './views/EvidenceView.jsx';
import QuoxLensLocked from './QuoxLensLocked.jsx';
import { usePluginLicensed } from '../../hooks/usePluginLicensed';

const TABS = [
  { key: 'lenses', label: 'Lenses' },
  { key: 'findings', label: 'Findings' },
  { key: 'evidence', label: 'Evidence' },
];

function CommandStrip({ tab, onTabChange }) {
  const [health, setHealth] = useState({ ok: null, lensCount: null });

  useEffect(() => {
    let cancelled = false;
    api.health()
      .then((data) => { if (!cancelled) setHealth({ ok: true, lensCount: data.lens_count }); })
      .catch(() => { if (!cancelled) setHealth({ ok: false, lensCount: null }); });
    return () => { cancelled = true; };
  }, []);

  const dotClass = health.ok === null ? 'qx-dot--idle' : health.ok ? 'qx-dot--online' : 'qx-dot--offline';
  const pillClass = health.ok === null ? 'qx-pill--ghost' : health.ok ? 'qx-pill--online' : 'qx-pill--offline';
  const pillText = health.ok === null ? 'checking...' : health.ok ? `${health.lensCount} Lens(es) registered` : 'collector unreachable';

  return (
    <div className="qx-card qx-card--bar qx-row qx-row--apart">
      <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
        <strong>QuoxLens</strong>
        <span className={`qx-dot ${dotClass}`} aria-hidden="true" />
        <span className={`qx-pill ${pillClass} qx-pill--xs`}>{pillText}</span>
        <div className="qx-tabs" role="tablist" aria-label="QuoxLens tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              className={`qx-tab${tab === t.key ? ' qx-tab--active' : ''}`}
              onClick={() => onTabChange(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function TabPanes() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'lenses';
  const scope = params.get('scope') || null;
  const fingerprint = params.get('fp') || null;

  function switchTab(next) {
    const nextParams = new URLSearchParams(params);
    nextParams.set('tab', next);
    setParams(nextParams, { replace: true });
  }

  function selectScope(nextScope) {
    const nextParams = new URLSearchParams(params);
    nextParams.set('scope', nextScope);
    setParams(nextParams, { replace: true });
  }

  function viewEvidence(nextScope, nextFingerprint) {
    const nextParams = new URLSearchParams(params);
    nextParams.set('tab', 'evidence');
    nextParams.set('scope', nextScope);
    nextParams.set('fp', nextFingerprint);
    setParams(nextParams, { replace: true });
  }

  return (
    <div className="qx-stack" style={{ height: '100%' }}>
      <CommandStrip tab={tab} onTabChange={switchTab} />
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {tab === 'lenses' && <LensesView />}
        {tab === 'findings' && (
          <FindingsView scope={scope} onSelectScope={selectScope} onViewEvidence={viewEvidence} />
        )}
        {tab === 'evidence' && <EvidenceView scope={scope} fingerprint={fingerprint} />}
      </div>
    </div>
  );
}

export default function QuoxLensView() {
  const licensed = usePluginLicensed('quoxlens');

  if (!licensed) {
    return <QuoxLensLocked />;
  }

  return (
    <div className="qx-view" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <TabPanes />
    </div>
  );
}
