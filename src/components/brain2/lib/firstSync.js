// firstSync.js - BRAIN2-V2 V2-6 pure state derivation for the onboarding
// "first sync" step. Input is one row of GET /api/feed/status
// ({sourceType, last_sync, last_status, last_count}); nothing is invented
// client-side. The feed API reports no "running" flag, so there is no running
// state: a source is either waiting for its first scheduled run or has a
// server-recorded result.

export const SYNC_STATES = ['waiting', 'synced', 'failed', 'skipped']

const lower = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '')

/** @returns {{state:'waiting'|'synced'|'failed'|'skipped', count:number, at:string|null, error:string|null, terminal:boolean}} */
export function deriveSourceSync(row) {
  const status = lower(row?.last_status)
  const at = row?.last_sync || null
  const count = Number(row?.last_count) || 0
  const raw = typeof row?.last_status === 'string' ? row.last_status.trim() : ''
  if (status.startsWith('error')) {
    const error = raw.replace(/^error:?\s*/i, '') || 'Sync failed'
    return { state: 'failed', count, at, error, terminal: true }
  }
  if (status.startsWith('skipped')) {
    return { state: 'skipped', count, at, error: raw.replace(/^skipped:?\s*/i, '') || 'Skipped', terminal: true }
  }
  // "synced" needs a server-recorded run time AND an ok status.
  if (at && status.startsWith('ok')) return { state: 'synced', count, at, error: null, terminal: true }
  return { state: 'waiting', count: 0, at: null, error: null, terminal: false }
}

/** Merge enabled-source rows with the status payload, by sourceType. */
export function deriveFirstSync(sources, statusPayload) {
  const byType = new Map((statusPayload?.sources || []).map((r) => [r.sourceType, r]))
  const rows = (Array.isArray(sources) ? sources : []).map((s) => ({
    sourceType: s.sourceType,
    name: s.name || s.sourceType,
    ...deriveSourceSync(byType.get(s.sourceType))
  }))
  return {
    rows,
    allTerminal: rows.length > 0 && rows.every((r) => r.terminal),
    anySynced: rows.some((r) => r.state === 'synced')
  }
}
