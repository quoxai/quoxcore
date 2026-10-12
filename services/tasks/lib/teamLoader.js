// Team Loader — loads, validates, and manages team definitions in the task service DB
import { getDatabase } from '../db/index.js';
import { randomUUID } from 'crypto';

const REQUIRED_MANIFEST_FIELDS = ['id', 'type', 'version', 'displayName', 'orchestrator', 'members', 'policies'];

export function validateTeamManifest(manifest) {
  const errors = [];
  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (!manifest[field]) errors.push(`Missing required field: ${field}`);
  }
  if (manifest.type !== 'team') errors.push(`Invalid type: ${manifest.type}`);
  if (!manifest.orchestrator?.agentId) errors.push('Missing orchestrator.agentId');
  if (!Array.isArray(manifest.members) || manifest.members.length === 0) {
    errors.push('Members must be a non-empty array');
  }
  for (const member of manifest.members || []) {
    if (!member.agentId) errors.push('Member missing agentId');
    if (!member.role) errors.push(`Member ${member.agentId || '?'} missing role`);
  }

  // AT-1: Topology validation (optional field, defaults to star)
  const VALID_TOPOLOGIES = ['star', 'hierarchical', 'pipeline', 'mesh']
  if (manifest.topology) {
    if (!manifest.topology.type || !VALID_TOPOLOGIES.includes(manifest.topology.type)) {
      errors.push(`Invalid topology type: ${manifest.topology?.type}. Must be one of: ${VALID_TOPOLOGIES.join(', ')}`)
    }
    // Hierarchical: sub-orchestrators must be in members list
    if (manifest.topology.type === 'hierarchical' && manifest.topology.subOrchestrators) {
      const memberIds = (manifest.members || []).map(m => m.agentId)
      for (const subOrch of manifest.topology.subOrchestrators) {
        if (!memberIds.includes(subOrch)) {
          errors.push(`Sub-orchestrator '${subOrch}' is not in the members list`)
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function installTeam(orgId, manifest, installedBy = null, source = null) {
  const db = getDatabase();
  const { valid, errors } = validateTeamManifest(manifest);
  if (!valid) {
    throw new Error(`Invalid team manifest: ${errors.join(', ')}`);
  }

  const effectiveSource = source || (manifest.tier === 'free' ? 'core' : 'marketplace');

  // Check if already installed for this org
  const existing = db.prepare('SELECT id FROM team_definitions WHERE id = ? AND org_id = ?').get(manifest.id, orgId);
  if (existing) {
    // Update existing
    db.prepare(
      'UPDATE team_definitions SET manifest_json = ?, status = ?, installed_by = ?, source = ? WHERE id = ? AND org_id = ?'
    ).run(JSON.stringify(manifest), 'active', installedBy, effectiveSource, manifest.id, orgId);
    return { id: manifest.id, action: 'updated' };
  }

  db.prepare(
    'INSERT INTO team_definitions (id, org_id, manifest_json, source, status, installed_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(manifest.id, orgId, JSON.stringify(manifest), effectiveSource, 'active', installedBy);

  return { id: manifest.id, action: 'installed' };
}

export function uninstallTeam(orgId, teamId) {
  const db = getDatabase();
  const result = db.prepare('UPDATE team_definitions SET status = ? WHERE id = ? AND org_id = ?').run('archived', teamId, orgId);
  // S7: Disable all schedules for this team to prevent phantom triggers
  if (result.changes > 0) {
    db.prepare("UPDATE team_schedules SET enabled = 0, updated_at = datetime('now') WHERE team_definition_id = ? AND org_id = ?").run(teamId, orgId);
  }
  return result.changes > 0;
}

export function getTeamDefinition(orgId, teamId) {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM team_definitions WHERE id = ? AND org_id = ? AND status = ?').get(teamId, orgId, 'active');
  if (!row) return null;
  return {
    ...row,
    manifest: JSON.parse(row.manifest_json),
  };
}

export function listTeamDefinitions(orgId) {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM team_definitions WHERE org_id = ? AND status = ? ORDER BY installed_at DESC').all(orgId, 'active');
  return rows.map(row => ({
    ...row,
    manifest: JSON.parse(row.manifest_json),
  }));
}

export function createTeamInstance(teamDefinitionId, orgId, userId) {
  const db = getDatabase();
  const id = randomUUID();
  db.prepare(
    'INSERT INTO team_instances (id, team_definition_id, org_id, user_id, status) VALUES (?, ?, ?, ?, ?)'
  ).run(id, teamDefinitionId, orgId, userId, 'idle');
  return id;
}

export function getTeamInstance(instanceId) {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM team_instances WHERE id = ?').get(instanceId);
  if (!row) return null;
  return {
    ...row,
    shared_context: JSON.parse(row.shared_context_json || '{}'),
  };
}

export function updateTeamInstanceStatus(instanceId, status, objectiveId = null) {
  const db = getDatabase();
  const updates = ['status = ?', "updated_at = datetime('now')"];
  const params = [status];
  if (objectiveId !== undefined) {
    updates.push('current_objective_id = ?');
    params.push(objectiveId);
  }
  params.push(instanceId);
  db.prepare(`UPDATE team_instances SET ${updates.join(', ')} WHERE id = ?`).run(...params);
}

export function updateTeamContext(instanceId, key, value) {
  const db = getDatabase();
  // OE-4: Atomic update using json_set — prevents read-modify-write race condition
  try {
    const result = db.prepare(`
      UPDATE team_instances
      SET shared_context_json = json_set(COALESCE(shared_context_json, '{}'), '$.' || ?, json(?)),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(key, JSON.stringify(value), instanceId);
    return result.changes > 0;
  } catch (e) {
    // Fallback for older SQLite without json_set — only catch json_set errors
    if (!e.message || !e.message.includes('json_set')) throw e
    const row = db.prepare('SELECT shared_context_json FROM team_instances WHERE id = ?').get(instanceId);
    if (!row) return false;
    const ctx = JSON.parse(row.shared_context_json || '{}');
    ctx[key] = value;
    db.prepare("UPDATE team_instances SET shared_context_json = ?, updated_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(ctx), instanceId);
    return true;
  }
}

export function getTeamContext(instanceId) {
  const db = getDatabase();
  const row = db.prepare('SELECT shared_context_json FROM team_instances WHERE id = ?').get(instanceId);
  if (!row) return null;
  return JSON.parse(row.shared_context_json || '{}');
}

// MACHINERY-4a: cap on the number of task-completion summaries kept in a
// team instance's shared_context_json.task_history array. Bounds context
// growth for long-running / high-iteration teams — older entries roll off
// as new ones are appended. Chosen as a sane default that keeps a full
// recent-history window (star/pipeline/mesh teams rarely exceed a handful
// of tasks per round) without letting the JSON blob grow unboundedly across
// many re-observe iterations.
export const MAX_TEAM_TASK_HISTORY = 20;

/**
 * Append a compact task-completion summary to a team instance's shared
 * context, bounding the history to the most recent `maxEntries` entries.
 * Built on top of the existing getTeamContext/updateTeamContext helpers
 * (read-modify-write under the `task_history` key) rather than a new raw
 * SQL path.
 *
 * @param {string} instanceId
 * @param {{task_id: string, role: string, status: string, result_summary: string, completed_at: string}} summary
 * @param {number} [maxEntries]
 * @returns {boolean} true if the instance was found and updated
 */
export function appendTaskSummary(instanceId, summary, maxEntries = MAX_TEAM_TASK_HISTORY) {
  const ctx = getTeamContext(instanceId);
  if (!ctx) return false;
  const history = Array.isArray(ctx.task_history) ? ctx.task_history : [];
  history.push(summary);
  const bounded = history.length > maxEntries ? history.slice(history.length - maxEntries) : history;
  return updateTeamContext(instanceId, 'task_history', bounded);
}

/**
 * MACHINERY-4a — format a team instance's task_history (as written by
 * appendTaskSummary) into a prompt-ready block. Used at dispatch time so
 * subsequent member task prompts actually receive prior teammates'
 * completion summaries instead of the shared context sitting unread.
 *
 * @param {Array} history - task_history entries from getTeamContext()
 * @returns {string} block to append to a task prompt, or '' when empty
 */
export function buildTeamContextBlock(history) {
  if (!Array.isArray(history) || history.length === 0) return '';
  const lines = history.map(entry =>
    `- [${entry.completed_at || 'unknown time'}] ${entry.role || 'unknown'} (${entry.status || 'unknown'}) — task ${entry.task_id || '?'}: ${entry.result_summary || ''}`
  );
  return `\n\n## Shared team context (prior task outcomes)\n\n${lines.join('\n')}`;
}

/**
 * Clean up old team instances, keeping the most recent N per team per org.
 * Instances with status 'active' or 'running' are never removed.
 * @param {number} keepPerTeam - Number of instances to keep per team (default 5)
 * @returns {number} Number of instances cleaned up
 */
export function cleanupOldInstances(keepPerTeam = 5) {
  const db = getDatabase();
  // Find team/org combos with more than keepPerTeam instances
  const groups = db.prepare(`
    SELECT team_definition_id, org_id, COUNT(*) as cnt
    FROM team_instances
    GROUP BY team_definition_id, org_id
    HAVING cnt > ?
  `).all(keepPerTeam);

  let cleaned = 0;
  for (const g of groups) {
    // Get IDs to keep (most recent N, plus any active/running)
    const keep = db.prepare(`
      SELECT id FROM team_instances
      WHERE team_definition_id = ? AND org_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(g.team_definition_id, g.org_id, keepPerTeam).map(r => r.id);

    // AC-0: Delete related records first to avoid FK constraint failures,
    // then delete the stale team instances
    const staleIds = db.prepare(`
      SELECT id FROM team_instances
      WHERE team_definition_id = ? AND org_id = ?
        AND id NOT IN (${keep.map(() => '?').join(',')})
        AND status NOT IN ('active', 'running')
    `).all(g.team_definition_id, g.org_id, ...keep).map(r => r.id);

    if (staleIds.length === 0) continue;

    // Clear FK references before deleting
    const placeholders = staleIds.map(() => '?').join(',');
    db.prepare(`
      UPDATE team_instances SET current_objective_id = NULL
      WHERE id IN (${placeholders})
    `).run(...staleIds);
    db.prepare(`
      UPDATE objectives SET team_instance_id = NULL
      WHERE team_instance_id IN (${placeholders})
    `).run(...staleIds);

    const result = db.prepare(`
      DELETE FROM team_instances
      WHERE id IN (${placeholders})
    `).run(...staleIds);

    cleaned += result.changes;
  }
  return cleaned;
}
