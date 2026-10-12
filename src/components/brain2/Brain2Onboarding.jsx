/**
 * Brain2Onboarding - first-run connect -> capture -> ask card (BRAIN2-W8).
 *
 * Progress is derived from SERVER data (lib/onboarding.js): connected feed
 * source rows, /brain/status note count, and the /brain/usage search ledger.
 * localStorage holds only the "dismissed" UI preference (set by the parent).
 * Composed from .qx-* utilities and global button classes, no bespoke CSS.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { getSources } from '../../services/brain2FeedClient'
import { getQuoxbrainClient } from '../../services/quoxbrainClient'
import { interpretSearchResponse } from '../../pages/views/quoxbrainSearchState'
import Brain2ConnectSource from '../settings/Brain2ConnectSource'
import BrainCapture from './BrainCapture'
import CortexAnswer from './CortexAnswer'
import Brain2FirstSync from './Brain2FirstSync'
import { deriveOnboarding, seedQuestion } from './lib/onboarding'

const Svg = ({ children, size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)
const PlugIcon = () => <Svg><path d="M9 2v6" /><path d="M15 2v6" /><path d="M6 8h12v4a6 6 0 0 1-12 0z" /><path d="M12 18v4" /></Svg>
const AskIcon = () => <Svg><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></Svg>
const CloseIcon = () => <Svg><path d="M18 6L6 18" /><path d="M6 6l12 12" /></Svg>
const CheckIcon = () => <Svg><path d="M20 6L9 17l-5-5" /></Svg>

const STEP_TITLES = {
  connect: 'Connect a source',
  capture: 'Capture a first note',
  ask: 'Ask a first question'
}

function StepHeader({ n, id, done, current }) {
  return (
    <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
      <span className={`qx-pill qx-pill--sm ${done ? 'qx-pill--online' : current ? 'qx-pill--info' : 'qx-pill--ghost'}`}>
        {done ? <CheckIcon /> : n}
      </span>
      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{STEP_TITLES[id]}</h3>
    </div>
  )
}

export default function Brain2Onboarding({ noteCount = 0, onChanged, onDismiss, client, orgId, userId, onCitationSelect }) {
  const { authFetch, user } = useAuth()
  const api = useMemo(() => client || getQuoxbrainClient(), [client])
  const [sources, setSources] = useState([])
  const [searchCount, setSearchCount] = useState(0)
  const [connectSource, setConnectSource] = useState(null)
  const [question, setQuestion] = useState('')
  const [seeded, setSeeded] = useState(false)
  const [asking, setAsking] = useState(false)
  const [answer, setAnswer] = useState(null) // {insufficient, results} | {error}
  const [askedThisSession, setAskedThisSession] = useState(false)
  const [cortexAsk, setCortexAsk] = useState(null) // {question, nonce}
  const [firstAnswerMs, setFirstAnswerMs] = useState(null) // time-to-first-answer, ms
  const askRef = useRef(null)
  const askInputRef = useRef(null)

  const refresh = useCallback(async () => {
    const [src, usage] = await Promise.allSettled([
      authFetch ? getSources({ authFetch }) : Promise.resolve([]),
      api.getUsage()
    ])
    if (src.status === 'fulfilled') setSources(src.value)
    if (usage.status === 'fulfilled') setSearchCount(Number(usage.value?.total?.search) || 0)
  }, [authFetch, api])
  useEffect(() => { refresh() }, [refresh])

  const progress = deriveOnboarding({ noteCount, sources, searchCount, askedThisSession })
  const connectable = sources.filter((s) => !s.connected && (s.status === 'live' || s.connector === 'oauth')).slice(0, 6)

  const askAboutSynced = () => {
    if (!question) setQuestion('What is in my synced data?')
    askInputRef.current?.focus()
  }

  const handleSaved =(out, ctx) => {
    if (!seeded && !question) {
      const q = seedQuestion({ title: out?.title, text: ctx?.text })
      if (q) { setQuestion(q); setSeeded(true) }
    }
    onChanged?.()
    refresh()
  }

  const fallbackSearch = async (q, reason) => {
    try {
      const data = await api.brainSearch(q, { limit: 5 })
      setAnswer({ ...interpretSearchResponse(data), warning: reason })
      setAskedThisSession(true)
      refresh()
    } catch (err) {
      setAnswer({ error: [reason, err?.message || 'Search failed'].filter(Boolean).join(' / ') })
    } finally {
      setAsking(false)
    }
  }

  const ask = (e) => {
    e?.preventDefault()
    const q = question.trim()
    if (!q || asking) return
    setAsking(true)
    setAnswer(null)
    setFirstAnswerMs(null)
    const next = { question: q, nonce: Date.now() }
    askRef.current = next
    setCortexAsk(next)
  }

  const handleAnswered = useCallback((ms) => {
    setFirstAnswerMs(ms)
    setAsking(false)
    setAskedThisSession(true)
    refresh()
  }, [refresh])

  const handleCortexFailed = useCallback((msg) => {
    const cur = askRef.current
    if (!cur) return
    askRef.current = null
    setCortexAsk(null)
    fallbackSearch(cur.question, `Qortex could not answer (${msg}). Showing matching notes instead.`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api])

  return (
    <section className="qx-card" data-testid="brain2-onboarding">
      <div className="qx-stack">
        <div className="qx-row qx-row--apart" style={{ alignItems: 'center' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 16 }}>Get your brain going</h2>
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>{progress.doneCount} of {progress.total} steps done</span>
          </div>
          <button className="glass-btn" type="button" onClick={onDismiss} aria-label="Dismiss onboarding">
            <CloseIcon /> Dismiss
          </button>
        </div>
        <div className="qx-progress qx-progress--slim" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.doneCount}>
          <div className="qx-progress__fill" style={{ width: `${(progress.doneCount / progress.total) * 100}%` }} />
        </div>

        <div className="qx-grid-3">
          <div className="qx-stack" data-testid="onboarding-step-connect">
            <StepHeader n={1} id="connect" done={progress.done.connect} current={progress.current === 'connect'} />
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>
              {progress.connected.length > 0
                ? `Connected: ${progress.connected.map((s) => s.name || s.sourceType).join(', ')}`
                : 'Nothing connected yet. Pick where your knowledge already lives.'}
            </span>
            <div className="qx-row qx-row--wrap qx-row--tight">
              {connectable.map((s) => (
                <button key={s.sourceType} className="glass-btn" type="button" onClick={() => setConnectSource(s)}>
                  <PlugIcon /> {s.name || s.sourceType}
                </button>
              ))}
            </div>
          </div>

          <div className="qx-stack" data-testid="onboarding-step-capture">
            <StepHeader n={2} id="capture" done={progress.done.capture} current={progress.current === 'capture'} />
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>
              {progress.done.capture ? `${noteCount} note${noteCount === 1 ? '' : 's'} in your brain. Add another any time.` : 'Paste a note or a link. It is saved and searchable straight away.'}
            </span>
            <BrainCapture client={client} onSaved={handleSaved} />
          </div>

          <div className="qx-stack" data-testid="onboarding-step-ask" data-first-answer-ms={firstAnswerMs ?? undefined}>
            <StepHeader n={3} id="ask" done={progress.done.ask} current={progress.current === 'ask'} />
            <form className="qx-stack" onSubmit={ask}>
              <input
                className="glass-input"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder={progress.done.capture ? 'Ask your brain a question' : 'Capture a note first, then ask about it'}
                aria-label="Ask your brain a first question"
                ref={askInputRef}
              />
              <button className="glass-btn" type="submit" disabled={!question.trim() || asking}>
                <AskIcon /> {asking ? 'Asking Qortex...' : 'Ask'}
              </button>
            </form>
            {cortexAsk && (
              <CortexAnswer
                key={cortexAsk.nonce}
                question={cortexAsk.question}
                nonce={cortexAsk.nonce}
                orgId={orgId || user?.org_id}
                userId={userId || user?.id}
                authFetch={authFetch}
                onCitationSelect={onCitationSelect}
                onAnswered={handleAnswered}
                onFailed={handleCortexFailed}
                onConnectSource={connectable[0] ? () => setConnectSource(connectable[0]) : undefined}
              />
            )}
            {answer?.warning && <div className="qx-banner qx-banner--error" role="alert">{answer.warning}</div>}
            {answer?.error && <div className="qx-banner qx-banner--error" role="alert">{answer.error}</div>}
            {answer && !answer.error && answer.insufficient && (
              <div className="qx-banner qx-banner--info" role="status">No relevant notes. Nothing in your brain matched that closely enough to show.</div>
            )}
            {answer && !answer.error && !answer.insufficient && answer.results.length === 0 && (
              <div className="qx-banner qx-banner--info" role="status">No relevant notes.</div>
            )}
            {answer && !answer.error && answer.results.length > 0 && (
              <ul className="qx-stack" style={{ listStyle: 'none', margin: 0, padding: 0 }} data-testid="onboarding-results">
                {answer.results.map((r) => (
                  <li key={r.chunkId || r.noteId || r.relPath} style={{ fontSize: 12 }}>
                    <strong>{r.title || r.relPath}</strong>
                    {r.snippet || r.text ? <div style={{ color: 'rgba(255,255,255,0.7)' }}>{String(r.snippet || r.text).slice(0, 160)}</div> : null}
                    {r.relPath ? <div style={{ color: 'rgba(255,255,255,0.7)' }}>Source: {r.relPath}</div> : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        {progress.connected.length > 0 && (
          <Brain2FirstSync authFetch={authFetch} sources={progress.connected} onAskFirst={askAboutSynced} />
        )}
      </div>

      {connectSource && (
        <Brain2ConnectSource
          source={connectSource}
          onClose={() => setConnectSource(null)}
          onConnected={() => { setConnectSource(null); onChanged?.(); refresh() }}
        />
      )}
    </section>
  )
}
