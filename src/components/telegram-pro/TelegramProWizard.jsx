/**
 * TelegramProWizard: reusable per-bot onboarding wizard for the Quox
 * Telegram Pro multi-bot roster (QTG-PRO P0 → roster evolution).
 * Structure mirrors YouTubeSetupWizard.jsx (useState step index over a
 * STEPS array); styling is .qx-* globals only (glass-design-system skill),
 * no per-view CSS, matching GpuSetupView.jsx.
 *
 * Step 1 gains a bot-kind selector:
 *   - gateway: the shared team/terminal bot. Full 4-step flow (BotFather,
 *     connect token, create the Quox Dev group, bind as owner channel).
 *   - agent: speaks/receives as one Quox agent. Beta. Steps 3-4 collapse
 *     into a single "join the existing group" step: agent bots don't
 *     create their own group, they join the one the gateway already bound.
 *   - notify: outbound only. Same collapsed 3-step flow as agent.
 *
 * Owner quote driving this: "there will be numerous bots to set up to get
 * a really good flow going. We will make the process as painless as
 * possible with good UI/UX.": this wizard is reused unmodified for every
 * bot in the roster, only the copy and step count change by kind.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  saveBotToken, setupWebhook, startPolling, getOnboardingStatus, bindChat, guessWebhookUrl,
} from '../../services/telegramProService'

// TODO: feed from the real agent registry (src/config/agentRegistry.js)
// once agent-kind bots are wired end-to-end for real per-agent routing.
// Static placeholder list so the kind selector has something to offer today.
const AGENT_OPTIONS = [
  { id: 'quox', name: 'QUOX (orchestrator)' },
  { id: 'sentinel', name: 'WARDEN' },
  { id: 'nova', name: 'DAEDALUS' },
  { id: 'cipher', name: 'CIPHER' },
  { id: 'prism', name: 'PRISM' },
]

const KINDS = [
  { id: 'gateway', label: 'Gateway bot', desc: 'The shared team/terminal bot. Most orgs need exactly one.' },
  { id: 'agent', label: 'Agent bot', desc: 'Speaks and receives messages as one Quox agent.', beta: true },
  { id: 'notify', label: 'Notify bot', desc: 'Outbound only, for alerts and notifications.' },
]

function stepsForKind(kind) {
  return kind === 'gateway'
    ? [
      { key: 'botfather', title: 'Create your bot', sub: 'BotFather, once per bot' },
      { key: 'token', title: 'Connect the token', sub: 'Stored in the vault, never in your browser' },
      { key: 'group', title: 'Create the Quox Dev group', sub: 'Topics on, bot admin' },
      { key: 'bind', title: 'Bind and finish', sub: 'Pick your owner channel' },
    ]
    : [
      { key: 'botfather', title: 'Create your bot', sub: 'BotFather, once per bot' },
      { key: 'token', title: 'Connect the token', sub: 'Stored in the vault, never in your browser' },
      { key: 'join', title: 'Add to your group', sub: 'A human admin adds the bot' },
    ]
}

function usernameHintFor(kind, agentId) {
  if (kind === 'agent') return `quox_${agentId || 'agent'}_bot`
  if (kind === 'notify') return 'quox_notify_bot'
  return 'quox_gateway_bot'
}

function displayNameFor(kind, agentId) {
  if (kind === 'agent') {
    const agent = AGENT_OPTIONS.find((a) => a.id === agentId)
    return `Quox Agent · ${agent ? agent.name : 'Unassigned'}`
  }
  if (kind === 'notify') return 'Quox Notify'
  return 'Quox Gateway'
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="22" height="22">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  )
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function LinkIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  )
}

function CopyLine({ text, hint }) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef(null)
  const handleCopy = useCallback(() => {
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {})
    setCopied(true)
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setCopied(false), 1200)
  }, [text])
  useEffect(() => () => clearTimeout(timerRef.current), [])
  return (
    <div className="qx-code-block" style={{ position: 'relative' }}>
      <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" style={{ position: 'absolute', top: 8, right: 8 }} onClick={handleCopy}>
        {copied ? <CheckIcon /> : <CopyIcon />}
        {copied ? 'copied' : 'copy'}
      </button>
      <div>{text}</div>
      {hint && <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginTop: 4 }}>{hint}</div>}
    </div>
  )
}

function ChatList({ chats, selectedChatId, onSelect }) {
  return (
    <div className="qx-stack qx-stack--tight">
      {chats.map((chat) => (
        <label key={chat.tg_chat_id} className="qx-row qx-row--tight glass-btn" style={{ cursor: 'pointer' }}>
          <input
            type="radio"
            name="target-chat"
            checked={selectedChatId === chat.tg_chat_id}
            onChange={() => onSelect(chat.tg_chat_id)}
          />
          <span style={{ flex: 1, fontSize: 13, color: '#fff' }}>{chat.title || chat.tg_chat_id}</span>
          {chat.is_forum && <span className="qx-pill qx-pill--online qx-pill--sm">Topics on</span>}
        </label>
      ))}
    </div>
  )
}

export default function TelegramProWizard({ initialStep = 0, initialKind = 'gateway', existingChats = [], onComplete }) {
  const [kind, setKind] = useState(initialKind)
  const [agentId, setAgentId] = useState(AGENT_OPTIONS[0].id)
  const steps = stepsForKind(kind)

  const [stepIndex, setStepIndex] = useState(Math.min(initialStep, steps.length - 1))
  const [maxReached, setMaxReached] = useState(Math.min(initialStep, steps.length - 1))
  const stepKey = steps[stepIndex].key

  // Step 2: token connect. Default connection path is long-polling
  // (outbound-only, works behind any NAT); webhook is an opt-in "Advanced"
  // path for installs with a public HTTPS URL.
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [tokenSaved, setTokenSaved] = useState(false)
  const [botId, setBotId] = useState(null)
  const [botIdentity, setBotIdentity] = useState(null)
  const [pollingStarted, setPollingStarted] = useState(false)
  const [pollingWarning, setPollingWarning] = useState(null)
  const [webhookSaving, setWebhookSaving] = useState(false)
  const [webhookActive, setWebhookActive] = useState(false)
  const [webhookWarning, setWebhookWarning] = useState(null)
  const webhookUrl = useRef(guessWebhookUrl()).current

  // Step 3 (gateway "group") / "join" (agent, notify): chat detection
  const [detecting, setDetecting] = useState(false)
  const [chatsSeen, setChatsSeen] = useState(existingChats)
  const [detectError, setDetectError] = useState(null)
  const [backendNotDeployed, setBackendNotDeployed] = useState(false)

  // Final step: bind/join
  const [selectedChatId, setSelectedChatId] = useState(existingChats[0]?.tg_chat_id || null)
  const [binding, setBinding] = useState(false)
  const [bindError, setBindError] = useState(null)
  const [bound, setBound] = useState(null)

  const advance = useCallback((next) => {
    setMaxReached((m) => Math.max(m, next))
    setStepIndex(next)
  }, [])

  const goToStep = useCallback((i) => {
    if (i > maxReached) return
    setStepIndex(i)
  }, [maxReached])

  const handleKindChange = useCallback((nextKind) => {
    setKind(nextKind)
    // Re-derive step count for the new kind: stay on step 0.
    setStepIndex(0)
    setMaxReached(0)
  }, [])

  // Poll onboarding status every 4s while detecting is on (group/join steps).
  useEffect(() => {
    const pollable = stepKey === 'group' || stepKey === 'join'
    if (!pollable || !detecting) return undefined
    let cancelled = false
    async function poll() {
      const status = await getOnboardingStatus()
      if (cancelled) return
      if (status.notDeployed) {
        setBackendNotDeployed(true)
        return
      }
      if (status.error) {
        setDetectError(status.error)
        return
      }
      setDetectError(null)
      setChatsSeen(status.chats_seen || [])
    }
    poll()
    const id = setInterval(poll, 4000)
    return () => { cancelled = true; clearInterval(id) }
  }, [stepKey, detecting])

  const handleSaveToken = useCallback(async () => {
    const trimmed = token.trim()
    if (!trimmed) return
    setSaving(true)
    setSaveError(null)
    setPollingWarning(null)
    // Never echoed after save: clear local state immediately, before await.
    setToken('')
    try {
      const saveResult = await saveBotToken(trimmed, { kind, agentId: kind === 'agent' ? agentId : undefined })
      if (!saveResult.success) {
        setSaveError(saveResult.error || 'Failed to save token to the vault')
        setSaving(false)
        return
      }
      setTokenSaved(true)
      setBotId(saveResult.id || null)
      const pollResult = await startPolling(saveResult.id)
      if (pollResult.notDeployed) {
        setBackendNotDeployed(true)
        setPollingWarning('Token saved. Polling is not available yet, the collector endpoint is not deployed on this instance.')
      } else if (!pollResult.ok && !pollResult.polling) {
        setPollingWarning(pollResult.error || 'Token saved, but polling could not start. You can retry from the roster later.')
      } else {
        setPollingStarted(true)
      }
    } catch (err) {
      setSaveError(err.message || 'Failed to connect the token')
    } finally {
      setSaving(false)
    }
  }, [token, kind, agentId])

  // Advanced, opt-in path: register a webhook instead of polling. Only makes
  // sense for installs that have a public HTTPS URL Telegram can reach.
  const handleUseWebhook = useCallback(async () => {
    setWebhookSaving(true)
    setWebhookWarning(null)
    try {
      const webhookResult = await setupWebhook(webhookUrl, botId)
      if (webhookResult.notDeployed) {
        setBackendNotDeployed(true)
        setWebhookWarning('Webhook registration is not available yet, the collector endpoint is not deployed on this instance.')
      } else if (webhookResult.success === false && !webhookResult.notDeployed) {
        setWebhookWarning(webhookResult.error || 'Webhook registration failed. You can retry from the roster later.')
      } else {
        setWebhookActive(true)
        if (webhookResult.bot_username) setBotIdentity({ username: webhookResult.bot_username })
      }
    } catch (err) {
      setWebhookWarning(err.message || 'Webhook registration failed.')
    } finally {
      setWebhookSaving(false)
    }
  }, [webhookUrl, botId])

  const handleBind = useCallback(async () => {
    if (!selectedChatId) return
    setBinding(true)
    setBindError(null)
    try {
      const result = await bindChat(selectedChatId, botId)
      if (result.notDeployed) {
        setBackendNotDeployed(true)
        setBindError('Binding is not available yet, the collector endpoint is not deployed on this instance.')
        return
      }
      if (!result.ok) {
        setBindError(result.error || 'Failed to bind this chat')
        return
      }
      setBound(result.binding || { tg_chat_id: selectedChatId })
    } catch (err) {
      setBindError(err.message || 'Failed to bind this chat')
    } finally {
      setBinding(false)
    }
  }, [selectedChatId, botId])

  const isFinalStep = stepIndex === steps.length - 1
  const canProceedFromKind = kind !== 'agent' || !!agentId

  return (
    <div className="qx-card" style={{ maxWidth: 720, margin: '0 auto', width: '100%' }}>
      {/* Header */}
      <div className="qx-row qx-row--apart" style={{ marginBottom: 4 }}>
        <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
          <span style={{ color: '#38bdf8' }}><SendIcon /></span>
          <div>
            <h2 style={{ margin: 0, fontSize: 19, fontWeight: 650, color: '#fff' }}>Connect a Telegram bot</h2>
            <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'rgba(255,255,255,0.7)' }}>Set up once, reuse for every bot in your roster</p>
          </div>
        </div>
        <span className="qx-pill qx-pill--info qx-pill--sm">STEP {stepIndex + 1} / {steps.length}</span>
      </div>

      {backendNotDeployed && (
        <div className="qx-banner qx-banner--warn" style={{ marginTop: 12 }}>
          <span>Backend not deployed yet on this instance. This step will complete once the Telegram Pro onboarding endpoints ship.</span>
        </div>
      )}

      {/* Progress */}
      <div className="qx-row qx-row--tight" style={{ margin: '16px 0' }}>
        {steps.map((s, i) => {
          const state = i < stepIndex ? 'done' : i === stepIndex ? 'active' : 'upcoming'
          const clickable = i <= maxReached
          return (
            <button
              key={s.key}
              type="button"
              disabled={!clickable}
              className={`qx-btn qx-btn--sm${state === 'active' ? ' qx-btn--primary' : ' qx-btn--ghost'}`}
              style={{ flex: 1, justifyContent: 'center', cursor: clickable ? 'pointer' : 'default', opacity: state === 'upcoming' ? 0.6 : 1 }}
              onClick={() => goToStep(i)}
            >
              <span className={`qx-dot qx-dot--${state === 'done' ? 'online' : state === 'active' ? 'loading' : 'idle'}`} />
              {i + 1}. {s.title}
            </button>
          )
        })}
      </div>

      <div className="qx-divider qx-divider--dense" />

      {/* Step content */}
      <div className="qx-stack" style={{ minHeight: 260 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: '#fff' }}>{steps[stepIndex].title}</h3>
          <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'rgba(255,255,255,0.7)' }}>{steps[stepIndex].sub}</p>
        </div>

        {stepKey === 'botfather' && (
          <div className="qx-stack qx-stack--tight">
            <span className="qx-section-title">Bot kind</span>
            <div className="qx-grid-3">
              {KINDS.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  className="qx-action-card"
                  aria-pressed={kind === k.id}
                  style={kind === k.id ? { borderColor: 'rgba(56,189,248,0.55)', background: 'linear-gradient(145deg, rgba(56,189,248,0.12), rgba(168,85,247,0.06))' } : undefined}
                  onClick={() => handleKindChange(k.id)}
                >
                  <div className="qx-action-card__body">
                    <div className="qx-action-card__title">
                      {k.label}
                      {k.beta && <span className="qx-pill qx-pill--purple qx-pill--sm" style={{ marginLeft: 6 }}>Beta</span>}
                    </div>
                    <div className="qx-action-card__desc">{k.desc}</div>
                  </div>
                </button>
              ))}
            </div>

            {kind === 'agent' && (
              <div className="qx-field">
                <label className="qx-field__label">Which agent should this bot speak as?</label>
                <select className="qx-select" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                  {AGENT_OPTIONS.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                <span className="qx-field__hint">Beta: agent-specific behavior is still rolling out. The bot connects and joins your group today; deeper per-agent routing lands in a later phase.</span>
              </div>
            )}

            <p style={{ fontSize: 13.5, color: 'rgba(255,255,255,0.85)' }}>
              Telegram only lets a human create a bot, so Quox cannot do this step for you.
            </p>
            <ol style={{ paddingLeft: 20, margin: 0, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13.5, color: 'rgba(255,255,255,0.85)' }}>
              <li>Open <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" style={{ color: '#38bdf8' }}>@BotFather</a> in Telegram</li>
              <li>Send the command below</li>
              <li>When asked for a display name, use <code className="qx-code">{displayNameFor(kind, agentId)}</code></li>
              <li>When asked for a username, try <code className="qx-code">{usernameHintFor(kind, agentId)}</code> (must end in "bot", must be unique, BotFather will suggest alternatives if it is taken)</li>
              <li>BotFather replies with a token, keep that chat open, you will paste the token in the next step</li>
            </ol>
            {kind !== 'gateway' && (
              <div className="qx-banner qx-banner--info">
                <span>This bot joins the Quox Dev group your gateway bot already bound. A human admin adds it manually in the last step, Telegram does not let bots add other bots.</span>
              </div>
            )}
            <CopyLine text="/newbot" hint="Send this to @BotFather to start bot creation" />
            <div className="qx-row qx-row--tight" style={{ marginTop: 'auto', paddingTop: 16 }}>
              <button type="button" className="qx-btn qx-btn--primary" disabled={!canProceedFromKind} onClick={() => advance(1)}>Next</button>
            </div>
          </div>
        )}

        {stepKey === 'token' && (
          <div className="qx-stack qx-stack--tight">
            {!tokenSaved && (
              <>
                <div className="qx-field">
                  <label className="qx-field__label">Bot Token</label>
                  <input
                    type="password"
                    className="qx-input"
                    placeholder="123456789:ABCdefGHIjklMNOpqrSTUvwxYZ"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    autoComplete="off"
                    autoFocus
                  />
                  <span className="qx-field__hint">Pasted from BotFather. Stored encrypted in the vault, never in your browser.</span>
                </div>
                {saveError && <div className="qx-banner qx-banner--error"><span>{saveError}</span></div>}
                <div className="qx-row qx-row--tight" style={{ marginTop: 'auto', paddingTop: 16 }}>
                  <button type="button" className="qx-btn qx-btn--ghost" onClick={() => goToStep(0)}>Back</button>
                  <button type="button" className="qx-btn qx-btn--primary" disabled={!token.trim() || saving} onClick={handleSaveToken}>
                    {saving ? 'Connecting…' : 'Save & Connect'}
                  </button>
                </div>
              </>
            )}
            {tokenSaved && (
              <>
                <div className="qx-banner qx-banner--success">
                  <span>Token saved to the vault{botIdentity?.username ? `: connected as @${botIdentity.username}` : ''}.</span>
                </div>
                {pollingStarted && (
                  <div className="qx-banner qx-banner--success">
                    <span>Connected. Quox is polling Telegram for this bot. No public URL or open port needed.</span>
                  </div>
                )}
                {pollingWarning && <div className="qx-banner qx-banner--warn"><span>{pollingWarning}</span></div>}

                <details className="qx-disclosure">
                  <summary className="qx-disclosure__head">
                    <span className="qx-disclosure__chev" />
                    <span style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.7)' }}>This install has a public HTTPS URL? Use a webhook instead.</span>
                  </summary>
                  <div className="qx-disclosure__body">
                    <div className="qx-stack qx-stack--tight">
                      <p style={{ margin: 0, fontSize: 12.5, color: 'rgba(255,255,255,0.7)' }}>
                        Only switch to a webhook if Telegram can reach this box directly over HTTPS. Polling stays on for this bot until you do.
                      </p>
                      {webhookWarning && <div className="qx-banner qx-banner--warn"><span>{webhookWarning}</span></div>}
                      {webhookActive ? (
                        <div className="qx-banner qx-banner--success"><span>Webhook registered{botIdentity?.username ? `: @${botIdentity.username}` : ''}.</span></div>
                      ) : (
                        <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" disabled={webhookSaving} onClick={handleUseWebhook}>
                          <LinkIcon />
                          {webhookSaving ? 'Registering…' : 'Register webhook instead'}
                        </button>
                      )}
                    </div>
                  </div>
                </details>

                <div className="qx-row qx-row--tight" style={{ marginTop: 'auto', paddingTop: 16 }}>
                  <button type="button" className="qx-btn qx-btn--ghost" onClick={() => goToStep(0)}>Back</button>
                  <button type="button" className="qx-btn qx-btn--primary" onClick={() => advance(2)}>Next</button>
                </div>
              </>
            )}
          </div>
        )}

        {stepKey === 'group' && (
          <div className="qx-stack qx-stack--tight">
            <ol style={{ paddingLeft: 20, margin: 0, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13.5, color: 'rgba(255,255,255,0.85)' }}>
              <li>Create a new Telegram group named <code className="qx-code">Quox Dev</code></li>
              <li>Open group settings and enable <b>Topics</b></li>
              <li>Add your gateway bot to the group</li>
              <li>Promote the bot to admin with the <b>Manage Topics</b> permission</li>
            </ol>
            <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
              <button type="button" className="qx-btn" disabled={detecting} onClick={() => { setDetecting(true); setDetectError(null) }}>
                {detecting ? <span className="qx-dot qx-dot--loading" /> : null}
                {detecting ? 'Detecting…' : 'Detect my group'}
              </button>
              {detecting && <span className="qx-hint qx-hint--sm">Polling every 4s</span>}
            </div>
            {detectError && <div className="qx-banner qx-banner--error"><span>{detectError}</span></div>}
            {chatsSeen.length > 0 && (
              <div className="qx-stack qx-stack--tight">
                <span className="qx-section-title">Detected chats</span>
                {chatsSeen.map((chat) => (
                  <div key={chat.tg_chat_id} className="qx-row qx-row--apart" style={{ padding: '6px 0' }}>
                    <span style={{ fontSize: 13, color: '#fff' }}>{chat.title || chat.tg_chat_id}</span>
                    {chat.is_forum && <span className="qx-pill qx-pill--online qx-pill--sm">Topics on</span>}
                  </div>
                ))}
              </div>
            )}
            <div className="qx-row qx-row--tight" style={{ marginTop: 'auto', paddingTop: 16 }}>
              <button type="button" className="qx-btn qx-btn--ghost" onClick={() => goToStep(1)}>Back</button>
              <button type="button" className="qx-btn qx-btn--primary" disabled={chatsSeen.length === 0} onClick={() => advance(3)}>Next</button>
            </div>
          </div>
        )}

        {stepKey === 'join' && !bound && (
          <div className="qx-stack qx-stack--tight">
            <ol style={{ paddingLeft: 20, margin: 0, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13.5, color: 'rgba(255,255,255,0.85)' }}>
              <li>Open your existing <code className="qx-code">Quox Dev</code> group</li>
              <li>Add <b>{botIdentity?.username ? `@${botIdentity.username}` : 'this bot'}</b> to the group yourself</li>
              <li>Promote it to admin only if it needs to post into topics</li>
            </ol>
            <div className="qx-banner qx-banner--info">
              <span>Telegram does not let bots add other bots, a human admin has to do this step.</span>
            </div>
            {chatsSeen.length === 0 && (
              <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
                <button type="button" className="qx-btn" disabled={detecting} onClick={() => { setDetecting(true); setDetectError(null) }}>
                  {detecting ? <span className="qx-dot qx-dot--loading" /> : null}
                  {detecting ? 'Detecting…' : 'Detect my group'}
                </button>
                {detecting && <span className="qx-hint qx-hint--sm">Polling every 4s</span>}
              </div>
            )}
            {detectError && <div className="qx-banner qx-banner--error"><span>{detectError}</span></div>}
            {chatsSeen.length > 0 && (
              <div className="qx-stack qx-stack--tight">
                <span className="qx-section-title">Pick the group this bot joined</span>
                <ChatList chats={chatsSeen} selectedChatId={selectedChatId} onSelect={setSelectedChatId} />
              </div>
            )}
            {bindError && <div className="qx-banner qx-banner--error"><span>{bindError}</span></div>}
            <div className="qx-row qx-row--tight" style={{ marginTop: 'auto', paddingTop: 16 }}>
              <button type="button" className="qx-btn qx-btn--ghost" onClick={() => goToStep(1)}>Back</button>
              <button type="button" className="qx-btn qx-btn--primary" disabled={!selectedChatId || binding} onClick={handleBind}>
                {binding ? 'Joining…' : 'Join and finish'}
              </button>
            </div>
          </div>
        )}

        {stepKey === 'bind' && !bound && (
          <div className="qx-stack qx-stack--tight">
            <p style={{ fontSize: 13.5, color: 'rgba(255,255,255,0.85)' }}>Pick the chat that should become your owner channel.</p>
            <ChatList chats={chatsSeen} selectedChatId={selectedChatId} onSelect={setSelectedChatId} />
            {bindError && <div className="qx-banner qx-banner--error"><span>{bindError}</span></div>}
            <div className="qx-row qx-row--tight" style={{ marginTop: 'auto', paddingTop: 16 }}>
              <button type="button" className="qx-btn qx-btn--ghost" onClick={() => goToStep(2)}>Back</button>
              <button type="button" className="qx-btn qx-btn--primary" disabled={!selectedChatId || binding} onClick={handleBind}>
                {binding ? 'Binding…' : 'Bind and finish'}
              </button>
            </div>
          </div>
        )}

        {isFinalStep && bound && (
          <div className="qx-stack qx-stack--tight">
            <div className="qx-banner qx-banner--success">
              <span>{kind === 'gateway' ? 'Owner channel bound.' : 'Bot joined and bound to the group.'}</span>
            </div>
            <div>
              <span className="qx-section-title">Now working</span>
              <ul style={{ paddingLeft: 20, margin: '6px 0 0', display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13.5, color: 'rgba(255,255,255,0.85)' }}>
                {kind === 'gateway' && (
                  <>
                    <li>Owner channel via your gateway bot</li>
                    <li>Replay-safe webhooks, no duplicate or lost updates</li>
                    <li>Rate-aware outbound queue respecting Telegram's limits</li>
                  </>
                )}
                {kind === 'agent' && (
                  <>
                    <li>This bot is connected and joined to your group (Beta)</li>
                    <li>Replay-safe webhooks, no duplicate or lost updates</li>
                  </>
                )}
                {kind === 'notify' && (
                  <>
                    <li>Outbound notifications from this bot</li>
                    <li>Rate-aware outbound queue respecting Telegram's limits</li>
                  </>
                )}
              </ul>
            </div>
            <div>
              <span className="qx-section-title">Coming next</span>
              <ul style={{ paddingLeft: 20, margin: '6px 0 0', display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13.5, color: 'rgba(255,255,255,0.7)' }}>
                <li>Terminal topic channels for live session visibility</li>
                {kind === 'agent' ? <li>Full per-agent identity and routing (this bot is the Beta preview)</li> : <li>Per-agent bot identities</li>}
              </ul>
            </div>
            <div className="qx-row qx-row--tight" style={{ marginTop: 'auto', paddingTop: 16 }}>
              <button type="button" className="qx-btn qx-btn--primary" onClick={() => onComplete?.(bound)}>Back to roster</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
