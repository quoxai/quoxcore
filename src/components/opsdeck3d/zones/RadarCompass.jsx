/**
 * RadarCompass — Unified radar/compass orientation layer at y=0.
 *
 * Fibonacci-spaced concentric rings: gaps grow outward (φ ratio) so outer
 * zones have proportionally more room for future node growth.
 *
 * Single-draw-call GLSL shader disc rendering rings, compass radials,
 * radar sweep, and tick marks. Billboard labels for zone names + cardinals.
 */
import { useRef, useMemo, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text, Html } from '@react-three/drei'
import * as THREE from 'three'

// ─── Fibonacci-spaced zone ring definitions ─────────────
// Gaps: 4, 3, 5, 5, 8, 13, 21, 21, 25, 25 (φ-ratio growth)
// Labels on cardinal spokes (N/E/S/W), cycling through 4 spokes
// spoke: 0=N(+z), 1=E(+x), 2=S(-z), 3=W(-x)
export const ZONE_RINGS = [
  { label: 'SERVICES',       radius: 4,   spoke: 0, cameraPos: [0, 3, 8] },
  { label: 'IMPLANTS',       radius: 7,   spoke: 1, cameraPos: [10, 4, 0] },
  { label: 'PLUGINS',        radius: 12,  spoke: 2, cameraPos: [0, 5, -16] },
  { label: 'ASSISTANTS',     radius: 17,  spoke: 3, cameraPos: [-22, 6, 0] },
  { label: 'AGENTS',         radius: 25,  spoke: 0, cameraPos: [0, 7, 30] },
  { label: 'ORG STRUCTURE',  radius: 30,  spoke: 1, cameraPos: [35, 8, 0] },
  { label: 'TEAMS',          radius: 38,  spoke: 2, cameraPos: [0, 8, -42] },
  { label: 'TEAMS EXT',      radius: 59,  spoke: 3, cameraPos: [-65, 10, 0] },
  { label: 'OBJ EXECUTION',  radius: 80,  spoke: 0, cameraPos: [0, 12, 88] },
  { label: 'WF EXECUTION',   radius: 90,  spoke: 1, cameraPos: [98, 14, 0] },
  { label: 'MEMORY',         radius: 105, spoke: 2, cameraPos: [0, 16, -115] },
  { label: 'VAULT',          radius: 120, spoke: 3, cameraPos: [-130, 18, 0] },
  { label: 'SHELL',          radius: 130, spoke: 0, cameraPos: [0, 20, 140] },
]

// Cardinal spoke directions: N=+z, E=+x, S=-z, W=-x (labels go here)
const SPOKE_DIRS = [
  [0, 0, 1],   // N
  [1, 0, 0],   // E
  [0, 0, -1],  // S
  [-1, 0, 0],  // W
]

// ─── Warp Lanes (V2-NAV-3) — 6 radial lanes replacing 52 diagonal jump nodes
// Each lane has stops at major zone boundaries. Click stop → camera rides there.
const LANE_COUNT = 6
const LANE_STOPS = [
  { label: 'Services',  radius: 4 },
  { label: 'Implants',  radius: 7 },
  { label: 'Agents',    radius: 25 },
  { label: 'Teams',     radius: 38 },
  { label: 'Execution', radius: 80 },
  { label: 'Memory',    radius: 105 },
  { label: 'Shell',     radius: 130 },
]

function buildWarpLanes() {
  const lanes = []
  for (let li = 0; li < LANE_COUNT; li++) {
    const angle = (li / LANE_COUNT) * Math.PI * 2
    const dx = Math.cos(angle)
    const dz = Math.sin(angle)
    const stops = LANE_STOPS.map(stop => {
      const x = dx * stop.radius
      const z = dz * stop.radius
      const camH = 4 + stop.radius * 0.08
      return {
        label: stop.label,
        radius: stop.radius,
        position: [x, 0.3, z],
        cameraPos: [x * 1.1, camH, z * 1.1],
        laneIndex: li,
      }
    })
    lanes.push({ angle, dx, dz, stops })
  }
  return lanes
}

const WARP_LANES = buildWarpLanes()

