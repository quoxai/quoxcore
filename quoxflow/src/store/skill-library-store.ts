/**
 * Skill Library Store — STUDY-REV W2 (Crystalliser persistence)
 *
 * After a workflow proves itself (3+ runs at >=80% success, consistent
 * action structure), the Crystalliser produces a deterministic workflow.
 * That artefact is persisted here, versioned per source workflow + org.
 *
 * Pattern mirrors EnvelopeStore: pg.Pool + in-memory fallback,
 * init() creates table with CREATE TABLE IF NOT EXISTS, ULID PKs.
 */

import pg from 'pg';
import { ulid } from 'ulid';
import { logger } from '../logger.js';
import { hashSnapshot } from './crystal-canonical-hash.js';

const { Pool } = pg;

const log = logger.for('SkillLibraryStore');

export interface SkillLibraryStoreConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
}

export interface SkillLibraryWriteInput {
  orgId: string;
  sourceWorkflowId: string;
  name: string;
  confidence: number;
  executionCount: number;
  successRate: number;
  workflowJson: Record<string, unknown>;
  tags?: string[];
  variables?: unknown[];
  /** P9.1: Crystal applicability metadata — agentId + objective keywords for retrieval */
  metadata?: {
    agentId?: string;
    objectiveKeywords?: string[];
    source?: 'post-hoc' | 'task-time';
    stage?: 'candidate' | 'canonical';
    /** QSKL-4.B: Skill that was active in the session when this Crystal was produced */
    source_skill_id?: string;
    /** QSKL-4.B: Version of the source skill (string form of the version number) */
    source_skill_version?: string;
    [key: string]: unknown;
  };
  /** REPLAY-ONLY .B2: sha256 hex of the canonical JSON of actionLogSnapshot, set at promotion time. */
  canonicalHash?: string;
  /** REPLAY-ONLY .B2: Ed25519 signature (hex) from the auth signing oracle, or unset if unsigned/pending. */
  signature?: string;
  /** REPLAY-ONLY .B2: auth CSK key_id that produced `signature`. */
  signedBy?: string;
  /** REPLAY-ONLY .B2: signature algorithm reported by the signing oracle (e.g. 'Ed25519'). */
  sigAlgorithm?: string;
  /** REPLAY-ONLY .B2: ISO timestamp of a successful sign. */
  signedAt?: string;
  /**
   * REPLAY-ONLY .B2: 'signed' after a successful auth signing-oracle call,
   * 'pending' when signing was attempted but failed/unavailable (canonical_hash
   * is still stored so a later re-sign can confirm the snapshot didn't change —
   * B3's verify-on-replay gate treats 'pending' as unsigned, fail-closed),
   * 'unsigned' when no crystalSigner was injected at all (legacy behavior).
   */
  signatureStatus?: SignatureStatus;
}

export type SignatureStatus = 'signed' | 'unsigned' | 'pending';

export interface SkillLibraryRecord extends SkillLibraryWriteInput {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * REPLAY-ONLY .B2: the shape returned by auth's crystal signing oracle
 * (POST /api/internal/crystals/sign, shipped in .B1a). The private key
 * never leaves auth — quoxflow only ever sees the hash it sent and the
 * signature/key_id/algorithm that come back.
 */
export interface CrystalSignerResult {
  signature: string;
  key_id: string;
  algorithm: string;
}

/**
 * REPLAY-ONLY .B2: optional dependency-injected signer, mirroring how
 * replayOnlyResolver/budgetScopeResolver are threaded through config in
 * server.ts. Must never throw into the promotion path — on any failure
 * (non-2xx, network error) the real implementation logs and resolves to
 * null so promoteCanonical can fall back to signature_status='pending'.
 */
export type CrystalSigner = (params: { orgId: string; hash: string }) => Promise<CrystalSignerResult | null>;

/** P9.1: Options for findApplicable */
export interface FindApplicableOptions {
  orgId: string;
  agentId?: string;
  objectiveKeywords?: string[];
  maxCrystals?: number;
}

/**
 * AGH-5: Minimal params snapshot for a single replayed action.
 * Only the fields needed to re-execute — url/method/headers for http_call,
 * command/host for ssh_exec. Keep it small; this lives in workflowJson.
 */
export interface ActionParamsSnapshot {
  action: string;
  params: Record<string, unknown>;
}

/** P9.2: In-flight Crystal draft, keyed on executionId */
export interface CrystalDraft {
  executionId: string;
  orgId: string;
  name: string;
  summary: string;
  actionPattern: string;
  confidence: number;
  agentId?: string;
  objectiveKeywords?: string[];
  refineCount: number;
  /**
   * Sentinel-4 Fix2: number of consecutive successful matching runs for this
   * (agentId, orgId, actionPattern) tuple. Incremented by the executor done-branch
   * on each successful run where the action_pattern matches. Reset to 0 on pattern divergence.
   */
  consecutiveSuccess: number;
  /**
   * AGH-5: Snapshot of the real action params from the run that proposed this draft.
   * Stored in workflowJson at promotion time so the engine can replay without an LLM call.
   * Format: [{ action, params: { url, method, headers? } | { command, host } }]
   *
   * NOTE: Existing canonical Crystals promoted before AGH-5 will not have this field.
   * They will get it the next time their pattern is re-promoted (via idempotency bump path
   * or manual re-trigger). Do not backfill existing rows — let them update naturally.
   */
  actionLogSnapshot?: ActionParamsSnapshot[];
  createdAt: string;
  updatedAt: string;
}

export class SkillLibraryStore {
  private pool: pg.Pool | null = null;
  private inMemory: SkillLibraryRecord[] = [];
  /**
   * P9.2: In-memory draft store keyed on executionId.
   * Only used when pgPool is null (in-memory / test mode).
   * When PG is enabled, all draft ops go directly to crystal_drafts table.
   */
  private drafts: Map<string, CrystalDraft> = new Map();
  /**
   * Sentinel-4 Fix2: Cross-execution consecutive-success counters.
   * Key: `${agentId}::${orgId}::${actionPattern}` (normalised).
   * Only used when pgPool is null (in-memory / test mode).
   * When PG is enabled, all counter ops go to consecutive_success_counters table.
   */
  private consecutiveSuccessCounters: Map<string, number> = new Map();
  private useInMemory: boolean;
  /**
   * REPLAY-ONLY .B2: optional signing oracle client, injected from server.ts
   * (mirrors replayOnlyResolver/budgetScopeResolver injection). Undefined in
   * test/embedded contexts that never call setCrystalSigner — promoteCanonical
   * treats that as legacy behavior (signature_status='unsigned').
   */
  private crystalSigner?: CrystalSigner;

