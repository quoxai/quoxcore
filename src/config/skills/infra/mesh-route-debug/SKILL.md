---
name: mesh-route-debug
license: LicenseRef-SkillRights-Reserved-1.0
category: infra/network
version: 1.0.0
edition: stable
author: quox-core
description: Resolves a hostname through the active mesh routing table managed by the meshnet agent, returning the full next-hop chain and observed round-trip time per hop for diagnosing overlay routing issues in Quox.
tags: [mesh-routing, next-hop, rtt-measurement, overlay-network, meshnet, route-debug, network-path]
best_for_agents: [meshnet]
required_tools: []
required_capabilities: []
related_skills: []
delegate_targets: []
policy_satisfies: []
policy_required: []
kind: procedural
---

# Mesh Route Debug

## When to apply

Use this skill when an operator or agent needs to trace how a hostname resolves through the active mesh overlay and determine whether the routing path is optimal, degraded, or broken. Typical triggers include: a service is experiencing unexpectedly high latency and the cause may be a suboptimal mesh route, a host has been added or removed from the overlay and the routing table has not yet converged, a mesh peering link is suspected to be down and the actual forwarding path must be confirmed, or a baseline route snapshot is needed before a network maintenance event. This skill reads the live routing table from the meshnet agent — it does not modify routes, flush tables, or force reconvergence. For route modification, use the dedicated mesh management skill.

## Inputs

- `target_hostname` (string) — The hostname or mesh-registered name to resolve and trace (e.g. `docker03`, `hyp-07`, `kuma01`). Required. Must be a name resolvable within the mesh overlay; public DNS names are not supported.
- `source_node` (string, optional) — The mesh node from which to evaluate the route. Default: the node local to the meshnet agent processing this skill invocation. Setting this to a remote node causes the agent to relay the query via the mesh control plane.
- `probe_count` (number, optional) — Number of RTT measurement packets to send per hop for averaging. Default: `3`. Higher values improve accuracy at the cost of additional probe traffic.
- `probe_timeout_ms` (number, optional) — Maximum wait time in milliseconds for each RTT probe packet response. Default: `2000`.
- `include_routing_table_excerpt` (boolean, optional) — When `true`, include the raw routing table entries relevant to the target in the output for low-level debugging. Default: `false`.

## Steps

1. Query the meshnet agent's routing table API for all entries matching `target_hostname`. If the hostname is not found in the overlay routing table, check whether it resolves to an IP address present in the table; record the resolution path (hostname → IP → table entry) in the AEE envelope field `quox.skill.mesh_route_debug.resolution_path`.
2. Extract the next-hop sequence from the routing table entry: the primary route (lowest metric) and any alternate routes (higher metric). Record the full next-hop chain for the primary route as an ordered list of `{ node_id, ip, metric }` objects.
3. For each hop in the primary next-hop chain, issue `probe_count` ICMP or UDP probe packets with TTL set to expire at that hop. Record the responses and compute `rtt_avg_ms`, `rtt_min_ms`, `rtt_max_ms`, and `packet_loss_pct` per hop. Apply `probe_timeout_ms` to each individual probe. Unresponsive hops (packet loss 100%) are recorded with `rtt_avg_ms: null` and `status: "no_response"`.
4. Determine the route health classification for the primary path:
   - `"healthy"` — All hops respond, no packet loss, and end-to-end RTT is within the mesh baseline for this path segment.
   - `"degraded"` — One or more hops show >10% packet loss or RTT exceeding 2× the baseline.
   - `"broken"` — Packet loss is 100% at any hop, meaning the path is not forwarding traffic to the target.
   - `"unresolved"` — The target hostname was not found in the routing table at all.
5. If `include_routing_table_excerpt` is `true`, retrieve and include the raw routing table rows for the target from the meshnet agent's `/routes` endpoint. Redact any credential or pre-shared-key fields before including the excerpt in the output.
6. Emit a VOLT evidence record with `evidence_type: mesh_route_snapshot` containing the hop chain, per-hop RTT measurements, route health classification, and the resolved target IP. Attach the AEE corr id from the calling context.
7. Return the structured output (see Outputs).

