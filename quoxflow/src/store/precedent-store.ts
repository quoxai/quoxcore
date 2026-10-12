/**
 * Precedent Store — AOCL judgment-call precedent tracking.
 *
 * When a judgment-call resolution (HITL-resolved or agent-autonomous) is
 * disposed of, the resolution can be persisted here as a precedent: the
 * fact pattern that was judged, the ratio (the operative reasoning that
 * generalises beyond this one case), the disposition reached, and who/what
 * had the authority to reach it. Future resolutions of a similar fact
 * pattern are expected to either follow or explicitly distinguish an
 * active precedent — see src/pipeline/precedent-gate.ts for the fail-closed
 * enforcement that checks this.
 *
 * Pattern mirrors SkillLibraryStore (skill-library-store.ts): pg.Pool +
 * in-memory fallback, init() creates table with CREATE TABLE IF NOT EXISTS,
 * ULID PKs, an injectable Ed25519 crystalSigner for the canonical-hash /
 * signature columns.
 */

import pg from 'pg';
import { ulid } from 'ulid';
import { logger } from '../logger.js';
import { hashSnapshot } from './crystal-canonical-hash.js';

const { Pool } = pg;

const log = logger.for('PrecedentStore');

export type PrecedentAuthority = 'agent-autonomous' | 'hitl-approved' | 'owner';
export type PrecedentStatus = 'active' | 'overruled' | 'superseded';
export type PrecedentSignatureStatus = 'signed' | 'unsigned' | 'pending';

export interface PrecedentStoreConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
}

export interface PrecedentWriteInput {
  orgId: string;
  /** The judged fact pattern. Its top-level keys double as the "context
   * keys" used for fuzzy overlap matching in findApplicable() when no
   * exact fact_pattern_hash match exists — see that method's doc comment. */
  factPattern: Record<string, unknown>;
  /** sha256 hex digest of factPattern, via hashSnapshot() — reused verbatim
   * from the Crystal canonical-hash algorithm so both stores are consistent. */
  factPatternHash?: string;
  /** The operative reasoning that generalises beyond this one case. */
  ratio: string;
  disposition: Record<string, unknown>;
  authority: PrecedentAuthority;
  status?: PrecedentStatus;
  overruledBy?: string;
  overruleApprovalId?: string;
  citationCount?: number;
  lastCitedAt?: string;
  canonicalHash?: string;
  signature?: string;
  signedBy?: string;
  sigAlgorithm?: string;
  signedAt?: string;
  signatureStatus?: PrecedentSignatureStatus;
}

export interface PrecedentRecord extends PrecedentWriteInput {
  id: string;
  factPatternHash: string;
  status: PrecedentStatus;
  citationCount: number;
  signatureStatus: PrecedentSignatureStatus;
  createdAt: string;
  updatedAt: string;
}

/** Mirrors SkillLibraryStore's CrystalSigner injection (skill-library-store.ts). */
export type PrecedentSigner = (params: { orgId: string; hash: string }) => Promise<{
  signature: string;
  key_id: string;
  algorithm: string;
} | null>;

export interface FindApplicablePrecedentOptions {
  orgId: string;
  /** Exact-match lookup — checked first. When it hits, contextKeys is ignored. */
  factPatternHash?: string;
  /** Fallback fuzzy match: overlap against each active precedent's own
   * fact_pattern top-level keys. */
  contextKeys?: string[];
  maxResults?: number;
  /** When false (default true), overruled/superseded precedents are excluded. */
  includeInactive?: boolean;
}

export class PrecedentStore {
  private pool: pg.Pool | null = null;
  private inMemory: PrecedentRecord[] = [];
  private useInMemory: boolean;
  private signer?: PrecedentSigner;

  constructor(config?: PrecedentStoreConfig) {
    this.useInMemory = !config;
    if (config) {
      this.pool = new Pool(config);
    }
  }

  /** Inject the auth crystal-signing-oracle HTTP client (same oracle used by SkillLibraryStore). */
  setSigner(signer: PrecedentSigner): void {
    this.signer = signer;
  }

