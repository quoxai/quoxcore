'use strict';
/**
 * #904 part 3 (2026-10-14): a provider limit must be visible BEFORE a user types into it.
 * The dev server's Claude subscription hit its weekly limit and every turn failed for a day
 * while nothing (status line, quox status, LUCID, the proof canary) said so.
 *
 * One durable record per (scope, provider): { provider, state: limited|no_credits, resets_at,
 * since, last_message }. Scope is an org id, or INSTANCE for credentials the whole server shares
 * (the Claude CLI sign-in). A successful turn on that provider clears it; a limit with a known
 * reset time also clears itself at resets_at. Stored as a small JSON file on the collector's
 * data volume (survives rebuilds); never in a browser.
 */

const fs = require('fs');
const path = require('path');

const INSTANCE = '_instance';
// A limit with no stated reset (an OpenAI 429 rate limit, not a credit problem) is assumed
// cleared after this long unless a later failure renews it.
const UNKNOWN_RESET_MS = 60 * 60 * 1000;

const OUT_OF_CREDIT_RE = /insufficient_quota|no credits remaining|credit balance is too low|payment required|quota exceeded/i;
const CLAUDE_LIMIT_RE = /hit its (weekly|5-hour|usage) limit(?:, which resets (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC)?/i;
const CLAUDE_RAW_LIMIT_RE = /you've hit your (weekly|session|usage) limit/i;

let storePath = fs.existsSync('/var/lib/quox')
  ? '/var/lib/quox/provider-health.json'
  : path.join(__dirname, '..', 'logs', 'provider-health.json');
let cache = null;

function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(storePath, 'utf8')); } catch { cache = {}; }
  if (!cache || typeof cache !== 'object') cache = {};
  return cache;
}

function save() {
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const tmp = `${storePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 1));
    fs.renameSync(tmp, storePath);
  } catch (err) {
    console.error('[ProviderHealth] could not persist provider health:', err.message);
  }
}

/** Is this failure a provider limit? -> { state, resets_at, last_message } | null. */
function classifyProviderLimit({ provider, message = '', status = null, body = '' } = {}) {
  const text = `${message || ''} ${typeof body === 'string' ? body : ''}`;
  const lastMessage = String(message || body || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (OUT_OF_CREDIT_RE.test(text)) return { state: 'no_credits', resets_at: null, last_message: lastMessage };
  const m = CLAUDE_LIMIT_RE.exec(text);
  if (m) {
    const resetsAt = m[2] && m[3] ? new Date(`${m[2]}T${m[3]}:00Z`).toISOString() : null;
    return { state: 'limited', resets_at: resetsAt, last_message: lastMessage };
  }
  if (CLAUDE_RAW_LIMIT_RE.test(text)) return { state: 'limited', resets_at: null, last_message: lastMessage };
  if (Number(status) === 429 && provider !== 'anthropic') return { state: 'limited', resets_at: null, last_message: lastMessage };
  return null;
}

function key(scope, provider) { return `${scope || INSTANCE}|${provider}`; }

/** Record a failed turn. Returns { changed, entry } (changed = this is a new limit, not a repeat). */
function observeFailure({ scope = INSTANCE, provider, message, status = null, body = '', now = Date.now() } = {}) {
  if (!provider) return { changed: false, entry: null };
  const c = classifyProviderLimit({ provider, message, status, body });
  if (!c) return { changed: false, entry: null };
  const db = load();
  const k = key(scope, provider);
  const prev = db[k];
  const entry = {
    scope: scope === INSTANCE ? 'instance' : 'org',
    org_id: scope === INSTANCE ? null : scope,
    provider,
    state: c.state,
    resets_at: c.resets_at || (c.state === 'limited' ? new Date(now + UNKNOWN_RESET_MS).toISOString() : null),
    since: prev && prev.state === c.state ? prev.since : new Date(now).toISOString(),
    last_message: c.last_message,
    last_seen: new Date(now).toISOString(),
  };
  const changed = !prev || prev.state !== entry.state || prev.resets_at !== entry.resets_at;
  db[k] = entry;
  save();
  if (changed) console.warn(`[ProviderHealth] ${provider} ${entry.state}${entry.resets_at ? ` until ${entry.resets_at}` : ''} (scope ${entry.scope})`);
  return { changed, entry };
}

/** A successful turn on this provider clears its limit. */
function observeSuccess({ scope = INSTANCE, provider } = {}) {
  const db = load();
  const k = key(scope, provider);
  if (!db[k]) return { changed: false };
  delete db[k];
  save();
  console.log(`[ProviderHealth] ${provider} healthy again (scope ${scope === INSTANCE ? 'instance' : 'org'})`);
  return { changed: true };
}

/** Active limits an org can feel: its own plus the instance-wide ones. Expired entries drop out. */
function getProviderHealth(orgId, { now = Date.now() } = {}) {
  const db = load();
  const out = [];
  let dirty = false;
  for (const [k, e] of Object.entries(db)) {
    if (e.resets_at && Date.parse(e.resets_at) <= now) { delete db[k]; dirty = true; continue; }
    if (e.scope === 'instance' || (orgId && e.org_id === orgId)) out.push(e);
  }
  if (dirty) save();
  return out;
}

const NAMES = { anthropic: 'claude', openai: 'openai', gemini: 'gemini' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "claude limited until 15 Oct 22:00 UTC" / "openai out of credits". */
function healthLine(e) {
  const who = NAMES[e.provider] || e.provider;
  if (e.state === 'no_credits') return `${who} out of credits`;
  if (!e.resets_at) return `${who} limited`;
  const d = new Date(e.resets_at);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${who} limited until ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${hh}:${mm} UTC`;
}

function _setStorePath(p) { storePath = p; cache = null; }

module.exports = { INSTANCE, classifyProviderLimit, observeFailure, observeSuccess, getProviderHealth, healthLine, _setStorePath };

/**
 * One call per finished turn from any provider path. ok=true clears; a limit failure records.
 * On a state change it tells LUCID (vital ledger, subject provider:<name>) so "what needs you"
 * names it once, and retracts when the provider works again. Never throws into the turn.
 */
function observeTurn({ orgId = null, scope = null, provider, ok, message = '', status = null, body = '', lucid = null } = {}) {
  try {
    const sc = scope || (provider === 'anthropic' ? INSTANCE : (orgId || INSTANCE));
    const r = ok ? observeSuccess({ scope: sc, provider }) : observeFailure({ scope: sc, provider, message, status, body });
    if (r.changed && orgId) {
      const emitter = lucid || require('./lucid/emit.js');
      const subject = `provider:${provider}`;
      if (ok) emitter.emit({ org_id: orgId, ledger: 'vital', subject, kind: 'retract', source: { feed: 'providers' }, state: { status: 'healthy', provider } });
      else if (r.entry) emitter.emit({ org_id: orgId, ledger: 'vital', subject, kind: 'ask', source: { feed: 'providers' },
        state: { status: r.entry.state, provider, resets_at: r.entry.resets_at, last_message: r.entry.last_message },
        summary: `${healthLine(r.entry)}: chat on ${NAMES[provider] || provider} fails until then. Connect another provider in Settings or wait.`,
        salience: { needs: 'owner', gates: [] } });
    }
    return r;
  } catch (err) {
    console.error('[ProviderHealth] observeTurn failed:', err.message);
    return { changed: false };
  }
}

module.exports.observeTurn = observeTurn;
