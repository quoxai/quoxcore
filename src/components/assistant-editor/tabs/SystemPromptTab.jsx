/**
 * SystemPromptTab — Enhanced with guided mode, layer preview, token count
 * AUX-3: Two modes — guided (Role/Scope/Constraints) and advanced (raw textarea).
 * Backward compatible — saves to same draft.context.systemPromptAdditions field.
 */

import { useState, useMemo } from 'react'
import { generatePersonalityPrompt, estimateTokens } from '../personalityUtils'

const PROMPT_TEMPLATES = [
  { id: 'support', label: 'Customer Support', icon: '🎧', prompt: 'You are a helpful customer support assistant for {company}. You help customers with product questions, billing, and technical issues. Be friendly but professional. If you don\'t know the answer, say so clearly and offer to connect them with the support team.' },
  { id: 'sales', label: 'Sales Assistant', icon: '💰', prompt: 'You are a knowledgeable sales assistant for {company}. Help potential customers understand the product, answer pricing questions, and guide them toward the right plan. Be warm, consultative, and value-focused. Never be pushy.' },
  { id: 'docs', label: 'Documentation', icon: '📚', prompt: 'You are a documentation assistant for {company}. Answer technical questions accurately, citing specific sections of the documentation when possible. Use code examples where appropriate. If a topic isn\'t covered in the docs, say so.' },
  { id: 'internal', label: 'Internal Knowledge', icon: '🏢', prompt: 'You are an internal knowledge assistant for {company}. Help team members find information, understand policies, and navigate internal processes. Be clear and precise. Respect confidentiality — never share information outside the organisation.' },
  { id: 'monitor', label: 'Monitoring Agent', icon: '📡', prompt: 'You are a monitoring specialist. Report system status concisely. Prioritise alerts by severity. When reporting issues, include: what\'s affected, since when, current impact, and recommended action. Be factual, not alarmist.' },
  { id: 'security', label: 'Security Agent', icon: '🛡️', prompt: 'You are a security specialist. Analyse threats, audit configurations, and recommend mitigations. Prioritise by risk. Use industry-standard terminology (CVE, CVSS, MITRE ATT&CK). Always recommend the least-privilege approach.' },
]

