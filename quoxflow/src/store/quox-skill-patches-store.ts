/**
 * QuoxSkillPatches Store — QSKL-4.A
 *
 * Persistence layer for skill-patch audit records.
 * Mirrors the pattern of QuoxSkillsStore: pg.Pool + in-memory fallback,
 * ULID PKs, init() no-op for in-memory mode.
 *
 * Table: quox_skill_patches (created by migration 007-quox-skills.sql)
 */

import pg from 'pg';
import { ulid } from 'ulid';

const { Pool } = pg;

export interface QuoxSkillPatchesStoreConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
}

export interface QuoxSkillPatchInput {
  skillId: string;
  fromVersion: string;
  toVersion: string;
  patchedBy: string;
  reason?: string | null;
  diff: {
    from_body_md: string;
    to_body_md: string;
    step_diff?: unknown;
  };
  /** QSKL-5.B: author-written tests run before Crystal-eval. Default 0. */
  testsRun?: number;
  /** QSKL-5.B: count of those tests that passed. Default 0. */
  testsPassed?: number;
  crystalsEvaluated: number;
  crystalsPassed: number;
  crystalsFailed: unknown[];
  outcome: 'promoted' | 'reverted' | 'pending_hitl';
  envelopeId?: string | null;
  /** QSKL-FIX Slice3: org_id of the owning org. Optional for backwards compat (no DB column yet). */
  orgId?: string | null;
}

export interface QuoxSkillPatchRecord extends Omit<QuoxSkillPatchInput, 'testsRun' | 'testsPassed'> {
  id: string;
  testsRun: number;
  testsPassed: number;
  createdAt: string;
  orgId?: string | null;
}

/**
 * Resolve org_id for a patch record.
 * In production: throw when orgId is missing to prevent silent 'org-default' minting.
 * In dev/test: allow missing orgId but log a once-per-process warning.
 */
let _orgDefaultWarned = false;
function resolveOrgIdForPatch(orgId: string | null | undefined): string {
  if (orgId && orgId.length > 0) return orgId;

  const isServiceKey = Boolean(process.env.INTERNAL_SERVICE_KEY);
  if (process.env.NODE_ENV === 'production' && !isServiceKey) {
    throw new Error(
      '[QuoxSkillPatchesStore] org_id is required in production — refusing to mint org-default. ' +
      'Supply orgId from the caller\'s JWT/execution context.'
    );
  }

  // Dev/test: allow but warn once
  if (!_orgDefaultWarned) {
    _orgDefaultWarned = true;
    console.warn(
      '[QuoxSkillPatchesStore] org_id missing on patch create — falling back to "org-default". ' +
      'This is only acceptable in dev/test. Production requests must supply orgId.'
    );
  }
  return 'org-default';
}

export class QuoxSkillPatchesStore {
  private pool: pg.Pool | null = null;
  private inMemory: QuoxSkillPatchRecord[] = [];
  private useInMemory: boolean;

  constructor(config?: QuoxSkillPatchesStoreConfig) {
    this.useInMemory = !config;
    if (config) {
      this.pool = new Pool(config);
    }
  }

  async init(): Promise<void> {
    // Table is created by migration 007-quox-skills.sql.
    // In-memory mode: no-op (matches QuoxSkillsStore pattern).
    if (this.useInMemory) return;
    // PG mode: table already exists via migration; nothing to create inline.
  }

  async create(input: QuoxSkillPatchInput): Promise<QuoxSkillPatchRecord> {
    const id = ulid();
    const now = new Date().toISOString();

    if (this.useInMemory) {
      const record: QuoxSkillPatchRecord = {
        ...input,
        id,
        testsRun: input.testsRun ?? 0,
        testsPassed: input.testsPassed ?? 0,
        orgId: resolveOrgIdForPatch(input.orgId),
        createdAt: now,
      };
      this.inMemory.push(record);
      return record;
    }

    await this.pool!.query(
      `INSERT INTO quox_skill_patches (
        id, skill_id, from_version, to_version, patched_by, reason,
        diff, tests_run, tests_passed,
        crystals_evaluated, crystals_passed, crystals_failed,
        outcome, envelope_id, created_at, org_id
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7::jsonb, $8, $9,
        $10, $11, $12::jsonb,
        $13, $14, $15, $16
      )`,
      [
        id,
        input.skillId,
        input.fromVersion,
        input.toVersion,
        input.patchedBy,
        input.reason ?? null,
        JSON.stringify(input.diff),
        input.testsRun ?? 0,
        input.testsPassed ?? 0,
        input.crystalsEvaluated,
        input.crystalsPassed,
        JSON.stringify(input.crystalsFailed),
        input.outcome,
        input.envelopeId ?? null,
        now,
        resolveOrgIdForPatch(input.orgId),
      ]
    );

    return (await this.findById(id))!;
  }

