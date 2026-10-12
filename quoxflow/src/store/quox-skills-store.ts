/**
 * QuoxSkills Store — QSKL-1
 *
 * Persistence layer for the procedural-knowledge Skills primitive.
 * Distinct from SkillLibraryStore (which stores Crystals / crystallised
 * workflow snapshots). Uses quox_skills table to avoid collision.
 *
 * Pattern mirrors SkillLibraryStore: pg.Pool + in-memory fallback,
 * init() creates table inline, ULID PKs.
 */

import pg from 'pg';
import { ulid } from 'ulid';
import { mirrorSkillToDisk } from './quox-skill-mirror.js';

const { Pool } = pg;

/** Org-ID used for the system-wide seed catalog. Included in list() results by default. */
export const SEED_CATALOG_ORG_ID = 'quox-core@seed';

export interface QuoxSkillsStoreConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
}

export interface QuoxSkillInput {
  orgId: string;
  /** null = org-wide (no team/division scope). DB column scope_id is nullable. */
  scopeId: string | null;
  name: string;
  category: string;
  description: string;
  bodyMd: string;
  tags?: string[];
  bestForAgents?: string[];
  requiredTools?: unknown[];
  relatedSkills?: unknown[];
  delegateTargets?: unknown[];
  llmPreference?: Record<string, unknown>;
  modelDirectives?: Record<string, string>;
  policySatisfies?: string[];
  policyRequired?: string[];
  kind?: string;
  refs?: Record<string, string>;
  scripts?: Record<string, string>;
  tests?: Record<string, unknown>;
  author: string;
  authoringEnvelopeId?: string;
  /**
   * SKILLRIGHTS #478: licence declaration carried over from a SkillRights
   * SKILL.md `license:` frontmatter field. Stored verbatim, never validated
   * against a known list (unknown identifiers pass through, same as the
   * rest of the ecosystem). null/undefined = no declaration (undeclared,
   * never defaulted to a licence).
   */
  license?: string | null;
  /** QSKL-10: seed loader supplies canonical version strings from FS frontmatter. Defaults to '1.0.0'. */
  version?: string;
  /** QSKL-10: seed loader marks all FS-sourced skills as 'stable'. Defaults to 'experimental'. */
  edition?: 'experimental' | 'stable' | 'deprecated' | 'archived';
}

export interface QuoxSkillRecord extends Omit<QuoxSkillInput, 'scopeId' | 'edition'> {
  scopeId: string | null | undefined;
  id: string;
  version: string;
  edition: 'experimental' | 'stable' | 'deprecated' | 'archived';
  lastUsedAt?: string;
  lastPatchedAt?: string;
  lastPatchedBy?: string;
  lastPatchEnvelopeId?: string;
  decayState: string;
  evals: Record<string, unknown>;
  signature?: string;
  signedBy?: string;
  supersededBy?: string;
  /** QSKL-11b: Flag set when rolling 4-week judge avg falls below 3.0. */
  reviewNeeded: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * QSKL-11b: Payload for a single judge evaluation run.
 * Written atomically by setJudgeResult; previous judge moved to judge_history.
 */
export interface JudgeResult {
  scored_at: string;
  scores: {
    clarity: number;
    completeness: number;
    recency: number;
    /** QSKL-11b: null when skill has zero invocations in the drift window; see notes.drift for the reason string. */
    drift: number | null;
  };
  avg_score: number;
  judge_notes: Record<string, unknown>;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  rubric_version: number;
}

/**
 * QSKL-11b: Camel-cased row returned by getRecentInvocations.
 * actionLog: ordered list of action names executed during this invocation.
 * Provides behavioral signal for the judge's drift dimension. Null/empty
 * when the invocation row pre-dates QSKL-7-FIX or used Crystal replay
 * (no LLM action sequence to record).
 */
export interface QuoxSkillInvocationRow {
  id: string;
  agentId: string;
  success: boolean;
  tokensUsed: number;
  costUsd: number;
  latencyMs: number;
  createdAt: string;
  /** Ordered list of action names executed during this invocation. May be empty for pre-fix rows. */
  actionLog: string[];
}

export class QuoxSkillsStore {
  private pool: pg.Pool | null = null;
  private inMemory: QuoxSkillRecord[] = [];
  private useInMemory: boolean;
  /** In-memory invocation rows for test injection (QSKL-11b). Only used in in-memory mode. */
  _inMemoryInvocations: Array<{
    id: string;
    skillId: string;
    agentId: string;
    success: boolean;
    tokensUsed: number;
    costUsd: number;
    latencyMs: number;
    createdAt: string;
    /** QSKL-7-FIX: ordered list of action names executed during this invocation. */
    actionLog?: string[];
  }> = [];

  constructor(config?: QuoxSkillsStoreConfig) {
    this.useInMemory = !config;
    if (config) {
      this.pool = new Pool(config);
    }
  }

