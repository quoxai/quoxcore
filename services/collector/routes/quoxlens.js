/**
 * quoxlens — QUOXLENS-UI P0: read-only routes for the dashboard surface.
 *
 * QuoxLens has six built phases of engine (lensComposer, lensContract,
 * unprovenGate, lensFindings, lensPanel, lensEvidence) and, until this
 * route file, no way for the owner to see any of it from the dashboard.
 * This is the read seam only: no route here applies a Lens, mutates a
 * finding's lifecycle, or writes to disk. That is a separate, later phase.
 *
 * Mounted at /api/v1/lens (see server.js), behind requireServiceOrUserAuth()
 * at the mount site, same pattern as routes/agentContracts.js.
 *
 * Data sources, all filesystem, all already produced by the engine phases:
 *   - src/config/lenses/<category>/<id>/LENS.md   — lensComposer.loadLens()
 *   - eval/lenses/unprovenGate.mjs                — isUnproven() ground truth
 *   - eval/lenses/results/<lensId>-<model>.json   — runEval.mjs output
 *   - eval/lenses/findings/<sweep>/<target>.json  — sweep.mjs output (NOT
 *     lensFindings.js's own loadFindings/saveFindings shape — sweep.mjs's own
 *     header explains why it keeps a separate on-disk shape; see sweep.mjs
 *     "Persistence" section).
 *
 * Honesty note (the reason this route file exists): a Lens with no measured
 * lift, or a negative one, must say so. isUnproven() is the single source of
 * truth this file defers to rather than re-deriving the answer — see
 * unprovenGate.mjs's own header.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Router } = require('express');
const { loadLens } = require('../lib/lensComposer.js');
const { STATES, summarise, accept } = require('../lib/lensFindings.js');
const { runPanel } = require('../lib/lensPanel.js');
const { buildLensEnvelope, buildVoltBundle, attachProvenance } = require('../lib/lensEvidence.js');

const router = Router();

/**
 * Locate src/config/lenses regardless of repo checkout vs container image —
 * duplicated from lensComposer.js's resolveLensRoot() rather than exported
 * from it, matching this codebase's existing convention (lensEvidence.js,
 * lensPanel.js each keep their own tiny copy of normalizeForMatch for the
 * same reason: this is five lines, not worth a new inter-module dependency).
 */
