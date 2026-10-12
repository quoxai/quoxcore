#!/usr/bin/env node
/**
 * backfill-org.ts — QF-MT WP2 operator backfill
 *
 * Reassigns legacy org_id='default' rows to the instance's real primary org.
 * NOT part of the automatic migration chain (migrations/019-org-isolation.sql)
 * because the target org differs per install — this is an operator-run,
 * one-time (but idempotent / re-runnable) step. See
 * docs/STREAM_QUOXFLOW_MULTITENANCY_PLAN.md S5.
 *
 * Usage:
 *   npx tsx scripts/backfill-org.ts --to <orgId> [--execute] [--force]
 *
 * Flags:
 *   --to <orgId>   Required. The org every 'default'-owned row is reassigned to.
 *   --dry-run      Default behavior. Prints per-table counts, writes nothing.
 *   --execute      Actually perform the reassignment (alias: --no-dry-run).
 *   --force        Skip the auth-service org-existence check (best-effort;
 *                  also used automatically if the auth service is unreachable
 *                  and the operator wants to proceed anyway).
 *   --help, -h     Print this usage and exit.
 *
 * Env:
 *   DATABASE_URL       Postgres connection string (required).
 *   AUTH_SERVICE_URL   Base URL of the auth service, default http://auth:3101.
 *                       Used for GET /api/internal/orgs/list (X-Service-Key
 *                       auth) to validate --to is a real, live org.
 *   INTERNAL_SERVICE_KEY  Service key sent as X-Service-Key on the org check.
 *   EVIDENCE_PATH      File-backend base path for the audit evidence record
 *                       this script writes on successful --execute runs.
 *                       Default /tmp/quoxflow/evidence (mirrors server.ts).
 *
 * Idempotent: every UPDATE is scoped to `WHERE org_id = 'default'`, so
 * re-running after a partial or fully-completed backfill only touches rows
 * still legitimately at 'default' (e.g. residue written by in-flight
 * executions during a deploy window — see plan S9 risk 4).
 */

import pg from 'pg';
import { ulid } from 'ulid';
import { createPostgresEvidenceStore, createFileStorageBackend } from '../src/evidence/index.js';

const { Pool } = pg;

// ─── Table plan ─────────────────────────────────────────────────────────────

/** Tables large enough (per plan S2 evidence) to require batched updates. */
const BIG_TABLES = ['envelopes', 'evidence', 'executions'] as const;

/** Tables small enough for a single UPDATE statement. */
const SMALL_TABLES = [
  'workflows',
  'approvals',
  'policies',
  'execution_history',
  'observations',
  'budgets',
  'budget_usage',
] as const;

const ALL_TABLES = [...BIG_TABLES, ...SMALL_TABLES];

const BATCH_SIZE = 50_000;
const LEGACY_ORG_ID = 'default';

// ─── CLI args ────────────────────────────────────────────────────────────────

interface Args {
  to?: string;
  dryRun: boolean;
  force: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: true, force: false, help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--to':
        args.to = argv[++i];
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--execute':
      case '--no-dry-run':
        args.dryRun = false;
        break;
      case '--force':
        args.force = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        // Unknown flag — ignored rather than fatal, matching this repo's
        // other one-off scripts (scripts/import-all-n8n.ts) which favor
        // reporting over hard failure for operator tooling.
        break;
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`
backfill-org.ts — QF-MT WP2 operator backfill

Reassigns legacy org_id='default' rows to the instance's real primary org.

Usage:
  npx tsx scripts/backfill-org.ts --to <orgId> [--execute] [--force]

Flags:
  --to <orgId>   Required. Target org for every 'default'-owned row.
  --dry-run      Default. Prints per-table counts, writes nothing.
  --execute      Perform the reassignment (alias: --no-dry-run).
  --force        Skip the auth-service org-existence check.
  --help, -h     Print this message and exit.

Env:
  DATABASE_URL          Postgres connection string (required).
  AUTH_SERVICE_URL       Auth service base URL (default http://auth:3101).
  INTERNAL_SERVICE_KEY   X-Service-Key for the org-existence check.
  EVIDENCE_PATH          Evidence file-backend base path (default /tmp/quoxflow/evidence).
`);
}

// ─── Auth-service org validation (best-effort) ──────────────────────────────

