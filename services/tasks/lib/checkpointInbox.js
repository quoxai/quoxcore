// quox#896: an objective checkpoint waiting for a human never reached the
// Approvals inbox, so LUCID said "nothing needs you" and chat said "nothing
// pending" while one waited. HITL is the primary sink: every pending
// checkpoint now raises ONE Approvals item (payload.source
// 'objective_checkpoint'), recorded on the checkpoint row so it is never
// raised twice, and closed when the checkpoint is decided elsewhere.
//
// The item deliberately carries NO tasks_objective_id: that field routes an
// inbox respond into the objective resume bridge, which is not this
// checkpoint's decision path.
//
// Scheduler triad (reconcileCheckpointInbox + startCheckpointInboxReconciler):
// failures are counted apart from "nothing to do", ticks with failures and no
// progress back off, and a checkpoint that failed MAX_RAISE_ATTEMPTS raises is
// retired (logged once) instead of being retried forever.

export const MAX_RAISE_ATTEMPTS = 5
const authUrl = () => process.env.AUTH_SERVICE_URL || 'http://auth:3101'
const serviceKey = () => process.env.INTERNAL_SERVICE_KEY || ''

function loadCheckpoint(db, checkpointId) {
  return db.prepare(`
    SELECT c.id, c.objective_id, c.task_id, c.checkpoint_type, c.status, c.title, c.description,
           c.inbox_item_id, c.inbox_closed_at, c.inbox_raise_attempts,
           o.org_id, o.user_id, o.title AS objective_title
    FROM checkpoints c INNER JOIN objectives o ON o.id = c.objective_id
    WHERE c.id = ?
  `).get(checkpointId)
}

