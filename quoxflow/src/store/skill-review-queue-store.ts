/**
 * QSKL-SAFETY.E — Skill Review Queue Store
 *
 * Persists skill safety-review queue rows to skill_review_queue (migration 014).
 * In-memory implementation used in tests; Postgres implementation used in production.
 *
 * Idempotency: insert() returns null (no-op) when a row already exists for
 * the same (skill_id, version) pair — mirrors the ON CONFLICT DO NOTHING
 * behaviour of the Postgres implementation.
 */

import { ulid } from 'ulid';
import type pg from 'pg';
import { SYSTEM_SCOPE, SystemScope } from '../api/middleware/org-scope.js';

/**
 * QF-MT WP7: org scope accepted by listPending/listByStatus/getById — string
 * org id, or the explicit cross-org SYSTEM_SCOPE sentinel. Previously these
 * took `orgId?: string`, so the org filter was silently skippable by simply
 * not passing it (the admin-path call sites in quox-skills.ts already fetch
 * unscoped-then-403-manually — those now pass SYSTEM_SCOPE explicitly instead
 * of omitting the argument). The route-level 403-on-mismatch semantics in
 * quox-skills.ts are unchanged (plan §4: don't churn working code).
 */
export type SkillReviewQueueOrgScope = string | SystemScope;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SkillReviewQueueRow {
  id: string;
  skill_id: string;
  version: string;
  org_id: string | null;
  status: 'pending' | 'approved' | 'rejected';
  queued_at: string;           // ISO timestamp
  judge_run_id: string | null;
  findings: unknown[];
  rubric_scores: Record<string, unknown> | null;
  rubric_version: number;
  cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  reviewer_id: string | null;
  decision_at: string | null;  // ISO timestamp
  comment: string | null;
}

export interface SkillReviewQueueInsertInput {
  skill_id: string;
  version: string;
  org_id?: string | null;
  judge_run_id?: string | null;
  findings: unknown[];
  rubric_scores: Record<string, unknown> | null;
  rubric_version: number;
  cost_usd?: number | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
}

export interface SkillReviewDecisionInput {
  id: string;
  status: 'approved' | 'rejected';
  reviewer_id?: string | null;
  comment?: string | null;
}

export interface SkillReviewQueueStore {
  /**
   * Self-bootstrap: creates skill_review_queue table + indexes if they do not
   * exist. No-op for the in-memory implementation.
   * Must be called at startup before any other method.
   */
  init(): Promise<void>;

  /**
   * Insert a new review queue row.
   * Returns the inserted row, or null if a row already exists for (skill_id, version)
   * — ON CONFLICT DO NOTHING semantics.
   */
  insert(input: SkillReviewQueueInsertInput): Promise<SkillReviewQueueRow | null>;

  /**
   * Find a pending row for the given skill_id and version.
   * Returns null when no pending row exists.
   */
  findPendingBySkill(skillId: string, version: string): Promise<SkillReviewQueueRow | null>;

  /**
   * List all pending rows. Pass SYSTEM_SCOPE explicitly for the cross-org
   * admin path — omission is no longer possible (QF-MT WP7).
   */
  listPending(scope: SkillReviewQueueOrgScope): Promise<SkillReviewQueueRow[]>;

  /**
   * List rows by status, scoped to an org or explicit SYSTEM_SCOPE.
   * QSKL-SAFETY.F: used by the review-queue API routes to support ?status=pending|approved|rejected.
   */
  listByStatus(status: 'pending' | 'approved' | 'rejected', scope: SkillReviewQueueOrgScope): Promise<SkillReviewQueueRow[]>;

  /**
   * Update the status of a review row to approved or rejected.
   * Sets reviewer_id, comment, and decision_at.
   */
  markDecision(input: SkillReviewDecisionInput): Promise<void>;

  /**
   * Fetch a row by its primary key id.
   * When scope is a real org, returns null if the row's org_id does not match
   * (org-scoped). Pass SYSTEM_SCOPE explicitly for the internal/admin path
   * that returns the row regardless of org (QF-MT WP7 — no longer an
   * omittable param).
   */
  getById(id: string, scope: SkillReviewQueueOrgScope): Promise<SkillReviewQueueRow | null>;

  /**
   * Find any active (pending or rejected) row for the given skill_id.
   * Used by the promotion gate to block experimental→stable.
   */
  findActiveBySkill(skillId: string): Promise<SkillReviewQueueRow | null>;
}

// ---------------------------------------------------------------------------
// In-memory implementation (tests + in-memory server mode)
// ---------------------------------------------------------------------------

