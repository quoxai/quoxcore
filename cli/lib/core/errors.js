/**
 * Error types and handler for QuoxCLI
 */

import chalk from 'chalk';

export class QuoxError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'QuoxError';
    this.exitCode = exitCode;
  }
}

export class QuoxApiError extends QuoxError {
  /**
   * @param {number} status  HTTP status
   * @param {string} code    machine-readable error code from the body
   * @param {string} message human-readable message
   * @param {*} [detail]     the body's `detail`/`details` field, if any
   * @param {object} [body]  LL-3d: the WHOLE parsed JSON error body. Lifting
   *   only message/detail threw away everything else the server said, and the
   *   licensing endpoints say a lot: which instance holds the seat, how many
   *   of the licensed servers are in use, which plugin is unlicensed. Command
   *   handlers read this to render something actionable; --json emits it raw.
   */
  constructor(status, code, message, detail, body) {
    // #1005: some services (quoxflow) answer { error: { code, message, details } }.
    // Passed through as `code`, it printed as "Status: 400 [object Object]" and the
    // real message and field errors were lost. Lift them out.
    const structured = code && typeof code === 'object' ? code : null;
    if (structured) {
      if (structured.message && (!message || /^(Stream request|Request) failed with status/.test(message))) message = structured.message;
      if (detail == null && structured.details != null) detail = structured.details;
      code = typeof structured.code === 'string' ? structured.code : 'api_error';
    }
    super(message, statusToExitCode(status));
    this.name = 'QuoxApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    if (body && typeof body === 'object') this.body = body;
  }
}

export class QuoxAuthError extends QuoxError {
  constructor(message = 'Not authenticated. Run `quox login` first.') {
    super(message, 3);
    this.name = 'QuoxAuthError';
  }
}

/**
 * A re-authentication that failed for a reason expected to clear by itself
 * (auth service restarting, 429 rate_limited on the resident token exchange,
 * 502/503/504, network fault). It IS a QuoxAuthError, so every verb that does
 * not know about it behaves exactly as before; only long-lived listeners
 * (`quox slot wait`) choose to back off and keep going. `retryAfterMs` carries
 * the server's Retry-After when it sent one.
 */
export class QuoxTransientAuthError extends QuoxAuthError {
  constructor(message, retryAfterMs = null) {
    super(message);
    this.name = 'QuoxTransientAuthError';
    this.transient = true;
    this.retryAfterMs = retryAfterMs;
  }
}

export class QuoxNetworkError extends QuoxError {
  constructor(message = 'Could not connect to QuoxCORE services.', cause) {
    super(message, 7);
    this.name = 'QuoxNetworkError';
    this.cause = cause;
  }
}

export class QuoxValidationError extends QuoxError {
  constructor(message) {
    super(message, 2);
    this.name = 'QuoxValidationError';
  }
}

/**
 * CLI-ERRORS (owner 2026-10-17): the shared error contract. A command that knows what went wrong throws
 * this: `headline` says what happened and why in plain words, `next` is the ONE best next step. The
 * renderer prints exactly those two lines; technical detail (status, code, raw server text) only with
 * --verbose. Exit code is the caller's choice (6 for "already decided differently", 5 for not found...).
 */
export class QuoxUserError extends QuoxError {
  constructor(headline, { next = null, exitCode = 1, code = 'user_error', status, detail, body } = {}) {
    super(headline, exitCode);
    this.name = 'QuoxUserError';
    this.headline = headline;
    this.next = next;
    this.code = code;
    if (status) this.status = status;
    if (detail != null) this.detail = detail;
    if (body && typeof body === 'object') this.body = body;
  }
}

function statusToExitCode(status) {
  if (status === 401) return 3;
  if (status === 403) return 4;
  if (status === 404) return 5;
  if (status === 409) return 6;
  if (status >= 500) return 8;
  return 1;
}

const STATUS_HINTS = {
  401: 'Run `quox login` to authenticate.',
  403: 'You may not have permission. Try `quox org switch` to change context.',
  // #995: never name a verb that may not exist; handleError names the real one when it knows the group
  404: 'Resource not found. Check the id; `quox <command> --help` shows how to list what exists.',
  409: 'Resource conflict. The item may already exist.',
  429: 'Rate limited. Wait a moment and try again.',
  500: 'Server error. Use --debug for details.',
  502: 'Service temporarily unavailable. Check `quox service health`.',
  503: 'Service temporarily unavailable. Check `quox service health`.',
};

