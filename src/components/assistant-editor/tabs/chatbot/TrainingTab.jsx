/**
 * TrainingTab — System prompt, guardrails, live test chat with source attribution
 * CW-8.6
 *
 * QCL-TEACH P1 — Teach Mode. `correctedBy` is passed down from
 * QuoxChatWidgetRoom (the authenticated admin's email via useAuth()) rather
 * than called here, so TrainingTab keeps working when rendered outside an
 * AuthProvider (render tests, any future standalone route) — same pattern
 * LogsTab uses for its "Improve this answer" correction loop.
 */

import { useState } from 'react'
import { getConfidenceBadge, formatSourceAttribution } from '../../../../widget/trainingUtils'

// QCL-TEACH P1: how many recent test-chat turns to send to /teach/propose —
// enough for the LLM to see the mistake + the admin's correction without
// unbounded growth of the request body.
const TEACH_CONTEXT_TURNS = 12

export default function TrainingTab({ widget, authFetch, orgId, correctedBy, onWidgetChange }) {
  const persona = widget?.persona || JSON.parse(widget?.persona_json || '{}')
  // QUOXCHAT-BRUTALOOP w5 D3: the widget row (system_prompt_override +
  // guardrails_json) is what the message path reads; fall back to the
  // persona copy for widgets saved before that wiring.
  let savedGuardrails = null
  try { savedGuardrails = widget?.guardrails_json ? JSON.parse(widget.guardrails_json) : null } catch { savedGuardrails = null }
  const gr = savedGuardrails && !Array.isArray(savedGuardrails) ? savedGuardrails : persona.widget_config?.guardrails
  const [systemPrompt, setSystemPrompt] = useState(widget?.system_prompt_override || '')
  const [alwaysRules, setAlwaysRules] = useState((gr?.always || []).join('\n'))
  const [neverRules, setNeverRules] = useState((gr?.never || []).join('\n'))
  const [testQuery, setTestQuery] = useState('')
  const [testResult, setTestResult] = useState(null)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState(null)

  // QCL-TEACH P1 — Teach Mode state. `turns` accumulates the recent test-chat
  // exchange (user + assistant) so a correction has context to propose from.
  const [teachMode, setTeachMode] = useState(false)
  const [turns, setTurns] = useState([])
  const [proposing, setProposing] = useState(false)
  const [proposal, setProposal] = useState(null) // { question, answer, rationale } | { none: true } | null
  const [proposeError, setProposeError] = useState(null)
  const [applyState, setApplyState] = useState(null) // 'applying' | 'applied' | 'error' | null

  const handleTest = async () => {
    if (!testQuery.trim()) return
    setTesting(true)
    setTestResult(null)
    // A new question starts a fresh correction target — clear any stale proposal.
    setProposal(null)
    setProposeError(null)
    setApplyState(null)
    const sentQuery = testQuery
    try {
      const resp = await fetch('/collector/quoxchat/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: sentQuery, widget_id: widget?.id || 'demo', visitor_id: 'training_test', page_url: '/training' }),
      })
      const data = await resp.json().catch(() => ({}))
      // B7 audit fix: a non-2xx response used to fall straight through to
      // "No response" with no cause. Surface the HTTP status plus any error
      // text from the body instead.
      if (!resp.ok) {
        const detail = data.error || data.message || resp.statusText || 'unknown error'
        setTestResult({ text: `Test failed (HTTP ${resp.status}: ${detail})`, sources: [], confidence: 0, error: true })
        return
      }
      const responseText = data.response || 'No response'
      setTestResult({
        text: responseText,
        sources: data.sources || [],
        // QUOXCHAT-BRUTALOOP: confidence is the top retrieval score, not
        // answer length (output tokens / 100 made long answers look sure).
        confidence: typeof data.sources?.[0]?.score === 'number' ? data.sources[0].score : 0,
        model: data.model,
        tokens: data.tokens,
        duration: data.duration_ms,
        injectionScore: data.injection_score || 0,
      })
      // QCL-TEACH P1: keep a rolling window of turns for Teach Mode's proposal call.
      setTurns(t => [...t, { role: 'user', content: sentQuery }, { role: 'assistant', content: responseText }].slice(-TEACH_CONTEXT_TURNS))
      if (authFetch && orgId && widget?.id && !widget?.tested_at) {
        authFetch(`/api/orgs/${orgId}/widgets/${widget.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tested_at: new Date().toISOString() }),
        }).catch(() => {})
      }
    } catch (err) {
      setTestResult({ text: `Error: ${err.message}`, sources: [], confidence: 0, error: true })
    } finally {
      setTesting(false)
    }
  }

  // QCL-TEACH P1 — asks the widget's LLM to distill the test conversation
  // (which should include the admin's correction as the latest turn) into a
  // single proposed FAQ entry. Propose-only: never writes to the KB.
  const handlePropose = async () => {
    if (turns.length === 0) return
    // QCL-SECURITY P0-1: /teach/propose now requires the org-scoped,
    // authenticated route — a real widget context is required.
    if (!authFetch || !orgId || !widget?.id) {
      setProposeError('Open a specific widget room to propose a training update.')
      return
    }
    setProposing(true)
    setProposeError(null)
    setProposal(null)
    try {
      const resp = await authFetch(`/api/orgs/${orgId}/widgets/${widget.id}/teach/propose`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: turns }),
      })
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok || data.success === false) {
        throw new Error(data.error || `Propose failed (${resp.status})`)
      }
      setProposal(data.proposal || { none: true })
    } catch (err) {
      setProposeError(err.message)
    } finally {
      setProposing(false)
    }
  }

  // QCL-TEACH P1 — the admin has reviewed/edited the proposal; confirming
  // applies it via the existing correction ingest (QCL-LEARN P1), which
  // pins it into the KB as category 'correction' because provenance is
  // attached.
  const handleConfirmApply = async () => {
    if (!proposal || proposal.none) return
    // QCL-SECURITY P0-1: /knowledge/qa now requires the org-scoped,
    // authenticated route — a real widget context is required.
    if (!authFetch || !orgId || !widget?.id) {
      setApplyState('error')
      return
    }
    setApplyState('applying')
    try {
      const resp = await authFetch(`/api/orgs/${orgId}/widgets/${widget.id}/knowledge/qa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: proposal.question,
          answer: proposal.answer,
          source_conversation_id: 'teach:' + Date.now(),
          // QCL-SECURITY P0-3: corrected_by is now derived server-side from
          // the authenticated session — the auth proxy ignores this field,
          // it's dropped here to avoid implying it's honoured.
        }),
      })
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok || data.success === false) {
        throw new Error(data.error || `Apply failed (${resp.status})`)
      }
      setApplyState('applied')
    } catch (err) {
      setApplyState('error')
    }
  }

  const handleDiscardProposal = () => {
    setProposal(null)
    setProposeError(null)
    setApplyState(null)
  }

  const handleSave = async () => {
    if (!authFetch || !orgId || !widget?.id) return
    setSaving(true)
    setSaveMsg(null)
    try {
      const guardrails = {
        always: alwaysRules.split('\n').filter(Boolean),
        never: neverRules.split('\n').filter(Boolean),
      }
      // The widget row is what the live message path reads.
      const wResp = await authFetch(`/api/orgs/${orgId}/widgets/${widget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system_prompt_override: systemPrompt, guardrails }),
      })
      if (!wResp.ok) {
        const d = await wResp.json().catch(() => ({}))
        throw new Error(`Save failed (${wResp.status}${d.error ? `: ${d.error}` : ''}). Nothing was applied to the live widget.`)
      }
      try { const d = await wResp.clone().json(); if (d?.widget && onWidgetChange) onWidgetChange(d.widget) } catch {}
      // Keep the backing assistant persona in step (editor display copy).
      const assistantId = widget.assistant_id
      if (assistantId) {
        const aResp = await authFetch(`/api/orgs/${orgId}/assistants/${assistantId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            persona: {
              ...persona,
              system_prompt: systemPrompt,
              widget_config: { ...persona.widget_config, guardrails },
            },
          }),
        })
        if (!aResp.ok) throw new Error(`Widget saved, but the assistant copy failed (${aResp.status}).`)
      }
      setSaveMsg({ type: 'success', text: 'Training saved' })
    } catch (err) {
      setSaveMsg({ type: 'error', text: err.message })
    } finally {
      setSaving(false)
      setTimeout(() => setSaveMsg(null), 3000)
    }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16, minHeight: 400 }}>
      {/* Left: Prompt + Rules */}
      <div className="qx-flat-panel" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 8 }}>System prompt</div>
          <textarea
            value={systemPrompt}
            onChange={e => setSystemPrompt(e.target.value)}
            rows={8}
            placeholder="Define how your assistant behaves, what it knows, and how it responds..."
            style={{ width: '100%', padding: '10px 12px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: '#fff', fontSize: 13, fontFamily: "'JetBrains Mono', monospace", resize: 'vertical', boxSizing: 'border-box' }}
          />
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.65)', marginTop: 4 }}>
            ~{Math.ceil((systemPrompt.length || 0) / 4)} tokens.{' '}
            {systemPrompt.trim()
              ? 'This is the prompt the live widget runs (saved to the widget, with your guardrails appended).'
              : 'Empty: the widget runs the neutral default customer prompt. Anything you write here replaces it.'}
          </div>
        </div>

        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#30ff90', marginBottom: 4 }}>Always rules</div>
          <textarea
            value={alwaysRules}
            onChange={e => setAlwaysRules(e.target.value)}
            rows={3}
            placeholder="Cite sources when answering&#10;Offer human handoff for billing"
            style={{ width: '100%', padding: '8px 10px', background: 'rgba(0,0,0,0.15)', border: '1px solid rgba(48,255,144,0.15)', borderRadius: 6, color: '#fff', fontSize: 12, fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box' }}
          />
        </div>

        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#ef4444', marginBottom: 4 }}>Never rules</div>
          <textarea
            value={neverRules}
            onChange={e => setNeverRules(e.target.value)}
            rows={3}
            placeholder="Discuss competitor pricing&#10;Make promises about delivery dates"
            style={{ width: '100%', padding: '8px 10px', background: 'rgba(0,0,0,0.15)', border: '1px solid rgba(239,68,68,0.15)', borderRadius: 6, color: '#fff', fontSize: 12, fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box' }}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={handleSave} disabled={saving} style={{ padding: '8px 20px', fontSize: 12, fontWeight: 700, background: saving ? 'rgba(48,255,144,0.5)' : '#30ff90', border: 'none', borderRadius: 8, cursor: saving ? 'not-allowed' : 'pointer', color: '#000' }}>
            {saving ? 'Saving...' : 'Save training'}
          </button>
          {saveMsg && <span style={{ fontSize: 12, fontWeight: 600, color: saveMsg.type === 'success' ? '#30ff90' : '#ef4444' }}>{saveMsg.text}</span>}
        </div>
      </div>

      {/* Right: Test Chat */}
      <div className="qx-flat-panel" style={{ display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden', minHeight: 0 }}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>Test chat: source attribution</span>
          {/* QCL-TEACH P1 — Teach Mode toggle */}
          <label
            title="Teach mode: chat with the assistant, and when you correct it, it proposes a knowledge update you can confirm and apply."
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, fontWeight: 600, color: teachMode ? '#30ff90' : 'rgba(255,255,255,0.65)', cursor: 'pointer', userSelect: 'none' }}
          >
            <input
              type="checkbox"
              checked={teachMode}
              onChange={e => setTeachMode(e.target.checked)}
              aria-label="Teach mode"
              style={{ cursor: 'pointer' }}
            />
            Teach mode
          </label>
        </div>
        <div style={{ flex: 1, padding: 12, overflow: 'auto', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 8 }}>
          {testResult && (
            <>
              <div style={{ padding: '8px 12px', borderRadius: 12, background: 'rgba(0,0,0,0.15)', fontSize: 12, color: testResult.error ? '#ef4444' : '#fff', lineHeight: 1.5, alignSelf: 'flex-start', maxWidth: '95%' }}>
                {testResult.text.slice(0, 500)}{testResult.text.length > 500 ? '...' : ''}
              </div>
              {/* Sources with pinned/retrieved badges */}
              {testResult.sources.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {testResult.sources.map((s, i) => {
                    const attr = formatSourceAttribution(s)
                    return (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10 }}>
                        <span style={{ padding: '1px 5px', borderRadius: 3, background: `${attr.badgeColor}15`, color: attr.badgeColor, fontWeight: 700, fontSize: 9 }}>
                          {attr.badge}
                        </span>
                        <span style={{ color: 'rgba(255,255,255,0.65)' }}>{attr.label}</span>
                        <span style={{ color: 'rgba(255,255,255,0.65)', fontFamily: "'JetBrains Mono', monospace" }}>{attr.scoreDisplay}</span>
                      </div>
                    )
                  })}
                </div>
              )}
              {/* Confidence badge */}
              {testResult.confidence !== undefined && (() => {
                const badge = getConfidenceBadge(testResult.confidence)
                return (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: badge.color }}>
                    <span>{badge.icon}</span>
                    Confidence: {badge.label}
                    {testResult.model && <span style={{ color: 'rgba(255,255,255,0.65)', fontFamily: "'JetBrains Mono', monospace" }}> · {testResult.model} · {testResult.duration}ms</span>}
                  </div>
                )
              })()}
            </>
          )}

          {/* QCL-TEACH P1 — propose / review / confirm a knowledge update */}
          {teachMode && testResult && !testResult.error && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
              {!proposal && (
                <button
                  onClick={handlePropose}
                  disabled={proposing || turns.length === 0}
                  style={{ alignSelf: 'flex-start', padding: '5px 12px', fontSize: 10, fontWeight: 600, background: proposing ? 'rgba(48,255,144,0.05)' : 'rgba(48,255,144,0.1)', border: '1px solid rgba(48,255,144,0.25)', borderRadius: 6, cursor: proposing ? 'not-allowed' : 'pointer', color: '#30ff90', fontFamily: 'inherit' }}
                >
                  {proposing ? 'Proposing…' : 'Propose training update'}
                </button>
              )}

              {proposeError && (
                <div style={{ fontSize: 10, color: '#ef4444' }}>Propose failed: {proposeError}</div>
              )}

              {proposal && proposal.none && (
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.65)' }}>
                  No change needed.
                  <button onClick={handleDiscardProposal} style={{ marginLeft: 8, padding: '2px 8px', fontSize: 9, fontWeight: 600, background: 'transparent', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 4, cursor: 'pointer', color: 'rgba(255,255,255,0.6)', fontFamily: 'inherit' }}>
                    Dismiss
                  </button>
                </div>
              )}

              {proposal && !proposal.none && (
                <div style={{ padding: 10, borderRadius: 8, background: 'rgba(48,255,144,0.05)', border: '1px solid rgba(48,255,144,0.2)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ fontSize: 9, fontWeight: 600, color: 'rgba(255,255,255,0.65)' }}>Question</label>
                  <input
                    type="text"
                    value={proposal.question}
                    onChange={e => setProposal(p => ({ ...p, question: e.target.value }))}
                    style={{ padding: '4px 8px', fontSize: 11, background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 4, color: '#fff', fontFamily: 'inherit' }}
                  />
                  <label style={{ fontSize: 9, fontWeight: 600, color: 'rgba(255,255,255,0.65)' }}>Answer</label>
                  <textarea
                    value={proposal.answer}
                    onChange={e => setProposal(p => ({ ...p, answer: e.target.value }))}
                    rows={3}
                    style={{ padding: '6px 8px', fontSize: 11, background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 4, color: '#fff', fontFamily: 'inherit', resize: 'vertical' }}
                  />
                  {proposal.rationale && (
                    <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)', fontStyle: 'italic' }}>
                      Rationale: {proposal.rationale}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
                    {applyState === 'applied' && <span style={{ fontSize: 9, fontWeight: 600, color: '#30ff90' }}>✓ Applied</span>}
                    {applyState === 'error' && <span style={{ fontSize: 9, fontWeight: 600, color: '#ef4444' }}>✗ Apply failed</span>}
                    <button
                      onClick={handleDiscardProposal}
                      style={{ padding: '3px 10px', fontSize: 9, fontWeight: 600, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, cursor: 'pointer', color: 'rgba(255,255,255,0.75)', fontFamily: 'inherit' }}
                    >
                      Discard
                    </button>
                    <button
                      onClick={handleConfirmApply}
                      disabled={applyState === 'applying' || applyState === 'applied'}
                      style={{ padding: '3px 10px', fontSize: 9, fontWeight: 600, background: 'rgba(48,255,144,0.12)', border: '1px solid rgba(48,255,144,0.3)', borderRadius: 4, cursor: applyState === 'applying' ? 'not-allowed' : 'pointer', color: '#30ff90', fontFamily: 'inherit' }}
                    >
                      {applyState === 'applying' ? 'Applying…' : 'Confirm & apply'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        <div style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.04)', display: 'flex', gap: 6 }}>
          <input
            value={testQuery} onChange={e => setTestQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleTest()}
            placeholder="Test your widget..."
            style={{ flex: 1, padding: '7px 10px', background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 6, color: '#fff', fontSize: 11, fontFamily: 'inherit' }}
          />
          <button onClick={handleTest} disabled={testing} style={{ padding: '4px 12px', fontSize: 10, fontWeight: 600, background: testing ? 'rgba(168,85,247,0.05)' : 'rgba(168,85,247,0.1)', border: '1px solid rgba(168,85,247,0.2)', borderRadius: 6, cursor: testing ? 'not-allowed' : 'pointer', color: '#a855f7', fontFamily: 'inherit' }}>
            {testing ? '...' : 'Test'}
          </button>
        </div>
      </div>
    </div>
  )
}