function resolveLensRoot() {
  const candidates = [
    path.join(__dirname, '..', '..', '..', 'src', 'config', 'lenses'), // repo checkout
    path.join(__dirname, '..', 'src', 'config', 'lenses'),             // container image
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

const LENS_ROOT = resolveLensRoot();
const RESULTS_DIR = path.join(__dirname, '..', 'eval', 'lenses', 'results');
const FINDINGS_DIR = path.join(__dirname, '..', 'eval', 'lenses', 'findings');

// ─────────────────────────────────────────────────────────────────────────
// Dependency injection — same pattern as lib/actionToolHandlers.js's
// setAuditFn(): server.js owns storeAuditEnvelope() (the AEE/WARD choke
// point) and the real voltEmitter (the AEE/WARD choke point for VOLT run
// events), and this router cannot construct either itself without either
// duplicating server.js's DB wiring here or importing server.js (circular).
// Both default to safe no-ops so the read-only routes above keep working
// with zero wiring, and so unit tests never touch a real DB/WARD chain
// unless they explicitly inject a spy.
// ─────────────────────────────────────────────────────────────────────────
let _storeAuditEnvelope = () => {};
let _voltEmitter = null;
// Injectable model runner for POST /apply, purely for tests — production
// code never calls this setter, so runPanel falls back to its own
// defaultRunModel (the real `claude` CLI). See lensPanel.js's runModelFn.
let _runModelFn = null;

/** Wire in server.js's storeAuditEnvelope. Call once at startup. */
function setAuditFn(fn) {
  if (typeof fn === 'function') _storeAuditEnvelope = fn;
}

/** Wire in server.js's real voltEmitter (see lib/voltEmitter.js createVoltEmitter). */
function setVoltEmitter(emitter) {
  _voltEmitter = emitter && typeof emitter.startRun === 'function' ? emitter : null;
}

/** Test-only: inject a fake (prompt, model) => string in place of the real claude CLI call. */
function setRunModelFn(fn) {
  _runModelFn = typeof fn === 'function' ? fn : null;
}

/** <prefix>_<base36 timestamp>_<random> — the stable id for one apply (or,
 * with prefix "LENS_ACCEPT", one accept-risk decision), used as both the
 * AEE envelope's corr and the VOLT run's corr so a single fetch of GET
 * /aee/conversation/:corr/bundle (server.js, already used by QuoxSignal's
 * own evidence trail — see EvidenceTrail.jsx there) reunites the envelope
 * and the bundle for this exact application. */
function generateApplicationId(prefix = 'LENS_APPLY') {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(4).toString('hex');
  return `${prefix}_${timestamp}_${random}`.toUpperCase();
}

// Cached at require time — dynamic import() of unprovenGate.mjs's ESM module
// from this CommonJS router, resolved once and reused (Node caches ES module
// resolution by URL anyway; this just avoids re-awaiting the import() call
// on every request).
let isUnprovenPromise = null;
function getIsUnproven() {
  if (!isUnprovenPromise) {
    isUnprovenPromise = import('../eval/lenses/unprovenGate.mjs').then((mod) => mod.isUnproven);
  }
  return isUnprovenPromise;
}

// Same lazy-dynamic-import pattern as getIsUnproven() above, for the same
// reason: sweep.mjs is ESM and this router is CommonJS. saveSweepFindings is
// sweep.mjs's own exported write helper for findings/<sweep>/<target>.json —
// reused here rather than re-implemented so POST /findings/:sweep/:target/
// accept-risk below writes through the exact same persistence a live sweep
// run does, never a second on-disk shape.
let sweepPersistencePromise = null;
function getSweepPersistence() {
  if (!sweepPersistencePromise) {
    sweepPersistencePromise = import('../eval/lenses/sweep.mjs').then((mod) => ({
      saveSweepFindings: mod.saveSweepFindings,
    }));
  }
  return sweepPersistencePromise;
}

/**
 * Every {id, category} pair under LENS_ROOT that has a LENS.md — the full
 * roster QuoxLens can currently apply (or, for most of them today, cannot
 * yet claim to have proven).
 *
 * @returns {Array<{id: string, category: string}>}
 */
function listLensIds() {
  if (!fs.existsSync(LENS_ROOT)) return [];
  const out = [];
  let categories;
  try {
    categories = fs.readdirSync(LENS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  for (const category of categories) {
    const categoryDir = path.join(LENS_ROOT, category.name);
    let lensDirs;
    try {
      lensDirs = fs.readdirSync(categoryDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const lensDir of lensDirs) {
      if (fs.existsSync(path.join(categoryDir, lensDir.name, 'LENS.md'))) {
        out.push({ id: lensDir.name, category: category.name });
      }
    }
  }
  return out;
}

/**
 * Every eval result file on disk, newest first. Trims `per_artifact` (the
 * heaviest field — full per-artifact transcripts) from the listing shape;
 * `getResultDetail` below returns it in full for a single result.
 *
 * @returns {Array<object>}
 */
function listResultFiles() {
  if (!fs.existsSync(RESULTS_DIR)) return [];
  let files;
  try {
    files = fs.readdirSync(RESULTS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const results = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, file), 'utf8'));
      const { per_artifact, ...summary } = parsed;
      results.push({ file, ...summary });
    } catch {
      // A corrupted result file must not take down the whole listing — it is
      // simply omitted, not silently treated as a clean/passing result.
    }
  }
  results.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  return results;
}

/** The most recent eval result for one lens id, across every model evaluated, or null if none exists. */
function latestResultForLens(lensId) {
  const matches = listResultFiles().filter((r) => r.lens_id === lensId);
  return matches.length ? matches[0] : null;
}

/**
 * Every findings file under FINDINGS_DIR, recursively, as
 * {scope, ...meta, summary}. `scope` is the sweep/target path with slashes,
 * matching sweep.mjs's own `${sweepName}/${targetSlug}` on-disk layout —
 * this is the "scope" a caller passes to GET /findings/:scope*.
 *
 * @returns {Array<object>}
 */
function listFindingScopes() {
  if (!fs.existsSync(FINDINGS_DIR)) return [];
  const out = [];
  function walk(dir, prefix) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, prefix ? `${prefix}/${entry.name}` : entry.name);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        const scope = prefix ? `${prefix}/${entry.name.slice(0, -5)}` : entry.name.slice(0, -5);
        try {
          const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
          const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
          out.push({
            scope,
            sweep: parsed.sweep || null,
            target: parsed.target || null,
            url: parsed.url || null,
            lastRun: parsed.lastRun || null,
            verdict: parsed.verdict || null,
            summary: summarise(findings),
          });
        } catch {
          // A corrupted findings file is omitted from the list, not reported
          // as a clean/empty scope — that would hide a real problem.
        }
      }
    }
  }
  walk(FINDINGS_DIR, '');
  return out;
}

