/**
 * Synthetic Test Approver
 *
 * P0b (QUOXPERTICUS DEC-4): the request/perform split for sandbox approvals.
 * The agent only ever REQUESTS a sandbox resolution; the collector PERFORMS it
 * as this synthetic principal over its own internal service channel. No
 * credential is ever delivered to the agent's box, and no agent identity (nor
 * any agent-chosen alias) ever appears on an approval record, sandbox or not.
 * If the agent could present the credential itself, the synthetic principal
 * would be an alias, not a wall.
 *
 * Every performed sandbox resolution is stamped AGENT-DRIVEN-TEST-APPROVAL
 * with the driving agent's id, so the record is honest about what happened:
 * a test approval driven by an agent inside a disposable sandbox, never a
 * human decision.
 */

const TEST_APPROVER_PRINCIPAL = 'synthetic:test-approver';
const TEST_APPROVAL_STAMP = 'AGENT-DRIVEN-TEST-APPROVAL';

/**
 * Prefix the human-visible resolution text (approve comment / deny reason)
 * with the stamp and the driving agent, keeping the agent's original text.
 */
function annotateTestApproval(text, agentKey) {
  const tag = `[${TEST_APPROVAL_STAMP} driven_by=${agentKey}]`;
  const original = typeof text === 'string' ? text.trim() : '';
  return original ? `${tag} ${original}` : tag;
}

module.exports = {
  TEST_APPROVER_PRINCIPAL,
  TEST_APPROVAL_STAMP,
  annotateTestApproval,
};
