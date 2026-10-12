/**
 * FacebookView — Facebook plugin dashboard. FB-3, mirrors
 * src/pages/views/LinkedInView.jsx.
 *
 * License-gated with six tabs: Dashboard, Compose, Activity, Health, About,
 * Facebook Agent. Uses pluginConfigStorage for org-scoped config instead of
 * raw localStorage.
 */

import { useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePluginLicensed } from '../../hooks/usePluginLicensed'
import { getPluginConfig, savePluginConfig } from '../../services/pluginConfigStorage'
import { useFacebookData } from '../../hooks/useFacebookData'
import AccountHealthPanel from '../../components/facebook/AccountHealthPanel'
import ActivityPanel from '../../components/facebook/ActivityPanel'
import ContentFeedPanel from '../../components/facebook/ContentFeedPanel'
import ComposePanel from '../../components/facebook/ComposePanel'
import EngagementOverviewPanel from '../../components/facebook/EngagementOverviewPanel'
import { FacebookChatSidebar } from '../../components/facebook/FacebookChatSidebar'
import FacebookSetupWizard from '../../components/facebook/FacebookSetupWizard'
import './FacebookView.css'

// Facebook icon inline SVG — explicit stroke colour, no currentColor
const FacebookIcon = ({ size = 22 }) => (
  <svg viewBox="0 0 24 24" fill="none" style={{ width: size, height: size }}>
    <path d="M15 4h-2a5 5 0 0 0-5 5v3H6v4h2v8h4v-8h3l1-4h-4V9a1 1 0 0 1 1-1h3z" stroke="rgba(24, 119, 242, 0.9)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)

// ─── License Paywall ────────────────────────────────────────
function FacebookPaywall({ onActivate }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      minHeight: '60vh', padding: '40px'
    }}>
      <div style={{
        textAlign: 'center', maxWidth: 480,
        background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 16, padding: '48px 32px'
      }}>
        <div style={{
          width: 56, height: 56, borderRadius: 14, margin: '0 auto 20px',
          background: 'rgba(24,119,242,0.15)', display: 'flex',
          alignItems: 'center', justifyContent: 'center'
        }}>
          <FacebookIcon size={28} />
        </div>
        <h2 style={{ margin: '0 0 8px', fontSize: '1.3rem', fontWeight: 700, color: '#f4f4f5' }}>
          Facebook Pages
        </h2>
        <p style={{ margin: '0 0 24px', color: '#71717a', fontSize: '0.9rem', lineHeight: 1.6 }}>
          Publish posts, read Page Insights, and retrieve Lead Ads leads for your Facebook Page. Compose panel, content feed, insights summary, and embedded Facebook agent.
        </p>
        <button
          onClick={onActivate}
          style={{
            padding: '10px 24px', background: 'linear-gradient(135deg, #1877F2, #0B3D91)',
            border: 'none', borderRadius: 8, color: 'white', fontSize: '0.85rem',
            fontWeight: 600, cursor: 'pointer'
          }}
        >
          Activate Plugin - $2
        </button>
      </div>
    </div>
  )
}

