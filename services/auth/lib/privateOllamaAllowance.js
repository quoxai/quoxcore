/**
 * #1288: a per-connection allowance for an org admin's OWN Ollama on a private address.
 *
 * The vault's SSRF guard refuses private base URLs unless the instance-wide gate
 * `allow_lan_integration_targets` is on (services/integrationHealthService.js). That gate is
 * server-wide and instance-admin only, so a self-hoster connecting the GPU box on their LAN hit a
 * dead end. This narrower path admits ONE origin, for ONE type, with every one of these holding:
 *
 *   - integration_type is exactly `ollama`;
 *   - base_url is a literal RFC1918 or CGNAT IPv4 address (validateUrlBasic with allowPrivate).
 *     Loopback, link-local (169.254.169.254 cloud metadata), 0.0.0.0/8, 100.100.100.0/24, private
 *     IPv6 (fd00:ec2::254), and blocked hostnames never qualify: they keep the normal 400;
 *   - the caller is a HUMAN (an agent principal is refused even with the admin role);
 *   - the caller holds the org admin role (or owner);
 *   - the request carries confirm_private_origin equal to that exact origin (the human said yes to
 *     "Connect to <host>? It's on your private network." in the TUI);
 *   - the credential's allow_private_origin names that same origin (the collector's runtime egress
 *     admits only that origin, lib/ollamaProvider.js);
 *   - the target answers GET <origin>/api/tags with 200 and { models: [...] } (no redirects).
 *
 * The route writes an audit entry for every decision this makes (allowed or refused).
 */
import { validateUrlBasic } from '../utils/urlValidation.js';
import { hasRoleLevel } from '../utils/policy.js';

export const PRIVATE_OLLAMA_TYPE = 'ollama';
const PROBE_TIMEOUT_MS = 5000;
const MAX_BODY = 1024 * 1024;

function originOf(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
        const u = new URL(value.trim());
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        return u.origin;
    } catch { return null; }
}

const PRIVATE_MSG = 'Invalid base URL: Access to internal/private networks is not allowed';

/**
 * GET <origin>/api/tags. -> { ok: true, models } | { ok: false, reason }. Never follows redirects.
 * The caller has already validated the address; this only asks "is it Ollama?".
 */
export async function probeOllamaTags(origin, { fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
    let res;
    try {
        res = await fetchImpl(`${origin}/api/tags`, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    } catch (e) {
        return { ok: false, reason: 'unreachable', detail: e?.message || String(e) };
    }
    if (res.status !== 200) return { ok: false, reason: `http_${res.status}` };
    let text;
    try { text = await res.text(); } catch { return { ok: false, reason: 'unreadable' }; }
    if (text.length > MAX_BODY) return { ok: false, reason: 'too_large' };
    let body;
    try { body = JSON.parse(text); } catch { return { ok: false, reason: 'not_ollama' }; }
    if (!body || !Array.isArray(body.models)) return { ok: false, reason: 'not_ollama' };
    return { ok: true, models: body.models.length };
}

/**
 * -> { applies: false, allow: false }                       not this path's business; the normal 400 stands
 *  | { applies: true, allow: false, status, error, message, origin, confirmable? }
 *  | { applies: true, allow: true, origin, models }
 */
export async function evaluatePrivateOllamaAllowance({ integrationType, credentials, confirmOrigin, role, nonHuman, probe = probeOllamaTags } = {}) {
    const no = { applies: false, allow: false };
    if (integrationType !== PRIVATE_OLLAMA_TYPE) return no;
    const baseUrl = credentials && typeof credentials.base_url === 'string' ? credentials.base_url : '';
    if (!baseUrl) return no;
    if (validateUrlBasic(baseUrl).valid) return no; // public: nothing to allow
    if (!validateUrlBasic(baseUrl, { allowPrivate: true }).valid) return no; // metadata, loopback, link-local, IPv6 ULA ...
    const origin = originOf(baseUrl);
    if (!origin) return no;

    const refuse = (status, error, message, extra = {}) => ({ applies: true, allow: false, status, error, message, origin, ...extra });
    if (nonHuman) return refuse(403, 'human_admin_required', 'Connecting an AI on a private address needs a human org admin. An agent cannot allow it.');
    if (!hasRoleLevel(role, 'admin')) return refuse(403, 'org_admin_required', 'Connecting an AI on a private address needs the org admin role.');
    if (typeof confirmOrigin !== 'string' || originOf(confirmOrigin) !== origin) {
        return refuse(400, 'validation_error', `${PRIVATE_MSG}. ${origin} is on a private network: confirm it to connect your own Ollama there.`, { confirmable: true });
    }
    if (originOf(credentials.allow_private_origin) !== origin) {
        return refuse(400, 'validation_error', `allow_private_origin must be ${origin} to connect Ollama on a private address.`);
    }
    let p;
    try { p = await probe(origin); } catch (e) { p = { ok: false, reason: 'unreachable', detail: e?.message }; }
    if (!p || !p.ok) return refuse(400, 'not_ollama', `${origin} did not answer as Ollama (GET /api/tags: ${p?.reason || 'failed'}). Nothing was saved.`);
    return { applies: true, allow: true, origin, models: p.models };
}
