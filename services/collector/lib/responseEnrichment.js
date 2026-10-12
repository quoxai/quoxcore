/**
 * Response Enrichment Pipeline — QMD-A
 *
 * Async post-response processing for every chat interaction.
 * Non-blocking: fires after res.json(), never delays user response.
 *
 * Two functions:
 * 1. Session tracking — maintains conversation state, writes journals
 * 2. Quality scoring — heuristic evaluation of response quality
 *
 * Powers: QuoxDream (session journals), QuoxReflect (quality scores)
 */

const MEMORY_URL = `http://${process.env.MEMORY_HOST || 'memory'}:${process.env.MEMORY_PORT || '3103'}`
const SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY || ''
const SESSION_TIMEOUT_MS = 10 * 60 * 1000  // 10 minutes
const MIN_MESSAGES_FOR_JOURNAL = 3

// ── Session State ─────────────────────────────────────────────────
// In-memory tracking per session_id. Lightweight, lost on restart (acceptable).

const sessions = new Map()

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      id: sessionId,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      messageCount: 0,
      agentsUsed: new Set(),
      toolsCalled: new Set(),
      topics: [],
      qualityScores: [],
      errors: 0,
      journalSaved: false,
      // TRUST-GATE-1.22: real tenant scope, threaded in from the chat
      // dispatch's JWT-derived org/user (see enrichResponse below). Never
      // defaults to a hardcoded org/user here — a session without a real
      // orgId should stay null until enrichResponse supplies one.
      orgId: null,
      userId: null,
    })
  }
  const session = sessions.get(sessionId)
  session.lastActivityAt = Date.now()
  return session
}

// ── Quality Scoring ───────────────────────────────────────────────
// Heuristic: 0-100 based on observable signals.

function scoreQuality(data) {
  let score = 50  // baseline

  // Response exists and has content
  if (data.responseLength > 100) score += 15
  else if (data.responseLength > 20) score += 5
  else if (data.responseLength === 0) score -= 20

  // Tools were used when query was about infrastructure
  const infraQuery = /host|server|docker|ssh|deploy|fleet|disk|cpu|memory|network|proxmox|status|health/i.test(data.prompt || '')
  if (infraQuery && data.toolsUsed > 0) score += 15
  if (infraQuery && data.toolsUsed === 0) score -= 10

  // No "I can't" / "I don't have access" in response
  if (data.responseContainsCantAccess) score -= 25

  // No error
  if (data.error) score -= 30

  // Agent delegation happened (specialist used, not just quox)
  if (data.agentId && data.agentId !== 'quox') score += 5

  return Math.max(0, Math.min(100, score))
}

// ── Enrichment Entry Point ────────────────────────────────────────

/**
 * Called after every chat response. Non-blocking.
 *
 * @param {Object} data
 * @param {string} data.sessionId
 * @param {string} data.agentId
 * @param {string} data.prompt — user's query
 * @param {string} data.orgId
 * @param {string} data.userId
 * @param {number} data.responseLength — response text length
 * @param {number} data.toolsUsed — count of tool calls in response
 * @param {boolean} data.responseContainsCantAccess — "I can't" / "I don't have access"
 * @param {boolean} data.error — whether the response was an error
 * @param {number} data.durationMs — total response time
 */
function enrichResponse(data) {
  try {
    const session = getSession(data.sessionId || 'unknown')
    // TRUST-GATE-1.22: thread the chat dispatch's real org/user onto the
    // session so writeSessionJournal can scope the eventual journal write
    // to the tenant the conversation actually belonged to, instead of a
    // hardcoded 'default'/'system' regardless of caller.
    if (data.orgId) session.orgId = data.orgId
    if (data.userId) session.userId = data.userId
    session.messageCount++
    if (data.agentId) session.agentsUsed.add(data.agentId)

    // Extract topic hint from prompt (first 5 significant words)
    const words = (data.prompt || '').split(/\s+/).filter(w => w.length > 3).slice(0, 5).join(' ')
    if (words) session.topics.push(words)

    // Quality score
    const quality = scoreQuality(data)
    session.qualityScores.push(quality)
    if (data.error) session.errors++

    // Log for debugging
    if (quality < 40) {
      console.log(`[Enrichment] Low quality score: ${quality} for session ${data.sessionId} (agent: ${data.agentId})`)
    }
  } catch (err) {
    // Never block — log and continue
    console.warn('[Enrichment] Error:', err.message)
  }
}

// ── Session Journal Writer ────────────────────────────────────────

/**
 * Writes session journal to memory service.
 * Called when session ends (timeout) or reaches 10+ messages.
 */
