// annBackfillScheduler.js: drives annIndex.backfillTick. Scheduler triad
// (CLAUDE.md loop hygiene): failures counted distinctly from empty ticks,
// capped exponential backoff on zero-progress/failed ticks, durable retirement
// (cursor + ann_sync_retired in annIndex). Self-rescheduling setTimeout chain,
// unref'd. Dark unless QUOXBRAIN_ANN=qdrant.

import { annEnabled, backfillTick } from './annIndex.js'
import { getDatabase } from './db.js'

export const DEFAULT_WARMUP_MS = 20_000
export const BUSY_MS = 2_000          // more work remains: next batch soon
export const IDLE_MS = 5 * 60_000     // caught up: cheap periodic check
export const MAX_BACKOFF_MS = 15 * 60_000

export function nextDelay({ result, streak }) {
  if (result.error || (result.synced === 0 && result.retired === 0 && !result.done)) {
    return Math.min(MAX_BACKOFF_MS, BUSY_MS * 2 ** Math.min(streak, 10))
  }
  return result.done ? IDLE_MS : BUSY_MS
}

export function startAnnBackfillScheduler(deps = {}) {
  if (!(deps.force || annEnabled())) {
    console.log('[AnnBackfill] scheduler disabled (QUOXBRAIN_ANN!=qdrant)')
    return null
  }
  const tick = deps.backfillTick || backfillTick
  const setTimeoutFn = deps.setTimeoutFn || setTimeout
  let streak = 0
  let stopped = false
  const run = async () => {
    if (stopped) return
    let result
    try {
      result = await tick(deps.db || getDatabase(), deps.tickOpts || {})
    } catch (err) {
      result = { synced: 0, failed: 0, retired: 0, done: false, error: err.message }
    }
    streak = (result.error || (result.synced === 0 && result.retired === 0 && !result.done)) ? streak + 1 : 0
    console.log(`[AnnBackfill] tick synced=${result.synced} failed=${result.failed} retired=${result.retired} done=${result.done}${result.error ? ` error=${result.error}` : ''} streak=${streak}`)
    if (!stopped) setTimeoutFn(run, nextDelay({ result, streak })).unref?.()
  }
  const t = setTimeoutFn(run, deps.warmupMs ?? DEFAULT_WARMUP_MS)
  t?.unref?.()
  return { stop: () => { stopped = true } }
}
