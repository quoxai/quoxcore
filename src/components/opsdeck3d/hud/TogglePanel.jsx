/**
 * TogglePanel — Left-side layer toggle panel with presets and system state.
 *
 * Extracted from CognitiveCore3DView.jsx (Phase CC-10 refactor).
 */
import { useState } from 'react'

const FONT_STACK = "'JetBrains Mono', 'Fira Code', monospace"
const BRAND_VIOLET = '#8b5cf6'
const GLASS_BG = 'var(--cc3d-glass-bg, rgba(5, 5, 16, 0.88))'

// ─── Layer Presets ──────────────────────────────────────
export const LAYER_PRESETS = {
  'Full Core': { holoGrid: true, particles: true, nucleus: true, shell: true, implants: true, agents: true, orgs: true, execution: true, memory: true, highways: true, heartbeat: true, zoneRings: true, focusBeam: true, nestedShells: true, services: true, protocols: true, infra: true, plugins: true, tools: true, workflows: true, teams: true, integrations: true, llmProviders: true, horus: true, floatingPanels: false, simulation: false },
  'OpsDeck': { holoGrid: true, particles: true, nucleus: true, shell: false, implants: false, agents: true, orgs: true, execution: true, memory: false, highways: false, heartbeat: false, zoneRings: true, focusBeam: false, nestedShells: false, services: true, protocols: true, infra: false, plugins: true, tools: false, workflows: true, teams: true, integrations: true, llmProviders: false, horus: true, floatingPanels: true, simulation: false },
  'Memory': { holoGrid: true, particles: true, nucleus: true, shell: true, implants: false, agents: false, orgs: false, execution: false, memory: true, highways: true, heartbeat: false, zoneRings: true, focusBeam: true, nestedShells: false, services: false, protocols: false, infra: false, plugins: false, tools: false, workflows: false, teams: false, integrations: false, llmProviders: false, horus: false, floatingPanels: false, simulation: false },
  'Health': { holoGrid: true, particles: false, nucleus: true, shell: true, implants: true, agents: false, orgs: false, execution: false, memory: false, highways: true, heartbeat: true, zoneRings: true, focusBeam: false, nestedShells: false, services: true, protocols: false, infra: true, plugins: true, tools: false, workflows: false, teams: true, integrations: true, llmProviders: false, horus: true, floatingPanels: false, simulation: false },
  'Agents': { holoGrid: true, particles: true, nucleus: true, shell: false, implants: true, agents: true, orgs: true, execution: false, memory: false, highways: true, heartbeat: false, zoneRings: true, focusBeam: false, nestedShells: false, services: false, protocols: false, infra: false, plugins: true, tools: true, workflows: false, teams: true, integrations: false, llmProviders: true, horus: true, floatingPanels: false, simulation: false },
  'Minimal': { holoGrid: true, particles: true, nucleus: true, shell: false, implants: false, agents: false, orgs: false, execution: false, memory: false, highways: false, heartbeat: true, zoneRings: false, focusBeam: false, nestedShells: false, services: false, protocols: false, infra: false, plugins: false, tools: false, workflows: false, teams: false, integrations: false, llmProviders: false, horus: false, floatingPanels: false, simulation: false },
}
export const PRESET_NAMES = Object.keys(LAYER_PRESETS)

