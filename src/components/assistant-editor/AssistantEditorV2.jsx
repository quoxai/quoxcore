/**
 * AssistantEditorV2 — Composition root using extracted tab components
 *
 * AUX-1: This is a ZERO FUNCTIONAL CHANGE refactor of AssistantEditor.jsx.
 * All state management, save logic, and data flow are preserved exactly.
 * The only change is: inline tab JSX blocks → imported tab components.
 *
 * Once verified, this replaces AssistantEditor.jsx.
 * The original CSS is preserved via the same inline <style> block.
 */

import React, { useState, useEffect } from 'react'
import './assistant-editor.css'
import {
  getAssistant,
  updateAssistant,
  resetAssistant,
  hasOverrides,
  generateSelfKnowledge
} from '../../services/entityRegistry'
import VisualizationStudioEditor from '../visualizations-v2/settings/VisualizationStudioEditor'
import {
  getAllProviders,
  getModelsForProvider,
  getDefaultModel,
  DEFAULT_LLM_CONFIG
} from '../../services/llmService'
import { normalizeLlmPolicy } from '../../services/llmPolicy'
import { agentRegistry } from '../../config/agentRegistry'
import { resolveAssistantType, getTabsForType, ASSISTANT_TYPE_CONFIGS } from './typeConfig'
import { useVoiceSelector } from '../../hooks/useVoiceSettings'
import { VOICE_LIBRARY } from '../../services/voiceSettings'

// Extracted tab components
import {
  IdentityTab,
  SystemPromptTab,
  VoiceTab,
  LLMConfigTab,
  PersonalityTab,
  RulesTab,
  SafetyTab,
  UISettingsTab,
  DelegationTab,
  QuickActionsTab,
  ToolBuilderTab,
} from './tabs'

// Validation helpers (unchanged)
const validateIdentity = (identity) => {
  const errors = {}
  if (!identity?.name?.trim()) {
    errors.name = 'Display name is required'
  } else if (identity.name.length > 50) {
    errors.name = 'Display name must be 50 characters or less'
  }
  if (!identity?.shortName?.trim()) {
    errors.shortName = 'Short name is required'
  } else if (identity.shortName.length > 2) {
    errors.shortName = 'Short name must be 1-2 characters'
  }
  if (identity?.tagline?.length > 100) {
    errors.tagline = 'Tagline must be 100 characters or less'
  }
  return errors
}

// Transform API assistant format → editor format (copied from original — pure function)
export function transformApiToEditorFormat(apiAssistant) {
  const persona = apiAssistant.persona || JSON.parse(apiAssistant.persona_json || '{}')
  const llm = {
    ...DEFAULT_LLM_CONFIG,
    ...(apiAssistant.llm || {}),
    provider: apiAssistant.llm?.provider || persona.provider || DEFAULT_LLM_CONFIG.provider,
    model: apiAssistant.llm?.model || persona.model || DEFAULT_LLM_CONFIG.model,
    temperature: apiAssistant.llm?.temperature ?? persona.temperature ?? DEFAULT_LLM_CONFIG.temperature,
    maxTokens: apiAssistant.llm?.maxTokens ?? persona.maxTokens ?? persona.max_tokens ?? DEFAULT_LLM_CONFIG.maxTokens
  }
  const llmPolicy = normalizeLlmPolicy(apiAssistant.llmPolicy || apiAssistant.llm?.policy || null, { entityId: apiAssistant.id })
  return {
    id: apiAssistant.id,
    identity: {
      name: apiAssistant.name || 'Unnamed',
      shortName: persona.shortName || apiAssistant.name?.charAt(0) || 'A',
      tagline: apiAssistant.description || '',
      description: apiAssistant.description || '',
      personality: {
        tone: persona.personality?.tone || 'Professional and helpful',
        style: persona.personality?.style || 'detailed',
        traits: persona.personality?.traits || [],
        catchphrases: persona.personality?.catchphrases || []
      },
      color: { primary: persona.color || '#8b5cf6', secondary: 'rgba(255, 255, 255, 0.05)' }
    },
    hierarchy: { role: persona.role || 'specialist', level: persona.level ?? 2, reportsTo: null, manages: [] },
    capabilities: {
      domains: persona.domains || [persona.specialty].filter(Boolean),
      intents: [], toolAccess: 'none',
      toolCapabilities: persona.tools || [], workflows: []
    },
    rules: { always: persona.instructions || [], never: [], escalateTo: null },
    safety: { defconLevel: 'GREEN', requiresApproval: [], autoApproved: [] },
    llm: { provider: llm.provider, model: llm.model, temperature: llm.temperature, maxTokens: llm.maxTokens },
    llmPolicy,
    ui: { settingsEnabled: true, visualizer: { type: 'commander-sigil', pulseSpeed: 'normal' }, suggestions: [] },
    context: { systemPromptAdditions: persona.system_prompt || '' },
    _source: 'api', _persona: persona
  }
}

