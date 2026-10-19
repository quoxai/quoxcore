/**
 * orgResolve.js: turn a --org / QUOX_ORG_ID value into an org ID (#1141).
 *
 * The root flag is documented as `--org <slug>`, but the value used to be sent
 * verbatim as the org ID, so `quox --org quox-development vault types` hit
 * /api/orgs/quox-development/... and answered 404 org_not_found.
 *
 *   - ID-shaped (ULID or UUID)          -> unchanged, no call
 *   - the session org's slug or name    -> its id, no call
 *   - otherwise                         -> the caller's org list, matched by the
 *     same matchOrg the TUI `/org switch` uses (exact slug, then exact id/slug/
 *     name, then every word in the name or slug), cached per profile (10 min)
 *   - unknown                           -> error listing the caller's org slugs
 *   - ambiguous                         -> error listing the matches
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { QuoxValidationError } from './errors.js';
import { matchOrg } from '../quoxon/orgSwitch.js';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ORG_CACHE_TTL_MS = 10 * 60 * 1000;

export const isOrgId = (v) => ULID.test(String(v ?? '').trim()) || UUID.test(String(v ?? '').trim());

const defaultCachePath = () => join(homedir(), '.config', 'quox', 'org-cache.json');
const readCache = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) || {}; } catch { return {}; } };
const writeCache = (p, data) => {
  try { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(data), { mode: 0o600 }); } catch { /* cache only */ }
};
const label = (o) => o.slug || o.name || o.id;

/**
 * @param {string} value                 the --org / QUOX_ORG_ID value
 * @param {object} opts
 * @param {string} [opts.profile]        cache key (the effective profile name)
 * @param {object|null} [opts.authData]  stored auth (org_id, org_slug, org_name)
 * @param {() => Promise<object[]>} opts.listOrgs  the caller's orgs ({ id, slug, name })
 * @param {string} [opts.source]         how the value was given, for error text
 * @returns {Promise<string>} the org ID
 */
export async function resolveOrgRef(value, { profile = 'default', authData = null, listOrgs, source = '--org', cachePath = defaultCachePath(), now = Date.now } = {}) {
  const ref = String(value ?? '').trim();
  if (!ref || isOrgId(ref)) return value;

  const low = ref.toLowerCase();
  if (authData?.org_id && (authData.org_slug === ref || String(authData.org_name || '').toLowerCase() === low)) return authData.org_id;

  const cache = readCache(cachePath);
  const hit = cache?.[profile]?.[low];
  if (hit?.id && now() - (hit.at || 0) < ORG_CACHE_TTL_MS) return hit.id;

  let list;
  try { list = await listOrgs(); } catch (e) {
    throw new QuoxValidationError(`Could not look up ${source} '${ref}' in your organisations (${e?.message || e}). Pass the org ID instead (\`quox org list\`).`);
  }
  const m = matchOrg(ref, list);
  if (m.ambiguous) {
    throw new QuoxValidationError(`${source} '${ref}' matches more than one of your organisations: ${m.ambiguous.map(label).join(', ')}. Use the full slug or the org ID.`);
  }
  if (!m.org) {
    const yours = (Array.isArray(list) ? list : []).map(label);
    throw new QuoxValidationError(`${source} '${ref}' is not one of your organisations. Yours: ${yours.length ? yours.join(', ') : 'none'}.`);
  }
  cache[profile] = { ...(cache[profile] || {}), [low]: { id: m.org.id, at: now() } };
  writeCache(cachePath, cache);
  return m.org.id;
}
