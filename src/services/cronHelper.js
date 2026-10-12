/**
 * Cron Expression Helper
 * Converts cron expressions to human-readable text and computes next runs.
 */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/**
 * Convert a cron expression to human-readable text.
 * Handles common patterns for standard 5-field cron (min hour dom month dow).
 */
export function cronToHuman(expression) {
  if (!expression) return 'No schedule'
  const parts = expression.trim().split(/\s+/)
  if (parts.length < 5) return expression

  const [min, hour, dom, month, dow] = parts

  // Every minute
  if (min === '*' && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return 'Every minute'
  }

  // Every N minutes
  if (min.startsWith('*/') && hour === '*' && dom === '*') {
    return `Every ${min.slice(2)} minutes`
  }

  // Every hour at :MM
  if (min !== '*' && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return `Every hour at :${min.padStart(2, '0')}`
  }

  // Every N hours
  if (min === '0' && hour.startsWith('*/') && dom === '*') {
    return `Every ${hour.slice(2)} hours`
  }

  // Daily at HH:MM
  if (min !== '*' && hour !== '*' && dom === '*' && month === '*' && dow === '*') {
    return `Daily at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
  }

  // Specific days of week
  if (min !== '*' && hour !== '*' && dom === '*' && month === '*' && dow !== '*') {
    const time = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
    // Common range: weekdays
    if (dow === '1-5') return `Weekdays at ${time}`
    if (dow === '0-6') return `Daily at ${time}`
    // Handle ranges like '1-3'
    if (dow.includes('-') && !dow.includes(',')) {
      const [from, to] = dow.split('-').map(Number)
      const fromDay = DAYS[from] || from
      const toDay = DAYS[to] || to
      return `${fromDay}\u2013${toDay} at ${time}`
    }
    const days = dow.split(',').map(d => {
      if (d.includes('-')) {
        const [from, to] = d.split('-').map(Number)
        return `${DAYS[from] || from}\u2013${DAYS[to] || to}`
      }
      return DAYS[parseInt(d)] || d
    }).join(', ')
    return `${days} at ${time}`
  }

  // Specific day of month
  if (min !== '*' && hour !== '*' && dom !== '*' && month === '*' && dow === '*') {
    return `Day ${dom} of every month at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
  }

  // Fallback: return the raw expression
  return expression
}

/**
 * Format a countdown string from now to the target date.
 */
export function formatCountdown(targetDate) {
  if (!targetDate) return 'Unknown'
  const now = new Date()
  const target = new Date(targetDate)
  const diffMs = target - now

  if (diffMs < 0) return 'Overdue'
  if (diffMs < 60000) return `${Math.floor(diffMs / 1000)}s`
  if (diffMs < 3600000) return `${Math.floor(diffMs / 60000)}m`
  if (diffMs < 86400000) {
    const hours = Math.floor(diffMs / 3600000)
    const mins = Math.floor((diffMs % 3600000) / 60000)
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
  }
  const days = Math.floor(diffMs / 86400000)
  return `${days}d`
}

/**
 * Validate a cron expression (basic validation).
 */
export function isValidCron(expression) {
  if (!expression) return false
  const parts = expression.trim().split(/\s+/)
  return parts.length >= 5 && parts.length <= 6
}

/**
 * Check if a cron field matches a given value.
 * Handles: *, specific number, comma-separated list, ranges (1-5), step values (star/N).
 */
function cronFieldMatches(field, value) {
  if (field === '*') return true
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2))
    return step > 0 && value % step === 0
  }
  // Comma-separated values or ranges
  return field.split(',').some(part => {
    if (part.includes('-')) {
      const [from, to] = part.split('-').map(Number)
      return value >= from && value <= to
    }
    return parseInt(part) === value
  })
}

/**
 * Check if a cron expression fires on a given date (day-level check).
 * Only checks dom, month, and dow fields (ignores hour/minute).
 */
export function cronMatchesDate(expression, date) {
  if (!expression) return false
  const parts = expression.trim().split(/\s+/)
  if (parts.length < 5) return false

  const [, , dom, month, dow] = parts
  const d = date instanceof Date ? date : new Date(date)
  const dayOfMonth = d.getDate()
  const monthNum = d.getMonth() + 1 // cron months are 1-12
  const dayOfWeek = d.getDay() // 0=Sunday

  // Month check
  if (!cronFieldMatches(month, monthNum)) return false

  // DOM and DOW: if both are restricted (not *), match either (standard cron behavior)
  const domRestricted = dom !== '*'
  const dowRestricted = dow !== '*'

  if (domRestricted && dowRestricted) {
    return cronFieldMatches(dom, dayOfMonth) || cronFieldMatches(dow, dayOfWeek)
  }
  if (domRestricted) return cronFieldMatches(dom, dayOfMonth)
  if (dowRestricted) return cronFieldMatches(dow, dayOfWeek)

  return true // both are *, fires every day
}

