// tenantBudget.js: BRAIN2-W7 C 145. Per-org request budget for the
// retrieval routes (/brain/search, /brain/context) so one tenant cannot
// monopolise shared CPU and embedding work. Fixed one-minute window, in
// process. Bounded: expired windows are pruned so the map cannot grow
// without limit. Limit via QUOXBRAIN_ORG_RPM (default 600/min/org; 0 turns
// the budget off). Every rejection is counted and visible via
// tenantBudgetStats().

const WINDOW_MS = 60_000
const DEFAULT_RPM = 600

const windows = new Map() // org_id -> { start, count }
let rejected = 0

function limitPerMinute() {
  const raw = process.env.QUOXBRAIN_ORG_RPM
  if (raw === undefined || raw === '') return DEFAULT_RPM
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RPM
}

/** @returns {{ok:true}|{ok:false, retryAfterSec:number}} */
export function consumeOrgBudget(orgId, now = Date.now()) {
  const limit = limitPerMinute()
  if (limit === 0 || !orgId) return { ok: true }
  let w = windows.get(orgId)
  if (!w || now - w.start >= WINDOW_MS) {
    w = { start: now, count: 0 }
    windows.set(orgId, w)
    if (windows.size > 5000) {
      for (const [k, v] of windows) if (now - v.start >= WINDOW_MS) windows.delete(k)
    }
  }
  if (w.count >= limit) {
    rejected += 1
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((w.start + WINDOW_MS - now) / 1000)) }
  }
  w.count += 1
  return { ok: true }
}

export function orgBudgetMiddleware(req, res, next) {
  const r = consumeOrgBudget(req.org_id)
  if (r.ok) return next()
  res.set('Retry-After', String(r.retryAfterSec))
  return res.status(429).json({ error: 'per-org request budget exceeded', retryAfterSec: r.retryAfterSec })
}

export function tenantBudgetStats() { return { orgs: windows.size, rejected } }
export function _resetTenantBudget() { windows.clear(); rejected = 0 }
