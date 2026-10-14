/**
 * HTTP client for QuoxCLI
 *
 * Wraps native fetch with:
 * - Bearer token injection
 * - Service-aware URL routing (auth:3101, collector:9848, etc.)
 * - Auto-refresh on 401
 * - Retry with exponential backoff for transient errors
 * - Debug logging
 */

import { resolveActing, resolveActingToken } from './actingAs.js';
import { detectCallerSource } from './callerSource.js';
import { QuoxApiError, QuoxNetworkError, QuoxAuthError, QuoxTransientAuthError } from './errors.js';

const RETRY_STATUSES = new Set([429, 502, 503]);
const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 3000, 9000];

// Generate a ULID-like correlation ID (timestamp + random, sortable, unique)
// quox#558: undici reports every TLS trust failure as a bare "fetch failed",
// which sent people debugging services that were up. Name the real cause and
// the sanctioned fix (trust the CA; never disable verification).
const TLS_TRUST_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export function describeNetworkError(service, baseUrl, err) {
  const code = err?.cause?.code || err?.code;
  let msg = `Could not connect to ${service} service at ${baseUrl}: ${err.message}`;
  if (code && TLS_TRUST_CODES.has(code)) {
    msg += `\n  TLS: certificate not trusted (${code}). For a self-signed dev edge, trust its CA:`
      + `\n    export NODE_EXTRA_CA_CERTS=~/.config/quox/quox-dev-edge.pem`
      + `\n  Never disable TLS verification (NODE_TLS_REJECT_UNAUTHORIZED=0) instead.`;
  } else if (code === 'ERR_SSL_WRONG_VERSION_NUMBER' || code === 'EPROTO') {
    // quox#532 defect 1: the profile says https:// but the service answered
    // PLAINTEXT (classic: url stamped https://localhost:3000 against plain
    // http local services). Say "did you mean http://" instead of a raw
    // fetch failed.
    msg += `\n  The server answered plaintext to a TLS handshake: this profile's url says https:// but the service speaks http.`
      + `\n  Did you mean ${String(baseUrl).replace(/^https:/, 'http:')} ? Fix it with: quox config set url <http-url>`;
  } else if (code === 'ECONNREFUSED') {
    // quox#548: "connection refused" could not distinguish service-absent
    // from wrong-URL, and on boxes running a project-prefixed parallel stack
    // the service often IS up, on a +10000 offset port. Say so instead of a
    // dead end. Per-profile stamped service URLs also go stale silently
    // (that half of quox#548 stays open) — the override is the escape hatch.
    let offsetHint = '';
    try {
      const u = new URL(baseUrl);
      if (u.port) offsetHint = ` (a project-prefixed stack would serve it at :${Number(u.port) + 10000})`;
    } catch { /* baseUrl unparsable: skip the arithmetic, keep the rest */ }
    msg += `\n  Nothing is listening there: the service is absent, or this profile's URL is stale${offsetHint}.`
      + `\n  Check \`quox doctor\`, or override for this shell: export QUOX_${String(service).toUpperCase()}_URL=<url>`;
  }
  return msg;
}

function generateCorrelationId() {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `cli-${t}-${r}`;
}

/**
 * HITL-CONTEXT (owner 2026-10-07): name the calling session and profile so an
 * approval this call triggers says "VULCAN (CLI) · profile moo" instead of a
 * bare agent id. Display-only on the server; never used for authorization.
 * Session: $QUOX_SESSION (the Claude/terminal session name).
 */
export function callerContextHeaders(config, env = process.env, detectDeps = {}) {
  const headers = {};
  const clean = (v, n) => String(v).replace(/[^\w .:@+\-/]/g, '').trim().slice(0, n);
  // QUOX_SESSION wins; otherwise auto-detect (QUOX_STREAM, attached agent,
  // held slot, parent process) so the card never says only "CLI".
  let session = env.QUOX_SESSION && clean(env.QUOX_SESSION, 48);
  if (!session) {
    try { session = detectCallerSource(env, detectDeps).label; } catch { session = null; }
  }
  if (session) headers['X-Quox-Session'] = clean(session, 48);
  let profile = null;
  try { profile = typeof config?.getActiveProfileName === 'function' ? config.getActiveProfileName() : null; } catch { profile = null; }
  if (profile) {
    const p = clean(profile, 32);
    if (p) headers['X-Quox-Profile'] = p;
  }
  return headers;
}

