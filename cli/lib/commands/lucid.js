/**
 * `quox lucid` (alias `aware`): LUCID, the situational-awareness view.
 * Collector routes under /api/v1/lucid (org-scoped).
 *
 *   quox lucid | since-last   what needs you / changed since you last looked (advances the cursor)
 *   quox lucid since <w|seq>  same view from a window or seq, never advances
 *   quox lucid subjects|feeds|journal|ack
 *   quox lucid why <ref> [--evidence] | do <ref> <measure_id> | area <name>
 *   quox lucid teach <target> <field>=<value> | lessons | forget <id>
 *   quox lucid herald [set key=value... | test]   when LUCID speaks first, and what it has said
 *   quox lucid blind          sources live/silent/failing/never heard, and what doesn't add up
 */
import { formatOutput, printSuccess } from '../core/output.js';
import { line as glyphLine, printEvent } from '../core/quoxglyph.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { confirmDestructive } from '../core/confirm.js';
import { resolveOrgId } from './helpers.js';

const SURFACE = 'cli';

function age(ms) {
  if (ms == null) return '';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function ts(ms) {
  return ms == null ? '' : new Date(ms).toISOString();
}

export function registerLucidCommands(program, ctx) {
  const { client, auth } = ctx;

  const lu = program
    .command('lucid')
    .alias('aware')
    .description('LUCID: what needs you, what changed since you last looked, what is in motion, what I cannot see')
    .option('--json', 'print the full JSON response')
    .option('--agent', 'compact id-rich form for agents')
    .option('--spoken', 'sentences only, as read on the phone')
    .option('--no-advance', 'do not move the cursor when viewing')
    .option('--sitrep', 'one-shot formatted snapshot for the terminal or pasting into a chat (never moves the cursor)');

  const wantJson = (cmd) => {
    const o = cmd.optsWithGlobals ? cmd.optsWithGlobals() : cmd.opts();
    return Boolean(o.json) || program.opts().output === 'json';
  };
  const advanceOf = (cmd) => {
    const o = cmd.optsWithGlobals ? cmd.optsWithGlobals() : cmd.opts();
    return o.advance !== false;
  };

  // An error body is not data: report the status and stop.
  async function call(method, key, { query, body, params } = {}) {
    const ep = resolveEndpoint(key, params);
    const q = { org_id: resolveOrgId(auth, program), ...query };
    try {
      const data = method === 'POST'
        ? await client.post(ep.path, { service: ep.service, body, query: q })
        : method === 'DELETE'
          ? await client.delete(ep.path, { service: ep.service, query: q })
          : await client.get(ep.path, { service: ep.service, query: q });
      return data;
    } catch (err) {
      const status = err && (err.status || err.statusCode);
      if (status) {
        console.error(`LUCID request failed: HTTP ${status}${err.message ? ` ${err.message}` : ''}`);
        process.exitCode = 1;
        return null;
      }
      throw err;
    }
  }

  async function showSituation(cmd, since, advance) {
    auth.requireAuth();
    const data = await call('GET', 'lucid.situation', {
      query: { since, surface: SURFACE, advance: advance ? '1' : undefined },
    });
    if (data === null) return;
    if (wantJson(cmd)) { console.log(JSON.stringify(data, null, 2)); return; }
    const sit = data.situation || {};
    const needs = (sit.needs_you || []).length;
    const cov = sit.cannot_see && sit.cannot_see.coverage;
    const feeds = cov ? ` · feeds ${cov.live}/${cov.expected}` : '';
    // quoxglyph.js is a vendored lockstep copy (no LUCID icon yet), so swap the fallback Ⓠ for ◉ here.
    printEvent(glyphLine('lucid', 'situation', { result: `${needs} need you${feeds}` }).replace('Ⓠ', '◉'));
    const o = typeof cmd.optsWithGlobals === 'function' ? cmd.optsWithGlobals() : cmd.opts();
    console.log((o.agent ? data.text_agent : o.spoken ? data.spoken : data.text) ?? data.text ?? '');
  }

  async function showSitrep(o = {}) {
    auth.requireAuth();
    const data = await call('GET', 'lucid.situation', { query: { since: 'last', surface: o.agent ? 'agent' : 'deck' } });
    if (data === null) return;
    // Agents: --agent (compact, id-rich), --json (structured), --spoken (sentences). Never moves the cursor.
    if (o.json) { console.log(JSON.stringify(data, null, 2)); return; }
    if (o.agent) { console.log(data.text_agent ?? data.text ?? ''); return; }
    if (o.spoken) { console.log(data.spoken ?? data.text ?? ''); return; }
    const { renderSitrep } = await import('../lucid/sitrep.js');
    const tty = Boolean(process.stdout.isTTY);
    process.stdout.write(renderSitrep(data, {
      width: process.stdout.columns || 100,
      color: tty && !process.env.NO_COLOR && process.env.QUOX_COLOR !== '0',
    }));
  }

  lu.action(async (opts, cmd) => {
    if (opts.sitrep) return showSitrep();
    return showSituation(cmd, 'last', advanceOf(cmd));
  });

  const sitrepOpts = (c) => c
    .option('--agent', 'compact, id-rich form for agents')
    .option('--json', 'the full structured situation')
    .option('--spoken', 'sentences only, as read on the phone');

  sitrepOpts(lu
    .command('sitrep')
    .description('One-shot formatted snapshot (areas, what needs you, what changed, what I cannot see)'))
    .action(async (o) => showSitrep(o));

  // Top-level shortcut so any human or agent can ask for a sitrep: `quox sitrep [--agent|--json|--spoken]`.
  sitrepOpts(program
    .command('sitrep')
    .description('LUCID situation report: what needs you, every area, what changed, what LUCID cannot see'))
    .action(async (o) => showSitrep(o));

  lu
    .command('deck')
    .description('Live full-screen LUCID deck (refreshes every 10s; m marks seen)')
    .option('--no-intro', 'skip the startup animation')
    .action(async (o) => {
      auth.requireAuth();
      const orgQ = { org_id: resolveOrgId(auth, program) };
      const get = async (key, query) => {
        const ep = resolveEndpoint(key);
        return client.get(ep.path, { service: ep.service, query: { ...orgQ, ...query } });
      };
      const post = async (key, body, query) => {
        const ep = resolveEndpoint(key);
        return client.post(ep.path, { service: ep.service, body, query: { ...orgQ, ...query } });
      };
      const { launchDeck } = await import('../lucid/deck.js');
      await launchDeck({
        situation: () => get('lucid.situation', { since: 'last', surface: 'deck' }),
        measure: (ref, measure_id) => post('lucid.measure', { ref, measure_id }),
        teach: (body) => post('lucid.teach', body),
        ack: (seq) => post('lucid.ack', { seq: Number(seq) }, { surface: 'deck' }),
      }, { noIntro: o.intro === false });
    });

  lu
    .command('since-last')
    .description('Situation since you last looked (advances the cursor unless --no-advance)')
    .option('--json', 'print the full JSON response')
    .option('--no-advance', 'do not move the cursor')
    .action(async (_opts, cmd) => showSituation(cmd, 'last', advanceOf(cmd)));

  lu
    .command('since <window>')
    .description('Situation since a window (3h, 30m, 2d) or journal seq; never advances the cursor')
    .option('--json', 'print the full JSON response')
    .action(async (window, _opts, cmd) => showSituation(cmd, window, false));

  lu
    .command('subjects')
    .description('Open subjects the journal is tracking')
    .option('--ledger <ledger>', 'filter by ledger')
    .option('--json', 'print the full JSON response')
    .action(async (options, cmd) => {
      auth.requireAuth();
      const data = await call('GET', 'lucid.subjects', { query: { ledger: options.ledger } });
      if (data === null) return;
      if (wantJson(cmd)) { console.log(JSON.stringify(data, null, 2)); return; }
      const subjects = data.subjects || [];
      formatOutput(subjects.map((s) => ({
        LEDGER: s.ledger || '',
        SUBJECT: s.subject || '',
        STATUS: s.status || '',
        SUMMARY: s.summary || '',
      })), {
        format: program.opts().output,
        columns: ['LEDGER', 'SUBJECT', 'STATUS', 'SUMMARY'],
        emptyMessage: 'No open subjects.',
        raw: subjects,
      });
    });

  lu
    .command('feeds')
    .description('Which feeds are speaking, and which are expected but silent')
    .option('--json', 'print the full JSON response')
    .action(async (_options, cmd) => {
      auth.requireAuth();
      const data = await call('GET', 'lucid.feeds');
      if (data === null) return;
      if (wantJson(cmd)) { console.log(JSON.stringify(data, null, 2)); return; }
      const feeds = data.feeds || [];
      formatOutput(feeds.map((f) => ({
        FEED: f.feed,
        'LAST HEARD': f.last_heard ? `${age(f.last_heard)} ago` : '',
        'EXPECTED BY': f.expected_by ? ts(f.expected_by) : '',
        ERROR: f.last_error || '',
      })), {
        format: program.opts().output,
        columns: ['FEED', 'LAST HEARD', 'EXPECTED BY', 'ERROR'],
        emptyMessage: 'No feeds have been heard from.',
        raw: feeds,
      });
      const heard = new Set(feeds.map((f) => f.feed));
      const never = (data.expected || []).filter((n) => !heard.has(n));
      if (never.length) console.log(`Expected but never heard: ${never.join(', ')}`);
    });

  lu
    .command('blind')
    .description("What I can and cannot hear (live / silent / failing / never heard) and what doesn't add up")
    .option('--json', 'print the structured data')
    .action(async (_options, cmd) => {
      auth.requireAuth();
      const sitData = await call('GET', 'lucid.situation', { query: { since: 'last', surface: 'blind' } });
      if (sitData === null) return;
      const feedData = await call('GET', 'lucid.feeds');
      if (feedData === null) return;
      const payload = { situation: sitData.situation || {}, feeds: feedData.feeds || [], expected: feedData.expected || [] };
      if (wantJson(cmd)) { console.log(JSON.stringify(payload, null, 2)); return; }
      const { renderBlind } = await import('../lucid/blind.js');
      process.stdout.write(renderBlind(payload));
    });

  lu
    .command('ask')
    .description('Ask LUCID anything about your situation, in plain words (routed to the LUCID agent)')
    .argument('<question...>', 'your question, e.g. "what changed while I was out?"')
    .option('--conversation <id>', 'continue a conversation')
    .action(async (words, o) => {
      auth.requireAuth();
      const { consumeStream } = await import('./chat.js');
      try {
        await consumeStream(client, { message: words.join(' '), agent: 'lucid', sessionId: o.conversation }, { onAgentLabel: () => {} });
      } catch (err) {
        console.error(`LUCID request failed: ${err.message}`);
        process.exitCode = 1;
      }
    });

  lu
    .command('replay')
    .description('What LUCID knew at a past moment (rebuilt from the journal)')
    .requiredOption('--at <when>', 'ISO time, epoch ms, or HH:MM today (London)')
    .option('--json', 'print the structured data')
    .action(async (o, cmd) => {
      auth.requireAuth();
      const data = await call('GET', 'lucid.replay', { query: { at: o.at } });
      if (data === null) return;
      if (wantJson(cmd)) { console.log(JSON.stringify(data, null, 2)); return; }
      printEvent(glyphLine('lucid', `replay at ${o.at}`, { result: 'rebuilt from the journal' }).replace('Ⓠ', '◉'));
      console.log(data.text || '');
    });

  lu
    .command('told')
    .description('What LUCID told you (herald steps and briefings), with witness ids')
    .option('--since <window>', 'e.g. 6h, 2d', '24h')
    .option('--json', 'print the structured data')
    .action(async (o, cmd) => {
      auth.requireAuth();
      const data = await call('GET', 'lucid.told', { query: { since: o.since } });
      if (data === null) return;
      if (wantJson(cmd)) { console.log(JSON.stringify(data, null, 2)); return; }
      const told = data.told || [];
      if (!told.length) { console.log(`LUCID told you nothing in the last ${o.since}.`); return; }
      const fmt = (ts) => new Date(ts).toLocaleString('en-GB', { timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', minute: '2-digit' });
      for (const t of told) {
        const STEP = { l1_inbox: 'Approvals inbox', l2_slot: 'slot nudge', l3_call: 'phone call', resolved: 'withdrawn', l2_failed: 'nudge failed', l3_failed: 'call failed' };
        const what = t.type === 'briefing' ? `situation shown (${t.kind || 'view'})` : (t.summary || t.ref || '');
        const how = t.type === 'briefing' ? `briefing · ${t.surface || ''}` : (STEP[t.status] || t.status || '');
        console.log(`  ${fmt(t.ts)}  ${String(how).padEnd(16)} ${what}${t.ward_entry_id ? '  ✔ witnessed' : '  (not witnessed)'}`);
      }
      const c = data.counts || {};
      console.log(`\n  ${c.herald_steps || 0} herald steps · ${c.briefings || 0} briefings · ${c.unwitnessed || 0} not witnessed`);
    });

  lu
    .command('journal')
    .description('Raw journal entries')
    .option('--after <seq>', 'only entries after this seq')
    .option('--limit <n>', 'max entries')
    .option('--json', 'print the full JSON response')
    .action(async (options, cmd) => {
      auth.requireAuth();
      const data = await call('GET', 'lucid.journal', { query: { after: options.after, limit: options.limit } });
      if (data === null) return;
      if (wantJson(cmd)) { console.log(JSON.stringify(data, null, 2)); return; }
      const entries = data.entries || [];
      formatOutput(entries.map((e) => ({
        SEQ: e.seq,
        TIME: ts(e.ts),
        KIND: e.kind || '',
        SUBJECT: e.subject || '',
        SUMMARY: e.summary || '',
      })), {
        format: program.opts().output,
        columns: ['SEQ', 'TIME', 'KIND', 'SUBJECT', 'SUMMARY'],
        emptyMessage: 'No journal entries.',
        raw: entries,
      });
    });

  lu
    .command('ack <seq>')
    .description('Advance your cursor to a journal seq')
    .action(async (seq, _opts, cmd) => {
      auth.requireAuth();
      const data = await call('POST', 'lucid.ack', { body: { seq: Number(seq) }, query: { surface: SURFACE } });
      if (data === null) return;
      if (wantJson(cmd)) { console.log(JSON.stringify(data, null, 2)); return; }
      printSuccess(`Cursor at ${data.cursor ?? seq}`);
    });

  const measuresOf = (item) => (item && item.L2 && item.L2.measures) || [];

  lu
    .command('why <ref>')
    .description('Why is this on the list: who, what, why, when, what it affects, and what you can do')
    .option('--evidence', 'also show the L3 evidence block')
    .option('--json', 'print the full JSON response')
    .action(async (ref, options, cmd) => {
      auth.requireAuth();
      const data = await call('GET', 'lucid.item', { query: { ref } });
      if (data === null) return;
      if (wantJson(cmd)) { console.log(JSON.stringify(data, null, 2)); return; }
      const item = data.item || {};
      const a = item.L1 || {};
      console.log(item.L0 || ref);
      console.log('');
      console.log(`Who:   ${a.who ?? ''}`);
      console.log(`What:  ${a.what ?? ''}`);
      console.log(`Why:   ${a.why ?? ''}`);
      const w = a.when || {};
      const whenParts = [];
      if (w.clock) whenParts.push(w.clock);
      if (w.since) whenParts.push(`since ${ts(w.since)}`);
      if (w.waited_ms != null) whenParts.push(`waiting ${age(Date.now() - w.waited_ms)}`);
      if (w.deadline) whenParts.push(`deadline ${ts(w.deadline)}`);
      console.log(`When:  ${whenParts.join(' · ')}`);
      const aff = a.affected || [];
      console.log(`Affected: ${aff.length ? aff.map((x) => `${x.label} (${x.how}${x.inferred ? ', inferred' : ''})`).join('; ') : 'nothing known'}`);
      const ms = measuresOf(item);
      if (ms.length) {
        console.log('');
        console.log('What you can do:');
        ms.forEach((m, i) => {
          console.log(`  ${i + 1}. ${m.label} [${m.id}]${m.say ? ` - ${m.say}` : ''}${m.command ? `\n     ${m.command}` : ''}`);
        });
      }
      if (options.evidence) {
        const e = item.L3 || {};
        console.log('');
        console.log('Evidence:');
        console.log(`  Status: ${e.status ?? ''}`);
        console.log(`  Feed: ${e.feed ?? ''}`);
        const c = e.confidence || {};
        console.log(`  Confidence: last heard ${c.last_heard ? `${age(c.last_heard)} ago` : 'never'}${c.stale ? ' (STALE)' : ''}`);
        for (const t of e.transitions || []) {
          console.log(`  ${ts(t.ts)}  ${t.from ?? '-'} -> ${t.to}${t.held_ms != null ? ` (held ${age(Date.now() - t.held_ms)})` : ''}`);
        }
      }
    });

  lu
    .command('do <ref> <measure_id>')
    .description('Carry out one of the measures offered by `lucid why`')
    .option('-y, --yes', 'skip the confirmation for run measures')
    .option('--json', 'print the full JSON response')
    .action(async (ref, measureId, options, cmd) => {
      auth.requireAuth();
      const itemData = await call('GET', 'lucid.item', { query: { ref } });
      if (itemData === null) return;
      const m = measuresOf(itemData.item).find((x) => x.id === measureId);
      if (m && m.kind === 'run') {
        const ok = await confirmDestructive(program, { force: options.yes === true }, `Run "${m.label}" for ${ref}?`);
        if (!ok) { console.log('Cancelled.'); return; }
      }
      const data = await call('POST', 'lucid.measure', { body: { ref, measure_id: measureId } });
      if (data === null) return;
      if (wantJson(cmd)) { console.log(JSON.stringify(data, null, 2)); return; }
      if (data.status === 'filed') {
        printSuccess(`Filed${data.approval_id ? ` (approval ${data.approval_id})` : ''}. Approve it in Approvals.`);
      } else if (data.status === 'manual') {
        console.log('This one is manual. Run this yourself:');
        console.log(`  ${data.command ?? ''}`);
      } else if (data.status === 'opened') {
        console.log(`Opened: ${data.url ?? ''}`);
      } else {
        console.log(data.say || `Status: ${data.status}`);
      }
    });

  lu
    .command('teach <target> <assignment>')
    .description('Teach LUCID a rule, e.g. quox lucid teach hitl:abc urgency=fyi --scope subject')
    .option('--scope <scope>', 'subject | kind | area', 'subject')
    .option('--reason <reason>', 'why')
    .option('--json', 'print the full JSON response')
    .action(async (target, assignment, options, cmd) => {
      auth.requireAuth();
      const eq = assignment.indexOf('=');
      if (eq < 1) {
        console.error('LUCID teach needs <field>=<value>, for example urgency=fyi');
        process.exitCode = 1;
        return;
      }
      const body = {
        scope: options.scope, target,
        field: assignment.slice(0, eq), value: assignment.slice(eq + 1),
        reason: options.reason,
      };
      const data = await call('POST', 'lucid.teach', { body });
      if (data === null) return;
      if (wantJson(cmd)) { console.log(JSON.stringify(data, null, 2)); return; }
      printSuccess(`Learned: ${body.field}=${body.value} for ${body.scope} ${target}${data.id ? ` (lesson ${data.id})` : ''}`);
    });

  lu
    .command('lessons')
    .description('What you have taught LUCID')
    .option('--json', 'print the full JSON response')
    .action(async (_options, cmd) => {
      auth.requireAuth();
      const data = await call('GET', 'lucid.lessons');
      if (data === null) return;
      if (wantJson(cmd)) { console.log(JSON.stringify(data, null, 2)); return; }
      const lessons = data.lessons || [];
      formatOutput(lessons.map((l) => ({
        ID: l.id,
        SCOPE: l.scope || '',
        TARGET: l.target || '',
        RULE: `${l.field}=${l.value}`,
        REASON: l.reason || '',
      })), {
        format: program.opts().output,
        columns: ['ID', 'SCOPE', 'TARGET', 'RULE', 'REASON'],
        emptyMessage: 'No lessons taught yet.',
        raw: lessons,
      });
    });

  lu
    .command('forget <id>')
    .description('Forget a lesson')
    .action(async (id, _opts, cmd) => {
      auth.requireAuth();
      const data = await call('DELETE', 'lucid.lessons.delete', { params: { id } });
      if (data === null) return;
      if (wantJson(cmd)) { console.log(JSON.stringify(data, null, 2)); return; }
      printSuccess(`Forgot lesson ${id}`);
    });

  lu
    .command('area <name>')
    .description('One area of the situation: headline, what needs you, measures, last outcome')
    .option('--json', 'print the full JSON response')
    .action(async (name, _opts, cmd) => {
      auth.requireAuth();
      const data = await call('GET', 'lucid.situation', { query: { since: 'last', surface: SURFACE } });
      if (data === null) return;
      const areas = (data.situation && data.situation.areas) || [];
      const area = areas.find((x) => x.area === name || (x.label || '').toLowerCase() === name.toLowerCase());
      if (!area) {
        console.error(`LUCID has no area "${name}". Areas: ${areas.map((x) => x.area).join(', ')}`);
        process.exitCode = 1;
        return;
      }
      if (wantJson(cmd)) { console.log(JSON.stringify(area, null, 2)); return; }
      console.log(`${area.label || area.area} (${area.state})`);
      console.log(area.L0 || '');
      const needs = (area.L1 && area.L1.needs) || [];
      if (needs.length) {
        console.log('');
        console.log('Needs you:');
        for (const n of needs) console.log(`  - ${n.L0} [${n.ref}]`);
      }
      const ms = (area.L2 && area.L2.measures) || [];
      if (ms.length) {
        console.log('');
        console.log('Measures:');
        ms.forEach((m, i) => console.log(`  ${i + 1}. ${m.label} [${m.id}]${m.command ? `  ${m.command}` : ''}`));
      }
      if (area.last) console.log(`\nLast: ${area.last.L0}${area.last.outcome ? ` (${area.last.outcome})` : ''} ${area.last.ts ? `${age(area.last.ts)} ago` : ''}`);
      const st = Object.entries(area.stats || {});
      if (st.length) console.log(`Stats: ${st.map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`).join(' · ')}`);
    });

  // ---- herald: when LUCID reaches out on its own ----
  const LEVELS = { l1_inbox: 'filed in your Approvals inbox', l2_slot: 'nudged you in your slot', l3_call: 'called you', resolved: 'resolved' };
  const levelWords = (l) => LEVELS[l] || l || 'not yet reached out';
  const nextWords = (e) => {
    if (!e.next_step) return 'nothing further';
    const nxt = { l2_slot: 'nudge in your slot', l3_call: 'phone call' }[e.next_step] || e.next_step;
    return e.next_step_at ? `${nxt} at ${ts(e.next_step_at)}` : nxt;
  };
  const coerce = (v) => {
    if (v === 'true') return true;
    if (v === 'false') return false;
    return /^-?\d+$/.test(v) ? Number(v) : v;
  };

  const herald = lu
    .command('herald')
    .description('When LUCID speaks first: your herald settings and what it has escalated')
    .option('--json', 'print the full JSON response')
    .action(async (_opts, cmd) => {
      auth.requireAuth();
      const data = await call('GET', 'lucid.herald');
      if (data === null) return;
      if (wantJson(cmd)) { console.log(JSON.stringify(data, null, 2)); return; }
      const s = data.settings || {};
      console.log(`Herald is ${s.enabled ? 'ON' : 'OFF'}.`);
      console.log(`  Approvals inbox: ${s.inbox ? 'on' : 'off'}`);
      console.log(`  Slot nudge:      ${s.slot ? `on (slot ${s.slot_name})` : 'off'}`);
      console.log(`  Phone call:      ${s.call ? 'on' : 'off (opt-in)'}`);
      console.log(`  Quiet hours:     ${s.quiet_start} to ${s.quiet_end} (${s.tz})`);
      console.log(`  Morning briefing: ${s.morning_at}`);
      console.log(`  Max new inbox items per hour: ${s.max_items_per_hour}`);
      console.log('');
      const esc = data.escalations || [];
      formatOutput(esc.map((e) => ({
        WHAT: e.L0 || e.ref,
        URGENCY: e.urgency || '',
        'SO FAR': levelWords(e.level),
        SINCE: e.since ? `${age(e.since)} ago` : '',
        NEXT: nextWords(e),
      })), {
        format: program.opts().output,
        columns: ['WHAT', 'URGENCY', 'SO FAR', 'SINCE', 'NEXT'],
        emptyMessage: 'LUCID has not escalated anything to you.',
        raw: esc,
      });
    });

  herald
    .command('set <pairs...>')
    .description('Change herald settings, e.g. quox lucid herald set call=true quiet_start=23:00')
    .option('--json', 'print the full JSON response')
    .action(async (pairs, _opts, cmd) => {
      auth.requireAuth();
      const body = {};
      for (const p of pairs) {
        const eq = p.indexOf('=');
        if (eq < 1) {
          console.error(`LUCID herald set needs key=value pairs, got "${p}"`);
          process.exitCode = 1;
          return;
        }
        body[p.slice(0, eq)] = coerce(p.slice(eq + 1));
      }
      const data = await call('POST', 'lucid.herald.settings', { body });
      if (data === null) return;
      if (wantJson(cmd)) { console.log(JSON.stringify(data, null, 2)); return; }
      printSuccess(`Herald updated: ${Object.entries(body).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    });

  herald
    .command('test')
    .description('Dry run: what the herald would do right now (files and sends nothing)')
    .option('--json', 'print the full JSON response')
    .action(async (_opts, cmd) => {
      auth.requireAuth();
      const data = await call('POST', 'lucid.herald.test', { body: {} });
      if (data === null) return;
      if (wantJson(cmd)) { console.log(JSON.stringify(data, null, 2)); return; }
      // The collector answers { enabled, items: [{ L0, urgency, budget_min, waited_min, would }] }.
      const list = data.items || data.would || data.steps || data.actions || [];
      if (data.enabled === false) console.log('The herald is off (quox lucid herald set enabled=true).');
      if (!list.length) { console.log('Nothing needs you, so nothing would fire.'); return; }
      console.log('What the herald would do right now (nothing was sent):');
      for (const w of list) {
        const what = w.L0 || w.ref || '';
        const act = typeof w.would === 'string' ? w.would : levelWords(w.level || w.step);
        const wait = w.waited_min != null ? ` · waited ${w.waited_min}m${w.budget_min != null ? ` of ${w.budget_min}m` : ''}` : '';
        console.log(`  - ${what}${wait}\n      → ${act}${w.message ? `\n      ${w.message}` : ''}`);
      }
    });
}
