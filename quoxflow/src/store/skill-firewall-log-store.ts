/**
 * QSKL-SAFETY Slice 2 — Skill Firewall Log Store
 *
 * Persists every firewall scan result to skill_firewall_log (migration 013).
 * In-memory implementation used in tests; Postgres implementation used in production.
 */

import { ulid } from 'ulid';
import type pg from 'pg';
import type { SkillFirewallFinding } from '../security/skill_firewall.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SkillFirewallLogRow {
  id: string;
  /**
   * NULL when allow=false on a create path (no DB row was created yet).
   * Non-null for all allow=true rows and for patch/manage block rows where
   * the skill already exists.
   */
  skill_id: string | null;
  /**
   * Carries the would-be skill name for blocked create attempts where
   * skill_id is NULL. NULL for all other row types.
   */
  pending_skill_name: string | null;
  version: number;
  org_id: string | null;
  author_id: string | null;
  scanned_at: string;     // ISO timestamp
  allow: boolean;
  findings: SkillFirewallFinding[];
  reason: string | null;
  rule_set_version: number;
  /** MACHINERY: 'crystal_promotion_sweep' — task-time run-completion promotion sweep (durable-hooks.ts). */
  source: 'skill_manage' | 'api_publish' | 'api_patch' | 'patch_flow' | 'skill_view' | 'crystal_promotion_sweep';
}

export interface SkillFirewallLogInput {
  /**
   * NULL when allow=false on a create path (no DB row has been created yet).
   */
  skill_id: string | null;
  /**
   * The would-be skill name for blocked create attempts (skill_id=NULL rows).
   * Null for all other write paths.
   */
  pending_skill_name?: string | null;
  version: number;
  org_id?: string | null;
  author_id?: string | null;
  scanned_at?: string;
  allow: boolean;
  findings: SkillFirewallFinding[];
  reason?: string | null;
  rule_set_version: number;
  source: 'skill_manage' | 'api_publish' | 'api_patch' | 'patch_flow' | 'skill_view' | 'crystal_promotion_sweep';
}

export interface SkillFirewallLogStore {
  /**
   * Self-bootstrap: creates skill_firewall_log table + indexes if they do not
   * exist. No-op for the in-memory implementation.
   * Must be called at startup before any other method.
   */
  init(): Promise<void>;
  record(input: SkillFirewallLogInput): Promise<SkillFirewallLogRow>;
  /**
   * List firewall log rows for a skill, scoped to the caller's org.
   * orgId is required — callers must always supply their org context.
   * Pass undefined only on internal/admin paths (returns empty array for safety).
   */
  listBySkill(skillId: string, orgId: string): Promise<SkillFirewallLogRow[]>;
  listByOrg(orgId: string): Promise<SkillFirewallLogRow[]>;
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests + in-memory server mode)
// ---------------------------------------------------------------------------

export function createInMemorySkillFirewallLogStore(): SkillFirewallLogStore {
  const rows: SkillFirewallLogRow[] = [];

  return {
    async init(): Promise<void> {
      // No-op: in-memory implementation needs no schema setup.
    },

    async record(input: SkillFirewallLogInput): Promise<SkillFirewallLogRow> {
      const row: SkillFirewallLogRow = {
        id: ulid(),
        skill_id: input.skill_id,
        pending_skill_name: input.pending_skill_name ?? null,
        version: input.version,
        org_id: input.org_id ?? null,
        author_id: input.author_id ?? null,
        scanned_at: input.scanned_at ?? new Date().toISOString(),
        allow: input.allow,
        findings: input.findings,
        reason: input.reason ?? null,
        rule_set_version: input.rule_set_version,
        source: input.source,
      };
      rows.push(row);
      return row;
    },

    async listBySkill(skillId: string, orgId: string): Promise<SkillFirewallLogRow[]> {
      return rows
        .filter(r => r.skill_id === skillId && r.org_id === orgId)
        .sort((a, b) => b.scanned_at.localeCompare(a.scanned_at));
    },

    async listByOrg(orgId: string): Promise<SkillFirewallLogRow[]> {
      return rows
        .filter(r => r.org_id === orgId)
        .sort((a, b) => b.scanned_at.localeCompare(a.scanned_at));
    },
  };
}

// ---------------------------------------------------------------------------
// Postgres-backed implementation (production)
// ---------------------------------------------------------------------------

