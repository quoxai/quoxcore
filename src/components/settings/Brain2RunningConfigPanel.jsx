/**
 * Brain2RunningConfigPanel: BRAIN2-V2 V2-10 "Settings truth".
 *
 * For every allowlisted quoxbrain knob: the STORED value (the org/instance
 * setting from the platform settings store), the EFFECTIVE value the running
 * brain actually uses (quoxbrain GET /brain/config/effective), where it came
 * from, and a DRIFT marker when they disagree (stored but not yet applied,
 * or applied only after a restart). Env-only knobs are shown honestly as set
 * by the server environment and not editable here.
 *
 * Best-effort: an unreachable brain or a non-admin caller shows an honest
 * "unavailable"; it never fails the cockpit.
 */

import { useEffect, useState } from 'react'
import SettingsCard from './SettingsCard'
import { fetchPlatformFlags } from '../../services/platformFlagsClient'

const SOURCE_LABEL = {
    setting: 'Setting',
    env: 'Environment',
    default: 'Default',
    'last-known-good': 'Last known good',
    unknown: 'Unknown',
}

const REFRESH_MS = 30000

function sameValue(a, b) {
    if (a === b) return true
    const na = Number(a)
    const nb = Number(b)
    return a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb) && na === nb
}

/**
 * Pure: merge the brain's effective knobs with the stored flags into display rows.
 * drift: null | 'restart' (stored, differs, applies after restart) | 'pending'
 * (stored, differs, should be live) | 'degraded' (brain could not read the setting).
 */
export function buildRows(knobs, flags) {
    const byKey = new Map((flags || []).map((f) => [f.key, f]))
    return (knobs || []).map((k) => {
        const flag = byKey.get(k.key)
        const stored = flag && flag.source === 'setting' ? String(flag.value) : null
        const envOnly = k.scope === 'env'
        let drift = null
        if (k.source === 'unknown' || k.source === 'last-known-good') drift = 'degraded'
        else if (stored !== null && !sameValue(stored, k.effective)) drift = k.restartRequired ? 'restart' : 'pending'
        return { ...k, stored, envOnly, drift }
    })
}

function DriftPill({ drift }) {
    if (!drift) return null
    const text = {
        restart: 'DRIFT: stored, applies after restart',
        pending: 'DRIFT: stored, not yet applied',
        degraded: 'DRIFT: brain could not read the setting',
    }[drift]
    return <span className="qx-pill qx-pill--warn qx-pill--sm" data-testid="running-config-drift">{text}</span>
}

export default function Brain2RunningConfigPanel({ client, authFetch, refreshKey }) {
    const [state, setState] = useState(undefined) // undefined = loading, null = unavailable, {rows}
    useEffect(() => {
        let alive = true
        const load = async () => {
            try {
                if (typeof client?.getEffectiveConfig !== 'function') throw new Error('unsupported')
                const [eff, flags] = await Promise.all([
                    client.getEffectiveConfig(),
                    // Stored values are best-effort: without them the panel still shows effective truth.
                    fetchPlatformFlags(authFetch).catch(() => []),
                ])
                if (alive) setState({ rows: buildRows(eff.knobs, flags) })
            } catch {
                if (alive) setState(null)
            }
        }
        load()
        const timer = setInterval(load, REFRESH_MS)
        const onFocus = () => { load() }
        window.addEventListener('focus', onFocus)
        return () => {
            alive = false
            clearInterval(timer)
            window.removeEventListener('focus', onFocus)
        }
    }, [client, authFetch, refreshKey])

    if (state === undefined) return null
    if (state === null) {
        return (
            <SettingsCard title="Running configuration" glass>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--ui-text-muted)' }} data-testid="running-config-unavailable">
                    The running configuration is unavailable (the Qortex service did not answer, or this needs an org admin).
                </p>
            </SettingsCard>
        )
    }

    const driftCount = state.rows.filter((r) => r.drift).length
    return (
        <SettingsCard
            title="Running configuration"
            subtitle={driftCount ? `${driftCount} setting${driftCount === 1 ? '' : 's'} differ from what the brain is running.` : 'What the brain is actually running matches what is stored.'}
            glass
        >
            <div className="qx-card" data-testid="running-config">
                <table className="qx-table">
                    <thead>
                        <tr><th>Knob</th><th>Stored</th><th>Running</th><th>Source</th><th>Status</th></tr>
                    </thead>
                    <tbody>
                        {state.rows.map((r) => (
                            <tr key={r.key} data-testid={`running-config-${r.key}`}>
                                <td style={{ overflowWrap: 'anywhere' }}>{r.key}</td>
                                <td>{r.envOnly ? <span style={{ color: 'var(--ui-text-muted)' }}>n/a</span> : (r.stored ?? <span style={{ color: 'var(--ui-text-muted)' }}>none</span>)}</td>
                                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{r.source === 'unknown' ? 'not known (settings lookup failed; fails closed)' : r.effective}</td>
                                <td><span className="qx-pill qx-pill--sm">{SOURCE_LABEL[r.source] || r.source}</span></td>
                                <td>
                                    <DriftPill drift={r.drift} />
                                    {r.envOnly && (
                                        <span style={{ fontSize: 12, color: 'var(--ui-text-muted)' }} data-testid="running-config-envonly">
                                            Set by the server environment, not editable here
                                        </span>
                                    )}
                                    {!r.envOnly && !r.drift && r.restartRequired && (
                                        <span style={{ fontSize: 12, color: 'var(--ui-text-muted)' }}>Changes need a restart</span>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </SettingsCard>
    )
}
