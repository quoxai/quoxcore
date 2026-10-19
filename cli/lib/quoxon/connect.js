/**
 * /connect: connections status, the secure key card's logic, the composer paste guard and the
 * gentle "connect it now?" offer. Pure, apart from the api object passed in.
 *
 * Where a key goes (the path /chat/stream reads): the org's DEFAULT QuoxVault credential of the
 * provider's integration type. The collector resolves OpenAI via auth /internal/resolve ->
 * credentialResolver.resolveProviderKey(org, 'openai') -> getDefaultCredential(org, 'openai').
 * The write is auth POST /api/orgs/:orgId/vault (alias of /integrations: SECRETS_WRITE gated,
 * audited, AEE envelope carrying integration_type + label only). The label is "<Name> …last4",
 * so the audit trail holds a fingerprint and never the key.
 *
 * The key itself lives only inside a secret box (closure). It is never dispatched, never put in
 * the composer buffer or history, never sent to the chat stream, never written to a transcript.
 */

import { askText } from './ask.js';
import { consentCovers, connectConsentNote, needsConsent, providerLabel } from './consent.js';
import { providerState, SUBSCRIPTION_NAME } from './providers.js';
import { isLoopbackUrl, detectLanIp } from './hostUrls.js';
import { cmd } from './palette.js';

export const PROVIDERS = {
  openai: {
    id: 'openai', type: 'openai', name: 'OpenAI', field: 'api_key', card: true, minLen: 20,
    why: 'Quox needs an OpenAI key to use GPT models for your org.',
    keyUrl: 'https://platform.openai.com/api-keys'
  },
  anthropic: {
    id: 'anthropic', type: 'anthropic', name: 'Claude API', field: 'api_key', card: true, minLen: 20,
    why: 'Quox needs an Anthropic API key to call Claude models for your org.',
    keyUrl: 'https://console.anthropic.com/settings/keys'
  },
  // B3: no key; a server URL. /connect ollama <url> probes it server side, then saves.
  ollama: { id: 'ollama', type: 'ollama', name: 'Ollama', card: false, url: true },
  // B5: hosted OpenAI-compatible presets. Same secure key card; the third-party data path is stated on it.
  openrouter: hosted('openrouter', 'OpenRouter', 'api_key', 'https://openrouter.ai/settings/keys',
    "OpenRouter, which passes them to the model's provider"),
  huggingface: hosted('huggingface', 'Hugging Face', 'api_token', 'https://huggingface.co/settings/tokens',
    "Hugging Face, which passes them to the inference provider that serves the model"),
  groq: hosted('groq', 'Groq', 'api_key', 'https://console.groq.com/keys', 'Groq'),
  together: hosted('together', 'Together', 'api_key', 'https://api.together.ai/settings/api-keys', 'Together AI'),
  // B5: self-hosted OpenAI-compatible servers: no key, a URL. Probed server side, then saved.
  lmstudio: selfHosted('lmstudio', 'LM Studio', 1234),
  vllm: selfHosted('vllm', 'vLLM', 8000),
  // B5: any https OpenAI-compatible base URL, key optional (asked for only when the server needs one).
  custom: {
    id: 'custom', type: 'openai_compatible', name: 'Custom', field: 'api_key', card: false, url: true, custom: true, minLen: 8,
    why: 'This endpoint wants an API key. It is stored in your org vault with the base URL.',
    keyUrl: 'the provider of that endpoint',
    disclosure: 'Custom endpoint: your prompts and tool results leave this server for that URL. Unless it is your own server, that is a third party. Your own AI data sharing consent applies (/consent).'
  }
};
function hosted(id, name, field, keyUrl, who) {
  return {
    id, type: id, name, field, card: true, hosted: true, minLen: 20, keyUrl,
    why: `Quox needs a ${name} key to use ${name} models for your org.`,
    disclosure: `Hosted: your prompts and tool results leave this server for ${who}. Your own AI data sharing consent applies (/consent).`
  };
}
function selfHosted(id, name, port) {
  return { id, type: id, name, card: false, url: true, selfHosted: true, port };
}
const ALIASES = {
  'anthropic-api': 'anthropic', claude: 'anthropic', gpt: 'openai', chatgpt: 'openai',
  hf: 'huggingface', 'lm-studio': 'lmstudio', 'openai-compatible': 'custom', openai_compatible: 'custom'
};
export const providerFor = (name) => PROVIDERS[ALIASES[String(name || '').toLowerCase()] || String(name || '').toLowerCase()] || null;

// ---- paste guard -------------------------------------------------------------------------------
const ANTHROPIC_RE = /\bsk-ant-[A-Za-z0-9_-]{16,}/;
const OPENROUTER_RE = /\bsk-or-(?:v1-)?[A-Za-z0-9_-]{16,}/;
const GROQ_RE = /\bgsk_[A-Za-z0-9]{20,}/;
const HF_RE = /\bhf_[A-Za-z0-9]{20,}/;
const OPENAI_RE = /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/;

