'use strict';
/**
 * Wazuh read tools for ARGUS: wazuh_agents, wazuh_manager_status, wazuh_alerts, wazuh_vulnerabilities.
 * Read-only. Same logic as the collector's GET /api/v1/wazuh/* routes (lib/wazuhReads.js), called
 * in-process. A Wazuh that is not configured or unreachable is success:false with a code, never an
 * empty list.
 */

/**
 * Run one shared Wazuh read (lib/wazuhReads.js) for an agent tool. Maps the route-shaped result to the
 * tool contract: a failure of any kind is success:false with a code and a plain message, an upstream
 * HTTP error from the manager is a failure too, and a count is never reported for a failed read.
 */
async function runWazuhRead(ctx, call, kind) {
  try {
    const orgId = ctx?.orgId;
    if (!orgId) return { success: false, error: 'No organization context' };
    const r = await call(require('./wazuhReads.js'), orgId);
    const b = r.body || {};
    if (r.aee) { try { ctx.emitEnvelope?.({ type: r.aee.type, intent: r.aee.intent, payload: r.aee.payload }); } catch { /* evidence only */ } }
    if (r.status >= 400 || !b.success) {
      const code = b.code || (typeof b.error === 'string' && /^wazuh_/.test(b.error) ? b.error : (b.error ? 'wazuh_unreachable' : 'wazuh_upstream_error'));
      return { success: false, error: code, message: b.message || (typeof b.error === 'string' ? b.error : 'Wazuh read failed') };
    }
    if (kind === 'alerts' || kind === 'vulnerabilities') return { success: true, [kind]: b.data, total: b.total };
    const up = b.data || {};
    if (b.status >= 400 || up.error) {
      return { success: false, error: 'wazuh_upstream_error', message: `Wazuh answered ${b.status}: ${String(up.title || up.detail || 'error').slice(0, 200)}` };
    }
    const items = up.data?.affected_items || [];
    if (kind === 'agents') return { success: true, agents: items.map((a) => ({ id: a.id, name: a.name, ip: a.ip, status: a.status, version: a.version, os: a.os?.name, last_keep_alive: a.lastKeepAlive })), total: up.data?.total_affected_items ?? items.length };
    return { success: true, daemons: items[0] || {}, total: items.length };
  } catch (err) {
    return { success: false, error: 'wazuh_unreachable', message: err.message };
  }
}

const WAZUH_TOOLS = {
  wazuh_agents: {
    name: 'wazuh_agents',
    description: "List the machines enrolled in Wazuh security monitoring and whether each is connected, disconnected or never connected. This is not for deploying or removing a Wazuh agent (that is a separate approved action).",
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'disconnected', 'never_connected', 'pending'], description: 'Optional: only agents in this connection state' },
        limit: { type: 'number', description: 'Max agents (default 500)' }
      },
      required: []
    },
    execute: async (input, ctx) => runWazuhRead(ctx, (reads, orgId) => {
      const query = {};
      if (input?.status) query.status = String(input.status);
      if (input?.limit) query.limit = String(Math.min(Math.max(parseInt(input.limit, 10) || 500, 1), 1000));
      return reads.listAgents(orgId, query);
    }, 'agents')
  },

  wazuh_manager_status: {
    name: 'wazuh_manager_status',
    description: "Report whether the Wazuh manager is healthy: the running state of each manager daemon (analysisd, remoted, apid and the rest).",
    input_schema: { type: 'object', properties: {}, required: [] },
    execute: async (input, ctx) => runWazuhRead(ctx, (reads, orgId) => reads.managerStatus(orgId), 'manager_status')
  },

  wazuh_alerts: {
    name: 'wazuh_alerts',
    description: "Recent Wazuh security alerts, newest first, optionally only those at or above a rule level (level 12 and up is high severity).",
    input_schema: {
      type: 'object',
      properties: {
        min_level: { type: 'number', description: 'Only alerts with rule level at or above this (1-15; 12 is high severity)' },
        q: { type: 'string', description: 'Optional text to match in rule description, agent name or rule groups' },
        limit: { type: 'number', description: 'Max alerts (default 50, capped at 500)' }
      },
      required: []
    },
    execute: async (input, ctx) => runWazuhRead(ctx, (reads, orgId) => reads.listAlerts(orgId, {
      limit: input?.limit, q: input?.q, min_level: input?.min_level
    }), 'alerts')
  },

  wazuh_vulnerabilities: {
    name: 'wazuh_vulnerabilities',
    description: "Vulnerabilities Wazuh knows about on the monitored hosts, highest score first, optionally filtered by severity (Critical, High, Medium, Low) or by host.",
    input_schema: {
      type: 'object',
      properties: {
        severity: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low'], description: 'Optional severity filter' },
        agent_name: { type: 'string', description: 'Optional: only this Wazuh agent (host) name' },
        limit: { type: 'number', description: 'Max results (default 100, capped at 1000)' }
      },
      required: []
    },
    execute: async (input, ctx) => runWazuhRead(ctx, (reads, orgId) => reads.listVulnerabilities(orgId, {
      severity: input?.severity, agent_name: input?.agent_name, limit: input?.limit
    }), 'vulnerabilities')
  }
};

module.exports = { WAZUH_TOOLS, runWazuhRead };
