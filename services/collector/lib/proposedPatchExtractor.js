'use strict';

/**
 * Extract a proposed_patch envelope from a toolsmith chat reply.
 *
 * Path 1 (preferred): looks for a single fenced block tagged exactly
 *   ```proposed_patch\n{...JSON...}\n```
 *
 * Path 2 (fallback): if no explicit tag is found, scans for any
 *   ```json, ```js, ```javascript, or bare ``` fence and shape-validates
 *   each candidate against the same guards. Returns the first match.
 *   NOTE: if an explicit ```proposed_patch fence IS present but its JSON
 *   fails validation, we do NOT fall through to shape detection — that
 *   would mask an agent intent bug (the agent meant to emit a patch but
 *   got the structure wrong).
 *
 * Validation rules (all must pass or the field is dropped entirely):
 * - `patches` must be a non-empty array
 * - Each patch must have string fields: path, oldText, newText
 * - `path` must not contain '..' (path-traversal guard) or start with '/'
 * - `path` must be in the strict 5-file allowlist (toolsmith files only)
 * - `rationale` must be a string
 * - Total fence content must be ≤ 100 KB
 *
 * @module proposedPatchExtractor
 */

const KNOWN_TOOLSMITH_FILES = new Set([
  'script.py',
  'tool.json',
  'tests.json',
  'requirements.txt',
  'README.md',
]);

// Path 1: locate the "```proposed_patch" fence opener; closing fence is found
// by brace-balanced scan (the inner JSON may contain its own embedded
// markdown fences like ```bash inside README/script content strings).
const FENCE_TAGGED_OPENER_RE = /```proposed_patch\s*\n/;

// Path 2: matches ```json, ```js, ```javascript, or bare ``` (no tag / generic tag).
// Same brace-balanced scan; we use this regex only to find candidate opener
// positions, not the closing fence.
const FENCE_ANY_OPENER_RE = /```(json|js|javascript)?\s*\n/g;

const MAX_PATCH_BYTES = 100 * 1024; // 100 KB

/**
 * Validate the raw JSON string for a proposed_patch payload.
 * Returns the parsed payload on success, or null on any failure.
 *
 * @param {string} jsonStr
 * @returns {object|null}
 */
function tryValidate(jsonStr) {
  if (jsonStr.length > MAX_PATCH_BYTES) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  if (!Array.isArray(payload.patches) || payload.patches.length === 0) {
    return null;
  }

  if (typeof payload.rationale !== 'string') {
    return null;
  }

  for (const p of payload.patches) {
    if (
      !p ||
      typeof p.path !== 'string' ||
      typeof p.oldText !== 'string' ||
      typeof p.newText !== 'string'
    ) {
      return null;
    }

    // Path-traversal guard
    if (p.path.includes('..') || p.path.startsWith('/')) {
      return null;
    }

    // Strict allowlist — only the 5 known toolsmith files
    if (!KNOWN_TOOLSMITH_FILES.has(p.path)) {
      return null;
    }
  }

  return payload;
}

/**
 * Scan a JSON object literal starting at openIdx in text and return its
 * end index (the index of the closing `}` + 1). Brace-balanced, string-aware
 * (skips braces inside JSON strings, honours backslash escapes). Returns -1
 * if no balanced object is found.
 *
 * This is what lets us handle proposed_patch fences whose JSON contains
 * embedded markdown fences (e.g. ```bash inside README content) — the inner
 * backticks are JSON string content, not fence boundaries.
 */
function scanJsonObjectEnd(text, openIdx) {
  if (text[openIdx] !== '{') return -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') { depth++; continue; }
    if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Given a fence opener match (regex result with index + matched text),
 * find the JSON object inside (skipping leading whitespace), use
 * brace-balanced scan to find its end, then find the next closing
 * triple-backtick after the JSON object. Returns { jsonStr, fenceEnd }
 * where fenceEnd is the absolute index just after the closing ```, or
 * null if the structure isn't matched.
 */
function locateFenceContent(text, fenceOpenIdx, openerLen) {
  // First non-whitespace char after the opener should be '{'
  let i = fenceOpenIdx + openerLen;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== '{') return null;
  const jsonStart = i;
  const jsonEnd = scanJsonObjectEnd(text, jsonStart);
  if (jsonEnd === -1) return null;
  // After the JSON, find the next ``` (optionally on its own line)
  const tail = text.slice(jsonEnd);
  const closeMatch = tail.match(/^\s*```/);
  if (!closeMatch) return null;
  const fenceEnd = jsonEnd + closeMatch[0].length;
  return {
    jsonStr: text.slice(jsonStart, jsonEnd),
    fenceEnd,
  };
}

/**
 * extractProposedPatch(text)
 *
 * @param {string} text - The raw chat reply text from the LLM
 * @returns {{ strippedText: string, proposedPatch: object|null }}
 *   strippedText — reply text with the matched fence removed (or unchanged if extraction fails)
 *   proposedPatch — parsed + validated payload, or null
 */
function extractProposedPatch(text) {
  if (!text || typeof text !== 'string') {
    return { strippedText: text || '', proposedPatch: null };
  }

  // -----------------------------------------------------------------------
  // Path 1: explicit ```proposed_patch fence (preferred)
  // -----------------------------------------------------------------------
  const taggedMatch = FENCE_TAGGED_OPENER_RE.exec(text);
  if (taggedMatch) {
    const located = locateFenceContent(text, taggedMatch.index, taggedMatch[0].length);
    if (located) {
      const payload = tryValidate(located.jsonStr.trim());
      if (payload) {
        const before = text.slice(0, taggedMatch.index);
        const after = text.slice(located.fenceEnd);
        const strippedText = (before + after).replace(/\n{3,}/g, '\n\n').trimEnd();
        return { strippedText, proposedPatch: payload };
      }
    }
    // Explicit tag present but JSON is invalid (or fence structure broken) —
    // do NOT fall through to shape detection. If the agent intended to emit
    // a patch and got it wrong, silently promoting a different JSON block
    // would mask the bug.
    console.warn('[proposedPatchExtractor] explicit proposed_patch fence present but invalid');
    return { strippedText: text, proposedPatch: null };
  }

  // -----------------------------------------------------------------------
  // Path 2: shape-detection fallback for ```json / ```js / bare ```
  // -----------------------------------------------------------------------
  FENCE_ANY_OPENER_RE.lastIndex = 0;
  let firstHit = null;
  let matchCount = 0;
  let opener;
  while ((opener = FENCE_ANY_OPENER_RE.exec(text)) !== null) {
    const located = locateFenceContent(text, opener.index, opener[0].length);
    if (!located) continue;
    const payload = tryValidate(located.jsonStr.trim());
    if (payload) {
      matchCount++;
      if (firstHit === null) {
        firstHit = { opener, located, payload };
      }
    }
  }

  if (firstHit !== null) {
    if (matchCount > 1) {
      console.warn(
        `[proposedPatchExtractor] ${matchCount} generic fences matched the patch schema; using the first one`
      );
    }
    console.log(
      '[proposedPatchExtractor] shape-detected proposed_patch in fallback fence (tag was generic, not "proposed_patch")'
    );
    const before = text.slice(0, firstHit.opener.index);
    const after = text.slice(firstHit.located.fenceEnd);
    const strippedText = (before + after).replace(/\n{3,}/g, '\n\n').trimEnd();
    return { strippedText, proposedPatch: firstHit.payload };
  }

  return { strippedText: text, proposedPatch: null };
}

module.exports = { extractProposedPatch, KNOWN_TOOLSMITH_FILES };
