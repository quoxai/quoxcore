/**
 * BrowserQ Run Detail Components — Glass Design System
 *
 * Production-ready components for the three-column run detail page.
 * Each component follows the Glass Design System exactly:
 * - No grey text (minimum opacity 0.6)
 * - Glass morphism on all panels (backdrop-filter + shimmer)
 * - Hover lift + click depress on interactive elements
 * - Purple-to-cyan active states
 * - Top-left light source borders
 */

import { useState, useCallback, useEffect } from 'react'

// ─── Embedded Styles (hover physics for mapped items) ──────────────

const GLASS_HOVER_CSS = `.bq-step-btn:hover{transform:translateY(-1px) scale(1.005)}.bq-step-btn:active{transform:translateY(1px) scale(0.995)}.bq-tab-btn:hover{transform:translateY(-1px);background:rgba(255,255,255,0.03)!important}.bq-tab-btn:active{transform:translateY(1px)}.bq-scrub-seg:hover{opacity:0.8!important;transform:scaleY(1.5)}.bq-scrub-seg:active{transform:scaleY(1)}`

function useInjectGlassHoverCSS() {
  useEffect(() => {
    if (document.getElementById('bq-glass-hover')) return
    const style = document.createElement('style')
    style.id = 'bq-glass-hover'
    style.textContent = GLASS_HOVER_CSS
    document.head.appendChild(style)
  }, [])
}

// ─── Shimmer Layer ─────────────────────────────────────────────────

function Shimmer() {
  return (
    <div style={{
      position: 'absolute', inset: 0, borderRadius: 'inherit', pointerEvents: 'none',
      background: 'linear-gradient(105deg, rgba(255,255,255,0.05) 0%, transparent 35%, transparent 65%, rgba(255,255,255,0.01) 100%)',
    }} />
  )
}

// ─── Glass Panel ───────────────────────────────────────────────────

function GlassPanel({ children, style = {}, className = '' }) {
  return (
    <div className={className} style={{
      backdropFilter: 'var(--glass-blur-strong)',
      WebkitBackdropFilter: 'var(--glass-blur-strong)',
      background: 'linear-gradient(145deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0.005) 100%)',
      borderTop: '1px solid rgba(255,255,255,0.40)',
      borderLeft: '1px solid rgba(255,255,255,0.31)',
      borderRight: '1px solid transparent',
      borderBottom: '1px solid transparent',
      borderRadius: 14,
      boxShadow: '0 5px 19px rgba(0,0,0,0.35), 0 2px 4px rgba(0,0,0,0.2), inset 0 1px 2px rgba(255,255,255,0.08), inset 1px 0 1px rgba(255,255,255,0.04)',
      position: 'relative',
      overflow: 'hidden',
      ...style,
    }}>
      <Shimmer />
      {children}
    </div>
  )
}

// ─── Glass Button ──────────────────────────────────────────────────

function GlassButton({ children, variant = 'default', onClick, disabled, style = {} }) {
  const [hover, setHover] = useState(false)
  const [press, setPress] = useState(false)

  const colors = {
    default: { bg: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.15)', color: '#fff' },
    approve: { bg: 'rgba(16,185,129,0.12)', border: 'rgba(16,185,129,0.3)', color: '#10b981' },
    danger: { bg: 'rgba(239,68,68,0.12)', border: 'rgba(239,68,68,0.3)', color: '#ef4444' },
    cyan: { bg: 'rgba(6,182,212,0.12)', border: 'rgba(6,182,212,0.3)', color: '#06b6d4' },
    purple: { bg: 'rgba(168,85,247,0.12)', border: 'rgba(168,85,247,0.3)', color: '#a855f7' },
    amber: { bg: 'rgba(245,158,11,0.12)', border: 'rgba(245,158,11,0.3)', color: '#f59e0b' },
  }
  const c = colors[variant] || colors.default

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setPress(false) }}
      onMouseDown={() => setPress(true)}
      onMouseUp={() => setPress(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '6px 14px', borderRadius: 10, fontSize: 12, fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        border: `1px solid ${c.border}`, color: c.color,
        backdropFilter: 'var(--glass-blur-strong)',
        WebkitBackdropFilter: 'var(--glass-blur-strong)',
        background: c.bg,
        opacity: disabled ? 0.5 : 1,
        transform: press ? 'translateY(1px) scale(0.995)' : hover ? 'translateY(-2px) scale(1.008)' : 'none',
        boxShadow: press
          ? '0 1px 6px rgba(0,0,0,0.3), inset 0 2px 4px rgba(0,0,0,0.15)'
          : hover
            ? '0 8px 30px rgba(0,0,0,0.4), 0 0 20px rgba(56,189,248,0.07)'
            : '0 2px 8px rgba(0,0,0,0.2)',
        transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
        position: 'relative', overflow: 'hidden',
        ...style,
      }}
    >
      <Shimmer />
      {children}
    </button>
  )
}

