/**
 * QuoxPlanView — QuoxPlan mounted as a native Quox dashboard view.
 *
 * QUOXPLAN-P4 dashboard embed (owner course-correction 2026-07-25): no
 * ported sidebar/topbar/app-shell chrome. This follows the RepoBrainView
 * pattern instead — a single `qx-view` with a header row (roadmap switcher +
 * qx-tabs + Edit/ROADY controls) and the tab content below, exactly like
 * every other dashboard view. The dashboard's own chrome is the only chrome.
 *
 * Internal routing is preserved as nested <Routes> under /quoxplan/* so
 * :roadmapId/focus|board|timeline|streams and streams/:streamId keep working
 * as real URLs (deep-linkable, back-button-friendly) — this satisfies
 * "sub-route" for stream drill-in, matching RepoBrainView's own use of
 * useSearchParams for tab state, just with real path segments since QuoxPlan
 * needs shareable stream/roadmap URLs.
 */
import { useRef, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { RoadmapProvider, useRoadmapCtx, useCurrentRoadmapId } from './context/RoadmapContext.jsx';
import { EditModeProvider, useEditMode } from './context/EditModeContext.jsx';
import { usePersistedBool } from './lib/viewPrefs.js';
import RoadyRail from './components/RoadyRail.jsx';
import ScopeSelector from './components/ScopeSelector.jsx';
import PortalMenu from './components/PortalMenu.jsx';
import ToastStack from './components/ToastStack.jsx';
import AsyncBoundary from './components/AsyncBoundary.jsx';
import OnboardingWizard from './views/OnboardingWizard.jsx';
import FocusView from './views/FocusView.jsx';
import BoardView from './views/BoardView.jsx';
import TimelineView from './views/TimelineView.jsx';
import StreamsView from './views/StreamsView.jsx';
import StreamPage from './views/StreamPage.jsx';
import './styles/quoxplan.css';
import './styles/quoxplan-identity.css';

const TABS = [
  { key: 'focus', label: 'Focus' },
  { key: 'board', label: 'Board' },
  { key: 'timeline', label: 'Timeline' },
  { key: 'streams', label: 'Streams' }
];

/**
 * QUOXPLAN-P7 onboarding (owner feedback wave 2, item 2): shows the
 * first-run wizard instead of the plain empty view when the caller's org has
 * no roadmaps yet. In dev, unscoped legacy roadmaps (quox-strategic, the
 * Meridian corpus) mean this branch never fires naturally, so `?onboarding=1`
 * force-previews it for QA/screenshots regardless of `roadmaps.length` or
 * the dismissed pref.
 */
function RootRedirect({ onOpenRoady }) {
  const { roadmaps, loading, error } = useRoadmapCtx();
  const [searchParams] = useSearchParams();
  const forcePreview = searchParams.get('onboarding') === '1';
  const [dismissed, setDismissed] = usePersistedBool('quoxplan.onboarding.dismissed', false);

  if (loading || error) {
    return (
      <div className="qx-pad">
        <AsyncBoundary loading={loading} error={error} skeletonLines={6} />
      </div>
    );
  }
  if ((roadmaps.length === 0 && !dismissed) || forcePreview) {
    return <OnboardingWizard onOpenRoady={onOpenRoady} onDismiss={() => setDismissed(true)} forcePreview={forcePreview} />;
  }
  if (roadmaps.length === 0) {
    return (
      <div className="qx-empty">
        <div className="qx-empty__title">No roadmaps yet</div>
        <div className="qx-empty__body">The QuoxPlan server has no roadmaps seeded.</div>
      </div>
    );
  }
  return <Navigate to={`/quoxplan/${roadmaps[0].id}/focus`} replace />;
}

function RoadmapRouteGuard({ children }) {
  const { roadmapId } = useParams();
  const { roadmaps, loading } = useRoadmapCtx();
  if (loading) return children;
  if (roadmaps.length > 0 && !roadmaps.some((r) => r.id === roadmapId)) {
    return <Navigate to={`/quoxplan/${roadmaps[0].id}/focus`} replace />;
  }
  return children;
}

/**
 * Compact qx-menu dropdown replacing the old sidebar's roadmap list.
 *
 * Positioned via the shared `PortalMenu` (components/PortalMenu.jsx) —
 * extracted from this component's original inline portal implementation.
 * See PortalMenu's own doc comment for why the menu must portal to
 * `document.body` at all (the "clipped dropdown" root cause: this switcher
 * lives inside a `.qx-card` header row, and `.qx-card` sets
 * `overflow: hidden` app-wide, which clips any absolutely-positioned
 * popover anchored inside one).
 */
function RoadmapSwitcher({ activeTab }) {
  const { roadmaps } = useRoadmapCtx();
  const currentRoadmapId = useCurrentRoadmapId();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef(null);

  if (roadmaps.length === 0) return null;
  const current = roadmaps.find((r) => r.id === currentRoadmapId);

  return (
    <div ref={anchorRef} style={{ position: 'relative' }}>
      <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={() => setOpen((v) => !v)}>
        {current?.name || 'Roadmap'} <span aria-hidden="true">&#9662;</span>
      </button>
      <PortalMenu open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} className="qxp-roadmap-menu" minWidth={220}>
        {roadmaps.map((r) => (
          <button
            key={r.id}
            type="button"
            className={`qx-menu__item${r.id === currentRoadmapId ? ' qx-menu__item--active' : ''}`}
            onClick={() => {
              setOpen(false);
              navigate(`/quoxplan/${r.id}/${activeTab || 'focus'}`);
            }}
          >
            <span style={{ flex: 1, textAlign: 'left' }}>{r.name}</span>
            {r.open_action_items > 0 && (
              <span className="qx-chip qx-chip--xs qxp-mono">{r.open_action_items}</span>
            )}
          </button>
        ))}
      </PortalMenu>
    </div>
  );
}

