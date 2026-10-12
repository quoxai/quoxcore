/**
 * QUOXHAT P0 — read-only "tool load per turn" baseline panel.
 *
 * Shows, per agent, the live resolved tool count with its origin
 * decomposition (hardcoded grant / DB descriptor / connector / entity) and
 * cap status per provider leg, straight from the collector's org-scoped
 * recorder (turnToolStats.js). Measurement only: no hat behaviour exists
 * yet, and nothing here is editable. The same numbers appear on the Mirror
 * (Cognitive Topology) so Settings and Mirror can never disagree.
 */

import { useCallback, useEffect, useState } from 'react'
import SettingsCard, { SettingsGroup } from './SettingsCard'
import Button from '../ui/Button'
import { fetchToolTurnStats } from '../../services/toolTurnStatsClient'

const RefreshIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M23 4v6h-6M1 20v-6h6" />
    <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
  </svg>
)

function OriginsLine({ origins }) {
  if (!origins) return <span style={{ color: 'rgba(255,255,255,0.7)' }}>no origin data</span>
  const parts = [
    ['grant', origins.hardcoded],
    ['db', origins.db],
    ['connector', origins.connector],
    ['entity', origins.entity],
    ['other', origins.other],
  ].filter(([, n]) => n > 0)
  return (
    <span>
      {parts.map(([label, n], i) => (
        <span key={label}>
          {i > 0 && ' · '}
          {n} {label}
        </span>
      ))}
    </span>
  )
}

export default function ToolTurnBaselinePanel({ authFetch }) {
  const [state, setState] = useState({ loading: true, error: null, agents: {}, entries: [] })

  const load = useCallback(async () => {
    setState(s => ({ ...s, loading: true }))
    const r = await fetchToolTurnStats(authFetch)
    setState({
      loading: false,
      error: r.ok ? null : r.error,
      agents: r.agents,
      entries: r.entries,
    })
  }, [authFetch])

  useEffect(() => { load() }, [load])

  const agentRows = Object.entries(state.agents)
    .sort((a, b) => (b[1].lastTs || '').localeCompare(a[1].lastTs || ''))

  const fallbackEvents = state.entries.filter(e => e.leg === 'openai_fallback')

  return (
    <SettingsCard
      title="Tool Load per Turn"
      subtitle="Live per-agent resolved tool counts, origin breakdown and provider cap status (QuoxHat P0 baseline, read-only). Counts appear after a chat turn runs."
      headerActions={
        <Button size="sm" variant="ghost" onClick={load} disabled={state.loading} icon={<RefreshIcon />}>
          Refresh
        </Button>
      }
    >
      <SettingsGroup>
        {state.error && (
          <div style={{ color: 'var(--ui-red-light, #ff8080)' }}>
            Could not load turn stats: {state.error}
          </div>
        )}
        {!state.error && !state.loading && agentRows.length === 0 && (
          <div style={{ color: 'rgba(255,255,255,0.7)' }}>
            No turns recorded since the collector last started. Run a chat turn, then refresh.
          </div>
        )}
        {agentRows.length > 0 && (
          <table className="qx-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Resolved → sent</th>
                <th>Origins (resolved set)</th>
                <th>Hat</th>
                <th>Leg / provider</th>
                <th>Capped turns</th>
              </tr>
            </thead>
            <tbody>
              {agentRows.map(([agent, a]) => (
                <tr key={agent}>
                  <td>{agent}</td>
                  <td>
                    {a.lastRaw ?? '—'} → {a.lastFinal ?? '—'}
                    {a.lastRaw != null && a.lastFinal != null && a.lastFinal < a.lastRaw && (
                      <span className="qx-pill" style={{ marginLeft: 8 }}>capped</span>
                    )}
                  </td>
                  <td><OriginsLine origins={a.lastOrigins} /></td>
                  <td>
                    {a.lastHat ? (
                      <>
                        {a.lastHat.hat_key} v{a.lastHat.hat_revision}
                        <span className="qx-pill" style={{ marginLeft: 6 }}>
                          {a.lastHat.enforced ? 'enforced' : 'preview'}
                        </span>
                      </>
                    ) : '—'}
                  </td>
                  <td>{a.lastLeg || '—'} / {a.lastProvider || '—'}</td>
                  <td>{a.truncatedTurns} truncated · {a.fallbackCapTurns} fallback-leg</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {fallbackEvents.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <strong>OpenAI fallback-leg cap events</strong> (the #653 case: primary down, tools capped to fit the fallback provider):
            <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
              {fallbackEvents.slice(0, 5).map((e, i) => (
                <li key={i}>
                  {e.ts?.replace('T', ' ').slice(0, 19)} · {e.agent}: {e.raw} → {e.final} tools (cap {e.cap}{e.smart ? ', query-aware' : ''})
                </li>
              ))}
            </ul>
          </div>
        )}
      </SettingsGroup>
    </SettingsCard>
  )
}