  async init(): Promise<void> {
    if (this.useInMemory) return;

    const createTable = `
      CREATE TABLE IF NOT EXISTS precedent_store (
        id                    VARCHAR(26) PRIMARY KEY,
        org_id                VARCHAR(255) NOT NULL,
        fact_pattern          JSONB NOT NULL,
        fact_pattern_hash     TEXT NOT NULL,
        ratio                 TEXT NOT NULL,
        disposition           JSONB NOT NULL,
        authority             TEXT NOT NULL CHECK (authority IN ('agent-autonomous', 'hitl-approved', 'owner')),
        status                TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'overruled', 'superseded')),
        overruled_by          VARCHAR(26),
        overrule_approval_id  VARCHAR(255),
        citation_count        INT NOT NULL DEFAULT 0,
        last_cited_at         TIMESTAMPTZ,
        canonical_hash        TEXT,
        signature             TEXT,
        signed_by             TEXT,
        sig_algorithm         TEXT,
        signed_at             TIMESTAMPTZ,
        signature_status      TEXT DEFAULT 'unsigned',
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_precedent_store_org_hash
        ON precedent_store(org_id, fact_pattern_hash);

      CREATE INDEX IF NOT EXISTS idx_precedent_store_org_status
        ON precedent_store(org_id, status);

      CREATE INDEX IF NOT EXISTS idx_precedent_store_citation_rank
        ON precedent_store(org_id, status, citation_count DESC, last_cited_at DESC);
    `;

    await this.pool!.query(createTable);
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
    }
  }

  /**
   * Write a new precedent. If input.factPatternHash is not supplied it is
   * computed here via hashSnapshot(input.factPattern), the same algorithm
   * skill-library-store.ts uses for Crystal action snapshots.
   */
  async write(input: PrecedentWriteInput): Promise<PrecedentRecord> {
    const factPatternHash = input.factPatternHash ?? hashSnapshot(input.factPattern);
    const status: PrecedentStatus = input.status ?? 'active';
    const citationCount = input.citationCount ?? 0;
    const signatureStatus: PrecedentSignatureStatus = input.signatureStatus ?? 'unsigned';
    const id = ulid();
    const now = new Date().toISOString();

    const record: PrecedentRecord = {
      ...input,
      factPatternHash,
      status,
      citationCount,
      signatureStatus,
      id,
      createdAt: now,
      updatedAt: now,
    };

    if (this.useInMemory) {
      this.inMemory.push(record);
      return record;
    }

    await this.pool!.query(
      `INSERT INTO precedent_store (
        id, org_id, fact_pattern, fact_pattern_hash, ratio, disposition,
        authority, status, overruled_by, overrule_approval_id,
        citation_count, last_cited_at, canonical_hash, signature,
        signed_by, sig_algorithm, signed_at, signature_status,
        created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        id,
        input.orgId,
        JSON.stringify(input.factPattern),
        factPatternHash,
        input.ratio,
        JSON.stringify(input.disposition),
        input.authority,
        status,
        input.overruledBy ?? null,
        input.overruleApprovalId ?? null,
        citationCount,
        input.lastCitedAt ?? null,
        input.canonicalHash ?? null,
        input.signature ?? null,
        input.signedBy ?? null,
        input.sigAlgorithm ?? null,
        input.signedAt ?? null,
        signatureStatus,
        now,
        now,
      ],
    );

    return record;
  }

  /**
   * Sign-before-commit hook, mirroring SkillLibraryStore.signCrystal(). Pure
   * best-effort: never throws — a signer failure or absence commits with
   * signature_status='pending'/'unsigned' rather than blocking the write.
   */
  async signPrecedent(params: { orgId: string; factPattern: Record<string, unknown> }): Promise<{
    canonicalHash: string;
    signatureStatus: PrecedentSignatureStatus;
    signature?: string;
    signedBy?: string;
    sigAlgorithm?: string;
    signedAt?: string;
  }> {
    const canonicalHash = hashSnapshot(params.factPattern);

    if (!this.signer) {
      return { canonicalHash, signatureStatus: 'unsigned' };
    }

    try {
      const result = await this.signer({ orgId: params.orgId, hash: canonicalHash });
      if (!result) {
        log.warn(`signPrecedent: signer returned null for org ${params.orgId} — committing with signature_status='pending'`);
        return { canonicalHash, signatureStatus: 'pending' };
      }
      return {
        canonicalHash,
        signatureStatus: 'signed',
        signature: result.signature,
        signedBy: result.key_id,
        sigAlgorithm: result.algorithm,
        signedAt: new Date().toISOString(),
      };
    } catch (err) {
      log.warn(`signPrecedent: signer threw for org ${params.orgId} — committing with signature_status='pending': ${err instanceof Error ? err.message : String(err)}`);
      return { canonicalHash, signatureStatus: 'pending' };
    }
  }

  /**
   * Find precedents applicable to a judgment call.
   *
   * Match strategy (mirrors SkillLibraryStore.findApplicable, skill-library-store.ts:512-551):
   *   1. Exact match on fact_pattern_hash, if provided — the strongest possible
   *      signal (this is literally the same fact pattern as before).
   *   2. Otherwise, fuzzy: keyword overlap between opts.contextKeys and each
   *      candidate's own fact_pattern top-level keys.
   * Ranking (both paths): citation_count (normalised 0..1 across the matched
   * set) × 0.8 + recency × 0.2 — same weighting as the Crystal ranking formula.
   * Only status='active' precedents are returned unless includeInactive is set.
   */
  async findApplicable(opts: FindApplicablePrecedentOptions): Promise<PrecedentRecord[]> {
    const { orgId, factPatternHash, contextKeys = [], maxResults = 5, includeInactive = false } = opts;

    const pool = this.useInMemory ? null : this.pool!;
    const candidates: PrecedentRecord[] = this.useInMemory
      ? this.inMemory.filter(r => r.orgId === orgId && (includeInactive || r.status === 'active'))
      : (
        await pool!.query(
          includeInactive
            ? `SELECT * FROM precedent_store WHERE org_id = $1`
            : `SELECT * FROM precedent_store WHERE org_id = $1 AND status = 'active'`,
          [orgId],
        )
      ).rows.map((row: Record<string, unknown>) => this.rowToRecord(row));

    let matched: PrecedentRecord[];
    if (factPatternHash) {
      matched = candidates.filter(r => r.factPatternHash === factPatternHash);
      // Fall through to fuzzy matching only if the exact hash misses entirely.
      if (matched.length === 0 && contextKeys.length > 0) {
        matched = candidates.filter(r => this.hasKeyOverlap(r.factPattern, contextKeys));
      }
    } else if (contextKeys.length > 0) {
      matched = candidates.filter(r => this.hasKeyOverlap(r.factPattern, contextKeys));
    } else {
      matched = [];
    }

    return this.rankAndSlice(matched, maxResults);
  }

  private hasKeyOverlap(factPattern: Record<string, unknown>, contextKeys: string[]): boolean {
    const patternKeys = Object.keys(factPattern ?? {});
    return patternKeys.some(k => contextKeys.includes(k));
  }

  private rankAndSlice(matched: PrecedentRecord[], maxResults: number): PrecedentRecord[] {
    if (matched.length === 0) return [];

    const maxCitations = Math.max(...matched.map(r => r.citationCount), 1);
    const createdAts = matched.map(r => new Date(r.createdAt).getTime());
    const minTs = Math.min(...createdAts);
    const maxTs = Math.max(...createdAts);
    const tsRange = maxTs - minTs || 1;

    const scored = matched.map(r => {
      const citationScore = r.citationCount / maxCitations;
      const recency = (new Date(r.createdAt).getTime() - minTs) / tsRange;
      const score = citationScore * 0.8 + recency * 0.2;
      return { r, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxResults).map(s => s.r);
  }

  /** Increment citation_count / bump last_cited_at when a precedent is followed or distinguished. */
  async recordCitation(id: string, orgId: string): Promise<void> {
    const now = new Date().toISOString();

    if (this.useInMemory) {
      const rec = this.inMemory.find(r => r.id === id && r.orgId === orgId);
      if (rec) {
        rec.citationCount += 1;
        rec.lastCitedAt = now;
        rec.updatedAt = now;
      }
      return;
    }

    await this.pool!.query(
      `UPDATE precedent_store
       SET citation_count = citation_count + 1, last_cited_at = $3, updated_at = $3
       WHERE id = $1 AND org_id = $2`,
      [id, orgId, now],
    );
  }

  async getById(id: string, orgId: string): Promise<PrecedentRecord | null> {
    if (this.useInMemory) {
      return this.inMemory.find(r => r.id === id && r.orgId === orgId) ?? null;
    }
    const result = await this.pool!.query(
      `SELECT * FROM precedent_store WHERE id = $1 AND org_id = $2`,
      [id, orgId],
    );
    return result.rows[0] ? this.rowToRecord(result.rows[0]) : null;
  }

  private rowToRecord(row: Record<string, unknown>): PrecedentRecord {
    return {
      id: row.id as string,
      orgId: row.org_id as string,
      factPattern: row.fact_pattern as Record<string, unknown>,
      factPatternHash: row.fact_pattern_hash as string,
      ratio: row.ratio as string,
      disposition: row.disposition as Record<string, unknown>,
      authority: row.authority as PrecedentAuthority,
      status: row.status as PrecedentStatus,
      overruledBy: (row.overruled_by as string | null) ?? undefined,
      overruleApprovalId: (row.overrule_approval_id as string | null) ?? undefined,
      citationCount: Number(row.citation_count ?? 0),
      lastCitedAt: row.last_cited_at ? (row.last_cited_at as Date).toISOString() : undefined,
      canonicalHash: (row.canonical_hash as string | null) ?? undefined,
      signature: (row.signature as string | null) ?? undefined,
      signedBy: (row.signed_by as string | null) ?? undefined,
      sigAlgorithm: (row.sig_algorithm as string | null) ?? undefined,
      signedAt: row.signed_at ? (row.signed_at as Date).toISOString() : undefined,
      signatureStatus: ((row.signature_status as PrecedentSignatureStatus | null) ?? 'unsigned'),
      createdAt: (row.created_at as Date).toISOString(),
      updatedAt: (row.updated_at as Date).toISOString(),
    };
  }
}

export function createInMemoryPrecedentStore(): PrecedentStore {
  return new PrecedentStore();
}

export function createPostgresPrecedentStore(config: PrecedentStoreConfig): PrecedentStore {
  return new PrecedentStore(config);
}
