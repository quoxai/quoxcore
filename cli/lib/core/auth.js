/**
 * Auth module for QuoxCLI
 *
 * Handles login, logout, token storage, and auto-refresh.
 * Tokens stored in config profile's auth field.
 */

import { readFileSync, statSync } from 'node:fs';
import { QuoxAuthError, QuoxApiError, QuoxTransientAuthError } from './errors.js';
import { loadResidentProfile, residentLogin, resolveResidentBaseUrl } from './residentAuth.js';

// A resident agent has no refresh token: its expired-access-token seam is
// re-running the signed challenge exchange, not demanding `quox login`,
// since there is no human at the terminal to run it. Kept as a standalone helper
// so createAuth()'s refresh() stays the single seam client.js already calls
// on a 401, per quox#453 phase 15.
async function refreshResident(config, baseUrl, storedAuth) {
  let profile;
  try {
    profile = loadResidentProfile(storedAuth.resident_profile_path);
  } catch (err) {
    throw new QuoxAuthError(`Resident re-authentication failed: ${err.message}`);
  }

  // The caller passes getServiceUrl('auth'), which can port-swap to
  // loopback :3101 and be unreachable from a remote host, so the resident
  // rules (bootstrap instance_url / explicit profile URL) come FIRST. But
  // edge-only was its own outage (2026-08-23, both residents): on the
  // control box the edge is self-signed https, the systemd unit has no CA
  // trust, and the one URL that does work there is exactly the
  // services-aware one the caller passed (plain-http loopback auth). Try
  // the resident-rules URL, then fall back to the caller's, and only die
  // if both refuse. An unattended runner must exhaust its options before
  // giving up: Option A persistence depends on this.
  const candidates = [...new Set([resolveResidentBaseUrl(config, profile), baseUrl].filter(Boolean))];

  let tokenData;
  const failures = [];
  const errs = [];
  for (const candidate of candidates) {
    try {
      tokenData = await residentLogin({ baseUrl: candidate, profile });
      break;
    } catch (err) {
      failures.push(`${candidate}: ${err.message}`);
      errs.push(err);
    }
  }
  if (!tokenData) {
    // Every candidate failed for a reason that clears by itself (429, 5xx,
    // connection refused/reset/timeout): surface a typed transient error so a
    // long-lived listener can back off instead of dying.
    const isTransient = (e) => e instanceof QuoxTransientAuthError
      || (!(e instanceof QuoxAuthError) && /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|timed? ?out/i.test(`${e?.message} ${e?.cause?.code || ''} ${e?.cause?.message || ''}`));
    if (errs.length > 0 && errs.every(isTransient)) {
      const waits = errs.map((e) => e.retryAfterMs).filter((n) => Number.isFinite(n));
      throw new QuoxTransientAuthError(`Resident re-authentication failed: ${failures.join('; ')}`, waits.length ? Math.max(...waits) : null);
    }
    throw new QuoxAuthError(`Resident re-authentication failed: ${failures.join('; ')}`);
  }

  const authData = {
    ...storedAuth,
    access_token: tokenData.access_token,
    user_id: tokenData.user?.id ?? storedAuth.user_id,
    email: tokenData.user?.email ?? storedAuth.email,
    org_role: tokenData.user?.role ?? storedAuth.org_role,
    actor_type: tokenData.user?.actor_type ?? storedAuth.actor_type,
    host_id: tokenData.user?.host_id ?? storedAuth.host_id,
    expires_at: Date.now() + (tokenData.expires_in || 900) * 1000,
  };
  config.setAuth(authData, { refresh: true });
  return tokenData;
}

// When a password-backed session dead-ends (revoked or expired) the only
// recovery is an interactive `quox login`, which an unattended agent cannot
// run. A resident profile, if one is configured, IS that recovery: durable,
// passwordless, self-renewing. Build a one-line pointer to it, preferring a
// resident on the same org as the profile that just died. Returns '' when no
// resident profile exists (nothing useful to suggest). Never throws — a
// hint-builder must not become a new failure seam in the auth path.
function residentProfileHint(config, deadOrgId = null) {
  try {
    const residents = typeof config.listResidentProfiles === 'function'
      ? config.listResidentProfiles()
      : [];
    if (!residents.length) return '';
    const sameOrg = deadOrgId ? residents.find(r => r.orgId === deadOrgId) : null;
    const pick = sameOrg || residents[0];
    return ` For unattended automation use the durable resident profile instead: `
      + `\`quox -p ${pick.name} <command>\` (Ed25519, no password, self-renews — never needs re-login).`;
  } catch {
    return '';
  }
}

