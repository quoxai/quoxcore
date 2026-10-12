---
name: port-scan
license: LicenseRef-SkillRights-Reserved-1.0
category: security
version: 1.0.0
edition: stable
author: quox-core
description: Scan a host or CIDR range for open TCP/UDP ports, identify listening services, and flag unexpected exposures against a configured baseline allowlist.
tags: [port-scan, network, exposure, tcp, udp, baseline]
best_for_agents: [sentinel]
required_tools:
  - { name: shell_exec, version_constraint: ">=1.0.0" }
required_capabilities: [network.read, shell.exec]
related_skills:
  - { skill_id: network-egress-snapshot, relation: composes }
  - { skill_id: ssl-audit, relation: composes }
delegate_targets:
  - step: 5
    to_agent: sentinel
    sub_skill: suspicious-egress-trace
    expected_output: { suspicious: boolean, reason: string }
policy_satisfies: [security:audit-trail, network:no-unexpected-exposure]
policy_required: [network:scan-authorised]
kind: procedural
---

# Port Scan

## When to apply

Apply during a periodic network posture sweep, when a new host or service is deployed to the asset registry, or when WARDEN raises an unexpected-exposure alert. Use to validate that only allowed ports are reachable from the control plane. Requires `network:scan-authorised` policy to be satisfied before execution — do not run against hosts outside the authorised asset scope.

## Inputs

- `target` (string) — Single IP, FQDN, or CIDR range (e.g. `192.168.1.0/24`). Required.
- `protocols` (array of strings, optional) — `["tcp"]`, `["udp"]`, or `["tcp", "udp"]`. Default: `["tcp"]`.
- `port_range` (string, optional) — Port range to scan (e.g. `1-1024`, `1-65535`). Default: `1-1024`.
- `allowlist` (array of objects, optional) — Expected open ports: `[{ port, protocol, service }]`. Default: `[]`.
- `timeout_ms` (integer, optional) — Per-port probe timeout in milliseconds. Default: `500`.

## Steps

1. Validate that `target` is within the authorised asset scope; abort with `policy_violation` if not.
2. Resolve `target` to one or more IP addresses; expand CIDR ranges to individual hosts (cap at 256 hosts per invocation).
3. For each host, probe the specified `port_range` using the configured `protocols`; record each responsive port with its protocol and banner response if available.
4. Identify the likely service for each open port using a well-known port-to-service mapping (e.g. 22→ssh, 80→http, 443→https, 3306→mysql).
5. Diff the open port list against `allowlist`; classify each port as `expected`, `unexpected`, or `unknown`.
6. Flag all `unexpected` ports as findings with severity `high`; flag `unknown` ports as severity `info`.
7. For any `unexpected` port associated with a sensitive service (database, admin panel, remote shell), escalate to WARDEN for a suspicious-egress trace.
8. Emit a VOLT evidence envelope per scanned host and return a structured report.

## Outputs

- `results` (array of objects) — One entry per host: `{ host, open_ports[], findings[] }`.
- `summary` (object) — `{ total_hosts, total_open_ports, unexpected_count, unknown_count }`.
- `findings` (array of objects) — All flagged ports: `{ host, port, protocol, service, severity, detail }`.

## Failure modes

- **Host unreachable / all ports filtered:** Record `status: filtered` for the host; do not treat as all-closed; surface in summary.
- **CIDR expansion exceeds cap:** Abort with `error: target_too_large`; advise splitting into smaller ranges.
- **Policy violation — unauthorised target:** Abort immediately with `error: policy_violation`; do not probe any ports; log the attempt.

## Notes

UDP scanning requires elevated privileges on the agent host; if unavailable, skip UDP and add a `warn: udp_skipped` notice to the output. All scan results are emitted as VOLT evidence so historical comparisons are possible. WARD policy `network:scan-authorised` must be satisfied before this skill runs — WARDEN enforces this gate. Bastion routing applies: the scan originates from the Quox control plane, not from individual monitored hosts.
