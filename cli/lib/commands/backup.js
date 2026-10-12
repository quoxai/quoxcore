/**
 * Backup commands: CRUD, verify, restore, schedule
 *
 * TWO LANES, deliberately distinct (G2d slice 3):
 *   `quox backup …`         — the per-ORG tenant lane (one org's data).
 *   `quox backup server …`  — the SERVER-WIDE lane: the whole box, every org,
 *                             instance-admin only, executed by the governed
 *                             host-side runner. Its restore is the most
 *                             destructive verb in the product, so it is
 *                             dry-run by default and needs both --execute and
 *                             an interactive confirmation.
 */

import chalk from 'chalk';
import { createHash } from 'crypto';
import { createWriteStream } from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import * as path from 'path';
import { formatOutput, formatDetail, printSuccess, printInfo, printWarning } from '../core/output.js';
import { resolveOrgId } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';

export function registerBackupCommands(program, ctx) {
  const { client, auth } = ctx;
  const sleep = ctx.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  const backup = program
    .command('backup')
    .description('Manage backups');

  backup
    .command('list')
    .description('List backups')
    .option('--limit <n>', 'max results', '20')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const data = await client.get(resolveEndpoint('backups.list', { orgId }).path, { service: resolveEndpoint('backups.list', { orgId }).service, query: { limit: options.limit } });
      formatOutput({
        // fleet #392: backups has name/backup_type/archive_size_bytes.
        columns: ['id', 'name', 'backup_type', 'archive_size_bytes', 'status', 'created_at'],
        headers: ['ID', 'Name', 'Type', 'Size (bytes)', 'Status', 'Created'],
        rows: data.items || data.backups || data,
      }, { format: program.opts().output });
    });

  backup
    .command('get')
    .description('Get backup details')
    .argument('<backupId>', 'backup ID')
    .action(async (backupId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const data = await client.get(resolveEndpoint('backups.get', { orgId, backupId }).path, { service: resolveEndpoint('backups.get', { orgId, backupId }).service });
      formatDetail(data.backup || data, { format: program.opts().output });
    });

  backup
    .command('create')
    .description('Create a backup')
    .option('--label <label>', 'backup label')
    .option('--type <type>', 'backup type: full, incremental', 'full')
    .option('--components <list>', 'comma-separated components to include')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = { type: options.type };
      if (options.label) body.label = options.label;
      if (options.components) body.components = options.components.split(',').map(c => c.trim());

      const ora = (await import('ora')).default;
      const spinner = ora('Creating backup...').start();
      try {
        const data = await client.post(resolveEndpoint('backups.create', { orgId }).path, { service: resolveEndpoint('backups.create', { orgId }).service, body, timeout: 300000 });
        spinner.succeed('Backup created');
        if (data.backup) formatDetail(data.backup, { format: program.opts().output });
      } catch (err) {
        spinner.fail('Backup failed');
        throw err;
      }
    });

  backup
    .command('delete')
    .description('Delete a backup')
    .argument('<backupId>', 'backup ID')
    .action(async (backupId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      await client.delete(resolveEndpoint('backups.delete', { orgId, backupId }).path, { service: resolveEndpoint('backups.delete', { orgId, backupId }).service });
      printSuccess('Backup deleted.');
    });

  backup
    .command('verify')
    .description('Verify backup integrity')
    .argument('<backupId>', 'backup ID')
    .action(async (backupId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const data = await client.post(resolveEndpoint('backups.verify', { orgId, backupId }).path, { service: resolveEndpoint('backups.verify', { orgId, backupId }).service });
      let result = data;
      // The auth route verifies ASYNC ("Verification started", status verifying) and
      // writes the outcome to the backup row. Reading `valid` off the start reply
      // reported "failed: unknown" for a backup that went on to verify cleanly.
      if (data && data.valid === undefined && data.status === 'verifying') {
        const ep = resolveEndpoint('backups.get', { orgId, backupId });
        const deadline = Date.now() + 30 * 60 * 1000;
        for (;;) {
          const g = await client.get(ep.path, { service: ep.service });
          const b = (g && g.backup) || g || {};
          if (b.status && b.status !== 'verifying') {
            let v = null;
            try { v = b.verification_json ? JSON.parse(b.verification_json) : (b.verification || null); } catch { v = null; }
            result = { valid: b.status === 'verified' && (!v || v.valid !== false), errors: v && (v.errors || (v.mismatches && v.mismatches.length ? v.mismatches : undefined)), status: b.status };
            break;
          }
          if (Date.now() > deadline) throw new Error('Backup verification still running after 30 minutes; check `quox backup get ' + backupId + '`');
          await sleep(5000);
        }
      }
      if (result.valid) {
        printSuccess('Backup is valid.');
      } else {
        const detail = result.errors ? JSON.stringify(result.errors) : (result.status ? `status ${result.status}` : 'unknown');
        throw new Error(`Backup verification failed: ${detail}`);
      }
    });

  backup
    .command('restore')
    .description('Restore from a backup')
    .argument('<backupId>', 'backup ID')
    .option('--dry-run', 'show what would be restored without doing it')
    .option('--components <list>', 'comma-separated components to restore')
    .action(async (backupId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = {};
      if (options.dryRun) body.dry_run = true;
      if (options.components) body.components = options.components.split(',').map(c => c.trim());

      if (options.dryRun) {
        printInfo('DRY RUN - No changes will be made');
      }

      const ora = (await import('ora')).default;
      const spinner = ora('Restoring...').start();
      try {
        const data = await client.post(resolveEndpoint('backups.restore', { orgId, backupId }).path, { service: resolveEndpoint('backups.restore', { orgId, backupId }).service, body, timeout: 300000 });
        spinner.succeed('Restore complete');
        if (data.restore) formatDetail(data.restore, { format: program.opts().output });
      } catch (err) {
        spinner.fail('Restore failed');
        throw err;
      }
    });

  // Schedule subcommand
  const schedule = backup
    .command('schedule')
    .description('Manage backup schedules');

  schedule
    .command('list')
    .description('List backup schedules')
    .action(async () => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const data = await client.get(resolveEndpoint('backup-schedules.list', { orgId }).path, { service: resolveEndpoint('backup-schedules.list', { orgId }).service });
      formatOutput({
        // fleet #392: backup_schedules has cron_expression/backup_type/next_run_at.
        columns: ['id', 'name', 'cron_expression', 'backup_type', 'enabled', 'next_run_at'],
        headers: ['ID', 'Name', 'Cron', 'Type', 'Enabled', 'Next Run'],
        rows: data.schedules || [data.schedule].filter(Boolean) || data,
      }, { format: program.opts().output });
    });

  schedule
    .command('create')
    .description('Create a backup schedule')
    .requiredOption('--name <name>', 'schedule name')
    .requiredOption('--cron <expr>', 'cron expression')
    .option('--type <type>', 'backup type', 'full')
    .option('--retention <days>', 'retention in days', '30')
    .action(async (options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      // Field names match services/auth/routes/backups.js POST /orgs/:orgId/backup-schedules
      // (name required; cron -> cron_expression; type -> backup_type).
      await client.post(resolveEndpoint('backup-schedules.create', { orgId }).path, {
        service: resolveEndpoint('backup-schedules.create', { orgId }).service,
        body: {
          name: options.name,
          cron_expression: options.cron,
          backup_type: options.type,
          retention_days: parseInt(options.retention, 10),
        },
      });
      printSuccess('Backup schedule created.');
    });

  // ── `quox backup server …` — the instance-admin, SERVER-WIDE lane ────────
  //
  // Style-matched to `quox build` (lib/commands/build.js): the dispatch verbs
  // say plainly that a 200 is a QUEUE acknowledgement and not a finished job,
  // and every read verb names which half of the picture it is showing.
  //
  // Every route behind these verbs is instance-admin gated server-side
  // (services/auth/routes/admin-backups.js); nothing here re-implements that
  // check, it just surfaces the refusal honestly.
  const server = backup
    .command('server')
    .description('Server-wide backup/restore (whole box, every org; instance admin only)');

  server
    .command('create')
    .description('Dispatch a server-wide backup on the configured runner host')
    .option('--mode <mode>', 'backup mode: full, quick', 'full')
    .action(async (options) => {
      auth.requireAuth();
      if (!['full', 'quick'].includes(options.mode)) {
        throw new Error(`--mode must be one of: full, quick (got "${options.mode}")`);
      }
      const endpoint = resolveEndpoint('backups.server.create');
      const data = await client.post(endpoint.path, {
        service: endpoint.service,
        body: { mode: options.mode },
      });
      formatDetail(data, { format: program.opts().output, title: 'Server-wide backup dispatched' });
      printSuccess(`${options.mode} backup queued on ${data.runner_host || 'the runner host'}.`);
      printWarning('Queued is not backed up: a 200 here is the dispatch acknowledgement only. '
        + 'Check `quox backup server status` and the receipt before claiming the box is backed up.');
    });

  server
    .command('status')
    .description('Runner readiness and live state, plus the latest durable receipts')
    .action(async () => {
      auth.requireAuth();
      const endpoint = resolveEndpoint('backups.server.status');
      const data = await client.get(endpoint.path, { service: endpoint.service });
      formatDetail(data.runner || {}, {
        format: program.opts().output,
        title: `Runner state: ${data.runner_host || 'unknown host'}`,
      });
      if (data.receipts_error) {
        // Never render a clean board when a half could not be read.
        printWarning(`Receipts could not be read: ${data.receipts_error}`);
        return;
      }
      formatOutput(data.receipts || [], {
        format: program.opts().output,
        columns: ['created_at', 'kind', 'result', 'host', 'archive_id', 'archive_size_bytes', 'duration_seconds'],
        emptyMessage: 'No backup receipts recorded yet.',
      });
    });

  server
    .command('list')
    .description('Archives the runner host has registered')
    .action(async () => {
      auth.requireAuth();
      const endpoint = resolveEndpoint('backups.server.list');
      const data = await client.get(endpoint.path, { service: endpoint.service });
      const rows = (data.archives || []).map((a) => ({
        id: a.id,
        size_bytes: a.size_bytes,
        created_at: a.created_at,
        sha256: typeof a.sha256 === 'string' ? `${a.sha256.replace(/^sha256:/, '').slice(0, 12)}…` : '-',
      }));
      formatOutput(rows, {
        format: program.opts().output,
        columns: ['id', 'size_bytes', 'created_at', 'sha256'],
        headers: ['Archive ID', 'Size (bytes)', 'Created', 'SHA-256'],
        emptyMessage: 'No archives registered on the runner host.',
      });
    });

  server
    .command('download')
    .description('Download a server-wide archive to a local file')
    .argument('<archiveId>', 'archive id from `quox backup server list`')
    .option('--out <path>', 'output file (default ./<archiveId>.tar.gz)')
    .action(async (archiveId, options) => {
      auth.requireAuth();
      const endpoint = resolveEndpoint('backups.server.download', { archiveId });
      const res = await client.get(endpoint.path, { service: endpoint.service, raw: true, timeout: 1800000 });
      if (!res.ok) {
        let detail = '';
        try { detail = JSON.stringify(await res.json()); } catch { detail = res.statusText; }
        throw new Error(`Download failed with status ${res.status}: ${detail}`);
      }

      const outPath = path.resolve(options.out || `./${archiveId.endsWith('.tar.gz') ? archiveId : `${archiveId}.tar.gz`}`);
      // Hash WHAT WAS WRITTEN, not what the server said it would send: the
      // operator needs to compare the bytes on their disk against the
      // archive's registered sha256, and a hash taken anywhere else proves
      // nothing about the file they now hold.
      const hash = createHash('sha256');
      let bytes = 0;
      const sink = createWriteStream(outPath);
      const source = Readable.fromWeb(res.body);
      source.on('data', (chunk) => { bytes += chunk.length; hash.update(chunk); });
      await pipeline(source, sink);

      printSuccess(`Wrote ${bytes} bytes to ${outPath}`);
      printInfo(`sha256(${path.basename(outPath)}) = ${hash.digest('hex')}`);
      printInfo('Compare that against the SHA-256 column in `quox backup server list` before trusting the copy.');
    });

  server
    .command('restore')
    .description('Restore the whole box from a server-wide archive (DRY RUN unless --execute)')
    .argument('<archiveId>', 'archive id from `quox backup server list`')
    .option('--execute', 'perform a REAL restore (destroys current data), not a dry run')
    .option('--stores <list>', 'comma-separated store names to restore (default: all in the archive)')
    .action(async (archiveId, options) => {
      auth.requireAuth();
      const body = {};
      if (options.stores) body.stores = options.stores.split(',').map((s) => s.trim()).filter(Boolean);

      if (!options.execute) {
        // dry_run is left ABSENT rather than sent as true: the engine's own
        // default is dry-run, and asserting a posture the operator did not
        // state is how a real restore eventually happens by accident.
        printInfo('DRY RUN: nothing will be written. Re-run with --execute to restore for real.');
      } else {
        printWarning(`REAL RESTORE of ${archiveId}. This OVERWRITES this instance's data for EVERY org `
          + 'from the archive. Current data not in the archive is lost.');
        const { confirmDestructive } = await import('../core/confirm.js');
        const ok = await confirmDestructive(
          program,
          options,
          `Restore ${archiveId} over this instance, destroying current data?`,
        );
        if (!ok) {
          printInfo('Aborted. Nothing was dispatched.');
          return;
        }
        body.dry_run = false;
        body.confirm = 'RESTORE';
      }

      const endpoint = resolveEndpoint('backups.server.restore', { archiveId });
      const data = await client.post(endpoint.path, { service: endpoint.service, body });
      formatDetail(data, { format: program.opts().output, title: `Restore dispatched: ${archiveId}` });
      printWarning('Dispatched, not finished: poll `quox backup server restore-status` for the outcome.');
    });

  server
    .command('restore-status')
    .description('Live restore-engine state on the runner host, plus recent restore receipts')
    .action(async () => {
      auth.requireAuth();
      const endpoint = resolveEndpoint('backups.server.restoreStatus');
      const data = await client.get(endpoint.path, { service: endpoint.service });
      formatDetail(data.runner || {}, {
        format: program.opts().output,
        title: `Restore engine: ${data.runner_host || 'unknown host'}`,
      });
      if (data.receipts_error) {
        printWarning(`Restore receipts could not be read: ${data.receipts_error}`);
        return;
      }
      formatOutput(data.receipts || [], {
        format: program.opts().output,
        columns: ['created_at', 'result', 'archive_id', 'dry_run', 'host', 'duration_seconds'],
        emptyMessage: 'No restore receipts recorded yet.',
      });
    });
}
