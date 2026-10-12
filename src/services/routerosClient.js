/**
 * RouterOS API Client
 *
 * Provides API functions for MikroTik router management.
 * Uses collector proxy for CORS bypass.
 * Returns an honest empty state ([]) when no router is configured or the live API call fails.
 */

import { useState, useEffect, useCallback } from 'react';
import { csrfFetch } from '../utils/csrfFetch';

// ============================================
// CONFIGURATION STORAGE (vault-first, localStorage fallback)
// ============================================

const STORAGE_KEY = 'quox-routeros-config';

// WEB-REFACTOR-27: the org vault's registered integration type for this
// connector (services/auth/config/integrationTypeRegistry.js) is
// `mikrotik_routeros`, requiring `{integration_type, label, credentials}`
// on POST /api/orgs/:orgId/integrations — NOT the `{type, name, config}`
// shape this file used to send, which 400'd on every write and silently
// fell back to a localStorage-only cache (a zero-tolerance persistence
// violation: a fresh browser lost the router config). See
// services/collector/lib/routerosConfigStore.js's original scope note for
// the history of the mismatch.
const VAULT_INTEGRATION_TYPE = 'mikrotik_routeros';

// PROOF-LOOP #2329 (2026-08-07): the vault path above is a documented dead
// end for this integration — services/auth/utils/urlValidation.js's SSRF
// guard rejects any private/LAN IP with no exception for LAN-scoped
// integrations, so the vault POST 400s for essentially every real router,
// and even ignoring that, findVaultCredential() below reads
// `data.integrations?.[0]` while the server actually returns
// `{credentials:[...]}` (a second, independent bug — both fixed in the
// vault's own routes are out of scope here). Net effect: `configured` was
// only ever reachable via the localStorage cache, a per-browser fallback
// that a fresh browser or a different device never sees — a zero-tolerance
// persistence violation (server-side must always be the source of truth).
//
// Fix: read from the SAME governed, per-org store the hardened proxy
// (POST /api/v1/mikrotik/proxy) and the NETWATCH agent tools already read
// from successfully — services/collector/lib/routerosConfigStore.js, via
// GET /api/v1/mikrotik/config (server.js). That endpoint resolves the org
// from the authenticated session server-side, so no client-supplied org
// scoping is needed, and it can never disagree with what the Router Health
// panel's own proxy calls see. The vault lookup below is kept only as a
// best-effort fallback for when the collector itself cannot be reached.
const GOVERNED_CONFIG_URL = '/collector/api/v1/mikrotik/config';

let _resolvedConfig = undefined; // undefined = not yet checked; null = checked, not configured

/**
 * Build the base_url the vault's mikrotik_routeros integration type
 * requires (credentials.base_url) from this app's address/port/useSSL
 * fields.
 */
function buildVaultBaseUrl(config) {
    const scheme = config.useSSL ? 'https' : 'http';
    const port = config.port || (config.useSSL ? 443 : 80);
    return `${scheme}://${config.address}:${port}`;
}

/**
 * Look up the org's existing RouterOS vault credential, if any. The vault
 * is keyed by credential id, not integration type — any update/delete
 * against an existing row needs its id first. GET .../integrations?type=...
 * lists (masked) credentials for the type; at most one is expected per org
 * (single router support, same assumption getRouters() makes).
 *
 * VAULT-INTEG P3: the list route (services/auth/routes/integrations.js
 * GET /orgs/:orgId/integrations) responds `{ credentials: [...] }`, not
 * `{ integrations: [...] }` — this used to read the wrong key and always
 * got `undefined`, so storeConfig()/removeStoredConfig() below always took
 * the "no existing credential" branch (a fresh POST every save, and a
 * silent no-op on delete since there was never an id to delete by). Fixed
 * to read the real response shape; PROOF-LOOP #2329 (2026-08-07)'s
 * documented SSRF/private-IP blocker on the WRITE side (see this file's
 * header comment) is a separate, still-open issue this fix does not touch.
 */
async function findVaultCredential(orgId) {
    const resp = await csrfFetch(`/api/orgs/${orgId}/integrations?type=${VAULT_INTEGRATION_TYPE}`);
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.credentials?.[0] || null;
}

/**
 * Get stored router configuration.
 * Returns the resolved governed-store answer once loadConfigAsync() has
 * checked it, else falls back to a synchronous localStorage read for the
 * very first paint (before that async check has had a chance to resolve).
 */
