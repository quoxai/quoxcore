/**
 * LIFECYCLE-P1-D1 — Powers Available-Tools Drift Library
 *
 * Provides:
 *  - computeToolListHash()        — sha256 fingerprint for loop-detect
 *  - applyAvailableToolsDrift()   — merge new tool list into DB; mark deprecated / re-appeared
 *  - dropExpiredDeprecations()    — D3 TTL cron: drop entries deprecated >30 days
 *  - prefixDeprecatedDescription() — utility for LLM-serve and collector reseed
 *
 * All functions are pure-ish (side-effects scoped to the passed DB) — easy to unit-test.
 */

import { createHash } from 'crypto';
import { getDb } from '../db/index.js';
import { ulid } from '../utils/helpers.js';

const DEPRECATED_PREFIX = '[DEPRECATED — this tool was removed from the upstream MCP server; expect failures] ';
const DEPRECATION_TTL_DAYS = 30;

// ─── Hash ──────────────────────────────────────────────────────────────────────

/**
 * Compute a sha256 fingerprint of a tool list for loop-detect.
 * Sorts by name before hashing so order doesn't matter.
 *
 * @param {Array<{name: string, description?: string}>} tools
 * @returns {string} hex sha256
 */
export function computeToolListHash(tools) {
  if (!Array.isArray(tools)) return '';
  const sorted = [...tools].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const material = sorted.map(t => `${t.name}::${t.description || ''}`).join('\n');
  return createHash('sha256').update(material).digest('hex');
}

// ─── Description prefix ────────────────────────────────────────────────────────

/**
 * Prefix a tool description with the deprecation warning.
 * Idempotent — won't double-prefix.
 *
 * @param {string} description
 * @returns {string}
 */
export function prefixDeprecatedDescription(description) {
  if (!description) return DEPRECATED_PREFIX.trimEnd();
  if (description.startsWith('[DEPRECATED')) return description;
  return DEPRECATED_PREFIX + description;
}

// ─── Audit helper (non-fatal) ─────────────────────────────────────────────────

