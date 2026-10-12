/**
 * AOCL-FULL-7 — L4 plan.decompose.
 *
 * Decides whether the user's request is a single-turn chat or a multi-step
 * objective. For single-turn, L4 bypasses — downstream layers proceed with
 * no plan structure. For multi-step, L4 produces a skeletal plan on C4 and
 * optionally delegates to an injected objective-creator.
 *
 * The classifier is pure heuristics — rules + regex — so it's fast, offline,
 * explainable, and doesn't blow token budget. An LLM-based classifier can
 * plug in later via `opts.classify` without reshaping this module.
 *
 * Scope of Phase 7:
 *  - classifyComplexity(): rule-based single_turn vs multi_step
 *  - decomposePlan():      split multi_step into sequential steps
 *  - runL4():              orchestrate, populate C4, optionally delegate
 *
 * Integration with the objectives service is behind opts.createObjective,
 * matching L5/L6/L7's DI pattern. Server.js decides when to wire up the
 * real creator; this module stays pure + testable.
 */

const SINGLE_TURN = 'single_turn';
const MULTI_STEP = 'multi_step';

// Keywords that strongly suggest multi-step work.
const SEQUENCER_RE = /\b(then|after that|and then|next step|afterwards|finally)\b/i;
const PLAN_RE = /\b(make a plan|break (this|it) down|step by step|step-by-step|multi-step|multi step|plan to|orchestrate)\b/i;
const NUMBERED_LIST_RE = /(?:^|\s)(\d+\.\s)/g;

// Query verbs that stay single-turn even if the prompt is long.
const QUERY_VERBS_RE = /^(what|how|why|when|where|who|list|show|find|search|get|describe|explain)\b/i;

/**
 * Classify a prompt as single_turn or multi_step.
 * Returns { kind, confidence, reasons: [] }.
 */
function classifyComplexity(prompt) {
  if (!prompt || typeof prompt !== 'string') {
    return { kind: SINGLE_TURN, confidence: 0.9, reasons: ['empty_input'] };
  }
  const trimmed = prompt.trim();
  if (!trimmed) return { kind: SINGLE_TURN, confidence: 0.9, reasons: ['empty_input'] };

  const reasons = [];
  let multiScore = 0;
  let singleScore = 0;

  // Query verbs push toward single-turn
  if (QUERY_VERBS_RE.test(trimmed)) {
    singleScore += 2;
    reasons.push('starts_with_query_verb');
  }

  // Sequencer keywords push toward multi-step
  if (SEQUENCER_RE.test(trimmed)) {
    multiScore += 3;
    reasons.push('contains_sequencer');
  }

  // Explicit planning language
  if (PLAN_RE.test(trimmed)) {
    multiScore += 4;
    reasons.push('explicit_planning_language');
  }

  // Numbered list
  const numberedMatches = trimmed.match(NUMBERED_LIST_RE) || [];
  if (numberedMatches.length >= 2) {
    multiScore += 3;
    reasons.push('numbered_list');
  }

  // Length / clause count — long prompts with multiple commas are often multi-step
  const commaCount = (trimmed.match(/,/g) || []).length;
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount >= 12 && commaCount >= 3) {
    multiScore += 3;
    reasons.push('long_with_many_clauses');
  }

  // Short = single-turn
  if (wordCount <= 8) {
    singleScore += 1;
    reasons.push('short_prompt');
  }

  const total = multiScore + singleScore;
  const kind = multiScore > singleScore ? MULTI_STEP : SINGLE_TURN;
  const winningScore = kind === MULTI_STEP ? multiScore : singleScore;
  const confidence = total === 0 ? 0.5 : Math.min(1, 0.5 + (winningScore / (total + 2)));

  return { kind, confidence, reasons };
}

/**
 * Split a multi-step prompt into sequential steps.
 * For single_turn, returns a 1-step plan.
 */
