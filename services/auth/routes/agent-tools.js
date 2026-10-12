/**
 * Agent Tool Execution Routes
 * Phase 3: Make agents actually invoke tools instead of LLM-only responses
 *
 * ============================================================================
 * DEPRECATION NOTICE (2026-02-04):
 * This file provides inline tool handlers that BYPASS the proper tool registry.
 *
 * PROPER ARCHITECTURE:
 * 1. Tools should be defined in tool_definitions table (via seed-tools.js)
 * 2. Tools installed per-org via tool_installations
 * 3. Tools assigned to agents via agent_tool_assignments
 * 4. Complex tools should be QuoxFlow workflows
 *
 * This file remains functional for backward compatibility but should be
 * migrated to the proper tool registry system. New tools should be:
 * - Added to /services/auth/scripts/seed-tools.js
 * - Implemented as QuoxFlow workflows
 *
 * See: /services/auth/routes/tool-catalog.js for the proper API
 * ============================================================================
 *
 * This provides a simple tool execution layer for core agent capabilities.
 * For complex sandboxed execution, use the full sandbox service.
 */

import { Router } from 'express';
import { prepare } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership } from '../middleware/org.js';
import { createAuditEvent, ulid } from '../utils/helpers.js';
// Issue #163 fix: Import comprehensive SSRF protection
import { validateUrlForSSRF, safeFetch } from '../utils/urlValidation.js';

const router = Router();
router.use(requireAuth);

// =============================================================================
// INPUT VALIDATION (C1 Security Fix - Command Injection Prevention)
// =============================================================================

// Strict regex patterns for input validation
const IPV4_REGEX = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
const HOSTNAME_REGEX = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const DOMAIN_REGEX = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

/**
 * Validate a target (hostname or IPv4 address)
 * Blocks command injection via shell metacharacters
 */
function validateTarget(target) {
    if (!target || typeof target !== 'string') return false;
    if (target.length > 253) return false;
    // Must match either IPv4 or valid hostname pattern
    return IPV4_REGEX.test(target) || HOSTNAME_REGEX.test(target);
}

/**
 * Validate a domain name
 */
function validateDomain(domain) {
    if (!domain || typeof domain !== 'string') return false;
    if (domain.length > 253) return false;
    return DOMAIN_REGEX.test(domain);
}

/**
 * Validate a port number
 */
function validatePort(port) {
    const p = parseInt(port, 10);
    return !isNaN(p) && p >= 1 && p <= 65535;
}

// =============================================================================
// SSRF PROTECTION (H1 Security Fix - Enhanced for Issue #163)
// =============================================================================

// Issue #163: validateProbeUrl replaced with comprehensive validateUrlForSSRF
// from utils/urlValidation.js which handles:
// - DNS rebinding protection (resolves hostname before connecting)
// - IPv6 loopback and IPv4-mapped addresses
// - HTTP redirect validation
// - Encoded IP formats (decimal, hex, octal)

// =============================================================================
// SOURCE/HOST PARAMETER VALIDATION (Issue #163 Fix)
// =============================================================================

/**
 * Allowed source hosts for bastion command execution
 * These are the only hosts that operators can execute commands FROM
 * Issue #163: Prevents lateral movement to arbitrary hosts
 */
const ALLOWED_BASTION_SOURCES = new Set([
    'gw-01',    // Primary bastion
    'docker01', 'docker02', 'docker03', 'docker04',  // Docker hosts
    'proxmox01', 'proxmox02', 'proxmox03',           // Proxmox nodes
    'kuma01',      // Monitoring
]);

/**
 * Allowed hosts for docker operations
 */
const ALLOWED_DOCKER_HOSTS = new Set([
    'docker01', 'docker02', 'docker03', 'docker04'
]);

/**
 * Sanitize a hostname parameter — strip anything except [a-z0-9-]
 * Issue #163 hardening: prevents null-byte injection, unicode normalization attacks
 */
function sanitizeHostParam(value) {
    if (!value || typeof value !== 'string') return '';
    return value.toLowerCase().replace(/[^a-z0-9-]/g, '');
}

