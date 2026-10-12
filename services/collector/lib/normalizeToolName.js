'use strict';

/**
 * Normalize a tool_id to be Anthropic-tool-use-API compatible.
 * Anthropic limits tool names to [a-zA-Z0-9_-]{1,64}; no dots allowed.
 *
 * Used by:
 *   - auth's /internal/agents/:id/tools (converts on output)
 *   - collector's install + reseed handlers (registers under both names)
 *
 * Idempotent: a name without dots is returned unchanged.
 */
function normalizeToolName(id) {
  if (typeof id !== 'string') return id;
  return id.replace(/\./g, '_');
}

module.exports = { normalizeToolName };
