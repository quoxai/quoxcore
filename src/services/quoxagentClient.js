/**
 * QuoxAgent Client - API client for QuoxAgent (Quox Helper Agent) operations
 * Integrated with AEE (Agent Envelope Exchange) for full audit trail
 */

import {
  createQuoxAgentJob,
  createQuoxAgentJobResult,
  createHeartbeat,
  createEvent,
  createError,
  storeEnvelope,
  QuoxAgent_INTENTS
} from '../lib/aee'
import { safeJsonParse } from './apiUtils.js'

const COLLECTOR_URL = '/collector';

/**
 * Check if a host has QuoxAgent installed
 * @param {string} hostId - The host identifier
 * @returns {Promise<{installed: boolean, running: boolean, version?: string}>}
 */
export async function checkQuoxAgentStatus(hostId) {
  try {
    const res = await fetch(`${COLLECTOR_URL}/api/v1/check/${hostId}`);
    if (!res.ok) {
      const errorMsg = res.status === 404
        ? `Host "${hostId}" not found`
        : `API error (${res.status})`
      return { installed: false, running: false, error: errorMsg };
    }
    return await safeJsonParse(res, {
      fallback: { installed: false, running: false, error: 'Invalid response' }
    });
  } catch (err) {
    console.error(`[QuoxAgent] Failed to check status for ${hostId}:`, err);
    return { installed: false, running: false, error: err.message };
  }
}

/**
 * Check QuoxAgent status for multiple hosts
 * @param {string[]} hostIds - Array of host identifiers
 * @returns {Promise<Map<string, {installed: boolean, running: boolean}>>}
 */
export async function checkQuoxAgentStatusBatch(hostIds) {
  const results = new Map();

  // Check in parallel
  await Promise.all(
    hostIds.map(async (hostId) => {
      const status = await checkQuoxAgentStatus(hostId);
      results.set(hostId, status);
    })
  );

  return results;
}

/**
 * Get hosts that don't have QuoxAgent installed
 * @param {string[]} hostIds - Array of host identifiers
 * @returns {Promise<{hostname: string, status: string}[]>}
 */
export async function getHostsWithoutQuoxAgent(hostIds) {
  const statuses = await checkQuoxAgentStatusBatch(hostIds);
  const hostsWithoutQuoxAgent = [];

  for (const [hostname, status] of statuses) {
    if (!status.installed) {
      hostsWithoutQuoxAgent.push({
        hostname,
        status: status.error || 'Not installed'
      });
    } else if (!status.running) {
      hostsWithoutQuoxAgent.push({
        hostname,
        status: 'Installed but not running'
      });
    }
  }

  return hostsWithoutQuoxAgent;
}

/**
 * Install QuoxAgent on hosts via collector API
 * @param {string[]} hostnames - Array of hostnames to install on
 * @returns {Promise<{hostname: string, success: boolean, error?: string}[]>}
 */
export async function installQuoxAgent(hostnames) {
  try {
    const res = await fetch('/collector/api/v1/quoxagent/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hosts: hostnames })
    });

    if (!res.ok) {
      throw new Error(`Installation request failed: ${res.status}`);
    }

    const data = await res.json();
    return data.results || hostnames.map(h => ({ hostname: h, success: false, error: 'Unknown' }));
  } catch (err) {
    console.error('[QuoxAgent] Installation failed:', err);
    return hostnames.map(h => ({ hostname: h, success: false, error: err.message }));
  }
}

/**
 * Get all connected QuoxAgent agents
 * @returns {Promise<{count: number, agents: any[]}>}
 */
export async function getAgents() {
  try {
    const res = await fetch(`${COLLECTOR_URL}/api/v1/agents`);
    if (!res.ok) {
      throw new Error(`API error: ${res.status}`);
    }
    return await safeJsonParse(res, {
      fallback: { count: 0, agents: [] }
    });
  } catch (err) {
    console.error('[QuoxAgent] Failed to get agents:', err);
    return { count: 0, agents: [] };
  }
}

/**
 * Get fleet summary
 * @returns {Promise<object>}
 */
