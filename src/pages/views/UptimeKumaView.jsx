/**
 * UptimeKumaView - Uptime Kuma Plugin
 *
 * Standalone view for service uptime monitoring and status tracking.
 * Supports multiple status pages with tabs.
 * Shows setup wizard when not connected, full status panel when connected.
 * Also available as a tab within NOC when both plugins are active.
 */

import { useState, useEffect, useCallback } from 'react'
import { PageLayout } from '../../components/layout'
import { UptimePanel } from '../../components/core/monitoring/UptimePanel'
import { MonitoringSetup } from '../../components/monitoring/MonitoringSetup'
import PluginLicenseNotice from '../../components/plugins/PluginLicenseNotice'
import { usePluginLicenseDiagnosis } from '../../hooks/usePluginLicensed'
import './views.css'

export default function UptimeKumaView() {
  const diag = usePluginLicenseDiagnosis('uptime-kuma')
  const licensed = diag.licensed
  const [connected, setConnected] = useState(null) // null | true | false | 'reconfigure'
  const [adding, setAdding] = useState(false)
  const [panelKey, setPanelKey] = useState(0)
  const [currentUrl, setCurrentUrl] = useState('')

  useEffect(() => {
    if (!licensed) return
    checkConnection()
  }, [licensed])

  const checkConnection = useCallback(async () => {
    try {
      const resp = await fetch('/collector/api/v1/monitoring/config', { credentials: 'include' })
      const data = await resp.json()
      const kumaConfig = data.services?.['uptime-kuma']
      if (kumaConfig?.url) setCurrentUrl(kumaConfig.url)
      const hasPages = kumaConfig?.statusPages?.length > 0 || !!kumaConfig?.statusPageSlug
      if (data.success && kumaConfig?.configured && hasPages) {
        const testResp = await fetch('/collector/api/v1/monitoring/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ url: kumaConfig.url, service: 'uptime-kuma' })
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

  const handlePageAdded = useCallback(() => {
    setAdding(false)
    // Force UptimePanel to remount and refetch pages
    setPanelKey(k => k + 1)
    // If this was the first page, recheck connection
    if (!connected) checkConnection()
  }, [connected, checkConnection])

  function handleReconfigure() {
    setConnected('reconfigure')
  }

  if (!licensed) {
    return <PluginLicenseNotice diag={diag} displayName="Uptime Kuma" accentColor="#10b981" />
  }

  if (connected === null) {
    return (
      <PageLayout>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '40vh', color: 'var(--shell-text-muted)' }}>
          Checking Uptime Kuma connection...
        </div>
      </PageLayout>
    )
  }

  // Not connected or reconfiguring — show setup
  if ((!connected || connected === 'reconfigure') && !adding) {
    return (
      <PageLayout>
        <MonitoringSetup
          serviceId="uptime-kuma"
          currentUrl={currentUrl}
          onConnected={(url) => {
            if (url) setCurrentUrl(url)
            checkConnection()
          }}
        />
      </PageLayout>
    )
  }

  // Adding a new page (while already connected)
  if (adding) {
    return (
      <PageLayout>
        <div style={{ padding: '0 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <button
              onClick={() => setAdding(false)}
              style={{
                padding: '6px 12px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.15)',
                background: 'transparent', color: 'rgba(255,255,255,0.7)', cursor: 'pointer', fontSize: 13
              }}
            >
              ◀ Back
            </button>
            <h3 style={{ fontSize: 15, fontWeight: 600, color: 'rgba(255,255,255,0.9)', margin: 0 }}>
              Add Status Page
            </h3>
          </div>
          <MonitoringSetup
            serviceId="uptime-kuma"
            onConnected={handlePageAdded}
          />
        </div>
      </PageLayout>
    )
  }

  return (
    <PageLayout>
      <div style={{ padding: '0 16px 16px' }}>
        <UptimePanel key={panelKey} onAddPage={() => setAdding(true)} onReconfigure={handleReconfigure} />
      </div>
    </PageLayout>
  )
}