// QUOX_TOKEN_FILE: the W4 builder principal (SDK-TEAM design v2, 2.1.3) runs
// on ONE agent token that an owner-side helper writes to a file and rewrites
// near expiry. The builder holds no refresh token, no user session and no
// service key, so this mode is exclusive and fails CLOSED: the file's token or
// nothing, never the profile, never an ambient QUOX_SERVICE_KEY. Its "refresh"
// is re-reading the file; it never calls the auth service and never writes or
// clears the profile.
function tokenFilePath() {
  return process.env.QUOX_TOKEN_FILE || null;
}

function readTokenFile(file) {
  let st;
  try {
    st = statSync(file);
  } catch {
    throw new QuoxAuthError(`QUOX_TOKEN_FILE ${file} is not readable. The owner-side builder helper writes it; is the lease live?`);
  }
  if (st.mode & 0o004) {
    throw new QuoxAuthError(`QUOX_TOKEN_FILE ${file} is readable by other users (mode ${(st.mode & 0o777).toString(8)}); refusing to use it. Expected 0640 or tighter.`);
  }
  const token = readFileSync(file, 'utf8').trim();
  if (!token) throw new QuoxAuthError(`QUOX_TOKEN_FILE ${file} is empty.`);
  return { access_token: token, expires_at: jwtExpiryMs(token), token_file: file };
}

// Expiry only, for the client's "looks expired, try the refresh seam" signal.
// Not verification: the server verifies. Undecodable means no local expiry.
function jwtExpiryMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Keep the last login email on the profile (not a secret) so a signed-out session can prefill /login. */
export function rememberEmail(config, email) {
  try {
    const prof = config.getActiveProfile?.();
    if (prof && email && prof.last_email !== email) { prof.last_email = email; config.save?.(); }
  } catch { /* best-effort */ }
}

