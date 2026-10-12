/**
 * QUOXHAT P1 — hat catalogue + manual selection panel (Settings).
 *
 * PREVIEW, honestly labelled: hats and defaults are stored server-side and
 * audited, but NOTHING here changes which tools a chat turn executes until
 * P2 wires the collector turn manifest. The label must not overclaim.
 */

import { useCallback, useEffect, useState } from 'react'
import SettingsCard, { SettingsGroup } from './SettingsCard'
import Button from '../ui/Button'
import { fetchHats, setOrgDefaultHat, setUserDefaultHat, setOrgEnforcement, setOrgSelectionMode } from '../../services/quoxhatClient'

const HatIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M4 17c0-1.5 3.6-3 8-3s8 1.5 8 3-3.6 3-8 3-8-1.5-8-3z" />
    <path d="M8 16.2V9a4 4 0 118 0v7.2" />
  </svg>
)

export default function QuoxHatPanel({ authFetch, currentOrg, canManageOrg = false, onNotification }) {
  const orgId = currentOrg?.id
  const [state, setState] = useState({ loading: true, error: null, hats: [], settings: null })
  const [busyHat, setBusyHat] = useState(null)
  const [userDefault, setUserDefault] = useState(null)

  const load = useCallback(async () => {
    if (!orgId) return
    setState(s => ({ ...s, loading: true }))
    const r = await fetchHats(authFetch, orgId)
    setState({ loading: false, error: r.error || null, hats: r.hats, settings: r.settings })
  }, [authFetch, orgId])

  useEffect(() => { load() }, [load])

  const notify = (msg, type = 'success') => {
    if (onNotification) onNotification(msg, type)
  }

  const handleSetOrgDefault = async (hat) => {
    setBusyHat(hat.id)
    try {
      await setOrgDefaultHat(authFetch, orgId, hat.id)
      notify(`Org default hat set to ${hat.name} (preview, not yet enforced)`)
      await load()
    } catch (err) {
      notify(`Could not set org default: ${err.message}`, 'error')
    } finally {
      setBusyHat(null)
    }
  }

  const handleSetUserDefault = async (hat) => {
    setBusyHat(hat.id)
    try {
      await setUserDefaultHat(authFetch, orgId, hat.id)
      setUserDefault(hat.id)
      notify(`Your default hat is now ${hat.name} (preview, not yet enforced)`)
    } catch (err) {
      notify(`Could not set your default: ${err.message}`, 'error')
    } finally {
      setBusyHat(null)
    }
  }

  const summarizeDef = (def) => {
    if (!def) return 'no definition'
    const explicit = def.tools?.explicit?.length || 0
    const bundles = def.tools?.bundles?.length || 0
    const specialists = def.agents?.specialists?.length || 0
    return `${explicit} direct tools · ${bundles} bundles · ${specialists} specialists · budget ${def.budgets?.initial_tool_target}/${def.budgets?.max_manifest}`
  }

  return (
    <SettingsCard
      title="QuoxHat Modes"
      subtitle="Named, bounded capability profiles (agents + tools + context) resolved server-side. In preview, selection is stored and audited without changing executed tools; under enforcement every turn is bounded to its hat manifest."
      icon={<HatIcon />}
      status="warning"
      statusText="Preview"
    >
      <SettingsGroup>
        {state.error && (
          <div style={{ color: 'var(--ui-red-light, #ff8080)' }}>Could not load hats: {state.error}</div>
        )}
        {!state.error && state.hats.length > 0 && (
          <table className="qx-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Hat</th>
                <th>Purpose</th>
                <th>Composition</th>
                <th>Rev</th>
                <th>Default</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {state.hats.map(hat => {
                const isOrgDefault = state.settings?.default_hat_id === hat.id
                const isUserDefault = userDefault === hat.id
                return (
                  <tr key={hat.id}>
                    <td>
                      {hat.name}
                      {hat.template_key && <span className="qx-pill" style={{ marginLeft: 6 }}>built-in</span>}
                      {hat.definition?.transitions?.privileged && <span className="qx-pill" style={{ marginLeft: 6 }}>privileged</span>}
                    </td>
                    <td style={{ maxWidth: 260 }}>{hat.purpose}</td>
                    <td>{summarizeDef(hat.definition)}</td>
                    <td>v{hat.current_revision}</td>
                    <td>
                      {isOrgDefault && <span className="qx-pill">org</span>}
                      {isUserDefault && <span className="qx-pill" style={{ marginLeft: 4 }}>you</span>}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <Button size="xs" variant="ghost" disabled={busyHat === hat.id} onClick={() => handleSetUserDefault(hat)}>
                        Set my default
                      </Button>
                      {canManageOrg && (
                        <Button size="xs" variant="ghost" disabled={busyHat === hat.id || isOrgDefault} onClick={() => handleSetOrgDefault(hat)} style={{ marginLeft: 6 }}>
                          Set org default
                        </Button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        {state.settings && (
          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ color: 'rgba(255,255,255,0.7)' }}>
              Selection mode:{' '}
              {canManageOrg ? (
                <select
                  className="glass-btn"
                  value={state.settings.selection_mode}
                  disabled={busyHat === '__selection__'}
                  title="manual: binding → user default → org default. automatic: a specialist agent-match beats defaults (never a privileged hat). hybrid: agent-match only fills the gap after the user's own default. A conversation binding always wins."
                  style={{ padding: '2px 6px' }}
                  onChange={async (e) => {
                    const next = e.target.value
                    setBusyHat('__selection__')
                    try {
                      await setOrgSelectionMode(authFetch, orgId, next)
                      notify(`Hat selection mode is now ${next} for this org`)
                      await load()
                    } catch (err) {
                      notify(`Could not change selection mode: ${err.message}`, 'error')
                    } finally {
                      setBusyHat(null)
                    }
                  }}
                >
                  <option value="manual">manual</option>
                  <option value="automatic">automatic</option>
                  <option value="hybrid">hybrid</option>
                </select>
              ) : (
                state.settings.selection_mode
              )}
              {' '}· Enforcement: <strong style={{ color: '#fff' }}>{state.settings.enforcement}</strong>
              {state.settings.enforcement === 'preview' && ' (turns still load the agent’s full resolved tool set)'}
              {state.settings.enforcement === 'enforce' && ' (every turn is bounded to its hat manifest)'}
            </span>
            {canManageOrg && (
              <Button
                size="xs"
                variant={state.settings.enforcement === 'enforce' ? 'outline-amber' : 'outline-red'}
                disabled={busyHat === '__enforcement__'}
                onClick={async () => {
                  const next = state.settings.enforcement === 'enforce' ? 'preview' : 'enforce'
                  if (next === 'enforce' && !window.confirm(
                    'Enable hat enforcement for this ENTIRE org?\n\nEvery chat turn will be bounded to its hat manifest. Agents lose direct access to tools outside the active hat (they can still discover, load bundles, delegate, or propose a switch). This is audited.'
                  )) return
                  setBusyHat('__enforcement__')
                  try {
                    await setOrgEnforcement(authFetch, orgId, next)
                    notify(`Hat enforcement is now ${next} for this org`)
                    await load()
                  } catch (err) {
                    notify(`Could not change enforcement: ${err.message}`, 'error')
                  } finally {
                    setBusyHat(null)
                  }
                }}
              >
                {state.settings.enforcement === 'enforce' ? 'Back to preview' : 'Enable enforcement'}
              </Button>
            )}
          </div>
        )}
      </SettingsGroup>
    </SettingsCard>
  )
}
