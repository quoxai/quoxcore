/**
 * QUOXHAT P3 — provider certification matrix (read-only).
 *
 * Renders the collector's PROVIDER_COMPAT verbatim: per-provider tool
 * constraints and the HONEST proof status (live proven / unit tested /
 * none). This panel is the user-visible face of the certification rule:
 * no "works on provider X" claim without a matching matrix entry.
 */

import { useEffect, useState } from 'react'
import SettingsCard, { SettingsGroup } from './SettingsCard'

const PROOF_LABELS = {
  live_proven: { text: 'live proven', color: 'rgba(110,231,183,0.95)' },
  unit_tested: { text: 'unit tested', color: 'rgba(252,211,77,0.95)' },
  none: { text: 'not driven', color: 'rgba(252,165,165,0.95)' },
  'n/a': { text: 'n/a', color: 'rgba(255,255,255,0.5)' },
}

function Proof({ status }) {
  const p = PROOF_LABELS[status] || PROOF_LABELS.none
  return <span style={{ color: p.color }}>{p.text}</span>
}

export default function ProviderCertificationPanel({ authFetch }) {
  const [state, setState] = useState({ providers: null, error: null })

  useEffect(() => {
    let cancelled = false
    const doFetch = authFetch || fetch
    ;(async () => {
      try {
        // await tolerates fetch doubles that return undefined (test mocks)
        const resp = await doFetch('/collector/api/v1/observability/provider-compat', { signal: AbortSignal.timeout(10000) })
        if (!resp || !resp.ok) throw new Error(resp ? `HTTP ${resp.status}` : 'no response')
        const body = await resp.json()
        if (!cancelled) setState({ providers: body.providers, error: null })
      } catch (err) {
        if (!cancelled) setState({ providers: null, error: err?.message || 'network_error' })
      }
    })()
    return () => { cancelled = true }
  }, [authFetch])

  return (
    <SettingsCard
      title="Provider Certification"
      subtitle="Per-provider tool-calling constraints and honest proof status. A hat manifest must fit every certified provider; under enforcement, failover skips incompatible providers with a named reason instead of mutating the tool set."
    >
      <SettingsGroup>
        {state.error && (
          <div style={{ color: 'var(--ui-red-light, #ff8080)' }}>Could not load the matrix: {state.error}</div>
        )}
        {state.providers && (
          <table className="qx-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Tool loop</th>
                <th>Tool cap</th>
                <th>Primary</th>
                <th>Fallback</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(state.providers).map(([key, p]) => (
                <tr key={key}>
                  <td>{p.label}</td>
                  <td>{p.toolLoop ? 'yes' : 'no'}</td>
                  <td>{p.toolLoop ? (p.toolCap === null ? 'none' : p.toolCap) : '—'}</td>
                  <td><Proof status={p.proof?.primary} /></td>
                  <td><Proof status={p.proof?.fallback} /></td>
                  <td style={{ maxWidth: 320, color: 'rgba(255,255,255,0.7)' }}>{p.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SettingsGroup>
    </SettingsCard>
  )
}
