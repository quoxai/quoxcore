---
name: agentic-skill-loop-design
license: LicenseRef-SkillRights-Reserved-1.0
category: workflow
version: 1.0.0
edition: stable
author: quox-core
description: |
  Design an iterative agentic execution loop for a recurring task: the agent picks
  tools, executes, evaluates against success criteria, patches the skill on Crystal
  threshold, and emits a VOLT evidence envelope per iteration.
tags: [workflow, agentic-loop, crystals, skill-patch, volt, iteration]
best_for_agents: [weaver]
required_tools: []
required_capabilities: []
related_skills: []
delegate_targets: []
policy_satisfies: []
policy_required: []
kind: procedural
---

# Agentic Skill Loop Design

## When to apply

Use this skill when WEAVER — the workflow-builder agent — needs to design a recurring,
self-improving agentic loop for a task that is executed repeatedly (e.g. nightly security
sweep, hourly service health review, continuous data-quality check). The loop must pick the
best tools per run, evaluate results against stated success criteria, and trigger a Crystal
patch via QSKL-4's `applySkillPatch` when repeated successes cross the canonical threshold.
Apply when the caller wants the loop to self-improve over time rather than being a static
script. Do not apply to one-shot tasks.

## Inputs

- `task_description` (string) — Plain-language description of the recurring task. Required.
- `skill_id` (string) — The ID of the existing skill in the `quox_skills` table that this loop will improve. Required.
- `success_criteria` (object) — Structured evaluation rubric the loop uses to grade each iteration. Required. Shape: `{ "metric": string, "op": "<" | "<=" | "==" | ">=" | ">", "threshold": number | string }`.
- `available_tools` (string[]) — Tool names the agent may select from on each iteration. Required.
- `crystal_patch_threshold` (number, optional) — Minimum number of consecutive successful iterations before `applySkillPatch` is called. Default: `3` (matches QSKL-4 canonical threshold).
- `max_iterations` (number, optional) — Hard cap on loop iterations before the workflow self-terminates. Default: `100`.
- `loop_interval_seconds` (number, optional) — Minimum wait between iterations. Default: `0` (run immediately when prior iteration completes).
- `volt_evidence_type` (string, optional) — VOLT envelope `evidence_type` tag to attach to each iteration result. Default: `"skill_loop_iteration"`.

## Steps

1. **Initialise loop state:** Emit a QuoxFlow `call` node that initialises loop metadata: `{ iteration: 0, consecutive_successes: 0, crystal_patched: false, last_patch_at: null }`. Store in the workflow execution context so all subsequent nodes can read it.

2. **Tool selection:** Emit a QuoxFlow `loop` node wrapping Steps 3–8, with `termination_condition: "iteration >= max_iterations OR crystal_patched"`. Inside the loop body, first emit a `call` node that invokes the agent (assigned from `best_for_agents`) to select the best tool from `available_tools` for this iteration, given the task and any observations from prior iterations stored in working context.

3. **Execute selected tool:** Emit a `call` node with `tool: <selected_tool>` resolved at runtime from the selection in Step 2. Pass any required inputs derived from loop context. Capture the raw tool output as `iteration_result`.

4. **Evaluate against success criteria:** Emit a `condition` node that compares `iteration_result` against `success_criteria`. The condition resolves to `pass` or `fail`.

5. **Update consecutive success counter:** Emit a `transform` node:
   - On `pass`: increment `consecutive_successes`; set `last_success_at` to current ISO 8601 UTC timestamp.
   - On `fail`: reset `consecutive_successes` to `0`; record `failure_reason` from `iteration_result`.

6. **Crystal patch gate:** Emit a `condition` node checking `consecutive_successes >= crystal_patch_threshold AND NOT crystal_patched`. On true, emit a `call` node invoking `applySkillPatch(skill_id, patch_payload)` where `patch_payload` captures the winning tool sequence and parameters observed across the successful iterations. This is the QSKL-4 Crystal-eval patch safety primitive — it is idempotent (the `crystal_patched` flag prevents double-patching within one loop run) and the patch is subject to the 60-minute auto-revert window enforced by QSKL-4. Set `crystal_patched: true` in context after the call.

7. **VOLT evidence emission:** After every iteration (pass or fail), emit a `call` node that writes a VOLT envelope with fields: `evidence_type: volt_evidence_type`, `iteration: <n>`, `tool_used: <tool>`, `outcome: "pass" | "fail"`, `consecutive_successes: <n>`, `crystal_patched: <bool>`, `timestamp: <ISO 8601 UTC>`. The VOLT envelope ties each iteration to the parent AEE execution context via `corr` inheritance, satisfying per-iteration audit trail requirements.

8. **Advance loop:** Increment `iteration`. If `loop_interval_seconds > 0`, emit a `call` node that waits for the configured interval before the next loop cycle begins. Return to Step 2.

9. **Loop exit:** When the `termination_condition` from Step 2 resolves, emit a `call` node that writes a final VOLT envelope with `evidence_type: "skill_loop_complete"` and a summary of total iterations, pass/fail counts, and whether a Crystal patch was applied.

## Outputs

- `loop_workflow` (object) — Fully typed QuoxFlow workflow tree representing the loop. The root node is a `loop` type with nested `call`, `condition`, and `transform` children.
- `summary` (string) — Human-readable description of the loop's structure: tool selection strategy, success criteria, patch threshold, VOLT evidence type, and termination condition.
- `estimated_patch_iteration` (number) — The earliest iteration at which `applySkillPatch` may fire, assuming all iterations pass: equals `crystal_patch_threshold`.
- `volt_envelope_schema` (object) — The exact VOLT envelope schema that will be emitted per iteration, so callers can set up evidence queries ahead of first run.

## Failure modes

- **`skill_id` not found in `quox_skills`:** Abort with `loop_workflow: null` and `error: "skill_not_found: <skill_id>"`. Do not design a patch loop for a skill that does not exist — `applySkillPatch` would have nothing to target.
- **`success_criteria` unparseable:** If the `op` field is not one of the allowed operators or `threshold` is missing, abort with `loop_workflow: null` and `error: "invalid_success_criteria: <field>"`.
- **`available_tools` empty:** The loop cannot function without at least one tool. Abort with `loop_workflow: null` and `error: "no_tools_available"`.
- **Crystal patch double-fire guard:** The `crystal_patched` flag in loop context prevents re-firing `applySkillPatch` if the loop continues past the patch point. If the loop is restarted (new execution context), the flag resets — QSKL-4's 60-minute auto-revert window provides the cross-run safety net in that case.
- **`max_iterations` reached without success:** Emit the final VOLT envelope with `outcome: "loop_exhausted"` and `crystal_patched: false`. Surface to the calling agent for review — do not silently terminate.

## Notes

The `applySkillPatch` call in Step 6 uses the shared patch primitive introduced in QSKL-4.
The 60-minute auto-revert window is enforced by the QSKL-4 substrate: if the patched skill
shows degraded performance in the post-patch soak window, the revert fires automatically
without requiring agent intervention. This loop design assumes the QSKL-4 patch safety net
is active; do not remove the `crystal_patched` guard or the patch will fire on every
iteration once the threshold is crossed. VOLT evidence emitted at Step 7 is durable: it
writes to server-side storage via the collector's `/api/evidence` endpoint and is queryable
independent of whether the agent session remains open. For long-running loops with
`loop_interval_seconds > 0`, the QuoxFlow engine's scheduled task system is used, not a
browser timer.
