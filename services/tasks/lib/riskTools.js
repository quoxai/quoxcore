// riskTools.js — shared HIGH_RISK_TOOLS set.
//
// Split out of autonomyDecision.js so agentStanding.js's risk-tiering
// (redemption eligibility: "3 consecutive clean supervised runs whose
// MINIMUM risk tier is at least the tier that triggered the drop") can
// join against the exact same set makeDecision()'s tool-risk check uses,
// without agentStanding.js <-> autonomyDecision.js forming a circular
// import (autonomyDecision.js also imports agentStanding.js for the
// standing gate).
//
// NOTE (2026-08-09 audit): this is a bypassable denylist — a tool string
// outside this set sails through both makeDecision()'s tool-risk check and
// Standing's risk-tiering unescalated/untiered. That finding is about a
// different design (the tool-risk gate itself) and does not block
// Standing; Standing uses this set as-is, same as makeDecision() does.
export const HIGH_RISK_TOOLS = new Set([
  'ssh_exec', 'system_admin', 'docker_extended',
  'proxmox_vm_action', 'security_audit'
])
