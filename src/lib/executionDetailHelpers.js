/**
 * executionDetailHelpers — pure helper functions for ExecutionDetailView P6.D
 *
 * All functions are side-effect-free so they are easy to unit-test.
 *
 * STUDY-REV-2 P6.D
 */

// ─── AOCL clustering ────────────────────────────────────────────────────────

/**
 * AOCL intent prefixes that belong in the L1/L3/L8 cluster.
 *
 * The engine emits envelopes with intent aocl.layer.* and aocl.run.*,
 * with payload.layer set to 'L1', 'L3', or 'L8' (the three active
 * enforcement layers in aoclEnforcer.js).  We cluster ALL aocl.* envelopes
 * rather than only L1/L3/L8 payloads — the build doc says "L1/L3/L8
 * envelope cluster" but in practice aocl.run.start/complete/error bookend
 * the layer events and belong in the same disclosure group.
 */
export const AOCL_INTENT_PREFIX = 'aocl.'

/**
 * Return true if an envelope belongs in the AOCL cluster.
 *
 * @param {object} envelope
 * @returns {boolean}
 */
export function isAoclEnvelope(envelope) {
  const intent = envelope?.intent || ''
  return intent.startsWith(AOCL_INTENT_PREFIX)
}

/**
 * Split a flat envelope array into two arrays:
 *   - aoclEnvelopes:  all envelopes whose intent starts with 'aocl.'
 *   - otherEnvelopes: the remainder
 *
 * @param {object[]} envelopes
 * @returns {{ aoclEnvelopes: object[], otherEnvelopes: object[] }}
 */
export function clusterAoclEnvelopes(envelopes) {
  if (!Array.isArray(envelopes)) return { aoclEnvelopes: [], otherEnvelopes: [] }

  const aoclEnvelopes = []
  const otherEnvelopes = []

  for (const env of envelopes) {
    if (isAoclEnvelope(env)) {
      aoclEnvelopes.push(env)
    } else {
      otherEnvelopes.push(env)
    }
  }

  return { aoclEnvelopes, otherEnvelopes }
}

// ─── Evidence grouping ───────────────────────────────────────────────────────

/**
 * Group a flat array of evidence records by nodeId.
 *
 * Each evidence row is expected to have a `nodeId` field (or `node_id`
 * for snake_case APIs).  Records without a nodeId are grouped under the
 * sentinel key '__global__'.
 *
 * @param {object[]} evidenceRows  - Array from listQuoxflowEvidence().data
 * @returns {Map<string, object[]>} - Map<nodeId, evidenceRow[]>
 */
export function groupEvidenceByNode(evidenceRows) {
  const map = new Map()

  if (!Array.isArray(evidenceRows)) return map

  for (const row of evidenceRows) {
    const nodeId = row.nodeId || row.node_id || '__global__'
    if (!map.has(nodeId)) map.set(nodeId, [])
    map.get(nodeId).push(row)
  }

  return map
}

// ─── Tool I/O extraction ─────────────────────────────────────────────────────

/**
 * Extract an input preview string from a quox.flow.node.started envelope.
 *
 * Checks payload.input_preview first (the engine's explicit truncated field),
 * then falls back to JSON-stringifying payload.input if present.
 * Returns null when no input data is available.
 *
 * @param {object} envelope
 * @param {number} [maxLen=300]
 * @returns {string|null}
 */
export function extractInputPreview(envelope, maxLen = 300) {
  if (!envelope?.payload) return null

  const raw = envelope.payload.input_preview
    ?? (envelope.payload.input !== undefined
      ? safeStringify(envelope.payload.input)
      : null)

  if (raw === null || raw === undefined) return null

  const str = String(raw)
  return str.length > maxLen ? str.slice(0, maxLen) + '…' : str
}

/**
 * Extract an output preview string from a quox.flow.node.completed envelope.
 *
 * Checks payload.output_preview first, then falls back to
 * JSON-stringifying payload.output if present.
 * Returns null when no output data is available.
 *
 * @param {object} envelope
 * @param {number} [maxLen=300]
 * @returns {string|null}
 */
export function extractOutputPreview(envelope, maxLen = 300) {
  if (!envelope?.payload) return null

  const raw = envelope.payload.output_preview
    ?? (envelope.payload.output !== undefined
      ? safeStringify(envelope.payload.output)
      : null)

  if (raw === null || raw === undefined) return null

  const str = String(raw)
  return str.length > maxLen ? str.slice(0, maxLen) + '…' : str
}

// ─── Observation formatting ──────────────────────────────────────────────────

/**
 * Format a single observation row into a display-friendly object.
 *
 * @param {object} obs  Raw observation from listObservations()
 * @returns {{ id, ts, nodeId, type, summary, contentRef }}
 */
export function formatObservation(obs) {
  if (!obs) return null

  const summary = obs.summary || obs.content_summary || obs.description || ''
  const truncated = summary.length > 200 ? summary.slice(0, 200) + '…' : summary

  return {
    id: obs.id,
    ts: obs.ts || obs.timestamp || obs.created_at,
    nodeId: obs.nodeId || obs.node_id,
    type: obs.type || obs.observation_type || 'observation',
    summary: truncated,
    contentRef: obs.contentRef || obs.content_ref || obs.evidence_id || null,
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function safeStringify(val) {
  try {
    return JSON.stringify(val, null, 2)
  } catch {
    return String(val)
  }
}