  constructor(config?: SkillLibraryStoreConfig) {
    this.useInMemory = !config;
    if (config) {
      this.pool = new Pool(config);
    }
  }

  /** REPLAY-ONLY .B2: inject the auth crystal-signing-oracle HTTP client. */
  setCrystalSigner(signer: CrystalSigner): void {
    this.crystalSigner = signer;
  }

  async init(): Promise<void> {
    if (this.useInMemory) return;

    const createTable = `
      CREATE TABLE IF NOT EXISTS skill_library (
        id VARCHAR(26) PRIMARY KEY,
        org_id VARCHAR(255) NOT NULL,
        source_workflow_id VARCHAR(255) NOT NULL,
        name TEXT NOT NULL,
        version INT NOT NULL,
        confidence REAL NOT NULL,
        execution_count INT NOT NULL,
        success_rate REAL NOT NULL,
        workflow_json JSONB NOT NULL,
        tags JSONB,
        variables JSONB,
        metadata JSONB,
        signature TEXT,
        signed_by TEXT,
        sig_algorithm TEXT,
        canonical_hash TEXT,
        signed_at TIMESTAMPTZ,
        signature_status TEXT DEFAULT 'unsigned',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(org_id, source_workflow_id, version)
      );

      CREATE INDEX IF NOT EXISTS idx_skill_library_org_source
        ON skill_library(org_id, source_workflow_id);

      CREATE TABLE IF NOT EXISTS crystal_drafts (
        execution_id            VARCHAR(255) PRIMARY KEY,
        org_id                  VARCHAR(255) NOT NULL,
        agent_id                VARCHAR(255),
        name                    TEXT NOT NULL,
        summary                 TEXT NOT NULL,
        action_pattern          TEXT NOT NULL,
        confidence              REAL NOT NULL,
        refine_count            INTEGER NOT NULL DEFAULT 0,
        consecutive_success     INTEGER NOT NULL DEFAULT 0,
        action_log_snapshot     JSONB,
        objective_keywords      JSONB DEFAULT '[]'::jsonb,
        created_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_crystal_drafts_pattern_key
        ON crystal_drafts (org_id, agent_id, action_pattern);

      CREATE TABLE IF NOT EXISTS consecutive_success_counters (
        pattern_key             VARCHAR(512) PRIMARY KEY,
        count                   INTEGER NOT NULL DEFAULT 0,
        updated_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );
    `;

    await this.pool!.query(createTable);

    // AGH-4: Hydrate in-memory Maps from PG so sync callers (getDraftByExecution,
    // getConsecutiveSuccess) work correctly after an engine restart without requiring
    // any code changes in the executor.
    await this.hydrateMapsFromPG();
  }

