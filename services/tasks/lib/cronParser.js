// Server-side cron next-run calculator
// 5-field standard cron: minute hour dom month dow
// No external dependencies

// Check if a cron field matches a given value.
// Handles: *, specific number, comma-separated list, ranges (1-5), step values.
function cronFieldMatches(field, value) {
  if (field === '*') return true
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2))
    return step > 0 && value % step === 0
  }
  return field.split(',').some(part => {
    if (part.includes('-')) {
      const [from, to] = part.split('-').map(Number)
      return value >= from && value <= to
    }
    return parseInt(part) === value
  })
}

/**
 * Validate range values for a cron field.
 */
function fieldInRange(field, min, max) {
  if (field === '*') return true
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2))
    return !isNaN(step) && step >= 1 && step <= max
  }
  return field.split(',').every(part => {
    if (part.includes('-')) {
      const [from, to] = part.split('-').map(Number)
      return !isNaN(from) && !isNaN(to) && from >= min && to <= max && from <= to
    }
    const val = parseInt(part)
    return !isNaN(val) && val >= min && val <= max
  })
}

/**
 * Validate a 5-field cron expression with range checks.
 * @param {string} expression - Cron expression (min hour dom month dow)
 * @returns {boolean}
 */
export function isValidCron(expression) {
  if (!expression || typeof expression !== 'string') return false
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) return false

  const [min, hour, dom, month, dow] = parts

  // Validate each field against its valid range
  if (!fieldInRange(min, 0, 59)) return false
  if (!fieldInRange(hour, 0, 23)) return false
  if (!fieldInRange(dom, 1, 31)) return false
  if (!fieldInRange(month, 1, 12)) return false
  if (!fieldInRange(dow, 0, 6)) return false

  return true
}

/**
 * Get date components in a specific timezone using Intl.DateTimeFormat.
 * Returns { year, month, day, hour, minute, dow }.
 */
function getDatePartsInTimezone(date, timezone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', hour12: false,
      weekday: 'short',
    })
    const parts = {}
    for (const { type, value } of fmt.formatToParts(date)) {
      if (type === 'year') parts.year = parseInt(value)
      else if (type === 'month') parts.month = parseInt(value)
      else if (type === 'day') parts.day = parseInt(value)
      else if (type === 'hour') parts.hour = parseInt(value) % 24 // handle 24 → 0
      else if (type === 'minute') parts.minute = parseInt(value)
      else if (type === 'weekday') {
        const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
        parts.dow = dowMap[value] ?? 0
      }
    }
    return parts
  } catch {
    return null // invalid timezone — fall back to local
  }
}

/**
 * Calculate the next cron run after a given date.
 * Scans forward minute-by-minute up to 366 days.
 * @param {string} expression - 5-field cron expression
 * @param {Date} [after] - Start scanning after this date (default: now)
 * @param {string} [timezone] - IANA timezone (e.g., 'America/New_York'). If omitted, uses local time.
 * @returns {Date|null} Next run date, or null if none found within 366 days
 */
export function getNextCronRun(expression, after, timezone) {
  if (!isValidCron(expression)) return null

  const parts = expression.trim().split(/\s+/)
  const [minField, hourField, domField, monthField, dowField] = parts

  // Start from the next whole minute after 'after'
  const start = after ? new Date(after) : new Date()
  start.setSeconds(0, 0)
  start.setMinutes(start.getMinutes() + 1)

  const maxDate = new Date(start)
  maxDate.setDate(maxDate.getDate() + 366)

  const current = new Date(start)

  while (current < maxDate) {
    // OE-5: Timezone-aware date parts
    let month, dom, dow, hour, min
    if (timezone) {
      const tzParts = getDatePartsInTimezone(current, timezone)
      if (tzParts) {
        month = tzParts.month
        dom = tzParts.day
        dow = tzParts.dow
        hour = tzParts.hour
        min = tzParts.minute
      } else {
        // Invalid timezone — fall back to local
        month = current.getMonth() + 1
        dom = current.getDate()
        dow = current.getDay()
        hour = current.getHours()
        min = current.getMinutes()
      }
    } else {
      month = current.getMonth() + 1 // cron months: 1-12
      dom = current.getDate()
      dow = current.getDay() // 0=Sunday
      hour = current.getHours()
      min = current.getMinutes()
    }

    // Check month first — if wrong month, skip to next month
    if (!cronFieldMatches(monthField, month)) {
      current.setMonth(current.getMonth() + 1, 1)
      current.setHours(0, 0, 0, 0)
      continue
    }

    // Check day (DOM and DOW — standard cron: if both restricted, match either)
    const domRestricted = domField !== '*'
    const dowRestricted = dowField !== '*'
    let dayMatch = true

    if (domRestricted && dowRestricted) {
      dayMatch = cronFieldMatches(domField, dom) || cronFieldMatches(dowField, dow)
    } else if (domRestricted) {
      dayMatch = cronFieldMatches(domField, dom)
    } else if (dowRestricted) {
      dayMatch = cronFieldMatches(dowField, dow)
    }

    if (!dayMatch) {
      current.setDate(current.getDate() + 1)
      current.setHours(0, 0, 0, 0)
      continue
    }

    // Check hour — if wrong, skip to next hour
    if (!cronFieldMatches(hourField, hour)) {
      current.setHours(current.getHours() + 1, 0, 0, 0)
      continue
    }

    // Check minute
    if (cronFieldMatches(minField, min)) {
      return new Date(current)
    }

    // Advance by 1 minute
    current.setMinutes(current.getMinutes() + 1)
  }

  return null
}