export function createInMemorySkillReviewQueueStore(): SkillReviewQueueStore {
  const rows: SkillReviewQueueRow[] = [];

  return {
    async init(): Promise<void> {
      // No-op: in-memory implementation needs no schema setup.
    },

    async insert(input: SkillReviewQueueInsertInput): Promise<SkillReviewQueueRow | null> {
      // Idempotency: return null if a row already exists for (skill_id, version)
      const existing = rows.find(
        r => r.skill_id === input.skill_id && r.version === input.version
      );
      if (existing) return null;

      const row: SkillReviewQueueRow = {
        id: ulid(),
        skill_id: input.skill_id,
        version: input.version,
        org_id: input.org_id ?? null,
        status: 'pending',
        queued_at: new Date().toISOString(),
        judge_run_id: input.judge_run_id ?? null,
        findings: input.findings,
        rubric_scores: input.rubric_scores,
        rubric_version: input.rubric_version,
        cost_usd: input.cost_usd ?? null,
        tokens_in: input.tokens_in ?? null,
        tokens_out: input.tokens_out ?? null,
        reviewer_id: null,
        decision_at: null,
        comment: null,
      };
      rows.push(row);
      return row;
    },

    async findPendingBySkill(
      skillId: string,
      version: string
    ): Promise<SkillReviewQueueRow | null> {
      return (
        rows.find(
          r => r.skill_id === skillId && r.version === version && r.status === 'pending'
        ) ?? null
      );
    },

    async listPending(scope: SkillReviewQueueOrgScope): Promise<SkillReviewQueueRow[]> {
      return rows
        .filter(r => r.status === 'pending' && (scope === SYSTEM_SCOPE || r.org_id === scope))
        .sort((a, b) => a.queued_at.localeCompare(b.queued_at));
    },

    async listByStatus(
      status: 'pending' | 'approved' | 'rejected',
      scope: SkillReviewQueueOrgScope
    ): Promise<SkillReviewQueueRow[]> {
      return rows
        .filter(r => r.status === status && (scope === SYSTEM_SCOPE || r.org_id === scope))
        .sort((a, b) => a.queued_at.localeCompare(b.queued_at));
    },

    async markDecision(input: SkillReviewDecisionInput): Promise<void> {
      const row = rows.find(r => r.id === input.id);
      if (!row) return;
      row.status = input.status;
      row.reviewer_id = input.reviewer_id ?? null;
      row.comment = input.comment ?? null;
      row.decision_at = new Date().toISOString();
    },

    async getById(id: string, scope: SkillReviewQueueOrgScope): Promise<SkillReviewQueueRow | null> {
      const row = rows.find(r => r.id === id) ?? null;
      if (!row) return null;
      if (scope !== SYSTEM_SCOPE && row.org_id !== null && row.org_id !== scope) return null;
      return row;
    },

    async findActiveBySkill(skillId: string): Promise<SkillReviewQueueRow | null> {
      return (
        rows.find(
          r => r.skill_id === skillId && (r.status === 'pending' || r.status === 'rejected')
        ) ?? null
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Postgres-backed implementation (production)
// ---------------------------------------------------------------------------

export function createPostgresSkillReviewQueueStore(pool: pg.Pool): SkillReviewQueueStore {
  return {
    async init(): Promise<void> {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS skill_review_queue (
          id              TEXT PRIMARY KEY,
          skill_id        TEXT NOT NULL,
          version         TEXT NOT NULL,
          org_id          TEXT,
          status          TEXT NOT NULL DEFAULT 'pending',
          queued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          judge_run_id    TEXT,
          findings        JSONB NOT NULL DEFAULT '[]'::jsonb,
          rubric_scores   JSONB,
          rubric_version  INTEGER NOT NULL DEFAULT 1,
          cost_usd        NUMERIC,
          tokens_in       INTEGER,
          tokens_out      INTEGER,
          reviewer_id     TEXT,
          decision_at     TIMESTAMPTZ,
          comment         TEXT,
          UNIQUE(skill_id, version)
        );

        CREATE INDEX IF NOT EXISTS idx_skill_review_queue_status_queued
          ON skill_review_queue (status, queued_at);

        CREATE INDEX IF NOT EXISTS idx_skill_review_queue_org_status
          ON skill_review_queue (org_id, status);

        CREATE INDEX IF NOT EXISTS idx_skill_review_queue_skill_queued
          ON skill_review_queue (skill_id, queued_at DESC);
      `);
    },

    async insert(input: SkillReviewQueueInsertInput): Promise<SkillReviewQueueRow | null> {
      const id = ulid();
      const queued_at = new Date().toISOString();

      const result = await pool.query(
        `INSERT INTO skill_review_queue (
           id, skill_id, version, org_id, status, queued_at,
           judge_run_id, findings, rubric_scores, rubric_version,
           cost_usd, tokens_in, tokens_out
         ) VALUES ($1,$2,$3,$4,'pending',$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12)
         ON CONFLICT (skill_id, version) DO NOTHING
         RETURNING *`,
        [
          id,
          input.skill_id,
          input.version,
          input.org_id ?? null,
          queued_at,
          input.judge_run_id ?? null,
          JSON.stringify(input.findings),
          input.rubric_scores ? JSON.stringify(input.rubric_scores) : null,
          input.rubric_version,
          input.cost_usd ?? null,
          input.tokens_in ?? null,
          input.tokens_out ?? null,
        ]
      );

      if (result.rows.length === 0) return null; // ON CONFLICT hit
      return rowToRecord(result.rows[0]);
    },

    async findPendingBySkill(
      skillId: string,
      version: string
    ): Promise<SkillReviewQueueRow | null> {
      const result = await pool.query(
        `SELECT * FROM skill_review_queue
          WHERE skill_id = $1 AND version = $2 AND status = 'pending'
          LIMIT 1`,
        [skillId, version]
      );
      return result.rows.length > 0 ? rowToRecord(result.rows[0]) : null;
    },

    async listPending(scope: SkillReviewQueueOrgScope): Promise<SkillReviewQueueRow[]> {
      if (scope !== SYSTEM_SCOPE) {
        const result = await pool.query(
          `SELECT * FROM skill_review_queue
            WHERE status = 'pending' AND org_id = $1
            ORDER BY queued_at ASC`,
          [scope]
        );
        return result.rows.map(rowToRecord);
      }
      const result = await pool.query(
        `SELECT * FROM skill_review_queue
          WHERE status = 'pending'
          ORDER BY queued_at ASC`
      );
      return result.rows.map(rowToRecord);
    },

    async listByStatus(
      status: 'pending' | 'approved' | 'rejected',
      scope: SkillReviewQueueOrgScope
    ): Promise<SkillReviewQueueRow[]> {
      if (scope !== SYSTEM_SCOPE) {
        const result = await pool.query(
          `SELECT * FROM skill_review_queue
            WHERE status = $1 AND org_id = $2
            ORDER BY queued_at ASC`,
          [status, scope]
        );
        return result.rows.map(rowToRecord);
      }
      const result = await pool.query(
        `SELECT * FROM skill_review_queue
          WHERE status = $1
          ORDER BY queued_at ASC`,
        [status]
      );
      return result.rows.map(rowToRecord);
    },

    async markDecision(input: SkillReviewDecisionInput): Promise<void> {
      await pool.query(
        `UPDATE skill_review_queue
           SET status = $1, reviewer_id = $2, comment = $3,
               decision_at = NOW()
         WHERE id = $4`,
        [input.status, input.reviewer_id ?? null, input.comment ?? null, input.id]
      );
    },

    async getById(id: string, scope: SkillReviewQueueOrgScope): Promise<SkillReviewQueueRow | null> {
      if (scope !== SYSTEM_SCOPE) {
        const result = await pool.query(
          `SELECT * FROM skill_review_queue WHERE id = $1 AND org_id = $2`,
          [id, scope]
        );
        return result.rows.length > 0 ? rowToRecord(result.rows[0]) : null;
      }
      const result = await pool.query(
        `SELECT * FROM skill_review_queue WHERE id = $1`,
        [id]
      );
      return result.rows.length > 0 ? rowToRecord(result.rows[0]) : null;
    },

    async findActiveBySkill(skillId: string): Promise<SkillReviewQueueRow | null> {
      const result = await pool.query(
        `SELECT * FROM skill_review_queue
          WHERE skill_id = $1 AND status IN ('pending', 'rejected')
          ORDER BY queued_at DESC
          LIMIT 1`,
        [skillId]
      );
      return result.rows.length > 0 ? rowToRecord(result.rows[0]) : null;
    },
  };
}

function rowToRecord(row: Record<string, unknown>): SkillReviewQueueRow {
  return {
    id: row.id as string,
    skill_id: row.skill_id as string,
    version: String(row.version),
    org_id: (row.org_id as string | null) ?? null,
    status: row.status as 'pending' | 'approved' | 'rejected',
    queued_at:
      row.queued_at instanceof Date
        ? (row.queued_at as Date).toISOString()
        : (row.queued_at as string),
    judge_run_id: (row.judge_run_id as string | null) ?? null,
    findings: (row.findings as unknown[]) ?? [],
    rubric_scores: (row.rubric_scores as Record<string, unknown> | null) ?? null,
    rubric_version: Number(row.rubric_version),
    cost_usd: row.cost_usd != null ? Number(row.cost_usd) : null,
    tokens_in: row.tokens_in != null ? Number(row.tokens_in) : null,
    tokens_out: row.tokens_out != null ? Number(row.tokens_out) : null,
    reviewer_id: (row.reviewer_id as string | null) ?? null,
    decision_at:
      row.decision_at instanceof Date
        ? (row.decision_at as Date).toISOString()
        : (row.decision_at as string | null) ?? null,
    comment: (row.comment as string | null) ?? null,
  };
}
