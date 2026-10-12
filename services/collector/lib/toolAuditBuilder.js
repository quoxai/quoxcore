/**
 * toolAuditBuilder.js — STUDY-REV-2 / P4.D
 *
 * Pure function that computes the tool audit row set.
 * Kept separate from server.js so it is unit-testable without HTTP or DB.
 *
 * Inputs:
 *   toolDefs      — TOOL_DEFS object (key = tool name, value = descriptor)
 *   toolAgents    — reverse map: tool_name → string[] of agent ids that have an assignment
 *                   (comes from AGENT_TOOLS reverse-walk, same as /api/v1/tools/agents toolAgents)
 *   toolStoreMetas — array of rows from toolDefinitionsStore.listToolMetas()
 *                   (may be empty if the store is not ready)
 *
 * Output:
 *   Array<ToolAuditRow> — one entry per TOOL_DEFS key
 *
 * Status derivation (priority order):
 *   1. deprecated — store row has status='deprecated'
 *   2. live       — TOOL_DEFS key exists AND toolAgents[name].length > 0
 *   3. orphan     — TOOL_DEFS key exists, no assignments, no executions in 30d
 *   4. broken     — reserved for future (store status='broken') — falls through to orphan for now
 *
 * last_executed_at / execution_count_30d:
 *   Graceful degradation: tool_executions table is defined in auth schema but
 *   not yet populated by any service. Returns null / 0 until wired.
 *
 * Source derivation from executor_type:
 *   native → 'core'
 *   openapi → 'openapi'
 *   mcp → 'mcp'
 *   repo → 'repo'
 *   script → 'script'
 *   (any other) → 'core'
 */

'use strict';

const EXECUTOR_TO_SOURCE = {
  native:  'core',
  openapi: 'openapi',
  mcp:     'mcp',
  repo:    'repo',
  script:  'script',
};

/**
 * Build one audit row per TOOL_DEFS key.
 *
 * @param {Object}  toolDefs       - The TOOL_DEFS map from agentTools.js
 * @param {Object}  toolAgents     - Reverse map: toolName → agentId[]
 * @param {Array}   toolStoreMetas - Rows from toolDefinitionsStore.listToolMetas()
 * @returns {Array<ToolAuditRow>}
 */
function buildToolAuditRows(toolDefs, toolAgents, toolStoreMetas) {
  // Index store metas by name for O(1) lookup
  const storeByName = new Map();
  for (const meta of toolStoreMetas) {
    storeByName.set(meta.name, meta);
  }

  const rows = [];

  for (const [toolId, def] of Object.entries(toolDefs)) {
    const storeMeta = storeByName.get(toolId) || null;
    const agentsUsing = toolAgents[toolId] || [];

    // Derive source from executor_type (store row) or default to 'core'
    const executorType = storeMeta?.executor_type || 'native';
    const source = EXECUTOR_TO_SOURCE[executorType] || 'core';

    // Status derivation
    let status;
    const storeStatus = storeMeta?.status;
    if (storeStatus === 'deprecated') {
      status = 'deprecated';
    } else if (storeStatus === 'broken') {
      status = 'broken';
    } else if (agentsUsing.length > 0) {
      status = 'live';
    } else {
      // No assignments, no executions → orphan
      // (execution_count_30d will be 0 until tool_executions is wired)
      status = 'orphan';
    }

    rows.push({
      tool_id: toolId,
      name: def.name || toolId,
      source,
      status,
      agents_using: agentsUsing,
      last_executed_at: null,    // Graceful degradation: tool_executions not yet populated
      execution_count_30d: 0,    // Graceful degradation: ditto
    });
  }

  return rows;
}

module.exports = { buildToolAuditRows };
