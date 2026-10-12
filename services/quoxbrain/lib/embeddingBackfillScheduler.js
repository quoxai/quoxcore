// embeddingBackfillScheduler.js: QuoxBrain embedding backfill scheduler
// (audit finding: lib/embeddingBackfill.js's backfillEmbeddings() had no
// production caller, so hybrid retrieval's dense leg silently starved:
// 345 of 76356 chunks embedded before a manual run. Ships dark by default.)
//
// Modelled EXACTLY on lib/dreamScheduler.js's shape: a warmup setTimeout
// followed by a recurring setInterval, both `.unref()`'d so they never hold
// the process open or block `node --test` exit. Ships dark by default:
// QUOXBRAIN_EMBED_BACKFILL_ENABLED must be explicitly 'true', or
// startEmbeddingBackfillScheduler() schedules nothing and returns
// immediately.
//
// Unlike dreamScheduler (which fans out over an operator-supplied
// QUOXDREAM_ORGS CSV), the org list here is auto-discovered per tick via
// vaultStore.getOrgIdsWithMissingEmbeddings, an org with nothing missing is
// never returned by that query, so "skip orgs with nothing missing" is a
// property of the discovery query, not extra branching in this file.
//
// Best-effort throughout: each org's backfillEmbeddings() call is wrapped in
// its own try/catch so one org failing (embed seam down, bad org id) never
// prevents the other discovered orgs from running that tick.

import { backfillEmbeddings as backfillEmbeddingsDefault } from './embeddingBackfill.js'
// Discovery covers orgs with missing embeddings AND fully-covered orgs whose
// rows span >1 embedding space (needing the healing pass) — the injectable
// dep keeps its historical name (getOrgIdsWithMissingEmbeddings) for test
// compatibility, but the default is the wider query.
import { getEmbeddingProviderCached } from './embeddingStatus.js'
import { getOrgIdsNeedingEmbeddingWork as getOrgIdsNeedingEmbeddingWorkDefault, markEmbedOrgAttempted as markEmbedOrgAttemptedDefault } from './vaultStore.js'
import { getInstanceSetting } from './configResolver.js'

// Warmup: first tick fires ~2 min after boot (shorter than QuoxDream's 5min,
// since this job is cheap, bounded I/O rather than LLM consolidation, so
// there's less reason to hold off letting it start catching up the backlog).
export const DEFAULT_WARMUP_MS = 2 * 60 * 1000
// Interval: subsequent ticks every ~15min (much tighter than QuoxDream's 6h,
// since the whole point of this scheduler is to catch up a large existing
// backlog without waiting hours between bites).
export const DEFAULT_INTERVAL_MS = 15 * 60 * 1000
// Max distinct orgs discovered/processed per tick, bounds total tick work
// alongside each org's own batch cap (embeddingBackfill's own `limit`).
export const DEFAULT_MAX_ORGS_PER_TICK = 10

/**
 * Starts the embedding backfill scheduler. Dark by default: no timers are
 * created unless QUOXBRAIN_EMBED_BACKFILL_ENABLED === 'true'.
 *
 * @param {object} [deps]
 * @param {number} [deps.warmupMs] - override the warmup delay (tests)
 * @param {number} [deps.intervalMs] - override the recurring interval (tests)
 * @param {boolean} [deps.runNow] - skip the warmup timer and run one tick immediately (tests)
 * @param {function} [deps.backfillEmbeddings] - override backfillEmbeddings (tests)
 * @param {function} [deps.getOrgIdsWithMissingEmbeddings] - override the org-discovery query (tests)
 * @param {function} [deps.setTimeoutFn] - injectable for tests
 * @param {function} [deps.setIntervalFn] - injectable for tests
 * @param {number} [deps.runTimes] - with runNow, run this many sequential
 *   ticks in a row instead of one (tests — lets the per-org and zero-progress
 *   backoff logic below be exercised across multiple ticks without needing
 *   real timers)
 */
