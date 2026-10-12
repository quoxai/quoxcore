/**
 * Resident agent authentication for QuoxCLI (quox#453 phase 15)
 *
 * A dev server's resident agent authenticates with an Ed25519 key on disk
 * instead of a password, zero human minting. The exchange is a signed
 * challenge:
 *
 *   1. POST {baseUrl}/api/auth/resident/challenge {org_id, host_id}
 *        -> {challenge_id, challenge_b64, expires_in}
 *   2. sign the raw challenge bytes with the Ed25519 private key at key_path
 *   3. POST {baseUrl}/api/auth/resident/token {challenge_id, org_id, host_id, signature_b64}
 *        -> {access_token, token_type, expires_in, user}
 *
 * Bootstrap file on a dev host (not secret itself, points at the real key):
 *   ~/.config/quox/resident-profile.json
 *   {kind: 'resident', org_id, host_id, key_id, key_path, instance_url}
 *
 * Neither the private key nor any resulting token is ever printed or logged
 * by this module.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sign, createPrivateKey } from 'node:crypto';
import { QuoxError, QuoxAuthError, QuoxTransientAuthError } from './errors.js';

export function defaultResidentProfilePath() {
  return join(homedir(), '.config', 'quox', 'resident-profile.json');
}

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Load and validate the resident bootstrap profile.
 * @param {string} [explicitPath] - overrides the default ~/.config/quox/resident-profile.json
 */
