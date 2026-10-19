/**
 * QUOXON-FW17: /row, custom rows above the status line. Kept out of app.js.
 *
 * url rows save to the user's server-side preferences (api.setRowPrefs, namespace quoxonRows); cmd rows save to a
 * local file only (api.setLocalCmdRows) and are never sent anywhere. The engine (rows.js) does the polling.
 */
import { checkRow, parseRowCmd, splitRows, rowLabel, normRows, MAX_ROWS, rowDisplay, ROLES, secretInRow, syncable } from '../rows.js';
import { clip } from '../theme.js';
import { createRowWalk } from './rowWalk.js';

/** How a row reads its data, in words (for /row list). */
export const whereOf = (r) => {
  const s = r.source;
  if (s.type === 'url') return `url ${s.url}`;
  if (s.type === 'quox') return `quox ${s.path}${s.service === 'collector' ? ' (collector)' : ''}`;
  if (s.type === 'plugin') return `plugin ${s.plugin} ${s.path}`;
  return `cmd ${s.cmd}  (this machine only)`;
};

/** ROWS: rows changed elsewhere (`quox rows`, another window) reach an open window within this long. */
export const RELOAD_MS = 60 * 1000;

const cleanLine = (l) => String(l).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');

export function createRowCmd({ api, say, engine, bump, cols, setT = setTimeout, clearT = clearTimeout }) {
  let url = []; // synced (url, quox and plugin rows)
  let cmd = []; // this machine only
  let reloadTimer = null;
  const all = () => [...url, ...cmd];
  const apply = () => { engine.setRows(all()); bump(); };

  /** Start up: the cached/local rows at once, then the server copy. Never throws. */
  async function load() {
    try { url = api.localRowPrefs?.() || []; cmd = api.localCmdRows?.() || []; } catch { url = []; cmd = []; }
    engine.setEnabled(api.settings?.().rows !== 'off');
    apply();
    await refreshFromStores();
    schedule();
  }

  /** Re-read both stores; the engine keeps the state of rows that did not change. -> true when anything changed. */
  async function refreshFromStores() {
    const before = JSON.stringify(all());
    try { cmd = api.localCmdRows?.() || cmd; } catch { /* keep */ }
    try {
      const r = await api.rowPrefs?.();
      if (r?.source === 'server') url = normRows(r.rows);
    } catch { /* the local copy stands */ }
    const changed = JSON.stringify(all()) !== before;
    if (changed) apply();
    return changed;
  }

  function schedule() {
    clearT(reloadTimer);
    reloadTimer = setT(async () => { await refreshFromStores(); schedule(); }, RELOAD_MS);
    reloadTimer?.unref?.();
  }

  /** Save one row (new, or replacing `replace`). Shared by /row add and the walk. -> { ok, text }. */
  async function put(row, { replace = null } = {}) {
    const exists = replace || find(row.id);
    if (!exists && all().length >= MAX_ROWS) return { ok: false, text: `You have ${MAX_ROWS} rows already (the most there is room for). /row rm <id> makes space.` };
    if (exists) { url = url.filter((x) => x !== exists); cmd = cmd.filter((x) => x !== exists); }
    if (exists && !syncable(exists) && syncable(row)) api.setLocalCmdRows?.(cmd);
    if (syncable(row)) {
      url = [...url, row];
      apply();
      const r = api.setRowPrefs ? await api.setRowPrefs(url) : { synced: true };
      if (!r.synced) return { ok: false, text: `Saved on this machine only (${r.error || 'the server did not take it'}). Making the change again retries.` };
      return { ok: true, text: `Row ${row.id} ${exists ? 'saved' : 'added'}. It follows your account to other machines. /row test ${row.id} shows the raw value.` };
    }
    cmd = [...cmd, row];
    apply();
    if (exists && syncable(exists) && api.setRowPrefs) await api.setRowPrefs(url);
    const ok = api.setLocalCmdRows ? api.setLocalCmdRows(cmd) : true;
    return ok ? { ok: true, text: `Row ${row.id} ${exists ? 'saved' : 'added'}. It runs your command on THIS machine only and is never synced.` } : { ok: false, text: 'Could not save the row to the local file; it lasts until you quit.' };
  }

  const walk = createRowWalk({ say, bump, probe: (row) => engine.probe(row), save: put, existing: () => all() });

  async function saveUrl(tail = '') {
    if (!api.setRowPrefs) return;
    const r = await api.setRowPrefs(url);
    if (!r.synced) say(`Saved on this machine only (${r.error || 'the server did not take it'}). Making the change again retries.`, 'warn');
    else if (tail) say(tail);
  }

  const find = (id) => all().find((r) => r.id.toLowerCase() === String(id).toLowerCase());

  async function handle(arg) {
    const sub = parseRowCmd(arg);
    const w = Math.max(20, cols() - 4);
    switch (sub.kind) {
      case 'error': return say(sub.text, 'warn');
      case 'list': {
        const rows = all();
        if (!rows.length) return say('No custom rows yet. /row new walks you through one (or quox rows add from a shell).');
        say(`Custom rows (${rows.length} of ${MAX_ROWS})${engine.isEnabled() ? '' : ', hidden: /row on shows them'}:`);
        for (const r of rows) {
          const s = engine.state(r.id);
          say(clip(`  ${r.id}${r.label && r.label !== r.id ? ` (${r.label})` : ''}  every ${r.source.every}  ${whereOf(r)}${r.template ? '' : '  [status-row contract]'}`, w));
          if (s && engine.isEnabled()) say(clip(`      now: ${rowDisplay(s).text}`, w), s.status === 'error' ? 'warn' : undefined);
        }
        return undefined;
      }
      case 'on': case 'off': {
        engine.setEnabled(sub.kind === 'on');
        api.saveSetting?.('rows', sub.kind);
        bump();
        return say(sub.kind === 'on' ? 'Custom rows are on.' : 'Custom rows hidden and paused. /row on brings them back.');
      }
      case 'rm': {
        const r = find(sub.id);
        if (!r) return say(`No row "${sub.id}". /row list shows them.`, 'warn');
        if (syncable(r)) { url = url.filter((x) => x !== r); apply(); await saveUrl(); } else { cmd = cmd.filter((x) => x !== r); apply(); api.setLocalCmdRows?.(cmd); }
        return say(`Removed row ${r.id}.`, 'ok');
      }
      case 'test': {
        const r = find(sub.id);
        if (!r) return say(`No row "${sub.id}". /row list shows them.`, 'warn');
        say(`Testing ${r.id}…`);
        const p = await engine.probe(r);
        if (!p.ok && !p.raw) return say(clip(`⚠ ${rowLabel(r)}: ${p.error}`, w), 'warn');
        const lines = p.raw.split('\n').filter((l) => l.trim()).slice(0, 4);
        say('Raw value:');
        for (const l of lines) say(clip(`  ${cleanLine(l)}`, w));
        if (p.raw.length > 400 || lines.length >= 4) say('  …');
        if (!p.ok) return say(clip(`⚠ ${rowLabel(r)}: ${p.error}`, w), 'warn');
        for (const wn of p.warnings || []) say(clip(`Note: ${wn}`, w), 'warn');
        if (p.seg?.link) say(clip(`Link: ${p.seg.link}`, w));
        return say(clip(`Row shows: ${p.text}`, w), 'ok');
      }
      case 'add': {
        const v = checkRow(sub.row);
        if (v.error) return say(v.error, 'warn');
        const secret = secretInRow(v.row);
        if (secret) return say(secret, 'warn');
        const r = await put(v.row);
        return say(r.text, r.ok ? 'ok' : 'warn');
      }
      case 'new': return walk.start('new');
      case 'edit': return walk.start('edit', sub.id);
      case 'reload': {
        const changed = await refreshFromStores();
        return say(changed ? `Rows reloaded: ${all().map((r) => r.id).join(', ') || 'none'}.` : 'Rows reloaded; nothing changed.');
      }
      default: return undefined;
    }
  }

  return {
    handle, load, stopEngine: () => { clearT(reloadTimer); engine.stop(); }, view: () => engine.view(), all, colours: ROLES, counts: () => splitRows(all()),
    /** the /row new|edit walk: app.js routes typed lines, its y/N/c card and Esc here */
    walk
  };
}
