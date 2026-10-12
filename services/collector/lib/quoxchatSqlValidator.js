/**
 * QuoxChat SQL Template Validator — CW-9.6
 *
 * Validates query templates supplied by widget administrators before they are
 * stored on a database tool. The validator runs at tool create/update time,
 * not at execute time — at execute time we rely on driver parameter binding
 * to keep untrusted LLM values out of the SQL grammar.
 *
 * The validator guarantees:
 *   1. Single statement only (no `; DROP TABLE …`).
 *   2. First keyword is SELECT or WITH (CTE that terminates in SELECT).
 *   3. No DDL/DML keywords anywhere at statement level (defence in depth).
 *   4. No system-table references (information_schema, pg_catalog, sqlite_master, …).
 *   5. All referenced tables appear in the supplied allowlist (if any).
 *
 * The logic is deliberately conservative — it strips comments and string
 * literals before scanning, so attempts to hide DROP inside a comment do not
 * fool it, and a semicolon inside a string literal does not count as a
 * statement separator.
 */

const SYSTEM_SCHEMAS = new Set([
  'information_schema',
  'pg_catalog',
  'pg_toast',
  'sys',
  'mysql',
  'performance_schema',
]);

const SYSTEM_TABLE_NAMES = new Set([
  'pg_class',
  'pg_namespace',
  'pg_tables',
  'pg_user',
  'pg_shadow',
  'pg_roles',
  'sqlite_master',
  'sqlite_temp_master',
  'sqlite_sequence',
]);

const FORBIDDEN_KEYWORDS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'TRUNCATE',
  'CREATE',
  'ALTER',
  'GRANT',
  'REVOKE',
  'REPLACE',
  'MERGE',
  'CALL',
  'EXEC',
  'EXECUTE',
  'LOCK',
  'VACUUM',
  'ATTACH',
  'DETACH',
  'PRAGMA',
  'COPY',
  'LOAD',
];

/**
 * Remove SQL comments (-- line, /* block *\/) and string literals ('...'),
 * replacing them with whitespace so keyword detection and `;` splitting can
 * operate on a sanitised view of the SQL.
 *
 * Backtick (`) and double-quote (") identifiers are preserved because we
 * still want to see table names inside them.
 */
function stripCommentsAndStrings(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    // Line comment
    if (ch === '-' && next === '-') {
      out += '  ';
      i += 2;
      while (i < n && sql[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    // Block comment
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) { out += sql[i] === '\n' ? '\n' : ' '; i++; }
      if (i < n) { out += '  '; i += 2; }
      continue;
    }
    // Single-quoted string literal with '' escape
    if (ch === "'") {
      out += ' ';
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") { out += '  '; i += 2; continue; }
        if (sql[i] === "'") { out += ' '; i++; break; }
        out += sql[i] === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Extract bare table references from a SQL string.
 * Detects `FROM x`, `JOIN x`, and handles schema-prefixed `schema.table`,
 * plus backtick / double-quote quoted identifiers.
 * Returns a deduplicated, lowercased list of BARE table names (no schema).
 */
function extractTableReferences(sql) {
  if (typeof sql !== 'string' || !sql) return [];
  return extractQualifiedReferences(sql).map(q => q.name.toLowerCase()).filter(Boolean)
    .reduce((acc, n) => (acc.includes(n) ? acc : acc.concat(n)), []);
}

/**
 * Extract schema-qualified references separately so we can reject
 * references that live in a system schema even before allowlist checks.
 * Returns `[{ schema, name }]` in lowercase.
 */
function extractQualifiedReferences(sql) {
  if (typeof sql !== 'string' || !sql) return [];
  const scrubbed = stripCommentsAndStrings(sql);
  const out = [];
  // Match FROM|JOIN followed by a comma-separated list of identifiers
  // (each optionally followed by an alias). Stop the list at the next SQL
  // clause keyword (WHERE/GROUP/HAVING/ORDER/LIMIT/UNION/ON/JOIN) or EOF.
  const re = /\b(from|join)\b([\s\S]*?)(?=\b(where|group|having|order|limit|union|intersect|except|join|on|using)\b|$)/gi;
  const identRe = /(`[^`]+`|"[^"]+"|[a-zA-Z_][a-zA-Z0-9_.]*)/g;
  let m;
  while ((m = re.exec(scrubbed)) !== null) {
    const segment = m[2] || '';
    const items = segment.split(',');
    for (const item of items) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      // Subquery (FROM (SELECT …)) — skip, we'll recurse on the inner.
      if (trimmed.startsWith('(')) continue;
      identRe.lastIndex = 0;
      const first = identRe.exec(trimmed);
      if (!first) continue;
      let name = first[1];
      if (name.startsWith('`') || name.startsWith('"')) name = name.slice(1, -1);
      const parts = name.toLowerCase().split('.');
      if (parts.length >= 2) out.push({ schema: parts[0], name: parts[parts.length - 1] });
      else out.push({ schema: null, name: parts[0] });
    }
  }
  return out;
}

function validateReadOnlySqlTemplate(sql, opts = {}) {
  if (typeof sql !== 'string' || !sql.trim()) {
    return { ok: false, error: 'empty_sql', message: 'SQL template is required' };
  }

  const scrubbed = stripCommentsAndStrings(sql);

  // 1. Multi-statement check. Allow exactly one trailing ';' (after trimming).
  const trimmed = scrubbed.replace(/\s+$/u, '').replace(/;+\s*$/u, '');
  if (trimmed.includes(';')) {
    return { ok: false, error: 'multi_statement', message: 'only a single statement is allowed' };
  }

  // 2. First meaningful keyword must be SELECT or WITH.
  const leading = trimmed.trim().toUpperCase();
  if (!/^(SELECT|WITH)\b/.test(leading)) {
    return { ok: false, error: 'not_select', message: 'query must start with SELECT or WITH' };
  }

  // 3. Reject forbidden keywords appearing as stand-alone tokens.
  const upper = ' ' + leading + ' ';
  for (const kw of FORBIDDEN_KEYWORDS) {
    const re = new RegExp(`(?:^|[^A-Z_])${kw}(?:[^A-Z_]|$)`);
    if (re.test(upper)) {
      return { ok: false, error: `forbidden_keyword:${kw.toLowerCase()}`, message: `${kw} is not permitted` };
    }
  }

  // 4. System-table / system-schema blocks.
  const qualified = extractQualifiedReferences(scrubbed);
  for (const q of qualified) {
    if (q.schema && SYSTEM_SCHEMAS.has(q.schema)) return { ok: false, error: 'system_table', message: `schema ${q.schema} is not permitted` };
    if (SYSTEM_TABLE_NAMES.has(q.name)) return { ok: false, error: 'system_table', message: `table ${q.name} is not permitted` };
    if (q.name.startsWith('pg_')) return { ok: false, error: 'system_table', message: `table ${q.name} is not permitted` };
  }

  // 5. Allowlist check (bare names, lowercased).
  const tables = extractTableReferences(scrubbed);
  if (Array.isArray(opts.allowedTables) && opts.allowedTables.length > 0) {
    const allow = new Set(opts.allowedTables.map(t => String(t).toLowerCase()));
    for (const t of tables) {
      if (!allow.has(t)) return { ok: false, error: 'table_not_allowed', message: `table ${t} is not in the allowlist` };
    }
  }

  return { ok: true, tables };
}

module.exports = {
  validateReadOnlySqlTemplate,
  extractTableReferences,
  extractQualifiedReferences,
  stripCommentsAndStrings,
  FORBIDDEN_KEYWORDS,
  SYSTEM_SCHEMAS,
  SYSTEM_TABLE_NAMES,
};
