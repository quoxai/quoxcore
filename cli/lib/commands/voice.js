/**
 * quox#695: `quox voice numbers list|set|remove`, per-number telephony org
 * binding. Collector routes under /api/v1/telephony/numbers (org-scoped;
 * writes are org-admin only).
 */
import { formatOutput, printSuccess } from '../core/output.js';
import { resolveEndpoint } from '../api/endpoints.js';
import { QuoxApiError } from '../core/errors.js';
import { resolveOrgId } from './helpers.js';

export function friendlyNumbersError(err) {
  if (err instanceof QuoxApiError) {
    if (err.status === 409) return new QuoxApiError(409, err.code, 'that number belongs to another org', err.detail, err.body);
    if (err.status === 400) return new QuoxApiError(400, err.code, 'use E.164 format, e.g. +447700900123', err.detail, err.body);
    if (err.status === 403) return new QuoxApiError(403, err.code, 'only an org admin can bind numbers', err.detail, err.body);
  }
  return err;
}

export function parseOnOff(value, flag) {
  const v = String(value).trim().toLowerCase();
  if (['on', 'true', 'yes', '1'].includes(v)) return true;
  if (['off', 'false', 'no', '0'].includes(v)) return false;
  throw new Error(`${flag} must be on or off`);
}

export function registerVoiceCommands(program, ctx) {
  const { client, auth } = ctx;

  const voice = program.command('voice').description('QuoxVoice telephony');
  const numbers = voice.command('numbers').description('Bind phone numbers to this org');

  numbers
    .command('list')
    .description('List numbers bound to the active org')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('telephony.numbers.list');
      const data = await client.get(ep.path, { service: ep.service, query: { org_id: resolveOrgId(auth, program) } });
      const list = data.numbers || [];
      formatOutput(list.map((n) => ({
        NUMBER: n.number,
        LABEL: n.label || '',
        ORG: n.org_id,
        UPDATED: n.updated_at || n.created_at || '',
      })), {
        format: program.opts().output,
        columns: ['NUMBER', 'LABEL', 'ORG', 'UPDATED'],
        emptyMessage: 'No numbers bound. Bind one with `quox voice numbers set <number>`.',
        raw: list,
      });
    });

  numbers
    .command('set <number>')
    .description('Bind a number (E.164) to the active org, optionally with a label and policy')
    .option('--label <text>', 'human label for the number')
    .option('--policy <json>', 'policy as a JSON object (merged over the current policy)')
    .option('--brand <text>', 'policy: brand name the line answers as')
    .option('--opener-name <text>', 'policy: name used in the call opener')
    .option('--ivr <on|off>', 'policy: IVR menu on or off')
    .option('--voice <text>', 'policy: voice to speak with')
    .option('--language <text>', 'policy: language')
    .option('--persona <text>', 'policy: persona')
    .option('--verbosity <quiet|verbose>', 'policy: how chatty the agent is')
    .action(async (number, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = { org_id: orgId };
      if (options.label !== undefined) body.label = options.label;
      const flagPolicy = {};
      if (options.brand !== undefined) flagPolicy.brand = options.brand;
      if (options.openerName !== undefined) flagPolicy.opener_name = options.openerName;
      if (options.ivr !== undefined) flagPolicy.ivr = parseOnOff(options.ivr, '--ivr');
      if (options.voice !== undefined) flagPolicy.voice = options.voice;
      if (options.language !== undefined) flagPolicy.language = options.language;
      if (options.persona !== undefined) flagPolicy.persona = options.persona;
      if (options.verbosity !== undefined) flagPolicy.verbosity = options.verbosity;
      let jsonPolicy;
      if (options.policy !== undefined) {
        try { jsonPolicy = JSON.parse(options.policy); } catch { throw new Error('--policy must be valid JSON'); }
      }
      if (jsonPolicy !== undefined || Object.keys(flagPolicy).length > 0) {
        // Read-modify-write so one flag never clobbers the other policy keys.
        const lep = resolveEndpoint('telephony.numbers.list');
        const cur = await client.get(lep.path, { service: lep.service, query: { org_id: orgId } });
        const existing = ((cur && cur.numbers) || []).find((n) => n.number === number);
        body.policy = { ...((existing && existing.policy) || {}), ...(jsonPolicy || {}), ...flagPolicy };
      }
      const ep = resolveEndpoint('telephony.numbers.set', { number });
      let data;
      try {
        data = await client.put(ep.path, { service: ep.service, body });
      } catch (err) { throw friendlyNumbersError(err); }
      if (program.opts().output === 'json') { console.log(JSON.stringify(data, null, 2)); return; }
      printSuccess(`Bound ${(data.number && data.number.number) || number} to this org`);
    });

  numbers
    .command('remove <number>')
    .description('Unbind a number from the active org')
    .action(async (number) => {
      auth.requireAuth();
      const ep = resolveEndpoint('telephony.numbers.remove', { number });
      let data;
      try {
        data = await client.delete(ep.path, { service: ep.service, query: { org_id: resolveOrgId(auth, program) } });
      } catch (err) { throw friendlyNumbersError(err); }
      if (program.opts().output === 'json') { console.log(JSON.stringify(data, null, 2)); return; }
      printSuccess(`Removed ${number}`);
    });

  const identities = voice.command('identities').description('Map caller numbers to users (voice on-behalf-of identity)');

  identities
    .command('list')
    .description('List caller number to user mappings for the active org')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('telephony.identities.list');
      const data = await client.get(ep.path, { service: ep.service, query: { org_id: resolveOrgId(auth, program) } });
      const list = data.identities || [];
      formatOutput(list.map((n) => ({
        NUMBER: n.number,
        USER: n.user_id,
        LABEL: n.label || '',
        UPDATED: n.updated_at || '',
      })), {
        format: program.opts().output,
        columns: ['NUMBER', 'USER', 'LABEL', 'UPDATED'],
        emptyMessage: 'No identities mapped. Add one with `quox voice identities set <number> <userId>`.',
        raw: list,
      });
    });

  identities
    .command('set <number> <userId>')
    .description('Map a caller number (E.164) to a user in the active org')
    .option('--label <text>', 'human label for the mapping')
    .action(async (number, userId, options) => {
      auth.requireAuth();
      const body = { org_id: resolveOrgId(auth, program), user_id: userId };
      if (options.label !== undefined) body.label = options.label;
      const ep = resolveEndpoint('telephony.identities.set', { number });
      let data;
      try {
        data = await client.put(ep.path, { service: ep.service, body });
      } catch (err) { throw friendlyNumbersError(err); }
      if (program.opts().output === 'json') { console.log(JSON.stringify(data, null, 2)); return; }
      printSuccess(`Mapped ${(data && data.number) || number} to user ${userId}`);
    });

  identities
    .command('remove <number>')
    .description('Remove a caller number mapping from the active org')
    .action(async (number) => {
      auth.requireAuth();
      const ep = resolveEndpoint('telephony.identities.remove', { number });
      let data;
      try {
        data = await client.delete(ep.path, { service: ep.service, query: { org_id: resolveOrgId(auth, program) } });
      } catch (err) { throw friendlyNumbersError(err); }
      if (program.opts().output === 'json') { console.log(JSON.stringify(data, null, 2)); return; }
      printSuccess(`Removed ${number}`);
    });

  voice
    .command('calls')
    .description('List recent calls for the active org (summary + turn count)')
    .option('--limit <n>', 'max calls to return (1-200, default 50)')
    .action(async (options) => {
      auth.requireAuth();
      const ep = resolveEndpoint('voice.calls.list');
      const query = { org_id: resolveOrgId(auth, program) };
      if (options.limit) query.limit = options.limit;
      const data = await client.get(ep.path, { service: ep.service, query });
      const list = data.calls || [];
      formatOutput(list.map((c) => ({
        TIME: c.started_at ? new Date(c.started_at).toISOString() : '',
        DIR: String(c.direction || '').startsWith('out') ? 'out' : 'in',
        PEER: c.peer || '',
        SUMMARY: c.summary || '',
        TURNS: Array.isArray(c.transcript) ? c.transcript.length : 0,
      })), {
        format: program.opts().output,
        columns: ['TIME', 'DIR', 'PEER', 'SUMMARY', 'TURNS'],
        emptyMessage: 'No calls recorded yet.',
        raw: list,
      });
    });

  voice
    .command('insights')
    .description('Show aggregate call insights for the active org')
    .action(async () => {
      auth.requireAuth();
      const ep = resolveEndpoint('voice.insights.get');
      const data = await client.get(ep.path, { service: ep.service, query: { org_id: resolveOrgId(auth, program) } });
      if (program.opts().output === 'json') { console.log(JSON.stringify(data, null, 2)); return; }
      const rows = [
        { METRIC: 'Total calls', VALUE: String(data.total_calls ?? 0) },
        { METRIC: 'Inbound', VALUE: String(data.inbound ?? 0) },
        { METRIC: 'Outbound', VALUE: String(data.outbound ?? 0) },
        { METRIC: 'Total turns', VALUE: String(data.total_turns ?? 0) },
        { METRIC: 'Avg turns', VALUE: String(data.avg_turns ?? 0) },
        { METRIC: 'Avg duration (s)', VALUE: data.avg_duration_sec == null ? '-' : String(data.avg_duration_sec) },
        { METRIC: 'Last call', VALUE: data.last_call_at ? new Date(data.last_call_at).toISOString() : '-' },
      ];
      formatOutput(rows, { format: program.opts().output, columns: ['METRIC', 'VALUE'], raw: rows });
    });
}

export default registerVoiceCommands;
