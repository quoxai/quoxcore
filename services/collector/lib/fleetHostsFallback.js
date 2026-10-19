'use strict';

/**
 * quox#1224: a public install ships no Bastion, so GET /api/v1/fleet/hosts used to answer a bare 503
 * while `quox fleet agents` (and the chat fleet_status tool) showed the enrolled host healthy. With no
 * Bastion the agent registry IS the host inventory: this module shapes it like a Bastion host row and
 * says plainly where the list came from. One truth for the CLI route and the chat tool.
 */

const NO_BASTION_PREFIX = 'no Bastion on this install';

function agentsToHostRows(agentList) {
  return (agentList || []).map((a) => {
    const conn = a.status?.connection || 'unknown';
    const lastSeenSeconds = typeof a.status?.last_seen_seconds === 'number' ? a.status.last_seen_seconds : null;
    return {
      id: a.host_id,
      ip: a.remote_addr || a.ip || '',
      group: 'agent',
      source: 'agent-registry',
      status: {
        state: conn === 'connected' ? 'active' : conn,
        health: a.status?.health || 'unknown',
        last_seen: lastSeenSeconds === null ? null : new Date(Date.now() - lastSeenSeconds * 1000).toISOString(),
      },
    };
  });
}

/** Plain-English one-liner naming the enrolled agents (never a bare status code). */
function describeNoBastion(hosts) {
  if (!hosts.length) {
    return `${NO_BASTION_PREFIX}, and no agents are enrolled yet. Enrol a host with \`quox fleet enrol <host>\`.`;
  }
  return `${NO_BASTION_PREFIX}; enrolled agents: ${hosts.map((h) => h.id).join(', ')}`;
}

module.exports = { agentsToHostRows, describeNoBastion, NO_BASTION_PREFIX };
