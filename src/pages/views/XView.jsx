/**
 * XView, the X plugin product surface. X-PLUGIN P3.
 *
 * Gates in order: license (usePluginLicenseDiagnosis('x')), then setup (pluginConfig
 * 'x'.setupComplete, written by XSetupWizard after a LIVE verify), then tabs:
 * Overview / Compose / Activity / Engagement / Budget / Account health /
 * About, with the HERALD chat sidebar alongside.
 *
 * X-PLUGIN phase 11: Overview is the landing tab and EVERY call this view
 * makes on mount is free. getAccount, getOverview, getSettings and
 * listActivity all read the collector's own tables. The only calls that spend
 * money are verify_credentials and the Engagement tab's refresh, and both run
 * exclusively from an explicit click that states the cost.
 *
 * Data layer is src/services/xClient.js, every call is a live collector
 * route (see X_ROUTES + src/test/xClientRoutes.test.js), authenticated via
 * AuthContext.authFetch. No bare fetch, no routes that do not exist
 * (the LinkedIn anti-pattern).
 *
 * Styling: structure comes from the global .qx-* classes
 * (glass-design-system). Phase 13 adds ONE X-scoped sheet,
 * components/x/x-shine.css, for the flex-overflow scroll fix, the solid
 * foreground buttons and the X-flavoured treatment. Every class in it is
 * namespaced .xs-*, so it cannot reach another view.
 */

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useWorkspace } from '../../contexts/WorkspaceContext'
import { usePluginLicenseDiagnosis } from '../../hooks/usePluginLicensed'
import PluginLicenseNotice from '../../components/plugins/PluginLicenseNotice'
import { getPluginConfig, savePluginConfig } from '../../services/pluginConfigStorage'
import {
  verifyCredentials, getAccount, listMedia, listActivity, draftPost, draftThread,
  getOverview, getSettings, saveSettings, uploadMedia, respondToInboxItem, fetchMediaObjectUrl,
  scheduleApprovedPublish, listScheduled, cancelScheduledPublish,
} from '../../services/xClient'
import XOverviewPanel from '../../components/x/XOverviewPanel'
import XComposePanel from '../../components/x/XComposePanel'
import XActivityPanel from '../../components/x/XActivityPanel'
import XScheduledPanel from '../../components/x/XScheduledPanel'
import XEngagementPanel from '../../components/x/XEngagementPanel'
import XBudgetPanel from '../../components/x/XBudgetPanel'
import XAccountHealthPanel from '../../components/x/XAccountHealthPanel'
import XAboutPanel from '../../components/x/XAboutPanel'
import XSetupWizard from '../../components/x/XSetupWizard'
import { XChatSidebar } from '../../components/x/XChatSidebar'
// X-PLUGIN phase 13. The .xs-* polish layer: the scroll fix, the solid
// foreground buttons and the X-flavoured treatment. Namespaced and imported
// once here, so none of it can leak into another view. See the file header
// for why it is not in the global stylesheet.
import '../../components/x/x-shine.css'

/**
 * The X mark. Sized larger and vertically centred against the title, because
 * the header used to read "X X Publisher": a small logo sitting beside a title
 * that also began with the letter X looked like a doubled character rather
 * than a brand mark. The title is now "Quox X Publisher" and the mark is big
 * enough to read as a logo.
 */
