/**
 * QSKL-13 — session_search agentic action
 *
 * Searches past envelope sessions using Postgres FTS (tsvector + GIN index
 * created by migration 012-envelopes-fts-search.sql).
 *
 * Multi-tenant: org_id is ALWAYS sourced from the context bag (SessionSearchContext),
 * never from caller params. Any org_id in params is silently ignored.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SessionSearchResult {
  envelope_id: string;
  session_id: string;
  ts: string;
  type: string;
  intent: string;
  score: number;
  snippet: string;
}

export interface SessionSearchStore {
  search(orgId: string, query: string, limit: number): Promise<SessionSearchResult[]>;
}

export interface SessionSearchContext {
  orgId: string;
  params: Record<string, unknown>;
  searchStore: SessionSearchStore;
}

// ─── Result types ─────────────────────────────────────────────────────────────

type SessionSearchSuccess = {
  ok: true;
  results: SessionSearchResult[];
  count: number;
  hint?: string;
};

type SessionSearchError = {
  ok: false;
  error_code: 'EMPTY_QUERY' | 'INVALID_LIMIT';
  reason: string;
};

export type SessionSearchHandlerResult = SessionSearchSuccess | SessionSearchError;

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

const ZERO_HIT_HINT =
  'No matching past sessions. Try broader keywords, or check session-history is being captured.';

// ─── Handler ──────────────────────────────────────────────────────────────────

/**
 * session_search handler.
 *
 * Validates inputs, delegates to the store's search() method, and returns
 * a normalised result shape.
 *
 * Multi-tenant guarantee: org_id is always sourced from ctx.orgId. Any
 * org_id field in ctx.params is ignored.
 */
export async function sessionSearchHandler(
  ctx: SessionSearchContext,
): Promise<SessionSearchHandlerResult> {
  const rawQuery = ctx.params.query;
  const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';

  // ── Input validation ────────────────────────────────────────────────────────

  if (!query) {
    return {
      ok: false,
      error_code: 'EMPTY_QUERY',
      reason: 'session_search requires a non-empty query string',
    };
  }

  const rawLimit = ctx.params.limit;
  const parsedLimit = rawLimit === undefined || rawLimit === null
    ? DEFAULT_LIMIT
    : Number(rawLimit);

  if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
    return {
      ok: false,
      error_code: 'INVALID_LIMIT',
      reason: 'limit must be between 1 and 50',
    };
  }

  // Cap silently at MAX_LIMIT
  const limit = Math.min(parsedLimit, MAX_LIMIT);

  // ── Execute search (org_id from context, never from params) ─────────────────

  const rows = await ctx.searchStore.search(ctx.orgId, query, limit);

  // ── Zero hits ───────────────────────────────────────────────────────────────

  if (rows.length === 0) {
    return {
      ok: true,
      results: [],
      count: 0,
      hint: ZERO_HIT_HINT,
    };
  }

  // ── Positive hits ───────────────────────────────────────────────────────────

  return {
    ok: true,
    results: rows,
    count: rows.length,
  };
}
