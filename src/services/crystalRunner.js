/**
 * crystalRunner — STUDY-REV-2 P10.I-5
 *
 * Thin service layer for one-off Crystal execution ("Run now").
 *
 * Calls the existing QuoxFlow workflow execute endpoint using the Crystal's
 * sourceWorkflowId. Returns { executionId } so the caller can navigate to
 * /executions/:id where the canvas overlay lights up live.
 *
 * Data flow:
 *   runCrystal() → POST /quoxflow/api/workflows/:sourceWorkflowId/execute
 *               → { executionId }
 *               → caller navigates to /executions/:id
 *
 * Multi-tenant convention: org_id read from localStorage('current_org_id').
 * Tests pass orgId explicitly to avoid localStorage dependency.
 */

// ─── QuoxFlow API base (mirrors quoxflowClient.js) ───────────────────────────
const QUOXFLOW_API_BASE =
  typeof import.meta !== 'undefined' && import.meta.env?.VITE_QUOXFLOW_API_URL
    ? import.meta.env.VITE_QUOXFLOW_API_URL
    : '/quoxflow/api'

/**
 * Read the current org_id from localStorage (non-fatal if unavailable).
 * @returns {string|null}
 */
function getOrgId() {
  try {
    return localStorage.getItem('current_org_id') || null
  } catch {
    return null
  }
}

/**
 * Run a Crystal immediately (one-off execution).
 *
 * @param {object} opts
 * @param {Function} opts.authFetch     — authenticated fetch from AuthContext
 * @param {string}  opts.crystalId     — Crystal record id (for correlation)
 * @param {string}  opts.sourceWorkflowId — the underlying workflow to execute
 * @param {string}  [opts.orgId]       — override org_id (tests use this)
 * @returns {Promise<{ executionId: string }>}
 * @throws {Error} friendly message on 4xx/5xx
 */
export async function runCrystal({ authFetch, crystalId, sourceWorkflowId, orgId } = {}) {
  if (!authFetch) throw new Error('authFetch is required')
  if (!sourceWorkflowId) throw new Error('sourceWorkflowId is required')

  const resolvedOrgId = orgId ?? getOrgId()
  const url = `${QUOXFLOW_API_BASE}/workflows/${sourceWorkflowId}/execute`

  const body = {
    triggerData: { crystalId },
    async: true,
    ...(resolvedOrgId ? { orgId: resolvedOrgId } : {}),
  }

  const response = await authFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  let data = null
  try {
    data = await response.json()
  } catch {
    /* ignore parse error — fall through to error check */
  }

  if (!response.ok) {
    const msg =
      data?.error?.message ||
      data?.message ||
      `Crystal run failed: HTTP ${response.status}`
    throw new Error(msg)
  }

  const executionId =
    data?.data?.executionId ||
    data?.executionId ||
    data?.data?.stored?.id

  return { executionId }
}

export default runCrystal
