/**
 * PLUGIN-IMG #1012: where the collector reaches the QuoxPlan server.
 *
 * Order:
 *   1. QUOXPLAN_URL, when set (trailing slashes trimmed). Both compose paths
 *      set it: the dev docker-compose.yml (default http://quoxplan:3107, the
 *      in-network service) and the public docker-compose.plugins.yml overlay
 *      (profile with-quoxplan, which runs the prebuilt image as service
 *      `quoxplan`).
 *   2. Otherwise the historical dev default, http://host.docker.internal:3107,
 *      for a collector run outside compose against a host-run QuoxPlan.
 *
 * One function so the proxy (server.js) and the health map agree.
 */
'use strict';

const DEV_DEFAULT_QUOXPLAN_URL = 'http://host.docker.internal:3107';
const IN_NETWORK_QUOXPLAN_URL = 'http://quoxplan:3107';

function resolveQuoxplanUrl(env = process.env) {
  const raw = typeof env.QUOXPLAN_URL === 'string' ? env.QUOXPLAN_URL.trim() : '';
  if (raw) return raw.replace(/\/+$/, '');
  return DEV_DEFAULT_QUOXPLAN_URL;
}

module.exports = { resolveQuoxplanUrl, DEV_DEFAULT_QUOXPLAN_URL, IN_NETWORK_QUOXPLAN_URL };
