/**
 * TelegramProView: Quox Telegram Pro (QTG-PRO P0 → multi-bot roster)
 *
 * Owner quote driving this rescope: "there will be numerous bots to set up
 * to get a really good flow going. We will make the process as painless as
 * possible with good UI/UX."
 *
 * Empty roster: full-bleed hero card leading into the wizard for the first
 * (gateway) bot: same as the original one-shot onboarding.
 * Non-empty roster: a Bots list. Each row (a .qx-disclosure) shows
 * username/name, kind badge, webhook status dot, bound chat count, added
 * date; expanding a row reveals its detail pane. A prominent "Add bot"
 * button opens the same reusable 4-step (gateway) / 3-step (agent, notify)
 * wizard.
 *
 * Built with .qx-* globals only (glass-design-system): no per-view CSS.
 */

import { useState, useEffect, useCallback } from 'react'
import { getBots, getPollingStatus } from '../../services/telegramProService'
import TelegramProWizard from './TelegramProWizard'

const KIND_LABEL = { gateway: 'Gateway', agent: 'Agent', notify: 'Notify' }
const KIND_PILL_CLASS = { gateway: 'qx-pill--info', agent: 'qx-pill--purple', notify: 'qx-pill--ghost' }

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="20" height="20">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  )
}

function BotRow({ bot }) {
  const kind = bot.kind || 'gateway'
  return (
    <details className="qx-disclosure">
      <summary className="qx-disclosure__head">
        <span className="qx-disclosure__chev" />
        <div className="qx-row qx-row--apart" style={{ flex: 1 }}>
          <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
            <span style={{ fontSize: 13.5, fontWeight: 600, color: '#fff' }}>{bot.name || (bot.username ? `@${bot.username}` : bot.bot_id)}</span>
            <span className={`qx-pill qx-pill--sm ${KIND_PILL_CLASS[kind] || 'qx-pill--ghost'}`}>{KIND_LABEL[kind] || kind}</span>
          </div>
          <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
            {bot.pollingKnown && (
              bot.pollingActive ? (
                <span className="qx-pill qx-pill--online qx-pill--sm">
                  <span className="qx-dot qx-dot--online qx-dot--sm" style={{ marginRight: 4 }} />
                  Polling
                </span>
              ) : bot.webhook_active ? (
                <span className="qx-pill qx-pill--ghost qx-pill--sm">Webhook</span>
              ) : (
                <span className="qx-pill qx-pill--ghost qx-pill--sm">Not connected</span>
              )
            )}
            <span className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
              <span className={`qx-dot qx-dot--${bot.webhook_active ? 'online' : 'offline'} qx-dot--sm`} />
              <span style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.7)' }}>{bot.webhook_active ? 'Webhook active' : 'Webhook inactive'}</span>
            </span>
            <span className="qx-pill qx-pill--ghost qx-pill--sm">{bot.chats_bound || 0} chat{bot.chats_bound === 1 ? '' : 's'}</span>
          </div>
        </div>
      </summary>
      <div className="qx-disclosure__body">
        <div className="qx-grid-2" style={{ marginTop: 8 }}>
          <div className="qx-stat-row">
            <span className="qx-stat-row__label">Username</span>
            <span className="qx-stat-row__value">{bot.username ? `@${bot.username}` : '—'}</span>
          </div>
          <div className="qx-stat-row">
            <span className="qx-stat-row__label">Kind</span>
            <span className="qx-stat-row__value">{KIND_LABEL[kind] || kind}</span>
          </div>
          <div className="qx-stat-row">
            <span className="qx-stat-row__label">Webhook</span>
            <span className="qx-stat-row__value">{bot.webhook_active ? 'Active' : 'Inactive'}</span>
          </div>
          <div className="qx-stat-row">
            <span className="qx-stat-row__label">Added</span>
            <span className="qx-stat-row__value">{bot.added_at ? new Date(bot.added_at).toLocaleDateString() : '—'}</span>
          </div>
        </div>
        {bot._legacyShape && (
          <div className="qx-hint qx-hint--sm" style={{ marginTop: 8 }}>
            Roster detail is synthesized from the single-bot status endpoint: full per-bot detail lands once the backend ships the bots[] roster.
          </div>
        )}
      </div>
    </details>
  )
}