function decomposePlan(prompt, complexity) {
  const kind = complexity?.kind || SINGLE_TURN;
  if (kind === SINGLE_TURN) {
    return {
      multiStep: false,
      steps: [{ index: 0, text: (prompt || '').trim() }],
    };
  }

  const text = (prompt || '').trim();
  let parts = [];

  // Numbered list first (most structured)
  if (NUMBERED_LIST_RE.test(text)) {
    parts = text
      .split(/\s*\d+\.\s+/)
      .map(s => s.trim())
      .filter(Boolean);
  }

  // Sequencer keywords
  if (parts.length < 2 && SEQUENCER_RE.test(text)) {
    parts = text
      .split(/\s+(?:then|after that|and then|next step|afterwards|finally)\s+/i)
      .map(s => s.trim())
      .filter(Boolean);
  }

  // Fallback: comma split for long multi-clause prompts
  if (parts.length < 2) {
    parts = text
      .split(/,\s*(?:and\s+)?/)
      .map(s => s.trim())
      .filter(Boolean);
  }

  if (parts.length < 2) parts = [text];

  return {
    multiStep: parts.length > 1,
    steps: parts.map((t, i) => ({ index: i, text: t })),
  };
}

/**
 * Run the L4 planner.
 *
 * @param {object} aoclCtx
 * @param {object} [opts]
 * @param {(prompt) => {kind, confidence, reasons}} [opts.classify]  override classifier
 * @param {'single_turn'|'multi_step'} [opts.forceComplexity]        force a decision
 * @param {(ctx, plan) => boolean} [opts.shouldOrchestrate]          gate for objective delegation
 * @param {(ctx, plan) => Promise<{objectiveId}>} [opts.createObjective]  delegate hook
 */
async function runL4(aoclCtx, opts = {}) {
  if (!aoclCtx) return { proceed: true };

  const startedAt = Date.now();
  const c4 = aoclCtx.C4 || (aoclCtx.C4 = {});
  const warnings = [];

  // Upstream halt (L2 fast-path): don't plan, pass through.
  if (aoclCtx.halt) {
    return {
      proceed: true,
      extras: {
        bypassed: true,
        bypassed_reason: aoclCtx.halt.reason || 'upstream_halt',
        duration_ms: Date.now() - startedAt,
      },
    };
  }

  const prompt = aoclCtx.C2?.rawUserPrompt || aoclCtx.query || '';
  const classifier = typeof opts.classify === 'function' ? opts.classify : classifyComplexity;
  let complexity = classifier(prompt);

  if (opts.forceComplexity === SINGLE_TURN || opts.forceComplexity === MULTI_STEP) {
    complexity = { kind: opts.forceComplexity, confidence: 1, reasons: ['forced'] };
  }

  c4.classifierReasons = complexity.reasons || [];
  c4.classifierConfidence = complexity.confidence || 0;
  c4.complexity = complexity.kind;

  // Single-turn → bypass; no plan needed, no objective to create.
  if (complexity.kind === SINGLE_TURN) {
    return {
      proceed: true,
      bypass: true,
      reason: 'single-turn',
      warnings,
      extras: {
        complexity: SINGLE_TURN,
        confidence: complexity.confidence,
        duration_ms: Date.now() - startedAt,
      },
    };
  }

  // Multi-step → build plan
  const plan = decomposePlan(prompt, complexity);
  c4.plan = plan;

  // Optionally delegate to objective creator
  let objectiveId = null;
  const shouldOrchestrate = typeof opts.shouldOrchestrate === 'function' ? opts.shouldOrchestrate : () => false;
  if (shouldOrchestrate(aoclCtx, plan) && typeof opts.createObjective === 'function') {
    try {
      const r = await opts.createObjective(aoclCtx, plan);
      if (r && typeof r.objectiveId === 'string') {
        objectiveId = r.objectiveId;
        c4.objectiveId = objectiveId;
      }
    } catch (err) {
      warnings.push(`L4:createObjective failed: ${err?.message || 'unknown'}`);
    }
  }

  return {
    proceed: true,
    warnings,
    extras: {
      complexity: MULTI_STEP,
      confidence: complexity.confidence,
      step_count: plan.steps.length,
      objective_id: objectiveId,
      duration_ms: Date.now() - startedAt,
    },
  };
}

module.exports = {
  runL4,
  classifyComplexity,
  decomposePlan,
  SINGLE_TURN,
  MULTI_STEP,
};
