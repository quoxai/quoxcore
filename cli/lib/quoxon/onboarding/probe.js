/**
 * #1101: is this URL a real QuoxCORE? One cheap unauthenticated GET of the edge's /health (nginx.conf answers
 * {"status":"ok","service":"dashboard"} on both the HTTP and HTTPS servers), run BEFORE /connect server asks for
 * an email and password. An error body is not data: only a 2xx JSON answer of that exact shape passes.
 *
 * -> { ok: true } | { ok: false, kind: 'url'|'unreachable'|'tls'|'not-quoxcore', code?, status?, detail? }
 */
const TLS_CODES = /^(SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT(_LOCALLY)?|CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|ERR_TLS_.*|ERR_SSL_.*|EPROTO)$/;
const PLAINTEXT_CODES = new Set(['ERR_SSL_WRONG_VERSION_NUMBER', 'EPROTO']);

export async function probeQuoxCore(url, { fetchImpl = globalThis.fetch, timeout = 5000 } = {}) {
  let base;
  try {
    base = new URL(String(url || ''));
    if (base.protocol !== 'http:' && base.protocol !== 'https:') return { ok: false, kind: 'url', detail: 'the address must start with https:// or http://' };
  } catch { return { ok: false, kind: 'url', detail: 'the address must start with https:// or http://' }; }
  const target = `${base.href.replace(/\/+$/, '')}/health`;
  let res;
  try {
    res = await fetchImpl(target, { signal: AbortSignal.timeout(timeout), headers: { accept: 'application/json' } });
  } catch (e) {
    const code = e?.cause?.code || e?.code || null;
    if (code && TLS_CODES.test(code)) return { ok: false, kind: 'tls', code };
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { ok: false, kind: 'unreachable', code: 'TIMEOUT', detail: `no answer within ${Math.round(timeout / 1000)} s` };
    return { ok: false, kind: 'unreachable', code, detail: e?.message || 'no answer' };
  }
  if (res?.status === 400 && base.protocol === 'http:') {
    let t = ''; try { t = await res.text(); } catch { /* no body */ }
    if (/plain HTTP request was sent to HTTPS port/i.test(t)) return { ok: false, kind: 'tls', code: 'HTTP_TO_HTTPS_PORT' };
  }
  if (!res || !(res.status >= 200 && res.status < 300)) return { ok: false, kind: 'not-quoxcore', status: res?.status, detail: `HTTP ${res?.status} from /health` };
  let body;
  try { body = JSON.parse(await res.text()); } catch { return { ok: false, kind: 'not-quoxcore', status: res.status, detail: '/health did not answer JSON' }; }
  if (!body || body.status !== 'ok' || body.service !== 'dashboard') return { ok: false, kind: 'not-quoxcore', status: res.status, detail: '/health answered, but not as QuoxCORE does' };
  return { ok: true };
}

// A new QuoxCORE serves its own self-signed certificate (setup.sh writes ssl/quox.crt, CA:TRUE, SAN = localhost +
// the LAN IP). Trusting exactly that file is the sanctioned fix; these are the codes it fixes. An expired or
// wrong-name certificate is a different problem: trusting a file would not cure it, so it is not suggested.
const SELF_SIGNED_CODES = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY']);
export const SERVER_CERT_DEFAULT = '~/quox-install/quox/ssl/quox.crt';

/**
 * One plain message per failure kind, naming the address and the next step.
 * opts.localCert: the absolute path of a QuoxCORE certificate on THIS machine (the server is here), if any.
 */
export function probeMessage(url, r, { localCert = null } = {}) {
  const again = 'Check the address, then try /connect server <url> again.';
  switch (r?.kind) {
    case 'url': return `"${url}" is not a server address (${r.detail}). Example: /connect server https://quox.example.com`;
    case 'unreachable': return `No answer from ${url}${r.code ? ` (${r.code})` : ''}. Nothing was saved and no password was asked for. ${again}`;
    case 'tls':
      if (r.code === 'HTTP_TO_HTTPS_PORT') return `${url} is an HTTPS port spoken to in plain HTTP. Did you mean ${String(url).replace(/^http:/i, 'https:')} ? Nothing was saved.`;
      if (PLAINTEXT_CODES.has(r.code)) return `${url} answered plain HTTP to an https:// request (${r.code}). Did you mean ${String(url).replace(/^https:/i, 'http:')} ? Nothing was saved.`;
      if (SELF_SIGNED_CODES.has(r.code)) {
        const lead = `${url} answered with its own self-signed certificate (${r.code}), which is normal for a new QuoxCORE. Trust that server's certificate, then start quox again.`;
        const tail = 'Never turn TLS checks off. Nothing was saved.';
        if (localCert) return `${lead} It is on this machine, so run: NODE_EXTRA_CA_CERTS=${localCert} quox   ${tail}`;
        return `${lead} Copy it from the server (by default ${SERVER_CERT_DEFAULT}) to this machine, then run: NODE_EXTRA_CA_CERTS=~/quox.crt quox   ${tail}`;
      }
      return `${url} answered, but its TLS certificate is not trusted (${r.code}). For a self-signed edge, trust its CA with NODE_EXTRA_CA_CERTS=<ca.pem> and try again; never turn TLS checks off. Nothing was saved.`;
    default: return `${url} answered, but it is not a QuoxCORE server (${r?.detail || 'unexpected answer'}). Nothing was saved and no password was asked for. ${again}`;
  }
}
