---
name: container-restart-traced
license: LicenseRef-SkillRights-Reserved-1.0
category: infra/lifecycle
version: 1.0.0
edition: stable
author: quox-core
description: Restarts a named Docker container via the quoxagent per-host API, emitting a full AEE/VOLT envelope around the lifecycle event and running a 30-second liveness probe after restart to confirm the container reached a healthy state.
tags: [docker, container-lifecycle, restart, liveness-probe, aee-envelope, volt-evidence, quoxagent]
best_for_agents: [dockeragent]
required_tools: []
required_capabilities: []
related_skills: []
delegate_targets: []
policy_satisfies: []
policy_required: []
kind: procedural
---

# Container Restart Traced

## When to apply

Use this skill when an operator or automated workflow needs to restart a Docker container on a managed host and requires a complete audit trail of the lifecycle event. Typical triggers include: a container has entered an unhealthy or crash-loop state and a supervised restart is required, a config change has been applied that requires a container bounce, or a scheduled maintenance rotation is running through services. The key differentiator from a raw `docker restart` command is the mandatory AEE/VOLT envelope and the post-restart liveness gate — this skill should not be skipped in favour of a direct SSH command when the action will be audited or when a downstream workflow depends on confirmed liveness. Do not apply this skill for container builds, image updates, or multi-container orchestration — those scenarios require a dedicated lifecycle workflow.

## Inputs

- `host_id` (string) — Canonical host identifier of the machine running the container (e.g. `docker01`, `hyp-04`). Required. Used to route the action to the correct quoxagent instance.
- `container_name` (string) — Name or ID of the Docker container to restart. Required. Must match the container name as shown in `docker ps` on the target host.
- `reason` (string) — Human-readable reason for the restart (e.g. `"crash-loop recovery"`, `"post-config-change bounce"`). Required. Written verbatim into the AEE envelope and VOLT evidence record for audit traceability.
- `liveness_url` (string, optional) — HTTP URL to probe for the post-restart liveness check (e.g. `http://localhost:9848/health`). When omitted, liveness is assessed by checking `docker inspect` container status for `"running"` state only.
- `liveness_poll_interval_s` (number, optional) — Interval in seconds between liveness poll attempts during the 30-second window. Default: `5`.
- `stop_timeout_s` (number, optional) — Seconds to wait for the container to stop gracefully before issuing a SIGKILL. Passed directly to `docker restart -t`. Default: `10`.
- `corr` (string, optional) — AOCL correlation ID from the calling context. When provided, the AEE envelope and VOLT evidence record are linked to the parent execution via this corr id. When omitted, a new root corr id is generated.

## Steps

1. Validate inputs: confirm `host_id` is registered in the Quox host registry and that a quoxagent instance is reachable at the registered endpoint for that host. If the quoxagent health check fails, abort before issuing the restart — emitting a pre-action AEE envelope with status `"aborted"` and reason `"quoxagent_unreachable"`.
2. Open the pre-restart AEE envelope. Record `container_name`, `host_id`, `reason`, and the `corr` id (or newly generated root corr). Set `quox.skill.container_restart_traced.phase: "pre_restart"`. Record the pre-restart container state by calling `docker inspect <container_name>` via the quoxagent API and extracting the current `Status`, `StartedAt`, and `RestartCount` fields.
3. Issue the restart command via the quoxagent per-host API: `POST /containers/<container_name>/restart` with body `{ "stop_timeout": stop_timeout_s }`. Record the HTTP response code and the timestamp (`restart_issued_at`) in the AEE envelope. A non-2xx response from quoxagent is a hard failure — proceed to Failure modes.
4. Poll the container state every `liveness_poll_interval_s` seconds for up to 30 seconds, checking that `docker inspect` reports `Status: "running"` and `StartedAt` is newer than `restart_issued_at`. This confirms the container actually cycled rather than remaining in a pre-existing running state.
5. If `liveness_url` is provided, additionally probe the URL via HTTP GET during the same 30-second window. The container is considered fully live only when both the `running` state and the HTTP 200 response are confirmed. Record each poll attempt result in the AEE envelope under `quox.skill.container_restart_traced.liveness_attempts`.
6. Emit a VOLT evidence record with `evidence_type: container_restart_event` containing: `host_id`, `container_name`, `reason`, `restart_issued_at`, `live_confirmed_at` (or `null` on timeout), `pre_restart_state`, and `post_restart_state`. Link to the parent corr id from the AEE envelope.
7. Close the AEE envelope with the final status (`"success"` if liveness confirmed within 30 seconds, `"liveness_timeout"` otherwise) and return the structured output.

