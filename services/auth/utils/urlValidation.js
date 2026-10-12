/**
 * URL Validation and SSRF Protection Utilities
 *
 * Provides secure URL validation to prevent Server-Side Request Forgery (SSRF) attacks.
 *
 * Security measures:
 * - Only allows http/https schemes
 * - Blocks private IP ranges (RFC 1918, loopback, link-local, etc.)
 * - Blocks localhost and local hostnames
 * - DNS rebinding protection (resolve hostname, verify IP, then connect)
 * - Configurable timeouts
 */

import dns from 'dns';
import { promisify } from 'util';

const dnsResolve4 = promisify(dns.resolve4);
const dnsResolve6 = promisify(dns.resolve6);

/**
 * Private/reserved IPv4 ranges that should be blocked
 */
const PRIVATE_IPV4_RANGES = [
    // Loopback (127.0.0.0/8)
    { start: [127, 0, 0, 0], end: [127, 255, 255, 255] },
    // Private Class A (10.0.0.0/8)
    { start: [10, 0, 0, 0], end: [10, 255, 255, 255] },
    // Private Class B (172.16.0.0/12)
    { start: [172, 16, 0, 0], end: [172, 31, 255, 255] },
    // Private Class C (192.168.0.0/16)
    { start: [192, 168, 0, 0], end: [192, 168, 255, 255] },
    // Link-local (169.254.0.0/16)
    { start: [169, 254, 0, 0], end: [169, 254, 255, 255] },
    // Broadcast (255.255.255.255/32)
    { start: [255, 255, 255, 255], end: [255, 255, 255, 255] },
    // Current network (0.0.0.0/8)
    { start: [0, 0, 0, 0], end: [0, 255, 255, 255] },
    // Documentation/TEST-NET-1 (192.0.2.0/24)
    { start: [192, 0, 2, 0], end: [192, 0, 2, 255] },
    // Documentation/TEST-NET-2 (198.51.100.0/24)
    { start: [198, 51, 100, 0], end: [198, 51, 100, 255] },
    // Documentation/TEST-NET-3 (203.0.113.0/24)
    { start: [203, 0, 113, 0], end: [203, 0, 113, 255] },
    // Carrier-grade NAT (100.64.0.0/10)
    { start: [100, 64, 0, 0], end: [100, 127, 255, 255] },
    // Reserved for IETF Protocol Assignments (192.0.0.0/24)
    { start: [192, 0, 0, 0], end: [192, 0, 0, 255] },
    // Multicast (224.0.0.0/4)
    { start: [224, 0, 0, 0], end: [239, 255, 255, 255] },
    // Reserved for future use (240.0.0.0/4)
    { start: [240, 0, 0, 0], end: [255, 255, 255, 254] },
];

/**
 * Private/reserved IPv6 ranges that should be blocked
 */
const PRIVATE_IPV6_PREFIXES = [
    '::1',              // Loopback
    'fc',               // Unique local (fc00::/7)
    'fd',               // Unique local (fc00::/7)
    'fe80:',            // Link-local (fe80::/10)
    'ff',               // Multicast (ff00::/8)
    '::ffff:127.',      // IPv4-mapped loopback
    '::ffff:10.',       // IPv4-mapped private
    '::ffff:172.16.',   // IPv4-mapped private
    '::ffff:172.17.',
    '::ffff:172.18.',
    '::ffff:172.19.',
    '::ffff:172.20.',
    '::ffff:172.21.',
    '::ffff:172.22.',
    '::ffff:172.23.',
    '::ffff:172.24.',
    '::ffff:172.25.',
    '::ffff:172.26.',
    '::ffff:172.27.',
    '::ffff:172.28.',
    '::ffff:172.29.',
    '::ffff:172.30.',
    '::ffff:172.31.',
    '::ffff:192.168.', // IPv4-mapped private
    '::ffff:169.254.', // IPv4-mapped link-local
    '::ffff:0.',       // IPv4-mapped current network
];

/**
 * Blocked local hostnames
 */
const BLOCKED_HOSTNAMES = [
    'localhost',
    'localhost.localdomain',
    'ip6-localhost',
    'ip6-loopback',
    'broadcasthost',
    'local',
    'internal',
    'intranet',
    'kubernetes',
    'kubernetes.default',
    'kubernetes.default.svc',
    'kubernetes.default.svc.cluster',
    'kubernetes.default.svc.cluster.local',
    'metadata',
    'metadata.google.internal',     // GCP metadata
    'instance-data',                // AWS metadata hostname
];

