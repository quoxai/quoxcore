/**
 * Go live helpers for the Widget Room header (wave 6).
 *
 * A new widget is a draft and refuses public visitors (423 widget_draft); only
 * previews answer. Going live is the publish action, which runs the security
 * checks on the server. 'active' is a legacy status that still serves.
 */

export function liveState(status) {
  const s = status || 'draft'
  if (s === 'published' || s === 'active') return { key: 'live', label: 'Live', canGoLive: false, canPause: true, canResume: false, note: 'Answering visitors.' }
  if (s === 'paused') return { key: 'paused', label: 'Paused', canGoLive: true, canPause: false, canResume: true, note: 'Paused: visitors get the "not live" message.' }
  if (s === 'archived') return { key: 'archived', label: 'Archived', canGoLive: false, canPause: false, canResume: false, note: 'Archived.' }
  return { key: 'draft', label: 'Draft', canGoLive: true, canPause: false, canResume: false, note: 'Drafts answer only previews. Visitors on your site see "not live yet" until you go live.' }
}

/** One-line result for a finished publish job. */
export function publishResultLine(job) {
  if (!job) return ''
  if (job.status === 'error') {
    const raw = job.http_status || job.error || 'error'
    if (job.message) return `${job.message} (${raw})`
    return `Go live failed (${raw}). Nothing changed.`
  }
  const r = job.result || {}
  if (r.published) return r.message || 'Live.'
  return `Not live: ${r.message || r.reason || 'security checks did not pass'}.`
}
