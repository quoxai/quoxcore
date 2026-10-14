/**
 * App URL (Settings > General). The public address of this Quox instance,
 * used in sign-in links, invites and verification emails.
 *
 * Server-side source of truth: instance_config `app_base_url`, read/written via
 *   GET /api/admin/instance/basics -> { basics: { appBaseUrl }, effective: { appBaseUrl, appBaseUrlSource } }
 *   PUT /api/admin/instance/basics { appBaseUrl: string | null }
 * (instance-admin gated, audited, services/auth/routes/admin-instance.js).
 * Non-admins get a 401/403 on the GET and this panel renders nothing.
 * CLI parity: `quox server config app-url [url]`.
 */
import { useState, useEffect, useCallback } from 'react'
import SettingsSection from './SettingsSection'
import SettingsCard, { SettingsGroup } from './SettingsCard'
import { Input, FormField } from '../ui/Input'
import Button from '../ui/Button'
import { csrfFetch } from '../../utils/csrfFetch'
import { buildAuthApiUrl } from '../../services/authApiUrl'

const PATH = '/admin/instance/basics'

export default function AppUrlSettings({ onNotification }) {
  const [state, setState] = useState({ loading: true, hidden: false, error: null, data: null })
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [fieldError, setFieldError] = useState(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(buildAuthApiUrl(PATH), { credentials: 'include' })
      if (res.status === 401 || res.status === 403) { setState({ loading: false, hidden: true, error: null, data: null }); return }
      if (!res.ok) throw new Error(`Could not load the App URL (HTTP ${res.status})`)
      const data = await res.json()
      setValue(data.basics?.appBaseUrl || '')
      setState({ loading: false, hidden: false, error: null, data })
    } catch (err) {
      setState({ loading: false, hidden: false, error: err.message, data: null })
    }
  }, [])

  useEffect(() => { load() }, [load])

  const save = async (next) => {
    setSaving(true)
    setFieldError(null)
    try {
      const res = await csrfFetch(buildAuthApiUrl(PATH), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ appBaseUrl: next }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        const msg = body.errors?.join('; ') || body.message || `Failed to save (HTTP ${res.status})`
        setFieldError(msg)
        onNotification?.(msg, 'error')
        return
      }
      onNotification?.(next ? 'App URL saved.' : 'App URL cleared; using the environment value.', 'success')
      await load()
    } catch (err) {
      setFieldError(err.message)
      onNotification?.(err.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  if (state.hidden) return null

  const stored = state.data?.basics?.appBaseUrl || ''
  const effective = state.data?.effective
  const dirty = value.trim() !== stored

  return (
    <SettingsSection
      title="App URL"
      description="The public address of this instance, used in sign-in links, invites and emails."
    >
      <SettingsCard glass>
        <SettingsGroup>
          {state.loading && <p style={{ color: 'var(--ui-text-muted)', fontSize: 13, margin: 0 }}>Loading…</p>}
          {state.error && <p role="alert" style={{ color: 'var(--ui-danger, #ef4444)', fontSize: 13, margin: 0 }}>{state.error}</p>}
          {state.data && (
            <>
              <FormField
                label="App URL"
                htmlFor="app-url"
                error={fieldError}
                hint={effective ? `In use now: ${effective.appBaseUrl} (${effective.appBaseUrlSource === 'instance_config' ? 'set here' : 'from the environment'})` : undefined}
              >
                <Input
                  id="app-url"
                  type="url"
                  placeholder="https://quox.example.com"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              </FormField>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button variant="primary" disabled={saving || !dirty || !value.trim()} onClick={() => save(value.trim())}>Save</Button>
                {stored && <Button variant="ghost" disabled={saving} onClick={() => save(null)}>Use environment value</Button>}
              </div>
            </>
          )}
        </SettingsGroup>
      </SettingsCard>
    </SettingsSection>
  )
}
