/**
 * Watch commands — real-time monitoring dashboards
 *
 * quox watch fleet        Live fleet status (polling)
 * quox watch services     Live service health
 */

import chalk from 'chalk';
import { resolveEndpoint } from '../api/endpoints.js';

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

      console.log(chalk.cyan('Fleet Watch') + chalk.dim(' (Ctrl+C to stop)\n'));

      const tick = async () => {
        try {
          const data = await client.get(resolveEndpoint('v1.fleet.status.list').path, { service: resolveEndpoint('v1.fleet.status.list').service });
          const agents = data.agents || [];

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
                `${String(a.uptime || '-').padEnd(10)} ` +
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

      const tick = async () => {
        process.stdout.write('\x1B[2J\x1B[H');
        console.log(chalk.cyan.bold('QuoxCLI Service Watch') + chalk.dim(`  ${new Date().toLocaleTimeString()}  (Ctrl+C to stop)`));
        console.log(chalk.dim('─'.repeat(50)));

        for (const svc of services) {
          try {
            const svcUrl = config.getServiceUrl(svc.name);
            const fullUrl = new URL(svc.path, svcUrl);
            const start = Date.now();
            const res = await fetch(fullUrl.href, { signal: AbortSignal.timeout(5000) });
            const latency = Date.now() - start;

            if (res.ok) {
              console.log(`  ${chalk.green('●')} ${svc.name.padEnd(14)} ${chalk.green('healthy')}  ${chalk.dim(latency + 'ms')}`);
            } else {
              console.log(`  ${chalk.yellow('●')} ${svc.name.padEnd(14)} ${chalk.yellow(res.status)}     ${chalk.dim(latency + 'ms')}`);
            }
          } catch {
            console.log(`  ${chalk.red('●')} ${svc.name.padEnd(14)} ${chalk.red('down')}`);
          }
        }

        console.log(chalk.dim('\n  refreshing every ' + (interval / 1000) + 's'));
      };

      await tick();
      const timer = setInterval(tick, interval);
      process.on('SIGINT', () => { clearInterval(timer); process.exit(0); });
    });
}
