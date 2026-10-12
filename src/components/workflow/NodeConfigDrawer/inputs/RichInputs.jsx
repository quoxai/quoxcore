/**
 * RichInputs — domain-aware inputs (cron, timezone, model, agent, tools,
 * workflowPicker). Each rides the same { value, onChange, disabled } contract
 * as BasicInputs and pulls its options from the appropriate registry.
 */

import { useEffect, useMemo, useState } from 'react'
import { TextInput, DropdownInput, TagInput } from './BasicInputs'
import { agentRegistry, getAgent, getAllAgents } from '../../../../config/agentRegistry'
import { searchWorkflows, loadWorkflowLibraryIndex } from '../../../../services/workflowLibrary'
import {
  MODEL_CATALOG,
  getModelsForProvider,
  getDefaultModel,
  getAllProviderIds,
  getProviderMeta,
} from '../../../../config/modelCatalog'
import CredentialPicker from '../../../integrations/CredentialPicker'

// =============================================================================
// CRON
// =============================================================================

const CRON_FIELD_LABELS = ['minute', 'hour', 'day', 'month', 'weekday']
const CRON_FIELD_HINTS  = ['0-59', '0-23', '1-31', '1-12', '0-6']

function describeCron(parts) {
  if (parts.length !== 5) return 'Invalid expression — needs 5 fields.'
  const [min, hour, dom, mon, dow] = parts
  if (parts.every((p) => p === '*')) return 'Every minute.'
  if (min === '*' && hour === '*') return 'Every minute.'
  if (min === '0' && hour === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every hour at :00.'
  if (/^\*\/\d+$/.test(min) && hour === '*') {
    const n = min.split('/')[1]
    return `Every ${n} minutes.`
  }
  if (min === '0' && /^\d+$/.test(hour) && dom === '*' && mon === '*' && dow === '*') {
    return `Every day at ${hour.padStart(2, '0')}:00.`
  }
  if (min === '0' && hour === '0' && dom === '*' && mon === '*' && dow === '*') return 'Every day at 00:00 (midnight).'
  if (min === '0' && hour === '*/1') return 'Every hour at :00.'
  return 'Custom schedule.'
}

export function CronInput({ value, onChange, disabled, autoFocus }) {
  const initial = typeof value === 'string' && value.trim() ? value : '0 * * * *'
  const parts = initial.split(/\s+/)
  const valid = parts.length === 5

  const updatePart = (i, next) => {
    const arr = valid ? [...parts] : ['*', '*', '*', '*', '*']
    arr[i] = next
    onChange(arr.join(' '))
  }

  return (
    <div className="ncd-cron">
      <div className="ncd-cron__fields">
        {CRON_FIELD_LABELS.map((label, i) => (
          <div key={label} className="ncd-cron__field">
            <input
              type="text"
              className="qx-input qx-input--mono"
              value={valid ? parts[i] : ''}
              disabled={disabled}
              autoFocus={autoFocus && i === 0}
              placeholder={CRON_FIELD_HINTS[i]}
              onChange={(e) => updatePart(i, e.target.value)}
              spellCheck={false}
            />
            <span className="ncd-cron__label">{label}</span>
          </div>
        ))}
      </div>
      <div className="ncd-cron__raw">
        <input
          type="text"
          className="qx-input qx-input--mono"
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          placeholder="0 * * * *"
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
        />
        <span className="ncd-cron__translation">{describeCron(parts)}</span>
      </div>
    </div>
  )
}

// =============================================================================
// TIMEZONE
// =============================================================================

let cachedTimezones = null
function listTimezones() {
  if (cachedTimezones) return cachedTimezones
  if (typeof Intl !== 'undefined' && typeof Intl.supportedValuesOf === 'function') {
    try {
      cachedTimezones = Intl.supportedValuesOf('timeZone')
      return cachedTimezones
    } catch (_) { /* fallthrough */ }
  }
  cachedTimezones = [
    'UTC',
    'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Stockholm',
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'America/Sao_Paulo',
    'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Singapore', 'Asia/Dubai',
    'Asia/Kolkata',
    'Australia/Sydney', 'Pacific/Auckland',
  ]
  return cachedTimezones
}

function formatOffset(tz) {
  try {
    const dtf = new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'shortOffset' })
    const parts = dtf.formatToParts(new Date())
    const off = parts.find((p) => p.type === 'timeZoneName')?.value
    return off || ''
  } catch (_) {
    return ''
  }
}

