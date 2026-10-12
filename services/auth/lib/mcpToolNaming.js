/**
 * mcpToolNaming — MCP inner-tool name normalization helpers.
 *
 * POWERS-INTROSPECT-P2: Auth unfolds available_tools into N discrete
 * Anthropic-API tool entries. This module handles the name normalization
 * and round-trip parse so collector dispatch can reverse emitted→canonical.
 *
 * Anthropic API constraint: [a-zA-Z0-9_-]{1,64} — no dots, max 64 chars.
 *
 * Naming rules:
 *   1. Replace dots with underscores in canonical_id.
 *   2. Strip any other characters violating [a-zA-Z0-9_-].
 *   3. Combined = <normalized_canonical>_<inner_name> (inner_name is already
 *      an MCP tool name so typically [a-z0-9_] safe, but strip non-compliant
 *      chars as a safety measure).
 *   4. If combined > 64 chars: use first 50 chars of normalized_canonical +
 *      '_' + inner_name.  If STILL > 64, use first 50 chars of
 *      normalized_canonical + '_' + 8-char hash of full combined.
 *
 * A forward registry maps emitted_name → { canonical_id, inner_name } because
 * hashing is one-way. Build it with buildNameRegistry() at unfold time and pass
 * to parseToolName() for dispatch.
 *
 * NOTE: Auth service uses "type":"module" (ESM). Collector is CJS and imports
 * a shadow copy (services/collector/lib/mcpToolNaming.js). Both must match.
 */

import { createHash } from 'crypto';

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
  return createHash('sha256').update(input).digest('hex').slice(0, 8);
}

/**
 * Produce the emitted tool name for a given canonical_id + inner_tool_name pair.
 * Deterministic: same inputs → same output, always.
 *
 * @param {string} canonicalId  - e.g. 'powers.mcp.9f18d90f.crystaldba_postgres-mcp'
 * @param {string} innerName    - e.g. 'list_schemas'
 * @returns {string}            - e.g. 'powers_mcp_9f18d90f_crystaldba_postgres-mcp_list_schemas'
 *                                  or truncated form if > 64 chars
 */
function makeEmittedName(canonicalId, innerName) {
  const normCanonical = normalizeCanonicalId(canonicalId);
  const normInner = normalizeInnerName(innerName);

  // Full combined attempt
  const combined = `${normCanonical}_${normInner}`;
  if (combined.length <= 64) return combined;

  // Truncation strategy 1: first 50 chars of canonical + _ + inner_name
  const attempt1 = `${normCanonical.slice(0, 50)}_${normInner}`;
  if (attempt1.length <= 64) return attempt1;

  // Truncation strategy 2: first 50 chars of canonical + _ + 8-char hash of full combined
  return `${normCanonical.slice(0, 50)}_${_shortHash(combined)}`;
}

/**
 * Build a forward registry mapping emitted_name → { canonical_id, inner_name }.
 * Must be built at unfold time since hashing is one-way.
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
 * Look up an emitted tool name against a set of known MCP registries.
 *
 * @param {string} emittedName   - name the LLM called (e.g. 'postgres_mcp_list_schemas')
 * @param {Map<string, {canonical_id, inner_name}>} registry - built by buildNameRegistry
 * @returns {{ canonical_id: string, inner_name: string } | null}
 */
function parseToolName(emittedName, registry) {
  if (!registry || !registry.has) return null;
  return registry.get(emittedName) || null;
}

/**
 * Max inner tools emitted per MCP before truncation with synthetic entry.
 */
const MAX_INNER_TOOLS = 40;

/**
 * Unfold a spec's available_tools into N Anthropic-API tool descriptors.
 *
 * Rules:
 * - If available_tools is empty/missing: returns null (caller should use wrapper fallback).
 * - If count > MAX_INNER_TOOLS: emit first 40 + one synthetic list_more_tools entry.
 * - Each emitted entry has: { name, description, input_schema, _canonical_id, _inner_name }
 *   The _canonical_id/_inner_name fields are for collector dispatch — NOT sent to LLM.
 *
 * @param {string} canonicalId  - e.g. 'powers.mcp.9f18d90f.crystaldba_postgres-mcp'
 * @param {string} toolDescription - base description for the MCP (for fallback hint)
 * @param {Array<{name, description, inputSchema}>} availableTools
 * @returns {Array<{name, description, input_schema, _canonical_id, _inner_name}> | null}
 */
