import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import SettingsSection from './SettingsSection'
import PlatformFlagsPanel from './PlatformFlagsPanel'
import ToolTurnBaselinePanel from './ToolTurnBaselinePanel'
import QuoxHatPanel from './QuoxHatPanel'
import ProviderCertificationPanel from './ProviderCertificationPanel'
import SettingsCard, { SettingsGroup, SettingsCardGroup } from './SettingsCard'
import { FormField, Select, SettingItem } from '../ui/Input'
import Button from '../ui/Button'
import { MODEL_CATALOG, getDefaultModel } from '../../config/modelCatalog'
import { getCapabilitySeedPolicy, getCapabilityPolicyDefault } from '../../services/llmCapabilityPolicy'
import { resolveExecutionPlan } from '../../services/executionPlanResolver'
import { resolveLlmExecutionPlan, saveLlmRoutingPolicy, testLlmRoutingPolicy } from '../../services/llmRoutingPolicyClient'
import { saveLlmCapabilityPreferences } from '../../services/llmCapabilityPreferencesClient'
import { getProvenanceSourceLabel } from '../../services/llmProvenance'
import { getCollectorUnavailableStatus, getSessionExpiredStatus, normalizeLlmStatusPayload } from '../../services/llmStatus'
import { DEFAULT_LLM_CONFIG } from '../../services/llmService'
import { getLlmIdentityKey } from '../../../shared/llm-routing/contract.js'

const MAX_CAPABILITY_FALLBACKS = 3

// Phase 25 (owner mandate 2026-08-06): governance-relevant platform flags —
// server-side, org-scoped, override the env default, admin-only, audited.
// See services/collector/lib/platformSettingsStore.js.
// VAULT-INTEG P14 slice 1: AOCL_L1_MODE/AOCL_L8_MODE are the first typed
// (enum) entries promoted to settable — same panel, now rendering a select
// instead of a toggle.
// VAULT-INTEG P17: group-driven instead of a hand-curated key list — every
// settable entry tagged group:'governance' renders here automatically.

const CAPABILITY_ORDER = [
  'general_assistant',
  'planning',
  'coding',
  'analysis',
  'research',
  'image_generation',
  'executive_advisory',
]

const CAPABILITY_LABELS = Object.fromEntries(
  CAPABILITY_ORDER.map(capability => [capability, getCapabilityPolicyDefault(capability).capabilityLabel || capability]),
)

const CAPABILITY_DESCRIPTIONS = {
  general_assistant: 'Everyday chat, Q&A, and default assistant work when no more specialized lane is chosen.',
  planning: 'Structured thinking, decomposition, sequencing, and high-level decision support.',
  coding: 'Code generation, code edits, debugging, and technical implementation work.',
  analysis: 'Deep reading, multimodal synthesis, and heavyweight interpretation tasks.',
  research: 'Search-heavy, citation-heavy, or web-informed investigation.',
  image_generation: 'Model lane for generated images and visual outputs.',
  executive_advisory: 'High-context, strategic, or leadership-facing responses.',
}

const ROUTING_PRECEDENCE = [
  'Live toolbar or explicit user model selection',
  'Vault credential or hard specialist lock',
  'Personal capability preference',
  'Organization execution policy',
  'System default and fallback chain',
]

const PRIMARY_PROVIDER_ORDER = ['openai', 'anthropic', 'gemini', 'perplexity']
const EXECUTION_POLICY_TABS = [
  { id: 'preferences', label: 'My Defaults' },
  { id: 'org', label: 'Org Policy' },
  { id: 'simulator', label: 'Simulator' },
  { id: 'readiness', label: 'Readiness' },
]

const PROVIDER_STATUS_KEY_MAP = {
  anthropic: 'hasAnthropicKey',
  openai: 'hasOpenaiKey',
  elevenlabs: 'hasElevenlabsKey',
  perplexity: 'hasPerplexityKey',
  gemini: 'hasGeminiKey',
  codex: 'hasCodexKey',
}

function clonePolicy(policy) {
  return structuredClone(policy || getCapabilitySeedPolicy())
}

function getCapabilityDefinition(policy, capability) {
  const resolvedPolicy = policy || getCapabilitySeedPolicy()
  return resolvedPolicy.capabilities?.[capability] || resolvedPolicy.capabilities?.general_assistant
}

function clonePreferences(preferences) {
  return structuredClone(preferences || { capabilities: {} })
}

function modelOptions(provider) {
  return MODEL_CATALOG[provider]?.models || []
}

function firstModelForProvider(provider) {
  return getDefaultModel(provider)?.id || MODEL_CATALOG[provider]?.models?.[0]?.id || ''
}

function formatModelName(provider, modelId) {
  if (!provider || !modelId) return 'Not assigned'
  return MODEL_CATALOG[provider]?.models?.find(model => model.id === modelId)?.name || modelId
}

function formatProviderName(provider) {
  if (!provider) return 'Unassigned'
  if (provider === 'anthropic') return 'Anthropic / Claude'
  return MODEL_CATALOG[provider]?.name || provider
}

function formatExecutionLane(provider, modelId) {
  if (!provider) return 'Unassigned'
  return `${formatProviderName(provider)} / ${formatModelName(provider, modelId)}`
}

function getProviderRuntimeState(provider, providerConfigStatus, runtimeStatus) {
  const statusKey = PROVIDER_STATUS_KEY_MAP[provider]
  const hasApiKey = statusKey ? !!providerConfigStatus[statusKey] : false

  if (provider === 'anthropic') {
    const terminalOAuth = runtimeStatus?.capabilities?.terminalOAuth
    if (hasApiKey) {
      return {
        tone: 'success',
        badge: 'API key configured',
        detail: 'Claude models can run through the Anthropic API key path.',
      }
    }
    if (runtimeStatus?.auth_method === 'cli_credentials') {
      return {
        tone: 'success',
        badge: 'Claude subscription authenticated',
        detail: 'Claude terminal OAuth is authenticated and can satisfy Anthropic routing.',
      }
    }
    if (terminalOAuth?.available) {
      return {
        tone: 'warning',
        badge: 'Claude terminal available',
        detail: 'The Claude subscription login path is available, but it is not authenticated yet.',
      }
    }
    return {
      tone: 'danger',
      badge: 'Not configured',
      detail: terminalOAuth?.recommendation || 'Add an Anthropic API key or authenticate Claude terminal access in Core Integrations.',
    }
  }

  if (hasApiKey) {
    return {
      tone: 'success',
      badge: 'Ready',
      detail: 'Configured in Core Integrations.',
    }
  }

  return {
    tone: 'danger',
    badge: 'Needs setup',
    detail: 'Add a provider key in Core Integrations before this lane can execute.',
  }
}

function getPreferredProviderOrder(primaryProvider) {
  const providers = Object.keys(MODEL_CATALOG)
  const preferred = []
  const pushUnique = (provider) => {
    if (provider && providers.includes(provider) && !preferred.includes(provider)) preferred.push(provider)
  }
  pushUnique(DEFAULT_LLM_CONFIG.provider)
  pushUnique(primaryProvider)
  providers.forEach(pushUnique)
  return preferred
}

