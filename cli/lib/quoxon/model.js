/**
 * /model: which provider (and optionally which model) the next turns ask the server for.
 * Pure, apart from the vault list result passed in.
 *
 * The choice is a REQUEST: the stream body carries `provider` (and `model`), and the collector's
 * policy plan (resolveCollectorPolicyPlan) decides. turn.started.provider/model is the truth; when it
 * differs from what was asked, the client says so once (never a silent fallback).
 * null choice = auto (no provider in the body; the server's policy picks).
 *
 * Availability is the same source as /connect, /doctor and /capabilities (providers.js): the server's
 * capabilities, with the org vault for detail.
 * Model ids mirror src/config/modelCatalog.js (openai + anthropic rows); an id not listed is passed
 * through with a note, the server decides whether it exists.
 */
import { PROVIDERS as CONNECT, offerText } from './connect.js';
import { providerState, SUBSCRIPTION_NAME } from './providers.js';

/**
 * No hardcoded model lists for the hosted providers: OpenAI and the Claude API are listed live by the server
 * (GET /api/v1/providers/<p>/models, 1 h server cache, refreshed by /model). The Claude SUBSCRIPTION has no
 * key to list with, so it takes the Claude CLI's family aliases, which the CLI resolves to the newest model.
 */
export const CLAUDE_FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];

export const CHOICES = [
  { id: 'openai', provider: 'openai', name: 'OpenAI', vault: 'openai', connect: 'openai', discover: true, models: [] },
  { id: 'anthropic', provider: 'anthropic', name: 'Claude API', vault: 'anthropic', connect: 'anthropic', discover: true, models: [] },
  // R3: the server's signed-in Claude subscription (dev only). The stream asks for anthropic; with no Claude API
  // key the server runs it through the claude CLI on that sign-in. `via` only tells the client which row it is.
  { id: 'claude-cli', provider: 'anthropic', via: 'subscription', cap: 'claude_subscription', name: SUBSCRIPTION_NAME, aliases: CLAUDE_FAMILIES, models: [] },
  // B3: served by the chat stream; models are whatever that Ollama has installed (listed by the server).
  { id: 'ollama', provider: 'ollama', name: 'Ollama', vault: 'ollama', connect: 'ollama', dynamic: true, hint: 'http://<host>:11434', models: [] },
  // B5: OpenAI-compatible presets. Models come from the provider's own /models (api.compatModels).
  // hosted: a model is required (listed, never defaulted); selfHosted: the connection default or the first served.
  ...[
    ['openrouter', 'OpenRouter', 'openrouter', true, ''], ['huggingface', 'Hugging Face', 'huggingface', true, ''],
    ['groq', 'Groq', 'groq', true, ''], ['together', 'Together', 'together', true, ''],
    ['lmstudio', 'LM Studio', 'lmstudio', false, ' http://<host>:1234'], ['vllm', 'vLLM', 'vllm', false, ' http://<host>:8000'],
    ['custom', 'Custom', 'openai_compatible', false, ' https://<host>/v1']
  ].map(([id, name, vault, hosted, hint]) => ({ id, provider: id, name, vault, connect: id, dynamic: true, compat: true, hosted, selfHosted: !hosted, hint: hint.trim(), models: [] }))
];
const ALIASES = { 'claude-subscription': 'claude-cli', subscription: 'claude-cli', 'claude-code': 'claude-cli', gpt: 'openai', chatgpt: 'openai', claude: 'anthropic', 'claude-api': 'anthropic', 'anthropic-api': 'anthropic', local: 'ollama', hf: 'huggingface', 'lm-studio': 'lmstudio', 'openai-compatible': 'custom', openai_compatible: 'custom', default: 'auto', policy: 'auto' };
const byProvider = (p) => CHOICES.find(c => c.provider === p) || null;
/** The CHOICES row a stored choice is (the subscription row shares provider anthropic). */
const rowOf = (ch) => (ch?.via === 'subscription' ? CHOICES.find(c => c.via === 'subscription') : byProvider(ch?.provider));