/**
 * Blocked hostname patterns (regex)
 */
const BLOCKED_HOSTNAME_PATTERNS = [
    /^.*\.local$/i,
    /^.*\.localhost$/i,
    /^.*\.internal$/i,
    /^.*\.localdomain$/i,
    /^metadata\..*$/i,
    /^instance-data\..*$/i,
    /^.*\.svc\.cluster\.local$/i,   // Kubernetes services
];

/**
 * Parse an IPv4 address into octets
 * @param {string} ip - IPv4 address string
 * @returns {number[]|null} Array of 4 octets or null if invalid
 */
function parseIPv4(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;

    const octets = parts.map(p => {
        const num = parseInt(p, 10);
        if (isNaN(num) || num < 0 || num > 255 || p !== String(num)) {
            return -1;
        }
        return num;
    });

    if (octets.some(o => o === -1)) return null;
    return octets;
}

/**
 * Check if an IPv4 address is within a range
 * @param {number[]} ip - IP as array of octets
 * @param {{ start: number[], end: number[] }} range - IP range
 * @returns {boolean}
 */
function ipv4InRange(ip, range) {
    for (let i = 0; i < 4; i++) {
        if (ip[i] < range.start[i]) return false;
        if (ip[i] > range.end[i]) return false;
        if (ip[i] > range.start[i] && ip[i] < range.end[i]) return true;
    }
    return true;
}

/**
 * Check if an IPv4 address is private/reserved
 * @param {string} ip - IPv4 address string
 * @returns {boolean}
 */
export function isPrivateIPv4(ip) {
    const octets = parseIPv4(ip);
    if (!octets) return true; // Invalid IPs are treated as private for safety

    for (const range of PRIVATE_IPV4_RANGES) {
        if (ipv4InRange(octets, range)) {
            return true;
        }
    }
    return false;
}

/**
 * Check if an IPv6 address is private/reserved
 * @param {string} ip - IPv6 address string
 * @returns {boolean}
 */
export function isPrivateIPv6(ip) {
    const normalizedIp = ip.toLowerCase();

    for (const prefix of PRIVATE_IPV6_PREFIXES) {
        if (normalizedIp.startsWith(prefix.toLowerCase())) {
            return true;
        }
    }
    return false;
}

/**
 * Check if an IP address (v4 or v6) is private/reserved
 * @param {string} ip - IP address string
 * @returns {boolean}
 */
export function isPrivateIP(ip) {
    // Check if it's IPv4
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
        return isPrivateIPv4(ip);
    }
    // Assume IPv6
    return isPrivateIPv6(ip);
}

/**
 * RFC1918 private-use ranges ONLY (10/8, 172.16/12, 192.168/16).
 * Deliberately narrower than isPrivateIPv4: loopback, link-local, 0.0.0.0/8,
 * CGNAT, multicast and every other reserved range stay OUTSIDE this set, so
 * an allowPrivate caller can reach a LAN device without ever being able to
 * reach 127.0.0.1 or the 169.254 metadata space.
 * @param {string} ip - IPv4 address string
 * @returns {boolean}
 */
export function isRfc1918Ipv4(ip) {
    const octets = parseIPv4(ip);
    if (!octets) return false;
    if (octets[0] === 10) return true;
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
    if (octets[0] === 192 && octets[1] === 168) return true;
    return false;
}

/**
 * Check if a hostname is blocked (localhost, local, etc.)
 *
 * SECURITY NOTE (VAULT-INTEG, owner-approved 2026-09-06): opts.allowPrivate
 * is a SCOPED SSRF relaxation for self-hosted integration types (uptime_kuma,
 * mikrotik_routeros and friends, registry entries with lanAllowed: true) and
 * is only ever passed when the instance gate `allow_lan_integration_targets`
 * is enabled by an operator (default OFF). Even then, ONLY literal RFC1918
 * addresses pass: loopback, link-local, 0.0.0.0/8 and blocked hostname
 * patterns remain rejected unconditionally. Residual risk, stated honestly:
 * on an enabled instance, an org admin with SECRETS_WRITE can probe RFC1918
 * hosts via the declared types' credential test endpoints.
 * @param {string} hostname - Hostname to check
 * @param {{allowPrivate?: boolean}} [opts]
 * @returns {boolean}
 */
