---
name: urgency-classify
license: LicenseRef-SkillRights-Reserved-1.0
category: communication
version: 1.0.0
edition: stable
author: quox-core
description: Score a freshly received message against a Quox urgency rubric, returning the assigned tier, a structured rationale, and the suggested SLA response window.
tags: [urgency, classification, sla, triage, inbox, message-scoring, hitl]
best_for_agents: [action-q]
required_tools: []
required_capabilities: []
related_skills: []
delegate_targets: []
policy_satisfies: []
policy_required: []
kind: procedural
---

# Urgency Classify

## When to apply

Use this skill whenever a freshly received message, notification, or event arrives at the Quox inbox surface and must be assigned an urgency tier before any routing or display decision is made. Apply it as the first processing step in any inbound HITL pipeline — before lane routing, before card rendering, and before SLA timers are started. This skill is stateless per invocation: it evaluates the single message provided against a rubric and returns a score; it does not accumulate history across messages. Do not use it to re-classify items already assigned a tier unless the message body has materially changed. Apply when `message_body` is available; all other inputs are optional enrichments.

## Inputs

- `message_body` (string) — The full text of the received message or notification. Required.
- `message_source` (string, optional) — Origin channel or system (e.g. `"slack"`, `"email"`, `"webhook"`, `"quox_agent"`). Used as a secondary rubric signal — agent-originated messages from known high-priority agents receive a baseline score boost.
- `sender_role` (string, optional) — Role of the sender within the org (e.g. `"admin"`, `"operator"`, `"external"`, `"agent"`). Messages from `admin` or `agent` senders receive additional weight on the security and policy signal dimensions.
- `org_urgency_config` (object, optional) — Org-level overrides for rubric weights and keyword lists. If omitted, the default rubric applies.
- `corr` (string, optional) — AOCL correlation id from the parent execution context. Echoed through to the output for downstream envelope construction.
- `reference_id` (string, optional) — Caller-supplied identifier for the message (e.g. an existing item id or webhook delivery id). Included in the output for correlation.

## Steps

1. Pre-process `message_body`. Normalise whitespace, lower-case for keyword matching, and extract the first 2,000 characters for rubric evaluation if the body exceeds that length. Record `body_truncated: true` if truncation occurred.

2. Score the message against the five urgency signal dimensions. Each dimension yields a score of 0–4 using the scale `none=0`, `weak=1`, `moderate=2`, `strong=3`, `definitive=4`:

   - **Safety / security signal:** Presence of terms indicating system compromise, data exfiltration, active attack, credential theft, or service outage. Examples: `"breach"`, `"compromised"`, `"down"`, `"outage"`, `"exfiltration"`, `"unauthorized access"`.
   - **Time pressure signal:** Explicit deadline language, countdown language, or elapsed-SLA warnings. Examples: `"urgent"`, `"immediately"`, `"overdue"`, `"deadline"`, `"expires in"`, `"before end of"`, `"SLA breach"`.
   - **Scope / blast radius signal:** Number of users, systems, or services referenced as affected. Score increases with breadth: single resource=1, team or service=2, org-wide=3, multi-org or external customer-facing=4.
   - **Sender authority signal:** Elevated if `sender_role` is `admin` or `agent`. Elevated if the message explicitly invokes an escalation path (e.g. `"escalating"`, `"incident commander"`, `"P0"`, `"SEV1"`).
   - **Explicit tier declaration:** If the message body contains an explicit tier marker (`"critical"`, `"high priority"`, `"normal"`, `"low priority"`, `"P0"`, `"P1"`, `"P2"`, `"P3"`), map it directly to 4, 3, 2, 1 respectively and record `explicit_tier_declared: true`.

3. Apply org rubric overrides. If `org_urgency_config` includes custom keyword lists for any dimension, merge them with the defaults (not replace). If it includes weight multipliers per dimension, apply them to that dimension's raw score before summing.