  async init(): Promise<void> {
    if (this.useInMemory) return;

    const createTable = `
      CREATE TABLE IF NOT EXISTS quox_skills (
        id                      VARCHAR(26) PRIMARY KEY,
        org_id                  VARCHAR(255) NOT NULL,
        scope_id                VARCHAR(26),
        name                    VARCHAR(255) NOT NULL,
        category                VARCHAR(64) NOT NULL,
        description             TEXT NOT NULL,
        license                 TEXT,
        version                 VARCHAR(16) NOT NULL DEFAULT '1.0.0',
        superseded_by           VARCHAR(26),
        edition                 VARCHAR(16) NOT NULL DEFAULT 'experimental',
        author                  VARCHAR(255) NOT NULL,
        authoring_envelope_id   VARCHAR(26),
        last_patched_by         VARCHAR(255),
        last_patch_envelope_id  VARCHAR(26),
        tags                    JSONB DEFAULT '[]'::jsonb,
        related_skills          JSONB DEFAULT '[]'::jsonb,
        required_tools          JSONB DEFAULT '[]'::jsonb,
        required_capabilities   JSONB DEFAULT '[]'::jsonb,
        best_for_agents         JSONB DEFAULT '[]'::jsonb,
        delegate_targets        JSONB DEFAULT '[]'::jsonb,
        llm_preference          JSONB,
        model_directives        JSONB DEFAULT '{}'::jsonb,
        body_md                 TEXT NOT NULL,
        refs                    JSONB DEFAULT '{}'::jsonb,
        scripts                 JSONB DEFAULT '{}'::jsonb,
        tests                   JSONB DEFAULT '{}'::jsonb,
        kind                    VARCHAR(16) DEFAULT 'procedural',
        policy_satisfies        JSONB DEFAULT '[]'::jsonb,
        policy_required         JSONB DEFAULT '[]'::jsonb,
        signature               TEXT,
        signed_by               VARCHAR(255),
        evals                   JSONB DEFAULT '{}'::jsonb,
        last_used_at            TIMESTAMP WITH TIME ZONE,
        last_patched_at         TIMESTAMP WITH TIME ZONE,
        decay_state             VARCHAR(32) DEFAULT 'active',
        review_needed           BOOLEAN NOT NULL DEFAULT false,
        created_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        UNIQUE (org_id, name, version)
      );

      CREATE INDEX IF NOT EXISTS idx_quox_skills_org            ON quox_skills (org_id);
      CREATE INDEX IF NOT EXISTS idx_quox_skills_category       ON quox_skills (category);
      CREATE INDEX IF NOT EXISTS idx_quox_skills_edition        ON quox_skills (edition);
      CREATE INDEX IF NOT EXISTS idx_quox_skills_last_used      ON quox_skills (last_used_at);
      CREATE INDEX IF NOT EXISTS idx_quox_skills_review_needed  ON quox_skills (review_needed) WHERE review_needed = true;
    `;

    await this.pool!.query(createTable);

    // SKILLRIGHTS #478: idempotent in-place migration for deployments whose
    // quox_skills table predates the license column.
    await this.pool!.query(
      `ALTER TABLE quox_skills ADD COLUMN IF NOT EXISTS license TEXT`
    );
  }

  async create(input: QuoxSkillInput): Promise<QuoxSkillRecord> {
    // Validate required fields
    if (!input.orgId || !input.orgId.trim()) throw new Error('orgId is required');
    // scopeId may be null (org-wide skill, no team/division scope)
    if (input.scopeId !== null && input.scopeId !== undefined && !input.scopeId.trim()) {
      throw new Error('scopeId must be null or a non-empty string');
    }
    if (!input.name || !input.name.trim()) throw new Error('name is required');
    if (!input.category || !input.category.trim()) throw new Error('category is required');
    if (!input.bodyMd || !input.bodyMd.trim()) throw new Error('bodyMd is required');

    const id = ulid();
    const now = new Date().toISOString();
    const version = input.version ?? '1.0.0';
    const edition = input.edition ?? 'experimental';
    const decayState = 'active';

    if (this.useInMemory) {
      // Check UNIQUE(org_id, name, version)
      const exists = this.inMemory.some(
        r => r.orgId === input.orgId && r.name === input.name && r.version === version
      );
      if (exists) {
        throw new Error(
          `Skill with name "${input.name}" and version "${version}" already exists for org "${input.orgId}"`
        );
      }

      const record: QuoxSkillRecord = {
        ...input,
        license: input.license ?? null,
        id,
        version,
        edition,
        decayState,
        evals: {},
        reviewNeeded: false,
        createdAt: now,
        updatedAt: now,
      };
      this.inMemory.push(record);
      await mirrorSkillToDisk(record);
      return record;
    }

    await this.pool!.query(
      `INSERT INTO quox_skills (
        id, org_id, scope_id, name, category, description, license, version, edition,
        author, authoring_envelope_id,
        tags, related_skills, required_tools, best_for_agents, delegate_targets,
        llm_preference, model_directives,
        body_md, refs, scripts, tests, kind,
        policy_satisfies, policy_required,
        evals, decay_state, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11,
        $12, $13, $14, $15, $16,
        $17, $18,
        $19, $20, $21, $22, $23,
        $24, $25,
        $26, $27, $28, $29
      )`,
      [
        id,
        input.orgId,
        input.scopeId ?? null,
        input.name,
        input.category,
        input.description,
        input.license ?? null,
        version,
        edition,
        input.author,
        input.authoringEnvelopeId ?? null,
        JSON.stringify(input.tags ?? []),
        JSON.stringify(input.relatedSkills ?? []),
        JSON.stringify(input.requiredTools ?? []),
        JSON.stringify(input.bestForAgents ?? []),
        JSON.stringify(input.delegateTargets ?? []),
        input.llmPreference ? JSON.stringify(input.llmPreference) : null,
        JSON.stringify(input.modelDirectives ?? {}),
        input.bodyMd,
        JSON.stringify(input.refs ?? {}),
        JSON.stringify(input.scripts ?? {}),
        JSON.stringify(input.tests ?? {}),
        input.kind ?? 'procedural',
        JSON.stringify(input.policySatisfies ?? []),
        JSON.stringify(input.policyRequired ?? []),
        JSON.stringify({}),
        decayState,
        now,
        now,
      ]
    );

    const created = await this.findByIdUnchecked(id) as QuoxSkillRecord;
    await mirrorSkillToDisk(created);
    return created;
  }

