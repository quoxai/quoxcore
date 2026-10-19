/**
 * quox#1004: refuse a Wazuh write upfront when this org has no usable Wazuh
 * connection, instead of filing an approval card for an action that can only
 * fail after approval. Resolves exactly as the executor does (getWazuhToken in
 * server.js: resolveCredentialForAgent(orgId, 'argus', 'wazuh') then
 * resolveWazuhConnection), so "passes here" means "the executor can connect".
 *
 * @param {string} orgId
 * @param {{ resolveCredentialForAgent: Function, resolveWazuhConnection: Function }} deps
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
async function checkWazuhConfigured(orgId, { resolveCredentialForAgent, resolveWazuhConnection }) {
  let resolved;
  try {
    resolved = await resolveCredentialForAgent(orgId, 'argus', 'wazuh');
  } catch (err) {
    return { ok: false, error: `The Wazuh credential could not be used: ${err.message}. No approval was filed.` };
  }
  try {
    resolveWazuhConnection(resolved);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `Wazuh is not configured on this install (${err.message}). Open Settings → Plugins → Wazuh → Configure, then retry. No approval was filed.`,
    };
  }
}

module.exports = { checkWazuhConfigured };
