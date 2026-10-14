'use strict';
/**
 * #815: the tool result for a non-2xx Bastion response.
 *
 * Bastion's 403 body reads "approval required: this request is risky under approval
 * mode ...; present a collector-signed X-Bastion-Approval-Grant". Forwarded verbatim,
 * a model read that as a pending approval and told the user "an approval card has been
 * raised" when none existed. A 403 is a REFUSAL: nothing ran and no card was created.
 * Only the approval gate (lib/approvalGate.js) creates cards, and its result always
 * carries the approval id (approvalId / _approval.id).
 *
 * The "Bastion returned <status>" prefix is kept: lib/toolDoctor.js and log readers
 * key on it.
 */
const DETAIL_MAX = 400;

function bastionHttpErrorResult(status, text) {
  const detail = String(text == null ? '' : text).slice(0, DETAIL_MAX);
  if (Number(status) !== 403) return { success: false, error: `Bastion returned ${status}: ${detail}` };
  return {
    success: false,
    refused: true,
    http_status: 403,
    approval_card_created: false,
    error: `Bastion returned 403 (refused): ${detail}. Nothing ran, and no approval card was created. `
      + 'Tell the user the command was refused; do not say an approval is pending or that a card was raised.',
  };
}

module.exports = { bastionHttpErrorResult };
