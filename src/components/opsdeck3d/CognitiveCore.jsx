/**
 * CognitiveCore — The R3F scene that composes all zones + effects.
 *
 * Everything that renders INSIDE the <Canvas> lives here.
 * Extracted from CognitiveCore3DView.jsx (Phase CC-10 refactor).
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing'
import * as THREE from 'three'

import { damp3 } from 'maath/easing'

import { PALETTE } from './lib/design-system'
import { getActiveZone } from './lib/scanner-projection'

import RadarCompass from './zones/RadarCompass'
import AmbientParticles from './effects/AmbientParticles'
import Nucleus from './zones/Nucleus'
import CoreShell from './zones/CoreShell'
import ImplantsRing from './zones/ImplantsRing'
import FocusBeam from './effects/FocusBeam'
import ShockwaveRipple from './effects/ShockwaveRipple'
import AgentMesh from './zones/AgentMesh'
// ZoneRings default export removed — absorbed into RadarCompass.
// Named exports (TaskOrbitPath, MemoryOrbitPath) still used by MemoryLattice/ObjectiveCluster.
import ExecutionLayer from './zones/ExecutionLayer'
import MemoryLattice from './zones/MemoryLattice'
import DataHighways from './effects/DataHighways'
import NestedShells from './zones/NestedShells'
import AssignmentBeams from './effects/AssignmentBeams'
import TeamLabels from './zones/TeamLabels'
import TeamClusters from './zones/TeamClusters'
import WormholePortal from './zones/WormholePortal'
import ServiceNodes from './zones/ServiceNodes'
import HelicalSpine from './zones/HelicalSpine'
import InfraLayer from './zones/InfraLayer'
import PluginConstellation from './zones/PluginConstellation'
import OrgStructure from './zones/OrgStructure'
import SpeechBubble from './effects/SpeechBubble'
import SearchBeacons from './effects/SearchBeacons'
import ToolDots from './zones/ToolDots'
import WorkflowDots from './zones/WorkflowDots'
import IntegrationDots from './zones/IntegrationDots'
import LLMProviderDots from './zones/LLMProviderDots'
import FloatingPanel from './prototypes/FloatingPanel'
import SimulationRunner from './prototypes/SimulationRunner'
import Horus from './zones/Horus'

// ─── Fog controller ─────────────────────────────────────
function FogSetup({ density }) {
  const { scene } = useThree()
  useEffect(() => {
    scene.fog = new THREE.FogExp2(0x050510, density)
    scene.background = new THREE.Color(0x050510)
    return () => { scene.fog = null }
  }, [scene, density])
  return null
}

// ─── Heartbeat Pulse Manager ────────────────────────────
function HeartbeatPulse({ interval = 8 }) {
  const [ripples, setRipples] = useState([])
  const lastPulse = useRef(0)

  useFrame((state) => {
    try {
      const elapsed = state.clock.elapsedTime
      if (elapsed - lastPulse.current >= interval) {
        lastPulse.current = elapsed
        setRipples((prev) => [...prev, { id: elapsed }])
      }
    } catch { /* ref not ready */ }
  })

  const handleComplete = useCallback((id) => {
    setRipples((prev) => prev.filter((r) => r.id !== id))
  }, [])

  return (
    <>
      {ripples.map((r) => (
        <ShockwaveRipple
          key={r.id}
          position={[0, 0, 0]}
          color={PALETTE.indigo}
          maxOpacity={0.025}
          maxRadius={80}
          duration={5}
          onComplete={() => handleComplete(r.id)}
        />
      ))}
    </>
  )
}

