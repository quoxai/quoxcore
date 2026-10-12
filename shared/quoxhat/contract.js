/**
 * QUOXHAT P1 — hat definition contract, shared by the auth store, the
 * collector (P2 resolution) and the dashboard surfaces, mirroring the
 * shared/llm-routing layout so no consumer re-derives the schema.
 *
 * A hat definition is the versioned document stored in
 * quoxhat_revisions.definition_json. P1 validates structure and budgets;
 * membership validation against the live server tool/agent registry is a
 * P2 concern (QUOXHAT_STUDY.md §4: never treat frontend arrays as grants).
 */

export const QUOXHAT_SCHEMA_VERSION = 1

// The whole point of a hat: its working manifest must fit EVERY certified
// provider. 128 is the tested OpenAI Chat Completions ceiling (see
// services/collector/lib/toolRetrievalCap.js OPENAI_TOOL_CAP); a hat that
// cannot fit the tightest provider cannot promise provider-agnostic failover.
export const HAT_HARD_MANIFEST_CAP = 128

// Proposed product quality budgets (study §2) — warnings, not errors.
export const HAT_RECOMMENDED_INITIAL_TARGET = 12
export const HAT_RECOMMENDED_MAX_MANIFEST = 32

export const SELECTION_MODES = ['manual', 'automatic', 'hybrid']
export const TRANSITION_CONFIRM = ['none', 'user', 'approver']

function isStringArray(v) {
  return Array.isArray(v) && v.every(x => typeof x === 'string' && x.length > 0)
}

/**
 * Validate a hat definition document.
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validateHatDefinition(def) {
  const errors = []
  const warnings = []

  if (!def || typeof def !== 'object') {
    return { valid: false, errors: ['definition must be an object'], warnings }
  }
  if (def.schema_version !== QUOXHAT_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${QUOXHAT_SCHEMA_VERSION}`)
  }
  if (typeof def.purpose !== 'string' || def.purpose.trim().length === 0) {
    errors.push('purpose is required (one line, human-readable)')
  }

  const agents = def.agents
  if (!agents || typeof agents !== 'object') {
    errors.push('agents object is required')
  } else {
    if (typeof agents.orchestrator !== 'string' || !agents.orchestrator) {
      errors.push('agents.orchestrator is required')
    }
    if (agents.specialists !== undefined && !isStringArray(agents.specialists)) {
      errors.push('agents.specialists must be an array of agent ids')
    }
  }

  const tools = def.tools
  if (!tools || typeof tools !== 'object') {
    errors.push('tools object is required')
  } else {
    if (tools.explicit !== undefined && !isStringArray(tools.explicit)) {
      errors.push('tools.explicit must be an array of tool names')
    }
    if (tools.connector_families !== undefined && !isStringArray(tools.connector_families)) {
      errors.push('tools.connector_families must be an array of connector family ids')
    }
    if (tools.bundles !== undefined) {
      if (!Array.isArray(tools.bundles)) {
        errors.push('tools.bundles must be an array')
      } else {
        tools.bundles.forEach((b, i) => {
          if (!b || typeof b !== 'object' || typeof b.key !== 'string' || !b.key) {
            errors.push(`tools.bundles[${i}].key is required`)
          }
          if (b && b.tools !== undefined && !isStringArray(b.tools)) {
            errors.push(`tools.bundles[${i}].tools must be an array of tool names`)
          }
        })
      }
    }
  }

  const budgets = def.budgets
  if (!budgets || typeof budgets !== 'object') {
    errors.push('budgets object is required')
  } else {
    const init = budgets.initial_tool_target
    const max = budgets.max_manifest
    if (!Number.isInteger(init) || init < 1) {
      errors.push('budgets.initial_tool_target must be a positive integer')
    }
    if (!Number.isInteger(max) || max < 1) {
      errors.push('budgets.max_manifest must be a positive integer')
    } else if (max > HAT_HARD_MANIFEST_CAP) {
      errors.push(`budgets.max_manifest must be <= ${HAT_HARD_MANIFEST_CAP} (a hat must fit every certified provider)`)
    } else if (max > HAT_RECOMMENDED_MAX_MANIFEST) {
      warnings.push(`budgets.max_manifest ${max} exceeds the recommended ${HAT_RECOMMENDED_MAX_MANIFEST}`)
    }
    if (Number.isInteger(init) && Number.isInteger(max) && init > max) {
      errors.push('budgets.initial_tool_target cannot exceed budgets.max_manifest')
    }
  }

  if (def.selection !== undefined) {
    if (!def.selection || typeof def.selection !== 'object' || !SELECTION_MODES.includes(def.selection.mode)) {
      errors.push(`selection.mode must be one of ${SELECTION_MODES.join(', ')}`)
    }
  }

  // QUOXHAT #657 P-E — authorization mode rule (optional, backward-compatible:
  // an absent authz block = the declared permissive-over-grant migration
  // posture; see hatManifest.computeAuthzSet). This is the J2 AUTHORIZATION
  // policy, distinct from tools.explicit (the J1 presentation profile): a
  // restrictive mode NARROWS the agent's grant ceiling, it never adds to it.
  const authz = def.authz
  if (authz !== undefined) {
    if (!authz || typeof authz !== 'object') {
      errors.push('authz must be an object')
    } else {
      if (authz.mode !== undefined && !['permissive', 'restrictive'].includes(authz.mode)) {
        errors.push("authz.mode must be 'permissive' or 'restrictive'")
      }
      if (authz.allow !== undefined && !isStringArray(authz.allow)) {
        errors.push('authz.allow must be an array of tool names')
      }
      if (authz.deny !== undefined && !isStringArray(authz.deny)) {
        errors.push('authz.deny must be an array of tool names')
      }
      // An allow list only ever INTERSECTS the grant (computeAuthzSet), so a
      // name here that the agent was never granted is inert, not an escalation;
      // we warn rather than error to keep templates forgiving.
      if (authz.mode === 'restrictive' && authz.allow === undefined && authz.deny === undefined) {
        warnings.push('authz.mode=restrictive with no allow/deny list authorizes the whole grant (same as permissive) — did you mean to list allowed tools?')
      }
    }
  }

  const transitions = def.transitions
  if (transitions !== undefined) {
    if (!transitions || typeof transitions !== 'object') {
      errors.push('transitions must be an object')
    } else {
      if (transitions.allowed !== undefined && transitions.allowed !== 'any' && !isStringArray(transitions.allowed)) {
        errors.push("transitions.allowed must be 'any' or an array of hat keys")
      }
      if (transitions.confirm !== undefined && !TRANSITION_CONFIRM.includes(transitions.confirm)) {
        errors.push(`transitions.confirm must be one of ${TRANSITION_CONFIRM.join(', ')}`)
      }
      if (transitions.privileged !== undefined && typeof transitions.privileged !== 'boolean') {
        errors.push('transitions.privileged must be a boolean')
      }
      // A privileged hat with no confirmation is a policy hole, not a preference.
      if (transitions.privileged === true && (transitions.confirm === 'none' || transitions.confirm === undefined)) {
        errors.push("a privileged hat requires transitions.confirm 'user' or 'approver'")
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

/**
 * Canonical JSON for digesting: stable key order, no whitespace variance.
 * Digest stability across node versions matters because the digest is what
 * WARD will eventually witness (P5) — it must never depend on insertion order.
 */
export function canonicalizeHatDefinition(def) {
  const sortValue = (v) => {
    if (Array.isArray(v)) return v.map(sortValue)
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortValue(v[k])]))
    }
    return v
  }
  return JSON.stringify(sortValue(def))
}
