/**
 * SidebarRail — Skinny icon rail (40px) replacing the fat TogglePanel.
 *
 * Zone icons fly the camera, utility icons expand a thin sub-panel.
 * Click again or click away to collapse the expanded panel.
 */
import { useState, useCallback, useRef, useEffect } from 'react'
import { LAYER_PRESETS, PRESET_NAMES, LAYER_GROUPS, LAYER_KEY_TO_LABEL } from './TogglePanel'
import { SLIDER_DEFS } from '../lib/design-system'

const FONT_STACK = "'JetBrains Mono', 'Fira Code', monospace"
const GLASS_BG = 'var(--cc3d-glass-bg, rgba(5, 5, 16, 0.88))'
const BRAND_VIOLET = '#8b5cf6'
const RAIL_WIDTH = 40
const PANEL_WIDTH = 200

// ─���─ Depth layer definitions ────────────────────────────
export const DEPTH_LAYERS = [
  { key: 'sky',  icon: '\u2191', label: 'Sky View',     position: [0, 30, 50],   y: 30 },
  { key: 'eq',   icon: '\u2194', label: 'Equator',      position: [0, 5, 60],    y: 5 },
  { key: 'deep', icon: '\u2193', label: 'Deep / Infra', position: [12, -12, 22], y: -12 },
]

// ─── Zone definitions with camera jump positions ─────────
const ZONE_ICONS = [
  { key: 'nucleus',    icon: '\u25C9', label: 'Nucleus',    position: [0, 4, 8] },
  { key: 'services',   icon: '\u2699', label: 'Services',   position: [4, 3, 6] },
  { key: 'assistants', icon: '\u25B2', label: 'Assistants', position: [0, 6, 22] },
  { key: 'agents',     icon: '\u25B3', label: 'Agents',     position: [0, 7, 30] },
  { key: 'teams',      icon: '\u2B21', label: 'Teams',      position: [20, 8, 42] },
  { key: 'execution',  icon: '\u25CE', label: 'Execution',  position: [40, 12, 88] },
  { key: 'memory',     icon: '\u25C7', label: 'Memory',     position: [0, 16, 115] },
  { key: 'shell',      icon: '\u2B22', label: 'Shell',      position: [0, 20, 140] },
  { key: 'infra',      icon: '\u2593', label: 'Infra',      position: [12, -15, 18] },
]

// ─── Icon Button ─────────────────────────────────────────
function IconButton({ icon, label, active, onClick }) {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: 36, height: 36,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer',
        borderRadius: 4,
        background: active ? 'rgba(139, 92, 246, 0.25)' : hovered ? 'rgba(255,255,255,0.06)' : 'transparent',
        border: active ? '1px solid rgba(139, 92, 246, 0.4)' : '1px solid transparent',
        color: active ? 'rgba(255,255,255,0.95)' : hovered ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.5)',
        fontSize: 16,
        transition: 'all 0.15s ease',
        position: 'relative',
        flexShrink: 0,
      }}
    >
      {icon}
      {hovered && (
        <div style={{
          position: 'absolute',
          left: '100%',
          top: '50%',
          transform: 'translateY(-50%)',
          marginLeft: 8,
          padding: '4px 8px',
          background: 'rgba(5, 5, 16, 0.95)',
          border: '1px solid rgba(139, 92, 246, 0.3)',
          borderRadius: 3,
          whiteSpace: 'nowrap',
          fontSize: 10,
          fontFamily: FONT_STACK,
          letterSpacing: '0.04em',
          color: 'rgba(255,255,255,0.8)',
          pointerEvents: 'none',
          zIndex: 50,
        }}>
          {label}
        </div>
      )}
    </div>
  )
}