/**
 * createPostgresSkillFirewallLogStore — QSKL-SAFETY Fix3
 *
 * Durable store that writes to the skill_firewall_log table created by
 * migration 013-skill-firewall-log.sql.
 *
 * Pool injection pattern mirrors QuoxSkillInvocationsStore and
 * PostgresSessionSearchStore: the caller owns the pool lifecycle.
 */
export function createPostgresSkillFirewallLogStore(pool: pg.Pool): SkillFirewallLogStore {
  return {
    async init(): Promise<void> {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS skill_firewall_log (
          id                  TEXT PRIMARY KEY,
          skill_id            TEXT,
          pending_skill_name  TEXT,
          version             INTEGER NOT NULL,
          org_id              TEXT,
          author_id           TEXT,
          scanned_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          allow               BOOLEAN NOT NULL,
          findings            JSONB NOT NULL DEFAULT '[]'::jsonb,
          reason              TEXT,
          rule_set_version    INTEGER NOT NULL,
          source              TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_skill_firewall_log_skill
          ON skill_firewall_log (skill_id, scanned_at DESC);

        CREATE INDEX IF NOT EXISTS idx_skill_firewall_log_org
          ON skill_firewall_log (org_id, scanned_at DESC);

        CREATE INDEX IF NOT EXISTS idx_skill_firewall_log_allow
          ON skill_firewall_log (allow, scanned_at DESC);
      `);
    },

    async record(input: SkillFirewallLogInput): Promise<SkillFirewallLogRow> {
      const id = ulid();
      const scanned_at = input.scanned_at ?? new Date().toISOString();

      await pool.query(
        `INSERT INTO skill_firewall_log (
           id, skill_id, pending_skill_name, version, org_id, author_id,
           scanned_at, allow, findings, reason, rule_set_version, source
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)`,
        [
          id,
          input.skill_id,
          input.pending_skill_name ?? null,
          input.version,
          input.org_id ?? null,
          input.author_id ?? null,
          scanned_at,
          input.allow,
          JSON.stringify(input.findings),
          input.reason ?? null,
          input.rule_set_version,
          input.source,
        ]
      );

      return {
        id,
        skill_id: input.skill_id,
        pending_skill_name: input.pending_skill_name ?? null,
        version: input.version,
        org_id: input.org_id ?? null,
        author_id: input.author_id ?? null,
        scanned_at,
        allow: input.allow,
        findings: input.findings,
        reason: input.reason ?? null,
        rule_set_version: input.rule_set_version,
        source: input.source,
      };
    },

    async listBySkill(skillId: string, orgId: string): Promise<SkillFirewallLogRow[]> {
      const result = await pool.query(
        `SELECT id, skill_id, pending_skill_name, version, org_id, author_id,
                scanned_at, allow, findings, reason, rule_set_version, source
           FROM skill_firewall_log
          WHERE skill_id = $1 AND org_id = $2
          ORDER BY scanned_at DESC`,
        [skillId, orgId]
      );
      return result.rows.map(rowToRecord);
    },

    async listByOrg(orgId: string): Promise<SkillFirewallLogRow[]> {
      const result = await pool.query(
        `SELECT id, skill_id, pending_skill_name, version, org_id, author_id,
                scanned_at, allow, findings, reason, rule_set_version, source
           FROM skill_firewall_log
          WHERE org_id = $1
          ORDER BY scanned_at DESC`,
        [orgId]
      );
      return result.rows.map(rowToRecord);
    },
  };
}

function rowToRecord(row: Record<string, unknown>): SkillFirewallLogRow {
  return {
    id: row.id as string,
    skill_id: (row.skill_id as string | null) ?? null,
    pending_skill_name: (row.pending_skill_name as string | null) ?? null,
    version: Number(row.version),
    org_id: (row.org_id as string | null) ?? null,
    author_id: (row.author_id as string | null) ?? null,
    scanned_at: row.scanned_at instanceof Date
      ? (row.scanned_at as Date).toISOString()
      : (row.scanned_at as string),
    allow: Boolean(row.allow),
    findings: (row.findings as SkillFirewallFinding[]) ?? [],
    reason: (row.reason as string | null) ?? null,
    rule_set_version: Number(row.rule_set_version),
    source: row.source as SkillFirewallLogRow['source'],
  };
}