/**
 * Resolve a sweep/target pair to its on-disk findings file path, refusing
 * anything that escapes FINDINGS_DIR — same containment style as
 * loadFindingScope below and sweep.mjs's own resolveTargetPath (reject an
 * absolute override, then require the resolved path to stay under the
 * root). Kept as its own function rather than folded into loadFindingScope
 * because a caller here (POST /findings/:sweep/:target/accept-risk) needs
 * to tell "the scope escapes the findings root" (400 — reject the request)
 * apart from "the scope is in-bounds but nothing is there" (404 — a normal,
 * expected miss), and loadFindingScope collapses both into a single null.
 *
 * @param {string} sweep
 * @param {string} target
 * @returns {string|null} the resolved, in-bounds file path, or null if sweep/target escape FINDINGS_DIR
 */
function resolveFindingsRecordPath(sweep, target) {
  if (typeof sweep !== 'string' || sweep.length === 0) return null;
  if (typeof target !== 'string' || target.length === 0) return null;
  if (path.isAbsolute(sweep) || path.isAbsolute(target)) return null;
  const filePath = path.join(FINDINGS_DIR, sweep, `${target}.json`);
  const resolved = path.resolve(filePath);
  const rootResolved = path.resolve(FINDINGS_DIR);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) return null;
  return resolved;
}

/** Load one findings-scope file in full (including every finding and its verbatim evidence quotes). */
function loadFindingScope(scope) {
  // scope is a caller-supplied path segment sequence; refuse traversal
  // outside FINDINGS_DIR before touching the filesystem.
  const filePath = path.join(FINDINGS_DIR, `${scope}.json`);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(FINDINGS_DIR) + path.sep)) return null;
  if (!fs.existsSync(resolved)) return null;
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────

/** Cheap liveness probe for the dashboard's CommandStrip health pill. */
router.get('/health', (req, res) => {
  res.json({ ok: true, version: '1', lens_count: listLensIds().length });
});

/**
 * GET /lenses — every Lens with its declared stance, its measured lift (if
 * any), and its unproven status. unproven is computed via isUnproven(), the
 * one function docs/LENS_CONTRACT.md invariant 4 designates as the source of
 * truth — never re-derived here, and never omitted from the response even
 * when the eval was won.
 */
router.get('/lenses', async (req, res) => {
  const isUnproven = await getIsUnproven();
  const ids = listLensIds();
  const lenses = ids.map(({ id, category }) => {
    let lens;
    try {
      lens = loadLens(id);
    } catch (err) {
      return { id, category, error: err.message };
    }
    const latest = latestResultForLens(id);
    return {
      id: lens.id,
      category,
      name: lens.name || lens.id,
      description: lens.description || null,
      version: lens.version || null,
      kind: lens.kind || null,
      tags: Array.isArray(lens.tags) ? lens.tags : [],
      blind_spots: Array.isArray(lens.blind_spots) ? lens.blind_spots : [],
      declared_unproven: lens.unproven === true,
      unproven: isUnproven(id),
      eval: latest
        ? {
            model: latest.model,
            date: latest.date,
            lens_version: latest.lens_version,
            matches_current_version: latest.lens_version === lens.version,
            artifact_count: latest.artifact_count,
            lift: latest.lift || null,
            baseline: latest.baseline || null,
            lens_stats: latest.lens || null,
            adjudication: latest.adjudication || null,
          }
        : null,
    };
  });
  res.json({ lenses });
});

