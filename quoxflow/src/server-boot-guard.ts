/**
 * server-boot-guard.ts — TRUST-GATE 1.1
 *
 * Fail-loud guard invoked before store initialisation in server.ts main().
 *
 * Problem: src/server.ts silently falls back to in-memory stores whenever
 * DATABASE_URL is unset (see store init ~lines 145-208). In production this
 * silently loses all run/approval/audit state on every restart, and the
 * failStale('running') boot recovery only runs in PG mode. Zero-tolerance
 * durability violation (see CLAUDE.md Data Persistence rules).
 *
 * An empty-string DATABASE_URL must be treated the same as unset — docker
 * compose interpolates empty strings for missing vars when a project runs
 * without a `.env` file (a known past incident), so `DATABASE_URL=` in the
 * environment must not silently pass as "configured".
 *
 * Behavior:
 *   - NODE_ENV=production, DATABASE_URL unset/empty, override not set:
 *     throws a descriptive error naming DATABASE_URL. Caller (main()) lets
 *     this propagate to the top-level `main().catch()` handler, which logs
 *     and process.exit(1)s — boot fails fast.
 *   - NODE_ENV=production, DATABASE_URL unset/empty, but
 *     QUOXFLOW_ALLOW_MEMORY_STORES=true: does not throw, but returns a
 *     result flagging that a prominent warning must be logged.
 *   - Any other NODE_ENV with DATABASE_URL unset/empty: does not throw, but
 *     flags that a (non-prominent) warning must be logged so the in-memory
 *     fallback is never silent.
 *   - DATABASE_URL configured (non-empty): no warning needed.
 */

export interface BootGuardResult {
  /** True when store init will fall back to in-memory (no usable DATABASE_URL). */
  usingMemoryStores: boolean;
  /** True when the production override (QUOXFLOW_ALLOW_MEMORY_STORES) was used. */
  productionOverride: boolean;
}

export interface AssertDatabaseConfiguredOptions {
  /** Defaults to process.env.NODE_ENV. */
  nodeEnv?: string;
  /** Defaults to process.env.DATABASE_URL. */
  databaseUrl?: string;
  /** Defaults to process.env.QUOXFLOW_ALLOW_MEMORY_STORES. */
  allowMemoryStoresOverride?: string;
}

/**
 * Returns true when a usable (non-empty) DATABASE_URL is configured.
 * Empty-string DATABASE_URL is treated as unset (docker-compose empty
 * interpolation burn — see module docstring).
 */
function hasDatabaseUrl(databaseUrl: string | undefined): boolean {
  return typeof databaseUrl === 'string' && databaseUrl.trim().length > 0;
}

/**
 * Guard invoked before store initialisation. Throws in production when no
 * DATABASE_URL is configured, unless explicitly overridden. Never throws
 * outside production. Returns a result describing whether the caller must
 * log a fallback warning.
 */
export function assertDatabaseConfigured(opts: AssertDatabaseConfiguredOptions = {}): BootGuardResult {
  const nodeEnv = opts.nodeEnv ?? process.env.NODE_ENV;
  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL;
  const allowOverride = opts.allowMemoryStoresOverride ?? process.env.QUOXFLOW_ALLOW_MEMORY_STORES;

  const configured = hasDatabaseUrl(databaseUrl);
  if (configured) {
    return { usingMemoryStores: false, productionOverride: false };
  }

  const isProduction = nodeEnv === 'production';
  const overridden = allowOverride === 'true';

  if (isProduction && !overridden) {
    throw new Error(
      'DATABASE_URL is not set (or empty). Refusing to boot in production with ' +
      'in-memory stores — all run/approval/audit state would be lost on restart, ' +
      'and crash recovery (failStale) would be skipped. Set DATABASE_URL to a ' +
      'valid PostgreSQL connection string, or set QUOXFLOW_ALLOW_MEMORY_STORES=true ' +
      'to explicitly opt into non-durable storage (not recommended in production).',
    );
  }

  return { usingMemoryStores: true, productionOverride: isProduction && overridden };
}

/**
 * REPLAY-ONLY .A-1b — G6: PG-mandatory boot guard for the skill_library
 * (Crystal) store.
 *
 * skill-library-store.ts runs in-memory whenever no DATABASE_URL is
 * configured (see assertDatabaseConfigured's `usingMemoryStores`) — the same
 * flag that gates every other store. Crystals evaporating on restart is a
 * compliance hazard specifically for replay-only mode: its entire premise is
 * a durable, auditable replay record (docs/STREAM_REPLAY_ONLY_FABLE_REVIEW.md
 * §3 G6). Because the replay-only-flags CRUD route is mounted unconditionally
 * whenever a store is present (see app.ts), replay-only can always be
 * switched on at runtime — so "can be active" reduces to "the deployment
 * exists at all", and this guard fires alongside the general DB guard.
 *
 * Deliberately a SEPARATE override from QUOXFLOW_ALLOW_MEMORY_STORES:
 * accepting non-durable audit/approval data in general does not imply
 * accepting canonical Crystals evaporating under a mode whose sole
 * commercial claim is "every replayed action is a signature-verified,
 * durable snapshot". An operator must opt into each hazard explicitly.
 */
export interface AssertReplayOnlyStoreDurableOptions {
  /** Defaults to process.env.NODE_ENV. */
  nodeEnv?: string;
  /**
   * Whether the skill_library (Crystal) store is running in in-memory mode.
   * Callers should pass through `assertDatabaseConfigured(...).usingMemoryStores`
   * — the same DATABASE_URL presence/absence determines both.
   */
  usingMemoryStores: boolean;
  /** Defaults to process.env.QUOXFLOW_ALLOW_REPLAY_ONLY_MEMORY. */
  allowReplayOnlyMemoryOverride?: string;
}

export interface ReplayOnlyBootGuardResult {
  /** True when the skill_library store is in-memory (crystals non-durable). */
  usingMemoryStores: boolean;
  /** True when the dedicated production override was used. */
  productionOverride: boolean;
}

export function assertReplayOnlyStoreDurable(
  opts: AssertReplayOnlyStoreDurableOptions,
): ReplayOnlyBootGuardResult {
  const nodeEnv = opts.nodeEnv ?? process.env.NODE_ENV;
  const allowOverride = opts.allowReplayOnlyMemoryOverride ?? process.env.QUOXFLOW_ALLOW_REPLAY_ONLY_MEMORY;
  const overridden = allowOverride === 'true';

  if (!opts.usingMemoryStores) {
    return { usingMemoryStores: false, productionOverride: false };
  }

  const isProduction = nodeEnv === 'production';

  if (isProduction && !overridden) {
    throw new Error(
      'REPLAY-ONLY G6: the skill_library (Crystal) store is running in-memory ' +
      '(no DATABASE_URL configured). Refusing to boot in production with replay-only ' +
      'reachable — canonical Crystals would evaporate on every restart, which is a ' +
      'compliance hazard for a mode whose entire premise is a durable, auditable ' +
      'replay record. Set DATABASE_URL to a valid PostgreSQL connection string, or ' +
      'set QUOXFLOW_ALLOW_REPLAY_ONLY_MEMORY=true to explicitly accept the risk ' +
      '(not recommended in production).',
    );
  }

  return { usingMemoryStores: true, productionOverride: isProduction && overridden };
}
