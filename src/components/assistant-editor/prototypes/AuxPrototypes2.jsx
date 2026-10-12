/**
 * AUX Stream — Prototype Components (Part 2)
 *
 * Additional glass-styled prototypes for the unified assistant configuration platform.
 * Continues from AuxPrototypes.jsx.
 *
 * Components:
 *   11. EditorShell �� The full split-canvas layout (rail + config + live preview)
 *   12. IdentityTab — Name, shortName, colour picker, avatar, description
 *   13. VoiceTab — Voice picker with categories, preview, verbosity mode
 *   14. RulesTab — Always/never rules editor with add/remove
 *   15. SafetyTab — DEFCON selector, approval requirements
 *   16. DelegationTab — Delegation targets, hierarchy visualisation
 *   17. ToolParameterBuilder — Visual schema editor for tool parameters
 *   18. ToolBrowser — Browse + assign tools from registry
 *   19. LiveChatPreview — Right-side preview with "what changed?" annotations
 *   20. AssistantsHubView — 5-tab listing page (All/Agents/Assistants/Teams/ChatBots)
 *   21. TemplateSelector — Browse + select prompt/persona templates
 *   22. BudgetManager — Monthly limit, fallback action, alert thresholds
 *   23. KnowledgeSourceCard — Knowledge source display (file/url/qa)
 *   24. ConnectionTester — Multi-state test button (idle → testing → pass/fail)
 *   25. AgentAvatar — Standalone avatar with DEFCON pulse animation
 *   26. WhatChangedBanner — "Config updated" annotation banner
 *   27. ArchitectChatMessage — ARCHITECT agent chat message with action blocks
 *   28. CompletionChecklist — Readiness checklist before publishing
 *
 * @see AuxPrototypes.jsx for Part 1 (components 1-10)
 */

import { useState, useEffect, useRef } from 'react'

// ─── Shared Glass Primitives (duplicated for standalone use) ─────────��──────

const GL = {
  panel: {
    backdropFilter: 'var(--glass-blur-strong)', WebkitBackdropFilter: 'var(--glass-blur-strong)',
    background: 'linear-gradient(145deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0.005) 100%)',
    borderTop: '1px solid rgba(255,255,255,0.40)', borderLeft: '1px solid rgba(255,255,255,0.31)',
    borderRight: '1px solid transparent', borderBottom: '1px solid transparent',
    boxShadow: '0 5px 19px rgba(0,0,0,0.35), 0 2px 4px rgba(0,0,0,0.2), inset 0 1px 2px rgba(255,255,255,0.08)',
    borderRadius: 16,
  },
  card: {
    backdropFilter: 'var(--glass-blur-strong)', WebkitBackdropFilter: 'var(--glass-blur-strong)',
    background: 'linear-gradient(145deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0.005) 100%)',
    borderTop: '1px solid rgba(255,255,255,0.25)', borderLeft: '1px solid rgba(255,255,255,0.18)',
    borderRight: '1px solid transparent', borderBottom: '1px solid transparent',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3), inset 0 1px 2px rgba(255,255,255,0.06)',
    borderRadius: 12,
  },
  inner: {
    background: 'rgba(0,0,0,0.15)', borderRadius: 10, border: '1px solid rgba(255,255,255,0.06)',
  },
  active: {
    background: 'linear-gradient(145deg, rgba(168,85,247,0.1) 0%, rgba(56,189,248,0.04) 100%)',
    borderTopColor: 'rgba(168,85,247,0.5)', borderLeftColor: 'rgba(56,189,248,0.3)',
    boxShadow: '0 0 50px rgba(168,85,247,0.2), 0 5px 19px rgba(0,0,0,0.35), inset 0 1px 2px rgba(168,85,247,0.15)',
  },
}

const Shim = () => (
  <div style={{ position: 'absolute', inset: 0, borderRadius: 'inherit', pointerEvents: 'none',
    background: 'linear-gradient(105deg, rgba(255,255,255,0.05) 0%, transparent 35%, transparent 65%, rgba(255,255,255,0.01) 100%)' }} />
)

const tx = 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)'

function Btn({ label, accent, small, onClick, disabled, style: extraStyle }) {
  const [h, setH] = useState(false)
  const [p, setP] = useState(false)
  return (
    <button
      onMouseEnter={() => setH(true)} onMouseLeave={() => { setH(false); setP(false) }}
      onMouseDown={() => setP(true)} onMouseUp={() => setP(false)}
      onClick={onClick} disabled={disabled}
      style={{
        ...GL.inner, padding: small ? '4px 8px' : '6px 14px', fontSize: small ? 14 : 11, fontWeight: 600,
        color: '#fff', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1,
        border: accent ? '1px solid rgba(168,85,247,0.3)' : '1px solid rgba(255,255,255,0.1)',
        borderRadius: 8, fontFamily: 'inherit', transition: tx,
        transform: p ? 'translateY(1px) scale(0.995)' : h ? 'translateY(-2px) scale(1.008)' : 'none',
        ...(accent ? { background: 'linear-gradient(145deg, rgba(168,85,247,0.15) 0%, rgba(56,189,248,0.08) 100%)' } : {}),
        ...extraStyle,
      }}
    >{label}</button>
  )
}

function GlassInput({ value, onChange, placeholder, mono, rows, style: s }) {
  const isTextarea = rows && rows > 1
  const Tag = isTextarea ? 'textarea' : 'input'
  return (
    <Tag
      value={value} onChange={onChange} placeholder={placeholder} rows={rows}
      style={{
        ...GL.inner, width: '100%', padding: '8px 12px', color: '#fff', fontSize: 12,
        fontFamily: mono ? "'JetBrains Mono', monospace" : 'inherit',
        background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 8, outline: 'none', resize: isTextarea ? 'vertical' : 'none',
        transition: tx, ...s,
      }}
    />
  )
}