function buildSuggestedFallback(policy, capabilityPolicy) {
  const primary = capabilityPolicy?.primary || {}
  const systemDefault = policy?.system_default || {}
  const existing = new Set([
    `${primary.provider || ''}:${primary.model || ''}`,
    ...((capabilityPolicy?.fallbacks || []).map(step => `${step.provider || ''}:${step.model || ''}`)),
  ])

  const candidates = []

  if (systemDefault.provider) {
    candidates.push({
      provider: systemDefault.provider,
      model: systemDefault.model || firstModelForProvider(systemDefault.provider),
    })
  }

  for (const provider of getPreferredProviderOrder(primary.provider)) {
    candidates.push({
      provider,
      model: firstModelForProvider(provider),
    })
  }

  const suggestion = candidates.find(step => step.provider && step.model && !existing.has(`${step.provider}:${step.model}`))
  return suggestion || {
    provider: systemDefault.provider || DEFAULT_LLM_CONFIG.provider,
    model: systemDefault.model || firstModelForProvider(systemDefault.provider || DEFAULT_LLM_CONFIG.provider),
  }
}

function CapabilityCard({ capability, draftPolicy, setDraftPolicy, readOnly, embedded = false }) {
  const capabilityPolicy = draftPolicy.capabilities[capability]
  const fallbacks = capabilityPolicy.fallbacks || []
  const capabilityLabel = CAPABILITY_LABELS[capability]
  const [fallbackErrors, setFallbackErrors] = useState({})
  const atFallbackCap = fallbacks.length >= MAX_CAPABILITY_FALLBACKS

  const clearFallbackError = (index) => {
    setFallbackErrors(prev => {
      if (!(index in prev)) return prev
      const next = { ...prev }
      delete next[index]
      return next
    })
  }

  const updateCapabilityField = (field, value) => {
    setDraftPolicy(prev => {
      const next = clonePolicy(prev)
      next.capabilities[capability][field] = value
      return next
    })
  }

  const updateCredentialConstraint = (blockOauth) => {
    setDraftPolicy(prev => {
      const next = clonePolicy(prev)
      const nextCapabilityPolicy = next.capabilities[capability]
      if (blockOauth) {
        nextCapabilityPolicy.credential_constraints = { allow_oauth: false }
      } else {
        delete nextCapabilityPolicy.credential_constraints
      }
      return next
    })
  }

  const updatePrimary = (field, value) => {
    setDraftPolicy(prev => {
      const next = clonePolicy(prev)
      next.capabilities[capability].primary[field] = value
      if (field === 'provider') {
        next.capabilities[capability].primary.model = firstModelForProvider(value)
      }
      return next
    })
  }

  const updateFallback = (index, field, value) => {
    // Duplicate check is computed against this render's own draftPolicy-derived
    // `capabilityPolicy`/`fallbacks` (not inside the setDraftPolicy updater) so
    // it doesn't depend on React's functional-update scheduling timing.
    const candidate = { ...fallbacks[index], [field]: value }
    if (field === 'provider') {
      candidate.model = firstModelForProvider(value)
    }
    const candidateKey = getLlmIdentityKey(candidate)
    const primaryKey = getLlmIdentityKey(capabilityPolicy.primary)
    const duplicatesAnotherFallback = fallbacks.some(
      (fallback, otherIndex) => otherIndex !== index && getLlmIdentityKey(fallback) === candidateKey,
    )

    if (candidateKey === primaryKey || duplicatesAnotherFallback) {
      setFallbackErrors(prev => ({
        ...prev,
        [index]: 'That provider/model already appears in this responsibility’s primary or fallback chain.',
      }))
      return
    }

    clearFallbackError(index)
    setDraftPolicy(prev => {
      const next = clonePolicy(prev)
      next.capabilities[capability].fallbacks[index] = candidate
      return next
    })
  }

  const addFallback = () => {
    if (atFallbackCap) return
    setDraftPolicy(prev => {
      const next = clonePolicy(prev)
      next.capabilities[capability].fallbacks.push(buildSuggestedFallback(next, next.capabilities[capability]))
      return next
    })
  }

  const removeFallback = (index) => {
    setDraftPolicy(prev => {
      const next = clonePolicy(prev)
      next.capabilities[capability].fallbacks.splice(index, 1)
      return next
    })
    setFallbackErrors(prev => {
      if (Object.keys(prev).length === 0) return prev
      const next = {}
      Object.entries(prev).forEach(([key, value]) => {
        const keyIndex = Number(key)
        if (keyIndex === index) return
        next[keyIndex > index ? keyIndex - 1 : keyIndex] = value
      })
      return next
    })
  }

  const moveFallback = (index, direction) => {
    setDraftPolicy(prev => {
      const next = clonePolicy(prev)
      const items = next.capabilities[capability].fallbacks
      const target = index + direction
      if (target < 0 || target >= items.length) return prev
      const [item] = items.splice(index, 1)
      items.splice(target, 0, item)
      return next
    })
    setFallbackErrors(prev => {
      const target = index + direction
      if (!(index in prev) && !(target in prev)) return prev
      const next = { ...prev }
      const indexError = next[index]
      const targetError = next[target]
      if (targetError === undefined) delete next[index]; else next[index] = targetError
      if (indexError === undefined) delete next[target]; else next[target] = indexError
      return next
    })
  }

  const content = (
    <>
      <SettingsGroup>
        <div style={{ color: 'var(--ui-text-secondary)' }}>
          Policy label: <strong style={{ color: 'var(--ui-text-primary)' }}>{capabilityPolicy.policyLabel || 'Default routing rule'}</strong>
        </div>
        <SettingItem
          label="Allow people to override this responsibility"
          description="If off, org policy stays in control for this responsibility unless a credential or specialist lock takes priority."
          checked={capabilityPolicy.allow_user_override !== false}
          onChange={(e) => updateCapabilityField('allow_user_override', e.target.checked)}
          disabled={readOnly}
        />
        <SettingItem
          label="Prod-critical: never use OAuth/CLI credentials"
          description="When on, this responsibility refuses the OAuth/CLI credential path even if it is configured, and fails toward the fallback chain instead. Off (default) allows OAuth."
          checked={capabilityPolicy.credential_constraints?.allow_oauth === false}
          onChange={(e) => updateCredentialConstraint(e.target.checked)}
          disabled={readOnly}
        />
      </SettingsGroup>
      <SettingsGroup divider>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <FormField label="Primary provider">
            <Select
              aria-label={`${capabilityLabel} primary provider`}
              value={capabilityPolicy.primary.provider}
              onChange={(e) => updatePrimary('provider', e.target.value)}
              disabled={readOnly}
            >
              {Object.keys(MODEL_CATALOG).map(provider => (
                <option key={provider} value={provider}>{MODEL_CATALOG[provider].name}</option>
              ))}
            </Select>
          </FormField>
          <FormField label="Primary model">
            <Select
              aria-label={`${capabilityLabel} primary model`}
              value={capabilityPolicy.primary.model}
              onChange={(e) => updatePrimary('model', e.target.value)}
              disabled={readOnly}
            >
              {modelOptions(capabilityPolicy.primary.provider).map(model => (
                <option key={model.id} value={model.id}>{model.name}</option>
              ))}
            </Select>
          </FormField>
        </div>
      </SettingsGroup>
      <SettingsGroup divider>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
          <strong style={{ color: 'var(--ui-text-primary)' }}>Fallback chain</strong>
          {!readOnly && (
            <Button size="sm" variant="outline" onClick={addFallback} disabled={atFallbackCap}>
              Add fallback
            </Button>
          )}
        </div>
        {fallbacks.length === 0 && (
          <div style={{ color: 'var(--ui-text-muted)', fontSize: '0.9rem' }}>
            No fallback configured for this capability.
          </div>
        )}
        {atFallbackCap && (
          <div style={{ color: 'var(--ui-text-muted)', fontSize: '0.86rem', marginBottom: '10px' }}>
            Maximum of {MAX_CAPABILITY_FALLBACKS} fallbacks reached for this responsibility.
          </div>
        )}
        <div style={{ display: 'grid', gap: '10px' }}>
          {fallbacks.map((fallback, index) => (
            <div
              key={`${capability}-fallback-${index}`}
              style={{
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '12px',
                padding: '12px',
                background: 'rgba(255,255,255,0.02)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                <strong style={{ color: 'var(--ui-text-secondary)' }}>Fallback {index + 1}</strong>
                {!readOnly && (
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <Button size="sm" variant="ghost" onClick={() => moveFallback(index, -1)} disabled={index === 0}>Up</Button>
                    <Button size="sm" variant="ghost" onClick={() => moveFallback(index, 1)} disabled={index === fallbacks.length - 1}>Down</Button>
                    <Button size="sm" variant="outline-red" onClick={() => removeFallback(index)}>Remove</Button>
                  </div>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <FormField label="Provider">
                  <Select
                    aria-label={`${capabilityLabel} fallback ${index + 1} provider`}
                    value={fallback.provider}
                    onChange={(e) => updateFallback(index, 'provider', e.target.value)}
                    disabled={readOnly}
                  >
                    {Object.keys(MODEL_CATALOG).map(provider => (
                      <option key={provider} value={provider}>{MODEL_CATALOG[provider].name}</option>
                    ))}
                  </Select>
                </FormField>
                <FormField label="Model">
                  <Select
                    aria-label={`${capabilityLabel} fallback ${index + 1} model`}
                    value={fallback.model}
                    onChange={(e) => updateFallback(index, 'model', e.target.value)}
                    disabled={readOnly}
                  >
                    {modelOptions(fallback.provider).map(model => (
                      <option key={model.id} value={model.id}>{model.name}</option>
                    ))}
                  </Select>
                </FormField>
              </div>
              {fallbackErrors[index] && (
                <div
                  role="alert"
                  style={{ color: 'var(--ui-red-light, #ff8080)', fontSize: '0.86rem', marginTop: '8px' }}
                >
                  {fallbackErrors[index]}
                </div>
              )}
            </div>
          ))}
        </div>
      </SettingsGroup>
    </>
  )

  if (embedded) {
    return <div className="execution-policy-panel">{content}</div>
  }

  return (
    <SettingsCard
      title={CAPABILITY_LABELS[capability]}
      subtitle={CAPABILITY_DESCRIPTIONS[capability] || 'Primary provider/model and ordered fallback chain'}
      status={fallbacks.length ? 'warning' : 'neutral'}
      statusText={fallbacks.length ? `${fallbacks.length === 1 ? '1 fallback' : `${fallbacks.length} fallbacks`}` : 'Primary only'}
      glass
    >
      {content}
    </SettingsCard>
  )
}

export default function ExecutionPolicySettings({
  authFetch,
  currentOrg,
  policyPayload,
  refreshPolicy,
  preferencePayload,
  refreshPreferences,
  onNotification,
}) {
  const navigate = useNavigate()
  const canEditPolicy = ['owner', 'admin'].includes(currentOrg?.role)
  const canEditPreferences = !!currentOrg?.id
  const draftStorageKey = currentOrg?.id ? `quox:execution-policy-draft:${currentOrg.id}` : null
  const [draftPolicy, setDraftPolicy] = useState(() => clonePolicy(policyPayload?.policy))
  const [draftPreferences, setDraftPreferences] = useState(() => clonePreferences(preferencePayload?.preferences))
  const [activeTab, setActiveTab] = useState('preferences')
  const [selectedCapability, setSelectedCapability] = useState('planning')
  const [manualProvider, setManualProvider] = useState('')
  const [manualModel, setManualModel] = useState('')
  const [validationErrors, setValidationErrors] = useState([])
  const [saving, setSaving] = useState(false)
  const [validating, setValidating] = useState(false)
  const [savingPreferences, setSavingPreferences] = useState(false)
  const [canonicalSimulatorPlan, setCanonicalSimulatorPlan] = useState(null)
  const [simulatorError, setSimulatorError] = useState('')
  const [simulatorLoading, setSimulatorLoading] = useState(false)
  const [providerConfigStatus, setProviderConfigStatus] = useState({})
  const [runtimeStatus, setRuntimeStatus] = useState(null)
  const draftHydratedRef = useRef(false)
  const restoredDraftNoticeRef = useRef(false)
  const serverPolicySnapshot = useMemo(() => JSON.stringify(clonePolicy(policyPayload?.policy)), [policyPayload?.policy])
  const serverPreferenceSnapshot = useMemo(() => JSON.stringify(clonePreferences(preferencePayload?.preferences)), [preferencePayload?.preferences])
  const draftPolicySnapshot = useMemo(() => JSON.stringify(draftPolicy), [draftPolicy])
  const draftPreferenceSnapshot = useMemo(() => JSON.stringify(draftPreferences), [draftPreferences])
  const hasUnsavedLocalDraft = draftPolicySnapshot !== serverPolicySnapshot || draftPreferenceSnapshot !== serverPreferenceSnapshot

  useEffect(() => {
    draftHydratedRef.current = false
    restoredDraftNoticeRef.current = false
  }, [draftStorageKey])

  useEffect(() => {
    const serverPolicy = clonePolicy(policyPayload?.policy)
    const serverPreferences = clonePreferences(preferencePayload?.preferences)

    if (!draftHydratedRef.current) {
      let restored = false
      if (draftStorageKey) {
        try {
          const raw = window.localStorage.getItem(draftStorageKey)
          if (raw) {
            const parsed = JSON.parse(raw)
            if (parsed?.policy) {
              setDraftPolicy(clonePolicy(parsed.policy))
              setDraftPreferences(clonePreferences(parsed.preferences))
              restored = true
              if (!restoredDraftNoticeRef.current) {
                onNotification?.('Recovered unsaved execution policy draft', 'info')
                restoredDraftNoticeRef.current = true
              }
            }
          }
        } catch {
          // Ignore malformed draft storage and fall back to server state.
        }
      }
      if (!restored) {
        setDraftPolicy(serverPolicy)
        setDraftPreferences(serverPreferences)
      }
      draftHydratedRef.current = true
      return
    }

    if (!draftStorageKey) {
      setDraftPolicy(serverPolicy)
      setDraftPreferences(serverPreferences)
      return
    }

    try {
      const raw = window.localStorage.getItem(draftStorageKey)
      if (!raw) {
        setDraftPolicy(serverPolicy)
        setDraftPreferences(serverPreferences)
      }
    } catch {
      setDraftPolicy(serverPolicy)
      setDraftPreferences(serverPreferences)
    }
  }, [draftStorageKey, policyPayload?.policy, preferencePayload?.preferences, onNotification])

  useEffect(() => {
    if (!draftHydratedRef.current || !draftStorageKey) return
    try {
      if (hasUnsavedLocalDraft) {
        window.localStorage.setItem(draftStorageKey, JSON.stringify({
          policy: draftPolicy,
          preferences: draftPreferences,
        }))
      } else {
        window.localStorage.removeItem(draftStorageKey)
      }
    } catch {
      // Ignore local draft persistence failures.
    }
  }, [draftStorageKey, hasUnsavedLocalDraft, draftPolicy, draftPreferences])

  useEffect(() => {
    let cancelled = false

    async function loadProviderStatus() {
      try {
        const response = await fetch('/api/setup/config', { credentials: 'include' })
        if (!response.ok) return
        const data = await response.json()
        if (!cancelled) {
          setProviderConfigStatus(data?.keys || {})
        }
      } catch {
        if (!cancelled) {
          setProviderConfigStatus({})
        }
      }
    }

    loadProviderStatus()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadRuntimeStatus() {
      try {
        const response = await fetch('/collector/chat/status', { signal: AbortSignal.timeout(10000) })
        if (response.status === 401 || response.status === 403) {
          // Stale session, not a dead collector — don't mislabel it.
          if (!cancelled) setRuntimeStatus(getSessionExpiredStatus(`HTTP ${response.status}`))
          return
        }
        if (!response.ok) {
          if (!cancelled) setRuntimeStatus(getCollectorUnavailableStatus(`HTTP ${response.status}`))
          return
        }
        const data = await response.json()
        if (!cancelled) {
          setRuntimeStatus(normalizeLlmStatusPayload(data))
        }
      } catch (error) {
        if (!cancelled) {
          setRuntimeStatus(getCollectorUnavailableStatus(error.message))
        }
      }
    }

    loadRuntimeStatus()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (manualProvider && !modelOptions(manualProvider).some(model => model.id === manualModel)) {
      setManualModel(firstModelForProvider(manualProvider))
    }
  }, [manualProvider, manualModel])

  const simulatorContext = useMemo(() => {
    const capabilityDefinition = getCapabilityDefinition(draftPolicy, selectedCapability)
    const personalPreference = draftPreferences?.capabilities?.[selectedCapability] || null
    const capabilityContext = {
      capability: selectedCapability,
      capabilityLabel: capabilityDefinition?.capabilityLabel || CAPABILITY_LABELS[selectedCapability] || selectedCapability,
      policyLabel: capabilityDefinition?.policyLabel || null,
      policyEnabled: draftPolicy?.enabled !== false,
      policyEnforcement: {
        ...(draftPolicy?.enforcement || {}),
      },
      systemDefault: {
        provider: draftPolicy?.system_default?.provider || null,
        model: draftPolicy?.system_default?.model || null,
      },
      policyDefault: {
        provider: capabilityDefinition?.primary?.provider || null,
        model: capabilityDefinition?.primary?.model || null,
      },
      policyFallbacks: capabilityDefinition?.fallbacks || [],
      allowUserOverride: capabilityDefinition?.allow_user_override !== false,
    }
    const executionPlan = resolveExecutionPlan({
      userSelection: {
        provider: manualProvider || null,
        model: manualModel || null,
      },
      capability: capabilityContext.capability,
      capabilityLabel: capabilityContext.capabilityLabel,
      policyLabel: capabilityContext.policyLabel,
      policyEnabled: capabilityContext.policyEnabled,
      policyEnforcement: capabilityContext.policyEnforcement,
      capabilityAllowUserOverride: capabilityContext.allowUserOverride,
      personalPreference,
      policyDefault: capabilityContext.policyDefault,
      systemDefault: capabilityContext.systemDefault,
    })
    return { capabilityContext, executionPlan, personalPreference }
  }, [draftPolicy, draftPreferences, selectedCapability, manualProvider, manualModel])

  useEffect(() => {
    let cancelled = false

    async function loadCanonicalSimulation() {
      if (!currentOrg?.id) {
        setCanonicalSimulatorPlan(null)
        setSimulatorError('')
        return
      }

      setSimulatorLoading(true)
      setSimulatorError('')
      try {
        const result = await resolveLlmExecutionPlan({
          orgId: currentOrg.id,
          capability: selectedCapability,
          provider: manualProvider || null,
          model: manualModel || null,
          policy: draftPolicy,
          personalPreference: simulatorContext.personalPreference,
        })
        if (!cancelled) {
          setCanonicalSimulatorPlan(result.executionPlan || null)
        }
      } catch (error) {
        if (!cancelled) {
          setCanonicalSimulatorPlan(null)
          setSimulatorError(error.validationErrors?.[0] || error.message)
        }
      } finally {
        if (!cancelled) {
          setSimulatorLoading(false)
        }
      }
    }

    loadCanonicalSimulation()
    return () => { cancelled = true }
  }, [
    currentOrg?.id,
    draftPolicy,
    selectedCapability,
    manualProvider,
    manualModel,
    simulatorContext.personalPreference,
  ])

  const handleValidate = async () => {
    setValidating(true)
    try {
      const result = await testLlmRoutingPolicy(authFetch, currentOrg?.id, draftPolicy)
      setValidationErrors(result.errors || [])
      if (result.valid) {
        onNotification?.('Execution policy validated', 'success')
      }
    } catch (error) {
      setValidationErrors([error.message])
      onNotification?.(error.message, 'error')
    } finally {
      setValidating(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await testLlmRoutingPolicy(authFetch, currentOrg?.id, draftPolicy)
      const result = await saveLlmRoutingPolicy(authFetch, currentOrg?.id, draftPolicy)
      if (result?.policy) {
        setDraftPolicy(clonePolicy(result.policy))
      }
      setValidationErrors([])
      void refreshPolicy?.({ force: true })
      onNotification?.('Execution policy saved', 'success')
    } catch (error) {
      setValidationErrors(error.validationErrors?.length ? error.validationErrors : [error.message])
      onNotification?.(error.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleReset = () => {
    setDraftPolicy(clonePolicy(policyPayload?.policy))
    setDraftPreferences(clonePreferences(preferencePayload?.preferences))
    setValidationErrors([])
  }

  const displayedSimulatorPlan = canonicalSimulatorPlan || simulatorContext.executionPlan
  const missingProviderAssignments = useMemo(() => {
    const seen = new Map()

    for (const capability of CAPABILITY_ORDER) {
      const definition = getCapabilityDefinition(draftPolicy, capability)
      const provider = definition?.primary?.provider
      const label = definition?.capabilityLabel || CAPABILITY_LABELS[capability] || capability
      const statusKey = PROVIDER_STATUS_KEY_MAP[provider]
      const configured = statusKey ? !!providerConfigStatus[statusKey] : true
      if (!provider || configured) continue
      if (!seen.has(provider)) seen.set(provider, [])
      seen.get(provider).push(label)
    }

    return Array.from(seen.entries()).map(([provider, labels]) => ({ provider, labels }))
  }, [draftPolicy, providerConfigStatus])

  const providerLaneRows = useMemo(() => {
    const assigned = new Map()
    // LLM-FAILOVER P2 (UX audit A2): count capabilities whose fallback
    // chain includes each provider, so fallback-only lanes can say what
    // they are actually standing by for.
    const fallbackCounts = new Map()

    for (const capability of CAPABILITY_ORDER) {
      const definition = getCapabilityDefinition(draftPolicy, capability)
      const provider = definition?.primary?.provider
      const label = definition?.capabilityLabel || CAPABILITY_LABELS[capability] || capability
      const fallbackProviders = new Set(
        (definition?.fallbacks || []).map(step => step?.provider).filter(Boolean)
      )
      for (const fallbackProvider of fallbackProviders) {
        fallbackCounts.set(fallbackProvider, (fallbackCounts.get(fallbackProvider) || 0) + 1)
      }
      if (!provider) continue
      if (!assigned.has(provider)) assigned.set(provider, [])
      assigned.get(provider).push(label)
    }

    const preferredProviders = new Set([
      ...PRIMARY_PROVIDER_ORDER,
      draftPolicy?.system_default?.provider,
      ...Array.from(assigned.keys()),
    ])

    return Array.from(preferredProviders)
      .filter(Boolean)
      .map(provider => ({
        provider,
        providerLabel: formatProviderName(provider),
        responsibilities: assigned.get(provider) || [],
        fallbackCapabilityCount: fallbackCounts.get(provider) || 0,
        ...getProviderRuntimeState(provider, providerConfigStatus, runtimeStatus),
      }))
  }, [draftPolicy, providerConfigStatus, runtimeStatus])

  const providerReadyCount = useMemo(() => (
    providerLaneRows.filter(row => row.tone === 'success').length
  ), [providerLaneRows])

  const selectedCapabilityDefinition = getCapabilityDefinition(draftPolicy, selectedCapability)
  const selectedCapabilityProviderState = getProviderRuntimeState(
    selectedCapabilityDefinition?.primary?.provider,
    providerConfigStatus,
    runtimeStatus,
  )

  const updateCapabilityPreference = (capability, nextValue) => {
    setDraftPreferences(prev => {
      const next = clonePreferences(prev)
      if (!nextValue) {
        delete next.capabilities[capability]
        return next
      }
      next.capabilities[capability] = nextValue
      return next
    })
  }

  const handleSavePreferences = async () => {
    setSavingPreferences(true)
    try {
      await saveLlmCapabilityPreferences(authFetch, currentOrg?.id, draftPreferences)
      void refreshPreferences?.({ force: true })
      onNotification?.('Personal capability preferences saved', 'success')
    } catch (error) {
      onNotification?.(error.message, 'error')
    } finally {
      setSavingPreferences(false)
    }
  }

  const updateGlobalPolicySetting = (field, value) => {
    setDraftPolicy(prev => {
      const next = clonePolicy(prev)
      next[field] = value
      return next
    })
  }

  const updateSystemDefault = (field, value) => {
    setDraftPolicy(prev => {
      const next = clonePolicy(prev)
      next.system_default[field] = value
      if (field === 'provider') {
        next.system_default.model = firstModelForProvider(value)
      }
      return next
    })
  }

  const updateEnforcement = (field, value) => {
    setDraftPolicy(prev => {
      const next = clonePolicy(prev)
      next.enforcement[field] = value
      return next
    })
  }

  const sectionActions = activeTab === 'preferences'
    ? (
      <div style={{ display: 'flex', gap: '8px' }}>
        <Button variant="outline" onClick={() => setDraftPreferences(clonePreferences(preferencePayload?.preferences))}>
          Reset Preferences
        </Button>
        <Button variant="primary" onClick={handleSavePreferences} loading={savingPreferences} disabled={!canEditPreferences}>
          Save Preferences
        </Button>
      </div>
    )
    : (
      <div style={{ display: 'flex', gap: '8px' }}>
        <Button variant="outline" onClick={handleValidate} loading={validating}>Validate</Button>
        <Button variant="outline" onClick={handleReset}>Reset</Button>
        <Button variant="primary" onClick={handleSave} loading={saving} disabled={!canEditPolicy}>Save Policy</Button>
      </div>
    )

  return (
    <div>
      <SettingsSection
        title="Execution Policy"
        description="Capability defaults, ordered fallbacks, and runtime precedence for model execution."
        actions={sectionActions}
      >
        <div
          role="tablist"
          aria-label="Execution policy sections"
          style={{
            display: 'flex',
            gap: '8px',
            flexWrap: 'wrap',
            marginBottom: '16px',
            padding: '4px',
            borderRadius: '14px',
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          {EXECUTION_POLICY_TABS.map(tab => {
            const selected = activeTab === tab.id
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`execution-policy-panel-${tab.id}`}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  all: 'unset',
                  boxSizing: 'border-box',
                  padding: '10px 14px',
                  borderRadius: '10px',
                  cursor: 'pointer',
                  color: selected ? 'var(--ui-text-primary)' : 'var(--ui-text-secondary)',
                  background: selected ? 'rgba(56,189,248,0.12)' : 'transparent',
                  border: selected ? '1px solid rgba(56,189,248,0.28)' : '1px solid transparent',
                  fontWeight: selected ? 700 : 600,
                  lineHeight: 1.2,
                }}
              >
                {tab.label}
              </button>
            )
          })}
        </div>

        {activeTab === 'preferences' && (
          <SettingsCard
            title="Personal Capability Preferences"
            subtitle="Quickly steer what does what for you. These only apply when the organization allows personal override."
            glass
            status={canEditPreferences ? 'success' : 'neutral'}
            statusText={canEditPreferences ? 'Your defaults' : 'Read only'}
          >
            <SettingsGroup divider>
              <div style={{ color: 'var(--ui-text-secondary)', lineHeight: 1.6 }}>
                This is the fastest control surface on the page. Leave a responsibility on <strong style={{ color: 'var(--ui-text-primary)' }}>Use org policy</strong>, or point it at your preferred provider/model for everyday work.
              </div>
            </SettingsGroup>
            <SettingsGroup>
              <div style={{ display: 'grid', gap: '12px' }}>
                {CAPABILITY_ORDER.map(capability => {
                  const preference = draftPreferences?.capabilities?.[capability] || null
                  const selectedProvider = preference?.provider || ''
                  const orgLane = getCapabilityDefinition(draftPolicy, capability)
                  return (
                    <div
                      key={`preference-${capability}`}
                      style={{
                        border: '1px solid rgba(255,255,255,0.08)',
                        borderRadius: '14px',
                        padding: '14px',
                        background: 'rgba(255,255,255,0.02)',
                        display: 'grid',
                        gap: '12px',
                      }}
                    >
                      <div style={{ display: 'grid', gap: '4px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
                          <strong style={{ color: 'var(--ui-text-primary)' }}>{CAPABILITY_LABELS[capability]}</strong>
                          <span style={{ color: 'var(--ui-text-muted)', fontSize: '0.86rem' }}>
                            Org default: {formatExecutionLane(orgLane?.primary?.provider, orgLane?.primary?.model)}
                          </span>
                        </div>
                        <div style={{ color: 'var(--ui-text-secondary)', lineHeight: 1.5 }}>
                          {CAPABILITY_DESCRIPTIONS[capability]}
                        </div>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
                        <FormField label="Preference mode">
                          <Select
                            aria-label={`${CAPABILITY_LABELS[capability]} preference mode`}
                            value={preference ? 'custom' : 'policy'}
                            onChange={(e) => {
                              if (e.target.value === 'policy') {
                                updateCapabilityPreference(capability, null)
                              } else {
                                const preferredProvider = draftPolicy?.system_default?.provider || DEFAULT_LLM_CONFIG.provider
                                updateCapabilityPreference(capability, {
                                  provider: preferredProvider,
                                  model: firstModelForProvider(preferredProvider),
                                })
                              }
                            }}
                            disabled={!canEditPreferences}
                          >
                            <option value="policy">Use org policy</option>
                            <option value="custom">Override for me</option>
                          </Select>
                        </FormField>
                        <FormField label="Provider">
                          <Select
                            aria-label={`${CAPABILITY_LABELS[capability]} preference provider`}
                            value={selectedProvider}
                            onChange={(e) => updateCapabilityPreference(capability, {
                              provider: e.target.value,
                              model: firstModelForProvider(e.target.value),
                            })}
                            disabled={!canEditPreferences || !preference}
                          >
                            <option value="">Use org policy</option>
                            {Object.keys(MODEL_CATALOG).map(provider => (
                              <option key={provider} value={provider}>{formatProviderName(provider)}</option>
                            ))}
                          </Select>
                        </FormField>
                        <FormField label="Model">
                          <Select
                            aria-label={`${CAPABILITY_LABELS[capability]} preference model`}
                            value={preference?.model || ''}
                            onChange={(e) => updateCapabilityPreference(capability, {
                              provider: selectedProvider,
                              model: e.target.value,
                            })}
                            disabled={!canEditPreferences || !preference || !selectedProvider}
                          >
                            <option value="">{preference ? 'Select model' : 'Use org policy'}</option>
                            {selectedProvider && modelOptions(selectedProvider).map(model => (
                              <option key={model.id} value={model.id}>{model.name}</option>
                            ))}
                          </Select>
                        </FormField>
                      </div>
                    </div>
                  )
                })}
              </div>
            </SettingsGroup>
          </SettingsCard>
        )}

        {activeTab === 'org' && (
          <>
            <SettingsCard
              title="Organization Responsibility Map"
              subtitle="Set the organization default for each responsibility. Personal preferences above can still win when override is allowed."
              status={draftPolicy.enabled !== false ? 'success' : 'warning'}
              statusText={draftPolicy.enabled !== false ? 'Policy active' : 'Policy bypassed'}
              glass
              headerActions={(
                <Button size="sm" variant="outline" onClick={() => navigate('/settings#core', { state: { section: 'core' } })}>
                  Provider Setup
                </Button>
              )}
            >
          <SettingsGroup divider>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                gap: '16px',
              }}
            >
              <div style={{ display: 'grid', gap: '12px' }}>
                <div style={{ color: 'var(--ui-text-secondary)', lineHeight: 1.6 }}>
                  Each card below is a responsibility in the system. Most teams can leave these alone. Change a lane only when you want a responsibility to favor a different provider or model family.
                </div>
                <div style={{ display: 'grid', gap: '10px' }}>
                  <SettingItem
                    label="Execution policy enabled"
                    description="Turn org-wide responsibility mapping on, or leave routing to live user choice, credentials, and system fallbacks."
                    checked={draftPolicy.enabled !== false}
                    onChange={(e) => updateGlobalPolicySetting('enabled', e.target.checked)}
                    disabled={!canEditPolicy}
                  />
                  <SettingItem
                    label="Allow provider override"
                    description="Leave this on for a flexible system. Turn it off only when responsibilities should stay in their assigned provider lane."
                    checked={draftPolicy.enforcement?.allow_user_provider_override !== false}
                    onChange={(e) => updateEnforcement('allow_user_provider_override', e.target.checked)}
                    disabled={!canEditPolicy}
                  />
                  <SettingItem
                    label="Allow model override"
                    description="Leave this on to let people choose a different model inside an allowed lane. Turn it off for tighter control."
                    checked={draftPolicy.enforcement?.allow_user_model_override !== false}
                    onChange={(e) => updateEnforcement('allow_user_model_override', e.target.checked)}
                    disabled={!canEditPolicy}
                  />
                  <SettingItem
                    label="Allow OAuth/CLI credentials"
                    description="Org-wide default for the OAuth/CLI credential path. A responsibility's own 'never use OAuth/CLI credentials' toggle always overrides this org default. Default: on (OAuth allowed)."
                    checked={draftPolicy.enforcement?.allow_oauth_credentials !== false}
                    onChange={(e) => updateEnforcement('allow_oauth_credentials', e.target.checked)}
                    disabled={!canEditPolicy}
                  />
                </div>
              </div>

              <div
                style={{
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '16px',
                  background: 'linear-gradient(180deg, rgba(56,189,248,0.08), rgba(255,255,255,0.03))',
                  padding: '16px',
                  display: 'grid',
                  gap: '12px',
                  alignContent: 'start',
                }}
              >
                <div>
                  <div style={{ color: 'var(--ui-text-muted)', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    Leave as-is fallback
                  </div>
                  <div style={{ color: 'var(--ui-text-primary)', fontSize: '1.05rem', fontWeight: 700, marginTop: '4px' }}>
                    {formatExecutionLane(draftPolicy.system_default?.provider, draftPolicy.system_default?.model)}
                  </div>
                  <div style={{ color: 'var(--ui-text-secondary)', marginTop: '6px', lineHeight: 1.5 }}>
                    This is the safety net used when no stronger choice wins.
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <FormField label="System default provider">
                    <Select
                      aria-label="System default provider"
                      value={draftPolicy.system_default?.provider || ''}
                      onChange={(e) => updateSystemDefault('provider', e.target.value)}
                      disabled={!canEditPolicy}
                    >
                      {Object.keys(MODEL_CATALOG).map(provider => (
                        <option key={provider} value={provider}>{formatProviderName(provider)}</option>
                      ))}
                    </Select>
                  </FormField>
                  <FormField label="System default model">
                    <Select
                      aria-label="System default model"
                      value={draftPolicy.system_default?.model || ''}
                      onChange={(e) => updateSystemDefault('model', e.target.value)}
                      disabled={!canEditPolicy}
                    >
                      {modelOptions(draftPolicy.system_default?.provider).map(model => (
                        <option key={model.id} value={model.id}>{model.name}</option>
                      ))}
                    </Select>
                  </FormField>
                </div>
                <div style={{ color: 'var(--ui-text-muted)', fontSize: '0.9rem', lineHeight: 1.5 }}>
                  Save this page only if you want to steer the whole org. Otherwise the current mapping is already active.
                </div>
              </div>
            </div>
          </SettingsGroup>

          <SettingsGroup divider>
            <div style={{ color: 'var(--ui-text-secondary)' }}>
              Provider lanes visible to this org right now. Claude appears here as <strong style={{ color: 'var(--ui-text-primary)' }}>Anthropic / Claude</strong> even if nothing is currently assigned to it.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
              {providerLaneRows.map((row) => (
                <div
                  key={`provider-lane-${row.provider}`}
                  style={{
                    padding: '12px',
                    borderRadius: '14px',
                    border: row.tone === 'success'
                      ? '1px solid rgba(34,197,94,0.22)'
                      : row.tone === 'warning'
                        ? '1px solid rgba(245,158,11,0.24)'
                        : '1px solid rgba(239,68,68,0.2)',
                    background: 'rgba(255,255,255,0.03)',
                    display: 'grid',
                    gap: '8px',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'start' }}>
                    <strong style={{ color: 'var(--ui-text-primary)' }}>{row.providerLabel}</strong>
                    <span
                      style={{
                        fontSize: '0.75rem',
                        fontWeight: 700,
                        padding: '4px 8px',
                        borderRadius: '999px',
                        background: row.tone === 'success'
                          ? 'rgba(34,197,94,0.16)'
                          : row.tone === 'warning'
                            ? 'rgba(245,158,11,0.16)'
                            : 'rgba(239,68,68,0.14)',
                        color: 'var(--ui-text-primary)',
                      }}
                    >
                      {row.badge}
                    </span>
                  </div>
                  <div style={{ color: 'var(--ui-text-secondary)', fontSize: '0.92rem', lineHeight: 1.45 }}>
                    {row.responsibilities.length
                      ? `Use for ${row.responsibilities.join(', ')}`
                      : row.fallbackCapabilityCount
                        ? `Fallback for ${row.fallbackCapabilityCount} ${row.fallbackCapabilityCount === 1 ? 'capability' : 'capabilities'}`
                        : 'Available lane, not assigned yet'}
                  </div>
                </div>
              ))}
            </div>
          </SettingsGroup>

          <SettingsGroup>
            <div style={{ color: 'var(--ui-text-secondary)' }}>
              Choose a responsibility first. The focused editor below follows the card you select.
            </div>
            <div style={{ display: 'grid', gap: '12px' }}>
              {CAPABILITY_ORDER.map((capability) => {
                const definition = getCapabilityDefinition(draftPolicy, capability)
                const provider = definition?.primary?.provider
                const providerState = getProviderRuntimeState(provider, providerConfigStatus, runtimeStatus)
                const selected = capability === selectedCapability
                return (
                  <button
                    key={`capability-map-${capability}`}
                    type="button"
                    onClick={() => setSelectedCapability(capability)}
                    style={{
                      all: 'unset',
                      boxSizing: 'border-box',
                      width: '100%',
                      textAlign: 'left',
                      padding: '16px',
                      borderRadius: '16px',
                      border: selected ? '1px solid rgba(56,189,248,0.42)' : '1px solid rgba(255,255,255,0.08)',
                      background: selected ? 'rgba(56,189,248,0.08)' : 'rgba(255,255,255,0.03)',
                      display: 'grid',
                      gap: '12px',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      lineHeight: 'inherit',
                    }}
                  >
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                        gap: '16px',
                        alignItems: 'start',
                      }}
                    >
                      <div style={{ display: 'grid', gap: '6px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'start', flexWrap: 'wrap' }}>
                          <strong style={{ color: 'var(--ui-text-primary)' }}>{CAPABILITY_LABELS[capability]}</strong>
                          <span style={{ color: selected ? 'var(--ui-text-primary)' : 'var(--ui-text-muted)', fontSize: '0.78rem', fontWeight: selected ? 700 : 500 }}>
                            {selected ? 'Selected' : definition?.allow_user_override !== false ? 'Flexible' : 'Policy-led'}
                          </span>
                        </div>
                        <div style={{ color: 'var(--ui-text-secondary)', fontSize: '0.92rem', lineHeight: 1.55 }}>
                          {CAPABILITY_DESCRIPTIONS[capability]}
                        </div>
                      </div>
                      <div style={{ display: 'grid', gap: '6px', justifyItems: 'start' }}>
                        <div style={{ color: 'var(--ui-text-primary)', fontWeight: 700 }}>
                          {formatExecutionLane(provider, definition?.primary?.model)}
                        </div>
                        <div style={{ color: 'var(--ui-text-muted)', fontSize: '0.86rem' }}>
                          {definition?.fallbacks?.length ? `${definition.fallbacks.length} fallback${definition.fallbacks.length === 1 ? '' : 's'}` : 'No fallback chain'}
                          {' '}• {providerState.badge}
                        </div>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          </SettingsGroup>
            </SettingsCard>

            <SettingsCard
              title={`${CAPABILITY_LABELS[selectedCapability]} Editor`}
              subtitle="Override this one responsibility, or leave it aligned with the rest of the system."
              status={selectedCapabilityProviderState.tone === 'danger' ? 'warning' : 'success'}
              statusText={selectedCapabilityProviderState.badge}
              glass
            >
              <SettingsGroup divider>
                <div
                  style={{
                    borderRadius: '14px',
                    border: '1px solid rgba(255,255,255,0.08)',
                    background: 'rgba(255,255,255,0.03)',
                    padding: '14px',
                    display: 'grid',
                    gap: '8px',
                  }}
                >
                  <div style={{ color: 'var(--ui-text-muted)', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    Current lane
                  </div>
                  <div style={{ color: 'var(--ui-text-primary)', fontSize: '1.05rem', fontWeight: 700 }}>
                    {formatExecutionLane(selectedCapabilityDefinition?.primary?.provider, selectedCapabilityDefinition?.primary?.model)}
                  </div>
                  <div style={{ color: 'var(--ui-text-secondary)', lineHeight: 1.5 }}>
                    {CAPABILITY_DESCRIPTIONS[selectedCapability]}
                  </div>
                  <div style={{ color: 'var(--ui-text-muted)', fontSize: '0.9rem' }}>
                    {selectedCapabilityProviderState.detail}
                  </div>
                </div>
              </SettingsGroup>
              <CapabilityCard
                key={selectedCapability}
                capability={selectedCapability}
                draftPolicy={draftPolicy}
                setDraftPolicy={setDraftPolicy}
                readOnly={!canEditPolicy}
                embedded
              />
            </SettingsCard>
          </>
        )}

        {activeTab === 'simulator' && (
          <SettingsCard
            title="Resolution Preview"
            subtitle="Test the selected responsibility before a real chat run."
            glass
          >
            <SettingsGroup divider>
              <FormField label="Capability">
                <Select
                  aria-label="Capability"
                  value={selectedCapability}
                  onChange={(e) => setSelectedCapability(e.target.value)}
                >
                  {CAPABILITY_ORDER.map(capability => (
                    <option key={capability} value={capability}>{CAPABILITY_LABELS[capability]}</option>
                  ))}
                </Select>
              </FormField>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <FormField label="Manual provider override">
                  <Select
                    aria-label="Manual provider override"
                    value={manualProvider}
                    onChange={(e) => setManualProvider(e.target.value)}
                  >
                    <option value="">None</option>
                    {Object.keys(MODEL_CATALOG).map(provider => (
                      <option key={provider} value={provider}>{formatProviderName(provider)}</option>
                    ))}
                  </Select>
                </FormField>
                <FormField label="Manual model override">
                  <Select
                    aria-label="Manual model override"
                    value={manualModel}
                    onChange={(e) => setManualModel(e.target.value)}
                    disabled={!manualProvider}
                  >
                    <option value="">{manualProvider ? 'Select model' : 'No override'}</option>
                    {manualProvider && modelOptions(manualProvider).map(model => (
                      <option key={model.id} value={model.id}>{model.name}</option>
                    ))}
                  </Select>
                </FormField>
              </div>
              <div
                aria-label="Execution policy simulator"
                style={{
                  borderRadius: '12px',
                  border: '1px solid rgba(255,255,255,0.08)',
                  padding: '12px',
                  background: 'rgba(255,255,255,0.03)',
                  display: 'grid',
                  gap: '6px',
                }}
              >
                <div>Preview mode: <strong>{canonicalSimulatorPlan ? 'Canonical collector resolution' : 'Local fallback preview'}</strong></div>
                <div>Capability: <strong>{simulatorContext.capabilityContext.capabilityLabel}</strong></div>
                <div>Source: <strong>{getProvenanceSourceLabel(displayedSimulatorPlan.source)}</strong></div>
                <div>Resolved provider/model: <strong>{displayedSimulatorPlan.provider} / {displayedSimulatorPlan.model}</strong></div>
                {displayedSimulatorPlan.source === 'personal_preference' && (
                  <div>Personal preference: <strong>{displayedSimulatorPlan.provider} / {displayedSimulatorPlan.model}</strong></div>
                )}
                {displayedSimulatorPlan.policyLabel && (
                  <div>Policy: <strong>{displayedSimulatorPlan.policyLabel}</strong></div>
                )}
                {simulatorContext.capabilityContext.policyFallbacks?.length > 0 && (
                  <div>Fallback chain: <strong>{simulatorContext.capabilityContext.policyFallbacks.map(step => `${step.provider}/${step.model}`).join(' -> ')}</strong></div>
                )}
                {simulatorLoading && (
                  <div style={{ color: 'var(--ui-text-muted)' }}>Refreshing canonical preview...</div>
                )}
                {simulatorError && (
                  <div style={{ color: 'var(--ui-red-light, #ff8080)' }}>Preview error: {simulatorError}</div>
                )}
              </div>
            </SettingsGroup>

            <SettingsGroup>
              <div style={{ color: 'var(--ui-text-secondary)', lineHeight: 1.6 }}>
                Precedence stays explicit even when this page gets simpler. The first matching choice below wins.
              </div>
              <div style={{ display: 'grid', gap: '8px' }}>
                {ROUTING_PRECEDENCE.map((step, index) => (
                  <div
                    key={`precedence-${index}`}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '28px 1fr',
                      gap: '10px',
                      alignItems: 'start',
                      color: 'var(--ui-text-secondary)',
                    }}
                  >
                    <div
                      style={{
                        width: '28px',
                        height: '28px',
                        borderRadius: '999px',
                        display: 'grid',
                        placeItems: 'center',
                        background: 'rgba(56,189,248,0.12)',
                        color: 'var(--ui-text-primary)',
                        fontWeight: 700,
                      }}
                    >
                      {index + 1}
                    </div>
                    <div>{step}</div>
                  </div>
                ))}
              </div>
              {!canEditPolicy && (
                <div style={{ color: 'var(--ui-text-muted)', fontSize: '0.9rem' }}>
                  Org owners and admins can edit execution policy. Other members can inspect and simulate only.
                </div>
              )}
            </SettingsGroup>
          </SettingsCard>
        )}

        {activeTab === 'readiness' && (
          <SettingsCard
            title="Provider Readiness"
            subtitle="Deeper deployment truth for the lanes you are assigning above."
            status={missingProviderAssignments.length ? 'warning' : 'success'}
            statusText={missingProviderAssignments.length ? 'Attention needed' : 'Providers covered'}
            glass
          >
            <SettingsGroup>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                  gap: '12px',
                }}
              >
                <div style={{ padding: '12px', borderRadius: '12px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                  <div style={{ color: 'var(--ui-text-muted)', fontSize: '0.82rem' }}>Configured providers</div>
                  <div style={{ color: 'var(--ui-text-primary)', fontSize: '1.1rem', fontWeight: 700 }}>{providerReadyCount}</div>
                </div>
                <div style={{ padding: '12px', borderRadius: '12px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                  <div style={{ color: 'var(--ui-text-muted)', fontSize: '0.82rem' }}>Chat runtime</div>
                  <div style={{ color: 'var(--ui-text-primary)', fontSize: '1.1rem', fontWeight: 700 }}>
                    {runtimeStatus?.ready ? 'Ready' : 'Needs attention'}
                  </div>
                </div>
                <div style={{ padding: '12px', borderRadius: '12px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}>
                  <div style={{ color: 'var(--ui-text-muted)', fontSize: '0.82rem' }}>Claude terminal OAuth</div>
                  <div style={{ color: 'var(--ui-text-primary)', fontSize: '1.1rem', fontWeight: 700 }}>
                    {runtimeStatus?.capabilities?.terminalOAuth?.available === false ? 'Unavailable' : 'Available'}
                  </div>
                </div>
              </div>
              {runtimeStatus?.recommendation && (
                <div
                  style={{
                    borderRadius: '12px',
                    border: '1px solid rgba(255,255,255,0.08)',
                    background: 'rgba(255,255,255,0.03)',
                    padding: '12px',
                    display: 'grid',
                    gap: '6px',
                  }}
                >
                  <strong style={{ color: 'var(--ui-text-primary)' }}>Runtime advice</strong>
                  <div style={{ color: 'var(--ui-text-secondary)' }}>{runtimeStatus.recommendation}</div>
                  {runtimeStatus?.readiness?.action && (
                    <div style={{ color: 'var(--ui-text-muted)', fontSize: '0.92rem' }}>{runtimeStatus.readiness.action}</div>
                  )}
                </div>
              )}
              {missingProviderAssignments.length > 0 && (
                <div
                  style={{
                    borderRadius: '12px',
                    border: '1px solid rgba(245, 158, 11, 0.28)',
                    background: 'rgba(245, 158, 11, 0.08)',
                    padding: '12px',
                    display: 'grid',
                    gap: '8px',
                  }}
                >
                  <strong style={{ color: 'var(--ui-text-primary)' }}>Capabilities mapped to unavailable providers</strong>
                  {missingProviderAssignments.map(({ provider, labels }) => (
                    <div key={provider} style={{ color: 'var(--ui-text-secondary)' }}>
                      <strong style={{ color: 'var(--ui-text-primary)' }}>{formatProviderName(provider)}</strong>: {labels.join(', ')}
                    </div>
                  ))}
                </div>
              )}
              <div style={{ color: 'var(--ui-text-secondary)' }}>
                Check provider keys, Vault selections, and Claude terminal auth in <strong style={{ color: 'var(--ui-text-primary)' }}>Settings &gt; Core Integrations</strong>.
              </div>
              <div>
                <button
                  type="button"
                  onClick={() => navigate('/settings#core', { state: { section: 'core' } })}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '8px',
                    color: 'var(--ui-blue, #38bdf8)',
                    textDecoration: 'none',
                    fontWeight: 600,
                    background: 'transparent',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                  }}
                >
                  Open Core Integrations
                </button>
              </div>
            </SettingsGroup>
          </SettingsCard>
        )}

        {validationErrors.length > 0 && (
          <SettingsCard title="Validation Issues" variant="danger">
            <SettingsGroup>
              {validationErrors.map((error) => (
                <div key={error} style={{ color: 'var(--ui-red-light, #ff8080)' }}>{error}</div>
              ))}
            </SettingsGroup>
          </SettingsCard>
        )}

      </SettingsSection>

      <SettingsSection
        title="QuoxHat Modes (Preview)"
        description="Bounded capability profiles that will keep every chat turn inside every provider's tool limit. Preview: pick defaults now; enforcement ships with the turn-manifest phase."
      >
        <QuoxHatPanel
          authFetch={authFetch}
          currentOrg={currentOrg}
          canManageOrg={canEditPolicy}
          onNotification={onNotification}
        />
      </SettingsSection>

      <SettingsSection
        title="Provider Certification"
        description="Which providers can carry a tool manifest, their hard limits, and how each claim was proven."
      >
        <ProviderCertificationPanel authFetch={authFetch} />
      </SettingsSection>

      <SettingsSection
        title="Tool Load per Turn"
        description="What each agent actually carries into a chat turn: resolved tool counts, where they come from, and when a provider cap fired. QuoxHat P0 baseline, read-only."
      >
        <ToolTurnBaselinePanel authFetch={authFetch} />
      </SettingsSection>

      <SettingsSection
        title="Governance Flags"
        description="Runtime behaviour flags that route agent output and destructive actions through governance checks."
      >
        <PlatformFlagsPanel
          group="governance"
          title="Governance & Approval"
          canWrite={canEditPolicy}
          onNotification={onNotification}
          authFetch={authFetch}
        />
      </SettingsSection>
    </div>
  )
}
