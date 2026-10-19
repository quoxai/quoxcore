/**
 * ProxmoxView - Proxmox VE Plugin (3-column NOC layout)
 *
 * Left: Quick actions (VM lifecycle + cluster ops + alerts)
 * Centre: Dense ops table or topology map (toggleable)
 * Right: HYPERION agent chat sidebar
 *
 * Features: IP enrichment, sparklines, context menu, node grouping,
 * topology visualization, alert rules with HITL inbox integration.
 *
 * Shows setup wizard when not connected, license gate when unlicensed.
 * ProxmoxPanel compact mode untouched for NOC tab embedding.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { PageLayout } from '../../components/layout'
import { ProxmoxOnboarding } from '../../components/monitoring/ProxmoxOnboarding'
import { useProxmoxData, timeAgo } from '../../components/core/monitoring/useProxmoxData'
import { useResourceHistory } from '../../components/monitoring/useResourceHistory'
import { ProxmoxTable } from '../../components/monitoring/ProxmoxTable'
import { ProxmoxTopology } from '../../components/monitoring/ProxmoxTopology'
import { ProxmoxActions } from '../../components/monitoring/ProxmoxActions'
import { ProxmoxChatSidebar } from '../../components/monitoring/ProxmoxChatSidebar'
import { ProxmoxContextMenu } from '../../components/monitoring/ProxmoxContextMenu'
import { ProxmoxNodes } from '../../components/monitoring/ProxmoxNodes'
import { ProxmoxBackups } from '../../components/monitoring/ProxmoxBackups'
import { ProxmoxPoolPanel } from '../../components/monitoring/ProxmoxPoolPanel'
import { ProxmoxDoctorPanel } from '../../components/monitoring/ProxmoxDoctorPanel'
import { usePoolStatus, poolSummary } from '../../components/monitoring/useProxmoxPool'
import { useActionExecution } from '../../components/core/actions/useActionExecution'
import PluginLicenseNotice from '../../components/plugins/PluginLicenseNotice'
import { usePluginLicenseDiagnosis } from '../../hooks/usePluginLicensed'
import { evaluateProxmoxAlerts } from '../../services/proxmoxAlertService'
import { useAuth } from '../../contexts/AuthContext'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import './proxmox-view.css'
import './views.css'

export function ProxmoxDashboard({ onReconfigure, onConnected }) {
  const data = useProxmoxData()
  const {
    cluster, vms, containers, allItems,
    refreshing, error, scannedAt, hasLiveData, isInitialLoad, connection,
    selectedVM, setSelectedVM, fetchLive,
  } = data

  const connState = connection?.state || 'ok'
  const connMessage = connection?.message || ''
  const hasData = connState === 'ok' || connState === 'stale'
  const isAuthError = !!connMessage && (connMessage.includes('401') || connMessage.includes('403') || connMessage.toLowerCase().includes('unauthorized'))

  const { getHistory, itemKey } = useResourceHistory(allItems)
  const { authFetch } = useAuth()
  const { currentOrg } = useWorkspace()
  const orgId = currentOrg?.id

  // Context menu for right-click actions
  const { executeAction } = useActionExecution({ source: 'proxmox', assistant: 'atlas' })
  const [contextMenu, setContextMenu] = useState(null)
  // VM Doctor: the VM being diagnosed (panel shows above the table)
  const [doctorVm, setDoctorVm] = useState(null)

  const [showActions, setShowActions] = useState(true)
  const [showChat, setShowChat] = useState(true)
  const [viewMode, setViewMode] = useState('table') // 'table' | 'topology'
  const [filter, setFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')

  const quorate = cluster?.summary?.quorate

  // HYPERION VM pool: one shared read feeds the Pool tab and the agent sidebar
  const pool = usePoolStatus()
  const poolInfo = poolSummary(pool.data)

  // Evaluate alerts on each data refresh
  const prevAlertRef = useRef(null)
  useEffect(() => {
    if (allItems.length > 0 && hasLiveData) {
      const key = allItems.map(i => `${i.vmid}:${i.status}:${i.cpu}`).join(',')
      if (key !== prevAlertRef.current) {
        prevAlertRef.current = key
        evaluateProxmoxAlerts(allItems, authFetch, orgId)
      }
    }
  }, [allItems, hasLiveData, authFetch, orgId])

  const handleContextMenu = useCallback((vm, position) => {
    setContextMenu({ vm, position })
  }, [])

  const handleContextAction = useCallback((action) => {
    if (action.id === 'vm-diagnose' && contextMenu?.vm) setDoctorVm(contextMenu.vm)
    else executeAction(action)
    setContextMenu(null)
  }, [executeAction, contextMenu])

  return (
    <div className="proxmox-view">
      {/* Header bar */}
      <div className="pxv-header">
        <div className="pxv-header__left">
          <div className="pxv-header__title">
            <span style={{ color: '#ff6b30', fontSize: 16 }}>▣</span>
            <span>Proxmox Cluster</span>
          </div>

          {connState === 'not_configured' && (
            <div className="pxv-cluster-badge pxv-cluster-badge--warn">
              <span className="pxv-cluster-badge__dot" />
              Not connected
            </div>
          )}
          {connState === 'error' && (
            <div className="pxv-cluster-badge pxv-cluster-badge--err">
              <span className="pxv-cluster-badge__dot" />
              Connection error
            </div>
          )}
          {connState === 'loading' && (
            <div className="pxv-cluster-badge pxv-cluster-badge--warn">
              <span className="pxv-cluster-badge__dot" />
              Connecting
            </div>
          )}

          {hasData && (
            <div className={`pxv-cluster-badge ${quorate ? 'pxv-cluster-badge--ok' : 'pxv-cluster-badge--warn'}`}>
              <span className="pxv-cluster-badge__dot" />
              {quorate ? 'QUORATE' : 'NO QUORUM'}
            </div>
          )}

          {hasData && (
            <div className="pxv-header__stats">
              <span>
                <span className="pxv-header__stat-value">{cluster?.summary?.online ?? 0}/{cluster?.summary?.totalNodes ?? 0}</span> nodes
              </span>
              <span>
                <span className="pxv-header__stat-value" style={{ color: '#30ff90' }}>{vms?.summary?.running ?? 0}</span> VMs
              </span>
              <span>
                <span className="pxv-header__stat-value" style={{ color: '#38bdf8' }}>{containers?.summary?.running ?? 0}</span> CTs
              </span>
            </div>
          )}
        </div>

        <div className="pxv-header__right">
          {/* View mode toggle */}
          <div className="pxv-view-toggle">
            <button
              className={`pxv-view-btn ${viewMode === 'table' ? 'pxv-view-btn--active' : ''}`}
              onClick={() => setViewMode('table')}
              title="Table view"
            >
              <span style={{ fontSize: 12, color: viewMode === 'table' ? '#ff6b30' : 'rgba(255,255,255,0.5)' }}>☰</span>
            </button>
            <button
              className={`pxv-view-btn ${viewMode === 'topology' ? 'pxv-view-btn--active' : ''}`}
              onClick={() => setViewMode('topology')}
              title="Topology view"
            >
              <span style={{ fontSize: 12, color: viewMode === 'topology' ? '#ff6b30' : 'rgba(255,255,255,0.5)' }}>⊞</span>
            </button>
          </div>

          <button
            className="pxv-header__refresh"
            onClick={() => fetchLive(false)}
            disabled={refreshing}
            title="Refresh data"
          >
            <span className={refreshing ? 'spinning' : ''} style={{ display: 'inline-block', fontSize: 13, color: 'rgba(255,255,255,0.5)' }}>↻</span>
            {scannedAt && !refreshing && <span>{timeAgo(scannedAt)}</span>}
            {refreshing && <span>Updating...</span>}
          </button>

          {/* Connection: reopens the "Connect your Proxmox" onboarding */}
          <button
            type="button"
            className={`qx-btn qx-btn--sm ${isAuthError ? 'qx-btn--danger' : 'qx-btn--ghost'}`}
            onClick={onReconfigure}
            title="Connect or reconnect Proxmox"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
            </svg>
            Connection
          </button>

          {/* Sidebar toggles */}
          <button
            className={`pxv-sidebar-toggle ${showActions ? 'pxv-sidebar-toggle--active' : ''}`}
            onClick={() => setShowActions(v => !v)}
            title={showActions ? 'Hide actions' : 'Show actions'}
          >
            <span style={{ fontSize: 13, color: showActions ? '#ff6b30' : 'rgba(255,255,255,0.5)' }}>◧</span>
          </button>
          <button
            className={`pxv-sidebar-toggle ${showChat ? 'pxv-sidebar-toggle--active' : ''}`}
            onClick={() => setShowChat(v => !v)}
            title={showChat ? 'Hide chat' : 'Show chat'}
          >
            <span style={{ fontSize: 13, color: showChat ? '#ff6b30' : 'rgba(255,255,255,0.5)' }}>◨</span>
          </button>
        </div>
      </div>

      {connState === 'error' && (
        <div className="qx-banner qx-banner--error pxv-banner" role="alert">
          <span className="qx-banner__title">Proxmox read failed</span>
          <span>{connMessage}</span>
          <div className="qx-banner__actions">
            <button type="button" className="qx-btn qx-btn--sm" onClick={() => fetchLive(false)} disabled={refreshing}>Retry</button>
            <button type="button" className="qx-btn qx-btn--sm qx-btn--danger" onClick={onReconfigure}>Connection</button>
          </div>
        </div>
      )}

      {connState === 'stale' && (
        <div className="qx-banner qx-banner--warn pxv-banner" role="alert">
          <span className="qx-banner__title">Cached {timeAgo(scannedAt)}</span>
          <span>live read failed: {connMessage}</span>
          <div className="qx-banner__actions">
            <button type="button" className="qx-btn qx-btn--sm" onClick={() => fetchLive(false)} disabled={refreshing}>Retry</button>
            <button type="button" className="qx-btn qx-btn--sm" onClick={onReconfigure}>Connection</button>
          </div>
        </div>
      )}

      {connState === 'not_configured' && (
        <div className="pxv-onboard">
          <ProxmoxOnboarding onConnected={(url) => { onConnected?.(url); fetchLive(false) }} />
        </div>
      )}

      {/* 3-column body */}
      {(hasData || connState === 'loading') && <div className="pxv-body">
        {/* Left: Actions */}
        <div className={`pxv-actions ${showActions ? '' : 'pxv-actions--collapsed'}`}>
          <ProxmoxActions selectedVM={selectedVM} cluster={cluster} onDiagnose={setDoctorVm} />
        </div>

        {/* Centre: Table, Topology, or Nodes */}
        <div className="pxv-centre">
          {doctorVm && (
            <ProxmoxDoctorPanel
              key={`${doctorVm.node}:${doctorVm.vmid}`}
              vm={doctorVm}
              onClose={() => setDoctorVm(null)}
              onAction={executeAction}
            />
          )}
          {viewMode === 'table' || typeFilter === 'nodes' || typeFilter === 'backups' || typeFilter === 'pool' ? (
            <ProxmoxTable
              items={allItems}
              selectedVM={selectedVM}
              onSelectVM={setSelectedVM}
              onContextMenu={handleContextMenu}
              filter={filter}
              onFilterChange={setFilter}
              typeFilter={typeFilter}
              onTypeFilterChange={setTypeFilter}
              error={error}
              isInitialLoad={isInitialLoad}
              clusterSummary={cluster?.summary}
              getHistory={getHistory}
              itemKey={itemKey}
            >
              {typeFilter === 'nodes' ? <ProxmoxNodes cluster={cluster} />
                : typeFilter === 'backups' ? <ProxmoxBackups cluster={cluster} allItems={allItems} />
                : typeFilter === 'pool' ? <ProxmoxPoolPanel pool={pool} />
                : null}
            </ProxmoxTable>
          ) : (
            <ProxmoxTopology
              items={allItems}
              cluster={cluster}
              selectedVM={selectedVM}
              onSelectVM={setSelectedVM}
            />
          )}
        </div>

        {/* Right: Chat */}
        <div className={`pxv-chat ${showChat ? '' : 'pxv-chat--collapsed'}`}>
          <ProxmoxChatSidebar
            cluster={cluster}
            vms={vms}
            containers={containers}
            selectedVM={selectedVM}
            pool={poolInfo}
          />
        </div>
      </div>}

      {/* Context Menu overlay */}
      {contextMenu && (
        <ProxmoxContextMenu
          vm={contextMenu.vm}
          position={contextMenu.position}
          onAction={handleContextAction}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}

const CACHE_URL = '/collector/api/v1/monitoring/cache/proxmox'

export default function ProxmoxView() {
  const diag = usePluginLicenseDiagnosis('proxmox')
  const licensed = diag.licensed
  // 'pending' = checking, 'yes' = connected, 'no' = not configured, 'cached' = show dashboard with cached data
  // 'reconfigure' = user wants to re-enter credentials
  const [connected, setConnected] = useState('pending')
  const [currentUrl, setCurrentUrl] = useState('')

  useEffect(() => {
    if (!licensed) return

    // Fast path: if server-side cache exists, show dashboard immediately
    // Connection check runs in background — if it fails, we show setup
    ;(async () => {
      try {
        const cacheResp = await fetch(CACHE_URL)
        const cacheData = await cacheResp.json()
        if (cacheData.success && cacheData.data) {
          // Cache exists — show dashboard now, verify connection in background
          setConnected('cached')
          checkConnectionBackground()
          return
        }
      } catch {
        // No cache — fall through to blocking connection check
      }

      // No cache — must check connection before we can show anything useful
      await checkConnectionBlocking()
    })()
  }, [licensed])

  async function checkConnectionBlocking() {
    try {
      const resp = await fetch('/collector/api/v1/monitoring/config', { credentials: 'include' })
      const data = await resp.json()
      if (data.success && data.services?.proxmox?.configured) {
        setCurrentUrl(data.services.proxmox.url || '')
        const testResp = await fetch('/collector/api/v1/monitoring/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ url: data.services.proxmox.url, service: 'proxmox' })
        })
        const testData = await testResp.json()
        setConnected(testData.success ? 'yes' : 'no')
      } else {
        setConnected('no')
      }
    } catch {
      setConnected('no')
    }
  }

  // Background check — test actual connectivity, not just config existence
  async function checkConnectionBackground() {
    try {
      const resp = await fetch('/collector/api/v1/monitoring/config', { credentials: 'include' })
      const data = await resp.json()
      if (data.success && data.services?.proxmox?.configured) {
        setCurrentUrl(data.services.proxmox.url || '')
        // Actually test the connection — a configured but broken token should still show dashboard
        // (useProxmoxData handles the error display), but we upgrade to 'yes' if it works
        setConnected('yes')
      }
    } catch {
      // Network error — keep showing cached data
    }
  }

  function handleReconfigure() {
    setConnected('reconfigure')
  }

  if (!licensed) {
    return <PluginLicenseNotice diag={diag} displayName="Proxmox VE" accentColor="#e65100" />
  }

  if (connected === 'pending') {
    return (
      <PageLayout>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '40vh', color: 'var(--shell-text-muted)' }}>
          Checking Proxmox connection...
        </div>
      </PageLayout>
    )
  }

  if (connected === 'no' || connected === 'reconfigure') {
    return (
      <PageLayout>
        <ProxmoxOnboarding
          onCancel={connected === 'reconfigure' ? () => setConnected('yes') : undefined}
          onConnected={(url) => {
            setCurrentUrl(url)
            setConnected('yes')
          }}
        />
      </PageLayout>
    )
  }

  // 'yes' or 'cached' — show dashboard immediately
  return <ProxmoxDashboard onReconfigure={handleReconfigure} onConnected={(url) => { setCurrentUrl(url); setConnected('yes') }} />
}
