/**
 * Deep Links — quox:// URI scheme
 *
 * Every Quox entity has a canonical URI:
 *   quox://fleet/docker01
 *   quox://workflow/WF_abc123/run/RUN_xyz
 *   quox://agent/sentinel
 *   quox://aee/ENV_789
 *   quox://memory/MEM_123
 *
 * URIs resolve to both a dashboard URL (browser) and a CLI command.
 *
 * CLI-3f (Stream CLI Phase 3)
 */

const ROUTE_MAP = {
  fleet:        { dashboard: '/noc?host=',        cli: 'bastion host show' },
  agent:        { dashboard: '/agents?id=',       cli: 'quox agent get' },
  workflow:     { dashboard: '/workflows?id=',    cli: 'quox workflow get' },
  aee:          { dashboard: '/activity?id=',     cli: 'quox aee get' },
  memory:       { dashboard: '/memory?id=',       cli: 'quox memory get' },
  tool:         { dashboard: '/tools?id=',        cli: 'quox tool get' },
  vault:        { dashboard: '/settings/vault?id=', cli: 'quox vault get' },
  session:      { dashboard: '/fleet?session=',   cli: 'quoxagent agent info' },
  conversation: { dashboard: '/assistants?conv=', cli: 'quox conversation get' },
};

/**
 * Build a quox:// URI for an entity.
 * @param {string} type - Entity type (fleet, workflow, agent, aee, etc.)
 * @param {string} id - Entity ID
 * @param {string} [subpath] - Optional sub-path (e.g., "run/RUN_xyz")
 * @returns {string}
 */
export function buildQuoxUri(type, id, subpath) {
  let uri = `quox://${type}/${id}`;
  if (subpath) uri += `/${subpath}`;
  return uri;
}

/**
 * Resolve a quox:// URI to a dashboard URL and CLI command.
 * @param {string} uri - The quox:// URI
 * @param {string} baseUrl - Dashboard base URL (e.g., http://localhost:3000)
 * @returns {{_ref: string, type: string, id: string, dashboardUrl: string, cliCommand: string}|null}
 */
export function resolveQuoxUri(uri, baseUrl) {
  if (!uri || !uri.startsWith('quox://')) return null;

  const path = uri.slice('quox://'.length);
  const parts = path.split('/');
  const type = parts[0];
  const id = parts[1];

  if (!type || !id) return null;

  const route = ROUTE_MAP[type];
  if (!route) {
    // Unknown type — best effort
    return {
      _ref: uri,
      type,
      id,
      dashboardUrl: `${baseUrl}/${type}?id=${id}`,
      cliCommand: `quox ${type} get ${id}`,
    };
  }

  return {
    _ref: uri,
    type,
    id,
    dashboardUrl: `${baseUrl}${route.dashboard}${id}`,
    cliCommand: `${route.cli} ${id}`,
  };
}