export default function AssistantEditorV2({
  assistantId,
  assistantSource,
  entityType,
  orgId,
  authFetch,
  onClose,
  onSave,
  onVisualizerChange,
  initialTab = null
}) {
  // ─── State (unchanged) ──────────────────────────────────────────────
  const [assistant, setAssistant] = useState(null)
  const [draft, setDraft] = useState(null)
  const [activeTab, setActiveTab] = useState(initialTab || 'identity')
  const [showPreview, setShowPreview] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editorLoading, setEditorLoading] = useState(false)
  const [validationErrors, setValidationErrors] = useState({})
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [llmProviders, setLlmProviders] = useState([])
  const [voicePreviewing, setVoicePreviewing] = useState(false)

  const isApiSource = assistantSource === 'user' || assistantSource === 'scope'

  // ─── Data Loading (unchanged) ───────────────────────────────────────
  useEffect(() => {
    if (!assistantId) return

    if (isApiSource) {
      if (!authFetch || !orgId) {
        setEditorLoading(true)
        return
      }
      setEditorLoading(true)
      authFetch(`/api/orgs/${orgId}/assistants/${assistantId}`)
        .then(resp => resp.ok ? resp.json() : null)
        .then(data => {
          if (data?.assistant) {
            const transformed = transformApiToEditorFormat(data.assistant)
            setAssistant(transformed)
            const cloned = JSON.parse(JSON.stringify(transformed))
            if (!cloned.llm) cloned.llm = { ...DEFAULT_LLM_CONFIG }
            if (!cloned.llmPolicy) cloned.llmPolicy = normalizeLlmPolicy(null, { entityId: assistantId })
            setDraft(cloned)
          } else {
            setAssistant(null)
            setDraft(null)
          }
        })
        .catch(() => { setAssistant(null); setDraft(null) })
        .finally(() => setEditorLoading(false))
    } else {
      const a = getAssistant(assistantId)
      if (!a) {
        setAssistant(null)
        setDraft(null)
        return
      }
      setAssistant(a)
      const cloned = JSON.parse(JSON.stringify(a))
      if (!cloned.llm) cloned.llm = { ...DEFAULT_LLM_CONFIG }
      if (!cloned.llmPolicy) cloned.llmPolicy = normalizeLlmPolicy(null, { entityId: assistantId })
      setDraft(cloned)
    }
  }, [assistantId, assistantSource, orgId, authFetch])

  useEffect(() => { getAllProviders().then(setLlmProviders) }, [])

  // Voice hook (must be called before early return)
  const { voicesByCategory, agents, setAgentVoice, VOICE_CATEGORIES } = useVoiceSelector()

  // ─── Early returns (unchanged) ──────────────────────────────────────
  if (editorLoading) {
    return (
      <div className="assistant-editor" style={{ padding: '32px', textAlign: 'center' }}>
        <p style={{ color: 'rgba(255, 255, 255, 0.6)', fontSize: '13px' }}>Loading assistant...</p>
      </div>
    )
  }

  if (!assistant || !draft) {
    return (
      <div className="assistant-editor" style={{ padding: '32px', textAlign: 'center' }}>
        <p style={{ color: 'rgba(255, 255, 255, 0.6)', fontSize: '13px', marginBottom: '16px' }}>
          Assistant not found.
        </p>
        <button className="cancel-btn" onClick={onClose}>Back to List</button>
      </div>
    )
  }

  // ─── Derived state (unchanged) ──────────────────────────────────────
  const isCustomized = hasOverrides(assistantId)
  const isAgent = entityType === 'agent' || ['specialist', 'analyst'].includes(draft?.hierarchy?.role)
  const registryEntry = agentRegistry.agents?.[assistantId] || {}
  const currentAgent = agents.find(a => a.agentId === assistantId)
  const currentVoiceKey = currentAgent?.voiceKey || 'american_female_1'
  const currentVoice = VOICE_LIBRARY[currentVoiceKey]
  const currentProvider = draft?.llm?.provider || DEFAULT_LLM_CONFIG.provider
  const availableModels = getModelsForProvider(currentProvider)

  // ─── Handlers (unchanged) ───────────────────────────────────────────
  const updateField = (path, value) => {
    setDraft(prev => {
      const next = { ...prev }
      const parts = path.split('.')
      let current = next
      for (let i = 0; i < parts.length - 1; i++) {
        current[parts[i]] = { ...current[parts[i]] }
        current = current[parts[i]]
      }
      current[parts[parts.length - 1]] = value
      return next
    })
  }

  const handleProviderChange = (newProvider) => {
    const defaultModel = getDefaultModel(newProvider)
    updateField('llm.provider', newProvider)
    updateField('llm.model', defaultModel)
  }

  const handleSave = async () => {
    const identityErrors = validateIdentity(draft?.identity)
    if (Object.keys(identityErrors).length > 0) {
      setValidationErrors(identityErrors)
      setActiveTab('identity')
      return
    }
    setValidationErrors({})
    setSaving(true)
    try {
      if (isApiSource && authFetch && orgId) {
        const persona = {
          system_prompt: draft.context?.systemPromptAdditions || '',
          personality: draft.identity?.personality,
          model: draft.llm?.model,
          temperature: draft.llm?.temperature,
          tools: draft.capabilities?.toolCapabilities || [],
          shortName: draft.identity?.shortName,
          color: draft.identity?.color?.primary,
          role: draft.hierarchy?.role,
          level: draft.hierarchy?.level,
          specialty: assistant._persona?.specialty || '',
          instructions: draft.rules?.always || [],
        }
        const resp = await authFetch(`/api/orgs/${orgId}/assistants/${assistantId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: draft.identity?.name,
            description: draft.identity?.tagline || draft.identity?.description,
            persona,
            llm: draft.llm,
            llmPolicy: draft.llmPolicy
          })
        })
        if (resp.ok) {
          onSave?.()
          setSaveSuccess(true)
          setTimeout(() => setSaveSuccess(false), 2000)
        }
      } else {
        const updated = updateAssistant(assistantId, draft)
        if (updated) {
          setAssistant(updated)
          onSave?.(updated)
          setSaveSuccess(true)
          setTimeout(() => setSaveSuccess(false), 2000)
        }
      }
    } finally {
      setSaving(false)
    }
  }

  const handleReset = () => {
    if (confirm('Reset all custom settings for this assistant to defaults?')) {
      const reset = resetAssistant(assistantId)
      if (reset) {
        setAssistant(reset)
        setDraft(JSON.parse(JSON.stringify(reset)))
      }
    }
  }

  const handleVoicePreview = async () => {
    if (voicePreviewing) return
    setVoicePreviewing(true)
    try {
      const agentName = draft?.identity?.name || assistantId
      const tagline = draft?.identity?.tagline || 'I help with various tasks'
      const previewText = `I am ${agentName}. ${tagline}.`
      const voice = VOICE_LIBRARY[currentVoiceKey]
      if (!voice?.voiceId) { setVoicePreviewing(false); return }
      const resp = await fetch('/webhook/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: previewText, voice_id: voice.voiceId, model_id: 'eleven_multilingual_v2' })
      })
      if (resp.ok) {
        const blob = await resp.blob()
        const url = URL.createObjectURL(blob)
        const audio = new Audio(url)
        audio.onended = () => { URL.revokeObjectURL(url); setVoicePreviewing(false) }
        audio.onerror = () => { URL.revokeObjectURL(url); setVoicePreviewing(false) }
        await audio.play()
      } else { setVoicePreviewing(false) }
    } catch { setVoicePreviewing(false) }
  }

  // ─── Type-aware tab config (AUX-2) ──────────────────────────────────
  const assistantType = resolveAssistantType({ ...draft, ...assistant, _source: isApiSource ? 'api' : 'core' })
  const typeConfig = ASSISTANT_TYPE_CONFIGS[assistantType] || ASSISTANT_TYPE_CONFIGS.agent

  // Tab label map — maps tab IDs to human-readable labels
  const TAB_LABELS = {
    'identity': 'Identity', 'personality': 'Personality', 'system-prompt': 'System Prompt',
    'voice': 'Voice', 'llm': 'LLM', 'tools': 'Tools & Workflows', 'quick-actions': 'Quick Actions',
    'delegation': 'Delegation', 'safety': 'Safety', 'visualization': 'Visualiser', 'ui': 'UI',
    'rules': 'Rules', 'team-members': 'Team Members',
    // Chatbot placeholders (CW fills these)
    'knowledge': 'Knowledge', 'training': 'Training', 'style': 'Style',
    'actions': 'Actions', 'analytics': 'Analytics', 'logs': 'Logs',
    'budget': 'Budget', 'settings': 'Settings',
  }

  // Build tab list from type config, filtering out system-prompt for CORE agents
  const configuredTabs = getTabsForType(assistantType)
  const tabs = configuredTabs
    .filter(id => {
      // system-prompt only for API-source entities
      if (id === 'system-prompt' && !isApiSource) return false
      return true
    })
    .map(id => ({ id, label: TAB_LABELS[id] || id }))

  // ─── Shared props for tabs ──────────────────────────────────────────
  const tabProps = { draft, updateField, validationErrors, assistantId, registryEntry, authFetch, orgId }

  // ─── Render ─────────────────────────────────────────────────────────
  return (
    <div className="assistant-editor">
      {/* Header (unchanged) */}
      <div className="editor-header">
        <div className="editor-title">
          <div className="editor-avatar" style={{ backgroundColor: `${draft.identity.color.primary}20`, borderColor: draft.identity.color.primary }}>
            <span style={{ color: draft.identity.color.primary }}>{draft.identity.shortName}</span>
          </div>
          <div>
            <h2>{draft.identity.name}</h2>
            <span className="editor-subtitle">
              {draft.identity.tagline}
              {typeConfig && (
                <span style={{
                  marginLeft: 8, fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 4,
                  background: `${typeConfig.accent}15`, color: typeConfig.accent, border: `1px solid ${typeConfig.accent}33`,
                }}>
                  {typeConfig.label}
                </span>
              )}
            </span>
          </div>
        </div>
        <div className="editor-actions">
          {isCustomized && <button className="reset-btn" onClick={handleReset}>Reset to Default</button>}
          <button className="preview-btn" onClick={() => setShowPreview(!showPreview)}>
            {showPreview ? 'Hide Preview' : 'Preview Context'}
          </button>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
      </div>

      {/* Tabs (unchanged) */}
      <div className="editor-tabs">
        {tabs.map(tab => (
          <button key={tab.id} className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`} onClick={() => setActiveTab(tab.id)}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content — now using extracted tab components */}
      <div className="editor-content">
        {showPreview ? (
          <div className="context-preview">
            <h4>Self-Knowledge Context (injected into LLM calls)</h4>
            <pre>{generateSelfKnowledge(assistantId)}</pre>
          </div>
        ) : (
          <>
            {activeTab === 'identity' && <IdentityTab {...tabProps} />}
            {activeTab === 'system-prompt' && <SystemPromptTab {...tabProps} />}
            {activeTab === 'voice' && (
              <VoiceTab
                {...tabProps}
                currentVoiceKey={currentVoiceKey}
                currentVoice={currentVoice}
                voicesByCategory={voicesByCategory}
                VOICE_CATEGORIES={VOICE_CATEGORIES}
                setAgentVoice={setAgentVoice}
                voicePreviewing={voicePreviewing}
                onVoicePreview={handleVoicePreview}
              />
            )}
            {activeTab === 'llm' && (
              <LLMConfigTab
                {...tabProps}
                llmProviders={llmProviders}
                availableModels={availableModels}
                currentProvider={currentProvider}
                onProviderChange={handleProviderChange}
              />
            )}
            {activeTab === 'personality' && <PersonalityTab {...tabProps} />}
            {activeTab === 'rules' && <RulesTab {...tabProps} />}
            {activeTab === 'safety' && <SafetyTab {...tabProps} />}
            {activeTab === 'ui' && <UISettingsTab {...tabProps} />}
            {activeTab === 'tools' && <ToolBuilderTab {...tabProps} />}
            {activeTab === 'delegation' && <DelegationTab {...tabProps} />}
            {activeTab === 'visualization' && (
              <VisualizationStudioEditor assistantId={assistantId} onRefresh={onVisualizerChange} />
            )}
            {activeTab === 'quick-actions' && <QuickActionsTab {...tabProps} />}
            {/* Placeholder tabs for types that don't have components yet (AUX-2) */}
            {['knowledge', 'training', 'style', 'actions', 'analytics', 'logs', 'budget', 'settings', 'team-members'].includes(activeTab) && (
              <div className="editor-section" style={{ textAlign: 'center', padding: '40px 20px' }}>
                <div style={{ fontSize: '32px', marginBottom: '12px', opacity: 0.6 }}>
                  {activeTab === 'knowledge' ? '📚' : activeTab === 'training' ? '🏋️' : activeTab === 'style' ? '🎨' :
                   activeTab === 'actions' ? '⚡' : activeTab === 'analytics' ? '📊' : activeTab === 'logs' ? '📜' :
                   activeTab === 'budget' ? '💰' : activeTab === 'settings' ? '⚙️' : activeTab === 'team-members' ? '👥' :
                   activeTab === 'quick-actions' ? '⚡' : '📋'}
                </div>
                <h3 style={{ color: '#fff', margin: '0 0 8px', fontSize: '16px' }}>
                  {TAB_LABELS[activeTab] || activeTab}
                </h3>
                <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: '13px', margin: 0 }}>
                  {['knowledge', 'training', 'style', 'actions', 'analytics', 'logs', 'budget', 'settings'].includes(activeTab)
                    ? 'Coming in QuoxChat (Stream CW)'
                    : 'Coming in a future AUX phase'}
                </p>
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer — hidden on visualization tab (Studio editor has its own save) */}
      {activeTab !== 'visualization' && (
        <div className="editor-footer">
          {Object.keys(validationErrors).length > 0 && (
            <span className="editor-footer__error" role="alert">Please fix the errors above before saving</span>
          )}
          {saveSuccess && (
            <span className="editor-footer__success" role="status">Changes saved successfully</span>
          )}
          <button className="cancel-btn" onClick={onClose}>Cancel</button>
          <button className={`save-btn ${saveSuccess ? 'save-btn--success' : ''}`} onClick={handleSave} disabled={saving} aria-busy={saving}>
            {saving ? 'Saving...' : saveSuccess ? 'Saved!' : 'Save Changes'}
          </button>
        </div>
      )}
    </div>
  )
}
