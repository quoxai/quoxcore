/**
 * CUSTOM-HATS (owner 2026-10-17): /hat new | edit <hat> | delete <hat> in the quox window. One small step machine:
 * every question is either a y/N/c card (askText, the same shape as every other ask) or a one-line text capture
 * (a name, a pick by number or name, a list of agents). Esc, or any other slash command, ends the walk and
 * nothing is sent. Nothing reaches the server until the final summary card is answered y.
 * The definition maths is shared with `quox hat create|edit` (core/customHats.js); this file has no I/O of its own
 * beyond the api it is given.
 */
import { buildCustomDefinition, applyHatEdits } from '../../core/customHats.js';
import { matchHat, hatChoices } from '../hatSwitch.js';
import { askText } from '../ask.js';

export const slugify = (name) => String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const isCustom = (hat) => hat?.template_key == null;
const nameOf = (hat) => hat?.name || hat?.key || 'hat';
const joinNice = (xs) => xs.join(', ');

/** "1, 3 sec" -> picks resolved against rows [{ id }] -> { ids, unknown } (numbers are 1-based positions). */
export function pickAgents(line, rows) {
  const ids = []; const unknown = [];
  for (const raw of String(line ?? '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean)) {
    let id = null;
    if (/^\d+$/.test(raw)) id = rows[Number(raw) - 1]?.id ?? null;
    else id = rows.find(r => r.id.toLowerCase() === raw.toLowerCase())?.id ?? null;
    if (!id) unknown.push(raw); else if (!ids.includes(id)) ids.push(id);
  }
  return { ids, unknown };
}

export function createHatWalk({ api, say, bump = () => {} }) {
  let W = null; // the walk in progress, or null

  const ask = (question, reason = '') => { const st = { at: Date.now() }; W.card = st; W.wait = { ...W.wait, kind: 'yn' }; say(askText(question, { reason }), 'ask'); return st; };
  const yn = (question, on, reason) => { W.wait = { kind: 'yn', on }; ask(question, reason); bump(); };
  const text = (prompt, on) => { W.wait = { kind: 'text', on }; W.card = null; say(prompt); bump(); };
  const end = () => { W = null; bump(); };
  const fail = (what, e) => { say(`${what}: ${e?.message || 'the server refused'}.`, 'warn'); end(); };

  async function loadAgents() {
    if (W.agents) return W.agents;
    try {
      const rows = await api.agents();
      W.agents = (Array.isArray(rows) ? rows : []).map(a => ({ id: String(a.agent_id ?? a.id ?? ''), name: a.name || a.agent_id || a.id })).filter(a => a.id);
    } catch { W.agents = null; }
    return W.agents;
  }
  const agentLabel = (id) => { const a = W.agents?.find(x => x.id === id); return a && a.name && a.name !== id ? `${id} (${a.name})` : id; };

  // Shared tail: keep cards for each current specialist, then "Add agents?". done(kept, added).
  async function agentSteps(current, done) {
    await loadAgents();
    const kept = []; const queue = [...current];
    const nextKeep = () => {
      if (!queue.length) return askAdd();
      const id = queue.shift();
      yn(`Keep ${agentLabel(id)}?`, (yes) => { if (yes) kept.push(id); nextKeep(); }, 'This hat lists it as a specialist');
    };
    const askAdd = () => yn('Add agents?', async (yes) => {
      if (!yes) return done(kept, []);
      if (!W.agents?.length) { say('Could not list the org agents, so none were added.', 'warn'); return done(kept, []); }
      const rows = W.agents.filter(a => !kept.includes(a.id));
      if (!rows.length) { say('Every agent in this org is already in the hat.'); return done(kept, []); }
      rows.forEach((a, i) => say(`  ${i + 1}. ${a.id}${a.name && a.name !== a.id ? `  ${a.name}` : ''}`));
      const pick = () => text('Which agents? Numbers and/or ids, separated by commas or spaces.', (line) => {
        const { ids, unknown } = pickAgents(line, rows);
        if (unknown.length) { say(`Not in the list above: ${unknown.join(', ')}.`, 'warn'); return pick(); }
        if (!ids.length) { say('No agent picked.', 'warn'); return pick(); }
        done(kept, ids);
      });
      pick();
    });
    nextKeep();
  }

  async function startNew() {
    let hats;
    try { hats = await api.hats(); } catch (e) { return fail("Couldn't list hats", e); }
    W = { mode: 'new', hats };
    const askName = () => text('What should the new hat be called?', (line) => {
      const name = line.trim(); const key = slugify(name);
      if (key.length < 2 || key.length > 41) { say('A hat name needs 2 to 41 letters or digits. Try another.', 'warn'); return askName(); }
      if (hats.some(h => h.key === key)) { say(`A hat with the key "${key}" already exists. Try another name.`, 'warn'); return askName(); }
      W.name = name; W.key = key; askBase();
    });
    const askBase = () => yn('Start from an empty hat?', (yes) => {
      if (yes) { W.base = null; return agents(); }
      hats.forEach((h, i) => say(`  ${i + 1}. ${nameOf(h)}  ${h.key}`));
      const pick = () => text('Which hat should it start from? A number or a name.', (line) => {
        const t = line.trim();
        const m = /^\d+$/.test(t) ? { hat: hats[Number(t) - 1] } : matchHat(t, hats);
        if (m.ambiguous) { say(`"${t}" matches more than one hat: ${hatChoices(m.ambiguous)}. Be more specific.`, 'warn'); return pick(); }
        if (!m.hat) { say(`No hat matches "${t}".`, 'warn'); return pick(); }
        W.base = m.hat; agents();
      });
      pick();
    });
    const agents = () => agentSteps(W.base?.definition?.agents?.specialists || [], (kept, added) => {
      const list = [...kept, ...added];
      let built;
      try { built = buildCustomDefinition({ base: W.base?.definition || null, name: W.name, agents: list }); } catch (e) { return fail('Could not build the hat', e); }
      yn(`Create the ${W.name} hat with ${list.length ? joinNice(list) : 'no agents'}? It offers only its own tools and agents.`, async (yes) => {
        if (!yes) { say('Nothing created.', 'dim'); return end(); }
        const { key, name } = W;
        try {
          const r = await api.createHat({ key, name, definition: built.definition, visibility: 'org' });
          say(`Hat ${name} created (rev ${r?.hat?.current_revision ?? 1}). It is in your hat list now, ready to wear.`, 'ok');
          for (const w of Array.isArray(r?.warnings) ? r.warnings : []) say(`Note: ${typeof w === 'string' ? w : w?.message || JSON.stringify(w)}`, 'warn');
        } catch (e) { say(`Hat not created: ${e?.message || 'the server refused'}.`, 'warn'); }
        end();
      });
    });
    askName();
  }

  async function findCustom(arg, verb) {
    let hats;
    try { hats = await api.hats(); } catch (e) { say(`Couldn't list hats: ${e?.message || 'failed'}.`, 'warn'); return null; }
    const mine = hats.filter(isCustom);
    if (!arg) { say(`Which hat? ${mine.length ? `Your own hats: ${hatChoices(mine)}.` : 'You have no hats of your own yet. /hat new makes one.'}`, 'warn'); return null; }
    const m = matchHat(arg, hats);
    if (m.ambiguous) { say(`"${arg}" matches more than one hat: ${hatChoices(m.ambiguous)}. Be more specific.`, 'warn'); return null; }
    if (!m.hat) { say(`No hat matches "${arg}". Your own hats: ${hatChoices(mine) || 'none yet'}.`, 'warn'); return null; }
    if (!isCustom(m.hat)) {
      say(verb === 'edit'
        ? `${nameOf(m.hat)} is a built-in hat, so it is not edited here. It can be reset, or used as a starting point with /hat new.`
        : `${nameOf(m.hat)} is a built-in hat and cannot be deleted. It can be reset, or used as a starting point with /hat new.`, 'warn');
      return null;
    }
    return m.hat;
  }

  async function startEdit(arg) {
    const hat = await findCustom(arg, 'edit'); if (!hat) return;
    W = { mode: 'edit', hat };
    const def = hat.definition || {};
    agentSteps(def.agents?.specialists || [], (kept, added) => {
      const current = def.agents?.specialists || [];
      const removeAgents = current.filter(a => !kept.includes(a));
      const rename = () => yn('Rename it?', (yes) => {
        if (!yes) return summary(null);
        const ask2 = () => text('What is the new name?', (line) => { const n = line.trim(); if (!n) { say('A name cannot be empty.', 'warn'); return ask2(); } summary(n); });
        ask2();
      });
      const summary = (newName) => {
        let ed;
        try { ed = applyHatEdits(def, { addAgents: added, removeAgents }); } catch (e) { return fail('Could not apply the edit', e); }
        const changes = [...ed.changes];
        if (newName && newName !== hat.name) changes.push(`name ${newName}`); else newName = null;
        if (!changes.length) { say(`Nothing changed on the ${nameOf(hat)} hat. Nothing was sent.`); return end(); }
        yn(`Update the ${nameOf(hat)} hat: ${changes.join('; ')}?`, async (yes) => {
          if (!yes) { say('Nothing changed.', 'dim'); return end(); }
          try {
            const r = await api.updateHat(hat.id, { definition: ed.definition, ...(newName ? { name: newName } : {}), change_reason: 'Edited from the quox window' });
            say(`Hat ${newName || nameOf(hat)} updated (rev ${r?.hat?.current_revision ?? 'next'}).`, 'ok');
            for (const w of Array.isArray(r?.warnings) ? r.warnings : []) say(`Note: ${typeof w === 'string' ? w : w?.message || JSON.stringify(w)}`, 'warn');
          } catch (e) { say(`Hat not updated: ${e?.message || 'the server refused'}.`, 'warn'); }
          end();
        });
      };
      rename();
    });
  }

  async function startDelete(arg) {
    const hat = await findCustom(arg, 'delete'); if (!hat) return;
    W = { mode: 'delete', hat };
    yn(`Delete the ${nameOf(hat)} hat? Conversations wearing it go back to the default hat.`, async (yes) => {
      if (!yes) { say('Nothing deleted.', 'dim'); return end(); }
      try {
        const r = await api.deleteHat(hat.id);
        const d = r?.deleted || {};
        say(`Hat ${nameOf(hat)} deleted. Conversations moved off it: ${d.bindings_cleared ?? 0}. Personal choices cleared: ${d.user_prefs_cleared ?? 0}.`, 'ok');
      } catch (e) { say(`Hat not deleted: ${e?.message || 'the server refused'}.`, 'warn'); }
      end();
    }, 'It cannot be undone');
  }

  return {
    active: () => Boolean(W),
    /** the y/N/c card currently on screen (for the ask machinery), or null */
    card: () => (W?.wait?.kind === 'yn' ? W.card : null),
    start(kind, arg = '') {
      if (W) { say('A hat walk is already open. Esc cancels it.', 'warn'); return; }
      if (kind === 'new') return startNew();
      if (kind === 'edit') return startEdit(arg);
      return startDelete(arg);
    },
    /** One typed line. true = consumed. A slash command ends the walk and is left to run. */
    answer(line) {
      if (!W?.wait) return false;
      const t = String(line ?? '').trim();
      if (t.startsWith('/')) { W = null; say('Hat walk ended. Nothing was sent.', 'dim'); bump(); return false; }
      const w = W.wait;
      if (w.kind === 'yn') {
        const yes = /^y(es)?$/i.test(t);
        if (!yes && t && !/^no?$/i.test(t)) return false; // c or free text: the card's normal chat behaviour
        W.wait = null; Promise.resolve(w.on(yes)).catch((e) => fail('Hat walk failed', e));
        return true;
      }
      if (!t) return true;
      W.wait = null; Promise.resolve(w.on(t)).catch((e) => fail('Hat walk failed', e));
      return true;
    },
    cancel() { if (!W) return false; W = null; say('Hat walk cancelled. Nothing was sent.', 'dim'); bump(); return true; },
  };
}