// ─── Layer Info & Groups ────────────────────────────────
export const LAYER_INFO = {
  holoGrid: { desc: 'Grid floor at y=-30', zone: 'Floor' },
  particles: { desc: '400 ambient dust particles', zone: 'Void' },
  nucleus: { desc: 'Central orb with horns', zone: 'r=0' },
  shell: { desc: 'Icosahedron wireframe', zone: 'r=50' },
  implants: { desc: '12 QuoxMind cognitive implants', zone: 'r=8' },
  agents: { desc: '16 agent nodes + team labels', zone: 'r=12-18' },
  zoneRings: { desc: 'Orbital track lines + labels', zone: 'All' },
  focusBeam: { desc: 'Indigo beam to focus target', zone: 'Nucleus' },
  heartbeat: { desc: 'Subtle ripple every 8s', zone: 'Nucleus' },
  execution: { desc: 'Objective execution clusters + tasks', zone: 'r=80' },
  memory: { desc: 'Memory crystals on orbits', zone: 'r=40-50' },
  highways: { desc: '4 data particle streams', zone: 'Between zones' },
  nestedShells: { desc: 'Tailnet + External boundaries', zone: 'r=70, r=90' },
  services: { desc: '6 infrastructure service nodes', zone: 'r=6' },
  protocols: { desc: 'AEE, AOCL, VOLT, WARD protocol rings', zone: 'r=33-39' },
  infra: { desc: '10 physical hosts below the core', zone: 'y=-12' },
  plugins: { desc: '32+ plugin dots by tier', zone: 'r=9.5' },
  tools: { desc: 'Tool density clouds per agent', zone: 'r=11-18' },
  workflows: { desc: 'Workflow execution dots', zone: 'r=90' },
  jumpNodes: { desc: 'Radar jump navigation nodes', zone: 'All rings' },
  orgs: { desc: 'Org / division / department sectors', zone: 'r=29-32' },
  teams: { desc: 'Agentic team hub+satellite clusters', zone: 'r=38/59' },
  integrations: { desc: 'Active connector integrations', zone: 'r=135 (shell)' },
  llmProviders: { desc: 'LLM providers near nucleus', zone: 'r=3' },
  horus: { desc: 'Autonomous watchdog agent', zone: 'Above nucleus' },
  floatingPanels: { desc: '3D floating info panels', zone: 'Near nucleus' },
  simulation: { desc: '30s demo loop through all zones', zone: 'Centre' },
}

export const LAYER_GROUPS = [
  { label: 'Core', keys: ['nucleus', 'implants', 'shell', 'services', 'plugins', 'llmProviders', 'horus', 'floatingPanels'] },
  { label: 'Agents', keys: ['agents', 'orgs', 'teams', 'zoneRings', 'tools'] },
  { label: 'Activity', keys: ['execution', 'highways', 'focusBeam', 'heartbeat', 'protocols', 'workflows', 'simulation'] },
  { label: 'Knowledge', keys: ['memory'] },
  { label: 'Ambient', keys: ['holoGrid', 'particles'] },
  { label: 'Boundaries', keys: ['nestedShells', 'integrations'] },
  { label: 'Physical', keys: ['infra'] },
]

export const LAYER_KEY_TO_LABEL = {
  holoGrid: 'Holo Grid', particles: 'Particles', nucleus: 'Nucleus',
  shell: 'Core Shell', implants: 'Implants Ring', agents: 'Agent Mesh',
  zoneRings: 'Zone Rings', focusBeam: 'Focus Beam', heartbeat: 'Heartbeat',
  execution: 'Obj Execution', memory: 'Memory Lattice', highways: 'Data Highways',
  nestedShells: 'Nested Shells',
  services: 'Services',
  protocols: 'Protocols',
  infra: 'Infrastructure',
  plugins: 'Plugins',
  tools: 'Tool Dots',
  workflows: 'WF Execution',
  orgs: 'Org Structure',
  jumpNodes: 'Jump Nodes',
  teams: 'Teams Ring',
  integrations: 'Integrations',
  llmProviders: 'LLM Providers',
  horus: 'HORUS',
  floatingPanels: '3D Panels',
  simulation: 'Simulation',
}

function presetCount(name) {
  const p = LAYER_PRESETS[name]
  return p ? Object.values(p).filter(Boolean).length : 0
}

