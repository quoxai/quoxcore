/**
 * Quox Voice — governed realtime voice conversation (QUOX-VOICE P2).
 *
 * The compact dashboard surface of the quox-voice backend (repo quox-voice,
 * :3111). The connection, transcript, agent-state and voice-switch logic all
 * live in the shared useQuoxVoiceSession hook — this component is just the
 * card chrome around it, so the full-screen CommanderQ mode (HALHome) and this
 * card run the exact same engine.
 *
 * Sibling pattern: quoxsignal (backend-shaped plugin, thin bundle entry in
 * plugins-src/quox-voice importing this view).
 */
import { useEffect, useRef, useState } from 'react'
import useQuoxVoiceSession from './useQuoxVoiceSession'
import SchedulesTab from './SchedulesTab'
import ApprovalsTab from './ApprovalsTab'
import './quoxvoice.css'

const VOICES = [
  { id: '', label: 'Quox default (Daniel, British male)' },
  { id: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel, warm American female' },
  { id: 'pFZP5JQG7iQjIQuC4Bku', label: 'Lily, British female' },
  { id: 'Xb7hH8MSUJpSbSDYk0k2', label: 'Alice, British female' },
  { id: 'XrExE9yKIg1WjnnlVkGX', label: 'Matilda, warm female' },
  { id: 'cgSgspJ2msm6clMCkdW9', label: 'Jessica, expressive female' },
]

// Agents offered in the picker. The server enforces per-agent tools and
// permissions (QUOX gets the full orchestrator toolset, SCHOLAR a
// research-scoped subset); the view just names which agent to serve.
const AGENTS = [
  { id: 'quox', label: 'CommanderQ (orchestrator)' },
  { id: 'scholar', label: 'SCHOLAR (research specialist)' },
]

export default function QuoxVoiceView() {
  const [tab, setTab] = useState('session')
  const [agentId, setAgentId] = useState('quox')
  const {
    phase, statusMsg, segments, toolEvents, sessionId, voiceId, live,
    start, stop, setVoice,
  } = useQuoxVoiceSession({ agentId })

  const transcriptRef = useAutoScroll(segments)

  return (
    <div className="qx-view quoxvoice-view">
      <div className="qx-tabs qx-tabs--underline" role="tablist">
        {[['session', 'Session'], ['schedules', 'Schedules'], ['approvals', 'Approvals']].map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id}
            className={`qx-tab${tab === id ? ' qx-tab--active' : ''}`}
            onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'schedules' && <SchedulesTab />}
      {tab === 'approvals' && <ApprovalsTab />}
      {tab === 'session' && <div className="qx-card quoxvoice-card">
        <div className="quoxvoice-head">
          <h2>Quox Voice</h2>
          <span className="qx-pill">
            <span className={`qx-dot ${live ? 'qx-dot--online' : 'qx-dot--idle'}`} />
            {live ? 'live, witnessed' : 'governed voice'}
          </span>
        </div>
        <p className="quoxvoice-sub">
          Realtime conversation with CommanderQ. Speech, reasoning and voice all
          run through the governed Quox stack; every session is witnessed, and
          Q answers with real governed tools. You are talking to an AI.
        </p>

        <button
          type="button"
          className={`quoxvoice-orb quoxvoice-orb--${phase}`}
          onClick={() => (live ? undefined : start())}
          title={live ? 'Session running' : 'Start voice session'}
        >
          <span className="quoxvoice-ring" />
          <svg viewBox="0 0 24 24" width="40" height="40" fill="none"
            stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" />
          </svg>
        </button>

        <div className="quoxvoice-status">{statusMsg}</div>

        <div className="quoxvoice-controls">
          <select className="qx-select" value={agentId} disabled={live}
            onChange={(e) => setAgentId(e.target.value)}
            title={live ? 'End the session to switch agent' : 'Choose the agent'}>
            {AGENTS.map((a) => (
              <option key={a.id} value={a.id}>{`Agent: ${a.label}`}</option>
            ))}
          </select>
          <select className="qx-select" value={voiceId}
            onChange={(e) => setVoice(e.target.value)}>
            {VOICES.map((v) => (
              <option key={v.id || 'default'} value={v.id}>{`Voice: ${v.label}`}</option>
            ))}
          </select>
          {live && (
            <button type="button" className="qx-btn quoxvoice-end" onClick={() => stop()}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
              End session
            </button>
          )}
        </div>

        {toolEvents.length > 0 && (
          <div className="quoxvoice-tools">
            {toolEvents.map((t) => (
              <span key={t.id} className={`quoxvoice-tool quoxvoice-tool--${t.status}`}
                title={t.detail}>
                <span className="quoxvoice-tool-dot" />
                {t.name}{t.detail ? ` · ${t.detail}` : ''}
              </span>
            ))}
          </div>
        )}

        {segments.length > 0 && (
          <div className="quoxvoice-transcript" ref={transcriptRef}>
            {segments.map((s) => (
              <div key={s.id}
                className={`quoxvoice-line quoxvoice-line--${s.who}${s.final ? '' : ' quoxvoice-line--interim'}`}>
                <span className="quoxvoice-who">{s.who === 'you' ? 'You' : 'Q'}</span>
                <span>{s.text}</span>
              </div>
            ))}
          </div>
        )}

        {sessionId && (
          <div className="quoxvoice-session">governed session {sessionId} · witnessed server-side</div>
        )}
      </div>}
    </div>
  )
}

// Keep the transcript pinned to the latest line.
function useAutoScroll(dep) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [dep])
  return ref
}
