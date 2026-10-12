/**
 * ProgressRingNode — Octahedron node with a circular progress ring.
 *
 * A custom ShaderMaterial discards fragments beyond the progress angle,
 * creating a filling arc effect. At 100%, the ring flashes green then
 * settles. Includes full node (wireframe + core + ground disc) plus
 * Billboard labels.
 */
import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import * as THREE from 'three'
import { PALETTE, NODE_SCALES } from '../lib/design-system'

const progressRingVertexShader = `
  varying vec2 vUv;
  varying vec3 vPosition;
  void main() {
    vUv = uv;
    vPosition = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const progressRingFragmentShader = `
  uniform float uProgress;
  uniform vec3 uColor;
  uniform vec3 uCompleteColor;
  uniform float uFlash;
  varying vec2 vUv;
  varying vec3 vPosition;

  void main() {
    // Compute angle from the torus local position
    float angle = atan(vPosition.z, vPosition.x);
    // Normalize to 0..1 (atan returns -PI..PI)
    float normalizedAngle = (angle + 3.14159265) / (2.0 * 3.14159265);
    // Discard fragments beyond progress
    if (normalizedAngle > uProgress) discard;

    vec3 col = mix(uColor, uCompleteColor, step(0.999, uProgress));
    col = mix(col, vec3(1.0), uFlash * 0.6);
    float alpha = 0.7 + uFlash * 0.3;
    gl_FragColor = vec4(col, alpha);
  }
`

export default function ProgressRingNode({
  position = [0, 0, 0],
  progress: externalProgress,
  color = PALETTE.indigo,
  size = NODE_SCALES.objective,
  title = 'Deploy v2.4',
  tasksDone = 3,
  tasksTotal = 6,
}) {
  const groupRef = useRef()
  const wireRef = useRef()
  const innerRef = useRef()
  const ringMatRef = useRef()
  const timeRef = useRef(0)
  const autoProgress = useRef(0)
  const flashRef = useRef(0)
  const wasComplete = useRef(false)

  const colorObj = useMemo(() => new THREE.Color(color), [color])
  const greenObj = useMemo(() => new THREE.Color(PALETTE.done), [])

  const ringUniforms = useMemo(() => ({
    uProgress: { value: 0 },
    uColor: { value: colorObj },
    uCompleteColor: { value: greenObj },
    uFlash: { value: 0 },
  }), [colorObj, greenObj])

  useFrame((_, delta) => {
    timeRef.current += delta

    // Auto-demo: 10s cycle
    if (externalProgress === undefined) {
      autoProgress.current += delta / 10
      if (autoProgress.current > 1.3) {
        autoProgress.current = 0
        wasComplete.current = false
      }
    }

    const p = externalProgress !== undefined
      ? externalProgress
      : Math.min(autoProgress.current, 1)

    // Flash on completion
    if (p >= 1 && !wasComplete.current) {
      flashRef.current = 1
      wasComplete.current = true
    }
    flashRef.current = Math.max(0, flashRef.current - delta * 2)

    if (ringMatRef.current) {
      ringMatRef.current.uniforms.uProgress.value = p
      ringMatRef.current.uniforms.uFlash.value = flashRef.current
    }

    if (wireRef.current) {
      wireRef.current.rotation.y += delta * 0.1
      wireRef.current.rotation.x += delta * 0.03
    }
    if (innerRef.current) {
      innerRef.current.rotation.y -= delta * 0.06
      const breathe = 1 + Math.sin(timeRef.current * 1.2) * 0.03
      innerRef.current.scale.setScalar(size * 0.65 * breathe)
    }
    if (groupRef.current) {
      groupRef.current.position.y = position[1] + Math.sin(timeRef.current * 0.5) * 0.08
    }
  })

  const ringRadius = size * 1.6

  return (
    <group ref={groupRef} position={position}>
      {/* Outer wireframe */}
      <mesh ref={wireRef} scale={size}>
        <octahedronGeometry args={[1, 0]} />
        <meshBasicMaterial color={color} wireframe transparent opacity={0.3} />
      </mesh>

      {/* Inner core */}
      <mesh ref={innerRef} scale={size * 0.65}>
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.8}
          transparent
          opacity={0.8}
          roughness={0.2}
          metalness={0.1}
        />
      </mesh>

      {/* Ground glow disc */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -size * 0.8, 0]}>
        <circleGeometry args={[size * 1.2, 24]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.12}
          side={THREE.DoubleSide}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Progress ring */}
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <torusGeometry args={[ringRadius, 0.06, 8, 128]} />
        <shaderMaterial
          ref={ringMatRef}
          vertexShader={progressRingVertexShader}
          fragmentShader={progressRingFragmentShader}
          uniforms={ringUniforms}
          transparent
          side={THREE.DoubleSide}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Background ring track (faint) */}
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <torusGeometry args={[ringRadius, 0.03, 8, 128]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.06}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Billboard label */}
      <Billboard position={[0, size * 1.8, 0]}>
        <Text
          fontSize={0.4}
          color="white"
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.03}
          outlineColor="#000000"
          fillOpacity={0.85}
        >
          {title}
        </Text>
        <Text
          fontSize={0.22}
          color={color}
          anchorX="center"
          anchorY="middle"
          position={[0, -0.35, 0]}
          fillOpacity={0.6}
        >
          {`${tasksDone}/${tasksTotal} tasks`}
        </Text>
      </Billboard>
    </group>
  )
}
