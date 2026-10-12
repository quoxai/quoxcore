// dreamScheduler.js — P3 WP3 QuoxDream scheduler
// (docs/STREAM_QUOXBRAIN_P3_DREAM_CONTRACT.md §WP3, §Guardrails)
//
// Mirrors the shape of collector/lib/memoryConsolidationScheduler.js (the
// "scheduler template to mirror" named in the contract): a warmup
// setTimeout followed by a recurring setInterval, both `.unref()`'d so they
// never hold the process open or block `node --test` exit. Ships dark by
// default — QUOXDREAM_ENABLED must be explicitly 'true' AND QUOXDREAM_ORGS
// must list at least one org id, or startDreamScheduler() schedules nothing
// and returns immediately.
//
// Best-effort throughout: each org's consolidateOrg() call is wrapped in its
// own try/catch so one org failing (LLM down, memory service down, bad org
// id) never prevents the other orgs in the CSV from running that tick.

import { resolveDreamLlmAllowed } from './brainConfig.js'
import { consolidateOrg as consolidateOrgDefault } from './quoxDream.js'
import { getInstanceSetting } from './configResolver.js'

// quox#524: collector-reachability defaults for fetchDreamEnabledOverride()
// below — same env-driven convention as lib/quoxDream.js's own collector
// calls (COLLECTOR_URL / COLLECTOR_HOST / COLLECTOR_PORT, X-Service-Key).
const COLLECTOR_URL_DEFAULT = process.env.COLLECTOR_URL
  || `http://${process.env.COLLECTOR_HOST || 'collector'}:${process.env.COLLECTOR_PORT || '9848'}`
const SERVICE_KEY_DEFAULT = process.env.INTERNAL_SERVICE_KEY || ''
const FLAG_FETCH_TIMEOUT_MS_DEFAULT = 5000

/**
 * quox#524: QUOXDREAM_ENABLED is registered in
 * services/collector/lib/platformCapabilities.js as a per-org,
 * Settings-store-overridable flag, but quoxbrain is a SEPARATE service/
 * process from collector — it never opens collector's voltDb (where
 * org_platform_settings actually lives), so it cannot call
 * platformSettingsStore.getEffectiveFlag() directly the way every
 * collector-side call site does. This fetches that same already-resolved,
 * precedence-applied value from collector's own
 * GET /api/v1/platform/settings/flags (the exact endpoint the Settings UI
 * reads) over the existing service-to-service convention (X-Service-Key —
 * mirrors lib/quoxDream.js's collector calls / lib/embeddingClient.js). No
 * new DB connection, no duplicated precedence logic.
 *
 * Best-effort/fail-safe throughout: no service key configured, no orgId,
 * a non-2xx response, a network error, a timeout, or a malformed/missing
 * entry in the response all resolve to `null` ("unknown — caller falls
 * back to its own env read") rather than throwing or guessing. Only a
 * genuine boolean `on` from the live resolver is trusted.
 *
 * @param {string} orgId
 * @param {object} [deps]
 * @param {function} [deps.fetchImpl] - injectable for tests
 * @param {string} [deps.collectorUrl] - override (tests)
 * @param {string} [deps.serviceKey] - override (tests)
 * @param {number} [deps.flagFetchTimeoutMs] - override (tests)
 * @returns {Promise<boolean|null>}
 */
export async function fetchDreamEnabledOverride(orgId, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch
  const collectorUrl = deps.collectorUrl || COLLECTOR_URL_DEFAULT
  const serviceKey = deps.serviceKey !== undefined ? deps.serviceKey : SERVICE_KEY_DEFAULT
  if (!serviceKey || !orgId) return null

  try {
    const res = await fetchImpl(`${collectorUrl}/api/v1/platform/settings/flags`, {
      headers: { 'X-Service-Key': serviceKey, 'X-Org-Id': orgId },
      signal: AbortSignal.timeout(deps.flagFetchTimeoutMs ?? FLAG_FETCH_TIMEOUT_MS_DEFAULT)
    })
    if (!res.ok) {
      console.error(`[QuoxDream] QUOXDREAM_ENABLED settings fetch HTTP ${res.status} for org=${orgId} — falling back to env`)
      return null
    }
    const data = await res.json()
    const entry = Array.isArray(data?.flags) ? data.flags.find((f) => f && f.key === 'QUOXDREAM_ENABLED') : null
    // BRAIN2-AUDIT L1 (2026-09-12): same source gate as
    // lib/configResolver.js _fetchFlag — source 'env' is the COLLECTOR's
    // own env/default resolution (it carries no QUOXDREAM_* vars), not a
    // stored operator choice; trusting it disabled dreaming at boot
    // whenever the collector answered healthily. Only a stored override
    // (source 'setting') is an answer.
    return (entry && typeof entry.on === 'boolean' && entry.source === 'setting') ? entry.on : null
  } catch (err) {
    console.error(`[QuoxDream] QUOXDREAM_ENABLED settings fetch failed for org=${orgId}, falling back to env — ${err.message}`)
    return null
  }
}

