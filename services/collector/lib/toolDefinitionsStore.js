/**
 * Tool Definitions Store — SQLite persistence for tool metadata.
 *
 * STUDY-REV K1/R1: DB-resolved tool descriptor function.
 *
 * Stores tool METADATA (name, description, input_schema) in SQLite.
 * The in-memory TOOL_DEFS in agentTools.js keeps all executor closures;
 * this store only overrides/extends the descriptive layer.
 *
 * Resolution order for getToolMeta(name, orgId):
 *   1. Org-specific row (org_id = orgId)
 *   2. Global row (org_id = '__global__')
 *   3. null (caller falls back to hardcoded)
 */

'use strict';

const Database = require('better-sqlite3');
const { existsSync, mkdirSync } = require('fs');
const { dirname } = require('path');

let _db = null;
let _ready = false;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tool_definitions (
    org_id          TEXT NOT NULL DEFAULT '__global__',
    name            TEXT NOT NULL,
    description     TEXT NOT NULL,
    input_schema    TEXT NOT NULL,
    executor_type   TEXT NOT NULL DEFAULT 'native',
    executor_config TEXT,
    category        TEXT,
    installed_at    TEXT NOT NULL DEFAULT (datetime('now')),
    installed_by    TEXT,
    PRIMARY KEY (org_id, name)
  );
  CREATE INDEX IF NOT EXISTS idx_tool_defs_name ON tool_definitions(name);
