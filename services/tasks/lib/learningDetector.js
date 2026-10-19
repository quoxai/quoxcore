/**
 * Learning Detector (QLOOP-ENGINE P3 step b, read-only aggregation).
 *
 * Pure. Takes learning candidates (observeCompletedRun outputs) and groups them
 * into DRAFT skill proposals when a shape recurs enough times within ONE org.
 * It authors nothing, submits nothing, promotes nothing: it only describes what
 * a human could choose to promote. The proposer that carries a draft into the
 * existing skill_manage chokepoint (firewall, Crystal regression, 60-min
 * auto-revert, weekly judge, HUMAN promotion) is the NEXT step and is where the
 * owner stays close. Auto-PROMOTE is never allowed, by design, and nothing here
 * can cause it.
 *
 * Invariants:
 *   - ORG-SCOPED: candidates are grouped within (org_id, shape). A shape is
 *     NEVER merged across orgs (multi-tenant isolation).
 *   - DENY-BY-DEFAULT: a candidate with no witness ref does not count.
 *   - THRESHOLD: a draft is proposed only at >= threshold occurrences.
 *   - DRAFT ONLY: every proposal carries status:'draft'. There is no 'promoted'
 *     path in this module.
 *   - OFF BY DEFAULT: LEARNING_DETECTOR!=='1' (its own flag) yields [].
 *
 * NOT wired into any execution path yet (parallels how the observer landed).
 */

export const DEFAULT_THRESHOLD = 3

export function detectorOn(env = process.env) {
  return env.LEARNING_DETECTOR === '1'
}

function median(nums) {
  const xs = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b)
  if (!xs.length) return null
  const mid = Math.floor(xs.length / 2)
  return xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2)
}

/**
 * @param {Array} candidates  learning candidates (shape, org_id, kind, tools, cost, witnessed_ref, run_id)
 * @param {object} [opts]
 * @param {number} [opts.threshold=3]
 * @param {boolean} [opts.flagOn]        override the env flag (tests)
 * @param {Set|Array} [opts.knownShapes] shapes already covered by a skill/draft; skipped
 * @returns {Array<object>} DRAFT proposals, most-recurring first; [] when off or nothing qualifies
 */
export function detectSkillDrafts(candidates, { threshold = DEFAULT_THRESHOLD, flagOn, knownShapes } = {}) {
  const on = flagOn === undefined ? detectorOn() : flagOn === true
  if (!on || !Array.isArray(candidates)) return []
  const known = knownShapes instanceof Set ? knownShapes
    : new Set(Array.isArray(knownShapes) ? knownShapes : [])

  const groups = new Map() // `${org_id}\u0000${shape}` -> aggregate
  for (const c of candidates) {
    if (!c || !c.shape || !c.org_id) continue
    if (!c.witnessed_ref) continue // deny-by-default: unwitnessed never counts
    const key = `${c.org_id}\u0000${c.shape}`
    let g = groups.get(key)
    if (!g) {
      g = { org_id: c.org_id, shape: c.shape, kind: c.kind === 'loop' ? 'loop' : 'objective', count: 0, tools: new Set(), run_ids: [], witnessed_refs: [], tokens: [] }
      groups.set(key, g)
    }
    g.count += 1
    for (const t of Array.isArray(c.tools) ? c.tools : []) g.tools.add(t)
    if (c.run_id) g.run_ids.push(c.run_id)
    g.witnessed_refs.push(c.witnessed_ref)
    const tok = c.cost && c.cost.tokens
    if (Number.isFinite(tok)) g.tokens.push(tok)
  }

  const drafts = []
  for (const g of groups.values()) {
    if (g.count < threshold) continue
    if (known.has(g.shape)) continue
    drafts.push({
      status: 'draft', // humans promote; there is no auto-promote, ever
      org_id: g.org_id,
      shape: g.shape,
      kind: g.kind,
      occurrences: g.count,
      tools: [...g.tools],
      example_run_ids: g.run_ids.slice(0, 5),
      witnessed_refs: g.witnessed_refs.slice(0, 5),
      median_tokens: median(g.tokens),
      rationale: `${g.count} successful witnessed ${g.kind} runs in this org share shape ${g.shape}; candidate for a reusable skill DRAFT (human promotion required).`,
    })
  }
  drafts.sort((a, b) => b.occurrences - a.occurrences)
  return drafts
}
