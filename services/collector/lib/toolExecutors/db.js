/**
 * Postgres DB Query Tool Executor
 *
 * VAULT-AUDIT P4.C — native executor for the `db_query` agent tool. Owns the
 * Postgres connection lifecycle only (connect -> [BEGIN READ ONLY] -> query
 * -> [COMMIT/ROLLBACK] -> disconnect) — credential resolution, input
 * validation, and response shaping live in agentTools.js.
 *
 * SECURITY: this module is handed a plaintext password (via connectionConfig)
 * by the caller for the sole purpose of opening the DB connection. It must
 * never log it, echo connectionConfig, or include it in a thrown error. The
 * default mode is a READ ONLY transaction — any write statement throws at
 * the DB level unless the caller explicitly opts into `readonly: false`.
 * DEFENSE-IN-DEPTH (2026-08-08): a JS-level statement guard also runs BEFORE
 * the pool is touched whenever readonly is true, rejecting non-read
 * statements in JS in addition to the PG-side READ ONLY transaction — see
 * `checkReadOnlyStatement` below. `readonly: false` skips both.
 *
 * Testing seam: the pg Client class is passed in by the caller
 * (agentTools.js) rather than required at module scope here — same
 * rationale as toolExecutors/email.js's ImapFlow seam and toolExecutors/
 * ssh.js's ssh2 Client seam (vitest's module runner does not intercept
 * nested CJS require() calls for bare npm specifiers reliably in this
 * repo's CJS/ESM hybrid setup, and a module-local seam on *this* file
 * wouldn't help either because agentTools.js reaches this module via
 * require() while a vitest spec reaches it via import() — different module
 * cache entries). Passing the implementation through as a call argument
 * avoids the shared-module-instance assumption entirely — agentTools.js
 * exposes __setPgClientForTesting on itself (same instance the test's
 * TOOL_DEFS import uses).
 */

const RealClient = require('pg').Client;

const MAX_ROWS = 1000;

// ---------------------------------------------------------------------------
// JS-level read-only statement guard (owner-approved 2026-08-08 hardening)
//
// The PG "BEGIN TRANSACTION READ ONLY" wrapper above is the primary
// enforcement — Postgres itself rejects a write statement inside that
// transaction. This guard is defense-in-depth ON TOP of that wrapper, not a
// replacement for it: it inspects the SQL text in JS and refuses to touch
// the pool at all for anything that isn't a recognised read statement, so a
// PG-side misconfiguration (a role without a genuinely read-only grant, a
// pooler that silently drops the READ ONLY marker, etc.) isn't the only
// thing standing between an agent and a write.
//
// It runs ONLY when the caller is in readonly mode. `allow_write: true`
// (readonly: false) is the existing, unchanged opt-in and skips this guard
// entirely, same as it already skips the PG transaction wrapper.
// ---------------------------------------------------------------------------

const READ_ONLY_KEYWORDS = new Set(['SELECT', 'EXPLAIN', 'SHOW', 'TABLE', 'VALUES']);
const WRITE_KEYWORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DROP', 'CREATE', 'ALTER',
  'TRUNCATE', 'GRANT', 'REVOKE', 'COMMENT', 'COPY', 'CALL', 'DO',
]);

/** Remove /* *\/ block comments and -- line comments anywhere in the string. */
function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/** Strip leading whitespace, comments, and opening parens to reach the first real token. */
function stripLeadingNoise(sql) {
  let s = sql;
  for (;;) {
    const before = s;
    s = s.replace(/^\s+/, '');
    s = s.replace(/^\(+/, '');
    if (s === before) break;
  }
  return s;
}

/**
 * Inspect a SQL statement destined for a read-only transaction.
 * Returns null when it is allowed, or { error, detail } when it must be
 * rejected before the pool is ever touched.
 */
function checkReadOnlyStatement(sql) {
  const raw = String(sql || '');
  const withoutComments = stripSqlComments(raw);

  // Statement stacking — reject more than one semicolon-separated
  // statement. A single trailing ';' with only whitespace after it is fine.
  const segments = withoutComments.split(';').map((s) => s.trim()).filter(Boolean);
  if (segments.length > 1) {
    return {
      error: 'write_statement_rejected',
      detail: 'multiple statements (statement stacking) are not allowed in a read-only query',
    };
  }

  const head = stripLeadingNoise(withoutComments);
  const match = head.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
  const keyword = match ? match[1].toUpperCase() : '';

  if (keyword === 'WITH') {
    // A CTE's trailing statement, or a writable-CTE body, can both smuggle
    // a write (e.g. `WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d`).
    // Rather than fully parsing the CTE list, scan the whole statement for
    // any write keyword at a word boundary.
    for (const kw of WRITE_KEYWORDS) {
      if (new RegExp(`\\b${kw}\\b`, 'i').test(withoutComments)) {
        return {
          error: 'write_statement_rejected',
          detail: `write statement (${kw}) found inside a WITH query — not allowed in read-only mode`,
        };
      }
    }
    return null;
  }

  if (READ_ONLY_KEYWORDS.has(keyword)) {
    return null;
  }

  if (WRITE_KEYWORDS.has(keyword)) {
    return {
      error: 'write_statement_rejected',
      detail: `write statement (${keyword}) is not allowed in read-only mode`,
    };
  }

  // Default-deny: anything not explicitly recognised as a read statement.
  return {
    error: 'write_statement_rejected',
    detail: `statement is not recognised as read-only (leading token: ${keyword || '(none)'})`,
  };
}

/**
 * Run a single SQL query against a Postgres database using the given
 * connection config, and return a bounded, safe-to-serialize result.
 *
 * @param {object} opts
 * @param {object} opts.connectionConfig - either { host, port, database, user, password } or { connectionString } — never logged/returned
 * @param {string} opts.query - SQL to run
 * @param {Array} [opts.params] - positional query parameters
 * @param {boolean} [opts.readonly=true] - wrap in a READ ONLY transaction (least-privilege default)
 * @param {number} [opts.statementTimeoutMs=15000] - DB-side statement_timeout
 * @param {Function} [opts.Client] - pg Client class override (testing)
 * @returns {Promise<{rows: object[], rowCount: number, fields: string[], truncated: boolean}>}
 */
async function runQuery({
  connectionConfig,
  query,
  params = [],
  readonly = true,
  statementTimeoutMs = 15000,
  Client = RealClient,
}) {
  if (readonly) {
    const guardResult = checkReadOnlyStatement(query);
    if (guardResult) {
      return { success: false, ...guardResult };
    }
  }

  const client = new Client({
    ...connectionConfig,
    statement_timeout: statementTimeoutMs,
    connectionTimeoutMillis: 10000,
  });

  try {
    await client.connect();

    if (readonly) {
      await client.query('BEGIN TRANSACTION READ ONLY');
      let res;
      try {
        res = await client.query(query, params);
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* non-fatal */ }
        throw err;
      }
      await client.query('COMMIT');
      return shapeResult(res);
    }

    const res = await client.query(query, params);
    return shapeResult(res);
  } finally {
    try { await client.end(); } catch { /* non-fatal — connection may never have opened */ }
  }
}

function shapeResult(res) {
  const allRows = res?.rows || [];
  const truncated = allRows.length > MAX_ROWS;
  return {
    rows: truncated ? allRows.slice(0, MAX_ROWS) : allRows,
    rowCount: typeof res?.rowCount === 'number' ? res.rowCount : allRows.length,
    fields: (res?.fields || []).map((f) => f.name),
    truncated,
  };
}

module.exports = {
  runQuery,
};
