/**
 * XBudgetPanel, the org's X posting budget as .qx-progress bars, PLUS the
 * rolling-window explanation, the admin limits editor and the social-sync
 * (mentions polling) toggles. X-PLUGIN phase 11.
 *
 * ROLLING WINDOW, NOT MIDNIGHT RESET, this is the headline fix this
 * rebuild exists for. The daily and monthly limits count back from EACH
 * post's own timestamp (a rolling 24-hour / 30-day window), not from
 * midnight or the 1st of the month. An owner once read "16 of 17" a day
 * later and assumed the page was stale; it was not, the window had quietly
 * refilled. This panel now says so in plain words and states exactly when
 * the next slot frees, using `budget.dailyFreesAt` / `budget.monthlyFreesAt`.
 *
 * Budget shape is the camelCase store shape from GET /x/overview
 * ({ dailyUsed, dailyLimit, dailyRemaining, monthlyUsed, monthlyLimit,
 * monthlyRemaining, limitsSource, windowHours, dailyFreesAt, monthlyFreesAt }).
 * `reads` is the sibling read-budget object ({ used, limit, remaining }).
 * `settings` is the whole GET /collector/x/settings response
 * ({ settings: [...], can_edit, poll_enabled_globally, follower_monitoring }).
 * Enforcement is server-side in the collector approval gate; this panel only
 * renders it and, when `can_edit` is true, lets an admin change the caps via
 * `onSaveSettings` (wired by the caller to xClient.saveSettings, never
 * reinvented here).
 */

import { useEffect, useState } from 'react'

const LIMIT_KEYS = {
  daily: 'X_DAILY_POST_LIMIT',
  monthly: 'X_MONTHLY_POST_LIMIT',
  reads: 'X_DAILY_READ_LIMIT',
}
const POLL_ENABLED_KEY = 'X_MENTIONS_POLL_ENABLED'
const POLL_INTERVAL_KEY = 'X_MENTIONS_POLL_INTERVAL'

const INTERVAL_LABELS = { '15m': '15 minutes', '30m': '30 minutes', '1h': '1 hour', '6h': '6 hours', daily: 'Daily' }
const READ_COST_USD = 0.005 // roughly $0.005 per mentions check, same rate as an engagement read

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
  )
}

function SaveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>
  )
}

/** Checks per day for a poll interval string ('15m' | '30m' | '1h' | '6h' | 'daily').
 * Computed from the interval itself, never a hardcoded per-option table, so
 * the monthly estimate below always tracks the real cadence. */
function checksPerDayFor(interval) {
  if (interval === 'daily') return 1
  const m = /^(\d+)(m|h)$/.exec(interval || '')
  if (!m) return 0
  const minutes = Number(m[1]) * (m[2] === 'h' ? 60 : 1)
  return minutes > 0 ? Math.round((24 * 60) / minutes) : 0
}

function monthlyEstimateUsd(interval) {
  return checksPerDayFor(interval) * READ_COST_USD * 30
}

function fmtUsd(n) {
  return `$${n.toFixed(2)}`
}

function findSetting(settingsList, key) {
  return (settingsList || []).find((s) => s.key === key) || null
}

function settingValue(settingsList, key, fallback) {
  const s = findSetting(settingsList, key)
  if (!s) return fallback
  return s.value !== undefined && s.value !== null ? s.value : (s.default ?? fallback)
}

/**
 * One editable cap: a slider with its value shown and editable beside it.
 * X-PLUGIN phase 13 (owner item 3). A cap is a quantity inside a known range,
 * which is exactly what a slider is for, and the number box stays so a precise
 * value can still be typed.
 *
 * The CEILINGS ARE UNCHANGED: min and max come from the server's own setting
 * metadata (X_DAILY_POST_LIMIT 1 to 100, and so on), the same numbers the old
 * number box carried, and the collector re-validates every save regardless of
 * what this control allows. The admin gate is unchanged too: this whole form
 * only renders when the server says can_edit.
 */
