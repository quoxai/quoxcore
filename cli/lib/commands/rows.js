/**
 * ROWS (owner 2026-10-17): `quox rows`, the CLI for the live lines above the quox window's status bar.
 * CLI first: everything /row does in the window works here, from a shell or a script.
 *
 *   quox rows list [--now]                          what you have, where each one lives, what it shows now
 *   quox rows add <id> --url|--quox|--plugin|--cmd  one row (no --template = the status-row contract)
 *   quox rows edit <id> [...]                       change any field; --contract drops the template
 *   quox rows remove <id>                           (alias rm)
 *   quox rows test [id] | test --url ...            fetch once and draw it here, nothing saved for an ad hoc test
 *   quox rows share [id...]                         a bundle others can import (command rows never leave)
 *   quox rows import <file|->                       url, quox and plugin rows; command rows need --trust-commands
 *                                                   AND a person answering y to each exact command
 *   quox rows contract                              the JSON shape a row endpoint returns
 *
 * Storage is the same as the window's (quoxon/rowsStore.js): synced rows in the user's server-side preferences,
 * command rows in a 0600 local file. An open window picks changes up within a minute, or at once with /row reload.
 */
import chalk from 'chalk';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { resolveEndpoint } from '../api/endpoints.js';
import { resolveOrgId } from './helpers.js';
import {
  checkRow, secretInRow, syncable, createRowEngine, runShell, rowParts, clipParts, labelWidth, MAX_ROWS,
  shareBundle, readBundle, cleanText, STATUS_ROW_TONES, themeRole, ROLES, fieldHints, dataFrom
} from '../quoxon/rows.js';
import { createRowsStore } from '../quoxon/rowsStore.js';
import { c as colourOf } from '../quoxon/theme.js';

export const CONTRACT = {
  kind: 'quox.status-row',
  version: 1,
  fields: {
    text: 'required (unless value is given). One line, 160 characters at most.',
    label: 'optional. Shown first, 16 characters. The row\'s own label wins.',
    value: 'optional. A number (shown compactly: 1.2k) or a short string (24), drawn bold before the text.',
    tone: `optional. One of ${STATUS_ROW_TONES.join(', ')}. Colours the text and adds ✔ ⚠ ✖ ◆.`,
    trend: 'optional. up, down, flat, or a number (the change: 3 shows ▲3, -2 shows ▼2).',
    link: 'optional. An http(s) URL to look at for more; shown by quox rows test and /row test.'
  },
  example: { label: 'Approvals', value: 3, text: 'waiting for you', tone: 'warn', trend: 1, link: 'https://quox.example/approvals' },
  rules: [
    'Plain text output counts as {"text": "<the text>"}.',
    'Terminal escapes and control characters are removed before anything is drawn.',
    'A row definition never carries a secret: use a quox or plugin row (your session is used) or a local command that reads its own secret.',
    'Command rows run on the machine that holds them only. They are never synced, shared or imported without a person saying yes to the exact command.'
  ]
};

/** A theme role -> a chalk painter in the window's own colours (hex, ansi256, or plain under NO_COLOR). No grey. */
export function tint(name) {
  const v = colourOf(name);
  if (!v) return chalk.reset;
  const m = /^ansi256\((\d+)\)$/.exec(v);
  if (m) return chalk.ansi256(Number(m[1]));
  return /^#[0-9a-f]{6}$/i.test(v) ? chalk.hex(v) : chalk.reset;
}
const paint = (role, bold, t) => { const f = tint(themeRole(role)); return bold ? f.bold(t) : f(t); };
export const drawRow = (state, width = process.stdout.columns || 100, labelW = 0) =>
  ' ' + clipParts(rowParts(state, { labelW }), Math.max(10, width - 2)).map(([t, role, bold]) => paint(role, bold, t)).join('');

const where = (r) => {
  const s = r.source;
  if (s.type === 'url') return s.url;
  if (s.type === 'quox') return `${s.path}${s.service === 'collector' ? ' (collector)' : ''}`;
  if (s.type === 'plugin') return `${s.plugin} ${s.path}`;
  return s.cmd;
};

/** Options -> a source (or null when none of --url/--quox/--plugin/--cmd was given). */
export function sourceFromOptions(o) {
  const given = ['url', 'quox', 'plugin', 'cmd'].filter((k) => o[k] !== undefined);
  if (given.length > 1) return { error: `Give one of --url, --quox, --plugin or --cmd (you gave ${given.map((g) => `--${g}`).join(' and ')}).` };
  if (!given.length) return { source: null };
  const k = given[0];
  if (k === 'url') return { source: { type: 'url', url: String(o.url) } };
  if (k === 'cmd') return { source: { type: 'cmd', cmd: String(o.cmd) } };
  if (k === 'quox') return { source: { type: 'quox', service: o.service || (String(o.quox).startsWith('/api/v1/') ? 'collector' : 'auth'), path: String(o.quox) } };
  return { source: { type: 'plugin', plugin: String(o.plugin), path: o.path ? String(o.path) : '' } };
}

