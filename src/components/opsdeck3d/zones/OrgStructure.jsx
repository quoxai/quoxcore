/**
 * OrgStructure — Organization / Division / Department arc sectors at r=30.
 *
 * Fibonacci layout: sits between Agents (r=25) and Teams (r=38).
 * Org sectors wrap the inner agent zones. Divisions subdivide. Departments sit inside.
 *
 * Each level is a thin arc segment at y=0 with a billboard label.
 * Think: concentric donut slices, colour-coded by org → div → dept.
 */
import { useRef, useMemo, useState, useEffect } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'

// Radii for the three levels
const R_ORG = 32        // outermost arc
const R_DIV = 30.5      // middle arc
const R_DEPT = 29       // innermost arc
const ARC_WIDTH = 0.08  // thickness of arc line
const ARC_Y = 0.15      // slight elevation

// ─── Arc segment (thin curved line) ─────────────────────
function ArcSegment({ radius, startAngle, endAngle, color, opacity = 0.15 }) {
  const points = useMemo(() => {
    const pts = []
    const segments = 32
    for (let i = 0; i <= segments; i++) {
      const a = startAngle + (endAngle - startAngle) * (i / segments)
      pts.push(new THREE.Vector3(Math.cos(a) * radius, ARC_Y, Math.sin(a) * radius))
    }
    return pts
  }, [radius, startAngle, endAngle])

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry()
    const verts = new Float32Array(points.length * 3)
    points.forEach((p, i) => {
      verts[i * 3] = p.x
      verts[i * 3 + 1] = p.y
      verts[i * 3 + 2] = p.z
    })
    g.setAttribute('position', new THREE.BufferAttribute(verts, 3))
    return g
  }, [points])

  return (
    <line geometry={geometry}>
      <lineBasicMaterial color={color} transparent opacity={opacity} depthWrite={false} />
    </line>
  )
}

// ─── Clickable arc label ────────────────────────────────
function ArcLabel({ position, text, color, fontSize = 0.3, opacity = 0.4, onSelect }) {
  const [hovered, setHovered] = useState(false)

  return (
    <group
      position={position}
      onPointerOver={(e) => { e.stopPropagation(); setHovered(true); document.body.style.cursor = 'pointer' }}
      onPointerOut={() => { setHovered(false); document.body.style.cursor = 'default' }}
      onClick={(e) => { e.stopPropagation(); onSelect?.({ type: 'org', name: text, color, position }) }}
    >
      <Billboard>
        <Text
          fontSize={hovered ? fontSize * 1.2 : fontSize}
          color={hovered ? '#ffffff' : color}
          anchorX="center"
          anchorY="middle"
          fillOpacity={hovered ? 0.8 : opacity}
          outlineWidth={0.01}
          outlineColor="#000000"
          letterSpacing={0.06}
        >
          {text}
        </Text>
      </Billboard>
    </group>
  )
}