/** -> { provider } when the text carries something API-key shaped, else null. */
export function looksLikeKey(text) {
  const s = String(text || '');
  if (ANTHROPIC_RE.test(s)) return { provider: 'anthropic' };
  if (OPENROUTER_RE.test(s)) return { provider: 'openrouter' }; // must win over the generic sk- shape
  if (GROQ_RE.test(s)) return { provider: 'groq' };
  if (HF_RE.test(s)) return { provider: 'huggingface' };
  if (OPENAI_RE.test(s)) return { provider: 'openai' };
  return null;
}
export const keyWarning = (hit) => `That looks like an API key. I didn't send it. Use /connect ${hit?.provider || 'openai'} to store it safely.`;

// ---- masked input ------------------------------------------------------------------------------
/** Bullets while typing; after a paste, four bullets and the last 4 (enough to recognise the key). */
export function maskSecret(value, pasted) {
  const v = String(value || '');
  if (!v) return '';
  if (pasted && v.length >= 8) return `••••${v.slice(-4)}`;
  return '•'.repeat(Math.min(v.length, 32));
}

/** Holds the secret in a closure. Serialising the box shows nothing. */
export function createSecretBox() {
  let v = ''; let pasted = false;
  const clean = (t) => String(t || '').replace(/[\s\x00-\x1f\x7f]+/g, '');
  return {
    type(t) { v += clean(t); },
    paste(t) { v += clean(t); pasted = true; },
    backspace() { v = [...v].slice(0, -1).join(''); if (!v) pasted = false; },
    clear() { v = ''; pasted = false; },
    length: () => v.length,
    last4: () => v.slice(-4),
    mask: () => maskSecret(v, pasted),
    /** Hands the value out once and empties the box. */
    take() { const out = v; v = ''; pasted = false; return out; },
    toJSON: () => '[secret]',
    toString: () => '[secret]'
  };
}

// ---- connections status ------------------------------------------------------------------------
const testTag = (r) => r.test_status === 'success' ? 'tested ✔' : r.test_status === 'failed' ? 'last test failed' : 'untested';
export const pickRow = (rows, type) => {
  const of = rows.filter(r => r.integration_type === type);
  return { def: of.find(r => r.is_default === 1 || r.is_default === true) || null, any: of[0] || null };
};

/**
 * -> [[text, tone?]] lines for /connect. `res` is { ok:true, rows } from the vault list, or { ok:false, error };
 * `caps` is the server's capabilities answer, the source of truth for whether each provider is usable
 * (providers.js, shared with /model and /doctor). Anything neither can answer is "? unknown".
 */
export function connectionLines(res, caps = null) {
  const STATUS_PROVIDERS = [PROVIDERS.openai, PROVIDERS.anthropic, PROVIDERS.ollama, PROVIDERS.openrouter, PROVIDERS.huggingface, PROVIDERS.groq, PROVIDERS.together, PROVIDERS.lmstudio, PROVIDERS.vllm, PROVIDERS.custom];
  const out = [];
  const ok = res && res.ok && Array.isArray(res.rows);
  const rows = ok ? res.rows : [];
  out.push(['Connections for this org:']);
  for (const p of STATUS_PROVIDERS) {
    const hint = p.custom ? '/connect custom https://<host>/v1' : p.card ? `/connect ${p.id}` : p.url ? `/connect ${p.id} http://<host>:${p.port || 11434}` : `quox vault create --type ${p.type}`;
    const st = providerState({ cap: p.id, vault: p.type }, caps, res);
    const def = st.row;
    if (st.state === 'unknown') out.push([`? ${p.name}  unknown (vault not readable)`, 'warn']);
    else if (st.state === 'connected' && def) out.push([`● ${p.name}  connected · ${def.label || def.id} · ${testTag(def)}`, def.test_status === 'failed' ? 'warn' : 'ok']);
    else if (st.state === 'connected') out.push([`● ${p.name}  ready on this server (an instance-wide key, not in your org vault)`, 'ok']);
    else if (st.state === 'stored') out.push([`◐ ${p.name}  stored but not the default · quox vault set-default ${st.row.id}`, 'warn']);
    else if (st.state === 'unavailable') out.push([`○ ${p.name}  not available here${st.reason ? `: ${st.reason}` : ''}`]);
    else out.push([`○ ${p.name}  not connected · ${hint}`]);
  }
  const sub = providerState({ cap: 'claude_subscription' }, caps, res);
  if (sub.state === 'connected') out.push([`● ${SUBSCRIPTION_NAME}  ready on this server · /model claude-cli`, 'ok']);
  else if (sub.state === 'unknown') out.push([`? ${SUBSCRIPTION_NAME}  unknown (the server did not say)`, 'warn']);
  else out.push([`○ ${SUBSCRIPTION_NAME}  ${sub.reason || 'not signed in on this server'} · sign in from the dashboard Terminal`]);
  if (!ok) { out.push([`  could not read the vault: ${res?.error || 'no answer'}`, 'warn']); return out; }
  const known = new Set(Object.values(PROVIDERS).map(p => p.type));
  const others = new Map();
  for (const r of rows) {
    if (known.has(r.integration_type)) continue;
    const cur = others.get(r.integration_type);
    if (!cur || (r.is_default && !cur.is_default)) others.set(r.integration_type, r);
  }
  const list = [...others.values()];
  if (list.length) {
    out.push(['Integrations in your vault:']);
    for (const r of list.slice(0, 12)) out.push([`● ${r.integration_type}  ${r.label || r.id} · ${testTag(r)}`, r.test_status === 'failed' ? 'warn' : undefined]);
    if (list.length > 12) out.push([`  +${list.length - 12} more · quox vault list`]);
  } else {
    out.push(['No other integrations yet. Connect Slack, GitHub, email and more with quox vault create --type <type>.']);
  }
  out.push(['  An instance-wide key set by your admin can also serve chat; it is not visible from here.']);
  return out;
}

