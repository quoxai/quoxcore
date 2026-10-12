/**
 * Service health commands
 */

import chalk from 'chalk';
import { formatOutput, printInfo } from '../core/output.js';
import { SERVICE_PORTS } from '../core/config.js';

async function runHealthCheck(name, ctx, program) {
  const { config } = ctx;

  const services = name
    ? { [name]: SERVICE_PORTS[name] }
    : SERVICE_PORTS;

  if (name && !SERVICE_PORTS[name]) {
    console.error(chalk.red(`Unknown service: ${name}`));
    console.error(`Available: ${Object.keys(SERVICE_PORTS).join(', ')}`);
    process.exit(2);
  }

  const results = [];

  for (const [svc, port] of Object.entries(services)) {
    const baseUrl = config.getServiceUrl(svc);
    const start = Date.now();
    let status = 'down';
    let responseTime = '-';

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
      clearTimeout(timer);
      const elapsed = Date.now() - start;
      responseTime = `${elapsed}ms`;

      if (res.ok) {
        status = 'operational';
      } else {
        status = 'degraded';
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        status = 'timeout';
      }
      // else stays 'down'
    }

    results.push({
      service: svc,
      port,
      status,
      response: responseTime,
    });
  }

  formatOutput({
    columns: ['service', 'port', 'status', 'response'],
    headers: ['Service', 'Port', 'Status', 'Response'],
    rows: results,
  }, { format: program.opts().output });

  const downCount = results.filter(r => r.status === 'down' || r.status === 'timeout').length;
  if (downCount > 0) {
    printInfo(`\n${downCount} service(s) unreachable.`);
  }
}

export function registerServiceCommands(program, ctx) {
  const service = program
    .command('service')
    .description('Check service health and status');

  service
    .command('health')
    .description('Check health of all QuoxCORE services')
    .argument('[name]', 'specific service to check (auth, collector, memory, files, orchestrator)')
    .action(async (name) => runHealthCheck(name, ctx, program));

  // Top-level alias — `quox health` is what deploy scripts / muscle memory
  // reach for first; keep it a thin wrapper over `service health` so there
  // is exactly one health-check implementation.
  program
    .command('health')
    .description('Check health of all QuoxCORE services (alias for `service health`)')
    .argument('[name]', 'specific service to check (auth, collector, memory, files, orchestrator)')
    .action(async (name) => runHealthCheck(name, ctx, program));
}