export function loadResidentProfile(explicitPath) {
  const path = expandHome(explicitPath) || defaultResidentProfilePath();

  if (!existsSync(path)) {
    throw new QuoxError(
      `No resident profile found at ${path}. A resident agent needs this bootstrap file `
      + `({kind, org_id, host_id, key_id, key_path, instance_url}) before it can authenticate. `
      + `Run --resident-profile <path> to point at a different one.`
    );
  }

  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new QuoxError(`Could not read resident profile at ${path}: ${err.message}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new QuoxError(`Resident profile at ${path} is not valid JSON: ${err.message}`);
  }

  const required = ['org_id', 'host_id', 'key_path'];
  const missing = required.filter((key) => !data[key]);
  if (missing.length > 0) {
    throw new QuoxError(
      `Resident profile at ${path} is missing required field(s): ${missing.join(', ')}.`
    );
  }

  return { ...data, kind: 'resident', _path: path };
}

/**
 * Prefer the bootstrap file's instance_url when the active CLI profile has
 * no explicit URL of its own: a resident agent bootstraps its own instance
 * pointer, it shouldn't need a human to also run `quox config`.
 */
export function resolveResidentBaseUrl(config, profile) {
  // quox#455 gap 1: the resident endpoints live on the instance EDGE
  // (https://<host>:3000/api/auth/resident/*, proxied to auth). NEVER
  // derive them by port-swapping to :3101: auth binds loopback on the
  // control box, so :3101 is connection-refused from every remote host.
  if (process.env.QUOX_AUTH_URL) return process.env.QUOX_AUTH_URL;
  if (process.env.QUOX_URL) return process.env.QUOX_URL;
  const activeProfile = typeof config.getActiveProfile === 'function' ? config.getActiveProfile() : null;
  const hasExplicitUrl = !!(activeProfile && activeProfile.url && activeProfile.url !== 'http://localhost:3000');
  if (hasExplicitUrl) return activeProfile.url;
  if (profile?.instance_url) return profile.instance_url;
  // Local default profile on the control box itself: auth is directly
  // reachable on loopback :3101, keep the historical local-dev behaviour.
  return config.getServiceUrl('auth');
}

/**
 * True only when `urlStr` is https AND its host is a bare IP or a
 * .local/LAN-style single-label name: the shapes that can never carry a
 * real, publicly-issued certificate, so a self-signed edge is the expected
 * (not the exceptional) case. A public FQDN with a real cert must never get
 * this baked in, even if it happens to be reachable over the LAN.
 */
function isSelfSignedLikelyHost(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname;
  if (!host) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true; // bare IPv4
  if (host.includes(':')) return true; // bare IPv6 (URL strips the brackets)
  if (/\.local$/i.test(host)) return true; // mDNS / LAN-style
  if (!host.includes('.')) return true; // single-label hostname, never a public FQDN
  return false;
}

/**
 * Derive the systemd unit environment for a resident's headless supervisor
 * from its bootstrap profile (item 1, live outage 2026-08-23: a unit run
 * directly by systemd inherits none of the caller's shell environment, so
 * every re-auth against a self-signed LAN edge died with a bare "fetch
 * failed"). Baked in once, at install time, from the same profile the
 * resident already trusts for its own identity: QUOX_URL and QUOX_AUTH_URL
 * from instance_url, QUOX_COLLECTOR_URL from collector_url, and
 * QUOX_INSECURE only when isSelfSignedLikelyHost(instance_url) is true.
 * Returns {} for a missing profile or a profile with neither URL: the
 * caller is responsible for warning in that case, this function only ever
 * derives, never decides whether the result is enough.
 */
export function deriveSupervisorEnv(profile) {
  const env = {};
  if (!profile) return env;
  if (profile.instance_url) {
    env.QUOX_URL = profile.instance_url;
    env.QUOX_AUTH_URL = profile.instance_url;
    if (isSelfSignedLikelyHost(profile.instance_url)) env.QUOX_INSECURE = '1';
  }
  if (profile.collector_url) env.QUOX_COLLECTOR_URL = profile.collector_url;
  return env;
}

const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

// Retry-After is delta-seconds or an HTTP date; returns ms or null.
function parseRetryAfterMs(res) {
  const raw = res?.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function exchangeFailure(what, res, data) {
  const msg = `${what} failed (${res.status}): ${data?.error || res.statusText || 'unknown error'}`;
  if (TRANSIENT_STATUSES.has(res.status)) return new QuoxTransientAuthError(msg, parseRetryAfterMs(res));
  return new QuoxAuthError(msg);
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Run the challenge/sign/token exchange and return the token response.
 * Never logs the private key or the returned token.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {object} opts.profile - result of loadResidentProfile()
 * @param {typeof fetch} [opts.fetchImpl]
 */
export async function residentLogin({ baseUrl, profile, fetchImpl = fetch }) {
  const { org_id, host_id, key_path } = profile;
  const keyPath = expandHome(key_path);

  if (!existsSync(keyPath)) {
    throw new QuoxError(
      `Resident identity key not found at ${keyPath}. Provision the Ed25519 key before logging in.`
    );
  }

  let keyPem;
  try {
    keyPem = readFileSync(keyPath, 'utf-8');
  } catch (err) {
    throw new QuoxError(`Could not read resident identity key at ${keyPath}: ${err.message}`);
  }

  let privateKey;
  try {
    privateKey = createPrivateKey(keyPem);
  } catch (err) {
    throw new QuoxError(`Resident identity key at ${keyPath} is not a valid private key: ${err.message}`);
  }

  // Step 1: request a fresh challenge.
  const challengeRes = await fetchImpl(`${baseUrl}/api/auth/resident/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ org_id, host_id }),
  });
  const challengeData = await safeJson(challengeRes);
  if (!challengeRes.ok) {
    throw exchangeFailure('Resident challenge request', challengeRes, challengeData);
  }
  const { challenge_id, challenge_b64 } = challengeData || {};
  if (!challenge_id || !challenge_b64) {
    throw new QuoxError('Resident challenge response is missing challenge_id or challenge_b64.');
  }

  // Step 2: sign the raw challenge bytes with the Ed25519 key.
  const challengeBytes = Buffer.from(challenge_b64, 'base64');
  const signatureBytes = sign(null, challengeBytes, privateKey);
  const signature_b64 = signatureBytes.toString('base64');

  // Step 3: exchange the signature for an access token.
  const tokenRes = await fetchImpl(`${baseUrl}/api/auth/resident/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challenge_id, org_id, host_id, signature_b64 }),
  });
  const tokenData = await safeJson(tokenRes);
  if (!tokenRes.ok) {
    throw exchangeFailure('Resident token exchange', tokenRes, tokenData);
  }
  if (!tokenData?.access_token) {
    throw new QuoxError('Resident token response is missing access_token.');
  }

  return tokenData;
}
