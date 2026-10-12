// nlCron.js — Server-side natural-language → cron parser for Calendar-Q (AQ-9B Phase 1)
//
// This is a server-side port of the same natural-language grammar already
// shipped at src/services/cronHelper.js:211 (naturalLanguageToCron, WC-2).
// It cannot be imported directly — that file lives in the frontend bundle
// (src/**) which is out of scope for this worktree/task — so the parsing
// rules are duplicated here verbatim rather than re-designed, keeping
// client-side NL hints (grid painting) and server-side authoritative
// parsing (event creation) behaviourally identical. Output is always
// validated by the existing services/tasks/lib/cronParser.js isValidCron()
// before being persisted — this module never bypasses that gate.

const DAY_MAP = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
}

/**
 * Parse a time string like "6am", "06:00", "6:30pm", "18:00".
 * Returns { hour, minute } or null.
 */
function parseTime(text) {
  if (!text) return null
  const t = text.trim().toLowerCase().replace(/\s+/g, '')

  const ampm = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/)
  if (ampm) {
    let hour = parseInt(ampm[1])
    const minute = ampm[2] ? parseInt(ampm[2]) : 0
    if (ampm[3] === 'pm' && hour !== 12) hour += 12
    if (ampm[3] === 'am' && hour === 12) hour = 0
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return { hour, minute }
  }

  const mil = t.match(/^(\d{1,2}):(\d{2})$/)
  if (mil) {
    const hour = parseInt(mil[1])
    const minute = parseInt(mil[2])
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return { hour, minute }
  }

  return null
}

/**
 * Parse natural language scheduling phrases into a 5-field cron expression.
 * Case-insensitive. Returns a cron string or null if unparseable.
 *
 * Examples:
 *   "every day" -> "0 9 * * *"
 *   "every day at 6am" -> "0 6 * * *"
 *   "every weekday" -> "0 9 * * 1-5"
 *   "every monday at 8am" -> "0 8 * * 1"
 *   "every 30 minutes" -> "*\/30 * * * *"
 *   "twice a day" -> "0 9,17 * * *"
 */
export function naturalLanguageToCron(text) {
  if (!text || typeof text !== 'string') return null
  const s = text.trim().toLowerCase()
  if (!s) return null

  const DEFAULT_HOUR = 9
  const DEFAULT_MIN = 0

  const atMatch = s.match(/\bat\s+(.+)$/)
  const time = atMatch ? parseTime(atMatch[1]) : null
  const h = time ? time.hour : DEFAULT_HOUR
  const m = time ? time.minute : DEFAULT_MIN

  const minMatch = s.match(/every\s+(\d+)\s+min(ute)?s?/)
  if (minMatch) {
    const n = parseInt(minMatch[1])
    if (n > 0 && n < 60) return `*/${n} * * * *`
    return null
  }

  if (/^every\s+minute$/.test(s)) return '* * * * *'

  const hourMatch = s.match(/every\s+(\d+)\s+hours?/)
  if (hourMatch) {
    const n = parseInt(hourMatch[1])
    if (n > 0 && n <= 23) return `0 */${n} * * *`
    return null
  }

  if (/^(every\s+hour|hourly)$/.test(s)) return '0 * * * *'

  if (/twice\s+a\s+day/.test(s)) return '0 9,17 * * *'

  if (/^every\s+morning$/.test(s)) return '0 9 * * *'

  if (/^every\s+(evening|night)$/.test(s)) return '0 18 * * *'

  if (/^(every\s+weekday|weekdays)(\s+at\s+.+)?$/.test(s)) return `${m} ${h} * * 1-5`

  if (/^(every\s+weekend|weekends)(\s+at\s+.+)?$/.test(s)) return `${m} ${h} * * 0,6`

  const dayMatch = s.match(/^every\s+(sunday|sun|monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat)(\s+at\s+.+)?$/)
  if (dayMatch) {
    const dow = DAY_MAP[dayMatch[1]]
    if (dow !== undefined) return `${m} ${h} * * ${dow}`
  }

  if (/^(every\s+day|daily)(\s+at\s+.+)?$/.test(s)) return `${m} ${h} * * *`

  if (/^(every\s+week|weekly)(\s+at\s+.+)?$/.test(s)) return `${m} ${h} * * 1`

  if (/^(every\s+month|monthly)(\s+at\s+.+)?$/.test(s)) return `${m} ${h} 1 * *`

  if (/^(every\s+year|yearly|annually)(\s+at\s+.+)?$/.test(s)) return `${m} ${h} 1 1 *`

  return null
}
