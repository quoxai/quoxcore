/**
 * QSKL-12 Slice 3 — Collector: internal personas handler
 *
 * Handles GET /api/internal/personas/:agent_id
 *
 * Returns:
 *   200 { agent_id, content: string | null }
 *   400 { error: 'invalid_agent_id' }  — when agent_id fails validation
 *
 * No auth required — /api/internal/* is service-to-service only (per existing
 * convention: see /api/internal/enrichment, /api/internal/fleet-snapshot etc.
 * which have no requireServiceOrUserAuth middleware).
 *
 * Defence: agent_id validated to [a-z0-9_-]+ before any filesystem access,
 * preventing path traversal. readPersona is called fresh on every request
 * (no module-level cache — callers manage caching per their own turn lifecycle).
 */

const { readPersona } = require('./personaReader');

/** Regex for safe agent IDs: lowercase alphanumeric, hyphens, underscores only. */
const VALID_AGENT_ID_RE = /^[a-z0-9_-]+$/;

/**
 * Validate that an agent_id is safe to use as a filename component.
 * Rejects empty strings, uppercase letters, dots, slashes, and any other
 * characters outside [a-z0-9_-].
 *
 * @param {string} agentId
 * @returns {boolean}
 */
function isValidAgentId(agentId) {
  if (!agentId || typeof agentId !== 'string') return false;
  return VALID_AGENT_ID_RE.test(agentId);
}

/**
 * Express route handler for GET /api/internal/personas/:agent_id
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function handlePersonasGet(req, res) {
  const { agent_id } = req.params;

  if (!isValidAgentId(agent_id)) {
    return res.status(400).json({ error: 'invalid_agent_id' });
  }

  const content = await readPersona(agent_id);
  return res.json({ agent_id, content });
}

module.exports = { handlePersonasGet, isValidAgentId };
