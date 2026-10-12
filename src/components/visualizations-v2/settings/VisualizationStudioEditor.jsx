import { useEffect, useMemo, useState } from 'react'
import VisualizerHost from '../VisualizerHost'
import {
  ensureVisualizationStudioMigration,
  getVisualizationStudioAssignment,
  saveVisualizationStudioAssignment,
  applyPremiumDefaults,
  getBackgroundOpacity,
  setBackgroundOpacity
} from '../../../services/visualizationStudioService'
import { getVisualizationSettings } from '../../../services/visualizationService'
import { getVisualizationStudioRenderer, getVisualizationStudioRenderers } from '../registry/renderers'
import { getBlackSunConfig } from '../renderers/BlackSunVisualizer'
import { getAnnotationLensConfig } from '../renderers/AnnotationLensVisualizer'
import { getBrowserLensConfig } from '../renderers/BrowserLensVisualizer'
import { getCathedralOfMindsConfig } from '../renderers/CathedralOfMindsVisualizer'
import { getCipherMeshConfig } from '../renderers/CipherMeshVisualizer'
import { getCommanderSigilConfig } from '../renderers/CommanderSigilVisualizer'
import { getMomentumBoardConfig } from '../renderers/MomentumBoardVisualizer'
import { getPrismConfig } from '../renderers/PrismVisualizer'
import { getPrototypeConfig } from '../renderers/PrototypeVisualizer'
import { getTriageLanesConfig } from '../renderers/TriageLanesVisualizer'

