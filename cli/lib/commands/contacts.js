/**
 * ContactsQ commands: governed contacts for people and agents.
 * Proxied through the collector (/api/v1/contactsq/*; org resolved server-side).
 * Cards carry MASKED identifiers only. Raw values come back solely from
 * `show --full`, which the server restricts to human actors.
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { Option } from 'commander';
import { formatOutput, formatDetail } from '../core/output.js';
import { QuoxApiError, QuoxError } from '../core/errors.js';
import { line as glyphLine, printEvent } from '../core/quoxglyph.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { runSelftest } from './contactsSelftest.js';
import { resolveOrgId } from './helpers.js';

const KINDS = ['person', 'organisation'];
const REASONS = ['dnc', 'do_not_market', 'bounced'];
const ID_CHANNELS = ['phone', 'email', 'social', 'url'];
const ERASE_SCOPES = ['full', 'identifiers_only'];
const IMPORT_FORMATS = ['csv', 'google_csv', 'vcard'];

const collect = (v, prev) => (prev || []).concat(v);
const isJson = (program) => program.opts().output === 'json';
const printJson = (d) => console.log(JSON.stringify(d, null, 2));
const announce = (verb, result) => printEvent(glyphLine('contactsq', verb, { result }));
const channelOf = (v) => (String(v).includes('@') ? 'email' : 'phone');

function checkEnum(value, allowed, flag) {
  if (value !== undefined && !allowed.includes(value)) {
    throw new QuoxError(`${flag} must be one of: ${allowed.join(', ')}`, 2);
  }
}

async function call(fn, { forbidden } = {}) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof QuoxApiError) {
      if (e.status === 403 && forbidden) throw new QuoxError(forbidden, 1);
      if (e.status === 404 && e.body && e.body.error === 'tombstone_not_found') {
        throw new QuoxError('No erasure tombstone exists for that identifier in this org.', 1);
      }
      if (e.status === 404) throw new QuoxError('Contact not found.', 1);
      if (e.status === 409 && e.body && e.body.error === 'legal_hold') {
        throw new QuoxError('Blocked: this contact is on legal hold. Remove the legal_hold flag first.', 1);
      }
      if (e.status === 409 && e.body && e.body.error === 'already_erased') throw new QuoxError('This contact is already erased.', 1);
      if (e.status === 409 && e.body && e.body.error === 'contact_erased') throw new QuoxError('This contact has been erased, so there is nothing to export.', 1);
      if (e.status === 409 && e.body && e.body.error === 'blind_index_rotation_required') {
        throw new QuoxError('Blocked: MASTER_ENCRYPTION_KEY_PREVIOUS is set. Run `quox contacts reindex` first, then rewrap.', 1);
      }
      if (e.status === 409 && e.body && e.body.error === 'merge_expired') throw new QuoxError('This merge is past its 30 day undo window.', 1);
      if (e.status === 409 && e.body && e.body.error === 'merge_not_active') throw new QuoxError('This merge has already been undone or has expired.', 1);
      if (e.status === 409 && e.body && e.body.error === 'survivor_unavailable') throw new QuoxError('The surviving contact was merged further or erased: undo that first.', 1);
      if (e.status === 409 && e.body && e.body.error === 'not_mergeable') throw new QuoxError('One of those contacts is already merged or erased.', 1);
      if (e.status === 400 && e.body && e.body.error === 'kind_mismatch') throw new QuoxError('A person can only be merged into a person, an organisation into an organisation.', 1);
      if (e.status === 409 && e.body && e.body.error === 'contact_merged') throw new QuoxError('That contact was merged into another: erase the surviving contact instead.', 1);
      if (e.status === 409 && e.body && e.body.error === 'identifier_erased') {
        throw new QuoxError('That number or email belongs to an erased person and is blocked from coming back. If they have legitimately returned, an org admin can run `quox contacts unblock <value> --reason <code> --yes` first.', 1);
      }
      if (e.status === 409 && e.body && e.body.error === 'identifier_in_use') {
        throw new QuoxError('That identifier already belongs to another contact in this org.', 1);
      }
    }
    throw e;
  }
}

const summary = (c) => (c.identifier_summary || []).map((i) => `${i.channel}:${i.masked}`).join(' ');
const cardRow = (c) => ({
  id: c.id,
  name: c.display_name || '',
  kind: c.kind || '',
  status: c.status || '',
  relationship: c.relationship_primary || '',
  identifiers: summary(c),
});
const CARD_COLS = ['id', 'name', 'kind', 'status', 'relationship', 'identifiers'];
const CARD_HEADS = ['ID', 'Name', 'Kind', 'Status', 'Relationship', 'Identifiers'];

// Structured person name flags (--given A --family B ...) -> the API's `name` object. '' clears a part on edit.
const NAME_FLAGS = [
  ['given', '--given <text>'], ['family', '--family <text>'], ['middle', '--middle <text>'], ['prefix', '--prefix <text>'],
  ['suffix', '--suffix <text>'], ['nickname', '--nickname <text>'],
  ['phonetic_given', '--phonetic-given <text>'], ['phonetic_family', '--phonetic-family <text>'],
];
const camel = (k) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const addNameOptions = (cmd) => NAME_FLAGS.reduce((c, [k, flag]) => c.option(flag, `name part: ${k.replace('_', ' ')}`), cmd);
function nameFromOptions(options) {
  const name = {};
  for (const [k] of NAME_FLAGS) if (options[camel(k)] !== undefined) name[k] = options[camel(k)];
  return Object.keys(name).length ? name : undefined;
}

export function registerContactsCommands(program, ctx) {
  const { client, auth } = ctx;

  const contacts = program
    .command('contacts')
    .description('ContactsQ: governed contacts (add, find, resolve caller-ID, suppress)');

  const list = async (options, textQuery) => {
    auth.requireAuth();
    const query = {};
    const q = textQuery ?? options.q;
    if (q) query.q = q;
    if (options.status) query.status = options.status;
    if (options.relationship) query.relationship = options.relationship;
    if (options.limit !== undefined) query.limit = Number(options.limit);
    const ep = resolveEndpoint('contactsq.contacts.list');
    const data = await call(() => client.get(ep.path, { service: ep.service, query }));
    if (isJson(program)) return printJson(data);
    const rows = (data.contacts || []).map(cardRow);
    formatOutput({ columns: CARD_COLS, headers: CARD_HEADS, rows }, { format: program.opts().output });
    announce('contacts list', `${rows.length} contacts`);
  };

  addNameOptions(contacts
    .command('add')
    .description('Create a contact (repeat --phone/--email for several identifiers). Name: positional <name> (split into given/family) or --given/--family/...')
    .argument('[name]', 'display name (split into given + family); or use --given/--family'))
    .option('--phone <number>', 'phone number (repeatable)', collect)
    .option('--email <address>', 'email address (repeatable)', collect)
    .option('--kind <kind>', 'person | organisation (default person)')
    .option('--org-kind', 'shorthand for --kind organisation')
    .option('--organisation <name>', 'their organisation (found by name or created, and linked); a contact has a name AND an organisation')
    .option('--job-title <title>', 'their role at --organisation')
    .option('--relationship <r>', 'primary relationship (e.g. customer, supplier)')
    .option('--notes <text>', 'notes (stored encrypted)')
    .action(async (name, options) => {
      auth.requireAuth();
      checkEnum(options.kind, KINDS, '--kind');
      const kind = options.orgKind ? 'organisation' : options.kind;
      const nameParts = nameFromOptions(options);
      if (!name && !nameParts) throw new QuoxError('Give a <name>, or at least --given/--family.', 2);
      if (nameParts && kind === 'organisation') throw new QuoxError('Organisations have a single name: pass <name>, not --given/--family.', 2);
      if (options.organisation && kind === 'organisation') throw new QuoxError('--organisation is for a person; an organisation contact is just <name> with --org-kind.', 2);
      if (options.jobTitle && !options.organisation) throw new QuoxError('--job-title needs --organisation.', 2);
      const identifiers = [
        ...(options.phone || []).map((value, i) => ({ channel: 'phone', value, ...(i === 0 ? { is_primary: true } : {}) })),
        ...(options.email || []).map((value, i) => ({ channel: 'email', value, ...(i === 0 ? { is_primary: true } : {}) })),
      ];
      const body = {};
      if (name) body.display_name = name;
      if (nameParts) body.name = nameParts;
      if (kind) body.kind = kind;
      if (options.organisation) body.organisation = { name: options.organisation, ...(options.jobTitle ? { role: options.jobTitle } : {}) };
      if (options.relationship) body.relationship_primary = options.relationship;
      if (options.notes) body.notes = options.notes;
      if (identifiers.length) body.identifiers = identifiers;
      const ep = resolveEndpoint('contactsq.contacts.create');
      const data = await call(() => client.post(ep.path, { service: ep.service, body }));
      if (isJson(program)) return printJson(data);
      const c = data.contact || {};
      formatOutput({ columns: CARD_COLS, headers: CARD_HEADS, rows: [cardRow(c)] }, { format: program.opts().output });
      announce('contacts add', c.id || 'created');
    });

  addNameOptions(contacts
    .command('edit')
    .description('Edit a contact name (partial: only the parts you pass change; --given \'\' clears one)')
    .argument('<id>', 'contact id')
    .option('--display <text>', 'display name override (use \'\' to go back to the derived name)')
    .option('--organisation <name>', 'set their organisation (\'\' clears it)')
    .option('--job-title <title>', 'their role at the organisation (with --organisation)'))
    .action(async (id, options) => {
      auth.requireAuth();
      const body = {};
      const name = nameFromOptions(options);
      if (name) body.name = name;
      if (options.display !== undefined) body.display_name_override = options.display === '' ? null : options.display;
      if (options.jobTitle !== undefined && options.organisation === undefined) throw new QuoxError('--job-title needs --organisation (pass the current one to change only the title).', 2);
      if (options.organisation !== undefined) body.organisation = options.organisation === '' ? null : { name: options.organisation, ...(options.jobTitle ? { role: options.jobTitle } : {}) };
      if (!Object.keys(body).length) throw new QuoxError('Nothing to change: pass --given/--family/--middle/--prefix/--suffix/--nickname, --display or --organisation.', 2);
      const ep = resolveEndpoint('contactsq.contacts.update', { id });
      const data = await call(() => client.put(ep.path, { service: ep.service, body }), { forbidden: 'Editing a contact needs a human user.' });
      if (isJson(program)) return printJson(data);
      const c = data.contact || {};
      formatOutput({ columns: CARD_COLS, headers: CARD_HEADS, rows: [cardRow(c)] }, { format: program.opts().output });
      announce('contacts edit', c.id || id);
    });

  contacts
    .command('list')
    .description('List contacts')
    .option('--q <text>', 'name filter')
    .option('--status <s>', 'active | candidate | archived')
    .option('--relationship <r>', 'primary relationship, e.g. customer | supplier | partner')
    .option('--limit <n>', 'max contacts')
    .action((options) => list(options));

  contacts
    .command('find')
    .description('Find contacts by name (same as list --q)')
    .argument('<text>', 'search text')
    .option('--status <s>', 'status filter')
    .option('--limit <n>', 'max contacts')
    .action((text, options) => list(options, text));

  contacts
    .command('show')
    .description('Show a contact card (masked). --greeting: safe greeting projection. --full: raw identifiers, human only')
    .argument('<id>', 'contact id')
    .option('--greeting', 'greeting projection (name, language, tz; no notes)')
    .option('--full', 'full record with raw identifiers and notes (human actors only)')
    .action(async (id, options) => {
      auth.requireAuth();
      if (options.greeting && options.full) throw new QuoxError('Use --greeting or --full, not both.', 2);
      const query = {};
      if (options.greeting) query.projection = 'greeting';
      if (options.full) query.projection = 'full';
      const ep = resolveEndpoint('contactsq.contacts.get', { id });
      const data = await call(() => client.get(ep.path, { service: ep.service, query }), {
        forbidden: '--full is for human users only; agents and service keys get the masked card.',
      });
      if (isJson(program)) return printJson(data);
      const c = data.contact || {};
      const detail = { ...cardRow(c), flags: (c.flags || []).join(',') };
      if (c.name) {
        for (const [k] of NAME_FLAGS) if (c.name[k]) detail[k] = c.name[k];
        if (c.display_name_override) detail.display_override = c.display_name_override;
      }
      if (options.greeting) {
        Object.assign(detail, {
          greeting_name: c.greeting_name ?? '', preferred_name: c.preferred_name ?? '',
          pronunciation: c.pronunciation ?? '', language: c.language ?? '', tz: c.tz ?? '',
          ai_disclosure_required: c.ai_disclosure_required ?? '',
        });
      }
      formatDetail(detail);
      if (options.full) {
        const rows = (c.identifiers || []).map((i) => ({
          id: i.id, channel: i.channel, label: i.label || '', value: i.value, verification: i.verification || '',
        }));
        console.log('');
        formatOutput({
          columns: ['id', 'channel', 'label', 'value', 'verification'],
          headers: ['ID', 'Channel', 'Label', 'Value', 'Verification'],
          rows,
        }, { format: program.opts().output });
        if (c.notes) { console.log(''); console.log(c.notes); }
      }
      announce('contacts show', c.id || id);
    });

  contacts
    .command('resolve')
    .description('Caller-ID: resolve a phone number or email to a contact (reports suppression)')
    .argument('<value>', 'phone number or email')
    .addOption(new Option('--channel <c>', 'phone | email | social | url (default: auto-detect)'))
    .option('--greeting', 'greeting projection instead of the card')
    .action(async (value, options) => {
      auth.requireAuth();
      const channel = options.channel || channelOf(value);
      const body = { channel, value, projection: options.greeting ? 'greeting' : 'card' };
      const ep = resolveEndpoint('contactsq.resolve');
      const data = await call(() => client.post(ep.path, { service: ep.service, body }));
      if (isJson(program)) return printJson(data);
      const m = data.match;
      if (m) {
        formatOutput({ columns: CARD_COLS, headers: CARD_HEADS, rows: [cardRow(m)] }, { format: program.opts().output });
        if (options.greeting) console.log(`greeting: ${m.greeting_name ?? '(unknown)'}`);
      }
      const reasons = data.suppressed && data.suppressed.reasons;
      if (reasons && reasons.length) console.log(`suppressed: ${reasons.join(', ')}`);
      announce('contacts resolve', m ? (m.display_name || m.id) : 'no match');
    });

  contacts
    .command('add-id')
    .description('Add an identifier to a contact')
    .argument('<id>', 'contact id')
    .option('--phone <v>', 'phone number')
    .option('--email <v>', 'email address')
    .option('--social <v>', 'social handle as network:handle')
    .option('--url <v>', 'URL')
    .option('--label <l>', 'label (work, home, ...)')
    .action(async (id, options) => {
      auth.requireAuth();
      const given = ID_CHANNELS.filter((c) => options[c]);
      if (given.length !== 1) throw new QuoxError('Give exactly one of --phone, --email, --social, --url.', 2);
      const channel = given[0];
      const body = { channel, value: options[channel] };
      if (options.label) body.label = options.label;
      const ep = resolveEndpoint('contactsq.identifiers.add', { id });
      const data = await call(() => client.post(ep.path, { service: ep.service, body }));
      if (isJson(program)) return printJson(data);
      const i = data.identifier || {};
      formatDetail({ id: i.id, channel: i.channel, label: i.label || '', masked: i.masked });
      announce('contacts add-id', `${i.channel || channel} ${i.masked || ''}`.trim());
    });

  contacts
    .command('archive')
    .description('Archive a contact (not erasure)')
    .argument('<id>', 'contact id')
    .action(async (id) => {
      auth.requireAuth();
      const ep = resolveEndpoint('contactsq.contacts.archive', { id });
      const data = await call(() => client.delete(ep.path, { service: ep.service }));
      if (isJson(program)) return printJson(data);
      const c = data.contact || {};
      announce('contacts archive', c.status || 'archived');
    });

  contacts
    .command('suppress')
    .description('Add a number or email to the suppression list (blind index only)')
    .argument('<value>', 'phone number or email')
    .requiredOption('--reason <r>', 'dnc | do_not_market | bounced')
    .option('--channel <c>', 'phone | email (default: auto-detect)')
    .action(async (value, options) => {
      auth.requireAuth();
      checkEnum(options.reason, REASONS, '--reason');
      const body = { channel: options.channel || channelOf(value), value, reason: options.reason };
      const ep = resolveEndpoint('contactsq.suppressions.create');
      const data = await call(() => client.post(ep.path, { service: ep.service, body }));
      if (isJson(program)) return printJson(data);
      const s = data.suppression || {};
      announce('contacts suppress', `${s.channel || body.channel} ${s.reason || body.reason}`);
    });

  contacts
    .command('suppressed')
    .description('Check whether a number or email is suppressed')
    .argument('<value>', 'phone number or email')
    .option('--channel <c>', 'phone | email (default: auto-detect)')
    .action(async (value, options) => {
      auth.requireAuth();
      const body = { channel: options.channel || channelOf(value), value };
      const ep = resolveEndpoint('contactsq.suppressions.check');
      const data = await call(() => client.post(ep.path, { service: ep.service, body }));
      if (isJson(program)) return printJson(data);
      const reasons = data.reasons || [];
      console.log(data.suppressed ? `suppressed: ${reasons.join(', ')}` : 'not suppressed');
      announce('contacts suppressed', data.suppressed ? reasons.join(',') : 'clear');
    });

  contacts
    .command('search')
    .description('Ranked name search (phonetic: Sean/Shawn/Shaun); flags ambiguity instead of guessing')
    .argument('<text>', 'name, e.g. "sarah"')
    .option('--org-hint <org>', 'prefer people at this organisation')
    .option('--limit <n>', 'max candidates')
    .action(async (text, options) => {
      auth.requireAuth();
      const query = { q: text };
      if (options.orgHint) query.org_hint = options.orgHint;
      if (options.limit !== undefined) query.limit = Number(options.limit);
      const ep = resolveEndpoint('contactsq.search');
      const data = await call(() => client.get(ep.path, { service: ep.service, query }));
      if (isJson(program)) return printJson(data);
      const rows = (data.candidates || []).map((c) => ({ ...cardRow(c), confidence: Number(c.confidence || 0).toFixed(2), match: c.match || '' }));
      formatOutput({ columns: [...CARD_COLS, 'confidence', 'match'], headers: [...CARD_HEADS, 'Conf', 'Match'], rows }, { format: program.opts().output });
      if (data.ambiguous) console.log(`ambiguous: ${data.hint || 'ask which one'}`);
      announce('contacts search', `${rows.length} candidates${data.ambiguous ? ' (ambiguous)' : ''}`);
    });

  // ---- P8a: morning brief, selftest, handoff notes ----
  contacts
    .command('brief')
    .description('Morning brief: candidates to review, consents expiring, overdue notices, duplicates, sync health, recent do-not-call additions')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('contactsq.brief');
      const d = await call(() => client.get(ep.path, { service: ep.service }));
      if (isJson(program)) return printJson(d);
      formatDetail({
        candidates_to_review: d.candidates_to_review, consents_expiring_30d: d.consents_expiring_30d, notices_overdue: d.notices_overdue,
        duplicates: d.duplicates, dnc_added_7d: d.dnc_added_7d, generated_at: d.generated_at,
      });
      for (const src of d.sync || []) console.log(`sync ${src.label || src.source_id}: ${src.retired ? 'retired' : (src.last_status || 'never run')}${src.last_run_at ? ` (${src.last_run_at})` : ''}`);
      announce('contacts brief', `${d.candidates_to_review} candidates, ${d.duplicates} duplicates`);
    });

  contacts
    .command('timeline <id>')
    .description('Interaction history of a contact, newest first: surface, direction, outcome and time (refs only, no message bodies)')
    .option('--limit <n>', 'max entries', '20')
    .action(async (id, options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('contactsq.timeline', { id });
      const d = await call(() => client.get(ep.path, { service: ep.service, query: { limit: options.limit } }));
      if (isJson(program)) return printJson(d);
      const rows = d.timeline || [];
      if (!rows.length) console.log('No interactions recorded.');
      for (const t of rows) console.log(`${t.occurred_at || ''}  ${t.surface || ''} ${t.direction || ''} ${t.outcome || ''}${t.agent_id ? ` (agent ${t.agent_id})` : ''}`);
      announce('contacts timeline', `${rows.length} entries`);
    });

  contacts
    .command('best-channel <id>')
    .description('Which channel (voice, email or sms) may be used to reach a contact for a purpose, with every alternative and its reason codes. Read-only; never shows a number or address')
    .option('--purpose <purpose>', 'service, transactional, marketing or research', 'service')
    .action(async (id, options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('contactsq.best_channel', { id });
      const d = await call(() => client.get(ep.path, { service: ep.service, query: { purpose: options.purpose } }));
      if (isJson(program)) return printJson(d);
      console.log(`channel: ${d.channel || 'none allowed'}`);
      for (const a of d.alternatives || []) console.log(`  ${a.channel}: ${a.decision}${(a.reasons || []).length ? ` (${a.reasons.join(', ')})` : ''}`);
      announce('contacts best-channel', d.channel || 'none allowed');
    });

  contacts
    .command('count')
    .description('How many contacts: the total (people and organisations, not archived or erased) with counts by kind, status and relationship. --kind narrows to person or organisation')
    .option('--kind <kind>', 'person or organisation')
    .action(async (options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('contactsq.count');
      const query = options.kind ? { kind: options.kind } : undefined;
      const d = await call(() => client.get(ep.path, { service: ep.service, query }));
      if (isJson(program)) return printJson(d);
      const fmt = (o) => Object.entries(o || {}).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
      formatDetail({
        total: d.total, ...(d.kind ? { kind: d.kind } : {}), by_kind: fmt(d.by_kind), by_status: fmt(d.by_status),
        by_relationship: fmt(d.by_relationship), candidates_to_review: d.candidates_to_review, generated_at: d.generated_at,
      });
      announce('contacts count', `${d.total} contacts${d.kind ? ` (${d.kind})` : ''}`);
    });

  contacts
    .command('selftest')
    .description('Drive the read path (search, find, resolve, best channel, timeline, touchpoint, brief) against a demo contact. Never dials or sends. --agent runs it through the attached agent tool scope')
    .option('--agent', 'run the checks as the attached contactsq agent (quox agent attach contactsq first)')
    .action(async (options) => {
      await runSelftest({ client, auth, program, options, orgId: options.agent ? resolveOrgId(auth, program) : undefined });
    });

  contacts
    .command('handoff')
    .description('Leave a handoff note on a contact with an open thread (stored encrypted, humans read it)')
    .argument('<id>', 'contact id')
    .argument('<note>', 'what is pending / what to do next (max 500 characters)')
    .action(async (id, note) => {
      auth.requireAuth();
      if (!note || !note.trim()) throw new QuoxError('A handoff note cannot be empty.', 2);
      if (note.length > 500) throw new QuoxError('A handoff note is at most 500 characters.', 2);
      const ep = resolveEndpoint('contactsq.handoffs.add', { id });
      const d = await call(() => client.post(ep.path, { service: ep.service, body: { note: note.trim() } }));
      if (isJson(program)) return printJson(d);
      announce('contacts handoff', (d.touchpoint && d.touchpoint.id) || 'recorded');
    });

  contacts
    .command('handoffs')
    .description('Open handoff notes on a contact, newest first')
    .argument('<id>', 'contact id')
    .option('--limit <n>', 'max notes (default 3)')
    .action(async (id, options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('contactsq.handoffs', { id });
      const d = await call(() => client.get(ep.path, { service: ep.service, query: options.limit !== undefined ? { limit: Number(options.limit) } : {} }));
      if (isJson(program)) return printJson(d);
      const rows = (d.handoffs || []).map((h) => ({ when: h.occurred_at, age_hours: h.age_hours, by: h.agent_id || '', note: h.summary || '' }));
      formatOutput({ columns: ['when', 'age_hours', 'by', 'note'], headers: ['When', 'Age (h)', 'By', 'Note'], rows }, { format: program.opts().output });
      announce('contacts handoffs', `${rows.length} open`);
    });

  contacts
    .command('focus')
    .description('Show the contact currently open in the ContactsQ dashboard (the one an agent means by "this person"); expires after 30 minutes')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('contactsq.focus.get');
      const data = await call(() => client.get(ep.path, { service: ep.service }));
      if (isJson(program)) return printJson(data);
      const f = data.focus;
      if (!f) { console.log('No contact is open in the dashboard.'); return announce('contacts focus', 'none'); }
      formatOutput({ columns: CARD_COLS, headers: CARD_HEADS, rows: [cardRow(f.contact)] }, { format: program.opts().output });
      console.log(`set by ${f.set_by}, ${f.age_seconds}s ago`);
      announce('contacts focus', `${f.contact.id} (${f.age_seconds}s ago)`);
    });

  contacts
    .command('call')
    .description('Dial a contact by id through the phone bridge; you never see or type the number')
    .argument('<id>', 'contact id (find it with `quox contacts search`)')
    .option('--reason <text>', 'what the call is about (the agent opens with it)')
    .option('--purpose <p>', 'service | transactional | marketing | research', 'service')
    .action(async (id, options) => {
      auth.requireAuth();
      const body = { contact_id: id, projection: 'dial', channel: 'voice', purpose: options.purpose };
      if (options.reason) body.reason = options.reason;
      const ep = resolveEndpoint('contactsq.leases.create');
      const data = await call(() => client.post(ep.path, { service: ep.service, body }), {
        forbidden: 'Blocked: the number is suppressed (do-not-call) or you are not a human user.',
      });
      if (isJson(program)) return printJson(data);
      const l = data.lease || {};
      formatDetail({ lease: l.id, status: l.status, dial: l.dial_state || 'queued', expires_at: l.expires_at });
      announce('contacts call', `${l.id || '?'} queued for the phone bridge`);
    });

  contacts
    .command('leases')
    .description('Lease + use ledger for a contact (who was given access, when, why; never the values)')
    .argument('<id>', 'contact id')
    .action(async (id) => {
      auth.requireAuth();
      const ep = resolveEndpoint('contactsq.leases.list');
      const data = await call(() => client.get(ep.path, { service: ep.service, query: { contact_id: id } }), {
        forbidden: 'The lease ledger is for human users.',
      });
      if (isJson(program)) return printJson(data);
      const rows = (data.leases || []).map((l) => ({
        id: l.id, projection: l.projection, channel: l.channel, purpose: l.purpose, status: l.status,
        decided_by: l.decided_by, uses: `${l.use_count}/${l.max_uses}`, expires_at: l.expires_at,
      }));
      formatOutput({ columns: ['id', 'projection', 'channel', 'purpose', 'status', 'decided_by', 'uses', 'expires_at'] , rows }, { format: program.opts().output });
      announce('contacts leases', `${rows.length} leases`);
    });

  const grant = contacts.command('grant').description('Standing grants: let an agent reach contacts without asking each time (admin)');
  grant
    .command('list')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('contactsq.grants.list');
      const data = await call(() => client.get(ep.path, { service: ep.service }), { forbidden: 'Grants are for human users.' });
      if (isJson(program)) return printJson(data);
      const rows = (data.grants || []).map((g) => ({
        id: g.id, agent: g.subject_id, projection: g.projection, channels: (g.channels || []).join(','),
        purposes: (g.purposes || []).join(','), per_day: g.max_uses_per_day, revoked: g.revoked_at ? 'yes' : '',
      }));
      formatOutput({ columns: ['id', 'agent', 'projection', 'channels', 'purposes', 'per_day', 'revoked'], rows }, { format: program.opts().output });
      announce('contacts grant list', `${rows.length} grants`);
    });
  grant
    .command('add')
    .argument('<agent>', 'agent id, e.g. quox')
    .option('--preset <name>', 'receptionist = dial, voice, service, 20/day')
    .option('--projection <p>', 'dial | send')
    .option('--channel <c>', 'voice | sms | email (repeatable)', collect)
    .option('--purpose <p>', 'service | transactional | marketing | research (repeatable)', collect)
    .option('--per-day <n>', 'daily cap (1-500)')
    .action(async (agent, options) => {
      auth.requireAuth();
      const body = options.preset
        ? { subject_id: agent, preset: options.preset }
        : { subject_id: agent, projection: options.projection, channels: options.channel || [], purposes: options.purpose || [], max_uses_per_day: Number(options.perDay) };
      const ep = resolveEndpoint('contactsq.grants.create');
      const data = await call(() => client.post(ep.path, { service: ep.service, body }), { forbidden: 'Creating a standing grant needs an org admin.' });
      if (isJson(program)) return printJson(data);
      const g = data.grant || {};
      announce('contacts grant add', `${g.id || '?'} ${agent} ${g.projection || ''} ${g.max_uses_per_day || ''}/day`);
    });
  grant
    .command('revoke')
    .argument('<grant-id>')
    .action(async (gid) => {
      auth.requireAuth();
      const ep = resolveEndpoint('contactsq.grants.revoke', { id: gid });
      const data = await call(() => client.delete(ep.path, { service: ep.service }), { forbidden: 'Revoking a grant needs an org admin.' });
      if (isJson(program)) return printJson(data);
      announce('contacts grant revoke', gid);
    });

  contacts
    .command('dsar')
    .description('Data subject access request: the full record, provenance, consents, touchpoints, edges and the lease use ledger as one JSON bundle (org admin)')
    .argument('<id>', 'contact id')
    .option('--out <file>', 'write the bundle to this file instead of printing it')
    .action(async (id, options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('contactsq.contacts.dsar', { id });
      const data = await call(() => client.get(ep.path, { service: ep.service }), {
        forbidden: 'A DSAR export needs a signed-in org admin; agents and service keys cannot run it.',
      });
      if (options.out) {
        writeFileSync(options.out, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
        announce('contacts dsar', `${options.out} (${Object.entries(data.counts || {}).map(([k, v]) => `${k}=${v}`).join(' ')})`);
        return;
      }
      printJson(data);
      announce('contacts dsar', id);
    });

  contacts
    .command('erase')
    .description('Erase a contact (org admin, irreversible). full = crypto-shred + tombstone; identifiers_only keeps the record')
    .argument('<id>', 'contact id')
    .requiredOption('--scope <scope>', 'full | identifiers_only')
    .requiredOption('--reason <code>', 'reason code, e.g. subject_request')
    .option('--yes', 'confirm the erasure (refused without it)')
    .action(async (id, options) => {
      auth.requireAuth();
      checkEnum(options.scope, ERASE_SCOPES, '--scope');
      if (!options.yes) throw new QuoxError('Erasure is irreversible. Re-run with --yes to confirm.', 2);
      const ep = resolveEndpoint('contactsq.contacts.erase', { id });
      const data = await call(() => client.post(ep.path, { service: ep.service, body: { scope: options.scope, reason_code: options.reason } }), {
        forbidden: 'Erasure needs a signed-in org admin; agents and service keys cannot erase.',
      });
      if (isJson(program)) return printJson(data);
      const c = data.certificate || {};
      formatDetail({ erasure: c.erasure_id, contact: c.contact_id, scope: c.scope, executed_at: c.executed_at, sha256: c.sha256 });
      console.log('');
      formatDetail(c.propagation || {});
      announce('contacts erase', `${c.erasure_id || '?'} ${c.scope || options.scope}`);
    });

  contacts
    .command('certificate')
    .description('Print an erasure certificate (org admin)')
    .argument('<erasure-id>', 'erasure id from `contacts erase`')
    .action(async (eid) => {
      auth.requireAuth();
      const ep = resolveEndpoint('contactsq.erasures.certificate', { id: eid });
      const data = await call(() => client.get(ep.path, { service: ep.service }), { forbidden: 'Certificates are for org admins.' });
      printJson(data);
      announce('contacts certificate', `${eid} ${data.verified ? 'verified' : 'HASH MISMATCH'}`);
    });

  contacts
    .command('compliance')
    .description('Compliance bands: Article 14 notices overdue, candidates expiring, no lawful basis, consents expiring')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('contactsq.compliance');
      const data = await call(() => client.get(ep.path, { service: ep.service }), { forbidden: 'Compliance bands are for human users.' });
      if (isJson(program)) return printJson(data);
      const rows = Object.entries(data.bands || {}).map(([band, b]) => ({ band, count: b.count, ids: (b.ids || []).slice(0, 5).join(',') + (b.count > 5 ? ',...' : '') }));
      formatOutput({ columns: ['band', 'count', 'ids'], headers: ['Band', 'Count', 'IDs'], rows }, { format: program.opts().output });
      announce('contacts compliance', rows.map((r) => `${r.band}=${r.count}`).join(' '));
    });

  contacts
    .command('notice-sent')
    .description('Record that the Article 14 notice was sent to a contact')
    .argument('<id>', 'contact id')
    .requiredOption('--evidence <ref>', 'reference to the evidence (WARD ref, message id)')
    .action(async (id, options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('contactsq.contacts.noticeSent', { id });
      const data = await call(() => client.post(ep.path, { service: ep.service, body: { evidence_ref: options.evidence } }), { forbidden: 'Only human users can record a notice.' });
      if (isJson(program)) return printJson(data);
      announce('contacts notice-sent', (data.notice && data.notice.sent_at) || id);
    });

  contacts
    .command('processing-record')
    .description('Article 30 record of processing for this org (no personal data; org admin)')
    .option('--out <file>', 'write to a file')
    .action(async (options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('contactsq.processingRecord');
      const data = await call(() => client.get(ep.path, { service: ep.service }), { forbidden: 'The processing record is for org admins.' });
      if (options.out) { writeFileSync(options.out, `${JSON.stringify(data, null, 2)}\n`); announce('contacts processing-record', options.out); return; }
      printJson(data);
      announce('contacts processing-record', 'ok');
    });

  const retention = contacts.command('retention').description('Retention reaper: erases candidates past their retention date (kill switch: `contacts settings --reaper off`)');
  retention
    .command('status')
    .description('Reaper status: enabled, last run, next run, pending')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('contactsq.retention.status');
      const data = await call(() => client.get(ep.path, { service: ep.service }), { forbidden: 'Retention status is for human users.' });
      if (isJson(program)) return printJson(data);
      formatDetail({ ...data, last_counts: data.last_counts ? JSON.stringify(data.last_counts) : '', pending: JSON.stringify(data.pending || {}) });
      announce('contacts retention status', `${data.enabled ? 'enabled' : 'disabled'} next ${data.next_tick_at || 'never'}`);
    });
  retention
    .command('run')
    .description('Run the reaper now (org admin). --dry-run lists what would be erased and changes nothing')
    .option('--dry-run', 'report only')
    .action(async (options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('contactsq.retention.run');
      const data = await call(() => client.post(ep.path, { service: ep.service, body: { dry_run: Boolean(options.dryRun) } }), { forbidden: 'Running retention needs an org admin.' });
      if (isJson(program)) return printJson(data);
      const r = data.run || {};
      formatDetail({ status: r.status, dry_run: r.dry_run, considered: r.considered, erased: r.erased, failed: r.failed, skipped_legal_hold: r.skipped_legal_hold, retired_failed: r.retired_failed });
      announce('contacts retention run', `${r.dry_run ? 'dry run: would erase' : 'erased'} ${r.dry_run ? (r.would_erase_ids || []).length : r.erased}`);
    });

  contacts
    .command('import')
    .description('Import contacts from a CSV (incl. Google Contacts export) or vCard file. Dry run unless --commit. Org admin')
    .argument('<file>', '.csv or .vcf file')
    .option('--commit', 'write the contacts (without it nothing is written)')
    .option('--format <f>', 'csv | google_csv | vcard (default: detected)')
    .option('--mapping <json>', 'column mapping as JSON or a path to a JSON file: {"Header": "email|phone|name|first_name|last_name|company|title|notes|tags|ignore"}')
    .action(async (file, options) => {
      auth.requireAuth();
      checkEnum(options.format, IMPORT_FORMATS, '--format');
      let bytes;
      try { bytes = readFileSync(file); } catch (e) { throw new QuoxError(`Cannot read ${file}: ${e.message}`, 2); }
      let mapping;
      if (options.mapping) {
        const raw = existsSync(options.mapping) ? readFileSync(options.mapping, 'utf8') : options.mapping;
        try { mapping = JSON.parse(raw); } catch { throw new QuoxError('--mapping must be valid JSON (or a path to a JSON file).', 2); }
      }
      const form = new FormData();
      form.append('file', new Blob([bytes]), basename(file));
      form.append('dry_run', options.commit ? 'false' : 'true');
      if (options.format) form.append('format', options.format);
      if (mapping) form.append('mapping', JSON.stringify(mapping));
      const ep = resolveEndpoint('contactsq.import');
      // retries: 0, a retried multipart upload would import twice.
      const data = await call(() => client.post(ep.path, { service: ep.service, body: form, timeout: 300000, retries: 0 }), {
        forbidden: 'Importing contacts needs a signed-in org admin; agents and service keys cannot import.',
      });
      if (isJson(program)) return printJson(data);
      const r = data.report || {};
      if (data.dry_run) {
        formatDetail({
          rows: r.rows, would_create: r.would_create, would_merge_into_existing: r.would_merge_into_existing,
          organisations_would_create: r.organisations_would_create, skipped_tombstoned: r.skipped_tombstoned,
          skipped_suppressed_marked: r.skipped_suppressed_marked, duplicates_in_file: r.duplicates_in_file, invalid: (r.invalid || []).length,
        });
        for (const i of r.invalid || []) console.log(`row ${i.row}: ${i.code}`);
        console.log('Dry run: nothing was written. Re-run with --commit to import.');
        announce('contacts import', `dry run: ${r.would_create} create, ${r.would_merge_into_existing} merge`);
        return;
      }
      formatDetail({ import_id: data.import_id, ...(data.counts || {}) });
      for (const i of r.invalid || []) console.log(`row ${i.row}: ${i.code}`);
      for (const i of r.row_errors || []) console.log(`row ${i.row}: failed (${i.code})`);
      announce('contacts import', `${(data.counts || {}).created || 0} created, ${(data.counts || {}).merged_into_existing || 0} merged (${data.import_id})`);
    });

  // ---- P7: CardDAV pull sync (iCloud, Fastmail, Nextcloud). One way: the address book is read, never written. ----
  const syncCmd = contacts.command('sync').description('Link an address book (iCloud or any CardDAV) and pull it into ContactsQ, one way. Org admin');
  const SYNC_FORBIDDEN = 'Address book sync needs a signed-in org admin; agents and service keys cannot manage it.';
  const syncRow = (s) => ({
    id: s.id, label: s.label, provider: s.provider, enabled: s.enabled ? 'yes' : 'no', every: s.interval_min ? `${s.interval_min}m` : 'manual',
    last_run: s.last_run_at || 'never', status: s.retired_at ? `RETIRED (${s.last_status || ''})` : (s.last_status || '-'),
  });
  const printSyncCounts = (c) => formatDetail(c || {});
  syncCmd
    .command('list')
    .description('List sync sources with last run and status')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('contactsq.sync.list');
      const data = await call(() => client.get(ep.path, { service: ep.service }), { forbidden: SYNC_FORBIDDEN });
      if (isJson(program)) return printJson(data);
      const rows = (data.sources || []).map(syncRow);
      formatOutput({ columns: ['id', 'label', 'provider', 'enabled', 'every', 'last_run', 'status'], headers: ['ID', 'Label', 'Provider', 'Enabled', 'Every', 'Last run', 'Status'], rows }, { format: program.opts().output });
      announce('contacts sync list', `${rows.length} sources`);
    });
  syncCmd
    .command('add')
    .description('Add a sync source from a vault credential of kind carddav_account (create the credential first; for iCloud use an app-specific password)')
    .requiredOption('--credential <id>', 'vault credential id (icloud_contacts or carddav)')
    .option('--label <text>', 'a name for this source')
    .option('--every <minutes>', 'sync on a schedule, every N minutes (15 to 10080). Omit for manual only')
    .option('--addressbook <url>', 'pick one address book when the account has several')
    .action(async (options) => {
      auth.requireAuth();
      const body = { credential_id: options.credential };
      if (options.label) body.label = options.label;
      if (options.addressbook) body.addressbook_url = options.addressbook;
      if (options.every !== undefined) {
        const n = Number(options.every);
        if (!Number.isInteger(n) || n < 15 || n > 10080) throw new QuoxError('--every must be a whole number of minutes between 15 and 10080.', 2);
        body.interval_min = n;
      }
      const ep = resolveEndpoint('contactsq.sync.add');
      let data;
      try {
        data = await call(() => client.post(ep.path, { service: ep.service, body, retries: 0 }), { forbidden: SYNC_FORBIDDEN });
      } catch (e) {
        if (e instanceof QuoxApiError && e.body) {
          const code = e.body.error;
          if (code === 'credential_rejected') throw new QuoxError('The address book server rejected that login. For iCloud use an app-specific password, not your Apple ID password.', 1);
          if (code === 'credential_wrong_kind') throw new QuoxError('That credential is not an address book login (kind carddav_account).', 1);
          if (code === 'source_exists') throw new QuoxError('That address book is already linked.', 1);
          if (code === 'addressbook_choice_required') {
            const list = (e.body.addressbooks || []).map((a) => `  ${a.name || '(unnamed)'}  ${a.url}`).join('\n');
            throw new QuoxError(`This account has several address books. Re-run with --addressbook <url>:\n${list}`, 1);
          }
        }
        throw e;
      }
      if (isJson(program)) return printJson(data);
      const s = data.source || {};
      formatDetail(syncRow(s));
      announce('contacts sync add', `${s.id} (try: quox contacts sync run ${s.id} --dry-run)`);
    });
  syncCmd
    .command('run')
    .description('Pull the address book now. --dry-run reports counts and changes nothing')
    .argument('<id>', 'sync source id')
    .option('--dry-run', 'report only')
    .action(async (id, options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('contactsq.sync.run', { id });
      const data = await call(() => client.post(ep.path, { service: ep.service, body: { dry_run: Boolean(options.dryRun) }, timeout: 600000, retries: 0 }), { forbidden: SYNC_FORBIDDEN });
      if (isJson(program)) return printJson(data);
      const c = data.counts || {};
      printSyncCounts(c);
      if (data.dry_run) console.log('Dry run: nothing was written.');
      announce('contacts sync run', `${data.dry_run ? 'dry run: ' : ''}${c.created || 0} created, ${c.updated || 0} updated, ${c.flagged_removed || 0} flagged removed`);
    });
  for (const [name, on] of [['enable', true], ['disable', false]]) {
    syncCmd
      .command(name)
      .description(on ? 'Enable a source for scheduled sync (also clears a retirement after repeated failures)' : 'Stop scheduled sync for a source (contacts are kept)')
      .argument('<id>', 'sync source id')
      .action(async (id) => {
        auth.requireAuth();
        const ep = resolveEndpoint('contactsq.sync.update', { id });
        const data = await call(() => client.patch(ep.path, { service: ep.service, body: { enabled: on } }), { forbidden: SYNC_FORBIDDEN });
        if (isJson(program)) return printJson(data);
        announce(`contacts sync ${name}`, `${id} ${on ? 'enabled' : 'disabled'}`);
      });
  }
  syncCmd
    .command('remove')
    .description('Remove a sync source: stops syncing, keeps every contact already pulled')
    .argument('<id>', 'sync source id')
    .option('--yes', 'confirm (refused without it)')
    .action(async (id, options) => {
      auth.requireAuth();
      if (!options.yes) throw new QuoxError('Removing a source stops syncing and drops its links. Contacts already pulled are kept. Re-run with --yes to confirm.', 2);
      const ep = resolveEndpoint('contactsq.sync.remove', { id });
      const data = await call(() => client.delete(ep.path, { service: ep.service }), { forbidden: SYNC_FORBIDDEN });
      if (isJson(program)) return printJson(data);
      announce('contacts sync remove', `${id} removed, contacts kept`);
    });

  contacts
    .command('merge')
    .description('Merge LOSER into SURVIVOR (org admin, undoable for 30 days with `contacts unmerge`)')
    .argument('<survivor>', 'contact id that stays')
    .argument('<loser>', 'contact id that is folded in')
    .option('--yes', 'confirm the merge (refused without it)')
    .action(async (survivor, loser, options) => {
      auth.requireAuth();
      if (!options.yes) throw new QuoxError('Merging moves identifiers, history and facts onto the survivor. Re-run with --yes to confirm (undo: `quox contacts unmerge <merge-id>` within 30 days).', 2);
      const ep = resolveEndpoint('contactsq.contacts.merge', { id: survivor });
      const data = await call(() => client.post(ep.path, { service: ep.service, body: { from_id: loser } }), { forbidden: 'Merging needs a signed-in org admin.' });
      if (isJson(program)) return printJson(data);
      const m = data.merge || {};
      formatDetail({ merge_id: m.id, survivor: m.survivor_id, merged: m.loser_id, undo_until: m.expires_at, ...(data.counts || {}) });
      announce('contacts merge', `${m.id} (undo: quox contacts unmerge ${m.id})`);
    });

  contacts
    .command('unmerge')
    .description('Undo a merge (org admin, within 30 days): both contacts are restored exactly')
    .argument('<merge-id>', 'merge id from `contacts merge`')
    .action(async (mid) => {
      auth.requireAuth();
      const ep = resolveEndpoint('contactsq.merges.undo', { id: mid });
      const data = await call(() => client.post(ep.path, { service: ep.service }), { forbidden: 'Undoing a merge needs a signed-in org admin.' });
      if (isJson(program)) return printJson(data);
      const m = data.merge || {};
      formatDetail({ merge_id: m.id, status: m.status, survivor: m.survivor_id, restored: m.loser_id });
      announce('contacts unmerge', `${m.id} restored`);
    });

  contacts
    .command('duplicates')
    .description('Suggest duplicate pairs (same identifier, or same name at the same organisation)')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('contactsq.duplicates');
      const data = await call(() => client.get(ep.path, { service: ep.service }), { forbidden: 'Duplicate suggestions are for human users.' });
      if (isJson(program)) return printJson(data);
      const rows = (data.duplicates || []).map((d) => ({ a: `${d.a.id} ${d.a.display_name}`, b: `${d.b.id} ${d.b.display_name}`, why: d.reasons.join(','), keep: d.suggested_survivor }));
      formatOutput({ columns: ['a', 'b', 'why', 'keep'], headers: ['A', 'B', 'Why', 'Suggested survivor'], rows }, { format: program.opts().output });
      announce('contacts duplicates', `${rows.length} pairs`);
    });

  contacts
    .command('facts')
    .description('List a contact\'s facts (human). --confirm / --reject <fact-id> reviews an agent proposal')
    .argument('<id>', 'contact id')
    .option('--confirm <fact-id>', 'confirm a proposed fact')
    .option('--reject <fact-id>', 'reject a proposed fact')
    .action(async (id, options) => {
      auth.requireAuth();
      const forbidden = 'Facts are for human users; agents can only propose them.';
      for (const [factId, state] of [[options.confirm, 'confirmed'], [options.reject, 'rejected']]) {
        if (!factId) continue;
        const uep = resolveEndpoint('contactsq.facts.update', { id, factId });
        await call(() => client.put(uep.path, { service: uep.service, body: { review_state: state } }), { forbidden });
        announce('contacts facts', `${factId} ${state}`);
      }
      const ep = resolveEndpoint('contactsq.facts.list', { id });
      const data = await call(() => client.get(ep.path, { service: ep.service }), { forbidden });
      if (isJson(program)) return printJson(data);
      const rows = (data.facts || []).map((f) => ({ id: f.id, key: f.key, value: f.value || '', state: f.review_state, sensitivity: f.sensitivity, confidence: f.confidence }));
      formatOutput({ columns: ['id', 'key', 'value', 'state', 'sensitivity', 'confidence'], headers: ['ID', 'Key', 'Value', 'State', 'Sensitivity', 'Confidence'], rows }, { format: program.opts().output });
      announce('contacts facts', `${rows.length} facts`);
    });

  contacts
    .command('settings')
    .description('Show or update ContactsQ settings (updates are admin only)')
    .option('--region <cc>', 'default phone region, e.g. GB')
    .option('--candidate-days <n>', 'days to keep auto-created candidates')
    .option('--reaper <on|off>', 'retention reaper kill switch')
    .option('--reaper-time <HH:MM>', 'UTC time of day the reaper runs (default 03:15)')
    .option('--backup-days <n>', 'days until an erased contact ages out of backups (shown on certificates)')
    .option('--report <weekly|monthly|off>', 'recurring compliance report to the Approvals inbox (default off)')
    .option('--report-day <n>', 'report day: weekly 1-7 (Mon=1), monthly 1-28')
    .option('--report-time <HH:MM>', 'UTC time of day the report is delivered (default 08:00)')
    .option('--strict-names <on|off>', 'store names encrypted (agents see a placeholder); run `contacts strict-names apply` to migrate existing contacts')
    .action(async (options) => {
      auth.requireAuth();
      const gep = resolveEndpoint('contactsq.settings.get');
      let data = await call(() => client.get(gep.path, { service: gep.service }));
      if (options.reaper !== undefined) checkEnum(options.reaper, ['on', 'off'], '--reaper');
      if (options.strictNames !== undefined) checkEnum(options.strictNames, ['on', 'off'], '--strict-names');
      if (options.report !== undefined) checkEnum(options.report, ['weekly', 'monthly', 'off'], '--report');
      const reportTouched = options.report !== undefined || options.reportDay !== undefined || options.reportTime !== undefined;
      if (reportTouched ||
          options.strictNames !== undefined || options.region !== undefined || options.candidateDays !== undefined || options.reaper !== undefined || options.reaperTime !== undefined || options.backupDays !== undefined) {
        const cur = data.settings || {};
        const body = { ...cur };
        if (options.region !== undefined) body.default_region = String(options.region).toUpperCase();
        if (options.candidateDays !== undefined) body.candidate_retention_days = Number(options.candidateDays);
        if (options.reaper !== undefined) body.retention_reaper_enabled = options.reaper === 'on';
        if (options.reaperTime !== undefined) body.retention_run_time_utc = options.reaperTime;
        if (options.backupDays !== undefined) body.backup_retention_days = Number(options.backupDays);
        if (options.strictNames !== undefined) body.strict_names = options.strictNames === 'on';
        if (reportTouched) {
          const cr = { ...(cur.compliance_report || {}) };
          if (options.report !== undefined) {
            cr.enabled = options.report !== 'off';
            if (options.report !== 'off') cr.cadence = options.report;
          }
          if (options.reportDay !== undefined) cr.day = Number(options.reportDay);
          if (options.reportTime !== undefined) cr.time_utc = options.reportTime;
          body.compliance_report = cr;
        }
        const pep = resolveEndpoint('contactsq.settings.update');
        data = await call(() => client.put(pep.path, { service: pep.service, body }), {
          forbidden: 'Changing ContactsQ settings needs an org admin.',
        });
      }
      if (isJson(program)) return printJson(data);
      formatDetail(data.settings || {});
      announce('contacts settings', 'ok');
    });
  contacts
    .command('unblock')
    .description('Lift an erasure tombstone so a returning person can be re-added (org admin; witnessed)')
    .argument('<identifier>', 'phone number or email address that was erased')
    .requiredOption('--reason <code>', 'reason code, e.g. subject_returned')
    .option('--yes', 'confirm (refused without it)')
    .action(async (identifier, options) => {
      auth.requireAuth();
      if (!options.yes) throw new QuoxError('Lifting a tombstone lets this identifier be recorded again. Re-run with --yes to confirm.', 2);
      const ep = resolveEndpoint('contactsq.suppressions.tombstoneLift');
      const data = await call(() => client.post(ep.path, { service: ep.service, body: { channel: channelOf(identifier), value: identifier, reason_code: options.reason } }), {
        forbidden: 'Lifting a tombstone needs a signed-in org admin; agents and service keys cannot.',
      });
      if (isJson(program)) return printJson(data);
      const l = data.lifted || {};
      formatDetail({ channel: l.channel, removed: l.removed });
      announce('contacts unblock', `${l.channel || channelOf(identifier)} tombstone lifted`);
    });

  contacts
    .command('rewrap')
    .description('Re-wrap every contact key under the current master key and upgrade old ciphertexts (org admin)')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('contactsq.admin.rewrap');
      const data = await call(() => client.post(ep.path, { service: ep.service, body: {} }), {
        forbidden: 'Rewrap needs a signed-in org admin; agents and service keys cannot run it.',
      });
      if (isJson(program)) return printJson(data);
      formatDetail(data.counts || {});
      if (data.previous_key_still_required) {
        console.log('\nWarning: some suppressions can only be matched with MASTER_ENCRYPTION_KEY_PREVIOUS. Do not remove it yet.');
      }
      if ((data.failed_ids || []).length) console.log(`\nFailed contact ids: ${data.failed_ids.join(', ')}`);
      announce('contacts rewrap', `${(data.counts || {}).rewrapped ?? 0} rewrapped, ${(data.counts || {}).failed ?? 0} failed`);
    });

  contacts
    .command('reindex')
    .description('Re-key every blind index under the current master key (master-key rotation step; org admin)')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('contactsq.admin.reindex');
      const data = await call(() => client.post(ep.path, { service: ep.service, body: {} }), {
        forbidden: 'Reindex needs a signed-in org admin; agents and service keys cannot run it.',
      });
      if (isJson(program)) return printJson(data);
      formatDetail({ complete: data.complete, bi_version: data.bi_version, previous_key_removable: data.previous_key_removable, ...(data.counts || {}) });
      if ((data.failed_ids || []).length) console.log(`\nFailed contact ids: ${data.failed_ids.join(', ')}`);
      if (data.complete && !data.previous_key_removable) {
        console.log('\nWarning: some suppressions could not be re-keyed (no surviving identifier). Keep MASTER_ENCRYPTION_KEY_PREVIOUS configured.');
      }
      announce('contacts reindex', data.complete ? `bi_version ${data.bi_version}` : 'INCOMPLETE');
    });

  contacts
    .command('strict-names')
    .description('Apply the org strict_names setting to existing contacts, both directions (org admin)')
    .argument('<action>', 'apply')
    .action(async (action) => {
      auth.requireAuth();
      checkEnum(action, ['apply'], 'action');
      const ep = resolveEndpoint('contactsq.admin.strictNamesApply');
      const data = await call(() => client.post(ep.path, { service: ep.service, body: {} }), {
        forbidden: 'Applying strict names needs a signed-in org admin.',
      });
      if (isJson(program)) return printJson(data);
      formatDetail({ strict_names: data.strict_names, ...(data.counts || {}) });
      if ((data.failed_ids || []).length) console.log(`\nFailed contact ids: ${data.failed_ids.join(', ')}`);
      announce('contacts strict-names apply', `${(data.counts || {}).converted ?? 0} converted`);
    });
}