export function TimezonePicker({ value, onChange, disabled, autoFocus }) {
  const tzs = listTimezones()
  const offset = formatOffset(value || 'UTC')

  return (
    <div className="ncd-tz">
      <input
        list="ncd-tz-list"
        type="text"
        className="qx-input qx-input--mono"
        value={value ?? 'UTC'}
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
      <datalist id="ncd-tz-list">
        {tzs.map((tz) => <option key={tz} value={tz} />)}
      </datalist>
      {offset && <span className="ncd-tz__offset">{offset}</span>}
    </div>
  )
}

// =============================================================================
// MODEL
// =============================================================================

const KNOWN_MODELS = [
  { id: 'claude-opus-4-7',          label: 'Claude Opus 4.7',          provider: 'Anthropic' },
  { id: 'claude-sonnet-4-6',        label: 'Claude Sonnet 4.6',        provider: 'Anthropic' },
  { id: 'claude-haiku-4-5',         label: 'Claude Haiku 4.5',         provider: 'Anthropic' },
  { id: 'gpt-4.1',                  label: 'GPT-4.1',                  provider: 'OpenAI' },
  { id: 'gpt-4o',                   label: 'GPT-4o',                   provider: 'OpenAI' },
  { id: 'gemini-2.0-pro',           label: 'Gemini 2.0 Pro',           provider: 'Google' },
  { id: 'local',                    label: 'Local inference',          provider: 'Local' },
]

export function ModelDropdown({ value, onChange, disabled }) {
  const options = KNOWN_MODELS.map((m) => ({ id: m.id, label: `${m.label} · ${m.provider}` }))
  return <DropdownInput value={value} onChange={onChange} disabled={disabled} options={options} />
}

// =============================================================================
// AGENT
// =============================================================================

