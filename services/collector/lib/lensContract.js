/**
 * lensContract — QUOXLENS P1
 *
 * lensComposer (P0) builds the prompt a Lens speaks through. This module is
 * the other half: the part that does not trust what comes back. A Lens can
 * ask a model for anything, but the seven invariants in docs/LENS_CONTRACT.md
 * are enforced here, in code, regardless of what the model produced. Nothing
 * in this file trusts a finding just because it is shaped correctly.
 *
 * Deliberately dependency-free, same reason as lensComposer: the collector's
 * package.json does not carry a JSON Schema validator or a YAML parser, and
 * this module only needs Node's built-in crypto for hashing.
 */

'use strict';

const crypto = require('crypto');

const VALID_BASES = ['fact', 'inference', 'assumption'];

// Fallback depth profiles. A lens can override any leg via flat frontmatter
// keys (depth_<quick|standard|deep>_<max_tokens|max_usd|evidence_bar>) since
// the P0 frontmatter parser only understands scalars, booleans and inline
// arrays, not nested YAML maps.
const DEFAULT_DEPTH_PROFILES = {
  quick: { max_tokens: 4000, max_usd: 0.05, evidence_bar: 'low' },
  standard: { max_tokens: 12000, max_usd: 0.15, evidence_bar: 'standard' },
  deep: { max_tokens: 40000, max_usd: 0.5, evidence_bar: 'high' },
};

/**
 * The JSON Schema for a single finding, matching the shape docs/LENS_CONTRACT.md
 * defines under `findings[]`. `fingerprint` is present as a property because
 * it is part of the documented shape, but it is deliberately left out of
 * `required` — the model never invents its own fingerprint, enforceContract
 * computes it from the lens id, artifact id, finding class and location
 * after the model has spoken. Callers building a tool-call schema for the
 * model should use this as-is; callers building the outbound response
 * schema can add fingerprint back to `required` once it has been computed.
 *
 * @returns {object} JSON Schema (draft-07 shape)
 */
function findingSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['class', 'severity', 'claim', 'rationale', 'location', 'evidence', 'confidence', 'basis'],
    properties: {
      fingerprint: {
        type: 'string',
        description: 'sha256-<hex>, computed server-side after the finding is accepted; never supplied by the model',
      },
      class: {
        type: 'string',
        description: 'lens-defined finding class, must be one of the lens finding_classes',
      },
      severity: {
        type: 'string',
        enum: ['critical', 'high', 'medium', 'low', 'info'],
      },
      claim: {
        type: 'string',
        description: 'one line, no rationale',
      },
      rationale: {
        type: 'string',
        description: 'why it matters',
      },
      location: {
        type: 'string',
        description: 'line 42 | 0:38 | selector | path',
      },
      evidence: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['quote'],
          properties: {
            quote: { type: 'string', description: 'verbatim from artifact' },
            at: { type: 'string', description: 'line 42 | 0:38' },
          },
        },
      },
      confidence: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
      },
      basis: {
        type: 'string',
        enum: VALID_BASES,
      },
    },
  };
}

/**
 * Strip whitespace and punctuation differences so a quote reproduced with
 * smart quotes, extra spaces or trailing periods still matches its source.
 * Case is deliberately preserved — "verbatim" means the words, not that the
 * model is free to relabel them by shouting or whispering.
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeForMatch(text) {
  return String(text == null ? '' : text)
    .normalize('NFKC')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Collapse a location string to a stable form for fingerprinting. Two
 * findings at "Line 42" and "line 42" are the same location.
 *
 * @param {string} location
 * @returns {string}
 */
