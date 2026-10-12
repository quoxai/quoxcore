/**
 * Plain-English wording for the History log trail. The server sends only codes and ids
 * ({ts, intent, actor:{type,id}, contact_id, outcome, codes}); this is where they become sentences.
 */
import { DECISIONS, flagLabel, labelOf, CHANNELS, IDENTIFIER_CHANNELS, explainReason } from './reasonCodes'

const L = {
  create: 'Contact added', find: 'Contacts listed', read: 'Contact opened', read_full: 'Real details revealed', search: 'Contacts searched',
  resolve: 'Number or address looked up', archive: 'Contact archived', identifier_add: 'Number or address added',
  suppress: 'Added to the do-not-contact list', suppress_check: 'Do-not-contact check', settings_update: 'Settings changed',
  consent: 'Consent recorded', flags_changed: 'Flags changed', stage_changed: 'Stage changed', objection: 'Objection recorded',
  policy: 'Reach check', 'policy.decision': 'Reach check', 'lease.minted': 'Access granted for one use', 'lease.denied': 'Access refused',
  'lease.redeemed': 'Access used', 'lease.revoked': 'Access withdrawn', 'lease.claimed': 'Call picked up by the phone bridge', lease: 'Access lease',
  send: 'Message sent', touchpoint: 'Interaction logged', timeline_read: 'Timeline opened', edge_add: 'Relationship added', edge_remove: 'Relationship removed',
  erased: 'Contact erased', dsar_exported: 'Data export (DSAR) downloaded', notice_sent: 'Notice recorded', processing_record_exported: 'Processing record downloaded',
  retention_run: 'Automatic clean-up ran', rewrap: 'Keys re-wrapped', reindex: 'Search indexes rebuilt', strict_names_applied: 'Strict names setting applied',
  tombstone_lifted: 'Erasure block lifted', grant_create: 'Agent permission granted', grant_revoke: 'Agent permission withdrawn',
  import: 'Contacts imported', import_dry_run: 'Import previewed', merge: 'Contacts merged', unmerge: 'Merge undone', duplicates: 'Duplicates checked',
  fact_add: 'Fact added', fact_proposed: 'Fact proposed', fact_review: 'Fact reviewed', facts_read: 'Facts read',
  photo_set: 'Photo set', photo_removed: 'Photo removed',
}
const humanise = (s) => String(s || '').replace(/[._]/g, ' ').replace(/^./, (c) => c.toUpperCase())

/** "quox.contacts.lease.minted" to "Access granted for one use". Unknown intents are humanised, never shown raw. */
export function intentLabel(intent) {
  const rest = String(intent || '').replace(/^quox\.contacts\./, '')
  return L[rest] || humanise(rest) || 'Event'
}

const OUTCOMES = {
  created: 'created', added: 'added', exists: 'already there', conflict: 'refused, already another contact\'s', ok: 'done', hit: 'matched', miss: 'no match', candidate_created: 'new unknown caller saved',
  suppressed: 'on the list', clear: 'clear', archived: 'archived', erased: 'erased', exported: 'downloaded', active: 'active', revoked: 'withdrawn', sent: 'sent', failed: 'failed',
  set: 'set', removed: 'removed', merged: 'merged', undone: 'undone', imported: 'imported', dry_run: 'preview only', recorded: 'recorded', updated: 'updated', complete: 'complete', partial: 'partly done',
  lifted: 'lifted', proposed: 'proposed', applied: 'applied',
}
const sentence = (s) => String(s || '').replace(/_/g, ' ')

/** Who did it, as a short phrase. */
export function actorLabel(actor) {
  if (!actor) return 'Unknown'
  if (actor.type === 'human') return 'A person'
  if (actor.type === 'agent') return `Agent ${actor.id || ''}`.trim()
  return actor.id ? `Service ${actor.id}` : 'A service'
}