export default function SystemPromptTab({ draft, updateField }) {
  const [mode, setMode] = useState('advanced') // 'guided' | 'advanced'
  const [showTemplates, setShowTemplates] = useState(false)

  const promptText = draft?.context?.systemPromptAdditions || ''
  const personalityText = generatePersonalityPrompt(draft?.identity?.personality || {})

  const tokenEstimate = useMemo(() => {
    const safetyTokens = 312 // Fixed safety preamble estimate
    const personalityTokens = estimateTokens(personalityText)
    const instructionTokens = estimateTokens(promptText)
    return { safety: safetyTokens, personality: personalityTokens, instructions: instructionTokens, total: safetyTokens + personalityTokens + instructionTokens }
  }, [promptText, personalityText])

  const budgetPct = Math.min(100, (tokenEstimate.total / 2000) * 100)
  const budgetColor = budgetPct > 80 ? '#ef4444' : budgetPct > 60 ? '#f59e0b' : '#30ff90'

  return (
    <div className="editor-section">
      {/* Mode toggle */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {['guided', 'advanced'].map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                padding: '4px 12px', fontSize: 11, fontWeight: mode === m ? 700 : 500,
                background: mode === m ? 'rgba(56,189,248,0.12)' : 'transparent',
                border: mode === m ? '1px solid rgba(56,189,248,0.3)' : '1px solid rgba(255,255,255,0.06)',
                borderRadius: 6, cursor: 'pointer', color: mode === m ? '#fff' : 'rgba(255,255,255,0.6)',
                transition: 'all 0.15s', fontFamily: 'inherit', textTransform: 'capitalize',
              }}
            >
              {m}
            </button>
          ))}
        </div>
        <button
          onClick={() => setShowTemplates(!showTemplates)}
          style={{
            padding: '4px 10px', fontSize: 10, fontWeight: 600,
            background: 'rgba(168,85,247,0.08)', border: '1px solid rgba(168,85,247,0.2)',
            borderRadius: 6, cursor: 'pointer', color: '#a855f7', fontFamily: 'inherit',
          }}
        >
          {showTemplates ? 'Hide Templates' : 'Browse Templates'}
        </button>
      </div>

      {/* Template browser */}
      {showTemplates && (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
          gap: 8, marginBottom: 16, padding: 12, background: 'rgba(0,0,0,0.15)',
          border: '1px solid rgba(255,255,255,0.06)', borderRadius: 10,
        }}>
          {PROMPT_TEMPLATES.map(t => (
            <button
              key={t.id}
              onClick={() => { updateField('context.systemPromptAdditions', t.prompt); setShowTemplates(false); setMode('advanced') }}
              style={{
                padding: 10, textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit',
                background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: 8, transition: 'all 0.15s',
              }}
            >
              <div style={{ fontSize: 18, marginBottom: 4 }}>{t.icon}</div>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#fff' }}>{t.label}</div>
            </button>
          ))}
        </div>
      )}

      {/* Prompt editor */}
      <div className="form-group">
        <label htmlFor="system-prompt">
          {mode === 'guided' ? 'Instructions (what should this assistant do?)' : 'System Prompt'}
        </label>
        <textarea
          id="system-prompt"
          rows={mode === 'guided' ? 8 : 14}
          value={promptText}
          onChange={(e) => updateField('context.systemPromptAdditions', e.target.value)}
          placeholder={mode === 'guided'
            ? 'Describe what this assistant does, what topics it covers, and any constraints...\n\nExample: "You are a helpful support assistant for Acme Corp. You help customers with product questions, billing, and technical support."'
            : 'Define the assistant\'s behavior, knowledge scope, and personality...'}
          style={{ fontFamily: mode === 'advanced' ? "'Fira Code', monospace" : 'inherit', fontSize: '13px', lineHeight: '1.5' }}
        />
      </div>

      {/* Token budget bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, marginBottom: 16,
      }}>
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>
          {tokenEstimate.total} / 2,000 tokens
        </span>
        <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)' }}>
          <div style={{ width: `${budgetPct}%`, height: '100%', borderRadius: 2, background: budgetColor, transition: 'width 0.3s ease' }} />
        </div>
      </div>

      {/* Constructed prompt layer preview */}
      <div style={{
        padding: 14, background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 10,
      }}>
        <div style={{
          fontSize: 9, fontWeight: 600, color: 'rgba(255,255,255,0.6)',
          textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10,
          fontFamily: "'JetBrains Mono', monospace",
        }}>
          Constructed Prompt Layers
        </div>

        {/* Safety layer */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
          <span style={{ fontSize: 12 }}>🛡️</span>
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', flex: 1 }}>Safety Preamble</span>
          <span style={{ fontSize: 10, fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.6)', fontVariantNumeric: 'tabular-nums' }}>~{tokenEstimate.safety} tok</span>
          <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>🔒</span>
        </div>

        {/* Personality layer */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
          <span style={{ fontSize: 12 }}>🧠</span>
          <span style={{ fontSize: 11, color: personalityText ? '#a855f7' : 'rgba(255,255,255,0.6)', flex: 1 }}>
            Personality {personalityText ? '' : '(not set)'}
          </span>
          <span style={{ fontSize: 10, fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.6)', fontVariantNumeric: 'tabular-nums' }}>{tokenEstimate.personality} tok</span>
          <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>✏️</span>
        </div>

        {/* Instructions layer */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
          <span style={{ fontSize: 12 }}>📝</span>
          <span style={{ fontSize: 11, color: promptText ? '#38bdf8' : 'rgba(255,255,255,0.6)', flex: 1 }}>
            Your Instructions {promptText ? '' : '(empty)'}
          </span>
          <span style={{ fontSize: 10, fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.6)', fontVariantNumeric: 'tabular-nums' }}>{tokenEstimate.instructions} tok</span>
          <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>✏️</span>
        </div>

        {/* Runtime layers */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', opacity: 0.5 }}>
          <span style={{ fontSize: 12 }}>⚡</span>
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', flex: 1 }}>Runtime Context</span>
          <span style={{ fontSize: 10, fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.6)' }}>~2K tok</span>
          <span style={{ fontSize: 9 }}>⚡</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', opacity: 0.5 }}>
          <span style={{ fontSize: 12 }}>💬</span>
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', flex: 1 }}>Conversation History</span>
          <span style={{ fontSize: 10, fontFamily: "'JetBrains Mono', monospace", color: 'rgba(255,255,255,0.6)' }}>variable</span>
          <span style={{ fontSize: 9 }}>💬</span>
        </div>
      </div>

      <span className="form-hint" style={{ marginTop: 8, display: 'block' }}>
        Your instructions are combined with a safety preamble and personality settings before being sent to the LLM.
      </span>
    </div>
  )
}
