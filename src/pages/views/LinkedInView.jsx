/**
 * LinkedInView — LinkedIn plugin dashboard.
 *
 * License-gated with six tabs: Dashboard, Compose, Activity, Health, About, and Chat.
 * Uses pluginConfigStorage for org-scoped config instead of raw localStorage.
 * Follows DockerView / RouterOSView patterns.
 */

import { useState, useCallback, useMemo } from 'react'
import { usePluginLicenseDiagnosis } from '../../hooks/usePluginLicensed'
import PluginLicenseNotice from '../../components/plugins/PluginLicenseNotice'
import { getPluginConfig, savePluginConfig } from '../../services/pluginConfigStorage'
import { useLinkedInData } from '../../hooks/useLinkedInData'
import AccountHealthPanel from '../../components/linkedin/AccountHealthPanel'
import ActivityPanel from '../../components/linkedin/ActivityPanel'
import ContentFeedPanel from '../../components/linkedin/ContentFeedPanel'
import ComposePanel from '../../components/linkedin/ComposePanel'
import EngagementOverviewPanel from '../../components/linkedin/EngagementOverviewPanel'
import { LinkedInChatSidebar } from '../../components/linkedin/LinkedInChatSidebar'
import LinkedInSetupWizard from '../../components/linkedin/LinkedInSetupWizard'
import './LinkedInView.css'

// LinkedIn icon inline SVG — explicit stroke colour, no currentColor
const LinkedInIcon = ({ size = 22 }) => (
  <svg viewBox="0 0 24 24" fill="none" style={{ width: size, height: size }}>
    <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6z" stroke="rgba(10, 102, 194, 0.9)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    <rect x="2" y="9" width="4" height="12" stroke="rgba(10, 102, 194, 0.9)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    <circle cx="4" cy="4" r="2" stroke="rgba(10, 102, 194, 0.9)" strokeWidth="1.8"/>
  </svg>
)

// Setup wizard is now a dedicated component: LinkedInSetupWizard