## Outputs

- `host_id` (string) — The target host identifier.
- `container_name` (string) — The restarted container name.
- `restart_issued_at` (string) — ISO 8601 UTC timestamp when the restart command was accepted by quoxagent.
- `live_confirmed_at` (string | null) — ISO 8601 UTC timestamp when the container reached confirmed liveness, or `null` if the 30-second window expired before confirmation.
- `liveness_status` (`"confirmed"` | `"running_unprobed"` | `"timeout"`) — `"confirmed"` means HTTP liveness URL returned 200; `"running_unprobed"` means no `liveness_url` was provided but `docker inspect` reports running; `"timeout"` means 30 seconds elapsed without either condition being met.
- `pre_restart_state` (object) — Container inspect snapshot before restart: `{ status, started_at, restart_count }`.
- `post_restart_state` (object | null) — Container inspect snapshot after liveness confirmed or timeout: `{ status, started_at, restart_count }`. `null` if quoxagent became unreachable after issuing the restart.
- `liveness_attempts` (object[]) — Array of poll results, each containing `attempt_at` (ISO timestamp), `container_running` (boolean), and `http_status_code` (number | null).
- `volt_evidence_id` (string | null) — ULID of the emitted VOLT evidence record.
- `aee_envelope_id` (string) — ULID of the closed AEE envelope for this skill invocation.

## Failure modes

- **quoxagent unreachable before restart:** The quoxagent health check at Step 1 fails. Emit a pre-action AEE envelope with `phase: "aborted"` and `reason: "quoxagent_unreachable"`. Return `liveness_status: "timeout"` and include the quoxagent error in the output. Do not attempt a raw SSH restart as a fallback — unenveloped restarts defeat the purpose of this skill.
- **Restart command rejected by quoxagent:** The quoxagent API returns a non-2xx status at Step 3 (e.g. container not found, permission denied). Close the AEE envelope with `phase: "restart_failed"` and the HTTP response body as the reason. Emit the VOLT evidence record with `live_confirmed_at: null`. The calling agent should verify `container_name` against `docker ps` output on the target host before retrying.
- **Container started but liveness URL unreachable:** The `docker inspect` state transitions to `"running"` within 30 seconds but the HTTP probe at `liveness_url` never returns 200. Return `liveness_status: "timeout"`. This indicates the process started but the application layer is unhealthy — a different remediation path than a clean recovery. The VOLT evidence record captures all poll attempts for diagnosis.
- **Container does not reach running state within 30 seconds:** Neither `docker inspect` running state nor HTTP liveness is confirmed within the window. Return `liveness_status: "timeout"` with `live_confirmed_at: null`. The calling agent should check `docker logs <container_name>` on the target host for crash output before attempting a second restart.
- **quoxagent disconnects after restart issued:** The restart command was accepted but quoxagent becomes unreachable before liveness polling completes (e.g. the container being restarted is quoxagent itself). Return `post_restart_state: null`, `liveness_status: "timeout"`, and note in the AEE envelope that the restart target may be the quoxagent process. Callers should handle this case by attempting a reconnect after 15 seconds.

## Notes

All restarts issued through this skill are fully attributable: the `reason` field is mandatory and written to both the AEE envelope and VOLT evidence record. This satisfies change-audit requirements for organisations with container lifecycle governance policies. The 30-second liveness window is fixed and not configurable — if an application has a known startup time exceeding 30 seconds, the calling workflow should chain a separate `service-health-check` invocation after this skill rather than extending the window here. The quoxagent per-host API is the canonical path for all container operations on Quox-managed hosts; never bypass it with direct SSH docker commands when an audit trail is required.
