/**
 * ModeToggle — Wizard ↔ Advanced pill + completion progress
 * CW-8.9.1
 *
 * Wizard progress coherence (Fable audit P2): while the wizard is open the
 * wizard's own step rail is the only progress vocabulary, so the setup meter
 * hides in wizard mode. In advanced mode it renders labelled ("Setup 2 of 6")
 * instead of an unexplained "2 of 6".
 */

export default function ModeToggle({ mode, onChange, completion }) {
  const pct = completion?.percent ?? 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      {mode !== 'wizard' && !(completion?.published && completion?.requiredDone) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 200 }} title="Setup completion across name, knowledge, training, style, testing and deployment">
          <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: 'linear-gradient(90deg, #a855f7, #38bdf8)', transition: 'width 0.4s ease' }} />
          </div>
          <span style={{ fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.7)', fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'nowrap' }}>
            Setup {completion?.completed ?? 0} of {completion?.total ?? 6}
          </span>
        </div>
      )}
      <div style={{ display: 'inline-flex', padding: 2, background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8 }}>
        <button
          onClick={() => onChange('wizard')}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '6px 12px', fontSize: 11, fontWeight: 700, borderRadius: 6, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
            background: mode === 'wizard' ? 'linear-gradient(135deg, rgba(168,85,247,0.25), rgba(56,189,248,0.15))' : 'transparent',
            color: mode === 'wizard' ? '#fff' : 'rgba(255,255,255,0.7)',
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={mode === 'wizard' ? '#ffffff' : 'rgba(255,255,255,0.7)'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M15 9h0M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5" /></svg>
          Wizard
        </button>
        <button
          onClick={() => onChange('advanced')}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '6px 12px', fontSize: 11, fontWeight: 700, borderRadius: 6, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
            background: mode === 'advanced' ? 'linear-gradient(135deg, rgba(168,85,247,0.25), rgba(56,189,248,0.15))' : 'transparent',
            color: mode === 'advanced' ? '#fff' : 'rgba(255,255,255,0.7)',
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={mode === 'advanced' ? '#ffffff' : 'rgba(255,255,255,0.7)'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
          Advanced
        </button>
      </div>
    </div>
  )
}
