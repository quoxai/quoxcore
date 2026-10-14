/**
 * QuoxChat Domain Guard — CW-13.3
 *
 * Enforces each widget's allowed_domains_json at request time on
 * /quoxchat/message. Missing Origin is treated as first-party / curl
 * (allowed). Dev origins (localhost, 127.0.0.1, *.localhost, LAN)
 * bypass the check entirely so embedding in local dev works.
 *
 * The allow list is fetched once from auth and cached for 60s per widget
 * so we don't round-trip for every message.
 */

const CACHE_TTL_MS = 60_000;
const cache = new Map(); // widgetId -> { domains, expiresAt }

function extractHost(urlOrHost) {
  if (!urlOrHost || typeof urlOrHost !== 'string') return null;
  try {
    if (/^https?:\/\//i.test(urlOrHost)) {
      const u = new URL(urlOrHost);
      return u.host.toLowerCase(); // includes port if non-default
    }
    // Already a bare host
    if (/[\s/]/.test(urlOrHost)) return null;
    return urlOrHost.toLowerCase();
  } catch {
    return null;
  }
}

function isDevOrigin(host) {
  if (!host) return false;
  const h = host.toLowerCase();
  if (h === 'localhost' || h.startsWith('localhost:')) return true;
  if (h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (/^127\.\d+\.\d+\.\d+(:\d+)?$/.test(h)) return true;
  if (/^10\.\d+\.\d+\.\d+(:\d+)?$/.test(h)) return true;
  if (/^192\.168\.\d+\.\d+(:\d+)?$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+(:\d+)?$/.test(h)) return true;
  if (/^\[::1\]/.test(h) || h === '::1') return true;
  return false;
}

/**
 * Match `host` against one allow-list entry. Bare domains in the list allow
 * subdomains; fqdns only match exactly; wildcards are supported.
 */
function matchesAllowEntry(host, entry) {
  if (!entry) return false;
  if (entry === '*') return true;
  const cleanEntry = String(entry).toLowerCase().trim();
  const cleanHost = host.toLowerCase();
  // Strip port for host comparison — allow list is about domains.
  const bareHost = cleanHost.split(':')[0];
  if (cleanEntry.startsWith('*.')) {
    const suffix = cleanEntry.slice(2);
    return bareHost.endsWith(`.${suffix}`) || bareHost === suffix ? bareHost !== suffix : false;
  }
  if (bareHost === cleanEntry) return true;
  // Bare domain matches any subdomain: example.com matches app.example.com.
  // We treat any entry without a leading '*.' and without >2 dots (heuristic)
  // as a "bare-or-subdomain" entry so customers don't need to list every
  // subdomain. FQDNs (3+ labels) must match exactly.
  const labels = cleanEntry.split('.');
  if (labels.length <= 2) {
    return bareHost.endsWith(`.${cleanEntry}`);
  }
  return false; // fqdn with 3+ labels — exact match only (handled above)
}

function isOriginAllowed(origin, allowedDomains) {
  // Missing origin → first-party or curl → allowed.
  if (!origin) return true;

  const host = extractHost(origin);
  if (!host) return true; // Parse failure — don't break on malformed headers.

  if (isDevOrigin(host)) return true;

  if (!Array.isArray(allowedDomains) || allowedDomains.length === 0) return false;

  for (const entry of allowedDomains) {
    if (matchesAllowEntry(host, entry)) return true;
  }
  return false;
}

// W7/W8: distinguish a definite answer from a transient auth failure. On a
// timeout or 5xx the last known list is served (stale), and with no cache the
// caller gets 'unavailable' so it can answer 503 "try again" instead of the
// permanent-sounding "not available on this website".
async function fetchAllowedDomainsDetailed(widgetId, { now = Date.now() } = {}) {
  if (!widgetId || widgetId === 'demo') return { domains: [], state: 'ok' };
  const cached = cache.get(widgetId);
  if (cached && cached.expiresAt > now) return { domains: cached.domains, state: 'ok' };
  const stale = () => (cached ? { domains: cached.domains, state: 'stale' } : { domains: null, state: 'unavailable' });

  const authUrl = process.env.AUTH_SERVICE_URL || 'http://auth:3101';
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (!serviceKey) return { domains: null, state: 'no_key' }; // fail-open path, unchanged

  try {
    const resp = await fetch(`${authUrl}/api/internal/widgets/${encodeURIComponent(widgetId)}/allowed-domains`, {
      headers: { 'x-service-key': serviceKey },
      signal: AbortSignal.timeout(2000),
    });
    if (resp.status === 404) return { domains: null, state: 'not_found' };
    if (!resp.ok) return stale();
    const data = await resp.json().catch(() => ({}));
    const domains = Array.isArray(data.allowed_domains) ? data.allowed_domains : [];
    cache.set(widgetId, { domains, expiresAt: now + CACHE_TTL_MS });
    return { domains, state: 'ok' };
  } catch {
    return stale();
  }
}

async function fetchAllowedDomains(widgetId) {
  const r = await fetchAllowedDomainsDetailed(widgetId);
  return r.domains;
}

function resetCache() { cache.clear(); }

// opts.requireOrigin (W5 defect 10): /message is public and spends LLM money, so
// a request with no Origin/Referer (curl, scripts) must not skip the allow list.
function enforceDomainGuard(widgetId, origin, allowedDomains, opts = {}) {
  if (isDevOrigin(extractHost(origin))) return { ok: true, reason: 'dev_origin' };
  if (!origin) return opts.requireOrigin ? { ok: false, reason: 'origin_required' } : { ok: true, reason: 'no_origin' };
  if (allowedDomains == null) return { ok: false, reason: 'widget_unknown' };
  if (isOriginAllowed(origin, allowedDomains)) return { ok: true, reason: 'allowed' };
  return { ok: false, reason: 'origin_not_allowed' };
}

module.exports = {
  fetchAllowedDomainsDetailed,
  isOriginAllowed,
  extractHost,
  isDevOrigin,
  matchesAllowEntry,
  fetchAllowedDomains,
  resetCache,
  enforceDomainGuard,
};