/** GET /lenses/:id — one Lens in full, including its markdown body. 404 if not found. */
router.get('/lenses/:id', async (req, res) => {
  const isUnproven = await getIsUnproven();
  let lens;
  try {
    lens = loadLens(req.params.id);
  } catch {
    res.status(404).json({ error: `no Lens found for id "${req.params.id}"` });
    return;
  }
  const results = listResultFiles().filter((r) => r.lens_id === lens.id);
  res.json({
    id: lens.id,
    name: lens.name || lens.id,
    description: lens.description || null,
    version: lens.version || null,
    kind: lens.kind || null,
    edition: lens.edition || null,
    author: lens.author || null,
    tags: Array.isArray(lens.tags) ? lens.tags : [],
    finding_classes: Array.isArray(lens.finding_classes) ? lens.finding_classes : [],
    blind_spots: Array.isArray(lens.blind_spots) ? lens.blind_spots : [],
    prohibited: Array.isArray(lens.prohibited) ? lens.prohibited : [],
    declared_unproven: lens.unproven === true,
    unproven: isUnproven(lens.id),
    body: lens.body || '',
    results,
  });
});

/** GET /results — every eval result on disk, newest first, `per_artifact` trimmed. */
router.get('/results', (req, res) => {
  res.json({ results: listResultFiles() });
});

/** GET /results/:file — one result in full, including per-artifact detail. */
router.get('/results/:file', (req, res) => {
  const name = req.params.file.endsWith('.json') ? req.params.file : `${req.params.file}.json`;
  const filePath = path.join(RESULTS_DIR, name);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(RESULTS_DIR) + path.sep) || !fs.existsSync(resolved)) {
    res.status(404).json({ error: `no eval result file "${name}"` });
    return;
  }
  try {
    res.json(JSON.parse(fs.readFileSync(resolved, 'utf8')));
  } catch {
    res.status(500).json({ error: `result file "${name}" could not be parsed` });
  }
});

/**
 * GET /findings — every findings scope with lifecycle counts, so the
 * dashboard can lead with what needs attention without fetching every scope
 * in full.
 */
router.get('/findings', (req, res) => {
  res.json({ scopes: listFindingScopes(), states: STATES });
});

/**
 * GET /findings/*scope — one findings scope in full: every finding, its
 * lifecycle state and history, and its verbatim evidence quote(s). Scope may
 * contain slashes (sweep/target), hence the wildcard rather than a single
 * :param.
 */
router.get('/findings/*', (req, res) => {
  const scope = req.params[0];
  const data = loadFindingScope(scope);
  if (!data) {
    res.status(404).json({ error: `no findings scope "${scope}"` });
    return;
  }
  const findings = Array.isArray(data.findings) ? data.findings : [];
  res.json({
    scope,
    sweep: data.sweep || null,
    target: data.target || null,
    url: data.url || null,
    lastRun: data.lastRun || null,
    verdict: data.verdict || null,
    findings,
    summary: summarise(findings),
  });
});

/**
 * POST /findings/:sweep/:target/accept-risk — record a human "we know,
 * we accept this, revisit later" decision on one persisted finding.
 *
 * lensFindings.js's lifecycle already models accepted-risk fully (STATES,
 * the acceptance field, isAcceptanceActive's expiry check) — the only
 * missing piece was a route to record the decision. This is that route,
 * and only that route: it never runs a Lens, never fetches a target, and
 * never creates a finding — it moves ONE already-persisted finding,
 * identified by its stable fingerprint plus the sweep/target it belongs
 * to, into accepted-risk.
 *
 * `until` is required and must be a real future date. An acceptance with
 * no expiry (or an already-lapsed one) is exactly the silent-permanent-
 * exemption failure mode lensFindings.accept() and isAcceptanceActive()
 * already guard against — refused here rather than written and left for
 * the library to quietly treat as inactive.
 *
 * Body: { fingerprint: string, reason: string, until: ISO date string }
 */
