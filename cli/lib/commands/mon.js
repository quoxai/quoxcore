/**
 * Monitoring commands: Docker fleet, Wazuh security monitoring, AGH-chain
 * agent honesty leaderboard, Prometheus metrics, and monitoring config.
 *
 * quox mon docker fleet|containers|container|logs|stats|stacks|df|action
 * quox mon wazuh status|agents|alerts|vulns|deploy-history|deploy-agent|deploy-bulk|active-response
 * quox mon agh-chain leaderboard|agent|events
 * quox mon metrics
 * quox mon config get|cache|grafana
 *
 * Backend: services/collector/server.js. See endpoints/mon.js's header for
 * the full auth/org-scoping verification per route family (WP4.3,
 * STREAM_CLI_PARITY_PLAN.md §2.3 #10) — summary:
 *   - `/docker/*` — NO auth middleware, no org filter (fleet-wide).
 *   - `/api/v1/wazuh/*` — requireServiceOrUserAuth(); not org-filtered by
 *     the Wazuh API itself; deploy-agent/deploy-bulk/active-response are
 *     HITL-gated (queue an HITL Inbox approval, return 202, do not execute
 *     immediately).
 *   - `/api/v1/agh-chain/*` — requireServiceOrUserAuth() AND genuinely
 *     org-scoped (403s without req.user.org_id).
 *   - `/metrics` — NO auth middleware, plain text (Prometheus exposition
 *     format), not JSON.
 *   - `/api/v1/monitoring/config` — optional auth; `/api/v1/monitoring/
 *     cache/:service` and `/api/v1/grafana/config` — requireServiceOrUserAuth().
 *     None of the three are org-scoped (single shared config/cache).
 */

import { formatOutput, formatDetail, printSuccess, printWarning, printInfo } from '../core/output.js';
import { parseJSON } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';

async function confirmOrSkip(program, options, message) {
  if (options.force || program.opts().yes) return true;
  const { default: inquirer } = await import('inquirer');
  const ans = await inquirer.prompt([{ type: 'confirm', name: 'confirm', message, default: false }]);
  return ans.confirm;
}

