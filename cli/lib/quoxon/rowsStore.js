/**
 * QUOXON-FW17 / ROWS: where custom rows live and how they are read. Shared by the quox window (api.js spreads this
 * in) and `quox rows` (commands/rows.js), so the two can never disagree about storage or the sync rule.
 *
 *   url, quox, plugin rows -> the user's server-side preferences (namespace `quoxonRows`, PATCH auth/me), with a
 *                             copy on the CLI profile (row_prefs) for offline starts. Read back through normRows
 *                             WITHOUT cmd: a synced row can never carry a shell command.
 *   cmd rows               -> ~/.config/quox/quoxon-rows.local.json (0600), never sent anywhere.
 *
 * Small on purpose (no React, no chat): `quox rows` loads only this and rows.js.
 */
import { resolveEndpoint } from '../api/endpoints.js';
import { normRows, plainFetch, loadLocalCmdRows, saveLocalCmdRows, URL_TIMEOUT_MS } from './rows.js';

const withTimeout = (p) => Promise.race([
  p,
  new Promise((_, rej) => { const t = setTimeout(() => rej(new Error(`timed out after ${URL_TIMEOUT_MS / 1000}s`)), URL_TIMEOUT_MS); t.unref?.(); })
]);

export function createRowsStore({ client, config, orgId = () => null }) {
  return {
    /** -> { rows, source: 'server' | 'local', error? }. Never includes a cmd row. */
    async rowPrefs() {
      const local = () => normRows(config.getActiveProfile?.()?.row_prefs);
      try {
        const ep = resolveEndpoint('auth.me.list');
        const d = await client.get(ep.path, { service: ep.service, retries: 0 });
        const raw = (d?.user?.preferences ?? d?.preferences)?.quoxonRows;
        const rows = normRows(raw);
        const prof = config.getActiveProfile?.();
        if (prof && raw !== undefined) { prof.row_prefs = rows; config.save?.(); }
        return { rows: raw === undefined && local().length ? local() : rows, source: 'server' };
      } catch (e) { return { rows: local(), source: 'local', error: e?.message || 'failed' }; }
    },
    /** Synced rows only (cmd rows are dropped). -> { ok, synced, error? }. */
    async setRowPrefs(value) {
      const rows = normRows(value);
      const prof = config.getActiveProfile?.();
      if (prof) { prof.row_prefs = rows; config.save?.(); }
      try {
        const ep = resolveEndpoint('auth.me.update');
        await client.patch(ep.path, { service: ep.service, body: { preferences: { quoxonRows: rows } }, retries: 0 });
        return { ok: true, synced: true };
      } catch (e) { return { ok: Boolean(prof), synced: false, error: e?.message || 'failed' }; }
    },
    localRowPrefs() { try { return normRows(config.getActiveProfile?.()?.row_prefs); } catch { return []; } },
    /** cmd rows: a local file under the CLI config dir, never synced. */
    localCmdRows() { return loadLocalCmdRows(); },
    setLocalCmdRows(rows) { return saveLocalCmdRows(rows); },
    /**
     * A row's URL -> text. This profile's own Quox base uses the normal authed client; any other origin gets a
     * plain request with NO credentials. 15 s timeout either way.
     */
    async rowFetch(url) {
      let u; try { u = new URL(url); } catch { throw new Error('bad URL'); }
      let own = null; try { own = new URL(config.getServiceUrl('auth')).origin; } catch { /* no profile */ }
      if (!own || u.origin !== own) return plainFetch(url);
      const d = await withTimeout(client.get(u.pathname + u.search, { service: 'auth', retries: 0 }));
      return typeof d === 'string' ? d : JSON.stringify(d);
    },
    /**
     * ROWS: a quox or plugin row -> text, read from THIS profile's Quox with the user's own session (GET only).
     * quox: { service, path } with {org} filled from the active org. plugin: GET /api/v1/plugins/<id>/<path> on the
     * collector (the same governed proxy the plugin's own UI uses; 402 when the org has no licence for it).
     */
    async rowFetchQuox(source) {
      const src = source || {};
      let service, path;
      if (src.type === 'plugin') { service = 'collector'; path = `/api/v1/plugins/${encodeURIComponent(src.plugin)}/${String(src.path || '').replace(/^\/+/, '')}`; }
      else if (src.type === 'quox') {
        service = src.service === 'collector' ? 'collector' : 'auth';
        const org = orgId() || '';
        if (String(src.path).includes('{org}') && !org) throw new Error('no org on this profile');
        path = String(src.path || '').replaceAll('{org}', encodeURIComponent(org));
      } else throw new Error('not a quox or plugin row');
      const d = await withTimeout(client.get(path, { service, retries: 0 }));
      return typeof d === 'string' ? d : JSON.stringify(d);
    }
  };
}
