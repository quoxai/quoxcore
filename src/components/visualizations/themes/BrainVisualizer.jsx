import { useRef, useEffect, useCallback, useMemo, useState } from 'react'
import { getStateConfig } from '../core/BaseVisualizer'

/**
 * BrainVisualizer - 3D neural network with firing signals
 * Ported from ai-visualizer/js/visualizers/brain.js
 *
 * Uses per-state config for speed, scale, sensitivity, hue
 * Uses ResizeObserver for responsive sizing
 */
function BrainVisualizer({
  state = 'idle',
  audioData = null,
  config = {}
}) {
  const containerRef = useRef(null)
  const canvasRef = useRef(null)
  const animationRef = useRef(null)
  const neuronsRef = useRef([])
  const synapsesRef = useRef([])
  const signalsRef = useRef([])
  const angleRef = useRef(0)
  const initializedRef = useRef(false)
  const [dimensions, setDimensions] = useState({ width: 500, height: 500 })

  // Get per-state config values
  const stateConfig = useMemo(() => getStateConfig(config, state), [config, state])

  // Static config values that don't change per-state
  const neuronCount = config?.neuronCount ?? 50
  const connectionThreshold = config?.connectionThreshold ?? 150

  // Handle resize
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        if (width > 0 && height > 0) {
          const size = Math.min(width, height)
          setDimensions({ width: size, height: size })
        }
      }
    })

    resizeObserver.observe(container)
    return () => resizeObserver.disconnect()
  }, [])

  // Initialize network on mount
  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true

    const neurons = []
    const synapses = []

    // Create Neurons (Random 3D cloud)
    for (let i = 0; i < neuronCount; i++) {
      neurons.push({
        x: (Math.random() - 0.5) * 500,
        y: (Math.random() - 0.5) * 400,
        z: (Math.random() - 0.5) * 300,
        baseSize: Math.random() * 2 + 2
      })
    }

    // Create Synapses (Connect close neurons)
    neurons.forEach((n1, i) => {
      neurons.forEach((n2, j) => {
        if (i >= j) return // Avoid duplicates
        const dx = n1.x - n2.x
        const dy = n1.y - n2.y
        const dz = n1.z - n2.z
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)

        if (dist < connectionThreshold) {
          synapses.push({
            from: i,
            to: j,
            length: dist
          })
        }
      })
    })

    neuronsRef.current = neurons
    synapsesRef.current = synapses
    signalsRef.current = []
  }, [neuronCount, connectionThreshold])

  // Helper to get current color based on state (uses per-state hue)
  const getPrimaryColor = useCallback((alpha = 1) => {
    const hue = stateConfig.hue
    return `hsla(${hue}, 100%, 50%, ${alpha})`
  }, [stateConfig.hue])

  // Helper to get audio average
  const getAudioAverage = useCallback(() => {
    if (!audioData || !audioData.length) return 0
    let sum = 0
    for (let i = 0; i < audioData.length; i++) {
      sum += audioData[i]
    }
    return sum / audioData.length
  }, [audioData])

  // Update canvas size when dimensions change
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width = dimensions.width
    canvas.height = dimensions.height
  }, [dimensions])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    const { width, height } = dimensions

    const draw = () => {
      // Use per-state config values
      const S = stateConfig.scale
      const cx = width / 2
      const cy = height / 2

      // Update - Rotate camera slightly (per-state speed)
      angleRef.current += (0.002 * (1 + stateConfig.speed))

      const energy = getAudioAverage() / 255
      const normEnergy = energy * stateConfig.sensitivity

      // Spawn signals based on energy
      if (Math.random() < (normEnergy * 0.5) || (state === 'thinking' && Math.random() < 0.1)) {
        if (synapsesRef.current.length > 0) {
          const synapseIdx = Math.floor(Math.random() * synapsesRef.current.length)
          signalsRef.current.push({
            synapseIdx,
            progress: 0,
            speed: 0.05 + (Math.random() * 0.05) + (normEnergy * 0.1)
          })
        }
      }

      // Update signals (per-state speed)
      for (let i = signalsRef.current.length - 1; i >= 0; i--) {
        signalsRef.current[i].progress += signalsRef.current[i].speed * (1 + stateConfig.speed)
        if (signalsRef.current[i].progress >= 1) {
          signalsRef.current.splice(i, 1)
        }
      }

      // Clear canvas
      ctx.clearRect(0, 0, width, height)

      const color = getPrimaryColor(1)
      const faintColor = getPrimaryColor(0.1)

      // Project Neurons
      const projected = neuronsRef.current.map(n => {
        const cos = Math.cos(angleRef.current)
        const sin = Math.sin(angleRef.current)

        let rx = n.x * cos - n.z * sin
        let rz = n.z * cos + n.x * sin

        let scale = (1000 * S) / ((1000 * S) - rz * S)
        let x = cx + rx * scale * S
        let y = cy + n.y * scale * S

        return { x, y, scale, rz }
      })

      ctx.lineWidth = 1 * S

      // Draw Synapses
      synapsesRef.current.forEach((s) => {
        const p1 = projected[s.from]
        const p2 = projected[s.to]

        ctx.strokeStyle = faintColor
        ctx.beginPath()
        ctx.moveTo(p1.x, p1.y)
        ctx.lineTo(p2.x, p2.y)
        ctx.stroke()
      })

      // Draw Signals
      ctx.lineWidth = 3 * S
      signalsRef.current.forEach(sig => {
        const synapse = synapsesRef.current[sig.synapseIdx]
        if (!synapse) return

        const p1 = projected[synapse.from]
        const p2 = projected[synapse.to]

        // Interpolate
        const sx = p1.x + (p2.x - p1.x) * sig.progress
        const sy = p1.y + (p2.y - p1.y) * sig.progress

        ctx.fillStyle = '#ffffff'
        ctx.shadowBlur = 10 * S
        ctx.shadowColor = color

        ctx.beginPath()
        ctx.arc(sx, sy, 3 * S, 0, Math.PI * 2)
        ctx.fill()
        ctx.shadowBlur = 0
      })

      // Draw Neurons
      projected.forEach((p, i) => {
        const n = neuronsRef.current[i]

        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(p.x, p.y, Math.max(0, n.baseSize * p.scale * S), 0, Math.PI * 2)
        ctx.fill()
      })

      animationRef.current = requestAnimationFrame(draw)
    }

    draw()

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [state, audioData, stateConfig, dimensions, getPrimaryColor, getAudioAverage])

  return (
    <div
      ref={containerRef}
      className="brain-visualizer"
      style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <canvas
        ref={canvasRef}
        className="brain-canvas"
        style={{ display: 'block' }}
      />
    </div>
  )
}

export default BrainVisualizer