/**
 * A plugin source with no --path -> the path its manifest's statusRows names. -> { source, label?, every? } | { error }.
 * manifest.statusRows: [{ id, label, path, every?, description? }] (quox-plugin-sdk docs/status-rows.md).
 */
export async function resolvePluginRow(client, orgId, source, rowId) {
  if (source.path) return { source };
  let manifest;
  try {
    const ep = resolveEndpoint('plugins.get', { orgId, pluginId: source.plugin });
    const d = await client.get(ep.path, { service: ep.service, retries: 0 });
    manifest = d?.plugin?.manifest ?? d?.manifest;
    if (typeof manifest === 'string') manifest = JSON.parse(manifest);
  } catch (e) { return { error: `Could not read the ${source.plugin} plugin (${e?.message || 'failed'}). Is it installed in this org?` }; }
  const rows = Array.isArray(manifest?.statusRows) ? manifest.statusRows : [];
  if (!rows.length) return { error: `The ${source.plugin} plugin ships no status rows (its manifest has no statusRows). Give --path to read one of its routes.` };
  const pick = rowId ? rows.find((r) => r?.id === rowId) : rows[0];
  if (!pick) return { error: `${source.plugin} has no status row "${rowId}". It has: ${rows.map((r) => r?.id).filter(Boolean).join(', ')}.` };
  return { source: { ...source, path: String(pick.path || '') }, label: typeof pick.label === 'string' ? pick.label : undefined, every: typeof pick.every === 'string' ? pick.every : undefined };
}

