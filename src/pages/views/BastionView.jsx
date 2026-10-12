/**
 * BastionView - Fleet Management with JANUS gateway specialist sidebar.
 *
 * Layout (licensed): side-by-side BastionPanel (fleet ops) + JANUS chat sidebar.
 * Cyan-refactored — consumes global .qx-* utilities, no bespoke view CSS.
 */

import { useState } from 'react';
import { PageLayout } from '../../components/layout';
import BastionPanel from '../../components/bastion/BastionPanel';
import BastionChatSidebar from '../../components/bastion/BastionChatSidebar';
import PluginLicenseNotice from '../../components/plugins/PluginLicenseNotice';
import { usePluginLicenseDiagnosis } from '../../hooks/usePluginLicensed';
import './views.css';

export default function BastionView() {
  const diag = usePluginLicenseDiagnosis('bastion-fleet');
  const licensed = diag.licensed;
  const [activeTab, setActiveTab] = useState('fleet');
  const [selectedHost, setSelectedHost] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  if (!licensed) {
    return <PluginLicenseNotice diag={diag} displayName="QuoxBastion Fleet Manager" accentColor="#06b6d4" />;
  }

  return (
    <PageLayout>
      <div className="qx-view">
        <div className="bastion-v2-layout">
          <div className="bastion-v2">
            <BastionPanel
              onTabChange={setActiveTab}
              onSelectedHostChange={setSelectedHost}
            />
          </div>
          {sidebarOpen && (
            <aside className="bastion-sidebar">
              <BastionChatSidebar
                activeTab={activeTab}
                selectedHost={selectedHost}
                onClose={() => setSidebarOpen(false)}
              />
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
              title="Open JANUS"
            >
              JANUS
            </button>
          )}
        </div>
      </div>
    </PageLayout>
  );
}