/**
 * The --debug "Body:" line. A sensitive request prints no body; otherwise top-level secret keys and
 * any nested `credentials` object are masked (a top-level-only denylist printed vault create keys).
 */
export function debugBody(body, sensitive = false) {
  if (sensitive) return '[redacted: sensitive request]';
  const sanitized = { ...body };
  for (const key of ['password', 'token', 'access_token', 'refresh_token', 'secret', 'api_key', 'mfa_code', 'credentials']) {
    if (sanitized[key]) sanitized[key] = '***';
  }
  return JSON.stringify(sanitized);
}

export function createClient(config, auth) {
  let refreshing = null;
  // After a failed refresh, back off instead of latching off forever. The
  // permanent latch was correct for 2-second CLI invocations but killed
  // long-lived daemons (2026-08-23: both resident supervisors poll-looped
  // to death after ONE transient refresh failure, because this instance
  // never tried again for the rest of its life). A cooldown keeps the
  // don't-hammer-auth property without the death sentence.
  const REFRESH_RETRY_COOLDOWN_MS = 60 * 1000;
  let refreshFailedAt = 0;
  const correlationId = generateCorrelationId();

  async function request(method, path, options = {}) {
    const {
      service = 'auth',
      body,
      query,
      headers: extraHeaders = {},
      timeout = 30000,
      raw = false,
      retries = MAX_RETRIES,
      noAuth = false,
      noActAs = false,
      sensitive = false,
    } = options;

    const baseUrl = config.getServiceUrl(service);
    const url = new URL(path, baseUrl);

    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value != null) url.searchParams.set(key, String(value));
      }
    }

    const fetchHeaders = {
      'X-Quox-Correlation': correlationId,
      'X-Quox-Client': 'cli',
      ...callerContextHeaders(config),
      ...extraHeaders,
    };

    // Inject auth. Precedence: a stored USER token always wins over an
    // ambient QUOX_SERVICE_KEY. The service key is the automation/daemon
    // fallback for when nobody has logged in — a long-running process
    // shelling out to this CLI has no human session and no refresh token,
    // so it can't participate in the login/refresh dance below.
    //
    // The other order was a live bug (quoxai/quox#404): dev boxes export
    // QUOX_SERVICE_KEY globally for quoxpert-mcp, so every command after a
    // successful `quox login` sent X-Service-Key instead of the user's
    // bearer token. The auth service's user endpoints (/api/auth/me and
    // friends) don't accept X-Service-Key, so login printed success (it
    // uses a raw fetch, bypassing this client) and everything after it 401'd.
    //
    // SEC: a custom header like X-Service-Key is NOT stripped by fetch on a
    // cross-origin redirect, unlike Authorization (which the spec drops).
    // That makes the long-lived, higher-privilege service key MORE exposed to
    // a rogue-redirect harvest than an ordinary user's bearer token. Refuse to
    // follow redirects at all when the service key is in play, so the key is
    // never resent to a host we did not choose. Scoped to the service-key path
    // deliberately: normal login flows keep their existing redirect behaviour.
    // QUOX_FORCE_SERVICE_KEY inverts the precedence above for a caller that
    // OWNS its service key and must never borrow the shared config's stored
    // session — a long-running daemon (discord-pro bridge, soak sampler) shares
    // ~/.config/quox/config.json, so whatever profile another process logged in
    // last leaks in as a stored token and wins. When that token drifts to an
    // identity the collector rejects, the daemon goes dark (2026-09-04: the
    // bridge 400'd for hours on a resident JWT). The force flag is
    // opt-in, so the #404 interactive-dev-box case is untouched.
    let usingServiceKey = false;
    // quox#772: opt-in acting identity (--as / QUOX_AS). Replaces the bearer
    // with the agent's attach token; throws (no request sent) if not attached.
    const acting = !noAuth && !noActAs ? await resolveActing({ explicitProfile: Boolean(config._explicitProfile) }) : { name: null };
    const actingAs = acting.name;
    if (actingAs) {
      const heartbeat = {
        post: (p, o) => request('POST', p, { ...o, noActAs: true }),
        get: (p, o) => request('GET', p, { ...o, noActAs: true }),
      };
      const attachToken = await resolveActingToken(actingAs, heartbeat, { implicit: acting.source === 'default' });
      fetchHeaders['Authorization'] = `Bearer ${attachToken}`;
    } else if (!noAuth) {
      const tokens = auth.getTokens();
      const serviceKey = process.env.QUOX_SERVICE_KEY;
      const forceServiceKey = !!process.env.QUOX_FORCE_SERVICE_KEY && !!serviceKey;
      if (forceServiceKey) {
        fetchHeaders['X-Service-Key'] = serviceKey;
        usingServiceKey = true;
      } else if (tokens?.access_token) {
        fetchHeaders['Authorization'] = `Bearer ${tokens.access_token}`;
      } else if (serviceKey) {
        fetchHeaders['X-Service-Key'] = serviceKey;
        usingServiceKey = true;
      }
    }

    if (body && !(body instanceof FormData)) {
      fetchHeaders['Content-Type'] = 'application/json';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const isDebug = process.argv.includes('--debug');

    if (isDebug) {
      console.error(`-> ${method} ${url.toString()}`);
      if (body && !(body instanceof FormData)) {
        console.error(`   Body: ${debugBody(body, sensitive).slice(0, 200)}`);
      }
    }

    let lastError;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url.toString(), {
          method,
          headers: fetchHeaders,
          body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
          ...(usingServiceKey ? { redirect: 'manual' } : {}),
        });

        // See the redirect note above: with redirect:'manual' a 3xx comes back
        // as a real response instead of being followed. Surface it loudly —
        // a Quox service should never redirect a CLI call, so this is either a
        // misconfiguration or someone trying to harvest the service key.
        if (usingServiceKey && res.status >= 300 && res.status < 400) {
          throw new QuoxApiError(
            `Refused to follow a ${res.status} redirect while authenticating with QUOX_SERVICE_KEY `
            + `(would resend the service key to ${res.headers.get('location') || 'an unknown host'}). `
            + 'Point QUOX_URL at the real collector instead of a redirecting front end.',
            res.status,
          );
        }

        if (isDebug) {
          console.error(`<- ${res.status} ${res.statusText} (${method} ${path})`);
        }

        // Auto-refresh on 401 — but only when the locally-tracked token
        // actually looks expired. A 401 can also come from a route that
        // requires entirely different credentials (e.g. a service-key-gated
        // /internal/* route hit with a valid, non-expired user token) — that
        // is not a session-expiry signal, and attempting a refresh anyway
        // risks the refresh call itself failing and wiping the whole stored
        // profile over what is really just "wrong token for this route".
        // In that case, skip the refresh and fall through to the normal
        // error handling below so the original 401/403 is surfaced as-is.
        const looksExpired = typeof auth.isExpired === 'function' ? auth.isExpired() : true;

        const refreshCoolingDown = refreshFailedAt && (Date.now() - refreshFailedAt < REFRESH_RETRY_COOLDOWN_MS);
        if (res.status === 401 && !noAuth && !actingAs && attempt === 0 && !refreshCoolingDown && looksExpired) {
          try {
            if (!refreshing) {
              const serviceUrl = config.getServiceUrl('auth');
              refreshing = auth.refresh(serviceUrl).finally(() => { refreshing = null; });
            }
            await refreshing;

            // Update auth header and retry
            const newTokens = auth.getTokens();
            if (newTokens?.access_token) {
              fetchHeaders['Authorization'] = `Bearer ${newTokens.access_token}`;
            }
            continue;
          } catch (refreshErr) {
            // Genuine refresh failure — start the retry cooldown and surface
            // a clear re-login prompt. A daemon's next request after the
            // cooldown gets another chance; see REFRESH_RETRY_COOLDOWN_MS.
            //
            // CARRY THE REAL REASON. A bare `catch {}` here replaced every
            // refresh failure with "Session expired", which is a GUESS at the
            // cause: auth.refresh() distinguishes a dead token from an
            // unhealthy service from a malformed request, and all three arrived
            // as the same sentence telling the user to log in again. That cost
            // hours on 2026-08-24, when the real cause was the CLI sending the
            // refresh token in a header the server never reads.
            clearTimeout(timer);
            if (refreshErr && refreshErr.transient) {
              // Auth is only temporarily unavailable (429 / restart): no
              // cooldown, and keep the type so a listener can back off.
              throw new QuoxTransientAuthError(`Re-authentication temporarily unavailable. ${refreshErr.message}`, refreshErr.retryAfterMs ?? null);
            }
            refreshFailedAt = Date.now();
            const why = refreshErr?.message ? ` ${refreshErr.message}` : '';
            throw new QuoxAuthError(`Session expired. Run \`quox login\` to re-authenticate.${why}`);
          }
        }

        // Retry transient errors
        if (RETRY_STATUSES.has(res.status) && attempt < retries) {
          const delay = RETRY_DELAYS[attempt] || 9000;
          if (isDebug) {
            console.error(`   Retrying in ${delay}ms (attempt ${attempt + 1}/${retries})...`);
          }
          await sleep(delay);
          continue;
        }

        clearTimeout(timer);

        if (raw) return res;

        if (!res.ok) {
          let data;
          try {
            data = await res.json();
          } catch {
            data = { error: 'unknown', message: res.statusText };
          }
          // A permission error while we silently fell back to the SERVICE
          // KEY is almost never a permissions problem: the service key
          // carries no user identity, so any route gated on who you are
          // refuses it. Say that, because the raw error sends people to fix
          // the wrong thing. Live cost, 2026-08-23: the instance owner hit
          // `403 instance_admin_required` on `quox admin config`, and it was
          // filed as a missing-role bug (quox#470) with a chicken-and-egg
          // theory about who could grant it. He had held instance-admin
          // since March. His session had simply expired and the CLI had
          // quietly downgraded the request to a key with no user attached.
          let message = data.message || `Request failed with status ${res.status}`;
          // quox#617: surface the server's machine-readable `reason`. A vault
          // update returns 403 with `reason: 'mfa_required'` for an MFA-enabled
          // owner (a step-up gate) vs `reason: 'role_<r>_lacks_capability_<cap>'`
          // for a genuine missing-permission — two very different fixes that
          // read as one opaque "you do not have permission" once the reason is
          // dropped. The body already carries it (and reaches .body below); we
          // just also fold it into the human message so the WHY is visible
          // without --debug. Skipped when the message already contains it.
          if (data.reason && !String(message).includes(data.reason)) {
            message += ` (reason: ${data.reason})`;
          }
          if (usingServiceKey && (res.status === 403 || res.status === 401)) {
            message += `\nNote: this request used the service key (QUOX_SERVICE_KEY) because no user session was stored for this profile. `
              + `The service key has no user identity, so anything gated on WHO you are will refuse it regardless of your real permissions. `
              + `Run \`quox login\` (or \`quox -p <profile> login\`) and retry before treating this as a permissions problem.`;
          }
          // LL-3d: carry the WHOLE body, not just message/detail. Endpoints
          // that answer with structured context (the licensing 409's
          // bound_instance_name / bound[] / max_servers, the 402's plugin)
          // had it flattened away here, so command handlers could only print
          // "Request failed with status 409".
          throw new QuoxApiError(
            res.status,
            data.error || 'api_error',
            message,
            data.detail || data.details,
            data
          );
        }

        // Handle empty responses (204 No Content)
        if (res.status === 204) return { success: true };

        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          return await res.json();
        }
        return { success: true, text: await res.text() };

      } catch (err) {
        clearTimeout(timer);

        if (err instanceof QuoxApiError || err instanceof QuoxAuthError) {
          throw err;
        }

        if (err.name === 'AbortError') {
          throw new QuoxNetworkError(`Request timed out after ${timeout}ms`);
        }

        lastError = err;

        if (attempt < retries && isTransientError(err)) {
          const delay = RETRY_DELAYS[attempt] || 9000;
          await sleep(delay);
          continue;
        }

        throw new QuoxNetworkError(
          describeNetworkError(service, baseUrl, err),
          err
        );
      }
    }

    throw lastError || new QuoxNetworkError('Request failed after retries');
  }

  /**
   * Open a Server-Sent Events (SSE) stream and yield parsed events.
   *
   * Mirrors the collector's `POST /chat/stream` contract (quox#782): when
   * `options.body` is given it is sent as a JSON POST body so prompts never
   * appear in the URL; `options.query` remains for non-sensitive params.
   * Response is `text/event-stream`
   * with `data: <json>\n\n` frames (plus `: ping` keep-alive comments).
   *
   * Each yielded value is the parsed JSON payload of one `data:` frame
   * (e.g. `{ type: 'connected', ... }`, `{ type: 'chunk', content: '...' }`,
   * `{ type: 'done', ... }`, `{ type: 'error', error: '...' }`). The
   * generator returns naturally on `done`/`error` events or when the
   * server closes the connection.
   *
   * @param {string} path - e.g. '/chat/stream'
   * @param {object} options
   * @param {string} [options.service='collector']
   * @param {object} [options.query] - query string params (never put prompts here)
   * @param {object} [options.body] - JSON body; switches the request to POST
   * @param {object} [options.headers] - extra headers
   * @param {AbortSignal} [options.signal] - external abort signal (e.g. Ctrl+C)
   * @param {boolean} [options.untilClose] - keep reading past done/error until the server closes (quoxon: turn.finished arrives after done)
   */
  async function* stream(path, options = {}) {
    const {
      service = 'collector',
      query,
      body: streamBody,
      headers: extraHeaders = {},
      signal: externalSignal,
      untilClose = false,
    } = options;

    const baseUrl = config.getServiceUrl(service);
    const url = new URL(path, baseUrl);

    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value != null) url.searchParams.set(key, String(value));
      }
    }

    const fetchHeaders = {
      Accept: 'text/event-stream',
      'X-Quox-Correlation': correlationId,
      ...(streamBody !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...extraHeaders,
    };

    // Same precedence as request() above, including the QUOX_FORCE_SERVICE_KEY
    // override for daemons that own their key and must not borrow the shared
    // config's stored session.
    const streamActingR = await resolveActing({ explicitProfile: Boolean(config._explicitProfile) });
    const streamActing = streamActingR.name;
    const streamTokens = auth.getTokens();
    let streamServiceKey = null;
    const streamForceKey = !!process.env.QUOX_FORCE_SERVICE_KEY && !!process.env.QUOX_SERVICE_KEY;
    if (streamActing) {
      const heartbeat = { post: (p, o) => request('POST', p, { ...o, noActAs: true }), get: (p, o) => request('GET', p, { ...o, noActAs: true }) };
      fetchHeaders['Authorization'] = `Bearer ${await resolveActingToken(streamActing, heartbeat, { implicit: streamActingR.source === 'default' })}`;
    } else if (streamForceKey) {
      streamServiceKey = process.env.QUOX_SERVICE_KEY;
      fetchHeaders['X-Service-Key'] = streamServiceKey;
    } else if (streamTokens?.access_token) {
      fetchHeaders['Authorization'] = `Bearer ${streamTokens.access_token}`;
    } else if (process.env.QUOX_SERVICE_KEY) {
      streamServiceKey = process.env.QUOX_SERVICE_KEY;
      fetchHeaders['X-Service-Key'] = streamServiceKey;
    }

    const isDebug = process.argv.includes('--debug');
    if (isDebug) {
      console.error(`-> ${streamBody !== undefined ? 'POST' : 'GET'}(stream) ${url.toString()}`);
    }

    let res;
    try {
      res = await fetch(url.toString(), {
        method: streamBody !== undefined ? 'POST' : 'GET',
        headers: fetchHeaders,
        ...(streamBody !== undefined ? { body: JSON.stringify(streamBody) } : {}),
        signal: externalSignal,
        // Same redirect protection as the non-streaming path above: never let
        // a 3xx resend X-Service-Key to a host we did not choose.
        ...(streamServiceKey ? { redirect: 'manual' } : {}),
      });
    } catch (err) {
      throw new QuoxNetworkError(
        describeNetworkError(service, baseUrl, err),
        err
      );
    }

    if (!res.ok) {
      let data;
      try {
        data = await res.json();
      } catch {
        data = { error: 'unknown', message: res.statusText };
      }
      throw new QuoxApiError(
        res.status,
        data.error || 'api_error',
        data.message || `Stream request failed with status ${res.status}`,
        data.detail || data.details,
        data
      );
    }

    if (!res.body) {
      throw new QuoxNetworkError('Stream response had no body.');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data:')) continue; // skip blank lines and ": ping" comments
          const raw = line.slice(5).trim();
          if (!raw || raw === '[DONE]') continue;

          let event;
          try {
            event = JSON.parse(raw);
          } catch {
            if (isDebug) console.error(`   [stream] skipping malformed frame: ${raw.slice(0, 100)}`);
            continue;
          }

          yield event;

          if (!untilClose && (event.type === 'done' || event.type === 'error')) {
            return;
          }
        }
      }
    } finally {
      // cancel first so the HTTP body is torn down, not just unlocked
      try { reader.cancel().catch(() => {}); } catch { /* already closed */ }
      try { reader.releaseLock(); } catch { /* already released */ }
    }
  }

  return {
    get(path, options) {
      return request('GET', path, options);
    },
    post(path, options) {
      return request('POST', path, options);
    },
    patch(path, options) {
      return request('PATCH', path, options);
    },
    put(path, options) {
      return request('PUT', path, options);
    },
    delete(path, options) {
      return request('DELETE', path, options);
    },
    request,
    stream,
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTransientError(err) {
  const msg = err.message || '';
  return msg.includes('ECONNRESET') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('fetch failed');
}