export function createAuth(config) {
  return {
    async login(baseUrl, email, password, orgId) {
      if (tokenFilePath()) {
        throw new QuoxAuthError('QUOX_TOKEN_FILE is set: this principal runs on its issued token only and cannot log in as a user.');
      }
      const url = `${baseUrl}/api/auth/login`;
      // client: 'cli' marks this a CLI/TUI sign-in so the server gives it the longer CLI session window.
      const body = { email, password, client: 'cli' };
      if (orgId) body.org_id = orgId;

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new QuoxApiError(res.status, data.error, data.message || 'Login failed');
      }

      // Store auth data
      const authData = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        user_id: data.user?.id,
        email: data.user?.email,
        display_name: data.user?.display_name,
        org_id: data.org?.id || null,
        org_name: data.org?.name || null,
        org_slug: data.org?.slug || null,
        org_role: data.org?.role || null,
        mfa_required: data.mfa_required,
        expires_at: Date.now() + (data.expires_in || 900) * 1000,
      };

      config.setAuth(authData);
      rememberEmail(config, email);
      return { ...data, authData };
    },

    async verifyMfa(baseUrl, token, code) {
      const url = `${baseUrl}/api/mfa/verify`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ code }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new QuoxApiError(res.status, data.error, data.message || 'MFA verification failed');
      }

      // Update stored token if new one issued
      if (data.access_token) {
        const auth = config.getAuth();
        auth.access_token = data.access_token;
        auth.mfa_required = false;
        if (data.expires_in) auth.expires_at = Date.now() + data.expires_in * 1000;
        config.setAuth(auth);
      }

      return data;
    },

    async logout(baseUrl) {
      const auth = config.getAuth();
      if (auth?.access_token) {
        try {
          await fetch(`${baseUrl}/api/auth/logout`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${auth.access_token}` },
          });
        } catch {
          // Best-effort server-side logout
        }
      }
      config.clearAuth();
    },

    async refresh(baseUrl) {
      const tokenFile = tokenFilePath();
      if (tokenFile) {
        const before = this._tokenFileLast;
        const now = readTokenFile(tokenFile);
        const stillExpired = now.expires_at && Date.now() > now.expires_at;
        if (stillExpired || (before && now.access_token === before)) {
          throw new QuoxAuthError(`QUOX_TOKEN_FILE ${tokenFile} has not been renewed; the owner-side helper re-mints it. Not falling back to any other credential.`);
        }
        this._tokenFileLast = now.access_token;
        return { access_token: now.access_token };
      }
      const auth = config.getAuth();

      // Resident agents authenticate via a signed challenge, not a refresh
      // token; see refreshResident() above.
      if (auth?.kind === 'resident') {
        return refreshResident(config, baseUrl, auth);
      }

      if (!auth?.refresh_token) {
        throw new QuoxAuthError('No refresh token. Please login again.');
      }

      // The token goes in the BODY. POST /api/auth/refresh reads
      // `req.cookies.refresh_token || req.body.refresh_token` and never looks
      // at the Authorization header, so sending it only as a Bearer header
      // meant the server saw no token at all: it answered `no_refresh_token`,
      // /health answered OK, and the clearing branch below destroyed a
      // perfectly good session. That is the "logged in, then Session expired
      // twenty minutes later" outage, logged three separate times before
      // anyone read the transport rather than the error text. Verified live
      // 2026-08-24: header -> no_refresh_token, body -> invalid_refresh_token.
      // The header is kept because it costs nothing and other deployments may
      // read it.
      const res = await fetch(`${baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${auth.refresh_token}`,
        },
        body: JSON.stringify({ refresh_token: auth.refresh_token }),
      });

      let data = null;
      try { data = await res.json(); } catch { /* non-JSON error body */ }
      if (!res.ok) {
        // Only a DEFINITIVE rejection (401/403) means the refresh token is
        // dead. A 5xx or gateway hiccup must NOT destroy the stored session:
        // on 2026-08-15 a wiped profile here erased the only copy of a
        // rejected refresh token before anyone could diagnose WHY the auth
        // service rejected it.
        // `no_refresh_token` means the REQUEST carried nothing, not that the
        // stored token is dead. Clearing on it turns a client-side transport
        // fault into a lost session, which is exactly how the header/body bug
        // above cost three re-logins in one night before it was found.
        if ((data && data.error) === 'no_refresh_token') {
          throw new QuoxAuthError(
            'The auth service received no refresh token, so it could not tell whether yours is valid. '
            + 'Stored session KEPT. This is a client/transport fault, not an expiry — retry, and report it if it persists.'
          );
        }

        if (res.status === 401 || res.status === 403) {
          // A 401 from refresh means one of TWO very different things, and
          // destroying the session on the wrong one costs the user their login.
          //
          //   (a) the refresh token really is dead  -> clearing is correct
          //   (b) the auth service is not READY yet -> clearing is data loss
          //
          // 2026-08-19: rebuilding the auth container logged out every CLI
          // session, twice in one evening, because a starting service answers
          // 401 before it can answer properly. For an autonomous agent that is
          // a hard stop mid-task; for a customer it is a surprise re-login
          // after any routine restart. The old comment here already refused to
          // clear on a 5xx for the same reason — this is the same hazard one
          // status code over.
          //
          // So ask the service whether it is healthy before believing it about
          // the token. Unreachable or unhealthy means we learned nothing about
          // the token, and a session is far more expensive to lose than a
          // command is to retry.
          let healthy = false;
          try {
            const h = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
            healthy = h.ok;
          } catch {
            healthy = false;
          }
          if (!healthy) {
            throw new QuoxAuthError(
              `Auth service is not healthy right now (refresh returned ${res.status} but /health did not answer OK). ` +
              `Stored session KEPT — this is very likely a restart or deploy in progress. Retry in a moment.`
            );
          }
          config.clearAuth({ refresh: true });
          const dead = new QuoxAuthError(
            `Session expired (refresh rejected: ${(data && data.error) || res.status}). Please login again.`
            + residentProfileHint(config, auth?.org_id),
          );
          // Machine-readable, so the TUI can say WHY (idle_timeout | max_session, from the server's session policy).
          dead.code = 'session_expired';
          dead.reason = (data && data.reason) || null;
          throw dead;
        }
        throw new QuoxAuthError(`Token refresh failed (${res.status}); stored session kept. Retry, or login again if this persists.`);
      }

      auth.access_token = data.access_token;
      // The route does not rotate the refresh token today. If it ever starts,
      // silently dropping the new one would make the NEXT refresh fail and
      // clear the session: the same outage with a different first cause.
      if (data.refresh_token) auth.refresh_token = data.refresh_token;
      if (data.expires_in) auth.expires_at = Date.now() + data.expires_in * 1000;
      config.setAuth(auth, { refresh: true });
      return data;
    },

    getTokens() {
      const tokenFile = tokenFilePath();
      if (tokenFile) {
        const t = readTokenFile(tokenFile);
        this._tokenFileLast = t.access_token;
        return t;
      }
      return config.getAuth();
    },

    isLoggedIn() {
      const tokenFile = tokenFilePath();
      if (tokenFile) {
        try { readTokenFile(tokenFile); return true; } catch { return false; }
      }
      // Precedence, matching client.js: a stored USER token is what we
      // actually authenticate with, so it decides this answer. A configured
      // QUOX_SERVICE_KEY still counts as authenticated on its own, but only
      // as the automation/daemon fallback when nobody has logged in.
      //
      // Checking the env var first was a live bug (quoxai/quox#404): dev
      // boxes export QUOX_SERVICE_KEY globally, so the CLI reported
      // "logged in" off the ambient key while sending the wrong credential.
      const auth = config.getAuth();
      // QUOX_FORCE_SERVICE_KEY: a daemon that owns its key deliberately bypasses
      // any stored session (see client.js), so the key alone decides here.
      if (process.env.QUOX_FORCE_SERVICE_KEY && process.env.QUOX_SERVICE_KEY) return true;
      if (auth?.access_token) return true;
      return !!process.env.QUOX_SERVICE_KEY;
    },

    isExpired() {
      const tokenFile = tokenFilePath();
      if (tokenFile) {
        try {
          const { expires_at } = readTokenFile(tokenFile);
          return expires_at ? Date.now() > expires_at : false;
        } catch {
          return true;
        }
      }
      // A forced service key is not a locally-tracked JWT: never "expired".
      if (process.env.QUOX_FORCE_SERVICE_KEY && process.env.QUOX_SERVICE_KEY) return false;
      // A stored user token is the credential in play (see isLoggedIn), so
      // its expiry is the one that matters — an ambient service key must not
      // suppress the expiry signal, or client.js's 401 auto-refresh path
      // (which only fires when isExpired() is true) would never refresh a
      // genuinely expired session.
      const auth = config.getAuth();
      if (auth?.access_token) {
        if (!auth.expires_at) return true;
        return Date.now() > auth.expires_at;
      }
      // Service-key mode: not a JWT with a locally-tracked expiry, so treat
      // it as never expired and never attempt a refresh for it.
      if (process.env.QUOX_SERVICE_KEY) return false;
      if (!auth?.expires_at) return true;
      return Date.now() > auth.expires_at;
    },

    requireAuth() {
      if (!this.isLoggedIn()) {
        // Name the PROFILE. "Run `quox login`" alone sent the owner in a
        // circle on 2026-08-23: he ran `quox login`, saw it succeed, then
        // `quox -p moo dev enable` still refused, because the login had
        // stored its session in whichever profile was active at the time
        // while -p pointed at a different one. The advice was literally
        // true and still useless, because it omitted the only detail that
        // mattered.
        const name = typeof config.getActiveProfileName === 'function' ? config.getActiveProfileName() : null;
        const activeOrgId = config.getAuth()?.org_id || null;
        if (name) {
          throw new QuoxAuthError(
            `Not authenticated on profile "${name}". Run \`quox -p ${name} login\`. `
            + `Note that \`quox login\` without -p logs into whichever profile is active, which may not be this one.`
            + residentProfileHint(config, activeOrgId)
          );
        }
        throw new QuoxAuthError(`Not authenticated. Run \`quox login\` first.${residentProfileHint(config, activeOrgId)}`);
      }
    },

    getOrgId(overrideOrg) {
      if (overrideOrg) return overrideOrg;
      const auth = config.getAuth();
      return auth?.org_id || null;
    },
  };
}
