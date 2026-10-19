/**
 * QuoxMind retirement scheduler — QUOXMIND #1112.
 *
 * Server-side, bounded, and built on the loop triad:
 *   - failure accounting: a failing step is counted separately from an empty
 *     result, and every tick logs one line with both.
 *   - backoff: zero-progress or failed ticks double the delay, capped.
 *   - retirement: every item it touches is durably retired (wisdom active = 0
 *     with a reason, orphaned tasks cancelled), so no item is re-attempted.
 *
 * Steps per tick: retire stale singletons + duplicates, decay stale wisdom
 * (once per 30 days per row), cancel pending tasks of terminal objectives.
 * Every step is idempotent, so a restart that re-arms the first tick is safe.
 */

import { retireWisdom, decayWisdom, retireOrphanedTasks } from './wisdomHygiene.js'

const HOUR = 3600000

export function createMindRetirementScheduler({
  getDb,
  intervalMs = 6 * HOUR,
  firstDelayMs = 10 * 60000,
  maxBackoffMs = 48 * HOUR,
  batch = 500,
  staleDays = 90,
  graceMinutes = 60,
  // 'retire' writes; 'report' only counts candidates and logs them (no data change).
  mode = 'retire',
  log = (m) => console.log(m),
  warn = (m) => console.warn(m),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
} = {}) {
  let timer = null
  let stopped = true
  let backoffLevel = 0
  const state = { ticks: 0, totalFailures: 0, consecutiveFailures: 0, lastTickAt: null, lastResult: null, nextDelayMs: firstDelayMs }

  async function tick() {
    const retired = { staleSingleton: 0, duplicate: 0 }
    let decayed = 0
    let tasksCancelled = 0
    let failures = 0
    const errors = []
    let db = null
    try { db = getDb() } catch (err) { failures += 1; errors.push(`db: ${err.message}`) }
    const step = (name, fn) => {
      if (!db) return null
      try { return fn(db) } catch (err) { failures += 1; errors.push(`${name}: ${err.message}`); return null }
    }

    const dryRun = mode === 'report'
    const r = step('retire_wisdom', (db) => retireWisdom(db, { staleDays, batch, dryRun }))
    if (r) Object.assign(retired, r)
    decayed = step('decay_wisdom', (db) => decayWisdom(db, { staleDays, batch, dryRun })) || 0
    tasksCancelled = step('retire_tasks', (db) => retireOrphanedTasks(db, { graceMinutes, batch, dryRun })) || 0

    // In report mode the same candidates recur every tick, so never reset backoff on them.
    const progress = dryRun ? 0 : retired.staleSingleton + retired.duplicate + decayed + tasksCancelled
    if (failures > 0 || progress === 0) backoffLevel += 1
    else backoffLevel = 0
    const nextDelayMs = Math.min(intervalMs * 2 ** backoffLevel, maxBackoffMs)

    state.ticks += 1
    state.totalFailures += failures
    state.consecutiveFailures = failures > 0 ? state.consecutiveFailures + 1 : 0
    state.lastTickAt = new Date().toISOString()
    state.nextDelayMs = nextDelayMs
    const result = { mode, retired, decayed, tasksCancelled, failures, errors, nextDelayMs }
    state.lastResult = result

    const line = `[QuoxMind] retirement tick${dryRun ? ' (REPORT ONLY, no changes; counts are candidates)' : ''}: wisdom retired stale_singleton=${retired.staleSingleton} duplicate=${retired.duplicate} decayed=${decayed} tasks_cancelled=${tasksCancelled} failures=${failures} next=${Math.round(nextDelayMs / 60000)}m`
    if (failures > 0) warn(`${line} errors=[${errors.join('; ')}]`)
    else log(line)
    return result
  }

  function schedule(ms) {
    if (stopped) return
    timer = setTimer(async () => {
      try { await tick() } catch (err) { state.totalFailures += 1; warn(`[QuoxMind] retirement tick crashed: ${err.message}`) }
      schedule(state.nextDelayMs)
    }, ms)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  return {
    tick,
    start() { if (!stopped) return; stopped = false; schedule(firstDelayMs) },
    stop() { stopped = true; if (timer) clearTimer(timer); timer = null },
    status() { return { ...state, mode, running: !stopped } },
  }
}
