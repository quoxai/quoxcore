/**
 * Consent helpers. Consent rows are append-only on the server; the current
 * state of a (purpose, channel) cell is the latest row. The server may send a
 * ready-made current set; otherwise it is derived here from the history.
 */

const ts = (r) => Date.parse(r?.captured_at || '') || 0;

/** -> { history: rows newest first, current: Map key `${purpose}:${channel}` -> row } */
export function normaliseConsents(data) {
  const rows = [
    ...(Array.isArray(data) ? data : []),
    ...(Array.isArray(data?.history) ? data.history : []),
    ...(!Array.isArray(data?.history) && Array.isArray(data?.consents) ? data.consents : []),
  ];
  const history = [...rows].sort((a, b) => ts(b) - ts(a));
  const current = new Map();
  const explicit = Array.isArray(data?.current) ? data.current : Array.isArray(data?.matrix) ? data.matrix : null;
  for (const r of (explicit || history)) {
    const key = `${r.purpose}:${r.channel}`;
    const prev = current.get(key);
    if (!prev || ts(r) >= ts(prev)) current.set(key, r);
  }
  if (!rows.length && explicit) explicit.forEach((r) => current.set(`${r.purpose}:${r.channel}`, r));
  return { history: history.length ? history : [...(explicit || [])], current };
}

/** Status -> .qx-dot variant for the compact consent grid. */
export const CONSENT_DOTS = { granted: 'online', soft_opt_in: 'info', withdrawn: 'offline', objected: 'degraded', unknown: 'idle' };
export const consentDotClass = (status) => `qx-dot qx-dot--sm qx-dot--static qx-dot--${CONSENT_DOTS[status] || 'idle'}`;

/**
 * Purpose x channel grid for the matrix. Columns are the everyday channels (voice, SMS, email)
 * plus any other channel that actually has a record, so the grid stays narrow.
 * -> { channels: [...], rows: [{ purpose, cells: [{ channel, row: record|null }] }] }
 */
export function buildConsentGrid(current, purposes, channels, always = ['voice', 'sms', 'email']) {
  const cols = channels.filter((c) => always.includes(c.key) || [...current.keys()].some((k) => k.endsWith(`:${c.key}`)));
  return {
    channels: cols,
    rows: purposes.map((p) => ({ purpose: p, cells: cols.map((c) => ({ channel: c, row: current.get(`${p.key}:${c.key}`) || null })) })),
  };
}
