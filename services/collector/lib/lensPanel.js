/**
 * lensPanel — QUOXLENS P5
 *
 * lensComposer (P0) applies one Lens to a prompt. lensContract (P1) enforces
 * one Lens's output. This module is the differentiating feature: several
 * Lenses over ONE artifact, run and combined so that where they disagree is
 * a visible, structured fact in the response, not a number that got averaged
 * into a single confident-sounding verdict. A panel that quietly resolves
 * disagreement into a mean severity is not safer than one Lens, it is a
 * false sense of consensus wearing a bigger sample size.
 *
 * Deliberately dependency-free, same reason as lensComposer/lensContract:
 * no external state-machine or scheduling library in the collector's
 * package.json, and this module only needs Node's built-in child_process
 * for the default (non-test) model call.
 */

'use strict';

const { execFileSync } = require('child_process');
const { loadLens, applyLenses } = require('./lensComposer.js');
const { enforceContract, depthProfile, budgetGuard } = require('./lensContract.js');

const ROTATIONS = ['blind', 'relay', 'adversarial', 'synthesis'];
// blind is the default precisely because it is the only mode that produces
// independent assessments — every other mode deliberately lets one Lens see
// another's work, which is useful (refinement, refutation, narration) but is
// no longer independent, so it must be opted into, not defaulted to.
const DEFAULT_ROTATION = 'blind';

const DISPOSITION_RANK = { pass: 0, inconclusive: 1, concerns: 2, fail: 3 };

// ───────────────────────────────────────────────────────────────────────────
// Model invocation — same shape as eval/lenses/runEval.mjs's runModel(): a
// plain string in, a plain string out. Kept swappable via options.runModelFn
// so every test in test/lensPanel.test.js can mock it and never shell out.
// ───────────────────────────────────────────────────────────────────────────

function defaultRunModel(prompt, model) {
  return execFileSync('claude', ['-p', '--model', model], {
    input: prompt,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 5 * 60 * 1000,
  }).trim();
}

/** Defensive JSON parse, same contract as runEval.mjs's parseModelJson: never throws,
 * strips code fences, falls back to empty findings with a warning rather than crashing
 * a whole panel because one Lens's model call came back malformed. */