// Strategic vantage points
const VANTAGE_NODES = [
  { label: 'Top Down',     position: [0, 80, 1],    icon: '\u25BD' },
  { label: 'Side Profile', position: [150, 5, 0],   icon: '\u25B6' },
  { label: 'Deep View',    position: [12, -15, 22], icon: '\u25B3' },
]

const OUTER_RADIUS = 135 // Fade + tick boundary
const CARDINAL_RADIUS = OUTER_RADIUS + 2

const CARDINAL_MARKERS = [
  { label: 'N', position: [0, 0.2, CARDINAL_RADIUS] },
  { label: 'S', position: [0, 0.2, -CARDINAL_RADIUS] },
  { label: 'E', position: [CARDINAL_RADIUS, 0.2, 0] },
  { label: 'W', position: [-CARDINAL_RADIUS, 0.2, 0] },
]

// ─── Shaders ────────────────────────────────────────────

const vertexShader = `
varying vec2 vWorldPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`

// Build the ring radius array as a GLSL constant
const RING_RADII = ZONE_RINGS.map(z => z.radius.toFixed(1))

const fragmentShader = `
uniform float uTime;
uniform float uOpacity;
varying vec2 vWorldPos;

#define PI 3.14159265359
#define TWO_PI 6.28318530718
#define RING_COUNT ${ZONE_RINGS.length}

void main() {
  float dist = length(vWorldPos);
  float angle = atan(vWorldPos.y, vWorldPos.x);

  // ── Fade at edges ─────────────────────────
  float fade = 1.0 - smoothstep(${(OUTER_RADIUS - 5).toFixed(1)}, ${(OUTER_RADIUS + 5).toFixed(1)}, dist);
  if (fade < 0.001) discard;

  // ── Concentric zone rings (double-line neon) ──
  float ringRadii[RING_COUNT];
  ${RING_RADII.map((r, i) => `ringRadii[${i}] = ${r};`).join('\n  ')}

  float ring = 0.0;
  for (int i = 0; i < RING_COUNT; i++) {
    float r = ringRadii[i];
    // Sharp inner line (thin, bright)
    float ringSharp = (1.0 - smoothstep(0.0, 0.12, abs(dist - r))) * 0.14;
    // Soft outer glow (tighter, dimmer)
    float ringGlow = (1.0 - smoothstep(0.0, 0.6, abs(dist - r))) * 0.03;
    ring += ringSharp + ringGlow;
  }

  // ── Radial lines (12 compass spokes) ──────
  float normAngle = mod(angle + TWO_PI, TWO_PI);

  float segAngle = TWO_PI / 12.0;
  float radialPhase = mod(normAngle + segAngle * 0.5, segAngle) - segAngle * 0.5;
  float radial = (1.0 - smoothstep(0.0, 0.012, abs(radialPhase))) * 0.04;
  radial *= step(0.0, dist) * (1.0 - step(${CARDINAL_RADIUS.toFixed(1)}, dist));

  // Cardinal lines (every 90 degrees) brighter
  float cardSegAngle = TWO_PI / 4.0;
  float cardPhase = mod(normAngle + cardSegAngle * 0.5, cardSegAngle) - cardSegAngle * 0.5;
  float cardinal = (1.0 - smoothstep(0.0, 0.018, abs(cardPhase))) * 0.06;
  cardinal *= step(0.0, dist) * (1.0 - step(${CARDINAL_RADIUS.toFixed(1)}, dist));

  // ── Tick marks at outer edge ────
  float tickPhase = mod(normAngle + segAngle * 0.5, segAngle) - segAngle * 0.5;
  float tick = (1.0 - smoothstep(0.0, 0.015, abs(tickPhase)))
             * smoothstep(${(OUTER_RADIUS - 2).toFixed(1)}, ${(OUTER_RADIUS - 1.5).toFixed(1)}, dist)
             * (1.0 - smoothstep(${(OUTER_RADIUS + 0.5).toFixed(1)}, ${(OUTER_RADIUS + 1).toFixed(1)}, dist))
             * 0.08;

  // ── Radar sweep (~20s per revolution) — faint orientation hint ──
  float sweepAngle = mod(uTime * 0.32, TWO_PI);
  float angleDiff = mod(normAngle - sweepAngle + TWO_PI, TWO_PI);
  float sweep = smoothstep(0.8, 0.0, angleDiff) * 0.018;
  float edge = smoothstep(0.06, 0.0, angleDiff) * 0.024;
  float radar = (sweep + edge) * smoothstep(5.0, 12.0, dist);

  // ── Combine ───────────────────────────────
  vec3 baseColor = vec3(0.2, 1.0, 0.4); // Vivid neon green
  float alpha = (ring + max(radial, cardinal) + tick + radar) * fade;

  alpha *= uOpacity;
  if (alpha < 0.003) discard;
  gl_FragColor = vec4(baseColor, alpha);
}
`