export function registerMonCommands(program, ctx) {
  const { client, auth } = ctx;

  const mon = program
    .command('mon')
    .description('Monitoring: Docker fleet, Wazuh security, AGH-chain leaderboard, metrics');

  // ══════════════════════════════════════════════════════════════════════
  // docker
  // ══════════════════════════════════════════════════════════════════════

  const docker = mon
    .command('docker')
    .description('Docker fleet: hosts, containers, stacks, disk usage');

  docker
    .command('fleet')
    .description('Discover Docker hosts across the fleet')
    .option('--refresh', 'force a live scan instead of returning the cache')
    .action(async (options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('mon.docker.fleet.list');
      const data = await client.get(ep.path, { service: ep.service, query: options.refresh ? { refresh: 'true' } : undefined });
      const hosts = data.hosts || [];
      formatOutput({
        // fleet #392: docker fleet rows are id/containers_total/docker_version; ip and status don't exist.
        columns: ['id', 'containers_total', 'containers_running', 'docker_version'],
        headers: ['Host', 'Containers', 'Running', 'Docker'],
        rows: hosts,
      }, { format: program.opts().output, emptyMessage: 'No Docker hosts found.' });
    });

  docker
    .command('containers')
    .description('List containers across the fleet (or a single host)')
    .option('--host <hostId>', 'filter to a single host')
    .option('--no-all', 'only running containers (default includes stopped)')
    .option('--refresh', 'force a live fetch instead of returning the cache')
    .action(async (options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('mon.docker.containers.list');
      const query = {};
      if (options.host) query.host = options.host;
      if (options.all === false) query.all = 'false';
      if (options.refresh) query.refresh = 'true';
      const data = await client.get(ep.path, { service: ep.service, query });
      formatOutput({
        columns: ['host_id', 'id', 'name', 'image', 'state', 'status'],
        headers: ['Host', 'ID', 'Name', 'Image', 'State', 'Status'],
        rows: data.containers || [],
      }, { format: program.opts().output, emptyMessage: 'No containers found.' });
    });

  docker
    .command('container')
    .description('Show container detail (stats + recent logs)')
    .argument('<id>', 'container ID')
    .requiredOption('--host <hostId>', 'host the container lives on')
    .action(async (id, options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('mon.docker.containers.get', { id });
      const data = await client.get(ep.path, { service: ep.service, query: { host: options.host } });
      formatDetail(data, {
        format: program.opts().output,
        title: `Container: ${id} (${options.host})`,
        fields: ['host', 'container', 'stats', 'logs'],
        labels: { host: 'Host', container: 'Container', stats: 'Stats', logs: 'Logs' },
      });
    });

  docker
    .command('logs')
    .description('Show container logs')
    .argument('<id>', 'container ID')
    .requiredOption('--host <hostId>', 'host the container lives on')
    .option('--tail <n>', 'number of lines', '100')
    .action(async (id, options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('mon.docker.containers.logs', { id });
      const data = await client.get(ep.path, { service: ep.service, query: { host: options.host, tail: options.tail } });
      if (program.opts().output === 'json') {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(data.logs || '');
      }
    });

  docker
    .command('stats')
    .description('Show container resource stats')
    .argument('<id>', 'container ID')
    .requiredOption('--host <hostId>', 'host the container lives on')
    .action(async (id, options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('mon.docker.containers.stats', { id });
      const data = await client.get(ep.path, { service: ep.service, query: { host: options.host } });
      formatDetail(data.stats || data, { format: program.opts().output, title: `Stats: ${id} (${options.host})` });
    });

  docker
    .command('stacks')
    .description('List Docker Compose stacks')
    .option('--host <hostId>', 'filter to a single host')
    .action(async (options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('mon.docker.stacks.list');
      const data = await client.get(ep.path, { service: ep.service, query: options.host ? { host: options.host } : undefined });
      formatOutput({
        columns: ['host_id', 'name', 'status', 'services'],
        headers: ['Host', 'Stack', 'Status', 'Services'],
        rows: data.stacks || [],
      }, { format: program.opts().output, emptyMessage: 'No stacks found.' });
    });

  docker
    .command('df')
    .description('Show Docker disk usage on a host')
    .requiredOption('--host <hostId>', 'host to query')
    .action(async (options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('mon.docker.system-df.get');
      const data = await client.get(ep.path, { service: ep.service, query: { host: options.host } });
      formatDetail(data, { format: program.opts().output, title: `Docker disk usage: ${options.host}` });
    });

  docker
    .command('action')
    .description('Start/stop/restart a container (destructive)')
    .argument('<id>', 'container ID')
    .argument('<action>', 'start|stop|restart')
    .requiredOption('--host <hostId>', 'host the container lives on')
    .option('--force', 'skip confirmation')
    .action(async (id, action, options) => {
      auth.requireAuth();
      if (!['start', 'stop', 'restart'].includes(action)) {
        throw new Error(`Invalid action: ${action}. Must be one of: start, stop, restart.`);
      }
      const confirmed = await confirmOrSkip(program, options, `${action} container ${id} on ${options.host}?`);
      if (!confirmed) {
        printInfo('Cancelled.');
        return;
      }
      const ep = resolveEndpoint('mon.docker.containers.action', { id, action });
      const data = await client.post(ep.path, { service: ep.service, body: { host: options.host } });
      if (data.success === false) {
        printWarning(`Action failed: ${data.error || 'unknown error'}`);
        return;
      }
      printSuccess(`Container ${id}: ${action} succeeded.`);
    });

  // ══════════════════════════════════════════════════════════════════════
  // wazuh
  // ══════════════════════════════════════════════════════════════════════

  const wazuh = mon
    .command('wazuh')
    .description('Wazuh security monitoring: manager status, agents, alerts, vulnerabilities');

  wazuh
    .command('status')
    .description('Show Wazuh manager status')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('mon.wazuh.manager-status.get');
      const data = await client.get(ep.path, { service: ep.service });
      formatDetail(data.data || data, { format: program.opts().output, title: 'Wazuh Manager Status' });
    });

  wazuh
    .command('agents')
    .description('List Wazuh agents')
    .option('--status <status>', 'filter by agent status')
    .option('--limit <n>', 'max results')
    .option('--offset <n>', 'result offset')
    .option('--q <query>', 'query string passed through to the Wazuh API')
    .action(async (options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('mon.wazuh.agents.list');
      const query = {};
      if (options.status) query.status = options.status;
      if (options.limit) query.limit = options.limit;
      if (options.offset) query.offset = options.offset;
      if (options.q) query.q = options.q;
      const data = await client.get(ep.path, { service: ep.service, query });
      const agents = data.data?.data?.affected_items || data.data?.affected_items || data.data || [];
      formatOutput({
        columns: ['id', 'name', 'ip', 'status', 'version'],
        headers: ['ID', 'Name', 'IP', 'Status', 'Version'],
        rows: Array.isArray(agents) ? agents : [],
      }, { format: program.opts().output, emptyMessage: 'No Wazuh agents found.' });
    });

  wazuh
    .command('alerts')
    .description('Query recent Wazuh alerts')
    .option('--q <query>', 'search text (rule description / agent name / rule groups)')
    .option('--limit <n>', 'max results (default 50, capped at 500)')
    .action(async (options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('mon.wazuh.alerts.list');
      const query = {};
      if (options.q) query.q = options.q;
      if (options.limit) query.limit = options.limit;
      const data = await client.get(ep.path, { service: ep.service, query });
      formatOutput({
        columns: ['timestamp', 'rule', 'agent', 'level'],
        headers: ['Time', 'Rule', 'Agent', 'Level'],
        rows: (data.data || []).map(a => ({
          timestamp: a.timestamp,
          rule: a.rule?.description || '',
          agent: a.agent?.name || '',
          level: a.rule?.level ?? '',
        })),
      }, { format: program.opts().output, emptyMessage: 'No alerts found.' });
    });

  wazuh
    .command('vulns')
    .description('Query current vulnerability states')
    .option('--agent-id <id>', 'filter by agent ID')
    .option('--agent-name <name>', 'filter by agent name')
    .option('--severity <severity>', 'filter by severity')
    .option('--limit <n>', 'max results (default 100, capped at 1000)')
    .action(async (options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('mon.wazuh.vulnerabilities.list');
      const query = {};
      if (options.agentId) query.agent_id = options.agentId;
      if (options.agentName) query.agent_name = options.agentName;
      if (options.severity) query.severity = options.severity;
      if (options.limit) query.limit = options.limit;
      const data = await client.get(ep.path, { service: ep.service, query });
      formatOutput({
        columns: ['agent', 'cve', 'severity', 'score'],
        headers: ['Agent', 'CVE', 'Severity', 'Score'],
        rows: (data.data || []).map(v => ({
          agent: v.agent?.name || '',
          cve: v.vulnerability?.id || '',
          severity: v.vulnerability?.severity || '',
          score: v.vulnerability?.score?.base ?? '',
        })),
      }, { format: program.opts().output, emptyMessage: 'No vulnerabilities found.' });
    });

  wazuh
    .command('deploy-history')
    .description('Show Wazuh agent deploy history')
    .option('--mode <mode>', 'latest|all', 'latest')
    .option('--limit <n>', 'max results (mode=all only)', '200')
    .action(async (options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('mon.wazuh.deploy-history.list');
      const data = await client.get(ep.path, { service: ep.service, query: { mode: options.mode, limit: options.limit } });
      formatOutput({
        // fleet #385 class sweep: the route returns
        // { hostname, ip, ssh_user, success, message, deployed_at }, but this
        // declared hostIp/status/deployedAt — three of four columns rendered
        // as dashes with no error. `success` is a boolean, so it's mapped to
        // a readable status rather than printed raw.
        columns: ['hostname', 'ip', 'status', 'deployed_at'],
        headers: ['Host', 'IP', 'Status', 'Deployed'],
        rows: (data.deploys || []).map(d => ({
          ...d,
          status: d.success ? 'ok' : (d.message ? `failed: ${String(d.message).slice(0, 40)}` : 'failed'),
        })),
      }, { format: program.opts().output, emptyMessage: 'No deploy history found.' });
    });

  wazuh
    .command('deploy-agent')
    .description('Queue a Wazuh agent deploy for one host (HITL-gated — requires HITL Inbox approval)')
    .requiredOption('--hostname <hostname>', 'target hostname')
    .requiredOption('--host-ip <ip>', 'target host IP')
    .option('--wazuh-server <ip>', 'Wazuh manager IP (defaults to server config)')
    .option('--bastion-host <ip>', 'bastion host for the SSH hop')
    .option('--ssh-user <user>', 'SSH user', 'control')
    .option('--ssh-port <n>', 'SSH port', '22')
    .option('--force', 'skip confirmation')
    .action(async (options) => {
      auth.requireAuth();
      const confirmed = await confirmOrSkip(program, options, `Queue Wazuh agent deploy to ${options.hostname} (${options.hostIp})? This will require HITL Inbox approval before it runs.`);
      if (!confirmed) {
        printInfo('Cancelled.');
        return;
      }
      const body = { hostname: options.hostname, hostIp: options.hostIp, sshUser: options.sshUser, sshPort: options.sshPort };
      if (options.wazuhServer) body.wazuhServer = options.wazuhServer;
      if (options.bastionHost) body.bastionHost = options.bastionHost;
      const ep = resolveEndpoint('mon.wazuh.deploy-agent');
      const data = await client.post(ep.path, { service: ep.service, body });
      printSuccess(`Deploy queued — inbox item ${data.inbox_item_id} (awaiting approval).`);
    });

  wazuh
    .command('deploy-bulk')
    .description('Queue a Wazuh agent deploy for multiple hosts (HITL-gated — requires HITL Inbox approval)')
    .requiredOption('--hosts <json>', 'JSON array of {hostname, ip} objects')
    .option('--wazuh-server <ip>', 'Wazuh manager IP (defaults to server config)')
    .option('--bastion-host <ip>', 'bastion host for the SSH hop')
    .option('--force', 'skip confirmation')
    .action(async (options) => {
      auth.requireAuth();
      const hosts = parseJSON(options.hosts, '--hosts');
      if (!Array.isArray(hosts) || hosts.length === 0) {
        throw new Error('--hosts must be a non-empty JSON array of {hostname, ip} objects.');
      }
      const confirmed = await confirmOrSkip(program, options, `Queue Wazuh agent deploy to ${hosts.length} host(s)? This will require HITL Inbox approval before it runs.`);
      if (!confirmed) {
        printInfo('Cancelled.');
        return;
      }
      const body = { hosts };
      if (options.wazuhServer) body.wazuhServer = options.wazuhServer;
      if (options.bastionHost) body.bastionHost = options.bastionHost;
      const ep = resolveEndpoint('mon.wazuh.deploy-bulk');
      const data = await client.post(ep.path, { service: ep.service, body });
      printSuccess(`Bulk deploy queued for ${data.host_count ?? hosts.length} host(s) — inbox item ${data.inbox_item_id} (awaiting approval).`);
    });

  wazuh
    .command('active-response')
    .description('Trigger a Wazuh active response (HITL-gated — requires HITL Inbox approval)')
    .requiredOption('--command <command>', 'firewall-block|host-isolate|restart-wazuh-agent')
    .requiredOption('--agents <ids>', 'comma-separated Wazuh agent IDs')
    .requiredOption('--reason <text>', 'justification (min 10 characters)')
    .option('--args <args>', 'comma-separated command arguments')
    .option('--force', 'skip confirmation')
    .action(async (options) => {
      auth.requireAuth();
      const agentList = options.agents.split(',').map(a => a.trim()).filter(Boolean);
      const args = options.args ? options.args.split(',').map(a => a.trim()).filter(Boolean) : [];
      const confirmed = await confirmOrSkip(program, options, `Trigger active response "${options.command}" on ${agentList.length} agent(s)? This will require HITL Inbox approval before it executes.`);
      if (!confirmed) {
        printInfo('Cancelled.');
        return;
      }
      const ep = resolveEndpoint('mon.wazuh.active-response');
      const data = await client.post(ep.path, { service: ep.service, body: { command: options.command, agentList, args, reason: options.reason } });
      printSuccess(`Active response queued — inbox item ${data.inbox_item_id} (awaiting approval).`);
    });

  // ══════════════════════════════════════════════════════════════════════
  // agh-chain
  // ══════════════════════════════════════════════════════════════════════

  const aghChain = mon
    .command('agh-chain')
    .description('AGH-chain: per-agent honesty leaderboard (org-scoped)');

  aghChain
    .command('leaderboard')
    .description('Show the org honesty leaderboard')
    .option('--window <window>', '24h|7d|30d', '24h')
    .action(async (options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('mon.agh-chain.leaderboard.list');
      const data = await client.get(ep.path, { service: ep.service, query: { window: options.window } });
      formatOutput({
        columns: ['agent_id', 'claims_made', 'claims_verified', 'claims_stripped', 'unfulfilled_promises', 'honesty_rate'],
        headers: ['Agent', 'Claims Made', 'Verified', 'Stripped', 'Unfulfilled', 'Honesty Rate'],
        rows: data.agents || [],
      }, { format: program.opts().output, emptyMessage: 'No leaderboard data found.' });
    });

  aghChain
    .command('agent')
    .description('Show honesty metrics for a single agent')
    .argument('<agentId>', 'agent ID')
    .option('--window <window>', '24h|7d|30d', '24h')
    .action(async (agentId, options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('mon.agh-chain.leaderboard.get', { agentId });
      const data = await client.get(ep.path, { service: ep.service, query: { window: options.window } });
      formatDetail(data, { format: program.opts().output, title: `Honesty metrics: ${agentId}` });
    });

  aghChain
    .command('events')
    .description('Show drill-through events for a guard kind')
    .argument('<agentId>', 'agent ID')
    .option('--window <window>', '24h|7d|30d', '24h')
    .option('--guard <kind>', 'guard kind', 'claims_stripped')
    .action(async (agentId, options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('mon.agh-chain.leaderboard.events.list', { agentId });
      const data = await client.get(ep.path, { service: ep.service, query: { window: options.window, guard: options.guard } });
      formatOutput({
        columns: ['event_id', 'run_id', 'ts', 'payload_preview'],
        headers: ['Event', 'Run', 'Time', 'Preview'],
        rows: data.events || [],
      }, { format: program.opts().output, emptyMessage: 'No drill-through events found.' });
    });

  // ══════════════════════════════════════════════════════════════════════
  // metrics
  // ══════════════════════════════════════════════════════════════════════

  mon
    .command('metrics')
    .description('Show Prometheus scrape metrics (collector fleet gauges)')
    .option('--raw', 'print the raw Prometheus exposition text')
    .action(async (options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('mon.metrics.get');
      const data = await client.get(ep.path, { service: ep.service });
      const text = data.text || '';

      if (options.raw || program.opts().output === 'json') {
        if (program.opts().output === 'json') {
          console.log(JSON.stringify({ text }, null, 2));
        } else {
          console.log(text);
        }
        return;
      }

      const rows = text
        .split('\n')
        .filter(line => line && !line.startsWith('#'))
        .map(line => {
          const idx = line.lastIndexOf(' ');
          if (idx === -1) return null;
          return { metric: line.slice(0, idx), value: line.slice(idx + 1) };
        })
        .filter(Boolean);

      formatOutput({
        columns: ['metric', 'value'],
        headers: ['Metric', 'Value'],
        rows,
      }, { format: program.opts().output, emptyMessage: 'No metrics returned.' });
    });

  // ══════════════════════════════════════════════════════════════════════
  // config
  // ══════════════════════════════════════════════════════════════════════

  const config = mon
    .command('config')
    .description('Monitoring service config (Prometheus/Uptime Kuma/Proxmox/Grafana)');

  config
    .command('get')
    .description('Show configured monitoring service URLs')
    .action(async () => {
      const ep = resolveEndpoint('mon.config.get');
      const data = await client.get(ep.path, { service: ep.service });
      formatDetail(data.services || data, { format: program.opts().output, title: 'Monitoring Config' });
    });

  config
    .command('cache')
    .description('Show the last cached scan for a monitoring service')
    .argument('<service>', 'service name, e.g. prometheus|uptime-kuma|proxmox')
    .action(async (service) => {
      auth.requireAuth();
      const ep = resolveEndpoint('mon.config.cache.get', { service });
      const data = await client.get(ep.path, { service: ep.service });
      if (data.cached === false) {
        printInfo(`No cached data for ${service}.`);
        return;
      }
      formatDetail(data, { format: program.opts().output, title: `Monitoring cache: ${service}` });
    });

  config
    .command('grafana')
    .description('Show the configured Grafana base URL')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('mon.config.grafana.get');
      const data = await client.get(ep.path, { service: ep.service });
      formatDetail(data, { format: program.opts().output, title: 'Grafana Config' });
    });
}