export function registerRowsCommands(program, ctx) {
  const { client, auth, config } = ctx;
  const store = createRowsStore({ client, config, orgId: () => { try { return auth.getOrgId(program.opts().org); } catch { return null; } } });
  const json = () => program.opts().output === 'json';
  const fail = (msg, code = 1) => { console.error(tint('error')(msg)); process.exitCode = code; };
  const say = (msg) => console.log(msg);

  async function loadAll() {
    const r = await store.rowPrefs();
    return { synced: r.rows, cmd: store.localCmdRows(), offline: r.source !== 'server' ? (r.error || 'server unreachable') : null };
  }
  /** Write the synced list; -> true when the server took it. */
  async function saveSynced(rows) {
    const r = await store.setRowPrefs(rows);
    if (!r.synced) fail(`Saved on this machine only: ${r.error || 'the server did not take it'}. Run the command again to retry.`);
    return r.synced;
  }
  const engine = () => createRowEngine({ fetchUrl: (u) => store.rowFetch(u), fetchQuox: (s) => store.rowFetchQuox(s), runCmd: runShell });

  /** Fetch once and print raw value, notes and the drawn row. -> the probe result. */
  async function showOnce(row) {
    const p = await engine().probe(row);
    const raw = String(p.raw || '');
    if (raw) {
      say(tint('label')('Raw value:'));
      const lines = raw.split('\n').filter((l) => l.trim()).slice(0, 6);
      for (const l of lines) say('  ' + cleanText(l, (process.stdout.columns || 100) - 4));
      if (raw.length > 600 || lines.length >= 6) say('  …');
    }
    if (!p.ok) {
      fail(`⚠ ${row.label || row.id}: ${p.error}`);
      const hints = raw ? fieldHints(dataFrom(raw)) : [];
      if (hints.length && !row.template) {
        say(tint('label')('It is JSON but not a status row. A template can read it; fields you can use:'));
        say('  ' + hints.map((h) => tint('command')(`{{${h}}}`)).join('  '));
        say(tint('label')(`  e.g. --template '{{${hints.find((h) => !h.startsWith('count(')) || hints[0]}}} …'`));
      }
      return p;
    }
    for (const w of p.warnings || []) say(tint('warn')(`Note: ${w}`));
    say(tint('label')(`Shape: ${row.template ? 'template' : 'status-row contract'}${p.seg?.link ? `  ·  link ${p.seg.link}` : ''}`));
    say(tint('label')('The row:'));
    say(drawRow({ row, status: 'ok', text: p.text, seg: p.seg, at: Date.now() }));
    return p;
  }

  /** Build a row from add/edit options on top of `base`. -> { row } | { error }. */
  async function buildRow(id, o, base = null) {
    const s = sourceFromOptions(o);
    if (s.error) return { error: s.error };
    let source = s.source || (base ? { ...base.source } : null);
    if (!source) return { error: 'Say where the row reads from: --url <url>, --quox <path>, --plugin <id>, or --cmd "<command>".' };
    let label = o.label ?? base?.label;
    let every = o.every ?? base?.source?.every; // a new source keeps the row's interval
    if (source.type === 'plugin' && !source.path) {
      auth.requireAuth();
      const r = await resolvePluginRow(client, resolveOrgId(auth, program), source, o.row);
      if (r.error) return { error: r.error };
      source = r.source; label = label ?? r.label; every = every ?? r.every;
    }
    if (every) source.every = every;
    const draft = { id, source };
    if (label) draft.label = label;
    const colour = o.colour ?? o.color ?? base?.colour;
    if (colour) draft.colour = colour;
    const template = o.contract ? '' : (o.template ?? base?.template ?? '');
    if (template) draft.template = template;
    const c = checkRow(draft);
    if (c.error) return { error: c.error };
    const secret = secretInRow(c.row);
    if (secret) return { error: secret };
    return { row: c.row };
  }

  async function put(row, { replace = null } = {}) {
    const { synced, cmd } = await loadAll();
    const all = [...synced, ...cmd];
    const prev = replace ? all.find((r) => r.id === replace) : all.find((r) => r.id.toLowerCase() === row.id.toLowerCase());
    if (!prev && all.length >= MAX_ROWS) return fail(`You have ${MAX_ROWS} rows already (the most the window has room for). quox rows remove <id> makes space.`);
    const syncedNext = synced.filter((r) => r !== prev);
    const cmdNext = cmd.filter((r) => r !== prev);
    if (syncable(row)) syncedNext.push(row); else cmdNext.push(row);
    if (prev && !syncable(prev) || !syncable(row)) if (!store.setLocalCmdRows(cmdNext)) return fail('Could not write the local rows file.');
    if (prev && syncable(prev) || syncable(row)) if (!(await saveSynced(syncedNext))) return undefined;
    if (json()) return say(JSON.stringify({ ok: true, row, where: syncable(row) ? 'synced' : 'this machine' }, null, 2));
    say(tint('ok')(`✔ Row ${row.id} ${prev ? 'saved' : 'added'}. ${syncable(row) ? 'It follows your account to your other machines.' : 'It runs on THIS machine only and is never synced.'}`));
    say(tint('label')(`  Open windows show it within a minute (/row reload for now). quox rows test ${row.id} draws it here.`));
    return undefined;
  }

  const rows = program.command('rows').description('Your live lines above the quox window\'s status bar: add, edit, remove, test, share, import (url, quox, plugin or local command rows)');

  const sourceOpts = (cmd) => cmd
    .option('--url <url>', 'read JSON or text from a URL (no credentials are sent to other hosts)')
    .option('--quox <path>', 'read a path on your own Quox with your session, e.g. /api/orgs/{org}/inbox/stats')
    .option('--service <name>', 'for --quox: auth (default) or collector')
    .option('--plugin <id>', 'read a status row a plugin ships (its manifest statusRows)')
    .option('--row <rowId>', 'for --plugin: which of its status rows (default: the first)')
    .option('--path <path>', 'for --plugin: a route of the plugin backend instead of a declared row')
    .option('--cmd <command>', 'run a local command (this machine only, never synced)')
    .option('--template <template>', 'fill {{path}} from the data; leave out to read the status-row contract')
    .option('--every <interval>', 'refresh interval: 30s, 5m, 1h (5 s to 1 day)')
    .option('--label <text>', 'a short name drawn first')
    .option('--colour <role>', `text colour: ${ROLES.join(', ')}`);

  rows.command('list').alias('ls')
    .description('List your rows: where each reads from, where it is stored, and (--now) what it shows now')
    .option('--now', 'fetch each row once and draw it')
    .action(async (o) => {
      auth.requireAuth();
      const { synced, cmd, offline } = await loadAll();
      const all = [...synced, ...cmd];
      if (offline) console.error(tint('warn')(`⚠ Server not reachable (${offline}); showing this machine's copy.`));
      const states = [];
      if (o.now) {
        const e = engine();
        for (const r of all) {
          const p = await e.probe(r);
          states.push(p.ok ? { row: r, status: 'ok', text: p.text, seg: p.seg, at: Date.now() } : { row: r, status: 'error', error: p.error, text: '', at: null });
        }
      }
      if (json()) return say(JSON.stringify({ rows: all.map((r, i) => ({ ...r, stored: syncable(r) ? 'synced' : 'this machine', shape: r.template ? 'template' : 'contract', ...(states[i] ? { now: states[i].status === 'ok' ? states[i].text : null, error: states[i].error || undefined } : {}) })), max: MAX_ROWS }, null, 2));
      if (!all.length) return say(`No rows yet. Try: quox rows add approvals --quox '/api/orgs/{org}/inbox/stats' --template '{{pending_approvals}} waiting' --label Approvals\n(or /row new in the quox window).`);
      say(tint('heading').bold(`Rows (${all.length} of ${MAX_ROWS})`));
      const lw = labelWidth(all.map((row) => ({ row })));
      for (const [i, r] of all.entries()) {
        say(`  ${tint('id').bold(r.id.padEnd(12))} ${tint('label')(r.source.type.padEnd(6))} ${tint('text')(where(r))}`);
        say(tint('label')(`  ${''.padEnd(12)} every ${r.source.every} · ${syncable(r) ? 'synced to your account' : 'this machine only'} · ${r.template ? `template ${r.template}` : 'status-row contract'}${r.label ? ` · label ${r.label}` : ''}`));
        if (states[i]) say('   ' + drawRow(states[i], (process.stdout.columns || 100) - 3, lw));
      }
      return undefined;
    });

  sourceOpts(rows.command('add <id>').description('Add a row. No --template = it reads the status-row contract (quox rows contract)')).option('--test', 'fetch it once and draw it after saving')
    .action(async (id, o) => {
      auth.requireAuth();
      const b = await buildRow(id, o);
      if (b.error) return fail(b.error);
      const { synced, cmd } = await loadAll();
      if ([...synced, ...cmd].some((r) => r.id.toLowerCase() === b.row.id.toLowerCase())) return fail(`A row called ${b.row.id} exists. quox rows edit ${b.row.id} changes it.`);
      await put(b.row);
      if (o.test && !process.exitCode) await showOnce(b.row);
      return undefined;
    });

  sourceOpts(rows.command('edit <id>').description('Change a row: any of the add options; --contract drops the template')).option('--contract', 'read the status-row contract instead of a template')
    .action(async (id, o) => {
      auth.requireAuth();
      const { synced, cmd } = await loadAll();
      const cur = [...synced, ...cmd].find((r) => r.id.toLowerCase() === String(id).toLowerCase());
      if (!cur) return fail(`No row "${id}". quox rows list shows them.`);
      const b = await buildRow(cur.id, o, cur);
      if (b.error) return fail(b.error);
      if (JSON.stringify(b.row) === JSON.stringify(cur)) return say(`Nothing changed on ${cur.id}.`);
      return put(b.row, { replace: cur.id });
    });

  rows.command('remove <id>').alias('rm').description('Remove a row')
    .action(async (id) => {
      auth.requireAuth();
      const { synced, cmd } = await loadAll();
      const cur = [...synced, ...cmd].find((r) => r.id.toLowerCase() === String(id).toLowerCase());
      if (!cur) return fail(`No row "${id}". quox rows list shows them.`);
      if (syncable(cur)) { if (!(await saveSynced(synced.filter((r) => r !== cur)))) return undefined; }
      else if (!store.setLocalCmdRows(cmd.filter((r) => r !== cur))) return fail('Could not write the local rows file.');
      return json() ? say(JSON.stringify({ ok: true, removed: cur.id })) : say(tint('ok')(`✔ Removed row ${cur.id}.`));
    });

  sourceOpts(rows.command('test [id]').description('Fetch a row once and draw it here. With --url/--quox/--plugin/--cmd instead of an id, try one before adding it (nothing is saved)'))
    .action(async (id, o) => {
      auth.requireAuth();
      let row;
      if (id) {
        const { synced, cmd } = await loadAll();
        row = [...synced, ...cmd].find((r) => r.id.toLowerCase() === String(id).toLowerCase());
        if (!row) return fail(`No row "${id}". quox rows list shows them.`);
      } else {
        const b = await buildRow('test', o);
        if (b.error) return fail(b.error);
        row = b.row;
      }
      const p = await showOnce(row);
      if (json()) say(JSON.stringify({ ok: p.ok, text: p.text ?? null, seg: p.seg ?? null, warnings: p.warnings ?? [], error: p.error ?? null }, null, 2));
      return undefined;
    });

  rows.command('share [ids...]').description('Print a bundle of your rows for someone else to import. Command rows never leave this machine')
    .action(async (ids) => {
      auth.requireAuth();
      const { synced, cmd } = await loadAll();
      const all = [...synced, ...cmd];
      const want = ids?.length ? ids.map((x) => String(x).toLowerCase()) : null;
      const missing = want ? want.filter((x) => !all.some((r) => r.id.toLowerCase() === x)) : [];
      if (missing.length) return fail(`No row ${missing.join(', ')}. quox rows list shows them.`);
      const picked = want ? all.filter((r) => want.includes(r.id.toLowerCase())) : all;
      const { bundle, skipped, refused } = shareBundle(picked);
      for (const s of skipped) console.error(tint('warn')(`Not shared: ${s} is a command row (it runs a shell on this machine, so it never leaves it).`));
      for (const r of refused) console.error(tint('warn')(`Not shared: ${r.id}: ${r.why}`));
      if (!bundle.rows.length) return fail('Nothing to share.');
      return say(JSON.stringify(bundle, null, 2));
    });

  rows.command('import <file>').description('Add rows from a share bundle (a file, or - for stdin). Command rows are never added without --trust-commands and a y for each exact command')
    .option('--trust-commands', 'offer each command row for a yes/no, one by one (needs a person at the terminal)')
    .option('--replace', 'replace rows that have the same id')
    .action(async (file, o) => {
      auth.requireAuth();
      let text;
      try { text = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8'); } catch (e) { return fail(`Could not read ${file}: ${e.message}`); }
      const b = readBundle(text);
      for (const e of b.errors) console.error(tint('warn')(`Skipped ${e}`));
      const take = [...b.rows];
      if (b.commands.length) {
        if (!o.trustCommands) {
          for (const r of b.commands) console.error(tint('warn')(`Not added: ${r.id} would run \`${cleanText(r.source.cmd, 200)}\` on this machine. Command rows from a bundle need --trust-commands and your yes.`));
        } else if (!process.stdin.isTTY || file === '-') {
          return fail('A command row from a bundle needs a person at the terminal to say yes to it. Nothing was imported.');
        } else {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          try {
            for (const r of b.commands) {
              say(tint('warn').bold(`⚠ ${r.id} runs this on THIS machine every ${r.source.every}:`));
              say('    ' + tint('command')(cleanText(r.source.cmd, 500)));
              const a = (await rl.question('  Add it? y/N ')).trim();
              if (/^y(es)?$/i.test(a)) take.push(r); else say('  Skipped.');
            }
          } finally { rl.close(); }
        }
      }
      if (!take.length) return fail('Nothing to import.');
      const { synced, cmd } = await loadAll();
      const has = (id) => [...synced, ...cmd].find((r) => r.id.toLowerCase() === id.toLowerCase());
      const clash = take.filter((r) => has(r.id));
      if (clash.length && !o.replace) return fail(`You already have ${clash.map((r) => r.id).join(', ')}. --replace swaps them; nothing was imported.`);
      const syncedNext = synced.filter((r) => !take.some((t) => t.id.toLowerCase() === r.id.toLowerCase()));
      const cmdNext = cmd.filter((r) => !take.some((t) => t.id.toLowerCase() === r.id.toLowerCase()));
      for (const r of take) (syncable(r) ? syncedNext : cmdNext).push(r);
      if (syncedNext.length + cmdNext.length > MAX_ROWS) return fail(`That would make ${syncedNext.length + cmdNext.length} rows; the window has room for ${MAX_ROWS}. Remove some first. Nothing was imported.`);
      if (take.some((r) => !syncable(r)) || cmdNext.length !== cmd.length) if (!store.setLocalCmdRows(cmdNext)) return fail('Could not write the local rows file.');
      if (!(await saveSynced(syncedNext))) return undefined;
      return say(tint('ok')(`✔ Imported ${take.map((r) => r.id).join(', ')}.`));
    });

  rows.command('contract').description('The JSON a row endpoint returns (the status-row contract), with an example')
    .action(() => {
      if (json()) return say(JSON.stringify(CONTRACT, null, 2));
      say(tint('heading').bold('Status-row contract v1'));
      for (const [k, v] of Object.entries(CONTRACT.fields)) say(`  ${tint('id').bold(k.padEnd(6))} ${v}`);
      say(tint('label')('Example:'));
      say('  ' + JSON.stringify(CONTRACT.example));
      say(tint('label')('Draws as:'));
      const ex = { row: { id: 'approvals', source: {} }, status: 'ok', at: Date.now(), seg: { label: 'Approvals', value: '3', text: 'waiting for you', tone: 'warn', trend: '▲1' }, text: '3 waiting for you ▲1' };
      say(' ' + drawRow(ex));
      for (const r of CONTRACT.rules) say(tint('label')(`  · ${r}`));
      return undefined;
    });
}
