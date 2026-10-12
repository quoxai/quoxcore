/**
 * ExecutionLayer — Container managing all objective clusters at r=25-35.
 *
 * Positions objective clusters evenly on a horizontal ring at r=30.
 * Renders zone ring and "EXECUTION" billboard label.
 */
import { useMemo } from 'react'
import { Billboard, Text } from '@react-three/drei'
import { PALETTE } from '../lib/design-system'
import ObjectiveCluster from './ObjectiveCluster'

const LAYER_RADIUS = 80  // Fibonacci layout: execution at r=80

export default function ExecutionLayer({ objectives = [], settings = {}, onSelect }) {
  // Position clusters evenly on horizontal ring at r=30
  const clusterPositions = useMemo(() => {
    const count = objectives.length
    if (count === 0) return []
    if (count === 1) return [[LAYER_RADIUS, 0, 0]]
    if (count === 2) return [
      [LAYER_RADIUS, 0, 0],
      [-LAYER_RADIUS, 0, 0],
    ]
    // 3+: evenly distributed
    return objectives.map((_, i) => {
      const angle = (i / count) * Math.PI * 2
      return [
        Math.cos(angle) * LAYER_RADIUS,
        0,
        Math.sin(angle) * LAYER_RADIUS,
      ]
    })
  }, [objectives.length])

  return (
    <group>
      {/* Objective clusters */}
      {objectives.map((obj, i) => (
        <ObjectiveCluster
          key={obj.id}
          objective={obj}
          position={clusterPositions[i] || [0, 0, 0]}
          settings={settings}
          onSelect={onSelect}
        />
      ))}
    </group>
  )
}