const PREVIEW_STATES = ['idle', 'listening', 'thinking', 'speaking', 'error']
const TUNABLE_KEYS = ['energy', 'pulse', 'ringSpeed', 'scannerSpeed', 'barGain', 'orbitCount', 'jitter']
const TUNABLE_META = {
  energy: { min: 0, max: 1.5, step: 0.01 },
  pulse: { min: 0, max: 1.4, step: 0.01 },
  ringSpeed: { min: 0, max: 2.4, step: 0.01 },
  scannerSpeed: { min: 0, max: 2.4, step: 0.01 },
  barGain: { min: 0, max: 1.5, step: 0.01 },
  orbitCount: { min: 1, max: 16, step: 1 },
  jitter: { min: 0, max: 1, step: 0.01 }
}
const PRISM_GLOBAL_META = {
  glass: { label: 'Glass', min: 0.2, max: 1.4, step: 0.01 },
  vibrance: { label: 'Vibrance', min: 0.2, max: 1.6, step: 0.01 }
}
const PRISM_STATE_META = {
  sourceDrift: { label: 'Source Drift', min: 0, max: 1.4, step: 0.01 },
  refraction: { label: 'Refraction', min: 0.1, max: 1.5, step: 0.01 }
}
const TRIAGE_GLOBAL_META = {
  laneSpread: { label: 'Lane Spread', min: 0.76, max: 1.24, step: 0.01 },
  reviewFocus: { label: 'Review Focus', min: 0.2, max: 1.4, step: 0.01 }
}
const TRIAGE_STATE_META = {
  queueDepth: { label: 'Queue Depth', min: 0.2, max: 1.6, step: 0.01 },
  sortSnap: { label: 'Sort Snap', min: 0.2, max: 1.4, step: 0.01 }
}
const COMMANDER_GLOBAL_META = {
  crownGlow: { label: 'Crown Glow', min: 0.2, max: 1.4, step: 0.01 },
  scopeRadius: { label: 'Scope Radius', min: 0.76, max: 1.3, step: 0.01 }
}
const COMMANDER_STATE_META = {
  voiceRipple: { label: 'Voice Ripple', min: 0.2, max: 1.5, step: 0.01 },
  delegation: { label: 'Delegation', min: 0.1, max: 1.5, step: 0.01 }
}
const INSIGHT_GLOBAL_META = {
  lensDepth: { label: 'Lens Depth', min: 0.7, max: 1.4, step: 0.01 },
  annotationGlow: { label: 'Annotation Glow', min: 0.2, max: 1.4, step: 0.01 }
}
const INSIGHT_STATE_META = {
  traceSpread: { label: 'Trace Spread', min: 0.2, max: 1.4, step: 0.01 },
  annotationDensity: { label: 'Annotation Density', min: 0.2, max: 1.4, step: 0.01 }
}
const BROWSER_GLOBAL_META = {
  glassDepth: { label: 'Glass Depth', min: 0.7, max: 1.4, step: 0.01 },
  refraction: { label: 'Refraction', min: 0.2, max: 1.4, step: 0.01 },
  chromeParallax: { label: 'Chrome Parallax', min: 0.2, max: 1.4, step: 0.01 }
}
const BROWSER_STATE_META = {
  selectorDensity: { label: 'Selector Density', min: 0.2, max: 1.6, step: 0.01 },
  focusLock: { label: 'Focus Lock', min: 0.2, max: 1.4, step: 0.01 }
}
const MOMENTUM_GLOBAL_META = {
  laneFlow: { label: 'Lane Flow', min: 0.4, max: 1.5, step: 0.01 },
  streakGlow: { label: 'Streak Glow', min: 0.2, max: 1.6, step: 0.01 },
  glassBoard: { label: 'Glass Board', min: 0.6, max: 1.5, step: 0.01 }
}
const MOMENTUM_STATE_META = {
  cardDensity: { label: 'Card Density', min: 0.3, max: 1.6, step: 0.01 },
  priorityHeat: { label: 'Priority Heat', min: 0.2, max: 1.5, step: 0.01 },
  delegateThreads: { label: 'Delegate Threads', min: 0, max: 1.5, step: 0.01 }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function createLegacyStateSettings(legacyConfig = {}) {
  return legacyConfig.stateSettings || {
    idle: { speed: 0.3, scale: legacyConfig.scale ?? 1.0, sensitivity: 0.5, hue: legacyConfig.stateColors?.idle ?? 200 },
    listening: { speed: 0.5, scale: (legacyConfig.scale ?? 1.0) * 1.1, sensitivity: 0.7, hue: legacyConfig.stateColors?.listening ?? 160 },
    speaking: { speed: 0.8, scale: (legacyConfig.scale ?? 1.0) * 1.2, sensitivity: 0.9, hue: legacyConfig.stateColors?.speaking ?? 0 },
    thinking: { speed: 1.2, scale: legacyConfig.scale ?? 1.0, sensitivity: 0.6, hue: legacyConfig.stateColors?.thinking ?? 280 },
    error: { speed: 0.5, scale: legacyConfig.scale ?? 1.0, sensitivity: 0.5, hue: legacyConfig.stateColors?.error ?? 0 }
  }
}

function hueToHex(hue) {
  const normalized = ((hue % 360) + 360) % 360
  const c = 1
  const x = 1 - Math.abs(((normalized / 60) % 2) - 1)
  let r = 0
  let g = 0
  let b = 0

  if (normalized < 60) [r, g, b] = [c, x, 0]
  else if (normalized < 120) [r, g, b] = [x, c, 0]
  else if (normalized < 180) [r, g, b] = [0, c, x]
  else if (normalized < 240) [r, g, b] = [0, x, c]
  else if (normalized < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]

  const toHex = (value) => Math.round((value * 255)).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

function hexToHue(hex) {
  const normalized = hex.replace('#', '')
  if (normalized.length !== 6) return 0
  const r = parseInt(normalized.slice(0, 2), 16) / 255
  const g = parseInt(normalized.slice(2, 4), 16) / 255
  const b = parseInt(normalized.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  if (delta === 0) return 0
  let hue
  if (max === r) hue = ((g - b) / delta) % 6
  else if (max === g) hue = (b - r) / delta + 2
  else hue = (r - g) / delta + 4
  return Math.round(((hue * 60) + 360) % 360)
}

export default function VisualizationStudioEditor({ assistantId, onRefresh }) {
  const [savedAssignment, setSavedAssignment] = useState(() => getVisualizationStudioAssignment(assistantId))
  const [draftAssignment, setDraftAssignment] = useState(() => getVisualizationStudioAssignment(assistantId))
  const [previewState, setPreviewState] = useState('idle')
  const [bgOpacity, setBgOpacity] = useState(() => getBackgroundOpacity())

  useEffect(() => {
    ensureVisualizationStudioMigration()
    const nextAssignment = getVisualizationStudioAssignment(assistantId)
    setSavedAssignment(nextAssignment)
    setDraftAssignment(nextAssignment)
  }, [assistantId])

  const renderers = useMemo(() => getVisualizationStudioRenderers(), [])
  const assignment = draftAssignment
  const renderer = getVisualizationStudioRenderer(assignment?.rendererId)
  const activeStateOverrides = assignment?.overrides?.states?.[previewState] || {}
  const effectiveConfig = useMemo(() => {
    if (!assignment) return { global: {}, state: {} }
    if (renderer.id === 'black-sun' || renderer.id === 'tropical-iris') {
      return getBlackSunConfig(assignment.presetId || renderer.defaultPresetId, assignment.overrides, previewState)
    }
    if (renderer.id === 'cathedral-of-minds') {
      return getCathedralOfMindsConfig(assignment.presetId || renderer.defaultPresetId, assignment.overrides, previewState)
    }
    if (renderer.id === 'cipher-mesh') {
      return getCipherMeshConfig(assignment.presetId || renderer.defaultPresetId, assignment.overrides, previewState)
    }
    if (renderer.id === 'prism-spectrum') {
      return getPrismConfig(assignment.presetId || renderer.defaultPresetId, assignment.overrides, previewState)
    }
    if (renderer.id === 'triage-lanes') {
      return getTriageLanesConfig(assignment.presetId || renderer.defaultPresetId, assignment.overrides, previewState)
    }
    if (renderer.id === 'commander-sigil') {
      return getCommanderSigilConfig(assignment.presetId || renderer.defaultPresetId, assignment.overrides, previewState)
    }
    if (renderer.id === 'annotation-lens') {
      return getAnnotationLensConfig(assignment.presetId || renderer.defaultPresetId, assignment.overrides, previewState)
    }
    if (renderer.id === 'browser-lens') {
      return getBrowserLensConfig(assignment.presetId || renderer.defaultPresetId, assignment.overrides, previewState)
    }
    if (renderer.id === 'momentum-board') {
      return getMomentumBoardConfig(assignment.presetId || renderer.defaultPresetId, assignment.overrides, previewState)
    }
    if ([
      'jarvis-command-hud',
      'orbital-cathedral',
      'signal-bloom',
      'mind-swarm',
      'living-ink',
      'gaia-eye'
    ].includes(renderer.id)) {
      return getPrototypeConfig(renderer.id, assignment.presetId || renderer.defaultPresetId, assignment.overrides, previewState)
    }
    return {
      global: assignment?.overrides?.global || {},
      state: assignment?.overrides?.states?.[previewState] || {}
    }
  }, [assignment, previewState, renderer])
  const nativeRenderer = renderer.family !== 'legacy'
  const isPrismRenderer = renderer.id === 'prism-spectrum'
  const isTriageRenderer = renderer.id === 'triage-lanes'
  const isCommanderRenderer = renderer.id === 'commander-sigil'
  const isInsightRenderer = renderer.id === 'annotation-lens'
  const isBrowserRenderer = renderer.id === 'browser-lens'
  const isMomentumRenderer = renderer.id === 'momentum-board'
  const legacyConfig = useMemo(() => {
    if (nativeRenderer) return null
    const fallback = getVisualizationSettings(assistantId)?.config || {}
    const stored = assignment?.overrides?.legacyConfig || {}
    const merged = {
      ...fallback,
      ...stored,
      stateColors: {
        ...(fallback.stateColors || {}),
        ...(stored.stateColors || {})
      }
    }
    merged.stateSettings = createLegacyStateSettings(merged)
    return merged
  }, [assistantId, assignment, nativeRenderer])
  const effectiveStateConfig = effectiveConfig.state || {}
  const effectiveGlobalConfig = effectiveConfig.global || {}
  const hasUnsavedChanges = useMemo(
    () => JSON.stringify(draftAssignment || null) !== JSON.stringify(savedAssignment || null),
    [draftAssignment, savedAssignment]
  )

  const handleRendererChange = (rendererId) => {
    const nextRenderer = getVisualizationStudioRenderer(rendererId)
    setDraftAssignment({
      rendererId,
      presetId: nextRenderer.defaultPresetId,
      source: 'studio',
      overrides: {
        global: {},
        states: {},
        legacyConfig: assignment?.overrides?.legacyConfig ? clone(assignment.overrides.legacyConfig) : undefined
      }
    })
  }

  const handleStateOverrideChange = (key, value) => {
    setDraftAssignment({
      ...assignment,
      overrides: {
        ...assignment?.overrides,
        states: {
          ...(assignment?.overrides?.states || {}),
          [previewState]: {
            ...(assignment?.overrides?.states?.[previewState] || {}),
            [key]: value
          }
        }
      }
    })
  }

  const handleGlobalOverrideChange = (key, value) => {
    setDraftAssignment({
      ...assignment,
      overrides: {
        ...assignment?.overrides,
        global: {
          ...(assignment?.overrides?.global || {}),
          [key]: value
        }
      }
    })
  }

  const activeRendererId = assignment?.rendererId || renderer.id
  const paletteLocked = assignment?.presetId === 'tropical-iris' || isCommanderRenderer

  const getLegacyStateSetting = (key) => {
    if (!legacyConfig) return key === 'scale' ? 1.0 : key === 'hue' ? 200 : 0.5
    return legacyConfig.stateSettings?.[previewState]?.[key]
      ?? (key === 'hue' ? legacyConfig.stateColors?.[previewState] : undefined)
      ?? legacyConfig[key]
      ?? (key === 'scale' ? 1.0 : key === 'hue' ? 200 : 0.5)
  }

  const handlePresetChange = (presetId) => {
    setDraftAssignment({
      ...assignment,
      presetId
    })
  }

  const handleRandomizeState = () => {
    const current = activeStateOverrides || {}
    const nextState = {
      energy: clamp((current.energy ?? 0.32) + (Math.random() - 0.5) * 0.5, 0.08, 1.35),
      pulse: clamp((current.pulse ?? 0.18) + (Math.random() - 0.5) * 0.5, 0.04, 1.3),
      ringSpeed: clamp((current.ringSpeed ?? 0.18) + (Math.random() - 0.5) * 0.5, 0.04, 2.2),
      scannerSpeed: clamp((current.scannerSpeed ?? 0.18) + (Math.random() - 0.5) * 0.7, 0.02, 2.2),
      barGain: clamp((current.barGain ?? 0.22) + (Math.random() - 0.5) * 0.7, 0.04, 1.35),
      orbitCount: Math.round(clamp((current.orbitCount ?? 5) + (Math.random() - 0.5) * 5, 1, 16)),
      jitter: clamp((current.jitter ?? 0.03) + (Math.random() - 0.5) * 0.22, 0, 0.8)
    }
    if (isPrismRenderer) {
      nextState.sourceDrift = clamp((current.sourceDrift ?? 0.24) + (Math.random() - 0.5) * 0.4, 0, 1.4)
      nextState.refraction = clamp((current.refraction ?? 0.56) + (Math.random() - 0.5) * 0.4, 0.1, 1.5)
    }
    if (isTriageRenderer) {
      nextState.queueDepth = clamp((current.queueDepth ?? 0.6) + (Math.random() - 0.5) * 0.5, 0.2, 1.6)
      nextState.sortSnap = clamp((current.sortSnap ?? 0.7) + (Math.random() - 0.5) * 0.4, 0.2, 1.4)
    }
    if (isCommanderRenderer) {
      nextState.voiceRipple = clamp((current.voiceRipple ?? 0.64) + (Math.random() - 0.5) * 0.5, 0.2, 1.5)
      nextState.delegation = clamp((current.delegation ?? 0.62) + (Math.random() - 0.5) * 0.5, 0.1, 1.5)
    }
    if (isInsightRenderer) {
      nextState.traceSpread = clamp((current.traceSpread ?? 0.64) + (Math.random() - 0.5) * 0.45, 0.2, 1.4)
      nextState.annotationDensity = clamp((current.annotationDensity ?? 0.72) + (Math.random() - 0.5) * 0.45, 0.2, 1.4)
    }
    if (isBrowserRenderer) {
      nextState.selectorDensity = clamp((current.selectorDensity ?? 0.72) + (Math.random() - 0.5) * 0.45, 0.2, 1.6)
      nextState.focusLock = clamp((current.focusLock ?? 0.8) + (Math.random() - 0.5) * 0.35, 0.2, 1.4)
    }
    if (isMomentumRenderer) {
      nextState.cardDensity = clamp((current.cardDensity ?? 0.8) + (Math.random() - 0.5) * 0.45, 0.3, 1.6)
      nextState.priorityHeat = clamp((current.priorityHeat ?? 0.82) + (Math.random() - 0.5) * 0.35, 0.2, 1.5)
      nextState.delegateThreads = clamp((current.delegateThreads ?? 0.46) + (Math.random() - 0.5) * 0.45, 0, 1.5)
    }

    setDraftAssignment({
      ...assignment,
      overrides: {
        ...assignment?.overrides,
        states: {
          ...(assignment?.overrides?.states || {}),
          [previewState]: {
            ...(assignment?.overrides?.states?.[previewState] || {}),
            ...nextState
          }
        }
      }
    })
  }

  const handleColorChange = (key, hex) => {
    setDraftAssignment({
      ...assignment,
      overrides: {
        ...assignment?.overrides,
        states: {
          ...(assignment?.overrides?.states || {}),
          [previewState]: {
            ...(assignment?.overrides?.states?.[previewState] || {}),
            [key]: hexToHue(hex)
          }
        }
      }
    })
  }

  const handleLegacyStateSettingChange = (key, value) => {
    const baseConfig = legacyConfig || getVisualizationSettings(assistantId)?.config || {}
    const nextStateSettings = {
      ...createLegacyStateSettings(baseConfig),
      [previewState]: {
        ...createLegacyStateSettings(baseConfig)[previewState],
        [key]: value
      }
    }
    const nextLegacyConfig = {
      ...baseConfig,
      stateSettings: nextStateSettings,
      stateColors: {
        ...(baseConfig.stateColors || {}),
        ...(key === 'hue' ? { [previewState]: value } : {})
      }
    }
    setDraftAssignment({
      ...assignment,
      overrides: {
        ...assignment?.overrides,
        legacyConfig: nextLegacyConfig
      }
    })
  }

  const renderNativeSlider = (key, meta, value, onChange) => (
    <label key={key}>
      <span>{meta.label || key}</span>
      <div className="viz-studio-editor__slider-row">
        <input
          type="range"
          min={meta.min}
          max={meta.max}
          step={meta.step}
          value={value ?? meta.min}
          onChange={(event) => onChange(event.target.value)}
        />
        <code>{Number(value ?? meta.min).toFixed(2)}</code>
      </div>
    </label>
  )

  const handleSaveChanges = () => {
    const saved = saveVisualizationStudioAssignment(assistantId, draftAssignment)
    setSavedAssignment(saved)
    setDraftAssignment(saved)
    onRefresh?.()
  }

  const handleApplyPremiumDefaults = () => {
    if (!window.confirm('This will replace the visualiser assignment for every agent with curated premium defaults. Continue?')) return
    applyPremiumDefaults()
    const nextAssignment = getVisualizationStudioAssignment(assistantId)
    setSavedAssignment(nextAssignment)
    setDraftAssignment(nextAssignment)
    onRefresh?.()
  }

  const handleBgOpacityChange = (value) => {
    const opacity = parseFloat(value)
    setBgOpacity(opacity)
    setBackgroundOpacity(opacity)
  }

  return (
    <div className="viz-studio-editor">
      <div className="viz-studio-editor__toolbar">
        <div className="viz-studio-editor__option-strip" role="tablist" aria-label="Visualizers">
          {renderers.map(item => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={activeRendererId === item.id}
              className={`viz-studio-editor__option-btn ${activeRendererId === item.id ? 'selected' : ''}`}
              onClick={() => handleRendererChange(item.id)}
              title={item.displayName}
            >
              {item.displayName}
            </button>
          ))}
        </div>
      </div>

      <div className="viz-studio-editor__workspace">
        <div className="viz-studio-editor__preview">
          <div className="viz-studio-editor__preview-meta">
            <div>
              <h4>{renderer.displayName}</h4>
              <p>{nativeRenderer ? 'Native studio controls are available for this renderer.' : 'This renderer is available in the unified system and can be upgraded with a native inspector later.'}</p>
            </div>
            <div className="viz-studio-editor__preset-box">
              <label htmlFor="viz-studio-preset">Preset</label>
              <select
                id="viz-studio-preset"
                value={assignment?.presetId || renderer.defaultPresetId}
                onChange={(event) => handlePresetChange(event.target.value)}
              >
                {renderer.presets.map(item => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="viz-studio-editor__stage-shell">
            <div className="viz-studio-editor__stage">
              {assignment && (
                <VisualizerHost assistantId={assistantId} state={previewState} fallbackAssignment={assignment} />
              )}
            </div>
          </div>

          <div className="viz-studio-editor__states-panel">
            <div className="viz-studio-editor__states-copy">
              <strong>Preview State</strong>
              <span>Switch behavior states to tune motion and intensity.</span>
            </div>
            <div className="viz-studio-editor__states">
              {PREVIEW_STATES.map(key => (
                <button
                  key={key}
                  className={previewState === key ? 'active' : ''}
                  onClick={() => setPreviewState(key)}
                >
                  {key}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="viz-studio-editor__controls">
          <div className="viz-studio-editor__section viz-studio-editor__section--compact">
            <div className="viz-studio-editor__section-head">
              <h4>Session</h4>
              <div className="viz-studio-editor__session-actions">
                <button
                  type="button"
                  className="viz-studio-editor__action-btn viz-studio-editor__action-btn--premium"
                  onClick={handleApplyPremiumDefaults}
                  title="Assign a curated visualiser to every agent"
                >
                  Apply premium defaults
                </button>
                {nativeRenderer && (
                  <button
                    type="button"
                    className="viz-studio-editor__action-btn"
                    onClick={handleRandomizeState}
                  >
                    Randomise {previewState}
                  </button>
                )}
                <button
                  type="button"
                  className={`viz-studio-editor__save-btn ${hasUnsavedChanges ? 'is-dirty' : ''}`}
                  onClick={handleSaveChanges}
                  disabled={!hasUnsavedChanges}
                >
                  {hasUnsavedChanges ? 'Save Changes' : 'Saved'}
                </button>
              </div>
            </div>
            <p>Use presets for the broad look, then tune the selected state with local overrides.</p>
          </div>

          <div className="viz-studio-editor__controls-grid">
            <div className="viz-studio-editor__section viz-studio-editor__section--stat">
              <span className="viz-studio-editor__eyebrow">Renderer</span>
              <strong>{renderer.displayName}</strong>
            </div>
            <div className="viz-studio-editor__section viz-studio-editor__section--stat">
              <span className="viz-studio-editor__eyebrow">Preset</span>
              <strong>{renderer.presets.find(item => item.id === (assignment?.presetId || renderer.defaultPresetId))?.name || 'Default'}</strong>
            </div>
            <div className="viz-studio-editor__section viz-studio-editor__section--stat">
              <span className="viz-studio-editor__eyebrow">State</span>
              <strong>{previewState}</strong>
            </div>
          </div>

          <div className="viz-studio-editor__section">
            <div className="viz-studio-editor__section-head">
              <h4>Display</h4>
            </div>
            <label>
              <span>Panel background</span>
              <div className="viz-studio-editor__slider-row">
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={bgOpacity}
                  onChange={(event) => handleBgOpacityChange(event.target.value)}
                />
                <code>{bgOpacity.toFixed(0) === '0' ? 'Glass' : `${Math.round(bgOpacity * 100)}%`}</code>
              </div>
            </label>
          </div>

          {nativeRenderer && (
            <>
              <div className="viz-studio-editor__section">
                <div className="viz-studio-editor__section-head">
                  <h4>{previewState} Palette</h4>
                </div>
                <div className="viz-studio-editor__palette-row">
                  <label className="viz-studio-editor__color-control">
                    <span>Primary</span>
                    <input
                      type="color"
                      value={hueToHex(effectiveStateConfig.hue ?? 200)}
                      disabled={paletteLocked}
                      onChange={(event) => handleColorChange('hue', event.target.value)}
                    />
                  </label>
                  <label className="viz-studio-editor__color-control">
                    <span>Accent</span>
                    <input
                      type="color"
                      value={hueToHex(effectiveStateConfig.accentHue ?? 120)}
                      disabled={paletteLocked}
                      onChange={(event) => handleColorChange('accentHue', event.target.value)}
                    />
                  </label>
                </div>
                {paletteLocked && (
                  <p>{isCommanderRenderer ? 'Commander Sigil keeps the horned Q locked to the main brand gradient.' : 'Tropical Iris keeps a fixed palette across states.'}</p>
                )}
              </div>

              <div className="viz-studio-editor__section">
                <div className="viz-studio-editor__section-head">
                  <h4>Global Overrides</h4>
                </div>
                <label>
                  <span>Backdrop</span>
                  <div className="viz-studio-editor__slider-row">
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={effectiveGlobalConfig.backdrop ?? 0}
                      onChange={(event) => handleGlobalOverrideChange('backdrop', parseFloat(event.target.value))}
                    />
                    <code>{(effectiveGlobalConfig.backdrop ?? 0).toFixed(2)}</code>
                  </div>
                </label>
                <label>
                  <span>Bloom</span>
                  <div className="viz-studio-editor__slider-row">
                    <input
                      type="range"
                      min="0"
                      max="1.4"
                      step="0.01"
                      value={effectiveGlobalConfig.bloom ?? 0}
                      onChange={(event) => handleGlobalOverrideChange('bloom', parseFloat(event.target.value))}
                    />
                    <code>{(effectiveGlobalConfig.bloom ?? 0).toFixed(2)}</code>
                  </div>
                </label>
              </div>

              {isPrismRenderer && (
                <>
                  <div className="viz-studio-editor__section">
                    <div className="viz-studio-editor__section-head">
                      <h4>Prism Surface</h4>
                    </div>
                    <p>Dial in the glass body and overall spectrum intensity.</p>
                    {Object.entries(PRISM_GLOBAL_META).map(([key, meta]) => renderNativeSlider(
                      key,
                      meta,
                      effectiveGlobalConfig[key],
                      (value) => handleGlobalOverrideChange(key, parseFloat(value))
                    ))}
                  </div>

                  <div className="viz-studio-editor__section">
                    <div className="viz-studio-editor__section-head">
                      <h4>Beam Behavior</h4>
                    </div>
                    <p>Control how much the source wanders and how aggressively the prism splits the beam.</p>
                    {Object.entries(PRISM_STATE_META).map(([key, meta]) => renderNativeSlider(
                      key,
                      meta,
                      effectiveStateConfig[key],
                      (value) => handleStateOverrideChange(key, parseFloat(value))
                    ))}
                  </div>
                </>
              )}

              {isTriageRenderer && (
                <>
                  <div className="viz-studio-editor__section">
                    <div className="viz-studio-editor__section-head">
                      <h4>Lane Layout</h4>
                    </div>
                    <p>Control how spread out the priority lanes are and how prominent the human review station feels.</p>
                    {Object.entries(TRIAGE_GLOBAL_META).map(([key, meta]) => renderNativeSlider(
                      key,
                      meta,
                      effectiveGlobalConfig[key],
                      (value) => handleGlobalOverrideChange(key, parseFloat(value))
                    ))}
                  </div>

                  <div className="viz-studio-editor__section">
                    <div className="viz-studio-editor__section-head">
                      <h4>Queue Logic</h4>
                    </div>
                    <p>Increase queue pressure or tighten the classifier so packets snap into their lane faster.</p>
                    {Object.entries(TRIAGE_STATE_META).map(([key, meta]) => renderNativeSlider(
                      key,
                      meta,
                      effectiveStateConfig[key],
                      (value) => handleStateOverrideChange(key, parseFloat(value))
                    ))}
                  </div>
                </>
              )}

              {isCommanderRenderer && (
                <>
                  <div className="viz-studio-editor__section">
                    <div className="viz-studio-editor__section-head">
                      <h4>Sigil Tone</h4>
                    </div>
                    <p>Control how brightly the crown glows and how far out the radial scope sits from the mark.</p>
                    {Object.entries(COMMANDER_GLOBAL_META).map(([key, meta]) => renderNativeSlider(
                      key,
                      meta,
                      effectiveGlobalConfig[key],
                      (value) => handleGlobalOverrideChange(key, parseFloat(value))
                    ))}
                  </div>

                  <div className="viz-studio-editor__section">
                    <div className="viz-studio-editor__section-head">
                      <h4>Command Field</h4>
                    </div>
                    <p>Shape how much speech ripples propagate and how strongly the relay halo reaches out into the outer ring.</p>
                    {Object.entries(COMMANDER_STATE_META).map(([key, meta]) => renderNativeSlider(
                      key,
                      meta,
                      effectiveStateConfig[key],
                      (value) => handleStateOverrideChange(key, parseFloat(value))
                    ))}
                  </div>
                </>
              )}

              {isInsightRenderer && (
                <>
                  <div className="viz-studio-editor__section">
                    <div className="viz-studio-editor__section-head">
                      <h4>Lens Surface</h4>
                    </div>
                    <p>Control the weight of the central dashboard lens and how strongly annotation markers glow around the traces.</p>
                    {Object.entries(INSIGHT_GLOBAL_META).map(([key, meta]) => renderNativeSlider(
                      key,
                      meta,
                      effectiveGlobalConfig[key],
                      (value) => handleGlobalOverrideChange(key, parseFloat(value))
                    ))}
                  </div>

                  <div className="viz-studio-editor__section">
                    <div className="viz-studio-editor__section-head">
                      <h4>Trend Analysis</h4>
                    </div>
                    <p>Spread the timeseries further apart or increase the density of annotations and correlation cues in the active state.</p>
                    {Object.entries(INSIGHT_STATE_META).map(([key, meta]) => renderNativeSlider(
                      key,
                      meta,
                      effectiveStateConfig[key],
                      (value) => handleStateOverrideChange(key, parseFloat(value))
                    ))}
                  </div>
                </>
              )}

              {isBrowserRenderer && (
                <>
                  <div className="viz-studio-editor__section">
                    <div className="viz-studio-editor__section-head">
                      <h4>Glass Body</h4>
                    </div>
                    <p>Control how deep the lens feels, how strongly it refracts the browser scene, and how much the page drifts underneath the glass.</p>
                    {Object.entries(BROWSER_GLOBAL_META).map(([key, meta]) => renderNativeSlider(
                      key,
                      meta,
                      effectiveGlobalConfig[key],
                      (value) => handleGlobalOverrideChange(key, parseFloat(value))
                    ))}
                  </div>

                  <div className="viz-studio-editor__section">
                    <div className="viz-studio-editor__section-head">
                      <h4>Automation Focus</h4>
                    </div>
                    <p>Increase DOM target density or tighten the focus reticle so the magnifier feels more locked onto the active browser task.</p>
                    {Object.entries(BROWSER_STATE_META).map(([key, meta]) => renderNativeSlider(
                      key,
                      meta,
                      effectiveStateConfig[key],
                      (value) => handleStateOverrideChange(key, parseFloat(value))
                    ))}
                  </div>
                </>
              )}

              {isMomentumRenderer && (
                <>
                  <div className="viz-studio-editor__section">
                    <div className="viz-studio-editor__section-head">
                      <h4>Board Surface</h4>
                    </div>
                    <p>Set the flow rate of the task rails, the strength of the streak halo, and how glassy the Kanban board feels under the cards.</p>
                    {Object.entries(MOMENTUM_GLOBAL_META).map(([key, meta]) => renderNativeSlider(
                      key,
                      meta,
                      effectiveGlobalConfig[key],
                      (value) => handleGlobalOverrideChange(key, parseFloat(value))
                    ))}
                  </div>

                  <div className="viz-studio-editor__section">
                    <div className="viz-studio-editor__section-head">
                      <h4>Execution Logic</h4>
                    </div>
                    <p>Control queue density, how aggressively urgent work burns through the scene, and how strongly delegated tasks peel off toward external agents.</p>
                    {Object.entries(MOMENTUM_STATE_META).map(([key, meta]) => renderNativeSlider(
                      key,
                      meta,
                      effectiveStateConfig[key],
                      (value) => handleStateOverrideChange(key, parseFloat(value))
                    ))}
                  </div>
                </>
              )}

              <div className="viz-studio-editor__section">
                <div className="viz-studio-editor__section-head">
                  <h4>{previewState} Overrides</h4>
                </div>
                {TUNABLE_KEYS.map(key => (
                  <label key={key}>
                    <span>{key}</span>
                    <div className="viz-studio-editor__slider-row">
                      <input
                        type="range"
                        min={TUNABLE_META[key].min}
                        max={TUNABLE_META[key].max}
                        step={TUNABLE_META[key].step}
                        value={effectiveStateConfig[key] ?? TUNABLE_META[key].min}
                        onChange={(event) => handleStateOverrideChange(
                          key,
                          key === 'orbitCount' ? parseInt(event.target.value, 10) : parseFloat(event.target.value)
                        )}
                      />
                      <code>{key === 'orbitCount' ? (effectiveStateConfig[key] ?? TUNABLE_META[key].min) : Number(effectiveStateConfig[key] ?? TUNABLE_META[key].min).toFixed(2)}</code>
                    </div>
                  </label>
                ))}
              </div>
            </>
          )}

          {!nativeRenderer && (
            <div className="viz-studio-editor__section">
              <div className="viz-studio-editor__section-head">
                <h4>{previewState} Legacy Controls</h4>
              </div>
              <p>These legacy visualizers keep their original control model inside the unified studio.</p>
              <label>
                <span>Scale</span>
                <div className="viz-studio-editor__slider-row">
                  <input
                    type="range"
                    min="0.4"
                    max="2"
                    step="0.01"
                    value={getLegacyStateSetting('scale')}
                    onChange={(event) => handleLegacyStateSettingChange('scale', parseFloat(event.target.value))}
                  />
                  <code>{Number(getLegacyStateSetting('scale')).toFixed(2)}</code>
                </div>
              </label>
              <label>
                <span>Speed</span>
                <div className="viz-studio-editor__slider-row">
                  <input
                    type="range"
                    min="0"
                    max="2"
                    step="0.01"
                    value={getLegacyStateSetting('speed')}
                    onChange={(event) => handleLegacyStateSettingChange('speed', parseFloat(event.target.value))}
                  />
                  <code>{Number(getLegacyStateSetting('speed')).toFixed(2)}</code>
                </div>
              </label>
              <label>
                <span>Sensitivity</span>
                <div className="viz-studio-editor__slider-row">
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={getLegacyStateSetting('sensitivity')}
                    onChange={(event) => handleLegacyStateSettingChange('sensitivity', parseFloat(event.target.value))}
                  />
                  <code>{Number(getLegacyStateSetting('sensitivity')).toFixed(2)}</code>
                </div>
              </label>
              <div className="viz-studio-editor__palette-row">
                <label className="viz-studio-editor__color-control">
                  <span>Hue</span>
                  <input
                    type="color"
                    value={hueToHex(getLegacyStateSetting('hue'))}
                    onChange={(event) => handleLegacyStateSettingChange('hue', hexToHue(event.target.value))}
                  />
                </label>
              </div>
            </div>
          )}
        </div>
      </div>

      <style>{`
        .viz-studio-editor {
          display: flex;
          flex-direction: column;
          gap: 16px;
          min-height: 0;
        }
        .viz-studio-editor__toolbar,
        .viz-studio-editor__preview,
        .viz-studio-editor__controls {
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 16px;
          background: linear-gradient(180deg, rgba(19,25,36,0.96), rgba(10,14,22,0.96));
          min-height: 0;
        }
        .viz-studio-editor__toolbar {
          padding: 12px 16px 8px;
        }
        .viz-studio-editor__option-strip {
          display: flex;
          gap: 8px;
          overflow-x: auto;
          padding: 2px 0 6px;
          scrollbar-width: thin;
          align-items: center;
        }
        .viz-studio-editor__option-btn {
          flex: 0 0 auto;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 36px;
          padding: 8px 14px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.1);
          background: rgba(255,255,255,0.04);
          color: rgba(244,247,251,0.82);
          white-space: nowrap;
          line-height: 1;
          font-size: 12px;
          font-weight: 600;
          font-family: inherit;
          cursor: pointer;
          overflow: visible;
        }
        .viz-studio-editor__option-btn.selected {
          background: rgba(48, 144, 255, 0.16);
          border-color: rgba(48, 144, 255, 0.55);
          color: #ffffff;
        }
        .viz-studio-editor__workspace {
          display: grid;
          grid-template-columns: minmax(0, 1.15fr) minmax(320px, 0.85fr);
          gap: 16px;
          min-height: 0;
          align-items: start;
        }
        .viz-studio-editor__preview {
          padding: 16px;
        }
        .viz-studio-editor__preview-meta {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 16px;
          margin-bottom: 14px;
        }
        .viz-studio-editor__preview-meta h4,
        .viz-studio-editor__preview-meta p {
          margin: 0;
          color: #f4f7fb;
        }
        .viz-studio-editor__preview-meta p {
          margin-top: 6px;
          color: rgba(244,247,251,0.68);
          max-width: 54ch;
        }
        .viz-studio-editor__preset-box {
          display: flex;
          flex-direction: column;
          gap: 8px;
          min-width: 180px;
        }
        .viz-studio-editor__preset-box label {
          color: rgba(244,247,251,0.68);
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
        }
        .viz-studio-editor__preset-box select {
          border-radius: 10px;
          border: 1px solid rgba(255,255,255,0.1);
          background: rgba(255,255,255,0.04);
          color: #f4f7fb;
          padding: 10px 12px;
        }
        .viz-studio-editor__stage-shell {
          border-radius: 14px;
          overflow: hidden;
          border: 1px solid rgba(255,255,255,0.06);
          background:
            radial-gradient(circle at top, rgba(48,144,255,0.12), transparent 44%),
            linear-gradient(180deg, rgba(7,10,16,0.96), rgba(4,6,10,0.98));
        }
        .viz-studio-editor__stage {
          min-height: 360px;
          height: min(500px, 54vh);
        }
        .viz-studio-editor__states-panel {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 16px;
          padding-top: 14px;
        }
        .viz-studio-editor__states-copy {
          display: flex;
          flex-direction: column;
          gap: 4px;
          color: #f4f7fb;
        }
        .viz-studio-editor__states-copy span {
          color: rgba(244,247,251,0.68);
          font-size: 13px;
        }
        .viz-studio-editor__controls {
          padding: 16px;
          max-height: calc(100vh - var(--shell-header-height, 56px) - 180px);
          overflow-y: auto;
          overscroll-behavior: contain;
          scrollbar-width: thin;
        }
        .viz-studio-editor__controls-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 16px;
          margin-bottom: 16px;
        }
        .viz-studio-editor__states {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          justify-content: flex-end;
        }
        .viz-studio-editor__states button,
        .viz-studio-editor__action-btn {
          border-radius: 10px;
          border: 1px solid rgba(255,255,255,0.1);
          background: rgba(255,255,255,0.04);
          color: #f4f7fb;
          padding: 8px 12px;
        }
        .viz-studio-editor__action-btn {
          width: fit-content;
          cursor: pointer;
          background: rgba(48, 144, 255, 0.12);
          border-color: rgba(48, 144, 255, 0.32);
        }
        .viz-studio-editor__action-btn--premium {
          background: rgba(139, 92, 246, 0.14);
          border-color: rgba(139, 92, 246, 0.36);
        }
        .viz-studio-editor__states button.active {
          background: rgba(48, 144, 255, 0.18);
          border-color: rgba(48, 144, 255, 0.5);
        }
        .viz-studio-editor__section {
          display: flex;
          flex-direction: column;
          gap: 10px;
          margin-bottom: 16px;
          min-width: 0;
          padding: 14px;
          border-radius: 14px;
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.06);
        }
        .viz-studio-editor__section h3,
        .viz-studio-editor__section h4,
        .viz-studio-editor__section p,
        .viz-studio-editor__section label,
        .viz-studio-editor__section span,
        .viz-studio-editor__section strong,
        .viz-studio-editor__section em,
        .viz-studio-editor__section code {
          margin: 0;
          color: #f4f7fb;
        }
        .viz-studio-editor__section p {
          color: rgba(244, 247, 251, 0.72);
        }
        .viz-studio-editor__section-head {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
        }
        .viz-studio-editor__session-actions {
          display: flex;
          gap: 10px;
          align-items: center;
          flex-wrap: wrap;
        }
        .viz-studio-editor__section--compact {
          padding-bottom: 12px;
        }
        .viz-studio-editor__section--stat strong {
          font-size: 16px;
          font-weight: 700;
        }
        .viz-studio-editor__eyebrow {
          color: rgba(244,247,251,0.6);
          text-transform: uppercase;
          letter-spacing: 0.08em;
          font-size: 11px;
        }
        .viz-studio-editor__palette-row {
          display: flex;
          gap: 16px;
          flex-wrap: wrap;
        }
        .viz-studio-editor__color-control {
          display: flex;
          flex-direction: column;
          gap: 8px;
          width: fit-content;
        }
        .viz-studio-editor__color-control input[type="color"] {
          width: 52px;
          height: 36px;
          padding: 3px;
          border-radius: 10px;
          border: 1px solid rgba(255,255,255,0.1);
          background: rgba(255,255,255,0.04);
        }
        .viz-studio-editor__slider-row {
          display: grid;
          grid-template-columns: 1fr auto;
          gap: 10px;
          align-items: center;
        }
        .viz-studio-editor__slider-row code {
          min-width: 44px;
          text-align: right;
          color: rgba(244,247,251,0.72);
        }
        .viz-studio-editor__save-btn {
          border-radius: 10px;
          border: 1px solid rgba(255,255,255,0.1);
          background: rgba(255,255,255,0.05);
          color: rgba(244,247,251,0.72);
          padding: 8px 14px;
          font-weight: 600;
          cursor: pointer;
        }
        .viz-studio-editor__save-btn.is-dirty {
          background: rgba(38, 191, 4, 0.14);
          border-color: rgba(38, 191, 4, 0.4);
          color: #f4f7fb;
        }
        .viz-studio-editor__save-btn:disabled {
          opacity: 0.72;
          cursor: default;
        }
        .viz-studio-editor__section input[type="range"] {
          width: 100%;
        }
        @media (max-width: 960px) {
          .viz-studio-editor__workspace {
            grid-template-columns: 1fr;
          }
          .viz-studio-editor__controls {
            max-height: none;
            overflow-y: visible;
          }
          .viz-studio-editor__preview-meta,
          .viz-studio-editor__states-panel,
          .viz-studio-editor__section-head {
            flex-direction: column;
            align-items: flex-start;
          }
          .viz-studio-editor__states {
            justify-content: flex-start;
          }
          .viz-studio-editor__stage {
            height: min(340px, 42vh);
          }
          .viz-studio-editor__controls-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </div>
  )
}