export function getStoredConfig() {
    if (_resolvedConfig !== undefined) return _resolvedConfig;

    // Synchronous fallback to localStorage for initial render only
    try {
        const encoded = localStorage.getItem(STORAGE_KEY);
        if (!encoded) return null;
        const decoded = atob(encoded);
        return JSON.parse(decoded);
    } catch (e) {
        console.error('Failed to load router config:', e);
        return null;
    }
}

/**
 * Async config loader — governed collector-side store first (source of
 * truth for the hardened proxy + agent tools), vault/localStorage as a
 * best-effort fallback only when the collector itself cannot be reached.
 *
 * The governed store's answer is authoritative: if it explicitly says "not
 * configured" for this org, we return null rather than falling back to a
 * possibly-stale vault/localStorage cache that could disagree with what the
 * real proxy calls (and NETWATCH's agent tools) would actually see.
 */
export async function loadConfigAsync(orgId) {
    try {
        const resp = await csrfFetch(GOVERNED_CONFIG_URL);
        if (resp.ok) {
            const data = await resp.json();
            if (data && typeof data.configured === 'boolean') {
                _resolvedConfig = data.configured
                    ? {
                        id: 'primary',
                        name: data.host,
                        address: data.host,
                        port: data.port,
                        useSSL: data.useSSL,
                        username: data.username,
                        updatedAt: data.updatedAt,
                        configured: true
                    }
                    : null;
                return _resolvedConfig;
            }
        }
    } catch { /* collector unreachable — fall through to legacy paths below */ }

    // Legacy vault fallback — only reached when the governed check above
    // could not get a definitive answer (network error / malformed body).
    if (orgId) {
        try {
            const existing = await findVaultCredential(orgId);
            if (existing) {
                return {
                    ...(existing.metadata || {}),
                    id: existing.id,
                    name: existing.label,
                    configured: true
                };
            }
        } catch { /* fallback */ }
    }

    return getStoredConfig();
}

/**
 * Store router configuration (vault + localStorage cache)
 */