function LimitSlider({ id, label, value, setting, onChange, disabled }) {
  const parsed = Number(value)
  const min = Number(setting?.min ?? 1)
  // If the server did not send a ceiling, do not invent a low one: a slider
  // whose top end is below the org's CURRENT limit would look like the limit
  // had been lowered. Fall back to something that can always express the
  // value in hand.
  const max = Number(setting?.max ?? Math.max(100, Number.isFinite(parsed) ? parsed * 2 : 100))
  const safe = Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : min
  const fill = max > min ? (safe - min) / (max - min) : 0
  return (
    <div className="xs-slider-row">
      <div className="xs-slider-row__labelcell">
        <label htmlFor={id} className="xs-slider-row__label">{label}</label>
        <span className="xs-slider-row__ceiling">allowed {min} to {max}</span>
      </div>
      <input
        id={id}
        type="range"
        className="xs-range"
        min={min}
        max={max}
        step={1}
        value={safe}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        style={{ '--xs-fill': fill }}
      />
      <input
        id={`${id}-value`}
        type="number"
        className="xs-num"
        aria-label={`${label} value`}
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}

function variantFor(used, limit) {
  if (!limit) return ''
  const ratio = used / limit
  if (ratio >= 1) return 'qx-progress--crit'
  if (ratio >= 0.8) return 'qx-progress--warn'
  return 'qx-progress--brand'
}

function BudgetBar({ label, used, limit, remaining }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0
  return (
    <div className="qx-stack qx-stack--tight">
      <div className="qx-row qx-row--apart">
        <span className="qx-section-title xs-title">{label}</span>
        <span className="xs-caption">{used} of {limit} used · {remaining} remaining</span>
      </div>
      {/* .qx-progress paints its fill from the --qx-progress variable (0..1)
          via its own ::after — there is no __fill child element in the
          component library. Rendering one drew every bar EMPTY: a budget at
          17 of 17 used showed as untouched, which is the single most
          dangerous thing a budget meter can get wrong. */}
      <div
        className={`qx-progress ${variantFor(used, limit)}`}
        style={{ '--qx-progress': limit ? Math.min(1, used / limit) : 0 }}
        role="progressbar"
        aria-valuenow={used}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-label={`${label}: ${used} of ${limit} used (${pct}%)`}
      />
    </div>
  )
}

/** Names the rolling window and states exactly when the next slot frees, in
 * the viewer's own locale plus a relative phrase, the absolute time alone
 * is what confused the owner into thinking the page was stale. */
function nextSlotPhrase(freesAtIso) {
  if (!freesAtIso) return null
  const target = new Date(freesAtIso)
  if (Number.isNaN(target.getTime())) return null
  const diffMs = target.getTime() - Date.now()
  const minutes = Math.round(Math.abs(diffMs) / 60000)
  let span
  if (minutes < 1) span = 'under a minute'
  else if (minutes < 60) span = `about ${minutes} minute${minutes === 1 ? '' : 's'}`
  else if (minutes < 60 * 24) {
    const hours = Math.round(minutes / 60)
    span = `about ${hours} hour${hours === 1 ? '' : 's'}`
  } else {
    const days = Math.round(minutes / (60 * 24))
    span = `about ${days} day${days === 1 ? '' : 's'}`
  }
  const relative = diffMs >= 0 ? `in ${span}` : `${span} ago`
  const clock = target.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return `1 slot frees at ${clock}, ${relative}.`
}

function RollingWindowNote({ headline, freesAtIso, wholeLabel }) {
  const phrase = nextSlotPhrase(freesAtIso)
  return (
    <div className="qx-stack qx-stack--tight">
      <p className="xs-caption">{headline}</p>
      <p className="xs-caption xs-caption--strong">{phrase || wholeLabel}</p>
    </div>
  )
}

/**
 * The read budget, read from whichever field names the caller supplied.
 *
 * GET /x/overview returns the STORE shape (dailyUsed / dailyLimit /
 * dailyRemaining, matching getReadBudgetStatus). An earlier draft of this
 * panel read used/limit/remaining instead, which no server ever sends: the
 * bar would have rendered 0 of 0 and painted EMPTY on an org that had spent
 * its whole read budget. That is precisely the class of lie the
 * .qx-progress note below warns about, and the panel's own tests missed it
 * because they fed the shape the component assumed rather than the shape the
 * server sends. Both spellings are accepted now so neither caller can be
 * silently wrong, with the server's own naming first.
 */
function normaliseReads(reads) {
  if (!reads) return null
  const used = reads.dailyUsed ?? reads.used ?? 0
  const limit = reads.dailyLimit ?? reads.limit ?? 0
  const remaining = reads.dailyRemaining ?? reads.remaining ?? Math.max(0, limit - used)
  return { used, limit, remaining }
}

export default function XBudgetPanel({ budget, reads, settings, loading = false, error = null, onSaveSettings, onRefresh }) {
  const { used: readsUsed, limit: readsLimit, remaining: readsRemaining } = normaliseReads(reads) || { used: 0, limit: 0, remaining: 0 }
  const settingsList = settings?.settings
  const dailySetting = findSetting(settingsList, LIMIT_KEYS.daily)
  const monthlySetting = findSetting(settingsList, LIMIT_KEYS.monthly)
  const readsSetting = findSetting(settingsList, LIMIT_KEYS.reads)
  const pollEnabledSetting = findSetting(settingsList, POLL_ENABLED_KEY)
  const pollIntervalSetting = findSetting(settingsList, POLL_INTERVAL_KEY)

  const [dailyInput, setDailyInput] = useState('')
  const [monthlyInput, setMonthlyInput] = useState('')
  const [readsInput, setReadsInput] = useState('')
  const [pollEnabledInput, setPollEnabledInput] = useState(false)
  const [pollIntervalInput, setPollIntervalInput] = useState('1h')

  const [savingLimits, setSavingLimits] = useState(false)
  const [limitsError, setLimitsError] = useState(null)
  const [limitsSaved, setLimitsSaved] = useState(false)

  const [savingSocial, setSavingSocial] = useState(false)
  const [socialError, setSocialError] = useState(null)
  const [socialSaved, setSocialSaved] = useState(false)

  // Re-sync the editable fields whenever the server-loaded settings change
  // (initial load, or a fresh GET after a save), never overwrite mid-edit
  // by tying this to render, only to the `settings` prop identity.
  useEffect(() => {
    if (!settings) return
    setDailyInput(String(settingValue(settingsList, LIMIT_KEYS.daily, '')))
    setMonthlyInput(String(settingValue(settingsList, LIMIT_KEYS.monthly, '')))
    setReadsInput(String(settingValue(settingsList, LIMIT_KEYS.reads, '')))
    setPollEnabledInput(Boolean(settingValue(settingsList, POLL_ENABLED_KEY, false)))
    setPollIntervalInput(settingValue(settingsList, POLL_INTERVAL_KEY, '1h'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings])

  async function handleSaveLimits(e) {
    e.preventDefault()
    if (typeof onSaveSettings !== 'function') return
    setSavingLimits(true)
    setLimitsError(null)
    setLimitsSaved(false)
    try {
      await onSaveSettings({
        [LIMIT_KEYS.daily]: Number(dailyInput),
        [LIMIT_KEYS.monthly]: Number(monthlyInput),
        [LIMIT_KEYS.reads]: Number(readsInput),
      })
      setLimitsSaved(true)
    } catch (err) {
      setLimitsError(err?.message || 'Save failed')
    } finally {
      setSavingLimits(false)
    }
  }

  async function handleSaveSocial() {
    if (typeof onSaveSettings !== 'function') return
    setSavingSocial(true)
    setSocialError(null)
    setSocialSaved(false)
    try {
      await onSaveSettings({
        [POLL_ENABLED_KEY]: pollEnabledInput,
        [POLL_INTERVAL_KEY]: pollIntervalInput,
      })
      setSocialSaved(true)
    } catch (err) {
      setSocialError(err?.message || 'Save failed')
    } finally {
      setSavingSocial(false)
    }
  }

  const intervalOptions = pollIntervalSetting?.allowedValues?.length
    ? pollIntervalSetting.allowedValues
    : Object.keys(INTERVAL_LABELS)
  const canEdit = Boolean(settings?.can_edit)
  const killSwitchOff = settings?.poll_enabled_globally === false

  return (
    <section className="qx-card">
      <div className="qx-stack">
        <div className="qx-row qx-row--apart">
          <div className="xs-panel-head">
            <h3>Posting budget</h3>
          </div>
          {onRefresh && (
            <button type="button" className="qx-btn xs-btn qx-btn--sm" onClick={onRefresh} disabled={loading}>
              <RefreshIcon />
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          )}
        </div>

        {error && <div className="qx-banner qx-banner--error">{error}</div>}

        {loading && !budget ? (
          <div className="qx-skeleton qx-skeleton--block" />
        ) : !budget ? (
          <p className="qx-hint qx-hint--sm">Budget unavailable: the collector did not answer.</p>
        ) : (
          <>
            <BudgetBar
              label="Daily"
              used={budget.dailyUsed ?? 0}
              limit={budget.dailyLimit ?? 0}
              remaining={budget.dailyRemaining ?? Math.max(0, (budget.dailyLimit ?? 0) - (budget.dailyUsed ?? 0))}
            />
            <RollingWindowNote
              headline="This is a ROLLING 24-hour window, not a reset at midnight: a post counts against the daily limit for 24 hours after it was made, then frees up on its own."
              freesAtIso={budget.dailyFreesAt}
              wholeLabel="The daily budget is already whole; nothing is currently counted against the rolling 24-hour window."
            />

            <BudgetBar
              label="Monthly"
              used={budget.monthlyUsed ?? 0}
              limit={budget.monthlyLimit ?? 0}
              remaining={budget.monthlyRemaining ?? Math.max(0, (budget.monthlyLimit ?? 0) - (budget.monthlyUsed ?? 0))}
            />
            <RollingWindowNote
              headline="The monthly limit is a rolling 30-day window in the same way: a post counted 30 days ago has already aged out, not waiting for the 1st of the month."
              freesAtIso={budget.monthlyFreesAt}
              wholeLabel="The monthly budget is already whole; nothing is currently counted against the rolling 30-day window."
            />

            {reads && (
              <BudgetBar
                label="Reads (last 24 hours)"
                used={readsUsed}
                limit={readsLimit}
                remaining={readsRemaining}
              />
            )}

            <p className="xs-caption">
              Limits are enforced server-side at draft AND at approval time. An approved post that
              would exceed the budget is refused by the collector, not by this page.
            </p>
          </>
        )}

        {settings && (
          <>
            <div className="qx-stack qx-stack--tight">
              <span className="qx-section-title xs-title">Limits</span>
              {canEdit ? (
                <form onSubmit={handleSaveLimits} className="qx-stack qx-stack--tight">
                  <LimitSlider
                    id="x-limit-daily"
                    label="Daily posts"
                    value={dailyInput}
                    setting={dailySetting}
                    onChange={setDailyInput}
                    disabled={savingLimits}
                  />
                  <LimitSlider
                    id="x-limit-monthly"
                    label="Monthly posts"
                    value={monthlyInput}
                    setting={monthlySetting}
                    onChange={setMonthlyInput}
                    disabled={savingLimits}
                  />
                  <LimitSlider
                    id="x-limit-reads"
                    label="Daily reads"
                    value={readsInput}
                    setting={readsSetting}
                    onChange={setReadsInput}
                    disabled={savingLimits}
                  />
                  <p className="xs-caption">
                    The ceilings beside each slider are the platform's own, enforced by the
                    collector on save. Lowering a cap bites immediately, including on a draft filed
                    under the old one.
                  </p>
                  <div className="qx-row qx-row--tight">
                    <button type="submit" className="qx-btn xs-btn xs-btn--accent qx-btn--sm" disabled={savingLimits}>
                      <SaveIcon />
                      {savingLimits ? 'Saving…' : 'Save limits'}
                    </button>
                  </div>
                  {limitsError && <div className="qx-banner qx-banner--error">{limitsError}</div>}
                  {limitsSaved && <p className="qx-hint qx-hint--sm">Limits saved.</p>}
                </form>
              ) : (
                <>
                  <p className="qx-hint qx-hint--sm">Only an org owner or admin can change these limits.</p>
                  <div className="qx-row qx-row--wrap qx-row--tight">
                    <span className="qx-pill qx-pill--sm">Daily {settingValue(settingsList, LIMIT_KEYS.daily, '—')}</span>
                    <span className="qx-pill qx-pill--sm">Monthly {settingValue(settingsList, LIMIT_KEYS.monthly, '—')}</span>
                    <span className="qx-pill qx-pill--sm">Reads {settingValue(settingsList, LIMIT_KEYS.reads, '—')}</span>
                  </div>
                </>
              )}
            </div>

            <div className="qx-stack qx-stack--tight">
              <span className="qx-section-title xs-title">Social sync</span>

              <label className="qx-row qx-row--tight" style={{ cursor: canEdit ? 'pointer' : 'default' }}>
                <input
                  type="checkbox"
                  checked={pollEnabledInput}
                  disabled={!canEdit}
                  onChange={(e) => setPollEnabledInput(e.target.checked)}
                  aria-label="Poll mentions"
                />
                <span>Poll mentions</span>
              </label>

              {pollEnabledInput && killSwitchOff && (
                <div className="qx-banner qx-banner--error">
                  The deployment-wide mentions polling switch is off, so even though this org's toggle
                  is on, no polling is actually happening right now.
                </div>
              )}

              <p className="qx-hint qx-hint--sm">
                Selected interval {INTERVAL_LABELS[pollIntervalInput] || pollIntervalInput}:{' '}
                <span className="qx-pill qx-pill--sm">about {fmtUsd(monthlyEstimateUsd(pollIntervalInput))}/month</span>
              </p>

              <div className="qx-stack qx-stack--tight">
                {intervalOptions.map((opt) => (
                  <label key={opt} className="qx-row qx-row--apart" style={{ cursor: canEdit ? 'pointer' : 'default' }}>
                    <span className="qx-row qx-row--tight">
                      <input
                        type="radio"
                        name="x-mentions-interval"
                        value={opt}
                        checked={pollIntervalInput === opt}
                        disabled={!canEdit}
                        onChange={() => setPollIntervalInput(opt)}
                      />
                      {INTERVAL_LABELS[opt] || opt}
                    </span>
                    <span className="qx-hint qx-hint--sm">about {fmtUsd(monthlyEstimateUsd(opt))}/month</span>
                  </label>
                ))}
              </div>

              {canEdit ? (
                <div className="qx-row qx-row--tight">
                  <button type="button" className="qx-btn xs-btn xs-btn--accent qx-btn--sm" onClick={handleSaveSocial} disabled={savingSocial}>
                    <SaveIcon />
                    {savingSocial ? 'Saving…' : 'Save social sync'}
                  </button>
                </div>
              ) : (
                <p className="qx-hint qx-hint--sm">Only an org owner or admin can change mentions polling.</p>
              )}
              {socialError && <div className="qx-banner qx-banner--error">{socialError}</div>}
              {socialSaved && <p className="qx-hint qx-hint--sm">Social sync settings saved.</p>}

              <div className="qx-row qx-row--apart" style={{ opacity: 0.6 }}>
                <label className="qx-row qx-row--tight" aria-disabled="true">
                  <input type="checkbox" checked={false} disabled readOnly aria-label="Follower monitoring (not available yet)" />
                  <span>
                    Follower monitoring <span className="qx-pill qx-pill--sm">Not available yet (phase 10)</span>
                  </span>
                </label>
                <span className="qx-hint qx-hint--sm">{settings.follower_monitoring?.note}</span>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
