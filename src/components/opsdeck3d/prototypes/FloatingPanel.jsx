/**
 * FloatingPanel — 3D glass panels floating in space, angled for perspective.
 *
 * Not flat HUD overlays — actual 3D objects in the scene that you can
 * orbit around. Like holographic monitors in a sci-fi command centre.
 *
 * Uses drei Html with 3D positioning + CSS perspective transforms.
 * Multiple panel variants: info card, metrics display, event feed, agent status.
 */
import { useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html, Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'
import { PALETTE } from '../lib/design-system'

const FONT = "'JetBrains Mono', 'Fira Code', monospace"

// ─── Panel Styles ────────────────────────────────────────

const panelBase = {
  background: 'rgba(5, 5, 16, 0.85)',
  backdropFilter: 'blur(20px)',
  border: '1px solid rgba(255, 255, 255, 0.08)',
  borderRadius: 8,
  fontFamily: FONT,
  color: 'rgba(255, 255, 255, 0.85)',
  fontSize: 10,
  boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5), 0 0 20px rgba(99, 102, 241, 0.05)',
  overflow: 'hidden',
}

// ─── Agent Status Panel ──────────────────────────────────

function AgentStatusPanel() {
  const agents = [
    { name: 'WARDEN', state: 'executing', color: PALETTE.executing, task: 'Port scan docker03' },
    { name: 'CIPHER', state: 'thinking', color: PALETTE.thinking, task: 'Analyzing DNS records' },
    { name: 'DAEDALUS', state: 'executing', color: PALETTE.executing, task: 'Building containers' },
    { name: 'HYPERION', state: 'idle', color: PALETTE.idle, task: null },
    { name: 'METRICS', state: 'reading', color: PALETTE.reading, task: 'Querying Prometheus' },
    { name: 'VIGIL', state: 'idle', color: PALETTE.idle, task: null },
  ]

  return (
    <div style={{ ...panelBase, width: 220, padding: '10px 14px' }}>
      <div style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: 6, marginBottom: 8 }}>
        <div style={{ fontSize: 8, textTransform: 'uppercase', letterSpacing: '0.1em', color: PALETTE.indigo, fontWeight: 700 }}>Agent Status</div>
      </div>
      {agents.map((a, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%', background: a.color, flexShrink: 0,
            boxShadow: a.state !== 'idle' ? `0 0 6px ${a.color}` : 'none',
          }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 9, fontWeight: 600, color: a.state === 'idle' ? 'rgba(255,255,255,0.4)' : '#fff' }}>{a.name}</div>
            {a.task && <div style={{ fontSize: 8, color: 'rgba(255,255,255,0.35)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.task}</div>}
          </div>
          <span style={{ fontSize: 7, color: a.color, fontWeight: 600, flexShrink: 0 }}>{a.state}</span>
        </div>
      ))}
    </div>
  )
}

// ─── Metrics Panel ───────────────────────────────────────

function MetricsPanel() {
  const metrics = [
    { label: 'Agents Active', value: '6/16', color: PALETTE.indigo, pct: 37.5 },
    { label: 'Tasks Running', value: '8', color: PALETTE.executing, pct: 67 },
    { label: 'Memory Items', value: '8,247', color: '#ec4899', pct: 82 },
    { label: 'Token Budget', value: '4.2K / 10K', color: PALETTE.waiting, pct: 42 },
    { label: 'System Health', value: '91%', color: PALETTE.executing, pct: 91 },
  ]

  return (
    <div style={{ ...panelBase, width: 200, padding: '10px 14px' }}>
      <div style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: 6, marginBottom: 8 }}>
        <div style={{ fontSize: 8, textTransform: 'uppercase', letterSpacing: '0.1em', color: PALETTE.violet, fontWeight: 700 }}>System Metrics</div>
      </div>
      {metrics.map((m, i) => (
        <div key={i} style={{ marginBottom: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
            <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.5)' }}>{m.label}</span>
            <span style={{ fontSize: 9, fontWeight: 700, color: m.color }}>{m.value}</span>
          </div>
          <div style={{ height: 3, borderRadius: 1.5, background: 'rgba(255,255,255,0.04)' }}>
            <div style={{ width: `${m.pct}%`, height: '100%', borderRadius: 1.5, background: m.color, opacity: 0.7 }} />
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Event Feed Panel ────────────────────────────────────

function EventFeedPanel() {
  const events = [
    { ts: '14:32:45', msg: 'WARDEN completed port scan', color: PALETTE.executing },
    { ts: '14:32:38', msg: 'QUOX delegated auth audit → CIPHER', color: PALETTE.delegation },
    { ts: '14:32:30', msg: 'Task "DNS check" failed (timeout)', color: PALETTE.blocked },
    { ts: '14:32:22', msg: 'Objective "Deploy v2.4" started', color: PALETTE.indigo },
    { ts: '14:32:15', msg: 'Memory: entity docker03 updated', color: '#ec4899' },
    { ts: '14:32:08', msg: 'HYPERION health check passed', color: PALETTE.executing },
    { ts: '14:32:01', msg: 'Integration-spine degraded (45%)', color: PALETTE.waiting },
  ]

  return (
    <div style={{ ...panelBase, width: 260, padding: '10px 14px' }}>
      <div style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: 6, marginBottom: 8 }}>
        <div style={{ fontSize: 8, textTransform: 'uppercase', letterSpacing: '0.1em', color: PALETTE.cyan, fontWeight: 700 }}>Event Stream</div>
      </div>
      {events.map((e, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, paddingBottom: 5, marginBottom: 5, borderBottom: i < events.length - 1 ? '1px solid rgba(255,255,255,0.03)' : 'none' }}>
          <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.3)', minWidth: 42, flexShrink: 0 }}>{e.ts}</span>
          <span style={{ fontSize: 8, color: e.color }}>{e.msg}</span>
        </div>
      ))}
    </div>
  )
}

