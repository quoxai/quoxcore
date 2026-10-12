---
name: extract-table
license: LicenseRef-SkillRights-Reserved-1.0
category: browser/automation
version: 1.0.0
edition: stable
author: quox-core
description: Locates the largest HTML table on a Quox browser-q rendered page, extracts all rows as structured JSON with normalised column names, and emits a VOLT evidence record for the extraction.
tags: [table-extraction, html-parsing, structured-data, browser-automation, playwright, json-output, column-normalisation]
best_for_agents: [browser-q]
required_tools: []
required_capabilities: []
related_skills: []
delegate_targets: []
policy_satisfies: []
policy_required: []
kind: procedural
---

# Extract Table

## When to apply

Use this skill when an agent needs to pull structured tabular data from a rendered web page where the data is presented in an HTML `<table>` element. Typical triggers: a monitoring workflow scrapes a status dashboard that does not expose an API, a compliance check collects a published fee schedule or CVE list, or a user asks "pull the data from the table on this page." This skill handles JavaScript-rendered content that plain HTTP fetch cannot capture, because the page is evaluated inside a live Chromium instance. Apply when the target data is the single largest table on the page; if multiple specific tables are needed, invoke the skill multiple times with the `table_selector` override. Do not apply to non-tabular data — for that, use a DOM extraction or screenshot approach instead.

## Inputs

- `url` (string) — Fully qualified HTTP/HTTPS URL of the page containing the table. Required.
- `table_selector` (string, optional) — CSS selector to target a specific `<table>` element. When omitted, the skill selects the table with the greatest number of rows × columns (by cell count). Default: largest table heuristic.
- `header_row` (boolean, optional) — When `true`, treat the first `<tr>` (or all `<th>` cells in the first `<thead>` row) as column headers. Default: `true`.
- `normalise_headers` (boolean, optional) — When `true`, convert column names to lowercase, replace whitespace and special characters with underscores, and deduplicate by appending `_2`, `_3`, etc. for repeated names. Default: `true`.
- `max_rows` (number, optional) — Maximum number of data rows to return. Default: `5000`. Hard cap enforced by the skill regardless of input value.
- `wait_until` (string, optional) — Playwright navigation wait condition. Accepted values: `load`, `domcontentloaded`, `networkidle`. Default: `networkidle`.
- `timeout_ms` (number, optional) — Navigation and extraction timeout in milliseconds. Default: `30000`.
- `corr` (string, optional) — AEE correlation ID inherited from the parent execution context.

## Steps

1. Validate `url` — confirm it is a well-formed HTTP or HTTPS URL. Reject data URIs and non-HTTP schemes.
2. Launch a disposable Playwright Chromium context within the browser-q sandbox with a 1920×1080 viewport. Navigate to `url` using `wait_until` and `timeout_ms`. Record `extraction_start_at` in ISO 8601 UTC.
3. If `table_selector` is provided, locate the target `<table>` element using that selector. If the selector matches zero elements, raise `Table not found`. If `table_selector` is omitted, enumerate all `<table>` elements in the DOM and select the one with the highest total cell count (rows × columns). Ties are broken by document order (first match wins).
4. Extract column headers from the selected table: if `header_row` is `true`, collect text content from `<th>` cells in the first `<thead>` row, or from the first `<tr>` if no `<thead>` is present. If `header_row` is `false`, generate synthetic headers `col_1`, `col_2`, … `col_N`.
5. If `normalise_headers` is `true`, apply the normalisation pipeline to each header string: trim whitespace, lowercase, replace one or more consecutive non-alphanumeric characters with a single underscore, strip leading/trailing underscores, deduplicate repeated names with numeric suffixes.
6. Iterate all `<tbody>` rows (or all `<tr>` rows after the header row when no `<tbody>` is present). For each row, map each cell's trimmed text content to its corresponding normalised column name. Cells that span multiple columns via `colspan` are expanded: the value is placed in the first spanned column and empty strings fill the remaining spanned positions. Stop after `max_rows` data rows are collected.
7. Record `extraction_end_at` in ISO 8601 UTC. Compute `extraction_time_ms`.
8. Emit an AEE envelope with `intent: quox.skill.extract_table` and `corr` from input. Attach `row_count` and `column_count` as envelope metadata.
9. Emit a VOLT evidence record with `evidence_type: table_extraction`, including `url`, `row_count`, `column_count`, `column_names`, and `extraction_time_ms`. The full `rows` payload is not stored in the VOLT record; callers that need durable storage of the row data must persist it via a downstream workflow step.
10. Close and discard the Chromium context and temporary profile.

## Outputs

- `url` (string) — The source URL.
- `table_selector_used` (string) — The CSS selector that was ultimately used to identify the table (either the user-supplied value or the generated selector for the largest table, e.g. `table:nth-of-type(3)`).
- `column_names` (string[]) — Ordered list of normalised column header names.
- `row_count` (number) — Number of data rows returned (excluding the header row).
- `column_count` (number) — Number of columns.
- `rows` (object[]) — Array of row objects, each keyed by the normalised column names.
- `truncated` (boolean) — `true` if the table contained more rows than `max_rows` and was clipped.
- `extraction_start_at` (string) — ISO 8601 UTC timestamp.
- `extraction_end_at` (string) — ISO 8601 UTC timestamp.
- `extraction_time_ms` (number) — Total elapsed time from navigation start to extraction complete.
- `corr` (string) — AEE correlation ID for this extraction.

## Failure modes

- **Table not found:** Raised at Step 3 when `table_selector` is provided but matches no elements, or when no `<table>` elements are present anywhere in the DOM after navigation. Set `status: "failed"`, `error: "No table element found matching selector '<selector>'"`. Emit a VOLT evidence record with the failure reason. The caller should verify the selector or confirm the page renders tabular content.
- **Page navigation timeout:** Raised when the page does not satisfy `wait_until` within `timeout_ms`. Set `status: "failed"`, `error: "Navigation timed out after <timeout_ms>ms"`. Close the Chromium process. Do not return a partial row set; the data state is undefined when the page has not finished loading.
- **Header row ambiguous:** Raised when `header_row` is `true` but the table contains no `<th>` cells and no `<thead>` element, and the first `<tr>` is indistinguishable from a data row. In this case the skill falls back to synthetic headers (`col_1`, `col_2`, …) and sets `header_inferred: true` in the output rather than failing. Log a warning in the AEE envelope metadata so the calling agent can flag this to the user.
- **Extraction result exceeds size limit:** If the serialised JSON of `rows` exceeds 10 MB, the skill truncates to the row count that fits within the limit, sets `truncated: true`, and records the truncation reason. This prevents memory exhaustion in the browser-q process and downstream envelope handling.
- **Sandbox kill:** The browser-q sandbox terminates the Chromium process due to resource budget exhaustion before extraction completes. Set `status: "failed"`, `error: "Browser sandbox terminated process during extraction"`. Emit a VOLT evidence record with `evidence_type: sandbox_kill`. The caller may retry with a more targeted `table_selector` to reduce DOM traversal cost.

## Notes

Column name normalisation is deterministic and idempotent: running it twice on the same input produces the same output. This makes the output safe to use as field keys in downstream database inserts or workflow mappings without additional transformation. When comparing extractions across time (e.g. weekly price table snapshots), callers should store `column_names` from the first run and assert equality on subsequent runs — a schema change in the source table will surface as a column name mismatch. The VOLT `table_extraction` evidence type carries only summary metadata, not the full row payload, to keep the audit log compact. Workflows that need the row data to be durably queryable should route the `rows` output to the collector's `/api/evidence/structured` endpoint immediately after this skill returns.
