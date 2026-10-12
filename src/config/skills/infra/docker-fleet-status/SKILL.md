---
name: docker-fleet-status
license: LicenseRef-SkillRights-Reserved-1.0
category: infra
version: 1.0.0
edition: stable
author: quox-core
description: Report container health across a Docker host or fleet — running/stopped/restarting counts per service, recent restart spikes, and last 50 log lines for unhealthy containers.
tags: [docker, containers, fleet-health, restart-spike, liveness]
best_for_agents: [nova]
required_tools: []
required_capabilities: [ssh.exec]
related_skills:
  - { skill_name: service-health-check, relation: composes }
delegate_targets: []
policy_satisfies: [ops:fleet-audit]
policy_required: []
kind: procedural
---

# Docker Fleet Status

## When to apply

Use this skill when an operator or agent needs a health snapshot of Docker containers across one or more hosts. Typical triggers: a workflow alert fires on high restart count, a routine fleet health check is scheduled, or an operator asks "what is unhealthy on `<host>`?" Apply before any remediation step to establish current ground truth on container state.

## Inputs

- `hosts` (string[]) — List of hostnames to interrogate. Each host must be reachable via the SSH bastion. Required.
- `services` (string[], optional) — Restrict output to named services (matches Docker Compose service names). Default: all services on each host.
- `restart_spike_threshold` (number, optional) — Containers with restart count above this value within the last hour are flagged. Default: `3`.
- `log_tail_lines` (number, optional) — Number of log lines to fetch per unhealthy container. Default: `50`. Maximum: `200`.

## Steps

1. For each host in `hosts`, open an SSH session via the bastion (`gw-01`). All commands in steps 2–5 run remotely on the target host.
2. Run `docker ps -a --format '{{.Names}}\t{{.Status}}\t{{.Image}}\t{{.RunningFor}}'` to list all containers and their states. Parse into a per-service record: `{ name, status, image, running_for }`.
3. Count containers by state bucket: `running`, `exited`, `restarting`, `paused`, `dead`. Record counts at the host level.
4. Identify restart-spiking containers: run `docker inspect --format '{{.Name}} {{.RestartCount}}' $(docker ps -aq)` and flag any container whose `RestartCount` exceeds `restart_spike_threshold`.
5. For each container with state `restarting`, `exited` (within last 30 minutes), or `dead`, fetch the last `log_tail_lines` lines: `docker logs --tail <log_tail_lines> <container_name> 2>&1`. Attach the output to the container record as `last_log_lines`.
6. Aggregate per-host results into a fleet summary: total running, total unhealthy (any non-running state), host count, and a flat list of containers requiring attention.
7. Emit an AEE envelope for each host scan (`quox.skill.docker_fleet_status.host_scan`) with `corr` inherited from the caller.
8. Return the structured fleet summary (see Outputs). If any container is unhealthy, also emit a VOLT evidence record with `evidence_type: container_unhealthy` for each flagged container.

## Outputs

- `fleet_summary` (object) — Aggregated counts across all scanned hosts.
  - `hosts_scanned` (number) — Number of hosts successfully interrogated.
  - `total_running` (number) — Total running containers fleet-wide.
  - `total_unhealthy` (number) — Total containers in non-running states.
  - `restart_spike_count` (number) — Containers exceeding the restart threshold.
- `hosts` (object[]) — Per-host breakdown.
  - `host` (string) — Hostname.
  - `running` (number) — Running container count.
  - `exited` (number) — Exited container count.
  - `restarting` (number) — Restarting container count.
  - `dead` (number) — Dead container count.
  - `containers` (object[]) — Full container list with `name`, `status`, `image`, `restart_count`, and `last_log_lines` (populated only for unhealthy containers).
- `scanned_at` (string) — ISO 8601 UTC timestamp of the scan.
- `errors` (object[]) — SSH or command failures per host, as `{ host, error }`. Partial fleet results are still returned.

## Failure modes

- **SSH connection refused:** Record the host as unreachable in `errors`. Continue scanning remaining hosts. Do not abort the entire fleet scan for one unreachable host.
- **`docker` not installed on host:** Record error `"docker binary not found on <host>"`. Skip that host. Surface in `errors`.
- **Partial log fetch failure:** If `docker logs` fails for a specific container (e.g. container removed mid-scan), set `last_log_lines: null` and record a warning on the container record. Do not fail the overall skill.
- **All hosts unreachable:** Emit `fleet_summary` with zeroed counts and a non-empty `errors` array. Return `status: "degraded"` to the caller.

## Notes

This skill is stateless per invocation. For trend detection and alerting, wrap repeated invocations in a QuoxFlow scheduled workflow and persist per-container restart counts via `/api/evidence`. SSH sessions go through the bastion at `gw-01`; ensure the target hosts have the agent's SSH key authorised. The `log_tail_lines` cap at `200` prevents runaway token consumption from verbose container logs.
