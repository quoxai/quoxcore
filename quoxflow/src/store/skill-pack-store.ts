/**
 * Skill Pack Store — DEVSUITE-SKILLS Phase 1 (pack format + signing).
 *
 * A "Dev Skills Pack" is a curated, versioned, signed bundle of REFERENCES
 * to skill/rule content (a skill name, a file path, a rule snippet id) that
 * gets installed on a dev-mode-activated host. This phase is pack format +
 * signing infrastructure only — the pack manifest holds references, never
 * the skill/rule text itself, and there is no installer or CLI here (see
 * quoxflow CLAUDE.md scope note in the originating task).
 *
 * Pattern mirrors PrecedentStore (precedent-store.ts) / SkillLibraryStore
 * (skill-library-store.ts): pg.Pool + in-memory fallback, init() creates the
 * table with CREATE TABLE IF NOT EXISTS (also duplicated as a real migration,
 * migrations/023-skill-pack.sql, per TRUST-GATE fresh-DB self-sufficiency),
 * ULID PKs, canonical_hash (via hashSnapshot -> canonicalizeSnapshot, the
 * same deterministic algorithm skill-library-store.ts and precedent-store.ts
 * use), and an injectable Ed25519 signer/verifier pair.
 *
 * Signing-oracle-generic-or-not (verified, not assumed): auth's
 * `POST /api/internal/crystals/sign` (services/auth/routes/internal-crystal-signing.js)
 * and the underlying `signCrystalHash()`
 * (services/auth/lib/crystalSigningKey.js) are GENERIC — they sign whatever
 * hex-encoded hash bytes they're given for the caller-supplied org_id, and
 * explicitly do NOT interpret or canonicalize the hash ("This function does
 * NOT interpret or canonicalize hashHex in any way — it signs whatever bytes
 * it is given. Structural/canonicalization concerns are entirely quoxflow's
 * responsibility."). There is no crystal-row lookup or crystal-specific
 * validation in the route handler. So pack-manifest hashes are signed by the
 * exact same per-org Ed25519 Crystal Signing Key (CSK) oracle as Crystals
 * and Precedents — same curator authority, no new key material, no new
 * endpoint needed. The verify side mirrors crystal-signature-verify.ts /
 * agentic.executor.ts's fetchOrgPublicKey pattern: an injected async
 * fetcher hitting `GET /api/internal/crystals/public-key/:orgId`.
 */

import pg from 'pg';
import { ulid } from 'ulid';
import { logger } from '../logger.js';
import { hashSnapshot } from './crystal-canonical-hash.js';
import { verifyCrystalSignature } from './crystal-signature-verify.js';

const { Pool } = pg;

const log = logger.for('SkillPackStore');

export type PackContentType = 'skill' | 'rule' | 'file';

/**
 * A single reference inside a pack manifest. `ref` names existing content
 * (a skill name, a file path, a rule snippet id) — this phase never embeds
 * or rewrites skill/rule text, it only curates references to it.
 *
 * The three content types install differently on the dev host (the collector's
 * skillPackInstaller.js is the authority):
 *  - 'skill' — installs FLAT at ~/.claude/skills/<ref> (Claude Code discovery).
 *  - 'rule'  — rendered into managed marker blocks in ~/.claude/CLAUDE.md and
 *              ~/.codex/AGENTS.md (backend-neutral rules layer).
 *  - 'file'  — a runtime-layer artifact (an executable tool, a statusline, a
 *              config example) written to ~/.claude/<dest||ref>. `dest`
 *              overrides the install path when it differs from the source
 *              `ref`; `mode` is an octal chmod applied after the write (e.g.
 *              '755' for an executable). File entries are excluded from the
 *              SkillRights licence aggregation (no frontmatter convention) but
 *              ARE covered by the pack content hash and signature.
 */
export interface PackContentRef {
  type: PackContentType;
  ref: string;
  description?: string;
  /** 'file' only: install path relative to ~/.claude, when it differs from `ref`. */
  dest?: string;
  /** 'file' only: octal chmod applied after the write (e.g. '755'). */
  mode?: string;
}

/**
 * The signed unit: a versioned, org-scoped, content-addressed bundle of
 * skill/rule references. `packId` is the pack's own stable identity (equal
 * to the store row's `id`) and is itself part of the hashed/signed payload,
 * so a signature also attests to which pack it belongs to.
 */
export interface PackManifest {
  version: string;
  packId: string;
  orgId: string;
  contents: PackContentRef[];
  createdAt: string;
}

export type PackSignatureStatus = 'signed' | 'unsigned' | 'pending';

