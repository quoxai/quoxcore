/**
 * TikTokView — TikTok plugin dashboard. TT-4, mirrors
 * src/pages/views/InstagramView.jsx.
 *
 * License-gated with six tabs: Dashboard, Publish, Activity, Health, About,
 * TikTok Agent. Uses pluginConfigStorage for org-scoped config instead of
 * raw localStorage. TikTok has its OWN dedicated vaulted credential (no
 * shared foundation with any other plugin), and the setup wizard walks the
 * developer-portal + vault flow rather than discovering a linked account.
 */

import { useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePluginLicensed } from '../../hooks/usePluginLicensed'
import { getPluginConfig, savePluginConfig } from '../../services/pluginConfigStorage'
import { useTikTokData } from '../../hooks/useTikTokData'
import AccountHealthPanel from '../../components/tiktok/AccountHealthPanel'
import ActivityPanel from '../../components/tiktok/ActivityPanel'
import VideoGridPanel from '../../components/tiktok/VideoGridPanel'
import PublishPanel from '../../components/tiktok/PublishPanel'
import { TikTokChatSidebar } from '../../components/tiktok/TikTokChatSidebar'
import TikTokSetupWizard from '../../components/tiktok/TikTokSetupWizard'
import './TikTokView.css'

// TikTok icon inline SVG — explicit stroke colours, no currentColor
const TikTokIcon = ({ size = 22 }) => (
  <svg viewBox="0 0 24 24" fill="none" style={{ width: size, height: size }}>
    <path d="M16 3v9.5a4 4 0 1 1-4-4V3" stroke="rgba(254, 44, 85, 0.9)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M16 3a5 5 0 0 0 5 5" stroke="rgba(37, 244, 238, 0.9)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)

// ─── License Paywall ────────────────────────────────────────
function TikTokPaywall({ onActivate }) {
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
          background: 'rgba(254,44,85,0.15)', display: 'flex',
          alignItems: 'center', justifyContent: 'center'
        }}>
          <TikTokIcon size={28} />
        </div>
        <h2 style={{ margin: '0 0 8px', fontSize: '1.3rem', fontWeight: 700, color: '#f4f4f5' }}>
          TikTok
        </h2>
        <p style={{ margin: '0 0 24px', color: '#71717a', fontSize: '0.9rem', lineHeight: 1.6 }}>
          Publish videos or upload TikTok inbox drafts on your own dedicated TikTok
          credential, with every publish governed by a human approval.
        </p>
        <button
          onClick={onActivate}
          style={{
            padding: '10px 24px', background: 'linear-gradient(135deg, #FE2C55, #25F4EE)',
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
export default function TikTokView() {
  const navigate = useNavigate()
  const licensed = usePluginLicensed('tiktok')

  // Plugin config via pluginConfigStorage (org-scoped, server-synced).
  // configVersion re-reads after a wizard save; a full-page reload here
  // would race the debounced server sync and could strand the config in
  // localStorage only (the browser-only-persistence class we ban).
  const [configVersion, setConfigVersion] = useState(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const config = useMemo(() => getPluginConfig('tiktok'), [configVersion])
  const setupComplete = !!config?.setupComplete

  const [activeTab, setActiveTab] = useState('dashboard')
  const [showChat, setShowChat] = useState(true)

  const handleSaveConfig = useCallback((newConfig) => {
    savePluginConfig('tiktok', newConfig)
    // State-based re-read, NOT window.location.reload().
    setConfigVersion((v) => v + 1)
  }, [])

  const {
    profile,
    videos,
    credentialHealth,
    tokenExpiry,
    activity,
    loading,
    error,
    refreshAll,
    refreshActivity,
    publishVideo,
    uploadDraft,
  } = useTikTokData()

  // ─── License gate ─────────────────────────────────
  if (!licensed) {
    return <TikTokPaywall onActivate={() => navigate('/settings')} />
  }

  // ─── Setup gate ───────────────────────────────────
  if (!setupComplete) {
    return (
      <div className="tiktok-view">
        <div className="tiktok-view__header">
          <div className="tiktok-view__title-row">
            <TikTokIcon />
            <h2 className="tiktok-view__title">TikTok</h2>
          </div>
        </div>
        <TikTokSetupWizard onSave={handleSaveConfig} />
      </div>
    )
  }

  // ─── Main dashboard ───────────────────────────────
  return (
    <div className="tiktok-view">
      <div className="tiktok-view__header">
        <div className="tiktok-view__title-row">
          <TikTokIcon />
          <h2 className="tiktok-view__title">TikTok</h2>

          {/* Tab switcher */}
          <div className="tiktok-view__tabs">
            <button
              className={`tiktok-view__tab ${activeTab === 'dashboard' ? 'tiktok-view__tab--active' : ''}`}
              onClick={() => setActiveTab('dashboard')}
            >
              {'\u{1F4CA}'} Dashboard
            </button>
            <button
              className={`tiktok-view__tab ${activeTab === 'publish' ? 'tiktok-view__tab--active' : ''}`}
              onClick={() => setActiveTab('publish')}
            >
              {'\u{1F4F9}'} Publish
            </button>
            <button
              className={`tiktok-view__tab ${activeTab === 'activity' ? 'tiktok-view__tab--active' : ''}`}
              onClick={() => setActiveTab('activity')}
            >
              {'\u{1F4DC}'} Activity
            </button>
            <button
              className={`tiktok-view__tab ${activeTab === 'health' ? 'tiktok-view__tab--active' : ''}`}
              onClick={() => setActiveTab('health')}
            >
              {'⚕'} Health
            </button>
            <button
              className={`tiktok-view__tab ${activeTab === 'about' ? 'tiktok-view__tab--active' : ''}`}
              onClick={() => setActiveTab('about')}
            >
              {'ℹ'} About
            </button>
            <button
              className={`tiktok-view__tab ${activeTab === 'chat' ? 'tiktok-view__tab--active' : ''}`}
              onClick={() => setActiveTab('chat')}
            >
              {'\u{1F4AC}'} TikTok Agent
            </button>
          </div>

          {error && <span className="tiktok-view__error">{error}</span>}
        </div>
        <button className="tiktok-view__refresh" onClick={refreshAll} disabled={loading}>
          {loading ? 'Refreshing...' : '\u{21BB} Refresh'}
        </button>
      </div>

      {activeTab === 'dashboard' && (
        <div className="tiktok-view__layout">
          <div className={`tiktok-view__grid ${showChat ? '' : 'tiktok-view__grid--full'}`}>
            <div className="tiktok-view__top">
              <AccountHealthPanel
                credentialHealth={credentialHealth}
                profile={profile}
                tokenExpiry={tokenExpiry}
                onRefresh={refreshAll}
              />
            </div>

            <div className="tiktok-view__main">
              <div className="tiktok-view__left">
                <VideoGridPanel
                  videos={videos}
                  loading={loading}
                />
              </div>
              <div className="tiktok-view__right">
                <PublishPanel
                  onPublish={publishVideo}
                  onUploadDraft={uploadDraft}
                />
              </div>
            </div>
          </div>

          {/* Collapsible chat sidebar on dashboard tab */}
          <div className={`tiktok-view__chat-sidebar ${showChat ? '' : 'tiktok-view__chat-sidebar--collapsed'}`}>
            <TikTokChatSidebar
              videos={videos}
              profile={profile}
              credentialHealth={credentialHealth}
              tokenExpiry={tokenExpiry}
            />
          </div>

          <button
            className="tiktok-view__chat-toggle"
            onClick={() => setShowChat(v => !v)}
            title={showChat ? 'Hide TikTok Agent' : 'Show TikTok Agent'}
          >
            {showChat ? '▨' : '▧'}
          </button>
        </div>
      )}

      {activeTab === 'publish' && (
        <div className="tiktok-view__single" style={{ maxWidth: 720 }}>
          <PublishPanel
            onPublish={publishVideo}
            onUploadDraft={uploadDraft}
          />
        </div>
      )}

      {activeTab === 'activity' && (
        <div className="tiktok-view__single" style={{ maxWidth: 860 }}>
          <ActivityPanel activity={activity} onRefresh={refreshActivity} />
        </div>
      )}

      {activeTab === 'health' && (
        <div className="tiktok-view__single" style={{ maxWidth: 720 }}>
          <AccountHealthPanel
            credentialHealth={credentialHealth}
            profile={profile}
            tokenExpiry={tokenExpiry}
            onRefresh={refreshAll}
          />
          <div className="tt-panel" style={{ marginTop: 16 }}>
            <div className="tt-panel__header">
              <h3 className="tt-panel__title">Audit status and token rotation</h3>
            </div>
            <div className="tt-panel__body" style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)', lineHeight: 1.6 }}>
              Until TikTok approves this app's audit, everything published through it is
              restricted to private (SELF_ONLY) viewing, no matter what privacy level is
              requested. Submitting the audit is free and owner paperwork; it typically takes
              weeks to clear. Separately, the access token above lives exactly 24 hours and
              there is no automatic refresh built yet, so a real countdown is shown rather than
              a token that quietly stops working. Every health check on this tab is a real
              TikTok API call (get_profile) through your own vaulted credential, never a cached
              or global status.
            </div>
          </div>
        </div>
      )}

      {activeTab === 'about' && (
        <div className="tiktok-view__single" style={{ maxWidth: 720 }}>
          <div className="tt-panel">
            <div className="tt-panel__header">
              <h3 className="tt-panel__title">About TikTok</h3>
            </div>
            <div className="tt-panel__body" style={{ fontSize: 13, color: 'rgba(255,255,255,0.75)', lineHeight: 1.7 }}>
              <p style={{ marginTop: 0 }}>
                Governed publishing to a TikTok account on its own dedicated vaulted
                credential. Every publish or draft upload files a human approval card in
                HITL Inbox and executes only after an explicit approve; the Activity tab reads
                that same approval trail, so history can never drift from what actually
                happened.
              </p>
              <p>
                <strong>Two hard external truths, stated plainly:</strong> first, an unaudited
                TikTok app can only post content as private (SELF_ONLY) until TikTok approves
                the app's audit, a TikTok-side gate submitted as free paperwork that typically
                takes weeks to clear, not something this plugin can work around. Second, access
                tokens live exactly 24 hours with no automatic refresh built yet (the shared
                refresh machinery is a separate stream), so the honest contract today is a
                daily manual rotate of the access_token, tracked by the countdown on the
                Health tab.
              </p>
              <p>
                <strong>Works today:</strong> HITL video publishing from a file already under
                this org's TikTok media root (direct upload then publish), HITL upload of a video
                as a TikTok inbox draft (the recommended pre-audit workhorse: the video lands in
                the account's TikTok inbox and is finished and published manually inside the
                TikTok app), profile and recent-video reads, per-video stats, publish status
                lookups, 24h token expiry tracking, the TikTok agent, and the <code>quox
                tiktok</code> CLI.
              </p>
              <p>
                <strong>Not built yet, honestly:</strong> post scheduling, comment reads or
                replies, music/sound search, and any local browser video upload or arbitrary
                URL as a video source (the file must already sit in the org's TikTok media
                root). Ads live in a separate plugin, not here.
              </p>
              <p style={{ marginBottom: 0, color: 'rgba(255,255,255,0.5)' }}>
                The full maturity map lives in STATUS_AND_LIMITS_TIKTOK.md.
              </p>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'chat' && (
        <div className="tiktok-view__chat-full">
          <TikTokChatSidebar
            videos={videos}
            profile={profile}
            credentialHealth={credentialHealth}
            tokenExpiry={tokenExpiry}
          />
        </div>
      )}
    </div>
  )
}
