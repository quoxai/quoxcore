// Stream QMH-3 part 2 — priorityScorer.
//
// Deterministic priority scorer for work items (tasks, objectives, inbox
// approvals). Pure function — same input always returns same output. No DB
// lookups, no LLM calls. QuoxValue reads aggregate pressure from this; the
// queue can sort by it; HITL inbox surfaces it as severity.
//
// Public API:
//   scorePriority(item) → integer 0..100
//
// Inputs (all optional except title):
//   title           string
//   prompt          string
//   severity        'critical' | 'high' | 'medium' | 'low'
//   dueBy           ISO timestamp string
//   dependentCount  number — how many other tasks depend on this one
//   now             Date (for testing; defaults to current time)

const SEVERITY_BASE = {
  critical: 90,
  high: 70,
  medium: 50,
  low: 30,
}

// Patterns that suggest urgency in titles/prompts. Each match adds a fixed
// bump (capped). Keep small and conservative — easy to audit.
const URGENCY_PATTERNS = [
  /\boutage\b/i,
  /\bblocking\b/i,
  /\bsecurity\b/i,
  /\bbroken\b/i,
  /\bdown\b/i,
  /\bcrash(ed|ing)?\b/i,
  /\burgent\b/i,
  /\bp0\b|\bp1\b/i,
]

const URGENCY_BUMP_PER_HIT = 4
const URGENCY_BUMP_CAP = 12

const DEPENDENT_BONUS_PER_LINK = 2
const DEPENDENT_BONUS_CAP = 12

export function scorePriority(item = {}) {
  const {
    title = '',
    prompt = '',
    severity,
    dueBy = null,
    dependentCount = 0,
    now = new Date(),
  } = item

  let score = severity in SEVERITY_BASE ? SEVERITY_BASE[severity] : 50

  // Urgency keywords in title + prompt
  const corpus = `${title} ${prompt}`
  let urgencyHits = 0
  for (const pattern of URGENCY_PATTERNS) {
    if (pattern.test(corpus)) urgencyHits++
  }
  score += Math.min(urgencyHits * URGENCY_BUMP_PER_HIT, URGENCY_BUMP_CAP)

  // dueBy proximity: imminent → big bump, far away → small.
  if (dueBy) {
    const dueAt = Date.parse(dueBy)
    if (!Number.isNaN(dueAt)) {
      const hoursUntil = (dueAt - now.getTime()) / (1000 * 60 * 60)
      if (hoursUntil <= 1) score += 15
      else if (hoursUntil <= 24) score += 10
      else if (hoursUntil <= 24 * 7) score += 5
    }
  }

  // Critical-path bonus: many dependents → blocking more work.
  if (dependentCount > 0) {
    score += Math.min(dependentCount * DEPENDENT_BONUS_PER_LINK, DEPENDENT_BONUS_CAP)
  }

  return clamp(Math.round(score), 0, 100)
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n))
}