async function postInbox(fetchImpl, orgId, body) {
  const res = await fetchImpl(`${authUrl()}/api/internal/orgs/${encodeURIComponent(orgId)}/inbox`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(serviceKey() ? { 'x-service-key': serviceKey() } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
  let json = null
  try { json = await res.json() } catch { /* empty body */ }
  return { ok: res.ok, status: res.status, json }
}

/** Raise the Approvals item for one pending checkpoint. Idempotent. */
export async function raiseCheckpointInboxItem(db, checkpointId, { fetchImpl = fetch } = {}) {
  const cp = loadCheckpoint(db, checkpointId)
  if (!cp) return { ok: false, error: 'checkpoint_not_found' }
  if (cp.inbox_item_id) return { ok: true, skipped: 'already_raised', itemId: cp.inbox_item_id }
  if (cp.status !== 'pending') return { ok: true, skipped: 'not_pending' }

  const kindLabel = String(cp.checkpoint_type || 'checkpoint').replace(/_/g, ' ')
  const body = {
    kind: 'approval',
    priority: 'high',
    // The short checkpoint id keeps two checkpoints on one objective from
    // collapsing into one under the inbox's 30-minute title dedup.
    title: `Objective checkpoint (${kindLabel}): ${cp.objective_title} [${cp.id.slice(-6)}]`,
    body_md: `${cp.description || cp.title || 'This objective is waiting for a human decision.'}\n\nObjective: ${cp.objective_title} (\`${cp.objective_id}\`)\nCheckpoint: ${kindLabel} (\`${cp.id}\`)\n\nDecide here, or with \`quox objective approve ${cp.objective_id} ${cp.id}\`.`,
    payload: {
      what: {
        action: `pass objective checkpoint (${kindLabel})`,
        target: `objective ${cp.objective_id}`,
        summary: `let objective "${String(cp.objective_title || cp.objective_id).slice(0, 100)}" continue past its ${kindLabel}${cp.title ? `: ${String(cp.title).slice(0, 100)}` : ''}`,
      },
      source: 'objective_checkpoint',
      objective_id: cp.objective_id,
      checkpoint_id: cp.id,
      checkpoint_type: cp.checkpoint_type,
      task_id: cp.task_id || undefined,
      actions: ['approve', 'deny'],
    },
    assignee_user_id: cp.user_id || undefined,
  }

  let r
  try {
    r = await postInbox(fetchImpl, cp.org_id, body)
    // An agent-owned objective's user_id is not an org member: fall back to
    // the org's owners/admins rather than losing the item.
    if (!r.ok && r.status === 400 && body.assignee_user_id) {
      delete body.assignee_user_id
      r = await postInbox(fetchImpl, cp.org_id, body)
    }
  } catch (e) {
    r = { ok: false, status: 0, error: e?.message || String(e) }
  }

  const itemId = r.ok ? (r.json?.item?.id || r.json?.existing_item_id || null) : null
  if (!itemId) {
    db.prepare('UPDATE checkpoints SET inbox_raise_attempts = inbox_raise_attempts + 1 WHERE id = ?').run(cp.id)
    return { ok: false, status: r.status, error: r.error || r.json?.error || `HTTP ${r.status}` }
  }
  db.prepare('UPDATE checkpoints SET inbox_item_id = ? WHERE id = ? AND inbox_item_id IS NULL').run(itemId, cp.id)
  return { ok: true, itemId }
}

/** Close the mirror item after the checkpoint was decided. Idempotent. */
export async function closeCheckpointInboxItem(db, checkpointId, { action = 'approve', actorType = 'service', actorId = 'tasks:checkpoint-inbox', reason, fetchImpl = fetch } = {}) {
  const cp = loadCheckpoint(db, checkpointId)
  if (!cp || !cp.inbox_item_id) return { ok: true, skipped: 'no_item' }
  if (cp.inbox_closed_at) return { ok: true, skipped: 'already_closed' }
  try {
    const res = await fetchImpl(`${authUrl()}/api/internal/orgs/${encodeURIComponent(cp.org_id)}/inbox/${encodeURIComponent(cp.inbox_item_id)}/resolve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(serviceKey() ? { 'x-service-key': serviceKey() } : {}),
        'x-actor-type': actorType,
        'x-actor-id': actorId,
      },
      body: JSON.stringify({ action, reason: reason || `Checkpoint ${cp.status} in the objective` }),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return { ok: false, status: res.status }
  } catch (e) {
    return { ok: false, status: 0, error: e?.message || String(e) }
  }
  db.prepare("UPDATE checkpoints SET inbox_closed_at = datetime('now') WHERE id = ?").run(cp.id)
  return { ok: true }
}

/** One bounded pass: raise missing items, close decided ones. */
export async function reconcileCheckpointInbox(db, { fetchImpl = fetch, limit = 50, log = () => {} } = {}) {
  const out = { raised: 0, closed: 0, failed: 0, retired: 0 }
  const toRaise = db.prepare(`
    SELECT id, inbox_raise_attempts FROM checkpoints
    WHERE status = 'pending' AND inbox_item_id IS NULL
    ORDER BY created_at ASC LIMIT ?
  `).all(limit)
  for (const row of toRaise) {
    if (row.inbox_raise_attempts >= MAX_RAISE_ATTEMPTS) { out.retired += 1; continue }
    const r = await raiseCheckpointInboxItem(db, row.id, { fetchImpl })
    if (r.ok && !r.skipped) out.raised += 1
    else if (!r.ok) {
      out.failed += 1
      if (row.inbox_raise_attempts + 1 >= MAX_RAISE_ATTEMPTS) log(`[CheckpointInbox] retiring ${row.id} after ${MAX_RAISE_ATTEMPTS} failed raises (last: ${r.error || r.status})`)
    }
  }
  const toClose = db.prepare(`
    SELECT id, status FROM checkpoints
    WHERE status != 'pending' AND inbox_item_id IS NOT NULL AND inbox_closed_at IS NULL
    ORDER BY created_at ASC LIMIT ?
  `).all(limit)
  for (const row of toClose) {
    const action = row.status === 'approved' ? 'approve' : 'deny'
    const r = await closeCheckpointInboxItem(db, row.id, { action, fetchImpl })
    if (r.ok && !r.skipped) out.closed += 1
    else if (!r.ok) out.failed += 1
  }
  return out
}

/** Boot backfill + periodic reconcile with failure accounting and backoff. */
export function startCheckpointInboxReconciler(getDb, { baseMs = 10 * 60 * 1000, maxMs = 2 * 60 * 60 * 1000, firstDelayMs = 30 * 1000 } = {}) {
  let delay = baseMs
  let timer = null
  let stopped = false
  const tick = async () => {
    if (stopped) return
    let r
    try {
      r = await reconcileCheckpointInbox(getDb(), { log: (m) => console.log(m) })
    } catch (e) {
      r = { raised: 0, closed: 0, failed: 1, retired: 0, error: e?.message }
    }
    const progress = r.raised + r.closed
    if (r.failed > 0 && progress === 0) delay = Math.min(delay * 2, maxMs)
    else delay = baseMs
    if (progress || r.failed || r.error) {
      console.log(`[CheckpointInbox] tick raised=${r.raised} closed=${r.closed} failed=${r.failed} retired=${r.retired}${r.error ? ` error=${r.error}` : ''} next=${Math.round(delay / 1000)}s`)
    }
    if (!stopped) { timer = setTimeout(tick, delay); timer.unref?.() }
  }
  timer = setTimeout(tick, firstDelayMs)
  timer.unref?.()
  return () => { stopped = true; if (timer) clearTimeout(timer) }
}
