export const DEFAULT_LLM_POLICY = {
  mode: 'recommendation',
  lockScope: 'none',
  reason: null,
  note: null,
};

const HARD_LOCKED_ENTITY_POLICIES = {
  imagesq: {
    mode: 'locked',
    lockScope: 'hard',
    reason: 'specialist_capability',
    note: 'Image generation requires an image-capable model path.',
  },
};

export function normalizeLlmPolicy(policy = null, context = {}) {
  const entityPolicy = context.entityId ? HARD_LOCKED_ENTITY_POLICIES[context.entityId] : null;
  const next = {
    ...DEFAULT_LLM_POLICY,
    ...(entityPolicy || {}),
    ...(policy || {}),
  };

  if (next.mode !== 'locked') {
    return { ...DEFAULT_LLM_POLICY, mode: 'recommendation' };
  }

  return {
    ...DEFAULT_LLM_POLICY,
    ...next,
    mode: 'locked',
    lockScope: next.lockScope || 'soft',
  };
}

export function isLlmPolicyLocked(policy) {
  return normalizeLlmPolicy(policy).mode === 'locked';
}

export function isLlmPolicyHardLocked(policy) {
  const normalized = normalizeLlmPolicy(policy);
  return normalized.mode === 'locked' && normalized.lockScope === 'hard';
}

export function getLlmPolicyLabel(policy) {
  const normalized = normalizeLlmPolicy(policy);
  return normalized.mode === 'locked' ? 'Specialist lock' : 'Recommendation';
}

export function getLlmPolicyDescription(policy) {
  const normalized = normalizeLlmPolicy(policy);
  if (normalized.mode === 'locked') {
    return normalized.note || 'This model choice is fixed for this specialist execution path.';
  }
  return 'This model is the agent default. Live user choice, credentials, and later policy layers can still override it.';
}

