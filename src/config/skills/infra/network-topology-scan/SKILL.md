---
name: network-topology-scan
license: LicenseRef-SkillRights-Reserved-1.0
category: infra/discovery
version: 1.0.0
edition: stable
author: quox-core
description: Probes declared subnets via ICMP ping and TCP port checks on ports 22 and 443, returning a host-to-host edge list and open-port map suitable for cluster topology mapping in Quox.
tags: [network-discovery, topology-mapping, icmp-probe, port-scan, subnet-sweep, edge-list, cluster-map]
best_for_agents: [atlas, netwatch]
required_tools: []
required_capabilities: []
related_skills: []
delegate_targets: []
policy_satisfies: []
policy_required: []
kind: procedural
---

# Network Topology Scan

## When to apply

Use this skill when an agent needs to build or refresh a map of which hosts are present on the declared subnets and which services are reachable between them. Typical triggers include: a new host has been provisioned and must be located before enrollment, a cluster networking change (VLAN reconfiguration, firewall rule update) requires topology verification, or a baseline snapshot is needed before a maintenance window. This skill is also appropriate as part of a pre-incident evidence collection run when anomalous traffic patterns have been observed. It does not attempt authentication or intrusive probing; ICMP sweep and TCP SYN checks on ports 22 and 443 are the only probe methods used.

## Inputs

- `subnets` (string[]) — CIDR blocks to sweep (e.g. `["192.0.2.0/24", "10.0.0.0/24"]`). Required. At least one subnet must be specified.
- `probe_ports` (number[], optional) — TCP ports to check per discovered host. Default: `[22, 443]`. Callers may extend this list (e.g. add `9848` for collector detection) but should keep the list short to avoid probe duration blowout.
- `icmp_timeout_ms` (number, optional) — Timeout for each ICMP ping probe in milliseconds. Default: `1000`.
- `tcp_timeout_ms` (number, optional) — Timeout for each TCP connection attempt in milliseconds. Default: `2000`.
- `concurrency` (number, optional) — Maximum number of simultaneous probes across all target IPs. Default: `20`. Reduce for low-bandwidth segments.
- `bastion_host` (string, optional) — If set, all probes are issued from the bastion host via an SSH-tunnelled sweep command rather than locally. Default: not set (probes issue from the agent host). For internal subnets (192.0.2.x, 10.0.0.x), always set this to `gw-01`.
- `skip_ips` (string[], optional) — Individual IP addresses to exclude from probing (e.g. management interfaces, known unresponsive equipment). Default: `[]`.

## Steps

1. Expand each CIDR in `subnets` to a flat list of IP addresses, applying `skip_ips` exclusions. Log the total candidate count to the AEE envelope field `quox.skill.network_topology_scan.candidate_count`.
2. If `bastion_host` is set, establish an SSH control socket to the bastion (user: `control`) and confirm connectivity before starting probes. Abort with a clear error if the bastion is unreachable rather than falling back to local probing — local probing of internal subnets would produce incomplete results.
3. Issue ICMP ping probes to all candidate IPs with the configured `icmp_timeout_ms` and `concurrency` limit. Record each IP that responds as a live host. IPs that do not respond to ICMP are not immediately discarded — some hosts have ICMP blocked at the firewall — and proceed to TCP probing.
4. For each candidate IP (regardless of ICMP result), attempt a TCP SYN connection to each port in `probe_ports` with `tcp_timeout_ms`. Record which ports responded with an accepted connection. A host is marked `alive: true` if it responded to ICMP or at least one TCP port.
5. For each pair of discovered alive hosts, record a directed edge `{ source: <ip>, target: <ip>, via: "layer3" }` if TCP port 22 is open on the target (indicating SSH reachability). This edge list represents the SSH-reachable cluster graph. Hosts only reachable via ICMP (no TCP port open) are included as nodes but generate no edges.
6. Attempt a reverse-DNS lookup for each alive host IP to populate the `hostname` field. On lookup failure, set `hostname: null` and continue — DNS resolution is best-effort and does not block edge list construction.
7. Emit a VOLT evidence record with `evidence_type: network_topology_edge` containing the full node list and edge list, the scan parameters, and the scan duration. Attach the AEE corr id from the calling context. Return the structured output (see Outputs).

## Outputs

- `nodes` (object[]) — One entry per alive host discovered. Each node contains:
  - `ip` (string) — IP address.
  - `hostname` (string | null) — Reverse-DNS resolved hostname, or `null`.
  - `alive` (boolean) — Always `true` for entries in this array.
  - `icmp_responsive` (boolean) — Whether the host responded to ICMP ping.
  - `open_ports` (number[]) — Subset of `probe_ports` that accepted a TCP connection. Empty array `[]` if none.
- `edges` (object[]) — Directed edge list representing SSH-reachable pairs. Each edge contains:
  - `source` (string) — Source IP.
  - `target` (string) — Target IP.
  - `via` (string) — Always `"layer3"` for this skill.
- `subnets_scanned` (string[]) — The CIDR blocks that were swept.
- `candidate_count` (number) — Total IP addresses attempted (after skip_ips exclusion).
- `alive_count` (number) — Number of hosts marked alive.
- `scan_duration_ms` (number) — Wall-clock duration of the full probe run in milliseconds.
- `scanned_at` (string) — ISO 8601 UTC timestamp when the scan was initiated.
- `volt_evidence_id` (string | null) — ULID of the emitted VOLT evidence record, or `null` if VOLT emission was skipped.

## Failure modes

- **Bastion connection failure:** When `bastion_host` is configured and the SSH connection to the bastion fails, abort the scan immediately. Return `nodes: []`, `edges: []`, and set the AEE envelope error to `"bastion_unreachable: <reason>"`. Do not fall back to local probing — results from the wrong vantage point would be misleading and could not be compared to prior scans from the bastion.
- **Subnet expansion produces zero addresses:** If all CIDR blocks expand to zero addresses after applying `skip_ips`, return immediately with `candidate_count: 0`, `alive_count: 0`, and a warning in the AEE envelope. This can happen if `skip_ips` inadvertently covers the entire subnet range.
- **All probes time out:** If `alive_count` is zero after completing all ICMP and TCP probes, emit a VOLT evidence record marking the scan as a null result and include the scan duration. A zero-result scan against a previously active subnet is itself significant evidence and must be persisted. Set the AEE envelope status to `"warning"` rather than `"error"` — the scan completed, it simply found nothing.
- **Concurrency-induced packet loss:** On segments with aggressive rate limiting, high concurrency can cause probes to be dropped, producing false negatives. If `alive_count` is unusually low compared to previous scans, append a note to the AEE envelope recommending a re-run with reduced `concurrency` (e.g. `5`) before concluding hosts are offline.
- **Reverse-DNS lookup failure:** Individual DNS lookup failures are non-fatal. Set `hostname: null` for the affected node and continue. If more than 80% of alive hosts return DNS failures, append a warning to the AEE envelope noting a potential DNS resolver misconfiguration.

## Notes

This skill operates at layer 3 (IP) and layer 4 (TCP). It does not perform application-layer probing and cannot determine service versions or application health. For service-level health checks, pair this skill with `service-health-check` after topology discovery. The probe is intentionally non-intrusive: SYN probes without full handshake completion are used where possible to minimise load on target hosts. On subnets shared with production traffic, callers should schedule this scan during low-traffic windows and set `concurrency` to 10 or lower. The VOLT evidence records from repeated scans can be diffed by downstream consumers to detect topology changes (new hosts appearing, hosts disappearing, port state changes) without re-running the scan.
