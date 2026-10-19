/**
 * ROWS (owner 2026-10-17): /row new and /row edit <id> in the quox window. The same shape as the hat walk
 * (hatWalk.js): every question is a y/N/c card (askText) or a one-line text capture. Esc, or any slash command,
 * ends the walk and nothing is saved. Before the last card the row is fetched ONCE and the card shows what it
 * will say, so a row is never saved blind.
 *
 * Command rows get their own card naming the exact command, because a command runs a shell on this machine every
 * refresh. This file has no I/O beyond the functions it is given (probe, save, existing).
 */
import { askText } from '../ask.js';
import { checkRow, secretInRow, validId, parseEvery, rowLabel } from '../rows.js';

export const KINDS = [
  { key: 'url', name: 'a web address (URL) that returns JSON or text', ask: 'Which URL? It is fetched with no credentials.' },
  { key: 'quox', name: 'a path on your own Quox, read with your session', ask: 'Which path? It starts with /api/; {org} is filled in for you. Example: /api/orgs/{org}/inbox/stats' },
  { key: 'plugin', name: 'a status row a plugin ships', ask: 'Which plugin and row path? Example: qpe row' },
  { key: 'cmd', name: 'a command on THIS machine (never synced or shared)', ask: 'Which command? It runs through your shell, 5 s at most.' }
];

const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);

/** A kind and the typed target -> a source, or { error }. */
export function sourceFrom(kind, line, every = '60s') {
  const t = String(line ?? '').trim();
  if (!t) return { error: 'That is empty.' };
  if (kind === 'url') return { source: { type: 'url', url: t, every } };
  if (kind === 'cmd') return { source: { type: 'cmd', cmd: t, every } };
  if (kind === 'quox') return { source: { type: 'quox', service: t.startsWith('/api/v1/') ? 'collector' : 'auth', path: t, every } };
  const [plugin, ...rest] = t.split(/\s+/);
  if (!rest.length) return { error: 'Give the plugin id and the row path, e.g. qpe row.' };
  return { source: { type: 'plugin', plugin, path: rest.join(''), every } };
}

/** "1", "url", "a URL" -> a KINDS key, or null. */
export function pickKind(line) {
  const t = String(line ?? '').trim().toLowerCase();
  if (/^[1-4]$/.test(t)) return KINDS[Number(t) - 1].key;
  const hit = KINDS.find((k) => k.key === t || (t.length >= 3 && k.name.toLowerCase().includes(t)));
  return hit ? hit.key : (t === 'command' || t === 'shell' ? 'cmd' : null);
}