`;

/**
 * Open or create the tools DB. Idempotent.
 * @param {string} dbPath - Filesystem path for the SQLite file.
 */
function init(dbPath) {
  if (_db) return _db;

  const resolvedPath = dbPath || process.env.TOOLS_DB_PATH || '/var/lib/quox/tools.db';

  const dir = dirname(resolvedPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  _db = new Database(resolvedPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.exec(SCHEMA);

  // STUDY-REV-2/P1.A: idempotent migration — add category column to existing DBs
  try {
    _db.exec(`ALTER TABLE tool_definitions ADD COLUMN category TEXT`);
    console.log('[ToolStore] Added category column to tool_definitions');
  } catch (e) {
    if (!/duplicate column|already exists/i.test(e.message)) {
      console.warn('[ToolStore] category column migration failed (non-fatal):', e.message);
    }
  }

  _ready = true;

  console.log(`[ToolStore] Initialized at ${resolvedPath}`);
  return _db;
}

/**
 * Whether the DB has been initialised. Used as a guard in agentTools.js
 * to skip DB lookups during early boot / test environments that haven't
 * called init().
 */
function isReady() {
  return _ready;
}

/**
 * Seed the DB from the in-memory TOOL_DEFS map.
 * Inserts each tool as org_id='__global__', executor_type='native' IF NOT EXISTS.
 * Idempotent — safe to call multiple times.
 *
 * AGENT-ATTACH #771: code is the source of truth for core native tools. An
 * existing global row with executor_type='native' whose description or
 * input_schema differs from code is REFRESHED (a stale seed from an older
 * release otherwise shadows TOOL_DEFS forever: INSERT OR IGNORE never updated
 * it). Org-specific rows (deliberate overrides) and non-native global rows
 * (mcp/toolsmith) are never touched.
 *
 * @param {object} toolDefs - The TOOL_DEFS map from agentTools.js
 * @returns {{ inserted: number, skipped: number, refreshed: number }}
 */
function seedFromHardcoded(toolDefs) {
  if (!_db) throw new Error('[ToolStore] Not initialized — call init() first');

  const insertStmt = _db.prepare(`
    INSERT OR IGNORE INTO tool_definitions
      (org_id, name, description, input_schema, executor_type, installed_at)
    VALUES ('__global__', ?, ?, ?, 'native', datetime('now'))
  `);

  const refreshStmt = _db.prepare(`
    UPDATE tool_definitions SET description = ?, input_schema = ?
    WHERE org_id = '__global__' AND name = ? AND executor_type = 'native'
      AND (description != ? OR input_schema != ?)
  `);

  let inserted = 0;
  let skipped = 0;
  let refreshed = 0;

  const seed = _db.transaction((defs) => {
    for (const [name, def] of Object.entries(defs)) {
      if (!def || !def.name || !def.description || !def.input_schema) continue;
      const schemaJson = JSON.stringify(def.input_schema);
      const changes = insertStmt.run(name, def.description, schemaJson).changes;
      if (changes > 0) {
        inserted++;
      } else if (refreshStmt.run(def.description, schemaJson, name, def.description, schemaJson).changes > 0) {
        refreshed++;
      } else {
        skipped++;
      }
    }
  });

  seed(toolDefs);
  return { inserted, skipped, refreshed };
}

/**
 * Resolve tool metadata for a given name + org.
 * Resolution: org-specific row → global row → null.
 *
 * @param {string} name
 * @param {string} [orgId='__global__']
 * @returns {{ name, description, input_schema, executor_type, executor_config } | null}
 */
function getToolMeta(name, orgId = '__global__') {
  if (!_db) return null;

  // Try org-specific first (if orgId isn't already __global__)
  if (orgId && orgId !== '__global__') {
    const orgRow = _db.prepare(
      'SELECT name, description, input_schema, executor_type, executor_config, category FROM tool_definitions WHERE org_id = ? AND name = ?'
    ).get(orgId, name);
    if (orgRow) return orgRow;
  }

  // Fall back to global
  const globalRow = _db.prepare(
    'SELECT name, description, input_schema, executor_type, executor_config, category FROM tool_definitions WHERE org_id = \'__global__\' AND name = ?'
  ).get(name);

  return globalRow || null;
}

/**
 * List all tool metas visible to an org.
 * Returns org-specific rows + global rows, with org rows taking precedence
 * on name collision.
 *
 * @param {string} [orgId='__global__']
 * @returns {Array<{ name, description, input_schema, executor_type, executor_config }>}
 */
function listToolMetas(orgId = '__global__') {
  if (!_db) return [];

  // Fetch global rows
  const globalRows = _db.prepare(
    "SELECT name, description, input_schema, executor_type, executor_config, category FROM tool_definitions WHERE org_id = '__global__'"
  ).all();

  if (!orgId || orgId === '__global__') {
    return globalRows;
  }

  // Fetch org-specific rows
  const orgRows = _db.prepare(
    'SELECT name, description, input_schema, executor_type, executor_config, category FROM tool_definitions WHERE org_id = ?'
  ).all(orgId);

  // Merge: org rows win on name collision
  const byName = new Map();
  for (const row of globalRows) byName.set(row.name, row);
  for (const row of orgRows) byName.set(row.name, row); // org overrides global

  return Array.from(byName.values());
}

/**
 * INSERT OR REPLACE a tool definition for a given org.
 *
 * @param {{ name, description, input_schema, executor_type, executor_config, category, orgId, installedBy }} opts
 * @returns {object} The inserted/replaced row
 */
function registerToolDef({ name, description, input_schema, executor_type = 'native', executor_config = null, category = null, orgId = '__global__', installedBy = null }) {
  if (!_db) throw new Error('[ToolStore] Not initialized — call init() first');

  const schemaStr = typeof input_schema === 'string' ? input_schema : JSON.stringify(input_schema);
  const configStr = executor_config
    ? (typeof executor_config === 'string' ? executor_config : JSON.stringify(executor_config))
    : null;

  _db.prepare(`
    INSERT OR REPLACE INTO tool_definitions
      (org_id, name, description, input_schema, executor_type, executor_config, category, installed_at, installed_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
  `).run(orgId, name, description, schemaStr, executor_type, configStr, category, installedBy);

  return _db.prepare(
    'SELECT * FROM tool_definitions WHERE org_id = ? AND name = ?'
  ).get(orgId, name);
}

/**
 * Remove an org-specific tool definition override.
 * Refuses to delete __global__ rows (returns false).
 *
 * @param {string} name
 * @param {string} orgId
 * @returns {boolean} true if a row was deleted, false otherwise
 */
function removeToolDef(name, orgId) {
  if (!_db) throw new Error('[ToolStore] Not initialized — call init() first');
  if (!orgId || orgId === '__global__') {
    console.warn(`[ToolStore] removeToolDef refused: cannot delete __global__ row for '${name}'`);
    return false;
  }
  const changes = _db.prepare(
    'DELETE FROM tool_definitions WHERE org_id = ? AND name = ?'
  ).run(orgId, name).changes;
  return changes > 0;
}

/**
 * Reseed the store from auth's tool_definitions snapshot endpoint.
 *
 * POWERS-P2.C-fix-3 Item 1 — Boot-time reseed:
 * Per CLAUDE.md ZERO TOLERANCE (Data Persistence): the in-memory
 * toolDefinitionsStore is a CACHE. Auth's tool_definitions table is the
 * SOURCE OF TRUTH. Every collector restart silently vaporises the cache;
 * this method repopulates it from auth so deployed MCP tools survive restarts.
 *
 * Idempotent: uses registerToolDef (INSERT OR REPLACE) so re-runs don't
 * duplicate rows.
 *
 * @param {object} opts
 * @param {string} opts.authUrl       - Auth service base URL
 * @param {string} opts.serviceKey    - INTERNAL_SERVICE_KEY value
 * @returns {Promise<{ reseeded: number, errors: number }>}
 */
async function reseedFromAuth({ authUrl, serviceKey } = {}) {
  if (!_db) throw new Error('[ToolStore] Not initialized — call init() first');

  const resolvedAuthUrl = authUrl || process.env.AUTH_SERVICE_URL || 'http://auth:3101';
  const resolvedKey = serviceKey || process.env.INTERNAL_SERVICE_KEY || '';

  const { assertJsonResponse } = require('./crossServiceFetch.js');

  const snapshotUrl = `${resolvedAuthUrl}/api/internal/tool-definitions/snapshot`;
  let resp;
  try {
    resp = await assertJsonResponse(
      'collector→auth snapshot',
      snapshotUrl,
      {
        method: 'GET',
        headers: resolvedKey ? { 'X-Service-Key': resolvedKey } : {},
        signal: AbortSignal.timeout(10000),
      },
      {}
    );
  } catch (err) {
    console.warn('[ToolStore] reseedFromAuth fetch failed (non-fatal):', err.message);
    throw err;
  }

  let body;
  try {
    body = await resp.json();
  } catch (err) {
    console.warn('[ToolStore] reseedFromAuth: failed to parse JSON response:', err.message);
    throw err;
  }

  const tools = body.tools || [];
  let reseeded = 0;
  let errors = 0;

  for (const tool of tools) {
    try {
      const {
        toolId, orgId, toolName, executor_type: executorType,
        executor_config_payload: executorConfigPayload,
        agent_id: agentId,
      } = tool;

      if (!toolId || !orgId || !toolName || !executorType) {
        console.warn('[ToolStore] reseedFromAuth: skipping malformed tool entry:', toolId);
        continue;
      }

      // Build description matching what the original install handler produces
      let description;
      let inputSchema;
      const MCP_WRAPPER_INPUT_SCHEMA = {
        type: 'object',
        properties: {
          tool_name: { type: 'string', description: "Name of the MCP tool to invoke" },
          arguments: { type: 'object', description: 'Arguments to pass to the MCP tool', additionalProperties: true },
        },
        required: ['tool_name', 'arguments'],
      };

      const { normalizeToolName } = require('./normalizeToolName.js');
      const { makeEmittedName, MAX_INNER_TOOLS } = require('./mcpToolNaming.js');

      const isMcp = executorType === 'mcp_endpoint' || executorType === 'mcp_hosted';
      const availableTools = isMcp ? ((executorConfigPayload && executorConfigPayload.available_tools) || []) : [];

      if (isMcp && executorType === 'mcp_endpoint') {
        const toolList = availableTools.map(t => t.name).join(', ');
        description = toolList ? `MCP endpoint: ${toolList}` : `MCP tool: ${toolName}`;
        inputSchema = MCP_WRAPPER_INPUT_SCHEMA;
      } else if (isMcp) {
        // mcp_hosted
        description = `MCP hosted: ${toolName}`;
        inputSchema = MCP_WRAPPER_INPUT_SCHEMA;
      } else {
        description = toolName;
        inputSchema = MCP_WRAPPER_INPUT_SCHEMA;
      }

      const baseRegistration = {
        description,
        input_schema: inputSchema,
        executor_type: executorType,
        executor_config: JSON.stringify(executorConfigPayload || {}),
        category: executorType,
        orgId,
        installedBy: 'boot-reseed',
      };

      // Always register under the canonical name (preserves dots for audit/log)
      registerToolDef({ ...baseRegistration, name: toolId });

      // If the canonical contains dots, ALSO register under the LLM-normalized name
      // so getToolDef(normalizedName, orgId) finds the row when LLMs emit tool_use.
      const normalizedId = normalizeToolName(toolId);
      if (normalizedId !== toolId) {
        registerToolDef({ ...baseRegistration, name: normalizedId });
      }

      // INTROSPECT-P2: If available_tools is populated, register N unfolded alias rows.
      // Each alias has executor_config._inner_name set so _buildMcp*Execute can route directly.
      // LIFECYCLE-P1-D1: Deprecated tools (have deprecated_at) are STILL registered so the
      // LLM can surface them with an error-hinting description. They are NOT filtered out.
      const DEPRECATED_DESCRIPTION_PREFIX = '[DEPRECATED — this tool was removed from the upstream MCP server; expect failures] ';
      if (isMcp && availableTools.length > 0) {
        const emitTools = availableTools.slice(0, MAX_INNER_TOOLS);
        for (const innerTool of emitTools) {
          const emittedName = makeEmittedName(toolId, innerTool.name);
          // Build alias executor_config with inner_name and base MCP connection info
          const aliasConfig = {
            ...(executorConfigPayload || {}),
            _inner_name: innerTool.name,
            _unfolded: true,
          };
          const aliasInputSchema = (innerTool.inputSchema && typeof innerTool.inputSchema === 'object')
            ? innerTool.inputSchema
            : { type: 'object', properties: {} };

          // Apply deprecated description prefix if tool has been marked as deprecated
          let aliasDescription = innerTool.description || `MCP tool: ${innerTool.name}`;
          if (innerTool.deprecated_at && !aliasDescription.startsWith('[DEPRECATED')) {
            aliasDescription = DEPRECATED_DESCRIPTION_PREFIX + aliasDescription;
          }

          registerToolDef({
            name: emittedName,
            description: aliasDescription,
            input_schema: aliasInputSchema,
            executor_type: executorType,
            executor_config: JSON.stringify(aliasConfig),
            category: executorType,
            orgId,
            installedBy: 'boot-reseed-unfolded',
          });
        }

        if (availableTools.length > MAX_INNER_TOOLS) {
          console.warn(
            '[ToolStore] reseedFromAuth: tool %s has %d available_tools; registered first %d aliases',
            toolId, availableTools.length, MAX_INNER_TOOLS
          );
        }
      }

      reseeded++;
    } catch (err) {
      console.warn('[ToolStore] reseedFromAuth: failed to register tool %s: %s', tool.toolId, err.message);
      errors++;
    }
  }

  console.log(`[ToolStore] reseedFromAuth complete: ${reseeded} reseeded, ${errors} errors`);
  return { reseeded, errors };
}

/**
 * Returns true if any tool_definitions row has executor_config.agent_id matching agentId.
 * Cross-org scan (no org filter) since agentIdResolver runs before org context resolves.
 *
 * Uses SQLite json_extract for indexable performance. Fast on typical sizes
 * (1-100 custom agents per deployment). No caching here — the SQLite query
 * is already <1ms.
 *
 * @param {string} agentId
 * @returns {boolean}
 */
function hasAgent(agentId) {
  if (!_db) return false;
  if (!agentId || typeof agentId !== 'string') return false;
  try {
    const row = _db.prepare(`
      SELECT 1 FROM tool_definitions
      WHERE json_extract(executor_config, '$.agent_id') = ?
      LIMIT 1
    `).get(agentId);
    return !!row;
  } catch (_) {
    return false;
  }
}

/**
 * Reset the store (for testing only).
 * @private
 */
function _resetForTesting() {
  if (_db) {
    try { _db.close(); } catch (_) {}
  }
  _db = null;
  _ready = false;
}

module.exports = {
  init,
  isReady,
  seedFromHardcoded,
  reseedFromAuth,
  getToolMeta,
  listToolMetas,
  registerToolDef,
  removeToolDef,
  hasAgent,
  _resetForTesting,
};
