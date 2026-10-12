/**
 * TeamLabels — Subtle Billboard text labels above agent team clusters.
 *
 * Visual team grouping without restructuring the agent mesh layout.
 * Labels positioned approximately where each team's agents cluster.
 * Extremely subtle — opacity 0.2, small font.
 */
import { Billboard, Text } from '@react-three/drei'

// Team definitions with approximate centroid positions
// Based on AgentMesh layout: managers at r=11, specialists at r=15
const TEAMS = [
  {
    name: 'Security',
    color: '#3090ff',
    // WARDEN (manager, r=11) + CIPHER (manager, r=11) — adjacent in manager ring
    position: [9, 4, -6],
  },
  {
    name: 'DevOps',
    color: '#30ff90',
    // DAEDALUS (manager, r=11) + VULCAN (specialist, r=15) + TESTER (specialist, r=15)
    position: [-6, 4, 10],
  },
  {
    name: 'Infrastructure',
    color: '#ff8c00',
    // HYPERION + METRICS + VIGIL + INSIGHT (specialists, r=15, clustered)
    position: [13, 4, 8],
  },
  {
    name: 'Research',
    color: '#20b2aa',
    // SCHOLAR + PERPLEXITY + NANOBANANA (specialists, r=15)
    position: [-12, 4, -10],
  },
  {
    name: 'Core',
    color: '#06b6d4',
    // QUOX (orchestrator, r=0) + PRISM (analyst, r=11) + COREY + KEEPER (specialists, r=15)
    position: [0, 6, 0],
  },
]

export default function TeamLabels() {
  return (
    <group>
      {TEAMS.map((team) => (
        <Billboard key={team.name} position={team.position}>
          <Text
            fontSize={0.25}
            color={team.color}
            anchorX="center"
            anchorY="middle"
            fillOpacity={0.2}
            outlineWidth={0.01}
            outlineColor="#000000"
            font={undefined}
          >
            {team.name.toUpperCase()}
          </Text>
        </Billboard>
      ))}
    </group>
  )
}
