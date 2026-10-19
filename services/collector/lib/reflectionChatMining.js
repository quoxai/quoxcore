/**
 * BRAIN2-FABLE11 quox#1193 (owner 2026-10-17): opt-in mining of REAL chats.
 * Each mined fact is written ONLY to the asking user's PERSONAL memory scope
 * (X-User-Id = the session identity). Never org scope. The per-org opt-in
 * (REFLECTION_MINING_CHATS_ENABLED) is checked by the scheduler, fail closed.
 */
'use strict'

const MAX_PAIRS_PER_SESSION = 20
const SVC_IDENTITY = '__svc__'

function summarizeLazy(text, max) {
  // lazy: the scheduler requires this module, so a top-level require would be circular
  return require('./reflectionMiningScheduler.js').summarize(text, max)
}

/** Pure. Pair each user turn with the next assistant turn. */
function extractChatMemories(turns, sessionId) {
  const out = []
  if (!Array.isArray(turns)) return out
  let pendingUser = null
  for (const t of turns) {
    if (!t) continue
    const text = typeof t.content === 'string' ? t.content.trim() : ''
    if (t.role === 'user') {
      pendingUser = text || null
    } else if (t.role === 'assistant') {
      if (pendingUser && text) {
        out.push({
          memory_type: 'fact',
          content: `Q: ${summarizeLazy(pendingUser, 200)} A: ${summarizeLazy(text, 500)}`,
          tags: ['conversation_qa', 'source:chat', `session:${sessionId}`],
        })
        if (out.length >= MAX_PAIRS_PER_SESSION) break
      }
      pendingUser = null
    }
  }
  return out
}

/** Never throws. Failed writes are counted distinctly from empty results. */
async function runChatMining({
  orgId, after = 0, now = Date.now(), idleMs = 0, maxSessions = 10,
  listSessions, listTurns, postMemory, getMark, setMark, log = () => {},
} = {}) {
  const counts = { sessions: 0, mined: 0, written: 0, failed: 0, skipped: 0 }
  try {
    const sessions = (await listSessions({ orgId, after, limit: maxSessions * 5 })) || []
    for (const s of sessions) {
      if (counts.sessions >= maxSessions) break
      try {
        if (!s || !s.identity || s.identity === SVC_IDENTITY || !s.session_id) { counts.skipped++; continue }
        if (s.last_ts > now - idleMs) { counts.skipped++; continue }
        // Durable per-session mark: only turns newer than the last mined one are read, so a
        // continued session (or a collector restart) never writes the same Q/A twice.
        const mark = Number(await getMark(s.session_id)) || 0
        if (mark >= s.last_ts) { counts.skipped++; continue }
        counts.sessions++
        const turns = (await listTurns({ orgId, identity: s.identity, sessionId: s.session_id, after: Math.max(after, mark), limit: 200 })) || []
        const memories = extractChatMemories(turns, s.session_id)
        counts.mined += memories.length
        let sessionFailed = 0
        for (const memory of memories) {
          const res = await postMemory({ orgId, memory, userId: s.identity })
          if (!res || res.error) { counts.failed++; sessionFailed++ } else counts.written++
        }
        // all writes failed: leave the mark so the session is retried
        if (memories.length === 0 || sessionFailed < memories.length) await setMark(s.session_id, s.last_ts)
      } catch (err) {
        counts.failed++
        log(`session failed: ${err.message}`)
      }
    }
  } catch (err) {
    counts.failed++
    log(`chat mining failed: ${err.message}`)
  }
  return counts
}

module.exports = { extractChatMemories, runChatMining, MAX_PAIRS_PER_SESSION }
