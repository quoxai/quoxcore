/**
 * QSKL-13 — SessionSearchStore (Postgres-backed)
 *
 * Thin wrapper that executes the FTS query against the envelopes table.
 * Requires migration 012-envelopes-fts-search.sql to be applied first
 * (adds the fts_search generated column + GIN partial index).
 *
 * The store is multi-tenant: every query is scoped to a single org_id
 * that must be supplied by the caller (sourced from context, not params).
 */

import pg from 'pg';
import type { SessionSearchResult, SessionSearchStore } from '../agentic/session-search-actions.js';

const { Pool } = pg;

// ─── FTS SQL ──────────────────────────────────────────────────────────────────

/**
 * Main FTS query over the envelopes table.
 *
 * Parameters:
 *   $1  — org_id (VARCHAR)
 *   $2  — websearch query string (e.g. "docker health")
 *   $3  — LIMIT (integer)
 *
 * Returns rows ordered by ts_rank DESC, ts DESC so the most-relevant and
 * most-recent results surface first.
 *
 * ts_headline is applied to whichever of the payload text fields is
 * non-empty, producing a short bolded snippet around the matched terms.
 */
const FTS_QUERY = `
SELECT
  id AS envelope_id,
  COALESCE(corr, id) AS session_id,
  ts,
  type,
  intent,
  ts_rank(fts_search, websearch_to_tsquery('english', $2)) AS score,
  ts_headline(
    'english',
    COALESCE(
      NULLIF(payload->>'objective', ''),
      NULLIF(payload->>'message', ''),
      NULLIF(payload->>'reasoning', ''),
      NULLIF(payload->>'output', ''),
      NULLIF(payload->>'observation', ''),
      NULLIF(payload->>'error', ''),
      intent
    ),
    websearch_to_tsquery('english', $2),
    'MaxFragments=1,MaxWords=20,MinWords=5'
  ) AS snippet
FROM envelopes
WHERE org_id = $1
  AND type IN ('task', 'result', 'error')
  AND fts_search @@ websearch_to_tsquery('english', $2)
ORDER BY score DESC, ts DESC
LIMIT $3
`;

// ─── Postgres-backed store ────────────────────────────────────────────────────

export class PostgresSessionSearchStore implements SessionSearchStore {
  private pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async search(orgId: string, query: string, limit: number): Promise<SessionSearchResult[]> {
    const result = await this.pool.query(FTS_QUERY, [orgId, query, limit]);
    return result.rows.map(row => ({
      envelope_id: row.envelope_id as string,
      session_id: row.session_id as string,
      ts: row.ts instanceof Date ? row.ts.toISOString() : (row.ts as string),
      type: row.type as string,
      intent: row.intent as string,
      score: parseFloat(row.score as string),
      snippet: row.snippet as string,
    }));
  }
}

// ─── In-memory store (tests / no-DB mode) ────────────────────────────────────

/**
 * In-memory implementation. Always returns empty results.
 * Used in no-DB mode (when DATABASE_URL is not set) so the action handler
 * degrades gracefully with the zero-hits hint rather than throwing.
 */
export class InMemorySessionSearchStore implements SessionSearchStore {
  async search(_orgId: string, _query: string, _limit: number): Promise<SessionSearchResult[]> {
    return [];
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createPostgresSessionSearchStore(pool: pg.Pool): SessionSearchStore {
  return new PostgresSessionSearchStore(pool);
}

export function createInMemorySessionSearchStore(): SessionSearchStore {
  return new InMemorySessionSearchStore();
}
