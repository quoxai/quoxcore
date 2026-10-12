/**
 * NOCPopout — Standalone popout window for NOC tabs
 *
 * Opens via window.open() from the main NOC view.
 * Syncs state with the main window via BroadcastChannel.
 * Designed for multi-monitor NOC setups.
 */

import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageGrid } from '../components/layout';
import { ProxmoxPanel, MetricsPanel, UptimePanel, GrafanaEmbed, GrafanaAlertBadge } from '../components/core/monitoring';
import { isPluginLicensed } from '../services/licenseValidator';
import './views/noc.css';

const NOC_TABS = [
  { id: 'fleet', label: 'Fleet' },
  { id: 'operations', label: 'Operations' },
  { id: 'monitoring', label: 'Monitoring' },
];

function NOCPopout() {
  const [searchParams] = useSearchParams();
  const tabId = searchParams.get('tab') || 'monitoring';
  const tab = NOC_TABS.find(t => t.id === tabId) || NOC_TABS[2];

  const [connected, setConnected] = useState(false);
  const [state, setState] = useState({ hosts: [], pingResults: {}, bastionStatus: { available: false }, usingMockData: true });
  const channelRef = useRef(null);

  useEffect(() => {
    document.title = `NOC — ${tab.label} — QuoxCORE`;

    channelRef.current = new BroadcastChannel('quox-noc-sync');

    channelRef.current.onmessage = (e) => {
      if (e.data.type === 'state-update') {
        setState(e.data.payload);
        setConnected(true);
      }
    };

    // Request current state from main window
    channelRef.current.postMessage({ type: 'request-state' });

    // Heartbeat: request state every 10s
    const heartbeat = setInterval(() => {
      channelRef.current?.postMessage({ type: 'request-state' });
    }, 10000);

    // Detect disconnection after 15s without updates
    let lastUpdate = Date.now();
    const checkConnection = setInterval(() => {
      if (Date.now() - lastUpdate > 15000) setConnected(false);
    }, 5000);

    const origOnMessage = channelRef.current.onmessage;
    channelRef.current.onmessage = (e) => {
      lastUpdate = Date.now();
      origOnMessage(e);
    };

    return () => {
      clearInterval(heartbeat);
      clearInterval(checkConnection);
      channelRef.current?.close();
    };
  }, [tab.label]);

  const handleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen();
    }
  };

  return (
    <div className="noc-popout noc">
      <div className="noc-popout__header">
        <div className="noc-popout__title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
          NOC — {tab.label}
        </div>
        <div className="noc-popout__actions">
          {!connected && (
            <div className="noc-popout__disconnected">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              Disconnected from main window
            </div>
          )}
          <button onClick={handleFullscreen} title="Toggle fullscreen">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
            Fullscreen
          </button>
          <button onClick={() => window.close()} title="Close popout">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            Close
          </button>
        </div>
      </div>

      {/* Monitoring tab — most useful as popout */}
      {tabId === 'monitoring' && (
        <div className="noc__monitoring">
          <GrafanaAlertBadge pollInterval={30000} />
          {(isPluginLicensed('proxmox') || isPluginLicensed('prometheus')) && (
            <PageGrid columns={2}>
              {isPluginLicensed('proxmox') && <ProxmoxPanel />}
              {isPluginLicensed('prometheus') && <MetricsPanel />}
            </PageGrid>
          )}
          {isPluginLicensed('uptime-kuma') && <UptimePanel />}
          {isPluginLicensed('grafana') && <GrafanaEmbed />}
        </div>
      )}

      {/* Fleet tab — shows host data from BroadcastChannel */}
      {tabId === 'fleet' && (
        <div style={{ padding: '40px', textAlign: 'center', color: '#666' }}>
          <p>Fleet popout receives live data from the main NOC window.</p>
          <p style={{ fontFamily: "'SF Mono', monospace", fontSize: '12px', marginTop: '8px' }}>
            {state.hosts.length} hosts | {Object.values(state.pingResults).filter(p => p.reachable).length} online
          </p>
          {!connected && <p style={{ color: '#ffb030', marginTop: '16px' }}>Waiting for main window connection...</p>}
        </div>
      )}

      {/* Operations tab placeholder */}
      {tabId === 'operations' && (
        <div style={{ padding: '40px', textAlign: 'center', color: '#666' }}>
          <p>Operations actions run from the main NOC window.</p>
          <p style={{ fontSize: '12px', marginTop: '8px' }}>Use this popout for monitoring dashboards instead.</p>
        </div>
      )}
    </div>
  );
}

export default NOCPopout;