  async findById(id: string, orgId?: string): Promise<QuoxSkillPatchRecord | null> {
    if (this.useInMemory) {
      const record = this.inMemory.find(r => r.id === id) ?? null;
      if (!record) return null;
      if (orgId !== undefined && record.orgId !== undefined && record.orgId !== null && record.orgId !== orgId) return null;
      return record;
    }

    if (orgId !== undefined) {
      const result = await this.pool!.query(
        `SELECT * FROM quox_skill_patches WHERE id = $1 AND org_id = $2`,
        [id, orgId]
      );
      return result.rows[0] ? this.rowToRecord(result.rows[0]) : null;
    }
    const result = await this.pool!.query(
      `SELECT * FROM quox_skill_patches WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? this.rowToRecord(result.rows[0]) : null;
  }

  async setEnvelopeId(patchId: string, envelopeId: string): Promise<void> {
    if (this.useInMemory) {
      const rec = this.inMemory.find(r => r.id === patchId);
      if (rec) rec.envelopeId = envelopeId;
      return;
    }

    await this.pool!.query(
      `UPDATE quox_skill_patches SET envelope_id = $1 WHERE id = $2`,
      [envelopeId, patchId]
    );
  }

  async listBySkillId(skillId: string, orgId?: string): Promise<QuoxSkillPatchRecord[]> {
    if (this.useInMemory) {
      return this.inMemory.filter(r =>
        r.skillId === skillId &&
        (orgId === undefined || r.orgId === undefined || r.orgId === null || r.orgId === orgId)
      );
    }

    if (orgId !== undefined) {
      const result = await this.pool!.query(
        `SELECT * FROM quox_skill_patches WHERE skill_id = $1 AND org_id = $2 ORDER BY created_at DESC`,
        [skillId, orgId]
      );
      return result.rows.map(row => this.rowToRecord(row));
    }
    const result = await this.pool!.query(
      `SELECT * FROM quox_skill_patches WHERE skill_id = $1 ORDER BY created_at DESC`,
      [skillId]
    );
    return result.rows.map(row => this.rowToRecord(row));
  }

  /**
   * QSKL-4.E — Returns all promoted patches whose created_at falls within the
   * last `windowMinutes` minutes.  A future scheduled job (QSKL-7) calls this
   * to find every in-window promoted patch and pass each to checkAndAutoRevert.
   */
  async listPromotedInWindow(now: Date, windowMinutes: number): Promise<QuoxSkillPatchRecord[]> {
    const since = new Date(now.getTime() - windowMinutes * 60 * 1000);

    if (this.useInMemory) {
      return this.inMemory.filter(r => {
        if (r.outcome !== 'promoted') return false;
        const createdAt = new Date(r.createdAt);
        return createdAt >= since && createdAt <= now;
      });
    }

    const result = await this.pool!.query(
      `SELECT * FROM quox_skill_patches
       WHERE outcome = 'promoted' AND created_at > $1
       ORDER BY created_at DESC`,
      [since.toISOString()]
    );
    return result.rows.map(row => this.rowToRecord(row));
  }

  /**
   * QSKL-7.5 — Returns patches for a given skill where outcome='promoted' and
   * created_at >= sinceIso, sorted by created_at DESC.
   * Used by the post-invocation auto-revert hook to enumerate recent promoted
   * patches that may need to be evaluated for threshold breach.
   */
  async findRecentPromoted(skillId: string, sinceIso: string): Promise<QuoxSkillPatchRecord[]> {
    if (this.useInMemory) {
      return this.inMemory
        .filter(r => {
          if (r.skillId !== skillId) return false;
          if (r.outcome !== 'promoted') return false;
          return new Date(r.createdAt) >= new Date(sinceIso);
        })
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }

    const result = await this.pool!.query(
      `SELECT * FROM quox_skill_patches
       WHERE skill_id = $1 AND outcome = 'promoted' AND created_at >= $2
       ORDER BY created_at DESC`,
      [skillId, sinceIso]
    );
    return result.rows.map(row => this.rowToRecord(row));
  }

  /**
   * QSKL-14a — Count patches attributed to a specific agent since `since`.
   * Only rows whose patched_by = 'agent:<agentId>' are counted.
   * When orgId is provided, only patches for that org are counted (per-org isolation).
   */
  async countAgentPatchesSince(agentId: string, since: Date, orgId?: string): Promise<number> {
    const key = `agent:${agentId}`;

    if (this.useInMemory) {
      return this.inMemory.filter(r => {
        if (r.patchedBy !== key) return false;
        if (new Date(r.createdAt) <= since) return false;
        if (orgId !== undefined && r.orgId !== undefined && r.orgId !== null && r.orgId !== orgId) return false;
        return true;
      }).length;
    }

    if (orgId !== undefined) {
      const result = await this.pool!.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM quox_skill_patches
         WHERE patched_by = $1 AND created_at > $2 AND org_id = $3`,
        [key, since.toISOString(), orgId]
      );
      return parseInt(result.rows[0].count, 10);
    }

