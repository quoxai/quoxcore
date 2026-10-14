/**
 * QuoxPlan commands: roadmaps, streams, phases, plans, timeline
 * (STREAM_QUOXPLAN_PLAN.md, quoxcli parity gate P3b).
 *
 * Mirrors the standalone `quoxplan` CLI's verbs (quoxplan/cli)
 * one-for-one, but through the collector's governed proxy
 * (services/collector/server.js: /api/v1/quoxplan/* -> QuoxPlan server,
 * port 3107) instead of hitting the QuoxPlan server directly — same auth,
 * same profile, same --json/--insecure conventions as every other `quox`
 * command group. Mutations send actor: "quox-cli" (the standalone CLI sends
 * "cli") so the event log can tell the two clients apart.
 *
 * The render helpers (streamLine, renderStreamDetail, renderTimeline, etc.)
 * are adapted from the standalone CLI's lib/render/*.js — same visual
 * language (octahedron status glyphs per owner feedback 2026-07-25 point 5),
 * rebuilt on chalk instead of hand-rolled ANSI since chalk is already this
 * CLI's house convention.
 *
 * quox plan <subcommand> [options]
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import chalk from 'chalk';
import { printSuccess } from '../core/output.js';
import { events, printEvent, celebrate, line as glyphLine } from '../core/quoxglyph.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { QuoxApiError } from '../core/errors.js';

const VALID_LENSES = ['focus', 'tier', 'all'];
const VALID_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETE', 'BLOCKED', 'DECISION_NEEDED'];

const ID_WIDTH = 18;
const NAME_WIDTH = 36;
const WEEK_WIDTH = 4; // characters of bar per week, timeline view

// ── glyphs ───────────────────────────────────────────────────────────────

const STATUS_GLYPH = {
  NOT_STARTED: { glyph: '◇', color: chalk.dim },
  IN_PROGRESS: { glyph: '⬗', color: chalk.yellow },
  BLOCKED: { glyph: '◆', color: chalk.red },
  DECISION_NEEDED: { glyph: '◈', color: chalk.magenta },
  COMPLETE: { glyph: '◆', color: chalk.dim },
};

function statusGlyph(status) {
  return STATUS_GLYPH[status] || { glyph: '◇', color: chalk.dim };
}

const PHASE_GLYPH = {
  TODO: { glyph: '□', color: chalk.dim },
  IN_PROGRESS: { glyph: '▨', color: chalk.yellow },
  DONE: { glyph: '■', color: chalk.green },
};

function phaseGlyph(status) {
  return PHASE_GLYPH[status] || { glyph: '□', color: chalk.dim };
}

// ── small text helpers ───────────────────────────────────────────────────
// Pad/truncate the PLAIN string before applying chalk color — chalk wraps
// the string in fixed-length escape sequences, so padding an already-colored
// string with padEnd/padStart would count the escape bytes as visible width
// and break column alignment.

function pad(value, n) {
  const s = String(value ?? '');
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function truncate(value, n) {
  const s = String(value ?? '');
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + '…';
}

function wrapText(text, width) {
  const words = String(text || '').split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) {
      lines.push(line.trim());
      line = w;
    } else {
      line = line ? line + ' ' + w : w;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

/** Light ANSI pass-through markdown: headings bold cyan, code dim. Not a real parser. */
function renderMarkdownLite(md) {
  if (!md) return '';
  const lines = String(md).split('\n');
  const out = [];
  let inFence = false;
  for (let line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push(chalk.dim(line));
      continue;
    }
    if (inFence) {
      out.push(chalk.dim(line));
      continue;
    }
    if (/^(#{1,6})\s+(.*)$/.test(line)) {
      out.push(chalk.cyan.bold(line));
      continue;
    }
    line = line.replace(/`([^`]+)`/g, (_, code) => chalk.dim('`' + code + '`'));
    out.push(line);
  }
  return out.join('\n');
}

// ── render: roadmaps / stream lists ─────────────────────────────────────

function renderRoadmapsList(roadmaps) {
  const lines = [];
  for (const r of roadmaps) {
    lines.push('');
    lines.push(chalk.cyan.bold(`  ${r.id}`) + '  ' + r.name);
    if (r.description) lines.push(chalk.dim(`    ${r.description}`));
    const counts = r.status_counts || {};
    const parts = Object.entries(counts).map(([status, n]) => {
      const g = statusGlyph(status);
      return g.color(`${g.glyph} ${n} ${status}`);
    });
    lines.push(`    ${r.stream_count} streams  ${parts.join('  ')}`);
  }
  return lines;
}

function streamLine(s, { indent = 0, showReasons = false } = {}) {
  const prefix = indent > 0 ? '  '.repeat(indent) + '└ ' : '  ';
  const g = statusGlyph(s.status);
  const idPlain = pad(s.id, ID_WIDTH);
  const idStr = indent > 0 ? chalk.dim(idPlain) : chalk.cyan(idPlain);
  const nameStr = pad(truncate(s.name, NAME_WIDTH - 1), NAME_WIDTH);
  const tierStr = chalk.dim(`T${s.tier}`);
  const reasons =
    showReasons && s.focus_reasons && s.focus_reasons.length
      ? ' ' + chalk.magenta(`[${s.focus_reasons.join(',')}]`)
      : '';
  return `${prefix}${g.color.bold(g.glyph)} ${idStr} ${nameStr} ${tierStr}${reasons}`;
}

function streamAndSubstreams(s, opts) {
  const lines = [streamLine(s, opts)];
  for (const sub of s.substreams || []) {
    lines.push(streamLine(sub, { ...opts, indent: (opts.indent || 0) + 1 }));
  }
  return lines;
}

/** lens: 'tier' | 'focus' | 'all' — matches the API's `streams` payload shape for that lens. */
function renderStreamList(payload, { lens = 'tier' } = {}) {
  const lines = [];
  const streams = (payload && payload.streams) || [];

  if (lens === 'tier') {
    if (streams.length === 0) {
      lines.push(chalk.dim('  (no streams)'));
      return lines;
    }
    for (const group of streams) {
      lines.push('');
      lines.push(chalk.cyan.bold(`  TIER ${group.tier}`));
      for (const s of group.streams) {
        lines.push(...streamAndSubstreams(s, { indent: 0 }));
      }
    }
    return lines;
  }

  // 'focus' and 'all' are both flat arrays (already nested with substreams).
  if (streams.length === 0) {
    lines.push(chalk.dim(lens === 'focus' ? '  Nothing needs attention right now.' : '  (no streams)'));
    return lines;
  }
  for (const s of streams) {
    lines.push(...streamAndSubstreams(s, { indent: 0, showReasons: lens === 'focus' }));
  }
  return lines;
}

// ── render: stream detail ───────────────────────────────────────────────

function renderStreamDetail(detail) {
  const { stream, phases = [], plan, notes = [], depends_on: dependsOn = [], dependents = [] } = detail;
  const lines = [];
  const g = statusGlyph(stream.status);

  lines.push('');
  lines.push(chalk.cyan.bold(`  ${stream.id}`) + '  ' + chalk.bold(stream.name));
  lines.push(
    `  ${g.color.bold(g.glyph)} ${g.color(stream.status)}` +
      `  ${chalk.dim(`tier ${stream.tier}`)}  ${chalk.dim(`#${stream.priority}`)}` +
      (stream.effort ? `  ${chalk.dim(stream.effort)}` : '')
  );
  if (stream.tags && stream.tags.length) {
    lines.push('  ' + stream.tags.map((t) => chalk.dim(`[${t}]`)).join(' '));
  }
  lines.push('');
  for (const line of wrapText(stream.summary, 78)) lines.push(`  ${line}`);

  if (phases.length) {
    lines.push('');
    lines.push(chalk.cyan.bold('  Phases'));
    for (const p of phases) {
      const pg = phaseGlyph(p.status);
      lines.push(`    ${pg.color(pg.glyph)} ${pad(`${p.seq}.`, 4)}${p.title}`);
    }
  }

  if (dependsOn.length || dependents.length) {
    lines.push('');
    lines.push(chalk.cyan.bold('  Dependencies'));
    if (dependsOn.length) {
      lines.push(
        '    depends on: ' +
          dependsOn
            .map((d) => `${chalk.cyan(d.id)} ${statusGlyph(d.status).color(`(${d.status})`)}`)
            .join(', ')
      );
    }
    if (dependents.length) {
      lines.push(
        '    blocks: ' +
          dependents
            .map((d) => `${chalk.cyan(d.id)} ${statusGlyph(d.status).color(`(${d.status})`)}`)
            .join(', ')
      );
    }
  }

  if (plan && plan.body) {
    lines.push('');
    lines.push(chalk.cyan.bold(`  Plan (v${plan.version})`));
    lines.push('');
    lines.push(renderMarkdownLite(plan.body));
  }

  if (notes.length) {
    lines.push('');
    lines.push(chalk.cyan.bold('  Notes'));
    for (const n of notes) {
      lines.push(`    ${chalk.dim(n.created_at)} ${n.author ? chalk.dim(`(${n.author}) `) : ''}${n.body}`);
    }
  }

  lines.push('');
  return lines;
}

// ── render: timeline (ASCII Gantt) ──────────────────────────────────────

function barColor(status) {
  if (status === 'COMPLETE') return chalk.dim;
  if (status === 'BLOCKED') return chalk.red;
  if (status === 'IN_PROGRESS') return chalk.yellow;
  if (status === 'DECISION_NEEDED') return chalk.magenta;
  return chalk.white;
}

function barChar(status) {
  return status === 'BLOCKED' ? '▒' : '█';
}

function weekHeader(totalWeeks) {
  const cells = [];
  for (let w = 1; w <= totalWeeks; w++) cells.push(pad(`W${w}`, WEEK_WIDTH));
  return ' '.repeat(ID_WIDTH + 1 + NAME_WIDTH + 1) + cells.join('');
}

function renderTimelineRow(stream, totalWeeks) {
  const totalCols = totalWeeks * WEEK_WIDTH;
  const startCol = Math.max(0, Math.round((stream.start_offset_days / 7) * WEEK_WIDTH));
  const rawEndCol = Math.round((stream.end_offset_days / 7) * WEEK_WIDTH);
  const endCol = Math.min(totalCols, Math.max(startCol + 1, rawEndCol));
  const width = Math.max(1, endCol - startCol);

  const ch = barChar(stream.status);
  const color = barColor(stream.status);
  const bar = stream.on_critical_path ? color.bold(ch.repeat(width)) : color(ch.repeat(width));

  const idStr = chalk.cyan(pad(stream.id, ID_WIDTH));
  const nameStr = pad(truncate(stream.name, NAME_WIDTH - 1), NAME_WIDTH);

  let suffix = '';
  if (stream.error) {
    suffix = ' ' + chalk.red.bold('cyclic dependency');
  } else if (stream.status === 'BLOCKED' && stream.blocked_by && stream.blocked_by.length) {
    suffix = ' ' + chalk.red(`blocked by ${stream.blocked_by.join(', ')}`);
  }

  return `${idStr} ${nameStr} ${' '.repeat(startCol)}${bar}${suffix}`;
}

/**
 * timeline: array of stream schedule entries (getTimeline() domain fn shape).
 * opts.weeks: force the number of week columns (default: derived from the
 * longest schedule, minimum 1). opts.title: optional heading (roadmap id).
 */
function renderTimeline(timeline, opts = {}) {
  const lines = [];
  if (opts.title) {
    lines.push(chalk.cyan.bold(`  ${opts.title}`));
    lines.push('');
  }
  if (!timeline || timeline.length === 0) {
    lines.push(chalk.dim('  (no streams to schedule)'));
    return lines;
  }

  const maxEnd = timeline.reduce((m, s) => Math.max(m, s.end_offset_days || 0), 0);
  const totalWeeks = opts.weeks || Math.max(1, Math.ceil(maxEnd / 7));

  lines.push(chalk.dim(weekHeader(totalWeeks)));

  const sorted = [...timeline].sort((a, b) => {
    const laneDiff = (a.lane ?? 0) - (b.lane ?? 0);
    if (laneDiff !== 0) return laneDiff;
    const startDiff = (a.start_offset_days ?? 0) - (b.start_offset_days ?? 0);
    if (startDiff !== 0) return startDiff;
    return a.id.localeCompare(b.id);
  });

  for (const s of sorted) lines.push(renderTimelineRow(s, totalWeeks));

  lines.push('');
  lines.push(
    chalk.dim('  Legend: ') +
      chalk.cyan.bold('███') +
      chalk.dim(' critical path  ') +
      chalk.yellow('███') +
      chalk.dim(' in progress  ') +
      chalk.dim('███') +
      chalk.dim(' complete  ') +
      chalk.red('▒▒▒') +
      chalk.dim(' blocked')
  );

  return lines;
}

// ── render: stats / completed ────────────────────────────────────────────
// Fed by GET /roadmaps/:id/export (the same STRATEGIC_ROADMAP.json-shaped
// doc the retired roadmap-cli used to read from disk). Adapted from the
// standalone quoxplan CLI's lib/render/stats.js and completed.js, rebuilt
// on chalk per this file's house convention.

function progressBar(done, total) {
  if (total <= 0) return '';
  const width = 20;
  const filled = Math.round((done / total) * width);
  const pct = Math.round((done / total) * 100);
  const color = pct >= 80 ? chalk.green : pct >= 40 ? chalk.yellow : chalk.dim;
  return color('█'.repeat(filled)) + chalk.dim('░'.repeat(width - filled)) + chalk.dim(` ${pct}%`);
}

function renderStats(doc) {
  const streams = doc.streams || [];
  const completed = doc.completed || [];

  const inProgress = streams.filter((s) => s.status === 'IN_PROGRESS').length;
  const notStarted = streams.filter((s) => s.status === 'NOT_STARTED').length;
  const blocked = streams.filter((s) => s.status === 'BLOCKED').length;
  const decisions = streams.filter((s) => s.status === 'DECISION_NEEDED').length;

  const totalPhases = streams.reduce((a, s) => a + (s.phases_total || 0), 0);
  const donePhases = streams.reduce((a, s) => a + (s.phases_done || 0), 0);
  const totalTests = completed.reduce((a, s) => a + (s.tests || 0), 0);

  const lines = [];
  lines.push('');
  lines.push(chalk.cyan.bold('  ROADMAP STATISTICS') + '  ' + chalk.dim(doc.updated || ''));
  lines.push('  ' + '-'.repeat(50));
  lines.push(`  ${chalk.green('✓ Completed')}        ${completed.length} streams`);
  lines.push(`  ${chalk.yellow('● In progress')}      ${inProgress} streams`);
  lines.push(`  ${chalk.dim('○ Not started')}      ${notStarted} streams`);
  if (blocked) lines.push(`  ${chalk.red('✗ Blocked')}          ${blocked} streams`);
  if (decisions) lines.push(`  ${chalk.magenta('? Needs decision')}   ${decisions} streams`);
  lines.push('');
  lines.push(
    `  Phase progress   ${progressBar(donePhases, totalPhases || 1)} ${chalk.dim(`(${donePhases}/${totalPhases})`)}`
  );
  lines.push(`  Tests shipped    ${totalTests} ${chalk.dim('(completed streams)')}`);
  lines.push('');
  return lines;
}

function renderCompletedList(completed) {
  const lines = [];
  const list = completed || [];
  lines.push('');
  lines.push(chalk.cyan.bold(`  COMPLETED STREAMS (${list.length})`));
  lines.push('  ' + '-'.repeat(60));
  if (list.length === 0) {
    lines.push(chalk.dim('  (none yet)'));
    lines.push('');
    return lines;
  }
  const sorted = [...list].sort((a, b) => String(b.completed).localeCompare(String(a.completed)));
  for (const s of sorted) {
    const tests = s.tests ? chalk.dim(` (${s.tests} tests)`) : '';
    const completedDate = s.completed || chalk.dim('unknown date');
    lines.push(`  ${chalk.green('[DONE]')} ${pad(s.id, 12)} ${pad(s.name, 35)} ${completedDate}${tests}`);
  }
  lines.push('');
  return lines;
}

// ── helpers ──────────────────────────────────────────────────────────────

/**
 * Name the active org from what the CLI profile already stores (no network),
 * so an empty or 404 answer reads as "wrong org?" and not as data loss
 * (quox#751). Honours a --org override.
 */
function describeActiveOrg(auth, program) {
  let stored = null;
  try { stored = typeof auth.getTokens === 'function' ? auth.getTokens() : null; } catch { stored = null; }
  let override = null;
  try { override = program?.opts?.().org || null; } catch { override = null; }
  const id = override || stored?.org_id || null;
  const name = override ? null : (stored?.org_name || null);
  const slug = override ? null : (stored?.org_slug || null);
  const ident = slug || id;
  if (name && ident && name !== ident) return `${name} (${ident})`;
  return name || ident || 'unknown';
}

/** Default roadmap = first from GET /roadmaps (server orders by name). */
async function resolveRoadmapId(client, explicit, orgLabel) {
  if (explicit) return explicit;
  const ep = resolveEndpoint('quoxplan.roadmaps.list');
  const data = await client.get(ep.path, { service: ep.service });
  const roadmaps = data.roadmaps || [];
  if (roadmaps.length === 0) {
    throw new Error(
      `No roadmaps in org ${orgLabel || 'unknown'}. Roadmaps may exist in another org you belong to; `
      + 'switch with `quox org switch <org>`.'
    );
  }
  return roadmaps[0].id;
}

function printJson(data) {
  console.log(JSON.stringify(data, null, 2));
}

function isJsonOutput(program) {
  return program.opts().output === 'json';
}

// `quox plan update` field coercion — mirrors the standalone quoxplan CLI's
// update.js: numeric fields parse as Number, array fields accept either a
// JSON array literal or a comma-separated list.
const UPDATE_NUM_FIELDS = ['tier', 'effort_days'];
const UPDATE_ARRAY_FIELDS = ['tags', 'depends_on'];

function coerceUpdateValue(field, value) {
  if (UPDATE_NUM_FIELDS.includes(field)) return Number(value);
  if (UPDATE_ARRAY_FIELDS.includes(field)) {
    try {
      return JSON.parse(value);
    } catch {
      return value.split(',').map((v) => v.trim());
    }
  }
  return value;
}

// ── registration ─────────────────────────────────────────────────────────

export function registerPlanCommands(program, ctx) {
  const { client, auth } = ctx;

  const plan = program
    .command('plan')
    .description('QuoxPlan: roadmaps, streams, phases, plans, timeline (governed proxy to the QuoxPlan server)');

  // ── roadmaps ─────────────────────────────────────────────────────────

  plan
    .command('roadmaps')
    .description('List roadmaps with status counts')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('quoxplan.roadmaps.list');
      const data = await client.get(ep.path, { service: ep.service });
      if (isJsonOutput(program)) return printJson(data);
      console.log(renderRoadmapsList(data.roadmaps || []).join('\n'));
    });

  // ── roadmap (create) ─────────────────────────────────────────────────
  // Roadmap-create primitive (ONBOARD step 0). The plural `plan roadmaps`
  // above lists; this singular `plan roadmap create` makes one. Reused by the
  // `quox onboard` wizard to give a fresh tenant its own roadmap, but a
  // standalone verb in its own right so nothing has to shell out to onboard.
  const roadmap = plan
    .command('roadmap')
    .description('Roadmap-level operations (create a roadmap)');

  roadmap
    .command('create')
    .description('Create a roadmap (POST to the governed QuoxPlan proxy)')
    // NOT requiredOption: --org shadows the root program's global --org <slug>
    // (bin/quox.js). Commander's mandatory-option check runs BEFORE the
    // mergeShadowedGlobals preAction hook, so a requiredOption here fires
    // "required option '--org' not specified" even when the user supplied it.
    // Same defect as quox#457 on fleet rehome-agent; the action validates it
    // below instead. See lib/core/global-flags.js.
    .option('--org <orgId>', 'org that owns the roadmap')
    .requiredOption('--id <roadmapId>', 'roadmap id (stable, e.g. the tenant slug)')
    .requiredOption('--title <title>', 'human-readable roadmap title')
    .option('--description <text>', 'roadmap description')
    .action(async (options) => {
      auth.requireAuth();
      // --org can arrive on the subcommand (merged by the preAction hook) or,
      // when shadowed, on the root. Read both before deciding it is missing.
      const orgId = String(options.org || program.opts().org || '').trim();
      if (!orgId) {
        throw new Error(
          'Missing --org <orgId>. Usage: quox plan roadmap create --org <orgId> --id <roadmapId> --title <title>'
        );
      }
      const body = {
        org_id: orgId,
        id: options.id,
        name: options.title,
        actor: 'quox-cli',
      };
      if (options.description) body.description = options.description;
      const ep = resolveEndpoint('quoxplan.roadmaps.create');
      const data = await client.post(ep.path, { service: ep.service, body });
      if (isJsonOutput(program)) return printJson(data);
      const created = data.roadmap || data;
      printSuccess(`Created roadmap ${created.id || options.id} for org ${orgId}`);
    });

  // ── list ─────────────────────────────────────────────────────────────

  plan
    .command('list [roadmap]')
    .description('Tier-grouped stream list (default roadmap: first by name)')
    .option('--lens <lens>', 'focus | tier | all', 'tier')
    .action(async (roadmapArg, options) => {
      auth.requireAuth();
      if (!VALID_LENSES.includes(options.lens)) {
        throw new Error(`invalid --lens "${options.lens}" (expected focus, tier, or all)`);
      }
      const roadmapId = await resolveRoadmapId(client, roadmapArg, describeActiveOrg(auth, program));
      const ep = resolveEndpoint('quoxplan.roadmap.streams.list', { roadmapId });
      const data = await client.get(ep.path, { service: ep.service, query: { lens: options.lens } });
      if (isJsonOutput(program)) return printJson(data);
      console.log(`\n  ${roadmapId}  (lens: ${options.lens})`);
      console.log(renderStreamList(data, { lens: options.lens }).join('\n'));
    });

  // ── focus ────────────────────────────────────────────────────────────

  plan
    .command('focus [roadmap]')
    .description('The focus lens: what matters now (P0, blocked, decision needed, in-flight, stale)')
    .action(async (roadmapArg) => {
      auth.requireAuth();
      const roadmapId = await resolveRoadmapId(client, roadmapArg, describeActiveOrg(auth, program));
      const ep = resolveEndpoint('quoxplan.roadmap.streams.list', { roadmapId });
      const data = await client.get(ep.path, { service: ep.service, query: { lens: 'focus' } });
      if (isJsonOutput(program)) return printJson(data);
      console.log(`\n  ${roadmapId}  (focus)`);
      console.log(renderStreamList(data, { lens: 'focus' }).join('\n'));
    });

  // ── show ─────────────────────────────────────────────────────────────

  plan
    .command('show <streamId>')
    .description('Full stream detail: header, phases checklist, plan, notes timeline, deps')
    .action(async (streamId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('quoxplan.stream.get', { id: streamId });
      let detail;
      try {
        detail = await client.get(ep.path, { service: ep.service });
      } catch (err) {
        if (err instanceof QuoxApiError && err.status === 404) {
          throw new QuoxApiError(404, err.code, `Stream ${streamId} not found in org ${describeActiveOrg(auth, program)}. It may exist in another org you belong to; switch with \`quox org switch <org>\`.`, err.detail, err.body);
        }
        throw err;
      }
      if (isJsonOutput(program)) return printJson(detail);
      console.log(renderStreamDetail(detail).join('\n'));
    });

  // ── timeline ─────────────────────────────────────────────────────────

  plan
    .command('timeline [roadmap]')
    .description('ASCII Gantt: dependency-sequenced schedule, critical path bold, blocked edges marked')
    .option('--weeks <n>', 'force the number of week columns shown', (v) => parseInt(v, 10))
    .action(async (roadmapArg, options) => {
      auth.requireAuth();
      const roadmapId = await resolveRoadmapId(client, roadmapArg, describeActiveOrg(auth, program));
      const ep = resolveEndpoint('quoxplan.roadmap.timeline.get', { roadmapId });
      const data = await client.get(ep.path, { service: ep.service });
      if (isJsonOutput(program)) return printJson(data);
      console.log(renderTimeline(data.timeline, { weeks: options.weeks, title: roadmapId }).join('\n'));
    });

  // ── status ───────────────────────────────────────────────────────────

  plan
    .command('status <id> <status>')
    .description('PATCH a stream status (COMPLETE requires --confirm-owner; never auto-confirmed)')
    .option('--confirm-owner', 'confirm an owner-gated transition to COMPLETE')
    .action(async (id, statusArg, options) => {
      auth.requireAuth();
      const status = statusArg.toUpperCase();
      if (!VALID_STATUSES.includes(status)) {
        throw new Error(`invalid status "${statusArg}" (expected one of ${VALID_STATUSES.join(', ')})`);
      }
      const body = { status, actor: 'quox-cli' };
      // No auto-confirm: confirm_owner is only ever sent when the caller
      // explicitly passed --confirm-owner. The server rejects COMPLETE
      // without it (403) and that error is surfaced verbatim, not retried.
      if (options.confirmOwner) body.confirm_owner = true;
      const ep = resolveEndpoint('quoxplan.stream.update', { id });
      const data = await client.patch(ep.path, { service: ep.service, body });
      if (isJsonOutput(program)) return printJson(data);
      if (data.stream.status === 'COMPLETE') {
        printEvent(glyphLine('quoxplan', 'stream', { result: celebrate(`◆ ${id} COMPLETE ◆ every phase done`) }));
      } else {
        printEvent(glyphLine('quoxplan', 'status', { result: `${id} -> ${data.stream.status}` }));
      }
    });

  // ── note ─────────────────────────────────────────────────────────────

  plan
    .command('note <id> <text...>')
    .description("Append a note to a stream's timeline (append-only, never replaced)")
    .action(async (id, textParts) => {
      auth.requireAuth();
      const body = textParts.join(' ');
      if (!body.trim()) throw new Error('note text is required');
      const ep = resolveEndpoint('quoxplan.stream.notes.create', { id });
      const data = await client.post(ep.path, { service: ep.service, body: { body, actor: 'quox-cli' } });
      if (isJsonOutput(program)) return printJson(data);
      printEvent(glyphLine('quoxplan', 'note appended', { result: `${id} #${data.id}`, status: 'ok' }));
    });

  // ── phase ────────────────────────────────────────────────────────────

  plan
    .command('phase <streamId> <verb> [rest...]')
    .description('Phase ops: "tick <seq>", "untick <seq>", "add <title>", "rename <seq> <title>", "remove <seq>"')
    .action(async (streamId, verb, rest) => {
      auth.requireAuth();

      if (verb === 'tick' || verb === 'untick' || verb === 'rename' || verb === 'remove') {
        const seq = parseInt(rest[0], 10);
        if (!Number.isInteger(seq)) {
          throw new Error(`phase ${verb} requires a numeric <seq>, got "${rest[0]}"`);
        }
        const newTitle = rest.slice(1).join(' ').trim();
        if (verb === 'rename' && !newTitle) throw new Error('phase rename requires a <title>');
        // Resolve seq -> phaseId via stream detail (phases are addressed by
        // numeric id server-side, not by seq).
        const detailEp = resolveEndpoint('quoxplan.stream.get', { id: streamId });
        const detail = await client.get(detailEp.path, { service: detailEp.service });
        const phase = (detail.phases || []).find((p) => p.seq === seq);
        if (!phase) throw new Error(`no phase with seq ${seq} on ${streamId}`);

        if (verb === 'rename') {
          const ep = resolveEndpoint('quoxplan.phase.update', { phaseId: phase.id });
          const data = await client.patch(ep.path, { service: ep.service, body: { title: newTitle, actor: 'quox-cli' } });
          if (isJsonOutput(program)) return printJson(data);
          printSuccess(`${streamId}: phase ${seq} "${phase.title}" renamed to "${newTitle}"`);
          return;
        }

        if (verb === 'remove') {
          const ep = resolveEndpoint('quoxplan.phase.delete', { phaseId: phase.id });
          const data = await client.delete(ep.path, { service: ep.service, body: { actor: 'quox-cli' } });
          if (isJsonOutput(program)) return printJson(data);
          printSuccess(`${streamId}: phase ${seq} "${phase.title}" removed (remaining phases renumbered)`);
          return;
        }

        const status = verb === 'tick' ? 'DONE' : 'TODO';
        const ep = resolveEndpoint('quoxplan.phase.update', { phaseId: phase.id });
        const data = await client.patch(ep.path, { service: ep.service, body: { status, actor: 'quox-cli' } });
        if (isJsonOutput(program)) return printJson(data);
        printSuccess(`${streamId}: phase ${seq} "${phase.title}" -> ${status}`);
        return;
      }

      if (verb === 'add') {
        const title = rest.join(' ');
        if (!title) throw new Error('phase add requires a <title>');
        const ep = resolveEndpoint('quoxplan.stream.phases.create', { id: streamId });
        const data = await client.post(ep.path, { service: ep.service, body: { title, actor: 'quox-cli' } });
        if (isJsonOutput(program)) return printJson(data);
        const phases = data.phases || [];
        const added = phases[phases.length - 1];
        printSuccess(`${streamId}: phase "${title}" added (seq ${added ? added.seq : '?'})`);
        return;
      }

      throw new Error(`unknown phase verb "${verb}" (expected tick, untick, add, rename, or remove)`);
    });

  // ── plan (doc) ───────────────────────────────────────────────────────

  plan
    .command('plan <id>')
    .description('Print raw plan markdown; --edit opens $EDITOR (PUT on save if changed); --history lists versions')
    .option('--edit', 'open $EDITOR on the plan body, PUT on save if changed')
    .option('--history', 'list plan versions instead of printing the body')
    .action(async (id, options) => {
      auth.requireAuth();

      if (options.history) {
        const ep = resolveEndpoint('quoxplan.stream.plan.versions.list', { id });
        const data = await client.get(ep.path, { service: ep.service });
        if (isJsonOutput(program)) return printJson(data);
        const versions = data.versions || [];
        if (versions.length === 0) {
          console.log(chalk.dim('  (no plan versions yet)'));
          return;
        }
        for (const v of versions) {
          console.log(`  v${v.version}  ${v.updated_at}  ${v.updated_by || 'unknown'}  (${v.length} bytes)`);
        }
        return;
      }

      const detailEp = resolveEndpoint('quoxplan.stream.get', { id });
      const detail = await client.get(detailEp.path, { service: detailEp.service });
      const currentBody = (detail.plan && detail.plan.body) || '';

      if (options.edit) {
        const dir = mkdtempSync(join(tmpdir(), 'quox-plan-'));
        const file = join(dir, `${id}.md`);
        writeFileSync(file, currentBody, 'utf8');
        const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
        const result = spawnSync(editor, [file], { stdio: 'inherit' });
        if (result.error) throw result.error;
        const newBody = readFileSync(file, 'utf8');
        try {
          unlinkSync(file);
        } catch {
          /* best-effort cleanup */
        }
        if (newBody === currentBody) {
          console.log(chalk.dim('  No changes.'));
          return;
        }
        const putEp = resolveEndpoint('quoxplan.stream.plan.put', { id });
        const data = await client.put(putEp.path, { service: putEp.service, body: { body: newBody, actor: 'quox-cli' } });
        if (isJsonOutput(program)) return printJson(data);
        printSuccess(`${id}: plan updated to v${data.version}`);
        return;
      }

      if (isJsonOutput(program)) return printJson(detail.plan);
      if (!currentBody) {
        console.log(chalk.dim('  (no plan yet)'));
        return;
      }
      console.log(renderMarkdownLite(currentBody));
    });

  // ── move ─────────────────────────────────────────────────────────────

  plan
    .command('move <roadmap> <id> <position>')
    .description('Reprioritise a top-level stream to a 1-based position')
    .action(async (roadmapId, id, positionArg) => {
      auth.requireAuth();
      const position = parseInt(positionArg, 10);
      if (!Number.isInteger(position) || position < 1) {
        throw new Error('position must be a positive integer');
      }

      const listEp = resolveEndpoint('quoxplan.roadmap.streams.list', { roadmapId });
      const listData = await client.get(listEp.path, { service: listEp.service, query: { lens: 'all' } });
      const order = (listData.streams || []).map((s) => s.id);
      const idx = order.indexOf(id);
      if (idx === -1) {
        throw new Error(`"${id}" is not a top-level stream on roadmap "${roadmapId}"`);
      }

      order.splice(idx, 1);
      const insertAt = Math.min(position - 1, order.length);
      order.splice(insertAt, 0, id);

      const ep = resolveEndpoint('quoxplan.roadmap.reprioritise', { roadmapId });
      const data = await client.post(ep.path, { service: ep.service, body: { order, actor: 'quox-cli' } });
      if (isJsonOutput(program)) return printJson(data);
      printSuccess(`${id}: moved to position #${insertAt + 1} on ${roadmapId}`);
    });

  // ── add ──────────────────────────────────────────────────────────────

  plan
    .command('add <json>')
    .description('Create a new stream from a JSON object (id, name required)')
    .option('--roadmap <roadmap>', 'roadmap id (default: first roadmap)')
    .action(async (json, options) => {
      auth.requireAuth();
      let body;
      try {
        body = JSON.parse(json);
      } catch (err) {
        throw new Error(`invalid JSON: ${err.message}`);
      }
      body.actor = body.actor || 'quox-cli';
      const roadmapId = await resolveRoadmapId(client, options.roadmap, describeActiveOrg(auth, program));
      const ep = resolveEndpoint('quoxplan.roadmap.streams.create', { roadmapId });
      const data = await client.post(ep.path, { service: ep.service, body });
      if (isJsonOutput(program)) return printJson(data);
      printSuccess(`Added stream ${data.stream.id} to ${roadmapId} at priority #${data.stream.priority}`);
    });

  // ── update ───────────────────────────────────────────────────────────

  plan
    .command('update <id> <field> <value>')
    .description('Update a stream field (notes append; priority use `move` instead)')
    .action(async (id, field, value) => {
      auth.requireAuth();
      if (field === 'priority') {
        throw new Error('priority is not directly settable; use `quox plan move <roadmap> <id> <position>` instead');
      }

      if (field === 'notes') {
        console.error(
          chalk.yellow(
            '  Warning: notes are append-only in QuoxPlan (a timeline, not a single field) — appending, not replacing.'
          )
        );
        const ep = resolveEndpoint('quoxplan.stream.notes.create', { id });
        const data = await client.post(ep.path, { service: ep.service, body: { body: value, actor: 'quox-cli' } });
        if (isJsonOutput(program)) return printJson(data);
        printEvent(glyphLine('quoxplan', 'note appended', { result: `${id} #${data.id}`, status: 'ok' }));
        return;
      }

      const body = { [field]: coerceUpdateValue(field, value), actor: 'quox-cli' };
      const ep = resolveEndpoint('quoxplan.stream.update', { id });
      const data = await client.patch(ep.path, { service: ep.service, body });
      if (isJsonOutput(program)) return printJson(data);
      printSuccess(`${id}.${field} = ${JSON.stringify(data.stream[field])}`);
    });

  // ── rename ───────────────────────────────────────────────────────────

  plan
    .command('rename <oldId> <newId>')
    .description('Rename a stream id, cascading to depends_on/parent_id references')
    .action(async (oldId, newId) => {
      auth.requireAuth();
      const ep = resolveEndpoint('quoxplan.stream.rename', { id: oldId });
      const data = await client.post(ep.path, { service: ep.service, body: { new_id: newId, actor: 'quox-cli' } });
      if (isJsonOutput(program)) return printJson(data);
      printSuccess(`Renamed ${oldId} -> ${data.stream.id}`);
    });

  // ── stats ────────────────────────────────────────────────────────────

  plan
    .command('stats [roadmap]')
    .description('Roadmap statistics (streams, phase progress, tests shipped)')
    .action(async (roadmapArg) => {
      auth.requireAuth();
      const roadmapId = await resolveRoadmapId(client, roadmapArg, describeActiveOrg(auth, program));
      const ep = resolveEndpoint('quoxplan.roadmap.export.get', { roadmapId });
      const data = await client.get(ep.path, { service: ep.service });
      if (isJsonOutput(program)) return printJson(data);
      console.log(renderStats(data).join('\n'));
    });

  // ── completed ────────────────────────────────────────────────────────

  plan
    .command('completed [roadmap]')
    .description('List completed streams')
    .action(async (roadmapArg) => {
      auth.requireAuth();
      const roadmapId = await resolveRoadmapId(client, roadmapArg, describeActiveOrg(auth, program));
      const ep = resolveEndpoint('quoxplan.roadmap.export.get', { roadmapId });
      const data = await client.get(ep.path, { service: ep.service });
      if (isJsonOutput(program)) return printJson(data.completed);
      console.log(renderCompletedList(data.completed).join('\n'));
    });
}
