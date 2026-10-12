/**
 * DataHighways — Particle streams between zones.
 *
 * Fibonacci layout positions. Particles ONLY flow when active=true
 * (real objectives running or real agent activity detected).
 * Zero particles when idle — no fake animation.
 *
 * Routes:
 *  1. Health Pulse:     Nucleus → Implants (r=7)     (Violet)
 *  2. Capability Feed:  Implants → Agents (r=25)     (Indigo)
 *  3. Task Stream:      Agents → Execution (r=80)    (Emerald)
 *  4. Knowledge Flow:   Execution → Memory (r=105)   (Rose)
 *  5. Team Dispatch:    Agents → Teams (r=38)        (Cyan)
 */
import DataHighway from './DataHighway'

const HIGHWAYS = [
  {
    id: 'health-pulse',
    from: [0, 0, 0],        // Nucleus
    to: [0, 0, 7],          // Implants r=7
    color: '#8b5cf6',
    midYOffset: 2,
    particleCountActive: 25,
    speed: 0.4,
  },
  {
    id: 'capability-feed',
    from: [0, 0, 7],        // Implants r=7
    to: [0, 0, 25],         // Agents r=25
    color: '#6366f1',
    midYOffset: 0,
    particleCountActive: 30,
    speed: 0.5,
  },
  {
    id: 'task-stream',
    from: [0, 0, 25],       // Agents r=25
    to: [80, 0, 0],         // Obj Execution r=80
    color: '#22c55e',
    midYOffset: -4,
    particleCountActive: 35,
    speed: 0.6,
  },
  {
    id: 'knowledge-flow',
    from: [80, 0, 0],       // Execution r=80
    to: [0, 0, 105],        // Memory r=105
    color: '#ec4899',
    midYOffset: 6,
    particleCountActive: 30,
    speed: 0.45,
  },
  {
    id: 'team-dispatch',
    from: [0, 0, 25],       // Agents r=25
    to: [-38, 0, 0],        // Teams r=38
    color: '#06b6d4',
    midYOffset: 2,
    particleCountActive: 20,
    speed: 0.5,
  },
]

export default function DataHighways({ active = false }) {
  return (
    <group>
      {HIGHWAYS.map((hw) => (
        <DataHighway
          key={hw.id}
          from={hw.from}
          to={hw.to}
          color={hw.color}
          particleCount={active ? hw.particleCountActive : 0}
          speed={hw.speed}
          active={active}
          midYOffset={hw.midYOffset}
        />
      ))}
    </group>
  )
}
