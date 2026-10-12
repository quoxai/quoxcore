/**
 * Tool Correlation — resolve correlation ID for tool execution
 *
 * Priority:
 * 1. X-Quox-Correlation header (from CLI or upstream service)
 * 2. session_id from request body (from dashboard)
 * 3. Generated TOOL_ ID (fallback)
 *
 * Created: CLI-3e (Stream CLI Phase 3)
 */

/**
 * Resolve the correlation ID for a tool execution request.
 * @param {Object} req - Express request
 * @param {Object} body - Request body (may contain session_id)
 * @returns {string} Correlation ID
 */
function resolveCorrelationId(req, body) {
  // 1. CLI/upstream correlation header
  const header = (req.headers['x-quox-correlation'] || '').trim();
  if (header) return header;

  // 2. Dashboard session ID
  if (body.session_id) return body.session_id;

  // 3. Generate fallback
  return `TOOL_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = { resolveCorrelationId };