// ─── Run Metadata Bar ──────────────────────────────────────────────

const STATUS_CONFIG = {
  completed: { color: '#30ff90', label: 'Completed', icon: '\u2713' },
  running: { color: '#38bdf8', label: 'Running', icon: '\u25B6' },
  paused: { color: '#f59e0b', label: 'Awaiting Approval', icon: '\u23F8' },
  failed: { color: '#ef4444', label: 'Failed', icon: '\u2717' },
  cancelled: { color: 'rgba(255,255,255,0.6)', label: 'Cancelled', icon: '\u2715' },
  planned: { color: '#a855f7', label: 'Planned', icon: '\u25CB' },
}

export function RunMetadataBar({ objective, onBack, onWatch, onRerun, onSave, onSchedule, onApprove }) {
  const status = STATUS_CONFIG[objective?.status] || STATUS_CONFIG.planned
  const steps = objective?.steps || []
  const doneCount = steps.filter(s => s.status === 'completed' || s.status === 'done').length

  return (
    <GlassPanel style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
      <GlassButton variant="default" onClick={onBack} style={{ padding: '4px 10px', fontSize: 16, minWidth: 'auto' }}>
        {'\u2190'}
      </GlassButton>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 14, fontWeight: 700, color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {objective?.intent || 'Untitled Run'}
        </div>
        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: 'rgba(255,255,255,0.6)', marginTop: 2 }}>
          {objective?.url || ''}
        </div>
      </div>

      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '3px 10px', borderRadius: 6,
        background: `${status.color}15`, border: `1px solid ${status.color}30`,
      }}>
        <span style={{ color: status.color, fontSize: 11 }}>{status.icon}</span>
        <span style={{ color: status.color, fontSize: 11, fontWeight: 600 }}>{status.label}</span>
      </div>

      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#fff', fontWeight: 600 }}>
        {doneCount}/{steps.length}
      </div>

      <div style={{ display: 'flex', gap: 6, marginLeft: 8 }}>
        {(objective?.status === 'running' || objective?.status === 'paused') && (
          <GlassButton variant="cyan" onClick={onWatch}>{'\u25B6'} Watch</GlassButton>
        )}
        {(objective?.status === 'paused' || (objective?.steps || []).some(s => s.status === 'awaiting_approval' || s.status === 'paused' || s.status === 'pending_approval')) && onApprove && (
          <GlassButton variant="approve" onClick={onApprove}>{'\u2713'} Approve</GlassButton>
        )}
        {objective?.status === 'completed' && (
          <>
            <GlassButton variant="approve" onClick={onRerun}>{'\u21BB'} Rerun</GlassButton>
            <GlassButton variant="purple" onClick={onSave}>{'\u{1F4BE}'} Save</GlassButton>
          </>
        )}
        {objective?.status === 'failed' && (
          <GlassButton variant="amber" onClick={onRerun}>{'\u21BB'} Retry</GlassButton>
        )}
      </div>
    </GlassPanel>
  )
}

// ─── Step Timeline ─────────────────────────────────────────────────

