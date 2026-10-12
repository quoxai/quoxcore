/**
 * AOCL-CUTOVER-2 / AOCL-DISPATCH-5 — stack mode selector.
 *
 * Reads AOCL_STACK_MODE env var and exposes the three rollout modes:
 *   legacy — the pre-cutover code path (runPreLLMPipeline + inline L8).
 *            Still available for rollback via AOCL_STACK_MODE=legacy.
 *   shadow — runs legacy authoritatively, fires the new stack in parallel
 *            for parity metrics. User-visible behaviour = legacy.
 *   stack  — the new buildChatStack pipeline is authoritative. DEFAULT
 *            since AOCL-DISPATCH Phase 5: parity proven via E2E test
 *            (100/100 inputs, byte-identical to legacy).
 *
 * On any exception in the stack branch, handleCollectorChat falls through
 * to legacy — rollback is automatic even without flipping the env var.
 */

const STACK_MODES = ['legacy', 'shadow', 'stack'];
const DEFAULT_STACK_MODE = 'stack';

function getStackMode(override) {
  const raw = override ?? process.env.AOCL_STACK_MODE ?? DEFAULT_STACK_MODE;
  const normalised = String(raw).toLowerCase().trim();
  return STACK_MODES.includes(normalised) ? normalised : DEFAULT_STACK_MODE;
}

function isLegacy(override) { return getStackMode(override) === 'legacy'; }
function isShadow(override) { return getStackMode(override) === 'shadow'; }
function isStack(override)  { return getStackMode(override) === 'stack'; }

module.exports = { getStackMode, isLegacy, isShadow, isStack, STACK_MODES, DEFAULT_STACK_MODE };
