'use strict';

/**
 * QUOX-SECURITY-SCHED Phase 3: pure scan-result diffing. No deps beyond
 * node's crypto — fully unit-testable without a db or a real scan.
 *
 * A scan job's result_json is whatever executeCliTool returned:
 * { success, output, error, exit_code, ... }. `output` is where the actual
 * scan output lives (nuclei/httpx -jsonl, subfinder/dig -silent lines, raw
 * openssl text, etc). extractFindings normalizes that output, whatever
 * shape it's in, into a flat array of comparable findings; diffScanResults
 * compares two such arrays.
 *
 * NOTE (deferred): a "REGRESSED" finding (something that was resolved and
 * has now reappeared) needs more than 2 runs of history to tell apart from
 * a routinely-recurring result — that needs the schedule's own diff
 * history, not just prev-vs-curr. v1 here only ever reports NEW (added),
 * RESOLVED (removed), and UNCHANGED between the two most recent runs.
 */

const crypto = require('crypto');

const HIGH_SEVERITIES = new Set(['high', 'critical']);

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** Best-effort: does this string parse as a JSON array of objects? */
function tryParseJsonArray(text) {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.every((v) => v && typeof v === 'object')) {
      return parsed;
    }
  } catch {
    // not a single JSON array — fall through
  }
  return null;
}

/** Best-effort: newline-delimited JSON objects (nuclei -jsonl style). */
function tryParseNdjson(text) {
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const objects = [];
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return null; // not every line is JSON — this isn't ndjson
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    objects.push(obj);
  }
  return objects;
}

function lower(v) {
  return typeof v === 'string' ? v.toLowerCase() : v;
}

function findingFromObject(obj) {
  const severityRaw = (obj.severity !== undefined ? obj.severity
    : (obj.info && obj.info.severity !== undefined ? obj.info.severity : 'info'));
  const severity = lower(severityRaw) || 'info';

  const label = obj['template-id'] || obj['matched-at'] || obj.host || obj.name || obj.url
    || (obj.info && obj.info.name) || JSON.stringify(obj).slice(0, 120);

  // Identifying fields only — deliberately excludes timestamp-ish fields
  // (curl-timestamp, timestamp, ts, matched-time, etc) so the same finding
  // across two runs hashes to the same key even if a timestamp differs.
  const identity = {
    'template-id': obj['template-id'],
    'matched-at': obj['matched-at'],
    host: obj.host,
    name: obj.name || (obj.info && obj.info.name),
    url: obj.url,
    severity,
  };

  return {
    key: stableHash(JSON.stringify(identity)),
    severity,
    label: String(label).slice(0, 120),
    raw: obj,
  };
}

function findingFromLine(line) {
  return {
    key: stableHash(line),
    severity: 'info',
    label: line.slice(0, 120),
    raw: line,
  };
}

/**
 * @param {*} resultJson - a job's result_json, may be a JSON string or an
 *   already-parsed object (the shape executeCliTool returns).
 * @param {string} [tool] - reserved for future tool-specific normalization;
 *   current logic is tool-agnostic.
 * @returns {Array<{key:string, severity:string, label:string, raw:*}>}
 */
function extractFindings(resultJson, _tool) {
  try {
    let obj = resultJson;
    if (typeof obj === 'string') {
      try {
        obj = JSON.parse(obj);
      } catch {
        // resultJson was a plain string, not JSON — treat it as the output itself
        obj = { output: resultJson };
      }
    }
    if (!obj || typeof obj !== 'object') return [];

    const output = obj.output !== undefined && obj.output !== null ? obj.output : obj;
    const outputText = typeof output === 'string' ? output : null;

    if (Array.isArray(output)) {
      // output is an array. Real scan tools land here in three shapes, and
      // the common one is nuclei: `output` is an array of JSON *strings*
      // (each a serialized finding object), NOT objects — a naive
      // `typeof v === 'object'` filter silently drops every one of them
      // (found live 2026-08-23: a real nuclei run produced 19 string
      // elements and diffed to 0 findings). Handle strings AND objects.
      const findings = [];
      for (const el of output) {
        if (el && typeof el === 'object') {
          findings.push(findingFromObject(el));
          continue;
        }
        if (typeof el === 'string') {
          const s = el.trim();
          if (!s) continue;
          let parsed = null;
          try { parsed = JSON.parse(s); } catch { parsed = null; }
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            findings.push(findingFromObject(parsed));
          } else {
            findings.push(findingFromLine(s));
          }
        }
      }
      return findings;
    }

    if (outputText !== null) {
      const asArray = tryParseJsonArray(outputText);
      if (asArray) return asArray.map(findingFromObject);

      const asNdjson = tryParseNdjson(outputText);
      if (asNdjson) return asNdjson.map(findingFromObject);

      // Plain text: one finding per non-empty trimmed line, deduped by key.
      const seen = new Map();
      for (const rawLine of outputText.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        const f = findingFromLine(line);
        if (!seen.has(f.key)) seen.set(f.key, f);
      }
      return Array.from(seen.values());
    }

    // output was an object (not array, not string) — treat the object
    // itself as a single finding.
    if (output && typeof output === 'object') {
      return [findingFromObject(output)];
    }

    return [];
  } catch {
    // Never throw on malformed input.
    return [];
  }
}

/**
 * @param {*} prevResultJson - previous successful run's result_json, or
 *   null/undefined on a first run (no baseline).
 * @param {*} currResultJson - current run's result_json.
 * @param {string} [tool]
 * @returns {{added:Array, removed:Array, unchanged:Array, newHighSeverity:Array}}
 */
function diffScanResults(prevResultJson, currResultJson, tool) {
  const currFindings = extractFindings(currResultJson, tool);

  if (prevResultJson === null || prevResultJson === undefined) {
    // First run: no baseline to compare against. Every current finding is
    // "new" relative to nothing having been observed before — this is a
    // deliberate choice (documented in the plan): a first-run baseline
    // still alerts on high/critical so a schedule's very first scan can
    // surface something serious immediately, rather than silently
    // establishing a baseline and only alerting from the second run on.
    const added = currFindings;
    return {
      added,
      removed: [],
      unchanged: [],
      newHighSeverity: added.filter((f) => HIGH_SEVERITIES.has(f.severity)),
    };
  }

  const prevFindings = extractFindings(prevResultJson, tool);
  const prevByKey = new Map(prevFindings.map((f) => [f.key, f]));
  const currByKey = new Map(currFindings.map((f) => [f.key, f]));

  const added = [];
  const unchanged = [];
  for (const f of currFindings) {
    if (prevByKey.has(f.key)) unchanged.push(f);
    else added.push(f);
  }

  const removed = prevFindings.filter((f) => !currByKey.has(f.key));

  return {
    added,
    removed,
    unchanged,
    newHighSeverity: added.filter((f) => HIGH_SEVERITIES.has(f.severity)),
  };
}

module.exports = {
  extractFindings,
  diffScanResults,
};
