/**
 * lensFindings — QUOXLENS P3
 *
 * lensContract (P1) produces a fingerprint per finding that is stable across
 * runs and across a lens version bump. This module is what turns "the same
 * fingerprint showed up again" into a lifecycle a human or a gate can act
 * on. Without it a scheduled sweep just re-reports the same problems every
 * run — that is noise, and noise is what makes people stop reading digests.
 *
 * Deliberately dependency-free, same reason as lensContract: no external
 * state-machine or JSON Schema library in the collector's package.json, and
 * this module only needs Node's built-in fs/path.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');

const FINDINGS_DIR = path.join(__dirname, '..', 'eval', 'lenses', 'findings');

/**
 * `lapsed` exists because absence is not evidence of repair. A model that
 * simply does not mention a finding on the next run has told us nothing
 * about whether the artifact was fixed; treating that silence as
 * "remediated" produced digests claiming 7 fixes on a day nothing was
 * fixed, and 13 fixes across two runs over a byte-identical file. A
 * governance tool that emits false remediation claims is worse than one
 * with no lifecycle at all, because a human believes work happened that
 * did not. `remediated` now requires evidence that the artifact itself
 * changed; everything else lands in `lapsed`, which is visible, counted
 * and deliberately makes no claim about repair.
 */
const STATES = ['new', 'confirmed', 'accepted-risk', 'remediated', 'lapsed', 'regressed'];

/**
 * Coerce a Date instance or ISO string into a comparable epoch millisecond
 * number. `now` is threaded through every function rather than read from
 * the clock internally so reconcile/summarise are pure and testable without
 * mocking time.
 *
 * @param {string|Date} value
 * @returns {number}
 */
function toEpoch(value) {
  return new Date(value).getTime();
}

/**
 * True while an acceptance's expiry has not yet passed. An acceptance
 * with no `until` at all is treated as already expired rather than
 * permanently active — `accept()` refuses to create one, but a record
 * loaded from disk that predates that rule (or was edited by hand) should
 * not silently become a permanent exemption.
 *
 * @param {{ until?: string }|null|undefined} acceptance
 * @param {string|Date} now
 * @returns {boolean}
 */
function isAcceptanceActive(acceptance, now) {
  if (!acceptance || !acceptance.until) return false;
  return toEpoch(acceptance.until) > toEpoch(now);
}

/**
 * Collapse cosmetic differences in artifact text so that a re-fetch of an
 * unmodified page (different line endings, a reflowed whitespace run, a
 * unicode form change) does not read as a content change and hand out a
 * free "remediated". Deliberately separate from lensContract's
 * normalizeForMatch: that one strips punctuation because it compares a
 * model's quote against a page, whereas here punctuation IS content and a
 * deleted comma is a real edit.
 *
 * @param {string} text
 * @returns {string}
 */