router.post('/findings/:sweep/:target/accept-risk', async (req, res) => {
  const { sweep, target } = req.params;
  const body = req.body || {};

  const resolvedPath = resolveFindingsRecordPath(sweep, target);
  if (!resolvedPath) {
    res.status(400).json({
      error: 'invalid scope',
      detail: `sweep "${sweep}" and target "${target}" must be plain names, not paths that escape the findings directory`,
    });
    return;
  }

  if (typeof body.fingerprint !== 'string' || body.fingerprint.length === 0) {
    res.status(400).json({ error: 'invalid request', detail: 'fingerprint is required' });
    return;
  }
  if (typeof body.reason !== 'string' || body.reason.trim().length === 0) {
    res.status(400).json({ error: 'invalid request', detail: 'reason is required and must be a non-empty string' });
    return;
  }
  if (typeof body.until !== 'string' || body.until.length === 0) {
    res.status(400).json({
      error: 'invalid request',
      detail: 'until is required: an accepted risk must have an expiry, or it is just a hidden defect nobody is tracking',
    });
    return;
  }
  const untilEpoch = new Date(body.until).getTime();
  if (Number.isNaN(untilEpoch)) {
    res.status(400).json({ error: 'invalid request', detail: `until is not a valid date: "${body.until}"` });
    return;
  }
  const now = new Date();
  if (untilEpoch <= now.getTime()) {
    res.status(400).json({
      error: 'invalid request',
      detail: `until ("${body.until}") must be in the future; an already-expired acceptance would never read as accepted-risk`,
    });
    return;
  }

  if (!fs.existsSync(resolvedPath)) {
    res.status(404).json({ error: 'not found', detail: `no findings scope "${sweep}/${target}"` });
    return;
  }

  let record;
  try {
    record = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch {
    res.status(500).json({ error: 'findings scope could not be parsed', detail: `${sweep}/${target}` });
    return;
  }

  const findings = Array.isArray(record.findings) ? record.findings : [];
  const index = findings.findIndex((f) => f && f.fingerprint === body.fingerprint);
  if (index === -1) {
    res.status(404).json({
      error: 'not found',
      detail: `no finding with fingerprint "${body.fingerprint}" in "${sweep}/${target}"`,
    });
    return;
  }

  const actor = req.user?.id || null;
  let updated;
  try {
    updated = accept(
      findings[index],
      { until: body.until, actor, note: body.reason },
      now.toISOString(),
    );
  } catch (err) {
    res.status(400).json({ error: 'invalid request', detail: err.message });
    return;
  }

  const nextFindings = findings.slice();
  nextFindings[index] = updated;

  const { saveSweepFindings } = await getSweepPersistence();
  // Preserves url/verdict/artifactText/lastRun from the existing record —
  // this is a lifecycle edit to one finding, not a new sweep run, so
  // nothing about when the target was last actually swept should change.
  saveSweepFindings(sweep, target, nextFindings, {
    url: record.url || null,
    verdict: record.verdict || null,
    artifactText: record.artifactText || '',
    lastRun: record.lastRun || null,
  });

  res.status(200).json({
    scope: `${sweep}/${target}`,
    finding: updated,
    summary: summarise(nextFindings),
  });

  // Evidence — after the response, never allowed to affect it. Same
  // non-fatal, try/catch-wrapped posture as POST /apply's evidence
  // persistence below: a storage failure must never turn a good decision
  // into a 500.
  try {
    const orgId = req.user?.org_id || req.headers['x-org-id'] || null;
    const envelope = {
      v: '1',
      id: generateApplicationId('LENS_ACCEPT'),
      ts: now.toISOString(),
      type: 'event',
      from: actor ? `human.${actor}` : 'system',
      to: 'audit.lens',
      intent: 'lens.finding.accepted_risk',
      corr: `LENS_ACCEPT_${Date.now()}`,
      reply_to: null,
      payload: {
        sweep,
        target,
        fingerprint: body.fingerprint,
        until: body.until,
        reason: body.reason,
      },
      priority: 'normal',
      org_id: orgId,
    };
    _storeAuditEnvelope(envelope);
  } catch (err) {
    console.warn('[QuoxLens accept-risk] evidence persistence failed (non-fatal):', err.message);
  }
});

/**
 * Resolve the artifact text enforceContract judges against, per the
 * docs/LENS_CONTRACT.md `artifact.kind` union. Only "text" and "record" are
 * supported in this phase — "url" and "file" would require the collector to
 * fetch/parse a caller-supplied resource server-side, which is a distinct
 * SSRF-surface decision (see assertSafeEgressUrl() precedent elsewhere in
 * this collector) deliberately left for a later phase rather than bolted on
 * here without that review. Returns null (not empty string) for a kind this
 * phase cannot resolve, so the caller can tell "no text" apart from
 * "unsupported kind".
 *
 * @param {{kind?: string, content?: string, record?: object}} artifact
 * @returns {string|null}
 */
function resolveArtifactText(artifact) {
  const kind = artifact.kind || 'text';
  if (kind === 'text') return typeof artifact.content === 'string' ? artifact.content : '';
  if (kind === 'record') return JSON.stringify(artifact.record ?? {});
  return null;
}

/**
 * POST /apply — single-lens Lens application (QUOXLENS-P6/EVIDENCE-LIVE).
 *
 * Single-lens mode only in this phase: `mode: "panel"` 400s rather than
 * silently falling back to single, so a caller relying on panel behaviour
 * finds out immediately instead of getting a quietly-wrong verdict.
 *
 * Reuses runPanel() (lensPanel.js, already tested — P5) with a one-lens
 * panel rather than a second enforcement path: enforceContract, budgetGuard
 * and disposition computation all run through the exact same code every
 * multi-lens panel runs through, so "no finding without evidence" and
 * "budget is a ceiling" (invariants 1 and 6) are guaranteed by construction,
 * not re-implemented here and possibly drifted.
 *
 * Evidence (AEE envelope + VOLT bundle) is persisted AFTER the verdict is
 * already known to be response-worthy, wrapped in try/catch so a storage
 * failure never turns a good verdict into a 500 — same non-fatal posture as
 * server.js's emitQuoxplanAEE/emitSignalAEE.
 */
router.post('/apply', async (req, res) => {
  const body = req.body || {};
  const mode = body.mode || 'single';

  if (mode === 'panel') {
    res.status(400).json({
      error: 'panel mode is not supported by this route yet',
      detail: 'POST /api/v1/lens/apply only implements mode: "single" in this phase. Panel application (lensPanel.js runPanel with multiple lenses) is engine-complete but not yet exposed here.',
    });
    return;
  }
  if (mode !== 'single') {
    res.status(400).json({ error: 'invalid mode', detail: `mode must be "single" or "panel", got "${mode}"` });
    return;
  }

  if (!body.lens_id || typeof body.lens_id !== 'string') {
    res.status(400).json({ error: 'unknown lens', detail: 'lens_id is required' });
    return;
  }

  let lens;
  try {
    lens = loadLens(body.lens_id);
  } catch {
    res.status(400).json({ error: 'unknown lens', detail: `no Lens found for id "${body.lens_id}"` });
    return;
  }

  const artifactInput = body.artifact;
  if (!artifactInput || typeof artifactInput !== 'object' || !artifactInput.id) {
    res.status(400).json({ error: 'invalid artifact', detail: 'artifact.id is required' });
    return;
  }
  const text = resolveArtifactText(artifactInput);
  if (text === null) {
    res.status(400).json({
      error: 'invalid artifact',
      detail: `artifact.kind "${artifactInput.kind}" is not supported by this route yet; only "text" and "record" are`,
    });
    return;
  }

  const depth = typeof body.depth === 'string' ? body.depth : 'standard';
  const budget = body.budget && typeof body.budget === 'object' ? body.budget : null;
  const artifact = { id: artifactInput.id, title: artifactInput.title || null, text };

  let panelResult;
  try {
    panelResult = await runPanel({
      lenses: [lens],
      artifact,
      rotation: 'blind',
      budget,
      depth,
      runModelFn: _runModelFn || undefined,
    });
  } catch (err) {
    res.status(500).json({ error: 'lens apply failed', detail: err.message });
    return;
  }

  const single = panelResult.verdicts[0] || null;
  const rawVerdict = single && single.verdict;
  const findings = ((single && single.findings) || []).map((finding) =>
    attachProvenance(finding, {
      lensId: lens.id,
      version: lens.version || null,
      model: (single && single.applied && single.applied.model) || null,
    })
  );

  // The panel's own disposition already folds in the budget-tripped ->
  // "inconclusive" rule (lensPanel.js computeOverallDisposition + the
  // budgetTripped check ahead of it) — never recomputed here, so a budget
  // ceiling always wins over whatever the model itself claimed.
  const verdict = {
    summary: (rawVerdict && rawVerdict.summary) || (panelResult.budget_tripped
      ? 'Budget ceiling reached before the Lens could complete its assessment.'
      : 'No verdict was produced.'),
    disposition: panelResult.disposition,
    confidence: typeof (rawVerdict && rawVerdict.confidence) === 'number' ? rawVerdict.confidence : 0,
  };
  const applied = (single && single.applied) || {
    lens_id: lens.id,
    version: lens.version || null,
    model: null,
    depth,
    provider: 'quoxlens',
    unproven: !!lens.unproven,
    blind_spots: Array.isArray(lens.blind_spots) ? lens.blind_spots : [],
  };

  const applicationId = generateApplicationId();

  res.status(200).json({
    verdict,
    findings,
    applied,
    dissent: panelResult.dissent,
    usage: panelResult.usage,
    // Additive field, not part of the frozen v0.1 contract shape: the id a
    // caller (the dashboard's Evidence view) uses to fetch this exact
    // application's AEE envelope + VOLT bundle back via the collector's
    // existing GET /aee/conversation/:corr/bundle.
    evidence: { corr: applicationId },
  });

  // Evidence persistence — after the response, never allowed to affect it.
  // Same governed-boundary posture as emitSignalAEE/persistSignalEvidenceBundle
  // in server.js: this IS the boundary that decides a Lens verdict is worth
  // recording (see lensEvidence.js's own header), so it runs here, once,
  // right after a real apply — not from a second unauthenticated path.
  try {
    const orgId = req.user?.org_id || req.headers['x-org-id'] || null;
    const actor = req.user?.id || null;
    const verdictForEvidence = {
      lens_id: lens.id,
      verdict,
      findings,
      applied,
      violations: (single && single.violations) || [],
      dropped: (single && single.dropped) || 0,
      artifact_id: artifact.id,
      artifact: { id: artifact.id, title: artifact.title, text: artifact.text },
    };

    const envelope = buildLensEnvelope(verdictForEvidence, { orgId, actor, artifact });
    // buildLensEnvelope mints its own time-based corr; overridden here so the
    // AEE envelope and the VOLT run below share the SAME corr as evidence.corr
    // above — that shared corr is what lets a single GET
    // /aee/conversation/:corr/bundle call reunite them later.
    envelope.corr = applicationId;
    _storeAuditEnvelope(envelope);

    if (_voltEmitter) {
      const bundle = buildVoltBundle(verdictForEvidence);
      const runId = _voltEmitter.startRun(applicationId, { org_id: orgId });
      _voltEmitter.emit(runId, 'lens.evidence.recorded', { bundle });
      _voltEmitter.completeRun(runId);
    }
  } catch (err) {
    console.warn('[QuoxLens apply] evidence persistence failed (non-fatal):', err.message);
  }
});

module.exports = {
  router,
  setAuditFn,
  setVoltEmitter,
  setRunModelFn,
  // Exported for tests only — pure functions, no request/response coupling.
  listLensIds,
  listResultFiles,
  latestResultForLens,
  listFindingScopes,
  loadFindingScope,
  resolveFindingsRecordPath,
  resolveArtifactText,
  generateApplicationId,
};