// ─── Main Component ─────────────────────────────────────
export default function OrgStructure({ onSelect }) {
  const groupRef = useRef()
  const [orgData, setOrgData] = useState(null)

  // Poll real org hierarchy from auth service
  useEffect(() => {
    let mounted = true
    const poll = async () => {
      try {
        const res = await fetch('/api/orgs', { credentials: 'include', signal: AbortSignal.timeout(5000) })
        if (res.ok) {
          const data = await res.json()
          if (mounted && Array.isArray(data) && data.length > 0) {
            // Map auth service org format to our display format
            setOrgData(data.map(org => ({
              id: org.id || org.slug,
              name: org.name || org.slug,
              color: org.color || '#8b5cf6',
              divisions: (org.divisions || []).map(div => ({
                id: div.id || div.slug,
                name: div.name || div.slug,
                color: div.color || '#6366f1',
                departments: (div.departments || []).map(dept => ({
                  id: dept.id || dept.slug,
                  name: dept.name || dept.slug,
                  color: dept.color || '#818cf8',
                  teams: dept.teams || [],
                })),
              })),
            })))
          }
        }
      } catch {
        // Auth service not reachable — leave orgData empty (honest state, no mock substitution)
      }
    }
    poll()
    const interval = setInterval(poll, 60000) // Orgs change slowly
    return () => { mounted = false; clearInterval(interval) }
  }, [])

  const displayOrgs = orgData || []

  useFrame((_, delta) => {
    try {
      // Very slow rotation for ambient motion
      if (groupRef.current) groupRef.current.rotation.y += delta * 0.002
    } catch { /* ref not ready */ }
  })

  // Compute arc layout from org data
  const layout = useMemo(() => {
    const arcs = []
    const labels = []
    const TWO_PI = Math.PI * 2

    displayOrgs.forEach((org, oi) => {
      const orgStart = (oi / displayOrgs.length) * TWO_PI
      const orgEnd = ((oi + 1) / displayOrgs.length) * TWO_PI

      // Org arc (outermost)
      arcs.push({ key: `org-${org.id}`, radius: R_ORG, start: orgStart, end: orgEnd, color: org.color, opacity: 0.2 })
      const orgMid = (orgStart + orgEnd) / 2
      labels.push({
        key: `org-lbl-${org.id}`,
        position: [Math.cos(orgMid) * (R_ORG + 1), 0.8, Math.sin(orgMid) * (R_ORG + 1)],
        text: org.name.toUpperCase(), color: org.color, fontSize: 0.35, opacity: 0.5,
      })

      // Divisions
      const divCount = org.divisions.length
      org.divisions.forEach((div, di) => {
        const divStart = orgStart + (orgEnd - orgStart) * (di / divCount)
        const divEnd = orgStart + (orgEnd - orgStart) * ((di + 1) / divCount)

        arcs.push({ key: `div-${div.id}`, radius: R_DIV, start: divStart + 0.02, end: divEnd - 0.02, color: div.color, opacity: 0.15 })
        const divMid = (divStart + divEnd) / 2
        labels.push({
          key: `div-lbl-${div.id}`,
          position: [Math.cos(divMid) * R_DIV, 0.6, Math.sin(divMid) * R_DIV],
          text: div.name, color: div.color, fontSize: 0.25, opacity: 0.35,
        })

        // Departments
        const deptCount = div.departments.length
        div.departments.forEach((dept, deptI) => {
          const deptStart = divStart + (divEnd - divStart) * (deptI / deptCount)
          const deptEnd = divStart + (divEnd - divStart) * ((deptI + 1) / deptCount)

          arcs.push({ key: `dept-${dept.id}`, radius: R_DEPT, start: deptStart + 0.03, end: deptEnd - 0.03, color: dept.color, opacity: 0.1 })
          const deptMid = (deptStart + deptEnd) / 2
          labels.push({
            key: `dept-lbl-${dept.id}`,
            position: [Math.cos(deptMid) * (R_DEPT - 0.8), 0.4, Math.sin(deptMid) * (R_DEPT - 0.8)],
            text: dept.name, color: dept.color, fontSize: 0.2, opacity: 0.3,
          })
        })
      })
    })

    return { arcs, labels }
  }, [displayOrgs])

  return (
    <group ref={groupRef}>
      {/* Faint guide rings */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, ARC_Y, 0]}>
        <torusGeometry args={[R_ORG, 0.01, 8, 64]} />
        <meshBasicMaterial color="#8b5cf6" transparent opacity={0.04} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, ARC_Y, 0]}>
        <torusGeometry args={[R_DEPT, 0.01, 8, 64]} />
        <meshBasicMaterial color="#8b5cf6" transparent opacity={0.03} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>

      {/* Arc segments */}
      {layout.arcs.map(arc => (
        <ArcSegment key={arc.key} radius={arc.radius} startAngle={arc.start} endAngle={arc.end} color={arc.color} opacity={arc.opacity} />
      ))}

      {/* Labels */}
      {layout.labels.map(lbl => (
        <ArcLabel key={lbl.key} position={lbl.position} text={lbl.text} color={lbl.color} fontSize={lbl.fontSize} opacity={lbl.opacity} onSelect={onSelect} />
      ))}
    </group>
  )
}
