/**
 * BottomControls — Hex tile control panels flanking the scanner disc.
 *
 * LEFT of minimap: Layout save/load slots (1-5) + save button
 * RIGHT of minimap: Toggle controls (Map, Orbit, Grid, Stars, Shell, Perf, Reset)
 *
 * Uses HexButton for consistent cockpit aesthetic.
 */
import { useState, useCallback } from 'react'
import HexButton, { HexPanel } from './HexButton'

const SLOT_KEY = 'cogcore3d_layout_slots'
const MAX_SLOTS = 5

function loadSlots() {
  try {
    return JSON.parse(localStorage.getItem(SLOT_KEY)) || {}
  } catch { return {} }
}

function saveSlotData(slotId, data) {
  const slots = loadSlots()
  slots[slotId] = { ...data, savedAt: Date.now() }
  localStorage.setItem(SLOT_KEY, JSON.stringify(slots))
}

// ─── Layout Slots (left of minimap) ─────────────────────
function LayoutSlots({ visible, settings, activePreset, onLoadSlot }) {
  const [slots, setSlots] = useState(loadSlots)
  const [saveMode, setSaveMode] = useState(false)

  const handleSave = useCallback((slotId) => {
    saveSlotData(slotId, { visible, settings, activePreset })
    setSlots(loadSlots())
    setSaveMode(false)
  }, [visible, settings, activePreset])

  const handleLoad = useCallback((slotId) => {
    const s = slots[slotId]
    if (s) onLoadSlot?.(s)
  }, [slots, onLoadSlot])

  return (
    <HexPanel style={{ flexDirection: 'column', alignItems: 'center', gap: 3 }}>
      {/* Save toggle */}
      <HexButton
        icon={saveMode ? '\u2714' : '\u{1F4BE}'}
        label={saveMode ? 'Pick' : 'Save'}
        active={saveMode}
        onClick={() => setSaveMode(p => !p)}
        color="#22c55e"
        size={32}
      />
      {/* Slot buttons */}
      <div style={{ display: 'flex', gap: 3 }}>
        {Array.from({ length: MAX_SLOTS }, (_, i) => {
          const slotId = `slot_${i + 1}`
          const hasData = !!slots[slotId]
          return (
            <HexButton
              key={slotId}
              icon={`${i + 1}`}
              label={hasData ? 'Saved' : 'Empty'}
              active={hasData}
              onClick={() => saveMode ? handleSave(slotId) : handleLoad(slotId)}
              color={saveMode ? '#22c55e' : '#8b5cf6'}
              size={30}
              tooltip={saveMode ? `Save to slot ${i + 1}` : hasData ? `Load slot ${i + 1}` : `Empty slot ${i + 1}`}
            />
          )
        })}
      </div>
    </HexPanel>
  )
}

// ─── Toggle Controls (right of minimap) ─────────────────
function ToggleControls({
  minimapVisible, onToggleMinimap,
  orbitLocked, onToggleOrbitLock,
  gridVisible, onToggleGrid,
  particlesVisible, onToggleParticles,
  perfHudVisible, onTogglePerfHud,
  shellVisible, onToggleShell,
  onResetView,
}) {
  return (
    <HexPanel>
      <HexButton icon={'\u25CE'} label="Map" active={minimapVisible} onClick={onToggleMinimap} color="#22d3ee" size={34} />
      <HexButton icon={'\u{1F512}'} label="Orbit" active={orbitLocked} onClick={onToggleOrbitLock} color="#8b5cf6" size={34} />
      <HexButton icon={'\u25A6'} label="Grid" active={gridVisible} onClick={onToggleGrid} color="#33ff66" size={34} />
      <HexButton icon={'\u2726'} label="Stars" active={particlesVisible} onClick={onToggleParticles} color="#f59e0b" size={34} />
      <HexButton icon={'\u2B21'} label="Shell" active={shellVisible} onClick={onToggleShell} color="#a78bfa" size={34} />
      <HexButton icon={'\u{1F4CA}'} label="Perf" active={perfHudVisible} onClick={onTogglePerfHud} color="#ef4444" size={34} />
      <HexButton icon={'\u21BA'} label="Reset" onClick={onResetView} color="#555570" size={34} />
    </HexPanel>
  )
}

// ─── Main Component ─────────────────────────────────────
export default function BottomControls({
  minimapVisible = true, onToggleMinimap,
  orbitLocked = true, onToggleOrbitLock,
  gridVisible = true, onToggleGrid,
  particlesVisible = true, onToggleParticles,
  perfHudVisible = false, onTogglePerfHud,
  shellVisible = true, onToggleShell,
  onResetView,
  // Layout slot props
  visible, settings, activePreset, onLoadSlot,
}) {
  return (
    <>
      {/* Left of minimap: layout save slots */}
      <div style={{
        position: 'absolute', bottom: 12, left: '50%',
        transform: 'translateX(calc(-50% - 260px))',
        zIndex: 12, pointerEvents: 'auto',
      }}>
        <LayoutSlots
          visible={visible}
          settings={settings}
          activePreset={activePreset}
          onLoadSlot={onLoadSlot}
        />
      </div>

      {/* Right of minimap: toggle controls */}
      <div style={{
        position: 'absolute', bottom: 12, left: '50%',
        transform: 'translateX(calc(-50% + 260px))',
        zIndex: 12, pointerEvents: 'auto',
      }}>
        <ToggleControls
          minimapVisible={minimapVisible} onToggleMinimap={onToggleMinimap}
          orbitLocked={orbitLocked} onToggleOrbitLock={onToggleOrbitLock}
          gridVisible={gridVisible} onToggleGrid={onToggleGrid}
          particlesVisible={particlesVisible} onToggleParticles={onToggleParticles}
          perfHudVisible={perfHudVisible} onTogglePerfHud={onTogglePerfHud}
          shellVisible={shellVisible} onToggleShell={onToggleShell}
          onResetView={onResetView}
        />
      </div>
    </>
  )
}
