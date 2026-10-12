---
name: objective-decompose
license: LicenseRef-SkillRights-Reserved-1.0
category: workflow
version: 1.0.0
edition: stable
author: quox-core
description: |
  Decompose a high-level objective into a tree of executable QuoxFlow steps,
  each with a tool or agent assignment, typed success criteria, and HITL gates
  where human approval is required before proceeding.
tags: [workflow, planning, decomposition, hitl, quoxflow, objective]
best_for_agents: [weaver]
required_tools: []
required_capabilities: []
related_skills: []
delegate_targets: []
policy_satisfies: []
policy_required: []
kind: procedural
---

# Objective Decompose

## When to apply

Use this skill when WEAVER — the workflow-builder agent — receives a high-level objective
such as "ship the feature", "investigate the outage", or "complete the quarterly audit" and
needs to emit a concrete, executable QuoxFlow workflow rather than leaving the objective as
an unstructured intent. Apply at the start of any planning interaction where the user's
request spans multiple agents, tools, or decision branches. Do not apply when the objective
already maps to a single named skill or tool call.

## Inputs

- `objective` (string) — The high-level objective to decompose. Required.
- `available_agents` (string[]) — Agent IDs that may be assigned to leaf steps (e.g. `["cipher", "nova", "sentinel"]`). Required.
- `available_tools` (string[]) — Tool names registered in the org's tool library. Required.
- `hitl_policy` (`"none"` | `"on_branch"` | `"on_risk"` | `"on_all"`) — When to insert human-in-the-loop gates. Default: `"on_risk"`.
- `max_depth` (number, optional) — Maximum decomposition depth. Default: `4`.
- `context` (object, optional) — Additional structured context to resolve ambiguous objectives (e.g. `{ "environment": "production", "incident_id": "INC-4421" }`).

## Steps

1. **Parse intent:** Identify the primary domain of the objective (security, ops, data, compliance, etc.) and extract any named entities (hosts, agents, services, time windows) present in the `objective` string.

2. **Top-level split:** Emit a QuoxFlow `parallel` node if the objective has independent sub-goals that can proceed concurrently, or a `call` sequence node if steps are strictly ordered. Assign the overall objective as the workflow `description` field.

3. **Recursive decomposition:** For each branch produced in Step 2, recurse up to `max_depth` levels. At each level:
   - If the step maps directly to a registered tool from `available_tools`, emit a `call` node with `tool: <tool_name>` and a typed `success_criteria` object.
   - If the step requires multi-step reasoning or extended execution, emit a `loop` node with an `agent` assignment from `available_agents` and a `termination_condition` field.
   - If the step involves conditional branching on a data value, emit a `condition` or `switch` node with typed `cases`.
   - If the step requires transformation of structured data between prior steps, emit a `transform` node with an explicit `schema_in` and `schema_out`.

4. **HITL gate insertion:** After emitting each leaf or branch node, evaluate whether a HITL gate is required:
   - `hitl_policy: "on_risk"` — insert a `human:approval` node before any step that modifies production state, sends external communications, or allocates resources.
   - `hitl_policy: "on_branch"` — insert a `human:review` node at each `condition`/`switch` node.
   - `hitl_policy: "on_all"` — insert a `human:approval` node before every leaf.
   - `hitl_policy: "none"` — skip all gates.
   HITL nodes must carry `inbox_label` and `timeout_action` (`"escalate"` | `"abort"` | `"auto_approve"`) fields.

5. **Success criteria assignment:** Every leaf node must have a `success_criteria` field with at minimum `{ "type": "status_match", "expected": "ok" }` or a domain-specific schema (e.g. `{ "type": "metric_threshold", "metric": "error_rate", "op": "<", "value": 0.01 }`).

6. **Agent assignment validation:** For every `agent`-assigned node, confirm the assigned agent ID exists in `available_agents`. If not, fall back to the closest-matching agent by domain tag and emit a `warning` in the output.

7. **Emit the workflow tree** as a structured `workflow_plan` object alongside a human-readable `summary` string listing each top-level branch and its assigned owner.

## Outputs

- `workflow_plan` (object) — Fully typed QuoxFlow workflow tree. Nodes follow the QuoxFlow node schema: `{ id, type, description, agent?, tool?, success_criteria, hitl_gate?, children? }`.
- `summary` (string) — Narrative summary of the decomposition: top-level branches, agent assignments, HITL gate count.
- `hitl_gate_count` (number) — Total number of HITL gates inserted.
- `leaf_count` (number) — Total number of leaf (executable) nodes.
- `warnings` (string[]) — Non-fatal issues encountered during decomposition (e.g. agent fallbacks, ambiguous steps). Empty array if none.

## Failure modes

- **Objective too vague to decompose:** If the `objective` cannot be split into discrete steps even after one level of decomposition, emit `workflow_plan: null`, set `warnings: ["objective_too_vague: <reason>"]`, and return a clarifying question in `summary`. Do not emit a partial tree.
- **No available agents or tools:** If `available_agents` and `available_tools` are both empty, abort with `workflow_plan: null` and `warnings: ["no_execution_resources: provide at least one agent or tool"]`.
- **max_depth exceeded:** If a branch has not resolved to leaf nodes at `max_depth`, emit a `call` node with `agent: <best_match>` and `description: "continue decomposition at runtime"`, and add a warning. Do not recurse further.
- **HITL timeout not configured:** If `hitl_policy` requires HITL gates but a gate's `timeout_action` cannot be determined from org policy, default to `"escalate"` and emit a warning.

## Notes

The `workflow_plan` emitted by this skill is intended for direct consumption by the QuoxFlow
workflow engine. The node types `call`, `transform`, `condition`, `switch`, `loop`, and
`parallel` map exactly to QuoxFlow primitives. The HITL `human:approval` and `human:review`
node types route to the org's HITL Inbox queue. Callers should persist the `workflow_plan` via
the collector's `/api/workflows` endpoint before executing, so that the plan is auditable
and replayable via the AEE execution log independent of whether the originating chat session
remains open.