export default function TelegramProView() {
  const [loading, setLoading] = useState(true)
  const [bots, setBots] = useState([])
  const [raw, setRaw] = useState(null)
  const [notDeployed, setNotDeployed] = useState(false)
  const [addingBot, setAddingBot] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const [result, pollingResult] = await Promise.all([getBots(), getPollingStatus()])
    const pollingKnown = !pollingResult.notDeployed
    const pollerIds = new Set((pollingResult.pollers || []).map((p) => p.bot_id))
    const merged = (result.bots || []).map((bot) => ({
      ...bot,
      pollingKnown,
      pollingActive: pollingKnown && pollerIds.has(bot.bot_id),
    }))
    setBots(merged)
    setRaw(result.raw || null)
    setNotDeployed(!!result.notDeployed)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  if (loading) {
    return (
      <div className="qx-view qx-pad">
        <div className="qx-row qx-row--tight" style={{ alignItems: 'center', justifyContent: 'center', minHeight: 200 }}>
          <span className="qx-dot qx-dot--loading" />
          <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)' }}>Checking your bot roster…</span>
        </div>
      </div>
    )
  }

  const existingChats = raw?.chats_seen || []
  const hasBots = bots.length > 0

  if (addingBot || !hasBots) {
    return (
      <div className="qx-view qx-pad" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
        {notDeployed && (
          <div className="qx-banner qx-banner--warn" style={{ maxWidth: 720, width: '100%' }}>
            <span>Backend not deployed yet on this instance. The wizard still walks you through it, but the last step will not complete until the Telegram Pro onboarding endpoints ship.</span>
          </div>
        )}
        {addingBot && hasBots && (
          <div style={{ maxWidth: 720, width: '100%' }}>
            <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => { setAddingBot(false); load() }}>
              <BackIcon />
              Back to roster
            </button>
          </div>
        )}
        <TelegramProWizard
          initialKind="gateway"
          existingChats={hasBots ? existingChats : []}
          onComplete={() => { setAddingBot(false); load() }}
        />
      </div>
    )
  }

  return (
    <div className="qx-view qx-pad qx-stack">
      <div className="qx-row qx-row--apart">
        <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
          <span style={{ color: '#38bdf8' }}><SendIcon /></span>
          <div>
            <h1 style={{ margin: 0, fontSize: 19, fontWeight: 650, color: '#fff' }}>Quox Telegram Pro</h1>
            <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'rgba(255,255,255,0.7)' }}>Gateway, agent, and notify bots in one roster</p>
          </div>
        </div>
        <button type="button" className="qx-btn qx-btn--primary" onClick={() => setAddingBot(true)}>
          <PlusIcon />
          Add bot
        </button>
      </div>

      {notDeployed && (
        <div className="qx-banner qx-banner--warn">
          <span>Backend not deployed yet: showing the single-bot status endpoint's data synthesized into a roster.</span>
        </div>
      )}

      <div className="qx-card">
        <span className="qx-section-title">Bots ({bots.length})</span>
        <div className="qx-stack qx-stack--tight" style={{ marginTop: 8 }}>
          {bots.map((bot) => <BotRow key={bot.bot_id} bot={bot} />)}
        </div>
      </div>

      <div className="qx-card">
        <span className="qx-section-title">Recent activity</span>
        <div className="qx-empty">
          <div className="qx-empty__title">Not available yet</div>
          <div className="qx-empty__body">Terminal topic channels and message activity land in a later phase of Telegram Pro.</div>
        </div>
      </div>
    </div>
  )
}