  /**
   * AGH-4: Load persisted drafts and counters from PG into the in-memory Maps.
   * Called by init() at engine startup. Safe to call multiple times — it overwrites
   * Map contents with the authoritative PG state.
   */
  private async hydrateMapsFromPG(): Promise<void> {
    if (!this.pool) return;

    try {
      // Hydrate drafts
      const draftsResult = await this.pool.query(`SELECT * FROM crystal_drafts ORDER BY created_at ASC`);
      this.drafts.clear();
      for (const row of draftsResult.rows) {
        const draft = this.rowToDraft(row);
        this.drafts.set(draft.executionId, draft);
      }

      // Hydrate consecutive-success counters
      const countersResult = await this.pool.query(`SELECT pattern_key, count FROM consecutive_success_counters`);
      this.consecutiveSuccessCounters.clear();
      for (const row of countersResult.rows) {
        this.consecutiveSuccessCounters.set(row.pattern_key as string, Number(row.count));
      }

      log.info(
        `AGH-4: hydrated ${this.drafts.size} drafts and ` +
        `${this.consecutiveSuccessCounters.size} counters from PG`
      );
    } catch (err) {
      log.warn('hydrateMapsFromPG error', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  async write(input: SkillLibraryWriteInput): Promise<SkillLibraryRecord> {
    if (this.useInMemory) {
      // Determine next version for this (org, sourceWorkflowId) pair
      const existing = this.inMemory.filter(
        r => r.orgId === input.orgId && r.sourceWorkflowId === input.sourceWorkflowId
      );
      const version = existing.length > 0
        ? Math.max(...existing.map(r => r.version)) + 1
        : 1;

      const now = new Date().toISOString();
      const record: SkillLibraryRecord = {
        ...input,
        signatureStatus: input.signatureStatus ?? 'unsigned',
        id: ulid(),
        version,
        createdAt: now,
        updatedAt: now,
      };

      this.inMemory.push(record);
      return record;
    }

    // Determine next version in postgres
    const versionResult = await this.pool!.query(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
       FROM skill_library
       WHERE org_id = $1 AND source_workflow_id = $2`,
      [input.orgId, input.sourceWorkflowId]
    );
    const version = parseInt(versionResult.rows[0].next_version, 10);

    const id = ulid();
    const now = new Date().toISOString();

    const signatureStatus: SignatureStatus = input.signatureStatus ?? 'unsigned';

    await this.pool!.query(
      `INSERT INTO skill_library (
        id, org_id, source_workflow_id, name, version, confidence,
        execution_count, success_rate, workflow_json, tags, variables,
        metadata, signature, signed_by, sig_algorithm, canonical_hash,
        signed_at, signature_status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
      [
        id,
        input.orgId,
        input.sourceWorkflowId,
        input.name,
        version,
        input.confidence,
        input.executionCount,
        input.successRate,
        JSON.stringify(input.workflowJson),
        input.tags ? JSON.stringify(input.tags) : null,
        input.variables ? JSON.stringify(input.variables) : null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        input.signature ?? null,
        input.signedBy ?? null,
        input.sigAlgorithm ?? null,
        input.canonicalHash ?? null,
        input.signedAt ?? null,
        signatureStatus,
        now,
        now,
      ]
    );

    return {
      ...input,
      signatureStatus,
      id,
      version,
      createdAt: now,
      updatedAt: now,
    };
  }

  async getLatest(opts: { orgId: string; sourceWorkflowId: string }): Promise<SkillLibraryRecord | null> {
    if (this.useInMemory) {
      const matches = this.inMemory.filter(
        r => r.orgId === opts.orgId && r.sourceWorkflowId === opts.sourceWorkflowId
      );
      if (matches.length === 0) return null;
      return matches.reduce((best, r) => r.version > best.version ? r : best);
    }

    const result = await this.pool!.query(
      `SELECT * FROM skill_library
       WHERE org_id = $1 AND source_workflow_id = $2
       ORDER BY version DESC
       LIMIT 1`,
      [opts.orgId, opts.sourceWorkflowId]
    );

    return result.rows[0] ? this.rowToRecord(result.rows[0]) : null;
  }

  /**
   * REPLAY-ONLY .A1 (G5): Fetch a Crystal by its exact versioned ULID id,
   * org-scoped. Used by the replay-only executor's pinned crystal_binding
   * resolution — a deterministic node -> crystal_id lookup, never a fuzzy
   * match (see findApplicable, which stays fuzzy-only for the non-replay-only
   * optimisation path). Returns null when the id doesn't exist or belongs
   * to a different org (never leaks cross-org rows).
   */
  async getById(id: string, orgId: string): Promise<SkillLibraryRecord | null> {
    if (this.useInMemory) {
      const match = this.inMemory.find(r => r.id === id && r.orgId === orgId);
      return match ?? null;
    }

    const result = await this.pool!.query(
      `SELECT * FROM skill_library WHERE id = $1 AND org_id = $2`,
      [id, orgId]
    );
    return result.rows[0] ? this.rowToRecord(result.rows[0]) : null;
  }

  /**
   * STUDY-REV SV-1: list every version for one (org, sourceWorkflowId) pair,
   * ordered ascending by version. Used by the version-history UI and the
   * rollback endpoint, both of which need to see the full history (not
   * just the latest like list() / getLatest()).
   */
  async listVersions(opts: { orgId: string; sourceWorkflowId: string }): Promise<SkillLibraryRecord[]> {
    if (this.useInMemory) {
      return this.inMemory
        .filter(r => r.orgId === opts.orgId && r.sourceWorkflowId === opts.sourceWorkflowId)
        .slice()
        .sort((a, b) => a.version - b.version);
    }

    const result = await this.pool!.query(
      `SELECT * FROM skill_library
       WHERE org_id = $1 AND source_workflow_id = $2
       ORDER BY version ASC`,
      [opts.orgId, opts.sourceWorkflowId]
    );
    return result.rows.map(row => this.rowToRecord(row));
  }

  async list(opts: { orgId: string; includeAllVersions?: boolean }): Promise<SkillLibraryRecord[]> {
    if (this.useInMemory) {
      const orgRecords = this.inMemory.filter(r => r.orgId === opts.orgId);

      if (opts.includeAllVersions) {
        return orgRecords;
      }

      // Return only the latest version per sourceWorkflowId
      const latestMap = new Map<string, SkillLibraryRecord>();
      for (const r of orgRecords) {
        const current = latestMap.get(r.sourceWorkflowId);
        if (!current || r.version > current.version) {
          latestMap.set(r.sourceWorkflowId, r);
        }
      }
      return Array.from(latestMap.values());
    }

    if (opts.includeAllVersions) {
      const result = await this.pool!.query(
        'SELECT * FROM skill_library WHERE org_id = $1 ORDER BY source_workflow_id, version ASC',
        [opts.orgId]
      );
      return result.rows.map(row => this.rowToRecord(row));
    }

    // Latest version only per source_workflow_id
    const result = await this.pool!.query(
      `SELECT DISTINCT ON (source_workflow_id) *
       FROM skill_library
       WHERE org_id = $1
       ORDER BY source_workflow_id, version DESC`,
      [opts.orgId]
    );
    return result.rows.map(row => this.rowToRecord(row));
  }

  /**
   * QSKL-4.C: Find all canonical Crystals whose metadata.source_skill_id matches
   * the given skillId. Returns all versions (not just latest) so the evaluator
   * can check every Crystal the skill has ever produced.
   */
  async findCanonicalCrystalsBySourceSkillId(
    orgId: string,
    skillId: string,
  ): Promise<SkillLibraryRecord[]> {
    if (this.useInMemory) {
      return this.inMemory.filter(
        r =>
          r.orgId === orgId &&
          r.metadata?.source_skill_id === skillId &&
          r.metadata?.stage === 'canonical',
      );
    }

    const result = await this.pool!.query(
      `SELECT * FROM skill_library
       WHERE org_id = $1
         AND metadata->>'source_skill_id' = $2
         AND metadata->>'stage' = 'canonical'
       ORDER BY created_at ASC`,
      [orgId, skillId],
    );
    return result.rows.map(row => this.rowToRecord(row));
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
    }
  }

  /**
   * P9.1: Find Crystals applicable to an agentic task at runtime.
   *
   * Match criteria (any-match — OR logic):
   *   1. metadata.agentId === agentId
   *   2. metadata.objectiveKeywords has ≥1 overlap with objectiveKeywords
   *
   * Ranking: successRate × recency score (newest record = 1.0, oldest = 0.0 in the set).
   * Returns up to maxCrystals (default 3) latest-version records.
   */
  async findApplicable(opts: FindApplicableOptions): Promise<SkillLibraryRecord[]> {
    const { orgId, agentId, objectiveKeywords = [], maxCrystals = 3 } = opts;

    if (this.useInMemory) {
      // Start from latest-version records per source workflow
      const latestMap = new Map<string, SkillLibraryRecord>();
      for (const r of this.inMemory) {
        if (r.orgId !== orgId) continue;
        const cur = latestMap.get(r.sourceWorkflowId);
        if (!cur || r.version > cur.version) {
          latestMap.set(r.sourceWorkflowId, r);
        }
      }
      const candidates = Array.from(latestMap.values());

      const matched = candidates.filter(r => {
        const meta = (r as any).metadata as { agentId?: string; objectiveKeywords?: string[] } | undefined;
        const metaAgentId = meta?.agentId;
        const metaKeywords: string[] = meta?.objectiveKeywords ?? [];

        const agentMatch = agentId && metaAgentId === agentId;
        const keywordMatch = objectiveKeywords.length > 0 &&
          metaKeywords.some(k => objectiveKeywords.includes(k));

        return agentMatch || keywordMatch;
      });

      // Rank by successRate × recency
      const createdAts = matched.map(r => new Date(r.createdAt).getTime());
      const minTs = Math.min(...createdAts);
      const maxTs = Math.max(...createdAts);
      const tsRange = maxTs - minTs || 1;

      const scored = matched.map(r => {
        const recency = (new Date(r.createdAt).getTime() - minTs) / tsRange;
        const score = r.successRate * 0.8 + recency * 0.2;
        return { r, score };
      });

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, maxCrystals).map(s => s.r);
    }

    // Postgres variant: pull latest-version rows for org, filter/rank in JS
    const result = await this.pool!.query(
      `SELECT DISTINCT ON (source_workflow_id) *
       FROM skill_library
       WHERE org_id = $1
       ORDER BY source_workflow_id, version DESC`,
      [orgId]
    );
    const all: SkillLibraryRecord[] = result.rows.map(row => this.rowToRecord(row));

    const matched = all.filter(r => {
      const meta = (r as any).metadata as { agentId?: string; objectiveKeywords?: string[] } | undefined;
      const metaAgentId = meta?.agentId;
      const metaKeywords: string[] = meta?.objectiveKeywords ?? [];

      const agentMatch = agentId && metaAgentId === agentId;
      const keywordMatch = objectiveKeywords.length > 0 &&
        metaKeywords.some(k => objectiveKeywords.includes(k));

      return agentMatch || keywordMatch;
    });

    const createdAts = matched.map(r => new Date(r.createdAt).getTime());
    const minTs = Math.min(...createdAts);
    const maxTs = Math.max(...createdAts);
    const tsRange = maxTs - minTs || 1;

    const scored = matched.map(r => {
      const recency = (new Date(r.createdAt).getTime() - minTs) / tsRange;
      const score = r.successRate * 0.8 + recency * 0.2;
      return { r, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxCrystals).map(s => s.r);
  }

  // ─── P9.2: Draft store methods ──────────────────────────────────────────

  // ── normalise helper (shared across draft + counter methods) ─────────────
  private normalisePattern(s: string): string {
    return s
      .toLowerCase()
      .replace(/\s+/g, '')            // remove all whitespace
      .replace(/[→,|;\/\-]+/g, ',')  // collapse separator chars into ','
      .replace(/,+/g, ',')           // deduplicate commas
      .replace(/^,|,$/g, '');        // trim leading/trailing commas
  }

  /**
   * Create a new in-flight draft. Returns null if a draft already exists
   * for this executionId (enforce one-draft-per-execution).
   *
   * AGH-4: When PG is enabled, persists to crystal_drafts table.
   * AGH-5: accepts optional actionLogSnapshot so the executor can pass through
   * the real action params at draft-creation time; stored in workflowJson on promotion.
   */
  createDraft(params: Omit<CrystalDraft, 'refineCount' | 'consecutiveSuccess' | 'createdAt' | 'updatedAt'>): CrystalDraft | null {
    // Enforce one-draft-per-execution: check in-memory Map first (populated on every createDraft)
    if (this.drafts.has(params.executionId)) return null;

    const now = new Date().toISOString();
    const draft: CrystalDraft = { ...params, refineCount: 0, consecutiveSuccess: 0, createdAt: now, updatedAt: now };

    // Always write to in-memory Map (acts as write-through cache; hydrated from PG on init())
    this.drafts.set(params.executionId, draft);

    if (this.pool) {
      // PG path: fire-and-forget INSERT. ON CONFLICT DO NOTHING handles restart-replay safety.
      this.pool.query(
        `INSERT INTO crystal_drafts (
           execution_id, org_id, agent_id, name, summary, action_pattern,
           confidence, refine_count, consecutive_success,
           action_log_snapshot, objective_keywords, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (execution_id) DO NOTHING`,
        [
          params.executionId,
          params.orgId,
          params.agentId ?? null,
          params.name,
          params.summary,
          params.actionPattern,
          params.confidence,
          0,
          0,
          params.actionLogSnapshot ? JSON.stringify(params.actionLogSnapshot) : null,
          JSON.stringify(params.objectiveKeywords ?? []),
          now,
          now,
        ]
      ).catch(err => log.warn('createDraft PG error', { error: err instanceof Error ? err.message : String(err) }));
    }

    return draft;
  }

  /**
   * Retrieve a draft by executionId.
   * AGH-4: Always reads from the in-memory Map (which acts as a write-through cache,
   * hydrated from PG on init()). Sync so existing callers in agentic.executor.ts work unchanged.
   * Returns undefined if not found.
   */
  getDraftByExecution(executionId: string): CrystalDraft | undefined {
    return this.drafts.get(executionId);
  }

  /**
   * Async variant of getDraftByExecution — queries PG directly when available,
   * then syncs into the in-memory Map. Use this when you need a fresh PG read
   * (e.g. after a restart before the Map is fully hydrated).
   */
  async getDraftByExecutionAsync(executionId: string): Promise<CrystalDraft | undefined> {
    if (!this.pool) {
      return this.drafts.get(executionId);
    }
    try {
      const result = await this.pool.query(
        `SELECT * FROM crystal_drafts WHERE execution_id = $1`,
        [executionId]
      );
      if (result.rows[0]) {
        const draft = this.rowToDraft(result.rows[0]);
        this.drafts.set(executionId, draft);
        return draft;
      }
      return undefined;
    } catch (err) {
      log.warn('getDraftByExecutionAsync PG error', { error: err instanceof Error ? err.message : String(err) });
      return undefined;
    }
  }

  /**
   * Update a draft in-place (for refinement).
   * AGH-4: Writes to the in-memory Map (write-through cache) and, when PG is enabled,
   * also fires a fire-and-forget UPDATE to crystal_drafts.
   * Returns the updated draft or null if not found.
   */
  updateDraft(executionId: string, patch: Partial<Pick<CrystalDraft, 'summary' | 'actionPattern' | 'confidence'>>): CrystalDraft | null {
    const existing = this.drafts.get(executionId);
    if (!existing) return null;

    const updated: CrystalDraft = {
      ...existing,
      ...patch,
      refineCount: existing.refineCount + 1,
      updatedAt: new Date().toISOString(),
    };
    this.drafts.set(executionId, updated);

    if (this.pool) {
      const now = updated.updatedAt;
      const sets: string[] = ['refine_count = refine_count + 1', 'updated_at = $1'];
      const values: unknown[] = [now];
      let idx = 2;

      if (patch.summary !== undefined) { sets.push(`summary = $${idx++}`); values.push(patch.summary); }
      if (patch.actionPattern !== undefined) { sets.push(`action_pattern = $${idx++}`); values.push(patch.actionPattern); }
      if (patch.confidence !== undefined) { sets.push(`confidence = $${idx++}`); values.push(patch.confidence); }

      values.push(executionId);
      this.pool.query(
        `UPDATE crystal_drafts SET ${sets.join(', ')} WHERE execution_id = $${idx}`,
        values
      ).catch(err => log.warn('updateDraft PG error', { error: err instanceof Error ? err.message : String(err) }));
    }

    return updated;
  }

  /**
   * List all drafts for an org (useful for the promote-draft endpoint).
   * AGH-4: When PG is enabled, reads from crystal_drafts table.
   */
  async listDrafts(orgId: string): Promise<CrystalDraft[]> {
    if (!this.pool) {
      return Array.from(this.drafts.values()).filter(d => d.orgId === orgId);
    }
    try {
      const result = await this.pool.query(
        `SELECT * FROM crystal_drafts WHERE org_id = $1 ORDER BY created_at ASC`,
        [orgId]
      );
      return result.rows.map(row => this.rowToDraft(row));
    } catch (err) {
      log.warn('listDrafts PG error', { error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  /**
   * Clear a draft after promotion or abandonment.
   * AGH-4: Always removes from in-memory Map; when PG is enabled, also deletes
   * from crystal_drafts table.
   */
  clearDraft(executionId: string): void {
    this.drafts.delete(executionId);

    if (this.pool) {
      this.pool.query(
        `DELETE FROM crystal_drafts WHERE execution_id = $1`,
        [executionId]
      ).catch(err => log.warn('clearDraft PG error', { error: err instanceof Error ? err.message : String(err) }));
    }
  }

  /**
   * MACHINERY: task-time promotion sweep support.
   *
   * Find all in-flight (experimental/draft) Crystals for a given org + agent
   * whose actionPattern matches the supplied pattern (same normalised-string
   * comparison used by recordSuccessfulRun's pattern-divergence check).
   *
   * A draft only exists in `this.drafts` between createDraft() and the
   * clearDraft() call that follows a promote()/promoteCanonical() — so this
   * method is inherently scoped to "experimental" Crystals (drafts that have
   * not yet been promoted). Used by the run-completion promotion sweep to
   * detect when a completed run reused a previously-drafted-but-unpromoted
   * pattern, even though the LLM never re-emitted propose_crystal this run.
   *
   * Sync — reads from the in-memory Map (write-through cache, hydrated from
   * PG on init() per AGH-4), mirroring getDraftByExecution().
   */
  findDraftsByPattern(orgId: string, agentId: string | undefined, actionPattern: string): CrystalDraft[] {
    const norm = this.normalisePattern(actionPattern);
    if (!norm) return [];
    return Array.from(this.drafts.values()).filter(d =>
      d.orgId === orgId &&
      (agentId === undefined || d.agentId === agentId) &&
      this.normalisePattern(d.actionPattern) === norm
    );
  }

  /**
   * Sentinel-4 Fix2: Increment or reset the cross-execution consecutiveSuccess counter
   * for a given (agentId, orgId, actionPattern) tuple.
   *
   * Call from the executor done-branch after a successful run:
   *   - If the completed run's action_pattern matches the draft's pattern → increment.
   *   - If divergent → reset to 0.
   *
   * The counter is also written back to ALL live drafts for the same tuple so that
   * getDraftByExecution() returns the up-to-date count.
   *
   * AGH-4: When PG is enabled, persists counter to consecutive_success_counters table
   * and updates matching crystal_drafts rows.
   *
   * Returns the new consecutiveSuccess count.
   */
  recordSuccessfulRun(opts: {
    agentId: string;
    orgId: string;
    actionPattern: string;
    completedActionPattern: string;
  }): number {
    const key = `${opts.agentId}::${opts.orgId}::${opts.actionPattern}`;
    const normalised = this.normalisePattern.bind(this);

    let count: number;
    if (normalised(opts.completedActionPattern) === normalised(opts.actionPattern)) {
      count = (this.consecutiveSuccessCounters.get(key) ?? 0) + 1;
    } else {
      // Pattern diverged — reset
      count = 0;
    }

    if (!this.pool) {
      // In-memory path
      this.consecutiveSuccessCounters.set(key, count);

      // Write back to any live drafts for this tuple
      for (const [execId, draft] of this.drafts.entries()) {
        if (
          draft.agentId === opts.agentId &&
          draft.orgId === opts.orgId &&
          normalised(draft.actionPattern) === normalised(opts.actionPattern)
        ) {
          this.drafts.set(execId, { ...draft, consecutiveSuccess: count, updatedAt: new Date().toISOString() });
        }
      }
    } else {
      // PG path: upsert counter and update matching drafts
      const now = new Date().toISOString();
      this.pool.query(
        `INSERT INTO consecutive_success_counters (pattern_key, count, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (pattern_key) DO UPDATE
           SET count = $2, updated_at = $3`,
        [key, count, now]
      ).catch(err => log.warn('recordSuccessfulRun counter PG error', { error: err instanceof Error ? err.message : String(err) }));

      // Update consecutive_success on matching crystal_drafts rows
      this.pool.query(
        `UPDATE crystal_drafts
         SET consecutive_success = $1, updated_at = $2
         WHERE org_id = $3
           AND agent_id = $4
           AND action_pattern = $5`,
        [count, now, opts.orgId, opts.agentId, opts.actionPattern]
      ).catch(err => log.warn('recordSuccessfulRun draft update PG error', { error: err instanceof Error ? err.message : String(err) }));

      // Write through to in-memory Maps so sync callers see the new value immediately
      this.consecutiveSuccessCounters.set(key, count);
      const now2 = new Date().toISOString();
      for (const [execId, draft] of this.drafts.entries()) {
        if (
          draft.agentId === opts.agentId &&
          draft.orgId === opts.orgId &&
          normalised(draft.actionPattern) === normalised(opts.actionPattern)
        ) {
          this.drafts.set(execId, { ...draft, consecutiveSuccess: count, updatedAt: now2 });
        }
      }
    }

    return count;
  }

  /**
   * Retrieve the current consecutiveSuccess count for a (agentId, orgId, actionPattern) tuple.
   * AGH-4: When PG is enabled, reads from consecutive_success_counters (or falls back
   * to the in-memory cache which is kept in sync by recordSuccessfulRun).
   */
  getConsecutiveSuccess(agentId: string, orgId: string, actionPattern: string): number {
    const key = `${agentId}::${orgId}::${actionPattern}`;
    return this.consecutiveSuccessCounters.get(key) ?? 0;
  }

  /**
   * AGH-4: Async variant of getConsecutiveSuccess — reads from PG when available.
   * Use this at engine startup to hydrate the in-memory counter from the DB,
   * or when you need the most durable value after a restart.
   */
  async getConsecutiveSuccessAsync(agentId: string, orgId: string, actionPattern: string): Promise<number> {
    const key = `${agentId}::${orgId}::${actionPattern}`;
    if (!this.pool) {
      return this.consecutiveSuccessCounters.get(key) ?? 0;
    }
    try {
      const result = await this.pool.query(
        `SELECT count FROM consecutive_success_counters WHERE pattern_key = $1`,
        [key]
      );
      const count = result.rows[0] ? Number(result.rows[0].count) : 0;
      // Sync into in-memory cache
      this.consecutiveSuccessCounters.set(key, count);
      return count;
    } catch (err) {
      log.warn('getConsecutiveSuccessAsync PG error', { error: err instanceof Error ? err.message : String(err) });
      return this.consecutiveSuccessCounters.get(key) ?? 0;
    }
  }

  /**
   * Sentinel-5: Compute a stable pattern key used as sourceWorkflowId for task-time promotions.
   * Uses agentId + orgId + normalised actionPattern so that all executions of the same
   * pattern accumulate under ONE sourceWorkflowId (versioned rows) rather than N independent rows.
   */
  private patternKey(agentId: string | undefined, orgId: string, actionPattern: string): string {
    const normPattern = actionPattern
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[→,|;\/\-]+/g, ',')
      .replace(/,+/g, ',')
      .replace(/^,|,$/g, '');
    return `task-time::${agentId || 'unknown'}::${orgId}::${normPattern}`;
  }

  /**
   * P9.4: Promote a draft Crystal into the skill library.
   *
   * Sentinel-5 fix: sourceWorkflowId is now the stable patternKey (not executionId),
   * so repeated calls for the same pattern accumulate as versions rather than
   * creating a new independent row per execution.
   *
   * task-time promotion creates a 'candidate' stage entry.
   * Canonical promotion (post-hoc) still uses write() directly.
   */
  async promote(draft: {
    orgId: string;
    executionId: string;
    name: string;
    summary: string;
    actionPattern: string;
    confidence: number;
    agentId?: string;
    objectiveKeywords?: string[];
    /** AGH-5: real action params snapshot for deterministic replay */
    actionLogSnapshot?: ActionParamsSnapshot[];
  }, options: { stage: 'candidate' | 'canonical' } = { stage: 'candidate' },
  /** QSKL-4.B: extra metadata fields merged into the Crystal row (e.g. source_skill_id) */
  extraMetadata?: Record<string, unknown>,
  /**
   * REPLAY-ONLY .B2: signing fields computed by promoteCanonical's
   * sign-before-commit hook (computeSigningFields). Only ever passed by
   * promoteCanonical — the plain candidate-promotion callers (skills.ts
   * routes, task-time draft promotion) never sign.
   */
  signingFields?: {
    canonicalHash?: string;
    signature?: string;
    signedBy?: string;
    sigAlgorithm?: string;
    signedAt?: string;
    signatureStatus?: SignatureStatus;
  }): Promise<SkillLibraryRecord> {
    const sourceWorkflowId = this.patternKey(draft.agentId, draft.orgId, draft.actionPattern);
    const tags = options.stage === 'canonical'
      ? ['task-time']          // canonical rows have NO 'candidate' tag
      : ['task-time', 'candidate'];

    // AGH-5: include action_log_snapshot in workflowJson when provided so the
    // engine can replay the Crystal deterministically without an LLM call.
    const workflowJson: Record<string, unknown> = {
      summary: draft.summary,
      action_pattern: draft.actionPattern,
      source: 'task-time',
    };
    if (draft.actionLogSnapshot && draft.actionLogSnapshot.length > 0) {
      workflowJson.action_log_snapshot = draft.actionLogSnapshot;
    }

    return this.write({
      orgId: draft.orgId,
      sourceWorkflowId,
      name: draft.name,
      confidence: draft.confidence,
      executionCount: 1,
      successRate: draft.confidence,
      workflowJson,
      tags,
      metadata: {
        agentId: draft.agentId,
        objectiveKeywords: draft.objectiveKeywords ?? [],
        source: 'task-time',
        stage: options.stage,
        executionId: draft.executionId,
        ...extraMetadata,
      },
      ...signingFields,
    });
  }

  /**
   * REPLAY-ONLY .B2: sign-before-commit hook for promoteCanonical.
   *
   * Computes the canonical hash of the action-snapshot that is about to be
   * promoted and — when a crystalSigner is injected — calls it to obtain an
   * Ed25519 signature from auth's signing oracle (the CSK/private key never
   * leaves auth; quoxflow only ever handles the hash and the signature that
   * comes back). Never throws: any signer failure/null resolves to a
   * 'pending' status so promotion is never blocked by a transient auth
   * outage. canonical_hash is stored in every case (signed, pending, and
   * unsigned) so a later re-sign can confirm the snapshot hasn't changed.
   */
  private async computeSigningFields(
    orgId: string,
    actionLogSnapshot: ActionParamsSnapshot[] | undefined,
  ): Promise<{
    canonicalHash: string;
    signature?: string;
    signedBy?: string;
    sigAlgorithm?: string;
    signedAt?: string;
    signatureStatus: SignatureStatus;
  }> {
    const canonicalHash = hashSnapshot(actionLogSnapshot ?? []);

    if (!this.crystalSigner) {
      // No signer injected at all (test/embedded contexts) — legacy behavior.
      return { canonicalHash, signatureStatus: 'unsigned' };
    }

    try {
      const result = await this.crystalSigner({ orgId, hash: canonicalHash });
      if (!result) {
        log.warn(
          `promoteCanonical: crystalSigner returned null for org ${orgId} — ` +
          `committing with signature_status='pending' (replay-only treats this as unsigned)`
        );
        return { canonicalHash, signatureStatus: 'pending' };
      }
      return {
        canonicalHash,
        signature: result.signature,
        signedBy: result.key_id,
        sigAlgorithm: result.algorithm,
        signedAt: new Date().toISOString(),
        signatureStatus: 'signed',
      };
    } catch (err) {
      // Defence in depth: the injected crystalSigner is contracted not to
      // throw (server.ts's real implementation catches network/HTTP errors
      // and returns null), but a broken/test signer must not be able to
      // block a promotion either.
      log.warn(
        `promoteCanonical: crystalSigner threw for org ${orgId} — committing with signature_status='pending'`,
        { error: err instanceof Error ? err.message : String(err) }
      );
      return { canonicalHash, signatureStatus: 'pending' };
    }
  }

  /**
   * Sentinel-5: Promote a draft Crystal as canonical (threshold met, no 'candidate' tag).
   * Convenience wrapper around promote() with stage='canonical'.
   * Also resets the consecutive-success counter so subsequent runs do not trigger
   * another promotion immediately.
   *
   * AGH-1.fix: Idempotent — if a canonical row already exists for this
   * (orgId, sourceWorkflowId) pair, the existing row has its execution_count
   * incremented and updated_at bumped instead of inserting a new row.
   */
  async promoteCanonical(draft: {
    orgId: string;
    executionId: string;
    name: string;
    summary: string;
    actionPattern: string;
    confidence: number;
    agentId?: string;
    objectiveKeywords?: string[];
    /** AGH-5: real action params snapshot for deterministic replay */
    actionLogSnapshot?: ActionParamsSnapshot[];
  },
  /** QSKL-4.B: extra metadata fields merged into the Crystal row (e.g. source_skill_id) */
  extraMetadata?: Record<string, unknown>): Promise<SkillLibraryRecord> {
    const sourceWorkflowId = this.patternKey(draft.agentId, draft.orgId, draft.actionPattern);

    // ── In-memory path ─────────────────────────────────────────────────────
    if (this.useInMemory) {
      const existing = this.inMemory.find(
        r =>
          r.orgId === draft.orgId &&
          r.sourceWorkflowId === sourceWorkflowId &&
          r.metadata?.stage === 'canonical'
      );
      if (existing) {
        existing.executionCount += 1;
        existing.updatedAt = new Date().toISOString();
        log.info(
          `promoteCanonical skipped — canonical already exists for pattern ${sourceWorkflowId}` +
          ` (existing id=${existing.id}, version=${existing.version}); incremented executionCount to ${existing.executionCount}`
        );
        this.resetConsecutiveSuccess(draft.agentId, draft.orgId, draft.actionPattern);
        return existing;
      }
      const signingFields = await this.computeSigningFields(draft.orgId, draft.actionLogSnapshot);
      const record = await this.promote(draft, { stage: 'canonical' }, extraMetadata, signingFields);
      this.resetConsecutiveSuccess(draft.agentId, draft.orgId, draft.actionPattern);
      return record;
    }

    // ── Postgres path ───────────────────────────────────────────────────────
    const checkResult = await this.pool!.query(
      `SELECT id, version, execution_count FROM skill_library
       WHERE org_id = $1 AND source_workflow_id = $2 AND metadata->>'stage' = 'canonical'
       LIMIT 1`,
      [draft.orgId, sourceWorkflowId]
    );

    if (checkResult.rows.length > 0) {
      const row = checkResult.rows[0];
      const newCount = Number(row.execution_count) + 1;
      await this.pool!.query(
        `UPDATE skill_library SET execution_count = $1, updated_at = NOW() WHERE id = $2`,
        [newCount, row.id]
      );
      log.info(
        `promoteCanonical skipped — canonical already exists for pattern ${sourceWorkflowId}` +
        ` (existing id=${row.id}, version=${row.version}); incremented execution_count to ${newCount}`
      );
      this.resetConsecutiveSuccess(draft.agentId, draft.orgId, draft.actionPattern);
      // Re-fetch and return the updated record
      const updated = await this.pool!.query(
        `SELECT * FROM skill_library WHERE id = $1`,
        [row.id]
      );
      return this.rowToRecord(updated.rows[0]);
    }

    const signingFields = await this.computeSigningFields(draft.orgId, draft.actionLogSnapshot);
    const record = await this.promote(draft, { stage: 'canonical' }, extraMetadata, signingFields);
    // Reset counter so the next run starts fresh (won't immediately re-promote)
    this.resetConsecutiveSuccess(draft.agentId, draft.orgId, draft.actionPattern);
    return record;
  }

  /**
   * Sentinel-5: Reset the consecutive-success counter for a (agentId, orgId, actionPattern)
   * tuple after a canonical promotion. Prevents run 4 from immediately creating a second row.
   * AGH-4: When PG is enabled, also persists the reset to consecutive_success_counters.
   */
  resetConsecutiveSuccess(agentId: string | undefined, orgId: string, actionPattern: string): void {
    const key = `${agentId || ''}::${orgId}::${actionPattern}`;
    this.consecutiveSuccessCounters.set(key, 0);

    if (this.pool) {
      const now = new Date().toISOString();
      this.pool.query(
        `INSERT INTO consecutive_success_counters (pattern_key, count, updated_at)
         VALUES ($1, 0, $2)
         ON CONFLICT (pattern_key) DO UPDATE
           SET count = 0, updated_at = $2`,
        [key, now]
      ).catch(err => log.warn('resetConsecutiveSuccess PG error', { error: err instanceof Error ? err.message : String(err) }));
    }
  }

  /**
   * AGH-4: Map a crystal_drafts row to a CrystalDraft object.
   */
  private rowToDraft(row: Record<string, unknown>): CrystalDraft {
    return {
      executionId: row.execution_id as string,
      orgId: row.org_id as string,
      agentId: row.agent_id as string | undefined,
      name: row.name as string,
      summary: row.summary as string,
      actionPattern: row.action_pattern as string,
      confidence: Number(row.confidence),
      refineCount: Number(row.refine_count),
      consecutiveSuccess: Number(row.consecutive_success),
      actionLogSnapshot: row.action_log_snapshot as ActionParamsSnapshot[] | undefined,
      objectiveKeywords: row.objective_keywords as string[] | undefined,
      createdAt: (row.created_at as Date).toISOString(),
      updatedAt: (row.updated_at as Date).toISOString(),
    };
  }

  private rowToRecord(row: Record<string, unknown>): SkillLibraryRecord {
    return {
      id: row.id as string,
      orgId: row.org_id as string,
      sourceWorkflowId: row.source_workflow_id as string,
      name: row.name as string,
      version: Number(row.version),
      confidence: Number(row.confidence),
      executionCount: Number(row.execution_count),
      successRate: Number(row.success_rate),
      workflowJson: row.workflow_json as Record<string, unknown>,
      tags: row.tags as string[] | undefined,
      variables: row.variables as unknown[] | undefined,
      metadata: row.metadata as SkillLibraryWriteInput['metadata'] | undefined,
      canonicalHash: (row.canonical_hash as string | null) ?? undefined,
      signature: (row.signature as string | null) ?? undefined,
      signedBy: (row.signed_by as string | null) ?? undefined,
      sigAlgorithm: (row.sig_algorithm as string | null) ?? undefined,
      signedAt: row.signed_at ? (row.signed_at as Date).toISOString() : undefined,
      signatureStatus: ((row.signature_status as SignatureStatus | null) ?? 'unsigned'),
      createdAt: (row.created_at as Date).toISOString(),
      updatedAt: (row.updated_at as Date).toISOString(),
    };
  }
}

export function createInMemorySkillLibraryStore(): SkillLibraryStore {
  return new SkillLibraryStore();
}

export function createPostgresSkillLibraryStore(config: SkillLibraryStoreConfig): SkillLibraryStore {
  return new SkillLibraryStore(config);
}
