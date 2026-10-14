/**
 * SessionsOverview (QUOXON J3): the presentational face of GET /api/v1/sessions.
 * Stat tiles from `counts`, sections grouped by agent, one row per live
 * session, a "+N more conversations" fold like the CLI, and a sources strip
 * that names every degraded source with its own note. Data comes in as props;
 * the polling lives in SessionsView so this renders from a fixture in tests.
 *
 * Composition only: qx globals (qx-components.css "Sessions overview").
 */
import { useState, useCallback, useEffect, useRef } from 'react'
import QHorn from '../ui/QHorn'
import {
  prepareIndex, kindLabel, hostLabel, formatAge, degradedSources, tileCounts, agentColor, STATES,
} from './sessionsModel'

// CLI palette (cli/lib/quoxon/theme.js): sky #38bdf8, indigo #6366f1, violet #a855f7, warn #f59e0b, error #f87171.
export const STATE_STOPS = {
  resting: ['#38bdf8', '#38bdf8', '#7dd3fc'],
  working: ['#38bdf8', '#6366f1', '#a855f7'],
  waiting: ['#f59e0b', '#fbbf24', '#f59e0b'],
  failing: ['#f87171', '#ef4444', '#f87171'],
}
const STATE_COLOR = { resting: 'rgba(125,211,252,0.85)', working: '#38bdf8', waiting: '#f59e0b', failing: '#f87171' }
const TILE_LABEL = { live: 'Live', working: 'Working', waiting: 'Waiting', resting: 'Resting', failing: 'Failing' }
const KIND_HUE = { tmux: 'sky', conversation: 'violet', slot: 'teal', resident: 'indigo', workflow: 'amber', objective: 'fuchsia', loop: 'fuchsia' }

export function QState({ state, size = 18 }) {
  const s = STATES.includes(state) ? state : 'resting'
  return (
    <span className={`qx-qstate qx-qstate--${s}`} role="img" aria-label={`state ${state || 'unknown'}`} title={state || 'unknown'} data-testid="qstate">
      <QHorn size={size} stops={STATE_STOPS[s]} />
    </span>
  )
}

const CopyIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
)
const CheckIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
)
const ChevronIcon = ({ open }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: open ? 'rotate(180deg)' : undefined }}>
    <path d="m6 9 6 6 6-6" />
  </svg>
)

function CopyHint({ text }) {
  const [state, setState] = useState('idle')
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text)
      setState('copied')
    } catch {
      setState('failed')
    }
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), 1600)
  }, [text])
  const label = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy attach command'
  return (
    <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={copy} aria-label={label} title={label}>
      {state === 'copied' ? CheckIcon : CopyIcon}
    </button>
  )
}

function SessionRow({ row, now, serverHost }) {
  const extra = row.state_reason
  return (
    <div className={`qx-session-row qx-session-row--${row.state}`} data-testid="session-row" data-state={row.state} data-kind={row.kind}>
      <QState state={row.state} />
      <div className="qx-session-row__main">
        <span className="qx-session-row__name" title={row.name}>{row.name || '(unnamed)'}</span>
        <span className="qx-session-row__meta">
          <span className={`qx-chip qx-chip--xs qx-chip--static qx-chip--hue-${KIND_HUE[row.kind] || 'slate'}`}>{kindLabel(row)}</span>
          <span style={{ color: STATE_COLOR[row.state] }}>{row.state}</span>
          {row.slot ? <span className="qx-chip qx-chip--xs qx-chip--static">slot {row.slot}</span> : null}
          {extra ? <span>{extra}</span> : null}
        </span>
      </div>
      <span className="qx-session-row__cell qx-session-row__cell--host" title={hostLabel(row, serverHost)}>{hostLabel(row, serverHost)}</span>
      <span className="qx-session-row__cell qx-session-row__cell--age" title={row.last_active || ''}>{formatAge(row.last_active, now)}</span>
      <span className="qx-session-row__attach">
        {row.attach_hint
          ? <><code className="qx-code" title={row.attach_hint}>{row.attach_hint}</code><CopyHint text={row.attach_hint} /></>
          : <span className="qx-hint">no attach command</span>}
      </span>
    </div>
  )
}

