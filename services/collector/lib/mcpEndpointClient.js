'use strict';

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
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, error: `transport: ${e.message}` };
  }

  if (!resp.ok) {
    let snippet = '';
    try { snippet = (await resp.text()).slice(0, 120); } catch (_) {}
    return { ok: false, error: `http_${resp.status}: ${snippet}` };
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

async function probeMcpEndpoint(url, { authKind, authValue, timeoutMs = 5000 } = {}) {
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

async function callMcpTool(url, toolName, args, { authKind, authValue, timeoutMs = 30000 } = {}) {
  const res = await rpcCall(url, 'tools/call', { name: toolName, arguments: args || {} }, { authKind, authValue, timeoutMs });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, result: res.result };
}

module.exports = { probeMcpEndpoint, callMcpTool };
