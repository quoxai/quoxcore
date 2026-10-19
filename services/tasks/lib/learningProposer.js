/**
 * Learning Proposer (QLOOP-ENGINE P3 step b, the draft proposer).
 *
 * Turns a detected pattern (learningDetector output) into a DRAFT skill and
 * submits it through the EXISTING skill chokepoint, unchanged: quoxflow
 * POST /api/quox-skills with requireHumanReview:true. That endpoint queues a
 * human-review row and refuses to load the skill until a person approves it
 * (quox#748), so the proposer's ceiling is "a draft is waiting for a human".
 *
 * HARD INVARIANTS:
 *   - DRAFT ONLY. requireHumanReview is hard-coded true on every submission;
 *     there is no code path here that promotes, approves, or loads a skill.
 *     Auto-PROMOTE is never allowed.
 *   - OFF BY DEFAULT. LEARNING_PROPOSER!=='1' (its own flag) => proposes nothing.
 *   - NO RE-PROPOSAL. A shape already proposed/promoted/rejected (alreadyProposed)
 *     is skipped, so a human's rejection is not nagged.
 *   - REUSES the chokepoint; does not fork its governance. The draft is marked
 *     edition experimental + kind procedural, mirroring createPendingSkill.
 *
 * Not auto-triggered: proposeDrafts is called by nothing yet. The trigger
 * (when/how often the detector->proposer chain fires) is a separate, supervised
 * wiring step and stays behind this flag.
 */

export function proposerOn(env = process.env) {
  return env.LEARNING_PROPOSER === '1'
}

function slugFromShape(shape) {
  return String(shape || 'pattern').replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase() || 'pattern'
}

/**
 * PURE: a detected pattern -> the pending-skill input the chokepoint expects.
 * requireHumanReview is forced true; the body is descriptive only (a human
 * authors the real procedure on review) so a draft can never carry a runnable
 * instruction that was not seen by a person.
 */
export function buildSkillDraftInput(pattern) {
  const p = pattern || {}
  const tools = Array.isArray(p.tools) ? p.tools : []
  const kindWord = p.kind === 'loop' ? 'loop' : 'objective'
  const name = `Learned ${kindWord} pattern ${slugFromShape(p.shape)}`
  const description = `Draft proposed by the learning observer: ${p.occurrences || 0} successful witnessed ${kindWord} runs in this org share this shape. A human reviews and authors the real procedure before it can load.`
  const bodyMd = [
    `# ${name} (DRAFT, awaiting human review)`,
    '',
    `This is an auto-detected candidate, not an approved skill. It was proposed because`,
    `${p.occurrences || 0} successful, witnessed ${kindWord} runs in this org shared the`,
    `same shape (\`${p.shape}\`).`,
    '',
    tools.length ? `Tools seen across those runs: ${tools.join(', ')}.` : 'No tool signal was recorded for those runs.',
    p.median_tokens != null ? `Median tokens per run: ${p.median_tokens}.` : '',
    '',
    `## For the reviewer`,
    `Decide whether this recurring success is worth a reusable skill. If so, replace`,
    `this text with the real, vetted procedure. If not, reject it; it will not be`,
    `re-proposed.`,
    '',
    p.example_run_ids && p.example_run_ids.length ? `Example runs: ${p.example_run_ids.join(', ')}.` : '',
    p.witnessed_refs && p.witnessed_refs.length ? `Witness refs: ${p.witnessed_refs.join(', ')}.` : '',
  ].filter((l) => l !== '').join('\n')

  return {
    name,
    category: 'learned',
    description,
    bodyMd,
    tags: ['learned', 'draft', kindWord],
    requiredTools: tools,
    kind: 'procedural',
    edition: 'experimental',
    requireHumanReview: true,   // hard rule: never submitted any other way
    reviewSource: 'learning-observer',
    learningShape: p.shape || null,
  }
}

/**
 * The real chokepoint submission: POST the draft to quoxflow /api/quox-skills
 * with requireHumanReview. Same endpoint createPendingSkill uses; nothing about
 * the governance pipeline is re-implemented here. Never throws.
 */
export async function submitPendingSkillDraft(input, {
  orgId,
  flowUrl = process.env.QUOXFLOW_URL || 'http://quoxflow:3200',
  serviceKey = process.env.INTERNAL_SERVICE_KEY || '',
  fetchFn = fetch,
} = {}) {
  const payload = { ...input, orgId, requireHumanReview: true } // belt and braces: never not-a-draft
  try {
    const res = await fetchFn(`${flowUrl}/api/quox-skills`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
        ...(orgId ? { 'X-Org-ID': orgId } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, status: res.status, error: body.error || 'create_failed' }
    return { ok: true, status: res.status, skill: body.data || body }
  } catch (err) {
    return { ok: false, status: 502, error: `submit_failed: ${err.message}` }
  }
}

/**
 * Orchestrate: for each NEW pattern (not in alreadyProposed), build a draft and
 * submit it. Flag-gated OFF; deny-by-default. submitFn is injected so the real
 * chokepoint call is swappable in tests. Returns what was proposed and skipped;
 * never promotes anything.
 *
 * @param {Array} patterns  learningDetector drafts (each has org_id, shape, ...)
 * @param {object} opts  { flagOn, submitFn, alreadyProposed, orgId }
 */
export async function proposeDrafts(patterns, { flagOn, submitFn, alreadyProposed, orgId } = {}) {
  const on = flagOn === undefined ? proposerOn() : flagOn === true
  const result = { proposed: [], skipped: [], submitted: 0 }
  if (!on || !Array.isArray(patterns)) return result
  const seen = alreadyProposed instanceof Set ? alreadyProposed
    : new Set(Array.isArray(alreadyProposed) ? alreadyProposed : [])
  const submit = typeof submitFn === 'function' ? submitFn : submitPendingSkillDraft

  for (const pattern of patterns) {
    if (!pattern || !pattern.shape) { result.skipped.push({ shape: pattern?.shape || null, reason: 'no_shape' }); continue }
    if (seen.has(pattern.shape)) { result.skipped.push({ shape: pattern.shape, reason: 'already_proposed' }); continue }
    const input = buildSkillDraftInput(pattern)
    // Final guard: a draft that somehow lost its human-review flag is NOT sent.
    if (input.requireHumanReview !== true) { result.skipped.push({ shape: pattern.shape, reason: 'not_a_draft' }); continue }
    const r = await submit(input, { orgId: pattern.org_id || orgId })
    if (r && r.ok) { result.submitted += 1; result.proposed.push({ shape: pattern.shape, skill: r.skill }) ; seen.add(pattern.shape) }
    else result.skipped.push({ shape: pattern.shape, reason: (r && r.error) || 'submit_failed' })
  }
  return result
}
