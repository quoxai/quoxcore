/**
 * REG-1: Seed core agents into the DB with governance metadata.
 *
 * Core agents live in src/config/agentRegistry.js as a static JS object.
 * Before REG, they were invisible to DB queries — you couldn't ask the
 * database "what agents exist?" because only custom (user-created) agents
 * had rows. This script fixes that by creating a DB row per core agent
 * with is_core=1 and governance defaults.
 *
 * Risk tier + data classes are assigned per-agent based on the tools they
 * use (agents with ssh_exec, proxmox_vm_action, security_audit are high-
 * risk; agents restricted to memory + search tools are low-risk).
 *
 * Run:
 *   node services/auth/scripts/seed-core-agents.js
 */

import 'dotenv/config';
import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { setAssetOwner, setAssetDataClass } from '../lib/reg.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.AUTH_DB_PATH || join(__dirname, '..', 'data', 'auth.db');
const REGISTRY_PATH = join(__dirname, '..', '..', '..', 'src', 'config', 'agentRegistry.js');

// System org for core agents — they belong to the platform, not any customer
const SYSTEM_ORG = '__system__';

/**
 * Classify risk tier based on tools the agent is allowed to use.
 */
function classifyRiskTier(agentId, agent) {
  if (agentId === 'quox') return 'high'; // orchestrator gets everything
  const tools = agent.tools || [];
  const highRiskTools = new Set([
    'ssh_exec', 'system_admin', 'proxmox_vm_action', 'docker_fleet_container_action',
    'security_audit', 'docker_extended',
  ]);
  const criticalRiskTools = new Set([
    // Reserved for future — agents with destructive cluster-level capabilities
  ]);
  if (tools.some(t => criticalRiskTools.has(t))) return 'critical';
  if (tools.some(t => highRiskTools.has(t))) return 'high';
  if (tools.length <= 5) return 'low';
  return 'standard';
}

/**
 * Derive data-class labels from agent tools.
 */
function deriveDataClasses(agentId, agent) {
  const tools = agent.tools || [];
  const classes = new Set();
  if (tools.some(t => /ssh_exec|system_admin|proxmox|docker/.test(t))) classes.add('infrastructure');
  if (tools.some(t => /security|ssl|certificates/.test(t))) classes.add('credentials');
  if (tools.some(t => /codebase_query|github|forge/.test(t))) classes.add('source_code');
  if (tools.includes('memory_save') || tools.includes('memory_search')) classes.add('internal');
  // Orchestrator touches everything
  if (agentId === 'quox') {
    classes.add('infrastructure');
    classes.add('internal');
  }
  return Array.from(classes);
}

/**
 * BLAST-RADIUS-P0: build the config_json.delegation slice for an agent row.
 *
 * canDelegateTo lives only in the static agentRegistry.js today, which makes
 * it invisible to the DB-backed internal API (GET /internal/agents) that the
 * collector's reach resolver reads. Persisting it into config_json.delegation
 * at seed time closes that gap without touching the agents table schema.
 */
function buildDelegationConfigJson(agent) {
  const canDelegateTo = Array.isArray(agent?.canDelegateTo) ? agent.canDelegateTo : [];
  return JSON.stringify({ delegation: { canDelegateTo } });
}