function TabLink({ tab, active }) {
  const currentRoadmapId = useCurrentRoadmapId();
  const navigate = useNavigate();
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`qx-tab${active ? ' qx-tab--active' : ''}`}
      onClick={() => navigate(currentRoadmapId ? `/quoxplan/${currentRoadmapId}/${tab.key}` : '/quoxplan')}
    >
      {tab.label}
    </button>
  );
}

function QuoxPlanShell() {
  const location = useLocation();
  const { health } = useRoadmapCtx();
  const { editMode, toggleEditMode } = useEditMode();
  const [roadyOpen, setRoadyOpen] = usePersistedBool('quoxplan.roady.open', false);
  const activeTab = TABS.find((t) => location.pathname.includes(`/${t.key}`))?.key;
  const currentRoadmapId = useCurrentRoadmapId();
  // /quoxplan/streams/:streamId is a roadmap-agnostic sub-route (see
  // RoadmapContext.useCurrentRoadmapId comment), so the stream id is read
  // straight off the location here rather than via useParams (this
  // component sits above the nested <Routes> as a sibling, not a descendant
  // of that specific Route match).
  const currentStreamId = location.pathname.match(/\/quoxplan\/streams\/([^/]+)/)?.[1] || null;

  const dotClass = health.ok === null ? 'qx-dot--idle' : health.ok ? 'qx-dot--online' : 'qx-dot--offline';
  const pillClass = health.ok === null ? 'qx-pill--ghost' : health.ok ? 'qx-pill--online' : 'qx-pill--offline';
  const pillText = health.ok === null ? 'checking...' : health.ok ? `server ok · v${health.version}` : 'server unreachable';

  return (
    <div className="qx-view" style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div className="qx-card qx-card--bar qx-row qx-row--apart qxp-view-bar">
        <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
          <strong>QuoxPlan</strong>
          <span className={`qx-dot ${dotClass}`} aria-hidden="true" />
          <span className={`qx-pill ${pillClass} qx-pill--xs`}>{pillText}</span>
          <RoadmapSwitcher activeTab={activeTab} />
          <ScopeSelector />
          <div className="qx-tabs" role="tablist" aria-label="QuoxPlan tabs">
            {TABS.map((t) => (
              <TabLink key={t.key} tab={t} active={activeTab === t.key} />
            ))}
          </div>
        </div>
        <div className="qx-row qx-row--tight">
          <span className="qx-tip qx-tip--below" data-tip={editMode ? 'Turn governed editing off' : 'Turn on governed editing'}>
            <button
              type="button"
              className={`qx-btn qx-btn--sm${editMode ? ' qxp-edit-btn--active' : ''}`}
              onClick={toggleEditMode}
            >
              {editMode ? 'Editing' : 'Edit'}
            </button>
          </span>
          <span className="qx-tip qx-tip--below" data-tip="Ask ROADY about this roadmap">
            <button
              type="button"
              className={`qx-btn qx-btn--sm${roadyOpen ? ' qxp-edit-btn--active' : ''}`}
              onClick={() => setRoadyOpen((v) => !v)}
              aria-pressed={roadyOpen}
            >
              ROADY
            </button>
          </span>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', marginTop: 16, gap: 16 }}>
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto' }}>
          <Routes>
            <Route path="/" element={<RootRedirect onOpenRoady={() => setRoadyOpen(true)} />} />
            <Route
              path=":roadmapId/focus"
              element={
                <RoadmapRouteGuard>
                  <FocusView />
                </RoadmapRouteGuard>
              }
            />
            <Route
              path=":roadmapId/board"
              element={
                <RoadmapRouteGuard>
                  <BoardView />
                </RoadmapRouteGuard>
              }
            />
            <Route
              path=":roadmapId/timeline"
              element={
                <RoadmapRouteGuard>
                  <TimelineView />
                </RoadmapRouteGuard>
              }
            />
            <Route
              path=":roadmapId/streams"
              element={
                <RoadmapRouteGuard>
                  <StreamsView />
                </RoadmapRouteGuard>
              }
            />
            <Route path="streams/:streamId" element={<StreamPage />} />
            <Route path="*" element={<Navigate to="/quoxplan" replace />} />
          </Routes>
        </div>
        {roadyOpen && (
          <RoadyRail
            onClose={() => setRoadyOpen(false)}
            roadmapId={currentRoadmapId}
            streamId={currentStreamId}
          />
        )}
      </div>
      <ToastStack />
    </div>
  );
}

export default function QuoxPlanView() {
  return (
    <EditModeProvider>
      <RoadmapProvider>
        <QuoxPlanShell />
      </RoadmapProvider>
    </EditModeProvider>
  );
}