// ─── 11. EditorShell ────────────────────────────────────────────────────────

export function EditorShell({ children }) {
  const [activeSection, setActiveSection] = useState('identity')
  const sections = [
    { id: 'identity', icon: '👤', label: 'Identity', complete: true },
    { id: 'persona', icon: '🧠', label: 'Persona', complete: true },
    { id: 'prompt', icon: '📝', label: 'Prompt', complete: false },
    { id: 'voice', icon: '🎤', label: 'Voice', complete: true },
    { id: 'llm', icon: '⚙️', label: 'LLM', complete: true },
    { id: 'tools', icon: '🔧', label: 'Tools', complete: false },
    { id: 'actions', icon: '⚡', label: 'Actions', complete: false },
  ]

  return (
    <div style={{ ...GL.panel, display: 'flex', flexDirection: 'column', height: 600, overflow: 'hidden' }}>
      <Shim />
      {/* Header */}
      <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <div style={{ width: 40, height: 40, borderRadius: '50%', background: '#38bdf815', border: '2px solid #38bdf8', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 800, color: '#fff' }}>Q</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#fff' }}>CommanderQ</div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>Master Orchestrator</div>
        </div>
        <ReadinessRingMini percent={78} />
        <Btn label="Save" accent />
        <Btn label="×" small />
      </div>

      {/* Body: Rail + Content + Preview */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, gap: 1 }}>
        {/* Rail */}
        <div style={{ width: 60, padding: '8px 4px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, borderRight: '1px solid rgba(255,255,255,0.04)', flexShrink: 0 }}>
          {sections.map(s => (
            <button key={s.id} onClick={() => setActiveSection(s.id)} style={{
              width: 42, height: 42, borderRadius: 10, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1, cursor: 'pointer',
              background: activeSection === s.id ? 'linear-gradient(145deg, rgba(168,85,247,0.12) 0%, rgba(56,189,248,0.06) 100%)' : 'transparent',
              border: activeSection === s.id ? '1px solid rgba(168,85,247,0.3)' : '1px solid transparent',
              position: 'relative', padding: 0, fontFamily: 'inherit', transition: tx,
            }}>
              <span style={{ fontSize: 14 }}>{s.icon}</span>
              <span style={{ fontSize: 7, color: activeSection === s.id ? '#fff' : 'rgba(255,255,255,0.5)', fontWeight: 600 }}>{s.label.slice(0, 5).toUpperCase()}</span>
              <span style={{ position: 'absolute', top: 3, right: 3, width: 5, height: 5, borderRadius: '50%', background: s.complete ? '#30ff90' : 'transparent', border: s.complete ? 'none' : '1px solid rgba(255,255,255,0.2)' }} />
            </button>
          ))}
        </div>

        {/* Config content */}
        <div style={{ flex: 1, padding: 16, overflow: 'auto', minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 12 }}>
            {sections.find(s => s.id === activeSection)?.label || 'Section'}
          </div>
          <div style={{ ...GL.inner, padding: 20, minHeight: 200 }}>
            <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12 }}>
              {activeSection} tab content renders here
            </div>
          </div>
        </div>

        {/* Live preview */}
        <div style={{ width: 280, borderLeft: '1px solid rgba(255,255,255,0.04)', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
          <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.04)', fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: 1 }}>
            Live Preview
          </div>
          <div style={{ flex: 1, padding: 12, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 8, overflow: 'auto' }}>
            <WhatChangedBanner text="Personality updated — more concise" />
            <div style={{ ...GL.inner, padding: '8px 12px', borderRadius: 14, fontSize: 12, color: '#fff', maxWidth: '85%', alignSelf: 'flex-start' }}>
              Hi! I'm CommanderQ. How can I help you today?
            </div>
          </div>
          <div style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.04)' }}>
            <GlassInput placeholder="Test a message..." style={{ fontSize: 11 }} />
          </div>
        </div>
      </div>

      {/* Footer */}
      <div style={{ padding: '8px 16px', borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
        <span style={{ fontSize: 10, color: '#f59e0b' }}>Unsaved changes</span>
        <Btn label="Save changes" accent />
      </div>
    </div>
  )
}

function ReadinessRingMini({ percent = 78, size = 28 }) {
  const r = (size - 3) / 2, circ = 2 * Math.PI * r, offset = circ - (percent / 100) * circ
  const color = percent >= 80 ? '#30ff90' : percent >= 50 ? '#f59e0b' : '#ef4444'
  return (
    <div style={{ position: 'relative', width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={2.5} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={2.5} strokeDasharray={circ} strokeDashoffset={offset} strokeLinecap="round" />
      </svg>
      <span style={{ position: 'absolute', fontSize: 7, fontWeight: 700, color: '#fff', fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>{percent}</span>
    </div>
  )
}


// ─── 12. IdentityTab ────────────────────────────────────────────────────────

export function IdentityTab() {
  const [name, setName] = useState('CommanderQ')
  const [shortName, setShortName] = useState('Q')
  const [tagline, setTagline] = useState('Master Orchestrator')
  const [description, setDescription] = useState('Central command authority for the entire Quox ecosystem.')
  const [color, setColor] = useState('#38bdf8')

  const PRESET_COLORS = ['#38bdf8', '#a855f7', '#30ff90', '#ef4444', '#f59e0b', '#ec4899', '#06b6d4', '#8b5cf6', '#f97316', '#14b8a6']

  return (
    <div style={{ ...GL.card, padding: 20, position: 'relative' }}>
      <Shim />
      <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 16 }}>Identity</div>

      {/* Avatar preview + colour */}
      <div style={{ display: 'flex', gap: 20, marginBottom: 20 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 72, height: 72, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: `${color}15`, border: `3px solid ${color}`, boxShadow: `0 0 30px ${color}33`,
            fontSize: 28, fontWeight: 800, color: '#fff', transition: tx,
          }}>
            {shortName}
          </div>
          <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>Avatar preview</span>
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <label style={{ fontSize: 11, fontWeight: 600, color: '#fff', display: 'block', marginBottom: 4 }}>Display Name</label>
            <GlassInput value={name} onChange={e => setName(e.target.value)} placeholder="Agent name" />
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.6)', marginTop: 2 }}>{name.length}/50 characters</div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: '#fff', display: 'block', marginBottom: 4 }}>Short Name</label>
              <GlassInput value={shortName} onChange={e => setShortName(e.target.value.slice(0, 2))} placeholder="QC" style={{ textAlign: 'center', fontWeight: 800 }} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 11, fontWeight: 600, color: '#fff', display: 'block', marginBottom: 4 }}>Tagline</label>
              <GlassInput value={tagline} onChange={e => setTagline(e.target.value)} placeholder="One-line description" />
            </div>
          </div>
        </div>
      </div>

      {/* Colour picker */}
      <div style={{ marginBottom: 16 }}>
        <label style={{ fontSize: 11, fontWeight: 600, color: '#fff', display: 'block', marginBottom: 6 }}>Accent Colour</label>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {PRESET_COLORS.map(c => (
            <button key={c} onClick={() => setColor(c)} style={{
              width: 24, height: 24, borderRadius: '50%', background: c, border: c === color ? '2px solid #fff' : '2px solid transparent',
              cursor: 'pointer', boxShadow: c === color ? `0 0 12px ${c}66` : 'none', transition: tx, padding: 0,
            }} />
          ))}
          <div style={{ ...GL.inner, display: 'flex', alignItems: 'center', padding: '2px 8px', gap: 6, marginLeft: 8 }}>
            <input type="color" value={color} onChange={e => setColor(e.target.value)} style={{ width: 20, height: 20, border: 'none', background: 'transparent', cursor: 'pointer', padding: 0 }} />
            <span style={{ fontSize: 10, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums', color: '#fff' }}>{color}</span>
          </div>
        </div>
      </div>

      {/* Description */}
      <div>
        <label style={{ fontSize: 11, fontWeight: 600, color: '#fff', display: 'block', marginBottom: 4 }}>Description</label>
        <GlassInput value={description} onChange={e => setDescription(e.target.value)} placeholder="What does this assistant do?" rows={3} />
      </div>

      {/* Slug preview */}
      <div style={{ marginTop: 10, fontSize: 10, color: 'rgba(255,255,255,0.6)', fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>
        API ID: {name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-')}
      </div>
    </div>
  )
}


// ─── 13. VoiceTab ───────────────────────────────────────────────────────────

const VOICE_CATEGORIES = {
  'American Female': [
    { key: 'af1', name: 'Warm', sample: 'I am here to help.' },
    { key: 'af2', name: 'Expressive', sample: 'Let me check that for you!' },
    { key: 'af3', name: 'Upbeat', sample: 'Great question!' },
  ],
  'American Male': [
    { key: 'am1', name: 'Deep', sample: 'I have completed the scan.' },
    { key: 'am4', name: 'Confident', sample: 'The system is operating normally.' },
  ],
  'British': [
    { key: 'bm1', name: 'Male - Authoritative', sample: 'Right then, lets have a look.' },
    { key: 'bf1', name: 'Female - Confident', sample: 'I can certainly assist with that.' },
  ],
}

export function VoiceTab() {
  const [selected, setSelected] = useState('am4')
  const [verbosity, setVerbosity] = useState('normal')
  const [playing, setPlaying] = useState(false)

  return (
    <div style={{ ...GL.card, padding: 20, position: 'relative' }}>
      <Shim />
      <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 16 }}>Voice</div>

      {Object.entries(VOICE_CATEGORIES).map(([cat, voices]) => (
        <div key={cat} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>{cat}</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {voices.map(v => {
              const active = v.key === selected
              return (
                <button key={v.key} onClick={() => setSelected(v.key)} style={{
                  ...GL.inner, ...(active ? GL.active : {}),
                  padding: '8px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
                  borderRadius: 8, fontFamily: 'inherit', transition: tx,
                }}>
                  <span style={{ fontSize: 12, color: active ? '#fff' : 'rgba(255,255,255,0.6)', fontWeight: active ? 700 : 500 }}>
                    {v.name}
                  </span>
                  <button onClick={(e) => { e.stopPropagation(); setPlaying(v.key) }} style={{
                    width: 20, height: 20, borderRadius: '50%', border: 'none', cursor: 'pointer', padding: 0,
                    background: playing === v.key ? 'linear-gradient(135deg, #a855f7, #38bdf8)' : 'rgba(255,255,255,0.1)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 8, color: '#fff', transition: tx,
                  }}>
                    {playing === v.key ? '■' : '▶'}
                  </button>
                </button>
              )
            })}
          </div>
        </div>
      ))}

      {/* Verbosity */}
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 14, marginTop: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#fff', marginBottom: 8 }}>Verbosity</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {['quiet', 'normal', 'verbose'].map(v => (
            <button key={v} onClick={() => setVerbosity(v)} style={{
              ...GL.inner, ...(v === verbosity ? GL.active : {}),
              padding: '6px 14px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
              color: v === verbosity ? '#fff' : 'rgba(255,255,255,0.5)',
              borderRadius: 8, fontFamily: 'inherit', transition: tx, textTransform: 'capitalize',
            }}>
              {v}
            </button>
          ))}
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', alignSelf: 'center', marginLeft: 8 }}>
            Max: {verbosity === 'quiet' ? '150' : verbosity === 'normal' ? '500' : '1000'} chars
          </span>
        </div>
      </div>
    </div>
  )
}


