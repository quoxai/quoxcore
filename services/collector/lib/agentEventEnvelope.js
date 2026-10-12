/**
 * agentEventEnvelope.js — envelope construction for the Agent Stream bridge.
 *
 * Extracted from server.js emitAgentEvent/emitAgentSession (quox#439,
 * AEE-ORG-BACKFILL P6) so the construction is unit-testable in isolation,
 * the same precedent as lib/aeeOrgScoping.js. Both #439 bugs lived here:
 *
 *  1. Untagged: the envelope carried no org anywhere, so every agent-stream
 *     row was stored org_id NULL and, since the P2 read-scope close, was
 *     invisible to the org that owns the session. The rule (triage's, on the
 *     issue): tag when the row describes org-owned activity; leave untagged
 *     only when it genuinely precedes or sits outside any org. NULL rather
 *     than an invented org, consistent with #438's signup decision.
 *  2. 'unknown' identity: the old line defaulted the agent name away instead
 *     of using what call sites could supply. Call sites now pass identity;
 *     the fallback remains for a caller that truly has none.
 */

'use strict';

/** Same sentinel guard as scripts/backfill-aee-org.js: a tag is only worth
 * writing if it names a real tenant. */
const SENTINEL_ORGS = new Set(['default', '__default__', 'system', 'null', 'undefined']);
function realOrg(org) {
  if (typeof org !== 'string') return null;
  const v = org.trim();
  if (!v || SENTINEL_ORGS.has(v.toLowerCase())) return null;
  return v;
}

const EVENT_TYPE_TO_INTENT = {
  'activity.message':     'quox.agent.message',
  'activity.thinking':    'quox.agent.thinking',
  'activity.tool_call':   'quox.agent.tool_call',
  'activity.tool_result': 'quox.agent.tool_result',
  'activity.file_change': 'quox.agent.file_change',
  'activity.code_exec':   'quox.agent.code_exec',
  'session.start':        'quox.agent.session_start',
  'session.end':          'quox.agent.session_end',
  'session.status':       'quox.agent.session_status',
  'output.stdout':        'quox.agent.output',
  'output.stderr':        'quox.agent.error_output',
  'metrics.tokens':       'quox.agent.token_usage',
  'metrics.cost':         'quox.agent.cost_update',
};

/**
 * Build the AEE envelope for an agent-stream activity event.
 * @param {object} event - { session_id, type, org_id?, agent_name?, host_id?, summary?, data? }
 * @returns {object} envelope for storeAuditEnvelope()
 */
function buildAgentEventEnvelope(event) {
  const intent = EVENT_TYPE_TO_INTENT[event.type] || `quox.agent.${event.type || 'event'}`;
  const agentName = event.agent_name || event.data?.agent || 'unknown';
  const orgId = realOrg(event.org_id);
  return {
    type: 'event',
    from: `agent.${agentName}`,
    to: 'audit.agent_stream',
    intent,
    corr: event.session_id || `STREAM_${Date.now()}`,
    ...(orgId ? { org_id: orgId } : {}),
    payload: {
      event_type: event.type,
      session_id: event.session_id,
      host_id: event.host_id,
      agent_name: agentName,
      summary: event.summary,
      ...(event.data || {}),
    },
  };
}

/**
 * Build the AEE envelope for a session lifecycle record.
 * @param {object} session - { id, agent_type, agent_name?, org_id?, provider?, model?, host_id?, user?, status? }
 * @returns {object} envelope for storeAuditEnvelope()
 */
function buildAgentSessionEnvelope(session) {
  const orgId = realOrg(session.org_id);
  return {
    type: 'event',
    from: 'system.collector',
    to: 'audit.agent_stream',
    intent: 'quox.session.started',
    corr: session.id || `SESSION_${Date.now()}`,
    ...(orgId ? { org_id: orgId } : {}),
    payload: {
      session_id: session.id,
      session_type: session.agent_type,
      agent_name: session.agent_name,
      provider: session.provider,
      model: session.model,
      host_id: session.host_id,
      user: session.user,
      status: session.status,
    },
  };
}

module.exports = { buildAgentEventEnvelope, buildAgentSessionEnvelope };
