/**
 * C2c: finishing a fresh install from the CLI (FIRST_RUN_JOURNEY.md steps 6, 7 and 9).
 *
 *   createOwner  POST /api/setup/admin        the instance's own first-owner route (refuses once an
 *                                             owner exists; creates user, default org, membership)
 *   signIn       POST /api/auth/login          via core/auth.js login(): the profile stores the login
 *                                             token in its existing format. The password is never stored.
 *   storeCredential  connect.js connectFlow    server-side test, then the governed vault write as the
 *                                             org default (POST /api/orgs/:org/vault, audited, label
 *                                             "<Name> …last4"). The held key is dropped right after.
 *   loginLink    POST /api/auth/login-link     a 10 minute, single-use, user+org bound sign-in link,
 *                                             joined to the dashboard URL the installer printed.
 *
 * The CLI talks to the services the way every other command does: profile url https://localhost:3000,
 * services derived to their loopback ports (auth 127.0.0.1:3101), so the self-signed edge certificate
 * never meets the CLI. Only the browser sees it, through the link.
 */
import { randomBytes, randomInt } from 'node:crypto';
import { connectFlow } from '../connect.js';

export const LOCAL_PROFILE_URL = 'https://localhost:3000';

// The auth service's rules (services/auth/utils/passwordValidation.js).
const SPECIAL = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/;
export function passwordProblem(pw) {
  const p = String(pw ?? '');
  if (p.length < 12) return 'Use at least 12 characters.';
  if (p.length > 256) return 'Use at most 256 characters.';
  if (!/[A-Z]/.test(p)) return 'Add an uppercase letter.';
  if (!/[a-z]/.test(p)) return 'Add a lowercase letter.';
  if (!/[0-9]/.test(p)) return 'Add a number.';
  if (!SPECIAL.test(p)) return 'Add a special character, for example - or !';
  return null;
}
export const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e ?? '').trim());

/** 3 groups of 6 from an unambiguous alphabet, joined with '-', plus one guaranteed digit and capital. */
export function generatePassword() {
  const A = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    const bytes = randomBytes(18);
    const groups = [0, 1, 2].map(g => Array.from(bytes.subarray(g * 6, g * 6 + 6), b => A[b % A.length]).join(''));
    const pw = `${groups.join('-')}-${randomInt(2, 10)}${'ABCDEFGHJKLMNPQRSTUVWXYZ'[randomInt(0, 24)]}`;
    if (!passwordProblem(pw)) return pw;
  }
}

const apiError = (e, fallback) => (e?.message && !/^\s*$/.test(e.message) ? e.message : fallback);

/**
 * -> finisher { kind, profileUrl, createOwner, signIn, storeCredential, loginLink }
 * Dependencies are the CLI's own modules; tests run them for real against a fake instance.
 */
export async function createFinisher({ profileUrl = LOCAL_PROFILE_URL, fetchImpl = globalThis.fetch } = {}) {
  const { loadConfig } = await import('../../core/config.js');
  const { createAuth } = await import('../../core/auth.js');
  const { createClient } = await import('../../core/client.js');
  const { createApi } = await import('../api.js');

  // Nothing is written here: the profile is pointed at the new instance only at sign-in, so leaving
  // Getting started early never leaves a half-configured profile behind.
  const config = loadConfig();
  const auth = createAuth(config);
  const client = createClient(config, auth);
  const authUrl = () => config.getServiceUrl('auth');

  return {
    kind: 'real',
    profileUrl,
    authUrl,

    /** -> { ok: true } | { ok: false, existed?: true, error } */
    async createOwner({ email, password, name }) {
      const display = name || String(email).split('@')[0];
      let r;
      try {
        r = await fetchImpl(`${authUrl()}/api/setup/admin`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: String(email).trim(), password, name: display, display_name: display })
        });
      } catch (e) { return { ok: false, error: `the auth service did not answer: ${e?.cause?.code || e?.message}` }; }
      let body = null;
      try { body = await r.json(); } catch { /* not json */ }
      if (r.ok && body?.success) return { ok: true };
      if (r.status === 400 && body?.error === 'admin_exists') return { ok: false, existed: true, error: body.message };
      return { ok: false, error: body?.message || `HTTP ${r.status}` };
    },

    /** -> { ok: true, org } | { ok: false, error }. Stores the login token in the active profile. */
    async signIn({ email, password }) {
      try {
        config.setProfileConnection({ url: profileUrl });
        const data = await auth.login(authUrl(), String(email).trim(), password);
        if (data?.mfa_required) return { ok: false, error: 'This account uses MFA. Finish signing in with: quox login' };
        return { ok: true, org: data?.org?.name || null };
      } catch (e) { return { ok: false, error: apiError(e, 'sign-in failed') }; }
    },

    /** held: a held secret from credential.js (or null). -> connectFlow result | { ok: false, skipped: true } */
    async storeCredential(held) {
      if (!held || typeof held.reveal !== 'function') return { ok: false, skipped: true };
      try {
        const api = createApi({ client, config, auth });
        return await connectFlow(api, held.provider, held.reveal());
      } finally {
        held.drop();
      }
    },

    /** -> { ok: true, url, expiresAt, ttlSeconds } | { ok: false, error } */
    async loginLink(dashboardUrl) {
      try {
        const r = await client.post('/api/auth/login-link', { service: 'auth', body: {}, retries: 0 });
        if (!r?.path || !/^\/api\/auth\/login-link\/consume\?t=/.test(r.path)) return { ok: false, error: 'unexpected answer from the auth service' };
        return { ok: true, url: new URL(r.path, dashboardUrl || profileUrl).href, expiresAt: r.expires_at, ttlSeconds: r.ttl_seconds };
      } catch (e) { return { ok: false, error: apiError(e, 'could not create the link') }; }
    }
  };
}