/** The codes of one event as plain phrases (decision, reasons, flags, channel, counts). */
export function codePhrases(codes = {}) {
  const out = []
  if (codes.decision) out.push(DECISIONS[codes.decision]?.label || sentence(codes.decision))
  if (Array.isArray(codes.reasons) && codes.reasons.length) out.push(codes.reasons.map((r) => explainReason(r).replace(/\.$/, '')).join('; '))
  if (typeof codes.reason === 'string' && codes.reason) out.push(`Reason: ${sentence(codes.reason)}`)
  if (Array.isArray(codes.flags)) out.push(codes.flags.length ? `Flags: ${codes.flags.map(flagLabel).join(', ')}` : 'No flags set')
  if (codes.channel) out.push(labelOf([...CHANNELS, ...IDENTIFIER_CHANNELS], codes.channel))
  if (codes.projection) out.push(`${sentence(codes.projection)} access`)
  if (codes.purpose) out.push(`Purpose: ${sentence(codes.purpose)}`)
  if (codes.scope) out.push(`Scope: ${sentence(codes.scope)}`)
  if (codes.surface) out.push(sentence(codes.surface))
  if (codes.stage) out.push(`Stage: ${sentence(codes.stage)}`)
  if (codes.format) out.push(String(codes.format).toUpperCase())
  if (typeof codes.count === 'number') out.push(`${codes.count} ${codes.count === 1 ? 'item' : 'items'}`)
  if (codes.counts && typeof codes.counts === 'object') {
    const bits = Object.entries(codes.counts).filter(([, n]) => typeof n === 'number').map(([k, n]) => `${n} ${sentence(k)}`)
    if (bits.length) out.push(bits.join(', '))
  }
  return out
}

/** One log row as display text: { title, who, outcome, details, contactId }. */
export function describeEvent(ev) {
  const outcome = ev.outcome ? (OUTCOMES[ev.outcome] || sentence(ev.outcome)) : ''
  return {
    title: intentLabel(ev.intent),
    who: actorLabel(ev.actor),
    outcome,
    details: codePhrases(ev.codes),
    contactId: ev.contact_id || null,
  }
}

/* ------------------------------------------------------------------------------------------------------------
 * The readable log: sentences, day groups, action filters and the noisy-read collapse.
 * The server envelope stays ids and codes only; names are resolved HERE, on the client, for a signed-in human.
 * ---------------------------------------------------------------------------------------------------------- */

const rest = (intent) => String(intent || '').replace(/^quox\.contacts\./, '')

/** Reads that fill the log with rows that mean nothing until clicked. Hidden by default behind "Show views". */
export const VIEW_INTENTS = new Set(['find', 'read', 'search', 'timeline_read', 'facts_read', 'resolve', 'duplicates', 'suppress_check', 'import_dry_run'])
const CALL_INTENTS = new Set(['send', 'lease', 'lease.minted', 'lease.denied', 'lease.redeemed', 'lease.revoked', 'lease.claimed'])
const PRIVACY_INTENTS = new Set(['suppress', 'objection', 'erased', 'dsar_exported', 'notice_sent', 'processing_record_exported', 'retention_run', 'rewrap', 'tombstone_lifted', 'read_full', 'consent', 'policy', 'policy.decision'])
const AGENT_INTENTS = new Set(['grant_create', 'grant_revoke', 'fact_proposed'])

export const LOG_FILTERS = [
  { key: 'all', label: 'Everything' },
  { key: 'calls', label: 'Calls and sends' },
  { key: 'changes', label: 'Changes' },
  { key: 'privacy', label: 'Privacy' },
  { key: 'agent', label: 'Agent' },
  { key: 'views', label: 'Views' },
]

/** 'views' | 'calls' | 'privacy' | 'changes': what kind of thing happened (independent of who did it). */
export function groupOf(ev) {
  const r = rest(ev.intent)
  if (VIEW_INTENTS.has(r)) return 'views'
  if (CALL_INTENTS.has(r)) return 'calls'
  if (PRIVACY_INTENTS.has(r)) return 'privacy'
  return 'changes'
}
export const isViewEvent = (ev) => groupOf(ev) === 'views'
export const isAgentEvent = (ev) => ev.actor?.type === 'agent' || AGENT_INTENTS.has(rest(ev.intent))

/** Does the event belong under this filter chip? */
export function matchesFilter(ev, filter = 'all') {
  if (filter === 'all') return true
  if (filter === 'agent') return isAgentEvent(ev)
  return groupOf(ev) === filter
}

/**
 * The rows to show: filter chip, contact filter, and (unless asked for) without the noisy reads.
 * Returns { rows, hiddenViews } where hiddenViews counts the read rows folded away.
 */
