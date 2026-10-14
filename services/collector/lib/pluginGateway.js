/**
 * Plugin Gateway
 *
 * Proxy layer for third-party plugin backend containers. Follows the existing
 * monitoring proxy pattern (server.js line 9936-9950) and connector bridge
 * registry pattern (connectors/registry.js).
 *
 * Plugin containers join the quox-network Docker bridge so the collector can
 * reach them by container name.
 */

const http = require('http');
const https = require('https');
const { isPluginLicensed: defaultIsPluginLicensed } = require('./licenseGate.js');
const { mintOrgTicket } = require('./pluginOrgTicket.js');

// ── Plugin backend registry ──────────────────────────────────────────────

/** Map<pluginId, { url, healthPath, port, status, rateLimit, lastHealthCheck }> */
const PLUGIN_BACKENDS = new Map();

/**
 * Per-plugin gateway secret, injected as X-Gateway-Secret so a backend that
 * publishes its org port can prove a request came through the gateway.
 * Convention: env PLUGIN_GATEWAY_SECRET_<PLUGINID_UPPER_UNDERSCORED>, with a
 * global PLUGIN_GATEWAY_SECRET fallback. Absent → header omitted (backend
 * runs in loopback-only / no-secret mode).
 */
function pluginGatewaySecret(pluginId) {
    const key = `PLUGIN_GATEWAY_SECRET_${String(pluginId).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    return process.env[key] || process.env.PLUGIN_GATEWAY_SECRET || null;
}

// Rate limit tracking per plugin
const rateLimits = new Map(); // pluginId → { count, windowStart }


// ── Target URL confinement (SEC-PLUGIN-TRUST M4) ──────────────────────────

/**
 * Parse a registered backend base URL; only http: and https: are allowed.
 * Throws (fail closed) otherwise.
 */
function parseBackendBase(rawUrl) {
    let base;
    try {
        base = new URL(rawUrl);
    } catch {
        throw new Error('Plugin backend URL is not a valid URL');
    }
    if (base.protocol !== 'http:' && base.protocol !== 'https:') {
        throw new Error(`Plugin backend URL protocol not allowed: ${base.protocol}`);
    }
    return base;
}

/**
 * Build the upstream target from the registered base URL plus a confined
 * path (and optional query). The incoming path can never change protocol,
 * host or port: it must start with '/', is appended as a pathname (never
 * resolved as a reference), and the result is re-checked against the base.
 * @returns {URL}
 */
function buildBackendTarget(baseUrl, rawPath) {
    const base = parseBackendBase(baseUrl);
    let p = rawPath === undefined || rawPath === null || rawPath === '' ? '/' : String(rawPath);
    if (p[0] === '?') p = '/' + p;
    if (p[0] !== '/' && p[0] !== '\\') {
        throw new Error('Plugin path must start with /');
    }
    const q = p.indexOf('?');
    let pathPart = q === -1 ? p : p.slice(0, q);
    const query = q === -1 ? '' : p.slice(q);
    // Collapse leading slashes/backslashes so '//evil' is a path, not an authority.
    pathPart = '/' + pathPart.replace(/^[\\/]+/, '');
    const target = new URL(base.href);
    const basePath = base.pathname.replace(/\/+$/, '');
    target.pathname = basePath + pathPart;
    target.search = query;
    target.hash = '';
    if (target.protocol !== base.protocol || target.host !== base.host || target.username || target.password) {
        throw new Error('Plugin path attempted to change the backend target');
    }
    return target;
}

/** TLS verification is on unless an admin opted this backend out explicitly. */
function tlsOptionsFor(backend, target) {
    return target.protocol === 'https:' ? { rejectUnauthorized: backend.tlsInsecure !== true } : {};
}

/** Node request options for a confined target. */
function requestOptionsFor(backend, target) {
    return {
        hostname: target.hostname,
        port: target.port || undefined,
        path: target.pathname + target.search,
        ...tlsOptionsFor(backend, target),
    };
}

/**
 * Register a plugin backend.
 * @param {string} pluginId
 * @param {{url: string, healthPath?: string, rateLimit?: number}} config
 */
function registerPluginBackend(pluginId, config) {
    if (!pluginId || !config?.url) {
        throw new Error('pluginId and config.url are required');
    }
    parseBackendBase(config.url); // fail closed on non-http(s) / malformed URLs

    PLUGIN_BACKENDS.set(pluginId, {
        url: config.url.replace(/\/+$/, ''),
        // image the container was started from, kept so a later registration
        // with a different image is detected as a conflict (FND_01M4SZ7NNV4NZ57ZM6J34NZ57Z).
        image: config.image || null,
        healthPath: config.healthPath || '/health',
        // Explicit per-backend opt-out of TLS verification (https only); instance-admin set.
        tlsInsecure: config.tlsInsecure === true,
        // requests per minute PER USER (see checkRateLimit). Data-heavy plugin
        // cockpits (e.g. QuoxTrade fires ~20-30 endpoints on a single load, plus
        // per-asset chart/backtest calls) blew straight through the old global
        // 60/min — which, now that first-party plugins are installed in every
        // org, was shared across all users and instantly tripped 429s.
        rateLimit: config.rateLimit || 600,
        status: 'unknown',
        lastHealthCheck: null,
        registeredAt: new Date().toISOString(),
    });

    console.log(`[PluginGateway] Registered backend for ${pluginId}: ${config.url}`);
}

/**
 * Unregister a plugin backend.
 * @param {string} pluginId
 */
function unregisterPluginBackend(pluginId) {
    PLUGIN_BACKENDS.delete(pluginId);
    // Rate-limit keys are `${pluginId}::${userKey}` — clear every user's window.
    for (const key of rateLimits.keys()) {
        if (key === pluginId || key.startsWith(`${pluginId}::`)) rateLimits.delete(key);
    }
    console.log(`[PluginGateway] Unregistered backend for ${pluginId}`);
}

/**
 * Get a registered plugin backend config.
 * @param {string} pluginId
 * @returns {Object|null}
 */
function getPluginBackend(pluginId) {
    return PLUGIN_BACKENDS.get(pluginId) || null;
}

/**
 * List all registered plugin backends with their health status.
 * @returns {Array<{pluginId, url, status, lastHealthCheck, registeredAt}>}
 */
function listPluginBackends() {
    const result = [];
    for (const [pluginId, config] of PLUGIN_BACKENDS) {
        result.push({
            pluginId,
            url: config.url,
            status: config.status,
            healthPath: config.healthPath,
            rateLimit: config.rateLimit,
            lastHealthCheck: config.lastHealthCheck,
            registeredAt: config.registeredAt,
        });
    }
    return result;
}

// ── Rate limiting ─────────────────────────────────────────────────────────

// Rate limit is PER (plugin, user): one user hammering their own cockpit must
// never starve another user of the same plugin. `userKey` is the verified user
// id (falls back to client IP for unauthenticated/service calls).
function checkRateLimit(pluginId, userKey = 'anon') {
    const backend = PLUGIN_BACKENDS.get(pluginId);
    if (!backend) return false;

    const key = `${pluginId}::${userKey}`;
    const now = Date.now();
    let tracker = rateLimits.get(key);

    if (!tracker || now - tracker.windowStart > 60000) {
        tracker = { count: 0, windowStart: now };
        rateLimits.set(key, tracker);
    }

    tracker.count++;
    return tracker.count <= backend.rateLimit;
}

// ── Proxy ─────────────────────────────────────────────────────────────────

/**
 * Proxy a request to a plugin backend.
 * Strips the /api/v1/plugins/:pluginId prefix and forwards the rest.
 *
 * LICENSE-LAUNCH LL-6b: the entitlement gate lives HERE as well as on the
 * catch-all route (server.js ~L24884, LE-3f). Today that route is the only
 * call site, but "the only call site" is a property of the current source, not
 * an invariant — the plugin storage routes (LL-1b) were an object lesson in a
 * prefix registered BEFORE the catch-all matching first and never crossing its
 * gate. Per the auth-gate-vs-handler-token-asymmetry lesson the licence check
 * belongs in the thing that actually reaches the backend. Semantics are
 * IDENTICAL to the route gate, so the double check is a no-op in production
 * (licenseGate caches for 30s, so the second call is a cache hit):
 *
 *   req.user present  → org_id required, entitlement required (402 otherwise)
 *   req.service only  → pure INTERNAL_SERVICE_KEY call, inside the trust
 *                       boundary, bypasses (same carve-out as LE-3f)
 *   neither           → 401, defence in depth behind requireServiceOrUserAuth()
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} pluginId
 * @param {{ isPluginLicensed?: (orgId: string, pluginId: string) => Promise<boolean> }} [deps]
 *   Entitlement resolver override (tests inject a stub; production uses the
 *   real auth-service-backed licenseGate client).
 */
async function proxyToPlugin(req, res, pluginId, deps = {}) {
    const backend = PLUGIN_BACKENDS.get(pluginId);
    if (!backend) {
        return res.status(404).json({ error: `Plugin backend not registered: ${pluginId}` });
    }

    if (req.user) {
        if (!req.user.org_id) {
            return res.status(402).json({ error: 'LICENSE_REQUIRED', plugin: pluginId, reason: 'no_org_context' });
        }
        const isLicensed = deps.isPluginLicensed || defaultIsPluginLicensed;
        let licensed = false;
        try {
            licensed = await isLicensed(req.user.org_id, pluginId);
        } catch {
            licensed = false; // fail closed, same posture as licenseGate itself
        }
        if (!licensed) {
            return res.status(402).json({ error: 'LICENSE_REQUIRED', plugin: pluginId });
        }
    } else if (!req.service) {
        return res.status(401).json({ error: 'authentication_required' });
    }

    // Rate limit check — per user, so one busy cockpit never starves others.
    if (!checkRateLimit(pluginId, req.user?.id || req.ip || 'anon')) {
        return res.status(429).json({ error: 'Rate limit exceeded for plugin backend' });
    }

    // Build target URL: strip the proxy prefix, keep the rest
    const proxyPrefix = `/api/v1/plugins/${pluginId}`;
    const targetPath = req.originalUrl.replace(proxyPrefix, '') || '/';

    try {
        let target;
        try {
            target = buildBackendTarget(backend.url, targetPath);
        } catch (e) {
            return res.status(400).json({ error: `Invalid plugin path: ${e.message}` });
        }
        const transport = target.protocol === 'https:' ? https : http;
        const orgTicket = req.user?.org_id
            ? mintOrgTicket({ pluginId, orgId: req.user.org_id, userId: req.user.id })
            : null;

        const proxyReq = transport.request({
            ...requestOptionsFor(backend, target),
            method: req.method,
            timeout: 30000,
            headers: {
                'Content-Type': req.headers['content-type'] || 'application/json',
                'Accept': req.headers['accept'] || 'application/json',
                'X-Plugin-Id': pluginId,
                'X-Forwarded-For': req.ip,
                // Forward user info if available
                ...(req.user ? { 'X-User-Id': req.user.id, 'X-User-Email': req.user.email } : {}),
                // Org scoping for multi-tenant plugin backends: the backend
                // must never trust a client-declared org — only this header,
                // derived from the verified token (SPATIAL-W2).
                ...(req.user?.org_id ? { 'X-Org-Id': req.user.org_id } : {}),
                // SEC-PLUGIN-TRUST C1: signed on-behalf-of ticket. The backend echoes
                // it when it calls the host with its qplg_ credential, which is the
                // only way it can act for this org. Never forwarded from the client.
                ...(orgTicket ? { 'X-Quox-Org-Ticket': orgTicket } : {}),
                // AUDIT: prove this request came through the gateway. A plugin
                // backend that publishes its org port can require this secret
                // so a direct forged-X-Org-Id caller is rejected. Injected
                // from collector env, per-plugin (falls back to a global).
                ...(pluginGatewaySecret(pluginId) ? { 'X-Gateway-Secret': pluginGatewaySecret(pluginId) } : {}),
            },
        }, (proxyRes) => {
            res.status(proxyRes.statusCode);
            // Forward content-type header
            if (proxyRes.headers['content-type']) {
                res.setHeader('content-type', proxyRes.headers['content-type']);
            }
            proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
            console.error(`[PluginGateway] Proxy error for ${pluginId}:`, err.message);
            if (!res.headersSent) {
                res.status(502).json({ error: `Plugin backend unreachable: ${err.message}` });
            }
        });

        proxyReq.on('timeout', () => {
            proxyReq.destroy();
            if (!res.headersSent) {
                res.status(504).json({ error: 'Plugin backend timeout' });
            }
        });

        // Pipe request body for POST/PUT/PATCH
        if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
            if (req.body && typeof req.body === 'object') {
                proxyReq.write(JSON.stringify(req.body));
                proxyReq.end();
            } else {
                req.pipe(proxyReq);
            }
        } else {
            proxyReq.end();
        }

    } catch (err) {
        console.error(`[PluginGateway] Proxy error for ${pluginId}:`, err);
        if (!res.headersSent) {
            res.status(500).json({ error: `Proxy error: ${err.message}` });
        }
    }
}

// ── Health checks ─────────────────────────────────────────────────────────

/**
 * Health check a single plugin backend.
 * @param {string} pluginId
 * @returns {Promise<{status: string, latency?: number, error?: string}>}
 */
async function healthCheckPlugin(pluginId) {
    const backend = PLUGIN_BACKENDS.get(pluginId);
    if (!backend) {
        return { status: 'not_registered' };
    }

    let target;
    try {
        target = buildBackendTarget(backend.url, backend.healthPath);
    } catch (e) {
        backend.status = 'unreachable';
        backend.lastHealthCheck = new Date().toISOString();
        return { status: 'unreachable', error: e.message };
    }
    const start = Date.now();

    return new Promise((resolve) => {
        const transport = target.protocol === 'https:' ? https : http;

        const req = transport.get({
            ...requestOptionsFor(backend, target),
            timeout: 5000,
        }, (res) => {
            const latency = Date.now() - start;
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                const status = res.statusCode >= 200 && res.statusCode < 300 ? 'healthy' : 'unhealthy';
                backend.status = status;
                backend.lastHealthCheck = new Date().toISOString();
                resolve({ status, latency, statusCode: res.statusCode });
            });
        });

        req.on('error', (err) => {
            backend.status = 'unreachable';
            backend.lastHealthCheck = new Date().toISOString();
            resolve({ status: 'unreachable', error: err.message });
        });

        req.on('timeout', () => {
            req.destroy();
            backend.status = 'timeout';
            backend.lastHealthCheck = new Date().toISOString();
            resolve({ status: 'timeout' });
        });
    });
}

/**
 * Health check all registered plugin backends.
 * @returns {Promise<Object<string, {status, latency?}>>}
 */
async function healthCheckAllPlugins() {
    const results = {};
    for (const [pluginId] of PLUGIN_BACKENDS) {
        results[pluginId] = await healthCheckPlugin(pluginId);
    }
    return results;
}

// ── Periodic health checks ────────────────────────────────────────────────

let healthCheckInterval = null;

function startHealthChecks(intervalMs = 60000) {
    if (healthCheckInterval) return;
    healthCheckInterval = setInterval(() => {
        healthCheckAllPlugins().catch(err => {
            console.error('[PluginGateway] Health check error:', err);
        });
    }, intervalMs);
    if (healthCheckInterval.unref) healthCheckInterval.unref();
    console.log(`[PluginGateway] Health checks started (every ${intervalMs / 1000}s)`);
}

function stopHealthChecks() {
    if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
    }
}

// ── Plugin tool registration ──────────────────────────────────────────────

/**
 * Register agent tools from a plugin backend.
 * Tools are namespaced: plugin_{pluginId}_{toolName}
 *
 * @param {string} pluginId
 * @param {Array<{name, description, input_schema}>} tools
 * @param {Object} TOOL_DEFS - Reference to the global TOOL_DEFS object
 * @param {Object} AGENT_TOOLS - Reference to the global AGENT_TOOLS object
 * @returns {{registered: number}}
 */
// AUDIT HIGH: cap tools per registration so a hostile/buggy backend can't
// grow TOOL_DEFS/AGENT_TOOLS without bound.
const MAX_TOOLS_PER_PLUGIN = 64;

function registerPluginTools(pluginId, tools, TOOL_DEFS, AGENT_TOOLS) {
    let registered = 0;
    let skipped = 0;
    const backend = PLUGIN_BACKENDS.get(pluginId);
    const list = Array.isArray(tools) ? tools.slice(0, MAX_TOOLS_PER_PLUGIN) : [];

    for (const tool of list) {
        // AUDIT HIGH: validate tool.name — an unvalidated name could contain
        // '__' or odd chars and, combined with pluginId dash→underscore
        // normalization, collide with another plugin's namespaced tool and
        // silently overwrite it (a live hijack, not just a clash).
        if (typeof tool?.name !== 'string' || !/^[a-zA-Z0-9_]{1,64}$/.test(tool.name)) {
            skipped++;
            continue;
        }
        const namespacedName = `plugin_${pluginId.replace(/-/g, '_')}_${tool.name}`;

        // Refuse to overwrite an existing tool owned by a DIFFERENT plugin
        // (e.g. foo-bar vs foo_bar normalizing identically).
        const existing = TOOL_DEFS[namespacedName];
        if (existing && existing._plugin && existing._plugin !== pluginId) {
            console.warn(`[PluginGateway] refusing tool ${namespacedName}: name collision between ${existing._plugin} and ${pluginId}`);
            skipped++;
            continue;
        }

        TOOL_DEFS[namespacedName] = {
            name: namespacedName,
            description: `[Plugin: ${pluginId}] ${tool.description}`,
            input_schema: tool.input_schema || { type: 'object', properties: {}, required: [] },
            _plugin: pluginId,
            _entity: true,
            // QUOXTRUST F5 (FND_..TYX): the plugin's SELF-DECLARED intent for this
            // tool ('read' | 'effect'), stored raw. It is only ever an INPUT to the
            // server-side classifyPluginToolEffect() decision at the GOV-4 choke — a
            // plugin label can add restriction, never remove it, and undeclared is
            // treated as an effect (fail-safe). `_pluginBaseName` is the un-namespaced
            // name the effect-verb heuristic reads.
            _pluginBaseName: tool.name,
            _pluginEffect: typeof tool.effect === 'string' ? tool.effect.toLowerCase() : null,
            // executeTool passes (input, ctx) — ctx carries the verified
            // org/user/agent identity. Forward it as headers: a multi-tenant
            // plugin backend answering a tool call without org context would
            // have to guess whose data to read (SPATIAL-W4).
            execute: async (input, ctx = {}) => {
                if (!backend) {
                    return { success: false, error: `Plugin backend ${pluginId} not registered` };
                }
                // QUOXTRUST F3 (FND_..TTX): plugin tools register into the GLOBAL
                // TOOL_DEFS / AGENT_TOOLS, so without a per-call check a governed
                // plugin enabled+licensed for one org is resolvable and executable
                // by ANOTHER org (cross-tenant). Gate execution on the CALLING
                // org's entitlement: an org-scoped caller (ctx.orgId present) must
                // be entitled to this plugin. isPluginLicensed fails CLOSED. The
                // trusted internal/service path (no ctx.orgId) is unaffected —
                // consistent with the F1 org-authority model. Free/ungoverned
                // plugins resolve licensed-for-all by design.
                if (ctx.orgId) {
                    let licensed = false;
                    try { licensed = await defaultIsPluginLicensed(ctx.orgId, pluginId); }
                    catch { licensed = false; }
                    if (!licensed) {
                        return { success: false, error: `plugin ${pluginId} is not enabled for this org`, _governanceDenied: true, status: 403 };
                    }
                }
                try {
                    const res = await new Promise((resolve, reject) => {
                        const target = buildBackendTarget(backend.url, `/tools/${encodeURIComponent(tool.name)}`);
                        const transport = target.protocol === 'https:' ? https : http;
                        const req = transport.request({
                            ...requestOptionsFor(backend, target),
                            method: 'POST',
                            timeout: 30000,
                            headers: {
                                'Content-Type': 'application/json',
                                ...(ctx.orgId ? { 'X-Org-Id': ctx.orgId } : {}),
                                ...(ctx.orgId ? { 'X-Quox-Org-Ticket': mintOrgTicket({ pluginId, orgId: ctx.orgId, userId: ctx.userId }) } : {}),
                                ...(ctx.userId ? { 'X-User-Id': ctx.userId } : {}),
                                ...(ctx.agentId ? { 'X-Agent-Id': ctx.agentId } : {}),
                                ...(pluginGatewaySecret(pluginId) ? { 'X-Gateway-Secret': pluginGatewaySecret(pluginId) } : {}),
                            },
                        }, (res) => {
                            let body = '';
                            res.on('data', c => body += c);
                            res.on('end', () => {
                                try { resolve(JSON.parse(body)); }
                                catch { resolve({ result: body }); }
                            });
                        });
                        req.on('error', reject);
                        req.write(JSON.stringify(input));
                        req.end();
                    });
                    return res;
                } catch (err) {
                    return { success: false, error: err.message };
                }
            },
        };

        // Add to orchestrator agent tools
        if (AGENT_TOOLS.quox && !AGENT_TOOLS.quox.includes(namespacedName)) {
            AGENT_TOOLS.quox.push(namespacedName);
        }

        registered++;
    }

    console.log(`[PluginGateway] Registered ${registered} tools for plugin ${pluginId}${skipped ? ` (${skipped} skipped: invalid name or collision)` : ''}`);
    return { registered, skipped };
}

/**
 * Unregister all tools for a plugin.
 */
function unregisterPluginTools(pluginId, TOOL_DEFS, AGENT_TOOLS) {
    const prefix = `plugin_${pluginId.replace(/-/g, '_')}_`;
    const toRemove = Object.keys(TOOL_DEFS).filter(k => k.startsWith(prefix));
    for (const name of toRemove) {
        delete TOOL_DEFS[name];
    }
    // Remove from agent tool lists
    for (const [, tools] of Object.entries(AGENT_TOOLS)) {
        let idx = tools.findIndex(t => t.startsWith(prefix));
        while (idx !== -1) {
            tools.splice(idx, 1);
            idx = tools.findIndex(t => t.startsWith(prefix));
        }
    }
}

// ── Exports ───────────────────────────────────────────────────────────────

module.exports = {
    registerPluginBackend,
    unregisterPluginBackend,
    getPluginBackend,
    listPluginBackends,
    proxyToPlugin,
    healthCheckPlugin,
    healthCheckAllPlugins,
    startHealthChecks,
    stopHealthChecks,
    registerPluginTools,
    unregisterPluginTools,
    checkRateLimit,
    buildBackendTarget,
};