/**
 * GAP 2 fix: `contents` is documented (see PackManifest below) as "a
 * curated ... bundle of references" — set/bundle language, not sequence
 * language, unlike a Crystal's action_log_snapshot (an ordered execution
 * sequence, where crystal-canonical-hash.ts's array-order-preserving
 * canonicalizeSnapshot() is correct and must not change). Without this
 * sort, two packs built from the identical set of skill/rule refs but
 * inserted in a different order (e.g. from a Set, or a future UI letting a
 * curator reorder/alphabetize) would hash and sign differently, then fail
 * verifyPack() with a spurious hash_mismatch. Sorting by (type, ref) — both
 * stable string fields — before hashing makes the hash order-independent.
 * Applied identically at sign-time (computeSigningFields, called from
 * createPack) and verify-time (verifyPack) so a manifest that was
 * constructed/stored in a different order than the original still
 * re-derives the same hash.
 */
function canonicalManifestForHashing(manifest: PackManifest): PackManifest {
  const sortedContents = [...manifest.contents].sort((a, b) => {
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    if (a.ref !== b.ref) return a.ref < b.ref ? -1 : 1;
    return 0;
  });
  return { ...manifest, contents: sortedContents };
}

export interface SkillPackStoreConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
}

export interface CreatePackInput {
  orgId: string;
  /** Pack manifest schema version (a free-form string, e.g. '1'). */
  version: string;
  contents: PackContentRef[];
  /** Overridable for deterministic tests; defaults to now(). */
  createdAt?: string;
  /**
   * Explicit WELL-KNOWN id (e.g. 'quox-core-dev-pack') for packs that
   * cross-service consumers look up by name (the collector's
   * skillPackInstaller). Omit for the default ULID. Validated against
   * WELL_KNOWN_PACK_ID_PATTERN — never silently replaced.
   */
  id?: string;
}

/** Lowercase slug, 4-26 chars (the column is VARCHAR(26)). */
export const WELL_KNOWN_PACK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,24}[a-z0-9]$/;

export interface SkillPackRecord {
  id: string;
  orgId: string;
  packVersion: string;
  manifest: PackManifest;
  canonicalHash: string;
  signature?: string;
  signedBy?: string;
  sigAlgorithm?: string;
  signedAt?: string;
  signatureStatus: PackSignatureStatus;
  createdAt: string;
  updatedAt: string;
}

/** Mirrors CrystalSigner (skill-library-store.ts) / PrecedentSigner (precedent-store.ts) — same oracle. */
export type PackSigner = (params: { orgId: string; hash: string }) => Promise<{
  signature: string;
  key_id: string;
  algorithm: string;
} | null>;

/** Mirrors FetchOrgPublicKey (agentic.executor.ts) — same oracle's GET counterpart. */
export type PackPublicKeyFetcher = (orgId: string) => Promise<{
  public_key_hex: string;
  key_id: string;
  algorithm: string;
} | null>;

export type PackVerifyFailureReason =
  | 'not_found'
  | 'hash_mismatch'
  | 'unsigned'
  | 'pending'
  | 'public_key_unavailable'
  | 'signature_invalid';

export type PackVerifyResult =
  | { valid: true }
  | { valid: false; reason: PackVerifyFailureReason };

export class SkillPackStore {
  private pool: pg.Pool | null = null;
  private inMemory: SkillPackRecord[] = [];
  private useInMemory: boolean;
  private signer?: PackSigner;
  private publicKeyFetcher?: PackPublicKeyFetcher;

  constructor(config?: SkillPackStoreConfig) {
    this.useInMemory = !config;
    if (config) {
      this.pool = new Pool(config);
    }
  }

  /** Inject the auth crystal-signing-oracle HTTP client (same oracle used by SkillLibraryStore/PrecedentStore). */
  setSigner(signer: PackSigner): void {
    this.signer = signer;
  }

  /** Inject the auth org-public-key-fetch HTTP client, used by verifyPack(). */
  setPublicKeyFetcher(fetcher: PackPublicKeyFetcher): void {
    this.publicKeyFetcher = fetcher;
  }

