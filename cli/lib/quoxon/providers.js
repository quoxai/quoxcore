/**
 * Provider availability, one source of truth for /model, /connect, /doctor and /capabilities (R3 audit D5:
 * the Claude subscription used to tell five different stories).
 *
 * The SERVER decides: GET /api/v1/capabilities reports `provider.<id>` from real signals (org vault keys,
 * instance keys, the server's Claude sign-in). The org vault list only adds detail (which credential, a
 * stored-but-not-default key). A provider the server does not report (Ollama) falls back to the vault; when
 * neither answers the state is unknown, never "not connected".
 *
 * Pure: `caps` is { ok, capabilities } from api.capabilities(), `vault` is { ok, rows } from api.connections().
 */

export const SUBSCRIPTION_NAME = 'Claude (subscription, dev only)';
const DISPLAY = { 'provider.claude_subscription': SUBSCRIPTION_NAME };

/** The name every surface shows for a capability (the server's own name, except where Quox has a fixed one). */
export const capabilityName = (c) => DISPLAY[c?.id] || c?.name || c?.id;

/** The server could not read this provider's status (not "not available"): shown as ? unknown on every surface. */
export const statusUnreadable = (c) => c?.availability === 'unavailable' && /^Could not read .* status/i.test(c.reason || '');

export const vaultPick = (rows, type) => {
  const of = rows.filter(r => r.integration_type === type);
  return { def: of.find(r => r.is_default === 1 || r.is_default === true) || null, any: of[0] || null };
};

/**
 * -> { state, row?, reason?, setup?, source } for one provider.
 * state: 'connected' (the server can use it) | 'stored' (a key exists but is not the org default) |
 *        'missing' (needs setup) | 'unavailable' (not on this server) | 'unknown' (nothing answered).
 * p: { cap: 'openai' | 'claude_subscription' | ..., vault?: integration type }
 */
export function providerState(p, caps, vault) {
  const rows = vault?.ok && Array.isArray(vault.rows) ? vault.rows : null;
  const v = rows && p.vault ? vaultPick(rows, p.vault) : { def: null, any: null };
  const c = caps?.ok && Array.isArray(caps.capabilities) ? caps.capabilities.find(x => x?.id === `provider.${p.cap}`) : null;
  if (c && statusUnreadable(c)) return { state: 'unknown', reason: c.reason, source: 'server' };
  if (c) {
    const base = { reason: c.reason || null, setup: c.setup || null, source: 'server' };
    if (c.availability === 'installed') return { ...base, state: 'connected', row: v.def || null };
    if (c.availability === 'requires_setup') return v.any && !v.def ? { ...base, state: 'stored', row: v.any } : { ...base, state: 'missing' };
    return { ...base, state: 'unavailable' };
  }
  if (!rows || !p.vault) return { state: 'unknown', source: 'none' };
  if (v.def) return { state: 'connected', row: v.def, source: 'vault' };
  if (v.any) return { state: 'stored', row: v.any, source: 'vault' };
  return { state: 'missing', source: 'vault' };
}