// quox#803: a 403 signature_invalid is not a permissions problem; the org
// enforces trusted plugin keys. Only real verbs are named: `quox plugin
// trusted-keys add` (CLI) and `quox-plugin sign` (@quoxai/quox-plugin-vite).
function signatureInvalidHint(reason) {
  const why = reason ? ` (reason: ${reason})` : '';
  return `This org enforces trusted plugin signing keys${why}. Sign the bundle with \`npx quox-plugin sign\` (from @quoxai/quox-plugin-vite) and pass \`--signature <file>\`, `
    + 'or have an org admin register your public key with `quox plugin trusted-keys add`.';
}

// Z2H-3c: a 402 LICENSE_REQUIRED printed only "Request failed with status 402" (seen on `quox fleet hosts`
// on a fresh install). Name what is locked and the real verbs that unlock or inspect it.
function licenseRequiredHint(body) {
  const plugin = body?.plugin || body?.requiredPlugin;
  return `${plugin ? `This needs a licence that includes \`${plugin}\`` : 'This needs a licence entitlement'}, and this install does not have it. `
    + 'Activate one with `quox setup license activate --key-file <path>`; see what you have with `quox setup license status`.';
}

// An object `detail` (e.g. {holder_session}) printed as "[object Object]". Show message/code when present,
// else compact JSON.
export function renderDetail(detail) {
  if (detail == null || detail === '') return '';
  if (typeof detail === 'string') return detail;
  // #1005: validation details as [{ path, message }] read as "field: problem".
  if (Array.isArray(detail) && detail.length && detail.every((d) => d && typeof d === 'object' && typeof d.message === 'string')) {
    return detail.map((d) => {
      const path = Array.isArray(d.path) ? d.path.join('.') : d.path;
      return path ? `${path}: ${d.message}` : d.message;
    }).join('; ');
  }
  if (typeof detail === 'object') {
    const parts = [detail.message, detail.code].filter((x) => typeof x === 'string' && x);
    if (parts.length) return parts.join(' ');
    try { return JSON.stringify(detail); } catch { return String(detail); }
  }
  return String(detail);
}

// A human-only route refused this login (an agent or resident identity). Switching org cannot help; a
// human profile can.
function humanOnlyHint() {
  return 'This needs a human login, and the active profile is not one (it is an agent or service login). '
    + 'Run it from a human profile: `quox -p <profile> ...`; `quox config profile list` shows them.';
}

function notSlotHolderHint() {
  return 'You don\'t hold this slot. To post as a member: `quox slot join <slot> --session <S>`, then `quox slot say <slot> --room --session <S> <text>`.';
}

// #995: the 404 hint names `quox <group> list` only when that group really has a list verb, else its --help.
function notFoundHint(ctx) {
  if (!ctx || !ctx.group) return null;
  return (ctx.subcommands || []).includes('list')
    ? `Resource not found. \`quox ${ctx.group} list\` shows what exists.`
    : `Resource not found. \`quox ${ctx.group} --help\` shows how to list what exists.`;
}

const RAW_HEADLINE = /^(Stream request|Request) failed with status \d+$/;

