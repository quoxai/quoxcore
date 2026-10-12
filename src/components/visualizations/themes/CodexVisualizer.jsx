/**
 * CodexVisualizer - ARCHIVIST-specific visualization
 *
 * A scrolling manuscript/document visualization that represents
 * the flow of knowledge and text analysis. Features:
 * - Cascading text columns like ancient scrolls
 * - Glowing highlight effects for "found" patterns
 * - Connection lines between related text fragments
 * - Archive/library aesthetic with purple/gold accents
 *
 * Available when both 'visualizations' AND 'files' (or 'advanced-memory') plugins are enabled.
 */

import { useRef, useMemo, useCallback, useEffect } from 'react'
import {
  BaseVisualizerClass as BaseVisualizer,
  getStateConfig as getStateConfigUtil,
  calculateIntensity as calculateIntensityUtil
} from '../core/BaseVisualizer'

// Sample text fragments that scroll (represents document analysis)
const TEXT_FRAGMENTS = [
  'analyzing...', 'pattern found', 'cross-reference', 'extracting data',
  'comparing docs', 'summarizing...', 'citation [1]', 'key insight',
  'contradiction', 'semantic match', 'topic cluster', 'entity found',
  '▓▓▒▒░░', '█▓▒░', '░▒▓█', 'processing...',
  '< document >', '{ data }', '[ array ]', '( result )',
  'knowledge', 'memory', 'archive', 'index'
]

// Unicode symbols for decoration
const SYMBOLS = ['◆', '◇', '○', '●', '□', '■', '△', '▽', '☰', '⚡', '✧', '❖']

class CodexVisualizerCore extends BaseVisualizer {
  constructor(canvas) {
    super(canvas)
    this.columns = []
    this.particles = []
    this.connections = []
    this.highlights = []
    this.lastHighlightTime = 0
    this.glyphFont = '12px "JetBrains Mono", "Fira Code", monospace'
    this.symbolFont = '14px serif'
    this.config = {}
    this.scale = 1
  }

  setConfig(config) {
    this.config = config || {}
  }

  getStateConfig(state) {
    return getStateConfigUtil(this.config, state)
  }

  calculateIntensity(audioData, config) {
    if (audioData && audioData.length > 0) {
      let sum = 0
      for (let i = 0; i < audioData.length; i++) {
        sum += audioData[i]
      }
      const avg = sum / audioData.length
      return Math.min(1, avg / 128) * (config?.sensitivity || 0.5)
    }
    return 0.3 // Default idle intensity
  }

  init() {
    // Set canvas dimensions from container
    if (this.canvas) {
      const rect = this.canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      this.canvas.width = rect.width * dpr
      this.canvas.height = rect.height * dpr
      this.width = this.canvas.width
      this.height = this.canvas.height
      this.ctx = this.canvas.getContext('2d')
      if (this.ctx) {
        this.ctx.scale(dpr, dpr)
      }
      this.scale = Math.min(rect.width, rect.height) / 300
    }
    this.initColumns()
    this.initParticles()
  }

  initColumns() {
    const columnCount = Math.floor(this.canvas.width / 80) // ~80px per column
    this.columns = []

    for (let i = 0; i < columnCount; i++) {
      this.columns.push({
        x: 40 + i * 80,
        chars: [],
        speed: 0.3 + Math.random() * 0.4,
        opacity: 0.3 + Math.random() * 0.4,
        highlighted: false,
        highlightIntensity: 0
      })

      // Initialize characters in each column
      const charCount = Math.floor(this.canvas.height / 20)
      for (let j = 0; j < charCount; j++) {
        this.columns[i].chars.push({
          y: j * 20,
          text: this.getRandomText(),
          brightness: Math.random(),
          isSymbol: Math.random() < 0.15
        })
      }
    }
  }

