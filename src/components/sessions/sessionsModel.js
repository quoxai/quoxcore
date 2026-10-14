/**
 * sessionsModel: pure helpers for the /sessions overview (QUOXON J3), the
 * dashboard face of GET /api/v1/sessions. Mirrors the CLI's `quox sessions`
 * rules (cli/lib/core/sessionsOverview.js prepareIndex) so both surfaces show
 * the same rows: every tmux session, slot, resident and running piece of work,
 * every working/waiting conversation, and only the RECENT_CONVERSATIONS most
 * recent quiet conversations (the rest fold into "+N more conversations").
 */

export const RECENT_CONVERSATIONS = 5
export const STATES = ['working', 'waiting', 'resting', 'failing']
export const STATE_LABEL = { working: 'working', waiting: 'waiting', resting: 'resting', failing: 'failing' }

const KEEP_KINDS = new Set(['tmux', 'slot', 'resident', 'objective', 'loop', 'workflow'])

const timeOf = (r) => {
  const t = Date.parse(r && r.last_active)
  return Number.isFinite(t) ? t : -Infinity
}

/** One-line title, clipped on a word boundary near the end (same as the CLI). */
export function clipTitle(raw, max = 48) {
  const s = String(raw ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()
  const a = [...s]
  if (a.length <= max) return s
  const cut = a.slice(0, max - 1).join('')
  const sp = cut.lastIndexOf(' ')
  return (sp >= Math.floor(max / 2) ? cut.slice(0, sp) : cut).replace(/[\s,.;:-]+$/, '') + '…'
}

/** tmux rows carry their backend: "tmux·claude". */
export function kindLabel(r) {
  if (r.kind === 'tmux') return r.backend ? `tmux·${r.backend}` : 'tmux'
  return r.kind || 'unknown'
}

/** Rows with no host are server-side (conversations, slots, work); a tmux row without one is unknown. */
export function hostLabel(r, serverHost = null) {
  if (!r.host) return r.kind === 'tmux' ? 'unknown host' : 'server'
  return serverHost && r.host === serverHost ? `${r.host} (server)` : r.host
}

/** Compact relative age: 12s, 4m, 3h, 2d. */
export function formatAge(lastActive, now = Date.now()) {
  const t = Date.parse(lastActive || '')
  if (!Number.isFinite(t)) return 'unknown'
  const s = Math.max(0, Math.floor((now - t) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/**
 * -> { groups: [{ agent, rows, hidden }], hiddenConversations, shown }
 * `expanded` keeps every row. Rows are regrouped by their own agent, newest
 * activity first; "no agent" goes last. Each group also reports how many of
 * its quiet conversations are folded away so the toggle can sit in the group.
 */
export function prepareIndex(index, { expanded = false, keep = RECENT_CONVERSATIONS } = {}) {
  const src = (index && Array.isArray(index.groups) && index.groups.length)
    ? index.groups.flatMap((g) => g.rows || [])
    : (index && Array.isArray(index.rows) ? index.rows : [])
  const rows = src.map((r) => (r.kind === 'conversation'
    ? { ...r, name: clipTitle(r.name || '(untitled)') }
    : r))
  const quiet = rows
    .filter((r) => r.kind === 'conversation' && r.state !== 'working' && r.state !== 'waiting')
    .sort((a, b) => timeOf(b) - timeOf(a))
  const hiddenSet = new Set(quiet.slice(keep))
  const kept = expanded ? rows : rows.filter((r) => !hiddenSet.has(r))
  const by = new Map()
  for (const r of [...kept].sort((a, b) => timeOf(b) - timeOf(a))) {
    const k = r.agent || null
    if (!by.has(k)) by.set(k, [])
    by.get(k).push(r)
  }
  const groups = [...by.entries()]
    .map(([agent, rs]) => ({ agent, rows: rs }))
    .sort((a, b) => (a.agent === null) - (b.agent === null) || timeOf(b.rows[0]) - timeOf(a.rows[0]))
  return { groups, hiddenConversations: expanded ? 0 : hiddenSet.size, foldable: hiddenSet.size, shown: kept.length }
}

/** Sources that are not connected, named honestly (state + note). */
export function degradedSources(index) {
  return ((index && index.sources) || []).filter((s) => s.state !== 'connected')
}

/** Counts, defaulting every tile to 0 and `live` to total. */
export function tileCounts(index) {
  const c = (index && index.counts) || {}
  return {
    live: c.total || 0,
    working: c.working || 0,
    waiting: c.waiting || 0,
    resting: c.resting || 0,
    failing: c.failing || 0,
  }
}

const AGENT_HUES = ['#38bdf8', '#818cf8', '#a855f7', '#06b6d4', '#f472b6', '#4ade80', '#fb923c', '#e879f9']

/** Agent colour: the registry colour when known, else a stable hue from the id. */
export function agentColor(agent, lookup) {
  if (!agent) return 'rgba(255,255,255,0.75)'
  const known = lookup ? lookup(agent) : null
  if (known) return known
  let h = 0
  for (const ch of String(agent)) h = (h * 31 + ch.codePointAt(0)) >>> 0
  return AGENT_HUES[h % AGENT_HUES.length]
}