export function createRowWalk({ say, bump = () => {}, probe, save, existing }) {
  let W = null;

  const ask = (question, reason = '') => { const st = { at: Date.now() }; W.card = st; say(askText(question, { reason }), 'ask'); return st; };
  const yn = (question, on, reason) => { W.wait = { kind: 'yn', on }; ask(question, reason); bump(); };
  // path: the answer may itself start with / (a quox path like /api/...), so only a known slash command ends the walk
  const text = (prompt, on, { empty = false, path = false } = {}) => { W.wait = { kind: 'text', on, empty, path }; W.card = null; say(prompt); bump(); };
  const end = () => { W = null; bump(); };

  /** Validate, preview once, then the final card. */
  async function preview(draft, verb) {
    const c = checkRow(draft);
    if (c.error) { say(c.error, 'warn'); return W?.retry?.(); }
    const secret = secretInRow(c.row);
    if (secret) { say(secret, 'warn'); return W?.retry?.(); }
    const row = c.row;
    say(`Fetching ${rowLabel(row)} once to show you what it will say…`);
    const p = await probe(row);
    if (!W) return undefined; // cancelled while fetching
    if (p.ok) {
      say(`It will show: ${p.text}`, 'ok');
      for (const w of p.warnings || []) say(`Note: ${w}`, 'warn');
    } else say(`It could not be read just now (${p.error}). You can still save it; the row shows the problem until it works.`, 'warn');
    yn(`${verb} the ${rowLabel(row)} row?`, async (yes) => {
      if (!yes) { say('Nothing saved.'); return end(); }
      const r = await save(row, { replace: W.replace || null });
      say(r.text, r.ok ? 'ok' : 'warn');
      end();
    }, row.source.type === 'cmd' ? 'Runs on this machine only, never synced' : 'Follows your account to your other machines');
    return undefined;
  }

  // Shared tail: template, interval, then preview.
  function tail(draft, verb) {
    const askTemplate = () => text(draft.template
      ? `Template? Enter keeps ${draft.template}; "-" uses the status-row contract ({"text": ...}).`
      : 'Template? Enter reads the status-row contract ({"text": ..., "value": ..., "tone": ...}) or plain text. Or type one, e.g. {{pending_approvals}} waiting', (line) => {
      const t = line.trim();
      if (t === '-') delete draft.template; else if (t) draft.template = t;
      askEvery();
    }, { empty: true });
    const askEvery = () => yn(`Refresh every ${draft.source.every}?`, (yes) => {
      if (yes) return preview(draft, verb);
      const again = () => text('How often? 30s, 5m or 1h (5 s to 1 day).', (line) => {
        if (parseEvery(line) === null) { say(`"${line.trim()}" is not an interval.`, 'warn'); return again(); }
        draft.source.every = line.trim(); preview(draft, verb);
      });
      again();
    });
    W.retry = askTemplate;
    askTemplate();
  }

  function askSource(draft, verb) {
    KINDS.forEach((k, i) => say(`  ${i + 1}. ${k.name}`));
    const pick = () => text('Where does it read from? A number.', (line) => {
      const kind = pickKind(line);
      if (!kind) { say('Pick 1, 2, 3 or 4.', 'warn'); return pick(); }
      const target = () => text(KINDS.find((k) => k.key === kind).ask, (l2) => {
        const s = sourceFrom(kind, l2, draft.source?.every || '60s');
        if (s.error) { say(s.error, 'warn'); return target(); }
        draft.source = s.source;
        const c = checkRow({ ...draft, template: draft.template });
        if (c.error && !/template|Template/.test(c.error)) { say(c.error, 'warn'); return target(); }
        const secret = secretInRow(draft);
        if (secret) { say(secret, 'warn'); return target(); }
        if (kind === 'cmd') return yn(`Run \`${s.source.cmd}\` on this machine every ${s.source.every}?`, (yes) => {
          if (!yes) { say('Nothing saved.'); return end(); }
          tail(draft, verb);
        }, 'A command row runs a shell here and is never synced or shared');
        tail(draft, verb);
      }, { path: kind === 'quox' });
      target();
    });
    pick();
  }

  function startNew() {
    W = { mode: 'new' };
    const draft = { source: { every: '60s' } };
    const askName = () => text('What should the row be called? A short label, e.g. Approvals.', (line) => {
      const label = line.trim().slice(0, 24);
      const id = slug(label);
      if (!validId(id)) { say('Use letters or digits in the name.', 'warn'); return askName(); }
      if (existing().some((r) => r.id.toLowerCase() === id)) { say(`A row called ${id} exists. /row edit ${id} changes it, or pick another name.`, 'warn'); return askName(); }
      draft.id = id; draft.label = label;
      askSource(draft, 'Add');
    });
    askName();
  }

  function startEdit(id) {
    const cur = existing().find((r) => r.id.toLowerCase() === String(id).toLowerCase());
    if (!cur) { say(`No row "${id}". /row list shows them.`, 'warn'); return; }
    W = { mode: 'edit', replace: cur };
    const draft = JSON.parse(JSON.stringify(cur));
    yn(`Change where ${rowLabel(cur)} reads from?`, (yes) => {
      if (yes) return askSource(draft, 'Save');
      yn('Rename it?', (y2) => {
        if (!y2) return tail(draft, 'Save');
        const again = () => text('What is the new label?', (line) => { const l = line.trim().slice(0, 24); if (!l) { say('A label cannot be empty.', 'warn'); return again(); } draft.label = l; tail(draft, 'Save'); });
        again();
      });
    });
  }

  return {
    active: () => Boolean(W),
    card: () => (W?.wait?.kind === 'yn' ? W.card : null),
    start(kind, arg = '') {
      if (W) { say('A row walk is already open. Esc cancels it.', 'warn'); return; }
      if (kind === 'new') return startNew();
      return startEdit(arg);
    },
    /** One typed line. true = consumed. A slash command ends the walk and is left to run. */
    answer(line) {
      if (!W?.wait) return false;
      const t = String(line ?? '').trim();
      const isPath = W.wait.kind === 'text' && W.wait.path && t.startsWith('/api/');
      if (t.startsWith('/') && !isPath) { W = null; say('Row walk ended. Nothing was saved.'); bump(); return false; }
      const w = W.wait;
      if (w.kind === 'yn') {
        const yes = /^y(es)?$/i.test(t);
        if (!yes && t && !/^no?$/i.test(t)) return false; // c or free text: the card's normal chat behaviour
        W.wait = null; Promise.resolve(w.on(yes)).catch((e) => { say(`Row walk failed: ${e?.message || 'error'}.`, 'warn'); end(); });
        return true;
      }
      if (!t && !w.empty) return true;
      W.wait = null; Promise.resolve(w.on(t)).catch((e) => { say(`Row walk failed: ${e?.message || 'error'}.`, 'warn'); end(); });
      return true;
    },
    cancel() { if (!W) return false; W = null; say('Row walk cancelled. Nothing was saved.'); bump(); return true; }
  };
}