function normalizeLocation(location) {
  return String(location == null ? '' : location).trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Drop any finding whose evidence cannot be found verbatim (post-normalisation)
 * in the artifact text. A finding that loses every quote is dropped entirely
 * rather than kept with an empty evidence array — invariant 1 in
 * docs/LENS_CONTRACT.md is "no finding without evidence", not "no finding
 * without SOME evidence surviving somewhere".
 *
 * @param {Array<object>} findings
 * @param {string} artifactText
 * @returns {{ findings: Array<object>, dropped: Array<{class: string, location: string, reason: string}> }}
 */
function verifyEvidence(findings, artifactText) {
  const haystack = normalizeForMatch(artifactText);
  const kept = [];
  const dropped = [];

  for (const finding of Array.isArray(findings) ? findings : []) {
    if (!finding || typeof finding !== 'object') continue;
    const evidence = Array.isArray(finding.evidence) ? finding.evidence : [];
    const verified = evidence.filter((item) => {
      if (!item || typeof item.quote !== 'string') return false;
      const normalizedQuote = normalizeForMatch(item.quote);
      return normalizedQuote.length > 0 && haystack.includes(normalizedQuote);
    });

    if (verified.length === 0) {
      dropped.push({ class: finding.class, location: finding.location, reason: 'no verified evidence' });
      continue;
    }

    kept.push({ ...finding, evidence: verified });
  }

  return { findings: kept, dropped };
}

/**
 * sha256(lens id + artifact id + finding class + normalised location).
 * Deliberately excludes lens version and finding text — the same claim at
 * the same spot in the same artifact is the same finding across a lens
 * version bump, so consumers can dedupe and track its lifecycle rather than
 * seeing a fresh finding every time the lens copy changes.
 *
 * @param {string} lensId
 * @param {string} artifactId
 * @param {string} findingClass
 * @param {string} location
 * @returns {string}
 */
function computeFingerprint(lensId, artifactId, findingClass, location, evidence) {
  /* The first evidence quote is part of the material, and the claim prose is
     deliberately not. A model rewords its own claim between runs, which would
     make the fingerprint unstable and break dedupe. The quote is verbatim from
     the artifact, so it is stable across runs AND distinguishes two different
     findings that share a class and a location. Without it, "fully automated is
     unsupported" and "enterprise-grade is unsupported" on the same line collide
     into one fingerprint, and remediating either would look like remediating
     both once the lifecycle lands. */
  const firstQuote = Array.isArray(evidence) && evidence.length && evidence[0]
    ? normalizeForMatch(evidence[0].quote)
    : '';
  const material = [
    String(lensId || ''),
    String(artifactId || ''),
    String(findingClass || ''),
    normalizeLocation(location),
    firstQuote,
  ].join('::');
  return `sha256-${crypto.createHash('sha256').update(material, 'utf8').digest('hex')}`;
}

/**
 * The full enforcement pass. Takes a lens and the raw result a model
 * produced (`{ verdict, findings, artifact_id }` — artifact_id mirrors the
 * request's `artifact.id` so the caller who has it can pass it straight
 * through) and returns only what survives the seven invariants:
 *
 *  - every finding's class must be declared in the lens's finding_classes
 *  - basis must be fact | inference | assumption
 *  - if the lens requires cite_sources, every finding must have verifiable
 *    evidence in the artifact text
 *  - every surviving finding gets a stable fingerprint
 *
 * @param {object} lens - a loaded lens (see lensComposer.loadLens)
 * @param {{ verdict?: object, findings?: Array<object>, artifact_id?: string, artifact?: {id?: string} }} result
 * @param {string} artifactText - the artifact content evidence is checked against
 * @returns {{ verdict: object|null, findings: Array<object>, dropped: number, violations: Array<object> }}
 */
function enforceContract(lens, result, artifactText) {
  if (!lens || typeof lens !== 'object') {
    throw new Error('enforceContract: lens is missing or malformed');
  }

  const findingClasses = Array.isArray(lens.finding_classes) ? lens.finding_classes : [];
  const artifactId = (result && (result.artifact_id || (result.artifact && result.artifact.id))) || '';
  const rawFindings = Array.isArray(result && result.findings) ? result.findings : [];

  const violations = [];
  let survivors = [];

  for (const finding of rawFindings) {
    if (!finding || typeof finding !== 'object') {
      violations.push({ reason: 'malformed finding' });
      continue;
    }
    if (findingClasses.length > 0 && !findingClasses.includes(finding.class)) {
      violations.push({ reason: 'unknown finding class', class: finding.class, location: finding.location });
      continue;
    }
    if (!VALID_BASES.includes(finding.basis)) {
      violations.push({ reason: 'missing or invalid basis', class: finding.class, basis: finding.basis, location: finding.location });
      continue;
    }
    survivors.push(finding);
  }

  if (lens.evidence_standard === 'cite_sources') {
    const verified = verifyEvidence(survivors, artifactText);
    survivors = verified.findings;
    for (const entry of verified.dropped) violations.push(entry);
  }

  const findings = survivors.map((finding) => ({
    ...finding,
    fingerprint: computeFingerprint(lens.id, artifactId, finding.class, finding.location, finding.evidence),
  }));

  return {
    verdict: (result && result.verdict) || null,
    findings,
    dropped: rawFindings.length - findings.length,
    violations,
  };
}

/**
 * Resolve quick | standard | deep to concrete caps. A lens may override any
 * leg via flat frontmatter keys, e.g. `depth_deep_max_tokens: 60000`;
 * anything not declared falls back to DEFAULT_DEPTH_PROFILES.
 *
 * @param {object|null|undefined} lens
 * @param {string} depth - "quick" | "standard" | "deep"
 * @returns {{ max_tokens: number, max_usd: number, evidence_bar: string }}
 */
function depthProfile(lens, depth) {
  const key = Object.prototype.hasOwnProperty.call(DEFAULT_DEPTH_PROFILES, depth) ? depth : 'standard';
  const defaults = DEFAULT_DEPTH_PROFILES[key];
  const prefix = `depth_${key}_`;

  const declaredTokens = lens ? lens[`${prefix}max_tokens`] : undefined;
  const declaredUsd = lens ? lens[`${prefix}max_usd`] : undefined;
  const declaredBar = lens ? lens[`${prefix}evidence_bar`] : undefined;

  return {
    max_tokens: declaredTokens !== undefined ? Number(declaredTokens) : defaults.max_tokens,
    max_usd: declaredUsd !== undefined ? Number(declaredUsd) : defaults.max_usd,
    evidence_bar: declaredBar !== undefined ? declaredBar : defaults.evidence_bar,
  };
}

/**
 * Budget is a ceiling, not a hint (invariant 6). Callers that get 'exceeded'
 * must return disposition "inconclusive" with whatever was produced so far
 * — this function only tells them where the line is, it does not decide
 * what happens next, since it has no view of partial results.
 *
 * @param {{ usd?: number, tokens?: number }} usage
 * @param {{ max_usd?: number, max_tokens?: number }} budget
 * @returns {'ok'|'exceeded'}
 */
function budgetGuard(usage, budget) {
  if (!budget || typeof budget !== 'object') return 'ok';
  const usedUsd = (usage && usage.usd) || 0;
  const usedTokens = (usage && usage.tokens) || 0;
  if (typeof budget.max_usd === 'number' && usedUsd > budget.max_usd) return 'exceeded';
  if (typeof budget.max_tokens === 'number' && usedTokens > budget.max_tokens) return 'exceeded';
  return 'ok';
}

module.exports = {
  findingSchema,
  verifyEvidence,
  enforceContract,
  depthProfile,
  budgetGuard,
};
