/**
 * PlatformFlagsPanel — Phase 25 (owner mandate 2026-08-06: a read-only
 * capability list is explicitly NOT what was asked for; this is the write
 * surface).
 *
 * Renders a subset of the platform settings (filtered by `keys`) as real
 * controls, each showing a plain-English description, its current
 * effective value, and where that value came from (an org setting, or the
 * env default). Reused across Settings sections (Privacy, Execution Policy,
 * QuoxMind, Qortex/Feed) instead of one flat "Platform Flags" page, so each
 * flag lives where an admin would already look for it.
 *
 * VAULT-INTEG P14 slice 1: a flag's `type` (from the API) decides the
 * control — 'boolean' renders the original Toggle, 'enum' a Select,
 * 'number' a numeric Input, 'string' a text Input. Same load/save/optimistic-
 * update flow for all four; only the rendered control and the value read off
 * the DOM event differ.
 *
 * VAULT-INTEG P17: this panel originally only knew how to render an
 * explicit `keys` allow-list per instance — every settings page curated its
 * own array by hand, so a newly-promoted settable entry stayed invisible
 * until someone remembered to add its key to the right page's list. This
 * panel now also accepts a `group` (the registry's `group` field —
 * memory/feed/governance/privacy/screencap/storage/integrations/...): every
 * settable entry carrying that group renders automatically, including ones
 * that land after this page shipped. `keys` still works standalone (an
 * explicit allow-list, e.g. a single entry pulled out of a group shared with
 * unrelated settings) and can combine with `group` to narrow it further.
 * At least one of `keys`/`group` must be given or nothing renders.
 *
 * Data: GET/PATCH /collector/api/v1/platform/settings/flags (admin-only
 * write, org-scoped, audited — see services/collector/lib/platformSettingsStore.js).
 */

import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import SettingsCard, { SettingsGroup } from './SettingsCard'
import { Toggle, Input, Select } from '../ui/Input'
import Badge from '../ui/Badge'
import { fetchPlatformFlags, setPlatformFlag, setPlatformSetting } from '../../services/platformFlagsClient'

/**
 * Some settings panels (ExecutionPolicySettings) receive `authFetch` as a
 * prop from their parent rather than pulling it from AuthContext directly —
 * useful in isolation/tests with no AuthProvider mounted. Prefer an
 * explicitly-passed authFetch; only fall back to useAuth() when none was
 * given. useAuth() is still called unconditionally every render (rules of
 * hooks) — only whether its context is required is conditional.
 */
function useResolvedAuthFetch(explicitAuthFetch) {
  let ctx = null
  try {
    ctx = useAuth()
  } catch {
    ctx = null
  }
  return explicitAuthFetch || ctx?.authFetch
}

function sourceLabel(flag) {
  if (flag.source === 'setting') return 'set for this org'
  return `using the default (${flag.type === 'boolean' ? (flag.default === 'true' ? 'on' : 'off') : flag.default})`
}

/**
 * VAULT-INTEG P17: an explicit "where did this value come from" badge next
 * to every flag's label — the description text below already narrates the
 * same fact in prose (kept, existing convention), this is the scannable
 * version for a page with a dozen settings on it. Reuses the global Badge
 * component/tokens (ui-badge*), no per-page CSS.
 */
function SourceBadge({ flag }) {
  return flag.source === 'setting'
    ? <Badge color="green" pill>Org setting</Badge>
    : <Badge color="default" pill>Env default</Badge>
}

function RestartNotice({ flag }) {
  if (!flag.requiresRestart) return null
  return (
    <div style={{
      margin: '-6px 0 10px 0',
      padding: '6px 10px',
      fontSize: 11.5,
      borderRadius: 6,
      background: 'rgba(251, 191, 36, 0.1)',
      border: '1px solid rgba(251, 191, 36, 0.35)',
      color: '#fbbf24',
    }}>
      Needs a service restart to take effect{flag.restartNote ? ` — ${flag.restartNote}` : '.'}
    </div>
  )
}

function FlagRow({ flag, onToggle, saving, canWrite }) {
  const description = [
    flag.description,
    `Currently ${flag.on ? 'ON' : 'OFF'} — ${sourceLabel(flag)}.`,
    !canWrite ? 'Only an org admin can change this.' : '',
  ].filter(Boolean).join(' ')
  const id = `flag-${flag.key}`

  return (
    <div className="ui-setting-item" style={{ marginBottom: 4 }}>
      <div className="ui-setting-info">
        <label htmlFor={id} className="ui-setting-label" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {flag.name}
          <SourceBadge flag={flag} />
        </label>
        {description && <p className="ui-setting-description">{description}</p>}
        <RestartNotice flag={flag} />
      </div>
      <Toggle
        id={id}
        checked={flag.on}
        onChange={(e) => onToggle(flag.key, e.target.checked)}
        disabled={saving || !canWrite}
      />
    </div>
  )
}

/**
 * VAULT-INTEG P14 slice 1: the non-boolean sibling of FlagRow. Renders a
 * Select for 'enum' (options = flag.allowedValues) or a numeric/text Input
 * for 'number'/'string', with the same label/description/source-of-truth
 * copy as the toggle rows above, in the same ui-setting-item layout (no new
 * CSS — reuses the existing SettingItem-adjacent classes).
 */
