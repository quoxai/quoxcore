---
name: service-health-check
license: LicenseRef-SkillRights-Reserved-1.0
category: ops/health
version: 1.0.0
edition: stable
author: quox-core
description: Probes a Quox service or external HTTP endpoint, returning up/down status, response latency, HTTP status code, and any error envelope for failed probes.
tags: [liveness-probe, http-health, latency-measurement, endpoint-monitoring, status-check]
best_for_agents: [nova]
required_tools: []
required_capabilities: []
related_skills: []
delegate_targets: []
policy_satisfies: []
policy_required: []
kind: procedural
---

# Service Health Check

## When to apply

Use this skill when an agent or user needs to verify that a named Quox service or arbitrary HTTP endpoint is reachable and responding within acceptable latency bounds. Typical triggers: a workflow run fails with a network error, a scheduled reliability check fires, or an operator asks "is X up?" Apply before any remediation or escalation to establish current ground truth.

## Inputs

- `target_url` (string) — Full HTTP/HTTPS URL to probe. Required.
- `service_name` (string, optional) — Human-readable name of the service (e.g. `collector`, `quoxflow`). Used in output labels and AEE envelope metadata. Default: derived from URL hostname.
- `method` (string, optional) — HTTP verb for the probe request. Default: `GET`.
- `expected_status` (number, optional) — HTTP status code considered healthy. Default: `200`.
- `timeout_ms` (number, optional) — Request timeout in milliseconds. Default: `5000`.
- `headers` (object, optional) — Additional HTTP headers to include (e.g. `Authorization`). Sensitive values must be sourced from the agent's credential vault, never passed as literals in workflow definitions.
- `body` (string, optional) — Request body for POST/PUT probes. Default: none.

## Steps

1. Resolve `service_name`: if not provided, extract the hostname from `target_url` and use that as the label.
2. Record the probe start timestamp (`probe_start_at`) in ISO 8601 UTC.
3. Issue the HTTP request to `target_url` using `method`, `headers`, and `body` (if set), with a hard timeout of `timeout_ms`. Route outbound requests through the agent's registered network context; for Quox internal services the request travels within the cluster network and does not exit via the bastion.
4. Record the probe end timestamp (`probe_end_at`) and compute `latency_ms = probe_end_at − probe_start_at`.
5. Evaluate health: the probe is `up` if the HTTP response status code matches `expected_status` AND `latency_ms` ≤ `timeout_ms`. Any network error, DNS failure, TLS error, or timeout yields `down`.
6. Attach an AEE envelope tagging this probe result to the parent execution context (field `quox.skill.service_health_check`, corr inherited from caller).
7. Emit the structured output object (see Outputs). If status is `down`, also emit a VOLT evidence record with `evidence_type: liveness_failure` and include the raw error message or non-2xx response body (truncated to 2 KB).

## Outputs

- `service_name` (string) — Resolved service label.
- `target_url` (string) — The probed URL.
- `status` (`"up"` | `"down"`) — Liveness result.
- `http_status_code` (number | null) — Response status code, or `null` on network-level failure.
- `latency_ms` (number | null) — Round-trip latency, or `null` on failure.
- `error` (string | null) — Human-readable error message when `status` is `down`; `null` otherwise.
- `response_body_preview` (string | null) — First 512 characters of the response body; `null` on timeout or hard failure.
- `probe_start_at` (string) — ISO 8601 UTC timestamp when the probe was issued.
- `probe_end_at` (string) — ISO 8601 UTC timestamp when the probe resolved.

## Failure modes

- **DNS resolution failure:** Set `status: "down"`, `http_status_code: null`, `error: "DNS resolution failed for <hostname>"`. Emit VOLT evidence. Do not retry automatically — surface to the calling agent for decision.
- **Timeout exceeded:** Set `status: "down"`, `http_status_code: null`, `latency_ms: timeout_ms`, `error: "Request timed out after <timeout_ms>ms"`. The probe is considered a hard failure; the agent should check whether the service is restarting or overloaded.
- **Non-matching status code:** Set `status: "down"`, record the actual `http_status_code` and `response_body_preview`. This is a soft failure — the service is reachable but unhealthy. The agent may escalate differently from a hard network failure.
- **TLS/certificate error:** Set `status: "down"`, `error: "TLS handshake failed: <reason>"`. Emit VOLT evidence with `evidence_type: tls_failure`. Never silently skip TLS verification.

## Notes

This skill is intentionally stateless per invocation — it does not retain history. For trend analysis and alerting over time, callers should wrap repeated invocations in a QuoxFlow scheduled workflow and persist results via the collector's `/api/evidence` endpoint. When probing Quox internal services (collector, quoxflow, auth), the `target_url` should use the service's internal cluster address (e.g. `http://collector:9848/health`) to avoid routing through the public bastion unnecessarily. The VOLT evidence attachment at Step 7 satisfies the `ops:liveness-audit` policy track when that track is enabled for the org.