function normaliseArtifactText(text) {
  return String(text == null ? '' : text)
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * sha256 of the normalised artifact text, or null when there is no text to
 * hash. null means UNKNOWN, never "unchanged" and never "changed": callers
 * must resolve an unknown to the weaker claim.
 *
 * @param {string|null|undefined} text
 * @returns {string|null}
 */
function hashArtifact(text) {
  const normalised = normaliseArtifactText(text);
  if (!normalised) return null;
  return crypto.createHash('sha256').update(normalised, 'utf8').digest('hex');
}

/**
 * True only when we can PROVE the artifact changed since the finding was
 * last actually seen. A missing hash on either side is unknown, and unknown
 * resolves to false, so a record written before hashes were stored can
 * never be upgraded into a remediation claim on the strength of nothing.
 *
 * @param {string|null|undefined} previousHash - hash stored when the finding was last present
 * @param {string|null|undefined} currentHash - hash of the artifact this run
 * @returns {boolean}
 */
function artifactChanged(previousHash, currentHash) {
  if (!previousHash || !currentHash) return false;
  return previousHash !== currentHash;
}

/**
 * Push a transition onto a copy of the history array and return the new
 * state. History is append-only: callers must never reuse the array
 * reference from a previous record, so every caller here works off a
 * fresh `.slice()` taken before the first push.
 *
 * @param {Array<object>} history - already a fresh copy, mutated by this call
 * @param {string} from
 * @param {string} to
 * @param {string|Date} at
 * @returns {string} to, so call sites can assign state in one line
 */
function transition(history, from, to, at) {
  history.push({ from, to, at });
  return to;
}

/**
 * Build the lifecycle record for a fingerprint that was not present in the
 * previous run at all.
 *
 * @param {object} finding - a raw finding from enforceContract, has .fingerprint
 * @param {string|Date} now
 * @param {string|null} [artifactHash] - hash of the artifact this finding was seen in
 * @returns {object}
 */
function createRecord(finding, now, artifactHash = null) {
  return {
    fingerprint: finding.fingerprint,
    state: 'new',
    finding,
    firstSeen: now,
    lastSeen: now,
    remediatedAt: null,
    acceptance: null,
    // Hash of the artifact as it stood the last time this finding was
    // actually reported. Comparing it against the current artifact is what
    // separates "the problem was fixed" from "the model went quiet".
    artifactHash: artifactHash || null,
    history: [{ from: null, to: 'new', at: now }],
  };
}

/**
 * Advance one existing lifecycle record given whether its fingerprint is
 * present in the current run. This is the transition table from
 * docs/LENS_CONTRACT.md's lifecycle extension, spelled out in full because
 * getting the accepted-risk and regressed legs wrong is exactly the failure
 * mode this module exists to prevent:
 *
 *  - accepted-risk, still active, present  -> stays accepted-risk (sticky)
 *  - accepted-risk, still active, absent   -> remediated (the accepted risk
 *      is gone; nothing left to hold an acceptance open for)
 *  - accepted-risk, expired, present       -> confirmed (falls back into the
 *      ordinary lifecycle now that the exemption has lapsed)
 *  - accepted-risk, expired, absent        -> remediated
 *  - new, present                          -> confirmed
 *  - confirmed, present                    -> confirmed (no-op, no new entry)
 *  - regressed, present                    -> confirmed (the "it's back" alert
 *      already fired once; a finding does not stay perpetually "regressed"
 *      any more than it stays perpetually "new")
 *  - new | confirmed | regressed, absent, artifact CHANGED   -> remediated
 *  - new | confirmed | regressed, absent, artifact UNCHANGED
 *      or unknown                          -> lapsed (the finding was not
 *      reported again, and nothing about the artifact supports calling that
 *      a fix. This is the whole point of the state: the old table read this
 *      leg as "remediated" and so reported repairs that never happened)
 *  - lapsed, present                       -> confirmed, NOT regressed. A
 *      regression means "we said it was fixed and it came back". Nothing was
 *      ever said to be fixed here, so the honest reading is that the finding
 *      was there all along and the run that missed it was the anomaly.
 *      Calling it regressed would be a second false alarm on top of the one
 *      this state exists to remove.
 *  - lapsed, absent, artifact CHANGED      -> remediated (the evidence
 *      arrived late: the artifact has since been edited and the finding is
 *      still gone, which is exactly the proof that was missing)
 *  - lapsed, absent, unchanged or unknown  -> lapsed (no-op)
 *  - remediated, present                   -> regressed (this is the leg the
 *      whole lifecycle exists for: a problem that was marked fixed and came
 *      back is not noise, it is a signal, and it must not look identical to
 *      a first-time "new" finding)
 *  - remediated, absent                    -> remediated (no-op)
 *
 * "Changed" is decided by comparing the artifact hash stored when the
 * finding was last seen against the hash of the artifact this run. Absent a
 * usable hash on either side the answer is UNKNOWN, and unknown always
 * chooses the weaker claim, `lapsed`.
 *
 * @param {object} prev - lifecycle record from the previous reconcile
 * @param {object|undefined} curr - raw finding from the current run, if present
 * @param {string|Date} now
 * @param {string|null} [currentHash] - hash of the artifact swept this run, null if unknown
 * @returns {object}
 */
function advanceRecord(prev, curr, now, currentHash = null) {
  const isPresent = curr !== undefined;
  const history = prev.history.slice();
  let state = prev.state;
  let finding = prev.finding;
  let lastSeen = prev.lastSeen;
  let remediatedAt = prev.remediatedAt;
  let artifactHash = prev.artifactHash || null;
  const acceptance = prev.acceptance;
  const changed = artifactChanged(prev.artifactHash, currentHash);

  if (prev.state === 'accepted-risk') {
    // Untouched by the absence-is-not-remediation change: a human has
    // explicitly signed off on this finding with an expiry date, so the
    // accepted-risk legs stay exactly as they were, expiry included.
    const active = isAcceptanceActive(acceptance, now);
    if (active && isPresent) {
      // Sticky by design: an accepted risk that is still within its window
      // must not reappear as "new" or "confirmed" just because a sweep ran.
      lastSeen = now;
      finding = curr;
      artifactHash = currentHash || artifactHash;
    } else if (active && !isPresent) {
      state = transition(history, 'accepted-risk', 'remediated', now);
      remediatedAt = now;
    } else if (!active && isPresent) {
      state = transition(history, 'accepted-risk', 'confirmed', now);
      lastSeen = now;
      finding = curr;
      artifactHash = currentHash || artifactHash;
    } else {
      state = transition(history, 'accepted-risk', 'remediated', now);
      remediatedAt = now;
    }
  } else if (prev.state === 'remediated') {
    if (isPresent) {
      state = transition(history, 'remediated', 'regressed', now);
      lastSeen = now;
      finding = curr;
      artifactHash = currentHash || artifactHash;
      remediatedAt = null;
    }
    // absent -> stays remediated, no history entry, nothing to update
  } else if (prev.state === 'lapsed') {
    if (isPresent) {
      // Back to confirmed, not regressed. See the transition table above.
      state = transition(history, 'lapsed', 'confirmed', now);
      lastSeen = now;
      finding = curr;
      artifactHash = currentHash || artifactHash;
    } else if (changed) {
      state = transition(history, 'lapsed', 'remediated', now);
      remediatedAt = now;
    }
    // absent with an unchanged or unknown artifact -> stays lapsed
  } else {
    // new | confirmed | regressed
    if (isPresent) {
      if (prev.state === 'new' || prev.state === 'regressed') {
        state = transition(history, prev.state, 'confirmed', now);
      }
      // already confirmed -> no-op
      lastSeen = now;
      finding = curr;
      artifactHash = currentHash || artifactHash;
    } else if (changed) {
      state = transition(history, prev.state, 'remediated', now);
      remediatedAt = now;
    } else {
      state = transition(history, prev.state, 'lapsed', now);
    }
  }

  return {
    fingerprint: prev.fingerprint,
    state,
    finding,
    firstSeen: prev.firstSeen,
    lastSeen,
    remediatedAt,
    acceptance,
    artifactHash,
    history,
  };
}

/**
 * Merge a previous run's lifecycle records with a current run's raw
 * findings into the next generation of lifecycle records. Pure function:
 * neither argument is mutated, so a caller holding a reference to
 * `previousFindings` after calling this still sees the old state.
 *
 * The artifact text (or a precomputed hash of it) is what makes a
 * remediation claim checkable. Omitting it does not fail the call, it costs
 * the run the ability to say "remediated" at all: every disappearance is
 * then UNKNOWN and lands in `lapsed`.
 *
 * @param {Array<object>} previousFindings - output of a prior reconcile (or [] on first run)
 * @param {Array<object>} currentFindings - raw findings from enforceContract, each with .fingerprint
 * @param {string|Date} now
 * @param {{ artifactText?: string, artifactHash?: string }} [options] - the
 *   artifact this run swept. `artifactHash` wins if both are supplied.
 * @returns {Array<object>}
 */
function reconcile(previousFindings, currentFindings, now, options = {}) {
  const prevList = Array.isArray(previousFindings) ? previousFindings : [];
  const currList = Array.isArray(currentFindings) ? currentFindings : [];
  const currentHash = (options && options.artifactHash) || hashArtifact(options && options.artifactText);

  const currByFingerprint = new Map();
  for (const finding of currList) {
    if (finding && finding.fingerprint) currByFingerprint.set(finding.fingerprint, finding);
  }

  const merged = [];
  const seen = new Set();

  for (const prev of prevList) {
    if (!prev || !prev.fingerprint) continue;
    seen.add(prev.fingerprint);
    const curr = currByFingerprint.get(prev.fingerprint);
    merged.push(advanceRecord(prev, curr, now, currentHash));
  }

  for (const finding of currList) {
    if (!finding || !finding.fingerprint || seen.has(finding.fingerprint)) continue;
    merged.push(createRecord(finding, now, currentHash));
  }

  return merged;
}

/**
 * Move a lifecycle record into accepted-risk with an expiry. An acceptance
 * with no expiry is rejected outright: a risk "accepted" forever is
 * functionally identical to a defect nobody is tracking, which is the exact
 * noise problem this whole lifecycle exists to solve. Force a decision
 * date, even a far one, rather than a silent permanent exemption.
 *
 * @param {object} finding - a lifecycle record (from reconcile, or loadFindings)
 * @param {{ until: string, actor?: string, note?: string }} options
 * @param {string|Date} [now]
 * @returns {object}
 */
function accept(finding, options, now) {
  if (!finding || !finding.fingerprint) {
    throw new Error('accept: finding must be a lifecycle record with a fingerprint');
  }
  if (!options || !options.until) {
    throw new Error(
      'accept: an accepted risk must have an expiry (until). ' +
        'An acceptance that never expires is just a hidden defect, ' +
        'which is the failure mode this lifecycle exists to prevent.'
    );
  }
  if (Number.isNaN(toEpoch(options.until))) {
    throw new Error(`accept: "until" is not a valid date: ${options.until}`);
  }

  const at = now || new Date().toISOString();
  const history = finding.history.slice();
  history.push({ from: finding.state, to: 'accepted-risk', at });

  return {
    ...finding,
    state: 'accepted-risk',
    acceptance: {
      until: options.until,
      actor: options.actor || null,
      note: options.note || null,
      acceptedAt: at,
    },
    history,
  };
}

/**
 * Counts per state plus `needsAttention`, the number a digest or a gate
 * actually cares about. `needsAttention` counts an accepted-risk record
 * whose expiry has already passed even though its stored `state` still
 * reads "accepted-risk" — the record only flips to confirmed/remediated the
 * next time reconcile() runs, but a digest read between sweeps must not
 * report a lapsed exemption as settled.
 *
 * `lapsed` findings are counted in `counts` like any other state but are
 * deliberately NOT in `needsAttention`: a finding nobody reported this run
 * is not an alarm, it is an open question. Counted so it stays visible,
 * quiet so it does not crowd out real new and regressed findings.
 *
 * @param {Array<object>} findings - lifecycle records
 * @param {string|Date} [now]
 * @returns {{ counts: object, needsAttention: number, total: number }}
 */
function summarise(findings, now) {
  const at = now || new Date().toISOString();
  const list = Array.isArray(findings) ? findings : [];

  const counts = STATES.reduce((acc, state) => {
    acc[state] = 0;
    return acc;
  }, {});

  let needsAttention = 0;

  for (const finding of list) {
    if (!finding || !Object.prototype.hasOwnProperty.call(counts, finding.state)) continue;
    counts[finding.state] += 1;

    if (finding.state === 'new' || finding.state === 'regressed') {
      needsAttention += 1;
    } else if (finding.state === 'accepted-risk' && !isAcceptanceActive(finding.acceptance, at)) {
      needsAttention += 1;
    }
  }

  return { counts, needsAttention, total: list.length };
}

/**
 * Load the persisted lifecycle records for a scope. A missing file means
 * "this is the first sweep for this scope", not an error — every finding
 * in that run is legitimately new.
 *
 * @param {string} scope - lens id plus an artifact-set name, e.g. "honesty-and-claims__quox-website"
 * @returns {Array<object>}
 */
function loadFindings(scope) {
  const filePath = path.join(FINDINGS_DIR, `${scope}.json`);
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Persist the merged lifecycle records for a scope. Same spirit as
 * runEval's results directory: plain JSON on disk, no database.
 *
 * @param {string} scope
 * @param {Array<object>} findings
 * @returns {void}
 */
function saveFindings(scope, findings) {
  fs.mkdirSync(FINDINGS_DIR, { recursive: true });
  const filePath = path.join(FINDINGS_DIR, `${scope}.json`);
  fs.writeFileSync(filePath, JSON.stringify(findings, null, 2));
}

module.exports = {
  STATES,
  hashArtifact,
  reconcile,
  accept,
  summarise,
  loadFindings,
  saveFindings,
};