export function visibleEvents(events, { filter = 'all', contactId = '', showViews = false } = {}) {
  let hiddenViews = 0
  const rows = events.filter((ev) => {
    if (contactId && ev.contact_id !== contactId) return false
    if (!matchesFilter(ev, filter)) return false
    if (isViewEvent(ev) && !showViews && filter !== 'views') { hiddenViews += 1; return false }
    return true
  })
  return { rows, hiddenViews }
}

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/** "Today", "Yesterday", or a long date. */
export function dayLabel(ts, now = new Date()) {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return 'Unknown date'
  const diff = Math.round((startOfDay(new Date(now)) - startOfDay(d)) / 86400000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' })
}

/** [{ key, label, events }] newest day first, keeping the order of events inside a day. */
export function groupByDay(events, now = new Date()) {
  const out = []
  let cur = null
  for (const ev of events) {
    const d = new Date(ev.ts)
    const key = Number.isNaN(d.getTime()) ? 'unknown' : String(startOfDay(d))
    if (!cur || cur.key !== key) { cur = { key, label: dayLabel(ev.ts, now), events: [] }; out.push(cur) }
    cur.events.push(ev)
  }
  return out
}

export const fmtTime = (ts) => {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** Who did it, for people: "Adam (you)", "A teammate", "ContactsQ agent", "Service phone-bridge". `me` = { id, name } of the signed-in user. */
export function actorName(actor, me = null) {
  if (!actor) return 'Someone'
  if (actor.type === 'human') {
    if (me && me.id && actor.id === me.id) return me.name ? `${me.name} (you)` : 'You'
    return 'A teammate'
  }
  if (actor.type === 'agent') return !actor.id || /contacts?q/i.test(actor.id) ? 'ContactsQ agent' : `Agent ${actor.id}`
  return actor.id ? `Service ${actor.id}` : 'The system'
}

/** Verb phrases. `c` is the contact as a phrase ("Sean Proofer" or "a contact"). */
const VERB = {
  create: (c) => `added ${c}`,
  read_full: (c) => `revealed the real details of ${c}`,
  archive: (c) => `archived ${c}`,
  identifier_add: (c) => `added a number or address to ${c}`,
  suppress: () => 'added a number or address to the do-not-contact list',
  settings_update: () => 'changed the ContactsQ settings',
  consent: (c) => `recorded consent for ${c}`,
  flags_changed: (c) => `changed the flags on ${c}`,
  stage_changed: (c) => `moved ${c} to a new stage`,
  objection: (c) => `recorded an objection from ${c}`,
  policy: (c) => `checked whether ${c} can be reached`,
  'policy.decision': (c) => `checked whether ${c} can be reached`,
  touchpoint: (c) => `logged an interaction with ${c}`,
  edge_add: (c) => `linked ${c} to someone`,
  edge_remove: (c) => `removed a link from ${c}`,
  erased: (c) => `erased ${c}`,
  dsar_exported: (c) => `downloaded the data export for ${c}`,
  notice_sent: (c) => `recorded a notice to ${c}`,
  processing_record_exported: () => 'downloaded the record of processing',
  retention_run: () => 'ran the automatic clean-up',
  rewrap: () => 're-wrapped the encryption keys',
  reindex: () => 'rebuilt the search indexes',
  strict_names_applied: () => 'applied the strict names setting',
  tombstone_lifted: () => 'lifted an erasure block',
  grant_create: () => 'granted an agent a standing permission',
  grant_revoke: () => 'withdrew an agent permission',
  import: () => 'imported contacts',
  merge: (c) => `merged ${c} with a duplicate`,
  unmerge: (c) => `undid a merge for ${c}`,
  fact_add: (c) => `added a fact to ${c}`,
  fact_proposed: (c) => `proposed a fact for ${c}`,
  fact_review: (c) => `reviewed a fact on ${c}`,
  photo_set: (c) => `set a photo for ${c}`,
  photo_removed: (c) => `removed the photo of ${c}`,
  find: () => 'listed contacts',
  search: () => 'searched contacts',
  read: (c) => `opened ${c}`,
  timeline_read: (c) => `opened the timeline of ${c}`,
  facts_read: (c) => `read the facts of ${c}`,
  resolve: () => 'looked up a number or address',
  duplicates: () => 'checked for duplicates',
  suppress_check: () => 'checked the do-not-contact list',
  import_dry_run: () => 'previewed an import',
}

function callVerb(ev, c) {
  const r = rest(ev.intent)
  const dial = ev.codes?.projection === 'dial' || /call|voice/.test(String(ev.codes?.channel || ''))
  const noun = dial ? 'a call to' : 'a message to'
  if (r === 'send') return `sent a message to ${c}`
  if (r === 'lease.minted') return dial ? `placed a call to ${c}` : `was given one-time access to reach ${c}`
  if (r === 'lease.denied') return `was refused ${noun} ${c}`
  if (r === 'lease.redeemed') return `used one-time access to reach ${c}`
  if (r === 'lease.revoked') return `had access to reach ${c} withdrawn`
  if (r === 'lease.claimed') return `had ${noun} ${c} picked up by the phone bridge`
  return `used access to ${c}`
}

/** An id-like certificate/receipt code in the event's codes, if the server sent one (shown, never invented). */
function certificate(codes = {}) {
  for (const [k, v] of Object.entries(codes)) if (/cert|receipt/i.test(k) && typeof v === 'string' && v) return v
  return null
}

/**
 * One log row for a person: { text, who, verb, detail, contactId, group, icon }.
 * `nameOf(contactId)` returns a display name or null (not loaded, erased, or unknown) and is the ONLY place a name enters.
 */
export function eventSentence(ev, { nameOf = () => null, me = null } = {}) {
  const r = rest(ev.intent)
  const who = actorName(ev.actor, me)
  const name = ev.contact_id ? nameOf(ev.contact_id) : null
  const c = name || 'a contact'
  const group = groupOf(ev)
  const verb = group === 'calls' ? callVerb(ev, c) : (VERB[r] ? VERB[r](c) : `${intentLabel(ev.intent).toLowerCase()}${name ? ` for ${name}` : ''}`)
  const outcome = ev.outcome ? (OUTCOMES[ev.outcome] || sentence(ev.outcome)) : ''
  const cert = certificate(ev.codes)
  const bits = [outcome, ...codePhrases(ev.codes)].filter(Boolean)
  if (cert) bits.push(`certificate ${cert}`)
  return { text: `${who} ${verb}`, who, verb, detail: bits.join(' · '), contactId: ev.contact_id || null, group, icon: iconKey(ev, group) }
}

/** Icon key per action type (the component maps keys to SVGs). */
function iconKey(ev, group) {
  const r = rest(ev.intent)
  if (group === 'calls') return /denied/.test(r) ? 'refused' : /send/.test(r) ? 'message' : 'call'
  if (group === 'views') return 'eye'
  if (group === 'privacy') return /erased|suppress|objection/.test(r) ? 'ban' : 'shield'
  if (isAgentEvent(ev)) return 'bot'
  if (/merge/.test(r)) return 'merge'
  if (/import/.test(r)) return 'upload'
  if (/create|add/.test(r)) return 'plus'
  return 'edit'
}

/** Per-day counts of the given events over `days` days ending today, oldest first, for the sparkline. */
export function dailyCounts(events, days = 30, now = new Date()) {
  const end = startOfDay(new Date(now))
  const counts = Array.from({ length: days }, () => 0)
  for (const ev of events) {
    const t = new Date(ev.ts)
    if (Number.isNaN(t.getTime())) continue
    const idx = days - 1 - Math.round((end - startOfDay(t)) / 86400000)
    if (idx >= 0 && idx < days) counts[idx] += 1
  }
  return counts
}

/**
 * Contacts added in the last 7 days, from the loaded log. Only reported when the loaded pages reach back 7 days
 * (or the log has no older page), so a short first page is never presented as the whole week.
 */
export function addedThisWeek(events, { hasMore = false, now = new Date() } = {}) {
  const cutoff = now.getTime() - 7 * 86400000
  const oldest = events.length ? new Date(events[events.length - 1].ts).getTime() : null
  const covered = !hasMore || (oldest != null && !Number.isNaN(oldest) && oldest <= cutoff)
  if (!covered) return null
  return events.filter((ev) => rest(ev.intent) === 'create' && new Date(ev.ts).getTime() >= cutoff).length
}