// ─── Target Lock Controller ─────────────────────────────
// Smart camera: ease-out curves, contextual zoom, auto-framing.
// Single click = smooth orbit refocus. Double-click/search = fly + frame.
function TargetLockController({ controlsRef, orbitTarget = [0, 0, 0], zoomToTarget = false, orbitLocked = false }) {
  const zooming = useRef(false)
  const zoomFlag = useRef(false)
  const zoomProgress = useRef(0) // 0→1 smooth flight progress

  // Track zoomToTarget changes
  if (zoomToTarget !== zoomFlag.current) {
    zoomFlag.current = zoomToTarget
    if (zoomToTarget) { zooming.current = true; zoomProgress.current = 0 }
  }

  useFrame(({ camera: cam }, delta) => {
    try {
      if (!controlsRef?.current?.target) return
      if (typeof controlsRef.current.target.x !== 'number') return
      if (!orbitTarget || !Array.isArray(orbitTarget) || orbitTarget.length < 3) return

      const tx = orbitTarget[0] ?? 0
      const ty = orbitTarget[1] ?? 0
      const tz = orbitTarget[2] ?? 0
      const isOrigin = tx === 0 && ty === 0 && tz === 0

      // Smooth orbit target tracking — ease-out via damp3 (lambda=0.12 for gentle decel)
      const targetArr = isOrigin ? [0, 0, 0] : [tx, ty, tz]
      damp3(controlsRef.current.target, targetArr, 0.12, delta)

      // Zoom flight: smooth ease-out curve to contextual distance
      if (zooming.current && cam && !isOrigin) {
        const targetVec = new THREE.Vector3(tx, ty, tz)
        const dist = cam.position.distanceTo(targetVec)

        // Contextual ideal distance based on target's radius from origin
        const targetR = targetVec.length()
        const idealDist = targetR < 10 ? 6 : targetR < 50 ? 12 : targetR < 120 ? 25 : 40

        // Smooth ease-out: fast start, gentle arrival
        zoomProgress.current = Math.min(1, zoomProgress.current + delta * 1.8)
        const t = 1 - Math.pow(1 - zoomProgress.current, 3) // cubic ease-out

        if (dist > idealDist + 0.5 && zoomProgress.current < 1) {
          const dir = targetVec.clone().sub(cam.position).normalize()
          const speed = (dist - idealDist) * (1 - t) * 3 + 2 // decelerates as we approach
          cam.position.add(dir.multiplyScalar(delta * speed))

          // Auto-frame: bias camera slightly above target for natural viewing angle
          const yBias = Math.max(1, idealDist * 0.15)
          const currentYOffset = cam.position.y - ty
          if (currentYOffset < yBias) {
            cam.position.y += delta * (yBias - currentYOffset) * 2
          }
        } else {
          zooming.current = false
        }
      }

      // Auto-adjust near/far planes based on camera distance from origin
      if (cam) {
        const camDist = cam.position.length()
        const nearPlane = camDist < 20 ? 0.1 : camDist < 100 ? 0.5 : 1.0
        if (Math.abs(cam.near - nearPlane) > 0.05) {
          cam.near = nearPlane
          cam.updateProjectionMatrix()
        }
      }

      if (typeof controlsRef.current.update === 'function') {
        controlsRef.current.update()
      }
    } catch {}
  })

  return null
}

// ─── Void Click Detector ────────────────────────────────
function VoidClickDetector({ onVoidClick }) {
  return (
    <mesh
      position={[0, -20, 0]}
      rotation={[-Math.PI / 2, 0, 0]}
      onClick={(e) => {
        // Only fire if this is the first hit (nothing closer was clicked)
        if (e.intersections.length > 0 && e.intersections[0].object === e.object) {
          onVoidClick()
        }
      }}
      visible={false}
    >
      <planeGeometry args={[500, 500]} />
      <meshBasicMaterial transparent opacity={0} side={THREE.DoubleSide} />
    </mesh>
  )
}

// ─── Camera Zone Tracker ────────────────────────────────
function CameraZoneTracker({ onZoneChange, onCameraUpdate }) {
  const lastZone = useRef('')
  const frameCount = useRef(0)
  useFrame(({ camera }) => {
    try {
      const r = camera.position.length()
      const zone = getActiveZone(r)
      if (zone.zone !== lastZone.current) {
        lastZone.current = zone.zone
        onZoneChange(zone.zone)
      }
      // Pipe camera data every 3 frames (throttle for perf)
      frameCount.current++
      if (onCameraUpdate && frameCount.current % 3 === 0) {
        const dir = new THREE.Vector3()
        camera.getWorldDirection(dir)
        onCameraUpdate({
          position: camera.position.toArray(),
          direction: dir.toArray(),
          fov: camera.fov,
        })
      }
    } catch { /* ref not ready */ }
  })
  return null
}