// ─── 14. RulesTab ───────────────────────────────────────────────────────────

export function RulesTab() {
  const [alwaysRules, setAlwaysRules] = useState([
    'Cite sources when answering from the knowledge base',
    'Offer to connect with a human for billing disputes',
  ])
  const [neverRules, setNeverRules] = useState([
    'Discuss competitor pricing or features',
    'Make promises about delivery dates or timelines',
    'Reveal internal system details or architecture',
  ])

  const addRule = (type) => {
    if (type === 'always') setAlwaysRules([...alwaysRules, ''])
    else setNeverRules([...neverRules, ''])
  }

  const RuleList = ({ rules, setRules, accent }) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {rules.map((rule, i) => (
        <div key={i} style={{ ...GL.inner, display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderLeftColor: accent, borderLeftWidth: 2 }}>
          <input
            value={rule} onChange={e => { const n = [...rules]; n[i] = e.target.value; setRules(n) }}
            placeholder="Enter rule..."
            style={{ flex: 1, background: 'transparent', border: 'none', color: '#fff', fontSize: 11, fontFamily: 'inherit', outline: 'none' }}
          />
          <button onClick={() => setRules(rules.filter((_, idx) => idx !== i))} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.6)', cursor: 'pointer', fontSize: 14, padding: 0 }}>×</button>
        </div>
      ))}
    </div>
  )

  return (
    <div style={{ ...GL.card, padding: 20, position: 'relative' }}>
      <Shim />
      <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 16 }}>Rules & Guardrails</div>

      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#30ff90' }}>Always</span>
          <Btn label="+ Add" small onClick={() => addRule('always')} />
        </div>
        <RuleList rules={alwaysRules} setRules={setAlwaysRules} accent="rgba(48,255,144,0.3)" />
      </div>

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#ef4444' }}>Never</span>
          <Btn label="+ Add" small onClick={() => addRule('never')} />
        </div>
        <RuleList rules={neverRules} setRules={setNeverRules} accent="rgba(239,68,68,0.3)" />
      </div>
    </div>
  )
}


