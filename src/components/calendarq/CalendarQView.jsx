/**
 * CalendarQView — Calendar-Q mounted as a native Quox dashboard view
 * (AQ-9B L2-C1b).
 *
 * Same posture as InboxQView/QuoxSignalView: collector-native, no
 * standalone app, no PageLayout wrapper — `.qx-view.cq-view` installs its
 * own bounded height chain (toolbar, tab strip, main pane, chat dock).
 *
 * Toolbar: icon + name, a coverage pill for the primary provider connection
 * (from GET /coverage), a freshness time, and a manual Sync button (POST
 * /sync). Tab strip: Calendar | Schedules | Connections | Receipts, each a
 * plain React state switch (no nested routes needed in this read-first
 * phase). Right-hand dock: CalendarQChatSidebar bound to the 'calendar-q'
 * agent, same chassis InboxQChatSidebar uses.
 */
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { usePluginLicensed, usePluginLicenseDiagnosis } from '../../hooks/usePluginLicensed';
import LicenceGate from '../plugins/LicenceGate';
import CalendarQLocked from './CalendarQLocked.jsx';
import CalendarQChatSidebar from './CalendarQChatSidebar.jsx';
import CalendarTab from './tabs/CalendarTab.jsx';
import SchedulesTab from './tabs/SchedulesTab.jsx';
import ConnectionsTab from './tabs/ConnectionsTab.jsx';
import ReceiptsTab from './tabs/ReceiptsTab.jsx';
import { getStatus, getCoverage, sync } from '../../services/calendarQService';
import './calendarq.css';

const TABS = [
  { key: 'calendar', label: 'Calendar' },
  { key: 'schedules', label: 'Schedules' },
  { key: 'connections', label: 'Connections' },
  { key: 'receipts', label: 'Receipts' },
];

const CalendarIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: '#c9a3ff' }}>
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <line x1="16" y1="2" x2="16" y2="6" />
    <line x1="8" y1="2" x2="8" y2="6" />
    <line x1="3" y1="10" x2="21" y2="10" />
  </svg>
);

const COVERAGE_PILL_VARIANT = {
  complete: 'qx-pill--online',
  empty: 'qx-pill--ghost',
  partial: 'qx-pill--medium',
  stale: 'qx-pill--medium',
  disconnected: 'qx-pill--offline',
  unavailable: 'qx-pill--offline',
};

/** Toolbar: name, the TAB STRIP (merged in — one chrome row like Apple, it
 * bought back the 720p fold budget the NotesQ header card spends), coverage
 * pill for the primary connection, freshness time, Sync. The old inline
 * "Read-first scheduling…" sentence lives on as the title tooltip. */
function Toolbar({ primaryConnection, coverage, syncing, onSync, tab, onTab }) {
  const freshness = coverage?.freshnessTs ? new Date(coverage.freshnessTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
  const pillVariant = coverage ? (COVERAGE_PILL_VARIANT[coverage.state] || 'qx-pill--ghost') : 'qx-pill--ghost';
  const pillText = coverage ? coverage.state : (primaryConnection ? 'checking…' : 'not connected');

  return (
    <div className="qx-card qx-card--bar qx-surface--backed qx-row qx-row--apart cq-toolbar">
      <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }} title="Read-first scheduling. Event creation arrives with approvals in the next phase.">
        <CalendarIcon />
        <strong>Calendar-Q</strong>
        <span className={`qx-pill qx-pill--xs ${pillVariant}`}>{pillText}</span>
      </div>
      <div className="qx-tabs qx-tabs--plain cq-tabs" role="tablist" aria-label="Calendar-Q tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`qx-tab${tab === t.key ? ' qx-tab--active' : ''}`}
            onClick={() => onTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
        {freshness && <span className="qx-hint qx-hint--sm">checked {freshness}</span>}
        <button
          type="button"
          className="qx-btn qx-btn--sm qx-btn--ghost"
          disabled={!primaryConnection || syncing}
          onClick={onSync}
          title={primaryConnection ? 'Manually sync the primary connection' : 'Connect a calendar first in the Connections tab'}
        >
          {syncing ? (<><span className="qx-spinner qx-spinner--sm" style={{ marginRight: 6 }} aria-hidden="true" /> Syncing…</>) : 'Sync'}
        </button>
      </div>
    </div>
  );
}