async function writeSessionJournal(session) {
  if (session.journalSaved) return
  if (session.messageCount < MIN_MESSAGES_FOR_JOURNAL) return
  session.journalSaved = true

  const avgQuality = session.qualityScores.length > 0
    ? Math.round(session.qualityScores.reduce((a, b) => a + b, 0) / session.qualityScores.length)
    : 50

  const journal = {
    session_id: session.id,
    started_at: new Date(session.startedAt).toISOString(),
    duration_minutes: Math.round((session.lastActivityAt - session.startedAt) / 60000),
    message_count: session.messageCount,
    agents_used: [...session.agentsUsed],
    topics: [...new Set(session.topics)].slice(0, 10),
    avg_quality: avgQuality,
    errors: session.errors,
  }

  const content = `Session journal: ${journal.message_count} messages over ${journal.duration_minutes}min. ` +
    `Agents: ${journal.agents_used.join(', ') || 'quox'}. ` +
    `Quality: ${journal.avg_quality}%. ` +
    `Topics: ${journal.topics.slice(0, 5).join('; ') || 'general'}. ` +
    `Errors: ${journal.errors}.`

  // Night-2 D1: the org fallback is a last-resort safety net, not a silent
  // default — if a session genuinely reached journal-write time without a
  // real orgId (should not happen in production; enrichResponse always
  // supplies one from the chat dispatch's JWT/service-key context), that is
  // itself a signal something upstream failed to plumb tenant context. Log
  // it loudly so a cross-tenant-looking journal is traceable, never silent.
  if (!session.orgId) {
    console.warn(`[QuoxDream] Session ${session.id} has no real orgId at journal-write time — falling back to 'default' (multi-tenant scoping degraded for this write)`)
  }

  try {
    const res = await fetch(`${MEMORY_URL}/api/memory`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Key': SERVICE_KEY,
        // TRUST-GATE-1.12a: the memory service strips org_id/user_id from the
        // JSON body (tenant-injection defence) and scopes service-key calls
        // from these headers instead — sending them only in the body meant
        // this write silently landed under the fallback 'default'/'service'
        // scope rather than the session-journal's intended org/user.
        //
        // TRUST-GATE-1.22: these headers previously hardcoded 'default'/
        // 'system' on EVERY write regardless of which org/user the chat
        // session belonged to — every tenant's dream journals collapsed
        // into org 'default'. Now scoped from the session's real org/user,
        // threaded in by enrichResponse() from the chat dispatch's JWT
        // context. The org fallback below is a last-resort safety net for
        // sessions that somehow never received a real org (warned above);
        // the user fallback ('system') is legitimate for genuinely
        // system-initiated journals with no real user.
        'X-Org-Id': session.orgId || 'default',
        'X-User-Id': session.userId || 'system',
      },
      body: JSON.stringify({
        agent_id: 'quoxdream',
        memory_type: 'observation',
        content,
        importance: avgQuality < 50 ? 'high' : 'medium',
        // Raw array — the memory service's createMemory() JSON.stringifies
        // tags internally. Sending an already-stringified array here
        // double-encodes it and corrupts the stored value.
        tags: ['session_journal', ...journal.agents_used],
        provenance: 'tool_output',
      }),
      signal: AbortSignal.timeout(5000),
    })

    if (!res.ok) {
      const bodyExcerpt = await res.text().catch(() => '').then(t => (t || '').slice(0, 300))
      console.error(`[QuoxDream] Journal save failed: HTTP ${res.status} — ${bodyExcerpt || '(empty body)'}`)
      return
    }

    console.log(`[QuoxDream] Session journal saved: ${session.messageCount} messages, quality ${avgQuality}%`)
  } catch (err) {
    // Non-blocking by design (fire-and-forget from the response path), but
    // the failure must be loud — silent-success on a cross-service write is
    // a documented worst-class bug (never persisted, nobody noticed).
    console.error(`[QuoxDream] Journal save failed (network/exception): ${err.message}`)
  }
}

// ── Periodic Cleanup + Journal Flush ──────────────────────────────

/**
 * Check for timed-out sessions and write their journals.
 * Call this on a 60s interval.
 */
function flushStaleSessions() {
  const now = Date.now()
  for (const [id, session] of sessions) {
    if (now - session.lastActivityAt > SESSION_TIMEOUT_MS) {
      writeSessionJournal(session)
      sessions.delete(id)
    }
  }
}

/**
 * Get enrichment stats for the Mirror.
 */
function getEnrichmentStats() {
  let totalSessions = sessions.size
  let totalMessages = 0
  let totalQuality = 0
  let qualityCount = 0

  for (const session of sessions.values()) {
    totalMessages += session.messageCount
    for (const q of session.qualityScores) {
      totalQuality += q
      qualityCount++
    }
  }

  return {
    activeSessions: totalSessions,
    totalMessages,
    avgQuality: qualityCount > 0 ? Math.round(totalQuality / qualityCount) : null,
  }
}

/**
 * Start the periodic flush timer.
 */
function startEnrichmentTimer() {
  const enrichmentTimer = setInterval(flushStaleSessions, 60000)
  if (enrichmentTimer.unref) enrichmentTimer.unref()
}

module.exports = { enrichResponse, flushStaleSessions, getEnrichmentStats, startEnrichmentTimer, writeSessionJournal, getSession }