// ─── Layer Panel (expandable) ────────────────────────────
function LayerPanel({ visible, onToggle }) {
  return (
    <div style={{ padding: '8px 10px', overflowY: 'auto', maxHeight: 'calc(100vh - 200px)' }}>
      <div style={{
        fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.1em', color: 'rgba(255,255,255,0.5)', marginBottom: 8,
      }}>Layers</div>
      {LAYER_GROUPS.map((group) => (
        <div key={group.label} style={{ marginBottom: 8 }}>
          <div style={{
            fontSize: 8, fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '0.1em', color: 'rgba(255,255,255,0.3)', marginBottom: 3,
          }}>{group.label}</div>
          {group.keys.map((key) => (
            <label
              key={key}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '2px 4px', cursor: 'pointer', fontSize: 10,
                color: visible[key] ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.4)',
              }}
            >
              <input
                type="checkbox"
                checked={!!visible[key]}
                onChange={() => onToggle(key)}
                style={{ accentColor: BRAND_VIOLET, width: 11, height: 11 }}
              />
              {LAYER_KEY_TO_LABEL[key] || key}
            </label>
          ))}
        </div>
      ))}
    </div>
  )
}

// ─── Preset Panel (expandable) ───────────────────────────
function PresetPanel({ activePreset, onPreset }) {
  return (
    <div style={{ padding: '8px 10px' }}>
      <div style={{
        fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.1em', color: 'rgba(255,255,255,0.5)', marginBottom: 8,
      }}>Presets</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {PRESET_NAMES.map((name) => {
          const isActive = activePreset === name
          return (
            <button
              key={name}
              onClick={() => onPreset(name)}
              style={{
                padding: '5px 8px', border: 'none', borderRadius: 3, cursor: 'pointer',
                fontFamily: FONT_STACK, fontSize: 10, letterSpacing: '0.04em',
                textTransform: 'uppercase', textAlign: 'left',
                background: isActive ? 'rgba(139, 92, 246, 0.3)' : 'rgba(255,255,255,0.04)',
                color: isActive ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.6)',
                borderLeft: isActive ? '2px solid rgba(139, 92, 246, 0.7)' : '2px solid transparent',
                transition: 'all 0.15s ease',
              }}
            >{name}</button>
          )
        })}
      </div>
    </div>
  )
}