// ─── Main View ──────────────────────────────────────────────
export default function FacebookView() {
  const navigate = useNavigate()
  const licensed = usePluginLicensed('facebook')

  // Plugin config via pluginConfigStorage (org-scoped, server-synced).
  // configVersion re-reads after a wizard save; a full-page reload here
  // would race the debounced server sync and could strand the config in
  // localStorage only (the browser-only-persistence class we ban).
  const [configVersion, setConfigVersion] = useState(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const config = useMemo(() => getPluginConfig('facebook'), [configVersion])
  const defaultPageId = config?.defaultPageId || ''
  const setupComplete = !!config?.setupComplete

  const [activeTab, setActiveTab] = useState('dashboard')
  const [showChat, setShowChat] = useState(true)

  const handleSaveConfig = useCallback((newConfig) => {
    savePluginConfig('facebook', newConfig)
    // State-based re-read, NOT window.location.reload().
    setConfigVersion((v) => v + 1)
  }, [])

  const {
    pageInfo,
    posts,
    insights,
    credentialHealth,
    tokenExpiry,
    activity,
    loading,
    error,
    refreshAll,
    refreshActivity,
    publishPagePost,
  } = useFacebookData(defaultPageId)

  // ─── License gate ─────────────────────────────────
  if (!licensed) {
    return <FacebookPaywall onActivate={() => navigate('/settings')} />
  }

  // ─── Setup gate ───────────────────────────────────
  if (!setupComplete) {
    return (
      <div className="facebook-view">
        <div className="facebook-view__header">
          <div className="facebook-view__title-row">
            <FacebookIcon />
            <h2 className="facebook-view__title">Facebook</h2>
          </div>
        </div>
        <FacebookSetupWizard onSave={handleSaveConfig} />
      </div>
    )
  }

  // ─── Main dashboard ───────────────────────────────
  return (
    <div className="facebook-view">
      <div className="facebook-view__header">
        <div className="facebook-view__title-row">
          <FacebookIcon />
          <h2 className="facebook-view__title">Facebook</h2>

          {/* Tab switcher */}
          <div className="facebook-view__tabs">
            <button
              className={`facebook-view__tab ${activeTab === 'dashboard' ? 'facebook-view__tab--active' : ''}`}
              onClick={() => setActiveTab('dashboard')}
            >
              {'\u{1F4CA}'} Dashboard
            </button>
            <button
              className={`facebook-view__tab ${activeTab === 'compose' ? 'facebook-view__tab--active' : ''}`}
              onClick={() => setActiveTab('compose')}
            >
              {'✍'} Compose
            </button>
            <button
              className={`facebook-view__tab ${activeTab === 'activity' ? 'facebook-view__tab--active' : ''}`}
              onClick={() => setActiveTab('activity')}
            >
              {'\u{1F4DC}'} Activity
            </button>
            <button
              className={`facebook-view__tab ${activeTab === 'health' ? 'facebook-view__tab--active' : ''}`}
              onClick={() => setActiveTab('health')}
            >
              {'⚕'} Health
            </button>
            <button
              className={`facebook-view__tab ${activeTab === 'about' ? 'facebook-view__tab--active' : ''}`}
              onClick={() => setActiveTab('about')}
            >
              {'ℹ'} About
            </button>
            <button
              className={`facebook-view__tab ${activeTab === 'chat' ? 'facebook-view__tab--active' : ''}`}
              onClick={() => setActiveTab('chat')}
            >
              {'\u{1F4AC}'} Facebook Agent
            </button>
          </div>

          {error && <span className="facebook-view__error">{error}</span>}
        </div>
        <button className="facebook-view__refresh" onClick={refreshAll} disabled={loading}>
          {loading ? 'Refreshing...' : '\u{21BB} Refresh'}
        </button>
      </div>

      {activeTab === 'dashboard' && (
        <div className="facebook-view__layout">
          <div className={`facebook-view__grid ${showChat ? '' : 'facebook-view__grid--full'}`}>
            <div className="facebook-view__top">
              <AccountHealthPanel
                credentialHealth={credentialHealth}
                pageInfo={pageInfo}
                tokenExpiry={tokenExpiry}
                onRefresh={refreshAll}
              />
            </div>

            <div className="facebook-view__main">
              <div className="facebook-view__left">
                <ContentFeedPanel
                  posts={posts}
                  loading={loading}
                />
              </div>
              <div className="facebook-view__right">
                <ComposePanel
                  defaultPageId={defaultPageId}
                  onPublish={publishPagePost}
                />
                <EngagementOverviewPanel
                  insights={insights}
                  posts={posts}
                />
              </div>
            </div>
          </div>

          {/* Collapsible chat sidebar on dashboard tab */}
          <div className={`facebook-view__chat-sidebar ${showChat ? '' : 'facebook-view__chat-sidebar--collapsed'}`}>
            <FacebookChatSidebar
              posts={posts}
              insights={insights}
              pageInfo={pageInfo}
              credentialHealth={credentialHealth}
              defaultPageId={defaultPageId}
            />
          </div>

          <button
            className="facebook-view__chat-toggle"
            onClick={() => setShowChat(v => !v)}
            title={showChat ? 'Hide Facebook Agent' : 'Show Facebook Agent'}
          >
            {showChat ? '▨' : '▧'}
          </button>
        </div>
      )}

      {activeTab === 'compose' && (
        <div className="facebook-view__single" style={{ maxWidth: 720 }}>
          <ComposePanel
            defaultPageId={defaultPageId}
            onPublish={publishPagePost}
          />
        </div>
      )}

      {activeTab === 'activity' && (
        <div className="facebook-view__single" style={{ maxWidth: 860 }}>
          <ActivityPanel activity={activity} onRefresh={refreshActivity} />
        </div>
      )}

      {activeTab === 'health' && (
        <div className="facebook-view__single" style={{ maxWidth: 720 }}>
          <AccountHealthPanel
            credentialHealth={credentialHealth}
            pageInfo={pageInfo}
            tokenExpiry={tokenExpiry}
            onRefresh={refreshAll}
          />
          <div className="fb-panel" style={{ marginTop: 16 }}>
            <div className="fb-panel__header">
              <h3 className="fb-panel__title">Token lifecycle</h3>
            </div>
            <div className="fb-panel__body" style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)', lineHeight: 1.6 }}>
              Meta long-lived Page tokens live roughly 60 days and standard apps get no
              automatic refresh. The expiry is stamped automatically when the token is saved
              in the Vault, re-stamped on rotation, and shown above as a countdown.
              Every health check on this tab is a real Meta Graph API call through your own
              vaulted credential, never a cached or global status.
            </div>
          </div>
        </div>
      )}

      {activeTab === 'about' && (
        <div className="facebook-view__single" style={{ maxWidth: 720 }}>
          <div className="fb-panel">
            <div className="fb-panel__header">
              <h3 className="fb-panel__title">About Facebook Pages</h3>
            </div>
            <div className="fb-panel__body" style={{ fontSize: 13, color: 'rgba(255,255,255,0.75)', lineHeight: 1.7 }}>
              <p style={{ marginTop: 0 }}>
                Governed publishing to organic Facebook Pages. Every post files a human
                approval card in HITL Inbox and executes only after an explicit approve; the
                Activity tab reads that same approval trail, so history can never drift
                from what actually happened.
              </p>
              <p>
                <strong>Works today:</strong> HITL Page posting (text, optional link, optional
                image), Page and post reads, organic Page Insights, Lead Ads form and lead
                reads, token expiry tracking, the Facebook agent, and the <code>quox
                facebook</code> CLI.
              </p>
              <p>
                <strong>Not built yet, honestly:</strong> post scheduling, comment replies or
                comment writes, group management, and OAuth broker sign-in (credentials are a
                pasted long-lived Page token by design for now). Ad account insights and ad
                management live in a separate META-ADS plugin, not here.
              </p>
              <p style={{ marginBottom: 0, color: 'rgba(255,255,255,0.5)' }}>
                The full maturity map lives in STATUS_AND_LIMITS_FACEBOOK.md.
              </p>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'chat' && (
        <div className="facebook-view__chat-full">
          <FacebookChatSidebar
            posts={posts}
            insights={insights}
            pageInfo={pageInfo}
            credentialHealth={credentialHealth}
            defaultPageId={defaultPageId}
          />
        </div>
      )}
    </div>
  )
}