/** Stored or flag value -> { provider, model? } | null. Only the two known fields survive. */
export function normChoice(v) {
  if (!v || typeof v !== 'object' || typeof v.provider !== 'string' || !byProvider(v.provider)) return null;
  const out = typeof v.model === 'string' && v.model.trim() ? { provider: v.provider, model: v.model.trim() } : { provider: v.provider };
  if (v.provider === 'anthropic' && v.via === 'subscription') out.via = 'subscription';
  // B3/B5: the Ollama / self-hosted host, for the status line before the first turn (turn.started.endpoint wins after).
  if ((v.provider === 'ollama' || byProvider(v.provider).selfHosted) && typeof v.host === 'string' && v.host.trim()) out.host = v.host.trim().slice(0, 120);
  // D3: prompt profile (compact | full); absent = the server default (compact on ollama / local presets, full elsewhere).
  if (PROFILES.includes(v.profile)) out.profile = v.profile;
  return out;
}

export const PROFILES = ['compact', 'full'];

/** "/model <provider> [model] [compact|full]" text -> { ok:true, choice } (choice null = auto) | { ok:false, error }. */
export function parseModelArg(arg) {
  const words = String(arg || '').trim().split(/\s+/).filter(Boolean);
  const profile = words.length > 1 && PROFILES.includes(String(words[words.length - 1]).toLowerCase()) ? words.pop().toLowerCase() : null;
  const [rawName, model] = words;
  const n = String(rawName || '').toLowerCase();
  const id = ALIASES[n] || n;
  if (id === 'auto') return { ok: true, choice: null };
  const c = CHOICES.find(x => x.id === id);
  if (!c) return { ok: false, error: `No provider called "${rawName}". Use ${CHOICES.map(x => x.id).join(', ')} or auto (/model lists them).` };
  const resolved = model;
  const choice = resolved ? { provider: c.provider, model: resolved } : { provider: c.provider };
  if (c.via) choice.via = c.via;
  if (profile) choice.profile = profile;
  return { ok: true, choice };
}

/** -> { state, row?, reason? } for one choice, from the shared provider status (providers.js). */
const availability = (res, c, caps) => providerState({ cap: c.cap || c.id, vault: c.vault }, caps, res);

/** QUOXON-FW6: a typed provider name or alias -> the CHOICES id, or null. */
export const providerId = (name) => {
  const n = String(name || '').trim().toLowerCase();
  const id = ALIASES[n] || n;
  return CHOICES.some(c => c.id === id) ? id : null;
};
/** The CHOICES id a stored choice is (the subscription row shares provider anthropic). */
export const choiceId = (ch) => (ch ? rowOf(ch)?.id || null : null);
/** QUOXON-FW6: the CHOICES rows usable on this server now. Never lists a provider not connected. */
export const connectedChoices = (res, caps = null) =>
  CHOICES.filter(c => c.served !== false && availability(res, c, caps).state === 'connected');

const same = (a, b) => (a?.provider || null) === (b?.provider || null) && (a?.via || null) === (b?.via || null);

