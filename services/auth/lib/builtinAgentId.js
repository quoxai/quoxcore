/**
 * ASSAY audit (2026-10-17): agent ids are unique per org only, so any path that creates an org
 * agent from a caller-chosen id (agent create, every POWERS persona) could mint a tenant agent
 * wearing a built-in's id. Routing keeps the built-in, but the twin is an impersonation risk in
 * UIs, logs and slots. One rule, used by every such path.
 *
 * A built-in is any id in the static agent registry (the roster auth seeds from, so built-ins
 * added after the one-time seed still count), a collector-only built-in, an alias the collector
 * maps onto a built-in, or an active is_core row. __tests__/builtinAgentIdCoverage.test.js pins
 * this against the collector's AGENT_TOOLS and AGENT_ID_ALIASES.
 */
import { getDb } from '../db/index.js';
import { agentRegistry } from '../../../src/config/agentRegistry.js';

// Display-name aliases the collector maps onto a built-in (agentTools AGENT_ID_ALIASES).
export const BUILTIN_AGENT_ALIASES = new Set(['commanderq']);

// Built-ins the collector runs (AGENT_TOOLS) that are not in the registry.
const COLLECTOR_ONLY_BUILTINS = new Set(['qloop']);

const REGISTRY_IDS = new Set(Object.keys((agentRegistry && agentRegistry.agents) || {}));

/** db = null skips the is_core lookup (the static sets alone). */
export function isBuiltinAgentId(agentId, db = getDb()) {
    if (!agentId || typeof agentId !== 'string') return false;
    if (REGISTRY_IDS.has(agentId) || COLLECTOR_ONLY_BUILTINS.has(agentId) || BUILTIN_AGENT_ALIASES.has(agentId)) return true;
    if (!db) return false;
    try {
        return !!db.prepare(
            "SELECT 1 FROM agents WHERE is_core = 1 AND agent_id = ? AND status != 'retired' LIMIT 1"
        ).get(agentId);
    } catch (err) {
        // A schema without is_core holds no built-in rows; the static sets above still apply.
        if (/no such column: is_core/.test(err.message)) return false;
        throw err;
    }
}

/**
 * @returns {null | {status: 409, body: object}} null when the id is free to use.
 */
export function builtinAgentIdRefusal(agentId, db = getDb()) {
    if (!isBuiltinAgentId(agentId, db)) return null;
    const message = `${agentId} is a built-in agent id, so an org agent cannot use it: pick another id.`;
    return { status: 409, body: { error: message, message, code: 'AGENT_ID_IS_BUILTIN', agent_id: agentId } };
}

// PATCH on a built-in (HYPERION #13: default deny): ONLY placement and lifecycle are editable.
// Every other body key (identity, prompt, tools, model via config, and any column added later)
// ships with the product and is refused.
export const BUILTIN_EDITABLE_FIELDS = ['level', 'parent_agent_id', 'manager_assistant_id', 'home_scope_id', 'status'];

/**
 * @param {{agent_id: string, is_core?: number}} row  the stored agent row being patched
 * @param {object} body  the PATCH body
 * @returns {null | {status: 409, body: object}}
 */
export function builtinAgentPatchRefusal(row, body, db = getDb()) {
    if (!row) return null;
    const builtin = row.is_core === 1 || isBuiltinAgentId(row.agent_id, db);
    if (!builtin) return null;
    const fields = Object.keys(body && typeof body === 'object' ? body : {})
        .filter((f) => body[f] !== undefined && !BUILTIN_EDITABLE_FIELDS.includes(f));
    if (!fields.length) return null;
    const message = `${row.agent_id} is a built-in agent: its ${fields.join(', ')} ship with the product and cannot be edited here. ` +
        'To change how it behaves, create your own agent, or a hat.';
    return { status: 409, body: { error: message, message, code: 'AGENT_IS_BUILTIN', agent_id: row.agent_id, fields } };
}