export function isBlockedHostname(hostname, opts = {}) {
    const normalizedHostname = hostname.toLowerCase().trim();

    // Check exact matches
    if (BLOCKED_HOSTNAMES.includes(normalizedHostname)) {
        return true;
    }

    // Check patterns
    for (const pattern of BLOCKED_HOSTNAME_PATTERNS) {
        if (pattern.test(normalizedHostname)) {
            return true;
        }
    }

    // Check if it's an IP address and if it's private
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalizedHostname)) {
        if (opts.allowPrivate && isRfc1918Ipv4(normalizedHostname)) {
            return false;
        }
        return isPrivateIPv4(normalizedHostname);
    }

    // Check for IPv6 addresses (including bracketed form)
    const ipv6Match = normalizedHostname.match(/^\[?([0-9a-f:]+)\]?$/i);
    if (ipv6Match) {
        return isPrivateIPv6(ipv6Match[1]);
    }

    return false;
}

/**
 * Validate URL scheme (only http/https allowed)
 * @param {string} url - URL string
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateUrlScheme(url) {
    try {
        const parsed = new URL(url);
        const scheme = parsed.protocol.toLowerCase();

        if (scheme !== 'http:' && scheme !== 'https:') {
            return {
                valid: false,
                error: `URL scheme '${parsed.protocol.slice(0, -1)}' is not allowed. Only http and https are permitted.`
            };
        }

        return { valid: true };
    } catch (err) {
        return {
            valid: false,
            error: 'Invalid URL format'
        };
    }
}

/**
 * Validate URL for SSRF protection (synchronous basic checks)
 * @param {string} url - URL string to validate
 * @returns {{ valid: boolean, error?: string, parsedUrl?: URL }}
 */
export function validateUrlBasic(url, opts = {}) {
    // Check URL format and scheme
    const schemeCheck = validateUrlScheme(url);
    if (!schemeCheck.valid) {
        return schemeCheck;
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(url);
    } catch (err) {
        return { valid: false, error: 'Invalid URL format' };
    }

    // Check hostname
    const hostname = parsedUrl.hostname;

    if (!hostname) {
        return { valid: false, error: 'URL must have a hostname' };
    }

    // Check for blocked hostnames (opts.allowPrivate: see isBlockedHostname security note)
    if (isBlockedHostname(hostname, opts)) {
        return {
            valid: false,
            error: 'Access to internal/private networks is not allowed'
        };
    }

    // Check port - block common internal service ports when targeting suspicious hosts
    const port = parsedUrl.port ? parseInt(parsedUrl.port, 10) : (parsedUrl.protocol === 'https:' ? 443 : 80);

    // Disallow metadata service ports on suspicious hosts
    if (port === 80 || port === 8080) {
        // These are fine for normal hosts, but we already blocked metadata hostnames
    }

    return { valid: true, parsedUrl };
}

/**
 * Resolve hostname and validate all resolved IPs
 * Provides DNS rebinding protection by checking resolved IPs before connection
 * @param {string} hostname - Hostname to resolve
 * @returns {Promise<{ valid: boolean, error?: string, ips?: string[] }>}
 */
