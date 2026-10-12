/**
 * AUD-PDF Phase 2: redaction pre-pass
 *
 * Walks any JSON-shape structure and replaces strings that match the
 * configured patterns with a redaction marker. Returns a deep copy —
 * never mutates the input.
 *
 * Config shape:
 *   {
 *     emails?: true,           // match standard RFC email shapes
 *     ipv4?: true,             // match IPv4 addresses
 *     agents?: true,           // match "agent.*" identifiers
 *     userIds?: true,          // match "user_*" / "human.*" identifiers
 *     customPatterns?: RegExp[],
 *     customFieldKeys?: string[],  // always redact any field whose KEY matches
 *     marker?: string,         // default '████████'
 *   }
 *
 * When any redaction happens, the returned object has a top-level
 * `_redacted_fields: number` counter so the caller can note redaction
 * status in the PDF metadata (auditor visibility).
 */

const DEFAULT_MARKER = '████████';

const BUILTIN_PATTERNS = {
  emails: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  ipv4: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  agents: /\bagent\.[a-zA-Z0-9_-]+/g,
  userIds: /\b(?:user_|human\.)[a-zA-Z0-9_-]+/g,
};

function buildActivePatterns(config) {
  const patterns = [];
  for (const key of ['emails', 'ipv4', 'agents', 'userIds']) {
    if (config[key]) patterns.push(BUILTIN_PATTERNS[key]);
  }
  if (Array.isArray(config.customPatterns)) {
    for (const rx of config.customPatterns) {
      if (rx instanceof RegExp) patterns.push(rx);
    }
  }
  return patterns;
}

function isRedactedKey(key, customFieldKeys) {
  if (!Array.isArray(customFieldKeys) || customFieldKeys.length === 0) return false;
  return customFieldKeys.includes(key);
}

/**
 * Apply redaction to a single string value against every active pattern.
 * Returns { value, hits } — hits is the count of replacements for telemetry.
 */
function redactString(value, patterns, marker) {
  if (typeof value !== 'string') return { value, hits: 0 };
  let out = value;
  let hits = 0;
  for (const rx of patterns) {
    // Clone the regex so we don't carry lastIndex state across calls.
    const safe = new RegExp(rx.source, rx.flags.includes('g') ? rx.flags : rx.flags + 'g');
    out = out.replace(safe, () => {
      hits++;
      return marker;
    });
  }
  return { value: out, hits };
}

/**
 * Redact a report object. Returns { redacted, stats: { fields, replacements } }.
 */
function redact(report, config = {}) {
  const active = buildActivePatterns(config);
  const marker = config.marker || DEFAULT_MARKER;
  const customKeys = config.customFieldKeys || [];
  let fieldsRedacted = 0;
  let totalReplacements = 0;

  function walk(value, keyHint) {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map((v) => walk(v, keyHint));
    if (typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        if (isRedactedKey(k, customKeys)) {
          out[k] = marker;
          fieldsRedacted++;
          continue;
        }
        out[k] = walk(v, k);
      }
      return out;
    }
    if (typeof value === 'string' && active.length > 0) {
      const { value: redactedValue, hits } = redactString(value, active, marker);
      if (hits > 0) {
        fieldsRedacted++;
        totalReplacements += hits;
      }
      return redactedValue;
    }
    return value;
  }

  const redacted = walk(report, null);
  return {
    redacted,
    stats: {
      fieldsRedacted,
      totalReplacements,
    },
  };
}

module.exports = {
  DEFAULT_MARKER,
  BUILTIN_PATTERNS,
  redact,
};