  async update(id: string, patch: Partial<Pick<QuoxSkillRecord,
    'description' | 'bodyMd' | 'tags' | 'bestForAgents' | 'requiredTools' |
    'relatedSkills' | 'delegateTargets' | 'llmPreference' | 'modelDirectives' |
    'policySatisfies' | 'policyRequired' | 'refs' | 'scripts' | 'tests' |
    'edition' | 'decayState' | 'lastPatchedBy' | 'lastPatchEnvelopeId' |
    'signature' | 'signedBy' | 'supersededBy' | 'evals' | 'license'
  >> & {
    /**
     * When provided, the new immutable row uses this exact version string
     * instead of bumpMinor(existing.version). Useful for seed loaders that
     * have an authoritative FS version to honour (e.g. v2.5.0 rather than
     * whatever bumpMinor would produce from the stored version).
     *
     * When absent, current bumpMinor behaviour is preserved (backward-compatible).
     */
    explicitVersion?: string;
  }): Promise<QuoxSkillRecord> {
    // Internal self-call: use unchecked since update() is an intra-store operation
    // and the org check was already done at the route/agentic layer before calling update().
    const existing = await this.findByIdUnchecked(id);
    if (!existing) {
      throw new Error(`Skill ${id} not found`);
    }

    // QSKL-5.C: stable-promotion gate — must check BEFORE any mutation
    if (patch.edition === 'stable') {
      const evalTests = (existing.evals as Record<string, unknown>)?.tests as Record<string, unknown> | undefined;
      const skillTests = existing.tests as Record<string, unknown> | undefined;
      const hasSkillTests = skillTests && typeof skillTests === 'object' && Object.keys(skillTests).length > 0;

      if (evalTests) {
        // Test run recorded — check for failures or drift
        if ((evalTests.failed as number) > 0) {
          throw new Error(
            `Cannot promote to stable: skill has ${evalTests.failed} failed test(s). Fix failures before promoting.`
          );
        }
        if (evalTests.drifter === true) {
          throw new Error(
            `Cannot promote to stable: skill is in drifter state. Re-run tests before promoting.`
          );
        }
      } else if (hasSkillTests) {
        // Tests defined but never run — require a test run first
        throw new Error(
          `Cannot promote to stable: skill has tests defined but no test run recorded. Run tests before promoting.`
        );
      }
      // No tests defined and no evals → allow (nothing to fail)
    }

    const now = new Date().toISOString();
    const bodyMdChanged = patch.bodyMd !== undefined && patch.bodyMd !== existing.bodyMd;

    if (bodyMdChanged) {
      // Immutable version row: INSERT new row, mark old row superseded_by
      const newId = ulid();
      // Use explicitVersion when provided (e.g. seed loader honouring FS frontmatter);
      // otherwise fall back to bumpMinor for backward-compatible behaviour.
      const newVersion = patch.explicitVersion ?? this.bumpMinor(existing.version);

      if (this.useInMemory) {
        // Destructure out explicitVersion so it doesn't land on QuoxSkillRecord
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { explicitVersion: _ev, ...patchWithoutExplicit } = patch;
        const newRecord: QuoxSkillRecord = {
          ...existing,
          ...patchWithoutExplicit,
          id: newId,
          version: newVersion,
          supersededBy: undefined,
          createdAt: now,
          updatedAt: now,
        };
        this.inMemory.push(newRecord);
        // Mark old row as superseded
        const oldIdx = this.inMemory.findIndex(r => r.id === id);
        if (oldIdx !== -1) {
          this.inMemory[oldIdx] = { ...this.inMemory[oldIdx], supersededBy: newId };
        }
        await mirrorSkillToDisk(newRecord);
        return newRecord;
      }

      // PG path: insert new row, then update old row's superseded_by
      await this.pool!.query(
        `INSERT INTO quox_skills (
          id, org_id, scope_id, name, category, description, license, version, edition,
          author, authoring_envelope_id,
          tags, related_skills, required_tools, best_for_agents, delegate_targets,
          llm_preference, model_directives,
          body_md, refs, scripts, tests, kind,
          policy_satisfies, policy_required,
          evals, decay_state,
          last_patched_by, last_patch_envelope_id, signature, signed_by,
          created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11,
          $12, $13, $14, $15, $16,
          $17, $18,
          $19, $20, $21, $22, $23,
          $24, $25,
          $26, $27,
          $28, $29, $30, $31,
          $32, $33
        )`,
        [
          newId,
          existing.orgId,
          existing.scopeId ?? null,
          existing.name,
          existing.category,
          patch.description ?? existing.description,
          patch.license !== undefined ? patch.license : (existing.license ?? null),
          newVersion,
          patch.edition ?? existing.edition,
          existing.author,
          existing.authoringEnvelopeId ?? null,
          JSON.stringify(patch.tags ?? existing.tags ?? []),
          JSON.stringify(patch.relatedSkills ?? existing.relatedSkills ?? []),
          JSON.stringify(patch.requiredTools ?? existing.requiredTools ?? []),
          JSON.stringify(patch.bestForAgents ?? existing.bestForAgents ?? []),
          JSON.stringify(patch.delegateTargets ?? existing.delegateTargets ?? []),
          (patch.llmPreference ?? existing.llmPreference)
            ? JSON.stringify(patch.llmPreference ?? existing.llmPreference)
            : null,
          JSON.stringify(patch.modelDirectives ?? existing.modelDirectives ?? {}),
          patch.bodyMd,
          JSON.stringify(patch.refs ?? existing.refs ?? {}),
          JSON.stringify(patch.scripts ?? existing.scripts ?? {}),
          JSON.stringify(patch.tests ?? existing.tests ?? {}),
          existing.kind ?? 'procedural',
          JSON.stringify(patch.policySatisfies ?? existing.policySatisfies ?? []),
          JSON.stringify(patch.policyRequired ?? existing.policyRequired ?? []),
          JSON.stringify(patch.evals ?? existing.evals ?? {}),
          patch.decayState ?? existing.decayState,
          patch.lastPatchedBy ?? existing.lastPatchedBy ?? null,
          patch.lastPatchEnvelopeId ?? existing.lastPatchEnvelopeId ?? null,
          patch.signature ?? existing.signature ?? null,
          patch.signedBy ?? existing.signedBy ?? null,
          now,
          now,
        ]
      );

      await this.pool!.query(
        `UPDATE quox_skills SET superseded_by = $1 WHERE id = $2`,
        [newId, id]
      );

      const newRecord = (await this.findByIdUnchecked(newId))!;
      await mirrorSkillToDisk(newRecord);
      return newRecord;
    }

    // Metadata-only update: in-place mutation, no version bump
    if (this.useInMemory) {
      const idx = this.inMemory.findIndex(r => r.id === id);
      const updated: QuoxSkillRecord = {
        ...existing,
        ...patch,
        id,
        version: existing.version,
        updatedAt: now,
      };
      this.inMemory[idx] = updated;
      return updated;
    }

    // Build PG in-place update for metadata-only changes
    const setClauses: string[] = [];
    const vals: unknown[] = [];
    let p = 1;

    const maybeSet = (col: string, val: unknown, asJson = false) => {
      setClauses.push(`${col} = $${p++}`);
      vals.push(asJson ? JSON.stringify(val) : val);
    };

    if (patch.description !== undefined) maybeSet('description', patch.description);
    if (patch.license !== undefined) maybeSet('license', patch.license);
    if (patch.tags !== undefined) maybeSet('tags', patch.tags, true);
    if (patch.bestForAgents !== undefined) maybeSet('best_for_agents', patch.bestForAgents, true);
    if (patch.requiredTools !== undefined) maybeSet('required_tools', patch.requiredTools, true);
    if (patch.relatedSkills !== undefined) maybeSet('related_skills', patch.relatedSkills, true);
    if (patch.delegateTargets !== undefined) maybeSet('delegate_targets', patch.delegateTargets, true);
    if (patch.llmPreference !== undefined) maybeSet('llm_preference', patch.llmPreference, true);
    if (patch.modelDirectives !== undefined) maybeSet('model_directives', patch.modelDirectives, true);
    if (patch.policySatisfies !== undefined) maybeSet('policy_satisfies', patch.policySatisfies, true);
    if (patch.policyRequired !== undefined) maybeSet('policy_required', patch.policyRequired, true);
    if (patch.refs !== undefined) maybeSet('refs', patch.refs, true);
    if (patch.scripts !== undefined) maybeSet('scripts', patch.scripts, true);
    if (patch.tests !== undefined) maybeSet('tests', patch.tests, true);
    if (patch.edition !== undefined) maybeSet('edition', patch.edition);
    if (patch.decayState !== undefined) maybeSet('decay_state', patch.decayState);
    if (patch.lastPatchedBy !== undefined) maybeSet('last_patched_by', patch.lastPatchedBy);
    if (patch.lastPatchEnvelopeId !== undefined) maybeSet('last_patch_envelope_id', patch.lastPatchEnvelopeId);
    if (patch.signature !== undefined) maybeSet('signature', patch.signature);
    if (patch.signedBy !== undefined) maybeSet('signed_by', patch.signedBy);
    if (patch.supersededBy !== undefined) maybeSet('superseded_by', patch.supersededBy);
    if (patch.evals !== undefined) maybeSet('evals', patch.evals, true);

    setClauses.push(`updated_at = $${p++}`);
    vals.push(now);

    vals.push(id);

    await this.pool!.query(
      `UPDATE quox_skills SET ${setClauses.join(', ')} WHERE id = $${p}`,
      vals
    );

    return (await this.findByIdUnchecked(id))!;
  }

