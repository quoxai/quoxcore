/**
 * quox doctor — Platform Diagnostics
 *
 * Deep-checks every service, database, agent daemon, and credential.
 * Reports pass/warning/critical with actionable details.
 *
 * CLI-3b (Stream CLI Phase 3)
 */

import chalk from 'chalk';
import { SERVICE_PORTS } from '../core/config.js';
import { emitCliEvent } from '../core/aee.js';
import { resolveCliVersion, checkCliDrift } from '../core/version.js';

const CHECKS = [
  // Core services
  { name: 'Auth service', service: 'auth', port: 3101, path: '/health', critical: true },
  { name: 'Memory service', service: 'memory', port: 3103, path: '/health' },
  { name: 'Collector', service: 'collector', port: 9848, path: '/health', critical: true },
  { name: 'QuoxFlow', service: 'quoxflow', port: 3200, path: '/health' },
  { name: 'Files service', service: 'files', port: 3102, path: '/health' },
  // External services
  { name: 'QuoxAgent daemon', port: 9847, path: '/health', url: 'http://localhost:9847' },
  { name: 'Qdrant vectors', port: 6333, path: '/', url: 'http://localhost:6333' },
];

async function checkEndpoint(url, path, timeoutMs = 3000) {
  const start = Date.now();
  try {
    const resp = await fetch(`${url}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latency = Date.now() - start;
    if (resp.ok) {
      return { status: 'pass', latency_ms: latency };
    }
    return { status: 'warn', latency_ms: latency, detail: `HTTP ${resp.status}` };
  } catch (err) {
    return { status: 'fail', latency_ms: null, detail: err.message };
  }
}

/**
 * Every doctor check, in this process: services, auth token, CLI version. Shared by `quox doctor` and the
 * conversation's /doctor so the two can never disagree. -> [{ name, status, detail?, latency_ms?, ... }].
 */
export async function runDoctorChecks({ config }) {
  // Check all services in parallel — per-item try/catch so one failure doesn't lose all results
  const checks = await Promise.all(
    CHECKS.map(async (check) => {
      try {
        const url = check.url || config.getServiceUrl(check.service);
        let result = await checkEndpoint(url, check.path);
        // #623: doctor was crying CRITICAL when the configured URL was just
        // WRONG (stale profile override / wrong scheme+host) while the
        // service was up on its loopback bind. On a connection failure,
        // probe http://127.0.0.1:<port> — if THAT answers, the service is
        // UP and the verdict is "misconfigured URL", not "service down".
        // Downgrade to a warning that names the reachable bind + the bad
        // URL, so an operator fixes the config instead of chasing an outage.
        if (result.status === 'fail' && check.port) {
          const loopbackUrl = `http://127.0.0.1:${check.port}`;
          if (url !== loopbackUrl) {
            const alt = await checkEndpoint(loopbackUrl, check.path);
            if (alt.status === 'pass') {
              result = {
                status: 'warn',
                latency_ms: alt.latency_ms,
                detail: `reachable at ${loopbackUrl} but configured URL ${url} failed — profile URL likely stale/wrong (misconfig, not an outage)`,
              };
            }
          }
        }
        return {
          name: check.name,
          port: check.port,
          ...result,
          critical: check.critical || false,
        };
      } catch {
        return {
          name: check.name,
          port: check.port,
          ok: false,
          status: 'error',
          ms: 0,
          critical: check.critical || false,
        };
      }
    })
  );

  // Check auth token. fleet #479: the CURRENT profile (persisted
  // default, or a -p/QUOX_PROFILE override) is config._effectiveProfile,
  // never config._data.activeProfile (that's always the persisted
  // default now, and would report the wrong profile under an override).
  const auth = config.getAuth?.() || config._data?.profiles?.[config._effectiveProfile]?.auth;
  if (auth?.access_token) {
    const expired = auth.expires_at && Date.now() > auth.expires_at;
    if (expired) {
      checks.push({ name: 'Auth token', status: 'warn', detail: 'expired' });
    } else {
      const remaining = auth.expires_at ? Math.round((auth.expires_at - Date.now()) / 3600000) : '?';
      checks.push({ name: 'Auth token', status: 'pass', detail: `valid (expires in ${remaining}h)` });
    }
  } else {
    checks.push({ name: 'Auth token', status: 'warn', detail: 'not logged in' });
  }

  // #610 Part 3: which build is this, and is it drifted from origin/main?
  // A silently-stale CLI (the worktree was 32 commits behind and nothing
  // said so) is a real warning, so a stale drift maps to 'warn' and bumps
  // the exit code like any other. unknown/skip are informational (pass) —
  // never fail a health check because we could not compute drift. The
  // drift count reflects the last fetch (no network fetch here).
  const cliVersion = resolveCliVersion();
  const drift = checkCliDrift();
  checks.push({
    name: 'CLI version',
    status: drift.status === 'stale' ? 'warn' : 'pass',
    detail: `${cliVersion} · ${drift.detail}`,
  });

  return checks;
}

export function registerDoctorCommand(program, ctx) {
  const { config, client } = ctx;

  program
    .command('doctor')
    .description('Run platform health diagnostics')
    .action(async (opts, cmd) => {
      const outputFormat = cmd.parent?.opts()?.output || 'table';
      const isJson = outputFormat === 'json' || cmd.parent?.opts()?.json;

      const checks = await runDoctorChecks({ config });

      // Summary
      const passed = checks.filter(c => c.status === 'pass').length;
      const warnings = checks.filter(c => c.status === 'warn').length;
      const failed = checks.filter(c => c.status === 'fail').length;

      if (isJson) {
        console.log(JSON.stringify({ checks, summary: { passed, warnings, failed } }, null, 2));
        return;
      }

      // Render
      console.log('');
      for (const c of checks) {
        const icon = c.status === 'pass' ? chalk.green(' ✓')
          : c.status === 'warn' ? chalk.yellow(' ⚠')
          : chalk.red(' ✗');

        const latency = c.latency_ms != null ? chalk.dim(` (${c.latency_ms}ms)`) : '';
        const detail = c.detail ? chalk.dim(` ${c.detail}`) : '';
        const port = c.port ? chalk.dim(` ${c.port}`) : '';

        console.log(`${icon} ${c.name.padEnd(20)}${port}${latency}${detail}`);
      }

      console.log('');
      const parts = [];
      if (passed) parts.push(chalk.green(`${passed} passed`));
      if (warnings) parts.push(chalk.yellow(`${warnings} warning${warnings > 1 ? 's' : ''}`));
      if (failed) parts.push(chalk.red(`${failed} critical`));
      console.log(` ${parts.join('  ')}`);
      console.log('');

      emitCliEvent(client, {
        command: 'doctor',
        intent: 'quox.cli.doctor',
        payload: { passed, warnings, failed, total: checks.length },
        status: failed > 0 ? 'error' : 'success',
      });

      if (failed > 0) process.exitCode = 2;
      else if (warnings > 0) process.exitCode = 1;
    });
}
