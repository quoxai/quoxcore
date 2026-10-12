'use strict';

/**
 * mcpToolNaming — MCP inner-tool name normalization helpers (CJS shadow).
 *
 * POWERS-INTROSPECT-P2: Collector-side shadow of services/auth/lib/mcpToolNaming.js.
 * Auth is ESM; collector is CJS — they cannot share a module file. Both must
 * implement the same normalization spec; when the spec changes, update BOTH files.
 *
 * Spec: Anthropic API constraint [a-zA-Z0-9_-]{1,64} — no dots, max 64 chars.
 *
 * Naming rules (must match auth version exactly):
 *   1. Replace dots with underscores in canonical_id.
 *   2. Strip any other characters violating [a-zA-Z0-9_-].
 *   3. Combined = <normalized_canonical>_<inner_name>
 *   4. If combined > 64 chars: first 50 chars of canonical + _ + inner_name
 *      If STILL > 64: first 50 chars of canonical + _ + 8-char hash of combined
 *
 * Used for dispatch — collector receives unfolded tool names from LLM and must
 * reverse them to (canonical_id, inner_name) to route the MCP call correctly.
 */

const crypto = require('crypto');

/**
 * Normalize a canonical tool ID for use in combined names.
 * Replaces dots with underscores, strips chars outside [a-zA-Z0-9_-].
 *
 * @param {string} canonicalId
 * @returns {string}
 */
function normalizeCanonicalId(canonicalId) {
  if (typeof canonicalId !== 'string') return String(canonicalId);
  return canonicalId
    .replace(/\./g, '_')
    .replace(/[^a-zA-Z0-9_-]/g, '');
}

/**
 * Normalize an MCP inner tool name (strip non-compliant chars).
 *
 * @param {string} innerName
 * @returns {string}
 */
function normalizeInnerName(innerName) {
  if (typeof innerName !== 'string') return String(innerName);
  return innerName.replace(/[^a-zA-Z0-9_-]/g, '');
}

/**
 * Compute an 8-char hex hash of a string.
 *
 * @param {string} input
 * @returns {string}
 */
function _shortHash(input) {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 8);
}

/**
 * Produce the emitted tool name for a given canonical_id + inner_tool_name pair.
 * Deterministic: same inputs → same output, always.
 *
 * @param {string} canonicalId  - e.g. 'powers.mcp.9f18d90f.crystaldba_postgres-mcp'
 * @param {string} innerName    - e.g. 'list_schemas'
 * @returns {string}            - e.g. 'powers_mcp_9f18d90f_crystaldba_postgres-mcp_list_schemas'
 */
function makeEmittedName(canonicalId, innerName) {
  const normCanonical = normalizeCanonicalId(canonicalId);
  const normInner = normalizeInnerName(innerName);

  const combined = `${normCanonical}_${normInner}`;
  if (combined.length <= 64) return combined;

  const attempt1 = `${normCanonical.slice(0, 50)}_${normInner}`;
  if (attempt1.length <= 64) return attempt1;

  return `${normCanonical.slice(0, 50)}_${_shortHash(combined)}`;
}

/**
 * Build a forward registry mapping emitted_name → { canonical_id, inner_name }.
 * Must be built at install/reseed time since hashing is one-way.
 *
 * @param {string} canonicalId        - canonical tool ID (dotted)
 * @param {Array<{name: string}>} innerTools - available_tools array
 * @returns {Map<string, {canonical_id: string, inner_name: string}>}
 */
function buildNameRegistry(canonicalId, innerTools) {
  const registry = new Map();
  for (const tool of innerTools) {
    const emittedName = makeEmittedName(canonicalId, tool.name);
    registry.set(emittedName, { canonical_id: canonicalId, inner_name: tool.name });
  }
  return registry;
}

/**
 * Look up an emitted tool name in the registry.
 *
 * @param {string} emittedName
 * @param {Map<string, {canonical_id, inner_name}>} registry
 * @returns {{ canonical_id: string, inner_name: string } | null}
 */
function parseToolName(emittedName, registry) {
  if (!registry || !registry.has) return null;
  return registry.get(emittedName) || null;
}

/**
 * Maximum inner tools emitted per MCP per LLM request.
 * Must match auth version.
 */
const MAX_INNER_TOOLS = 40;

module.exports = {
  normalizeCanonicalId,
  normalizeInnerName,
  makeEmittedName,
  buildNameRegistry,
  parseToolName,
  MAX_INNER_TOOLS,
};