export function AgentDropdown({ value, onChange, disabled }) {
  const options = useMemo(() => {
    return getAllAgents()
      .filter((a) => a.id && a.id !== 'quox')
      .map((a) => ({ id: a.id, label: a.name || a.id }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [])

  return <DropdownInput value={value} onChange={onChange} disabled={disabled} options={options} />
}

// =============================================================================
// TOOLS — multi-select narrowed by the sibling `agent` field
// =============================================================================

export function ToolMultiSelect({ value, onChange, disabled, siblingConfig }) {
  const agentId = siblingConfig?.agent
  const arr = Array.isArray(value) ? value : []

  const available = useMemo(() => {
    if (!agentId) return []
    const agent = getAgent(agentId)
    return Array.isArray(agent?.tools) ? agent.tools : []
  }, [agentId])

  if (!agentId) {
    return <p className="ncd-field__helper">Select an agent first to see its tools.</p>
  }

  const toggle = (tool) => {
    if (disabled) return
    if (arr.includes(tool)) onChange(arr.filter((t) => t !== tool))
    else onChange([...arr, tool])
  }

  const allSelected = available.length > 0 && available.every((t) => arr.includes(t))

  return (
    <div className="ncd-tools">
      <div className="ncd-tools__header">
        <span>{arr.length || 'None'} of {available.length} selected</span>
        <div className="ncd-tools__bulk">
          <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" disabled={disabled || allSelected} onClick={() => onChange([...available])}>
            Select all
          </button>
          <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" disabled={disabled || arr.length === 0} onClick={() => onChange([])}>
            Clear
          </button>
        </div>
      </div>
      <div className="ncd-tools__chips">
        {available.map((tool) => {
          const on = arr.includes(tool)
          return (
            <button
              key={tool}
              type="button"
              disabled={disabled}
              className={`qx-chip ${on ? 'qx-chip--active' : ''}`}
              onClick={() => toggle(tool)}
            >
              {tool}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// =============================================================================
// WORKFLOW PICKER
// =============================================================================

export function WorkflowPicker({ value, onChange, disabled, autoFocus }) {
  const [query, setQuery] = useState(value ?? '')
  const [results, setResults] = useState([])
  const [open, setOpen] = useState(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let mounted = true
    loadWorkflowLibraryIndex().then(() => { if (mounted) setReady(true) }).catch(() => {})
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    if (!ready) return
    if (!query) { setResults([]); return }
    try {
      const r = searchWorkflows(query, { limit: 10 })
      setResults(Array.isArray(r) ? r : [])
    } catch (_) {
      setResults([])
    }
  }, [query, ready])

  return (
    <div className="ncd-workflow-picker">
      <input
        type="text"
        className="qx-input qx-input--mono"
        value={query}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={ready ? 'Type to search…' : 'Loading library…'}
        onChange={(e) => { setQuery(e.target.value); onChange(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        spellCheck={false}
      />
      {open && results.length > 0 && (
        <ul className="ncd-workflow-picker__list">
          {results.map((r) => (
            <li
              key={r.id}
              className="ncd-workflow-picker__item"
              onMouseDown={(e) => {
                e.preventDefault()
                setQuery(r.id)
                onChange(r.id)
                setOpen(false)
              }}
            >
              <span className="ncd-workflow-picker__id">{r.id}</span>
              {r.name && <span className="ncd-workflow-picker__name">{r.name}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// =============================================================================
// LLM PROVIDER  — sources MODEL_CATALOG (+ runtime-registered local providers)
// =============================================================================

export function LLMProviderInput({ value, onChange, disabled, commitMulti }) {
  const options = useMemo(() => {
    return getAllProviderIds().map((id) => {
      const meta = getProviderMeta(id) || MODEL_CATALOG[id]
      return { id, label: meta?.name || id }
    })
  }, [])

  const handleChange = (newProvider) => {
    if (typeof commitMulti === 'function') {
      // Provider change resets model + apiKeyRef so the user can't end up with
      // a Claude model selected against an OpenAI provider, or a vault key
      // pointing at the wrong service.
      const def = getDefaultModel(newProvider)
      commitMulti({ provider: newProvider, model: def?.id || '', apiKeyRef: '' })
    } else {
      onChange(newProvider)
    }
  }

  return <DropdownInput value={value} onChange={handleChange} disabled={disabled} options={options} />
}

// =============================================================================
// LLM MODEL  — depends on the sibling provider field
// =============================================================================

export function LLMModelInput({ value, onChange, disabled, siblingConfig }) {
  const provider = siblingConfig?.provider
  const models = useMemo(() => {
    if (!provider) return []
    return getModelsForProvider(provider).map((m) => ({
      id: m.id,
      label: m.tier ? `${m.name} · ${m.tier}` : m.name,
    }))
  }, [provider])

  if (!provider) {
    return <p className="ncd-field__helper">Select a provider first.</p>
  }
  if (models.length === 0) {
    return <p className="ncd-field__helper">No models registered for {provider}.</p>
  }
  return <DropdownInput value={value} onChange={onChange} disabled={disabled} options={models} />
}

// =============================================================================
// CREDENTIAL  — wraps the existing CredentialPicker, scoped to the
//               provider's vaultType
// =============================================================================

export function CredentialInput({ value, onChange, disabled, siblingConfig }) {
  const provider = siblingConfig?.provider
  const vaultType = useMemo(() => {
    if (!provider) return null
    const meta = getProviderMeta(provider) || MODEL_CATALOG[provider]
    return meta?.vaultType || null
  }, [provider])

  if (!provider) {
    return <p className="ncd-field__helper">Select a provider first.</p>
  }
  if (!vaultType) {
    return <p className="ncd-field__helper">No vault type registered for {provider}.</p>
  }

  return (
    <CredentialPicker
      type={vaultType}
      value={value || ''}
      onSelect={(cred) => onChange(cred?.id || '')}
      compact
      disabled={disabled}
    />
  )
}

// agentRegistry import retained as a side-effect anchor in case extracted helpers
// rely on it being in scope.
void agentRegistry