export async function resolveAndValidateHostname(hostname, opts = {}) {
    // If hostname is already an IP, validate it directly
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
        if (opts.allowPrivate && isRfc1918Ipv4(hostname)) {
            return { valid: true, ips: [hostname] };
        }
        if (isPrivateIPv4(hostname)) {
            return {
                valid: false,
                error: 'Access to internal/private networks is not allowed'
            };
        }
        return { valid: true, ips: [hostname] };
    }

    // Check for IPv6 address
    if (hostname.includes(':') || hostname.match(/^\[.*\]$/)) {
        const cleanIp = hostname.replace(/^\[|\]$/g, '');
        if (isPrivateIPv6(cleanIp)) {
            return {
                valid: false,
                error: 'Access to internal/private networks is not allowed'
            };
        }
        return { valid: true, ips: [cleanIp] };
    }

    // Resolve DNS
    const resolvedIps = [];

    try {
        const ipv4Addresses = await dnsResolve4(hostname);
        resolvedIps.push(...ipv4Addresses);
    } catch (err) {
        // No IPv4 addresses is not necessarily an error
        if (err.code !== 'ENODATA' && err.code !== 'ENOTFOUND') {
            // Log but continue - might have IPv6
        }
    }

    try {
        const ipv6Addresses = await dnsResolve6(hostname);
        resolvedIps.push(...ipv6Addresses);
    } catch (err) {
        // No IPv6 addresses is not necessarily an error
    }

    if (resolvedIps.length === 0) {
        return {
            valid: false,
            error: 'Unable to resolve hostname'
        };
    }

    // Check ALL resolved IPs - if any are private, reject.
    // allowPrivate permits RFC1918 IPv4 resolutions only (a LAN DNS name for a
    // lanAllowed device); private IPv6 and every other reserved range still reject.
    for (const ip of resolvedIps) {
        if (opts.allowPrivate && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip) && isRfc1918Ipv4(ip)) {
            continue;
        }
        if (isPrivateIP(ip)) {
            return {
                valid: false,
                error: 'Access to internal/private networks is not allowed'
            };
        }
    }

    return { valid: true, ips: resolvedIps };
}

/**
 * Full URL validation with DNS resolution (async)
 * This should be called before making any HTTP request to a user-provided URL
 * @param {string} url - URL string to validate
 * @returns {Promise<{ valid: boolean, error?: string, parsedUrl?: URL, resolvedIps?: string[] }>}
 */
export async function validateUrlForSSRF(url, opts = {}) {
    // Basic validation first
    const basicCheck = validateUrlBasic(url, opts);
    if (!basicCheck.valid) {
        return basicCheck;
    }

    // Resolve and validate hostname
    const dnsCheck = await resolveAndValidateHostname(basicCheck.parsedUrl.hostname, opts);
    if (!dnsCheck.valid) {
        return dnsCheck;
    }

    return {
        valid: true,
        parsedUrl: basicCheck.parsedUrl,
        resolvedIps: dnsCheck.ips
    };
}

/**
 * Create a fetch wrapper with SSRF protection
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options
 * @param {number} [timeout=30000] - Request timeout in ms
 * @param {number} [redirectDepth=0] - Current redirect depth (internal tracking)
 * @returns {Promise<Response>}
 */
export async function safeFetch(url, options = {}, timeout = 30000, redirectDepth = 0, ssrfOpts = {}) {
    // Issue #167 fix: Enforce MAX_REDIRECTS to prevent infinite loops
    if (redirectDepth >= MAX_REDIRECTS) {
        throw new Error(`Maximum redirect depth (${MAX_REDIRECTS}) exceeded`);
    }

    // Validate URL for SSRF (ssrfOpts threads allowPrivate through every
    // redirect hop so a hop can neither escape TO a blocked range nor lose
    // an intentionally granted LAN allowance mid-chain)
    const validation = await validateUrlForSSRF(url, ssrfOpts);
    if (!validation.valid) {
        throw new Error(validation.error);
    }

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal,
            // Prevent automatic redirects to check redirect targets
            redirect: 'manual'
        });

        // If redirect, validate the redirect target
        if (response.status >= 300 && response.status < 400) {
            const redirectUrl = response.headers.get('location');
            if (redirectUrl) {
                // Resolve relative URLs
                const absoluteRedirectUrl = new URL(redirectUrl, url).toString();

                // Validate redirect target (same ssrfOpts as the original request)
                const redirectValidation = await validateUrlForSSRF(absoluteRedirectUrl, ssrfOpts);
                if (!redirectValidation.valid) {
                    throw new Error(`Redirect blocked: ${redirectValidation.error}`);
                }

                // Follow the redirect with depth tracking
                clearTimeout(timeoutId);
                return safeFetch(absoluteRedirectUrl, options, timeout, redirectDepth + 1, ssrfOpts);
            }
        }

        return response;
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Default timeout for external API requests in milliseconds
 */
export const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Maximum number of redirects to follow
 */
export const MAX_REDIRECTS = 5;

export default {
    isPrivateIP,
    isPrivateIPv4,
    isPrivateIPv6,
    isRfc1918Ipv4,
    isBlockedHostname,
    validateUrlScheme,
    validateUrlBasic,
    validateUrlForSSRF,
    resolveAndValidateHostname,
    safeFetch,
    DEFAULT_TIMEOUT_MS,
    MAX_REDIRECTS
};
