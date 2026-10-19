/**
 * `quox presence [who]` / `quox presence set present|away|sleeping`: PRESENCE (owner 2026-10-16).
 * A human says they are not at their terminal (/afk, /sleep in quox do the same). Sessions and agents
 * read it so they stop waiting on approvals, which still queue normally: nothing is ever auto-approved.
 * Collector routes GET/PUT /api/v1/presence; the org is the caller's, only a human login sets its own.
 */
import { resolveEndpoint } from '../api/endpoints.js';
import { resolveOrgId } from './helpers.js';

const STATES = ['present', 'away', 'sleeping'];

function stamp(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso || '') : `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

/** One plain line for a presence record. */
export function presenceText(p) {
  if (!p || !p.away) return `${p?.who || 'they'}: present`;
  const note = p.note ? `, "${p.note}"` : '';
  return `${p.who}: ${p.auto ? 'away (idle)' : p.state} since ${stamp(p.since)}${note} (approvals will queue)`;
}

/** The fields an approval request reports, from GET /api/v1/presence. */
export function approvalPresenceFields(list) {
  const away = (list && Array.isArray(list.presence) ? list.presence : []).filter((p) => p && p.away);
  if (!away.length) return { owner_away: false };
  const p = away.find((x) => x.who === 'owner') || away[0];
  return { owner_away: true, owner_away_since: p.since, owner_presence: p.state, owner_away_notice: list.notice || presenceText(p) };
}

/** Read the org's presence; null on any failure (a presence read never fails the caller). */
export async function readPresence(client, orgId) {
  try {
    const ep = resolveEndpoint('presence.list');
    return await client.get(ep.path, { service: ep.service, query: orgId ? { org_id: orgId } : undefined, retries: 0, timeout: 5000 });
  } catch { return null; }
}

export function registerPresenceCommands(program, { client, auth }) {
  const pr = program
    .command('presence')
    .description('Is a person at their terminal? With no name: everyone with presence on record. When someone is away, approvals queue; work on something else')
    .argument('[who]', 'user id, email, email name, "owner" or "me"')
    .action(async (who) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const json = program.opts().output === 'json';
      if (who) {
        const ep = resolveEndpoint('presence.get', { who });
        const d = await client.get(ep.path, { service: ep.service, query: { org_id: orgId } });
        if (json) { console.log(JSON.stringify(d, null, 2)); return; }
        console.log(presenceText(d.presence));
        return;
      }
      const ep = resolveEndpoint('presence.list');
      const d = await client.get(ep.path, { service: ep.service, query: { org_id: orgId } });
      if (json) { console.log(JSON.stringify(d, null, 2)); return; }
      const list = Array.isArray(d.presence) ? d.presence : [];
      if (!list.some((p) => p.away)) console.log('Everyone is present: nobody has marked themselves away.');
      for (const p of list) console.log(presenceText(p));
    });

  pr
    .command('set')
    .description('Say where you are: present, away or sleeping (a human login only). Same as /afk, /sleep, /back in quox')
    .argument('<state>', 'present | away | sleeping')
    .option('--note <text>', 'a short note sessions will see ("school run")')
    .option('--slots <list>', 'your own window slots, comma separated (hitl and triage-q always count)')
    .option('--auto-away <minutes>', 'read as away after this many idle minutes; "off" to disable (default off)')
    .action(async (state, options) => {
      if (!STATES.includes(state)) throw new Error('state must be present, away or sleeping');
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = { state };
      if (options.note !== undefined) body.note = options.note;
      if (options.slots) body.slots = String(options.slots).split(',').map((s) => s.trim()).filter(Boolean);
      if (options.autoAway !== undefined) {
        const off = /^(off|0|no)$/i.test(String(options.autoAway));
        const n = Number(options.autoAway);
        if (!off && (!Number.isInteger(n) || n < 1 || n > 1440)) throw new Error('--auto-away is minutes (1 to 1440) or off');
        body.auto_away_minutes = off ? 0 : n;
      }
      const ep = resolveEndpoint('presence.set');
      const d = await client.put(ep.path, { service: ep.service, body, query: { org_id: orgId } });
      if (program.opts().output === 'json') { console.log(JSON.stringify(d, null, 2)); return; }
      console.log(presenceText(d.presence));
    });
}
