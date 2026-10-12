/**
 * Qlarity API client.
 *
 * Every call goes through the collector proxy, never to the service port.
 * That proxy is the governed boundary: it resolves the org, enforces the
 * licence gate and emits the AEE envelope. A client that talked to :3109
 * directly would be both ungoverned and unreachable from a browser.
 *
 * DEVBUNDLE_DOD.md chain point 6. There is deliberately no localStorage here:
 * session ids are server state with a short TTL, and caching them across a
 * reload would hand the user a session the reaper has already closed.
 */

const API_BASE = '/collector/api/v1/qlarity';

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    // Session cookie authenticates through the proxy, mirroring the QuoxPlan
    // and RepoBrain clients.
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!res.ok) {
    // Surface the server's reason verbatim. The two that matter most are the
    // 403 licence refusal and the 403 egress denial, and paraphrasing either
    // into "something went wrong" is how a user ends up widening an allowlist
    // they did not need to touch.
    const err = new Error(payload?.error || `qlarity_${res.status}`);
    err.status = res.status;
    throw err;
  }
  return payload;
}

const ORG_ALLOWLIST_BASE = '/collector/api/v1/qlarity-allowlist';

/**
 * Same contract as request(), against the collector's own allowlist routes.
 * Kept separate rather than parameterising request() because the two have
 * different bases and conflating them is how a call ends up proxied to a
 * service that has never heard of the path.
 */
async function orgRequest(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${ORG_ALLOWLIST_BASE}${path}`, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  try { payload = await res.json(); } catch { payload = null; }
  if (!res.ok) {
    // The server explains WHY an origin was refused (a wildcard, credentials,
    // a bad hostname). Losing that reason is how a customer concludes the
    // product is broken rather than that they typed the wrong thing.
    const err = new Error(payload?.message || payload?.error || `qlarity_allowlist_${res.status}`);
    err.status = res.status;
    throw err;
  }
  return payload;
}

export const api = {
  health: () => request('/health'),
  inspectors: () => request('/inspectors'),
  allowlist: () => request('/allowlist'),

  // NO-ENV-ONLY-CONFIG: the per-ORG origins a customer can manage themselves.
  // These are collector-owned routes, not proxied to the QLarity service, so
  // they sit outside API_BASE deliberately.
  orgOrigins: () => orgRequest(''),
  addOrgOrigin: (origin, note) => orgRequest('', { method: 'POST', body: { origin, note } }),
  removeOrgOrigin: (origin) => orgRequest(`?origin=${encodeURIComponent(origin)}`, { method: 'DELETE' }),

  listSessions: () => request('/sessions'),
  createSession: () => request('/sessions', { method: 'POST' }),
  closeSession: (id) => request(`/sessions/${id}`, { method: 'DELETE' }),

  open: (id, url, opts = {}) => request(`/sessions/${id}/open`, {
    method: 'POST',
    body: { url, ...opts },
  }),

  inspect: (id, inspector, args = {}) => request(`/sessions/${id}/inspect`, {
    method: 'POST',
    body: { inspector, ...args },
  }),

  blocked: (id) => request(`/sessions/${id}/blocked`),

  // BUNDLE POLISH B: the service has recorded console, network and screenshots
  // since it shipped, and the dashboard exposed none of them, so the only way
  // to see what QLarity actually saw was an agent tool call or curl. A governed
  // browser whose findings a human cannot read is half a product.
  //
  // All three report `dropped` / `bytes` honestly rather than silently
  // truncating: reading 500 messages from a page that emitted 12,000 and not
  // being told is how a user concludes a page is clean when it is not.
  consoleLog: (id, level) => request(`/sessions/${id}/console${level ? `?level=${encodeURIComponent(level)}` : ''}`),

  network: (id) => request(`/sessions/${id}/network`),

  /**
   * Returns { format, encoding, bytes, sha256, url, captured_at, data }.
   * The sha256 is the point: it is what makes the image witnessable evidence
   * of how a page looked at a moment, rather than just a loose PNG.
   * Viewport-sized by default — a full-page base64 body goes through the proxy
   * in memory.
   */
  screenshot: (id, opts = {}) => request(`/sessions/${id}/screenshot`, {
    method: 'POST',
    body: opts,
  }),

  /**
   * Always returns awaiting_approval with an inbox item id; it never runs the
   * script inline. The view must not present this as a result.
   */
  requestEval: (id, script) => request(`/sessions/${id}/eval`, {
    method: 'POST',
    body: { script },
  }),
};

export default api;
