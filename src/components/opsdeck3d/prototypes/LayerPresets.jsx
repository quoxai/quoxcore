/**
 * LayerPresets — Demonstrates configurable layer visibility.
 *
 * The Cognitive Core 3D can be opened in different "modes" by
 * toggling which layers are visible. This component shows how
 * presets work as a HUD selector.
 *
 * Presets:
 *   - Full Core: everything visible
 *   - OpsDeck: execution + agents only (objectives focus)
 *   - Memory View: memory lattice + nucleus (knowledge focus)
 *   - Health Monitor: implants + shell (system health)
 *   - Agent Focus: agents + nucleus + delegation arcs
 *   - Minimal: nucleus only (meditation mode)
 */
import { useState } from 'react'
import { PALETTE } from '../lib/design-system'

const FONT = "'JetBrains Mono', 'Fira Code', monospace"

const LAYERS = [
  { key: 'nucleus', label: 'Nucleus', color: PALETTE.indigo, zone: 'r=0-5' },
  { key: 'implants', label: 'Implants', color: PALETTE.violet, zone: 'r=5-10' },
  { key: 'agents', label: 'Agent Mesh', color: PALETTE.thinking, zone: 'r=10-18' },
  { key: 'execution', label: 'Execution', color: PALETTE.executing, zone: 'r=25-35' },
  { key: 'memory', label: 'Memory Lattice', color: '#ec4899', zone: 'r=40-50' },
  { key: 'shell', label: 'Core Shell', color: PALETTE.violet, zone: 'r=50' },
  { key: 'grid', label: 'Holo Grid', color: PALETTE.indigo, zone: 'y=-30' },
  { key: 'particles', label: 'Particles', color: 'rgba(255,255,255,0.5)', zone: 'ambient' },
  { key: 'arcs', label: 'Delegation Arcs', color: PALETTE.delegation, zone: 'effect' },
  { key: 'highways', label: 'Data Highways', color: PALETTE.cyan, zone: 'effect' },
  { key: 'heartbeat', label: 'Heartbeat', color: PALETTE.indigo, zone: 'effect' },
  { key: 'panels', label: 'Floating Panels', color: PALETTE.violet, zone: 'HUD' },
]

const PRESETS = {
  'Full Core': {
    desc: 'Everything visible — the complete cognitive architecture',
    layers: Object.fromEntries(LAYERS.map(l => [l.key, true])),
    accent: PALETTE.violet,
  },
  'OpsDeck': {
    desc: 'Objectives and agents — operational monitoring',
    layers: { nucleus: true, agents: true, execution: true, grid: true, arcs: true, heartbeat: false, implants: false, memory: false, shell: false, particles: true, highways: false, panels: false },
    accent: PALETTE.executing,
  },
  'Memory View': {
    desc: 'Memory lattice and nucleus — knowledge exploration',
    layers: { nucleus: true, memory: true, shell: true, grid: true, implants: false, agents: false, execution: false, particles: true, arcs: false, highways: true, heartbeat: false, panels: false },
    accent: '#ec4899',
  },
  'Health Monitor': {
    desc: 'Implants and shell — system health dashboard',
    layers: { nucleus: true, implants: true, shell: true, grid: true, agents: false, execution: false, memory: false, particles: false, arcs: false, highways: false, heartbeat: true, panels: true },
    accent: PALETTE.violet,
  },
  'Agent Focus': {
    desc: 'Agent mesh with delegations — team coordination',
    layers: { nucleus: true, agents: true, arcs: true, grid: true, implants: true, execution: false, memory: false, shell: false, particles: true, highways: true, heartbeat: false, panels: false },
    accent: PALETTE.indigo,
  },
  'Minimal': {
    desc: 'Nucleus only — contemplative, wallboard',
    layers: { nucleus: true, grid: true, particles: true, heartbeat: true, implants: false, agents: false, execution: false, memory: false, shell: false, arcs: false, highways: false, panels: false },
    accent: PALETTE.indigo,
  },
}

export default function LayerPresets({ onApplyPreset }) {
  const [activePreset, setActivePreset] = useState('Full Core')
  const [layers, setLayers] = useState(PRESETS['Full Core'].layers)

  const applyPreset = (name) => {
    setActivePreset(name)
    setLayers({ ...PRESETS[name].layers })
    onApplyPreset?.(PRESETS[name].layers)
  }

  const toggleLayer = (key) => {
    setLayers(prev => {
      const next = { ...prev, [key]: !prev[key] }
      setActivePreset('') // custom
      onApplyPreset?.(next)
      return next
    })
  }

  const visibleCount = Object.values(layers).filter(Boolean).length

  return (
    <div style={{
      background: 'rgba(5,5,16,0.92)', border: '1px solid rgba(255,255,255,0.06)',
      borderRadius: 8, padding: '12px 14px', fontFamily: FONT, fontSize: 10,
      color: 'rgba(255,255,255,0.8)', width: 260, backdropFilter: 'blur(16px)',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.1em', color: PALETTE.violet, fontWeight: 700 }}>Layer Presets</span>
        <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)' }}>{visibleCount}/{LAYERS.length} visible</span>
      </div>

      {/* Preset buttons */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 12 }}>
        {Object.entries(PRESETS).map(([name, preset]) => (
          <button
            key={name}
            onClick={() => applyPreset(name)}
            style={{
              padding: '4px 10px', borderRadius: 4, cursor: 'pointer', fontFamily: FONT, fontSize: 9,
              background: activePreset === name ? `${preset.accent}20` : 'rgba(255,255,255,0.03)',
              border: activePreset === name ? `1px solid ${preset.accent}40` : '1px solid rgba(255,255,255,0.06)',
              color: activePreset === name ? preset.accent : 'rgba(255,255,255,0.5)',
              fontWeight: activePreset === name ? 700 : 400,
            }}
          >
            {name}
          </button>
        ))}
      </div>

      {/* Active preset description */}
      {activePreset && (
        <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', marginBottom: 10, paddingBottom: 8, borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
          {PRESETS[activePreset]?.desc}
        </div>
      )}

      {/* Individual layer toggles */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {LAYERS.map(layer => (
          <button
            key={layer.key}
            onClick={() => toggleLayer(layer.key)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '4px 8px', borderRadius: 4, cursor: 'pointer', fontFamily: FONT, fontSize: 9,
              background: layers[layer.key] ? `${layer.color}10` : 'rgba(255,255,255,0.01)',
              border: layers[layer.key] ? `1px solid ${layer.color}25` : '1px solid rgba(255,255,255,0.03)',
              color: layers[layer.key] ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.25)',
              width: '100%', textAlign: 'left',
            }}
          >
            <span style={{
              width: 8, height: 8, borderRadius: 2, flexShrink: 0,
              background: layers[layer.key] ? layer.color : 'rgba(255,255,255,0.06)',
              opacity: layers[layer.key] ? 0.8 : 0.3,
            }} />
            <span style={{ flex: 1 }}>{layer.label}</span>
            <span style={{ fontSize: 7, color: 'rgba(255,255,255,0.2)' }}>{layer.zone}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
