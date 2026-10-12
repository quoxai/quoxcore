---
id: 01KSPL000000000000000000
name: network-egress-snapshot
license: LicenseRef-SkillRights-Reserved-1.0
category: security
version: 1.0.0
edition: stable
author: quox-core
authoring_envelope_id: 01KSPLAUTH000000000000000
description: |
  Capture network egress posture: external IP, ASN, CDN trace, geolocation.
  Three sequential HTTP GETs. Canonicalises into a Crystal after 3 successful
  runs with this exact action pattern.
tags: [security, network, egress, posture]
best_for_agents: [cipher, sentinel]
related_skills:
  - { skill_id: 01KS000000000000000AUTH1, relation: requires }
  - { skill_id: 01KS000000000000000PRB01, relation: composes }
required_tools:
  - { name: http_call, version_constraint: ">=1.0.0" }
required_capabilities: [network.read]
llm_preference: { model: sonnet, max_tokens: 1024 }
model_directives:
  claude-opus-4.7: "Verify each response status; bail on first non-2xx."
  claude-sonnet: "Parallel where safe; serial for ipify->cdn->ipinfo."
  gemini-pro: "Check curl/jq availability; never assume."
delegate_targets:
  - step: 4
    to_agent: sentinel
    sub_skill: suspicious-egress-trace
    expected_output: { suspicious: boolean, reason: string }
policy_satisfies: [security:audit-trail, network:no-secret-leakage]
policy_required: [hipaa:no-phi-egress]
kind: procedural
last_used_at: 2026-05-10T18:42:00Z
last_patched_at: 2026-05-09T22:15:00Z
decay_state: active
evals:
  success_rate_30d: 0.97
  avg_cost_usd: 0.00018
  avg_latency_ms: 4720
  crystal_hit_rate: 0.71
  drift_trend: 0.02
  judge_score: 4.4
---

# Network Egress Snapshot

Three-step audit of the current egress profile.

## Prerequisites

- `http_call` tool available
- Authenticated network access (see `network-auth` skill)

## Steps

### 1. External IP

```http
GET https://api.ipify.org?format=json
```

Capture `ip`.

### 2. CDN trace

```http
GET https://www.cloudflare.com/cdn-cgi/trace
```

Parse `colo`, `loc`, `ts`.

### 3. ASN + geo

```http
GET https://ipinfo.io/json
```

Capture `asn`, `country`, `org`.

### 4. (Conditional) Suspicious-egress trace

If the IP/ASN doesn't match the expected envelope, delegate to WARDEN:

```
delegate_to: sentinel
sub_skill: suspicious-egress-trace
expected_output: { suspicious: boolean, reason: string }
```

## Tests

```yaml
- name: happy-path
  input: { agent_id: cipher }
  expects:
    contains: ["ip", "asn", "country"]
    not_contains: ["ERROR", "denied"]

- name: cdn-down
  input: { mock_cdn_response: 503 }
  expects:
    skill_should_emit: ["retry", "fallback"]
```

## Notes

This skill canonicalises into a Crystal after 3 consecutive successful runs
with the same `(agent_id, action_pattern)`. Once canonical, replay is
$0/run and ~50x faster.