/** -> [[text, tone?]] lines for /model. `caps` = api.capabilities() (the server's word on each provider). */
export function modelLines(res, current, caps = null) {
  const out = [['Model for your next turns (the server decides; turn.started shows what ran):']];
  const mark = (on) => (on ? '▸' : ' ');
  out.push([`${mark(!current)} auto  server policy picks the provider and model · /model auto`]);
  for (const c of CHOICES) {
    const a = availability(res, c, caps);
    const picked = same(current, c);
    const sel = picked && current.model ? ` · using ${current.model}` : '';
    if (c.via === 'subscription') {
      const api = availability(res, byProvider('anthropic'), caps).state === 'connected';
      if (a.state === 'connected') out.push([`${mark(picked)} ● ${c.name}  ready on this server${sel} · /model claude-cli${api ? ' (the Claude API key is used first while it is connected)' : ''}`, 'ok']);
      else if (a.state === 'unknown') out.push([`${mark(picked)} ? ${c.name}  unknown (the server did not say)`, 'warn']);
      else out.push([`${mark(picked)} ○ ${c.name}  ${a.reason || 'not signed in on this server'} · sign in from the dashboard Terminal`]);
      continue;
    }
    if (c.served === false) {
      out.push([`${mark(picked)} ${c.name}  ${a.state === 'connected' ? 'connected, but ' : ''}not served by the chat stream yet`]);
      continue;
    }
    if (c.dynamic) {
      if (a.state === 'connected') out.push([`${mark(picked)} ● ${c.name}  connected · ${a.row.label || a.row.id}${sel} · /model ${c.id} lists its ${c.compat ? '' : 'installed '}models`, 'ok']);
      else if (a.state === 'stored') out.push([`${mark(picked)} ◐ ${c.name}  stored but not the default · quox vault set-default ${a.row.id}`, 'warn']);
      else if (a.state === 'missing' || a.state === 'unavailable') out.push([`${mark(picked)} ○ ${c.name}  not connected · /connect ${c.connect}${c.hint ? ` ${c.hint}` : ''}`]);
      else out.push([`${mark(picked)} ? ${c.name}  unknown (vault not readable)${sel}`, 'warn']);
      continue;
    }
    const models = c.models.join(', ');
    if (a.state === 'connected') out.push([`${mark(picked)} ● ${c.name}  connected${sel} · /model ${c.id} [${models || 'live list'}]`, 'ok']);
    else if (a.state === 'unavailable') out.push([`${mark(picked)} ○ ${c.name}  ${a.reason || 'not available on this server'}`]);
    else if (a.state === 'stored') out.push([`${mark(picked)} ◐ ${c.name}  stored but not the default · quox vault set-default ${a.row.id}`, 'warn']);
    else if (a.state === 'missing') out.push([`${mark(picked)} ○ ${c.name}  not connected · /connect ${c.connect}`]);
    else out.push([`${mark(picked)} ? ${c.name}  unknown (vault not readable)${sel}`, 'warn']);
  }
  if (!res?.ok) out.push([`  could not read the vault: ${res?.error || 'no answer'}`, 'warn']);
  return out;
}

/**
 * The /model <arg> decision. -> { ok, choice?, text, tone? }. A provider the vault says is not usable is
 * refused (with the /connect offer), never quietly swapped for another.
 */
export function selectModel(res, arg, caps = null) {
  const p = parseModelArg(arg);
  if (!p.ok) return { ok: false, text: p.error, tone: 'warn' };
  if (!p.choice) return { ok: true, choice: null, text: 'Model: auto. The server policy picks the provider and model.', tone: 'ok' };
  const c = rowOf(p.choice);
  if (c.served === false) return { ok: false, text: `${c.name} is not served by the chat stream yet, so I can't use it here. /model lists what can.`, tone: 'warn' };
  const a = availability(res, c, caps);
  const label0 = p.choice.model ? `${c.id} ${p.choice.model}` : c.id;
  if (c.via === 'subscription') {
    if (a.state === 'unknown') return { ok: true, choice: p.choice, text: `Model: ${label0}. Could not confirm the ${c.name} is signed in; the server will say if it is not.`, tone: 'warn' };
    if (a.state !== 'connected') return { ok: false, text: `${c.name} is not ready on this server (${a.reason || 'not signed in'}). Sign in from the dashboard Terminal.`, tone: 'warn' };
    const api = availability(res, byProvider('anthropic'), caps).state === 'connected';
    return { ok: true, choice: p.choice, text: `Model: ${c.name}${p.choice.model ? ` · ${p.choice.model}` : ''}. ${api ? 'The Claude API key is connected, so the server uses it first.' : 'Your next turns ask for it.'}`, tone: api ? 'warn' : 'ok' };
  }
  if (c.id === 'anthropic' && a.state === 'missing' && availability(res, rowOf({ via: 'subscription' }), caps).state === 'connected') {
    // what --provider anthropic does: no API key, so the server runs Claude on its signed-in subscription
    return { ok: true, choice: { ...p.choice, via: 'subscription' }, text: `Model: ${label0}. The Claude API isn't connected, so your next turns run on the ${SUBSCRIPTION_NAME}.`, tone: 'warn' };
  }
  if (c.dynamic && a.state === 'missing') return { ok: false, text: `${c.name} isn't connected, so I can't use it yet. Connect it: /connect ${c.connect}${c.hint ? ` ${c.hint}` : ''}`, tone: 'warn' };
  if (a.state === 'missing') return { ok: false, text: offerText(CONNECT[c.connect]), tone: 'warn' };
  if (a.state === 'unavailable') return { ok: false, text: `${c.name} isn't available on this server${a.reason ? `: ${a.reason}` : ''}.`, tone: 'warn' };
  if (a.state === 'stored') return { ok: false, text: `${c.name} has a key stored, but not as the org default, so the server will not use it. Fix: quox vault set-default ${a.row.id}`, tone: 'warn' };
  const label = p.choice.model ? `${c.id} ${p.choice.model}` : c.id;
  const extra = p.choice.model && !c.dynamic && !c.discover && !c.models.includes(p.choice.model) ? ` ${p.choice.model} is not in this client's list; the server decides whether it exists.` : '';
  if (a.state === 'unknown') return { ok: true, choice: p.choice, text: `Model: ${label}. Could not confirm ${c.name} is connected (the server did not say); the server will say if it is not.${extra}`, tone: 'warn' };
  return { ok: true, choice: p.choice, text: `Model: ${label}. Your next turns ask for it.${extra}`, tone: extra ? 'warn' : 'ok' };
}

