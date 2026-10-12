/**
 * InstagramView — Instagram plugin dashboard. IG-3, mirrors
 * src/pages/views/FacebookView.jsx.
 *
 * License-gated with six tabs: Dashboard, Publish, Activity, Health, About,
 * Instagram Agent. Uses pluginConfigStorage for org-scoped config instead of
 * raw localStorage. Instagram is its own plugin SKU on the SAME shared Meta
 * credential as the facebook plugin — the setup wizard discovers the linked
 * Instagram account instead of collecting a second credential.
 */

import { useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePluginLicensed } from '../../hooks/usePluginLicensed'
import { getPluginConfig, savePluginConfig } from '../../services/pluginConfigStorage'
import { useInstagramData } from '../../hooks/useInstagramData'
import AccountHealthPanel from '../../components/instagram/AccountHealthPanel'
import ActivityPanel from '../../components/instagram/ActivityPanel'
import MediaGridPanel from '../../components/instagram/MediaGridPanel'
import PublishPanel from '../../components/instagram/PublishPanel'
import QuotaPanel from '../../components/instagram/QuotaPanel'
import { InstagramChatSidebar } from '../../components/instagram/InstagramChatSidebar'
import InstagramSetupWizard from '../../components/instagram/InstagramSetupWizard'
import './InstagramView.css'

// Instagram icon inline SVG — explicit stroke colour, no currentColor
const InstagramIcon = ({ size = 22 }) => (
  <svg viewBox="0 0 24 24" fill="none" style={{ width: size, height: size }}>
    <rect x="3" y="3" width="18" height="18" rx="5" stroke="rgba(228, 64, 95, 0.9)" strokeWidth="1.8"/>
    <circle cx="12" cy="12" r="4" stroke="rgba(228, 64, 95, 0.9)" strokeWidth="1.8"/>
    <circle cx="17.5" cy="6.5" r="1.2" fill="rgba(228, 64, 95, 0.9)"/>
  </svg>
)

