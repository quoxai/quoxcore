/**
 * QSKL-HARDEN HRD-1 — Skill Overrides Store
 *
 * Persists per-org / per-user overrides of a small allowlist of non-behavioural
 * skill fields (description, notes, display_category, default_params) without
 * ever mutating the canonical `quox_skills` row. Keyed by skill NAME (not id)
 * so an override survives a version bump of the immutable-versioned skill.
 *
 * In-memory implementation used in tests; Postgres implementation (migration
 * 018-skill-overrides.sql) used in production. Mirrors the pattern established
 * by skill-firewall-log-store.ts.
 */

import { ulid } from 'ulid';
import type pg from 'pg';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SkillOverrideScope = 'org' | 'user';

export interface SkillOverrideRow {
  id: string;
  org_id: string;
  skill_name: string;
  scope: SkillOverrideScope;
  /** Required (non-null) when scope='user'. Always null when scope='org'. */
  user_id: string | null;
  overrides: Record<string, unknown>;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface SkillOverrideUpsertInput {
  org_id: string;
  skill_name: string;
  scope: SkillOverrideScope;
  user_id?: string | null;
  overrides: Record<string, unknown>;
  created_by: string;
}

export interface SkillOverridesStore {
  /**
   * Self-bootstrap: creates quox_skill_overrides table + indexes if they do
   * not exist. No-op for the in-memory implementation.
   */
  init(): Promise<void>;

  /**
   * Upsert (create or replace) the override row for (org_id, skill_name,
   * scope, user_id). scope='user' requires user_id; scope='org' forces
   * user_id to null regardless of what's passed.
   */
  upsert(input: SkillOverrideUpsertInput): Promise<SkillOverrideRow>;

  /**
   * Fetch both the org-scope and (if userId supplied) user-scope override
   * rows for a given skill in one call — the exact shape the merge layer
   * needs. Returns nulls for rows that don't exist.
   */
  getForMerge(params: {
    orgId: string;
    skillName: string;
    userId?: string | null;
  }): Promise<{ org: SkillOverrideRow | null; user: SkillOverrideRow | null }>;

  /** List every override row for a skill within an org (org row + all user rows). */
  listBySkill(orgId: string, skillName: string): Promise<SkillOverrideRow[]>;

