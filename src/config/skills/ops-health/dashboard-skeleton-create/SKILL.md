---
name: dashboard-skeleton-create
license: LicenseRef-SkillRights-Reserved-1.0
category: ops/health
version: 1.0.0
edition: stable
author: quox-core
description: Emits a Grafana dashboard JSON skeleton bound to a named service, pre-populated with four standard panels covering latency, error-rate, throughput, and saturation, ready for import or API push.
tags: [grafana, dashboard, observability, latency, error-rate, throughput, saturation]
best_for_agents: [prism]
required_tools: []
required_capabilities: []
related_skills: [prom-range-query]
delegate_targets: []
policy_satisfies: []
policy_required: []
kind: procedural
---

# Dashboard Skeleton Create

## When to apply

Use this skill when an operator or agent needs to bootstrap a Grafana dashboard for a service that does not yet have one, or when an existing dashboard needs to be regenerated from a clean baseline. Typical triggers: a new service is deployed and a dashboard is requested as part of the go-live checklist, an operator asks to create a standard four-golden-signals view for a named service, or an automated provisioning workflow needs to push a dashboard definition to Grafana via its API. This skill produces a complete, importable Grafana JSON document — it does not require Grafana to be reachable at generation time, but the push-to-Grafana step (step 8) does require a configured Grafana API endpoint. Invoke this skill for skeleton creation only; for deep panel customisation, treat the output JSON as a starting point for manual editing in Grafana's UI.

## Inputs

- `service_name` (string) — The service identifier to bind panels to. Used as a Grafana template variable default and in panel titles and PromQL label filters. Required. Must be a valid Prometheus label value (lowercase, alphanumeric, hyphens, underscores).
- `dashboard_title` (string, optional) — Human-readable title for the dashboard. Default: `"<service_name> — Service Overview"`.
- `namespace` (string, optional) — Kubernetes namespace or environment label to scope metric queries (e.g. `production`, `staging`). Default: none (queries are not namespace-scoped). When provided, all panel queries include `namespace="<namespace>"` in the label selector.
- `refresh_interval` (string, optional) — Grafana auto-refresh setting. Default: `"30s"`. Accepted values: `"off"`, `"5s"`, `"10s"`, `"30s"`, `"1m"`, `"5m"`, `"15m"`, `"30m"`, `"1h"`.
- `default_time_range` (string, optional) — Grafana time picker default. Default: `"now-1h"` to `"now"`. Provide as a JSON object `{"from": "now-Xh", "to": "now"}` or use a preset string such as `"last_1h"`, `"last_6h"`, `"last_24h"`, `"last_7d"`.
- `latency_metric` (string, optional) — Base histogram metric name for the latency panel. Default: `"http_request_duration_seconds"`.
- `error_rate_metric` (string, optional) — Counter metric name for the error-rate panel. Default: `"http_requests_total"`. The panel computes `rate(metric{status=~"5.."}[5m]) / rate(metric{}[5m])`.
- `throughput_metric` (string, optional) — Counter metric name for the throughput panel. Default: `"http_requests_total"`. The panel computes `rate(metric{}[5m])`.
- `saturation_metric` (string, optional) — Gauge or summary metric for the saturation panel. Default: `"process_cpu_seconds_total"`. When set to a CPU counter, the panel computes rate-based CPU utilisation.
- `push_to_grafana` (boolean, optional) — When `true`, push the generated dashboard JSON to Grafana via the org-configured `grafana.api_url` using a POST to `/api/dashboards/db`. Default: `false`.
- `grafana_folder` (string, optional) — Target folder title in Grafana. Default: `"Services"`. Used only when `push_to_grafana` is `true`.

## Steps

1. Validate `service_name` against the pattern `^[a-z][a-z0-9_-]{0,62}$`. Reject with `invalid_service_name` if it does not match. Derive `dashboard_title` if not supplied.
2. Construct the Grafana `templating` block with two template variables: `service` (type `constant`, value `service_name`) and `namespace` (type `constant`, value `namespace` or empty string). These variables are referenced as `$service` and `$namespace` in panel queries.
3. Build the four panels in order. Assign each a sequential `id` starting at `1` and a `gridPos` placing them in a 2×2 grid (each panel: `w: 12, h: 8`; positions `x:0,y:0`, `x:12,y:0`, `x:0,y:8`, `x:12,y:8`).
   - **Panel 1 — Latency (p50/p95/p99):** `type: "timeseries"`, title `"Latency — $service"`. Target queries using `histogram_quantile(0.99, rate(<latency_metric>{job="$service"<ns_filter>}[5m]))` and equivalents for p95 and p50. Set `unit: "s"`, legend: `"P99 / P95 / P50"`.
   - **Panel 2 — Error Rate:** `type: "timeseries"`, title `"Error Rate — $service"`. Target query: `rate(<error_rate_metric>{job="$service",status=~"5.."<ns_filter>}[5m]) / rate(<error_rate_metric>{job="$service"<ns_filter>}[5m])`. Set `unit: "percentunit"`, thresholds: warn at `0.01`, critical at `0.05`.
   - **Panel 3 — Throughput (RPS):** `type: "timeseries"`, title `"Throughput — $service"`. Target query: `rate(<throughput_metric>{job="$service"<ns_filter>}[5m])`. Set `unit: "reqps"`.
   - **Panel 4 — Saturation:** `type: "timeseries"`, title `"Saturation (CPU) — $service"`. Target query: `rate(<saturation_metric>{job="$service"<ns_filter>}[5m])`. Set `unit: "percentunit"`, thresholds: warn at `0.70`, critical at `0.90`.