/** Newest-first discovered rows -> ids. */
const ids = (res) => (res?.ok && Array.isArray(res.models) ? res.models.map(modelId).filter(Boolean) : []);

/**
 * /model openai|anthropic [model] against the live list (res from api.providerModels(provider)).
 * Match order: exact id, "latest" (newest listed), a family (opus, sonnet, mini, ...) or any prefix/substring ->
 * the NEWEST match. No match -> a clear error with the list. Discovery failed -> any typed id is allowed with a
 * plain note (the provider validates it on first use). -> { ok, choice?, text, tone, models?, current? }
 */
export function selectDiscoveredModel(res, choice, row) {
  const name = row.name;
  const model = choice.model || null;
  const list = ids(res);
  const rows = res?.ok ? res.models : [];
  if (!res?.ok || !list.length) {
    const why = res?.message || res?.error || 'no answer';
    if (!model) return { ok: true, choice, text: `Model: ${row.id}. Could not list ${name}'s models (${why}); the server uses its default.`, tone: 'warn' };
    return { ok: true, choice, text: `Model: ${row.id} ${model}. Could not list ${name}'s models (${why}); ${model} is sent as typed and the provider will say if it does not exist.`, tone: 'warn' };
  }
  const newest = res.default_model || list[0];
  if (!model) return { ok: true, choice, text: `Model: ${name} · ${newest} (the newest listed). Models below; pick one with /model ${row.id} <model|family|latest>.`, tone: 'ok', models: rows, current: newest };
  const q = model.toLowerCase();
  const hit = q === 'latest' ? list[0]
    : list.find(i => i.toLowerCase() === q)
    || rows.find(r => r.family && r.family === q)?.id
    || list.find(i => i.toLowerCase().startsWith(q))
    || list.find(i => i.toLowerCase().includes(q));
  if (!hit) return { ok: false, text: `${model} is not in ${name}'s live list. Pick an id, a family (${[...new Set(rows.map(r => r.family).filter(Boolean))].slice(0, 6).join(', ') || 'see below'}) or latest.`, tone: 'warn', models: rows };
  return { ok: true, choice: { ...choice, model: hit }, text: `Model: ${name} · ${hit}${hit !== model ? ` (from "${model}")` : ''}. Your next turns ask for it.`, tone: 'ok' };
}

/** Subscription path: a Claude family alias (the CLI resolves the newest) or a full claude-* id; anything else is an error with the aliases. */
export function selectSubscriptionModel(choice) {
  const m = choice.model;
  if (!m) return { ok: true, choice, text: 'Model: claude-cli. The server default applies (the newest Sonnet unless your org set CLAUDE_CLI_DEFAULT_MODEL).', tone: 'ok' };
  const q = m.toLowerCase();
  if (CLAUDE_FAMILIES.includes(q)) return { ok: true, choice: { ...choice, model: q }, text: `Model: claude-cli ${q} (the Claude CLI resolves the newest ${q}; turn.started shows what ran).`, tone: 'ok' };
  if (q === 'latest') return { ok: true, choice: { provider: choice.provider, via: choice.via }, text: 'Model: claude-cli, the server default.', tone: 'ok' };
  if (/^claude-[a-z0-9.\-]+$/i.test(m)) return { ok: true, choice, text: `Model: claude-cli ${m}. The CLI will say if it does not exist.`, tone: 'ok' };
  return { ok: false, text: `Unknown Claude model "${m}". Use ${CLAUDE_FAMILIES.join(', ')} (the CLI picks the newest) or a full claude-* id.`, tone: 'warn' };
}