// ---- gentle offer ------------------------------------------------------------------------------
const MISSING = [
  [/openai[^.]*?(api key )?(not configured|not connected|missing|no api key)/i, 'openai'],
  [/(anthropic|claude api)[^.]*?(api key )?(not configured|not connected|missing|no api key)/i, 'anthropic']
];
export const offerText = (p) => `Ⓠ ${p.name} isn't connected, so I can't use it yet. Connect it now? /connect ${p.id}`;

/** -> the one-line offer when an event says a provider is missing, else null. */
export function connectOfferFor(ev) {
  if (!ev || typeof ev !== 'object') return null;
  if (ev.available === false && ev.provider) { const p = providerFor(ev.provider); return p?.card ? offerText(p) : null; }
  if (ev.type !== 'error' && ev.type !== 'turn.finished') return null;
  const s = [ev.error, ev.message, ev.detail].filter(x => typeof x === 'string').join(' ');
  for (const [re, id] of MISSING) if (re.test(s)) return offerText(PROVIDERS[id]);
  return null;
}

// ---- save flow ---------------------------------------------------------------------------------
const scrubOut = (s, secret) => {
  let t = String(s || '');
  if (secret) t = t.split(secret).join('[key]');
  return t.replace(/\b(?:sk-|gsk_|hf_)[A-Za-z0-9_-]{6,}/g, '[key]');
};

/**
 * Server-side live test first (nothing persisted), then the governed vault write as the org default.
 * -> { ok, provider, last4, text } ; text is safe to show and to record.
 */
export async function connectFlow(api, providerId, secret, extra) {
  const p = providerFor(providerId);
  if (!p?.card && !p?.custom) return { ok: false, provider: providerId, text: `${providerId} cannot be connected from here.` };
  const key = String(secret || '');
  if (key.length < p.minLen) return { ok: false, provider: p.id, text: `That is too short to be a ${p.name} key. Paste the whole key, or Esc to cancel.` };
  const last4 = key.slice(-4);
  const credentials = { ...(p.custom && extra ? { base_url: extra.base_url, ...(extra.default_model ? { default_model: extra.default_model } : {}) } : {}), [p.field]: key };
  const label = p.custom && extra?.host ? `${p.name} · ${extra.host} …${last4}` : `${p.name} …${last4}`;
  let t;
  try { t = await api.testProviderKey({ type: p.type, credentials }); }
  catch (e) { t = { ok: false, unreachable: true, message: e?.message }; }
  if (!t?.ok) {
    const why = scrubOut(t?.message || 'no reason given', key);
    return { ok: false, provider: p.id, last4, text: t?.unreachable || t?.status >= 500
      ? `✖ Could not test the key (${why}). Nothing was saved.`
      : `✖ ${p.name} rejected the key: ${why}. Nothing was saved.` };
  }
  let s;
  try { s = await api.saveProviderKey({ type: p.type, label, credentials, isDefault: true }); }
  catch (e) { s = { ok: false, status: e?.status, message: e?.message }; }
  if (!s?.ok && s?.status === 409) return { ok: false, provider: p.id, last4, text: `This key is already in your vault as "${label}". /connect shows its status.` };
  if (!s?.ok) {
    const why = scrubOut(s?.message || 'failed', key);
    const role = s?.status === 403 ? ' Storing org keys needs the secrets.write capability; ask an org admin.' : '';
    return { ok: false, provider: p.id, last4, text: `✖ The key tested fine but was not saved (${s?.status ? `HTTP ${s.status}: ` : ''}${why}).${role}` };
  }
  return { ok: true, provider: p.id, last4, text: `✔ ${p.name} connected · key …${last4} · tested`, ...(p.disclosure ? { disclosure: p.disclosure } : {}) };
}

/** QUOXON-Z2H lane R: the one consent question asked after a cloud connect. Default No: cloud processing stays opt-in. */
export const consentAskLine = (type) => askText(`Allow Quox to send your conversations to ${providerLabel(type)}?`, { keys: 'y/N', who: 'Quox', action: `send your messages and any tool results to ${providerLabel(type)}, a third party, when it answers`, reason: 'Nothing is sent until you say yes; withdraw it any time in Settings > Privacy.' }) // no consent yet: nothing to chat with;

// ---- card controller ---------------------------------------------------------------------------
/**
 * Owns the open card and its secret box. The app routes every input event here while the card is
 * open (onEvent returns true = consumed), and renders view(). note(text, tone) shows a line; emit(a)
 * dispatches a transcript-visible action (only connect.started / connect.saved, provider + last4).
 */
