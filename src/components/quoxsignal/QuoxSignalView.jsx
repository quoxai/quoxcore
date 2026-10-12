/**
 * QuoxSignalView — QuoxSignal mounted as a native Quox dashboard view.
 *
 * SIGNAL-EMBED (owner course-correction, mirroring QUOXPLAN-P4): no ported
 * sidebar/topbar/app-shell chrome from the standalone app. Follows the
 * RepoBrainView pattern — a single `qx-view` with a command-strip header
 * (health dot/pill + `.qx-tabs`) and the tab content below, exactly like
 * every other dashboard view. The dashboard's own chrome is the only chrome.
 *
 * Feed/Sources/Proposals are `?tab=` query-param panes (RepoBrainView's own
 * idiom); item detail is a real nested route (`items/:id`) since it needs a
 * shareable, deep-linkable URL — same reasoning as QuoxPlan's
 * `streams/:streamId` sub-route.
 *
 * The standalone web/ app at /opt/quoxcore/quox-signal/web stays as-is, as a
 * dev harness — untouched by this embed, same as QuoxPlan's own standalone
 * app.
 */
import { useEffect, useState } from 'react';
import { Route, Routes, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from './lib/api.js';
import FeedView from './views/FeedView.jsx';
import SourcesView from './views/SourcesView.jsx';
import ProposalsView from './views/ProposalsView.jsx';
import ItemDetailView from './views/ItemDetailView.jsx';
import PipelineBar from './components/PipelineBar.jsx';
import PluginLicenseNotice from '../plugins/PluginLicenseNotice';
import { usePluginLicenseDiagnosis } from '../../hooks/usePluginLicensed';

const TABS = [
  { key: 'feed', label: 'Feed' },
  { key: 'sources', label: 'Sources' },
  { key: 'proposals', label: 'Proposals' },
];

function CommandStrip({ tab, onTabChange }) {
  const [health, setHealth] = useState({ ok: null, version: null });

  useEffect(() => {
    let cancelled = false;
    api.health()
      .then((data) => { if (!cancelled) setHealth({ ok: true, version: data.version }); })
      .catch(() => { if (!cancelled) setHealth({ ok: false, version: null }); });
    return () => { cancelled = true; };
  }, []);

  /* Month-to-date spend, in the header where it is unavoidable. The product promises the
     cost is visible BEFORE you spend, which is a hollow promise if nothing ever tells you
     what you have already spent. Guarded and silent on failure: a missing figure must not
     take the surface down, but it must not silently read as zero either, hence null. */
  const [spend, setSpend] = useState(null);
  useEffect(() => {
    let cancelled = false;
    if (typeof api.listBudgets !== 'function') return undefined;
    api.listBudgets()
      .then((d) => { if (!cancelled) setSpend(d?.org || null); })
      .catch(() => { /* cosmetic */ });
    return () => { cancelled = true; };
  }, []);

  const dotClass = health.ok === null ? 'qx-dot--idle' : health.ok ? 'qx-dot--online' : 'qx-dot--offline';
  const pillClass = health.ok === null ? 'qx-pill--ghost' : health.ok ? 'qx-pill--online' : 'qx-pill--offline';
  const pillText = health.ok === null ? 'checking...' : health.ok ? `server ok · v${health.version}` : 'server unreachable';

  return (
    <div className="qx-card qx-card--bar qx-row qx-row--apart">
      <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
        <strong>QuoxSignal</strong>
        <span className={`qx-dot ${dotClass}`} aria-hidden="true" />
        <span className={`qx-pill ${pillClass} qx-pill--xs`}>{pillText}</span>
        <span className="qx-hint qx-hint--sm" title="What this surface is for">
          Watch sources, transcribe what you pick, score it against your roadmap.
        </span>
        {spend && (
          <span
            className="qx-pill qx-pill--ghost qx-pill--xs"
            title={`Month to date against the ${spend.monthly_period} cap. Transcription and analysis both spend.`}
          >
            ${Number(spend.monthly_spend_usd || 0).toFixed(2)} / ${Number(spend.monthly_cap_usd || 0).toFixed(0)} this month
          </span>
        )}
        <div className="qx-tabs" role="tablist" aria-label="QuoxSignal tabs">
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

  /* SIGNAL-P8: a first run has no items, so landing on the Feed shows an empty list and
     nothing to do about it. When the org follows ZERO sources and no tab was asked for
     explicitly, open on Sources, which is where the first-run wizard lives. An explicit
     ?tab= always wins: this redirects a default, never a choice.
     Guarded on the method existing, the same posture as FeedView's avatar join, so a
     client surface without listSources degrades to the old behaviour instead of throwing. */
  const [noSources, setNoSources] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (typeof api.listSources !== 'function') return undefined;
    api.listSources()
      .then((d) => { if (!cancelled) setNoSources((d?.sources || []).length === 0); })
      .catch(() => { /* the tab default is cosmetic; never take the surface down for it */ });
    return () => { cancelled = true; };
  }, []);

  const tab = params.get('tab') || (noSources ? 'sources' : 'feed');
  const stage = params.get('stage') || '';
  const lane = params.get('lane') || 'pending';

  function switchTab(next) {
    const nextParams = new URLSearchParams(params);
    nextParams.set('tab', next);
    // SIGNAL-PIPELINE alignment: the plain tabs are the UNFILTERED views.
    // Without this, switching to Feed after visiting a station kept the old
    // ?stage= and silently showed a filtered list labelled as the Feed.
    nextParams.delete('stage');
    nextParams.delete('lane');
    setParams(nextParams, { replace: true });
  }

  // SIGNAL-PIPELINE: a station click sets every param it names and CLEARS the
  // ones it doesn't, so "Feed" always means the discovered station rather
  // than whatever stage filter was left behind by the last click.
  function navigateStation(to) {
    const nextParams = new URLSearchParams(params);
    nextParams.set('tab', to.tab);
    if (to.stage) nextParams.set('stage', to.stage); else nextParams.delete('stage');
    if (to.lane) nextParams.set('lane', to.lane); else nextParams.delete('lane');
    setParams(nextParams, { replace: true });
  }

  return (
    <div className="qx-stack" style={{ height: '100%' }}>
      <CommandStrip tab={tab} onTabChange={switchTab} />
      <PipelineBar tab={tab} stage={stage} lane={lane} onNavigate={navigateStation} />
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {tab === 'feed' && <FeedView />}
        {tab === 'sources' && <SourcesView />}
        {tab === 'proposals' && <ProposalsView />}
      </div>
    </div>
  );
}

export default function QuoxSignalView() {
  // SIGNAL-GATING: unlicensed users get the sales surface, not the feed —
  // same gating mechanism as every other paid plugin view (isPluginLicensed
  // reads the server-fetched entitlement cache, see UptimeKumaView/
  // QuoxbrainView). Currently a no-op in practice: quoxsignal is not yet in
  // the server's LICENSE_GOVERNED_PLUGINS set, so isPluginLicensed()
  // returns true for everyone until that cutover lands (see
  // docs/QUOXSIGNAL_GATING.md).
  const diag = usePluginLicenseDiagnosis('quoxsignal');

  if (!diag.licensed) {
    return <PluginLicenseNotice diag={diag} displayName="QuoxSignal" accentColor="#38bdf8" />;
  }

  return (
    <div className="qx-view" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Routes>
        <Route path="/" element={<TabPanes />} />
        <Route path="items/:id" element={<ItemDetailView />} />
      </Routes>
    </div>
  );
}
