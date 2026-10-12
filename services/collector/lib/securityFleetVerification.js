'use strict';

/**
 * QUOX-SECURITY Phase 0: production checkFleetMembership implementation,
 * injected as verifyTarget()'s dep at the API layer for the quoxagent_install
 * verification method (securityEngagement.js itself stays pure and
 * dependency-injected, see that file's own header).
 *
 * Proof of control for a private/internal target that dns_txt/well_known_file
 * can never reach (assertSafeEgressHost in securityDomainVerification.js
 * correctly blocks any fetch to a private-LAN address, and that guard is not
 * weakened for this): a target that is already a known, governed member of
 * the real QuoxAgent fleet is, by construction, under the owner's control.
 * This performs a local, same-process read of fleet state, it never installs
 * or configures anything on the target host itself.
 */

const { getFleetStatusLocal } = require('./agentTools.js');

/**
 * @param {string} targetValue - a target's `value` field: hostname or IP.
 * @param {{getFleetStatus?: Function}} deps
 * @returns {Promise<{member: boolean, hostId?: string, ip?: string, health?: string}>}
 */
async function checkFleetMembership(targetValue, deps = {}) {
  const getStatus = deps.getFleetStatus || getFleetStatusLocal;
  const status = await getStatus();
  const hosts = Array.isArray(status?.hosts) ? status.hosts : [];
  const needle = String(targetValue || '').trim().toLowerCase();
  const match = hosts.find(
    (h) => (h.host && String(h.host).toLowerCase() === needle) || (h.ip && String(h.ip).toLowerCase() === needle)
  );
  if (!match) return { member: false };
  return { member: true, hostId: match.host, ip: match.ip, health: match.health };
}

module.exports = { checkFleetMembership };
