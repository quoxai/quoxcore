---
name: sqlite-export
license: LicenseRef-SkillRights-Reserved-1.0
category: data
version: 1.0.0
edition: stable
author: quox-core
description: |
  Export a SQLite table or query result to CSV, JSON, or Parquet —
  preserve column types, stream large results, return file path, row count,
  and schema summary.
tags: [sqlite, export, csv, json, parquet, data-pipeline]
best_for_agents: [archivist]
required_tools: []
required_capabilities: [data.read, fs.write]
related_skills:
  - { skill_id: csv-summarise, relation: composes }
delegate_targets: []
policy_satisfies: [data:audit-trail]
policy_required: []
kind: procedural
---

# SQLite Export

Export a SQLite table or arbitrary SELECT query to a structured file format
(CSV, JSON, or Parquet) while preserving column types and supporting streaming
for large result sets.

## When to apply

Use this skill when an agent needs to extract data from a SQLite database into
a portable file for downstream processing, reporting, or transfer. Apply it for
both full-table exports and filtered query exports. Use it before feeding data
into `csv-summarise` or any analytics pipeline that expects a file input.

## Inputs

- `db_path` (string) — Absolute path to the SQLite database file. Required.
- `source` (string) — Either a table name (e.g. `events`) or a full SELECT statement (e.g. `SELECT id, ts FROM events WHERE status = 'done'`). Required.
- `output_format` (string) — One of `csv`, `json`, or `parquet`. Required.
- `output_path` (string) — Absolute path for the output file. The parent directory must exist. Required.
- `batch_size` (integer) — Number of rows to fetch and write per streaming batch. Defaults to `10000`.
- `include_header` (boolean) — For CSV output, whether to write a header row. Defaults to `true`.

## Steps

1. **Resolve source.** If `source` is a plain identifier (no whitespace, no SQL keywords), treat it as a table name and expand to `SELECT * FROM <source>`. Otherwise treat it as a literal SELECT statement.

2. **Inspect schema.** Before streaming, execute `PRAGMA table_info(<table>)` (or parse column names from the first fetched row for arbitrary queries) to collect `{name, type, notnull, dflt_value}` per column. Store as `schema`.

3. **Open output file.** Create or truncate `output_path`. For `parquet`, initialise a schema-aware writer using the inferred column types. For `csv`, write the header row if `include_header` is true. For `json`, open a top-level array `[`.

4. **Stream in batches.** Fetch rows from SQLite in batches of `batch_size` using `LIMIT`/`OFFSET` iteration. For each batch:
   - Preserve native SQLite types: `INTEGER` → integer, `REAL` → float, `TEXT` → string, `BLOB` → base64-encoded string, `NULL` → null.
   - Write the batch to the output file in the target format.
   - Accumulate `rows_exported`.

5. **Finalise output.** Flush and close the output file writer. For `json`, close the top-level array `]`. For `parquet`, close the row-group and write footer.

6. **Build schema summary.** Construct a summary array of `{column, sqlite_type, nullable}` from the schema captured in step 2.

7. **Return response.** Emit `output_path`, `rows_exported`, `output_format`, `schema_summary`, and `db_path`.

## Outputs

- `output_path` (string) — Absolute path to the written output file.
- `rows_exported` (integer) — Total number of rows written.
- `output_format` (string) — Format of the output file (`csv`, `json`, or `parquet`).
- `schema_summary` (array of `{column, sqlite_type, nullable}`) — Column schema from the source table or query.
- `db_path` (string) — Path of the source SQLite database (echoed for audit trail).

## Failure modes

- **Database file not found:** Return `error: db-not-found` with the supplied `db_path`.
- **Table or query error:** If the SQLite engine raises an error on the source query, return `error: query-failed` with the SQLite error message. Do not write a partial output file.
- **Output path not writable:** Return `error: output-not-writable` with `output_path`. Do not attempt a fallback location.
- **Unsupported format:** Return `error: unsupported-format` listing the valid values (`csv`, `json`, `parquet`).
- **Disk full mid-stream:** Delete the partial output file, return `error: disk-full` with `rows_exported` at point of failure.

## Notes

`db_path` is always caller-supplied. This skill never assumes a default database
location. For large databases (>1 GB), prefer `parquet` output format — it
compresses numeric columns significantly and is faster to parse downstream.