/**
 * Validate source parameter for bastion execution
 * Issue #163 fix: Prevents arbitrary host execution
 */
function validateSource(source) {
    const clean = sanitizeHostParam(source);
    if (!clean) return false;
    return ALLOWED_BASTION_SOURCES.has(clean);
}

/**
 * Validate host parameter for docker operations
 * Issue #163 fix: Restricts docker commands to docker hosts only
 */
function validateDockerHost(host) {
    const clean = sanitizeHostParam(host);
    if (!clean) return false;
    return ALLOWED_DOCKER_HOSTS.has(clean);
}

// =============================================================================
// ROLE-BASED ACCESS CONTROL (C2 Security Fix)
// =============================================================================

// Tool risk levels - determines minimum role required
const TOOL_RISK_LEVELS = {
    'auth_audit': 'viewer',      // read-only audit data
    'failed_logins': 'viewer',   // read-only security data
    'active_sessions': 'viewer', // read-only session data
    'health_probe': 'member',    // can probe external URLs
    'org_stats': 'viewer',       // read-only org stats
    'docker_list': 'operator',   // infrastructure access
    'ping': 'operator',          // network diagnostics
    'traceroute': 'operator',    // network diagnostics
    'dns_lookup': 'member',      // DNS queries (lower risk)
    'port_check': 'operator'     // port scanning capability
};

// Role hierarchy for permission checks
const ROLE_HIERARCHY = {
    'viewer': 1,
    'member': 2,
    'operator': 3,
    'admin': 4,
    'owner': 5
};

/**
 * Check if user role meets minimum requirement
 */
function hasRole(userRole, requiredRole) {
    const userLevel = ROLE_HIERARCHY[userRole] || 0;
    const requiredLevel = ROLE_HIERARCHY[requiredRole] || 999;
    return userLevel >= requiredLevel;
}

// Bastion configuration - set BASTION_URL env var or configure in auth service .env
const BASTION_URL = process.env.BASTION_URL || 'http://gw-01:9850';
const BASTION_TOKEN = process.env.BASTION_API_TOKEN || null;
const BASTION_TIMEOUT = 30000;

/**
 * Execute a command via QuoxBastion
 * @param {string[]} targets - Host IDs to execute on
 * @param {string} command - Command to execute
 * @param {number} timeout - Command timeout in seconds
 * @returns {Promise<Object>} - Execution results
 */
async function bastionExec(targets, command, timeout = 60) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), BASTION_TIMEOUT);

    const headers = {
        'Content-Type': 'application/json'
    };
    if (BASTION_TOKEN) {
        headers['Authorization'] = `Bearer ${BASTION_TOKEN}`;
    }

    try {
        const response = await fetch(`${BASTION_URL}/api/v1/exec`, {
            method: 'POST',
            headers,
            signal: controller.signal,
            body: JSON.stringify({
                targets,
                command,
                timeout,
                parallel: true
            })
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Bastion error: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        return data.results || [];
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
            throw new Error('Bastion request timed out');
        }
        throw err;
    }
}

/**
 * Check if bastion is available
 */
async function checkBastionHealth() {
    try {
        const response = await fetch(`${BASTION_URL}/api/v1/health`, {
            method: 'GET',
            signal: AbortSignal.timeout(5000)
        });
        return response.ok;
    } catch {
        return false;
    }
}