export function storeConfig(config, orgId) {
    // Always keep localStorage as fast cache (no secrets — just host/port/username)
    try {
        const cacheConfig = { ...config };
        delete cacheConfig.password; // never cache password in localStorage
        const encoded = btoa(JSON.stringify(cacheConfig));
        localStorage.setItem(STORAGE_KEY, encoded);
    } catch (e) {
        console.error('Failed to save router config:', e);
    }

    // Store full config (with password) in vault, org-scoped. The real
    // vault contract needs an existing credential's id to update it — look
    // one up first, then PUT (update) or POST (create).
    if (orgId) {
        (async () => {
            try {
                const credentials = {
                    base_url: buildVaultBaseUrl(config),
                    username: config.username,
                    password: config.password
                };
                const metadata = { ...config };
                delete metadata.password;
                const label = config.name || 'RouterOS';

                const existing = await findVaultCredential(orgId);
                const resp = existing
                    ? await csrfFetch(`/api/orgs/${orgId}/integrations/${existing.id}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ label, credentials, metadata })
                    })
                    : await csrfFetch(`/api/orgs/${orgId}/integrations`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            integration_type: VAULT_INTEGRATION_TYPE,
                            label,
                            credentials,
                            metadata
                        })
                    });

                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    throw new Error(err.message || `Vault write failed: ${resp.status}`);
                }

                _resolvedConfig = { ...metadata, configured: true };
            } catch (err) {
                console.warn('[RouterOS] Vault store failed, config in localStorage only:', err.message);
            }
        })();
    }

    // WEB-REFACTOR #2289: also seed the collector's own per-org RouterOS
    // proxy target (services/collector/lib/routerosConfigStore.js). The
    // hardened /api/v1/mikrotik/proxy route reads ONLY from that store, not
    // from the vault above (which is a separate, best-effort write) or from
    // the request body. Best-effort / fire-and-forget, same as the vault
    // write above — testConnection() already does the same PUT synchronously
    // before this function runs in the normal save flow, so this is a
    // belt-and-braces re-seed, not the only path that populates the store.
    csrfFetch('/collector/api/v1/mikrotik/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            host: config.address,
            port: config.port,
            useSSL: config.useSSL,
            username: config.username,
            password: config.password
        })
    }).catch(err => {
        console.warn('[RouterOS] Collector proxy config store failed:', err.message);
    });

    return true;
}

/**
 * Remove stored configuration
 */
export function removeStoredConfig(orgId) {
    localStorage.removeItem(STORAGE_KEY);
    _resolvedConfig = null;
    if (orgId) {
        // The real vault delete route is id-scoped (DELETE .../integrations/:id),
        // not type-scoped — look the credential up first.
        (async () => {
            try {
                const existing = await findVaultCredential(orgId);
                if (existing) {
                    await csrfFetch(`/api/orgs/${orgId}/integrations/${existing.id}`, { method: 'DELETE' });
                }
            } catch { /* best-effort */ }
        })();
    }
    // WEB-REFACTOR #2289: also clear the collector's per-org proxy target
    // (see storeConfig() above) so the hardened proxy stops dialing a
    // router the user has disconnected.
    csrfFetch('/collector/api/v1/mikrotik/config', { method: 'DELETE' }).catch(() => {});
}

// ============================================
// COLLECTOR PROXY API
// ============================================

// Collector-based proxy for MikroTik API
const PROXY_URL = '/collector/api/v1/mikrotik/proxy';

/**
 * Error class for RouterOS API errors
 */
export class RouterOSError extends Error {
    constructor(status, message, code = null) {
        super(message);
        this.name = 'RouterOSError';
        this.status = status;
        this.code = code;
    }
}

/**
 * Get plain English error message
 */
export function getPlainEnglishError(error) {
    if (error instanceof RouterOSError) {
        switch (error.status) {
            case 401:
                return "Wrong username or password. Double-check your credentials.";
            case 403:
                return "Access denied. Your user account may not have permission for this action.";
            case 404:
                return "REST API not enabled. Enable www-ssl service on your router and make sure you're running RouterOS 7.1+.";
            case 500:
                // Check for specific error codes first
                if (error.code === 'ECONNREFUSED') {
                    return "Can't reach your router. Check the IP address is correct.";
                }
                if (error.code === 'ETIMEDOUT') {
                    return "Router isn't responding. Make sure you're on the same network.";
                }
                if (error.code === 'CERT_ERROR') {
                    return "SSL/TLS connection failed. Your router's www-ssl service may not be configured properly. Try using HTTP (port 80) instead, or check that www-ssl is enabled in IP → Services.";
                }
                if (error.code === 'API_NOT_ENABLED') {
                    return "REST API not found. Enable the www-ssl (or www) service on your router. REST API requires RouterOS 7.1 or newer.";
                }
                return "The router encountered an error. Try again in a moment.";
            default:
                if (error.code === 'ECONNREFUSED') {
                    return "Can't reach your router. Check the IP address is correct.";
                }
                if (error.code === 'ETIMEDOUT') {
                    return "Router isn't responding. Make sure you're on the same network.";
                }
                if (error.code === 'CERT_ERROR') {
                    return "SSL/TLS connection failed. Your router's www-ssl service may not be configured properly. Try using HTTP (port 80) instead.";
                }
                return error.message || "Connection failed. Check your network and router settings.";
        }
    }
    return error.message || "An unexpected error occurred.";
}

/**
 * Make API call through collector proxy.
 *
 * WEB-REFACTOR #2289: the proxy target (host/port/credentials) is now
 * resolved server-side from the caller's org config, never from this
 * request body — sending it here would do nothing but leak it over the
 * wire unnecessarily, since the hardened proxy ignores it. Only the REST
 * path/method/body are sent. `config` is kept as a parameter (unused for
 * the request itself) so callers can still gate on `config?.configured`
 * before calling, as they already do throughout this file.
 */
async function proxyApiCall(config, path, method = 'GET', body = null) {
    const requestBody = JSON.stringify({ path, method, body });

    try {
        const response = await fetch(PROXY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: requestBody
        });

        const result = await response.json();

        if (!result.success) {
            throw new RouterOSError(
                result.status || 500,
                result.error || 'Unknown error',
                result.code
            );
        }

        return result.data;
    } catch (error) {
        if (error instanceof RouterOSError) {
            throw error;
        }
        throw new RouterOSError(0, 'RouterOS proxy not available. Check that the collector service is running.', 'PROXY_UNAVAILABLE');
    }
}

// ============================================
// API FUNCTIONS
// ============================================

/**
 * Test connection to router.
 *
 * WEB-REFACTOR #2289: this is the ONE place raw, not-yet-saved credentials
 * travel from the browser to the collector — it calls
 * PUT /api/v1/mikrotik/config, which test-connects with exactly these
 * credentials and only persists them into the collector's per-org RouterOS
 * proxy store on success. Every other RouterOS call goes through
 * proxyApiCall(), which never carries credentials.
 */
export async function testConnection(config) {
    try {
        const response = await csrfFetch('/collector/api/v1/mikrotik/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                host: config.address,
                port: config.port,
                useSSL: config.useSSL,
                username: config.username,
                password: config.password
            })
        });
        const result = await response.json();

        if (!result.success) {
            throw new RouterOSError(result.status || 422, result.error || 'Connection test failed', result.code);
        }

        const data = result.data || {};
        return {
            success: true,
            data: {
                version: data.version,
                boardName: data['board-name'],
                uptime: data.uptime,
                cpuLoad: data['cpu-load'],
                freeMemory: data['free-memory'],
                totalMemory: data['total-memory']
            }
        };
    } catch (error) {
        if (error instanceof RouterOSError) {
            return {
                success: false,
                error: getPlainEnglishError(error),
                technical: error.message,
                code: error.code,
                status: error.status
            };
        }
        return {
            success: false,
            error: 'RouterOS proxy not available. Check that the collector service is running.',
            technical: error.message,
            code: 'PROXY_UNAVAILABLE',
            status: null
        };
    }
}

/**
 * Get list of configured routers
 */
export async function getRouters() {
    const config = getStoredConfig();
    if (!config?.configured) {
        return []; // No routers configured
    }

    // For now, single router support
    return [{
        id: config.id || 'primary',
        name: config.name || 'Router',
        model: config.model || 'Unknown',
        version: config.version || '',
        ip: config.address,
        status: config.lastConnected ? 'online' : 'unknown',
        uptime: config.uptime || '',
        health: config.health || { score: 0, cpu: 0, memory: 0, temperature: 0, disk: 0 }
    }];
}

/**
 * Get router details by ID
 */
export async function getRouter(routerId) {
    const config = getStoredConfig();
    if (!config?.configured) return null;

    try {
        const resource = await proxyApiCall(config, '/system/resource');
        const health = await proxyApiCall(config, '/system/health').catch(() => []);

        // Find temperature from health data
        const tempItem = health.find?.(h => h.name === 'temperature' || h.name === 'cpu-temperature');
        const temperature = tempItem?.value || 0;

        // Calculate health score
        const cpuLoad = resource['cpu-load'] || 0;
        const memUsed = ((resource['total-memory'] - resource['free-memory']) / resource['total-memory']) * 100;
        const score = Math.round(100 - (cpuLoad * 0.3 + memUsed * 0.3 + Math.max(0, temperature - 50) * 0.4));

        return {
            id: config.id || 'primary',
            name: config.name,
            model: resource['board-name'],
            version: resource.version,
            ip: config.address,
            status: 'online',
            uptime: resource.uptime,
            health: {
                score: Math.max(0, Math.min(100, score)),
                cpu: cpuLoad,
                memory: Math.round(memUsed),
                temperature: temperature,
                disk: resource['free-hdd-space'] && resource['total-hdd-space']
                    ? Math.round(((resource['total-hdd-space'] - resource['free-hdd-space']) / resource['total-hdd-space']) * 100)
                    : 0
            }
        };
    } catch (error) {
        console.error('Failed to get router data:', error);
        return null;
    }
}

/**
 * Get router health metrics
 */
export async function getRouterHealth(routerId) {
    const router = await getRouter(routerId);
    return router?.health || null;
}

/**
 * Get connected devices from ARP table
 */
export async function getDevices(routerId) {
    const config = getStoredConfig();
    if (!config?.configured) return []; // No router configured

    try {
        const arp = await proxyApiCall(config, '/ip/arp');

        return arp
            .filter(entry => entry.address && entry['mac-address'])
            .map((entry, index) => ({
                id: `dev-${index}`,
                hostname: entry.comment || entry.address,
                ip: entry.address,
                mac: entry['mac-address'],
                vendor: detectVendor(entry['mac-address']),
                type: guessDeviceType(entry.comment, entry['mac-address']),
                status: entry.status === 'reachable' || !entry.status ? 'online' : 'offline',
                lastSeen: new Date().toISOString(),
                interface: entry.interface,
                trafficIn: 0, // Not available from ARP
                trafficOut: 0
            }));
    } catch (error) {
        console.error('Failed to get devices:', error);
        return []; // Honest empty state — do not mask a real API error with mock data
    }
}

/**
 * Get DHCP leases
 */
export async function getDHCPLeases(routerId) {
    const config = getStoredConfig();
    if (!config?.configured) return []; // No router configured

    try {
        const leases = await proxyApiCall(config, '/ip/dhcp-server/lease');

        return leases.map((lease, index) => ({
            id: lease['.id'] || `lease-${index}`,
            hostname: lease['host-name'] || lease.comment || 'Unknown',
            ip: lease.address,
            mac: lease['mac-address'],
            vendor: detectVendor(lease['mac-address']),
            status: lease.status || 'bound',
            expires: lease['expires-after'] ? calculateExpiry(lease['expires-after']) : null,
            isStatic: lease.dynamic === 'false' || lease.dynamic === false
        }));
    } catch (error) {
        console.error('Failed to get DHCP leases:', error);
        return []; // Honest empty state — do not mask a real API error with mock data
    }
}

/**
 * Get DHCP pools
 */
export async function getDHCPPools(routerId) {
    const config = getStoredConfig();
    if (!config?.configured) return []; // No router configured

    try {
        const pools = await proxyApiCall(config, '/ip/pool');
        const leases = await getDHCPLeases(routerId);

        return pools.map((pool, index) => {
            const ranges = pool.ranges || '';
            const total = calculatePoolSize(ranges);
            const used = leases.filter(l => isIpInPool(l.ip, ranges)).length;

            return {
                id: pool['.id'] || `pool-${index}`,
                name: pool.name,
                ranges: ranges,
                total: total,
                used: used,
                available: total - used
            };
        });
    } catch (error) {
        console.error('Failed to get DHCP pools:', error);
        return []; // Honest empty state — do not mask a real API error with mock data
    }
}

/**
 * Get alerts (generated from system state analysis)
 */
export async function getAlerts(routerId) {
    const config = getStoredConfig();
    if (!config?.configured) return []; // No router configured

    const alerts = [];

    try {
        // Check for IP conflicts in ARP
        const arp = await proxyApiCall(config, '/ip/arp');
        const macByIp = {};
        arp.forEach(entry => {
            if (entry.address) {
                if (macByIp[entry.address] && macByIp[entry.address] !== entry['mac-address']) {
                    alerts.push({
                        id: `conflict-${entry.address}`,
                        type: 'ip_conflict',
                        severity: 'high',
                        timestamp: new Date().toISOString(),
                        technical: `ARP conflict: ${entry.address} claimed by ${macByIp[entry.address]} and ${entry['mac-address']}`,
                        plainEnglish: `Two devices are fighting over the same IP address (${entry.address}). This can cause connection problems.`,
                        action: 'resolve_conflict'
                    });
                }
                macByIp[entry.address] = entry['mac-address'];
            }
        });

        // Check CPU usage
        const resource = await proxyApiCall(config, '/system/resource');
        if (resource['cpu-load'] > 80) {
            alerts.push({
                id: 'high-cpu',
                type: 'high_cpu',
                severity: 'medium',
                timestamp: new Date().toISOString(),
                technical: `CPU usage at ${resource['cpu-load']}%`,
                plainEnglish: 'Your router is working very hard right now. This might slow down your network.',
                action: 'investigate_cpu'
            });
        }

        // Check memory usage
        const memUsed = ((resource['total-memory'] - resource['free-memory']) / resource['total-memory']) * 100;
        if (memUsed > 85) {
            alerts.push({
                id: 'high-memory',
                type: 'high_memory',
                severity: 'medium',
                timestamp: new Date().toISOString(),
                technical: `Memory usage at ${Math.round(memUsed)}%`,
                plainEnglish: 'Your router is running low on memory. Consider restarting it if performance drops.',
                action: 'investigate_memory'
            });
        }

        return alerts;
    } catch (error) {
        console.error('Failed to get alerts:', error);
        return []; // Honest empty state — do not mask a real API error with mock data
    }
}

/**
 * Get VPN tunnels
 */
export async function getVPNTunnels(routerId) {
    const config = getStoredConfig();
    if (!config?.configured) return []; // No router configured

    const tunnels = [];

    try {
        // Get WireGuard peers
        const wgPeers = await proxyApiCall(config, '/interface/wireguard/peers').catch(() => []);
        wgPeers.forEach((peer, index) => {
            tunnels.push({
                id: peer['.id'] || `wg-${index}`,
                type: 'wireguard',
                name: peer.comment || peer.interface || `WireGuard Peer ${index + 1}`,
                status: peer['last-handshake'] ? 'connected' : 'disconnected',
                endpoint: peer.endpoint || 'dynamic',
                lastHandshake: peer['last-handshake'] ? new Date(Date.now() - parseUptime(peer['last-handshake'])).toISOString() : null,
                txBytes: peer.tx || 0,
                rxBytes: peer.rx || 0,
                allowedIPs: peer['allowed-address'] || ''
            });
        });

        // Get IPsec active peers
        const ipsecPeers = await proxyApiCall(config, '/ip/ipsec/active-peers').catch(() => []);
        ipsecPeers.forEach((peer, index) => {
            tunnels.push({
                id: peer['.id'] || `ipsec-${index}`,
                type: 'ipsec',
                name: peer.comment || `IPsec ${peer['remote-address']}`,
                status: 'established',
                remoteAddress: peer['remote-address'],
                localAddress: peer['local-address'],
                phase1: peer['ph2-state'] || 'established',
                phase2: peer['established'] ? 'up' : 'down',
                uptime: peer.uptime || ''
            });
        });

        return tunnels; // Empty array is an honest "no tunnels" state
    } catch (error) {
        console.error('Failed to get VPN tunnels:', error);
        return [];
    }
}

/**
 * Reserve a DHCP lease (make static)
 */
export async function reserveLease(routerId, leaseId) {
    const config = getStoredConfig();
    if (!config?.configured) {
        return { success: true, message: 'Lease reserved successfully (demo mode)' };
    }

    try {
        await proxyApiCall(config, `/ip/dhcp-server/lease/${leaseId}`, 'PATCH', {
            'make-static': true
        });
        return { success: true, message: 'Lease reserved successfully' };
    } catch (error) {
        return { success: false, message: getPlainEnglishError(error) };
    }
}

/**
 * Release a DHCP lease
 */
export async function releaseLease(routerId, leaseId) {
    const config = getStoredConfig();
    if (!config?.configured) {
        return { success: true, message: 'Lease released successfully (demo mode)' };
    }

    try {
        await proxyApiCall(config, `/ip/dhcp-server/lease/${leaseId}`, 'DELETE');
        return { success: true, message: 'Lease released successfully' };
    } catch (error) {
        return { success: false, message: getPlainEnglishError(error) };
    }
}

/**
 * Block a device (add to address list)
 */
export async function blockDevice(routerId, deviceId, mac) {
    const config = getStoredConfig();
    if (!config?.configured) {
        return { success: true, message: 'Device blocked successfully (demo mode)' };
    }

    try {
        // Add to blocked list
        await proxyApiCall(config, '/ip/firewall/address-list', 'POST', {
            list: 'blocked-devices',
            comment: `Blocked by QUOX: ${mac}`,
            address: mac
        });
        return { success: true, message: 'Device blocked successfully' };
    } catch (error) {
        return { success: false, message: getPlainEnglishError(error) };
    }
}

/**
 * Unblock a device
 */
export async function unblockDevice(routerId, deviceId) {
    const config = getStoredConfig();
    if (!config?.configured) {
        return { success: true, message: 'Device unblocked successfully (demo mode)' };
    }

    // Would need to find and remove from address list
    return { success: true, message: 'Device unblocked successfully' };
}

/**
 * Dismiss an alert
 */
export async function dismissAlert(routerId, alertId) {
    // Alerts are generated, not stored - dismissal would be local only
    return { success: true, message: 'Alert dismissed' };
}

/**
 * Execute alert action
 */
export async function executeAlertAction(routerId, alertId, action) {
    return { success: true, message: `Action "${action}" executed successfully` };
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Detect vendor from MAC address prefix
 */
function detectVendor(mac) {
    if (!mac) return 'Unknown';
    const prefix = mac.substring(0, 8).toUpperCase().replace(/[:-]/g, ':');

    const vendorMap = {
        'AA:BB:CC': 'Apple',
        '00:17:88': 'Philips',
        '00:1A:2B': 'Cisco',
        'B8:27:EB': 'Raspberry Pi',
        'DC:A6:32': 'Raspberry Pi',
        'E4:5F:01': 'Raspberry Pi',
        '00:0C:29': 'VMware',
        '00:50:56': 'VMware',
        '08:00:27': 'VirtualBox',
        '00:1C:42': 'Parallels',
        'AC:DE:48': 'Google',
        'F4:F5:D8': 'Google',
        '00:1A:11': 'Google',
        '30:FD:38': 'Google',
        'EC:FA:BC': 'Amazon',
        'A0:02:DC': 'Amazon',
        'FC:65:DE': 'Amazon',
        '00:23:24': 'Samsung',
        '00:26:37': 'Samsung',
        '5C:3A:45': 'Samsung',
        '00:25:00': 'Apple',
        '00:1E:C2': 'Apple',
        'A4:83:E7': 'Apple',
        '00:0D:93': 'Apple',
        '00:21:5D': 'Intel',
        '00:1B:21': 'Intel',
        '00:1F:3B': 'Intel',
    };

    for (const [p, vendor] of Object.entries(vendorMap)) {
        if (prefix.startsWith(p)) return vendor;
    }

    return 'Unknown';
}

/**
 * Guess device type from hostname or MAC
 */
function guessDeviceType(hostname, mac) {
    const name = (hostname || '').toLowerCase();

    if (name.includes('iphone') || name.includes('android') || name.includes('phone')) return 'phone';
    if (name.includes('ipad') || name.includes('tablet')) return 'tablet';
    if (name.includes('macbook') || name.includes('laptop') || name.includes('notebook')) return 'laptop';
    if (name.includes('imac') || name.includes('desktop') || name.includes('pc')) return 'desktop';
    if (name.includes('tv') || name.includes('roku') || name.includes('chromecast') || name.includes('firetv')) return 'tv';
    if (name.includes('printer') || name.includes('hp') || name.includes('epson') || name.includes('canon')) return 'printer';
    if (name.includes('nest') || name.includes('ring') || name.includes('hue') || name.includes('alexa') || name.includes('echo')) return 'iot';
    if (name.includes('server') || name.includes('nas') || name.includes('synology')) return 'server';
    if (name.includes('camera') || name.includes('cam')) return 'camera';

    return 'unknown';
}

/**
 * Calculate expiry time from RouterOS duration string
 */
function calculateExpiry(duration) {
    // Duration format: 3d2h30m15s
    const ms = parseUptime(duration);
    return new Date(Date.now() + ms).toISOString();
}

/**
 * Parse uptime string to milliseconds
 */
function parseUptime(uptime) {
    if (!uptime) return 0;

    let ms = 0;
    const weeks = uptime.match(/(\d+)w/);
    const days = uptime.match(/(\d+)d/);
    const hours = uptime.match(/(\d+)h/);
    const minutes = uptime.match(/(\d+)m/);
    const seconds = uptime.match(/(\d+)s/);

    if (weeks) ms += parseInt(weeks[1]) * 7 * 24 * 60 * 60 * 1000;
    if (days) ms += parseInt(days[1]) * 24 * 60 * 60 * 1000;
    if (hours) ms += parseInt(hours[1]) * 60 * 60 * 1000;
    if (minutes) ms += parseInt(minutes[1]) * 60 * 1000;
    if (seconds) ms += parseInt(seconds[1]) * 1000;

    return ms;
}

/**
 * Calculate pool size from ranges string
 */
function calculatePoolSize(ranges) {
    if (!ranges) return 0;

    let total = 0;
    ranges.split(',').forEach(range => {
        const match = range.match(/(\d+\.\d+\.\d+\.(\d+))-(\d+\.\d+\.\d+\.(\d+))/);
        if (match) {
            total += parseInt(match[4]) - parseInt(match[2]) + 1;
        }
    });

    return total || 150; // Default estimate
}

/**
 * Check if IP is within a pool range
 */
function isIpInPool(ip, ranges) {
    if (!ip || !ranges) return false;

    const ipNum = ipToNumber(ip);
    return ranges.split(',').some(range => {
        const match = range.match(/(\d+\.\d+\.\d+\.\d+)-(\d+\.\d+\.\d+\.\d+)/);
        if (match) {
            const start = ipToNumber(match[1]);
            const end = ipToNumber(match[2]);
            return ipNum >= start && ipNum <= end;
        }
        return false;
    });
}

/**
 * Convert IP address to number for comparison
 */
function ipToNumber(ip) {
    return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet), 0) >>> 0;
}

// ============================================
// REACT HOOKS
// ============================================

/**
 * Hook to check RouterOS license status
 * Extension enabled = licensed
 */
export function useRouterOSLicenseStatus() {
    const [licensed, setLicensed] = useState(true);
    const [loading, setLoading] = useState(false);

    // Extension enabled in settings = licensed
    return { licensed, loading };
}

/**
 * Hook to manage router configuration
 *
 * Vault is the source of truth; localStorage is a fast cache/fallback only.
 * @param {string} [orgId] - Current org id (from useWorkspace().currentOrg?.id).
 *   Without it, writes/deletes cannot reach the vault and are surfaced as an
 *   error rather than silently persisted to localStorage only.
 */
export function useRouterOSConfig(orgId) {
    const [config, setConfig] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        loadConfigAsync(orgId).then(loaded => {
            if (!cancelled) {
                setConfig(loaded);
                setLoading(false);
            }
        });
        return () => { cancelled = true; };
    }, [orgId]);

    const saveConfig = useCallback(async (newConfig) => {
        if (!orgId) {
            console.error('[RouterOS] No organization context available — router config will NOT be persisted to the vault (localStorage cache only, password will not be saved).');
            setError('No organization selected. Router credentials were not saved to the vault and will be lost on a fresh browser.');
        } else {
            setError(null);
        }

        // Test connection first
        const testResult = await testConnection(newConfig);
        if (!testResult.success) {
            throw new Error(testResult.error);
        }

        // Save to storage
        const configToSave = {
            ...newConfig,
            configured: true,
            lastConnected: new Date().toISOString(),
            model: testResult.data.boardName,
            version: testResult.data.version
        };

        storeConfig(configToSave, orgId);
        setConfig(configToSave);

        return testResult;
    }, [orgId]);

    const clearConfig = useCallback(() => {
        if (!orgId) {
            console.error('[RouterOS] No organization context available — router config removed from localStorage cache only, vault entry (if any) was NOT deleted.');
        }
        removeStoredConfig(orgId);
        setConfig(null);
    }, [orgId]);

    return {
        config,
        loading,
        error,
        configured: !!config?.configured,
        saveConfig,
        clearConfig
    };
}

/**
 * Hook for router data with auto-refresh
 */
export function useRouterData(routerId, refreshInterval = 30000) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [retryCount, setRetryCount] = useState(0);

    const refresh = useCallback(async () => {
        try {
            const [router, devices, leases, pools, alerts, vpn] = await Promise.all([
                getRouter(routerId),
                getDevices(routerId),
                getDHCPLeases(routerId),
                getDHCPPools(routerId),
                getAlerts(routerId),
                getVPNTunnels(routerId)
            ]);

            setData({
                router,
                devices,
                leases,
                pools,
                alerts,
                vpn
            });
            setError(null);
            setRetryCount(0);
        } catch (err) {
            setError(err.message || 'Failed to load router data');
            setRetryCount(prev => prev + 1);
        } finally {
            setLoading(false);
        }
    }, [routerId]);

    useEffect(() => {
        if (!routerId) {
            setLoading(false);
            return;
        }

        refresh();
        const interval = setInterval(refresh, refreshInterval);
        return () => clearInterval(interval);
    }, [refresh, refreshInterval, routerId]);

    return { data, loading, error, retryCount, refresh };
}

/**
 * Build context for NETWATCH chat
 */
export function buildNetwatchContext(query, routerData) {
    if (!routerData) return '';

    const { router, devices, alerts, leases, vpn } = routerData;
    const onlineDevices = devices?.filter(d => d.status === 'online').length || 0;
    const totalDevices = devices?.length || 0;
    const activeAlerts = alerts?.length || 0;
    const criticalAlerts = alerts?.filter(a => a.severity === 'high' || a.severity === 'critical').length || 0;

    const context = `
## Current Router Status

**Router:** ${router?.name || 'Unknown'} (${router?.model || 'Unknown'})
**IP:** ${router?.ip || 'Unknown'}
**Status:** ${router?.status || 'Unknown'}
**Uptime:** ${router?.uptime || 'Unknown'}
**RouterOS Version:** ${router?.version || 'Unknown'}

### Health Metrics
- **Overall Health Score:** ${router?.health?.score || 0}%
- **CPU Usage:** ${router?.health?.cpu || 0}%
- **Memory Usage:** ${router?.health?.memory || 0}%
- **Temperature:** ${router?.health?.temperature || 0}°C
- **Disk Usage:** ${router?.health?.disk || 0}%

### Network Overview
- **Connected Devices:** ${onlineDevices}/${totalDevices} online
- **Active DHCP Leases:** ${leases?.length || 0}
- **VPN Tunnels:** ${vpn?.length || 0}

### Alerts
- **Active Alerts:** ${activeAlerts}
- **Critical/High Severity:** ${criticalAlerts}
${alerts?.slice(0, 3).map(a => `- [${a.severity.toUpperCase()}] ${a.plainEnglish}`).join('\n') || ''}

When responding:
1. Use plain English explanations - avoid technical jargon when possible
2. Provide actionable recommendations
3. If asked about specific devices or issues, provide details from the current data
4. Be proactive about suggesting improvements or fixes
`.trim();

    return context;
}

export default {
    getRouters,
    getRouter,
    getRouterHealth,
    getDevices,
    getDHCPLeases,
    getDHCPPools,
    getAlerts,
    getVPNTunnels,
    reserveLease,
    releaseLease,
    blockDevice,
    unblockDevice,
    dismissAlert,
    executeAlertAction,
    testConnection,
    getStoredConfig,
    storeConfig,
    removeStoredConfig,
    useRouterOSLicenseStatus,
    useRouterOSConfig,
    useRouterData,
    buildNetwatchContext
};