const XLogo = ({ size = 28 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="rgba(255,255,255,0.95)"
    aria-hidden="true"
    style={{ display: 'block', flexShrink: 0 }}
  >
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
)

/** The header lockup, used by every state of this view so the naming and the
 * logo treatment can never drift between the loading, setup and ready paths. */
const XHeaderTitle = ({ size = 28 }) => (
  <span className="qx-row qx-row--tight" style={{ alignItems: 'center', gap: 10, minWidth: 0 }}>
    <XLogo size={size} />
    <h2 style={{ margin: 0, lineHeight: 1.1, whiteSpace: 'nowrap' }}>Quox X Publisher</h2>
  </span>
)

/** The cost of one verify_credentials call against X's pay-per-use API. Stated
 * on every button that spends it, same contract as XEngagementPanel. */
export const VERIFY_COST_USD = '$0.005'

/**
 * XAccountIdentity, "Connected as @handle" in the header.
 *
 * Renders from the SERVER-CACHED handle, never from a fresh API call: this
 * component must be free to mount. Three honest states:
 *   - a stored handle      → show it, with a re-verify affordance
 *   - credential, no handle → say so and offer the one paid check that stores it
 *   - neither               → render nothing (the caller is showing setup)
 */
function XAccountIdentity({ account, credential, checking, onVerify }) {
  if (account?.username) {
    return (
      <span className="qx-row qx-row--tight" style={{ minWidth: 0 }}>
        <span className="qx-pill qx-pill--sm qx-pill--online">@{account.username}</span>
        <button
          type="button"
          className="qx-btn xs-btn qx-btn--sm"
          onClick={onVerify}
          disabled={checking}
          title={`Re-check the credential against X. Costs about ${VERIFY_COST_USD}.`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
          {checking ? 'Checking…' : `Re-verify (${VERIFY_COST_USD})`}
        </button>
      </span>
    )
  }

  if (credential?.configured) {
    return (
      <span className="qx-row qx-row--tight" style={{ minWidth: 0 }}>
        <span className="qx-pill qx-pill--sm" title={credential.label || 'Vault credential'}>
          {credential.label || 'Credential set'}
        </span>
        <button
          type="button"
          className="qx-btn xs-btn qx-btn--sm"
          onClick={onVerify}
          disabled={checking}
          title={`Asks X which account this credential belongs to and remembers it. Costs about ${VERIFY_COST_USD}.`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>
          {checking ? 'Checking…' : `Verify connection (${VERIFY_COST_USD})`}
        </button>
      </span>
    )
  }

  return null
}

// Overview is the landing tab: it answers "what is this thing doing" without
// spending a penny, which Compose (a blank box) never did.
const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'compose', label: 'Compose' },
  { id: 'activity', label: 'Activity' },
  { id: 'engagement', label: 'Engagement' },
  { id: 'budget', label: 'Budget' },
  { id: 'health', label: 'Account health' },
  { id: 'about', label: 'About' },
]

export default function XView() {
  const { authFetch } = useAuth()
  const diag = usePluginLicenseDiagnosis('x')
  const licensed = diag.licensed

  const [configVersion, setConfigVersion] = useState(0)
  const config = getPluginConfig('x')
  const localSetupComplete = config?.setupComplete === true

  // ?tab=activity deep links straight to a tab (Compose's success banner
  // sends people to Activity, where a just-published or scheduled post lives).
  const [activeTab, setActiveTab] = useState(() => {
    const requested = new URLSearchParams(window.location.search).get('tab')
    return TABS.some((t) => t.id === requested) ? requested : 'overview'
  })
  const [showChat, setShowChat] = useState(true)

  // Org identity and role. The approve actions in Compose are gated on
  // owner/admin because X approval cards are assigned to owners and admins at
  // mint time, so they are the real approver set for X. This is a UI hint; the
  // auth service remains the enforcement point.
  const { currentOrg, isOrgAdmin } = useWorkspace()
  const orgId = currentOrg?.id || currentOrg?.org_id || null

  const [overview, setOverview] = useState(null)
  const [overviewError, setOverviewError] = useState(null)
  const [settings, setSettings] = useState(null)
  const [settingsError, setSettingsError] = useState(null)
  const [scheduled, setScheduled] = useState([])
  const [canCancelScheduled, setCanCancelScheduled] = useState(false)
  const [scheduledError, setScheduledError] = useState(null)

  // Server-side connection truth: the cached handle (from the last successful
  // verify) and whether the vault holds a twitter credential. Both come from
  // GET /x/account, which costs nothing.
  const [account, setAccount] = useState(null)
  const [credential, setCredential] = useState(null)
  const [accountLoaded, setAccountLoaded] = useState(false)

  const [health, setHealth] = useState(null)
  const [mediaFiles, setMediaFiles] = useState([])
  const [claims, setClaims] = useState([])
  const [ledger, setLedger] = useState([])
  const [budget, setBudget] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const refreshMedia = useCallback(async () => {
    try {
      const out = await listMedia(authFetch)
      setMediaFiles(out.files || [])
    } catch (e) {
      setError(e.message)
    }
  }, [authFetch])

  const refreshActivity = useCallback(async () => {
    try {
      const out = await listActivity(authFetch, { limit: 25 })
      setClaims(out.claims || [])
      setLedger(out.ledger || [])
      setBudget(out.budget || null)
    } catch (e) {
      setError(e.message)
    }
  }, [authFetch])

  /** Free. Never calls X, reads the collector's cached identity + vault state. */
  const loadAccount = useCallback(async () => {
    try {
      const out = await getAccount(authFetch)
      setAccount(out?.account || null)
      setCredential(out?.credential || null)
    } catch (e) {
      // Not knowing the account is not the same as not being connected; say so
      // rather than silently rendering a disconnected view.
      setError(e.message)
    } finally {
      setAccountLoaded(true)
    }
  }, [authFetch])

  /**
   * PAID. verify_credentials spends a request against X's pay-per-use API
   * (about $0.005), so it runs ONLY from an explicit click, never on mount,
   * never on a timer. Same rule XEngagementPanel documents for reads. On
   * success the collector caches the handle, so we refresh the free account
   * read rather than trusting local state.
   */
  const verify = useCallback(async () => {
    setHealth((h) => ({ ...(h || {}), checking: true }))
    try {
      const out = await verifyCredentials(authFetch)
      if (out?.success && out?.result?.username) {
        setHealth({ ok: true, checking: false, account: out.result })
        loadAccount()
      } else {
        setHealth({ ok: false, checking: false, error: out?.error || 'X did not return an authenticated account' })
      }
    } catch (e) {
      setHealth({ ok: false, checking: false, error: e.message })
    }
  }, [authFetch, loadAccount])

  /** FREE. Every number on the Overview tab comes from the collector's own
   * ledgers; this route must never reach api.x.com, or opening a page would
   * bill the org. */
  const refreshOverview = useCallback(async () => {
    try {
      setOverviewError(null)
      setOverview(await getOverview(authFetch))
    } catch (e) {
      setOverviewError(e.message)
    }
  }, [authFetch])

  /** FREE. Readable by any member; only the WRITE is admin-gated server-side. */
  const refreshSettings = useCallback(async () => {
    try {
      setSettingsError(null)
      setSettings(await getSettings(authFetch))
    } catch (e) {
      setSettingsError(e.message)
    }
  }, [authFetch])

  const handleSaveSettings = useCallback(async (updates) => {
    const out = await saveSettings(authFetch, updates)
    // Re-read rather than trusting local state: the server is the authority on
    // what the limits now are, and a partially rejected batch changes nothing.
    await Promise.all([refreshSettings(), refreshOverview(), refreshActivity()])
    return out
  }, [authFetch, refreshSettings, refreshOverview, refreshActivity])

  const handleUploadImage = useCallback((file) => uploadMedia(authFetch, file), [authFetch])

  /** FREE. The bytes behind one media filename, for the Compose library's
   * thumbnails. Authenticated like every other call, because the collector
   * refuses an unauthenticated read; the component owns and revokes the
   * object URL this resolves to. */
  const handleLoadThumb = useCallback((name) => fetchMediaObjectUrl(authFetch, name), [authFetch])

  /** Drives the SAME approval endpoint the inbox's own Post button drives.
   * See xClient.respondToInboxItem: there must never be a second write path. */
  const handleApprove = useCallback(async (inboxItemId) => {
    const out = await respondToInboxItem(authFetch, orgId, inboxItemId, { action: 'approved' })
    await Promise.all([refreshActivity(), refreshOverview()])
    return out
  }, [authFetch, orgId, refreshActivity, refreshOverview])

  /** Ground truth for one draft's claim, from the collector's own ledger.
   * Compose uses this when an approve call errors CLIENT-SIDE: the publish
   * may have happened anyway (the owner hit exactly that on 2026-09-16, and
   * the old error copy asserted the card was "waiting in your inbox" while
   * the tweet was already live). Returns the claim row or null. */
  const handleCheckClaim = useCallback(async (inboxItemId) => {
    try {
      const out = await listActivity(authFetch, { limit: 50 })
      return (out?.claims || []).find((c) => c.inbox_item_id === inboxItemId) || null
    } catch {
      return null
    }
  }, [authFetch])

  /** FREE. Reads the collector's own schedule table. */
  const refreshScheduled = useCallback(async () => {
    try {
      setScheduledError(null)
      const out = await listScheduled(authFetch)
      setScheduled(out?.scheduled || [])
      setCanCancelScheduled(out?.can_cancel === true)
    } catch (e) {
      setScheduledError(e.message)
    }
  }, [authFetch])

  /**
   * Phase 12: records the human's approve decision NOW against a publish time
   * in the future. The collector-side scheduler fires it through the same
   * machinery the decide endpoint drives; nothing here publishes.
   */
  const handleSchedulePublish = useCallback(async (opts) => {
    const out = await scheduleApprovedPublish(authFetch, opts)
    await Promise.all([refreshScheduled(), refreshActivity(), refreshOverview()])
    return out
  }, [authFetch, refreshScheduled, refreshActivity, refreshOverview])

  const handleCancelScheduled = useCallback(async (inboxItemId) => {
    const out = await cancelScheduledPublish(authFetch, inboxItemId)
    await Promise.all([refreshScheduled(), refreshActivity(), refreshOverview()])
    return out
  }, [authFetch, refreshScheduled, refreshActivity, refreshOverview])

  const refreshAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    await Promise.all([refreshActivity(), refreshMedia(), loadAccount(), refreshOverview(), refreshSettings(), refreshScheduled()])
    setLoading(false)
  }, [refreshActivity, refreshMedia, loadAccount, refreshOverview, refreshSettings, refreshScheduled])

  // The account read is free and answers "is this org set up", so it runs as
  // soon as the plugin is licensed, before and independently of any gate.
  useEffect(() => {
    if (licensed) loadAccount()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [licensed, configVersion])

  const connected = localSetupComplete || credential?.configured === true || !!account

  useEffect(() => {
    if (licensed && connected) {
      refreshActivity()
      refreshMedia()
      // Both are free collector reads, so they can load on mount alongside the
      // others. Nothing here touches X.
      refreshOverview()
      refreshSettings()
      refreshScheduled()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [licensed, connected, configVersion])

  const handleSetupComplete = useCallback((result) => {
    savePluginConfig('x', { ...(getPluginConfig('x') || {}), setupComplete: true, handle: result?.handle || '' })
    setConfigVersion((v) => v + 1)
  }, [])

  const handleDraftPost = useCallback(async (opts) => {
    const out = await draftPost(authFetch, opts)
    refreshActivity()
    return out
  }, [authFetch, refreshActivity])

  const handleDraftThread = useCallback(async (opts) => {
    const out = await draftThread(authFetch, opts)
    refreshActivity()
    return out
  }, [authFetch, refreshActivity])

  // ─── License gate ─────────────────────────────────
  if (!licensed) {
    return <PluginLicenseNotice diag={diag} displayName="Quox X Publisher" accentColor="#1d9bf0" />
  }

  // ─── Setup gate ───────────────────────────────────
  // Held until the free account read answers, so an org that IS connected never
  // flashes the "Connect X" wizard on the way in. Before this, the only record
  // that setup had happened lived in localStorage, so every fresh browser told
  // a fully-configured owner the plugin was not set up.
  if (!connected) {
    if (!accountLoaded) {
      return (
        <div className="qx-view">
          <div className="qx-stack">
            <div className="qx-card qx-card--bar qx-row qx-row--tight">
              <XHeaderTitle />
            </div>
            <section className="qx-card">
              <div className="qx-skeleton qx-skeleton--block" />
            </section>
          </div>
        </div>
      )
    }
    return (
      <div className="qx-view">
        <div className="qx-stack">
          <div className="qx-card qx-card--bar qx-row qx-row--tight">
            <XHeaderTitle />
          </div>
          <XSetupWizard onComplete={handleSetupComplete} authFetch={authFetch} />
        </div>
      </div>
    )
  }

  return (
    <div className="qx-view" style={{ height: '100%', minHeight: 0 }}>
      <div className="qx-stack" style={{ flex: 1, minHeight: 0 }}>
        <div className="qx-card qx-card--bar qx-row qx-row--apart qx-row--wrap">
          <div className="qx-row qx-row--tight" style={{ minWidth: 0 }}>
            <XHeaderTitle />
            <XAccountIdentity
              account={account}
              credential={credential}
              checking={health?.checking}
              onVerify={verify}
            />
          </div>
          <div className="qx-row qx-row--tight qx-row--wrap" style={{ minWidth: 0 }}>
            <div className="qx-tabs" role="tablist" aria-label="X plugin tabs">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === t.id}
                  className={`qx-tab ${activeTab === t.id ? 'qx-tab--active' : ''}`}
                  onClick={() => setActiveTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <button type="button" className="qx-btn xs-btn qx-btn--sm" onClick={refreshAll} disabled={loading}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
            <button type="button" className="qx-btn xs-btn qx-btn--sm" onClick={() => setShowChat((s) => !s)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
              {showChat ? 'Hide agent' : 'Show agent'}
            </button>
          </div>
        </div>

        {error && <div className="qx-banner qx-banner--error">{error}</div>}

        <div className="qx-row" style={{ flex: 1, minHeight: 0, alignItems: 'stretch' }}>
          {/* .xs-scroll is the house flex-overflow pattern PLUS the part the
              pattern alone did not cover: .qx-card sets overflow: hidden, which
              gives a flex item an automatic minimum size of 0, so every panel
              was being shrunk to the container height and clipping its own
              content instead of overflowing. Nothing scrolled because nothing
              overflowed. .xs-scroll > * { flex-shrink: 0 } is the fix, and it
              covers EVERY tab, not just Overview. */}
          <div className="qx-stack xs-scroll">
            {activeTab === 'overview' && (
              <XOverviewPanel
                overview={overview}
                loading={loading}
                error={overviewError}
                onRefresh={refreshOverview}
              />
            )}
            {activeTab === 'compose' && (
              <XComposePanel
                mediaFiles={mediaFiles}
                onRefreshMedia={refreshMedia}
                onDraftPost={handleDraftPost}
                onDraftThread={handleDraftThread}
                onApprove={handleApprove}
                onCheckClaim={handleCheckClaim}
                onSchedulePublish={handleSchedulePublish}
                onUploadImage={handleUploadImage}
                onLoadThumb={handleLoadThumb}
                canApprove={Boolean(isOrgAdmin && orgId)}
              />
            )}
            {activeTab === 'activity' && (
              <div className="qx-stack">
                {/* Approved-and-waiting sits ABOVE the history: a queue of
                    committed publishes is the thing a human most needs to see
                    and be able to stop. */}
                <XScheduledPanel
                  scheduled={scheduled}
                  canCancel={canCancelScheduled}
                  loading={loading}
                  error={scheduledError}
                  onCancel={handleCancelScheduled}
                  onRefresh={refreshScheduled}
                />
                <XActivityPanel claims={claims} ledger={ledger} loading={loading} />
              </div>
            )}
            {activeTab === 'engagement' && (
              <XEngagementPanel authFetch={authFetch} />
            )}
            {activeTab === 'budget' && (
              <XBudgetPanel
                budget={budget}
                reads={overview?.reads || null}
                settings={settings}
                loading={loading}
                error={settingsError}
                onSaveSettings={handleSaveSettings}
                onRefresh={refreshSettings}
              />
            )}
            {activeTab === 'health' && (
              <XAccountHealthPanel health={health} account={account} credential={credential} onVerify={verify} />
            )}
            {activeTab === 'about' && <XAboutPanel />}
          </div>
          {showChat && (
            <div style={{ width: 360, flexShrink: 0, minHeight: 0, display: 'flex' }}>
              <XChatSidebar
                budget={budget}
                claims={claims}
                ledger={ledger}
                health={health}
                collapsed={false}
                onToggle={() => setShowChat(false)}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
