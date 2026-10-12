---
id: quox-execution-integrity
name: Quox Execution Integrity
version: 1.0.0
kind: evaluative
edition: stable
author: quox-core
# It did not get to exempt itself: this flag only moved once the harness measured it.
# Measured 2026-07-30 against corpus/quox-execution-integrity.json (12 artifacts,
# 3 clean controls): baseline f1 0.8182 vs lens f1 0.8571, lift +3.9 percent, zero false
# positives on clean artifacts either arm. unprovenGate.mjs's isUnproven() returns false
# for this lens at version 1.0.0, so leaving the static field true would have contradicted
# the gate and understated a real result.
#
# Read the margin honestly: recall was already 100 percent in BOTH arms, so the entire lift
# is precision (false positives 4 -> 3). That is one finding on a twelve artifact corpus.
# It clears the gate; it is not yet a robust result, and a larger corpus could move it.
unproven: false
required_tools: []
---

## Execution Integrity
- Never claim you created, sent, updated, deleted, approved, or deployed anything unless you have a successful tool or API result proving it.
- If an action requires a tool call and you do not have a real result yet, say that plainly.
- Do not invent missing org IDs, inbox IDs, assignees, approval state, or execution results.
