/**
 * QuoxBox commands: status, workflows, tasks, and HITL approvals for the
 * governed Mac-mini agent gateway, proxied through the collector
 * (services/collector/routes/quoxbox-proxy.js, mounted at /api/quoxbox).
 *
 * quox quoxbox <subcommand> [options]
 */

import chalk from 'chalk';
import { formatOutput, formatDetail, printSuccess, printWarning } from '../core/output.js';
import { resolveEndpoint } from '../api/endpoints.js';

const VALID_MODES = ['readonly', 'propose', 'actuate'];

/** Commander collector for repeatable --param key=value flags -> { key: value, ... }. */
function collectParam(input, previous) {
  const idx = input.indexOf('=');
  if (idx === -1) {
    throw new Error(`Invalid --param value "${input}". Expected key=value.`);
  }
  const key = input.slice(0, idx).trim();
  const value = input.slice(idx + 1);
  if (!key) {
    throw new Error(`Invalid --param value "${input}". Key cannot be empty.`);
  }
  return { ...previous, [key]: value };
}

function statusDot(ok) {
  return ok ? chalk.green('●') : chalk.red('●');
}

function renderStatus(data) {
  const pending = data.pending || [];
  const tasks = data.tasks || [];
  const lines = [];

  lines.push('');
  lines.push(chalk.bold(' QUOXBOX STATUS') + chalk.dim(`  mode: ${data.mode}`));
  lines.push(chalk.dim(' ' + '─'.repeat(60)));
  lines.push(` ${statusDot(!data.halt)} Halt              ${data.halt ? chalk.red('yes') : chalk.green('no')}`);
  lines.push(` ${statusDot(data.screenLocked === false)} Screen Locked     ${data.screenLocked ? chalk.yellow('yes') : chalk.green('no')}`);
  lines.push(` ${statusDot(!data.breakerTripped)} Breaker Tripped   ${data.breakerTripped ? chalk.red('yes') : chalk.green('no')}`);
  lines.push(` ${statusDot(true)} Pending Approvals ${pending.length > 0 ? chalk.yellow(pending.length) : pending.length}`);
  lines.push(` ${statusDot(true)} Actuations/hr     ${data.actuationsLastHour ?? 0}`);

  if (tasks.length > 0) {
    lines.push('');
    lines.push(chalk.bold(' Recent Tasks'));
    for (const t of tasks) {
      lines.push(`   ${chalk.cyan(t.id)}  ${t.workflow}  ${t.status}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

function renderTask(task) {
  const lines = [];
  lines.push('');
  lines.push(chalk.bold(` Task: ${task.id}`));
  lines.push(chalk.dim(' ' + '─'.repeat(60)));
  lines.push(` Workflow    ${task.workflow}`);
  if (task.desc) lines.push(` Desc        ${task.desc}`);
  lines.push(` Status      ${task.status}`);
  lines.push(` Progress    ${task.cursor}/${task.total}`);
  lines.push(` Started     ${task.startedAt || '-'}`);
  lines.push(` Finished    ${task.finishedAt || '-'}`);

  const steps = task.steps || [];
  if (steps.length > 0) {
    lines.push('');
    lines.push(chalk.bold(' Steps'));
    steps.forEach((step, i) => {
      if (!step) {
        lines.push(`   ${i + 1}. ${chalk.dim('(pending)')}`);
        return;
      }
      const label = step.label || step.tool || `step ${i + 1}`;
      lines.push(`   ${i + 1}. ${label}  ${chalk.dim(step.status || '-')}`);
      if (step.status === 'awaiting_approval' && (step.pendingId || task.pendingId)) {
        const approvalId = step.pendingId || task.pendingId;
        lines.push(`      ${chalk.yellow.bold(`⚠ HELD — approval required: ${approvalId}`)}`);
        lines.push(`      ${chalk.dim(`Run \`quox quoxbox approve ${approvalId}\` or \`quox quoxbox deny ${approvalId}\``)}`);
      }
      if (step.detail) lines.push(`      ${chalk.dim(step.detail)}`);
    });
  }

  lines.push('');
  return lines.join('\n');
}

export function registerQuoxboxCommands(program, ctx) {
  const { client, auth } = ctx;

  const quoxbox = program
    .command('quoxbox')
    .description('QuoxBox governed Mac-mini agent — status, workflows, tasks, HITL approvals');

  // ── status ───────────────────────────────────────────────────────────────

  quoxbox
    .command('status')
    .description('Show QuoxBox live status: mode, halt, breaker, pending approvals, recent tasks')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('quoxbox.live');
      const data = await client.get(ep.path, { service: ep.service });

      const format = program.opts().output;
      if (format === 'json') {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      if (format === 'quiet') {
        console.log(data.mode || '');
        return;
      }
      console.log(renderStatus(data));
    });

  // ── workflows ────────────────────────────────────────────────────────────

  quoxbox
    .command('workflows')
    .description('List available governed workflows')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('quoxbox.workflows.list');
      const data = await client.get(ep.path, { service: ep.service });
      formatOutput({
        columns: ['id', 'desc', 'params', 'steps'],
        headers: ['ID', 'Description', 'Params', 'Steps'],
        rows: (data.workflows || []).map((w) => ({
          ...w,
          params: (w.params || []).map((p) => p.name || p).join(', '),
        })),
      }, { format: program.opts().output, emptyMessage: 'No workflows registered.' });
    });

  // ── run ──────────────────────────────────────────────────────────────────

  quoxbox
    .command('run')
    .description('Start a governed workflow task')
    .argument('<workflow>', 'workflow ID')
    .option('--param <key=value>', 'workflow param (repeatable)', collectParam, {})
    .option('--mode <mode>', 'override gateway mode for this call (readonly|propose|actuate)')
    .action(async (workflow, options) => {
      auth.requireAuth();
      if (options.mode && !VALID_MODES.includes(options.mode)) {
        throw new Error(`--mode must be one of: ${VALID_MODES.join(', ')}`);
      }

      const body = { workflow, params: options.param || {} };
      if (options.mode) body.mode = options.mode;

      const ep = resolveEndpoint('quoxbox.task.run');
      const data = await client.post(ep.path, { service: ep.service, body });
      const task = data.task || data;

      if (program.opts().output === 'json') {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      printSuccess(`Task started: ${task.id} (workflow: ${task.workflow}, status: ${task.status})`);
    });

  // ── task ─────────────────────────────────────────────────────────────────

  quoxbox
    .command('task')
    .description('Show full task detail, including step states')
    .argument('<taskId>', 'task ID')
    .action(async (taskId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('quoxbox.task.get', { taskId });
      const data = await client.get(ep.path, { service: ep.service });
      const task = data.task || data;

      const format = program.opts().output;
      if (format === 'json') {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      if (format === 'quiet') {
        console.log(task.id || '');
        return;
      }
      console.log(renderTask(task));
    });

  // ── tasks ────────────────────────────────────────────────────────────────

  quoxbox
    .command('tasks')
    .description('List recent tasks (from live status)')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('quoxbox.live');
      const data = await client.get(ep.path, { service: ep.service });
      formatOutput({
        columns: ['id', 'workflow', 'status', 'startedAt'],
        headers: ['Task ID', 'Workflow', 'Status', 'Started'],
        rows: data.tasks || [],
      }, { format: program.opts().output, emptyMessage: 'No recent tasks.' });
    });

  // ── approve / deny ───────────────────────────────────────────────────────

  quoxbox
    .command('approve')
    .description('Approve a pending HITL action')
    .argument('<approvalId>', 'pending approval ID')
    .action(async (approvalId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('quoxbox.approve', { approvalId });
      const data = await client.post(ep.path, { service: ep.service, body: {} });

      if (program.opts().output === 'json') {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      formatDetail(data, { format: program.opts().output, title: `Approved: ${approvalId}` });
    });

  quoxbox
    .command('deny')
    .description('Deny a pending HITL action')
    .argument('<approvalId>', 'pending approval ID')
    .action(async (approvalId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('quoxbox.deny', { approvalId });
      const data = await client.post(ep.path, { service: ep.service, body: {} });

      if (program.opts().output === 'json') {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      formatDetail(data, { format: program.opts().output, title: `Denied: ${approvalId}` });
    });

  // ── mode ─────────────────────────────────────────────────────────────────

  quoxbox
    .command('mode')
    .description('Set the QuoxBox gateway mode (readonly|propose|actuate)')
    .argument('<mode>', 'readonly | propose | actuate')
    .action(async (mode) => {
      auth.requireAuth();
      if (!VALID_MODES.includes(mode)) {
        throw new Error(`mode must be one of: ${VALID_MODES.join(', ')}`);
      }

      if (mode === 'actuate') {
        printWarning('WARNING: actuate mode allows QuoxBox to execute governed actions on approval/policy pass, without further confirmation from this CLI.');
      }

      const ep = resolveEndpoint('quoxbox.mode.set');
      const data = await client.post(ep.path, { service: ep.service, body: { mode } });

      if (program.opts().output === 'json') {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      printSuccess(`QuoxBox mode set to: ${data.mode || mode}`);
    });
}
