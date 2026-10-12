import { assertSafeEgressUrl } from './egressGuard.js';

let _idCounter = 1;
function nextId() { return _idCounter++; }

function buildAuthHeaders(authKind, authValue) {
  if (!authKind || authKind === 'none') return {};
  if (authKind === 'bearer') {
    return { Authorization: `Bearer ${authValue}` };
  }
  if (authKind === 'header') {
    const colonIdx = (authValue || '').indexOf(':');
    if (colonIdx < 0) throw new Error('authKind=header requires authValue in "HeaderName: value" form');
    const name = authValue.slice(0, colonIdx).trim();
    const value = authValue.slice(colonIdx + 1).trim();
    return { [name]: value };
  }
  return {};
}

async function rpcCall(url, method, params, { authKind, authValue, timeoutMs }) {
  const id = nextId();
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params: params || {},
  });

  let extraHeaders;
  try {
    extraHeaders = buildAuthHeaders(authKind, authValue);
  } catch (e) {
    return { ok: false, error: `transport: ${e.message}` };
  }

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body,
      redirect: 'manual', // #49 S1: don't follow redirects to internal targets
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, error: `transport: ${e.message}` };
  }

  // An MCP JSON-RPC endpoint responds directly; a 3xx is a misconfig or an SSRF
  // redirect-to-internal bypass — refuse rather than follow it.
  if (resp.status >= 300 && resp.status < 400) {
    return { ok: false, error: `blocked_redirect_${resp.status}` };
  }

  if (!resp.ok) {
    // #49 S1/S6: do NOT reflect the upstream response body to the caller.
    return { ok: false, error: `http_${resp.status}` };
  }

  let data;
  try {
    data = await resp.json();
  } catch (_) {
    return { ok: false, error: 'invalid_json' };
  }

  if (data.error) {
    return { ok: false, error: `rpc_${data.error.code}: ${data.error.message}` };
  }

  return { ok: true, result: data.result };
}

export async function probeMcpUrl(url, { authKind = 'none', authValue, timeoutMs = 5000 } = {}) {
  // #49 S1: defense-in-depth SSRF guard (route handlers guard first for a clean
  // 400; this protects any other caller of probeMcpUrl).
  try {
    await assertSafeEgressUrl(url);
  } catch (e) {
    return { ok: false, error: e.code || 'blocked_egress' };
  }

  const initRes = await rpcCall(url, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'quox-powers', version: '0.1.0' },
  }, { authKind, authValue, timeoutMs });

  if (!initRes.ok) return { ok: false, error: initRes.error };

  const serverInfo = initRes.result?.serverInfo;

  const listRes = await rpcCall(url, 'tools/list', {}, { authKind, authValue, timeoutMs });
  if (!listRes.ok) return { ok: false, error: listRes.error };

  return { ok: true, serverInfo, tools: listRes.result?.tools || [] };
}