## Outputs

- `target_hostname` (string) — The input hostname that was resolved.
- `target_ip` (string | null) — Resolved IP address within the mesh overlay, or `null` if the hostname could not be resolved.
- `source_node` (string) — The mesh node from which the route was evaluated.
- `route_health` (`"healthy"` | `"degraded"` | `"broken"` | `"unresolved"`) — Overall classification of the primary route path.
- `primary_route` (object[]) — Ordered hop chain for the primary (lowest-metric) route. Each entry contains:
  - `hop_index` (number) — Position in the chain (1-based).
  - `node_id` (string) — Mesh node identifier at this hop.
  - `ip` (string) — IP address of the hop.
  - `metric` (number) — Routing metric at this hop as reported by the routing table.
  - `rtt_avg_ms` (number | null) — Average RTT in milliseconds across `probe_count` probes, or `null` on no response.
  - `rtt_min_ms` (number | null) — Minimum observed RTT, or `null`.
  - `rtt_max_ms` (number | null) — Maximum observed RTT, or `null`.
  - `packet_loss_pct` (number) — Percentage of probe packets that received no response (0–100).
  - `status` (`"ok"` | `"degraded"` | `"no_response"`) — Per-hop health status.
- `alternate_routes` (object[]) — Summary of non-primary routes found for the same target. Each entry contains `next_hop_ip`, `metric`, and `hop_count`. Empty array `[]` if no alternates exist.
- `routing_table_excerpt` (object[] | null) — Raw routing table rows for the target when `include_routing_table_excerpt` is `true`; `null` otherwise.
- `resolved_at` (string) — ISO 8601 UTC timestamp when the routing table was queried.
- `volt_evidence_id` (string | null) — ULID of the emitted VOLT evidence record, or `null` if emission was skipped.

## Failure modes

- **Hostname not in mesh routing table:** The target hostname does not appear in the routing table and its IP (if resolvable by DNS) is also absent. Return `route_health: "unresolved"`, `target_ip: null`, `primary_route: []`. Emit the VOLT evidence record with the unresolved status — this is a significant finding and must be persisted. The calling agent should verify the host was enrolled in the mesh overlay and that the meshnet agent has received a routing update since enrollment.
- **meshnet agent API unreachable:** The meshnet agent's routing table API does not respond within the probe timeout. Abort the skill and return `route_health: "broken"` with an AEE envelope error of `"meshnet_agent_unreachable"`. This can indicate the meshnet agent process itself has crashed; escalate to a container health check on the meshnet agent host before requerying.
- **Partial probe failure (degraded path):** Some hops return RTT measurements but one or more hops in the chain show 100% packet loss (no response). Return `route_health: "broken"` and mark the non-responsive hops with `status: "no_response"` and `rtt_avg_ms: null`. The hops before the first silent hop are still valuable for identifying where the path breaks.
- **Routing table returns multiple conflicting entries:** The meshnet agent returns two or more primary routes with equal metrics for the same target, indicating a routing table inconsistency. Return the first entry as `primary_route` and all others as `alternate_routes`, and append a warning to the AEE envelope noting the metric collision. The meshnet agent should be queried for a convergence status before trusting the route.
- **`source_node` is unreachable for relay:** When `source_node` is set to a remote node and the meshnet agent cannot relay the query to that node, fall back to the local node and record `source_node_requested` and `source_node_used` separately in the output. Do not silently substitute — the caller may be diagnosing a route from a specific vantage point and must know the vantage point changed.

## Notes

RTT measurements in this skill reflect the mesh overlay path, not the underlying physical network path. A high overlay RTT on a local subnet hop indicates mesh encapsulation overhead or congestion, not physical link degradation — use a separate layer-3 traceroute (outside the mesh) to distinguish overlay vs. underlay problems. The `probe_count` default of 3 is a balance between accuracy and probe traffic volume; for critical paths or high-jitter links, callers should increase this to 10 or more to get a stable RTT average. The VOLT evidence records emitted by this skill over time can be used to build RTT trend baselines per mesh path segment, enabling detection of gradual route degradation before it becomes a user-visible outage.
