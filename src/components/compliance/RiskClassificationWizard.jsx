/**
 * RiskClassificationWizard — EU AI Act Risk Classification
 *
 * Guided decision tree with one question per screen, progress tree,
 * live classification badge, and structured decision path recording.
 *
 * AUD-UX Phase 2
 */

import { useState, useCallback, useMemo } from 'react'
import {
  GlassPanel,
  GlassPill,
  COLORS,
  M,
  F,
} from './glass-primitives'

const RISK_TIERS = {
  prohibited: { label: 'Prohibited', color: COLORS.red, severity: 4 },
  high_risk_annex_i: { label: 'High-Risk (Annex I)', color: '#ff6b35', severity: 3 },
  high_risk_annex_iii: { label: 'High-Risk (Annex III)', color: '#ff6b35', severity: 3 },
  gpai_systemic: { label: 'GPAI — Systemic Risk', color: COLORS.amber, severity: 3 },
  gpai_standard: { label: 'GPAI Model', color: COLORS.cyan, severity: 2 },
  limited_risk: { label: 'Limited Risk', color: COLORS.cyan, severity: 1 },
  minimal_risk: { label: 'Minimal Risk', color: COLORS.green, severity: 0 },
}

function ClassificationBadge({ result }) {
  if (!result || !result.tier) {
    return (
      <GlassPanel style={{ padding: 12, textAlign: 'center' }}>
        <div style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText, letterSpacing: 1 }}>CLASSIFICATION</div>
        <div style={{ fontFamily: M, fontSize: 14, color: COLORS.amber, fontWeight: 700, marginTop: 4 }}>Pending</div>
        <div style={{ fontFamily: F, fontSize: 10, color: COLORS.subtleText, marginTop: 2 }}>
          {result?.path?.length || 0} questions answered
        </div>
      </GlassPanel>
    )
  }

  const tier = RISK_TIERS[result.tier.id] || { label: result.tier.label, color: COLORS.white }

  return (
    <GlassPanel highlight={tier.color} style={{ padding: 12, textAlign: 'center' }}>
      <div style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText, letterSpacing: 1 }}>CLASSIFICATION</div>
      <div style={{ fontFamily: M, fontSize: 14, color: tier.color, fontWeight: 700, marginTop: 4 }}>{tier.label}</div>
      <div style={{ fontFamily: F, fontSize: 10, color: COLORS.subtleText, marginTop: 2 }}>
        {result.tier.articles?.join(', ')}
      </div>
    </GlassPanel>
  )
}