// Tool implementations
const TOOL_HANDLERS = {
    /**
     * WARDEN: Query auth audit events
     */
    'auth_audit': async (params, context) => {
        const { orgId } = context;
        const { hours = 24, eventTypes, limit = 100 } = params;

        const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

        let query = `
            SELECT id, action, actor_type, actor_id, target_type, target_id,
                   status, ip_address, created_at, metadata_json
            FROM audit_events
            WHERE org_id = ? AND created_at > ?
        `;
        const queryParams = [orgId, since];

        if (eventTypes && eventTypes.length > 0) {
            query += ` AND action IN (${eventTypes.map(() => '?').join(', ')})`;
            queryParams.push(...eventTypes);
        }

        query += ' ORDER BY created_at DESC LIMIT ?';
        queryParams.push(Math.min(limit, 500));

        const events = prepare(query).all(...queryParams);

        return {
            success: true,
            tool: 'auth_audit',
            data: {
                events,
                count: events.length,
                query: { hours, eventTypes, limit, since }
            }
        };
    },

    /**
     * WARDEN: Get failed login attempts
     */
    'failed_logins': async (params, context) => {
        const { orgId } = context;
        const { hours = 24, limit = 50 } = params;

        const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

        const events = prepare(`
            SELECT id, actor_id, ip_address, created_at, metadata_json
            FROM audit_events
            WHERE org_id = ?
              AND action = 'auth.login_failed'
              AND created_at > ?
            ORDER BY created_at DESC
            LIMIT ?
        `).all(orgId, since, Math.min(limit, 200));

        // Group by IP
        const byIp = {};
        for (const e of events) {
            byIp[e.ip_address] = (byIp[e.ip_address] || 0) + 1;
        }

        return {
            success: true,
            tool: 'failed_logins',
            data: {
                total: events.length,
                byIp,
                events: events.slice(0, 20), // Return first 20 details
                query: { hours, since }
            }
        };
    },

    /**
     * WARDEN: Get active sessions
     */
    'active_sessions': async (params, context) => {
        const { orgId } = context;

        const sessions = prepare(`
            SELECT s.id, s.user_id, s.ip_address, s.user_agent, s.created_at,
                   u.primary_email, u.display_name
            FROM sessions s
            JOIN users u ON s.user_id = u.id
            WHERE s.org_id = ?
              AND s.revoked_at IS NULL
              AND s.expires_at > datetime('now')
            ORDER BY s.created_at DESC
            LIMIT 100
        `).all(orgId);

        return {
            success: true,
            tool: 'active_sessions',
            data: {
                count: sessions.length,
                sessions
            }
        };
    },

    /**
     * VIGIL: Check service health
     * H1 fix: SSRF protection via URL validation
     */
    'health_probe': async (params, context) => {
        const { urls = [], timeout = 5000 } = params;

        const results = [];

        for (const url of urls.slice(0, 10)) { // Max 10 URLs
            // Issue #163 fix: Use comprehensive SSRF validation with DNS resolution
            const validation = await validateUrlForSSRF(url);
            // Issue #167 fix: Corrected property name from 'safe' to 'valid'
            if (!validation.valid) {
                results.push({
                    url,
                    status: 0,
                    ok: false,
                    error: validation.error || 'URL not allowed',
                    latency: 0
                });
                continue;
            }

            const start = Date.now();
            try {
                // Issue #163 fix: Use safeFetch which handles redirects safely
                const response = await safeFetch(url, { method: 'GET' }, timeout);

                results.push({
                    url,
                    status: response.status,
                    ok: response.ok,
                    latency: Date.now() - start
                });
            } catch (err) {
                results.push({
                    url,
                    status: 0,
                    ok: false,
                    error: err.name === 'AbortError' ? 'timeout' : err.message,
                    latency: Date.now() - start
                });
            }
        }

        const healthy = results.filter(r => r.ok).length;

        return {
            success: true,
            tool: 'health_probe',
            data: {
                total: results.length,
                healthy,
                unhealthy: results.length - healthy,
                results
            }
        };
    },

    /**
     * METRICS: Get org statistics
     */
    'org_stats': async (params, context) => {
        const { orgId } = context;

        const userCount = prepare(`
            SELECT COUNT(*) as count FROM org_memberships
            WHERE org_id = ? AND status = 'active'
        `).get(orgId);

        const teamCount = prepare(`
            SELECT COUNT(*) as count FROM teams WHERE org_id = ?
        `).get(orgId);

        const conversationCount = prepare(`
            SELECT COUNT(*) as count FROM conversations
            WHERE org_id = ? AND status = 'active'
        `).get(orgId);

        const messageCount = prepare(`
            SELECT COUNT(*) as count FROM messages WHERE org_id = ?
        `).get(orgId);

        const recentActivity = prepare(`
            SELECT COUNT(*) as count FROM audit_events
            WHERE org_id = ? AND created_at > datetime('now', '-24 hours')
        `).get(orgId);

        return {
            success: true,
            tool: 'org_stats',
            data: {
                users: userCount.count,
                teams: teamCount.count,
                conversations: conversationCount.count,
                messages: messageCount.count,
                activityLast24h: recentActivity.count
            }
        };
    },

    /**
     * DAEDALUS: List Docker containers via bastion SSH
     */
    'docker_list': async (params, context) => {
        const { host = 'docker01', all = false } = params;

        // Issue #163 fix: Validate host parameter to prevent lateral movement
        if (!validateDockerHost(host)) {
            return {
                success: false,
                tool: 'docker_list',
                error: `Invalid host: '${host}' not in allowed docker host list`,
                allowedHosts: [...ALLOWED_DOCKER_HOSTS]
            };
        }

        // Check bastion availability
        const bastionOk = await checkBastionHealth();
        if (!bastionOk) {
            return {
                success: false,
                tool: 'docker_list',
                error: 'QuoxBastion is not available',
                suggestion: 'Ensure bastion service is running on gw-01:9850'
            };
        }

        try {
            const command = all ? 'docker ps -a --format "{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}"'
                                : 'docker ps --format "{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}"';

            const results = await bastionExec([host], command, 30);
            const result = results[0];

            if (!result || result.exit_code !== 0) {
                return {
                    success: false,
                    tool: 'docker_list',
                    error: result?.stderr || 'Command execution failed',
                    host
                };
            }

            // Parse docker ps output
            const containers = result.stdout.trim().split('\n')
                .filter(line => line.trim())
                .map(line => {
                    const [id, name, image, status, ports] = line.split('\t');
                    return { id, name, image, status, ports: ports || '' };
                });

            return {
                success: true,
                tool: 'docker_list',
                data: {
                    host,
                    containers,
                    count: containers.length,
                    showAll: all
                }
            };
        } catch (err) {
            return {
                success: false,
                tool: 'docker_list',
                error: err.message
            };
        }
    },

    /**
     * CIPHER: Ping a host or IP
     * C1 fix: Input validation to prevent command injection
     */
    'ping': async (params, context) => {
        const { target, count = 4, source = 'gw-01' } = params;

        // C1 fix: Validate target to prevent command injection
        if (!target || !validateTarget(target)) {
            return {
                success: false,
                tool: 'ping',
                error: 'Invalid target: must be a valid hostname or IPv4 address'
            };
        }

        // Issue #163 fix: Validate source to prevent lateral movement
        if (!validateSource(source)) {
            return {
                success: false,
                tool: 'ping',
                error: `Invalid source: '${source}' not in allowed bastion source list`,
                allowedSources: [...ALLOWED_BASTION_SOURCES]
            };
        }

        // Check bastion availability
        const bastionOk = await checkBastionHealth();
        if (!bastionOk) {
            return {
                success: false,
                tool: 'ping',
                error: 'QuoxBastion is not available',
                suggestion: 'Ensure bastion service is running on gw-01:9850'
            };
        }

        try {
            // C1 fix: Sanitize count parameter
            const safeCount = Math.min(Math.max(1, parseInt(count, 10) || 4), 10);
            const command = `ping -c ${safeCount} -W 2 ${target}`;
            const results = await bastionExec([source], command, 30);
            const result = results[0];

            if (!result) {
                return {
                    success: false,
                    tool: 'ping',
                    error: 'No response from bastion'
                };
            }

            // Parse ping output
            const output = result.stdout || '';
            const lines = output.split('\n');

            // Extract statistics
            let transmitted = 0, received = 0, lossPercent = 100;
            let minRtt = 0, avgRtt = 0, maxRtt = 0;

            for (const line of lines) {
                // Match: "4 packets transmitted, 4 received, 0% packet loss"
                const statsMatch = line.match(/(\d+) packets transmitted, (\d+) received.*?(\d+(?:\.\d+)?)% packet loss/);
                if (statsMatch) {
                    transmitted = parseInt(statsMatch[1]);
                    received = parseInt(statsMatch[2]);
                    lossPercent = parseFloat(statsMatch[3]);
                }

                // Match: "rtt min/avg/max/mdev = 0.123/0.456/0.789/0.012 ms"
                const rttMatch = line.match(/rtt min\/avg\/max\/mdev = ([\d.]+)\/([\d.]+)\/([\d.]+)/);
                if (rttMatch) {
                    minRtt = parseFloat(rttMatch[1]);
                    avgRtt = parseFloat(rttMatch[2]);
                    maxRtt = parseFloat(rttMatch[3]);
                }
            }

            return {
                success: true,
                tool: 'ping',
                data: {
                    target,
                    source,
                    reachable: received > 0,
                    transmitted,
                    received,
                    lossPercent,
                    rtt: {
                        min: minRtt,
                        avg: avgRtt,
                        max: maxRtt
                    },
                    raw: output
                }
            };
        } catch (err) {
            return {
                success: false,
                tool: 'ping',
                error: err.message
            };
        }
    },

    /**
     * CIPHER: Traceroute to a host
     * C1 fix: Input validation to prevent command injection
     */
    'traceroute': async (params, context) => {
        const { target, maxHops = 15, source = 'gw-01' } = params;

        // C1 fix: Validate target to prevent command injection
        if (!target || !validateTarget(target)) {
            return {
                success: false,
                tool: 'traceroute',
                error: 'Invalid target: must be a valid hostname or IPv4 address'
            };
        }

        // Issue #163 fix: Validate source to prevent lateral movement
        if (!validateSource(source)) {
            return {
                success: false,
                tool: 'traceroute',
                error: `Invalid source: '${source}' not in allowed bastion source list`
            };
        }

        const bastionOk = await checkBastionHealth();
        if (!bastionOk) {
            return {
                success: false,
                tool: 'traceroute',
                error: 'QuoxBastion is not available'
            };
        }

        try {
            // C1 fix: Sanitize maxHops parameter
            const safeMaxHops = Math.min(Math.max(1, parseInt(maxHops, 10) || 15), 30);
            const command = `traceroute -m ${safeMaxHops} -w 2 ${target}`;
            const results = await bastionExec([source], command, 60);
            const result = results[0];

            if (!result) {
                return {
                    success: false,
                    tool: 'traceroute',
                    error: 'No response from bastion'
                };
            }

            // Parse traceroute output
            const lines = result.stdout.trim().split('\n');
            const hops = [];

            for (const line of lines.slice(1)) { // Skip header
                // Match: " 1  gateway (10.0.0.1)  0.123 ms  0.456 ms  0.789 ms"
                const hopMatch = line.match(/^\s*(\d+)\s+(\S+)\s+\(?([\d.]+)\)?\s+([\d.]+)\s*ms/);
                if (hopMatch) {
                    hops.push({
                        hop: parseInt(hopMatch[1]),
                        host: hopMatch[2],
                        ip: hopMatch[3],
                        rtt: parseFloat(hopMatch[4])
                    });
                } else if (line.includes('* * *')) {
                    const hopNum = line.match(/^\s*(\d+)/);
                    if (hopNum) {
                        hops.push({
                            hop: parseInt(hopNum[1]),
                            host: '*',
                            ip: null,
                            rtt: null,
                            timeout: true
                        });
                    }
                }
            }

            return {
                success: true,
                tool: 'traceroute',
                data: {
                    target,
                    source,
                    hops,
                    hopCount: hops.length,
                    reachable: hops.length > 0 && !hops[hops.length - 1]?.timeout,
                    raw: result.stdout
                }
            };
        } catch (err) {
            return {
                success: false,
                tool: 'traceroute',
                error: err.message
            };
        }
    },

    /**
     * CIPHER: DNS lookup
     * C1 fix: Input validation to prevent command injection
     */
    'dns_lookup': async (params, context) => {
        const { domain, type = 'A', source = 'gw-01' } = params;

        // C1 fix: Validate domain to prevent command injection
        if (!domain || !validateDomain(domain)) {
            return {
                success: false,
                tool: 'dns_lookup',
                error: 'Invalid domain: must be a valid domain name'
            };
        }

        // Issue #163 fix: Validate source to prevent lateral movement
        if (!validateSource(source)) {
            return {
                success: false,
                tool: 'dns_lookup',
                error: `Invalid source: '${source}' not in allowed bastion source list`
            };
        }

        const bastionOk = await checkBastionHealth();
        if (!bastionOk) {
            return {
                success: false,
                tool: 'dns_lookup',
                error: 'QuoxBastion is not available'
            };
        }

        try {
            // C1 fix: Whitelist record types
            const recordType = ['A', 'AAAA', 'MX', 'NS', 'TXT', 'CNAME', 'SOA', 'PTR'].includes(type.toUpperCase())
                ? type.toUpperCase() : 'A';

            const command = `dig +short ${domain} ${recordType}`;
            const results = await bastionExec([source], command, 15);
            const result = results[0];

            if (!result) {
                return {
                    success: false,
                    tool: 'dns_lookup',
                    error: 'No response from bastion'
                };
            }

            const records = result.stdout.trim().split('\n').filter(r => r.trim());

            return {
                success: true,
                tool: 'dns_lookup',
                data: {
                    domain,
                    type: recordType,
                    records,
                    count: records.length,
                    resolved: records.length > 0
                }
            };
        } catch (err) {
            return {
                success: false,
                tool: 'dns_lookup',
                error: err.message
            };
        }
    },

    /**
     * CIPHER: Port scan (limited)
     * C1 fix: Input validation to prevent command injection
     */
    'port_check': async (params, context) => {
        const { target, ports = [22, 80, 443], source = 'gw-01' } = params;

        // C1 fix: Validate target to prevent command injection
        if (!target || !validateTarget(target)) {
            return {
                success: false,
                tool: 'port_check',
                error: 'Invalid target: must be a valid hostname or IPv4 address'
            };
        }

        // Issue #163 fix: Validate source to prevent lateral movement
        if (!validateSource(source)) {
            return {
                success: false,
                tool: 'port_check',
                error: `Invalid source: '${source}' not in allowed bastion source list`
            };
        }

        const bastionOk = await checkBastionHealth();
        if (!bastionOk) {
            return {
                success: false,
                tool: 'port_check',
                error: 'QuoxBastion is not available'
            };
        }

        try {
            // Limit to 10 ports for safety
            const portList = (Array.isArray(ports) ? ports : [ports]).slice(0, 10);
            const portResults = [];

            for (const port of portList) {
                // C1 fix: Validate port number
                if (!validatePort(port)) {
                    portResults.push({
                        port: port,
                        status: 'invalid',
                        error: 'Invalid port number'
                    });
                    continue;
                }
                const safePort = parseInt(port, 10);
                const command = `timeout 2 bash -c "echo >/dev/tcp/${target}/${safePort}" 2>/dev/null && echo "open" || echo "closed"`;
                const results = await bastionExec([source], command, 5);
                const result = results[0];

                portResults.push({
                    port: parseInt(port),
                    status: result?.stdout?.trim() === 'open' ? 'open' : 'closed'
                });
            }

            const openPorts = portResults.filter(p => p.status === 'open');

            return {
                success: true,
                tool: 'port_check',
                data: {
                    target,
                    source,
                    ports: portResults,
                    openCount: openPorts.length,
                    closedCount: portResults.length - openPorts.length
                }
            };
        } catch (err) {
            return {
                success: false,
                tool: 'port_check',
                error: err.message
            };
        }
    }
};

