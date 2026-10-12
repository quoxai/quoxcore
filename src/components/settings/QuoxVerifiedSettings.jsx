/**
 * LICENSE-LAUNCH LL-9i3 — Quox Verified settings panel.
 *
 * NO-ENV-ONLY-CONFIG (owner hard rule): the WARD "quox-verified" sink switch
 * used to live only in the env flag WARD_QUOX_VERIFIED_ENABLED. This panel is
 * the dashboard-visible, admin-writable surface over the server-side
 * instance_config value (licensing.quox_verified.enabled) that now backs it.
 * The env flag stays as the fallback DEFAULT; the instance_config value the
 * admin sets here WINS.
 *
 *   GET   /api/admin/quox-verified/config  -> { enabled, source, envDefault }
 *   PATCH /api/admin/quox-verified/config  { enabled } -> { enabled, source }
 * (instance-admin gated in services/auth/routes/quox-verified-config.js).
 */

import { useState, useEffect, useCallback } from 'react'
import SettingsCard, { SettingsGroup } from './SettingsCard'
import { SettingItem } from '../ui/Input'
import { csrfFetch } from '../../utils/csrfFetch'
import { buildAuthApiUrl } from '../../services/authApiUrl'

const CONFIG_PATH = '/admin/quox-verified/config'

export default function QuoxVerifiedSettings({ onNotification }) {
  const [state, setState] = useState(null) // { enabled, source, envDefault }
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(buildAuthApiUrl(CONFIG_PATH), { credentials: 'include' })
      if (!res.ok) throw new Error(`Could not load current state (HTTP ${res.status})`)
      setState(await res.json())
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleToggle = async (enabled) => {
    setSaving(true)
    const prev = state
    setState((s) => ({ ...s, enabled, source: 'instance_config' })) // optimistic
    try {
      const res = await csrfFetch(buildAuthApiUrl(CONFIG_PATH), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ enabled }),
      })
      if (!res.ok) throw new Error(`Failed to update (HTTP ${res.status})`)
      const result = await res.json()
      setState((s) => ({ ...s, ...result }))
      onNotification?.(`Quox Verified ${enabled ? 'enabled' : 'disabled'} for this instance.`, 'success')
    } catch (err) {
      setState(prev)
      onNotification?.(err.message || 'Failed to update Quox Verified', 'error')
    } finally {
      setSaving(false)
    }
  }

  const subtitle = 'Countersign this instance’s WARD tip digests with the Quox control plane. Additive only — it never gates local evidence, and turning it off leaves every local receipt intact.'

  if (loading) {
    return (
      <SettingsCard title="Quox Verified" subtitle={subtitle} glass>
        <p style={{ color: 'var(--ui-text-muted)', fontSize: 13, margin: 0 }}>Loading…</p>
      </SettingsCard>
    )
  }

  const sourceNote = state?.source === 'instance_config'
    ? 'Set for this instance.'
    : `Using the environment default (${state?.envDefault ? 'on' : 'off'}).`

  const description = [
    'When on, each WARD tip digest is submitted to the control plane for an Ed25519 countersignature. The digest only, never the evidence.',
    `Currently ${state?.enabled ? 'ON' : 'OFF'} — ${sourceNote}`,
  ].join(' ')

  return (
    <SettingsCard title="Quox Verified" subtitle={subtitle} glass>
      {error && (
        <p style={{ color: '#ef4444', fontSize: 12, margin: '0 0 12px' }}>{error}</p>
      )}
      <SettingsGroup>
        <SettingItem
          label="Countersign WARD tips with Quox"
          description={description}
          checked={!!state?.enabled}
          onChange={(e) => handleToggle(e.target.checked)}
          disabled={saving}
        />
      </SettingsGroup>
    </SettingsCard>
  )
}