// ─── 15. SafetyTab ──────────────────────────────────────────────────────────

export function SafetyTab() {
  const [defcon, setDefcon] = useState('GREEN')
  const [approvalRequired, setApprovalRequired] = useState(true)
  const [autoApproved, setAutoApproved] = useState(['status_check', 'list_resources', 'health_check'])

  const DEFCON_LEVELS = [
    { level: 'GREEN', color: '#30ff90', desc: 'Normal operations. Read-only by default.' },
    { level: 'AMBER', color: '#f59e0b', desc: 'Elevated awareness. Approval required for changes.' },
    { level: 'RED', color: '#ef4444', desc: 'Critical operations. All actions require approval.' },
  ]

  return (
    <div style={{ ...GL.card, padding: 20, position: 'relative' }}>
      <Shim />
      <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 16 }}>Safety</div>

      {/* DEFCON selector */}
      <div style={{ fontSize: 11, fontWeight: 600, color: '#fff', marginBottom: 8 }}>DEFCON Level</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {DEFCON_LEVELS.map(d => (
          <button key={d.level} onClick={() => setDefcon(d.level)} style={{
            ...GL.card, ...(d.level === defcon ? GL.active : {}),
            flex: 1, padding: 12, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', transition: tx,
            borderLeftColor: d.level === defcon ? d.color : 'transparent', borderLeftWidth: 3,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: d.color, boxShadow: d.level === defcon ? `0 0 8px ${d.color}` : 'none' }} />
              <span style={{ fontSize: 12, fontWeight: 700, color: d.color }}>{d.level}</span>
            </div>
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>{d.desc}</span>
          </button>
        ))}
      </div>

      {/* Approval toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <input type="checkbox" checked={approvalRequired} onChange={() => setApprovalRequired(!approvalRequired)} style={{ accentColor: '#a855f7' }} />
        <span style={{ fontSize: 12, color: '#fff' }}>Require approval for destructive actions</span>
      </div>

      {/* Auto-approved actions */}
      <div style={{ fontSize: 11, fontWeight: 600, color: '#fff', marginBottom: 6 }}>Auto-Approved Actions</div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {autoApproved.map(a => (
          <span key={a} style={{ ...GL.inner, padding: '3px 8px', fontSize: 10, color: '#30ff90', fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>
            {a}
          </span>
        ))}
      </div>
    </div>
  )
}


// ─── 16. DelegationTab ──────────────────────────────────────────────────────