/**
 * POST /orgs/:orgId/agent-tools/execute
 * Execute an agent tool
 * C2 fix: Role-based authorization on tool execution
 */
router.post('/orgs/:orgId/agent-tools/execute', requireOrgMembership, async (req, res) => {
    // QUOXTRUST WP3.4 (D4 complete mediation, 2026-09-28) — DISABLED, 410 Gone.
    // This route was a SECOND, independent tool executor with its own
    // bastionExec dispatch, its own role model and its own audit events —
    // reachable entirely outside the collector's reference monitor, durable
    // intent and witnessed receipts (codex plan-challenge B6: an unmediated
    // parallel system, not an architectural boundary). Usage analysis before
    // disabling: ZERO frontend references, ZERO hits in 7 days of auth logs,
    // ZERO consumers in quoxmcp / the CLI / quoxagent. The governed path is
    // the collector's POST /api/v1/tools/execute. The GET listing route below
    // (used by the dashboard tool panels) is untouched. Reverting this block
    // is one commit if a real consumer surfaces — but route it through the
    // collector instead.
    return res.status(410).json({
        error: 'gone',
        message: 'This executor was retired (QuoxTrust WP3.4): it bypassed the platform reference monitor. Execute tools via the collector: POST /api/v1/tools/execute.',
    });
    // eslint-disable-next-line no-unreachable
    try {
        const { orgId } = req.params;
        const { tool, params = {}, agentId } = req.body;
        const userId = req.user.id;

        // Issue #163 hardening: sanitize source/host params at dispatch level
        if (params.source && typeof params.source === 'string') {
            params.source = sanitizeHostParam(params.source);
        }
        if (params.host && typeof params.host === 'string') {
            params.host = sanitizeHostParam(params.host);
        }

        if (!tool) {
            return res.status(400).json({
                error: 'tool_required',
                message: 'Tool name is required'
            });
        }

        const handler = TOOL_HANDLERS[tool];
        if (!handler) {
            return res.status(404).json({
                error: 'tool_not_found',
                message: `Unknown tool: ${tool}`,
                availableTools: Object.keys(TOOL_HANDLERS)
            });
        }

        // C2 fix: Check user role against tool risk level
        const requiredRole = TOOL_RISK_LEVELS[tool] || 'operator';
        const userRole = req.orgMembership?.role || 'viewer';
        if (!hasRole(userRole, requiredRole)) {
            return res.status(403).json({
                error: 'insufficient_permissions',
                message: `Tool '${tool}' requires '${requiredRole}' role or higher`,
                currentRole: userRole,
                requiredRole
            });
        }

        // Execute tool
        const startTime = Date.now();
        const result = await handler(params, {
            orgId,
            userId,
            agentId: agentId || 'direct'
        });
        const duration = Date.now() - startTime;

        // Log tool execution
        createAuditEvent({
            orgId,
            actorType: agentId ? 'agent' : 'user',
            actorId: agentId || userId,
            action: 'tool.execute',
            targetType: 'tool',
            targetId: tool,
            metadata: {
                params: Object.keys(params),
                duration,
                success: result.success
            }
        });

        res.json({
            ...result,
            execution: {
                tool,
                agentId,
                duration,
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('Tool execution error:', error);
        res.status(500).json({
            error: 'execution_failed',
            message: error.message
        });
    }
});

/**
 * GET /orgs/:orgId/agent-tools
 * List available tools
 */
router.get('/orgs/:orgId/agent-tools', requireOrgMembership, async (req, res) => {
    const tools = Object.keys(TOOL_HANDLERS).map(id => ({
        id,
        agent: getToolAgent(id),
        description: getToolDescription(id)
    }));

    res.json({ tools });
});

// Helper: Map tool to primary agent
function getToolAgent(toolId) {
    const mapping = {
        'auth_audit': 'sentinel',
        'failed_logins': 'sentinel',
        'active_sessions': 'sentinel',
        'health_probe': 'beacon',
        'org_stats': 'metrics',
        'docker_list': 'nova',
        'ping': 'cipher',
        'traceroute': 'cipher',
        'dns_lookup': 'cipher',
        'port_check': 'cipher'
    };
    return mapping[toolId] || 'quox';
}

// Helper: Tool descriptions
function getToolDescription(toolId) {
    const descriptions = {
        'auth_audit': 'Query audit events from the security log',
        'failed_logins': 'Get recent failed login attempts with IP analysis',
        'active_sessions': 'List currently active user sessions',
        'health_probe': 'Check health of HTTP endpoints',
        'org_stats': 'Get organization usage statistics',
        'docker_list': 'List Docker containers via SSH',
        'ping': 'Ping a host or IP address',
        'traceroute': 'Trace network path to a destination',
        'dns_lookup': 'Query DNS records for a domain',
        'port_check': 'Check if ports are open on a target'
    };
    return descriptions[toolId] || 'No description';
}

export default router;