export async function startEmbeddingBackfillScheduler(deps = {}) {
  // VAULT-INTEG P17: stored instance override > env default, same
  // fail-safe/resolved-once-at-boot contract as every other knob in this
  // function (see the HONESTY note below) — platformCapabilities.js's
  // QUOXBRAIN_EMBED_BACKFILL_ENABLED entry is `requiresRestart: true`.
  const envEnabled = process.env.QUOXBRAIN_EMBED_BACKFILL_ENABLED === 'true'
  let enabled = envEnabled
  try {
    const resolved = await getInstanceSetting('QUOXBRAIN_EMBED_BACKFILL_ENABLED', deps)
    if (resolved && typeof resolved.on === 'boolean') enabled = resolved.on
  } catch (err) {
    console.error(`[EmbedBackfill] QUOXBRAIN_EMBED_BACKFILL_ENABLED instance-setting resolver failed, falling back to env — ${err.message}`)
  }
  if (!enabled) {
    console.log('[EmbedBackfill] scheduler disabled')
    return
  }

  // Precedence for all knobs: injected deps (tests) > stored instance
  // setting (VAULT-INTEG P17, via configResolver.getInstanceSetting) > env
  // override > default. Empty/unset env (compose passes `VAR=` when the
  // host var is unset) MUST map to undefined -> fall through to default,
  // same guard as dreamScheduler.js's envNum (Number('') is 0, which would
  // wrongly zero out the batch cap / org cap and silently run no work).
  //
  // HONESTY: same as dreamScheduler.js — all four knobs are read once, at
  // startEmbeddingBackfillScheduler() call time (process boot), and baked
  // into this scheduler's setInterval/runTick closures for its lifetime. A
  // stored override is honoured from the next quoxbrain service restart
  // onward, not live against an already-running scheduler —
  // platformCapabilities.js marks all four `requiresRestart: true`.
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
      console.error(`[EmbedBackfill] ${key} instance-setting resolver failed, falling back to env — ${err.message}`)
    }
    return envNum(envValue)
  }
  const warmupMs = Number.isFinite(deps.warmupMs) ? deps.warmupMs : ((await resolveInstanceNum('QUOXBRAIN_EMBED_BACKFILL_WARMUP_MS', process.env.QUOXBRAIN_EMBED_BACKFILL_WARMUP_MS)) ?? DEFAULT_WARMUP_MS)
  const intervalMs = Number.isFinite(deps.intervalMs) ? deps.intervalMs : ((await resolveInstanceNum('QUOXBRAIN_EMBED_BACKFILL_INTERVAL_MS', process.env.QUOXBRAIN_EMBED_BACKFILL_INTERVAL_MS)) ?? DEFAULT_INTERVAL_MS)
  const maxOrgs = (await resolveInstanceNum('QUOXBRAIN_EMBED_BACKFILL_MAX_ORGS', process.env.QUOXBRAIN_EMBED_BACKFILL_MAX_ORGS)) ?? DEFAULT_MAX_ORGS_PER_TICK
  // batchCap left undefined falls through to backfillEmbeddings' own default
  // (limit=200), same "pass undefined, let the callee default" pattern
  // dreamScheduler.js uses for QUOXDREAM_BATCH_SIZE/QUOXDREAM_MAX_BATCHES.
  const batchCap = await resolveInstanceNum('QUOXBRAIN_EMBED_BACKFILL_BATCH_CAP', process.env.QUOXBRAIN_EMBED_BACKFILL_BATCH_CAP)

  const backfillEmbeddings = deps.backfillEmbeddings || backfillEmbeddingsDefault
  const getOrgIdsWithMissingEmbeddings = deps.getOrgIdsWithMissingEmbeddings || getOrgIdsNeedingEmbeddingWorkDefault
  // 084: live provider model (null when unknown), so an org uniformly embedded
  // in an obsolete model is still discovered for healing. Injected discovery
  // (tests) gets no probe unless deps.getCurrentModel is given.
  const getCurrentModel = deps.getCurrentModel || (deps.getOrgIdsWithMissingEmbeddings
    ? async () => null
    : async () => (await getEmbeddingProviderCached())?.model ?? null)
  const markEmbedOrgAttempted = deps.markEmbedOrgAttempted || markEmbedOrgAttemptedDefault
  const setTimeoutFn = deps.setTimeoutFn || setTimeout
  const setIntervalFn = deps.setIntervalFn || setInterval

  // INFRA-CPU (2026-08-30 CPU incident): with the embed seam down, every
  // tick called backfillEmbeddings for every discovered org, each batch
  // blocking on embeddingClient's full 45s timeout, and NEVER counted the
  // timeout as a failure (embeddingClient's best-effort [] return looked
  // identical to "nothing to embed") — so nothing ever backed off, and the
  // scheduler spun at full cadence for ~30h achieving nothing. Two minimal,
  // in-memory (no schema for per-chunk retry state exists) backoffs fix
  // this: an org whose batch fails outright is skipped for a growing number
  // of ticks, and a tick that makes zero progress at all skips the same way
  // — both capped so the effective gap between real attempts never exceeds
  // MAX_BACKOFF_MS regardless of how small intervalMs is configured.
  const MAX_BACKOFF_MS = 15 * 60 * 1000
  const backoffTicksCap = Math.max(1, Math.round(MAX_BACKOFF_MS / intervalMs))
  let consecutiveStalledTicks = 0
  let backoffTicksRemaining = 0
  const orgFailureStreak = new Map()
  const orgCooldownTicks = new Map()

  // 108: single-flight. A tick that outlives the interval must not be joined by
  // another one (duplicate embed calls, cost, cursor races).
  let tickRunning = false
  const runTick = async () => {
    if (tickRunning) {
      console.warn('[EmbedBackfill] tick skipped: previous tick still running')
      return
    }
    tickRunning = true
    try {
      await runTickInner()
    } finally {
      tickRunning = false
    }
  }

  const runTickInner = async () => {
    if (backoffTicksRemaining > 0) {
      backoffTicksRemaining -= 1
      console.log(`[EmbedBackfill] tick skipped: backing off after ${consecutiveStalledTicks} consecutive zero-progress tick(s), ${backoffTicksRemaining} tick(s) of backoff remaining`)
      return
    }

    let orgIds
    try {
      let currentModel = null
      try { currentModel = await getCurrentModel() } catch { currentModel = null }
      orgIds = getOrgIdsWithMissingEmbeddings(maxOrgs, currentModel)
    } catch (err) {
      console.error(`[EmbedBackfill] failed to discover orgs with missing embeddings: ${err.message}`)
      return
    }

    if (!orgIds || orgIds.length === 0) {
      console.log('[EmbedBackfill] tick complete: no orgs with missing embeddings')
      consecutiveStalledTicks = 0
      return
    }

    let totalEmbedded = 0
    let totalSkipped = 0
    let totalHealed = 0
    let failed = 0
    for (const orgId of orgIds) {
      // Per-org backoff: an org that failed outright on a recent tick is
      // not worth retrying immediately — skip it until its cooldown expires.
      const cooldown = orgCooldownTicks.get(orgId) || 0
      if (cooldown > 0) {
        orgCooldownTicks.set(orgId, cooldown - 1)
        continue
      }
      try {
        // 082: record the visit up front so discovery rotates even when the org fails.
        try { markEmbedOrgAttempted(orgId) } catch (err) { console.error(`[EmbedBackfill] could not record attempt for org=${orgId}: ${err.message}`) }
        const result = await backfillEmbeddings(orgId, { limit: batchCap }, deps)
        totalEmbedded += result.embedded
        totalSkipped += result.skipped
        totalHealed += result.healed || 0
        const itemFailures = result.failed || 0
        failed += itemFailures
        if (result.error) failed += 1
        if (result.error || itemFailures > 0) {
          const streak = (orgFailureStreak.get(orgId) || 0) + 1
          orgFailureStreak.set(orgId, streak)
          const cooldownTicks = Math.min(streak, backoffTicksCap)
          orgCooldownTicks.set(orgId, cooldownTicks)
          const retired = streak >= backoffTicksCap ? ' (retired — capped at max backoff until it succeeds again)' : ''
          console.warn(`[EmbedBackfill] org=${orgId} failed (streak ${streak}), backing off ${cooldownTicks} tick(s)${retired}`)
        } else {
          orgFailureStreak.delete(orgId)
          orgCooldownTicks.delete(orgId)
        }
      } catch (err) {
        failed += 1
        const streak = (orgFailureStreak.get(orgId) || 0) + 1
        orgFailureStreak.set(orgId, streak)
        orgCooldownTicks.set(orgId, Math.min(streak, backoffTicksCap))
        console.error(`[EmbedBackfill] backfillEmbeddings failed for org=${orgId}: ${err.message}`)
      }
    }

    // A tick that discovered orgs with missing embeddings but embedded
    // nothing (embed seam down/timing out, provider hiccup) is a
    // warning-worthy stall, not a silent no-op, same rationale as
    // embeddingClient.js's timeout logging: a stuck backfill should be
    // visible in logs, not indistinguishable from "caught up". It's also
    // the trigger for the whole-tick zero-progress backoff above: a tick
    // that made real progress resets it, a stalled one grows it.
    const madeProgress = totalEmbedded > 0 || totalHealed > 0
    if (madeProgress) {
      consecutiveStalledTicks = 0
    } else {
      consecutiveStalledTicks += 1
      backoffTicksRemaining = Math.min(consecutiveStalledTicks, backoffTicksCap)
    }
    const logFn = madeProgress ? console.log : console.warn
    const suffix = madeProgress ? '' : ', WARNING: orgs had embedding work but nothing was embedded or healed this tick'
    logFn(`[EmbedBackfill] tick complete: ${orgIds.length} org(s), ${totalEmbedded} embedded, ${totalHealed} healed, ${totalSkipped} skipped, ${failed} failed${suffix}`)
  }

  console.log(`[EmbedBackfill] scheduler enabled (warmup ${Math.round(warmupMs / 1000)}s, every ${Math.round(intervalMs / 60000)}min, up to ${maxOrgs} org(s)/tick, batch=${batchCap ?? 200}/org)`)

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

export default { startEmbeddingBackfillScheduler, DEFAULT_WARMUP_MS, DEFAULT_INTERVAL_MS, DEFAULT_MAX_ORGS_PER_TICK }