    const result = await this.pool!.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM quox_skill_patches
       WHERE patched_by = $1 AND created_at > $2`,
      [key, since.toISOString()]
    );
    return parseInt(result.rows[0].count, 10);
  }

  /**
   * QSKL-14a — Returns the oldest patch (by created_at) attributed to a
   * specific agent that falls within the window [since, now].
   * When orgId is provided, only patches for that org are considered.
   * Returns null when there are no matching rows.
   */
  async oldestAgentPatchSince(agentId: string, since: Date, orgId?: string): Promise<QuoxSkillPatchRecord | null> {
    const key = `agent:${agentId}`;

    if (this.useInMemory) {
      const rows = this.inMemory
        .filter(r => {
          if (r.patchedBy !== key) return false;
          if (new Date(r.createdAt) <= since) return false;
          if (orgId !== undefined && r.orgId !== undefined && r.orgId !== null && r.orgId !== orgId) return false;
          return true;
        })
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      return rows[0] ?? null;
    }

    if (orgId !== undefined) {
      const result = await this.pool!.query(
        `SELECT * FROM quox_skill_patches
         WHERE patched_by = $1 AND created_at > $2 AND org_id = $3
         ORDER BY created_at ASC
         LIMIT 1`,
        [key, since.toISOString(), orgId]
      );
      return result.rows[0] ? this.rowToRecord(result.rows[0]) : null;
    }

    const result = await this.pool!.query(
      `SELECT * FROM quox_skill_patches
       WHERE patched_by = $1 AND created_at > $2
       ORDER BY created_at ASC
       LIMIT 1`,
      [key, since.toISOString()]
    );
    return result.rows[0] ? this.rowToRecord(result.rows[0]) : null;
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private rowToRecord(row: Record<string, unknown>): QuoxSkillPatchRecord {
    return {
      id: row.id as string,
      skillId: row.skill_id as string,
      fromVersion: row.from_version as string,
      toVersion: row.to_version as string,
      patchedBy: row.patched_by as string,
      reason: row.reason as string | null,
      diff: this.parseJson(row.diff, {}) as QuoxSkillPatchRecord['diff'],
      testsRun: row.tests_run as number,
      testsPassed: row.tests_passed as number,
      crystalsEvaluated: row.crystals_evaluated as number,
      crystalsPassed: row.crystals_passed as number,
      crystalsFailed: this.parseJson(row.crystals_failed, []) as unknown[],
      outcome: row.outcome as 'promoted' | 'reverted' | 'pending_hitl',
      envelopeId: row.envelope_id as string | null,
      createdAt: row.created_at instanceof Date
        ? (row.created_at as Date).toISOString()
        : String(row.created_at),
      orgId: (row.org_id as string | null | undefined) ?? null,
    };
  }

  private parseJson(val: unknown, fallback: unknown): unknown {
    if (val === null || val === undefined) return fallback;
    if (typeof val === 'string') {
      try { return JSON.parse(val); } catch { return fallback; }
    }
    return val; // PG driver already parsed JSONB
  }
}

/** Factory for in-memory mode (tests / dev) */
export function createInMemoryQuoxSkillPatchesStore(): QuoxSkillPatchesStore {
  return new QuoxSkillPatchesStore();
}
