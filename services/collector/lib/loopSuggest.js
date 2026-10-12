'use strict';

/**
 * loopSuggest.js — LOOP-CONVERGENCE P1: the honest brain behind LOOP-Q's
 * loop_suggest advisor.
 *
 * QLoop's problem was never the machinery, it was discovery: the substrate is
 * built and governed, and nobody knows what to point it at. loop_suggest reads
 * real open roadmap work (QuoxPlan streams/phases) and proposes what to spawn,
 * BUT it applies the schedule-vs-loop gate honestly and is willing to say "cron
 * this, do not loop it". An advisor that only ever sells its own product is
 * governance theater (spec: docs/LOOP_SUBSTRATE_CONVERGENCE_SPEC.md §2-3).
 *
 * This module is PURE: no I/O. The tool (loopTools.js) fetches streams +
 * running loops and hands them in; everything here is deterministic and unit
 * tested. That keeps the gate logic honest and pinnable.
 *
 * The gate, three questions (spec §2):
 *   1. Endpoint a goal-state or a clock-tick?  goal = loop, clock = schedule
 *   2. Does turn N depend on what turn N-1 learned?  compounding = loop
 *   3. Would you watch it reason and pull the plug mid-way?  yes = loop
 * Lean clock / independent / no-watch -> schedule. Else -> loop.
 */

// The loopy-plugin catalog (spec §6): work shapes that genuinely warrant a loop.
// Each recipe carries the keywords that identify the shape in free text or a
// roadmap stream, a drafted objective, and a one-line why. mode is always 'loop'
// here by construction — schedule work is caught by SCHEDULE_TELLS, not listed.
const RECIPE_CATALOG = [
  {
    id: 'backlog-drain',
    title: 'Backlog drain',
    keywords: ['backlog', 'aging issues', 'triage backlog', 'drain', 'issue pile', 'stale issues'],
    objective_template: 'Work the aging backlog down: each turn pick the highest-value open item, fix or close it, until the >90d pile is cleared.',
    why: 'Open-ended goal, each choice depends on what is left, you would halt a bad-PR spree.',
  },
  {
    id: 'inbox-triage',
    title: 'Inbox triage',
    keywords: ['inbox', 'email', 'triage', 'messages', 'inboxq'],
    objective_template: 'Triage this batch of inbox items to a decision each (reply, delegate, archive, escalate), threads informing each other, until the batch is cleared.',
    why: 'Process a batch to decision-each; later items inform earlier categorisation; watchable.',
  },
  {
    id: 'migration',
    title: 'Codebase migration / refactor',
    keywords: ['migrate', 'refactor', 'convert', 'rename', 'port ', 'callers of', 'replace all', 'codemod'],
    objective_template: 'Migrate every call site of X to Y: each file informs the next, run the build after each, halt on a break, worktree-isolated, until all sites are migrated and green.',
    why: 'The use case where agentic loops most outperform everything; compounding, haltable.',
  },
  {
    id: 'security-audit-fix',
    title: 'Security audit and fix',
    keywords: ['audit', 'security', 'vulnerabilit', 'fix findings', 'secrets sweep', 'hardening'],
    objective_template: 'Audit path P, fix what is safe to auto-fix, re-scan, repeat until the finding set is clean or only human-gated items remain.',
    why: 'Find -> assess -> fix -> re-scan compounds; you would halt before a risky auto-fix.',
  },
  {
    id: 'seo-sweep',
    title: 'SEO sweep',
    keywords: ['seo', 'get pages to green', 'crawl', 'page score', 'lighthouse', 'core web vitals'],
    objective_template: 'Bring these N pages to green: fix -> re-crawl -> re-check -> next page, respecting cross-page coupling, until all pass.',
    why: 'Cross-page coupling means each fix changes the set; concrete sellable outcome.',
  },
  {
    id: 'connector-onboarding',
    title: 'Connector onboarding',
    keywords: ['connector', 'onboard', 'integration', 'depth rung', 'live-prove'],
    objective_template: 'Finish onboarding these half-configured connectors: each proven connector unlocks the next depth rung, until all reach the target rung.',
    why: 'Each proven connector unlocks the next; open-ended, watchable.',
  },
  {
    id: 'proof-loop',
    title: 'Proof loop (claim to shipped evidence)',
    keywords: ['proof', 'evidence', 'claim', 'promo', 'undersold', 'prove it', 'walkthrough'],
    objective_template: 'Take this claim to shipped evidence: drive the real surface, capture with assertions, file every gap, close the loop into promo/docs/STATUS, repeat until evidenced.',
    why: 'Claim -> drive -> capture -> file gap -> close, repeated until the claim is real.',
  },
  {
    id: 'fix-loop',
    title: 'Fix loop (bug to passing test)',
    keywords: ['bug', 'fix', 'regression', 'failing test', 'broken', 'used to work'],
    objective_template: 'Take this bug to green: write a failing test that reproduces it, minimal fix, run the suite, repeat up to the attempt cap, revert on regression.',
    why: 'Failing test -> fix -> suite -> repeat with a built-in retirement cap.',
  },
];