function sentence(text) {
  const t = String(text || '').trim();
  if (!t) return t;
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function lowerFirst(text) {
  return text ? text[0].toLowerCase() + text.slice(1) : text;
}

/** The server's own words for this error: its message, else its prose `error`, else null. */
function serverReason(err) {
  const m = String(err.message || '').split('\n')[0];
  if (m && !RAW_HEADLINE.test(m)) return m;
  const code = typeof err.code === 'string' ? err.code : (typeof err.body?.error === 'string' ? err.body.error : '');
  return /\s/.test(code) ? code : null;
}

/**
 * CLI-ERRORS: map an error to the contract { headline, next }, or null to keep the legacy rendering
 * (an error whose message already says it well; existing tests pin that output, see the audit).
 */
export function explainError(err, ctx = null) {
  if (!err) return null;
  if (err instanceof QuoxUserError) return { headline: err.headline, next: err.next };
  if (!(err instanceof QuoxApiError)) return null;
  const status = err.status;
  const body = err.body && typeof err.body === 'object' ? err.body : {};
  const code = typeof err.code === 'string' ? err.code : '';
  const all = `${code} ${typeof body.error === 'string' ? body.error : ''} ${err.message || ''}`;
  // reasonFromError: the client lifted a prose `error` into the message because the body had no `message`
  const raw = RAW_HEADLINE.test(String(err.message || '').split('\n')[0]) || err.reasonFromError === true;
  const reason = serverReason(err);

  // #8 service-key fallback: the real problem is "no stored session", say it once.
  if (err.serviceKeyFallback && (status === 401 || status === 403)) {
    return {
      headline: 'This needs a signed-in user, and this profile has no stored session, so the request went out with the service key, which carries no user.',
      next: 'run `quox login` (or `quox -p <profile> login`), then retry.',
    };
  }
  // #3 non-JSON error page from a proxy in front of a service
  if ((code === 'non_json_response' || code === 'unknown') && status >= 500) {
    return {
      headline: 'The server answered with an error page instead of Quox data, so the service behind it is down or restarting.',
      next: 'check `quox service health`, then retry.',
    };
  }
  // #9 / #10 sign-in
  if (status === 401 && code === 'invalid_credentials') {
    return {
      headline: 'Sign-in failed: the email or password is wrong for this server.',
      next: 'check the profile and server with `quox config profile list`, or reset the password from the dashboard sign-in page.',
    };
  }
  if (status === 401 && code === 'account_locked') {
    return { headline: sentence(reason || 'This account is locked after too many failed sign-ins'), next: 'wait for the lock to expire, then run `quox login` again; nothing else is needed.' };
  }
  // #6 an agent login tried to decide a HITL item
  if (status === 403 && /agents cannot resolve hitl/i.test(all)) {
    return {
      headline: 'Only a person can approve or reject inbox items, and this profile is an agent login.',
      next: 'run it from a human profile: `quox -p <profile> ...`; `quox config profile list` shows them.',
    };
  }
  // #13 / LICENSE_REQUIRED
  if ((status === 402 || status === 403) && (code === 'LICENSE_REQUIRED' || body.error === 'LICENSE_REQUIRED')) {
    if (body.reason === 'no_org_context') {
      return { headline: 'This command needs an org, and none is selected for this profile.', next: 'pick one with `quox org switch <org>`; `quox org list` shows them.' };
    }
    const plugin = body.plugin || body.requiredPlugin;
    return {
      headline: `${plugin ? `This needs a licence that includes \`${plugin}\`` : 'This needs a licence entitlement'}, and this install does not have it.`,
      next: 'activate one with `quox setup license activate --key-file <path>`; see what you have with `quox setup license status`.',
    };
  }
  // #11 / #12 prose "not licensed" (only when the headline would otherwise be raw)
  if ((status === 402 || status === 403) && /not licen[cs]ed/i.test(all) && (raw || status === 402)) {
    const text = (reason || 'This feature is not licensed for this org').replace(/^(\S+) not licen/i, '$1 is not licen');
    return { headline: sentence(text), next: '`quox setup license status` shows what this install has.' };
  }
  // #14 / #15 approvals
  if (/^approval (request )?has expired$/i.test(reason || '')) {
    return { headline: 'That approval expired before anyone decided it, so nothing ran.', next: 're-run the original command to ask for a fresh approval.' };
  }
  if (status === 404 && /^approval not found$/i.test(reason || '')) {
    return { headline: 'No approval with that id in this org; it may belong to another org or be past retention.', next: notFoundNext(ctx) || '`quox approvals --help` shows how to list what exists.' };
  }
  // #5 a role refusal is not an org-context problem
  if (status === 403 && /insufficient permissions?|lacks?[ _]capability|requires? (an? |the )?(admin|owner) role|not an? (org )?(admin|owner)/i.test(all)) {
    return { headline: sentence(reason || 'Your role does not allow this'), next: 'your role in this org does not allow this; ask an org owner or admin to do it or to raise your role.' };
  }
  // #18 a 409 that already says "already exists" needs no echo
  if (status === 409 && /already exists/i.test(reason || '')) {
    return { headline: sentence(reason), next: 'pick a different id, or update the existing one.' };
  }
  // #1 / #4 the headline would be "Request failed with status N": lead with the server's reason
  if (raw && reason) {
    const next = (typeof body.hint === 'string' && body.hint)
      || (status === 404 && notFoundNext(ctx))
      || CONTRACT_NEXT[status]
      || (STATUS_HINTS[status] ? lowerFirst(STATUS_HINTS[status]) : null);
    return { headline: sentence(reason), next };
  }
  return null;
}

// The contract's own next steps: an action, never a restatement of the headline.
const CONTRACT_NEXT = {
  401: 'run `quox login`, then retry.',
  403: 'if this belongs to another org, switch with `quox org switch <org>`; otherwise ask an org owner or admin.',
  404: 'check the id; `quox <command> --help` shows how to list what exists.',
  409: 'it may already exist or be in use; check its current state before retrying.',
};

function notFoundNext(ctx) {
  const h = notFoundHint(ctx);
  return h ? h.replace(/^Resource not found\. /, '') : null;
}

function isVerbose(ctx) {
  if (ctx && ctx.verbose) return true;
  const a = process.argv || [];
  return a.includes('--verbose') || a.includes('-v') || a.includes('--debug') || Boolean(process.env.DEBUG);
}

/**
 * CLI-ERRORS: the contract rendering for an API error with no specific mapping. Headline = the server's
 * own first line; next = the most specific hint we have (the cases the legacy renderer knew), once.
 */
function fallbackExplain(err, ctx) {
  const body = err.body && typeof err.body === 'object' ? err.body : {};
  const tags = `${typeof err.code === 'string' ? err.code : ''} ${typeof body.error === 'string' ? body.error : ''}`;
  const status = err.status;
  let next;
  if (status === 403 && /not (the current )?slot holder/i.test(tags)) next = notSlotHolderHint();
  else if (status === 403 && /\b(only a human|requires a human)\b/i.test(`${tags} ${err.message || ''}`)) next = humanOnlyHint();
  else if (status === 403 && (err.code === 'signature_invalid' || body.error === 'signature_invalid')) next = signatureInvalidHint(body.reason);
  else if (status === 403 && /not licen[cs]ed/i.test(tags)) next = '`quox setup license status` shows what this install has.';
  else if (err.code === 'PLUGIN_SERVICE_UNAVAILABLE') next = null;
  else {
    next = (typeof body.hint === 'string' && body.hint) || (status === 404 && notFoundNext(ctx)) || CONTRACT_NEXT[status]
      || (STATUS_HINTS[status] ? lowerFirst(STATUS_HINTS[status]) : null);
  }
  const plain = { 400: 'The server could not accept that request', 401: 'You are not signed in, or the session has expired', 402: 'This needs a licence this install does not have',
    403: 'This profile is not allowed to do that', 404: 'That was not found', 409: 'That conflicts with its current state', 429: 'Too many requests right now' };
  const msg = String(err.message || '').split('\n')[0];
  const first = serverReason(err) || (RAW_HEADLINE.test(msg) || !msg ? (plain[status] || (status >= 500 ? 'The server hit an error' : 'The request was refused')) : msg);
  return { headline: sentence(first), next: next || null };
}

// CLI-ERRORS: an instruction sentence (the step the user takes) vs the rest (what happened).
const INSTRUCTION = /^(run|check|use|retry|try|pass|fix|set|pick|switch|ask|log ?in|re-?run|please)\b/i;

function splitInstruction(text) {
  const first = String(text || '').split('\n')[0].trim();
  const rest = String(text || '').split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
  const parts = first.split(/(?<=[.!?;])\s+/);
  let idx = parts.findIndex((p, i) => i > 0 && INSTRUCTION.test(p));
  let head = idx === -1 ? parts.join(' ') : parts.slice(0, idx).join(' ');
  let next = idx === -1 ? null : parts[idx];
  const more = [...(idx === -1 ? [] : parts.slice(idx + 1)), ...rest];
  head = head.replace(/;$/, '');
  if (next && /^please log ?in again\.?$/i.test(next)) next = 'run `quox login`, then retry.';
  return { headline: sentence(head), next: next ? lowerFirst(next) : null, more };
}

/**
 * CLI-ERRORS: errors the CLI raises itself (auth, network, validation, anything else) in the same
 * contract as API errors: one headline, at most one Next, the rest (`more`) only with --verbose.
 */
export function explainLocal(err) {
  if (!err || err instanceof QuoxApiError || err instanceof QuoxUserError) return null;
  const message = String(err.message || '');
  if (err instanceof QuoxNetworkError) {
    const code = err.cause?.cause?.code || err.cause?.code || null;
    const m = /^Could not connect to (\S+) service at (\S+?): /.exec(message);
    const svc = m ? m[1] : null;
    const url = m ? m[2] : null;
    const more = message.split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
    if (m && code && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) {
      return { headline: `Could not reach the ${svc} service at ${url}: its certificate is not trusted (${code}).`,
        next: 'trust it with export NODE_EXTRA_CA_CERTS=<path to quox.crt> (on the server: ~/quox-install/quox/ssl/quox.crt); never disable TLS verification.', more };
    }
    if (m && (code === 'ERR_SSL_WRONG_VERSION_NUMBER' || code === 'EPROTO')) {
      return { headline: `The ${svc} service at ${url} speaks plain http, but this profile's URL says https://.`,
        next: `quox config set url ${url.replace(/^https:/, 'http:')}`, more };
    }
    if (m && code === 'ECONNREFUSED') {
      return { headline: `Nothing is listening at ${url} for the ${svc} service: it is down, or this profile's URL is stale.`,
        next: `run \`quox doctor\`; to point this shell elsewhere: export QUOX_${svc.toUpperCase()}_URL=<url>`, more };
    }
    const t = /^Request timed out after (\d+)ms$/.exec(message);
    if (t) {
      const secs = Math.round(Number(t[1]) / 1000);
      return { headline: `The server did not answer within ${secs} second${secs === 1 ? '' : 's'}.`, next: 'check `quox service health`, then retry.', more };
    }
    return { headline: sentence(message.split('\n')[0]), next: 'check `quox service health`, then retry.', more };
  }
  if (err instanceof QuoxAuthError) {
    const sp = splitInstruction(message);
    if (!sp.next) {
      sp.next = /QUOX_TOKEN_FILE/.test(message)
        ? 'this principal runs only on its issued token; ask the owner to re-issue the token file.'
        : err.transient ? 'wait a moment and retry; your stored session is kept.' : 'run `quox login`, then retry.';
    }
    return sp;
  }
  if (err instanceof QuoxValidationError) return splitInstruction(message);
  const first = message.split('\n')[0];
  return { headline: sentence(first || 'Something went wrong'), next: null, more: message.split('\n').slice(1), stack: true };
}