export function createConnectController({ api, note, emit, refresh }) {
  const box = createSecretBox();
  let card = null;
  const close = () => { box.clear(); card = null; refresh(); };
  async function submit() {
    if (!box.length()) { card.error = 'Paste your key first, or Esc to cancel.'; refresh(); return; }
    card.phase = 'saving'; card.error = null; refresh();
    const p = card.provider;
    const extra = card.extra;
    const r = await connectFlow(api, p.id, box.take(), extra);
    if (!card) return;
    if (r.ok) {
      card = null; refresh();
      emit({ type: 'connect.saved', provider: p.id, last4: r.last4 });
      note(r.text, 'ok');
      if (r.disclosure) note(r.disclosure, 'warn');
      note('Your next turns can use it. Servers cache keys briefly, so allow up to a minute.');
      await askConsent(p.type); // never meet the consent error cold: ask now, once
      return;
    }
    card.phase = 'input'; card.error = r.text; refresh();
  }
  /**
   * QUOXON-Z2H lane R: when `type` is a cloud provider and this user's OK is not in place, open the card on
   * the consent question. y records it (the user's own direct act, POST /api/consent); anything else leaves
   * it off and says how to give it later. -> true when the question opened.
   */
  async function askConsent(type) {
    if (!needsConsent(type) || !api.consentStatus) return false;
    let rec = null; try { rec = await api.consentStatus(); } catch { rec = null; }
    if (consentCovers(rec, type)) return false;
    if (!api.grantConsent) { note(connectConsentNote(type), 'warn'); return false; }
    box.clear();
    card = { provider: providerFor(type) || Object.values(PROVIDERS).find((x) => x.type === type) || { id: type, type, name: providerLabel(type) }, phase: 'consent', consentType: type, error: null, question: consentAskLine(type) };
    refresh();
    return true;
  }
  async function answerConsent(yes) {
    const type = card.consentType;
    if (!yes) { close(); note(`Left off: nothing goes to ${providerLabel(type)} until you say so. ${connectConsentNote(type)}`, 'warn'); return; }
    card.phase = 'saving'; refresh();
    try {
      await api.grantConsent(type);
      close(); note(`✔ Your OK is recorded: ${providerLabel(type)} can now answer. Withdraw it any time: quox consent list, or Settings > Privacy.`, 'ok');
    } catch (e) {
      close(); note(`Quox could not record your OK (${e?.message || e}). Nothing was sent. Try /consent grant ${type}.`, 'warn');
    }
  }
  /**
   * #1288: "Connect to <host>? It's on your private network." y/N. y runs offer.retry() (the save with a
   * confirm for that exact origin) and hands its result to after(); n, Enter or Esc saves nothing.
   */
  function askPrivate(offer, after) {
    box.clear();
    card = {
      provider: PROVIDERS.ollama || { id: 'ollama', type: 'ollama', name: 'Ollama' },
      phase: 'private', error: null, privateOffer: offer, privateAfter: after,
      question: askText(`Connect to ${offer.host}?`, { keys: 'y/N', who: 'Quox', reason: "It's on your private network", action: `save ${offer.origin} as your org's Ollama. Only this address is allowed, after the server checks it answers as Ollama. Needs an org admin.` })
    };
    refresh();
    return true;
  }
  async function answerPrivate(yes) {
    const { privateOffer: offer, privateAfter: after } = card;
    if (!yes) { close(); note(`Left blocked: ${offer.host} was not connected. Nothing was saved.`); return; }
    card.phase = 'saving'; refresh();
    let r;
    try { r = await offer.retry(); } catch (e) { r = { ok: false, lines: [[`✖ ${e?.message || e}. Nothing was saved.`, 'warn']] }; }
    close();
    for (const [t, tone] of r.lines || []) note(t, tone);
    if (after) await after(r);
  }
  return {
    askConsent,
    askPrivate,
    isOpen: () => Boolean(card),
    view: () => (card ? { card: { ...card }, mask: box.mask() } : null),
    /** -> true when a card opened. */
    open(name) {
      const p = providerFor(name);
      if (!p) { note(`Nothing called "${name}" to connect. /connect lists what is available.`, 'warn'); return false; }
      if (p.custom) { note('Custom endpoints take a URL first: /connect custom https://<host>/v1 [model]'); return false; }
      if (!p.card) { note(p.url ? `${p.name} takes a server URL, not a key: /connect ${p.id} http://<host>:${p.port || 11434} [model]` : `${p.name} takes a server URL, not a key. Add it with: quox vault create --type ${p.type}`); return false; }
      if (!api.testProviderKey || !api.saveProviderKey) { note('Connecting is not available in this mode.', 'warn'); return false; }
      box.clear(); card = { provider: p, phase: 'input', error: null };
      emit({ type: 'connect.started', provider: p.id });
      refresh();
      return true;
    },
    /** B5: open the key card for a custom endpoint that answered 401/403; extra = { base_url, host, default_model? }. */
    openCustom(extra) {
      if (!api.testProviderKey || !api.saveProviderKey) { note('Connecting is not available in this mode.', 'warn'); return false; }
      box.clear(); card = { provider: PROVIDERS.custom, phase: 'input', error: null, extra, subtitle: extra.host };
      emit({ type: 'connect.started', provider: 'custom' });
      refresh();
      return true;
    },
    onEvent(e) {
      if (!card) return false;
      if (card.phase === 'saving') return true;
      if (card.phase === 'private') {
        if (e.type === 'text' && /^y(es)?$/i.test(String(e.text).trim())) { answerPrivate(true); return true; }
        if ((e.type === 'text' && /^n(o)?$/i.test(String(e.text).trim())) || (e.type === 'key' && ['enter', 'escape', 'ctrl-c'].includes(e.name))) { answerPrivate(false); return true; }
        return true; // the question takes only y or n
      }
      if (card.phase === 'consent') {
        if (e.type === 'text' && /^y(es)?$/i.test(String(e.text).trim())) { answerConsent(true); return true; }
        if ((e.type === 'text' && /^n(o)?$/i.test(String(e.text).trim())) || (e.type === 'key' && ['enter', 'escape', 'ctrl-c'].includes(e.name))) { answerConsent(false); return true; }
        return true; // the question takes only y or n
      }
      if (e.type === 'paste') { box.paste(e.text); card.error = null; refresh(); return true; }
      if (e.type === 'text') { box.type(e.text); card.error = null; refresh(); return true; }
      if (e.type !== 'key') return true;
      if (e.name === 'escape' || e.name === 'ctrl-c') { close(); note('Cancelled. Nothing was stored.'); return true; }
      if (e.name === 'enter') { submit(); return true; }
      if (e.name === 'backspace') { box.backspace(); refresh(); return true; }
      if (e.name === 'kill-line' || e.name === 'delete-word') { box.clear(); refresh(); return true; }
      return true; // every other key is swallowed by the card
    }
  };
}


