/**
 * DPIAForm — GDPR Article 35 Data Protection Impact Assessment
 *
 * Sectioned long-form with sticky section nav, completion indicators,
 * interactive risk matrix, lifecycle controls, and debounced auto-save.
 *
 * AUD-UX Phase 3
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  GlassPanel,
  GlassPill,
  SectionHeader,
  ProgressRing,
  COLORS,
  M,
  F,
} from './glass-primitives'

const SECTIONS = [
  { id: 'description', label: '1. Processing Description', icon: '◈' },
  { id: 'necessity', label: '2. Necessity & Proportionality', icon: '⬡' },
  { id: 'risks', label: '3. Risk Assessment', icon: '▣' },
  { id: 'measures', label: '4. Mitigation Measures', icon: '◉' },
  { id: 'consultation', label: '5. Consultation', icon: '★' },
  { id: 'outcome', label: '6. Outcome & Decision', icon: '◆' },
]

const LEGAL_BASES = [
  { id: 'consent', label: 'Consent (Art.6(1)(a))' },
  { id: 'contract', label: 'Performance of a contract (Art.6(1)(b))' },
  { id: 'legal_obligation', label: 'Legal obligation (Art.6(1)(c))' },
  { id: 'vital_interests', label: 'Vital interests (Art.6(1)(d))' },
  { id: 'public_interest', label: 'Public interest (Art.6(1)(e))' },
  { id: 'legitimate_interest', label: 'Legitimate interest (Art.6(1)(f))' },
]

function sectionComplete(completeness, sectionId) {
  const s = completeness?.[sectionId]
  if (!s) return false
  return s.complete >= s.total
}

function RiskMatrix({ risks = [], onRiskClick }) {
  const grid = Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => []))
  for (const r of risks) {
    if (r.likelihood >= 1 && r.likelihood <= 5 && r.severity >= 1 && r.severity <= 5) {
      grid[5 - r.severity][r.likelihood - 1].push(r)
    }
  }

  return (
    <div style={{ display: 'inline-block' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
        <span style={{ fontFamily: M, fontSize: 8, color: COLORS.subtleText, writingMode: 'vertical-rl', transform: 'rotate(180deg)', letterSpacing: 1 }}>SEVERITY</span>
        <div>
          {grid.map((row, si) => (
            <div key={si} style={{ display: 'flex', gap: 2 }}>
              {row.map((cell, li) => {
                const score = (li + 1) * (5 - si)
                const bg = score >= 16 ? 'rgba(239,68,68,0.2)' : score >= 9 ? 'rgba(249,115,22,0.15)' : score >= 4 ? 'rgba(245,158,11,0.1)' : 'rgba(48,255,144,0.05)'
                return (
                  <div
                    key={li}
                    onClick={() => cell.length > 0 && onRiskClick?.(cell[0])}
                    style={{
                      width: 36, height: 36, borderRadius: 4,
                      background: bg, border: '1px solid rgba(255,255,255,0.04)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      cursor: cell.length > 0 ? 'pointer' : 'default',
                      fontSize: 10, fontFamily: M, color: '#fff',
                    }}
                    title={cell.map(r => r.name).join(', ') || `L${li + 1} × S${5 - si} = ${score}`}
                  >
                    {cell.length > 0 ? `${cell.length}` : ''}
                  </div>
                )
              })}
            </div>
          ))}
          <div style={{ fontFamily: M, fontSize: 8, color: COLORS.subtleText, textAlign: 'center', marginTop: 4, letterSpacing: 1 }}>
            LIKELIHOOD
          </div>
        </div>
      </div>
    </div>
  )
}

function TextArea({ value, onChange, placeholder, rows = 3, readOnly }) {
  return (
    <textarea
      value={value || ''}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      readOnly={readOnly}
      style={{
        width: '100%', fontFamily: F, fontSize: 11, color: '#fff',
        background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 6, padding: '8px 10px', outline: 'none', resize: 'vertical',
        opacity: readOnly ? 0.6 : 1,
      }}
    />
  )
}

function FieldLabel({ children }) {
  return (
    <div style={{ fontFamily: M, fontSize: 9, color: COLORS.subtleText, letterSpacing: 0.5, marginBottom: 4, marginTop: 10 }}>
      {children}
    </div>
  )
}

export default function DPIAForm({
  dpia,
  completeness,
  onUpdate,
  onStatusChange,
  onAddRisk,
  onUpdateRisk,
  onAddMeasure,
  readOnly = false,
}) {
  const [activeSection, setActiveSection] = useState('description')
  const saveTimer = useRef(null)

  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current) }, [])

  const debouncedSave = useCallback((field, value) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      onUpdate?.(field, value)
    }, 1000)
  }, [onUpdate])

  const updateField = useCallback((section, field, value) => {
    if (readOnly) return
    debouncedSave(`sections.${section}.${field}`, value)
  }, [readOnly, debouncedSave])

  const s = dpia?.sections || {}
  const desc = s.description || {}
  const nec = s.necessity || {}
  const risks = s.risks || []
  const measures = s.measures || []
  const cons = s.consultation || {}
  const outcome = s.outcome || {}

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Header with status */}
      <GlassPanel>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontFamily: M, fontSize: 14, color: '#fff', fontWeight: 700 }}>
              {dpia?.processing_name || 'New DPIA'}
            </div>
            <div style={{ fontFamily: F, fontSize: 10, color: COLORS.subtleText, marginTop: 2 }}>
              GDPR Article 35 — Data Protection Impact Assessment
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <GlassPill color={
              dpia?.status === 'approved' ? COLORS.green
                : dpia?.status === 'dpo_review' ? COLORS.cyan
                  : dpia?.status === 'prior_consultation_required' ? COLORS.amber
                    : COLORS.subtleText
            }>
              {(dpia?.status || 'draft').replace(/_/g, ' ').toUpperCase()}
            </GlassPill>
            {!readOnly && dpia?.status === 'draft' && (
              <GlassPill color={COLORS.cyan} style={{ cursor: 'pointer' }}
                onClick={() => onStatusChange?.('dpo_review')}>
                Submit for DPO Review
              </GlassPill>
            )}
          </div>
        </div>
      </GlassPanel>

      {/* Section nav */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {SECTIONS.map(sec => {
          const isComplete = sectionComplete(completeness, sec.id)
          const active = activeSection === sec.id
          return (
            <button
              key={sec.id}
              onClick={() => setActiveSection(sec.id)}
              style={{
                padding: '6px 12px', borderRadius: 6, border: 'none',
                fontFamily: M, fontSize: 9, fontWeight: active ? 700 : 500,
                color: active ? '#fff' : COLORS.subtleText,
                background: active ? 'rgba(168,85,247,0.12)' : 'rgba(255,255,255,0.02)',
                cursor: 'pointer',
              }}
            >
              {isComplete ? '✓' : sec.icon} {sec.label}
            </button>
          )
        })}
      </div>

      {/* Section content */}
      {activeSection === 'description' && (
        <GlassPanel>
          <SectionHeader title="Processing Description" subtitle="Describe the processing activity and its scope" />
          <FieldLabel>Controller Name</FieldLabel>
          <TextArea value={desc.controller_name} onChange={v => updateField('description', 'controller_name', v)} placeholder="Organisation name..." rows={1} readOnly={readOnly} />
          <FieldLabel>Processing Purpose</FieldLabel>
          <TextArea value={desc.processing_purpose} onChange={v => updateField('description', 'processing_purpose', v)} placeholder="What is the purpose of this processing activity?" readOnly={readOnly} />
          <FieldLabel>Legal Basis</FieldLabel>
          <select
            value={desc.legal_basis || ''}
            onChange={e => updateField('description', 'legal_basis', e.target.value || null)}
            disabled={readOnly}
            style={{
              width: '100%', fontFamily: M, fontSize: 10, color: '#fff',
              background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 6, padding: '8px 10px', outline: 'none',
            }}
          >
            <option value="">Select legal basis...</option>
            {LEGAL_BASES.map(b => <option key={b.id} value={b.id}>{b.label}</option>)}
          </select>
          <FieldLabel>Retention Period</FieldLabel>
          <TextArea value={desc.retention_period} onChange={v => updateField('description', 'retention_period', v)} placeholder="How long will data be retained?" rows={1} readOnly={readOnly} />
        </GlassPanel>
      )}

      {activeSection === 'necessity' && (
        <GlassPanel>
          <SectionHeader title="Necessity & Proportionality" subtitle="Assess whether the processing is necessary and proportionate" />
          <FieldLabel>Purpose Limitation</FieldLabel>
          <TextArea value={nec.purpose_limitation} onChange={v => updateField('necessity', 'purpose_limitation', v)} placeholder="How is the processing limited to its stated purpose?" readOnly={readOnly} />
          <FieldLabel>Data Minimisation</FieldLabel>
          <TextArea value={nec.data_minimisation} onChange={v => updateField('necessity', 'data_minimisation', v)} placeholder="What measures ensure only necessary data is processed?" readOnly={readOnly} />
          <FieldLabel>Proportionality Assessment</FieldLabel>
          <TextArea value={nec.proportionality_assessment} onChange={v => updateField('necessity', 'proportionality_assessment', v)} placeholder="Is the processing proportionate to the purpose? What alternatives were considered?" rows={4} readOnly={readOnly} />
        </GlassPanel>
      )}

      {activeSection === 'risks' && (
        <GlassPanel>
          <SectionHeader title="Risk Assessment" subtitle="Identify and score risks to data subjects" action={
            !readOnly && <GlassPill color={COLORS.cyan} style={{ cursor: 'pointer' }} onClick={onAddRisk}>+ Add Risk</GlassPill>
          } />
          <RiskMatrix risks={risks} />
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {risks.length === 0 && (
              <div style={{ fontFamily: F, fontSize: 11, color: COLORS.subtleText, textAlign: 'center', padding: 20 }}>
                No risks identified yet. Click "+ Add Risk" to begin the risk assessment.
              </div>
            )}
            {risks.map((risk, i) => {
              const score = risk.likelihood * risk.severity
              const level = score >= 16 ? COLORS.red : score >= 9 ? '#f97316' : score >= 4 ? COLORS.amber : COLORS.green
              return (
                <GlassPanel key={risk.id} style={{ padding: '10px 12px', borderLeft: `3px solid ${level}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ fontFamily: M, fontSize: 11, color: '#fff', fontWeight: 600, flex: 1 }}>
                      {risk.name || `Risk ${i + 1}`}
                    </span>
                    <GlassPill color={level}>L:{risk.likelihood} S:{risk.severity} = {score}</GlassPill>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <div>
                      <FieldLabel>Likelihood (1-5)</FieldLabel>
                      <input type="range" min={0} max={5} value={risk.likelihood}
                        onChange={e => onUpdateRisk?.(risk.id, 'likelihood', parseInt(e.target.value))}
                        style={{ width: '100%' }} disabled={readOnly} />
                    </div>
                    <div>
                      <FieldLabel>Severity (1-5)</FieldLabel>
                      <input type="range" min={0} max={5} value={risk.severity}
                        onChange={e => onUpdateRisk?.(risk.id, 'severity', parseInt(e.target.value))}
                        style={{ width: '100%' }} disabled={readOnly} />
                    </div>
                  </div>
                </GlassPanel>
              )
            })}
          </div>
        </GlassPanel>
      )}

      {activeSection === 'measures' && (
        <GlassPanel>
          <SectionHeader title="Mitigation Measures" subtitle="Define measures to address identified risks" action={
            !readOnly && <GlassPill color={COLORS.cyan} style={{ cursor: 'pointer' }} onClick={onAddMeasure}>+ Add Measure</GlassPill>
          } />
          {measures.length === 0 && (
            <div style={{ fontFamily: F, fontSize: 11, color: COLORS.subtleText, textAlign: 'center', padding: 20 }}>
              No measures defined yet. Add measures to mitigate identified risks.
            </div>
          )}
          {measures.map((m, i) => {
            const linkedRisk = risks.find(r => r.id === m.risk_id)
            return (
              <GlassPanel key={m.id} style={{ padding: '10px 12px', marginTop: 6 }}>
                <div style={{ fontFamily: M, fontSize: 10, color: '#fff' }}>
                  {m.description || `Measure ${i + 1}`}
                </div>
                {linkedRisk && (
                  <div style={{ fontFamily: F, fontSize: 9, color: COLORS.subtleText, marginTop: 2 }}>
                    Mitigates: {linkedRisk.name}
                  </div>
                )}
                <GlassPill color={m.status === 'implemented' ? COLORS.green : COLORS.amber} style={{ marginTop: 4 }}>
                  {m.status}
                </GlassPill>
              </GlassPanel>
            )
          })}
        </GlassPanel>
      )}

      {activeSection === 'consultation' && (
        <GlassPanel>
          <SectionHeader title="Consultation" subtitle="Record DPO and data subject consultations" />
          <FieldLabel>DPO Consulted</FieldLabel>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: readOnly ? 'default' : 'pointer' }}>
            <input type="checkbox" checked={cons.dpo_consulted || false}
              onChange={e => updateField('consultation', 'dpo_consulted', e.target.checked)}
              disabled={readOnly} />
            <span style={{ fontFamily: F, fontSize: 11, color: '#fff' }}>DPO has been consulted on this DPIA</span>
          </label>
          {cons.dpo_consulted && (
            <>
              <FieldLabel>DPO Opinion</FieldLabel>
              <TextArea value={cons.dpo_opinion} onChange={v => updateField('consultation', 'dpo_opinion', v)} placeholder="DPO's opinion on the processing and risks..." readOnly={readOnly} />
            </>
          )}
          <FieldLabel>Data Subjects Consulted</FieldLabel>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: readOnly ? 'default' : 'pointer' }}>
            <input type="checkbox" checked={cons.data_subjects_consulted || false}
              onChange={e => updateField('consultation', 'data_subjects_consulted', e.target.checked)}
              disabled={readOnly} />
            <span style={{ fontFamily: F, fontSize: 11, color: '#fff' }}>Data subjects or their representatives have been consulted</span>
          </label>
        </GlassPanel>
      )}

      {activeSection === 'outcome' && (
        <GlassPanel>
          <SectionHeader title="Outcome & Decision" subtitle="Record the overall assessment outcome" />
          <FieldLabel>Overall Risk Level</FieldLabel>
          <select
            value={outcome.overall_risk_level || ''}
            onChange={e => updateField('outcome', 'overall_risk_level', e.target.value || null)}
            disabled={readOnly}
            style={{
              width: '100%', fontFamily: M, fontSize: 10, color: '#fff',
              background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 6, padding: '8px 10px', outline: 'none',
            }}
          >
            <option value="">Select risk level...</option>
            <option value="low">Low — processing can proceed</option>
            <option value="medium">Medium — processing can proceed with measures</option>
            <option value="high">High — additional measures required before proceeding</option>
            <option value="critical">Critical — prior consultation with supervisory authority required</option>
          </select>
          <FieldLabel>Decision</FieldLabel>
          <select
            value={outcome.decision || ''}
            onChange={e => updateField('outcome', 'decision', e.target.value || null)}
            disabled={readOnly}
            style={{
              width: '100%', fontFamily: M, fontSize: 10, color: '#fff',
              background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 6, padding: '8px 10px', outline: 'none',
            }}
          >
            <option value="">Select decision...</option>
            <option value="proceed">Proceed — risks adequately mitigated</option>
            <option value="proceed_with_conditions">Proceed with conditions — additional measures required</option>
            <option value="do_not_proceed">Do not proceed — risks too high</option>
            <option value="prior_consultation">Refer for prior consultation with supervisory authority</option>
          </select>
        </GlassPanel>
      )}
    </div>
  )
}