export function DelegationTab() {
  const agents = [
    { id: 'sentinel', name: 'WARDEN', domain: 'Security', color: '#ef4444', enabled: true },
    { id: 'cipher', name: 'CIPHER', domain: 'Network', color: '#38bdf8', enabled: true },
    { id: 'nova', name: 'DAEDALUS', domain: 'DevOps', color: '#a855f7', enabled: true },
    { id: 'atlas', name: 'HYPERION', domain: 'Virtualisation', color: '#f97316', enabled: false },
    { id: 'metrics', name: 'METRICS', domain: 'Monitoring', color: '#06b6d4', enabled: true },
    { id: 'forge', name: 'VULCAN', domain: 'GitHub', color: '#8b5cf6', enabled: false },
  ]

  return (
    <div style={{ ...GL.card, padding: 20, position: 'relative' }}>
      <Shim />
      <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 16 }}>Delegation Targets</div>
      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginBottom: 12 }}>This agent can delegate queries to the following specialists:</div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {agents.map(a => (
          <div key={a.id} style={{ ...GL.inner, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10, opacity: a.enabled ? 1 : 0.5 }}>
            <div style={{ width: 28, height: 28, borderRadius: '50%', background: `${a.color}15`, border: `1.5px solid ${a.color}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 800, color: '#fff' }}>
              {a.name.slice(0, 2)}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#fff' }}>{a.name}</div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>{a.domain}</div>
            </div>
            <div style={{
              width: 32, height: 18, borderRadius: 9, cursor: 'pointer', position: 'relative',
              background: a.enabled ? 'linear-gradient(90deg, #a855f7, #38bdf8)' : 'rgba(255,255,255,0.1)', transition: tx,
            }}>
              <div style={{ width: 14, height: 14, borderRadius: '50%', background: '#fff', position: 'absolute', top: 2, left: a.enabled ? 16 : 2, transition: tx }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}


// ─── 17. ToolParameterBuilder ───────────────────────────────────────────────

export function ToolParameterBuilder() {
  const [params, setParams] = useState([
    { name: 'host', type: 'string', required: true, description: 'Target hostname or IP', sensitive: false },
    { name: 'command', type: 'string', required: true, description: 'Shell command to execute', sensitive: false },
    { name: 'timeout', type: 'integer', required: false, description: 'Timeout in seconds', sensitive: false, default: '30' },
  ])
  const [expanded, setExpanded] = useState(null)

  const TYPES = ['string', 'number', 'integer', 'boolean', 'array', 'object']

  return (
    <div style={{ ...GL.card, padding: 20, position: 'relative' }}>
      <Shim />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>Parameters</span>
        <Btn label="+ Add Parameter" onClick={() => setParams([...params, { name: '', type: 'string', required: false, description: '', sensitive: false }])} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {params.map((p, i) => (
          <div key={i} style={{ ...GL.inner, overflow: 'hidden' }}>
            {/* Collapsed header */}
            <button onClick={() => setExpanded(expanded === i ? null : i)} style={{
              width: '100%', padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8,
              background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
            }}>
              <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>{expanded === i ? '▼' : '▶'}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#fff', fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums', flex: 1 }}>{p.name || 'unnamed'}</span>
              <span style={{ ...GL.inner, padding: '1px 6px', fontSize: 9, color: '#38bdf8' }}>{p.type}</span>
              {p.required && <span style={{ ...GL.inner, padding: '1px 6px', fontSize: 9, color: '#f59e0b' }}>required</span>}
              {p.sensitive && <span style={{ ...GL.inner, padding: '1px 6px', fontSize: 9, color: '#ef4444' }}>sensitive</span>}
              <button onClick={(e) => { e.stopPropagation(); setParams(params.filter((_, idx) => idx !== i)) }} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.6)', cursor: 'pointer', fontSize: 12, padding: 0 }}>×</button>
            </button>

            {/* Expanded editor */}
            {expanded === i && (
              <div style={{ padding: '0 12px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)', display: 'block', marginBottom: 2 }}>Name</label>
                    <GlassInput value={p.name} onChange={e => { const n = [...params]; n[i] = { ...p, name: e.target.value }; setParams(n) }} mono placeholder="param_name" />
                  </div>
                  <div style={{ width: 120 }}>
                    <label style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)', display: 'block', marginBottom: 2 }}>Type</label>
                    <select value={p.type} onChange={e => { const n = [...params]; n[i] = { ...p, type: e.target.value }; setParams(n) }}
                      style={{ ...GL.inner, width: '100%', padding: '8px 10px', color: '#fff', fontSize: 11, background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>
                      {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                </div>
                <div>
                  <label style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)', display: 'block', marginBottom: 2 }}>Description</label>
                  <GlassInput value={p.description} onChange={e => { const n = [...params]; n[i] = { ...p, description: e.target.value }; setParams(n) }} placeholder="What this parameter does" />
                </div>
                <div style={{ display: 'flex', gap: 12 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'rgba(255,255,255,0.7)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={p.required} onChange={() => { const n = [...params]; n[i] = { ...p, required: !p.required }; setParams(n) }} style={{ accentColor: '#f59e0b' }} />
                    Required
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'rgba(255,255,255,0.7)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={p.sensitive} onChange={() => { const n = [...params]; n[i] = { ...p, sensitive: !p.sensitive }; setParams(n) }} style={{ accentColor: '#ef4444' }} />
                    Sensitive (redact in logs)
                  </label>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Schema preview */}
      <div style={{ ...GL.inner, padding: 10, marginTop: 12, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums', fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>
        <div style={{ fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 4 }}>Schema Preview</div>
        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', color: '#38bdf8' }}>
          {JSON.stringify(Object.fromEntries(params.map(p => [p.name || 'unnamed', { type: p.type, ...(p.required && { required: true }), ...(p.description && { description: p.description }), ...(p.sensitive && { sensitive: true }) }])), null, 2)}
        </pre>
      </div>
    </div>
  )
}


// ─── 18. ToolBrowser ────────────────────────────────────────────────────────

export function ToolBrowser() {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const tools = [
    { name: 'ssh_exec', category: 'infrastructure', assigned: true, risk: 'medium' },
    { name: 'docker_status', category: 'infrastructure', assigned: true, risk: 'low' },
    { name: 'security_audit', category: 'security', assigned: false, risk: 'high' },
    { name: 'metrics_query', category: 'analytics', assigned: true, risk: 'low' },
    { name: 'proxmox_vms', category: 'infrastructure', assigned: false, risk: 'medium' },
    { name: 'fleet_status', category: 'infrastructure', assigned: true, risk: 'low' },
    { name: 'github_create_issue', category: 'dev', assigned: false, risk: 'low' },
    { name: 'memory_save', category: 'data', assigned: true, risk: 'low' },
  ]
  const CATS = ['all', 'infrastructure', 'security', 'analytics', 'dev', 'data']
  const catColors = { infrastructure: '#38bdf8', security: '#a855f7', analytics: '#f59e0b', dev: '#8b5cf6', data: '#30ff90' }
  const filtered = tools.filter(t => (category === 'all' || t.category === category) && (!search || t.name.includes(search)))

  return (
    <div style={{ ...GL.card, padding: 20, position: 'relative' }}>
      <Shim />
      <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 12 }}>Tool Browser</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <GlassInput value={search} onChange={e => setSearch(e.target.value)} placeholder="Search tools..." style={{ flex: 1 }} />
        <Btn label="+ Create Tool" accent />
      </div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap' }}>
        {CATS.map(c => (
          <button key={c} onClick={() => setCategory(c)} style={{
            ...GL.inner, ...(c === category ? GL.active : {}),
            padding: '3px 10px', fontSize: 10, fontWeight: 600, cursor: 'pointer',
            color: c === category ? '#fff' : 'rgba(255,255,255,0.5)',
            borderRadius: 6, fontFamily: 'inherit', transition: tx, textTransform: 'capitalize',
          }}>{c}</button>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {filtered.map(t => (
          <div key={t.name} style={{ ...GL.inner, padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#fff', fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums', flex: 1 }}>{t.name}</span>
            <span style={{ fontSize: 9, color: catColors[t.category] || '#fff' }}>{t.category}</span>
            <span style={{ fontSize: 9, color: t.risk === 'high' ? '#ef4444' : t.risk === 'medium' ? '#f59e0b' : '#30ff90' }}>{t.risk}</span>
            <div style={{
              width: 28, height: 16, borderRadius: 8, cursor: 'pointer', position: 'relative',
              background: t.assigned ? 'linear-gradient(90deg, #a855f7, #38bdf8)' : 'rgba(255,255,255,0.1)', transition: tx,
            }}>
              <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#fff', position: 'absolute', top: 2, left: t.assigned ? 14 : 2, transition: tx }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}


// ─── 19. LiveChatPreview ────────────────────────────────────────────────────

export function LiveChatPreview() {
  const [message, setMessage] = useState('')
  const messages = [
    { role: 'bot', text: 'Hi! I\'m CommanderQ, your infrastructure orchestrator. How can I help?' },
    { role: 'user', text: 'Check the status of all Docker containers' },
    { role: 'bot', text: 'I\'ll have DAEDALUS check that for you. Running docker_status across all hosts...', tool: 'docker_status' },
  ]

  return (
    <div style={{ ...GL.card, display: 'flex', flexDirection: 'column', height: 400, overflow: 'hidden', position: 'relative' }}>
      <Shim />
      <div style={{ padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.04)', fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: 1 }}>
        Live Preview
      </div>
      <div style={{ flex: 1, padding: 12, display: 'flex', flexDirection: 'column', gap: 8, overflow: 'auto', justifyContent: 'flex-end' }}>
        <WhatChangedBanner text="Voice changed to American Male 4 (Confident)" />
        {messages.map((m, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
            <div style={{
              ...GL.inner, padding: '8px 12px', borderRadius: 14, maxWidth: '80%',
              background: m.role === 'user' ? 'linear-gradient(145deg, rgba(168,85,247,0.15), rgba(56,189,248,0.08))' : undefined,
              fontSize: 11, color: '#fff', lineHeight: 1.5,
            }}>
              {m.text}
              {m.tool && <div style={{ marginTop: 4, fontSize: 9, color: '#38bdf8', fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>Tool: {m.tool}</div>}
            </div>
          </div>
        ))}
      </div>
      <div style={{ padding: 8, borderTop: '1px solid rgba(255,255,255,0.04)', display: 'flex', gap: 6 }}>
        <GlassInput value={message} onChange={e => setMessage(e.target.value)} placeholder="Test a message..." style={{ flex: 1, fontSize: 11 }} />
        <Btn label="Send" accent />
      </div>
    </div>
  )
}


// ─── 20. WhatChangedBanner ──────────────────────────────────────────────────

export function WhatChangedBanner({ text = 'Personality updated — responses will be more concise' }) {
  const [visible, setVisible] = useState(true)
  useEffect(() => { const t = setTimeout(() => setVisible(false), 4000); return () => clearTimeout(t) }, [text])
  if (!visible) return null
  return (
    <div style={{
      padding: '4px 10px', borderRadius: 8, fontSize: 10, color: '#38bdf8', fontWeight: 600,
      background: 'rgba(56,189,248,0.06)', border: '1px solid rgba(56,189,248,0.15)',
      display: 'flex', alignItems: 'center', gap: 6, transition: tx, opacity: visible ? 1 : 0,
    }}>
      <span style={{ fontSize: 10 }}>↻</span> {text}
    </div>
  )
}


// ─── 21. TemplateSelector ───────────────────────────────────────────────────

export function TemplateSelector({ onSelect }) {
  const templates = [
    { id: 'support', name: 'Customer Support', desc: 'Friendly, knowledge-grounded, escalates when unsure', icon: '🎧', popularity: 89 },
    { id: 'sales', name: 'Sales Assistant', desc: 'Warm, conversion-focused, highlights value', icon: '💰', popularity: 72 },
    { id: 'docs', name: 'Documentation', desc: 'Precise, technical, cites sources', icon: '📚', popularity: 95 },
    { id: 'internal', name: 'Internal Knowledge', desc: 'Enterprise-focused, policy-aware, secure', icon: '🏢', popularity: 64 },
    { id: 'onboarding', name: 'Onboarding Guide', desc: 'Step-by-step, patient, progress-tracking', icon: '🚀', popularity: 58 },
    { id: 'monitor', name: 'Monitoring Agent', desc: 'Concise, alert-focused, ops-oriented', icon: '📡', popularity: 81 },
  ]

  return (
    <div style={{ ...GL.card, padding: 20, position: 'relative' }}>
      <Shim />
      <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 12 }}>Start from Template</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 8 }}>
        {templates.map(t => {
          const [h, setH] = useState(false)
          return (
            <button key={t.id} onClick={() => onSelect?.(t.id)}
              onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
              style={{
                ...GL.inner, padding: 12, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', transition: tx,
                transform: h ? 'translateY(-2px)' : 'none',
                border: h ? '1px solid rgba(168,85,247,0.3)' : '1px solid rgba(255,255,255,0.06)',
              }}>
              <div style={{ fontSize: 20, marginBottom: 6 }}>{t.icon}</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#fff', marginBottom: 2 }}>{t.name}</div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', marginBottom: 6, lineHeight: 1.4 }}>{t.desc}</div>
              <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>Used by {t.popularity}% of agents</div>
            </button>
          )
        })}
      </div>
    </div>
  )
}


// ─── 22. BudgetManager ──────────────────────────────────────────────────────

export function BudgetManager() {
  const [budget, setBudget] = useState(50)
  const [fallback, setFallback] = useState('downgrade')
  const used = 34.20
  const pct = (used / budget) * 100

  const FALLBACKS = [
    { id: 'hide', label: 'Hide widget', desc: 'Widget disappears from site' },
    { id: 'unavailable', label: 'Show unavailable', desc: 'Bubble stays, shows message' },
    { id: 'downgrade', label: 'Auto-downgrade model', desc: 'Switch to cheaper LLM' },
    { id: 'message', label: 'Custom message', desc: 'Display your own text' },
    { id: 'continue', label: 'Continue anyway', desc: 'Provider rejects when empty' },
  ]

  return (
    <div style={{ ...GL.card, padding: 20, position: 'relative' }}>
      <Shim />
      <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 16 }}>Budget Management</div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 11, fontWeight: 600, color: '#fff', display: 'block', marginBottom: 4 }}>Monthly Limit ($)</label>
          <GlassInput value={budget} onChange={e => setBudget(Number(e.target.value) || 0)} mono />
        </div>
        <div style={{ ...GL.inner, flex: 2, padding: 12 }}>
          <div style={{ fontSize: 9, fontWeight: 600, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>Current Month</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 6 }}>
            <span style={{ fontSize: 18, fontWeight: 800, color: '#fff', fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' }}>${used.toFixed(2)}</span>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>/ ${budget}</span>
          </div>
          <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.06)' }}>
            <div style={{ width: `${Math.min(100, pct)}%`, height: '100%', borderRadius: 3, background: pct > 80 ? '#ef4444' : pct > 60 ? '#f59e0b' : 'linear-gradient(90deg, #a855f7, #38bdf8)', transition: 'width 0.5s ease' }} />
          </div>
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', marginTop: 4 }}>~8,200 conversations · {pct.toFixed(0)}% used</div>
        </div>
      </div>

      <div style={{ fontSize: 11, fontWeight: 600, color: '#fff', marginBottom: 8 }}>When budget exhausted</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 16 }}>
        {FALLBACKS.map(f => (
          <button key={f.id} onClick={() => setFallback(f.id)} style={{
            ...GL.inner, ...(f.id === fallback ? GL.active : {}),
            padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
            fontFamily: 'inherit', textAlign: 'left', transition: tx,
          }}>
            <span style={{ width: 14, height: 14, borderRadius: '50%', border: f.id === fallback ? '4px solid #a855f7' : '2px solid rgba(255,255,255,0.2)', boxSizing: 'border-box', flexShrink: 0 }} />
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#fff' }}>{f.label}</div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>{f.desc}</div>
            </div>
          </button>
        ))}
      </div>

      <div style={{ fontSize: 11, fontWeight: 600, color: '#fff', marginBottom: 8 }}>Alert Thresholds</div>
      <div style={{ display: 'flex', gap: 12 }}>
        {[50, 80, 100].map(t => (
          <label key={t} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'rgba(255,255,255,0.7)', cursor: 'pointer' }}>
            <input type="checkbox" defaultChecked={t <= 80} style={{ accentColor: t === 100 ? '#ef4444' : '#a855f7' }} />
            {t}%
          </label>
        ))}
      </div>
    </div>
  )
}


// ─── 23. KnowledgeSourceCard ─────────────────────────────────────��──────────

export function KnowledgeSourceCard({ type = 'file', name = 'product-manual.pdf', status = 'indexed', chunks = 47, lastSync = '2m ago', size = '2.4 MB' }) {
  const statusColors = { indexed: '#30ff90', indexing: '#38bdf8', pending: '#f59e0b', error: '#ef4444' }
  const typeIcons = { file: '📄', url: '🌐', qa: '❓', connector: '🔗' }

  return (
    <div style={{ ...GL.inner, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontSize: 16 }}>{typeIcons[type]}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
        <div style={{ display: 'flex', gap: 8, fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>
          <span>{size}</span>
          <span>{chunks} chunks</span>
          <span>Synced {lastSync}</span>
        </div>
      </div>
      <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: statusColors[status], fontWeight: 600 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: statusColors[status], boxShadow: `0 0 6px ${statusColors[status]}44` }} />
        {status}
      </span>
      <Btn label="⋯" small />
    </div>
  )
}


// ─── 24. CompletionChecklist ────────────────────────────────────────────────

export function CompletionChecklist() {
  const checks = [
    { label: 'Identity configured', done: true },
    { label: 'Personality set', done: true },
    { label: 'System prompt written', done: true },
    { label: 'LLM model selected', done: true },
    { label: 'API key validated', done: true },
    { label: 'Knowledge sources added', done: false },
    { label: 'At least one test conversation', done: false },
    { label: 'Security score > 70', done: false },
  ]
  const pct = Math.round((checks.filter(c => c.done).length / checks.length) * 100)

  return (
    <div style={{ ...GL.card, padding: 16, position: 'relative', width: 260 }}>
      <Shim />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <ReadinessRingMini percent={pct} size={32} />
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>Publish Readiness</div>
          <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>{checks.filter(c => c.done).length}/{checks.length} complete</div>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {checks.map((c, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: c.done ? 'rgba(255,255,255,0.6)' : '#fff' }}>
            <span style={{ fontSize: 12, color: c.done ? '#30ff90' : 'rgba(255,255,255,0.2)' }}>{c.done ? '✓' : '○'}</span>
            <span style={{ textDecoration: c.done ? 'line-through' : 'none' }}>{c.label}</span>
          </div>
        ))}
      </div>
      <Btn label="Publish" accent disabled={pct < 100} style={{ width: '100%', marginTop: 12, textAlign: 'center' }} />
    </div>
  )
}


// ─── 25. AssistantsHubView (5-tab listing) ──────────────────────────────────

export function AssistantsHubView() {
  const [tab, setTab] = useState('all')
  const tabs = [
    { id: 'all', label: 'All', count: 42 },
    { id: 'agents', label: 'Agents', count: 16 },
    { id: 'assistants', label: 'Assistants', count: 8 },
    { id: 'teams', label: 'Teams', count: 12 },
    { id: 'chatbots', label: 'ChatBots', count: 6 },
  ]
  const tabColors = { agents: '#38bdf8', assistants: '#a855f7', teams: '#f59e0b', chatbots: '#30ff90', all: '#fff' }

  return (
    <div style={{ ...GL.panel, padding: 20, position: 'relative' }}>
      <Shim />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: '#fff' }}>Assistants</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <Btn label="+ Create" accent />
          <Btn label="Talk to ARCHITECT" />
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: 8 }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            padding: '6px 14px', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
            background: t.id === tab ? 'linear-gradient(145deg, rgba(168,85,247,0.08) 0%, rgba(56,189,248,0.04) 100%)' : 'transparent',
            border: t.id === tab ? '1px solid rgba(168,85,247,0.2)' : '1px solid transparent',
            borderRadius: 8, color: t.id === tab ? tabColors[t.id] : 'rgba(255,255,255,0.5)', transition: tx,
          }}>
            {t.label} <span style={{ fontSize: 9, opacity: 0.6 }}>{t.count}</span>
          </button>
        ))}
      </div>

      {/* Placeholder grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
        {[1, 2, 3, 4, 5, 6].map(i => (
          <div key={i} style={{ ...GL.inner, padding: 14, height: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>Assistant Card {i}</span>
          </div>
        ))}
      </div>
    </div>
  )
}


// ─── 26. ArchitectChatMessage ───────────────────────────────────────────────

export function ArchitectChatMessage() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 480 }}>
      {/* User message */}
      <div style={{ alignSelf: 'flex-end' }}>
        <div style={{ ...GL.inner, padding: '8px 12px', borderRadius: 14, fontSize: 12, color: '#fff', background: 'linear-gradient(145deg, rgba(168,85,247,0.15), rgba(56,189,248,0.08))' }}>
          Create a monitoring agent that watches Docker containers and alerts on failures
        </div>
      </div>

      {/* ARCHITECT response */}
      <div style={{ alignSelf: 'flex-start' }}>
        <div style={{ ...GL.inner, padding: '10px 14px', borderRadius: 14, fontSize: 12, color: '#fff', lineHeight: 1.5, maxWidth: '100%' }}>
          <div style={{ marginBottom: 8 }}>
            I'll create a Docker monitoring specialist. Here's the proposed configuration:
          </div>
          {/* Inline agent preview card */}
          <div style={{ ...GL.card, padding: 12, marginBottom: 8, borderLeftColor: '#38bdf844', borderLeftWidth: 2 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#06b6d415', border: '1.5px solid #06b6d4', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, color: '#fff' }}>DK</div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#fff' }}>DOCKWATCH</div>
                <div style={{ display: 'flex', gap: 4 }}>
                  <span style={{ ...GL.inner, padding: '1px 5px', fontSize: 8, color: '#38bdf8' }}>Agent</span>
                  <span style={{ ...GL.inner, padding: '1px 5px', fontSize: 8, color: '#30ff90' }}>GREEN</span>
                </div>
              </div>
            </div>
            <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div>Tools: <span style={{ color: '#38bdf8' }}>docker_status, docker_extended, alerts_manage, ssh_exec</span></div>
              <div>Tone: Professional, alert-focused</div>
              <div>Quick: "Container health", "Failed containers", "Docker disk usage"</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <Btn label="Apply" accent />
            <Btn label="Edit in Panel" />
            <Btn label="Cancel" />
          </div>
        </div>
      </div>
    </div>
  )
}


// ─── Full Showcase ──────────────────────────────────────────────────────────

export default function AuxPrototypeShowcase2() {
  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 32, maxWidth: 900, margin: '0 auto' }}>
      <div style={{ fontSize: 20, fontWeight: 800, color: '#fff' }}>AUX Prototypes (Part 2)</div>

      <EditorShell />

      <div style={{ display: 'flex', gap: 16 }}>
        <div style={{ flex: 1 }}><IdentityTab /></div>
        <LiveChatPreview />
      </div>

      <VoiceTab />
      <RulesTab />

      <div style={{ display: 'flex', gap: 16 }}>
        <div style={{ flex: 1 }}><SafetyTab /></div>
        <div style={{ flex: 1 }}><DelegationTab /></div>
      </div>

      <ToolParameterBuilder />
      <ToolBrowser />
      <TemplateSelector />
      <BudgetManager />

      <div style={{ display: 'flex', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <div style={{ ...GL.card, padding: 16, position: 'relative' }}>
            <Shim />
            <div style={{ fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 10 }}>Knowledge Sources</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <KnowledgeSourceCard />
              <KnowledgeSourceCard type="url" name="docs.acme.com" status="indexing" chunks={128} size="4.1 MB" lastSync="indexing..." />
              <KnowledgeSourceCard type="qa" name="Pricing FAQ" status="indexed" chunks={12} size="8 KB" lastSync="1h ago" />
            </div>
          </div>
        </div>
        <CompletionChecklist />
      </div>

      <AssistantsHubView />
      <ArchitectChatMessage />
    </div>
  )
}
