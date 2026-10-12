---
name: host-inventory
license: LicenseRef-SkillRights-Reserved-1.0
category: infra/discovery
version: 1.0.0
edition: stable
author: quox-core
description: Walks known hosts via the registered SSH bastion path and returns structured inventory rows containing host_id, role, IP address, uptime, and kernel version for each reachable host.
tags: [host-discovery, inventory, ssh-bastion, uptime, kernel-version, infrastructure-audit, asset-tracking]
best_for_agents: [atlas]
required_tools: []
required_capabilities: []
related_skills: []
delegate_targets: []
policy_satisfies: []
policy_required: []
kind: procedural
---

# Host Inventory

## When to apply

Use this skill when an operator or automated workflow needs a current snapshot of the reachable host fleet. Typical triggers include: a new infrastructure change requires a baseline inventory, a compliance audit requests a host manifest, an agent needs to confirm which hosts are active before delegating work, or a monitoring alert fires and the operator needs to verify the affected host's role and kernel version. This skill is also appropriate as a scheduled daily collection to detect newly added or decommissioned hosts. It does not attempt remediation; its output is read-only evidence suitable for VOLT attachment.

## Inputs

- `host_ids` (string[], optional) — Explicit list of canonical host identifiers (e.g. `["hyp-01", "docker03", "kuma01"]`) to query. When omitted, the skill walks all hosts registered in the Quox host registry at invocation time.
- `bastion_host` (string, optional) — SSH bastion hostname or IP used to proxy connections to internal hosts. Default: `gw-01` (192.0.2.247).
- `bastion_user` (string, optional) — SSH username on the bastion. Default: `control`.
- `ssh_timeout_s` (number, optional) — Per-host SSH connection and command timeout in seconds. Default: `10`.
- `include_offline` (boolean, optional) — When `true`, offline/unreachable hosts are included in the output with a `reachable: false` row instead of being silently dropped. Default: `false`.

## Steps

1. Resolve the target host list: if `host_ids` is provided, use it directly; otherwise load all registered host entries from the Quox host registry, extracting each `host_id` and its known IP address.
2. Open a control-socket SSH connection to the bastion (`bastion_host` as `bastion_user`) to amortise handshake cost across all target hosts in the batch. Record the bastion connection attempt and result in the AEE envelope with field `quox.skill.host_inventory.bastion_connected`.
3. For each target host, proxy an SSH command through the bastion using `ProxyJump` and run the following compound shell command to collect inventory fields in a single round-trip: `echo "host_id=$(hostname); role=$(cat /etc/quox-role 2>/dev/null || echo unknown); ip=$(hostname -I | awk '{print $1}'); uptime_s=$(cat /proc/uptime | awk '{print $1}'); kernel=$(uname -r)"`. Apply the `ssh_timeout_s` timeout per host.
4. Parse the key=value output from each host into a structured inventory row. Convert `uptime_s` to a human-readable string (e.g. `"14d 3h 22m"`) for the `uptime_human` field while retaining the raw seconds value in `uptime_seconds`.
5. For any host that times out or fails SSH connection, record a row with `reachable: false` and the error reason. If `include_offline` is `false`, exclude these rows from the primary output but retain them in `unreachable_hosts`.
6. Emit a VOLT evidence record with `evidence_type: host_inventory_snapshot` containing the full inventory array and the scan timestamp. Attach the AEE corr id from the calling context so the snapshot is traceable to its parent execution.
7. Close the bastion control socket and return the structured output (see Outputs).

## Outputs

- `inventory` (object[]) — Array of inventory rows for reachable hosts. Each row contains:
  - `host_id` (string) — Canonical host identifier (e.g. `hyp-04`).
  - `role` (string) — Role string from `/etc/quox-role`, or `"unknown"` if the file is absent.
  - `ip` (string) — Primary IP address as reported by `hostname -I`.
  - `uptime_seconds` (number) — Raw uptime in seconds from `/proc/uptime`.
  - `uptime_human` (string) — Human-readable uptime string (e.g. `"3d 11h 5m"`).
  - `kernel` (string) — Kernel version string from `uname -r` (e.g. `"6.8.0-111-generic"`).
  - `reachable` (boolean) — Always `true` for rows in this array.
- `unreachable_hosts` (object[]) — Array of hosts that could not be reached. Each row contains `host_id`, `ip`, `reachable: false`, and `error` (string). Empty array `[]` when all hosts responded.
- `host_count` (number) — Total number of hosts attempted.
- `reachable_count` (number) — Number of hosts that returned data.
- `scanned_at` (string) — ISO 8601 UTC timestamp when the scan was initiated.
- `volt_evidence_id` (string | null) — ULID of the emitted VOLT evidence record, or `null` if VOLT emission was skipped due to a configuration policy.

## Failure modes

- **Bastion unreachable:** If the SSH connection to `gw-01` (or the configured `bastion_host`) fails, the entire skill aborts with `reachable_count: 0`. Set the AEE envelope error field to `"bastion_connection_failed: <reason>"`. Emit a VOLT evidence record with `evidence_type: host_inventory_snapshot` marking all hosts as unreachable and recording the bastion failure. Do not attempt direct connections to internal hosts — the bastion is the only authorised path.
- **Per-host SSH timeout:** Individual host timeouts after `ssh_timeout_s` seconds do not abort the batch. The host is recorded in `unreachable_hosts` with `error: "ssh_timeout"`. The batch continues to remaining hosts. If more than 50% of hosts time out, append a warning to the AEE envelope indicating a likely network partition or bastion load issue.
- **Malformed command output:** If the compound shell command returns output that cannot be parsed as key=value pairs (e.g. due to a non-standard shell or missing commands), record the host row with `role: "parse_error"`, `kernel: "parse_error"`, and preserve the raw output in the `error` field of `unreachable_hosts` for diagnostic use.
- **Empty host registry:** If `host_ids` is not provided and the Quox host registry returns zero entries, the skill returns `inventory: []`, `host_count: 0`, and does not emit a VOLT record. The AEE envelope should reflect this as a warning, not an error — an empty registry may be a legitimate initial state.

## Notes

The role field relies on `/etc/quox-role` being present on managed hosts. Hosts enrolled via `quoxagent` have this file written at install time. Legacy or manually added hosts may return `"unknown"` for role until the file is created. The skill does not write to target hosts and does not require elevated privileges; the `control` user with restricted SSH access is sufficient for all read operations performed here. For high-frequency inventory collection (shorter than 15-minute intervals), callers should check VOLT evidence recency before invoking this skill to avoid redundant bastion load — the VOLT evidence record can serve as a cache for downstream consumers. The `volt_evidence_id` in the output allows callers to retrieve the full snapshot via `/api/evidence/:id` without re-running the collection.