// ─── Toggle Button with Tooltip ─────────────────────────
function LayerToggle({ layerKey, label, checked, onToggle }) {
  const [hovered, setHovered] = useState(false)
  const info = LAYER_INFO[layerKey]

  return (
    <div
      style={{ position: 'relative' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <label style={{
        display: 'flex', alignItems: 'center', gap: 8,
        marginBottom: 4, cursor: 'pointer',
        padding: '3px 6px', borderRadius: 3,
        color: checked ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.45)',
        background: hovered ? 'rgba(139, 92, 246, 0.1)' : 'transparent',
        border: hovered ? '1px solid rgba(139, 92, 246, 0.2)' : '1px solid transparent',
        transition: 'all 0.15s ease',
      }}>
        <input
          type="checkbox"
          checked={checked}
          onChange={() => onToggle(layerKey)}
          style={{ accentColor: BRAND_VIOLET, width: 12, height: 12 }}
        />
        {label}
      </label>
      {hovered && info && (
        <div style={{
          position: 'absolute', left: '100%', top: 0, marginLeft: 6,
          padding: '5px 9px', borderRadius: 4, whiteSpace: 'nowrap',
          background: 'rgba(5, 5, 16, 0.95)', border: '1px solid rgba(139, 92, 246, 0.3)',
          boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
          fontSize: 9, lineHeight: 1.5, zIndex: 40, pointerEvents: 'none',
        }}>
          <div style={{ color: 'rgba(255,255,255,0.7)' }}>{info.desc}</div>
          <div style={{ color: 'rgba(139, 92, 246, 0.7)', marginTop: 1 }}>Zone: {info.zone}</div>
        </div>
      )}
    </div>
  )
}

// ─── Toggle Panel (Left Side) ───────────────────────────
export default function TogglePanel({ visible, onToggle, systemState, onSystemState, activePreset, onPreset }) {
  const [collapsed, setCollapsed] = useState(false)

  const states = ['idle', 'active', 'error']

  if (collapsed) {
    return (
      <div
        onClick={() => setCollapsed(false)}
        style={{
          position: 'fixed', top: 80, left: 12, zIndex: 30, cursor: 'pointer',
          width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: GLASS_BG, borderRadius: 4,
          border: '1px solid rgba(139, 92, 246, 0.2)',
          fontFamily: FONT_STACK, fontSize: 12, color: 'rgba(255,255,255,0.6)',
        }}
      >
        &#9654;
      </div>
    )
  }

  return (
    <div style={{
      position: 'fixed', top: 80, left: 12, zIndex: 30,
      width: 180, padding: '10px 12px',
      background: GLASS_BG, backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
      borderRadius: 6, border: '1px solid rgba(139, 92, 246, 0.2)',
      fontFamily: FONT_STACK, fontSize: 10, letterSpacing: '0.04em',
      maxHeight: 'calc(100vh - 100px)', overflowY: 'auto',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ color: 'rgba(255,255,255,0.7)', textTransform: 'uppercase', fontWeight: 600 }}>Layers</span>
        <span
          onClick={() => setCollapsed(true)}
          style={{ cursor: 'pointer', color: 'rgba(255,255,255,0.4)', fontSize: 12 }}
        >&#9664;</span>
      </div>

      {/* Preset buttons with counts */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginBottom: 10 }}>
        {PRESET_NAMES.map((name) => {
          const isActive = activePreset === name
          const count = presetCount(name)
          return (
            <button
              key={name}
              onClick={() => onPreset(name)}
              style={{
                padding: '2px 6px', border: 'none', borderRadius: 3, cursor: 'pointer',
                fontFamily: FONT_STACK, fontSize: 8, letterSpacing: '0.04em', textTransform: 'uppercase',
                background: isActive ? 'rgba(139, 92, 246, 0.35)' : 'rgba(255,255,255,0.05)',
                color: isActive ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.5)',
                borderBottom: isActive ? '1px solid rgba(139, 92, 246, 0.7)' : '1px solid transparent',
                transition: 'all 0.2s ease',
              }}
            >{name} ({count})</button>
          )
        })}
      </div>

      {/* Grouped toggles */}
      {LAYER_GROUPS.map((group) => (
        <div key={group.label} style={{ marginBottom: 6 }}>
          <div style={{
            fontSize: 8, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em',
            color: 'rgba(255,255,255,0.3)', marginBottom: 3, marginTop: 4,
          }}>{group.label}</div>
          <div style={{ paddingLeft: 2 }}>
            {group.keys.map((key) => (
              <LayerToggle
                key={key}
                layerKey={key}
                label={LAYER_KEY_TO_LABEL[key] || key}
                checked={!!visible[key]}
                onToggle={onToggle}
              />
            ))}
          </div>
        </div>
      ))}

      <div style={{ borderTop: '1px solid rgba(139, 92, 246, 0.15)', marginTop: 8, paddingTop: 8 }}>
        <span style={{ color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', fontWeight: 600 }}>State</span>
        <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
          {states.map((s) => (
            <button
              key={s}
              onClick={() => onSystemState(s)}
              style={{
                flex: 1, padding: '3px 0', border: 'none', borderRadius: 3,
                background: systemState === s ? 'rgba(139, 92, 246, 0.3)' : 'rgba(255,255,255,0.05)',
                color: systemState === s ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.5)',
                fontFamily: FONT_STACK, fontSize: 9, cursor: 'pointer',
                textTransform: 'uppercase', letterSpacing: '0.04em',
              }}
            >{s}</button>
          ))}
        </div>
      </div>
    </div>
  )
}
