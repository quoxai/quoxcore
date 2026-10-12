---
name: csv-summarise
license: LicenseRef-SkillRights-Reserved-1.0
category: data
version: 1.0.0
edition: stable
author: quox-core
description: |
  Profile a CSV file — infer column types, compute null-rate per column,
  top-5 values for categorical columns, min/max/median for numeric columns,
  and identify suspected primary-key candidates.
tags: [csv, profiling, data-quality, statistics, schema-inference]
best_for_agents: [archivist]
required_tools: []
required_capabilities: [fs.read]
related_skills:
  - { skill_id: sqlite-export, relation: composes }
delegate_targets: []
policy_satisfies: [data:audit-trail]
policy_required: []
kind: procedural
---

# CSV Summarise

Single-pass profile of a CSV file: column types, null rates, value distributions,
numeric statistics, and primary-key candidates — delivered as a structured
summary without loading the entire file into memory.

## When to apply

Use this skill when an agent receives an unknown or untrusted CSV and needs to
understand its structure before processing, transforming, or ingesting it.
Apply it as the first step in any data pipeline that starts from a CSV input.
Also use it after `sqlite-export` when the downstream consumer needs a schema
and quality report alongside the export.

## Inputs

- `file_path` (string) — Absolute path to the CSV file to profile. Required.
- `delimiter` (string) — Field delimiter character. Defaults to `,`. Common alternatives: `\t` (TSV), `;`, `|`.
- `has_header` (boolean) — Whether the first row contains column names. Defaults to `true`. If `false`, columns are named `col_0`, `col_1`, …
- `sample_rows` (integer) — Maximum rows to read for profiling. Defaults to `50000`. Use `0` for unlimited (streams the full file).
- `top_n` (integer) — Number of top values to return per categorical column. Defaults to `5`.

## Steps

1. **Open and parse headers.** Read the first row as column names (if `has_header` is true). Record `total_columns`.

2. **Stream rows in chunks.** Process the file in streaming chunks of 5000 rows. Stop after `sample_rows` rows (or at EOF if `sample_rows` is `0`). Track `rows_sampled` and `rows_total` (estimated from file size if not fully read).

3. **Infer column types.** For each column, attempt to parse every non-null value as: integer → float → ISO-8601 date/datetime → boolean → string. The type is the most specific type that fits all non-null values in the sample. Record `inferred_type` per column.

4. **Compute null statistics.** For each column count `null_count` (empty string, bare `NULL`, or `\N`). Compute `null_rate` as `null_count / rows_sampled`.

5. **Compute value distribution.**
   - For **numeric** columns (`integer` or `float`): compute `min`, `max`, and `median` (using a reservoir or sorted-sample approach).
   - For **categorical** columns (`string`, `boolean`, `date`): count value frequencies and return the top `top_n` values as `{value, count, pct}` array.

6. **Identify primary-key candidates.** A column is a primary-key candidate when: `null_rate == 0` AND `distinct_count == rows_sampled`. Record these column names in `pk_candidates`. If no column qualifies, return an empty array.

7. **Build summary.** Assemble the `columns` array, each entry containing `name`, `inferred_type`, `null_count`, `null_rate`, and either `stats` (numeric) or `top_values` (categorical).

8. **Return response.** Emit `file_path`, `rows_sampled`, `rows_total`, `total_columns`, `columns`, `pk_candidates`, and `sampled` (boolean — `true` if `rows_total > rows_sampled`).

## Outputs

- `file_path` (string) — Absolute path of the profiled file (echoed).
- `rows_sampled` (integer) — Number of rows read during profiling.
- `rows_total` (integer) — Total rows in the file (exact if fully read; estimated if sampled).
- `total_columns` (integer) — Number of columns detected.
- `sampled` (boolean) — `true` when `rows_total > rows_sampled`.
- `pk_candidates` (array of string) — Column names that qualify as primary-key candidates.
- `columns` (array of objects) — Per-column profile:
  - `name` (string) — Column name.
  - `inferred_type` (string) — One of `integer`, `float`, `date`, `datetime`, `boolean`, `string`.
  - `null_count` (integer) — Count of null/empty values in sample.
  - `null_rate` (float) — Fraction of nulls: `null_count / rows_sampled`.
  - `stats` (object, numeric only) — `{min, max, median}`.
  - `top_values` (array, categorical only) — `[{value, count, pct}, …]` for top `top_n` values.

## Failure modes

- **File not found:** Return `error: file-not-found` with `file_path`.
- **Parse error (malformed CSV):** Return `error: parse-failed` with the offending line number and the raw line text. Include `rows_sampled` at point of failure.
- **Empty file:** Return `error: empty-file` if the file contains zero data rows (header-only is treated as empty).
- **Unsupported encoding:** Return `error: encoding-unsupported` if the file is not valid UTF-8 or UTF-8 with BOM; include detected encoding hint if available.

## Notes

This skill never modifies the source file. All profiling is read-only.
For files larger than 500 MB, set `sample_rows` to a value that keeps memory
under 256 MB (rule of thumb: 50000 rows at ~200 bytes/row ≈ 10 MB).