function renderContract(err, ex, ctx) {
  console.error(chalk.red(`✖ ${ex.headline}`));
  if (ex.next) console.error(chalk.yellow(`  Next: ${ex.next}`));
  // #1000: a server that names the allowed values is telling the user the fix; keep it
  if (err.body && typeof err.body === 'object') {
    for (const [k, v] of Object.entries(err.body)) {
      if (k.startsWith('valid_') && Array.isArray(v) && v.length) console.error(chalk.dim(`  Valid ${k.slice(6).replace(/_/g, ' ')}: ${v.join(', ')}`));
    }
  }
  if (err.detail) console.error(chalk.dim(`  Detail: ${renderDetail(err.detail)}`));
  if (isVerbose(ctx)) {
    if (err.status) console.error(chalk.dim(`  Status: ${err.status} ${typeof err.code === 'object' && err.code ? renderDetail(err.code) : (err.code || '')}`));
    if (err instanceof QuoxApiError && err.message && err.message !== ex.headline) console.error(chalk.dim(`  Server said: ${err.message}`));
    for (const line of ex.more || []) if (line) console.error(chalk.dim(`  More: ${line}`));
    if (ex.stack && err.stack) console.error(chalk.dim((err.stack || '').replace(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[JWT_REDACTED]')));
  }
}

export function handleError(err, outputFormat = 'table', ctx = null) {
  if (outputFormat === 'json') {
    const obj = {
      error: true,
      code: err.code || err.name,
      message: err.headline || err.message,
    };
    if (err.status) obj.status = err.status;
    if (err.detail) obj.detail = err.detail;
    // LL-3d: scripts parsing --json get the server's own body verbatim, not
    // our prose rendering of it.
    if (err.body && typeof err.body === 'object') obj.body = err.body;
    const ex = explainError(err, ctx) || (err instanceof QuoxApiError ? fallbackExplain(err, ctx) : explainLocal(err));
    if (ex) { obj.headline = ex.headline; if (ex.next) obj.next = ex.next; }
    process.stderr.write(JSON.stringify(obj) + '\n');
    return;
  }

  const ex = explainError(err, ctx);
  if (ex) { renderContract(err, ex, ctx); return; }

  if (err instanceof QuoxApiError) {
    // CLI-ERRORS (PIN 01K55JRA11YHH73TN67X9ZDEGM): every API error renders in the contract now.
    renderContract(err, fallbackExplain(err, ctx), ctx);
  } else {
    renderContract(err, explainLocal(err), ctx);
  }
}
