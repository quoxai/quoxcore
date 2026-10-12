---
name: suspicious-login-investigation
license: LicenseRef-SkillRights-Reserved-1.0
category: security
version: 1.0.0
edition: stable
author: quox-core
description: Triage a flagged login event by gathering geolocation, session history, IP reputation, and MFA state, then propose targeted containment actions.
tags: [login, authentication, account-security, geolocation, mfa, containment]
best_for_agents: [sentinel]
required_tools:
  - { name: http_call, version_constraint: ">=1.0.0" }
  - { name: db_query, version_constraint: ">=1.0.0" }
required_capabilities: [network.read, data.read]
related_skills: []
delegate_targets:
  - step: 7
    to_agent: sentinel
    sub_skill: suspicious-egress-trace
    expected_output: { suspicious: boolean, reason: string }
policy_satisfies: [security:audit-trail, auth:incident-response]
policy_required: [auth:read-session-data]
kind: procedural
---

# Suspicious Login Investigation

## When to apply

Apply when an authentication system emits a suspicious-login signal — anomalous geolocation, impossible travel, unrecognised device fingerprint, repeated failed attempts followed by success, or login outside established hours. WARDEN should trigger this skill automatically on high-risk login events and present the investigation summary to the human inbox for containment decision.

## Inputs

- `user_id` (string) — Internal user identifier for the flagged account. Required.
- `event_id` (string) — Login event identifier from the auth log. Required.
- `source_ip` (string) — IP address of the flagged login attempt. Required.
- `event_timestamp` (string, ISO 8601) — Timestamp of the flagged login. Required.
- `auth_provider` (string, optional) — Auth provider name (e.g. `quox-auth`, `okta`, `google`). Default: `quox-auth`.
- `containment_auto_apply` (boolean, optional) — If `true`, apply the recommended containment action without human approval. Default: `false`.

## Steps

1. Fetch geolocation for `source_ip` (country, city, ASN, ISP); compare against the user's historical login geography stored in session history.
2. Retrieve the last 30 days of session history for `user_id`; identify the most recent 10 source IPs and their geolocations.
3. Calculate travel velocity between the last known login location and the flagged login location; flag as `impossible_travel` if the implied speed exceeds 900 km/h.
4. Query any concurrent active sessions for `user_id`; note session count, device fingerprints, and geolocations.
5. Check IP reputation using a threat-intel lookup; record risk score, known-malicious flag, VPN/proxy/Tor exit-node classification.
6. Fetch the user's current MFA enrollment state; note whether MFA was bypassed or downgraded during the flagged login.
7. If `source_ip` reputation score is high-risk or `impossible_travel` is true, delegate to WARDEN for a suspicious-egress trace to check whether the IP appears in other recent events.
8. Synthesise all evidence into a risk verdict (`low`, `medium`, `high`, `critical`) and produce an ordered list of recommended containment actions with rationale.

## Outputs

- `verdict` (string) — Risk level: `low`, `medium`, `high`, or `critical`.
- `evidence` (object) — `{ geolocation, travel_velocity_kmh, impossible_travel, concurrent_sessions, ip_reputation, mfa_state }`.
- `recommended_actions` (array of strings) — Ordered containment steps, e.g. `["force_logout_all_sessions", "require_mfa_reenrollment", "notify_user", "lock_account"]`.
- `applied_actions` (array of strings) — Actions taken automatically (populated only when `containment_auto_apply: true`).

## Failure modes

- **IP geolocation lookup fails:** Proceed with remaining steps; note `geolocation: unavailable` in evidence; do not block the investigation.
- **Session history unavailable (auth provider not integrated):** Mark `session_history: unavailable`; still evaluate IP reputation and MFA state; lower confidence in verdict.
- **User not found:** Abort with `error: user_not_found`; log the event for manual review; do not emit partial evidence.

## Notes

When `containment_auto_apply` is `false` (the default), this skill is read-only — it gathers evidence and proposes actions but does not mutate account state. The human-inbox HITL flow should present the verdict and recommended actions for operator approval before any containment action is applied. All evidence is emitted as AEE envelopes and stored as VOLT evidence items so the investigation is fully auditable. WARD policy `auth:incident-response` governs the escalation threshold from `medium` to automatic `high`-risk handling.
