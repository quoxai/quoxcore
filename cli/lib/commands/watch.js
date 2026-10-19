/**
 * Watch commands — real-time monitoring dashboards
 *
 * quox watch fleet        Live fleet status (polling)
 * quox watch services     Live service health
 */

import chalk from 'chalk';
import { resolveEndpoint } from '../api/endpoints.js';
import { joinServiceUrl } from '../core/config.js';

/** Seconds to a short "1d 1h" / "3h 12m" / "45s" label. */
function shortUptime(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec)) return '-';
  const d = Math.floor(sec / 86400); const h = Math.floor((sec % 86400) / 3600); const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return m ? `${m}m` : `${Math.floor(sec)}s`;
}

/**
 * quox#946: one row per agent from GET /api/v1/agents (the same source as
 * `quox fleet agents`). /api/v1/fleet/status carries totals only, which is why
 * the old dashboard always said "No agents reporting".
 */
export function fleetRows(data) {
  const list = Array.isArray(data) ? data : (Array.isArray(data?.agents) ? data.agents : []);
  return list.map((a) => ({
    host_id: a.host_id || a.system?.hostname || '-',
    status: typeof a.status === 'object' ? (a.status?.health ?? a.status?.connection ?? 'unknown') : (a.status || 'unknown'),
    cpu_percent: Math.round(a.resources?.cpu?.usage_percent ?? a.cpu_percent ?? 0),
    memory_percent: Math.round(a.resources?.memory?.usage_percent ?? a.memory_percent ?? 0),
    uptime: shortUptime(a.system?.uptime_seconds ?? a.uptime_seconds),
    version: a.agent?.version || a.version || '-',
    last_seen_seconds: typeof a.status?.last_seen_seconds === 'number' ? a.status.last_seen_seconds : null,
  }));
}

/**
 * quox#946: a slow service is a TIMEOUT, a refused connection is DOWN, a non-2xx
 * answer is DEGRADED. The old dashboard called every failure "down".
 */
export async function probeService(url, fetchImpl = fetch, timeoutMs = 8000) {
  const start = Date.now();
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    const latency_ms = Date.now() - start;
    return res.ok ? { status: 'healthy', latency_ms, code: res.status } : { status: 'degraded', latency_ms, code: res.status };
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return { status: 'timeout', latency_ms: Date.now() - start };
    return { status: 'down', reason: err?.cause?.code || err?.message || 'error' };
  }
}