  async findById(id: string, orgId?: string): Promise<QuoxSkillRecord | null> {
    // Org-scoped access only: callers must supply orgId.
    // When orgId is omitted, return null to prevent unscoped cross-org access.
    // Internal/system callers that legitimately need cross-org reads must supply
    // the org_id from their execution context (or use listByOrg/admin paths).
    if (orgId === undefined) return null;

    // list() unions in SEED_CATALOG_ORG_ID rows by default (the system seed
    // catalog is visible to every org) — findById must accept the same rows
    // list() already showed the caller, or every seed skill 404s on lookup
    // right after appearing in the list (fleet #366: all 29 crystals).
    if (this.useInMemory) {
      const record = this.inMemory.find(r => r.id === id) ?? null;
      if (!record) return null;
      if (record.orgId !== orgId && record.orgId !== SEED_CATALOG_ORG_ID) return null;
      return record;
    }

    const result = await this.pool!.query(
      `SELECT * FROM quox_skills WHERE id = $1 AND (org_id = $2 OR org_id = $3)`,
      [id, orgId, SEED_CATALOG_ORG_ID]
    );
    return result.rows[0] ? this.rowToRecord(result.rows[0]) : null;
  }

  /**
   * findByIdUnchecked — internal/admin path: bypasses org_id filter.
   * Use ONLY in system jobs (stale-flag, judge) that process skills across orgs
   * and have no user org context. Do NOT expose via any API route.
   */
  async findByIdUnchecked(id: string): Promise<QuoxSkillRecord | null> {
    if (this.useInMemory) {
      return this.inMemory.find(r => r.id === id) ?? null;
    }
    const result = await this.pool!.query(
      `SELECT * FROM quox_skills WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? this.rowToRecord(result.rows[0]) : null;
  }

  async findByName(opts: { orgId: string; name: string; version?: string }): Promise<QuoxSkillRecord | null> {
    if (this.useInMemory) {
      const matches = this.inMemory.filter(
        r => r.orgId === opts.orgId && r.name === opts.name
      );
      if (matches.length === 0) return null;
      if (opts.version) {
        return matches.find(r => r.version === opts.version) ?? null;
      }
      // Latest version: sort by semver, pick last
      return matches.slice().sort((a, b) => this.compareSemver(a.version, b.version)).pop() ?? null;
    }

    if (opts.version) {
      const result = await this.pool!.query(
        `SELECT * FROM quox_skills WHERE org_id = $1 AND name = $2 AND version = $3 LIMIT 1`,
        [opts.orgId, opts.name, opts.version]
      );
      return result.rows[0] ? this.rowToRecord(result.rows[0]) : null;
    }

    // Latest: order by version desc — simple string sort is fine for semver here
    const result = await this.pool!.query(
      `SELECT * FROM quox_skills WHERE org_id = $1 AND name = $2
       ORDER BY created_at DESC LIMIT 1`,
      [opts.orgId, opts.name]
    );
    return result.rows[0] ? this.rowToRecord(result.rows[0]) : null;
  }

  async list(opts: {
    orgId: string;
    category?: string;
    edition?: string;
    agentId?: string;
    tag?: string;
    limit?: number;
    includeAllVersions?: boolean;
    /**
     * When true (default), rows from the system seed catalog (SEED_CATALOG_ORG_ID)
     * are unioned into the result alongside the caller's own org rows.
     * Set to false for admin/audit queries that need strict org isolation.
     */
    includeSeedCatalog?: boolean;
    /**
     * QSKL-AP-1: Optional ordering column. Supported values: 'last_used_at', 'created_at'.
     * Defaults to 'created_at' if not specified.
     */
    orderBy?: 'last_used_at' | 'created_at';
    /** QSKL-AP-1: Sort direction. Defaults to 'desc'. */
    order?: 'asc' | 'desc';
  }): Promise<QuoxSkillRecord[]> {
    const limit = opts.limit ?? 100;
    const includeAll = opts.includeAllVersions ?? false;
    // Default true: seed catalog is visible to all orgs unless explicitly excluded
    const includeSeed = (opts.includeSeedCatalog ?? true) && opts.orgId !== SEED_CATALOG_ORG_ID;
    // QSKL-AP-1: Validated ordering — only allow known safe column names.
    const safeOrderBy = opts.orderBy === 'last_used_at' ? 'last_used_at' : 'created_at';
    const safeOrder = opts.order === 'asc' ? 'ASC' : 'DESC';

    if (this.useInMemory) {
      // Collect matching org IDs for the filter
      let records = this.inMemory.filter(r =>
        r.orgId === opts.orgId || (includeSeed && r.orgId === SEED_CATALOG_ORG_ID)
      );

      if (!includeAll) {
        // Return only the latest version per (orgId, name): keep highest semver per name
        // Key includes orgId so that org-A and seed-catalog rows with the same name
        // are treated as separate entries (not deduped against each other).
        const latestMap = new Map<string, QuoxSkillRecord>();
        for (const r of records) {
          const key = `${r.orgId}\0${r.name}`;
          const existing = latestMap.get(key);
          if (!existing || this.compareSemver(r.version, existing.version) > 0) {
            latestMap.set(key, r);
          }
        }
        records = Array.from(latestMap.values());
      }

      if (opts.category) records = records.filter(r => r.category === opts.category);
      if (opts.edition) records = records.filter(r => r.edition === opts.edition);
      if (opts.agentId) {
        records = records.filter(r =>
          Array.isArray(r.bestForAgents) && r.bestForAgents.includes(opts.agentId!)
        );
      }
      if (opts.tag) {
        records = records.filter(r =>
          Array.isArray(r.tags) && r.tags.includes(opts.tag!)
        );
      }
      // QSKL-AP-1: apply ordering for in-memory path
      if (safeOrderBy === 'last_used_at') {
        records.sort((a, b) => {
          const aVal = a.lastUsedAt ?? a.createdAt ?? '';
          const bVal = b.lastUsedAt ?? b.createdAt ?? '';
          return safeOrder === 'ASC' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
        });
      } else {
        records.sort((a, b) => {
          const aVal = a.createdAt ?? '';
          const bVal = b.createdAt ?? '';
          return safeOrder === 'ASC' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
        });
      }
      return records.slice(0, limit);
    }

    // PG path: build org filter clause
    let orgCondition: string;
    const vals: unknown[] = [];
    let p = 1;

    if (includeSeed) {
      orgCondition = `(org_id = $${p++} OR org_id = $${p++})`;
      vals.push(opts.orgId, SEED_CATALOG_ORG_ID);
    } else {
      orgCondition = `org_id = $${p++}`;
      vals.push(opts.orgId);
    }

    const conditions: string[] = [orgCondition];

    if (opts.category) { conditions.push(`category = $${p++}`); vals.push(opts.category); }
    if (opts.edition) { conditions.push(`edition = $${p++}`); vals.push(opts.edition); }
    if (opts.agentId) {
      conditions.push(`best_for_agents @> $${p++}::jsonb`);
      vals.push(JSON.stringify([opts.agentId]));
    }
    if (opts.tag) {
      conditions.push(`tags @> $${p++}::jsonb`);
      vals.push(JSON.stringify([opts.tag]));
    }

    vals.push(limit);

    if (!includeAll) {
      // Latest version per (org_id, name): use DISTINCT ON ordered by version desc.
      // QSKL-AP-1: after deduplication, apply requested ordering via sub-select.
      const result = await this.pool!.query(
        `SELECT * FROM (
           SELECT DISTINCT ON (org_id, name) * FROM quox_skills
           WHERE ${conditions.join(' AND ')}
           ORDER BY org_id, name, created_at DESC
         ) deduped
         ORDER BY ${safeOrderBy} ${safeOrder} NULLS LAST
         LIMIT $${p}`,
        vals
      );
      return result.rows.map(row => this.rowToRecord(row));
    }

    const result = await this.pool!.query(
      `SELECT * FROM quox_skills WHERE ${conditions.join(' AND ')}
       ORDER BY ${safeOrderBy} ${safeOrder} NULLS LAST LIMIT $${p}`,
      vals
    );
    return result.rows.map(row => this.rowToRecord(row));
  }

  async delete(id: string): Promise<boolean> {
    if (this.useInMemory) {
      const idx = this.inMemory.findIndex(r => r.id === id);
      if (idx === -1) return false;
      this.inMemory.splice(idx, 1);
      return true;
    }

    const result = await this.pool!.query(
      `DELETE FROM quox_skills WHERE id = $1`,
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listVersions(opts: { orgId: string; name: string }): Promise<QuoxSkillRecord[]> {
    if (this.useInMemory) {
      return this.inMemory
        .filter(r => r.orgId === opts.orgId && r.name === opts.name)
        .slice()
        .sort((a, b) => this.compareSemver(a.version, b.version));
    }

    const result = await this.pool!.query(
      `SELECT * FROM quox_skills WHERE org_id = $1 AND name = $2 ORDER BY created_at ASC`,
      [opts.orgId, opts.name]
    );
    return result.rows.map(row => this.rowToRecord(row));
  }

  async setLastUsed(id: string, at?: string): Promise<void> {
    const ts = at ?? new Date().toISOString();

    if (this.useInMemory) {
      const rec = this.inMemory.find(r => r.id === id);
      if (rec) rec.lastUsedAt = ts;
      return;
    }

    await this.pool!.query(
      `UPDATE quox_skills SET last_used_at = $1 WHERE id = $2`,
      [ts, id]
    );
  }

  /**
   * Merge a patch object into `quox_skills.evals` for the given skill.
   *
   * Uses a JSONB-merge approach (existing evals || patch) so callers only
   * need to supply the keys they want to change. Idempotent: applying the
   * same patch twice produces the same result.
   */
  async updateEvals(skillId: string, patch: Record<string, unknown>): Promise<void> {
    if (this.useInMemory) {
      const rec = this.inMemory.find(r => r.id === skillId);
      if (!rec) return; // no-op for unknown id
      rec.evals = { ...((rec.evals as Record<string, unknown>) ?? {}), ...patch };
      return;
    }

    await this.pool!.query(
      `UPDATE quox_skills
          SET evals      = COALESCE(evals, '{}'::jsonb) || $1::jsonb,
              updated_at = NOW()
        WHERE id = $2`,
      [JSON.stringify(patch), skillId]
    );
  }

  /**
   * QSKL-11a: List skills with edition='stable' whose last_used_at is older than
   * `daysIdle` days ago. last_used_at IS NULL → excluded (never-invoked skills do not decay).
   */
  async listStaleStableSkills(daysIdle: number, now?: Date): Promise<QuoxSkillRecord[]> {
    if (this.useInMemory) {
      const cutoff = new Date((now ?? new Date()).getTime() - daysIdle * 86400000);
      return this.inMemory.filter(r => {
        if (r.edition !== 'stable') return false;
        if (!r.lastUsedAt) return false;
        return new Date(r.lastUsedAt) < cutoff;
      });
    }

    const result = await this.pool!.query(
      `SELECT * FROM quox_skills
       WHERE edition = 'stable'
         AND last_used_at IS NOT NULL
         AND last_used_at < NOW() - ($1::int || ' days')::interval`,
      [daysIdle]
    );
    return result.rows.map(row => this.rowToRecord(row));
  }

  /**
   * MEM-DECAY MD.2: List skills currently decay_state='active' whose
   * last_used_at falls in the window [coolingDays, archiveDays) — i.e. idle
   * long enough to dim, but not yet at the archive-candidate threshold.
   * Excludes last_used_at IS NULL (seed-catalog / never-invoked skills never
   * enter idle-based decay — guardrail per STREAM_MEM_DECAY_PLAN_V2 §11 S2).
   * Bounding the window at archiveDays keeps this pass additive: skills that
   * are already past the archive threshold are handled by
   * listVeryStaleSkills below and are not double-touched here.
   */
  async listCoolingCandidateSkills(
    coolingDays: number,
    archiveDays: number,
    now?: Date,
  ): Promise<QuoxSkillRecord[]> {
    const currentNow = now ?? new Date();

    if (this.useInMemory) {
      const coolingCutoff = new Date(currentNow.getTime() - coolingDays * 86400000);
      const archiveCutoff = new Date(currentNow.getTime() - archiveDays * 86400000);
      return this.inMemory.filter(r => {
        if (r.decayState !== 'active') return false;
        if (!r.lastUsedAt) return false;
        const lastUsed = new Date(r.lastUsedAt);
        return lastUsed < coolingCutoff && lastUsed >= archiveCutoff;
      });
    }

    const result = await this.pool!.query(
      `SELECT * FROM quox_skills
       WHERE decay_state = 'active'
         AND last_used_at IS NOT NULL
         AND last_used_at < NOW() - ($1::int || ' days')::interval
         AND last_used_at >= NOW() - ($2::int || ' days')::interval`,
      [coolingDays, archiveDays]
    );
    return result.rows.map(row => this.rowToRecord(row));
  }

  /**
   * QSKL-11a: List skills (any edition) whose last_used_at is older than
   * `daysIdle` days ago AND whose decay_state is NOT already 'archive_candidate'.
   * Excludes last_used_at IS NULL.
   */
  async listVeryStaleSkills(daysIdle: number, now?: Date): Promise<QuoxSkillRecord[]> {
    if (this.useInMemory) {
      const cutoff = new Date((now ?? new Date()).getTime() - daysIdle * 86400000);
      return this.inMemory.filter(r => {
        if (!r.lastUsedAt) return false;
        if (r.decayState === 'archive_candidate') return false;
        return new Date(r.lastUsedAt) < cutoff;
      });
    }

    const result = await this.pool!.query(
      `SELECT * FROM quox_skills
       WHERE last_used_at IS NOT NULL
         AND decay_state != 'archive_candidate'
         AND last_used_at < NOW() - ($1::int || ' days')::interval`,
      [daysIdle]
    );
    return result.rows.map(row => this.rowToRecord(row));
  }

  /**
   * QSKL-11b: List stable skills due for re-judging.
   * - Never-judged: evals.judge.scored_at IS NULL/missing.
   * - Or last judged > weekIntervalDays ago.
   */
  async listSkillsForJudging(now: Date, weekIntervalDays: number = 7): Promise<QuoxSkillRecord[]> {
    if (this.useInMemory) {
      const cutoff = new Date(now.getTime() - weekIntervalDays * 86400000);
      return this.inMemory.filter(r => {
        if (r.edition !== 'stable') return false;
        const judge = ((r.evals as Record<string, unknown>)?.judge) as Record<string, unknown> | undefined;
        if (!judge || !judge.scored_at) return true; // never judged
        return new Date(judge.scored_at as string) < cutoff; // judged too long ago
      });
    }

    const result = await this.pool!.query(
      `SELECT * FROM quox_skills
       WHERE edition = 'stable'
         AND (
           evals->>'judge' IS NULL
           OR (evals->'judge'->>'scored_at') IS NULL
           OR (evals->'judge'->>'scored_at')::timestamptz < NOW() - ($1::int || ' days')::interval
         )`,
      [weekIntervalDays]
    );
    return result.rows.map(row => this.rowToRecord(row));
  }

  /**
   * QSKL-5.F: List all stable-edition skills across every org, for the daily
   * skill-tests cron sweep. Cross-org by design (mirrors listSkillsForJudging /
   * listStaleStableSkills) — the cron runs at the system level, not scoped to
   * a single caller's org, so it cannot use list() which requires an orgId.
   */
  async listAllStableSkills(): Promise<QuoxSkillRecord[]> {
    if (this.useInMemory) {
      return this.inMemory.filter(r => r.edition === 'stable');
    }

    const result = await this.pool!.query(
      `SELECT * FROM quox_skills WHERE edition = 'stable'`
    );
    return result.rows.map(row => this.rowToRecord(row));
  }

  /**
   * MEM-DECAY MD.3: List all experimental-edition skills across every org, for
   * the skill-decay-cron success-rate branch, which joins these against
   * skill_scoreboard rows by skill_id. Cross-org by design, mirrors
   * listAllStableSkills — the cron runs at the system level.
   */
  async listAllExperimentalSkills(): Promise<QuoxSkillRecord[]> {
    if (this.useInMemory) {
      return this.inMemory.filter(r => r.edition === 'experimental');
    }

    const result = await this.pool!.query(
      `SELECT * FROM quox_skills WHERE edition = 'experimental'`
    );
    return result.rows.map(row => this.rowToRecord(row));
  }

  /**
   * SKILLRIGHTS-BRIDGE: List every skill row across every org and edition, for
   * the filesystem mirror backfill (src/cli-mirror-backfill.ts). Cross-org and
   * cross-edition by design, mirroring listAllStableSkills — the backfill runs
   * at the system level, reconstructing the on-disk mirror for rows that were
   * written while QUOX_SKILLS_MIRROR_PATH was unset.
   *
   * Returns EVERY version row, not just the latest per name: the mirror keys
   * by category/name, so later rows overwrite earlier ones and the newest
   * version wins when callers iterate in created_at order.
   */
  async listAllSkills(): Promise<QuoxSkillRecord[]> {
    if (this.useInMemory) {
      return this.inMemory.slice();
    }

    const result = await this.pool!.query(
      `SELECT * FROM quox_skills ORDER BY created_at ASC`
    );
    return result.rows.map(row => this.rowToRecord(row));
  }

  /**
   * QSKL-11b: Atomically write evals.judge, prepending previous judge entry to
   * evals.judge_history (capped at 12 entries, oldest dropped).
   *
   * History ordering: NEW entries are prepended (index 0 = most recent in history),
   * so the array is newest-first. After cap, oldest entries are dropped from the tail.
   */
  async setJudgeResult(skillId: string, judge: JudgeResult): Promise<void> {
    if (this.useInMemory) {
      const rec = this.inMemory.find(r => r.id === skillId);
      if (!rec) return;
      const evalsObj = (rec.evals as Record<string, unknown>) ?? {};
      const prevJudge = evalsObj.judge as Record<string, unknown> | undefined;
      const prevHistory = (evalsObj.judge_history as unknown[]) ?? [];

      // Prepend old judge entry to history (newest-first ordering), cap at 12
      const newHistory = prevJudge
        ? [prevJudge, ...prevHistory].slice(0, 12)
        : prevHistory.slice(0, 12);

      rec.evals = {
        ...evalsObj,
        judge,
        judge_history: newHistory,
      };
      return;
    }

    // PG: read current evals.judge + judge_history, compute new history, write atomically
    const existing = await this.pool!.query(
      `SELECT evals FROM quox_skills WHERE id = $1`,
      [skillId]
    );
    if (existing.rows.length === 0) return;
    const evalsObj = (existing.rows[0].evals as Record<string, unknown>) ?? {};
    const prevJudge = evalsObj.judge as Record<string, unknown> | undefined;
    const prevHistory = (evalsObj.judge_history as unknown[]) ?? [];
    const newHistory = prevJudge
      ? [prevJudge, ...prevHistory].slice(0, 12)
      : prevHistory.slice(0, 12);

    await this.pool!.query(
      `UPDATE quox_skills
          SET evals      = evals
                        || jsonb_build_object('judge', $1::jsonb)
                        || jsonb_build_object('judge_history', $2::jsonb),
              updated_at = NOW()
        WHERE id = $3`,
      [JSON.stringify(judge), JSON.stringify(newHistory), skillId]
    );
  }

  /** QSKL-11b: Toggle review_needed flag. */
  async setReviewNeeded(skillId: string, value: boolean): Promise<void> {
    if (this.useInMemory) {
      const rec = this.inMemory.find(r => r.id === skillId);
      if (rec) rec.reviewNeeded = value;
      return;
    }

    await this.pool!.query(
      `UPDATE quox_skills SET review_needed = $1, updated_at = NOW() WHERE id = $2`,
      [value, skillId]
    );
  }

  /** QSKL-11b: List skills with review_needed=true. */
  async listReviewNeededSkills(): Promise<QuoxSkillRecord[]> {
    if (this.useInMemory) {
      return this.inMemory.filter(r => r.reviewNeeded === true);
    }

    const result = await this.pool!.query(
      `SELECT * FROM quox_skills WHERE review_needed = true`
    );
    return result.rows.map(row => this.rowToRecord(row));
  }

  /** QSKL-11b: Read recent invocations for the drift dimension. */
  async getRecentInvocations(skillId: string, days: number, limit: number): Promise<QuoxSkillInvocationRow[]> {
    if (this.useInMemory) {
      const cutoff = new Date(Date.now() - days * 86400000);
      return this._inMemoryInvocations
        .filter(r => r.skillId === skillId && new Date(r.createdAt) >= cutoff)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, limit)
        .map(r => ({
          id: r.id,
          agentId: r.agentId,
          success: r.success,
          tokensUsed: r.tokensUsed,
          costUsd: r.costUsd,
          latencyMs: r.latencyMs,
          createdAt: r.createdAt,
          // QSKL-7-FIX: pass through actionLog for drift signal in judge prompt
          actionLog: r.actionLog ?? [],
        }));
    }

    const result = await this.pool!.query(
      `SELECT id, agent_id, success, tokens_used, cost_usd, latency_ms, created_at
         FROM quox_skill_invocations
        WHERE skill_id = $1
          AND created_at >= NOW() - ($2::int || ' days')::interval
        ORDER BY created_at DESC
        LIMIT $3`,
      [skillId, days, limit]
    );
    return result.rows.map(row => ({
      id: row.id as string,
      agentId: row.agent_id as string,
      success: row.success as boolean,
      tokensUsed: row.tokens_used as number,
      costUsd: parseFloat(row.cost_usd as string),
      latencyMs: row.latency_ms as number,
      createdAt: row.created_at instanceof Date
        ? row.created_at.toISOString()
        : String(row.created_at),
      // QSKL-7-FIX: action_log column does not exist in quox_skill_invocations yet;
      // returns empty array for all existing rows. Populated once the column lands.
      actionLog: [] as string[],
    }));
  }

  /**
   * Test injection helper (in-memory mode only).
   * Seeds fake invocation rows for getRecentInvocations tests.
   */
  _seedInvocations(rows: Array<{
    id: string;
    skillId: string;
    agentId: string;
    success: boolean;
    tokensUsed: number;
    costUsd: number;
    latencyMs: number;
    createdAt: string;
    /** QSKL-7-FIX: optional ordered list of action names for drift signal. */
    actionLog?: string[];
  }>): void {
    this._inMemoryInvocations.push(...rows);
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private rowToRecord(row: Record<string, unknown>): QuoxSkillRecord {
    return {
      id: row.id as string,
      orgId: row.org_id as string,
      scopeId: row.scope_id as string | undefined,
      name: row.name as string,
      category: row.category as string,
      description: row.description as string,
      license: (row.license as string | null | undefined) ?? null,
      version: row.version as string,
      edition: row.edition as 'experimental' | 'stable' | 'deprecated' | 'archived',
      supersededBy: row.superseded_by as string | undefined,
      author: row.author as string,
      authoringEnvelopeId: row.authoring_envelope_id as string | undefined,
      lastPatchedBy: row.last_patched_by as string | undefined,
      lastPatchEnvelopeId: row.last_patch_envelope_id as string | undefined,
      tags: this.parseJson(row.tags, []) as string[],
      relatedSkills: this.parseJson(row.related_skills, []) as unknown[],
      requiredTools: this.parseJson(row.required_tools, []) as unknown[],
      bestForAgents: this.parseJson(row.best_for_agents, []) as string[],
      delegateTargets: this.parseJson(row.delegate_targets, []) as unknown[],
      llmPreference: this.parseJson(row.llm_preference, undefined) as Record<string, unknown> | undefined,
      modelDirectives: this.parseJson(row.model_directives, {}) as Record<string, string>,
      bodyMd: row.body_md as string,
      refs: this.parseJson(row.refs, {}) as Record<string, string>,
      scripts: this.parseJson(row.scripts, {}) as Record<string, string>,
      tests: this.parseJson(row.tests, {}) as Record<string, unknown>,
      kind: row.kind as string | undefined,
      policySatisfies: this.parseJson(row.policy_satisfies, []) as string[],
      policyRequired: this.parseJson(row.policy_required, []) as string[],
      signature: row.signature as string | undefined,
      signedBy: row.signed_by as string | undefined,
      evals: this.parseJson(row.evals, {}) as Record<string, unknown>,
      reviewNeeded: row.review_needed === true || row.review_needed === 'true',
      lastUsedAt: row.last_used_at
        ? (row.last_used_at instanceof Date
          ? row.last_used_at.toISOString()
          : String(row.last_used_at))
        : undefined,
      lastPatchedAt: row.last_patched_at
        ? (row.last_patched_at instanceof Date
          ? row.last_patched_at.toISOString()
          : String(row.last_patched_at))
        : undefined,
      decayState: row.decay_state as string,
      createdAt: row.created_at instanceof Date
        ? (row.created_at as Date).toISOString()
        : String(row.created_at),
      updatedAt: row.updated_at instanceof Date
        ? (row.updated_at as Date).toISOString()
        : String(row.updated_at),
    };
  }

  private parseJson(val: unknown, fallback: unknown): unknown {
    if (val === null || val === undefined) return fallback;
    if (typeof val === 'string') {
      try { return JSON.parse(val); } catch { return fallback; }
    }
    return val; // PG driver already parsed JSONB
  }

  private bumpMinor(version: string): string {
    const parts = version.split('.');
    const major = parseInt(parts[0] ?? '1', 10);
    const minor = parseInt(parts[1] ?? '0', 10);
    return `${major}.${minor + 1}.0`;
  }

  private bumpPatch(version: string): string {
    const parts = version.split('.');
    const major = parseInt(parts[0] ?? '1', 10);
    const minor = parseInt(parts[1] ?? '0', 10);
    const patch = parseInt(parts[2] ?? '0', 10);
    return `${major}.${minor}.${patch + 1}`;
  }

  private compareSemver(a: string, b: string): number {
    const parse = (v: string) => v.split('.').map(n => parseInt(n, 10));
    const av = parse(a);
    const bv = parse(b);
    for (let i = 0; i < 3; i++) {
      const diff = (av[i] ?? 0) - (bv[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }
}

/** Factory for in-memory mode (tests / dev) */
export function createInMemoryQuoxSkillsStore(): QuoxSkillsStore {
  return new QuoxSkillsStore();
}