// ---- private-network refusal: explain it, offer the instance gate, retry once --------------------
/** The vault refused the base URL because the address is private (HTTP 400, SSRF guard). */
export const isPrivateNetworkError = (s) => s?.status === 400 && /private|internal/i.test(s?.message || '');

const WHO_CAN = [
  'Only an instance admin can allow this. Ask one to run:',
  '  quox server config lan-targets on'
];

/**
 * The save failed because the address is on a private network. -> { ok:false, lines, lanOffer? }.
 * An admin gets a card and { lanOffer } (the app keeps it for "/connect yes"); anyone else is told
 * who can. `retry` re-runs the same connect once the gate is on.
 */
/** The true scope of a saved private address: the instance gate is server-wide, not per connection. */
function privateScopeNote(origin) {
  return [
    [`  ${origin} is a private address. This Quox server allows private-network`],
    ['  addresses for AI and monitoring connections. Turn off: quox server config lan-targets off']
  ];
}

export async function lanGateCard(api, name, retry, { retried } = {}) {
  const lines = [[`✖ ${name} is on a private network, so Quox did not save it.`, 'warn']];
  const st = api.lanTargets ? await api.lanTargets() : null;
  if (retried || st?.enabled) {
    lines.push(['  Private-network targets are already on, so Quox still refuses this address.']);
    lines.push(['  Loopback and link-local addresses are always blocked. Use the machine\'s LAN address.']);
    return { ok: false, lines };
  }
  lines.push(['  Quox blocks private addresses by default, so an AI cannot be pointed at internal services.']);
  if (!api.setLanTargets || st?.status === 403) {
    for (const l of WHO_CAN) lines.push([l, l.startsWith('  ') ? undefined : 'warn']);
    return { ok: false, lines };
  }
  lines.push(['  Allowing it applies to every AI and monitoring connection on this Quox server,']);
  lines.push(['  not just this one. Loopback and link-local stay blocked. Turn off later:']);
  lines.push(['    quox server config lan-targets off']);
  lines.push(['  Allow it and connect now? /connect yes   (leave it blocked: /connect no)', 'warn']);
  return { ok: false, lines, lanOffer: { name, retry } };
}

/** "/connect yes": set the gate, then run the connect once more. Never offers a second time. */
export async function confirmLanAllow(api, offer) {
  if (!offer?.retry) return { ok: false, lines: [['Nothing to confirm. Run /connect again.', 'warn']] };
  const set = await api.setLanTargets(true);
  if (!set?.ok) {
    if (set?.status === 403) return { ok: false, lines: [['✖ Only an instance admin can allow that. Nothing was changed.', 'warn'], ...WHO_CAN.map(l => [l])] };
    return { ok: false, lines: [[`✖ Could not turn it on (${set?.status ? `HTTP ${set.status}: ` : ''}${set?.message || 'failed'}). Nothing was saved.`, 'warn']] };
  }
  const r = await offer.retry();
  return { ...r, lines: [['✔ Private-network targets are on for this instance. Retrying…', 'ok'], ...r.lines] };
}

// ---- Ollama (B3): a server URL, no key -----------------------------------------------------------
/** "/connect ollama <url> [model]" rest -> { url, model } ; a bare host gets http:// and :11434. */
export function parseOllamaArg(rest) {
  const [rawUrl, model] = String(rest || '').trim().split(/\s+/);
  if (!rawUrl) return { url: null, model: null };
  let url = rawUrl;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    url = `http://${url}`;
    try { const u = new URL(url); if (!u.port) { u.port = '11434'; url = u.toString().replace(/\/$/, ''); } } catch { /* the server says why */ }
  }
  return { url, model: model || null };
}

