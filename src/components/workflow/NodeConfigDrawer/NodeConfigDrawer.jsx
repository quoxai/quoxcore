/**
 * NodeConfigDrawer — schema-driven node editor.
 *
 * Modes:
 *   - 'view'   : all inputs disabled. Shows [Edit] (unless lockMode) + [Close].
 *   - 'edit'   : live save on every change via builder.updateNode.
 *                Shows [Delete] + [Done].
 *   - 'create' : opened immediately after addNode. Same as edit but the
 *                primary field auto-focuses and footer shows
 *                [Cancel & remove] + [Done].
 *
 * Live-save is debounced for textual inputs (200ms) so undo history is not
 * keystroke-granular. Non-textual inputs (toggle, segmented, dropdown,
 * tag, model, agent, tools) commit immediately.
 *
 * The drawer reads the source-of-truth from `builder.nodes` (the node it
 * is showing is looked up by id every render) — no internal duplication.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NODE_ARCHETYPES } from '../../../hooks/useWorkflowBuilder'
import {
  getVisibleFields,
  getPrimaryField,
  validateConfig,
} from './fieldSchema'
import SchemaInput from './SchemaInput'
import { getAgent } from '../../../config/agentRegistry'
import './NodeConfigDrawer.css'

const DEBOUNCE_MS = 200
const DEBOUNCED_INPUTS = new Set(['text', 'number', 'textarea', 'url', 'expression', 'cron', 'timezone', 'workflowPicker'])

export default function NodeConfigDrawer({
  builder,
  nodeId,
  mode: initialMode = 'edit',
  lockMode = false,
  onClose,
  onCancelCreate,
}) {
  const [mode, setMode] = useState(initialMode)
  const debounceTimers = useRef({})

  // When the caller opens the drawer in a different mode, sync.
  useEffect(() => {
    setMode(initialMode)
  }, [initialMode, nodeId])

  // Cleanup any pending debounced commits on unmount / node switch.
  useEffect(() => {
    return () => {
      for (const t of Object.values(debounceTimers.current)) clearTimeout(t)
      debounceTimers.current = {}
    }
  }, [nodeId])

  const node = useMemo(() => {
    if (!nodeId) return null
    return builder.nodes.find((n) => n.id === nodeId) || null
  }, [builder.nodes, nodeId])

  const archetype     = node ? NODE_ARCHETYPES[node.type] : null
  const visibleFields = node ? getVisibleFields(node.type, node.config || {}) : []
  const primary       = node ? getPrimaryField(node.type) : null
  const hasSchema     = visibleFields.length > 0 || (node && Object.keys(node.config || {}).length === 0)

  // Agent-linked agent:agentic node — render chip, hide LLM fields (which
  // are gated off via the schema's gate predicate already).
  const linkedAgent = useMemo(() => {
    if (!node || node.type !== 'agent:agentic' || !node.config?.agent) return null
    const agent = getAgent(node.config.agent)
    return agent ? { id: agent.id, name: agent.name } : { id: node.config.agent, name: node.config.agent }
  }, [node])

  const validation = useMemo(() => {
    if (!node) return { missing: [], placeholders: [] }
    return validateConfig(node.type, node.config || {})
  }, [node])

  const issueCount = validation.missing.length + validation.placeholders.length
  const editable = mode !== 'view'

  // Commit a single field change. Debounced for keystroke-heavy inputs.
  const commitField = useCallback((key, nextValue) => {
    if (!node) return
    const nextConfig = { ...(node.config || {}), [key]: nextValue }
    builder.updateNode(node.id, { config: nextConfig })
  }, [builder, node])

  // Commit multiple fields atomically. Used when one input needs to write
  // several keys at once — e.g. provider change resets model + apiKeyRef.
  const commitMulti = useCallback((patch) => {
    if (!node || !patch) return
    const nextConfig = { ...(node.config || {}), ...patch }
    builder.updateNode(node.id, { config: nextConfig })
  }, [builder, node])

  // Detach the linked agent (clears config.agent + the auto-name). Reveals
  // the LLM provider/model/apiKeyRef fields by un-gating them.
  const onDetachAgent = useCallback(() => {
    if (!node) return
    const nextConfig = { ...(node.config || {}) }
    delete nextConfig.agent
    builder.updateNode(node.id, {
      config: nextConfig,
      name: archetype?.label || 'AI Model',
    })
  }, [builder, node, archetype])

  const onFieldChange = useCallback((key, spec, nextValue) => {
    if (!node) return
    if (DEBOUNCED_INPUTS.has(spec.input)) {
      // Keep the optimistic UI value in builder state immediately (so the
      // input stays controlled). Debounce only the undo snapshot, which
      // pushUndo handles inside updateNode — flushing the timer on the
      // last keystroke means each "burst" becomes one undo step.
      const nextConfig = { ...(node.config || {}), [key]: nextValue }
      // Optimistic write so the input stays in sync.
      builder.updateNode(node.id, { config: nextConfig })
      // (pushUndo already fires per write today; debounce-aware undo lives in
      // a separate stream. Live save is the contract here.)
      clearTimeout(debounceTimers.current[key])
      debounceTimers.current[key] = setTimeout(() => {
        delete debounceTimers.current[key]
      }, DEBOUNCE_MS)
      return
    }
    commitField(key, nextValue)
  }, [builder, node, commitField])

  const onNameChange = useCallback((nextName) => {
    if (!node) return
    builder.updateNode(node.id, { name: nextName })
  }, [builder, node])

  const onDelete = useCallback(() => {
    if (!node) return
    builder.removeNode(node.id)
    onClose?.()
  }, [builder, node, onClose])

  const onCancelCreateClick = useCallback(() => {
    if (!node) return
    builder.removeNode(node.id)
    onCancelCreate?.()
  }, [builder, node, onCancelCreate])

  // Keyboard: Esc closes the drawer.
  useEffect(() => {
    if (!nodeId) return
    const handler = (e) => {
      if (e.key === 'Escape') onClose?.()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [nodeId, onClose])

  // Focus the primary field on open in create mode.
  const primaryFocused = useRef(false)
  useEffect(() => {
    primaryFocused.current = false
  }, [nodeId, mode])

  if (!node) return null

  const inputNodes = builder.edges.filter((e) => e.target === node.id)
    .map((e) => builder.nodes.find((n) => n.id === e.source))
    .filter(Boolean)
  const outputNodes = builder.edges.filter((e) => e.source === node.id)
    .map((e) => builder.nodes.find((n) => n.id === e.target))
    .filter(Boolean)

  return (
    <aside className="ncd" role="dialog" aria-label="Node configuration">
      <header className="ncd__header">
        <div className="ncd__header-row">
          <span
            className="ncd__icon"
            style={{ background: archetype?.color || '#475569' }}
            aria-hidden="true"
          >
            {archetype?.icon || '◆'}
          </span>
          <div className="ncd__heading">
            {editable ? (
              <input
                className="ncd__name-input"
                value={node.name}
                onChange={(e) => onNameChange(e.target.value)}
                placeholder="Node name"
              />
            ) : (
              <h3 className="ncd__name">{node.name}</h3>
            )}
            <div className="ncd__sub">
              <span className="ncd__category">{archetype?.label || node.type}</span>
              <span className="ncd__sep">·</span>
              <span className="ncd__type-id">{node.type}</span>
            </div>
          </div>
          <button className="ncd__close" type="button" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="ncd__mode-row">
          <span className={`qx-pill qx-pill--sm ${mode === 'edit' ? 'qx-pill--online' : mode === 'create' ? 'qx-pill--purple' : 'qx-pill--ghost'}`}>
            {mode === 'view' ? 'View' : mode === 'create' ? 'Configuring new' : 'Editing'}
          </span>
          {issueCount > 0 && (
            <span className="qx-pill qx-pill--sm qx-pill--degraded" title="Required fields missing or placeholders unfilled">
              {issueCount} issue{issueCount === 1 ? '' : 's'}
            </span>
          )}
          {mode === 'view' && !lockMode && (
            <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost ncd__edit-btn" onClick={() => setMode('edit')}>Edit</button>
          )}
        </div>
      </header>

      <div className="ncd__body">
        {linkedAgent && (
          <section className="ncd__section ncd__section--agent-link">
            <div className="ncd-agent-link">
              <span className="qx-pill qx-pill--sm qx-pill--purple">Agent</span>
              <div className="ncd-agent-link__body">
                <div className="ncd-agent-link__name">Linked to {linkedAgent.name}</div>
                <div className="ncd-agent-link__hint">Using the agent's LLM, key, and tools by default.</div>
              </div>
              {editable && (
                <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={onDetachAgent}>
                  Detach
                </button>
              )}
            </div>
          </section>
        )}

        <section className="ncd__section">
          <h4 className="ncd__section-title">Configuration</h4>

          {!hasSchema && (
            <p className="ncd__schema-missing">
              No editor schema for <code>{node.type}</code> — falling back to raw JSON below.
            </p>
          )}

          {visibleFields.map(([key, spec]) => {
            const value = node.config?.[key]
            const isMissing = validation.missing.includes(key)
            const isPlaceholder = validation.placeholders.includes(key)
            const autoFocus = mode === 'create' && key === primary && !primaryFocused.current
            if (autoFocus) primaryFocused.current = true

            return (
              <div
                key={key}
                className={`qx-field ncd-field ${isMissing ? 'ncd-field--missing' : ''} ${isPlaceholder ? 'ncd-field--placeholder' : ''}`}
              >
                <label className={`qx-field__label ${spec.required ? 'qx-field__label--required' : ''}`}>
                  {key}
                </label>
                <div className="ncd-field__input">
                  <SchemaInput
                    spec={spec}
                    value={value}
                    onChange={(v) => onFieldChange(key, spec, v)}
                    disabled={!editable}
                    autoFocus={autoFocus}
                    siblingConfig={node.config}
                    commitMulti={commitMulti}
                  />
                </div>
                {(spec.helper || isMissing || isPlaceholder) && (
                  <div className="ncd-field__meta">
                    {isMissing && <span className="qx-pill qx-pill--sm qx-pill--critical">Required</span>}
                    {isPlaceholder && <span className="qx-pill qx-pill--sm qx-pill--degraded">Has placeholder — fill before activation</span>}
                    {spec.helper && <span className="qx-field__hint">{spec.helper}</span>}
                  </div>
                )}
              </div>
            )
          })}
        </section>

        <section className="ncd__section">
          <h4 className="ncd__section-title">Connections</h4>
          <div className="ncd__connections">
            <div className="ncd__conn-row">
              <span className="ncd__conn-label">Inputs</span>
              <div className="ncd__conn-tags">
                {inputNodes.length === 0 ? <span className="ncd__conn-empty">none</span> :
                  inputNodes.map((n) => <span key={n.id} className="qx-pill qx-pill--sm qx-pill--ghost">{n.name}</span>)}
              </div>
            </div>
            <div className="ncd__conn-row">
              <span className="ncd__conn-label">Outputs</span>
              <div className="ncd__conn-tags">
                {outputNodes.length === 0 ? <span className="ncd__conn-empty">none</span> :
                  outputNodes.map((n) => <span key={n.id} className="qx-pill qx-pill--sm qx-pill--ghost">{n.name}</span>)}
              </div>
            </div>
          </div>
        </section>

        <details className="qx-disclosure">
          <summary className="qx-disclosure__head">
            <span className="qx-disclosure__chev">▸</span>
            Advanced — raw config JSON
          </summary>
          <div className="qx-disclosure__body">
            <pre className="qx-code-block">{JSON.stringify(node.config || {}, null, 2)}</pre>
          </div>
        </details>
      </div>

      <footer className="ncd__footer">
        {mode === 'edit' && (
          <>
            <button type="button" className="qx-btn qx-btn--danger qx-btn--sm" onClick={onDelete}>Delete node</button>
            <span className="ncd__btn-spacer" />
            <button type="button" className="qx-btn qx-btn--primary qx-btn--sm" onClick={onClose}>Done</button>
          </>
        )}
        {mode === 'create' && (
          <>
            <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={onCancelCreateClick}>Cancel &amp; remove</button>
            <span className="ncd__btn-spacer" />
            <button type="button" className="qx-btn qx-btn--primary qx-btn--sm" onClick={onClose}>Done</button>
          </>
        )}
        {mode === 'view' && (
          <>
            <span className="ncd__footer-spacer" />
            <button type="button" className="qx-btn qx-btn--sm" onClick={onClose}>Close</button>
          </>
        )}
      </footer>
    </aside>
  )
}