4. Insert `<ns_filter>` as `,namespace="$namespace"` when `namespace` was supplied; omit it entirely when namespace is empty, to avoid injecting an empty label matcher.
5. Construct the top-level dashboard JSON object with fields: `title`, `uid` (generated as `"qx-<service_name>-overview"`, max 40 chars), `schemaVersion: 39`, `version: 1`, `panels` (the four panel objects), `templating` (from step 2), `time` (from `default_time_range`), `refresh` (from `refresh_interval`), `tags: ["quox-generated", "service-overview", service_name]`.
6. Validate the assembled JSON structure: confirm all four panels are present, each has a non-empty `targets` array, and the top-level `uid` is unique within the current generation context (no collision check against Grafana is performed in this step; that is handled at push time).
7. Attach an AEE envelope with `intent: quox.skill.dashboard_skeleton_create`, inheriting `corr` from the caller. Include `service_name`, `dashboard_title`, and `push_to_grafana` as envelope metadata.
8. If `push_to_grafana` is `true`: resolve `grafana.api_url` and `grafana.api_key` from the org configuration store. POST the dashboard JSON wrapped in `{"dashboard": <json>, "folderTitle": "<grafana_folder>", "overwrite": false}` to `<grafana.api_url>/api/dashboards/db`. Record the Grafana-assigned `id` and `url` in the output. On HTTP 412 (dashboard UID already exists), set `push_conflict: true` and return the existing dashboard URL without overwriting.
9. Emit a VOLT evidence record with `evidence_type: dashboard_provisioned` containing `service_name`, `dashboard_uid`, `panel_count: 4`, and (if pushed) the Grafana dashboard URL. Return the structured output object.

## Outputs

- `dashboard_json` (object) — The complete Grafana dashboard JSON object. Always populated regardless of `push_to_grafana`.
- `dashboard_uid` (string) — The generated UID (`"qx-<service_name>-overview"` or truncated form).
- `dashboard_title` (string) — The resolved dashboard title.
- `service_name` (string) — The bound service name (echoed).
- `panel_count` (number) — Number of panels in the generated dashboard. Always `4` on success.
- `panel_titles` (array of string) — Titles of the four generated panels, in grid order.
- `pushed` (boolean) — `true` if the dashboard was successfully pushed to Grafana; `false` if `push_to_grafana` was `false` or if the push failed.
- `grafana_dashboard_url` (string | null) — Full URL of the dashboard in Grafana (e.g. `http://grafana.internal:3000/d/qx-api-server-overview`). `null` when `pushed` is `false`.
- `grafana_dashboard_id` (number | null) — Grafana's internal integer ID assigned at push time. `null` when `pushed` is `false`.
- `push_conflict` (boolean) — `true` when `push_to_grafana` was `true` but a dashboard with the same UID already exists in Grafana. In this case the existing dashboard is not overwritten.
- `volt_evidence_id` (string | null) — VOLT record ID; `null` if VOLT store unavailable.
- `error` (string | null) — Human-readable error message; `null` on success.

## Failure modes

- **invalid_service_name:** `service_name` fails the label-value pattern check. Set `error: "Invalid service_name '<value>': must match ^[a-z][a-z0-9_-]{0,62}$"`. Return immediately before any JSON is generated. The caller should sanitise the service identifier (e.g. replace dots and slashes with hyphens) and retry.
- **grafana_config_missing:** `push_to_grafana` is `true` but `grafana.api_url` or `grafana.api_key` is absent from the org configuration store. Set `error: "Grafana push configured but grafana.api_url or grafana.api_key not set for org <org_id>"`. Still return `dashboard_json` so the caller can offer the JSON for manual import; set `pushed: false`.
- **grafana_push_failed:** The POST to Grafana's API returns a non-2xx, non-412 status. Capture the response body (up to 2 KB). Set `error: "Grafana push failed (HTTP <status>): <response_body>"`. Set `pushed: false` and return `dashboard_json` for manual import. Emit VOLT evidence noting the failed push attempt so the operator can retry.
- **push_conflict:** A dashboard with the same UID already exists in Grafana (HTTP 412). Set `push_conflict: true`, `pushed: false`, `error: null`. Return the existing dashboard URL and advise the caller to either delete the existing dashboard before retrying or supply a different `service_name` to generate a distinct UID.
- **json_validation_failure:** Internal assertion — the assembled JSON is missing required fields or a panel has an empty `targets` array. This indicates a skill implementation defect. Set `error: "Dashboard JSON validation failed: <detail>"`. Do not push or emit VOLT evidence. Report the full validation failure detail so the defect can be reproduced.

## Notes

The generated dashboard uses Grafana schema version 39 (`schemaVersion: 39`), which is compatible with Grafana 10.x and 11.x. Grafana 9.x requires `schemaVersion: 36` or lower — if the org is running an older Grafana, set `schemaVersion` manually in the returned `dashboard_json` before import. The four panels implement the four golden signals (latency, errors, traffic, saturation) as defined by Google SRE principles, providing a consistent baseline across all services. Custom panels should be added in Grafana's UI after import rather than extending this skill's inputs, to keep the generation path simple and reliable. The `uid` format `qx-<service_name>-overview` is intentionally namespaced to avoid collisions with manually created dashboards. The VOLT evidence record emitted at step 9 provides an audit trail of which dashboards were auto-provisioned and when, supporting the `ops:dashboard-governance` policy track when enabled for the org.