// ─── License Paywall ────────────────────────────────────────
function InstagramPaywall({ onActivate }) {
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
          background: 'rgba(228,64,95,0.15)', display: 'flex',
          alignItems: 'center', justifyContent: 'center'
        }}>
          <InstagramIcon size={28} />
        </div>
        <h2 style={{ margin: '0 0 8px', fontSize: '1.3rem', fontWeight: 700, color: '#f4f4f5' }}>
          Instagram
        </h2>
        <p style={{ margin: '0 0 24px', color: '#71717a', fontSize: '0.9rem', lineHeight: 1.6 }}>
          Publish single image, video, or reel posts, read insights, and reply to comments on
          your Instagram professional account, on the same Meta credential as Facebook.
        </p>
        <button
          onClick={onActivate}
          style={{
            padding: '10px 24px', background: 'linear-gradient(135deg, #E4405F, #F77737)',
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
export default function InstagramView() {
  const navigate = useNavigate()
  const licensed = usePluginLicensed('instagram')

  // Plugin config via pluginConfigStorage (org-scoped, server-synced).
  // configVersion re-reads after a wizard save; a full-page reload here
  // would race the debounced server sync and could strand the config in
  // localStorage only (the browser-only-persistence class we ban).
  const [configVersion, setConfigVersion] = useState(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const config = useMemo(() => getPluginConfig('instagram'), [configVersion])
  const igUserId = config?.igUserId || ''
  const setupComplete = !!config?.setupComplete

  const [activeTab, setActiveTab] = useState('dashboard')
  const [showChat, setShowChat] = useState(true)

  const handleSaveConfig = useCallback((newConfig) => {
    savePluginConfig('instagram', newConfig)
    // State-based re-read, NOT window.location.reload().
    setConfigVersion((v) => v + 1)
  }, [])

  const {
    account,
    media,
    quota,
    credentialHealth,
    tokenExpiry,
    activity,
    loading,
    error,
    refreshAll,
    refreshActivity,
    publishMedia,
  } = useInstagramData(igUserId)

  // ─── License gate ─────────────────────────────────
  if (!licensed) {
    return <InstagramPaywall onActivate={() => navigate('/settings')} />
  }

  // ─── Setup gate ───────────────────────────────────
  if (!setupComplete) {
    return (
      <div className="instagram-view">
        <div className="instagram-view__header">
          <div className="instagram-view__title-row">
            <InstagramIcon />
            <h2 className="instagram-view__title">Instagram</h2>
          </div>
        </div>
        <InstagramSetupWizard onSave={handleSaveConfig} />
      </div>
    )
  }

  // ─── Main dashboard ───────────────────────────────
  return (
    <div className="instagram-view">
      <div className="instagram-view__header">
        <div className="instagram-view__title-row">
          <InstagramIcon />
          <h2 className="instagram-view__title">Instagram</h2>

          {/* Tab switcher */}
          <div className="instagram-view__tabs">
            <button
              className={`instagram-view__tab ${activeTab === 'dashboard' ? 'instagram-view__tab--active' : ''}`}
              onClick={() => setActiveTab('dashboard')}
            >
              {'\u{1F4CA}'} Dashboard
            </button>
            <button
              className={`instagram-view__tab ${activeTab === 'publish' ? 'instagram-view__tab--active' : ''}`}
              onClick={() => setActiveTab('publish')}
            >
              {'\u{1F4F7}'} Publish
            </button>
            <button
              className={`instagram-view__tab ${activeTab === 'activity' ? 'instagram-view__tab--active' : ''}`}
              onClick={() => setActiveTab('activity')}
            >
              {'\u{1F4DC}'} Activity
            </button>
            <button
              className={`instagram-view__tab ${activeTab === 'health' ? 'instagram-view__tab--active' : ''}`}
              onClick={() => setActiveTab('health')}
            >
              {'⚕'} Health
            </button>
            <button
              className={`instagram-view__tab ${activeTab === 'about' ? 'instagram-view__tab--active' : ''}`}
              onClick={() => setActiveTab('about')}
            >
              {'ℹ'} About
            </button>
            <button
              className={`instagram-view__tab ${activeTab === 'chat' ? 'instagram-view__tab--active' : ''}`}
              onClick={() => setActiveTab('chat')}
            >
              {'\u{1F4AC}'} Instagram Agent
            </button>
          </div>

          {error && <span className="instagram-view__error">{error}</span>}
        </div>
        <button className="instagram-view__refresh" onClick={refreshAll} disabled={loading}>
          {loading ? 'Refreshing...' : '\u{21BB} Refresh'}
        </button>
      </div>

      {activeTab === 'dashboard' && (
        <div className="instagram-view__layout">
          <div className={`instagram-view__grid ${showChat ? '' : 'instagram-view__grid--full'}`}>
            <div className="instagram-view__top">
              <AccountHealthPanel
                credentialHealth={credentialHealth}
                account={account}
                tokenExpiry={tokenExpiry}
                onRefresh={refreshAll}
              />
            </div>

            <div className="instagram-view__main">
              <div className="instagram-view__left">
                <MediaGridPanel
                  media={media}
                  loading={loading}
                />
              </div>
              <div className="instagram-view__right">
                <PublishPanel
                  igUserId={igUserId}
                  onPublish={publishMedia}
                />
                <QuotaPanel quota={quota} />
              </div>
            </div>
          </div>

          {/* Collapsible chat sidebar on dashboard tab */}
          <div className={`instagram-view__chat-sidebar ${showChat ? '' : 'instagram-view__chat-sidebar--collapsed'}`}>
            <InstagramChatSidebar
              media={media}
              account={account}
              credentialHealth={credentialHealth}
              igUserId={igUserId}
            />
          </div>

          <button
            className="instagram-view__chat-toggle"
            onClick={() => setShowChat(v => !v)}
            title={showChat ? 'Hide Instagram Agent' : 'Show Instagram Agent'}
          >
            {showChat ? '▨' : '▧'}
          </button>
        </div>
      )}

      {activeTab === 'publish' && (
        <div className="instagram-view__single" style={{ maxWidth: 720 }}>
          <PublishPanel
            igUserId={igUserId}
            onPublish={publishMedia}
          />
        </div>
      )}

      {activeTab === 'activity' && (
        <div className="instagram-view__single" style={{ maxWidth: 860 }}>
          <ActivityPanel activity={activity} onRefresh={refreshActivity} />
        </div>
      )}

      {activeTab === 'health' && (
        <div className="instagram-view__single" style={{ maxWidth: 720 }}>
          <AccountHealthPanel
            credentialHealth={credentialHealth}
            account={account}
            tokenExpiry={tokenExpiry}
            onRefresh={refreshAll}
          />
          <div style={{ marginTop: 16 }}>
            <QuotaPanel quota={quota} />
          </div>
          <div className="ig-panel" style={{ marginTop: 16 }}>
            <div className="ig-panel__header">
              <h3 className="ig-panel__title">Shared credential</h3>
            </div>
            <div className="ig-panel__body" style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)', lineHeight: 1.6 }}>
              Instagram is its own plugin SKU, but it reads the SAME vaulted Meta (Facebook
              Page) token as the Facebook plugin, so one pasted credential powers both. That
              token stays valid for around two months with no automatic refresh. The expiry
              is stamped when the token is saved in the Vault and shown above as a countdown.
              Every health check on this tab is a real Meta Graph API call (discover_account)
              through your own vaulted credential, never a cached or global status.
            </div>
          </div>
        </div>
      )}

      {activeTab === 'about' && (
        <div className="instagram-view__single" style={{ maxWidth: 720 }}>
          <div className="ig-panel">
            <div className="ig-panel__header">
              <h3 className="ig-panel__title">About Instagram</h3>
            </div>
            <div className="ig-panel__body" style={{ fontSize: 13, color: 'rgba(255,255,255,0.75)', lineHeight: 1.7 }}>
              <p style={{ marginTop: 0 }}>
                Governed publishing to an Instagram professional account, reached through its
                linked Facebook Page. Every publish or comment reply files a human approval
                card in HITL Inbox and executes only after an explicit approve; the Activity tab
                reads that same approval trail, so history can never drift from what actually
                happened.
              </p>
              <p>
                <strong>Works today:</strong> HITL publishing of a single image, video, or
                reel by public https URL (create-container -&gt; poll -&gt; publish),
                HITL comment replies, account and media reads, media/account insights,
                comment reads, publishing quota (rolling 24h), token expiry tracking on the
                shared Meta credential, the Instagram agent, and the <code>quox
                instagram</code> CLI.
              </p>
              <p>
                <strong>Not built yet, honestly:</strong> carousel (multi-item) posts, Stories,
                post scheduling, and OAuth broker sign-in (credentials are the same pasted
                long-lived Page token the Facebook plugin uses). Instagram requires a
                professional (Business or Creator) account linked to a Facebook Page; a
                personal Instagram account cannot be connected. Publishing is hard-capped by
                Meta at 100 API-published posts per rolling 24 hours. Ads live in a separate
                META-ADS plugin, not here.
              </p>
              <p style={{ marginBottom: 0, color: 'rgba(255,255,255,0.5)' }}>
                The full maturity map lives in STATUS_AND_LIMITS_INSTAGRAM.md.
              </p>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'chat' && (
        <div className="instagram-view__chat-full">
          <InstagramChatSidebar
            media={media}
            account={account}
            credentialHealth={credentialHealth}
            igUserId={igUserId}
          />
        </div>
      )}
    </div>
  )
}