// ─── Clickable zone label on spoke (AR HUD — fixed screen size) ──
function ZoneLabel({ zone, gridOpacity, onSelect }) {
  const dir = SPOKE_DIRS[zone.spoke ?? 0]
  const pos = [dir[0] * zone.radius, 0.4, dir[2] * zone.radius]

  return (
    <group position={pos}>
      <Html center style={{ pointerEvents: 'auto' }} zIndexRange={[5, 0]}>
        <div
          onClick={(e) => { e.stopPropagation(); onSelect?.(zone.cameraPos) }}
          style={{
            padding: '2px 6px', borderRadius: 3, cursor: 'pointer',
            background: 'rgba(5, 5, 16, 0.5)',
            border: '1px solid rgba(51, 255, 102, 0.15)',
            fontSize: 9, fontFamily: "'JetBrains Mono', monospace",
            fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase',
            color: `rgba(51, 255, 102, ${0.5 * gridOpacity})`,
            whiteSpace: 'nowrap', transition: 'all 0.15s ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = `rgba(102, 255, 170, ${0.9 * gridOpacity})`
            e.currentTarget.style.borderColor = 'rgba(102, 255, 170, 0.4)'
            e.currentTarget.style.background = 'rgba(5, 5, 16, 0.8)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = `rgba(51, 255, 102, ${0.5 * gridOpacity})`
            e.currentTarget.style.borderColor = 'rgba(51, 255, 102, 0.15)'
            e.currentTarget.style.background = 'rgba(5, 5, 16, 0.5)'
          }}
        >
          {zone.label}
        </div>
      </Html>
    </group>
  )
}

// ─── Warp Lane Stop (clickable node on a lane) ─────────
function WarpStop({ stop, gridOpacity, onSelect }) {
  return (
    <group position={stop.position}>
      <Html center style={{ pointerEvents: 'auto' }} zIndexRange={[5, 0]}>
        <div
          onClick={(e) => { e.stopPropagation(); onSelect?.(stop.cameraPos) }}
          style={{
            width: 18, height: 18, borderRadius: '50%',
            background: `rgba(6, 182, 212, ${0.25 * gridOpacity})`,
            border: `1.5px solid rgba(6, 182, 212, ${0.45 * gridOpacity})`,
            cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'all 0.15s ease',
            position: 'relative',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = `rgba(34, 211, 238, ${0.7 * gridOpacity})`
            e.currentTarget.style.transform = 'scale(1.3)'
            e.currentTarget.querySelector('.ws-label').style.opacity = '1'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = `rgba(6, 182, 212, ${0.25 * gridOpacity})`
            e.currentTarget.style.transform = 'scale(1)'
            e.currentTarget.querySelector('.ws-label').style.opacity = '0'
          }}
        >
          <div style={{
            width: 5, height: 5, borderRadius: '50%',
            background: `rgba(34, 211, 238, ${0.8 * gridOpacity})`,
          }} />
          <div className="ws-label" style={{
            position: 'absolute', bottom: '130%', left: '50%', transform: 'translateX(-50%)',
            padding: '2px 6px', borderRadius: 3, whiteSpace: 'nowrap',
            background: 'rgba(5, 5, 16, 0.9)', border: '1px solid rgba(6, 182, 212, 0.3)',
            fontSize: 8, fontFamily: "'JetBrains Mono', monospace",
            color: '#22d3ee', letterSpacing: '0.06em',
            opacity: 0, transition: 'opacity 0.15s ease',
            pointerEvents: 'none',
          }}>
            {stop.label}
          </div>
        </div>
      </Html>
    </group>
  )
}

