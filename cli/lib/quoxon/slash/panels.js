/**
 * Pure panel models for /status, /context and /doctor, rendered with the /help view (head + key/value rows).
 * Every value comes from the caller's real data; anything not known is said plainly, never filled in.
 */
import { capabilityMap } from './palette.js';
import { CHOICES } from '../model.js';
import { providerState, capabilityName } from '../providers.js';

const n = (v) => Number(v || 0).toLocaleString('en-US');
const row = (key, text) => ({ kind: 'row', key, text: String(text) });

export function healthText(hl) {
  if (!hl) return '? not checked';
  if (hl.ok) return `✔ answering (HTTP ${hl.status})`;
  if (hl.absent) return `✖ nothing running there (${hl.status})`;
  return `✖ not healthy (${hl.status})`;
}

/** What actually ran (turn.started), else what was asked for, said as such. */
export function modelText(ctx = {}, choice = null) {
  if (ctx.provider || ctx.model) return `${[ctx.provider, ctx.model].filter(Boolean).join(' ')} (as the server last reported)`;
  const ask = choice ? [choice.provider, choice.model].filter(Boolean).join(' ') : 'auto (server policy)';
  return `no turn yet; asking for ${ask}`;
}

export function statusModel(d = {}) {
  return [
    { kind: 'head', text: 'Status' },
    row('Profile', d.profile || '?'),
    row('Org', d.org || '? not in this login'),
    row('Server', `${d.serverUrl || '?'} · ${healthText(d.health)}`),
    row('Model', modelText(d.ctx, d.choice)),
    row('Agent', d.agent || 'CommanderQ (quox)'),
    row('Slot', d.slot || 'none (/slot <name>)'),
    row('Session', d.sessionName || 'unnamed (/rename <name>)'),
    row('Conversation', d.conversationId || 'new (starts with your next message)'),
    row('Version', d.version || '?'),
    ...(d.local ? [{ kind: 'dim', text: 'Server health not re-checked for this tip; /status checks it live.' }] : [])
  ];
}

export function contextModel(d = {}) {
  const rules = d.rules;
  const ruleFiles = rules?.files || [];
  const out = [
    { kind: 'head', text: 'Context' },
    row('Model', modelText(d.ctx, d.choice)),
    row('Conversation', !d.conversationId ? 'new, nothing sent yet' : d.server ? `${d.server.tokensText}${d.server.turnsText ? ` · ${d.server.turnsText}` : ''}` : `${n(d.tokens)} tokens reported so far in this session${d.serverError ? ` (server context: ${d.serverError})` : ''}`),
    ...(d.conversationId && d.server ? [row('Summary', d.server.summaryText)] : []),
    row('Rules', d.rulesOn === false ? 'off for this session (/rules on)' : ruleFiles.length ? `${ruleFiles.length} QUOX.md file${ruleFiles.length === 1 ? '' : 's'}, ${n(rules.totalChars)} chars${rules.truncated ? ' (truncated to fit)' : ''}` : 'none loaded')
  ];
  if (d.rulesOn !== false) for (const f of ruleFiles) out.push({ kind: 'dim', key: '', text: `  ${f.label || f.path}  ${n(f.chars)} chars` });
  const sk = d.skills;
  out.push(row('Skills', !sk ? '? not checked (/context checks it live)' : sk.ok ? `${sk.count} available in your org (/skills)` : `? ${sk.error}`));
  const mem = d.memory;
  out.push(row('Memory', !mem ? '? not checked (/context checks it live)' : mem.ok ? 'connected (persistent memory answers)' : `not reachable: ${mem.error}`));
  out.push(row('Agent', d.agent || 'CommanderQ (quox)'));
  return out;
}

const icon = (s) => (s === 'pass' ? '✔' : s === 'warn' ? '⚠' : s === 'skip' ? '·' : '✖');

/** checks: [{ name, status:'pass'|'warn'|'fail'|'error'|'skip', detail?, latency_ms? }] */
export function doctorModel(platform, chat, platformError = null) {
  const rowOf = (c) => ({ kind: c.status === 'skip' ? 'dim' : 'row', key: `${icon(c.status)} ${c.name}`, text: [c.detail, c.latency_ms != null ? `${c.latency_ms}ms` : null].filter(Boolean).join(' · ') || (c.status === 'pass' ? 'ok' : c.status) });
  const out = [{ kind: 'head', text: 'Doctor' }];
  if (platformError) out.push(row('✖ quox doctor', platformError));
  for (const c of platform || []) out.push(rowOf(c));
  out.push({ kind: 'gap' }, { kind: 'head', text: 'Chat' });
  for (const c of chat || []) out.push(rowOf(c));
  const all = [...(platform || []), ...(chat || [])];
  const count = (s) => all.filter(c => c.status === s || (s === 'fail' && c.status === 'error')).length;
  out.push({ kind: 'gap' }, { kind: 'dim', text: `${count('pass')} passed · ${count('warn')} warning${count('warn') === 1 ? '' : 's'} · ${count('fail')} failed` });
  return out;
}

/** Chat checks, each on its own: the chat routes answer, a provider is connected, the capability contract. */
export async function chatChecks(api, providerTypes = ['openai', 'anthropic', 'ollama']) {
  const one = async (name, fn) => { try { return { name, ...(await fn()) }; } catch (e) { return { name, status: 'fail', detail: e?.status ? `HTTP ${e.status} ${e.message || ''}`.trim() : (e?.message || 'failed') }; } };
  return Promise.all([
    one('Chat server', async () => {
      if (!api.conversations) return { status: 'skip', detail: 'not available in this mode' };
      const t0 = Date.now(); await api.conversations(1);
      return { status: 'pass', detail: 'conversation routes answer for this login', latency_ms: Date.now() - t0 };
    }),
    one('AI provider', async () => {
      if (!api.connections) return { status: 'skip', detail: 'not available in this mode' };
      // The same provider status as /model and /connect (providers.js): the server's capabilities first.
      const [r, caps] = await Promise.all([api.connections(), api.capabilities ? api.capabilities() : null]);
      const ready = CHOICES.filter(c => providerState({ cap: c.cap || c.id, vault: c.vault }, caps, r).state === 'connected').map(c => c.name);
      if (ready.length) return { status: 'pass', detail: `ready: ${ready.join(', ')}` };
      if (!r.ok && !caps?.ok) return { status: 'fail', detail: `could not read the vault: ${r.error}` };
      return { status: 'warn', detail: 'no AI provider is ready; /connect openai' };
    }),
    one('Capabilities', async () => {
      if (!api.capabilities) return { status: 'skip', detail: 'not available in this mode' };
      const res = await api.capabilities();
      if (res && res.ok === false) return res.missing ? { status: 'warn', detail: 'this server has no capability contract yet (GET /api/v1/capabilities)' } : { status: 'fail', detail: res.error || 'failed' };
      const m = capabilityMap(res);
      if (!m) return { status: 'warn', detail: 'unexpected capability response' };
      const names = (a) => res.capabilities.filter(c => c?.availability === a).map(capabilityName);
      const off = names('unavailable'), setup = names('requires_setup');
      const more = (l) => `${l.slice(0, 4).join(', ')}${l.length > 4 ? ` +${l.length - 4} more` : ''}`;
      const parts = [`${Object.keys(m).length} known`];
      if (off.length) parts.push(`unavailable here: ${more(off)}`);
      if (setup.length) parts.push(`needs setup: ${more(setup)}`);
      if (!off.length && !setup.length) parts.push('all available');
      return { status: off.length ? 'warn' : 'pass', detail: parts.join(', ') };
    })
  ]);
}
