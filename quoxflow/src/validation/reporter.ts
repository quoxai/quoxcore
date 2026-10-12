/**
 * Validation Reporter
 *
 * Aggregates RunResults into a NightlyReport, persists it, and computes
 * the consecutive-green-night streak.
 *
 * Storage: in-memory (default) or Postgres via DATABASE_URL.
 * For production nightly runs, set DATABASE_URL and call persist().
 * The HTTP API reads from this store.
 */

import { ulid } from 'ulid';
import { NightlyReport } from './types.js';

export interface PersistedReport {
  id: string;
  ranAt: string;
  totalAgents: number;
  passed: number;
  failed: number;
  results: NightlyReport['results'];
  envelopeIntents: string[];
  totalTokensIn: number;
  totalCostUsdMicro: number;
  createdAt: string;
}

export interface StreakResult {
  streak: number;
  target: number;
  /** ISO date when the 14-night gate opens, if streak >= target */
  eligibleAt?: string;
}

// ─── Shared interface ─────────────────────────────────────────────────────────

interface ReportStore {
  persist(report: NightlyReport): Promise<PersistedReport>;
  listRecent(limit?: number): Promise<PersistedReport[]>;
  computeStreak(target?: number): Promise<StreakResult>;
}

// ─── In-memory store (default) ───────────────────────────────────────────────

class InMemoryReportStore implements ReportStore {
  private reports: PersistedReport[] = [];

  async persist(report: NightlyReport): Promise<PersistedReport> {
    const persisted: PersistedReport = {
      id: ulid(),
      ranAt: report.ranAt,
      totalAgents: report.totalAgents,
      passed: report.passed,
      failed: report.failed,
      results: report.results,
      envelopeIntents: report.envelopeIntents,
      totalTokensIn: report.totalTokensIn,
      totalCostUsdMicro: report.totalCostUsdMicro,
      createdAt: new Date().toISOString(),
    };

    this.reports.unshift(persisted); // newest first
    return persisted;
  }

  async listRecent(limit = 30): Promise<PersistedReport[]> {
    return this.reports.slice(0, limit);
  }

  async computeStreak(target = 14): Promise<StreakResult> {
    // Count consecutive most-recent reports where passed === totalAgents
    let streak = 0;
    for (const r of this.reports) {
      if (r.passed === r.totalAgents) {
        streak++;
      } else {
        break;
      }
    }

    if (streak >= target) {
      // eligibleAt = ranAt of the oldest report in the consecutive run
      const eligibleReport = this.reports[streak - 1];
      return { streak, target, eligibleAt: eligibleReport?.ranAt };
    }

    return { streak, target };
  }
}

// ─── Postgres store (production) ─────────────────────────────────────────────

/**
 * R5.crit-2: PostgresReportStore persists nightly reports to `validation_reports`
 * so the 14-night streak survives process restarts. The streak computation reads
 * rows ordered by ran_at DESC — same logic as the in-memory version.
 */
class PostgresReportStore implements ReportStore {
  private pool: import('pg').Pool;
  private ready: Promise<void>;

  constructor(connectionString: string) {
    // Dynamic import pg so the module loads without pg when using in-memory.
    // We import it lazily in the constructor via a top-level dynamic import.
    // Node.js caches the module so subsequent instantiations are cheap.
    const pg = require('pg');
    this.pool = new pg.Pool({ connectionString });
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS validation_reports (
        id VARCHAR(26) PRIMARY KEY,
        ran_at TIMESTAMPTZ NOT NULL,
        total_agents INTEGER NOT NULL,
        passed INTEGER NOT NULL,
        failed INTEGER NOT NULL,
        results JSONB NOT NULL,
        envelope_intents JSONB NOT NULL,
        total_tokens_in INTEGER NOT NULL DEFAULT 0,
        total_cost_usd_micro BIGINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_validation_reports_ran_at ON validation_reports (ran_at DESC);
    `);
  }

  async persist(report: NightlyReport): Promise<PersistedReport> {
    await this.ready;
    const id = ulid();
    const createdAt = new Date().toISOString();

    await this.pool.query(
      `INSERT INTO validation_reports
        (id, ran_at, total_agents, passed, failed, results, envelope_intents, total_tokens_in, total_cost_usd_micro, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        report.ranAt,
        report.totalAgents,
        report.passed,
        report.failed,
        JSON.stringify(report.results),
        JSON.stringify(report.envelopeIntents),
        report.totalTokensIn,
        report.totalCostUsdMicro,
        createdAt,
      ]
    );

    return {
      id,
      ranAt: report.ranAt,
      totalAgents: report.totalAgents,
      passed: report.passed,
      failed: report.failed,
      results: report.results,
      envelopeIntents: report.envelopeIntents,
      totalTokensIn: report.totalTokensIn,
      totalCostUsdMicro: report.totalCostUsdMicro,
      createdAt,
    };
  }

  async listRecent(limit = 30): Promise<PersistedReport[]> {
    await this.ready;
    const result = await this.pool.query(
      `SELECT * FROM validation_reports ORDER BY ran_at DESC LIMIT $1`,
      [limit]
    );
    return result.rows.map(this.mapRow);
  }

  async computeStreak(target = 14): Promise<StreakResult> {
    await this.ready;
    // Fetch the most recent `target * 2` reports to compute streak
    const reports = await this.listRecent(target * 2);

    let streak = 0;
    for (const r of reports) {
      if (r.passed === r.totalAgents) {
        streak++;
      } else {
        break;
      }
    }

    if (streak >= target) {
      const eligibleReport = reports[streak - 1];
      return { streak, target, eligibleAt: eligibleReport?.ranAt };
    }

    return { streak, target };
  }

  private mapRow(row: Record<string, unknown>): PersistedReport {
    return {
      id: row.id as string,
      ranAt: row.ran_at instanceof Date ? (row.ran_at as Date).toISOString() : row.ran_at as string,
      totalAgents: row.total_agents as number,
      passed: row.passed as number,
      failed: row.failed as number,
      results: row.results as NightlyReport['results'],
      envelopeIntents: row.envelope_intents as string[],
      totalTokensIn: row.total_tokens_in as number,
      totalCostUsdMicro: row.total_cost_usd_micro as number,
      createdAt: row.created_at instanceof Date ? (row.created_at as Date).toISOString() : row.created_at as string,
    };
  }
}

// ─── Singleton store instance ─────────────────────────────────────────────────

let _store: ReportStore | null = null;

function getStore(): ReportStore {
  if (!_store) {
    const dbUrl = process.env.DATABASE_URL;
    if (dbUrl) {
      _store = new PostgresReportStore(dbUrl);
    } else {
      _store = new InMemoryReportStore();
    }
  }
  return _store;
}

/**
 * For testing: replace the store with a fresh instance.
 */
export function _resetStore(store?: ReportStore): void {
  _store = store ?? new InMemoryReportStore();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Persist a NightlyReport to the store.
 */
export async function persistReport(report: NightlyReport): Promise<PersistedReport> {
  return getStore().persist(report);
}

/**
 * List the last `limit` nightly reports (newest first).
 */
export async function listReports(limit = 30): Promise<PersistedReport[]> {
  return getStore().listRecent(limit);
}

/**
 * Compute the consecutive-green-night streak.
 * target defaults to 14 (the BQ-AGENTIC-MIGRATION gate).
 */
export async function computeStreak(target = 14): Promise<StreakResult> {
  return getStore().computeStreak(target);
}
