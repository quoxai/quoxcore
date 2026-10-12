/**
 * Website admin session for owner-only licence verbs (GRIPE-715 phase 2).
 *
 * `quox licence reissue` and `quox licence catalogue-sign` talk to the quox.ai
 * WEBSITE admin API, not to this instance, so they need their own credential,
 * separate from the instance profile in config.json.
 *
 * What is stored: per website profile, the base URL, the admin username and
 * the website session cookie (`quox.sid`, 24h). The password is used once for
 * POST /api/admin/login and never written anywhere. The file is 0600. Nothing
 * here prints the cookie.
 *
 * File: ~/.config/quox/website-sessions.json (QUOX_WEBSITE_SESSION_FILE overrides,
 * used by tests).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { QuoxError, QuoxValidationError } from './errors.js';

export const DEFAULT_WEBSITE_URL = 'https://quox.ai';
export const DEFAULT_WEBSITE_PROFILE = 'default';
const SESSION_COOKIE = 'quox.sid';

export function sessionFilePath() {
  return process.env.QUOX_WEBSITE_SESSION_FILE || join(homedir(), '.config', 'quox', 'website-sessions.json');
}

function readStore(file = sessionFilePath()) {
  if (!existsSync(file)) return { profiles: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed.profiles === 'object' ? parsed : { profiles: {} };
  } catch {
    return { profiles: {} };
  }
}

function writeStore(store, file = sessionFilePath()) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export function normaliseWebsiteUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new QuoxValidationError(`Invalid website URL: ${url}`); }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !local) {
    throw new QuoxValidationError('The website URL must be https (the session cookie is a credential); http is allowed only for localhost');
  }
  return `${u.protocol}//${u.host}`;
}

export function getWebsiteSession(profile = DEFAULT_WEBSITE_PROFILE) {
  return readStore().profiles[profile] || null;
}

export function saveWebsiteSession(profile, session) {
  const store = readStore();
  store.profiles[profile] = session;
  writeStore(store);
}

export function clearWebsiteSession(profile) {
  const store = readStore();
  const had = !!store.profiles[profile];
  delete store.profiles[profile];
  writeStore(store);
  return had;
}

/** Pull `quox.sid=<value>` out of the Set-Cookie header(s). */
export function extractSessionCookie(headers) {
  const list = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie')].filter(Boolean);
  for (const line of list) {
    for (const part of String(line).split(/,(?=\s*[^;,=\s]+=)/)) {
      const pair = part.trim().split(';')[0];
      if (pair.startsWith(`${SESSION_COOKIE}=`)) return pair;
    }
  }
  return null;
}

async function readJson(res) {
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return { error: text.slice(0, 200) }; }
}

/** Log in to the website admin API. Returns the session to save; never the password. */
export async function websiteLogin({ url, username, password, fetchImpl = globalThis.fetch }) {
  const base = normaliseWebsiteUrl(url);
  const res = await fetchImpl(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username, password }),
    redirect: 'manual',
  });
  const body = await readJson(res);
  if (!res.ok) throw new QuoxError(`Website login failed (HTTP ${res.status}): ${body.error || 'no detail'}`, 3);
  const cookie = extractSessionCookie(res.headers);
  if (!cookie) throw new QuoxError('Website login returned no session cookie; nothing saved', 3);
  return {
    url: base,
    username: body.username || username,
    cookie,
    must_change_password: !!body.mustChangePassword,
    saved_at: new Date().toISOString(),
  };
}

/**
 * POST to a website admin route with the saved session. Checks the status
 * before trusting the body; a 401 means the 24h session lapsed.
 */
export async function websitePost(profile, path, body, { fetchImpl = globalThis.fetch } = {}) {
  const session = getWebsiteSession(profile);
  if (!session?.cookie) {
    throw new QuoxError(`No website session for profile "${profile}". Run: quox licence website-login${profile === DEFAULT_WEBSITE_PROFILE ? '' : ` --website-profile ${profile}`}`, 3);
  }
  let res;
  try {
    res = await fetchImpl(`${session.url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Cookie: session.cookie },
      body: JSON.stringify(body || {}),
      redirect: 'manual',
    });
  } catch (err) {
    throw new QuoxError(`Could not reach the website admin API at ${session.url}: ${err.message}`, 7);
  }
  const data = await readJson(res);
  if (res.status === 401) {
    throw new QuoxError(`Website session expired or invalid (HTTP 401 from ${session.url}). Run: quox licence website-login`, 3);
  }
  if (!res.ok) {
    const err = new QuoxError(`Website API ${path} failed (HTTP ${res.status}${data.code ? ` ${data.code}` : ''}): ${data.error || 'no detail'}`, res.status === 403 ? 4 : 1);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}