/**
 * B3: /model ollama [model] against the server's installed-model list (res from api.ollamaModels()).
 * -> { ok, choice?, text, tone, rows? } ; rows = the installed list to show.
 */
export function selectOllamaModel(res, model) {
  if (!res?.ok) {
    if (res?.error === 'not_connected') return { ok: false, text: 'Ollama is not connected. /connect ollama http://<host>:11434', tone: 'warn' };
    const why = res?.message || res?.error || 'no answer';
    return model
      ? { ok: true, choice: { provider: 'ollama', model }, text: `Model: ollama ${model}. Could not list Ollama's models (${why}); the server will say if it is missing.`, tone: 'warn' }
      : { ok: false, text: `Could not list Ollama's models: ${why}`, tone: 'warn' };
  }
  const models = Array.isArray(res.models) ? res.models : [];
  const names = models.map(m => m.name);
  const host = res.host || null;
  const withHost = (c) => (host ? { ...c, host } : c);
  if (!model) {
    const def = res.default_model || names[0] || null;
    if (!def) return { ok: false, text: `Ollama at ${host} has no models installed. On that machine run: ollama pull qwen2.5`, tone: 'warn' };
    return { ok: true, choice: withHost({ provider: 'ollama' }), text: `Model: Ollama · ${host} · ${def} (the connection's default). Installed models below; pick one with /model ollama <model>.`, tone: 'ok', models, current: def };
  }
  const hit = names.includes(model) ? model : (names.includes(`${model}:latest`) ? `${model}:latest` : null);
  if (!hit) return { ok: false, text: `${model} is not installed on ${host}. On that machine run: ollama pull ${model}`, tone: 'warn', models };
  return { ok: true, choice: withHost({ provider: 'ollama', model: hit }), text: `Model: Ollama · ${host} · ${hit}. Your next turns ask for it.`, tone: 'ok' };
}

/** One compat row of a /models list: id (strings pass through). */
const modelId = (m) => (typeof m === 'string' ? m : m?.id);

/**
 * B5: /model <preset> [model] against the provider's own /models (res from api.compatModels(preset)).
 * Hosted presets never default a model: with none given the list is shown and no choice is set.
 * -> { ok, choice?, text, tone, models?, current? }
 */
export function selectCompatModel(res, presetId, model) {
  const c = byProvider(presetId);
  const connectCmd = `/connect ${c.connect}${c.hint ? ` ${c.hint}` : ''}`;
  if (!res?.ok) {
    if (res?.error === 'not_connected') return { ok: false, text: `${c.name} is not connected. ${connectCmd}`, tone: 'warn' };
    const why = res?.message || res?.error || 'no answer';
    return model
      ? { ok: true, choice: { provider: c.provider, model }, text: `Model: ${c.id} ${model}. Could not list ${c.name}'s models (${why}); the server will say if it is missing.`, tone: 'warn' }
      : { ok: false, text: `Could not list ${c.name}'s models: ${why}`, tone: 'warn' };
  }
  const models = Array.isArray(res.models) ? res.models : [];
  const ids = models.map(modelId).filter(Boolean);
  const host = c.selfHosted ? (res.host || null) : null;
  const withHost = (ch) => (host ? { ...ch, host } : ch);
  if (!model) {
    if (c.hosted) return { ok: false, text: `${c.name} needs a model. Pick one with /model ${c.id} <model>${ids.length ? ' (listed below)' : ''}.`, tone: 'warn', models };
    const def = res.default_model || ids[0] || null;
    if (!def) return { ok: false, text: `${c.name} at ${host} serves no models yet.`, tone: 'warn' };
    return { ok: true, choice: withHost({ provider: c.provider }), text: `Model: ${c.name} · ${host} · ${def} (the connection's default). Models below; pick one with /model ${c.id} <model>.`, tone: 'ok', models, current: def };
  }
  if (ids.length && !ids.includes(model)) return { ok: false, text: `${model} is not served by ${host || c.name}. Models below.`, tone: 'warn', models };
  if (!ids.length) return { ok: true, choice: withHost({ provider: c.provider, model }), text: `Model: ${c.id} ${model}. ${c.name} listed no models; the server will say if it is missing.`, tone: 'warn' };
  return { ok: true, choice: withHost({ provider: c.provider, model }), text: `Model: ${c.name}${host ? ` · ${host}` : ''} · ${model}. Your next turns ask for it.`, tone: 'ok' };
}