function ProgressTree({ questions, answers, currentQuestionId }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText, letterSpacing: 1, marginBottom: 6 }}>PROGRESS</div>
      {questions.map(q => {
        const answered = answers[q.id] !== undefined
        const isCurrent = q.id === currentQuestionId
        const option = answered ? q.options?.find(o => o.id === answers[q.id]) : null

        return (
          <div key={q.id} style={{
            padding: '6px 10px', borderRadius: 6,
            background: isCurrent ? 'rgba(168,85,247,0.1)' : 'transparent',
            borderLeft: isCurrent ? `3px solid ${COLORS.purple}` : answered ? `3px solid ${COLORS.green}40` : '3px solid rgba(255,255,255,0.05)',
            opacity: answered || isCurrent ? 1 : 0.4,
          }}>
            <div style={{ fontFamily: M, fontSize: 9, color: isCurrent ? '#fff' : COLORS.subtleText }}>
              {answered ? '✓' : isCurrent ? '→' : '○'} {q.id.replace('q_', '').replace(/_/g, ' ')}
            </div>
            {answered && option && (
              <div style={{ fontFamily: F, fontSize: 8, color: COLORS.cyan, marginTop: 1 }}>
                {option.label.slice(0, 35)}{option.label.length > 35 ? '...' : ''}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default function RiskClassificationWizard({
  questions = [],
  onClassify,
  onSave,
  initialAnswers = {},
  systemName = '',
  readOnly = false,
}) {
  const [answers, setAnswers] = useState(initialAnswers)
  const [currentQuestionId, setCurrentQuestionId] = useState(null)
  const [showHelp, setShowHelp] = useState(false)
  const [sysName, setSysName] = useState(systemName)

  const questionMap = useMemo(() => {
    const m = {}
    for (const q of questions) m[q.id] = q
    return m
  }, [questions])

  const questionOrder = useMemo(() => {
    const order = []
    let id = questions[0]?.id
    const visited = new Set()
    while (id && !visited.has(id)) {
      visited.add(id)
      const q = questionMap[id]
      if (!q) break
      order.push(id)
      const answer = answers[id]
      if (answer === undefined) break
      const nextId = q.next?.(answer)
      id = nextId
    }
    return order
  }, [questions, answers, questionMap])

  const result = useMemo(() => {
    if (!onClassify) return null
    return onClassify(answers)
  }, [answers, onClassify])

  const activeQuestionId = currentQuestionId || questionOrder[questionOrder.length - 1] || questions[0]?.id
  const activeQuestion = questionMap[activeQuestionId]
  const isComplete = result?.complete

  const handleAnswer = useCallback((questionId, optionId) => {
    if (readOnly) return
    const newAnswers = { ...answers, [questionId]: optionId }

    const validIds = new Set([questionId])
    const q = questionMap[questionId]
    if (q) {
      let nextId = q.next?.(optionId)
      const visited = new Set()
      while (nextId && !visited.has(nextId)) {
        visited.add(nextId)
        validIds.add(nextId)
        const nq = questionMap[nextId]
        if (!nq) break
        if (newAnswers[nextId] === undefined) break
        nextId = nq.next?.(newAnswers[nextId])
      }
    }

    for (const key of Object.keys(newAnswers)) {
      if (key === questionId) continue
      const qIdx = questions.findIndex(qq => qq.id === key)
      const currentIdx = questions.findIndex(qq => qq.id === questionId)
      if (qIdx > currentIdx && !validIds.has(key)) {
        delete newAnswers[key]
      }
    }

    setAnswers(newAnswers)
    setCurrentQuestionId(null)
    onSave?.(newAnswers, sysName)
  }, [answers, questionMap, questions, readOnly, onSave, sysName])

  const handleBack = useCallback(() => {
    const idx = questionOrder.indexOf(activeQuestionId)
    if (idx > 0) setCurrentQuestionId(questionOrder[idx - 1])
  }, [questionOrder, activeQuestionId])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* System name input */}
      {!readOnly && (
        <GlassPanel style={{ padding: '10px 14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontFamily: M, fontSize: 10, color: COLORS.subtleText }}>AI System:</span>
            <input
              value={sysName}
              onChange={e => setSysName(e.target.value)}
              placeholder="Name of the AI system being classified..."
              style={{
                flex: 1, fontFamily: F, fontSize: 11, color: '#fff',
                background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 5, padding: '5px 10px', outline: 'none',
              }}
            />
          </div>
        </GlassPanel>
      )}

      {/* Main layout: progress tree + question + badge */}
      <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr 200px', gap: 10, minHeight: 400 }}>
        {/* Left: progress tree */}
        <GlassPanel style={{ padding: 12 }}>
          <ProgressTree
            questions={questions}
            answers={answers}
            currentQuestionId={activeQuestionId}
          />
        </GlassPanel>

        {/* Center: question */}
        <GlassPanel style={{ padding: 24, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          {isComplete ? (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>✓</div>
              <div style={{ fontFamily: M, fontSize: 16, color: '#fff', fontWeight: 700 }}>Classification Complete</div>
              <div style={{ fontFamily: F, fontSize: 12, color: COLORS.subtleText, marginTop: 8 }}>
                {result?.tier?.label} — {result?.tier?.articles?.join(', ')}
              </div>
              <div style={{ fontFamily: F, fontSize: 11, color: COLORS.subtleText, marginTop: 4 }}>
                {result?.path?.length} questions answered
              </div>
            </div>
          ) : activeQuestion ? (
            <>
              <div style={{ fontFamily: F, fontSize: 15, color: '#fff', fontWeight: 600, lineHeight: 1.5, marginBottom: 16 }}>
                {activeQuestion.text}
              </div>

              {activeQuestion.help && (
                <div style={{ marginBottom: 16 }}>
                  <button
                    onClick={() => setShowHelp(!showHelp)}
                    style={{
                      fontFamily: M, fontSize: 9, color: COLORS.cyan, background: 'none',
                      border: 'none', cursor: 'pointer', padding: 0,
                    }}
                  >
                    {showHelp ? '▼' : '▶'} Why does this matter?
                  </button>
                  {showHelp && (
                    <div style={{
                      fontFamily: F, fontSize: 11, color: COLORS.subtleText, lineHeight: 1.5,
                      marginTop: 6, padding: '8px 12px', borderRadius: 6,
                      background: 'rgba(56,189,248,0.04)', border: '1px solid rgba(56,189,248,0.08)',
                    }}>
                      {activeQuestion.help}
                    </div>
                  )}
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {activeQuestion.options?.map(opt => {
                  const selected = answers[activeQuestionId] === opt.id
                  return (
                    <button
                      key={opt.id}
                      onClick={() => handleAnswer(activeQuestionId, opt.id)}
                      disabled={readOnly}
                      style={{
                        padding: '12px 16px', borderRadius: 8, textAlign: 'left',
                        fontFamily: F, fontSize: 12, color: '#fff',
                        background: selected ? 'rgba(168,85,247,0.12)' : 'rgba(255,255,255,0.02)',
                        border: selected ? `1px solid ${COLORS.purple}40` : '1px solid rgba(255,255,255,0.06)',
                        cursor: readOnly ? 'default' : 'pointer',
                        transition: 'all 0.15s',
                      }}
                    >
                      {opt.label}
                    </button>
                  )
                })}
              </div>

              {/* Navigation */}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 20 }}>
                <button
                  onClick={handleBack}
                  disabled={questionOrder.indexOf(activeQuestionId) <= 0}
                  style={{
                    fontFamily: M, fontSize: 10, color: COLORS.subtleText,
                    background: 'none', border: 'none', cursor: 'pointer',
                    opacity: questionOrder.indexOf(activeQuestionId) <= 0 ? 0.3 : 1,
                  }}
                >
                  ← Back
                </button>
                <span style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText }}>
                  {activeQuestion.rule_ref}
                </span>
              </div>
            </>
          ) : (
            <div style={{ textAlign: 'center', color: COLORS.subtleText }}>No questions available</div>
          )}
        </GlassPanel>

        {/* Right: classification badge */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <ClassificationBadge result={result} />
        </div>
      </div>
    </div>
  )
}