// ─── Main View ──────────────────────────────────────────────
export default function LinkedInView() {
  const diag = usePluginLicenseDiagnosis('linkedin')
  const licensed = diag.licensed

  // Plugin config via pluginConfigStorage (org-scoped, server-synced).
  // configVersion re-reads after a wizard save; the old full-page reload
  // raced the 2s server-sync debounce and could lose the config server-side
  // (found by automation teardown during LI-OVERHAUL P11).
  const [configVersion, setConfigVersion] = useState(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const config = useMemo(() => getPluginConfig('linkedin'), [configVersion])
  const authorUrn = config?.authorUrn || ''
  const orgId = config?.orgId || ''
  const orgUrn = orgId ? `urn:li:organization:${orgId}` : ''

  const [activeTab, setActiveTab] = useState('dashboard')
  const [showChat, setShowChat] = useState(true)

  const handleSaveConfig = useCallback((newConfig) => {
    savePluginConfig('linkedin', newConfig)
    // State-based re-read, NOT window.location.reload(): a reload here raced
    // the debounced server sync and could strand the config in localStorage
    // only, exactly the browser-only-persistence class we ban.
    setConfigVersion((v) => v + 1)
  }, [])

  const {
    posts,
    engagement,
    orgInfo,
    credentialHealth,
    tokenExpiry,
    activity,
    loading,
    error,
    refreshAll,
    refreshActivity,
    publishPost,
    uploadMedia,
  } = useLinkedInData(authorUrn, orgId)

  // ─── License gate ─────────────────────────────────
  if (!licensed) {
    return <PluginLicenseNotice diag={diag} displayName="LinkedIn Publisher" accentColor="#0A66C2" />
  }

  // ─── Setup gate ───────────────────────────────────
  if (!authorUrn) {
    return (
      <div className="linkedin-view">
        <div className="linkedin-view__header">
          <div className="linkedin-view__title-row">
            <LinkedInIcon />
            <h2 className="linkedin-view__title">LinkedIn</h2>
          </div>
        </div>
        <LinkedInSetupWizard onSave={handleSaveConfig} />
      </div>
    )
  }

  // ─── Main dashboard ───────────────────────────────
  return (
    <div className="linkedin-view">
      <div className="linkedin-view__header">
        <div className="linkedin-view__title-row">
          <LinkedInIcon />
          <h2 className="linkedin-view__title">LinkedIn</h2>

          {/* Tab switcher */}
          <div className="linkedin-view__tabs">
            <button
              className={`linkedin-view__tab ${activeTab === 'dashboard' ? 'linkedin-view__tab--active' : ''}`}
              onClick={() => setActiveTab('dashboard')}
            >
              {'\u{1F4CA}'} Dashboard
            </button>
            <button
              className={`linkedin-view__tab ${activeTab === 'compose' ? 'linkedin-view__tab--active' : ''}`}
              onClick={() => setActiveTab('compose')}
            >
              {'\u270D'} Compose
            </button>
            <button
              className={`linkedin-view__tab ${activeTab === 'activity' ? 'linkedin-view__tab--active' : ''}`}
              onClick={() => setActiveTab('activity')}
            >
              {'\u{1F4DC}'} Activity
            </button>
            <button
              className={`linkedin-view__tab ${activeTab === 'health' ? 'linkedin-view__tab--active' : ''}`}
              onClick={() => setActiveTab('health')}
            >
              {'\u2695'} Health
            </button>
            <button
              className={`linkedin-view__tab ${activeTab === 'about' ? 'linkedin-view__tab--active' : ''}`}
              onClick={() => setActiveTab('about')}
            >
              {'\u2139'} About
            </button>
            <button
              className={`linkedin-view__tab ${activeTab === 'chat' ? 'linkedin-view__tab--active' : ''}`}
              onClick={() => setActiveTab('chat')}
            >
              {'\u{1F4AC}'} LinkedIn Agent
            </button>
          </div>

          {error && <span className="linkedin-view__error">{error}</span>}
        </div>
        <button className="linkedin-view__refresh" onClick={refreshAll} disabled={loading}>
          {loading ? 'Refreshing...' : '\u{21BB} Refresh'}
        </button>
      </div>

      {activeTab === 'dashboard' && (
        <div className="linkedin-view__layout">
          <div className={`linkedin-view__grid ${showChat ? '' : 'linkedin-view__grid--full'}`}>
            <div className="linkedin-view__top">
              <AccountHealthPanel
                credentialHealth={credentialHealth}
                orgInfo={orgInfo}
                tokenExpiry={tokenExpiry}
                onRefresh={refreshAll}
              />
            </div>

            <div className="linkedin-view__main">
              <div className="linkedin-view__left">
                <ContentFeedPanel
                  posts={posts}
                  engagement={engagement}
                  loading={loading}
                />
              </div>
              <div className="linkedin-view__right">
                <ComposePanel
                  authorUrn={authorUrn}
                  orgUrn={orgUrn}
                  onPublish={publishPost}
                  onUploadMedia={uploadMedia}
                />
                <EngagementOverviewPanel
                  posts={posts}
                  engagement={engagement}
                />
              </div>
            </div>
          </div>

          {/* Collapsible chat sidebar on dashboard tab */}
          <div className={`linkedin-view__chat-sidebar ${showChat ? '' : 'linkedin-view__chat-sidebar--collapsed'}`}>
            <LinkedInChatSidebar
              posts={posts}
              engagement={engagement}
              orgInfo={orgInfo}
              credentialHealth={credentialHealth}
              authorUrn={authorUrn}
              orgUrn={orgUrn}
            />
          </div>

          <button
            className="linkedin-view__chat-toggle"
            onClick={() => setShowChat(v => !v)}
            title={showChat ? 'Hide LinkedIn Agent' : 'Show LinkedIn Agent'}
          >
            {showChat ? '\u25A8' : '\u25A7'}
          </button>
        </div>
      )}

      {activeTab === 'compose' && (
        <div className="linkedin-view__single" style={{ maxWidth: 720 }}>
          <ComposePanel
            authorUrn={authorUrn}
            orgUrn={orgUrn}
            onPublish={publishPost}
            onUploadMedia={uploadMedia}
          />
        </div>
      )}

      {activeTab === 'activity' && (
        <div className="linkedin-view__single" style={{ maxWidth: 860 }}>
          <ActivityPanel activity={activity} onRefresh={refreshActivity} />
        </div>
      )}

      {activeTab === 'health' && (
        <div className="linkedin-view__single" style={{ maxWidth: 720 }}>
          <AccountHealthPanel
            credentialHealth={credentialHealth}
            orgInfo={orgInfo}
            tokenExpiry={tokenExpiry}
            onRefresh={refreshAll}
          />
          <div className="li-panel" style={{ marginTop: 16 }}>
            <div className="li-panel__header">
              <h3 className="li-panel__title">Token lifecycle</h3>
            </div>
            <div className="li-panel__body" style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)', lineHeight: 1.6 }}>
              LinkedIn access tokens live 60 days and standard apps get no refresh.
              The expiry is stamped automatically when the token is saved in the Vault,
              re-stamped on rotation, shown above as a countdown, and an inbox warning
              fires for org admins 7 days out (an incident item once expired).
              Every health check on this tab is a real LinkedIn API call through your
              own vaulted credential, never a cached or global status.
            </div>
          </div>
        </div>
      )}

      {activeTab === 'about' && (
        <div className="linkedin-view__single" style={{ maxWidth: 720 }}>
          <div className="li-panel">
            <div className="li-panel__header">
              <h3 className="li-panel__title">About LinkedIn Publisher</h3>
            </div>
            <div className="li-panel__body" style={{ fontSize: 13, color: 'rgba(255,255,255,0.75)', lineHeight: 1.7 }}>
              <p style={{ marginTop: 0 }}>
                Governed publishing to member and organisation pages. Every publish and
                comment files a human approval card in HITL Inbox and executes only after an
                explicit approve; the Activity tab reads that same approval trail, so
                history can never drift from what actually happened.
              </p>
              <p>
                <strong>Works today:</strong> HITL posting and comments, feed and engagement
                reads, org page monitoring, image attach from an https URL (uploaded and
                processed server-side before the card is filed), token expiry tracking with
                inbox warnings, the LinkedIn agent, and the <code>quox linkedin</code> CLI.
              </p>
              <p>
                <strong>Not built yet, honestly:</strong> scheduled posting, mentions and
                comment polling, reaction writes, browser file upload, and OAuth broker
                sign-in (credentials are a pasted 60-day token by design for now).
              </p>
              <p style={{ marginBottom: 0, color: 'rgba(255,255,255,0.5)' }}>
                The full maturity map lives in STATUS_AND_LIMITS_LINKEDIN.md.
              </p>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'chat' && (
        <div className="linkedin-view__chat-full">
          <LinkedInChatSidebar
            posts={posts}
            engagement={engagement}
            orgInfo={orgInfo}
            credentialHealth={credentialHealth}
            authorUrn={authorUrn}
            orgUrn={orgUrn}
          />
        </div>
      )}
    </div>
  )
}