// ─── Warp Lane Line (faint radial from r=4 to r=130) ───
function WarpLaneLine({ lane }) {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    const innerR = 4
    const outerR = 130
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      lane.dx * innerR, 0.15, lane.dz * innerR,
      lane.dx * outerR, 0.15, lane.dz * outerR,
    ]), 3))
    return g
  }, [lane.dx, lane.dz])

  return (
    <line geometry={geometry}>
      <lineBasicMaterial color="#06b6d4" transparent opacity={0.06} depthWrite={false} />
    </line>
  )
}

// ─── Strategic vantage node (icon-based) ────────────────
function VantageNode({ node, gridOpacity, onSelect }) {
  const [hovered, setHovered] = useState(false)
  return (
    <group
      position={[node.position[0], 0.3, node.position[2]]}
      onPointerOver={(e) => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer' }}
      onPointerOut={() => { setHovered(false); document.body.style.cursor = 'default' }}
      onClick={(e) => { e.stopPropagation(); onSelect?.(node.position) }}
    >
      <Billboard>
        <Text
          fontSize={hovered ? 0.55 : 0.35}
          color={hovered ? '#88ffcc' : '#33ff66'}
          anchorX="center"
          anchorY="middle"
          fillOpacity={(hovered ? 0.8 : 0.15) * gridOpacity}
          outlineWidth={0.015}
          outlineColor="#000000"
        >
          {node.icon}
        </Text>
        {hovered && (
          <Text
            fontSize={0.28}
            color="#33ff66"
            anchorX="center"
            anchorY="middle"
            position={[0, -0.5, 0]}
            fillOpacity={0.7 * gridOpacity}
            outlineWidth={0.01}
            outlineColor="#000000"
            letterSpacing={0.06}
          >
            {node.label}
          </Text>
        )}
      </Billboard>
    </group>
  )
}

// ─── Component ──────────────────────────────────────────

export default function RadarCompass({ gridOpacity = 1.0, onZoneSelect, showJumpNodes = true }) {
  const matRef = useRef()

  const uniforms = useMemo(() => ({
    uTime: { value: 0 },
    uOpacity: { value: 1.0 },
  }), [])

  useFrame((_, delta) => {
    try {
      if (matRef.current) {
        matRef.current.uniforms.uTime.value += delta
        matRef.current.uniforms.uOpacity.value = gridOpacity
      }
    } catch { /* ref not ready */ }
  })

  const planeSize = (OUTER_RADIUS + 10) * 2

  return (
    <group>
      {/* Single shader disc — all rings, radials, sweep, ticks (hidden when grid off) */}
      {gridOpacity > 0 && <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <planeGeometry args={[planeSize, planeSize, 1, 1]} />
        <shaderMaterial
          ref={matRef}
          vertexShader={vertexShader}
          fragmentShader={fragmentShader}
          uniforms={uniforms}
          transparent
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>}

      {/* Zone labels — only when grid visible */}
      {gridOpacity > 0 && <>
      {/* Zone labels — clickable, fly camera to zone on click */}
      {ZONE_RINGS.map((zone) => (
        <ZoneLabel key={zone.label} zone={zone} gridOpacity={gridOpacity} onSelect={onZoneSelect} />
      ))}
      </>}

      {/* Warp lanes — 6 radial lines with stops at zone boundaries */}
      {showJumpNodes && WARP_LANES.map((lane, li) => (
        <group key={`lane-${li}`}>
          <WarpLaneLine lane={lane} />
          {lane.stops.map((stop) => (
            <WarpStop key={`${li}-${stop.label}`} stop={stop} gridOpacity={1} onSelect={onZoneSelect} />
          ))}
        </group>
      ))}

      {/* Strategic vantage nodes — also part of jump layer */}
      {showJumpNodes && VANTAGE_NODES.map((node) => (
        <VantageNode key={node.label} node={node} gridOpacity={1} onSelect={onZoneSelect} />
      ))}

      {/* Cardinal markers — N/S/E/W */}
      {CARDINAL_MARKERS.map((m) => (
        <Billboard key={m.label} position={m.position}>
          <Text
            fontSize={0.5}
            color="#33ff66"
            anchorX="center"
            anchorY="middle"
            fillOpacity={0.4 * gridOpacity}
            outlineWidth={0.015}
            outlineColor="#000000"
            letterSpacing={0.1}
          >
            {m.label}
          </Text>
        </Billboard>
      ))}
    </group>
  )
}