// Families whose Ollama builds accept tools (prefer one as the chat default).
const TOOL_FAMILIES = /^(qwen2\.5|qwen3|llama3\.[123]|mistral|mistral-nemo|mistral-small|command-r|hermes3|granite3|firefunction|nemotron|gpt-oss|smollm2)/i;
export const likelyToolCapable = (name) => TOOL_FAMILIES.test(String(name || ''));

/** The chat default: the asked model, else the first likely tool-capable one, else the first. */
export function pickOllamaDefault(models, asked) {
  const names = (Array.isArray(models) ? models : []).map(m => (typeof m === 'string' ? m : m?.name)).filter(Boolean);
  if (asked) {
    if (names.includes(asked)) return asked;
    return names.includes(`${asked}:latest`) ? `${asked}:latest` : null;
  }
  return names.find(likelyToolCapable) || names[0] || null;
}

const gb = (b) => (Number.isFinite(b) && b > 0 ? `${(b / 1e9).toFixed(1)} GB` : '');
/** -> [[text, tone?]] for an installed-model list. */
export function ollamaModelRows(models, current) {
  const out = [];
  for (const m of (models || []).slice(0, 20)) {
    const facts = [m.parameter_size, gb(m.size), likelyToolCapable(m.name) ? 'tools' : null].filter(Boolean).join(' · ');
    out.push([`${m.name === current ? '▸' : ' '} ${m.name}${facts ? `  ${facts}` : ''}`, m.name === current ? 'ok' : undefined]);
  }
  if ((models || []).length > 20) out.push([`  +${models.length - 20} more`]);
  return out;
}

/**
 * Z2H-R4: how to make Ollama listen on the network. The official Linux installer runs it as a systemd
 * service on 127.0.0.1, so `OLLAMA_HOST=0.0.0.0 ollama serve` fails there ("address already in use");
 * the service override comes first, the plain serve only for a non-service run.
 */
export const OLLAMA_LISTEN_LINES = [
  'Linux (installed as a service): ' + cmd('sudo systemctl edit ollama'),
  '  add under [Service]: ' + cmd('Environment="OLLAMA_HOST=0.0.0.0"'),
  '  then: ' + cmd('sudo systemctl restart ollama'),
  'Not a service: ' + cmd('OLLAMA_HOST=0.0.0.0 ollama serve')
];

export const OLLAMA_REACH_HINT = [
  'On the Ollama machine, make it listen on the network:',
  ...OLLAMA_LISTEN_LINES.map(l => `  ${l}`),
  'and allow port 11434 through its firewall. "localhost" is not reachable from the server; use the machine\'s LAN address.'
];

/** Z2H-R3: the hint for a loopback Ollama URL, with this machine's LAN address filled in. */
export function ollamaLoopbackHint(lan) {
  return [
    'The Quox server runs in Docker, so "localhost" there is the container, not this machine.',
    'Make Ollama listen on the network:',
    ...OLLAMA_LISTEN_LINES.map(l => `  ${l}`),
    `Then connect with this machine's LAN address: ${cmd(`/connect ollama http://${lan}:11434`)}`
  ];
}

