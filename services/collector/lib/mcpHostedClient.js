'use strict';

/**
 * POWERS-P2.B: Collector-side client for mcp_hosted tools.
 * Mirrors mcpEndpointClient.js shape but talks HTTP to powers-host
 * instead of directly to an upstream MCP endpoint.
 *
 * Powers-host at POWERS_HOST_URL handles container spawn, stdio, and JSON-RPC.
 */

const DEFAULT_TIMEOUT_MS = 35_000; // Slightly more than powers-host's 30s timeout

function getPowersHostUrl() {
  return process.env.POWERS_HOST_URL || 'http://powers-host:9849';
}

/**
 * Invoke an MCP tool on a hosted (container-managed) MCP process.
 *
 * @param {string} toolId      - powers_hosted.tool_id
 * @param {string} toolName    - MCP tool name (e.g. 'read_file')
 * @param {object} args        - Tool arguments
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ ok: boolean, result?: object, error?: string }>}
 */
async function invokeMcpHostedTool(toolId, toolName, args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = `${getPowersHostUrl()}/internal/mcp-hosted/${encodeURIComponent(toolId)}/invoke`;

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: toolName, args: args || {} }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, error: `transport: ${e.message}` };
  }

  let data;
  try {
    data = await resp.json();
  } catch (_) {
    return { ok: false, error: 'invalid_json_response' };
  }

  if (!resp.ok) {
    const errCode = data?.error || `http_${resp.status}`;
    const detail = data?.detail || '';
    return { ok: false, error: detail ? `${errCode}: ${detail}` : errCode };
  }

  return { ok: true, result: data.result };
}

module.exports = { invokeMcpHostedTool };
