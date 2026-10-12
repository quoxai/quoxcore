/**
 * WazuhView - Wazuh SIEM Plugin
 *
 * Layout (licensed): side-by-side WazuhPanel (SIEM ops) + ARGUS chat sidebar.
 * Cyan-refactored — consumes global .qx-* utilities, no bespoke view CSS.
 */

import { useState, useEffect } from 'react';
import { PageLayout } from '../../components/layout';
import WazuhPanel from '../../components/wazuh/WazuhPanel';
import WazuhChatSidebar from '../../components/wazuh/WazuhChatSidebar';
import WazuhSetupGate from '../../components/wazuh/WazuhSetupGate';
import PluginLicenseNotice from '../../components/plugins/PluginLicenseNotice';
import { usePluginLicenseDiagnosis } from '../../hooks/usePluginLicensed';
import { isWazuhConfigured, checkWazuhConfiguredServer } from '../../services/wazuhClient';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import './views.css';

export default function WazuhView() {
  const { authFetch } = useAuth();
  const { currentOrg } = useWorkspace();
  const orgId = currentOrg?.id;
  const diag = usePluginLicenseDiagnosis('wazuh');
  const licensed = diag.licensed;
  // ZERO TOLERANCE — server vault is the source of truth, not the browser-
  // local `isWazuhConfigured()` flag: seed with it (avoids a flash of the
  // setup gate for the common case) but confirm/override from the server
  // once orgId is known, so a fresh browser (or another device) still sees
  // "already configured" without ever having written to localStorage here.
  const [configured, setConfigured] = useState(() => isWazuhConfigured());
  const [checkingServer, setCheckingServer] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');

  useEffect(() => {
    let cancelled = false;
    if (!orgId) {
      setCheckingServer(false);
      return undefined;
    }
    checkWazuhConfiguredServer(orgId, authFetch).then((serverConfigured) => {
      if (cancelled) return;
      if (serverConfigured) setConfigured(true);
      setCheckingServer(false);
    });
    return () => { cancelled = true; };
  }, [orgId, authFetch]);

  if (!licensed) {
    return <PluginLicenseNotice diag={diag} displayName="Wazuh SIEM" accentColor="#00a9e5" />;
  }

  // Wait for the server-side check before showing the setup gate, so a
  // configured org never flashes it while checkWazuhConfiguredServer is
  // still in flight (localStorage-seeded `configured` only short-circuits
  // this to `true`, never to a false negative).
  if (!configured && checkingServer) {
    return <PageLayout><div className="qx-view" /></PageLayout>;
  }

  if (!configured) {
    return <WazuhSetupGate orgId={orgId} onConfigured={() => setConfigured(true)} />;
  }

  return (
    <PageLayout>
      <div className="qx-view">
        <div className="wazuh-v2-layout">
          <div className="wazuh-v2">
            <WazuhPanel activeTab={activeTab} onTabChange={setActiveTab} />
          </div>
          {sidebarOpen && (
            <aside className="wazuh-sidebar">
              <WazuhChatSidebar activeTab={activeTab} onClose={() => setSidebarOpen(false)} />
            </aside>
          )}
          {!sidebarOpen && (
            <button
              className="qx-btn qx-btn--sm"
              style={{
                position: 'absolute',
                right: 16,
                top: '50%',
                transform: 'translateY(-50%)',
                zIndex: 10,
                writingMode: 'vertical-rl',
                padding: '12px 6px',
              }}
              onClick={() => setSidebarOpen(true)}
              title="Open ARGUS"
            >
              ARGUS
            </button>
          )}
        </div>
      </div>
    </PageLayout>
  );
}