// Words that mean "this is a schedule, not a loop" (spec §2). If a situation or
// a stream reads like one of these, the advisor says cron it, do not loop it.
const SCHEDULE_TELLS = [
  'every ', 'daily', 'hourly', 'nightly', 'weekly', 'each morning', 'each day', 'each hour',
  'monitor', 'monitoring', 'digest', 'backup', 'sync ', 'syncing', 'health check', 'healthcheck',
  'poll', 'polling', 'scheduled report', 'cron', 'heartbeat', 'watch for new', 'periodic',
];

function norm(s) {
  return String(s || '').toLowerCase();
}

/**
 * Score a free-text blob against the recipe catalog. Returns the best matching
 * recipe and a hit count, or null if nothing matched.
 */
function bestRecipeMatch(text) {
  const t = norm(text);
  let best = null;
  for (const recipe of RECIPE_CATALOG) {
    let hits = 0;
    for (const kw of recipe.keywords) {
      if (t.includes(kw)) hits += 1;
    }
    if (hits > 0 && (!best || hits > best.hits)) best = { recipe, hits };
  }
  return best;
}

function looksLikeSchedule(text) {
  const t = norm(text);
  return SCHEDULE_TELLS.some((tell) => t.includes(tell));
}

/**
 * Classify a free-text situation as loop / schedule / unclear via the gate.
 * Schedule tells win over a recipe match, because "nightly backlog digest" is a
 * schedule even though "backlog" matches a loop recipe — the cadence word is the
 * stronger signal and mislabeling it as a loop is the exact cost blowout the
 * gate exists to prevent.
 */
function classifySituation(text) {
  const clean = String(text || '').trim();
  if (!clean) return null;

  if (looksLikeSchedule(clean)) {
    return {
      mode: 'schedule',
      title: `Schedule (not a loop): ${clean.slice(0, 80)}`,
      rationale: 'Reads like a fixed-cadence, independent-run job (a cadence or monitor word is present). Use a cron / systemd timer, not a loop. Looping it pays a model to reason every tick for work a schedule does for free.',
      source: 'situation',
    };
  }

  const match = bestRecipeMatch(clean);
  if (match) {
    return {
      mode: 'loop',
      title: `Loop: ${match.recipe.title} — ${clean.slice(0, 60)}`,
      recipe: match.recipe.id,
      objective_draft: match.recipe.objective_template,
      rationale: `${match.recipe.why} (matched the ${match.recipe.title} recipe.)`,
      source: 'situation',
    };
  }

  return {
    mode: 'unclear',
    title: `Unclear — run the gate: ${clean.slice(0, 70)}`,
    rationale: 'No clear loop shape or schedule tell. Ask the three questions: (1) goal-state endpoint or clock-tick? (2) does each turn depend on the last? (3) would you watch and halt it? Two or more "yes" toward goal/compounding/watch means loop; otherwise schedule.',
    source: 'situation',
  };
}