function unfoldAvailableTools(canonicalId, toolDescription, availableTools) {
  if (!Array.isArray(availableTools) || availableTools.length === 0) {
    return null; // caller should use wrapper fallback
  }

  const totalCount = availableTools.length;
  const emitTools = availableTools.slice(0, MAX_INNER_TOOLS);
  const truncated = totalCount - emitTools.length;

  const entries = emitTools.map(inner => {
    const emittedName = makeEmittedName(canonicalId, inner.name);
    const inputSchema = resolveInputSchema(inner.inputSchema);
    return {
      name: emittedName,
      description: inner.description || `MCP tool: ${inner.name}`,
      input_schema: inputSchema,
      _canonical_id: canonicalId,
      _inner_name: inner.name,
    };
  });

  if (truncated > 0) {
    const synthName = makeEmittedName(canonicalId, 'list_more_tools');
    const normCanonical = normalizeCanonicalId(canonicalId);
    // If the synth name would collide with a real tool or be over 64, use a safe fallback
    const safeSynthName = `${normCanonical.slice(0, 50)}_list_more`;
    const finalSynthName = synthName.length <= 64 ? synthName : safeSynthName;

    entries.push({
      name: finalSynthName,
      description: `This MCP exposes ${totalCount} total tools; ${truncated} were truncated. ` +
        'This synthetic tool is a placeholder — invoke it to see a note about the truncation. ' +
        `The first ${MAX_INNER_TOOLS} tools are available above.`,
      input_schema: { type: 'object', properties: {} },
      _canonical_id: canonicalId,
      _inner_name: '__list_more_tools__',
      _synthetic: true,
    });
  }

  return entries;
}

/**
 * Resolve a JSON Schema object, inlining $ref up to depth 5.
 * If unresolvable $ref found, replaces that level with { type: 'object', properties: {} }.
 * Does NOT import a full JSON-schema library — inline resolver only.
 *
 * @param {object|undefined} schema
 * @param {number} [depth=0] - Current recursion depth
 * @returns {object}
 */
function resolveInputSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} };
  }

  // If depth limit exceeded, return safe fallback
  if (depth >= 5) {
    console.warn('[mcpToolNaming] $ref resolution depth limit reached, using empty schema');
    return { type: 'object', properties: {} };
  }

  // Attempt inline $ref resolution — we don't have a definitions dict so $ref is unresolvable
  if (schema.$ref) {
    console.warn('[mcpToolNaming] Unresolvable $ref "%s" in tool inputSchema — using empty schema', schema.$ref);
    return { type: 'object', properties: {} };
  }

  // Recursively resolve nested objects
  const resolved = { ...schema };

  if (resolved.properties && typeof resolved.properties === 'object') {
    const resolvedProps = {};
    for (const [key, val] of Object.entries(resolved.properties)) {
      resolvedProps[key] = resolveInputSchema(val, depth + 1);
    }
    resolved.properties = resolvedProps;
  }

  if (resolved.items && typeof resolved.items === 'object') {
    resolved.items = resolveInputSchema(resolved.items, depth + 1);
  }

  if (Array.isArray(resolved.allOf)) {
    resolved.allOf = resolved.allOf.map(s => resolveInputSchema(s, depth + 1));
  }
  if (Array.isArray(resolved.oneOf)) {
    resolved.oneOf = resolved.oneOf.map(s => resolveInputSchema(s, depth + 1));
  }
  if (Array.isArray(resolved.anyOf)) {
    resolved.anyOf = resolved.anyOf.map(s => resolveInputSchema(s, depth + 1));
  }

  return resolved;
}

export {
  normalizeCanonicalId,
  normalizeInnerName,
  makeEmittedName,
  buildNameRegistry,
  parseToolName,
  unfoldAvailableTools,
  resolveInputSchema,
  MAX_INNER_TOOLS,
};