export async function getFleetSummary() {
  try {
    const res = await fetch(`${COLLECTOR_URL}/api/v1/fleet/summary`);
    if (!res.ok) {
      throw new Error(`API error: ${res.status}`);
    }
    return await safeJsonParse(res, { fallback: null });
  } catch (err) {
    console.error('[QuoxAgent] Failed to get fleet summary:', err);
    return null;
  }
}

/**
 * Execute a command on a host via QuoxAgent
 * Wraps the operation in AEE envelopes for full audit trail
 *
 * @param {string} hostId - Target host
 * @param {string} command - Command to execute
 * @param {Object} [options]
 * @param {number} [options.timeout] - Timeout in ms (default 30000)
 * @param {string} [options.user] - User identifier
 * @param {string} [options.corr] - Correlation ID for conversation linking
 * @returns {Promise<{success: boolean, output?: string, exit_code?: number, envelope?: object}>}
 */
export async function executeCommand(hostId, command, options = {}) {
  const { timeout = 30000, user = 'human.user', corr } = options

  // Create AEE job envelope
  const jobEnvelope = createQuoxAgentJob(hostId, command, { timeout, user, corr })

  try {
    // Store the job submission envelope
    await storeEnvelope(jobEnvelope)

    // Execute via QuoxAgent agent API
    const res = await fetch(`/quoxagent-agent/api/v1/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command,
        timeout,
        aee_id: jobEnvelope.id,
        aee_corr: jobEnvelope.corr
      })
    })

    if (!res.ok) {
      throw new Error(`QuoxAgent API error: ${res.status}`)
    }

    const result = await safeJsonParse(res, {
      fallback: { output: '', exit_code: -1, error: 'Invalid response' }
    })

    // Create and store result envelope
    const resultEnvelope = createQuoxAgentJobResult(jobEnvelope, {
      output: result.output || '',
      exit_code: result.exit_code || 0,
      duration_ms: result.duration_ms || 0
    })
    await storeEnvelope(resultEnvelope)

    return {
      success: result.exit_code === 0,
      output: result.output,
      exit_code: result.exit_code,
      duration_ms: result.duration_ms,
      envelope: resultEnvelope
    }
  } catch (err) {
    console.error(`[QuoxAgent] Command execution failed on ${hostId}:`, err)

    // Create and store error envelope
    const errorEnvelope = createError(jobEnvelope, {
      code: 'EXECUTION_FAILED',
      message: err.message,
      details: { host: hostId, command }
    })
    await storeEnvelope(errorEnvelope)

    return {
      success: false,
      error: err.message,
      envelope: errorEnvelope
    }
  }
}

/**
 * Process and store an incoming heartbeat as AEE event
 * @param {Object} heartbeat - Raw heartbeat data from QuoxAgent agent
 * @returns {Promise<Object>} - The stored AEE envelope
 */
export async function processHeartbeat(heartbeat) {
  const hostId = heartbeat.host_id || heartbeat.hostname || 'unknown'

  const envelope = createHeartbeat(hostId, {
    status: heartbeat.status || { health: 'unknown' },
    resources: heartbeat.resources || {},
    agent: heartbeat.agent || {}
  })

  await storeEnvelope(envelope)
  return envelope
}

/**
 * Store an QuoxAgent install event as AEE envelope
 * @param {string[]} hostnames - Hosts being installed
 * @param {string} [corr] - Correlation ID
 * @returns {Promise<Object>} - The stored AEE envelope
 */
export async function logInstallRequest(hostnames, corr) {
  const envelope = createEvent(
    'human.user',
    QuoxAgent_INTENTS.INSTALL,
    {
      hosts: hostnames,
      requested_at: new Date().toISOString()
    },
    corr
  )

  await storeEnvelope(envelope)
  return envelope
}

export default {
  checkQuoxAgentStatus,
  checkQuoxAgentStatusBatch,
  getHostsWithoutQuoxAgent,
  installQuoxAgent,
  getAgents,
  getFleetSummary,
  executeCommand,
  processHeartbeat,
  logInstallRequest
};