function ulid(prefix) {
  const t = Date.now().toString(36).padStart(9, '0');
  const r = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${t}${r}`;
}

function ensureSystemOrgAndUser(db) {
  // FK-safe bootstrap. Order matters: users first (orgs.owner_user_id FKs users),
  // then orgs. Use column introspection so this stays forward-compatible with
  // schema changes.

  const userCols = db.prepare(`PRAGMA table_info(users)`).all().map(c => c.name);
  const userExists = db.prepare(`SELECT 1 FROM users WHERE id = ?`).get('system');
  if (userCols.length > 0 && !userExists) {
    // Use whichever email column the schema provides
    const emailCol = userCols.includes('primary_email') ? 'primary_email'
                   : userCols.includes('email') ? 'email' : null;
    if (!emailCol) {
      console.warn(`  bootstrap: users table has no email column — skipping`);
    } else {
      const minimal = {
        id: 'system',
        [emailCol]: 'system@quox.local',
        display_name: 'Quox System',
        status: 'active',
      };
      const cols = Object.keys(minimal).filter(k => userCols.includes(k));
      const vals = cols.map(k => minimal[k]);
      const ph = cols.map(() => '?').join(', ');
      try {
        db.prepare(`INSERT OR IGNORE INTO users (${cols.join(', ')}) VALUES (${ph})`).run(...vals);
        console.log(`  bootstrap: created system user`);
      } catch (err) {
        console.warn(`  bootstrap: could not create system user: ${err.message}`);
      }
    }
  }

  const orgCols = db.prepare(`PRAGMA table_info(orgs)`).all().map(c => c.name);
  const orgExists = db.prepare(`SELECT 1 FROM orgs WHERE id = ?`).get(SYSTEM_ORG);
  if (orgCols.length > 0 && !orgExists) {
    const minimal = {
      id: SYSTEM_ORG,
      name: 'Quox System',
      slug: 'system',
      plan: 'enterprise',
      owner_user_id: 'system',
    };
    const cols = Object.keys(minimal).filter(k => orgCols.includes(k));
    const vals = cols.map(k => minimal[k]);
    const ph = cols.map(() => '?').join(', ');
    try {
      db.prepare(`INSERT OR IGNORE INTO orgs (${cols.join(', ')}) VALUES (${ph})`).run(...vals);
      console.log(`  bootstrap: created __system__ org`);
    } catch (err) {
      console.warn(`  bootstrap: could not create __system__ org: ${err.message}`);
    }
  }
}

async function main() {
  // Dynamic import the ESM registry
  const { agentRegistry } = await import(`file://${REGISTRY_PATH}`);
  const agents = agentRegistry.agents || {};

  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = ON');
  ensureSystemOrgAndUser(db);

  const agentIds = Object.keys(agents);
  console.log(`Seeding ${agentIds.length} core agents into DB...\n`);

  const insertAgent = db.prepare(`
    INSERT OR IGNORE INTO agents (
      id, org_id, agent_id, name,
      status, is_core, risk_tier, data_classes_json, approval_status,
      approved_by, approved_at,
      created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // If agents table has more required columns (description, level, domain,
  // parent_agent_id, home_scope_id, config_json, etc.), fall back to a
  // dynamic column-aware insert.
  const agentCols = db.prepare(`PRAGMA table_info(agents)`).all().map(c => c.name);

  function buildInsert() {
    const cols = ['id', 'org_id', 'agent_id', 'name'];
    const optional = {
      description: agentCols.includes('description'),
      level: agentCols.includes('level'),
      status: agentCols.includes('status'),
      is_core: agentCols.includes('is_core'),
      risk_tier: agentCols.includes('risk_tier'),
      data_classes_json: agentCols.includes('data_classes_json'),
      approval_status: agentCols.includes('approval_status'),
      approved_by: agentCols.includes('approved_by'),
      approved_at: agentCols.includes('approved_at'),
      created_by: agentCols.includes('created_by'),
      created_at: agentCols.includes('created_at'),
      config_json: agentCols.includes('config_json'),
    };
    for (const [k, v] of Object.entries(optional)) if (v) cols.push(k);
    const placeholders = cols.map(() => '?').join(', ');
    return {
      sql: `INSERT OR IGNORE INTO agents (${cols.join(', ')}) VALUES (${placeholders})`,
      cols,
    };
  }

  const { sql, cols } = buildInsert();
  const stmt = db.prepare(sql);
  const now = new Date().toISOString();

  let inserted = 0;
  let skipped = 0;
  const tx = db.transaction(() => {
    for (const [agentId, agent] of Object.entries(agents)) {
      const risk_tier = classifyRiskTier(agentId, agent);
      const data_classes = deriveDataClasses(agentId, agent);
      const row = {
        id: ulid('AGT'),
        org_id: SYSTEM_ORG,
        agent_id: agentId,
        name: agent.name || agentId,
        description: agent.description || null,
        level: agent.level != null ? agent.level : null,
        status: 'active',
        is_core: 1,
        risk_tier,
        data_classes_json: JSON.stringify(data_classes),
        approval_status: 'approved',
        approved_by: 'system',
        approved_at: now,
        created_by: 'system',
        created_at: now,
        config_json: buildDelegationConfigJson(agent),
      };
      const values = cols.map(c => (row[c] !== undefined ? row[c] : null));
      const result = stmt.run(...values);
      if (result.changes > 0) {
        inserted++;
        console.log(`  + ${agentId.padEnd(14)} risk=${risk_tier.padEnd(8)} classes=${JSON.stringify(data_classes)}`);
      } else {
        skipped++;
      }
    }
  });
  tx();

  // REG-4: Set platform team as primary owner for each newly inserted core agent
  let ownersSet = 0;
  const placeholders = agentIds.map(() => '?').join(',');
  const newAgents = db.prepare(
    `SELECT id, agent_id FROM agents WHERE is_core = 1 AND agent_id IN (${placeholders})`
  ).all(...agentIds);

  for (const a of newAgents) {
    try {
      setAssetOwner(db, {
        org_id: SYSTEM_ORG,
        asset_type: 'agent',
        asset_id: a.id,
        owner_type: 'system',
        owner_id: 'platform-team',
        is_primary: 1,
        role: 'owner',
        assigned_by: 'seed-core-agents',
      });
      ownersSet++;
    } catch (err) {
      if (!/UNIQUE/.test(err.message)) console.warn(`  owner ${a.agent_id}: ${err.message}`);
    }
  }

  console.log(`\nInserted ${inserted} agent(s), skipped ${skipped} already-present.`);
  console.log(`Set platform-team as owner on ${ownersSet} agent(s).`);
  db.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}

export { main, classifyRiskTier, deriveDataClasses, buildDelegationConfigJson };