// ─── Objective Detail Panel ──────────────────────────────

function ObjectiveDetailPanel() {
  const tasks = [
    { name: 'Pull images', status: 'done', agent: 'VULCAN', dur: '14s' },
    { name: 'Run migrations', status: 'done', agent: 'DAEDALUS', dur: '23s' },
    { name: 'Health check', status: 'running', agent: 'WARDEN', dur: '...' },
    { name: 'Update DNS', status: 'pending', agent: 'MESHNET', dur: '--' },
    { name: 'Notify team', status: 'pending', agent: null, dur: '--' },
  ]
  const done = tasks.filter(t => t.status === 'done').length

  return (
    <div style={{ ...panelBase, width: 230, padding: '10px 14px' }}>
      <div style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: 6, marginBottom: 8 }}>
        <div style={{ fontSize: 8, textTransform: 'uppercase', letterSpacing: '0.1em', color: PALETTE.executing, fontWeight: 700 }}>Objective</div>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#fff', marginTop: 3 }}>Deploy v2.4 to Production</div>
      </div>
      {/* Progress bar */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
          <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.4)' }}>Progress</span>
          <span style={{ fontSize: 9, fontWeight: 700, color: PALETTE.executing }}>{done}/{tasks.length}</span>
        </div>
        <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.04)' }}>
          <div style={{ width: `${(done / tasks.length) * 100}%`, height: '100%', borderRadius: 2, background: PALETTE.executing }} />
        </div>
      </div>
      {tasks.map((t, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <span style={{ color: t.status === 'done' ? PALETTE.executing : t.status === 'running' ? PALETTE.thinking : 'rgba(255,255,255,0.25)', fontSize: 10 }}>
            {t.status === 'done' ? '✓' : t.status === 'running' ? '▸' : '○'}
          </span>
          <span style={{ fontSize: 9, color: t.status === 'pending' ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.7)', flex: 1 }}>{t.name}</span>
          {t.agent && <span style={{ fontSize: 7, color: 'rgba(255,255,255,0.3)' }}>{t.agent}</span>}
          <span style={{ fontSize: 7, color: 'rgba(255,255,255,0.25)' }}>{t.dur}</span>
        </div>
      ))}
    </div>
  )
}

// ─── Main: Panels floating in 3D space ───────────────────

export default function FloatingPanel() {
  const groupRef = useRef()
  const timeRef = useRef(0)

  useFrame((_, delta) => {
    timeRef.current += delta
    if (groupRef.current) {
      // Gentle group sway
      groupRef.current.rotation.y = Math.sin(timeRef.current * 0.1) * 0.05
    }
  })

  const panels = [
    { component: <AgentStatusPanel />, pos: [-6, 2, 0], rot: [0, 0.3, 0], label: 'Agents' },
    { component: <MetricsPanel />, pos: [-2, 3, -3], rot: [0, 0.15, 0], label: 'Metrics' },
    { component: <EventFeedPanel />, pos: [3, 2, -2], rot: [0, -0.2, 0], label: 'Events' },
    { component: <ObjectiveDetailPanel />, pos: [7, 3, 1], rot: [0, -0.35, 0], label: 'Objective' },
  ]

  return (
    <group ref={groupRef}>
      {panels.map((panel, i) => (
        <group key={i} position={panel.pos} rotation={panel.rot}>
          {/* Panel anchor point indicator */}
          <mesh scale={0.08}>
            <octahedronGeometry args={[1, 0]} />
            <meshBasicMaterial color={PALETTE.violet} transparent opacity={0.3} />
          </mesh>

          {/* Connecting line from anchor to panel */}
          <line geometry={new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(0, 0.5, 0),
          ])}>
            <lineBasicMaterial color={PALETTE.violet} transparent opacity={0.1} />
          </line>

          {/* The actual HTML panel — positioned in 3D space */}
          <Html
            position={[0, 0.6, 0]}
            transform
            occlude={false}
            style={{ pointerEvents: 'none' }}
            distanceFactor={8}
          >
            {panel.component}
          </Html>
        </group>
      ))}
    </group>
  )
}
