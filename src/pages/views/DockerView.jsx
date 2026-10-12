/**
 * DockerView
 * Route entry point for the Docker Fleet plugin.
 * License-gated behind tier_b.
 * Two-column layout: DockerDashboard (left) + DOCKULA chat sidebar (right).
 */

import { useState, useCallback } from 'react'
import PageLayout from '../../components/layout/PageLayout'
import DockerDashboard from '../../components/docker/DockerDashboard'
import { DockerChatSidebar } from '../../components/docker/DockerChatSidebar'
import PluginLicenseNotice from '../../components/plugins/PluginLicenseNotice'
import { usePluginLicenseDiagnosis } from '../../hooks/usePluginLicensed'

export default function DockerView() {
  const diag = usePluginLicenseDiagnosis('docker-fleet')
  const licensed = diag.licensed
  const [showChat, setShowChat] = useState(true)
  const [fleetState, setFleetState] = useState({ hosts: [], containers: [], selectedHost: null })

  const handleStateChange = useCallback((state) => {
    setFleetState(state)
  }, [])

  if (!licensed) {
    return <PluginLicenseNotice diag={diag} displayName="Docker Fleet" accentColor="#2496ed" />
  }

  return (
    <PageLayout>
      <div className="qx-view">
        <div className="dv-layout">
          <style>{dvStyles}</style>

          <section className={`dv-main ${showChat ? '' : 'dv-main--full'}`}>
            <DockerDashboard onStateChange={handleStateChange} />
          </section>

          <aside className={`dv-sidebar ${showChat ? '' : 'dv-sidebar--collapsed'}`}>
            <DockerChatSidebar
              hosts={fleetState.hosts}
              containers={fleetState.containers}
              selectedHost={fleetState.selectedHost}
            />
          </aside>

          <button
            className="dv-chat-toggle"
            onClick={() => setShowChat(v => !v)}
            title={showChat ? 'Hide DOCKULA' : 'Show DOCKULA'}
          >
            {showChat ? '◨' : '◧'}
          </button>
        </div>
      </div>
    </PageLayout>
  )
}

const dvStyles = `
.dv-layout {
  display: flex;
  gap: 16px;
  height: 100%;
  min-height: 0;
  position: relative;
}

.dv-main,
.dv-sidebar {
  background: var(--m-bg-base);
  backdrop-filter: var(--qx-blur);
  -webkit-backdrop-filter: var(--qx-blur);
  border: 1px solid var(--m-border-default);
  border-radius: var(--qx-radius);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.18),
    inset 0 -1px 0 rgba(0, 0, 0, 0.45);
  position: relative;
}
.dv-main::before,
.dv-sidebar::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: var(--qx-edges);
  pointer-events: none;
}

.dv-main {
  flex: 1;
  min-width: 0;
  padding: 20px;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
}

.dv-sidebar {
  width: 340px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: width 0.25s ease, opacity 0.2s ease, border-color 0.2s ease;
}
.dv-sidebar--collapsed {
  width: 0;
  opacity: 0;
  pointer-events: none;
  border-color: transparent;
}

.dv-chat-toggle {
  position: absolute;
  top: 12px;
  right: 12px;
  z-index: 10;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: 1px solid var(--m-border-default);
  background: rgba(255, 255, 255, 0.14);
  color: rgba(255, 255, 255, 0.9);
  font-size: 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: right 0.25s ease, background 0.15s ease, border-color 0.15s ease;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.22),
    inset 0 -1px 0 rgba(0, 0, 0, 0.35),
    0 2px 8px rgba(0, 0, 0, 0.35);
}
.dv-chat-toggle:hover {
  background: rgba(56, 189, 248, 0.18);
  border-color: rgba(56, 189, 248, 0.4);
}

/* When sidebar is open, dock the toggle on the dashboard's inner edge */
.dv-layout:has(.dv-sidebar:not(.dv-sidebar--collapsed)) .dv-chat-toggle {
  right: calc(340px + 16px + 12px);
}
`
