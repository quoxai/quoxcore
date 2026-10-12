---
name: prom-range-query
license: LicenseRef-SkillRights-Reserved-1.0
category: ops/health
version: 1.0.0
edition: stable
author: quox-core
description: Executes a PromQL range query against the org-configured Prometheus instance and returns time-series JSON with automatic downsampling when the result set exceeds the configured point cap.
tags: [prometheus, promql, metrics, time-series, range-query, observability, downsampling]
best_for_agents: [metrics, prism]
required_tools: []
required_capabilities: []
related_skills: [alert-rule-tune]
delegate_targets: []
policy_satisfies: []
policy_required: []
kind: procedural
---

# Prom Range Query

## When to apply

Use this skill whenever an agent or user needs raw time-series data from Prometheus for a defined time window. Typical triggers include: a user asks to graph a metric over the past hour, an automated reliability check needs to evaluate a service's error-rate trend before filing an incident, or another skill (such as `alert-rule-tune`) needs historical series data to compute a threshold proposal. This skill is the canonical path for all PromQL range queries; do not construct raw HTTP calls to the Prometheus API directly, as this skill handles endpoint resolution, authentication header injection, downsampling, and VOLT evidence attachment in a single consistent call.

## Inputs

- `query` (string) — Valid PromQL expression to evaluate. Required.
- `start` (string) — Range start in ISO 8601 UTC or Unix epoch seconds. Required.
- `end` (string) — Range end in ISO 8601 UTC or Unix epoch seconds. Required.
- `step` (string, optional) — Resolution step as a Prometheus duration string (e.g. `30s`, `1m`, `5m`). Default: auto-computed as `(end − start) / 300` to produce at most 300 raw points before downsampling.
- `max_points` (number, optional) — Hard cap on the number of data points returned per series after downsampling. Default: `500`. Values above `2000` are rejected to prevent memory pressure on the calling agent.
- `downsample_method` (string, optional) — Aggregation applied when raw point count exceeds `max_points`. Accepted values: `lttb` (Largest-Triangle-Three-Buckets, default), `avg`, `max`, `min`.
- `timeout_ms` (number, optional) — HTTP timeout for the Prometheus API call. Default: `10000`.

## Steps

1. Resolve the Prometheus base URL from the org configuration store. The key is `prometheus.base_url`; the typical value is `http://prometheus.internal:9090`. If the key is absent, fail immediately with `config_missing` and surface the resolution path to the caller.
2. Normalise `start` and `end` to Unix epoch seconds. If either value is an ISO 8601 string, parse it with UTC semantics. Validate that `end > start`; reject the call with `invalid_range` if not.
3. Compute the effective `step` if not supplied: `step_s = ceil((end_s − start_s) / 300)` seconds, minimum `1s`.
4. Issue an HTTP GET to `<base_url>/api/v1/query_range` with query parameters `query`, `start`, `end`, `step`, and `timeout` (set to `floor(timeout_ms / 1000)`). Inject the org's Prometheus authentication header if configured (`prometheus.auth_header`). Set a hard HTTP client timeout of `timeout_ms`.
5. Validate the response: check `status == "ok"` and `data.resultType == "matrix"`. On any HTTP error or non-ok status, record the raw error body (up to 2 KB) and transition to the relevant failure mode.
6. For each series in `data.result`, count the number of `values` tuples. If the count exceeds `max_points`, apply the `downsample_method` to reduce the series to exactly `max_points` evenly-spaced (or LTTB-selected) points. Preserve the original point count in `raw_point_count` for each series.
7. Attach an AEE envelope with `intent: quox.skill.prom_range_query`, inheriting the `corr` id from the calling context. Include `query`, `start`, `end`, and `step` as envelope metadata.
8. Emit a VOLT evidence record with `evidence_type: metric_query_snapshot`. The record must include `query`, `start`, `end`, `step`, the number of series returned, and the total downsampled point count. This satisfies the `ops:metric-audit` policy track when enabled.
9. Return the structured output object (see Outputs).

## Outputs

- `series` (array) — Array of time-series objects. Each entry contains:
  - `metric` (object) — Label set identifying the series (e.g. `{job: "api-server", instance: "10.0.0.5:8080"}`).
  - `values` (array of `[timestamp_s, value_string]` tuples) — Downsampled data points. Timestamps are Unix epoch seconds (number). Values are strings per Prometheus convention; callers must parse to float.
  - `raw_point_count` (number) — Original point count before downsampling. Equal to `values.length` when no downsampling was applied.
- `series_count` (number) — Total number of series in the result. `0` when the query matched no time-series.
- `step_s` (number) — Effective step in seconds used for the query.
- `query` (string) — The PromQL expression that was executed (echoed for traceability).
- `start_s` (number) — Normalised range start as Unix epoch seconds.
- `end_s` (number) — Normalised range end as Unix epoch seconds.
- `downsampled` (boolean) — `true` if any series was reduced; `false` if all series were returned at full resolution.
- `downsample_method` (string | null) — The method applied; `null` when `downsampled` is `false`.
- `volt_evidence_id` (string | null) — VOLT record ID emitted at Step 8; `null` if the VOLT store is unavailable (non-fatal).
- `error` (string | null) — Human-readable error message; `null` on success.

## Failure modes

- **config_missing:** The org configuration store does not contain `prometheus.base_url`. Set `error: "Prometheus base URL not configured for org <org_id>"`, return an empty `series` array. The calling agent should surface this to the operator — the fix is to set `prometheus.base_url` in org settings. Do not attempt to guess or default to a hardcoded URL.
- **invalid_range:** `end` is not strictly greater than `start`, or either value cannot be parsed as a valid time. Set `error: "Invalid time range: end must be after start"`. Return immediately without issuing any HTTP request.
- **prometheus_unavailable:** The HTTP request to Prometheus fails at the network level (connection refused, DNS failure, timeout). Set `error: "Prometheus unreachable: <reason>"`. Emit VOLT evidence with `evidence_type: metric_source_failure`. Do not retry — surface to the caller for decision on whether to re-enqueue or escalate.
- **query_error:** Prometheus returns `status: "error"` with a `errorType` field (e.g. bad PromQL syntax, query timed out server-side). Capture `errorType` and `error` from the Prometheus response body. Set `error: "PromQL error (<errorType>): <prometheus_error_message>"`. This is a caller input error; do not retry with the same query.
- **oversized_result:** Prometheus returns more series than can be safely processed (threshold: `500` series). Set `error: "Result too large: <n> series returned; narrow the label selector or increase step"`. Return the first 500 series with a truncation flag. Emit VOLT evidence noting the truncation.

## Notes

The Prometheus `/api/v1/query_range` endpoint is synchronous and can be slow for wide time windows with high-cardinality label sets. Callers should set `step` deliberately rather than relying on the auto-computed default for windows longer than 24 hours; a 7-day window with a 30-second step produces over 20,000 raw points per series, which will always trigger downsampling. The LTTB algorithm preserves the visual shape of the series better than uniform-average downsampling and is recommended for any series destined for charting. The `volt_evidence_id` output enables downstream reconciliation between a metric observation and the workflow run that produced it, satisfying EU AI Act Art.12 transparency requirements when the evidence track is active. Related skill `alert-rule-tune` consumes the output of this skill directly — pass the `series` array rather than re-querying.