4. Compute the composite urgency score as the weighted sum of dimension scores:

   ```
   composite = (safety × 3) + (time_pressure × 2) + (scope × 2) + (sender_authority × 1) + (explicit_tier × 4)
   ```

   If `explicit_tier_declared` is `true`, skip the weighted sum and use the explicit tier directly — explicit declarations always win.

5. Map the composite score to a tier:

   | composite score | urgency_tier |
   |---|---|
   | 24–32 | `critical` |
   | 14–23 | `high` |
   | 6–13 | `normal` |
   | 0–5 | `low` |

6. Assign the SLA window for the resolved tier: `critical=30min`, `high=4h`, `normal=24h`, `low=72h`. Compute `sla_respond_by_at` as the current UTC timestamp plus the SLA window duration.

7. Construct the rationale object: for each dimension that contributed score > 0, record the dimension name, the score, and the one to three matching phrases or signals that drove the score. If `explicit_tier_declared` is true, record the matched marker phrase as the sole rationale entry.

8. Return the output object (see Outputs).

## Outputs

- `urgency_tier` (string) — The assigned urgency tier: one of `"critical"`, `"high"`, `"normal"`, `"low"`.
- `composite_score` (number) — The weighted composite score (0–32). Present even when `explicit_tier_declared` is true, for auditing.
- `explicit_tier_declared` (boolean) — `true` when the body contained an explicit tier marker that bypassed the weighted scoring.
- `sla_respond_by_at` (string) — ISO 8601 UTC timestamp by which a human response is required given the assigned tier and current time.
- `sla_window` (string) — Human-readable SLA window (e.g. `"30 minutes"`, `"4 hours"`, `"24 hours"`, `"72 hours"`).
- `dimension_scores` (object) — Map of dimension name to raw score (0–4): `{ safety, time_pressure, scope, sender_authority, explicit_tier }`.
- `rationale` (array of `{ dimension, score, signals }`) — Structured explanation listing the phrases or signals that drove each non-zero dimension score.
- `body_truncated` (boolean) — `true` if `message_body` exceeded 2,000 characters and was truncated before scoring.
- `corr` (string | null) — Echoed from input; `null` if not supplied.
- `reference_id` (string | null) — Echoed from input; `null` if not supplied.

## Failure modes

- **Empty or whitespace-only message body:** Return `error: "empty_message_body"`. Do not assign a default tier — an empty body cannot be classified and the caller must provide a non-empty message. Assigning `low` by default to empty messages would silently under-triage items where the body failed to populate.
- **org_urgency_config schema invalid:** If `org_urgency_config` is present but fails validation (wrong types, unrecognised dimension names, or invalid weight values), discard it entirely, set `org_config_invalid: true`, and proceed with the default rubric. Always return a classification result.
- **All dimension scores zero:** If the composite score is zero and no explicit tier was declared, assign `urgency_tier: "low"` and include `warn: "no_urgency_signals_detected"` in the output. This is a valid result — genuinely routine messages produce low scores — but the warning gives downstream processors visibility to double-check if needed.
- **body_truncated with high-urgency signals near tail:** When `body_truncated` is true and the resolved tier is `normal` or `low`, include `warn: "body_truncated_tier_may_be_under_scored"` to alert the caller that signals in the truncated portion were not evaluated. The caller may re-invoke with a pre-trimmed body focused on the high-signal sections.

## Notes

The urgency rubric is intentionally conservative: it requires multiple corroborating signals to reach `critical` or `high` so that routine noise does not flood the `oncall` lane. The `explicit_tier_declared` bypass exists to honour upstream systems (incident managers, paging tools) that already apply their own triage — Quox should not override a human-assigned `critical` label with a lower automated score. SLA windows (`critical=30min`, `high=4h`, `normal=24h`, `low=72h`) are the canonical defaults used across all communication skills in this category; orgs that operate under stricter contractual SLAs should set their targets in `org_urgency_config` rather than patching this skill. The `rationale` output is specifically designed to be included in the HITL inbox card body so reviewers can see at a glance why an item was scored as it was, reducing re-triage overhead.