// ─── FPS Counter hook ───────────────────────────────────
function useFps() {
  const frames = useRef(0)
  const lastTime = useRef(performance.now())
  const [fps, setFps] = useState(0)

  useFrame(() => {
    try {
      frames.current++
      const now = performance.now()
      if (now - lastTime.current >= 1000) {
        setFps(frames.current)
        frames.current = 0
        lastTime.current = now
      }
    } catch { /* ref not ready */ }
  })

  return fps
}

// ─── FPS display (inside Canvas) ────────────────────────
export function FpsCounter({ onFps }) {
  const fps = useFps()
  useEffect(() => { onFps?.(fps) }, [fps, onFps])
  return null
}

// ─── GL Info Reporter (draw calls, triangles) ───────────
export function GlInfoReporter({ onGlInfo }) {
  const { gl } = useThree()
  const frameCount = useRef(0)
  useFrame(() => {
    frameCount.current++
    if (frameCount.current % 60 === 0 && onGlInfo) {
      onGlInfo(gl.info)
    }
  })
  return null
}

// ─── Orbit Target Crosshair ─────────────────────────────
// Faint cross at orbit center — shows WHERE you're orbiting around
function OrbitCrosshair({ position }) {
  const groupRef = useRef()
  useFrame(({ camera }) => {
    try {
      if (!groupRef.current) return
      // Scale with camera distance so it's always barely visible
      const dist = camera.position.distanceTo(groupRef.current.position)
      const scale = Math.min(2.0, Math.max(0.3, dist * 0.03))
      groupRef.current.scale.setScalar(scale)
    } catch {}
  })
  if (!position || !Array.isArray(position)) return null
  const isOrigin = position[0] === 0 && position[1] === 0 && position[2] === 0
  if (isOrigin) return null
  return (
    <group ref={groupRef} position={position}>
      {/* Horizontal cross line */}
      <mesh><cylinderGeometry args={[0.005, 0.005, 1, 4]} /><meshBasicMaterial color="#ffffff" transparent opacity={0.08} depthWrite={false} /></mesh>
      {/* Vertical cross line */}
      <mesh rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[0.005, 0.005, 1, 4]} /><meshBasicMaterial color="#ffffff" transparent opacity={0.08} depthWrite={false} /></mesh>
      {/* Depth cross line */}
      <mesh rotation={[Math.PI / 2, 0, 0]}><cylinderGeometry args={[0.005, 0.005, 1, 4]} /><meshBasicMaterial color="#ffffff" transparent opacity={0.08} depthWrite={false} /></mesh>
    </group>
  )
}

// ─── Selection Ring ──────────────────────────────────────
// Auto-scales with camera distance so it's visible at all zoom levels
function SelectionRing({ position }) {
  const groupRef = useRef()
  const ring1Ref = useRef()
  useFrame(({ camera }) => {
    try {
      if (!groupRef.current) return
      groupRef.current.rotation.y += 0.015
      // Scale ring based on distance from camera (min 0.6, max 3.0)
      const dist = camera.position.distanceTo(groupRef.current.position)
      const scale = Math.min(3.0, Math.max(0.6, dist * 0.06))
      groupRef.current.scale.setScalar(scale)
      if (ring1Ref.current) ring1Ref.current.material.opacity = 0.15 + Math.sin(Date.now() * 0.004) * 0.06
    } catch {}
  })
  if (!position || !Array.isArray(position)) return null
  if (position[0] === 0 && position[1] === 0 && position[2] === 0) return null
  return (
    <group ref={groupRef} position={position}>
      {/* Hot white core ring */}
      <mesh ref={ring1Ref} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1.2, 0.02, 8, 48]} />
        <meshBasicMaterial color="#e0ffff" transparent opacity={0.4} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      {/* Cyan colour ring */}
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1.25, 0.04, 8, 48]} />
        <meshBasicMaterial color="#22d3ee" transparent opacity={0.25} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      {/* Outer glow ring */}
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1.3, 0.08, 8, 48]} />
        <meshBasicMaterial color="#22d3ee" transparent opacity={0.08} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      {/* Cross ring (diagonal) */}
      <mesh rotation={[0, 0, Math.PI / 4]}>
        <torusGeometry args={[1.2, 0.015, 8, 48]} />
        <meshBasicMaterial color="#22d3ee" transparent opacity={0.15} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      {/* Vertical pin line */}
      <mesh position={[0, 1.5, 0]}>
        <cylinderGeometry args={[0.004, 0.004, 3, 4]} />
        <meshBasicMaterial color="#22d3ee" transparent opacity={0.2} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      {/* Pin top marker */}
      <mesh position={[0, 3, 0]}>
        <octahedronGeometry args={[0.08, 0]} />
        <meshBasicMaterial color="#e0ffff" transparent opacity={0.4} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
    </group>
  )
}

