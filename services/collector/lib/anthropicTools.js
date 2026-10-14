'use strict';
// The Anthropic Messages API accepts ONLY {name, description, input_schema} per
// tool and hard-rejects any extra field ("tools.0.custom.entity: Extra inputs are
// not permitted"). agentTools carry Quox metadata (entity, _entity, requiresApproval,
// category, ...) that the MCP/CLI paths tolerate but this native path must strip.
// CLI-OVER-MCP-P1: without this, OAuth chat with connector tools 400s → 403 to the
// client. Allowlist, never denylist: any future metadata field is stripped for free.
// (CLI-QUOX B2: moved here from claudeMessagesDispatcher.js, which re-exports it, so
// the governed Anthropic stream loop shares it without loading that dispatcher.)
const { encodeToolName } = require('./providerToolNames.js');

function toAnthropicTool(t) {
  const out = { name: encodeToolName(t.name) };
  if (typeof t.description === 'string' && t.description) out.description = t.description;
  out.input_schema = t.input_schema || t.inputSchema || { type: 'object', properties: {} };
  return out;
}

module.exports = { toAnthropicTool };
