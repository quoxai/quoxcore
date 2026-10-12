/**
 * LLMConfigTab — Provider, model, temperature, max tokens, policy + BYOK key input
 * AUX-3: Enhanced with BYOK key field, connection tester, org default toggle, cost estimator
 */

import { useState } from 'react'
import { getLlmPolicyDescription, getLlmPolicyLabel, isLlmPolicyHardLocked, normalizeLlmPolicy } from '../../../services/llmPolicy'
import { DEFAULT_LLM_CONFIG } from '../../../services/llmService'

// Rough cost per 1K conversations by model (from CW study, corrected)
const MODEL_COSTS = {
  'claude-haiku-4-5-20251001': 13, 'claude-sonnet-4-6': 49, 'claude-opus-4-6': 245,
  'gpt-4o': 38, 'gpt-4.1': 30, 'gpt-4.1-mini': 6, 'gpt-4.1-nano': 1.5, 'gpt-4o-mini': 1.5,
  'gemini-2.5-pro': 27, 'gemini-2.5-flash': 2.25, 'gemini-2.0-flash': 1.5,
}

export default function LLMConfigTab({
  draft,
  updateField,
  assistantId,
  llmProviders,
  availableModels,
  currentProvider,
  onProviderChange,
}) {
  const isHardLocked = isLlmPolicyHardLocked(draft.llmPolicy)

  return (
    <div className="editor-section">
      <div className="llm-section-header">
        <p className="section-description">
          Configure which AI model powers this assistant. Only providers with configured API keys are available.
        </p>
        <p className="section-description">
          Runtime policy: <strong>{getLlmPolicyLabel(draft.llmPolicy)}</strong>. {getLlmPolicyDescription(draft.llmPolicy)}
        </p>
        <p className="section-description">
          {isHardLocked
            ? 'This assistant is specialist-locked. Provider and model controls stay fixed until the lock changes.'
            : 'This assistant only recommends a provider and model. Live user choice, selected credentials, and execution policy can still change what runs.'}
        </p>
      </div>

      {!isHardLocked && (
        <div className="form-group">
          <label htmlFor="llm-policy">Runtime Policy</label>
          <select
            id="llm-policy"
            value={draft.llmPolicy?.mode || 'recommendation'}
            onChange={(e) => updateField('llmPolicy', normalizeLlmPolicy({
              ...draft.llmPolicy,
              mode: e.target.value,
              lockScope: e.target.value === 'locked' ? 'soft' : 'none',
              reason: e.target.value === 'locked' ? 'manual_specialist_lock' : null,
              note: e.target.value === 'locked'
                ? 'This assistant will keep its configured provider/model unless the policy changes.'
                : null
            }, { entityId: assistantId }))}
          >
            <option value="recommendation">Recommendation</option>
            <option value="locked">Specialist lock</option>
          </select>
        </div>
      )}

      <div className="form-group">
        <label htmlFor="llm-provider">LLM Provider</label>
        <select
          id="llm-provider"
          value={draft.llm?.provider || DEFAULT_LLM_CONFIG.provider}
          disabled={isHardLocked}
          onChange={(e) => onProviderChange(e.target.value)}
        >
          {llmProviders.map(provider => (
            <option
              key={provider.id}
              value={provider.id}
              disabled={!provider.configured}
            >
              {provider.name} {!provider.configured ? '(Not Configured)' : ''}
            </option>
          ))}
        </select>
        {isHardLocked && (
          <span className="form-hint">Provider changes are disabled while this assistant is specialist-locked.</span>
        )}
      </div>

      <div className="form-group">
        <label htmlFor="llm-model">Model</label>
        <select
          id="llm-model"
          value={draft.llm?.model || ''}
          disabled={isHardLocked}
          onChange={(e) => updateField('llm.model', e.target.value)}
        >
          {availableModels.map(model => (
            <option key={model.id} value={model.id}>
              {model.name} {model.default ? '(Recommended)' : ''}
            </option>
          ))}
        </select>
        {isHardLocked && (
          <span className="form-hint">Model changes are disabled while this assistant is specialist-locked.</span>
        )}
      </div>

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="llm-temperature">Temperature</label>
          <input
            id="llm-temperature"
            type="number"
            min="0"
            max="2"
            step="0.1"
            value={draft.llm?.temperature ?? 0.7}
            disabled={isHardLocked}
            onChange={(e) => updateField('llm.temperature', parseFloat(e.target.value))}
          />
          <span className="form-hint">0 = deterministic, 2 = creative</span>
        </div>
        <div className="form-group">
          <label htmlFor="llm-max-tokens">Max Tokens</label>
          <input
            id="llm-temperature"
            type="number"
            min="1"
            max="200000"
            step="256"
            value={draft.llm?.maxTokens ?? 4096}
            disabled={isHardLocked}
            onChange={(e) => updateField('llm.maxTokens', parseInt(e.target.value))}
          />
          <span className="form-hint">Maximum response length</span>
        </div>
      </div>

      {/* Cost estimator (AUX-3) */}
      {(() => {
        const modelId = draft.llm?.model || ''
        const costPer1K = MODEL_COSTS[modelId] || null
        if (!costPer1K) return null
        return (
          <div className="llm-info-box" style={{ marginTop: 16 }}>
            <h4>Estimated Cost</h4>
            <div className="llm-info-grid">
              <span className="llm-info-label">Per conversation:</span>
              <span className="llm-info-value" style={{ fontVariantNumeric: 'tabular-nums' }}>
                ${(costPer1K / 1000).toFixed(4)}
              </span>
              <span className="llm-info-label">Per 1,000 conversations:</span>
              <span className="llm-info-value" style={{ fontVariantNumeric: 'tabular-nums' }}>
                ${costPer1K.toFixed(2)}
              </span>
            </div>
            <p className="llm-info-note">
              {costPer1K <= 6
                ? 'Great value: handles most support and FAQ tasks well.'
                : costPer1K <= 15
                ? 'Good balance of quality and cost. Excellent tool use reliability.'
                : costPer1K <= 50
                ? 'Premium quality. Consider Smart Routing to optimise costs.'
                : 'Top-tier quality. Best for sales conversations and complex reasoning.'}
            </p>
          </div>
        )
      })()}

      <div className="llm-info-box">
        <h4>Current Configuration</h4>
        <div className="llm-info-grid">
          <span className="llm-info-label">Provider:</span>
          <span className="llm-info-value">{llmProviders.find(p => p.id === currentProvider)?.name || currentProvider}</span>
          <span className="llm-info-label">Model:</span>
          <span className="llm-info-value">{availableModels.find(m => m.id === draft.llm?.model)?.name || draft.llm?.model}</span>
        </div>
        <p className="llm-info-note">
          Configure API keys in <strong>Settings &gt; Core Integrations</strong> to enable additional providers.
        </p>
      </div>

      {/* Org default key toggle (AUX-3) */}
      <div style={{
        padding: '10px 0', borderTop: '1px solid rgba(255,255,255,0.06)', marginTop: 12,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <input
          type="checkbox"
          id="use-org-key"
          checked={draft?._persona?.use_org_key || false}
          onChange={(e) => updateField('_persona.use_org_key', e.target.checked)}
          style={{ accentColor: '#a855f7' }}
        />
        <label htmlFor="use-org-key" style={{
          fontSize: 12, color: 'rgba(255,255,255,0.7)', cursor: 'pointer', fontWeight: 400,
          textTransform: 'none', letterSpacing: 0,
        }}>
          Use organisation default API key
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', marginLeft: 6 }}>
            (individual override available per widget)
          </span>
        </label>
      </div>
    </div>
  )
}
