/**
 * QuoxMind Advisor — Pre-flight intelligence for objective decomposition
 *
 * Stream QM Phase QM-3: Closes the feedback loop.
 *
 * Before every decomposition, the Advisor:
 * 1. Queries the Wisdom Store for relevant lessons
 * 2. Searches past outcomes for similar objectives
 * 3. Compiles a mandatory advisory with directives and success probability
 * 4. Injects the advisory into the decomposition prompt
 *
 * High-confidence directives (>0.8) are mandatory — the decomposer MUST follow them.
 */

import { getRelevantWisdom, findSimilarOutcomes } from './wisdomStore.js'

/**
 * Generate a pre-flight advisory for an objective about to be decomposed.
 *
 * QMH-4b: the MANDATORY DIRECTIVES section is gated on the quoxmind-pro
 * license. Free orgs receive wisdom + past outcomes + probability + risk
 * flags as advisory text only; Pro orgs additionally receive directives
 * the planner cannot override. The license check itself lives in the
 * caller (decomposer.js) — this function takes the resolved flag.
 *
 * @param {string} orgId
 * @param {string} title — objective title
 * @param {string} description — objective description
 * @param {Object} [opts]
 * @param {boolean} [opts.mandatoryEnabled=true] — when false, suppress the
 *   "MANDATORY DIRECTIVES" section in the advisory text and return an
 *   empty mandatoryDirectives array. Default true preserves pre-QMH-4b
 *   behaviour for callers that don't yet pass the option.
 * @returns {Object} { advisory: string, probability: number, riskFlags: string[], mandatoryDirectives: string[] }
 */
export function generateAdvisory(orgId, title, description, opts = {}) {
  const { mandatoryEnabled = true } = opts
  const fullText = `${title} ${description || ''}`

  // 1. Query relevant wisdom
  const wisdom = getRelevantWisdom(orgId, fullText, { minConfidence: 0.4, limit: 5 })

  // 2. Find similar past outcomes
  const pastOutcomes = findSimilarOutcomes(orgId, title, { limit: 3 })

  // 3. Compile advisory
  const lines = []
  const mandatoryDirectives = []
  const riskFlags = []

  if (wisdom.length > 0) {
    lines.push('RELEVANT WISDOM:')
    for (const w of wisdom) {
      const confLabel = w.confidence >= 0.85 ? 'HIGH' : w.confidence >= 0.6 ? 'MEDIUM' : 'LOW'
      lines.push(`● [${confLabel} ${w.confidence.toFixed(2)}] "${w.pattern_name}"`)
      lines.push(`  ${w.lesson}`)
      if (w.decomposition_directive) {
        lines.push(`  Directive: ${w.decomposition_directive}`)
        if (w.confidence >= 0.8 && mandatoryEnabled) {
          mandatoryDirectives.push(w.decomposition_directive)
        }
      }
      lines.push(`  Seen: ${w.occurrence_count}×. Last: ${w.last_seen_at || 'unknown'}.`)
      lines.push('')

      // Collect risk flags
      const tags = JSON.parse(w.tags || '[]')
      for (const tag of tags) {
        if (!riskFlags.includes(tag) && ['fleet', 'timeout', 'ssh', 'failure', 'cascade'].includes(tag)) {
          riskFlags.push(tag)
        }
      }
    }
  }

  if (pastOutcomes.length > 0) {
    lines.push('SIMILAR PAST OBJECTIVES:')
    for (const o of pastOutcomes) {
      const score = o.quality_score != null ? `${(o.quality_score * 100).toFixed(0)}%` : '?'
      lines.push(`● "${o.title}" — Score: ${score} (${o.tasks_completed}/${o.task_count} tasks)`)
      if (o.quality_score < 0.7 && o.failure_summary) {
        try {
          const failures = JSON.parse(o.failure_summary)
          if (failures.length > 0) {
            lines.push(`  Failed: ${failures.map(f => f.task).join(', ')}`)
          }
        } catch { /* ignore parse errors */ }
      }
    }
    lines.push('')
  }

  // 4. Compute success probability
  let probability = 0.7 // default baseline
  if (pastOutcomes.length > 0) {
    const avgScore = pastOutcomes.reduce((s, o) => s + (o.quality_score || 0), 0) / pastOutcomes.length
    probability = avgScore * 0.6 + 0.4 // weighted: 60% from history, 40% baseline
  }
  // Adjust down for high-confidence risk patterns
  for (const w of wisdom) {
    if (w.confidence >= 0.8 && w.severity === 'high') probability -= 0.1
    if (w.confidence >= 0.8 && w.severity === 'critical') probability -= 0.2
  }
  probability = Math.max(0.1, Math.min(0.95, probability))

  if (mandatoryDirectives.length > 0) {
    lines.push('MANDATORY DIRECTIVES (from high-confidence wisdom):')
    mandatoryDirectives.forEach((d, i) => {
      lines.push(`${i + 1}. ${d}`)
    })
    lines.push('')
  }

  lines.push(`PREDICTED SUCCESS PROBABILITY: ${(probability * 100).toFixed(0)}%`)
  if (riskFlags.length > 0) {
    lines.push(`RISK FLAGS: ${riskFlags.join(', ')}`)
  }

  const advisory = lines.length > 2 ? lines.join('\n') : null

  return {
    advisory,
    probability,
    riskFlags,
    mandatoryDirectives,
    wisdomCount: wisdom.length,
    pastOutcomeCount: pastOutcomes.length,
  }
}