function SourcesStrip({ sources }) {
  const bad = degradedSources({ sources })
  if (!sources || !sources.length) return null
  return (
    <div className="qx-stack" style={{ gap: 8 }} data-testid="sessions-sources">
      <div className="qx-row qx-row--tight" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="qx-hint">Sources</span>
        {sources.map((s) => (
          <span
            key={s.id}
            className={`qx-pill qx-pill--sm ${s.state === 'connected' ? 'qx-pill--online' : s.state === 'unavailable' ? 'qx-pill--ghost' : 'qx-pill--danger'}`}
            title={`${s.label || s.id}: ${s.state}${s.note ? ` (${s.note})` : ''}`}
            data-testid={`source-${s.id}`}
          >
            {s.id} {s.state === 'connected' ? `· ${s.count ?? 0}` : `· ${s.state}`}
          </span>
        ))}
      </div>
      {bad.length > 0 && (
        <ul className="qx-hint" style={{ margin: 0, paddingLeft: 18 }} data-testid="sessions-degraded">
          {bad.map((s) => (
            <li key={s.id}><b>{s.label || s.id}</b>: {s.state}{s.note ? `, ${s.note}` : ''}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Props: index (the API body or null), error ({status, message} or null),
 * loading, now (ms, ticks), lastOkAt (ms of last good fetch), agentColorOf (id -> colour or null).
 */
export default function SessionsOverview({ index, error, loading, now = Date.now(), lastOkAt = null, agentColorOf }) {
  const [expanded, setExpanded] = useState(false)

  if (loading && !index) {
    return (
      <section className="qx-card" data-testid="sessions-loading">
        <div className="qx-skeleton qx-skeleton--line-md" style={{ width: '60%' }} />
      </section>
    )
  }

  if (!index) {
    return (
      <section className="qx-card" data-testid="sessions-error">
        <div className="qx-empty">
          <div className="qx-empty__title">Sessions index unavailable</div>
          <div className="qx-empty__body">
            {error ? `${error.status ? `HTTP ${error.status}: ` : ''}${error.message}` : 'No response yet.'} Retrying every 5 seconds.
          </div>
        </div>
      </section>
    )
  }

  const counts = tileCounts(index)
  const prepared = prepareIndex(index, { expanded })
  const serverHost = index.server_host || null

  return (
    <div className="qx-stack">
      {error && (
        <div className="qx-banner qx-banner--warn" data-testid="sessions-stale">
          Last refresh failed ({error.status ? `HTTP ${error.status}: ` : ''}{error.message}). Showing the index from {lastOkAt ? formatAge(new Date(lastOkAt).toISOString(), now) : 'earlier'}.
        </div>
      )}

      <section className="qx-card">
        <div className="qx-session-tiles" data-testid="sessions-tiles">
          {['live', ...STATES].map((k) => (
            <div className="qx-stat" key={k} data-testid={`tile-${k}`}>
              <div className="qx-stat__head">
                {k === 'live' ? <QState state="working" size={14} /> : <QState state={k} size={14} />}
                <span>{TILE_LABEL[k]}</span>
              </div>
              <div className="qx-stat__value" style={k !== 'live' && counts[k] > 0 && (k === 'waiting' || k === 'failing') ? { color: STATE_COLOR[k] } : undefined}>
                {counts[k]}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="qx-card">
        {counts.live === 0 && prepared.shown === 0 ? (
          <div className="qx-empty" data-testid="sessions-empty">
            <div className="qx-empty__title">No live sessions in this org</div>
            <div className="qx-empty__body">
              Start one with <code className="qx-code">quox claude</code> (it heartbeats here), open a conversation with
              {' '}<code className="qx-code">quox</code>, or hold a slot. Degraded sources below may be hiding some.
            </div>
          </div>
        ) : (
          <div className="qx-stack">
            {prepared.groups.map((g) => {
              const color = agentColor(g.agent, agentColorOf)
              return (
                <div key={g.agent || '__none'} data-testid="sessions-group" data-agent={g.agent || ''}>
                  <div className="qx-session-agent">
                    <span className="qx-session-agent__swatch" style={{ color }} aria-hidden="true" />
                    <span className="qx-session-agent__name" style={{ color: g.agent ? color : undefined }}>{g.agent || 'no agent'}</span>
                    <span className="qx-hint">{g.rows.length}</span>
                  </div>
                  <div className="qx-session-list">
                    {g.rows.map((r) => <SessionRow key={`${r.kind}:${r.id || r.name}:${r.host || ''}`} row={r} now={now} serverHost={serverHost} />)}
                  </div>
                </div>
              )
            })}
            {prepared.foldable > 0 && (
              <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" style={{ alignSelf: 'flex-start' }} onClick={() => setExpanded((v) => !v)} data-testid="sessions-fold">
                <ChevronIcon open={expanded} />
                {expanded ? 'Show fewer conversations' : `+${prepared.hiddenConversations} more conversations (last 24 h)`}
              </button>
            )}
          </div>
        )}
      </section>

      <section className="qx-card qx-card--compact">
        <SourcesStrip sources={index.sources} />
        <div className="qx-hint" style={{ marginTop: 8 }}>
          {index.generated_at ? `Index generated ${formatAge(index.generated_at, now)}` : 'Index time unknown'}
          {serverHost ? ` on ${serverHost}` : ''} · refreshes every 5 s · same data as <code className="qx-code">quox sessions</code>
        </div>
      </section>
    </div>
  )
}
