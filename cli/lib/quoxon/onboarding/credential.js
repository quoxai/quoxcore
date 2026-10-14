/**
 * The credential step: which AI the agents use, and the key, held in memory only.
 *
 * `requestCredential(provider)` is THE hook for the K1 secure key card (/connect, branch session/quox-connect).
 * Until that merges, the broker below backs it with this view's own masked input. Same rules either way: the
 * secret never enters a transcript, history item, journey file, config file or event stream, and the only
 * thing ever shown or persisted about it is its fingerprint.
 */
import { createHash } from 'node:crypto';
import { CRED_OPTIONS } from './copy.js';

export const PROVIDERS = ['chatgpt', 'openai', 'anthropic', 'ollama', 'skip'];
export const KEY_PROVIDERS = new Set(['openai', 'anthropic']);
// Sign in with ChatGPT stays visible but unselectable until OpenAI approves the integration.
export const CHATGPT_ENABLED = false;

/**
 * Options in display order. Ollama is always offered (B3): "on this machine" when localhost:11434
 * answered, else "on another machine" (listed last), which asks for its LAN URL.
 */
export function credentialOptions({ ollama = false, chatgpt = CHATGPT_ENABLED } = {}) {
  // Not detected: "on another machine" goes last, so the familiar numbering (4 = Skip) holds.
  const order = ollama ? PROVIDERS : [...PROVIDERS.filter(p => p !== 'ollama'), 'ollama'];
  return order.map(id => {
    if (id === 'ollama') return { id, ...(ollama ? CRED_OPTIONS.ollama : CRED_OPTIONS.ollamaLan), detected: Boolean(ollama), disabled: false };
    return { id, ...CRED_OPTIONS[id], disabled: id === 'chatgpt' && !chatgpt };
  });
}

/** A typed Ollama URL -> normalised http(s) URL (bare host gets http:// and :11434) | null. */
export function normaliseOllamaUrl(text) {
  let v = String(text || '').trim();
  if (!v || /\s/.test(v)) return null;
  const bare = !/^[a-z][a-z0-9+.-]*:\/\//i.test(v);
  if (bare) v = `http://${v}`;
  let u;
  try { u = new URL(v); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || !u.hostname) return null;
  if (bare && !u.port) u.port = '11434';
  return u.toString().replace(/\/$/, '');
}

export const fingerprint = (secret) => 'sha256:' + createHash('sha256').update(String(secret)).digest('hex').slice(0, 8);

/** A secret that refuses to serialise: JSON, String() and util.inspect all show a redaction. */
export function holdSecret(provider, value) {
  let v = String(value);
  const fp = fingerprint(v);
  const redacted = `[${provider} key ${fp}]`;
  return Object.freeze({
    provider,
    fingerprint: fp,
    reveal: () => v, // the ONE accessor: C2c hands it to the new instance's vault API, then drops it
    drop: () => { v = ''; },
    toJSON: () => redacted,
    toString: () => redacted,
    [Symbol.for('nodejs.util.inspect.custom')]: () => redacted
  });
}

/**
 * Broker behind requestCredential(): a single pending request the view renders as a masked card.
 * K1 swap: replace createCredentialBroker().request with the secure card call; the view keeps working.
 */
export function createCredentialBroker() {
  let pending = null;
  const listeners = new Set();
  const emit = () => { for (const fn of listeners) fn(pending); };
  return {
    /** requestCredential(provider) -> Promise<held secret | null (cancelled)> */
    request(provider) {
      if (pending) pending.resolve(null);
      return new Promise((resolve) => {
        pending = { provider, resolve: (val) => { pending = null; emit(); resolve(val); } };
        emit();
      });
    },
    submit(value) { if (pending && String(value).length) pending.resolve(holdSecret(pending.provider, value)); },
    cancel() { pending?.resolve(null); },
    get pending() { return pending ? { provider: pending.provider } : null; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };
}

/**
 * THE hook the view calls: requestCredential(provider) -> Promise<held secret | null>.
 * K1 merge (session/quox-connect): return the secure key card's result here instead of broker.request(provider).
 * Whatever backs it must keep the rules above (memory only, fingerprint the only trace).
 */
export function createRequestCredential(broker) {
  return function requestCredential(provider) {
    return broker.request(provider);
  };
}
