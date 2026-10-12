---
name: hitl-inbox-route
license: LicenseRef-SkillRights-Reserved-1.0
category: communication
version: 1.0.0
edition: stable
author: quox-core
description: Decide which HITL inbox a flagged item should land in — user inbox, WARDEN queue, triage queue, or on-call escalation — based on item type, severity, and org routing rules.
tags: [hitl, inbox-routing, escalation, sentinel, on-call, governance]
best_for_agents: [beacon]
required_tools: []
required_capabilities: []
related_skills: []
delegate_targets: []
policy_satisfies: []
policy_required: []
kind: procedural
---

# HITL Inbox Route

## When to apply

Use this skill whenever an agent or workflow needs to deliver a flagged item to a human and must first determine the correct inbox destination. Apply before any HITL item is created — routing must be resolved prior to dispatch, not after. Do not use this skill to create the HITL item itself; its sole responsibility is to return a routing decision and the reasoning behind it. Apply when `item_type`, `severity`, and an `org_routing_rules` object (or defaults) are available.

## Inputs

- `item_type` (string) — The category of the flagged item. Recognised values: `"approval_request"`, `"policy_violation"`, `"security_alert"`, `"task_checkpoint"`, `"anomaly_report"`, `"information_request"`. Required.
- `severity` (string) — Severity level of the item. One of `"low"`, `"medium"`, `"high"`, `"critical"`. Required.
- `org_routing_rules` (object, optional) — Org-level overrides for routing thresholds and custom queue mappings. If omitted, the default routing matrix (see Steps) applies.
- `originating_agent` (string, optional) — Agent ID that raised the item (e.g. `"sentinel"`, `"cipher"`, `"nova"`). Used to detect WARDEN self-referral loops (see Failure modes).
- `user_id` (string, optional) — If the item is user-scoped (e.g. an approval they personally requested), their user ID to route to their personal inbox. If absent, routing falls back to queue-based destinations.
- `item_summary` (string, optional) — A one-sentence description of the flagged item included verbatim in the routing output for downstream context.

## Steps

1. **Normalise severity.** Map `severity` to a numeric tier: `low=1`, `medium=2`, `high=3`, `critical=4`. Store as `severity_tier`.

2. **Apply the default routing matrix** (overridden per field by `org_routing_rules` if present):

   | item_type | severity_tier | Destination |
   |---|---|---|
   | `approval_request` | 1–2 | **user inbox** (personal queue of `user_id`, or org-wide triage if no `user_id`) |
   | `approval_request` | 3–4 | **on-call escalation** |
   | `policy_violation` | 1–2 | **WARDEN queue** |
   | `policy_violation` | 3–4 | **on-call escalation** |
   | `security_alert` | 1 | **WARDEN queue** |
   | `security_alert` | 2–4 | **on-call escalation** |
   | `task_checkpoint` | 1–3 | **user inbox** |
   | `task_checkpoint` | 4 | **on-call escalation** |
   | `anomaly_report` | 1–2 | **triage queue** |
   | `anomaly_report` | 3–4 | **on-call escalation** |
   | `information_request` | 1–3 | **user inbox** |
   | `information_request` | 4 | **triage queue** |

3. **Apply org overrides.** If `org_routing_rules` contains a matching `{ item_type, severity }` entry, replace the matrix destination with the org-specified one. Record `overridden_by_org: true` in the output when an override fires.

4. **Resolve `user inbox` destination.** If the matrix destination is `user inbox` but no `user_id` was supplied, downgrade to `triage queue` and record `reason: "no_user_id_supplied"` in the routing note.

5. **Check for WARDEN self-referral.** If `originating_agent` is `"sentinel"` and the resolved destination is `WARDEN queue`, reroute to `triage queue` and record `reason: "sentinel_self_referral_prevented"` to avoid a routing loop.

6. **Compose and return the routing decision object** (see Outputs).

## Outputs

- `destination` (string) — One of: `"user_inbox"`, `"sentinel_queue"`, `"triage_queue"`, `"on_call_escalation"`. This is the definitive routing instruction.
- `destination_label` (string) — Human-readable label for the destination (e.g. `"User Inbox"`, `"WARDEN Queue"`, `"Triage Queue"`, `"On-Call Escalation"`).
- `severity_tier` (number) — Numeric severity tier (1–4) used in the routing decision.
- `overridden_by_org` (boolean) — `true` if an org-level rule changed the default matrix outcome.
- `routing_note` (string) — One-sentence explanation of why this destination was chosen, including any override or fallback reasons. This is the field that must be passed to HITL item creation — never send a vague "file an item" instruction without it.
- `item_summary` (string | null) — Echoed from input if provided, else `null`.

## Failure modes

- **Unknown item_type:** Return `error: "unknown_item_type"` and list the recognised `item_type` values. Do not guess a destination for an unrecognised type.
- **Unknown severity:** Return `error: "unknown_severity"` if `severity` is not one of the four recognised values. Do not default to `low` silently.
- **WARDEN self-referral:** Detected and rerouted in Step 5 — this is not an error but must be recorded in `routing_note` so the audit trail shows the loop was intercepted.
- **Org routing rules malformed:** If `org_routing_rules` is present but fails schema validation (missing `item_type` or `severity` keys, or an unrecognised destination value), ignore the malformed rule, log `org_rule_skipped: true` in the output, and fall back to the default matrix. Do not abort — a routing decision must always be returned.

## Notes

The four valid destination values (`user_inbox`, `sentinel_queue`, `triage_queue`, `on_call_escalation`) are the only strings downstream HITL item creation should ever receive. Vague routing instructions such as "file an item" or "notify someone" are not valid — they will cause silent mis-routing to WARDEN. The `routing_note` field exists specifically to make the rationale auditable and prevent that failure mode. When the routing decision is used to create a HITL item, pass both `destination` and `routing_note` to the creation call.