// Warmup: first tick fires ~5 min after boot (lets the service finish
// booting/health-checking before it starts doing LLM work).
export const DEFAULT_WARMUP_MS = 5 * 60 * 1000
// Interval: subsequent ticks every ~6h (contract §Design startDreamScheduler).
export const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000

// INFRA-CPU (2026-08-30 CPU incident, same class as EmbedBackfill's fix in
// 8e1a0958): the cap for both the per-org failure cooldown and the
// whole-tick zero-progress backoff below, expressed as a multiple of the
// interval rather than an absolute duration. EmbedBackfill caps at a fixed
// 15-minute MAX_BACKOFF_MS divided by its (usually short) interval; blindly
// reusing that here would divide 15min by QuoxDream's already-coarse 6h
// cadence and round down to a 1-tick cap, defeating exponential backoff
// entirely. Capping in ticks instead bounds the real gap between attempts
// at ~4x the normal interval (~24h) regardless of how intervalMs is
// configured.
export const BACKOFF_TICKS_CAP = 4

/**
 * Parses the QUOXDREAM_ORGS CSV env var into a clean list of org ids —
 * trims whitespace and drops empty entries (so 'a, ,b' -> ['a', 'b']).
 * @param {string} raw
 * @returns {string[]}
 */
export function parseOrgIds(raw) {
  return String(raw || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
}

/**
 * Starts the QuoxDream server-side scheduler. Dark by default: no timers are
 * created unless QUOXDREAM_ENABLED === 'true' and QUOXDREAM_ORGS resolves to
 * at least one org id.
 *
 * @param {object} [deps]
 * @param {number} [deps.warmupMs] - override the warmup delay (tests)
 * @param {number} [deps.intervalMs] - override the recurring interval (tests)
 * @param {boolean} [deps.runNow] - skip the warmup timer and run one tick immediately (tests)
 * @param {function} [deps.consolidateOrg] - override consolidateOrg (tests)
 * @param {function} [deps.setTimeoutFn] - injectable for tests
 * @param {function} [deps.setIntervalFn] - injectable for tests
 * @param {number} [deps.runTimes] - with runNow, run this many sequential
 *   ticks in a row instead of one (tests — lets the per-org and zero-progress
 *   backoff logic below be exercised across multiple ticks without needing
 *   real timers)
 */
export async function startDreamScheduler(deps = {}) {
  const configuredOrgIds = parseOrgIds(process.env.QUOXDREAM_ORGS)
  const envEnabled = process.env.QUOXDREAM_ENABLED === 'true'

  if (configuredOrgIds.length === 0) {
    console.log(envEnabled
      ? '[QuoxDream] scheduler enabled but no orgs configured (QUOXDREAM_ORGS is empty) — no orgs configured'
      : '[QuoxDream] scheduler disabled')
    return
  }

  // quox#524: resolve QUOXDREAM_ENABLED per configured org rather than
  // trusting the raw env var alone — an org admin's stored override
  // (Settings UI, org_platform_settings) must actually gate whether that
  // org's consolidation runs, not just be displayed. isDreamEnabledFn
  // defaults to fetchDreamEnabledOverride()'s live collector lookup; a
  // `null`/non-boolean resolution (no override stored, or the lookup
  // itself failed/unreachable) falls back to the plain env value — same
  // precedence contract as platformCapabilities.resolveEffectiveCapability.
  const isDreamEnabledFn = deps.isDreamEnabledFn || ((orgId) => fetchDreamEnabledOverride(orgId, deps))
  // BRAIN2-W7 104: enablement is re-resolved on EVERY tick (not frozen at boot),
  // so the per-org Settings switch starts/stops consolidation without a restart.
  // Enrollment is still bounded by QUOXDREAM_ORGS: an org absent from that list
  // is never scheduled, whatever its stored switch says.
  const resolveEnabledOrgs = async () => {
    const out = []
    for (const orgId of configuredOrgIds) {
      let on = envEnabled
      try {
        const resolved = await isDreamEnabledFn(orgId)
        if (typeof resolved === 'boolean') on = resolved
      } catch (err) {
        console.error(`[QuoxDream] QUOXDREAM_ENABLED resolver failed for org=${orgId}, defaulting to env — ${err.message}`)
      }
      if (on) out.push(orgId)
    }
    return out
  }
  const orgIds = await resolveEnabledOrgs()
  if (orgIds.length === 0) {
    console.log('[QuoxDream] no org is enabled at boot; scheduler stays armed and re-checks each tick (QUOXDREAM_ORGS bounds enrollment)')
  }

  // Precedence for all knobs: injected deps (tests) > stored instance
  // setting (VAULT-INTEG P17, via configResolver.getInstanceSetting — a
  // service-to-service HTTP call to collector's settings API, same
  // fail-safe contract as fetchDreamEnabledOverride above) > env override >
  // default. batchSize/maxBatches left undefined fall through to
  // consolidateSlice's own defaults (40 / 5). Env knobs let the soak run
  // gentle (small batches, short warmup) without a code change, and let us
  // dial throughput up later. Empty/unset env (compose passes `VAR=` when
  // the host var is unset) MUST map to undefined -> fall through to
  // default. Number('') is 0, which would wrongly set maxBatches=0 (no
  // work) — so guard empty/null explicitly.
  //
  // HONESTY: these four knobs are only ever read here, once, at
  // startDreamScheduler() call time (process boot) — the setInterval below
  // bakes warmupMs/intervalMs into its own closure, and batchSize/maxBatches
  // are captured for the lifetime of every runTick() this scheduler ever
  // creates. A stored override IS honoured, but only from the next quoxbrain
  // service restart onward — platformCapabilities.js marks all four
  // `requiresRestart: true` for exactly this reason (same honesty contract
  // as QUOXDREAM_ENABLED's own entry above it).
  const envNum = (v) => {
    if (v === undefined || v === null || String(v).trim() === '') return undefined
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : undefined
  }
  const resolveInstanceNum = async (key, envValue) => {
    try {
      const resolved = await getInstanceSetting(key, deps)
      if (resolved && resolved.value !== undefined) {
        const n = Number(resolved.value)
        if (Number.isFinite(n) && n >= 0) return n
      }
    } catch (err) {
      console.error(`[QuoxDream] ${key} instance-setting resolver failed, falling back to env — ${err.message}`)
    }
    return envNum(envValue)
  }
  const warmupMs = Number.isFinite(deps.warmupMs) ? deps.warmupMs : ((await resolveInstanceNum('QUOXDREAM_WARMUP_MS', process.env.QUOXDREAM_WARMUP_MS)) ?? DEFAULT_WARMUP_MS)
  const intervalMs = Number.isFinite(deps.intervalMs) ? deps.intervalMs : ((await resolveInstanceNum('QUOXDREAM_INTERVAL_MS', process.env.QUOXDREAM_INTERVAL_MS)) ?? DEFAULT_INTERVAL_MS)
  const batchSize = await resolveInstanceNum('QUOXDREAM_BATCH_SIZE', process.env.QUOXDREAM_BATCH_SIZE)
  const maxBatches = await resolveInstanceNum('QUOXDREAM_MAX_BATCHES', process.env.QUOXDREAM_MAX_BATCHES)
  const consolidateOrg = deps.consolidateOrg || consolidateOrgDefault
  const setTimeoutFn = deps.setTimeoutFn || setTimeout
  const setIntervalFn = deps.setIntervalFn || setInterval

  // INFRA-CPU (2026-08-30 CPU incident): an org whose consolidateOrg() call
  // fails EVERY tick (LLM down, memory service down, bad org id) had no
  // signal to slow down, and was retried at full 6h cadence forever. Two
  // minimal, in-memory backoffs fix this (no persistence needed — a restart
  // just resets to full cadence, acceptable for a resource-protection
  // guardrail, same rationale as EmbedBackfill's scheduler): an org that
  // fails outright is skipped for a growing number of ticks, and a tick
  // where NO org succeeds at all backs off the same way. Both capped at
  // BACKOFF_TICKS_CAP ticks (see its definition above for why that's a tick
  // count, not a duration).
  let consecutiveStalledTicks = 0
  let backoffTicksRemaining = 0
  const orgFailureStreak = new Map()
  const orgCooldownTicks = new Map()

  // BRAIN2-W5 108: single-flight. An async interval callback is not awaited by
  // setInterval, so a tick slower than the interval was overlapped by the next
  // one (duplicate LLM spend, cursor races). A tick that fires while one is
  // still running is skipped, not queued.
  let tickRunning = false
  const runTick = async () => {
    if (tickRunning) {
      console.log('[QuoxDream] tick skipped: previous tick still running')
      return
    }
    tickRunning = true
    try {
      await runTickBody()
    } finally {
      tickRunning = false
    }
  }

  const runTickBody = async () => {
    if (backoffTicksRemaining > 0) {
      backoffTicksRemaining -= 1
      console.log(`[QuoxDream] tick skipped: backing off after ${consecutiveStalledTicks} consecutive zero-progress tick(s), ${backoffTicksRemaining} tick(s) of backoff remaining`)
      return
    }

    let ok = 0
    let failed = 0
    let attempted = 0
    const tickOrgIds = await resolveEnabledOrgs()
    for (const orgId of tickOrgIds) {
      // Per-org backoff: an org that failed outright on a recent tick is
      // not worth retrying immediately — skip it until its cooldown expires.
      const cooldown = orgCooldownTicks.get(orgId) || 0
      if (cooldown > 0) {
        orgCooldownTicks.set(orgId, cooldown - 1)
        continue
      }
      // BRAIN2-V3 B4: per-org "Allow consolidation to send note text to the
      // LLM" (QUOXDREAM_ALLOW_LLM_TEXT, default allowed). Resolved every tick
      // so an admin's change takes effect without a restart. Consolidation
      // IS an LLM call, so a blocked org is skipped, not degraded. Not a
      // failure: no backoff, no failure streak.
      try {
        const llm = await (deps.isLlmAllowedFn || ((o) => resolveDreamLlmAllowed(o, deps)))(orgId)
        if (llm && llm.allowed === false) {
          console.log(`[QuoxDream] org=${orgId} skipped: consolidation sending note text to the LLM is switched off for this org`)
          continue
        }
      } catch (err) {
        // BRAIN2-W2 2: a failed privacy gate never means "allowed".
        console.error(`[QuoxDream] LLM-text gate resolver failed for org=${orgId}, skipping (fail closed) — ${err.message}`)
        continue
      }
      attempted += 1
      try {
        await consolidateOrg(orgId, { maxBatches, batchSize }, deps)
        ok += 1
        orgFailureStreak.delete(orgId)
        orgCooldownTicks.delete(orgId)
      } catch (err) {
        failed += 1
        const streak = (orgFailureStreak.get(orgId) || 0) + 1
        orgFailureStreak.set(orgId, streak)
        const cooldownTicks = Math.min(streak, BACKOFF_TICKS_CAP)
        orgCooldownTicks.set(orgId, cooldownTicks)
        const capped = streak >= BACKOFF_TICKS_CAP ? ' (capped at max backoff until it succeeds again)' : ''
        console.error(`[QuoxDream] consolidateOrg failed for org=${orgId} (streak ${streak}), backing off ${cooldownTicks} tick(s)${capped}: ${err.message}`)
      }
    }

    // A tick where at least one org was actually attempted but none
    // succeeded is a real stall, and the trigger for the whole-tick
    // zero-progress backoff. A tick where every org was skipped purely by
    // its own per-org cooldown (attempted === 0) is not a NEW stall — it's
    // already explained by those cooldowns, so it must not additionally
    // grow the whole-tick backoff on top.
    if (ok > 0) {
      consecutiveStalledTicks = 0
    } else if (attempted > 0) {
      consecutiveStalledTicks += 1
      backoffTicksRemaining = Math.min(consecutiveStalledTicks, BACKOFF_TICKS_CAP)
    }

    console.log(`[QuoxDream] tick complete: ${ok} org(s) consolidated, ${failed} failed, ${tickOrgIds.length} total`)
  }

  console.log(`[QuoxDream] scheduler enabled for ${orgIds.length} org(s) (warmup ${Math.round(warmupMs / 1000)}s, every ${(intervalMs / 3600000).toFixed(1)}h, batch=${batchSize ?? 40}x${maxBatches ?? 5})`)

  if (deps.runNow) {
    const times = Number.isInteger(deps.runTimes) && deps.runTimes > 0 ? deps.runTimes : 1
    for (let i = 0; i < times; i++) await runTick()
    return
  }

  const warmupTimer = setTimeoutFn(() => {
    runTick()
    const intervalTimer = setIntervalFn(runTick, intervalMs)
    if (intervalTimer && typeof intervalTimer.unref === 'function') intervalTimer.unref()
  }, warmupMs)
  if (warmupTimer && typeof warmupTimer.unref === 'function') warmupTimer.unref()
}

export default { startDreamScheduler, parseOrgIds, fetchDreamEnabledOverride, DEFAULT_WARMUP_MS, DEFAULT_INTERVAL_MS, BACKOFF_TICKS_CAP }
