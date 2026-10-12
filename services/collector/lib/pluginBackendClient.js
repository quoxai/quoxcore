'use strict';

/**
 * RES.5 (plan/19): collector-side client for powers-host's plugin-backend
 * lifecycle (/internal/plugin-backend/*). Mirrors mcpHostedClient.js. Used by
 * the collector's /backend/ensure + /backend/stop admin routes to start/stop a
 * third-party plugin's HTTP backend container from its manifest.backend.
 */

const DEFAULT_TIMEOUT_MS = 70_000; // powers-host waits up to 60s for health

function getPowersHostUrl() {
  return process.env.POWERS_HOST_URL || 'http://powers-host:9849';
}

async function startPluginBackend(pluginId, { image, port, healthPath, env } = {}) {
  const url = `${getPowersHostUrl()}/internal/plugin-backend/${encodeURIComponent(pluginId)}/start`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image, port, healthPath, env }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(body.detail || body.error || `powers-host ${resp.status}`);
  return body; // { ok, url, containerId, healthy }
}

async function stopPluginBackend(pluginId, { removeData = false } = {}) {
  const url = `${getPowersHostUrl()}/internal/plugin-backend/${encodeURIComponent(pluginId)}/stop`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ removeData }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(body.detail || body.error || `powers-host ${resp.status}`);
  return body;
}

module.exports = { startPluginBackend, stopPluginBackend };