/**
 * Z2H-3B: after a successful /connect, should the new provider become the active choice? Yes when the current
 * selection is not a working connected provider (nothing connected, or a saved/phantom choice that is not connected),
 * or when auto has no OTHER connected provider to pick. No provider is a silent default: with another working one
 * active, nothing changes and the caller keeps its "Use it: /model <id>" hint.
 * -> { adopt:true, choice, line } | { adopt:false }. `vault`/`caps` are re-read AFTER the connect.
 */
export function adoptAfterConnect({ vault, caps, current, id, host = null, model = null }) {
  const row = CHOICES.find(c => c.id === id);
  if (!row) return { adopt: false };
  const connected = (c) => availability(vault, c, caps).state === 'connected';
  const cur = current ? rowOf(current) : null;
  const curWorks = cur && cur.id !== row.id && connected(cur);
  const othersConnected = CHOICES.some(c => c.id !== row.id && connected(c));
  if (curWorks) return { adopt: false };
  if (!current && othersConnected) return { adopt: false };
  const choice = normChoice({ provider: row.provider, ...(model ? { model } : {}), ...(host ? { host } : {}) });
  return { adopt: true, choice, line: `Using ${row.name}${model ? ` ${model}` : ''} now. /model to change.` };
}

/** Status-line text: what the server said it ran, else what is selected; null for auto before any turn (keeps the line short). */
export function modelLabel(ctx, choice) {
  if (ctx?.model && ctx.provider === 'anthropic' && ctx.auth === 'subscription') return `claude-cli ${ctx.model}`;
  if (ctx?.model && ctx.provider === 'ollama') return `Ollama · ${ctx.endpoint || choice?.host || '?'} · ${ctx.model}`;
  const cc = ctx?.provider ? byProvider(ctx.provider) : null;
  if (ctx?.model && cc?.compat) return cc.hosted ? `${cc.name} · ${ctx.model}` : `${cc.name} · ${ctx.endpoint || choice?.host || '?'} · ${ctx.model}`;
  if (ctx?.model) return ctx.provider ? `${ctx.provider} ${ctx.model}` : ctx.model;
  if (!choice) return null;
  if (choice.via === 'subscription') return choice.model ? `claude-cli ${choice.model}` : 'claude-cli';
  if (choice.provider === 'ollama') return `Ollama · ${choice.host || '?'} · ${choice.model || 'default model'}`;
  const ch = byProvider(choice.provider);
  if (ch?.compat) return ch.hosted ? `${ch.name} · ${choice.model || 'pick a model'}` : `${ch.name} · ${choice.host || '?'} · ${choice.model || 'default model'}`;
  return choice.model ? `${choice.provider} ${choice.model}` : choice.provider;
}

/** One line when turn.started shows the server ran something other than what was asked; else null. */
export function fallbackNote(choice, ev) {
  if (!choice || !ev || ev.type !== 'turn.started' || !ev.provider) return null;
  const ran = `${ev.provider}${ev.model ? ` ${ev.model}` : ''}`;
  if (ev.provider !== choice.provider) return `You asked for ${choice.provider}; the server ran ${ran} (its policy or a fallback). /model shows what is connected.`;
  if (choice.model && ev.model && ev.model !== choice.model) return `You asked for ${choice.model}; the server ran ${ran}.`;
  return null;
}

/** Fields for the stream body. */
export const streamFields = (choice) => (choice ? { provider: choice.provider, ...(choice.model ? { model: choice.model } : {}), ...(choice.profile ? { promptProfile: choice.profile } : {}) } : {});