  /** Delete (reset to default) a specific scope's override. No-op if absent. */
  delete(params: {
    orgId: string;
    skillName: string;
    scope: SkillOverrideScope;
    userId?: string | null;
  }): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests + in-memory server mode)
// ---------------------------------------------------------------------------

export function createInMemorySkillOverridesStore(): SkillOverridesStore {
  const rows: SkillOverrideRow[] = [];

  function findIndex(orgId: string, skillName: string, scope: SkillOverrideScope, userId: string | null): number {
    return rows.findIndex(
      r => r.org_id === orgId && r.skill_name === skillName && r.scope === scope && r.user_id === userId
    );
  }

  return {
    async init(): Promise<void> {
      // No-op: in-memory implementation needs no schema setup.
    },

    async upsert(input: SkillOverrideUpsertInput): Promise<SkillOverrideRow> {
      const userId = input.scope === 'user' ? (input.user_id ?? null) : null;
      if (input.scope === 'user' && !userId) {
        throw new Error('user_id is required when scope=\'user\'');
      }

      const now = new Date().toISOString();
      const idx = findIndex(input.org_id, input.skill_name, input.scope, userId);

      if (idx >= 0) {
        rows[idx] = {
          ...rows[idx],
          overrides: input.overrides,
          created_by: input.created_by,
          updated_at: now,
        };
        return rows[idx];
      }

      const row: SkillOverrideRow = {
        id: ulid(),
        org_id: input.org_id,
        skill_name: input.skill_name,
        scope: input.scope,
        user_id: userId,
        overrides: input.overrides,
        created_by: input.created_by,
        created_at: now,
        updated_at: now,
      };
      rows.push(row);
      return row;
    },

    async getForMerge(params): Promise<{ org: SkillOverrideRow | null; user: SkillOverrideRow | null }> {
      const orgIdx = findIndex(params.orgId, params.skillName, 'org', null);
      const org = orgIdx >= 0 ? rows[orgIdx] : null;

      let user: SkillOverrideRow | null = null;
      if (params.userId) {
        const userIdx = findIndex(params.orgId, params.skillName, 'user', params.userId);
        user = userIdx >= 0 ? rows[userIdx] : null;
      }

      return { org, user };
    },

    async listBySkill(orgId: string, skillName: string): Promise<SkillOverrideRow[]> {
      return rows.filter(r => r.org_id === orgId && r.skill_name === skillName);
    },

    async delete(params): Promise<boolean> {
      const userId = params.scope === 'user' ? (params.userId ?? null) : null;
      const idx = findIndex(params.orgId, params.skillName, params.scope, userId);
      if (idx < 0) return false;
      rows.splice(idx, 1);
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Postgres-backed implementation (production)
// ---------------------------------------------------------------------------

export function createPostgresSkillOverridesStore(pool: pg.Pool): SkillOverridesStore {
  return {
    async init(): Promise<void> {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS quox_skill_overrides (
          id            VARCHAR(26) PRIMARY KEY,
          org_id        VARCHAR(255) NOT NULL,
          skill_name    VARCHAR(255) NOT NULL,
          scope         VARCHAR(8) NOT NULL CHECK (scope IN ('org', 'user')),
          user_id       VARCHAR(255),
          overrides     JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_by    VARCHAR(255) NOT NULL,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (org_id, skill_name, scope, user_id)
        );

        CREATE INDEX IF NOT EXISTS idx_skill_overrides_lookup
          ON quox_skill_overrides (org_id, skill_name);
      `);
    },

    async upsert(input: SkillOverrideUpsertInput): Promise<SkillOverrideRow> {
      const userId = input.scope === 'user' ? (input.user_id ?? null) : null;
      if (input.scope === 'user' && !userId) {
        throw new Error('user_id is required when scope=\'user\'');
      }

      // Postgres UNIQUE treats NULL as distinct per-row (no conflict), so
      // scope='org' rows (user_id=NULL) can't rely on ON CONFLICT against the
      // composite unique constraint. Do a manual upsert instead, branching on
      // whether user_id is null.
      const existing = userId
        ? await pool.query(
            `SELECT id FROM quox_skill_overrides WHERE org_id=$1 AND skill_name=$2 AND scope=$3 AND user_id=$4`,
            [input.org_id, input.skill_name, input.scope, userId]
          )
        : await pool.query(
            `SELECT id FROM quox_skill_overrides WHERE org_id=$1 AND skill_name=$2 AND scope=$3 AND user_id IS NULL`,
            [input.org_id, input.skill_name, input.scope]
          );

      const now = new Date().toISOString();

      if (existing.rows.length > 0) {
        const id = existing.rows[0].id as string;
        await pool.query(
          `UPDATE quox_skill_overrides SET overrides=$1::jsonb, created_by=$2, updated_at=$3 WHERE id=$4`,
          [JSON.stringify(input.overrides), input.created_by, now, id]
        );
        return {
          id,
          org_id: input.org_id,
          skill_name: input.skill_name,
          scope: input.scope,
          user_id: userId,
          overrides: input.overrides,
          created_by: input.created_by,
          created_at: now,
          updated_at: now,
        };
      }

      const id = ulid();
      await pool.query(
        `INSERT INTO quox_skill_overrides (
           id, org_id, skill_name, scope, user_id, overrides, created_by, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$8)`,
        [id, input.org_id, input.skill_name, input.scope, userId, JSON.stringify(input.overrides), input.created_by, now]
      );

      return {
        id,
        org_id: input.org_id,
        skill_name: input.skill_name,
        scope: input.scope,
        user_id: userId,
        overrides: input.overrides,
        created_by: input.created_by,
        created_at: now,
        updated_at: now,
      };
    },

    async getForMerge(params): Promise<{ org: SkillOverrideRow | null; user: SkillOverrideRow | null }> {
      const orgResult = await pool.query(
        `SELECT * FROM quox_skill_overrides WHERE org_id=$1 AND skill_name=$2 AND scope='org' AND user_id IS NULL`,
        [params.orgId, params.skillName]
      );
      const org = orgResult.rows.length > 0 ? rowToRecord(orgResult.rows[0]) : null;

      let user: SkillOverrideRow | null = null;
      if (params.userId) {
        const userResult = await pool.query(
          `SELECT * FROM quox_skill_overrides WHERE org_id=$1 AND skill_name=$2 AND scope='user' AND user_id=$3`,
          [params.orgId, params.skillName, params.userId]
        );
        user = userResult.rows.length > 0 ? rowToRecord(userResult.rows[0]) : null;
      }

      return { org, user };
    },

    async listBySkill(orgId: string, skillName: string): Promise<SkillOverrideRow[]> {
      const result = await pool.query(
        `SELECT * FROM quox_skill_overrides WHERE org_id=$1 AND skill_name=$2 ORDER BY scope, user_id`,
        [orgId, skillName]
      );
      return result.rows.map(rowToRecord);
    },

    async delete(params): Promise<boolean> {
      const userId = params.scope === 'user' ? (params.userId ?? null) : null;
      const result = userId
        ? await pool.query(
            `DELETE FROM quox_skill_overrides WHERE org_id=$1 AND skill_name=$2 AND scope=$3 AND user_id=$4`,
            [params.orgId, params.skillName, params.scope, userId]
          )
        : await pool.query(
            `DELETE FROM quox_skill_overrides WHERE org_id=$1 AND skill_name=$2 AND scope=$3 AND user_id IS NULL`,
            [params.orgId, params.skillName, params.scope]
          );
      return (result.rowCount ?? 0) > 0;
    },
  };
}

function rowToRecord(row: Record<string, unknown>): SkillOverrideRow {
  return {
    id: row.id as string,
    org_id: row.org_id as string,
    skill_name: row.skill_name as string,
    scope: row.scope as SkillOverrideScope,
    user_id: (row.user_id as string | null) ?? null,
    overrides: (row.overrides as Record<string, unknown>) ?? {},
    created_by: row.created_by as string,
    created_at: row.created_at instanceof Date ? (row.created_at as Date).toISOString() : (row.created_at as string),
    updated_at: row.updated_at instanceof Date ? (row.updated_at as Date).toISOString() : (row.updated_at as string),
  };
}