function writeAuditEvent(db, { action, targetId, metadata }) {
  try {
    const id = ulid();
    // org_id is nullable in audit_events schema; use null for system-level events
    // (avoids FK constraint failure since '__system__' is not a real org row)
    db.prepare(`
      INSERT INTO audit_events (id, org_id, actor_type, actor_id, action, target_type, target_id, status, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      null,
      'service',
      'powers-lifecycle',
      action,
      'tool_installation',
      targetId || null,
      'success',
      JSON.stringify(metadata || {}),
      new Date().toISOString()
    );
  } catch (err) {
    // Audit failure is always non-fatal
    console.warn('[LIFECYCLE-P1] audit write failed: %s', err.message);
  }
}

// ─── Core drift merge ──────────────────────────────────────────────────────────

/**
 * Merge a fresh tool list from a re-probe into tool_installations.config_json.
 *
 * Rules:
 *  - New tool (in fresh but not in current): append with no deprecated_at.
 *  - Removed tool (in current but not in fresh): add deprecated_at timestamp.
 *  - Same tool (in both): preserve as-is. If it was previously deprecated + now
 *    re-appeared, clear deprecated_at and emit tool_reappeared audit event.
 *  - Byte-identical tool list (by sha256 of name+description): no-op.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} toolDefId - tool_definitions.id ULID
 * @param {Array<{name: string, description?: string, inputSchema?: object}>} freshTools
 * @returns {{ ok: boolean, added?: number, deprecated?: number, unchanged_count?: number,
 *             reappeared?: number, total?: number, no_change?: boolean, status?: number }}
 */
export function applyAvailableToolsDrift(db, toolDefId, freshTools) {
  if (!db || !toolDefId || !Array.isArray(freshTools)) {
    return { ok: false, status: 400, error: 'invalid_args' };
  }

  // Find the installation row
  const row = db.prepare(`
    SELECT ti.id, ti.config_json
    FROM tool_installations ti
    WHERE ti.tool_definition_id = ?
    ORDER BY ti.installed_at DESC
    LIMIT 1
  `).get(toolDefId);

  if (!row) {
    return { ok: false, status: 404, error: 'installation_not_found' };
  }

  let config = {};
  try { config = JSON.parse(row.config_json || '{}'); } catch (_) {}

  const currentTools = Array.isArray(config.available_tools) ? config.available_tools : [];

  // Loop-detect: compare hash of fresh tools vs current (non-deprecated) tools
  const currentActive = currentTools.filter(t => !t.deprecated_at);
  const currentHash = computeToolListHash(currentActive);
  const freshHash = computeToolListHash(freshTools);

  if (currentHash === freshHash && currentTools.length === currentActive.length) {
    // Byte-identical AND no currently-deprecated entries to handle — pure no-op
    return { ok: true, no_change: true };
  }

  const now = new Date().toISOString();
  const freshNames = new Set(freshTools.map(t => t.name));
  const currentByName = new Map(currentTools.map(t => [t.name, t]));

  let added = 0;
  let deprecated = 0;
  let unchanged = 0;
  let reappeared = 0;
  const addedNames = [];
  const deprecatedNames = [];

  const merged = [];

  // Process current tools (determine deprecated / re-appeared / same)
  for (const cur of currentTools) {
    if (freshNames.has(cur.name)) {
      if (cur.deprecated_at) {
        // Re-appeared — clear deprecated_at
        merged.push({ ...cur, deprecated_at: undefined });
        // Remove the undefined key
        delete merged[merged.length - 1].deprecated_at;
        reappeared++;
      } else {
        // Same — update description from fresh in case it changed
        const fresh = freshTools.find(t => t.name === cur.name);
        merged.push({ ...cur, description: fresh?.description ?? cur.description });
        unchanged++;
      }
    } else {
      // Removed from fresh — deprecate
      if (!cur.deprecated_at) {
        merged.push({ ...cur, deprecated_at: now });
        deprecated++;
        deprecatedNames.push(cur.name);
      } else {
        // Already deprecated — keep as-is
        merged.push(cur);
      }
    }
  }

  // Process fresh tools (add new ones not in current)
  for (const fresh of freshTools) {
    if (!currentByName.has(fresh.name)) {
      merged.push({ name: fresh.name, description: fresh.description, inputSchema: fresh.inputSchema });
      added++;
      addedNames.push(fresh.name);
    }
  }

  config.available_tools = merged;
  config.available_tools_last_probed_at = now;

  db.prepare('UPDATE tool_installations SET config_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(config), now, row.id);

  // Audit: drift detected
  if (added > 0 || deprecated > 0) {
    writeAuditEvent(db, {
      action: 'directory.power.tools_drift_detected',
      targetId: row.id,
      metadata: {
        tool_def_id: toolDefId,
        added: addedNames,
        deprecated: deprecatedNames,
        unchanged_count: unchanged,
      },
    });
  }

  // Audit: tool re-appeared
  if (reappeared > 0) {
    writeAuditEvent(db, {
      action: 'directory.power.tool_reappeared',
      targetId: row.id,
      metadata: {
        tool_def_id: toolDefId,
        reappeared_count: reappeared,
      },
    });
  }

  return {
    ok: true,
    added,
    deprecated,
    unchanged_count: unchanged,
    reappeared,
    total: merged.length,
  };
}

// ─── D3: Deprecation TTL cron ─────────────────────────────────────────────────

/**
 * Drop tool_installations.config_json.available_tools entries that have been
 * deprecated for more than DEPRECATION_TTL_DAYS.
 *
 * Intended to run once daily. Scans all tool_installations rows that have
 * mcp_hosted or mcp_endpoint executor_type.
 *
 * @param {import('better-sqlite3').Database} [db]
 * @returns {{ dropped: number, installations_scanned: number }}
 */
export function dropExpiredDeprecations(db) {
  const database = db || getDb();
  const cutoff = new Date(Date.now() - DEPRECATION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  let dropped = 0;
  let scanned = 0;

  // Only scan installations that have any available_tools in config_json
  const rows = database.prepare(`
    SELECT id, config_json FROM tool_installations
    WHERE enabled = 1 AND config_json LIKE '%available_tools%'
  `).all();

  for (const row of rows) {
    let config = {};
    try { config = JSON.parse(row.config_json || '{}'); } catch (_) { continue; }

    if (!Array.isArray(config.available_tools) || config.available_tools.length === 0) continue;

    scanned++;

    const before = config.available_tools.length;
    config.available_tools = config.available_tools.filter(t => {
      if (!t.deprecated_at) return true;
      // Keep if deprecated_at is within TTL
      return t.deprecated_at > cutoff;
    });
    const after = config.available_tools.length;
    const removedCount = before - after;

    if (removedCount > 0) {
      database.prepare('UPDATE tool_installations SET config_json = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(config), new Date().toISOString(), row.id);
      dropped += removedCount;
    }
  }

  if (dropped > 0) {
    console.log('[LIFECYCLE-P1-D3] dropExpiredDeprecations: dropped %d expired entries across %d installations', dropped, scanned);
  }

  return { dropped, installations_scanned: scanned };
}
