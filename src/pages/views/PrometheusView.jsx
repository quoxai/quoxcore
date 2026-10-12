/**
 * PrometheusView - Prometheus Intelligence Plugin
 *
 * 2-column layout: Content (tabs) | METRICS agent chat sidebar
 * Tabs: Fleet Heatmap | PromQL Explorer | Alert Timeline | Summary
 * Shows setup wizard when not connected.
 */

import { useState, useEffect, useCallback } from 'react'
import { PageLayout } from '../../components/layout'
import { MetricsPanel } from '../../components/core/monitoring/MetricsPanel'
import { MonitoringSetup } from '../../components/monitoring/MonitoringSetup'
import { FleetHeatmap } from '../../components/monitoring/FleetHeatmap'
import { PromQLExplorer } from '../../components/monitoring/PromQLExplorer'
import { AlertTimeline } from '../../components/monitoring/AlertTimeline'
import { MetricsChatSidebar } from '../../components/monitoring/MetricsChatSidebar'
import { getAlerts, getTargets } from '../../services/prometheusClient'
import PluginLicenseNotice from '../../components/plugins/PluginLicenseNotice'
import { usePluginLicenseDiagnosis } from '../../hooks/usePluginLicensed'
import './views.css'

const TABS = [
  { id: 'heatmap', label: 'Fleet Health' },
  { id: 'explorer', label: 'PromQL Explorer' },
  { id: 'alerts', label: 'Alert Timeline' },
  { id: 'summary', label: 'Summary' }
]

function PrometheusDashboard({ onReconfigure }) {
  const [activeTab, setActiveTab] = useState('heatmap')
  const [showChat, setShowChat] = useState(true)
  const [targets, setTargets] = useState(null)
  const [alerts, setAlerts] = useState(null)
  const [selectedHost, setSelectedHost] = useState(null)
  const [fetchError, setFetchError] = useState(null)

  // Fetch context data for the sidebar
  useEffect(() => {
    async function fetchContext() {
      try {
        const [t, a] = await Promise.all([getTargets(), getAlerts()])
        if (!t.success && t.error) {
          setFetchError(t.error)
        } else {
          setFetchError(null)
        }
        setTargets(t)
        setAlerts(a)
      } catch (err) {
        setFetchError(err.message)
      }
    }
    fetchContext()
    const interval = setInterval(fetchContext, 60000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="promv">
      {/* Header bar */}
      <div className="promv-header">
        <div className="promv-header__left">
          {/* Tab bar */}
          <div className="prom-tabs prom-tabs--inline">
            {TABS.map(tab => (
              <button
                key={tab.id}
                className={`prom-tab ${activeTab === tab.id ? 'prom-tab--active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div className="promv-header__right">
          {/* Status badges */}
          {targets && (
            <span className="promv-badge">
              <span className="promv-badge__dot" style={{
                background: targets.summary?.down > 0 ? '#f59e0b' : '#30ff90'
              }} />
              {targets.summary?.up}/{targets.summary?.total} targets
            </span>
          )}
          {alerts?.summary?.firing > 0 && (
            <span className="promv-badge promv-badge--alert">
              {alerts.summary.firing} firing
            </span>
          )}

          {/* Connection error */}
          {fetchError && (
            <span className="promv-badge promv-badge--error" style={{ color: '#ff6b6b', borderColor: 'rgba(255,68,68,0.3)', background: 'rgba(255,68,68,0.08)' }}>
              <span style={{ fontSize: 10 }}>✕</span> Connection error
              <button onClick={onReconfigure} style={{
                marginLeft: 6, padding: '1px 6px', border: '1px solid rgba(255,68,68,0.3)',
                background: 'transparent', color: '#ff6b6b', fontSize: 10, cursor: 'pointer', borderRadius: 3
              }}>Reconfigure</button>
            </span>
          )}

          {/* Settings gear */}
          <button
            className="promv-chat-toggle"
            onClick={onReconfigure}
            title="Connection settings"
          >
            <span style={{ fontSize: 14, color: fetchError ? '#ff4444' : 'rgba(255,255,255,0.5)' }}>⚙</span>
          </button>

          {/* Chat toggle */}
          <button
            className={`promv-chat-toggle ${showChat ? 'promv-chat-toggle--active' : ''}`}
            onClick={() => setShowChat(v => !v)}
            title={showChat ? 'Hide METRICS chat' : 'Show METRICS chat'}
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </button>
        </div>
      </div>

      {/* 2-column body */}
      <div className="promv-body">
        {/* Content area */}
        <div className="promv-content">
          {activeTab === 'heatmap' && <FleetHeatmap onSelectHost={setSelectedHost} />}
          {activeTab === 'explorer' && <PromQLExplorer />}
          {activeTab === 'alerts' && <AlertTimeline />}
          {activeTab === 'summary' && <MetricsPanel />}
        </div>

        {/* Right: METRICS chat */}
        <div className={`promv-chat ${showChat ? '' : 'promv-chat--collapsed'}`}>
          <MetricsChatSidebar
            targets={targets}
            alerts={alerts}
            activeTab={activeTab}
            selectedHost={selectedHost}
          />
        </div>
      </div>
    </div>
  )
}

export default function PrometheusView() {
  const diag = usePluginLicenseDiagnosis('prometheus')
  const licensed = diag.licensed
  const [connected, setConnected] = useState(null) // null | true | false | 'reconfigure'
  const [currentUrl, setCurrentUrl] = useState('')

  useEffect(() => {
    if (!licensed) return
    checkConnection()
  }, [licensed])

  const checkConnection = useCallback(async () => {
    try {
      const resp = await fetch('/collector/api/v1/monitoring/config', { credentials: 'include' })
      const data = await resp.json()
      if (data.success && data.services?.prometheus?.configured) {
        setCurrentUrl(data.services.prometheus.url || '')
        const testResp = await fetch('/collector/api/v1/monitoring/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ url: data.services.prometheus.url, service: 'prometheus' })
        })
        const testData = await testResp.json()
        setConnected(testData.success)
      } else {
        setConnected(false)
      }
    } catch {
      setConnected(false)
    }
  }, [])

  function handleReconfigure() {
    setConnected('reconfigure')
  }

  if (!licensed) {
    return <PluginLicenseNotice diag={diag} displayName="Prometheus Intelligence" accentColor="#e6522c" />
  }

  if (connected === null) {
    return (
      <PageLayout>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '40vh', color: 'var(--shell-text-muted)' }}>
          Checking Prometheus connection...
        </div>
      </PageLayout>
    )
  }

  if (!connected || connected === 'reconfigure') {
    return (
      <PageLayout>
        <MonitoringSetup
          serviceId="prometheus"
          currentUrl={currentUrl}
          onConnected={(url) => {
            setCurrentUrl(url)
            setConnected(true)
          }}
        />
      </PageLayout>
    )
  }

  return <PrometheusDashboard onReconfigure={handleReconfigure} />
}