/** Z2H-R4: bare /connect ollama, the whole setup from nothing, with this machine's LAN address filled in. */
export function ollamaSetupCard(lan) {
  return [
    ['Ollama runs AI models on your own machine, no account or key. To set it up:'],
    ['  1. Install it: ' + cmd('curl -fsSL https://ollama.com/install.sh | sh')],
    ['  2. Get a model that can use tools: ' + cmd('ollama pull qwen2.5')],
    ['  3. Let the Quox server reach it:'],
    ...OLLAMA_LISTEN_LINES.map(l => [`     ${l}`]),
    [`  4. Connect: ${cmd(`/connect ollama http://${lan}:11434`)}`],
    ['     (Ollama on another machine? Use that machine\'s address.)']
  ];
}

/**
 * Server-side probe (GET <url>/api/tags; human org admin; nothing stored), then the governed vault
 * write as the org default: { base_url, default_model, allow_private_origin? }. A private address is
 * allow-listed only for the exact origin probed. -> { ok, lines: [[text, tone?]] }
 */
export async function connectOllamaFlow(api, rest, { retried = false, confirmOrigin = null } = {}) {
  const { url, model } = parseOllamaArg(rest);
  if (!url) return { ok: false, lines: ollamaSetupCard((api.lanIp ? api.lanIp() : detectLanIp()) || '<lan-ip>') };
  if (!api.ollamaProbe || !api.saveProviderKey) return { ok: false, lines: [['Connecting is not available in this mode.', 'warn']] };
  const p = await api.ollamaProbe(url);
  if (!p?.ok) {
    if (p?.status === 403) return { ok: false, lines: [['✖ Connecting Ollama needs an org admin. Nothing was saved.', 'warn']] };
    const lines = [[`✖ ${p?.message || 'Ollama could not be reached'}. Nothing was saved.`, 'warn']];
    if (isLoopbackUrl(url)) { // Z2H-R3: the server is in Docker, so loopback is the container; give the exact command
      const lan = (api.lanIp ? api.lanIp() : detectLanIp()) || '<lan-ip>';
      for (const h of ollamaLoopbackHint(lan)) lines.push([`  ${h}`]);
    } else if (p?.error === 'ollama_unreachable' || p?.status === 502) for (const h of OLLAMA_REACH_HINT) lines.push([`  ${h}`]);
    return { ok: false, lines };
  }
  const models = Array.isArray(p.models) ? p.models : [];
  const def = pickOllamaDefault(models, model);
  if (model && !def) {
    return { ok: false, lines: [[`✖ ${model} is not installed on ${p.host}. On that machine run: ollama pull ${model}  Nothing was saved.`, 'warn'], ...ollamaModelRows(models)] };
  }
  const credentials = { base_url: p.base_url, ...(def ? { default_model: def } : {}), ...(p.private ? { allow_private_origin: p.origin } : {}) };
  const label = `Ollama · ${p.host}`;
  const confirm = confirmOrigin ? { confirmPrivateOrigin: confirmOrigin } : {};
  let s = await api.saveProviderKey({ type: 'ollama', label, credentials, isDefault: true, ...confirm });
  if (!s?.ok && s?.status === 409 && api.connections && api.updateProviderCredential) {
    // Same host connected before: refresh that credential (URL, default model, allowance) instead.
    const c = await api.connections();
    const row = c?.ok ? c.rows.find(r => r.integration_type === 'ollama' && r.label === label) : null;
    s = row ? await api.updateProviderCredential({ id: row.id, credentials, isDefault: true, ...confirm }) : s;
  }
  if (!s?.ok && s?.confirmable && !confirmOrigin) {
    // #1288: the server lets an org admin allow THIS one private address for their own Ollama. Ask y/N.
    const origin = s.origin || p.origin;
    return { ok: false, lines: [], privateAsk: { host: p.host, origin, retry: () => connectOllamaFlow(api, rest, { retried: true, confirmOrigin: origin }) } };
  }
  if (!s?.ok && confirmOrigin) {
    return { ok: false, lines: [[`✖ Ollama at ${p.host} was not saved (${s?.status ? `HTTP ${s.status}: ` : ''}${s?.message || 'failed'}).`, 'warn']] };
  }
  if (!s?.ok && isPrivateNetworkError(s)) {
    return lanGateCard(api, `Ollama at ${p.host}`, () => connectOllamaFlow(api, rest, { retried: true }), { retried });
  }
  if (!s?.ok) {
    const role = s?.status === 403 ? ' Storing org connections needs the secrets.write capability; ask an org admin.' : '';
    return { ok: false, lines: [[`✖ Ollama answered but the connection was not saved (${s?.status ? `HTTP ${s.status}: ` : ''}${s?.message || 'failed'}).${role}`, 'warn']] };
  }
  const lines = [[`✔ Ollama connected · ${p.host} · ${models.length} model${models.length === 1 ? '' : 's'}${def ? ` · default ${def}` : ''}`, 'ok']];
  if (p.private && confirmOrigin) lines.push([`  ${confirmOrigin} is on your private network. Quox allows only this address, for this connection.`]);
  else if (p.private) lines.push(...privateScopeNote(p.origin));
  if (!models.length) lines.push(['  No models installed yet. On that machine run: ollama pull qwen2.5', 'warn']);
  else {
    lines.push(...ollamaModelRows(models, def));
    if (def && !likelyToolCapable(def)) lines.push([`  ${def} may not support tools; turns then run without them. qwen2.5 or llama3.1 do.`, 'warn']);
  }
  lines.push(['  Use it: /model ollama' + (def ? '' : ' <model>')]);
  return { ok: true, host: p.host, model: def, lines };
}

// ---- B5: self-hosted OpenAI-compatible servers (LM Studio, vLLM) and custom endpoints ------------
const REACH_HINTS = {
  lmstudio: [
    'On the LM Studio machine: in the Developer tab enable "Serve on Local Network" and start the server (port 1234).',
    'Allow that port through its firewall. "localhost" is not reachable from the server; use the machine\'s LAN address.'
  ],
  vllm: [
    'On the vLLM machine: start it listening on the network, vllm serve <model> --host 0.0.0.0 --port 8000',
    'and allow port 8000 through its firewall. "localhost" is not reachable from the server; use the machine\'s LAN address.'
  ],
  custom: ['Check the URL (it usually ends in /v1) and that the endpoint is reachable from the server.']
};
export const SELF_HOSTED_NOTE = 'Self-hosted: your prompts stay between this server and your machine. No third party is added.';

/** "/connect <lmstudio|vllm|custom> <url> [model]" rest -> { url, model, error? }. Bare host: http:// and the preset's port. */
export function parseCompatArg(presetId, rest) {
  const p = PROVIDERS[presetId];
  const [rawUrl, model] = String(rest || '').trim().split(/\s+/);
  if (!rawUrl) return { url: null, model: null };
  let url = rawUrl;
  if (p?.custom) {
    if (/^http:\/\//i.test(url)) return { url: null, model: null, error: 'Custom endpoints must be https://. For a server on your own network use /connect lmstudio or /connect vllm.' };
    if (!/^https:\/\//i.test(url)) return { url: null, model: null, error: 'Custom endpoints take a full https:// base URL, for example /connect custom https://api.example.com/v1' };
    return { url, model: model || null };
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    url = `http://${url}`;
    try { const u = new URL(url); if (!u.port) { u.port = String(p?.port || 80); url = u.toString().replace(/\/$/, ''); } } catch { /* the server says why */ }
  }
  return { url, model: model || null };
}

/** Compact model rows for a compat /models list: up to 20, a tools tag when the server says so. */
export function compatModelRows(models, current) {
  const out = [];
  for (const m of (models || []).slice(0, 20)) {
    const id = typeof m === 'string' ? m : m?.id;
    if (!id) continue;
    out.push([`${id === current ? '▸' : ' '} ${id}${m?.tools === true ? '  tools' : ''}`, id === current ? 'ok' : undefined]);
  }
  if ((models || []).length > 20) out.push([`  +${models.length - 20} more`]);
  return out;
}

/**
 * /connect lmstudio|vllm|custom <url> [model]. Server-side probe (human org admin; nothing stored), then the
 * governed vault write as the org default. Custom endpoints that answer 401/403 come back as
 * { ok:false, needsKey:true, extra } so the app can open the key card carrying base_url.
 * -> { ok, lines: [[text, tone?]], needsKey?, extra? }
 */
export async function connectCompatFlow(api, presetId, rest, { retried = false } = {}) {
  const p = PROVIDERS[presetId];
  if (!p?.url || p.id === 'ollama') return { ok: false, lines: [[`${presetId} cannot be connected by URL.`, 'warn']] };
  const { url, model, error } = parseCompatArg(p.id, rest);
  const usage = p.custom ? '/connect custom https://<host>/v1 [model]' : `/connect ${p.id} http://<host>:${p.port} [model]`;
  if (error) return { ok: false, lines: [[`✖ ${error}`, 'warn']] };
  if (!url) return { ok: false, lines: [[`Usage: ${usage}`, 'warn']] };
  if (!api.compatProbe || !api.saveProviderKey) return { ok: false, lines: [['Connecting is not available in this mode.', 'warn']] };
  const pr = await api.compatProbe(p.id, url);
  if (!pr?.ok) {
    if (pr?.status === 403) return { ok: false, lines: [[`✖ Connecting ${p.name} needs an org admin. Nothing was saved.`, 'warn']] };
    const lines = [[`✖ ${pr?.message || `${p.name} could not be reached`}. Nothing was saved.`, 'warn']];
    if (pr?.error === 'provider_unreachable' || pr?.status === 502) for (const h of REACH_HINTS[p.id] || []) lines.push([`  ${h}`]);
    return { ok: false, lines };
  }
  const models = Array.isArray(pr.models) ? pr.models : [];
  const ids = models.map(m => m.id);
  if (pr.needs_key) {
    if (p.custom) {
      return { ok: false, needsKey: true, extra: { base_url: pr.base_url, host: pr.host, ...(model ? { default_model: model } : {}) },
        lines: [[`${pr.host} answered but wants an API key. Opening the key card.`]] };
    }
    return { ok: false, lines: [[`✖ ${pr.host} wants an API key, which ${p.name} connections do not take here. Use /connect custom ${pr.base_url} instead. Nothing was saved.`, 'warn']] };
  }
  if (model && ids.length && !ids.includes(model)) {
    return { ok: false, lines: [[`✖ ${model} is not served by ${pr.host}. Nothing was saved.`, 'warn'], ...compatModelRows(models)] };
  }
  const credentials = {
    base_url: pr.base_url, ...(model ? { default_model: model } : {}),
    ...(pr.private && !p.custom ? { allow_private_origin: pr.origin } : {})
  };
  const label = `${p.name} · ${pr.host}`;
  let s = await api.saveProviderKey({ type: p.type, label, credentials, isDefault: true });
  if (!s?.ok && s?.status === 409 && api.connections && api.updateProviderCredential) {
    const c = await api.connections();
    const row = c?.ok ? c.rows.find(r => r.integration_type === p.type && r.label === label) : null;
    s = row ? await api.updateProviderCredential({ id: row.id, credentials, isDefault: true }) : s;
  }
  if (!s?.ok && isPrivateNetworkError(s)) {
    return lanGateCard(api, `${p.name} at ${pr.host}`, () => connectCompatFlow(api, presetId, rest, { retried: true }), { retried });
  }
  if (!s?.ok) {
    const role = s?.status === 403 ? ' Storing org connections needs the secrets.write capability; ask an org admin.' : '';
    return { ok: false, lines: [[`✖ ${p.name} answered but the connection was not saved (${s?.status ? `HTTP ${s.status}: ` : ''}${s?.message || 'failed'}).${role}`, 'warn']] };
  }
  const lines = [[`✔ ${p.name} connected · ${pr.host} · ${models.length} model${models.length === 1 ? '' : 's'}${model ? ` · default ${model}` : ''}`, 'ok']];
  if (pr.private && !p.custom) lines.push(...privateScopeNote(pr.origin));
  lines.push(p.custom ? [`  ${p.disclosure}`, 'warn'] : [`  ${SELF_HOSTED_NOTE}`]);
  lines.push(...compatModelRows(models, model));
  lines.push([`  Use it: /model ${p.id}${model ? '' : ' [model]'}`]);
  return { ok: true, host: pr.host, model: model || null, lines };
}
