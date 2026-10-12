/** LucidView, route /lucid: "LUCID · Situation". Page header + situation pane + LUCID agent column. */
import { useState } from 'react'
import { PageLayout, PageHeader } from '../../components/layout'
import LucidSituation from '../../components/lucid/LucidSituation'
import LucidChatSidebar from '../../components/lucid/LucidChatSidebar'
import './views.css'

const Icon = ({ children }) => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)

export default function LucidView() {
  const [refreshKey, setRefreshKey] = useState(0)
  const [agentOpen, setAgentOpen] = useState(true)
  const refresh = () => setRefreshKey((k) => k + 1)

  const actions = (
    <>
      <button type="button" className="glass-btn" onClick={refresh} aria-label="Refresh" title="Refresh"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 10px', fontSize: 12 }}>
        <Icon><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></Icon>
        <span>Refresh</span>
      </button>
      {!agentOpen && (
        <button type="button" className="glass-btn" onClick={() => setAgentOpen(true)} aria-label="Open LUCID agent" title="Open LUCID agent"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '6px 10px', fontSize: 12 }}>
          <Icon><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></Icon>
          <span>Ask LUCID</span>
        </button>
      )}
    </>
  )

  return (
    <PageLayout
      header={(
        <PageHeader
          title="LUCID · Situation"
          subtitle="Background awareness: what needs you, what changed, what I cannot see"
          icon={<Icon><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></Icon>}
          actions={actions}
        />
      )}
    >
      <div className="qx-view">
        <div className="wazuh-v2-layout">
          <div className="wazuh-v2">
            <div className="qx-card" style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <LucidSituation refreshKey={refreshKey} />
            </div>
          </div>
          {agentOpen && (
            <aside className="wazuh-sidebar" aria-label="LUCID agent">
              <LucidChatSidebar onAgentActed={refresh} onClose={() => setAgentOpen(false)} />
            </aside>
          )}
        </div>
      </div>
    </PageLayout>
  )
}
