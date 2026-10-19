/**
 * Window-scoped org (#1034 root cause). `/org switch` in the TUI used to write the new org and token into the SHARED
 * profile (config.json) and move the shared server session's org, so every other window, script and proof run on the
 * same profile (`-p moo`) silently ran in the switched org. Now the org-scoped token lives in THIS window's memory only:
 *
 *   - the switch asks the server for a token without moving the session (`scope: 'window'`); an older server that
 *     moves it anyway gets the session put straight back on the profile's org;
 *   - the profile, the file and every other process keep the profile's org and token;
 *   - when the window token expires it is re-minted for the window's org, never the profile's.
 *
 * `quox org switch` from the shell is still the explicit way to change a profile's default org.
 */
import { resolveEndpoint } from '../api/endpoints.js';
import { RESTART_ORG_ENV } from './slash/restart.js';

export { RESTART_ORG_ENV };

const expiryOf = (token) => {
  try { const p = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')); return p?.exp ? p.exp * 1000 : null; }
  catch { return null; }
};

/**
 * @param {object} args
 * @param {object} args.auth        the profile auth (createAuth(config))
 * @param {object} args.baseClient  a client on the PROFILE identity (createClient(config, auth)), used only to mint
 * @returns {{ auth, switchTo(orgId), current(), _expireForTest() }}
 */
export function createWindowOrg({ auth, baseClient, now = () => Date.now() }) {
  let overlay = null; // { id, name, slug, role, access_token, expires_at } for this window only
  const ep = resolveEndpoint('auth.switch-org');
  const profileOrgId = () => { try { return auth.getOrgId(); } catch { return null; } };

  async function mint(orgId) {
    const data = await baseClient.post(ep.path, { service: ep.service, body: { org_id: orgId, scope: 'window' } });
    if (!data?.org?.id || !data?.access_token) { const e = new Error('The server did not return a token for that org.'); e.code = 'switch_failed'; throw e; }
    if (data.scope !== 'window') {
      // An older server moved the shared session's org (the #1034 leak). Put it back on the profile's org so the other
      // users of this profile do not refresh into the window's org. The token that call returns is discarded.
      const home = profileOrgId();
      if (home && home !== data.org.id) { try { await baseClient.post(ep.path, { service: ep.service, body: { org_id: home } }); } catch { /* best effort */ } }
    }
    return {
      id: data.org.id, name: data.org.name || data.org.slug || data.org.id, slug: data.org.slug || null, role: data.role || null,
      access_token: data.access_token, expires_at: expiryOf(data.access_token) ?? now() + 50 * 60 * 1000,
    };
  }

  const over = {
    getTokens() {
      const t = auth.getTokens();
      if (!overlay) return t;
      return { ...(t || {}), access_token: overlay.access_token, expires_at: overlay.expires_at, org_id: overlay.id, org_name: overlay.name, org_slug: overlay.slug, org_role: overlay.role };
    },
    isExpired() { return overlay ? now() > overlay.expires_at : auth.isExpired(); },
    getOrgId(o) { if (o) return o; return overlay ? overlay.id : auth.getOrgId(); },
    async refresh(baseUrl) {
      if (!overlay) return auth.refresh(baseUrl);
      if (auth.isExpired()) await auth.refresh(baseUrl); // the profile's own token, in the profile's org
      overlay = await mint(overlay.id);
      return { access_token: overlay.access_token };
    },
    // A new sign-in or sign-out in this window starts from the profile again.
    async login(...a) { overlay = null; return auth.login(...a); },
    async logout(...a) { overlay = null; return auth.logout(...a); },
  };
  const wrapped = new Proxy(auth, {
    get(t, k) {
      if (Object.prototype.hasOwnProperty.call(over, k)) return over[k];
      const v = t[k];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });

  return {
    auth: wrapped,
    /** Move THIS window to orgId. Back to the profile's own org just drops the window token. -> { id, name } */
    async switchTo(orgId) {
      if (orgId && orgId === profileOrgId()) {
        overlay = null;
        const a = auth.getTokens() || {};
        return { id: orgId, name: a.org_name || a.org_slug || orgId };
      }
      const m = await mint(orgId);
      overlay = m;
      return { id: m.id, name: m.name };
    },
    /** The window's own org when it differs from the profile's, else null. */
    current() { return overlay ? { id: overlay.id, name: overlay.name } : null; },
    _expireForTest() { if (overlay) overlay.expires_at = now() - 1; },
  };
}

/**
 * The client a TUI window should use: requests carry the window's org token when one is set.
 * -> { client, auth, windowOrg } ready for createApi({ ...this, config }).
 */
export function createWindowClient({ config, auth, createClient }) {
  const windowOrg = createWindowOrg({ auth, baseClient: createClient(config, auth) });
  return { client: createClient(config, windowOrg.auth), auth: windowOrg.auth, windowOrg };
}

/**
 * /restart hand-over: the predecessor's window org arrives in RESTART_ORG_ENV. Re-enter it in this window, once.
 * -> null (nothing carried) | { id, name } | { error, id }
 */
export async function carryOrg(api, env = process.env) {
  const id = env[RESTART_ORG_ENV] || null;
  delete env[RESTART_ORG_ENV];
  if (!id || !api?.switchOrg) return null;
  try { return await api.switchOrg(id); }
  catch (e) { return { error: e?.message || 'refused', id }; }
}
