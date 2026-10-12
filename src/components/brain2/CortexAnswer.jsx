/**
 * CortexAnswer - one-shot "ask Cortex" used by Brain2Onboarding.
 *
 * Reuses the CortexDock path (ChatEngine agent="cortex" + the collector
 * citations endpoint + the dock's [B1] chip renderer). No second chat stack.
 * Sends `question` once per `nonce`, reports time-to-first-answer, and tells
 * the parent when the turn failed so it can fall back to plain search.
 * Nothing is persisted here; chat + citations are server-side.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChatEngine } from '../chat/ChatEngine'
import { cortexSessionPrefix } from './lib/cortexScope'
import { CITATIONS_PATH, citeComponents, CitedNotesRow } from './CortexDock'
import './CortexDock.css'

function toRecord(data) {
  const status = data?.status || 'not_searched'
  if (status === 'hits') {
    return { status, citations: Array.isArray(data.citations) ? data.citations : [], finalized: data.finalized !== false }
  }
  return { status, reason: data?.reason }
}

function Runner({ chat, question, nonce, t0Ref, onFailed, answer, record, elapsedMs }) {
  const { isProcessing, sendMessage, error } = chat
  const sentRef = useRef(null)
  useEffect(() => {
    if (!question || sentRef.current === nonce) return
    sentRef.current = nonce
    t0Ref.current = performance.now()
    sendMessage(question)
  }, [question, nonce, sendMessage, t0Ref])

  const failedRef = useRef(null)
  useEffect(() => {
    if (error && !answer && !isProcessing && failedRef.current !== nonce) {
      failedRef.current = nonce
      onFailed?.(String(error))
    }
  }, [error, answer, isProcessing, nonce, onFailed])

  return null
}

export default function CortexAnswer({ question, nonce, orgId, userId, authFetch, onCitationSelect, onAnswered, onFailed, onConnectSource }) {
  const sessionPrefix = cortexSessionPrefix(orgId, userId)
  const sessionIdRef = useRef(null)
  const t0Ref = useRef(0)
  const [answer, setAnswer] = useState(null)
  const [record, setRecord] = useState(null)
  const [elapsedMs, setElapsedMs] = useState(null)

  useEffect(() => { setAnswer(null); setRecord(null); setElapsedMs(null) }, [nonce])

  const fetchCitations = useCallback(async (attempt = 0) => {
    const sid = sessionIdRef.current
    if (!sid) {
      if (attempt < 6) setTimeout(() => fetchCitations(attempt + 1), 150)
      return
    }
    try {
      const res = await authFetch(CITATIONS_PATH(sid))
      if (res.status === 404) { setRecord({ status: 'not_searched' }); return }
      if (!res.ok) { setRecord({ status: 'unavailable', reason: `HTTP ${res.status}` }); return }
      const data = await res.json().catch(() => null)
      if (!data) { setRecord({ status: 'unavailable', reason: 'bad response' }); return }
      setRecord(toRecord(data))
      if (data.finalized === false) {
        setTimeout(async () => {
          try {
            const r2 = await authFetch(CITATIONS_PATH(sid))
            const d2 = r2.ok ? await r2.json().catch(() => null) : null
            if (d2) setRecord(toRecord(d2))
          } catch { /* keep the pre-finalize record */ }
        }, 1500)
      }
    } catch {
      setRecord({ status: 'not_searched' })
    }
  }, [authFetch])

  const handleAssistantMessage = useCallback((msg) => {
    const ms = Math.round(performance.now() - t0Ref.current)
    setAnswer(msg?.text || msg?.content || '')
    setElapsedMs(ms)
    onAnswered?.(ms)
    fetchCitations()
  }, [fetchCitations, onAnswered])

  return (
    <ChatEngine
      key={sessionPrefix}
      agent="cortex"
      sessionPrefix={sessionPrefix}
      orgId={orgId}
      authFetch={authFetch}
      enableMemory
      enableSmartRouter
      onAssistantMessage={handleAssistantMessage}
    >
      {(chat) => {
        sessionIdRef.current = chat.sessionId || sessionIdRef.current
        const pending = !answer && chat.isProcessing
        const searched = record?.status === 'hits' ? record.citations.length : (record?.status === 'empty' ? 0 : null)
        return (
          <>
            <Runner chat={chat} question={question} nonce={nonce} t0Ref={t0Ref} onFailed={onFailed} answer={answer} />
            {pending && (
              <div className="qx-banner qx-banner--info" role="status" data-testid="onboarding-cortex-progress">
                <span className="qx-spinner" /> Qortex is reading your notes...
              </div>
            )}
            {answer != null && (
              <div className="qx-stack" data-testid="onboarding-cortex-answer">
                <div className="cortex-msg-text cortex-msg-text--markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={citeComponents(record, onCitationSelect)}>{answer}</ReactMarkdown>
                </div>
                {record && <CitedNotesRow record={record} onCitationSelect={onCitationSelect} />}
                <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)' }} data-testid="onboarding-cortex-meta">
                  {searched != null ? `${searched} note${searched === 1 ? '' : 's'} searched` : 'Searched your brain'}
                  {elapsedMs != null ? ` · answered in ${(elapsedMs / 1000).toFixed(1)}s` : ''}
                </span>
                {record?.status === 'empty' && (
                  <div className="qx-banner qx-banner--info" role="status" data-testid="onboarding-cortex-nudge">
                    Nothing relevant in your brain yet. Connect a source or capture a note, then ask again.
                    {onConnectSource && (
                      <button className="glass-btn" type="button" onClick={onConnectSource}>Connect a source</button>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )
      }}
    </ChatEngine>
  )
}