async function validateOrgExists(orgId: string): Promise<{ ok: boolean; reason?: string }> {
  const authServiceUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
  const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
  const url = `${authServiceUrl.replace(/\/$/, '')}/api/internal/orgs/list`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);

  try {
    const res = await fetch(url, {
      headers: { 'X-Service-Key': serviceKey },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, reason: `auth service responded ${res.status}` };
    }
    const body = (await res.json()) as { ok?: boolean; orgIds?: string[] };
    if (!Array.isArray(body.orgIds)) {
      return { ok: false, reason: 'auth service response missing orgIds array' };
    }
    if (!body.orgIds.includes(orgId)) {
      return { ok: false, reason: `org '${orgId}' not found in auth service (${body.orgIds.length} live orgs)` };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `auth service unreachable: ${msg}` };
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Counts / updates ───────────────────────────────────────────────────────

async function countLegacyRows(pool: pg.Pool, table: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::bigint AS count FROM ${table} WHERE org_id = $1`,
    [LEGACY_ORG_ID]
  );
  return Number(rows[0].count);
}

/** Single UPDATE for small tables. Returns rows affected. */
async function singleUpdate(pool: pg.Pool, table: string, toOrgId: string): Promise<number> {
  const result = await pool.query(
    `UPDATE ${table} SET org_id = $1 WHERE org_id = $2`,
    [toOrgId, LEGACY_ORG_ID]
  );
  return result.rowCount ?? 0;
}

/**
 * Batched UPDATE for big tables — bounds lock time on the ~1M-row envelopes
 * table (plan S3/S9 risk 3). Repeatedly updates up to BATCH_SIZE rows
 * (selected by primary key `id`, ordered for determinism) until none remain
 * at the legacy org.
 */
async function batchUpdate(pool: pg.Pool, table: string, toOrgId: string): Promise<number> {
  let total = 0;
  for (;;) {
    const result = await pool.query(
      `
      UPDATE ${table}
      SET org_id = $1
      WHERE id IN (
        SELECT id FROM ${table} WHERE org_id = $2 ORDER BY id LIMIT $3
      )
      `,
      [toOrgId, LEGACY_ORG_ID, BATCH_SIZE]
    );
    const affected = result.rowCount ?? 0;
    total += affected;
    if (affected < BATCH_SIZE) break;
  }
  return total;
}

// ─── Audit evidence (best-effort, never fails the backfill) ────────────────

async function logBackfillEvidence(
  dbUrl: string,
  toOrgId: string,
  counts: Record<string, number>
): Promise<void> {
  try {
    const evidenceBasePath = process.env.EVIDENCE_PATH || '/tmp/quoxflow/evidence';
    const backend = createFileStorageBackend({ basePath: evidenceBasePath });
    await backend.init?.();
    const evidenceStore = createPostgresEvidenceStore({ connectionString: dbUrl }, backend);

    const correlationId = `backfill-org-${Date.now()}`;
    const envelopeId = ulid();
    const totalRows = Object.values(counts).reduce((sum, n) => sum + n, 0);

    await evidenceStore.store({
      correlationId,
      envelopeId,
      type: 'data_snapshot',
      contentType: 'application/json',
      content: JSON.stringify({
        operation: 'backfill-org',
        toOrgId,
        legacyOrgId: LEGACY_ORG_ID,
        rowsReassigned: counts,
        totalRowsReassigned: totalRows,
        ranAt: new Date().toISOString(),
      }),
      metadata: {
        orgId: toOrgId,
        script: 'scripts/backfill-org.ts',
        totalRowsReassigned: totalRows,
      },
    });
  } catch (err) {
    // Best-effort per plan S5 — never fail the backfill because the audit
    // trail write failed. Log loudly so the gap is visible.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[backfill-org] WARNING: failed to write audit evidence record: ${msg}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  if (!args.to) {
    console.error('[backfill-org] ERROR: --to <orgId> is required.\n');
    printHelp();
    process.exitCode = 1;
    return;
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('[backfill-org] ERROR: DATABASE_URL is not set.');
    process.exitCode = 1;
    return;
  }

  const toOrgId = args.to;

  console.log(`[backfill-org] Target org: ${toOrgId}`);
  console.log(`[backfill-org] Mode: ${args.dryRun ? 'DRY RUN (default — no writes)' : 'EXECUTE'}`);

  const validation = await validateOrgExists(toOrgId);
  if (!validation.ok) {
    if (args.force) {
      console.warn(`[backfill-org] WARNING: org validation failed (${validation.reason}) — proceeding anyway due to --force.`);
    } else {
      console.error(`[backfill-org] ERROR: org validation failed (${validation.reason}).`);
      console.error(`[backfill-org] Pass --force to proceed anyway (e.g. auth service unreachable from this host).`);
      process.exitCode = 1;
      return;
    }
  } else {
    console.log(`[backfill-org] Org '${toOrgId}' confirmed live via auth service.`);
  }

  const pool = new Pool({ connectionString: dbUrl });

  try {
    console.log('\n[backfill-org] Per-table legacy row counts:');
    const legacyCounts: Record<string, number> = {};
    for (const table of ALL_TABLES) {
      legacyCounts[table] = await countLegacyRows(pool, table);
      console.log(`  ${table.padEnd(20)} ${legacyCounts[table]}`);
    }

    const totalLegacy = Object.values(legacyCounts).reduce((sum, n) => sum + n, 0);
    console.log(`\n[backfill-org] Total legacy rows: ${totalLegacy}`);

    if (args.dryRun) {
      console.log('\n[backfill-org] Dry run — no rows written. Pass --execute to perform the backfill.');
      return;
    }

    if (totalLegacy === 0) {
      console.log('\n[backfill-org] Nothing to do — no rows at org_id=\'default\'.');
      await logBackfillEvidence(dbUrl, toOrgId, {});
      return;
    }

    console.log('\n[backfill-org] Executing reassignment...');
    const reassignedCounts: Record<string, number> = {};

    for (const table of BIG_TABLES) {
      console.log(`  ${table}: batching (${BATCH_SIZE}/batch)...`);
      reassignedCounts[table] = await batchUpdate(pool, table, toOrgId);
      console.log(`  ${table}: ${reassignedCounts[table]} rows reassigned.`);
    }

    for (const table of SMALL_TABLES) {
      reassignedCounts[table] = await singleUpdate(pool, table, toOrgId);
      console.log(`  ${table}: ${reassignedCounts[table]} rows reassigned.`);
    }

    const totalReassigned = Object.values(reassignedCounts).reduce((sum, n) => sum + n, 0);
    console.log(`\n[backfill-org] Done. Total rows reassigned: ${totalReassigned}`);

    await logBackfillEvidence(dbUrl, toOrgId, reassignedCounts);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[backfill-org] FATAL:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