  async init(): Promise<void> {
    if (this.useInMemory) return;

    const createTable = `
      CREATE TABLE IF NOT EXISTS skill_pack (
        id                    VARCHAR(26) PRIMARY KEY,
        org_id                VARCHAR(255) NOT NULL,
        pack_version          TEXT NOT NULL,
        manifest              JSONB NOT NULL,
        canonical_hash        TEXT NOT NULL,
        signature             TEXT,
        signed_by             TEXT,
        sig_algorithm         TEXT,
        signed_at             TIMESTAMPTZ,
        signature_status      TEXT DEFAULT 'unsigned',
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_skill_pack_org
        ON skill_pack(org_id);

      CREATE INDEX IF NOT EXISTS idx_skill_pack_org_created
        ON skill_pack(org_id, created_at DESC);
    `;

    await this.pool!.query(createTable);
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
    }
  }

  /**
   * Sign-before-commit hook, mirroring SkillLibraryStore.computeSigningFields()
   * / PrecedentStore.signPrecedent(). Pure best-effort: never throws — a
   * signer failure or absence commits with signature_status='pending'/'unsigned'
   * rather than blocking pack creation.
   */
  private async computeSigningFields(orgId: string, manifest: PackManifest): Promise<{
    canonicalHash: string;
    signatureStatus: PackSignatureStatus;
    signature?: string;
    signedBy?: string;
    sigAlgorithm?: string;
    signedAt?: string;
  }> {
    const canonicalHash = hashSnapshot(canonicalManifestForHashing(manifest));

    if (!this.signer) {
      return { canonicalHash, signatureStatus: 'unsigned' };
    }

    try {
      const result = await this.signer({ orgId, hash: canonicalHash });
      if (!result) {
        log.warn(`createPack: signer returned null for org ${orgId} — committing with signature_status='pending'`);
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
      // Defence in depth: the injected signer is contracted not to throw
      // (the real server.ts implementation catches network/HTTP errors and
      // returns null), but a broken/test signer must not be able to block
      // pack creation either.
      log.warn(`createPack: signer threw for org ${orgId} — committing with signature_status='pending': ${err instanceof Error ? err.message : String(err)}`);
      return { canonicalHash, signatureStatus: 'pending' };
    }
  }

  /**
   * Build a PackManifest from the given references, hash it (canonical
   * JSON, stable key order — see crystal-canonical-hash.ts), sign it via the
   * injected signer if present, and persist the record.
   */
  async createPack(input: CreatePackInput): Promise<SkillPackRecord> {
    let packId: string;
    if (input.id !== undefined) {
      if (!WELL_KNOWN_PACK_ID_PATTERN.test(input.id)) {
        throw new Error(`skill-pack-store: invalid well-known pack id '${input.id}'`);
      }
      packId = input.id;
    } else {
      packId = ulid();
    }
    const createdAt = input.createdAt ?? new Date().toISOString();
    const manifest: PackManifest = {
      version: input.version,
      packId,
      orgId: input.orgId,
      contents: input.contents,
      createdAt,
    };

    const signingFields = await this.computeSigningFields(input.orgId, manifest);
    const now = new Date().toISOString();

    const record: SkillPackRecord = {
      id: packId,
      orgId: input.orgId,
      packVersion: input.version,
      manifest,
      ...signingFields,
      createdAt: now,
      updatedAt: now,
    };

    if (this.useInMemory) {
      this.inMemory.push(record);
      return record;
    }

    await this.pool!.query(
      `INSERT INTO skill_pack (
        id, org_id, pack_version, manifest, canonical_hash, signature,
        signed_by, sig_algorithm, signed_at, signature_status,
        created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        packId,
        input.orgId,
        input.version,
        JSON.stringify(manifest),
        signingFields.canonicalHash,
        signingFields.signature ?? null,
        signingFields.signedBy ?? null,
        signingFields.sigAlgorithm ?? null,
        signingFields.signedAt ?? null,
        signingFields.signatureStatus,
        now,
        now,
      ],
    );

    return record;
  }

  async getPack(id: string, orgId: string): Promise<SkillPackRecord | null> {
    if (this.useInMemory) {
      return this.inMemory.find(r => r.id === id && r.orgId === orgId) ?? null;
    }

    const result = await this.pool!.query(
      `SELECT * FROM skill_pack WHERE id = $1 AND org_id = $2`,
      [id, orgId],
    );
    return result.rows[0] ? this.rowToRecord(result.rows[0]) : null;
  }

  async listPacks(orgId: string): Promise<SkillPackRecord[]> {
    if (this.useInMemory) {
      return this.inMemory
        .filter(r => r.orgId === orgId)
        .slice()
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    }

    const result = await this.pool!.query(
      `SELECT * FROM skill_pack WHERE org_id = $1 ORDER BY created_at DESC`,
      [orgId],
    );
    return result.rows.map(row => this.rowToRecord(row));
  }

  /**
   * Re-derive the canonical hash from the stored manifest and check it
   * against the stored signature (fail-closed on every branch — a missing
   * pack, a tampered manifest, a missing/pending signature, an unreachable
   * public-key oracle, or an invalid signature all resolve to
   * `{ valid: false, reason }`, never a thrown error).
   */
  /**
   * Idempotent create-or-update for a WELL-KNOWN pack (DEVSUITE-SKILLS seq 4):
   * the boot-time seeding path server.ts runs so cross-service consumers (the
   * collector's skillPackInstaller) can verify 'quox-core-dev-pack' instead of
   * failing closed against an empty registry forever.
   *
   * - missing            -> createPack (signed if a signer is wired)
   * - same version+refs  -> unchanged (no re-sign, no write)
   * - different contents -> manifest rebuilt, re-hashed, re-signed, row updated
   */
  async ensureWellKnownPack(input: CreatePackInput & { id: string }): Promise<{
    record: SkillPackRecord;
    action: 'created' | 'unchanged' | 'updated';
  }> {
    const existing = await this.getPack(input.id, input.orgId);
    if (!existing) {
      const record = await this.createPack(input);
      return { record, action: 'created' };
    }

    const sortRefs = (refs: PackContentRef[]) =>
      [...refs].sort((a, b) => (a.type !== b.type ? (a.type < b.type ? -1 : 1) : a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
    const same =
      existing.packVersion === input.version &&
      JSON.stringify(sortRefs(existing.manifest.contents)) === JSON.stringify(sortRefs(input.contents));
    if (same) {
      return { record: existing, action: 'unchanged' };
    }

    const createdAt = input.createdAt ?? new Date().toISOString();
    const manifest: PackManifest = {
      version: input.version,
      packId: input.id,
      orgId: input.orgId,
      contents: input.contents,
      createdAt,
    };
    const signingFields = await this.computeSigningFields(input.orgId, manifest);
    const now = new Date().toISOString();
    const record: SkillPackRecord = {
      ...existing,
      packVersion: input.version,
      manifest,
      ...signingFields,
      updatedAt: now,
    };

    if (this.useInMemory) {
      const idx = this.inMemory.findIndex(r => r.id === input.id && r.orgId === input.orgId);
      this.inMemory[idx] = record;
      return { record, action: 'updated' };
    }

    await this.pool!.query(
      `UPDATE skill_pack SET
        pack_version = $3, manifest = $4, canonical_hash = $5, signature = $6,
        signed_by = $7, sig_algorithm = $8, signed_at = $9, signature_status = $10,
        updated_at = $11
       WHERE id = $1 AND org_id = $2`,
      [
        input.id,
        input.orgId,
        input.version,
        JSON.stringify(manifest),
        signingFields.canonicalHash,
        signingFields.signature ?? null,
        signingFields.signedBy ?? null,
        signingFields.sigAlgorithm ?? null,
        signingFields.signedAt ?? null,
        signingFields.signatureStatus,
        now,
      ],
    );
    return { record, action: 'updated' };
  }

  async verifyPack(id: string, orgId: string): Promise<PackVerifyResult> {
    const record = await this.getPack(id, orgId);
    if (!record) {
      return { valid: false, reason: 'not_found' };
    }

    const recomputedHash = hashSnapshot(canonicalManifestForHashing(record.manifest));
    if (recomputedHash !== record.canonicalHash) {
      // The manifest stored alongside the hash doesn't match the hash
      // anymore (tampered row) — fail before ever consulting the signature.
      return { valid: false, reason: 'hash_mismatch' };
    }

    if (record.signatureStatus === 'unsigned') {
      return { valid: false, reason: 'unsigned' };
    }
    if (record.signatureStatus === 'pending') {
      return { valid: false, reason: 'pending' };
    }
    if (!record.signature) {
      return { valid: false, reason: 'unsigned' };
    }

    if (!this.publicKeyFetcher) {
      return { valid: false, reason: 'public_key_unavailable' };
    }

    const pubKey = await this.publicKeyFetcher(orgId);
    if (!pubKey) {
      return { valid: false, reason: 'public_key_unavailable' };
    }

    const signatureValid = verifyCrystalSignature(recomputedHash, record.signature, pubKey.public_key_hex);
    return signatureValid ? { valid: true } : { valid: false, reason: 'signature_invalid' };
  }

  private rowToRecord(row: Record<string, unknown>): SkillPackRecord {
    return {
      id: row.id as string,
      orgId: row.org_id as string,
      packVersion: row.pack_version as string,
      manifest: row.manifest as PackManifest,
      canonicalHash: row.canonical_hash as string,
      signature: (row.signature as string | null) ?? undefined,
      signedBy: (row.signed_by as string | null) ?? undefined,
      sigAlgorithm: (row.sig_algorithm as string | null) ?? undefined,
      signedAt: row.signed_at ? (row.signed_at as Date).toISOString() : undefined,
      signatureStatus: ((row.signature_status as PackSignatureStatus | null) ?? 'unsigned'),
      createdAt: (row.created_at as Date).toISOString(),
      updatedAt: (row.updated_at as Date).toISOString(),
    };
  }
}

export function createInMemorySkillPackStore(): SkillPackStore {
  return new SkillPackStore();
}

export function createPostgresSkillPackStore(config: SkillPackStoreConfig): SkillPackStore {
  return new SkillPackStore(config);
}