// A stream is a candidate for a loop only while it is genuinely open. COMPLETE
// is done; BLOCKED means something upstream must clear first, so proposing a
// loop on it would be dishonest.
function isOpenStream(stream) {
  const st = norm(stream && stream.status);
  return st !== 'complete' && st !== 'blocked' && st !== 'done';
}

/**
 * Build ranked, mode-tagged proposals from real context. Pure and deterministic.
 *
 * @param {object} args
 * @param {Array<{id,name,status,tier,summary}>} args.streams  open roadmap streams
 * @param {Array<{id,status}>} [args.runningLoops]  current loop_sessions (dedup/awareness)
 * @param {string} [args.situation]  optional free-text "should I loop this?"
 * @param {number} [args.limit]
 * @returns {{proposals:Array, running:number, note:string}}
 */
function buildProposals({ streams = [], runningLoops = [], situation = '', limit = 5 } = {}) {
  const proposals = [];

  // 1. An explicit situation verdict always leads — it is what was asked.
  const verdict = classifySituation(situation);
  if (verdict) proposals.push(verdict);

  // 2. Real open roadmap work, matched to a recipe or flagged as a schedule.
  const open = (Array.isArray(streams) ? streams : []).filter(isOpenStream);
  const roadmapProposals = [];
  for (const stream of open) {
    const blob = `${stream.name || ''} ${stream.summary || ''} ${stream.status || ''}`;
    if (looksLikeSchedule(blob)) {
      roadmapProposals.push({
        mode: 'schedule',
        title: `Schedule (not a loop): ${stream.name || stream.id}`,
        stream_id: stream.id,
        rationale: 'This open stream reads like recurring fixed-cadence work. Drive it with a schedule, not a loop.',
        source: 'roadmap',
        _score: 0,
      });
      continue;
    }
    const match = bestRecipeMatch(blob);
    if (match) {
      roadmapProposals.push({
        mode: 'loop',
        title: `Loop on ${stream.name || stream.id}`,
        stream_id: stream.id,
        recipe: match.recipe.id,
        objective_draft: `${match.recipe.objective_template} (Scoped to stream ${stream.id}: ${stream.name || ''}.)`,
        rationale: `${match.recipe.why} (open stream matched the ${match.recipe.title} recipe, ${match.hits} signal${match.hits === 1 ? '' : 's'}.)`,
        source: 'roadmap',
        _score: match.hits,
      });
    }
  }
  roadmapProposals.sort((a, b) => b._score - a._score);
  for (const p of roadmapProposals) { delete p._score; proposals.push(p); }

  // 3. Fill with catalog loop types not already represented, so the advisor
  //    always shows what the substrate CAN do even on a quiet roadmap.
  const usedRecipes = new Set(proposals.map((p) => p.recipe).filter(Boolean));
  for (const recipe of RECIPE_CATALOG) {
    if (usedRecipes.has(recipe.id)) continue;
    proposals.push({
      mode: 'loop',
      title: `Available loop type: ${recipe.title}`,
      recipe: recipe.id,
      objective_draft: recipe.objective_template,
      rationale: `${recipe.why} (catalog suggestion, no open stream matched it yet.)`,
      source: 'catalog',
    });
  }

  const running = Array.isArray(runningLoops)
    ? runningLoops.filter((s) => norm(s && s.status) === 'running' || norm(s && s.status) === 'spawned').length
    : 0;

  const capped = proposals.slice(0, Math.max(1, Math.min(limit || 5, 25)));
  const note = running > 0
    ? `${running} loop${running === 1 ? '' : 's'} currently running (loop_sessions). Check those before spawning a duplicate.`
    : 'No loops currently running.';

  return { proposals: capped, running, note };
}

module.exports = {
  RECIPE_CATALOG,
  SCHEDULE_TELLS,
  bestRecipeMatch,
  looksLikeSchedule,
  classifySituation,
  isOpenStream,
  buildProposals,
};