function TypedFlagRow({ flag, onSave, saving, canWrite }) {
  const [draft, setDraft] = useState(flag.value)
  useEffect(() => { setDraft(flag.value) }, [flag.value])

  const description = [
    flag.description,
    `Currently "${flag.value}" — ${sourceLabel(flag)}.`,
    !canWrite ? 'Only an org admin can change this.' : '',
  ].filter(Boolean).join(' ')

  const commit = (nextValue) => {
    if (nextValue === flag.value) return
    onSave(flag.key, nextValue)
  }

  return (
    <div className="ui-setting-item" style={{ marginBottom: 4, alignItems: 'flex-start' }}>
      <div className="ui-setting-info">
        <label className="ui-setting-label" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {flag.name}
          <SourceBadge flag={flag} />
        </label>
        {description && <p className="ui-setting-description">{description}</p>}
        <RestartNotice flag={flag} />
      </div>
      <div style={{ minWidth: 140 }}>
        {flag.type === 'enum' ? (
          <Select
            size="sm"
            value={draft}
            disabled={saving || !canWrite}
            onChange={(e) => { setDraft(e.target.value); commit(e.target.value) }}
          >
            {(flag.allowedValues || []).map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </Select>
        ) : (
          <Input
            size="sm"
            type={flag.type === 'number' ? 'number' : 'text'}
            min={flag.type === 'number' ? flag.min : undefined}
            max={flag.type === 'number' ? flag.max : undefined}
            maxLength={flag.type === 'string' ? flag.maxLength : undefined}
            value={draft}
            disabled={saving || !canWrite}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={(e) => commit(e.target.value)}
          />
        )}
      </div>
    </div>
  )
}

/**
 * @param {string[]} [keys] - explicit settable flag keys this instance shows.
 *   Optional when `group` is given (acts as a further narrowing filter on the
 *   group); required on its own when `group` is omitted.
 * @param {string} [group] - VAULT-INTEG P17: registry `group` name — every
 *   settable entry with this group renders, including ones added later.
 * @param {string} title - SettingsCard title
 * @param {string} [subtitle]
 * @param {boolean} [canWrite] - frontend hint only (disables the toggle + shows a
 *   note); the backend PATCH is the real enforcement (admin-only, 403 otherwise).
 *   Defaults to true when the caller hasn't resolved an org role yet, so the
 *   control still works and simply surfaces a 403 if the caller turns out not
 *   to be an admin.
 * @param {Function} [authFetch] - pass through when the parent already has one
 *   (e.g. ExecutionPolicySettings); otherwise resolved from AuthContext.
 */
export default function PlatformFlagsPanel({ keys, group, title, subtitle, onNotification, canWrite = true, authFetch: authFetchProp }) {
  const authFetch = useResolvedAuthFetch(authFetchProp)
  const [flags, setFlags] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [savingKey, setSavingKey] = useState(null)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    fetchPlatformFlags(authFetch)
      .then(setFlags)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [authFetch])

  useEffect(() => { load() }, [load])

  const handleToggle = async (key, on) => {
    setSavingKey(key)
    // Optimistic update, reverted on failure.
    const prev = flags
    setFlags((cur) => cur.map((f) => (f.key === key ? { ...f, on, source: 'setting' } : f)))
    try {
      const result = await setPlatformFlag(authFetch, key, on)
      setFlags((cur) => cur.map((f) => (f.key === key ? { ...f, ...result.effective } : f)))
      onNotification?.(`${key} ${on ? 'enabled' : 'disabled'} for this org.`, 'success')
    } catch (err) {
      setFlags(prev)
      onNotification?.(err.message || `Failed to update ${key}`, 'error')
    } finally {
      setSavingKey(null)
    }
  }

  // VAULT-INTEG P14 slice 1: the typed (string/number/enum) sibling of
  // handleToggle — same optimistic-update/revert-on-failure shape, but
  // takes the raw value directly instead of assuming a boolean.
  const handleSave = async (key, value) => {
    setSavingKey(key)
    const prev = flags
    setFlags((cur) => cur.map((f) => (f.key === key ? { ...f, value, source: 'setting' } : f)))
    try {
      const result = await setPlatformSetting(authFetch, key, value)
      setFlags((cur) => cur.map((f) => (f.key === key ? { ...f, ...result.effective } : f)))
      onNotification?.(`${key} set to "${value}" for this org.`, 'success')
    } catch (err) {
      setFlags(prev)
      onNotification?.(err.message || `Failed to update ${key}`, 'error')
    } finally {
      setSavingKey(null)
    }
  }

  // VAULT-INTEG P17: group match OR explicit key match — whichever filters
  // were actually passed. `keys` alone (no group) keeps the pre-P17
  // behaviour; `group` alone is the new auto-including mode; both together
  // narrows a shared/mixed group down to specific keys.
  const rows = flags.filter((f) => (
    (group ? f.group === group : true) && (keys ? keys.includes(f.key) : true)
  ))

  if (loading) {
    return (
      <SettingsCard title={title} subtitle={subtitle} glass>
        <p style={{ color: 'var(--ui-text-muted)', fontSize: 13, margin: 0 }}>Loading…</p>
      </SettingsCard>
    )
  }

  return (
    <SettingsCard title={title} subtitle={subtitle} glass>
      {error && (
        <p style={{ color: '#ef4444', fontSize: 12, margin: '0 0 12px' }}>
          Could not load current values: {error}
        </p>
      )}
      {rows.length === 0 ? (
        <p style={{ color: 'var(--ui-text-muted)', fontSize: 13, margin: 0 }}>
          No flags registered here yet.
        </p>
      ) : (
        <SettingsGroup>
          {rows.map((flag) => (
            flag.type && flag.type !== 'boolean' ? (
              <TypedFlagRow
                key={flag.key}
                flag={flag}
                onSave={handleSave}
                saving={savingKey === flag.key}
                canWrite={canWrite}
              />
            ) : (
              <FlagRow
                key={flag.key}
                flag={flag}
                onToggle={handleToggle}
                saving={savingKey === flag.key}
                canWrite={canWrite}
              />
            )
          ))}
        </SettingsGroup>
      )}
    </SettingsCard>
  )
}
