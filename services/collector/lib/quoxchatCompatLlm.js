/**
 * QuoxChat OpenAI-compatible provider (widget level).
 *
 * Config lives in the widget's embed_config (auth DB, server side):
 *   embed_config.llm_provider = 'openai_compatible'
 *   embed_config.llm = {
 *     provider: 'openai_compatible',
 *     base_url: 'https://llm.example.com/v1',   // chat/completions is appended
 *     model: 'llama3.1:8b',
 *     api_key_ref: { vault_id: '<credential id>' },   // optional; Ollama needs none
 *     allow_private_origin: 'http://10.0.0.5:11434'   // optional, see below
 *   }
 * The API key is NEVER stored in embed_config: only a vault reference, which
 * resolves through the same vault path as other per-org keys.
 *
 * EGRESS POLICY (the trade-off, read before changing):
 * Self-hosted Ollama/vLLM normally lives on a private or loopback address,
 * which the SSRF guard exists to block. We allow a private target ONLY when
 * the org admin has written that exact origin (scheme + host + port) into
 * llm.allow_private_origin AND it equals the origin of base_url. The value is
 * persisted server side in embed_config; the auth PATCH route requires the
 * admin role to change it, and nothing a visitor sends can reach it. Even
 * then, link-local (cloud metadata 169.254/16, fe80::), unspecified and
 * multicast/reserved ranges stay blocked. Public endpoints pass the normal
 * guard. Residual risk: DNS rebinding between resolve and connect is not
 * pinned (same documented residual as the other egress guards); an
 * allow-listed origin is a standing trust grant to that one host.
 */

const dnsPromises = require('node:dns/promises');
const net = require('node:net');

const PROVIDER_ID = 'openai_compatible';
const SELF_HOSTED_LABEL = 'self-hosted, OpenAI-compatible';

function blocked(message) {
  const err = new Error(message);
  err.code = 'blocked_egress';
  err.statusCode = 400;
  return err;
}

// Ranges that stay blocked even for an allow-listed private origin.
function ipv4Hard(p) {
  const [a, b] = p;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  // 100.100.100.0/24 inside CGNAT: Alibaba Cloud metadata (100.100.100.200)
  // and Tailscale service addresses (100.100.100.100). Never a model server,
  // so an allow-listed CGNAT/tailnet origin can never reach it (2026-10-12).
  if (a === 100 && b === 100 && p[2] === 100) return true;
  if (a >= 224) return true;
  return false;
}
function ipv4Private(p) {
  const [a, b] = p;
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0 && p[2] === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return false;
}
function mappedV4(lower) {
  if (lower.includes('.')) {
    const v4 = lower.slice(lower.lastIndexOf(':') + 1);
    return net.isIP(v4) === 4 ? v4 : null;
  }
  const m = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!m) return null;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}

/** @returns {'public'|'private'|'hard'} */
function classifyIp(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) {
    const p = ip.split('.').map(Number);
    if (ipv4Hard(p)) return 'hard';
    return ipv4Private(p) ? 'private' : 'public';
  }
  if (fam === 6) {
    const lower = ip.toLowerCase();
    const v4 = mappedV4(lower);
    if (v4) return classifyIp(v4);
    if (lower === '::') return 'hard';
    if (/^fe[89ab]/.test(lower) || lower.startsWith('ff')) return 'hard';
    if (lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd')) return 'private';
    return 'public';
  }
  return 'hard';
}

function normaliseOrigin(raw) {
  try {
    const u = new URL(String(raw));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch { return null; }
}

/**
 * Parse the widget's embed_config (object or JSON string). Returns null when
 * the widget did not choose this provider; otherwise
 * { ok, selected:true, error?, baseUrl, chatUrl, origin, model, apiKeyRef, allowPrivateOrigin }.
 */
function parseCompatConfig(rawConfig) {
  let cfg = rawConfig;
  if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch { return null; } }
  if (!cfg || typeof cfg !== 'object') return null;
  const llm = cfg.llm && typeof cfg.llm === 'object' ? cfg.llm : null;
  const selected = cfg.llm_provider === PROVIDER_ID || (llm && llm.provider === PROVIDER_ID);
  if (!selected) return null;
  if (!llm) return { ok: false, selected: true, error: 'missing_llm_block' };
  const baseOrigin = normaliseOrigin(llm.base_url);
  if (!baseOrigin) return { ok: false, selected: true, error: 'invalid_base_url' };
  const model = typeof llm.model === 'string' ? llm.model.trim().slice(0, 120) : '';
  if (!model) return { ok: false, selected: true, error: 'missing_model' };
  const u = new URL(llm.base_url);
  if (u.username || u.password) return { ok: false, selected: true, error: 'credentials_in_url' };
  const baseUrl = (u.origin + u.pathname).replace(/\/+$/, '');
  const ref = llm.api_key_ref && typeof llm.api_key_ref === 'object'
    && typeof llm.api_key_ref.vault_id === 'string' && llm.api_key_ref.vault_id
    ? { vault_id: llm.api_key_ref.vault_id }
    : null;
  return {
    ok: true,
    selected: true,
    baseUrl,
    chatUrl: `${baseUrl}/chat/completions`,
    origin: baseOrigin,
    model,
    apiKeyRef: ref,
    allowPrivateOrigin: llm.allow_private_origin ? normaliseOrigin(llm.allow_private_origin) : null,
  };
}

/**
 * Decide whether the configured endpoint may be called. Throws blocked_egress
 * unless the host is public, or private AND exactly allow-listed by the admin.
 * @returns {Promise<{allowedPrivate:boolean, ips:string[]}>}
 */
async function assertCompatEgress(parsed, { resolver = dnsPromises } = {}) {
  if (!parsed || !parsed.ok) throw blocked('invalid_compat_config');
  const u = new URL(parsed.baseUrl);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let ips;
  if (net.isIP(host)) ips = [host];
  else {
    try { ips = (await resolver.lookup(host, { all: true })).map((r) => r.address); }
    catch { throw blocked(`dns_resolution_failed: ${host}`); }
  }
  if (!ips.length) throw blocked(`no_dns_records: ${host}`);
  const classes = ips.map(classifyIp);
  if (classes.includes('hard')) throw blocked(`blocked_host: ${host} resolves to a link-local/reserved address`);
  if (classes.includes('private')) {
    if (parsed.allowPrivateOrigin && parsed.allowPrivateOrigin === parsed.origin) {
      return { allowedPrivate: true, ips };
    }
    throw blocked(`blocked_host: ${host} is a private address and its origin is not allow-listed for this widget`);
  }
  return { allowedPrivate: false, ips };
}

/** Does an error response look like "this endpoint does not accept tools"? */
function looksLikeToolsRejection(status, bodyText) {
  if (status !== 400 && status !== 422 && status !== 501) return false;
  return /tool|function.?call/i.test(String(bodyText || ''));
}

module.exports = {
  PROVIDER_ID,
  SELF_HOSTED_LABEL,
  parseCompatConfig,
  assertCompatEgress,
  classifyIp,
  looksLikeToolsRejection,
  normaliseOrigin,
};