// ─── Main Scene ─────────────────────────────────────────
export default function CognitiveCore({
  visible,
  settings,
  overlayMode = 'default',
  systemState,
  agents,
  objectives,
  implants,
  memories,
  agentPositions,
  activeImplantCount,
  orbitTarget,
  zoomToTarget = false,
  orbitLocked = false,
  onSelect,
  onVoidClick,
  onZoneChange,
  controlsRef: externalControlsRef,
  delegations,
  onZoneSelect,
  onCameraUpdate,
  aeeEnvelopes = [],
  voltRuns = [],
  aoclStats = [],
  currentFocus = null,
  speechBubbles = [],
  onDismissBubble,
  searchResults = [],
  searchActiveIndex = -1,
  onHorusAlert,
}) {
  const internalControlsRef = useRef()
  const controlsRef = externalControlsRef || internalControlsRef

  // Resolve FocusBeam target from real currentFocus (WSM)
  const focusBeamTarget = useMemo(() => {
    if (!currentFocus?.task && !currentFocus?.project) return null
    const focusKey = (currentFocus.task || currentFocus.project || '').toLowerCase()
    if (!focusKey) return null
    // Try to match focus to an agent position — beam points to the relevant agent
    if (agentPositions instanceof Map) {
      for (const [id, pos] of agentPositions) {
        if (focusKey.includes(id)) return pos
      }
    }
    // Try matching agent names
    const matchedAgent = agents?.find(a =>
      focusKey.includes(a.id) || focusKey.includes((a.name || '').toLowerCase())
    )
    if (matchedAgent && agentPositions instanceof Map) {
      const pos = agentPositions.get(matchedAgent.id)
      if (pos) return pos
    }
    // Default: point toward execution layer (r=30) if focus exists but no agent match
    return [30, 0, 0]
  }, [currentFocus, agents, agentPositions])

  // Destructure onSelect handlers (the view passes a single onSelect with a type field,
  // but the zone components expect individual callbacks)
  const onImplantSelect = useCallback((item) => onSelect?.({ type: 'implant', ...item }), [onSelect])
  const onAgentSelect = useCallback((item) => onSelect?.(item), [onSelect])
  const onObjectiveSelect = useCallback((item) => onSelect?.(item), [onSelect])
  const onMemorySelect = useCallback((item) => onSelect?.(item), [onSelect])

  return (
    <>
      <FogSetup density={settings.fogDensity} />
      <ambientLight intensity={settings.ambientIntensity} />
      <pointLight position={[20, 40, 20]} intensity={0.4} color={PALETTE.indigo} />
      <pointLight position={[-30, -10, -20]} intensity={0.3} color={PALETTE.violet} />

      {/* RadarCompass at y=0: unified radar/compass disc (replaces HoloGrid + ZoneRings) */}
      {(visible.holoGrid || visible.jumpNodes) && <RadarCompass gridOpacity={visible.holoGrid ? (settings.gridOpacity != null ? settings.gridOpacity * 5.0 : 1.0) : 0} onZoneSelect={onZoneSelect} showJumpNodes={visible.jumpNodes !== false} />}
      {visible.particles && <AmbientParticles />}
      {visible.nucleus && <Nucleus systemState={systemState} activeImplantCount={activeImplantCount} settings={settings} />}
      {visible.horus && (() => {
        const hue = settings.horusEyeHue ?? 0
        const eyeCol = `hsl(${hue}, 100%, 50%)`
        return <Horus agents={agents} objectives={objectives} implants={implants} onSelect={onSelect} onAlert={onHorusAlert} eyeColor={eyeCol} selectedTarget={orbitTarget[0] !== 0 || orbitTarget[1] !== 0 || orbitTarget[2] !== 0 ? orbitTarget : null} />
      })()}
      {visible.shell && <CoreShell settings={settings} />}
      {visible.implants && <ImplantsRing implants={implants} settings={settings} onSelect={onImplantSelect} />}
      {visible.agents && (
        <AgentMesh
          agents={agents}
          settings={settings}
          onSelect={onAgentSelect}
          delegations={delegations}
          overlayMode={overlayMode}
        />
      )}
      {visible.execution && (
        <ExecutionLayer
          objectives={objectives}
          settings={settings}
          onSelect={onObjectiveSelect}
        />
      )}
      {visible.memory && (
        <MemoryLattice
          memories={memories}
          settings={settings}
          onSelect={onMemorySelect}
        />
      )}
      {/* ZoneRings absorbed into RadarCompass — removed */}
      {visible.focusBeam && <FocusBeam targetPosition={focusBeamTarget || [30, 0, 0]} active={!!focusBeamTarget || objectives?.some(o => o.tasks?.some(t => t.status === 'running'))} />}
      {visible.heartbeat && <HeartbeatPulse interval={settings.heartbeatInterval || 8} />}
      {visible.highways && (
        <DataHighways
          active={
            objectives?.some(o => o.tasks?.some(t => t.status === 'running')) ||
            agents?.some(a => a.state === 'executing' || a.state === 'thinking' || a.state === 'reading')
          }
          settings={settings}
        />
      )}
      {visible.nestedShells && <NestedShells settings={settings} />}
      {visible.nestedShells && <WormholePortal position={[130, 0, 0]} />}
      {visible.services && <ServiceNodes settings={settings} onSelect={onSelect} />}
      {visible.protocols && <HelicalSpine envelopes={aeeEnvelopes} voltRuns={voltRuns} aoclStats={aoclStats} onSelect={onSelect} />}
      {visible.infra && <InfraLayer settings={settings} onSelect={onSelect} />}
      {visible.execution && (
        <AssignmentBeams objectives={objectives} agentPositions={agentPositions} />
      )}
      {/* TeamLabels removed — TeamClusters handles team visualization */}
      {visible.orgs && <OrgStructure onSelect={onSelect} />}
      {visible.teams && <TeamClusters onSelect={onSelect} objectives={objectives} />}
      {visible.plugins && <PluginConstellation onSelect={onSelect} />}
      {visible.tools && <ToolDots agents={agents} onSelect={onSelect} />}
      {visible.workflows && <WorkflowDots />}
      {visible.integrations && <IntegrationDots onSelect={onSelect} />}
      {visible.llmProviders && <LLMProviderDots onSelect={onSelect} />}
      {visible.floatingPanels && <FloatingPanel />}
      {visible.simulation && <SimulationRunner />}

      <VoidClickDetector onVoidClick={onVoidClick} />
      <TargetLockController controlsRef={controlsRef} orbitTarget={orbitTarget} zoomToTarget={zoomToTarget} orbitLocked={orbitLocked} />
      <OrbitCrosshair position={orbitTarget} />
      <SelectionRing position={orbitTarget} />

      {/* Speech bubbles — appear over agent nodes when they speak */}
      {speechBubbles.map(bubble => (
        <SpeechBubble
          key={bubble.id}
          position={bubble.position}
          text={bubble.text}
          agentColor={bubble.color}
          agentName={bubble.agentName}
          onDismiss={() => onDismissBubble?.(bubble.id)}
        />
      ))}
      {/* Search beacon beams — visible from any distance */}
      <SearchBeacons results={searchResults} activeIndex={searchActiveIndex} />

      <CameraZoneTracker onZoneChange={onZoneChange} onCameraUpdate={onCameraUpdate} />

      <OrbitControls
        ref={controlsRef}
        makeDefault
        enableDamping
        dampingFactor={0.05}
        minDistance={3}
        maxDistance={400}
        enablePan
        panSpeed={0.5}
        rotateSpeed={0.5}
        zoomSpeed={0.8}
      />

      <EffectComposer>
        <Bloom
          intensity={settings.bloomIntensity}
          luminanceThreshold={settings.bloomThreshold}
          luminanceSmoothing={settings.bloomSmoothing}
          mipmapBlur
        />
        <Vignette offset={0.3} darkness={settings.vignetteStrength} />
      </EffectComposer>
    </>
  )
}