// ── Natural Language → Cron Parser (WC-2) ─────────────────────────

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
 * Parse a time string like "6am", "06:00", "6:30pm", "18:00", "6 am".
 * Returns { hour, minute } or null.
 */
function parseTime(text) {
  if (!text) return null
  const t = text.trim().toLowerCase().replace(/\s+/g, '')

  // "6am", "6pm", "11pm", "6:30am", "6:30pm"
  const ampm = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/)
  if (ampm) {
    let hour = parseInt(ampm[1])
    const minute = ampm[2] ? parseInt(ampm[2]) : 0
    if (ampm[3] === 'pm' && hour !== 12) hour += 12
    if (ampm[3] === 'am' && hour === 12) hour = 0
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return { hour, minute }
  }

  // "06:00", "18:30"
  const mil = t.match(/^(\d{1,2}):(\d{2})$/)
  if (mil) {
    const hour = parseInt(mil[1])
    const minute = parseInt(mil[2])
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return { hour, minute }
  }

  return null
}

/**
 * Parse natural language scheduling phrases into cron expressions.
 * Case-insensitive. Returns a 5-field cron string or null if unparseable.
 *
 * Examples:
 *   "every day" → "0 9 * * *"
 *   "every day at 6am" → "0 6 * * *"
 *   "every weekday" → "0 9 * * 1-5"
 *   "every monday at 8am" → "0 8 * * 1"
 *   "every 30 minutes" → "* /30 * * * *"   (without space)
 *   "twice a day" → "0 9,17 * * *"
 */
export function naturalLanguageToCron(text) {
  if (!text || typeof text !== 'string') return null
  const s = text.trim().toLowerCase()
  if (!s) return null

  const DEFAULT_HOUR = 9
  const DEFAULT_MIN = 0

  // Extract "at <time>" from end of string
  const atMatch = s.match(/\bat\s+(.+)$/)
  const time = atMatch ? parseTime(atMatch[1]) : null
  const h = time ? time.hour : DEFAULT_HOUR
  const m = time ? time.minute : DEFAULT_MIN

  // "every N minutes"
  const minMatch = s.match(/every\s+(\d+)\s+min(ute)?s?/)
  if (minMatch) {
    const n = parseInt(minMatch[1])
    if (n > 0 && n < 60) return `*/${n} * * * *`
    return null
  }

  // "every minute"
  if (/^every\s+minute$/.test(s)) return '* * * * *'

  // "every N hours"
  const hourMatch = s.match(/every\s+(\d+)\s+hours?/)
  if (hourMatch) {
    const n = parseInt(hourMatch[1])
    if (n > 0 && n <= 23) return `0 */${n} * * *`
    return null
  }

  // "every hour" / "hourly"
  if (/^(every\s+hour|hourly)$/.test(s)) return '0 * * * *'

  // "twice a day"
  if (/twice\s+a\s+day/.test(s)) return '0 9,17 * * *'

  // "every morning"
  if (/^every\s+morning$/.test(s)) return '0 9 * * *'

  // "every evening"  / "every night"
  if (/^every\s+(evening|night)$/.test(s)) return '0 18 * * *'

  // "every weekday" / "weekdays"
  if (/^(every\s+weekday|weekdays)(\s+at\s+.+)?$/.test(s)) return `${m} ${h} * * 1-5`

  // "every weekend" / "weekends"
  if (/^(every\s+weekend|weekends)(\s+at\s+.+)?$/.test(s)) return `${m} ${h} * * 0,6`

  // "every <day>" or "every <day> at <time>"
  const dayMatch = s.match(/^every\s+(sunday|sun|monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat)(\s+at\s+.+)?$/)
  if (dayMatch) {
    const dow = DAY_MAP[dayMatch[1]]
    if (dow !== undefined) return `${m} ${h} * * ${dow}`
  }

  // "every day" / "daily" with optional "at <time>"
  if (/^(every\s+day|daily)(\s+at\s+.+)?$/.test(s)) return `${m} ${h} * * *`

  // "every week" / "weekly" → Monday at default time
  if (/^(every\s+week|weekly)(\s+at\s+.+)?$/.test(s)) return `${m} ${h} * * 1`

  // "every month" / "monthly" → 1st of month
  if (/^(every\s+month|monthly)(\s+at\s+.+)?$/.test(s)) return `${m} ${h} 1 * *`

  // "every year" / "yearly" / "annually"
  if (/^(every\s+year|yearly|annually)(\s+at\s+.+)?$/.test(s)) return `${m} ${h} 1 1 *`

  return null
}

/**
 * Get array of day-of-month numbers (1-31) where the cron fires in a given month.
 */
export function getScheduledDays(expression, year, month) {
  const days = []
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month, day)
    if (cronMatchesDate(expression, date)) {
      days.push(day)
    }
  }
  return days
}