  initParticles() {
    this.particles = []
    const particleCount = 30

    for (let i = 0; i < particleCount; i++) {
      this.particles.push({
        x: Math.random() * this.canvas.width,
        y: Math.random() * this.canvas.height,
        vx: (Math.random() - 0.5) * 0.5,
        vy: (Math.random() - 0.5) * 0.5,
        size: 2 + Math.random() * 3,
        symbol: SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)],
        pulse: Math.random() * Math.PI * 2
      })
    }
  }

  getRandomText() {
    return TEXT_FRAGMENTS[Math.floor(Math.random() * TEXT_FRAGMENTS.length)]
  }

  resize() {
    if (this.canvas) {
      // Get container dimensions
      const rect = this.canvas.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      this.canvas.width = rect.width * dpr
      this.canvas.height = rect.height * dpr
      this.width = this.canvas.width
      this.height = this.canvas.height
      if (this.ctx) {
        this.ctx.scale(dpr, dpr)
      }
    }
    this.initColumns()
  }

  updateHighlights(intensity) {
    const now = Date.now()

    // Randomly highlight columns based on audio intensity
    if (intensity > 0.5 && now - this.lastHighlightTime > 200) {
      const randomCol = Math.floor(Math.random() * this.columns.length)
      this.columns[randomCol].highlighted = true
      this.columns[randomCol].highlightIntensity = intensity
      this.lastHighlightTime = now

      // Add a highlight burst
      this.highlights.push({
        x: this.columns[randomCol].x,
        y: this.canvas.height / 2,
        radius: 10,
        maxRadius: 100 + intensity * 100,
        opacity: 0.8
      })
    }

    // Fade highlights
    this.columns.forEach(col => {
      if (col.highlighted) {
        col.highlightIntensity *= 0.95
        if (col.highlightIntensity < 0.1) {
          col.highlighted = false
        }
      }
    })

    // Update highlight bursts
    this.highlights = this.highlights.filter(h => {
      h.radius += 3
      h.opacity -= 0.02
      return h.opacity > 0
    })
  }

  updateConnections() {
    // Create connections between highlighted columns
    this.connections = []
    const highlightedCols = this.columns.filter(c => c.highlighted)

    for (let i = 0; i < highlightedCols.length - 1; i++) {
      this.connections.push({
        from: { x: highlightedCols[i].x, y: this.canvas.height / 2 },
        to: { x: highlightedCols[i + 1].x, y: this.canvas.height / 2 },
        opacity: Math.min(highlightedCols[i].highlightIntensity, highlightedCols[i + 1].highlightIntensity)
      })
    }
  }

  update(audioData, state = 'idle') {
    const config = this.getStateConfig(state)
    const intensity = this.calculateIntensity(audioData, config)

    // Update columns
    this.columns.forEach(col => {
      col.chars.forEach(char => {
        char.y += col.speed * (1 + intensity * 2) * config.speed

        // Reset when off screen
        if (char.y > this.canvas.height + 20) {
          char.y = -20
          char.text = this.getRandomText()
          char.isSymbol = Math.random() < 0.15
        }

        // Pulse brightness
        char.brightness = 0.3 + Math.sin(Date.now() * 0.002 + char.y * 0.01) * 0.2 + intensity * 0.3
      })
    })

    // Update particles
    this.particles.forEach(p => {
      p.x += p.vx * (1 + intensity)
      p.y += p.vy * (1 + intensity)
      p.pulse += 0.05

      // Wrap around
      if (p.x < 0) p.x = this.canvas.width
      if (p.x > this.canvas.width) p.x = 0
      if (p.y < 0) p.y = this.canvas.height
      if (p.y > this.canvas.height) p.y = 0
    })

    this.updateHighlights(intensity)
    this.updateConnections()
  }

  draw(state = 'idle') {
    const ctx = this.ctx
    const config = this.getStateConfig(state)
    const hue = config.hue || 270 // Purple default

    // Clear with dark background
    ctx.fillStyle = 'rgba(10, 10, 20, 0.15)'
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)

    // Draw connections
    this.connections.forEach(conn => {
      ctx.beginPath()
      ctx.moveTo(conn.from.x, conn.from.y)
      ctx.lineTo(conn.to.x, conn.to.y)
      ctx.strokeStyle = `hsla(${hue}, 80%, 60%, ${conn.opacity * 0.5})`
      ctx.lineWidth = 2
      ctx.stroke()
    })

    // Draw highlight bursts
    this.highlights.forEach(h => {
      ctx.beginPath()
      ctx.arc(h.x, h.y, Math.max(0, h.radius), 0, Math.PI * 2)
      ctx.strokeStyle = `hsla(${hue + 30}, 70%, 70%, ${h.opacity})`
      ctx.lineWidth = 2
      ctx.stroke()
    })

    // Draw text columns
    this.columns.forEach((col, colIndex) => {
      const colHue = col.highlighted ? hue + 30 : hue
      const baseOpacity = col.highlighted ? 0.8 + col.highlightIntensity * 0.2 : col.opacity

      col.chars.forEach(char => {
        const brightness = char.brightness * (col.highlighted ? 1.5 : 1)
        const lightness = 40 + brightness * 30

        if (char.isSymbol) {
          ctx.font = this.symbolFont
          ctx.fillStyle = `hsla(${colHue + 40}, 70%, ${lightness + 10}%, ${baseOpacity * brightness})`
        } else {
          ctx.font = this.glyphFont
          ctx.fillStyle = `hsla(${colHue}, 60%, ${lightness}%, ${baseOpacity * brightness})`
        }

        ctx.textAlign = 'center'
        ctx.fillText(char.text, col.x, char.y)

        // Glow effect for highlighted columns
        if (col.highlighted && brightness > 0.5) {
          ctx.shadowColor = `hsla(${colHue}, 80%, 60%, 0.8)`
          ctx.shadowBlur = 10
          ctx.fillText(char.text, col.x, char.y)
          ctx.shadowBlur = 0
        }
      })
    })

    // Draw floating particles
    this.particles.forEach(p => {
      const particleOpacity = 0.3 + Math.sin(p.pulse) * 0.2
      ctx.font = '10px serif'
      ctx.fillStyle = `hsla(${hue + 60}, 60%, 70%, ${particleOpacity})`
      ctx.fillText(p.symbol, p.x, p.y)
    })

    // Draw center emblem (archive symbol)
    this.drawCenterEmblem(ctx, hue, state)
  }

  drawCenterEmblem(ctx, hue, state) {
    const cx = this.canvas.width / 2
    const cy = this.canvas.height / 2
    const size = 60 * this.scale
    const config = this.getStateConfig(state)
    const pulse = Math.sin(Date.now() * 0.002 * config.speed) * 0.1 + 1

    // Outer ring
    ctx.beginPath()
    ctx.arc(cx, cy, Math.max(0, size * pulse), 0, Math.PI * 2)
    ctx.strokeStyle = `hsla(${hue}, 60%, 50%, 0.3)`
    ctx.lineWidth = 2
    ctx.stroke()

    // Inner ring
    ctx.beginPath()
    ctx.arc(cx, cy, Math.max(0, size * 0.7 * pulse), 0, Math.PI * 2)
    ctx.strokeStyle = `hsla(${hue}, 70%, 60%, 0.5)`
    ctx.lineWidth = 1.5
    ctx.stroke()

    // Center symbol (book/scroll icon)
    ctx.font = `${size * 0.6}px serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = `hsla(${hue}, 80%, 70%, 0.8)`
    ctx.fillText('📜', cx, cy)

    // State indicator text
    ctx.font = '10px "JetBrains Mono", monospace'
    ctx.fillStyle = `hsla(${hue}, 60%, 60%, 0.6)`
    ctx.fillText(`[ ${state.toUpperCase()} ]`, cx, cy + size + 20)
  }
}

/**
 * React wrapper for CodexVisualizer
 */
export default function CodexVisualizer({ audioData, state, config }) {
  const canvasRef = useRef(null)
  const visualizerRef = useRef(null)
  const animationRef = useRef(null)

  const mergedConfig = useMemo(() => ({
    ...config,
    stateColors: config?.stateColors || {
      idle: 270,      // Purple
      listening: 250, // Blue-purple
      speaking: 290,  // Magenta
      thinking: 300,  // Pink-purple
      error: 0        // Red
    }
  }), [config])

  const animate = useCallback(() => {
    if (visualizerRef.current) {
      visualizerRef.current.setConfig(mergedConfig)
      visualizerRef.current.update(audioData, state)
      visualizerRef.current.draw(state)
    }
    animationRef.current = requestAnimationFrame(animate)
  }, [audioData, state, mergedConfig])

  // Initialize visualizer
  useEffect(() => {
    if (canvasRef.current && !visualizerRef.current) {
      visualizerRef.current = new CodexVisualizerCore(canvasRef.current)
      visualizerRef.current.init()
      visualizerRef.current.setConfig(mergedConfig)
    }
  }, [mergedConfig])

  // Start animation loop
  useEffect(() => {
    if (visualizerRef.current && !animationRef.current) {
      animate()
    }
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
        animationRef.current = null
      }
    }
  }, [animate])

  // Handle resize
  useEffect(() => {
    const handleResize = () => {
      if (visualizerRef.current) {
        visualizerRef.current.resize()
      }
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="codex-visualizer"
      style={{
        width: '100%',
        height: '100%',
        background: 'linear-gradient(135deg, #0a0a14 0%, #1a1025 50%, #0f0a1a 100%)'
      }}
    />
  )
}

// Export metadata for the visualizer factory
CodexVisualizer.displayName = 'Codex'
CodexVisualizer.description = 'Scrolling manuscript visualization for ARCHIVIST - available with Files + Visualizations plugins'
CodexVisualizer.requiresPlugins = ['visualizations', 'files']