// ─── Settings Panel (expandable) ─────────────────────────
function SettingsPanel({ settings, onSettingChange }) {
  const [expandedGroup, setExpandedGroup] = useState(null)

  // Group sliders by their group field
  const groups = SLIDER_DEFS.reduce((acc, s) => {
    if (!acc[s.group]) acc[s.group] = []
    acc[s.group].push(s)
    return acc
  }, {})

  return (
    <div style={{ padding: '8px 10px', overflowY: 'auto', maxHeight: 'calc(100vh - 200px)' }}>
      <div style={{
        fontSize: 9, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.1em', color: 'rgba(255,255,255,0.5)', marginBottom: 8,
      }}>Settings</div>
      {Object.entries(groups).map(([group, sliders]) => {
        const isOpen = expandedGroup === group
        return (
          <div key={group} style={{ marginBottom: 4 }}>
            <div
              onClick={() => setExpandedGroup(isOpen ? null : group)}
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '4px 4px', cursor: 'pointer', borderRadius: 3,
                background: isOpen ? 'rgba(139, 92, 246, 0.12)' : 'transparent',
              }}
            >
              <span style={{ fontSize: 9, fontWeight: 600, textTransform: 'uppercase',
                letterSpacing: '0.08em', color: isOpen ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.4)' }}>
                {group}
              </span>
              <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.3)' }}>{isOpen ? '\u25B2' : '\u25BC'}</span>
            </div>
            {isOpen && (
              <div style={{ padding: '4px 2px 4px 4px' }}>
                {sliders.map((s) => {
                  const val = settings?.[s.key] != null ? settings[s.key] : s.min
                  const pct = Math.round(((val - s.min) / (s.max - s.min)) * 100)
                  return (
                    <div key={s.key} style={{ marginBottom: 6 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                        <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.55)' }}>{s.label}</span>
                        <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.35)' }}>{val.toFixed(s.step < 0.01 ? 4 : s.step < 0.1 ? 2 : 1)} ({pct}%)</span>
                      </div>
                      <input
                        type="range" min={s.min} max={s.max} step={s.step}
                        value={val}
                        onChange={(e) => onSettingChange?.(s.key, parseFloat(e.target.value))}
                        style={{ width: '100%', accentColor: BRAND_VIOLET, height: 3 }}
                      />
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Main SidebarRail ────────────────────────────────────
export default function SidebarRail({
  visible,
  onToggle,
  activePreset,
  onPreset,
  onZoneJump,
  onSearch,
  onResetView,
  settings,
  onSettingChange,
  activeDepth = 'eq',
  onDepthChange,
}) {
  const [expanded, setExpanded] = useState(null)
  const railRef = useRef(null)

  useEffect(() => {
    if (!expanded) return
    const handler = (e) => {
      if (railRef.current && !railRef.current.contains(e.target)) {
        setExpanded(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [expanded])

  const togglePanel = useCallback((panel) => {
    setExpanded(prev => prev === panel ? null : panel)
  }, [])

  return (
    <div
      ref={railRef}
      style={{
        position: 'fixed',
        top: 44,
        left: 0,
        bottom: 8,
        zIndex: 30,
        display: 'flex',
        flexDirection: 'row',
        pointerEvents: 'auto',
      }}
    >
      <div style={{
        width: RAIL_WIDTH,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 2,
        paddingTop: 8,
        paddingBottom: 8,
        background: GLASS_BG,
        borderRight: '1px solid rgba(139, 92, 246, 0.12)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        overflowY: 'auto',
        overflowX: 'hidden',
      }}>
        {/* Depth layer buttons */}
        {DEPTH_LAYERS.map(layer => (
          <IconButton
            key={layer.key}
            icon={layer.icon}
            label={layer.label}
            active={activeDepth === layer.key}
            onClick={() => { onDepthChange?.(layer.key); onZoneJump?.(layer.position); setExpanded(null) }}
          />
        ))}

        <div style={{
          width: 20, height: 1,
          background: 'rgba(6, 182, 212, 0.2)',
          margin: '4px 0',
          flexShrink: 0,
        }} />

        {/* Zone jump buttons */}
        {ZONE_ICONS.map(zone => (
          <IconButton
            key={zone.key}
            icon={zone.icon}
            label={zone.label}
            onClick={() => { onZoneJump?.(zone.position); setExpanded(null) }}
          />
        ))}

        <div style={{
          width: 20, height: 1,
          background: 'rgba(139, 92, 246, 0.15)',
          margin: '4px 0',
          flexShrink: 0,
        }} />

        <IconButton
          icon={'\u{1F50D}'}
          label="Search (/)"
          onClick={() => { onSearch?.(); setExpanded(null) }}
        />
        <IconButton
          icon={'\u{1F4CB}'}
          label="Presets (L)"
          active={expanded === 'presets'}
          onClick={() => togglePanel('presets')}
        />
        <IconButton
          icon={'\u{1F441}'}
          label="Layers"
          active={expanded === 'layers'}
          onClick={() => togglePanel('layers')}
        />
        <IconButton
          icon={'\u2699'}
          label="Settings"
          active={expanded === 'settings'}
          onClick={() => togglePanel('settings')}
        />

        <div style={{
          width: 20, height: 1,
          background: 'rgba(139, 92, 246, 0.15)',
          margin: '4px 0',
          flexShrink: 0,
        }} />

        <IconButton
          icon={'\u21BA'}
          label="Reset View"
          onClick={() => { onResetView?.(); setExpanded(null) }}
        />
      </div>

      {expanded && (
        <div style={{
          width: PANEL_WIDTH,
          background: GLASS_BG,
          borderRight: '1px solid rgba(139, 92, 246, 0.12)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          fontFamily: FONT_STACK,
          overflowY: 'auto',
        }}>
          {expanded === 'layers' && (
            <LayerPanel visible={visible} onToggle={onToggle} />
          )}
          {expanded === 'presets' && (
            <PresetPanel activePreset={activePreset} onPreset={onPreset} />
          )}
          {expanded === 'settings' && (
            <SettingsPanel settings={settings} onSettingChange={onSettingChange} />
          )}
        </div>
      )}
    </div>
  )
}