export function StepTimeline({ steps = [], activeStepIndex = -1, onStepClick }) {
  useInjectGlassHoverCSS()
  return (
    <GlassPanel style={{ padding: '10px 0', display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ padding: '0 12px 8px', fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#fff', fontWeight: 700, letterSpacing: 1 }}>
        STEPS
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 6px' }} role="listbox" aria-label="Automation steps">
        {steps.map((step, i) => {
          const isActive = i === activeStepIndex
          const statusCfg = step.status === 'completed' || step.status === 'done'
            ? { color: '#30ff90', icon: '\u2713', bg: 'rgba(48,255,144,0.06)' }
            : step.status === 'failed'
              ? { color: '#ef4444', icon: '\u2717', bg: 'rgba(239,68,68,0.06)' }
              : step.status === 'awaiting_approval'
                ? { color: '#f59e0b', icon: '\u23F8', bg: 'rgba(245,158,11,0.06)' }
                : step.status === 'running'
                  ? { color: '#38bdf8', icon: '\u25B6', bg: 'rgba(56,189,248,0.06)' }
                  : { color: 'rgba(255,255,255,0.6)', icon: '\u25CB', bg: 'transparent' }

          return (
            <div
              key={step.id || i}
              role="option"
              aria-selected={isActive}
              onClick={() => onStepClick?.(i)}
              className="bq-step-btn"
              style={{
                padding: '8px 10px',
                marginBottom: 4,
                borderRadius: 8,
                cursor: 'pointer',
                background: isActive
                  ? 'linear-gradient(145deg, rgba(168,85,247,0.1) 0%, rgba(56,189,248,0.04) 100%)'
                  : statusCfg.bg,
                border: isActive
                  ? '1px solid rgba(168,85,247,0.3)'
                  : '1px solid transparent',
                transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
              }}
            >
              {/* Step description — normal flow, wraps freely */}
              <div style={{ fontSize: 11, color: '#fff', fontWeight: isActive ? 600 : 500, lineHeight: 1.5, wordBreak: 'break-word' }}>
                <span style={{ color: statusCfg.color, fontWeight: 700, marginRight: 6 }}>{statusCfg.icon}</span>
                {step.description || step.action}
              </div>
              {/* Metadata row */}
              <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap', paddingLeft: 18 }}>
                <span style={{
                  fontFamily: "'JetBrains Mono', monospace", fontSize: 9,
                  padding: '1px 5px', borderRadius: 3,
                  background: `${statusCfg.color}15`, color: statusCfg.color,
                  fontWeight: 600,
                }}>
                  {step.action}
                </span>
                {step.elapsed_ms != null && (
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, color: 'rgba(255,255,255,0.6)' }}>
                    {step.elapsed_ms < 1000 ? `${step.elapsed_ms}ms` : `${(step.elapsed_ms / 1000).toFixed(1)}s`}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </GlassPanel>
  )
}

// ─── Timeline Scrubber ─────────────────────────────────────────────

export function TimelineScrubber({ steps = [], activeStepIndex = -1, onStepClick }) {
  const totalMs = steps.reduce((sum, s) => sum + (s.elapsed_ms || 0), 0) || 1

  return (
    <GlassPanel style={{ display: 'flex', gap: 1, padding: '6px 8px', borderRadius: 8 }}>
      {steps.map((step, i) => {
        const pct = Math.max(((step.elapsed_ms || 0) / totalMs) * 100, 5)
        const isActive = i === activeStepIndex
        const color = step.status === 'completed' || step.status === 'done' ? '#30ff90'
          : step.status === 'failed' ? '#ef4444'
            : step.status === 'awaiting_approval' ? '#f59e0b'
              : step.status === 'running' ? '#38bdf8'
                : 'rgba(255,255,255,0.15)'

        return (
          <button
            key={step.id || i}
            className="bq-scrub-seg"
            onClick={() => onStepClick?.(i)}
            title={`Step ${i + 1}: ${step.description || step.action}`}
            style={{
              flex: `${pct} 0 0`,
              height: 6, borderRadius: 3, cursor: 'pointer',
              background: color,
              opacity: isActive ? 1 : 0.5,
              border: isActive ? '1px solid rgba(168,85,247,0.5)' : '1px solid transparent',
              boxShadow: isActive ? '0 0 6px rgba(168,85,247,0.3)' : 'none',
              transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
              padding: 0,
            }}
          />
        )
      })}
    </GlassPanel>
  )
}

// ─── Detail Panel ──────────────────────────────────────────────────

export function StepDetailPanel({ step, objective }) {
  const [activeTab, setActiveTab] = useState('reasoning')

  if (!step) {
    return (
      <GlassPanel style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 24, marginBottom: 8, opacity: 0.3 }}>{'\u{1F50D}'}</div>
          <div style={{ fontSize: 12, color: '#fff', fontWeight: 600 }}>Select a step</div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginTop: 4 }}>Click a step in the timeline to view details</div>
        </div>
      </GlassPanel>
    )
  }

  const tabs = [
    { id: 'info', label: 'Info' },
    { id: 'reasoning', label: 'Reasoning' },
    { id: 'data', label: 'Data' },
    { id: 'errors', label: 'Errors' },
  ]

  return (
    <GlassPanel style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Tab bar */}
      <div role="tablist" aria-label="Step details" style={{ display: 'flex', gap: 0, padding: '8px 10px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            className="bq-tab-btn"
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '6px 14px', borderRadius: '8px 8px 0 0',
              fontSize: 11, fontWeight: 600, cursor: 'pointer',
              border: 'none',
              color: activeTab === tab.id ? '#fff' : 'rgba(255,255,255,0.6)',
              background: activeTab === tab.id
                ? 'linear-gradient(145deg, rgba(168,85,247,0.1) 0%, rgba(56,189,248,0.04) 100%)'
                : 'transparent',
              borderTop: activeTab === tab.id ? '1px solid rgba(168,85,247,0.3)' : '1px solid transparent',
              transition: 'all 0.2s ease',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {activeTab === 'reasoning' && (
          <div>
            {step.reasoning ? (
              <div style={{
                display: 'flex', gap: 10, alignItems: 'flex-start',
                padding: 12, borderRadius: 10,
                background: 'linear-gradient(145deg, rgba(168,85,247,0.06) 0%, rgba(56,189,248,0.02) 100%)',
                border: '1px solid rgba(168,85,247,0.15)',
              }}>
                <div style={{
                  width: 28, height: 28, borderRadius: 8, flexShrink: 0,
                  background: 'linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 14, color: '#fff',
                }}>{'\uD83E\uDD16'}</div>
                <div>
                  <div style={{ fontSize: 10, color: '#a855f7', fontWeight: 600, marginBottom: 4, letterSpacing: 0.5 }}>
                    AGENT REASONING
                  </div>
                  <div style={{ fontSize: 12, color: '#fff', lineHeight: 1.5 }}>
                    {step.reasoning}
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: 20 }}>
                <div style={{ fontSize: 12, color: '#fff', fontWeight: 600, marginBottom: 4 }}>No reasoning captured</div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>
                  Reasoning is captured when the LLM planner generates the step plan.
                  Steps from fallback keyword planning or manual creation don't have reasoning.
                </div>
              </div>
            )}

            {/* Step context: what was on the page */}
            {step.result?.page_context && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', fontWeight: 600, marginBottom: 4, letterSpacing: 0.5 }}>
                  PAGE CONTEXT AT EXECUTION
                </div>
                <pre style={{
                  fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
                  color: '#fff', background: 'rgba(0,0,0,0.3)',
                  padding: 8, borderRadius: 6, overflow: 'auto',
                  maxHeight: 200, margin: 0, whiteSpace: 'pre-wrap',
                }}>
                  {typeof step.result.page_context === 'string'
                    ? step.result.page_context
                    : JSON.stringify(step.result.page_context, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}
        {activeTab === 'info' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* Warnings */}
            {(step.result?.warnings || step.result?.hint) && (
              <div style={{
                padding: '8px 10px', borderRadius: 8,
                background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)',
              }}>
                {step.result.hint && (
                  <div style={{ fontSize: 11, color: '#f59e0b', fontWeight: 600, marginBottom: 2 }}>
                    {step.result.hint}
                  </div>
                )}
                {step.result.warnings?.map((w, wi) => (
                  <div key={wi} style={{ fontSize: 11, color: '#f59e0b' }}>{w}</div>
                ))}
                {step.result.needs_credentials && (
                  <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', marginTop: 4 }}>
                    Add a credential in Settings {'\u2192'} Vault, or use the wizard with "Needs login" checked.
                  </div>
                )}
              </div>
            )}
            {step.result?.note && (
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', fontStyle: 'italic' }}>
                {step.result.note}
              </div>
            )}
            <DetailRow label="Action" value={step.action} mono />
            <DetailRow label="Description" value={step.description} />
            <DetailRow label="Status" value={step.status} color={
              step.status === 'completed' || step.status === 'done' ? '#30ff90'
                : step.status === 'failed' ? '#ef4444'
                  : step.status === 'awaiting_approval' ? '#f59e0b'
                    : '#38bdf8'
            } />
            {step.elapsed_ms != null && (
              <DetailRow label="Duration" value={`${step.elapsed_ms}ms`} mono />
            )}
            {step.params && Object.keys(step.params).length > 0 && (
              <div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', fontWeight: 600, marginBottom: 4 }}>PARAMETERS</div>
                <pre style={{
                  fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
                  color: '#fff', background: 'rgba(0,0,0,0.3)',
                  padding: 8, borderRadius: 6, overflow: 'auto',
                  maxHeight: 200, margin: 0, whiteSpace: 'pre-wrap',
                }}>
                  {JSON.stringify(step.params, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}
        {activeTab === 'data' && (
          <div>
            {step.result ? (
              <pre style={{
                fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
                color: '#fff', background: 'rgba(0,0,0,0.3)',
                padding: 8, borderRadius: 6, overflow: 'auto',
                maxHeight: 400, margin: 0, whiteSpace: 'pre-wrap',
              }}>
                {typeof step.result === 'string' ? step.result : JSON.stringify(step.result, null, 2)}
              </pre>
            ) : (
              <div style={{ textAlign: 'center', padding: 20, color: 'rgba(255,255,255,0.6)', fontSize: 11 }}>
                No data extracted for this step
              </div>
            )}
          </div>
        )}
        {activeTab === 'errors' && (
          <div>
            {step.status === 'failed' && step.result?.error ? (
              <div style={{
                background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
                borderRadius: 8, padding: 12,
              }}>
                <div style={{ fontSize: 12, color: '#ef4444', fontWeight: 600, marginBottom: 4 }}>Error</div>
                <pre style={{
                  fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
                  color: '#fff', margin: 0, whiteSpace: 'pre-wrap',
                }}>
                  {typeof step.result.error === 'string' ? step.result.error : JSON.stringify(step.result.error, null, 2)}
                </pre>
              </div>
            ) : (
              <div style={{ textAlign: 'center', padding: 20, color: 'rgba(255,255,255,0.6)', fontSize: 11 }}>
                No errors for this step
              </div>
            )}
          </div>
        )}
      </div>
    </GlassPanel>
  )
}

function DetailRow({ label, value, mono, color }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
      <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', fontWeight: 600, minWidth: 70, flexShrink: 0 }}>{label}</span>
      <span style={{
        fontSize: 12, color: color || '#fff', fontWeight: 500,
        fontFamily: mono ? "'JetBrains Mono', monospace" : 'inherit',
      }}>{value || '—'}</span>
    </div>
  )
}

// ─── Viewport Panel ────────────────────────────────────────────────

export function ViewportPanel({ screenshot, isLive, children }) {
  return (
    <GlassPanel style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {screenshot ? (
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          <img
            src={screenshot.startsWith('data:') ? screenshot : screenshot.startsWith('/') || screenshot.startsWith('http') ? screenshot : `data:image/jpeg;base64,${screenshot}`}
            alt="Browser viewport"
            style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }}
          />
          {isLive && (
            <div style={{
              position: 'absolute', top: 8, right: 8,
              padding: '3px 10px', borderRadius: 6,
              background: 'rgba(6,182,212,0.85)', color: '#fff',
              fontSize: 10, fontWeight: 700, letterSpacing: 1,
              boxShadow: '0 0 12px rgba(6,182,212,0.4)',
            }}>
              LIVE
            </div>
          )}
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center' }}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" strokeWidth="1" style={{ stroke: 'rgba(255,255,255,0.6)', marginBottom: 8 }}>
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
            <div style={{ fontSize: 12, color: '#fff', fontWeight: 600 }}>No screenshot</div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', marginTop: 4 }}>Select a step or start watching</div>
          </div>
        </div>
      )}
      {children}
    </GlassPanel>
  )
}

// ─── Exports ───────────────────────────────────────────────────────

export { GlassPanel, GlassButton, Shimmer }