function CalendarQContent() {
  const { authFetch } = useAuth();
  const [tab, setTab] = useState('calendar');
  const [status, setStatus] = useState(null);
  const [coverage, setCoverage] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [overlayForChat, setOverlayForChat] = useState({ layers: [], clashCount: 0, coverageSummary: '' });
  const [chatCollapsed, setChatCollapsed] = useState(false);

  const primaryConnection = status?.connections?.[0] || null;

  const loadStatus = useCallback(() => {
    getStatus(authFetch)
      .then((res) => {
        setStatus(res);
        const first = res?.connections?.[0];
        if (first) {
          return getCoverage(authFetch, { connectionId: first.connectionId })
            .then((covRes) => setCoverage(covRes.coverage))
            .catch(() => setCoverage(null));
        }
        setCoverage(null);
        return undefined;
      })
      .catch(() => { /* toolbar degrades to "not connected" rather than blocking the view */ });
  }, [authFetch]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const handleSync = useCallback(async () => {
    if (!primaryConnection) return;
    setSyncing(true);
    try {
      await sync(authFetch, { connectionId: primaryConnection.connectionId });
      loadStatus();
    } catch {
      // the toolbar's own coverage pill reflects the real post-sync state on
      // the next load; a transient sync failure here isn't treated as fatal.
    } finally {
      setSyncing(false);
    }
  }, [authFetch, primaryConnection, loadStatus]);

  const handleOverlayLoaded = useCallback((overlay, clashes) => {
    setOverlayForChat({
      layers: overlay?.layers || [],
      clashCount: clashes?.length || 0,
      coverageSummary: (overlay?.layers || []).map((l) => `${l.displayName} (${l.coverage?.state || 'unknown'})`).join('; '),
    });
  }, []);

  return (
    <div className="qx-view cq-view">
      <div className="cq-workspace">
        <Toolbar primaryConnection={primaryConnection} coverage={coverage} syncing={syncing} onSync={handleSync} tab={tab} onTab={setTab} />

        <div className="cq-body">
          {/* NotesQ look (owner 2026-10-10): the main pane is a transparent
              scroll column — each tab's own cards carry the glass, so the
              page reads as broken-up cards rather than one backed slab. */}
          <div className="cq-main">
            {tab === 'calendar' && <CalendarTab onOverlayLoaded={handleOverlayLoaded} />}
            {tab === 'schedules' && <SchedulesTab />}
            {tab === 'connections' && <ConnectionsTab />}
            {tab === 'receipts' && <ReceiptsTab />}
          </div>

          {/* Agent docked as the last column (NotesQ rule 6); collapsing it
              leaves a clickable pane rail in the same column (rule 4) rather
              than a bare 48px sliver, so the hide is visibly reversible. */}
          {chatCollapsed ? (
            <aside
              className="qx-pane-rail qx-card qx-card--compact cq-chat-rail"
              aria-label="CALENDAR-Q chat (hidden)"
              onClick={() => setChatCollapsed(false)}
              data-testid="calendarq-chat-rail"
            >
              <button
                type="button"
                className="qx-btn qx-btn--ghost qx-btn--sm"
                aria-label="Expand CALENDAR-Q chat"
                title="Expand CALENDAR-Q chat"
                onClick={(e) => { e.stopPropagation(); setChatCollapsed(false); }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="11 17 6 12 11 7" /><polyline points="18 17 13 12 18 7" />
                </svg>
              </button>
              <span className="qx-pane-rail__icon" aria-hidden="true"><CalendarIcon /></span>
              <span className="qx-pane-rail__label">CALENDAR-Q</span>
            </aside>
          ) : (
            <div className="cq-chat-dock qx-surface--backed">
              <CalendarQChatSidebar
                tab={tab}
                layers={overlayForChat.layers}
                clashCount={overlayForChat.clashCount}
                coverageSummary={overlayForChat.coverageSummary}
                collapsed={false}
                onToggle={() => setChatCollapsed(true)}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function CalendarQView() {
  // Same gating mechanism as every other paid plugin view — see
  // InboxQView/usePluginLicensed.
  const licensed = usePluginLicensed('calendar-q');
  const diag = usePluginLicenseDiagnosis('calendar-q');

  if (!licensed) {
    // Governed since 2026-10-07: an org-seat problem is explained, not sold again.
    return <LicenceGate diag={diag} displayName="Calendar-Q" locked={<CalendarQLocked />} />;
  }

  return <CalendarQContent />;
}
