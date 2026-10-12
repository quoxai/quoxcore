/**
 * quox status — Platform Pulse
 *
 * Displays a one-screen overview of the entire Quox platform:
 * services, fleet, sessions, vault, memory, AEE, workflows.
 *
 * CLI-3a (Stream CLI Phase 3)
 */

import chalk from 'chalk';
import { emitCliEvent } from '../core/aee.js';
import { resolveEndpoint } from '../api/endpoints.js';

const STATUS_ICON = {
  ok: chalk.green('●'),
  degraded: chalk.yellow('●'),
  down: chalk.red('●'),
};

function statusDot(status) {
  return STATUS_ICON[status] || chalk.dim('○');
}

function renderPulse(data) {
  const lines = [];

  // Header
  const scoreColor = data.score >= 90 ? chalk.green : data.score >= 70 ? chalk.yellow : chalk.red;
  lines.push('');
  lines.push(chalk.bold(` QUOX PLATFORM STATUS`) + chalk.dim(`  ${scoreColor(`Health: ${data.score}%`)}  ${data.timestamp || ''}`));
  lines.push(chalk.dim(' ' + '─'.repeat(60)));

  // Services
  const svcLine = Object.entries(data.services || {})
    .map(([name, s]) => `${statusDot(s.status)} ${name}`)
    .join('  ');
  lines.push(` Services    ${svcLine}`);

  // Fleet
  const f = data.fleet || {};
  lines.push(` Fleet       ${f.total || 0} agents  (${chalk.green(f.healthy || 0)} healthy, ${chalk.yellow(f.degraded || 0)} degraded, ${chalk.red(f.down || 0)} down)`);

  // Sessions
  const s = data.sessions || {};
  const providers = Object.entries(s.providers || {}).map(([k, v]) => `${v} ${k}`).join(', ');
  lines.push(` Sessions    ${s.active || 0} active  ${providers ? `(${providers})` : ''}  ${chalk.dim(`$${(s.cost_today_usd || 0).toFixed(2)} today`)}`);

  // Workflows
  const w = data.workflows || {};
  const wfParts = [];
  if (w.running) wfParts.push(`${w.running} running`);
  if (w.pending_approval) wfParts.push(`${w.pending_approval} pending approval`);
  if (wfParts.length) lines.push(` Workflows   ${wfParts.join(', ')}`);

  // Vault
  const v = data.vault || {};
  if (v.total) {
    const vaultWarn = v.expiring_soon > 0 ? chalk.yellow(` (${v.expiring_soon} expiring soon)`) : '';
    lines.push(` Vault       ${v.total} creds  (${chalk.green(v.healthy)} healthy)${vaultWarn}`);
  }

  // Memory
  const m = data.memory || {};
  if (m.entries) {
    const size = m.vector_size_gb ? `  ${m.vector_size_gb}GB vectors` : '';
    lines.push(` Memory      ${m.entries.toLocaleString()} entries${size}`);
  }

  // AEE
  const a = data.aee || {};
  if (a.envelopes_today) {
    const integrity = a.chain_ok ? chalk.green('✓') : chalk.red('✗');
    lines.push(` AEE         ${a.envelopes_today.toLocaleString()} envelopes today  chain integrity ${integrity}`);
  }

  lines.push('');
  return lines.join('\n');
}

export function registerStatusCommand(program, ctx) {
  const { client } = ctx;

  program
    .command('status')
    .description('Show platform health and status overview')
    .action(async (opts, cmd) => {
      const outputFormat = cmd.parent?.opts()?.output || 'table';
      const isJson = outputFormat === 'json' || cmd.parent?.opts()?.json;

      try {
        // fleet #602: this used to pass noAuth: true, which suppressed the
        // Authorization header the client would otherwise attach. The TUI's
        // useHealth/HealthView poll this same endpoint WITH the normal client
        // auth, as does a comparable authenticated route (backup.js).
        // (monitoring.js's `health` verb had the identical noAuth bug — fixed
        // in the same change.) Dropping noAuth here matches that pattern: the
        // request still works
        // for a logged-out session (client.js sends no Authorization header
        // when there's nothing stored), but a logged-in session's token now
        // actually reaches the collector instead of being withheld.
        const data = await client.get(resolveEndpoint('v1.health.aggregate.list').path, {
          service: resolveEndpoint('v1.health.aggregate.list').service,
          timeout: 5000,
        });

        if (isJson) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          console.log(renderPulse(data));
        }

        emitCliEvent(client, {
          command: 'status',
          intent: 'quox.cli.status',
          payload: { score: data.score, services: Object.keys(data.services || {}).length },
        });
      } catch (err) {
        if (isJson) {
          console.log(JSON.stringify({ error: 'collector_unavailable', message: err.message }));
        } else {
          console.log('');
          console.log(chalk.red(' Platform status unavailable'));
          console.log(chalk.dim(` Collector not reachable: ${err.message}`));
          console.log('');
        }
        // fleet #602: a real request failure (network error, non-2xx from
        // the collector) was printing the message above and still exiting
        // 0, hiding the failure from scripts/CI that check the exit code.
        // client.get only reaches this catch on an actual error (thrown
        // QuoxApiError / QuoxNetworkError / QuoxAuthError, see
        // lib/core/client.js) — never on a successful 2xx — so it's safe to
        // fail the process here without risking a false failure on a
        // legitimately-empty-but-200 status payload.
        process.exitCode = 1;
      }
    });
}