function parseModelJson(raw, label) {
  const cleaned = String(raw ?? '').replace(/^```(?:json)?/m, '').replace(/```\s*$/m, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) {
    console.warn(`[lensPanel] ${label}: no JSON object found in model output — treating as empty findings`);
    return { verdict: null, findings: [] };
  }
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return {
      verdict: parsed && typeof parsed.verdict === 'object' ? parsed.verdict : null,
      findings: parsed && Array.isArray(parsed.findings) ? parsed.findings : [],
    };
  } catch (err) {
    console.warn(`[lensPanel] ${label}: JSON parse failed (${err.message}) — treating as empty findings`);
    return { verdict: null, findings: [] };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Prompt construction — this is where the four rotation modes actually
// differ. Everything else in this file (budget, dissent, composition) is
// identical regardless of rotation; the rotation only changes what a Lens is
// shown before it speaks.
// ───────────────────────────────────────────────────────────────────────────

const OUTPUT_SHAPE_INSTRUCTIONS = `
Return ONLY raw JSON, no markdown fences, no commentary before or after, matching this shape:
{
  "verdict": { "summary": "one paragraph", "disposition": "pass"|"concerns"|"fail"|"inconclusive", "confidence": 0-100 },
  "findings": [
    {
      "class": "a short label for the kind of problem",
      "severity": "critical"|"high"|"medium"|"low"|"info",
      "claim": "one line, no rationale",
      "rationale": "why it matters",
      "location": "line N or a short locator",
      "evidence": [ { "quote": "verbatim substring copied from the artifact below", "at": "line N" } ],
      "confidence": 0-100,
      "basis": "fact"|"inference"|"assumption"
    }
  ]
}
Every finding's evidence.quote MUST be copied character-for-character from the artifact text below.
Never paraphrase a quote. If there is nothing to flag, return an empty findings array rather than
inventing a finding.`.trim();

function artifactText(artifact) {
  return String((artifact && (artifact.text || artifact.content)) || '');
}

function artifactBlock(artifact) {
  const lines = artifactText(artifact).split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
  return `<artifact id="${artifact.id}" title="${artifact.title || ''}">\n${lines}\n</artifact>`;
}

/**
 * Build the prompt one Lens sees for one panel slot. `context` is the
 * previous Lens's { verdict, findings } — null for the first Lens in any
 * rotation, and null for every Lens under `blind` and `synthesis` (their
 * per-Lens pass is blind by definition; `synthesis` earns its name from the
 * extra pass added afterward, in runSynthesisPass, not from what each Lens
 * sees here).
 *
 * @param {object} lens - loaded lens (see lensComposer.loadLens)
 * @param {object} artifact
 * @param {{verdict: object, findings: Array<object>}|null} context
 * @param {string} rotation
 * @param {Function} applyLensesFn
 * @returns {string}
 */
function buildLensPanelPrompt(lens, artifact, context, rotation, applyLensesFn) {
  const lines = [
    'You are one Lens in a multi-Lens panel independently reviewing a single artifact.',
    '',
    artifactBlock(artifact),
    '',
  ];

  if (rotation === 'relay' && context) {
    // Refine, not defer: the previous verdict is information, not an anchor
    // this Lens is obliged to agree with.
    lines.push(
      "A previous Lens in this panel already produced a verdict on this artifact. Consider it, but form your own independent judgement — confirm it, refine it, or diverge from it if the evidence says otherwise.",
      `Previous verdict: ${JSON.stringify(context.verdict)}`,
      `Previous findings: ${JSON.stringify(context.findings)}`,
      ''
    );
  } else if (rotation === 'adversarial' && context) {
    // The instruction every test in lensPanel.test.js greps for: this is
    // what makes adversarial a distinct mode rather than relay with a
    // different name.
    lines.push(
      'A previous Lens in this panel already produced a verdict on this artifact. Your job is to REFUTE it: actively look for evidence that it is wrong, incomplete, or overconfident, and state plainly where and why you disagree. Do not simply restate it.',
      `Previous verdict to refute: ${JSON.stringify(context.verdict)}`,
      `Previous findings to refute: ${JSON.stringify(context.findings)}`,
      ''
    );
  }
  // blind and synthesis intentionally fall through here with nothing added —
  // every Lens sees only the artifact, which is the whole point of an
  // independent assessment.

  lines.push(OUTPUT_SHAPE_INSTRUCTIONS);
  if (Array.isArray(lens.finding_classes) && lens.finding_classes.length) {
    lines.push(`Every finding's "class" MUST be one of: ${lens.finding_classes.join(', ')}.`);
  }

  return applyLensesFn(lines.join('\n'), [lens]);
}

/**
 * The pseudo-lens driving the synthesis pass. It is shaped like a Lens
 * (kind: evaluative, no required_tools) purely so it can be run through the
 * same applyLenses/enforceContract plumbing as a real one — it is not a
 * house Lens and is never discoverable via loadLens.
 */
const SYNTHESIS_PSEUDO_LENS = {
  id: '__panel_synthesis__',
  kind: 'evaluative',
  required_tools: [],
  finding_classes: [],
  body: [
    '## Panel synthesis pass',
    'You are given every verdict an independent panel of Lenses already produced for this artifact,',
    'plus a structured list of where those Lenses disagreed. Your job is to REPORT the disagreement',
    'clearly in your summary, not resolve it into a single blended stance. Never average severities or',
    'pick a winner. If the panel agreed on everything, say so plainly instead of inventing a nuance.',
  ].join('\n'),
};

function buildSynthesisPrompt(perLensResults, dissent, artifact, applyLensesFn) {
  const lines = [
    `Artifact under review: id="${artifact.id}" title="${artifact.title || ''}"`,
    '',
    `Panel verdicts (${perLensResults.length} Lens(es), each formed independently, none saw another's output):`,
    JSON.stringify(perLensResults.map((r) => ({ lens_id: r.lens_id, verdict: r.verdict }))),
    '',
    `Detected disagreement (${dissent.length} item(s)):`,
    JSON.stringify(dissent),
    '',
    OUTPUT_SHAPE_INSTRUCTIONS,
    'For this pass, return an empty findings array — your only job is the verdict summary.',
  ];
  return applyLensesFn(lines.join('\n'), [SYNTHESIS_PSEUDO_LENS]);
}

// ───────────────────────────────────────────────────────────────────────────
// Dissent detection — runs regardless of rotation. Two Lenses "agree" on a
// finding when it fingerprints to the same topic; anything else is dissent.
// ───────────────────────────────────────────────────────────────────────────

function normalizeForMatch(text) {
  return String(text == null ? '' : text)
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeLocation(location) {
  return String(location == null ? '' : location).trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * A cross-Lens comparable key for "the same underlying observation" —
 * deliberately NOT lensContract.computeFingerprint, which folds the lens id
 * into its material by design (so the same finding stays trackable across a
 * single lens's version bumps). Panel dissent needs the opposite property:
 * two DIFFERENT Lenses raising the same claim in the same place must key
 * identically so they can be compared, which is exactly what including the
 * lens id would prevent.
 *
 * @param {object} finding
 * @returns {string}
 */
function findingTopicKey(finding) {
  const firstQuote = Array.isArray(finding && finding.evidence) && finding.evidence[0]
    ? normalizeForMatch(finding.evidence[0].quote)
    : '';
  return [normalizeForMatch(finding && finding.class), normalizeLocation(finding && finding.location), firstQuote].join('::');
}

/**
 * Combine every Lens's surviving findings into the panel's merged findings[]
 * and a populated dissent[]. Two kinds of dissent are detected, matching the
 * task spec exactly:
 *   - coverage: a topic raised by exactly one Lens in a panel of 2+, i.e.
 *     every other Lens looked at the same artifact and did not raise it.
 *   - severity: a topic raised by 2+ Lenses who assigned it materially
 *     different severity.
 * A topic raised by 2+ Lenses at the SAME severity is agreement: it collapses
 * into one merged finding carrying every contributing lens_id, rather than
 * being duplicated once per Lens.
 *
 * @param {Array<{lens_id: string, verdict: object|null, findings: Array<object>}>} perLensResults
 * @returns {{ findings: Array<object>, dissent: Array<object> }}
 */
function mergeFindingsAndDissent(perLensResults) {
  const panelSize = perLensResults.length;
  const groups = new Map(); // topicKey -> [{lensId, finding}]

  for (const result of perLensResults) {
    for (const finding of result.findings || []) {
      const key = findingTopicKey(finding);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ lensId: result.lens_id, finding });
    }
  }

  const findings = [];
  const dissent = [];

  for (const [key, occurrences] of groups) {
    const severities = new Set(occurrences.map((o) => o.finding.severity));

    if (occurrences.length === 1) {
      const { lensId, finding } = occurrences[0];
      findings.push({ ...finding, lens_id: lensId, agreement: null });
      // Only a coverage disagreement if there was another Lens in the panel
      // that had the same artifact in front of it and did not raise this —
      // a single-Lens panel cannot dissent with itself.
      if (panelSize > 1) {
        dissent.push({
          type: 'coverage',
          topic: { class: finding.class, location: finding.location },
          lenses: [{ lens_id: lensId, severity: finding.severity }],
          detail: `raised by ${lensId} only; ${panelSize - 1} other Lens(es) on the same artifact did not raise it`,
        });
      }
      continue;
    }

    if (severities.size === 1) {
      // Unanimous on this topic and its severity: one merged entry, every
      // contributing lens_id recorded, not silently attributed to whichever
      // Lens happened to run first.
      const representative = occurrences[0].finding;
      findings.push({
        ...representative,
        lens_id: occurrences.map((o) => o.lensId).join(','),
        lens_ids: occurrences.map((o) => o.lensId),
        agreement: 'unanimous',
      });
      continue;
    }

    // Same topic, different severity: this IS the disagreement this whole
    // panel exists to surface. Keep every Lens's finding separate in
    // findings[] (never blended into one averaged severity) and record the
    // conflict explicitly in dissent[].
    for (const { lensId, finding } of occurrences) {
      findings.push({ ...finding, lens_id: lensId, agreement: 'disputed', disputed: true });
    }
    dissent.push({
      type: 'severity',
      topic: { class: occurrences[0].finding.class, location: occurrences[0].finding.location },
      lenses: occurrences.map((o) => ({ lens_id: o.lensId, severity: o.finding.severity })),
      detail: `${occurrences.map((o) => `${o.lensId}=${o.finding.severity}`).join(' vs ')} on the same finding`,
    });
  }

  // A panel that agrees on everything is not automatically a success — it
  // may just mean every Lens shares the same blind spot. Never let an empty
  // dissent[] pass silently; log it and let the caller see it happened.
  if (panelSize > 1 && dissent.length === 0) {
    console.warn(`[lensPanel] all ${panelSize} Lens(es) agreed perfectly on every finding — verify this is independent agreement, not a shared blind spot`);
  }

  return { findings, dissent };
}

// ───────────────────────────────────────────────────────────────────────────
// Budget — a ceiling across the whole panel, not per Lens (invariant 6,
// scaled: a panel multiplies spend by lens count, so the ceiling must too).
// Actual per-call token/cost telemetry is not part of runModelFn's contract
// (it returns raw text, same as eval/lenses/runEval.mjs's runModel), so
// spend is tracked via each Lens's OWN declared depth-profile ceiling — a
// safe upper bound for that call, never an underestimate, which is the
// correct direction to be wrong in for a budget guard.
// ───────────────────────────────────────────────────────────────────────────

function addUsage(a, b) {
  return { usd: (a.usd || 0) + (b.usd || 0), tokens: (a.tokens || 0) + (b.tokens || 0) };
}

// ───────────────────────────────────────────────────────────────────────────
// runPanel — the orchestrator.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Run a panel of Lenses over one artifact under a rotation mode, and return
 * the contract's panel shape: per-lens verdicts, merged findings, and a
 * populated dissent[].
 *
 * @param {object} options
 * @param {Array<string|object>} options.lenses - lens ids or already-loaded lens objects
 * @param {{id: string, title?: string, text?: string, content?: string}} options.artifact
 * @param {string} [options.rotation] - 'blind' | 'relay' | 'adversarial' | 'synthesis', default 'blind'
 * @param {{max_usd?: number, max_tokens?: number}} [options.budget]
 * @param {string} [options.depth] - 'quick' | 'standard' | 'deep', default 'standard'
 * @param {string} [options.model]
 * @param {Function} [options.runModelFn] - (prompt, model) => string, injectable for tests
 * @param {Function} [options.loadLensFn]
 * @param {Function} [options.applyLensesFn]
 * @param {Function} [options.enforceContractFn]
 * @returns {Promise<object>}
 */
async function runPanel(options = {}) {
  const {
    lenses: lensesInput = [],
    artifact,
    rotation = DEFAULT_ROTATION,
    budget = null,
    depth = 'standard',
    model = 'sonnet',
    runModelFn = defaultRunModel,
    loadLensFn = loadLens,
    applyLensesFn = applyLenses,
    enforceContractFn = enforceContract,
  } = options;

  if (!ROTATIONS.includes(rotation)) {
    throw new Error(`runPanel: unknown rotation "${rotation}", expected one of ${ROTATIONS.join(', ')}`);
  }
  if (!artifact || !artifact.id) {
    throw new Error('runPanel: artifact with an id is required');
  }

  const lenses = lensesInput.map((entry) => (typeof entry === 'string' ? loadLensFn(entry) : entry));
  const text = artifactText(artifact);

  const perLensResults = [];
  let usage = { usd: 0, tokens: 0 };
  let budgetTripped = false;
  let priorContext = null;

  for (const lens of lenses) {
    const context = (rotation === 'relay' || rotation === 'adversarial') ? priorContext : null;
    const prompt = buildLensPanelPrompt(lens, artifact, context, rotation, applyLensesFn);
    const raw = await runModelFn(prompt, model);
    const parsed = parseModelJson(raw, lens.id);
    const enforced = enforceContractFn(lens, { artifact_id: artifact.id, verdict: parsed.verdict, findings: parsed.findings }, text);

    const cost = depthProfile(lens, depth);
    usage = addUsage(usage, { usd: cost.max_usd, tokens: cost.max_tokens });

    const result = {
      lens_id: lens.id,
      verdict: enforced.verdict,
      findings: enforced.findings,
      applied: {
        lens_id: lens.id,
        version: lens.version || null,
        model,
        depth,
        provider: 'quoxlens',
        unproven: !!lens.unproven,
        blind_spots: Array.isArray(lens.blind_spots) ? lens.blind_spots : [],
      },
      violations: enforced.violations,
      dropped: enforced.dropped,
    };
    perLensResults.push(result);
    priorContext = { verdict: enforced.verdict, findings: enforced.findings };

    // Budget is a ceiling, not a hint: check AFTER accounting for the call
    // that just ran (it already happened), and stop BEFORE spending on the
    // next one.
    if (budgetGuard(usage, budget) === 'exceeded') {
      budgetTripped = true;
      break;
    }
  }

  const { findings, dissent } = mergeFindingsAndDissent(perLensResults);

  let synthesis = null;
  if (rotation === 'synthesis' && !budgetTripped && perLensResults.length > 0) {
    const cost = depthProfile(SYNTHESIS_PSEUDO_LENS, depth);
    const projected = addUsage(usage, { usd: cost.max_usd, tokens: cost.max_tokens });
    if (budgetGuard(projected, budget) === 'exceeded') {
      budgetTripped = true;
    } else {
      usage = projected;
      const prompt = buildSynthesisPrompt(perLensResults, dissent, artifact, applyLensesFn);
      const raw = await runModelFn(prompt, model);
      const parsed = parseModelJson(raw, 'synthesis');
      // The synthesis pass reports, it does not judge the artifact itself —
      // enforceContract is skipped here on purpose; its findings are always
      // empty by prompt instruction, and its verdict is a narrative over the
      // panel's own verdicts, not a fresh evidentiary claim about the artifact.
      synthesis = { verdict: parsed.verdict, reported_dissent: dissent.length };
    }
  }

  const disposition = budgetTripped
    ? 'inconclusive'
    : computeOverallDisposition(perLensResults, dissent);

  return {
    disposition,
    rotation,
    lenses_run: perLensResults.length,
    lenses_requested: lenses.length,
    budget_tripped: budgetTripped,
    verdicts: perLensResults,
    findings,
    dissent,
    synthesis,
    usage,
  };
}

/**
 * The panel's overall disposition is the WORST (highest-severity) stance
 * across its Lenses, bumped to at least "concerns" whenever dissent exists —
 * a maximum, not a mean. This is deliberately not an average: averaging a
 * "fail" and a "pass" into "concerns" would hide that one Lens found
 * something the others missed, which is the exact failure mode this whole
 * module exists to prevent.
 *
 * @param {Array<{verdict: object|null}>} perLensResults
 * @param {Array<object>} dissent
 * @returns {string}
 */
function computeOverallDisposition(perLensResults, dissent) {
  let rank = dissent.length > 0 ? DISPOSITION_RANK.concerns : DISPOSITION_RANK.pass;
  for (const result of perLensResults) {
    const disposition = result.verdict && result.verdict.disposition;
    const candidate = DISPOSITION_RANK[disposition];
    if (typeof candidate === 'number' && candidate > rank) rank = candidate;
  }
  return Object.keys(DISPOSITION_RANK).find((key) => DISPOSITION_RANK[key] === rank) || 'concerns';
}

// ───────────────────────────────────────────────────────────────────────────
// composePanel — pick a panel by blind-spot coverage, not by convenience.
// ───────────────────────────────────────────────────────────────────────────

function* combinations(items, size) {
  if (size === 0) {
    yield [];
    return;
  }
  for (let i = 0; i <= items.length - size; i++) {
    for (const rest of combinations(items.slice(i + 1), size - 1)) {
      yield [items[i], ...rest];
    }
  }
}

/** What a single lens covers of a required set: every required area it does NOT declare as a blind spot. */
function coverageOf(lens, requiredCoverage) {
  const blindSpots = new Set(Array.isArray(lens.blind_spots) ? lens.blind_spots : []);
  return requiredCoverage.filter((area) => !blindSpots.has(area));
}

function unionCoverage(lenses, requiredCoverage) {
  const covered = new Set();
  for (const lens of lenses) {
    for (const area of coverageOf(lens, requiredCoverage)) covered.add(area);
  }
  return covered;
}

/**
 * Choose the smallest subset of `candidates` whose declared blind_spots are
 * complementary enough to cover `requiredCoverage`. Five Lenses sharing a
 * blind spot produce confident, unanimous, correlated failure — worse than
 * one Lens with a caveat — so this never pretends coverage exists where it
 * does not: if no subset covers everything, it returns the smallest subset
 * achieving the BEST coverage actually available in the pool, and reports
 * exactly what remains uncovered rather than silently dropping it.
 *
 * Exhaustive search over subset sizes 1..candidates.length: candidate pools
 * for a Lens panel are small by nature (budget multiplies per Lens, so
 * nobody composes a 50-Lens pool), so this stays cheap in practice.
 *
 * @param {Array<object>} candidates - loaded lens objects (must declare blind_spots)
 * @param {Array<string>} requiredCoverage
 * @returns {{ panel: Array<object>, coverage: { required: Array<string>, covered: Array<string>, uncovered: Array<string> } }}
 */
function composePanel(candidates, requiredCoverage) {
  const pool = Array.isArray(candidates) ? candidates : [];
  const required = Array.isArray(requiredCoverage) ? requiredCoverage : [];

  if (required.length === 0 || pool.length === 0) {
    return { panel: [], coverage: { required, covered: [], uncovered: required.slice() } };
  }

  const bestPossible = unionCoverage(pool, required);
  const targetSize = bestPossible.size; // full coverage if achievable, else the pool's ceiling

  for (let size = 1; size <= pool.length; size++) {
    for (const combo of combinations(pool, size)) {
      const covered = unionCoverage(combo, required);
      if (covered.size === targetSize) {
        return {
          panel: combo,
          coverage: {
            required,
            covered: required.filter((area) => covered.has(area)),
            uncovered: required.filter((area) => !covered.has(area)),
          },
        };
      }
    }
  }

  // Unreachable in practice (size = pool.length always hits targetSize by
  // definition of bestPossible), kept as a defensive fallback.
  return { panel: pool.slice(), coverage: { required, covered: required.filter((a) => bestPossible.has(a)), uncovered: required.filter((a) => !bestPossible.has(a)) } };
}

module.exports = {
  ROTATIONS,
  DEFAULT_ROTATION,
  runPanel,
  composePanel,
  mergeFindingsAndDissent,
  findingTopicKey,
  buildLensPanelPrompt,
  buildSynthesisPrompt,
  computeOverallDisposition,
  parseModelJson,
};
