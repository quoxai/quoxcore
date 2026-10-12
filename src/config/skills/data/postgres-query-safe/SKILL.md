---
name: postgres-query-safe
license: LicenseRef-SkillRights-Reserved-1.0
category: data
version: 1.0.0
edition: stable
author: quox-core
description: |
  Run a parameterised SELECT against a Quox Postgres database with row-cap,
  statement-timeout, and read-only enforcement — refuse any non-SELECT,
  refuse cross-schema joins to system tables, return rows and summary stats.
tags: [postgres, sql, read-only, parameterised, safety, query]
best_for_agents: [scholar]
required_tools: []
required_capabilities: [data.read]
related_skills: []
delegate_targets: []
policy_satisfies: [data:audit-trail, data:query-safety]
policy_required: [data:read-only-query]
kind: procedural
---

# Postgres Query (Safe)

Read-only, parameterised SELECT execution against a Quox Postgres database with
hard safety rails — row cap, statement timeout, and schema-fence enforced at
every run.

## When to apply

Use this skill whenever an agent needs to read rows from a Postgres database.
Apply it before any ad-hoc query, scheduled report query, or data-export
pipeline that targets Postgres. Do not use it for DDL, DML, or stored-procedure
calls; reject those callers and direct them to an authorised migration workflow.

## Inputs

- `connection_string` (string) — Postgres DSN of the form `postgres://user:pass@host:5432/db`. Required.
- `query` (string) — The SELECT statement to execute. Must start with `SELECT` (after stripping leading whitespace and comments). Required.
- `params` (array) — Ordered bind parameters corresponding to `$1`, `$2`, … placeholders in `query`. Required; use an empty array `[]` when the query has no placeholders.
- `row_cap` (integer) — Maximum rows to return. Defaults to `500`; maximum allowed value is `5000`.
- `timeout_ms` (integer) — Statement timeout in milliseconds. Defaults to `10000` (10 s); maximum allowed value is `60000`.
- `schema` (string) — Allowed schema name. Defaults to `public`. Cross-schema references outside this value are rejected.

## Steps

1. **Validate query intent.** Strip leading whitespace and SQL block comments (`/* … */`). If the resulting string does not begin with `SELECT` (case-insensitive), abort immediately with `error: non-select-rejected` and return no rows.

2. **Enforce schema fence.** Parse the query for schema-qualified identifiers (pattern `<schema>.`). If any referenced schema is not `pg_catalog`, `information_schema`, or the caller-supplied `schema` value, abort with `error: cross-schema-rejected`.

3. **Reject system-table joins.** Reject any query that references `pg_`, `information_schema.`, or `sys.` tables outside of pure metadata introspection (i.e., when combined in a JOIN with user tables). Abort with `error: system-table-join-rejected`.

4. **Build parameterised command.** Construct the query using the supplied `params` array as positional bind values (`$1`, `$2`, …). Never concatenate parameter values into the query string.

5. **Apply caps to query.** Append `LIMIT <row_cap>` to the query if no `LIMIT` clause is already present. Set the session-level statement timeout: `SET LOCAL statement_timeout = '<timeout_ms>ms'` inside the transaction.

6. **Open read-only transaction.** Execute `BEGIN READ ONLY` before running the query. Commit (or rollback on error) immediately after fetching results. Never issue `COMMIT` without a preceding `BEGIN READ ONLY`.

7. **Execute and collect results.** Run the parameterised query. Capture the result set as an array of row objects. Record `rows_returned`, `columns` (name + inferred type), and wall-clock `duration_ms`.

8. **Build summary stats.** For each numeric column compute `min`, `max`, and `avg`. For all columns compute `null_count` and `null_rate`. Attach to the response as `stats`.

9. **Return response.** Emit `rows`, `rows_returned`, `columns`, `stats`, `duration_ms`, and `truncated` (boolean — true if `rows_returned == row_cap`).

## Outputs

- `rows` (array of objects) — Query result rows, up to `row_cap` entries.
- `rows_returned` (integer) — Actual count of rows in `rows`.
- `truncated` (boolean) — `true` when the result was capped at `row_cap`.
- `columns` (array of `{name, type}`) — Column names and inferred Postgres types.
- `stats` (object) — Per-column summary: `null_count`, `null_rate`, and for numeric columns `min`, `max`, `avg`.
- `duration_ms` (integer) — Wall-clock time for the query execution.

## Failure modes

- **Non-SELECT query supplied:** Abort before opening any connection; return `error: non-select-rejected` with the offending statement prefix.
- **Cross-schema reference detected:** Abort before execution; return `error: cross-schema-rejected` listing the disallowed schema names.
- **System-table join detected:** Abort; return `error: system-table-join-rejected`.
- **Statement timeout exceeded:** The database raises an exception; catch it, rollback, return `error: statement-timeout` with `timeout_ms` echoed.
- **Connection failure:** Return `error: connection-failed` with the Postgres error code; do not retry automatically.
- **Bind parameter count mismatch:** Return `error: param-count-mismatch` with expected vs. actual counts before any network call.

## Notes

This skill does not store credentials. `connection_string` must be passed in at
call time from a vault-backed secret, not hard-coded. `<connection_string>` in
examples is a placeholder for the caller's vault-resolved DSN.
