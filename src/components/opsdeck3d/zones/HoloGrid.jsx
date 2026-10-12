/**
 * HoloGrid — Infinite grid floor with radial fade and sonar pulse.
 * Sits at y=0 (equatorial plane). Indigo lines fading to void at edges.
 */
import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

const vertexShader = `
varying vec2 vWorldPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`

const fragmentShader = `
uniform float uTime;
uniform float uSonarInterval;
varying vec2 vWorldPos;

void main() {
  float dist = length(vWorldPos);
  float fade = 1.0 - smoothstep(0.0, 100.0, dist);

  // Grid lines
  vec2 grid = abs(fract(vWorldPos / 5.0 - 0.5) - 0.5) / fwidth(vWorldPos / 5.0);
  float line = min(grid.x, grid.y);
  float gridAlpha = 1.0 - min(line, 1.0);

  // Radar sweep — a rotating line from centre, like a probe scanner
  float angle = atan(vWorldPos.y, vWorldPos.x);
  float sweepAngle = mod(uTime * 0.4, 6.28318); // slow rotation ~16s per revolution
  float angleDiff = mod(angle - sweepAngle + 6.28318, 6.28318);
  // Fade trail behind the sweep line (wider = softer trail)
  float sweep = smoothstep(0.8, 0.0, angleDiff) * 0.08 * fade;
  // Bright leading edge
  float edge = smoothstep(0.06, 0.0, angleDiff) * 0.12 * fade;
  float radar = (sweep + edge) * smoothstep(5.0, 15.0, dist); // no radar near centre

  vec3 baseColor = vec3(0.388, 0.4, 0.945);
  float alpha = (gridAlpha * fade * 0.15) + radar;

  if (alpha < 0.003) discard;
  gl_FragColor = vec4(baseColor, alpha);
}
`

export default function HoloGrid({ sonarInterval = 10.0 }) {
  const matRef = useRef()

  const uniforms = useMemo(() => ({
    uTime: { value: 0 },
    uSonarInterval: { value: sonarInterval },
  }), [sonarInterval])

  useFrame((_, delta) => {
    try {
      if (matRef.current) {
        matRef.current.uniforms.uTime.value += delta
      }
    } catch { /* ref not ready */ }
  })

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
      <planeGeometry args={[200, 200, 1, 1]} />
      <shaderMaterial
        ref={matRef}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        uniforms={uniforms}
        transparent
        side={THREE.DoubleSide}
        depthWrite={false}
      />
    </mesh>
  )
}