export function registerWatchCommands(program, { client, auth, config }) {
  const watch = program
    .command('watch')
    .description('Real-time monitoring dashboards');

  watch
    .command('fleet')
    .description('Live fleet status dashboard')
    .option('--interval <seconds>', 'Refresh interval', '5')
    .action(async (opts) => {
      auth.requireAuth();
      const interval = Math.max(2, parseInt(opts.interval, 10) || 5) * 1000;
      const fetchAgents = async () => {
        const ep = resolveEndpoint('v1.agents.list');
        return fleetRows(await client.get(ep.path, { service: ep.service }));
      };

      // --json: one snapshot, then exit (a dashboard loop is not machine output).
      if (program.opts().output === 'json') {
        console.log(JSON.stringify({ agents: await fetchAgents(), timestamp: new Date().toISOString() }, null, 2));
        return;
      }

      console.log(chalk.cyan('Fleet Watch') + chalk.dim(' (Ctrl+C to stop)\n'));

      const tick = async () => {
        try {
          const agents = await fetchAgents();

          // Clear screen and redraw
          process.stdout.write('\x1B[2J\x1B[H');
          console.log(chalk.cyan.bold('QuoxCLI Fleet Watch') + chalk.dim(`  ${new Date().toLocaleTimeString()}  (Ctrl+C to stop)`));
          console.log(chalk.dim('─'.repeat(72)));

          if (agents.length === 0) {
            console.log(chalk.yellow('  No agents reporting'));
          } else {
            const header = `  ${'HOST'.padEnd(16)} ${'STATUS'.padEnd(10)} ${'CPU'.padEnd(7)} ${'MEM'.padEnd(7)} ${'UPTIME'.padEnd(10)} ${'VERSION'}`;
            console.log(chalk.dim(header));
            console.log(chalk.dim('  ' + '─'.repeat(68)));

            for (const a of agents) {
              const statusColor = a.status === 'healthy' ? chalk.green : a.status === 'degraded' ? chalk.yellow : chalk.red;
              const cpuColor = (a.cpu_percent || 0) > 80 ? chalk.red : (a.cpu_percent || 0) > 60 ? chalk.yellow : chalk.white;
              const memColor = (a.memory_percent || 0) > 80 ? chalk.red : (a.memory_percent || 0) > 60 ? chalk.yellow : chalk.white;

              console.log(
                `  ${chalk.white(String(a.host_id || '').padEnd(16))} ` +
                `${statusColor(String(a.status || 'unknown').padEnd(10))} ` +
                `${cpuColor(String((a.cpu_percent || 0) + '%').padEnd(7))} ` +
                `${memColor(String((a.memory_percent || 0) + '%').padEnd(7))} ` +
                `${String(a.uptime).padEnd(10)} ` +
                `${chalk.dim(a.version || '-')}`
              );
            }
          }

          console.log(chalk.dim('\n  ' + '─'.repeat(68)));
          console.log(chalk.dim(`  ${agents.length} agents  |  refreshing every ${interval / 1000}s`));
        } catch (err) {
          console.error(chalk.red(`  Error: ${err.message}`));
        }
      };

      await tick();
      const timer = setInterval(tick, interval);
      process.on('SIGINT', () => { clearInterval(timer); process.exit(0); });
    });

  watch
    .command('services')
    .description('Live service health dashboard')
    .option('--interval <seconds>', 'Refresh interval', '10')
    .action(async (opts) => {
      const interval = Math.max(5, parseInt(opts.interval, 10) || 10) * 1000;
      const services = [
        { name: 'auth', port: 3101, path: '/health' },
        { name: 'collector', port: 9848, path: '/health' },
        { name: 'memory', port: 3103, path: '/health' },
        { name: 'files', port: 3102, path: '/health' },
        { name: 'orchestrator', port: 3100, path: '/health' },
      ];

      const probeAll = async () => Promise.all(services.map(async (svc) => ({
        name: svc.name,
        ...(await probeService(joinServiceUrl(config.getServiceUrl(svc.name), svc.path).href)),
      })));

      // --json: one snapshot, then exit.
      if (program.opts().output === 'json') {
        console.log(JSON.stringify({ services: await probeAll(), timestamp: new Date().toISOString() }, null, 2));
        return;
      }

      const tick = async () => {
        const results = await probeAll();
        process.stdout.write('\x1B[2J\x1B[H');
        console.log(chalk.cyan.bold('QuoxCLI Service Watch') + chalk.dim(`  ${new Date().toLocaleTimeString()}  (Ctrl+C to stop)`));
        console.log(chalk.dim('─'.repeat(50)));
        for (const r of results) {
          if (r.status === 'healthy') console.log(`  ${chalk.green('●')} ${r.name.padEnd(14)} ${chalk.green('healthy')}  ${chalk.dim(r.latency_ms + 'ms')}`);
          else if (r.status === 'degraded') console.log(`  ${chalk.yellow('●')} ${r.name.padEnd(14)} ${chalk.yellow(r.code)}     ${chalk.dim(r.latency_ms + 'ms')}`);
          else if (r.status === 'timeout') console.log(`  ${chalk.yellow('●')} ${r.name.padEnd(14)} ${chalk.yellow('slow (no answer in ' + Math.round(r.latency_ms / 1000) + 's)')}`);
          else console.log(`  ${chalk.red('●')} ${r.name.padEnd(14)} ${chalk.red('down')}  ${chalk.dim(r.reason || '')}`);
        }
        console.log(chalk.dim('\n  refreshing every ' + (interval / 1000) + 's'));
      };

      await tick();
      const timer = setInterval(tick, interval);
      process.on('SIGINT', () => { clearInterval(timer); process.exit(0); });
    });
}
