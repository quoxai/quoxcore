/**
 * QuoxCore - Full-Screen Cognitive Visualizer
 *
 * A stunning display-ready visualization showing every datapoint in the system.
 * Designed to be left running on rack displays for visual appeal.
 *
 * Features:
 * - Central Q core node with pulsing animation
 * - 10 implant category nodes around the core
 * - Individual nodes for every datapoint (files, memories, agents, etc.)
 * - Interactive legend that highlights related nodes on hover
 * - Particle effects and glowing connections
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { getCognitiveData } from '../services/cognitiveDataCache'
import { COGNITIVE_IMPLANTS } from '../config/cognitiveImplants'
import './quox-core.css'

// Implant colors matching the topology page
const IMPLANT_COLORS = {
  'quox-memory': '#a78bfa',         // Purple - CIPHER
  'quox-value': '#38bdf8',          // Blue
  'quox-insight': '#06b6d4',        // Cyan - Info
  'quox-temporal': '#4ade80',       // Green - Success
  'quox-focus': '#f472b6',          // Pink - Accent
  'quox-executive': '#f97316',      // Orange - WARDEN
  'quox-guard': '#fbbf24',          // Yellow - SCHOLAR
  'quox-dream': '#fb7185',          // Coral
  'quox-reflect': '#8b5cf6',        // Violet - VAULT
  'quox-learn': '#60a5fa',          // Light blue
}

// Q Logo SVG path
const Q_LOGO_PATH = `M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10c1.85 0 3.58-.5 5.07-1.37l2.08 2.08 1.41-1.41-2.08-2.08C19.5 17.58 20 15.85 20 14c0-5.52-4.48-10-10-10zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z`

// Generate datapoint nodes from real data
// Every implant gets nodes - minimum 5, scaled by actual data
function generateDatapointNodes(data, implantPositions) {
  const nodes = []
  const MIN_NODES = 5  // Always show at least 5 nodes per implant
  const MAX_NODES = 50 // Cap for performance

  // Generate for all implants, even if no data yet
  Object.keys(IMPLANT_COLORS).forEach((implantId) => {
    const implantData = data[implantId] || {}
    const implantPos = implantPositions[implantId]
    if (!implantPos) return

    const color = IMPLANT_COLORS[implantId] || '#38bdf8'
    let dataCount = 0
    let percentValue = 0

    // Get actual counts and percentages from data
    switch (implantId) {
      case 'quox-memory':
        dataCount = implantData.totalMemories || 0
        percentValue = implantData.healthScore || 0
        break
      case 'quox-value':
        dataCount = (implantData.tools || 0) + (implantData.workflows || 0) + (implantData.assistants || 0)
        percentValue = implantData.totalEntities || 0
        break
      case 'quox-executive':
        dataCount = implantData.totalAgents || 0
        percentValue = implantData.capabilities || 0
        break
      case 'quox-learn':
        dataCount = implantData.totalFiles || 0
        percentValue = implantData.storagePercent || 0
        break
      case 'quox-insight':
        dataCount = implantData.connectedServices || 0
        percentValue = implantData.avgUptime || 0
        break
      case 'quox-temporal':
        dataCount = implantData.totalRuns || 0
        percentValue = implantData.successRate || 0
        break
      case 'quox-reflect':
        dataCount = (implantData.policyCount || 0) + (implantData.agentRoles || 0) + (implantData.memoryDomains || 0)
        break
      case 'quox-focus':
        dataCount = (implantData.openLoops || 0) + (implantData.recentEntities || 0) + (implantData.activeProjects || 0)
        percentValue = implantData.contextUtilization || 0
        break
      case 'quox-guard':
        // Parse "X/Y" format from servicesUp
        const servicesUp = implantData.servicesUp
        if (typeof servicesUp === 'string' && servicesUp.includes('/')) {
          const [up, total] = servicesUp.split('/').map(Number)
          dataCount = up || 0
        }
        percentValue = implantData.uptimePercent || 0
        break
      case 'quox-dream':
        dataCount = implantData.sessionCount || 0
        break
    }

    // Calculate node count: minimum 5, scale up based on data
    // For percentage-based implants, use percentage to scale (0-100 -> 5-30 nodes)
    // For count-based implants, use count directly (capped)
    let count
    if (dataCount > 0) {
      count = Math.min(Math.max(dataCount, MIN_NODES), MAX_NODES)
    } else if (percentValue > 0) {
      // Scale percentage to node count: 100% = 30 nodes, 0% = 5 nodes
      count = Math.floor(MIN_NODES + (percentValue / 100) * 25)
    } else {
      // No data yet - show minimum nodes as "potential"
      count = MIN_NODES
    }

    // Generate nodes in a cloud around the implant
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.3
      const distance = 50 + Math.random() * 90
      const x = implantPos.x + Math.cos(angle) * distance
      const y = implantPos.y + Math.sin(angle) * distance

      // Vary node appearance based on whether we have real data
      const hasRealData = dataCount > 0 || percentValue > 0
      const baseOpacity = hasRealData ? 0.5 : 0.2  // Dimmer if no data

      nodes.push({
        id: `${implantId}-${i}`,
        implantId,
        x,
        y,
        size: hasRealData ? 2 + Math.random() * 4 : 1.5 + Math.random() * 2,
        color,
        opacity: baseOpacity + Math.random() * 0.3,
        pulseOffset: Math.random() * Math.PI * 2,
        orbitSpeed: 0.0003 + Math.random() * 0.0008,
        orbitRadius: distance,
        orbitAngle: angle,
        hasRealData,
        dataCount,
        percentValue,
        nodeIndex: i,
        totalNodes: count,
      })
    }
  })

  return nodes
}

// Calculate implant positions in a circle around center
function calculateImplantPositions(centerX, centerY, radius) {
  const implantIds = Object.keys(IMPLANT_COLORS)
  const positions = {}

  implantIds.forEach((id, index) => {
    const angle = (index / implantIds.length) * Math.PI * 2 - Math.PI / 2
    positions[id] = {
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
      angle,
    }
  })

  return positions
}

export default function QuoxCore() {
  const navigate = useNavigate()
  const canvasRef = useRef(null)
  const animationRef = useRef(null)
  const nodesRef = useRef([])        // datapoint nodes for hit testing
  const implantPosRef = useRef({})   // implant positions for hit testing
  const [data, setData] = useState({})
  const [hoveredImplant, setHoveredImplant] = useState(null)
  const [hoveredNode, setHoveredNode] = useState(null)  // for datapoint tooltip
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 })
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showControls, setShowControls] = useState(true)
  const hideTimeoutRef = useRef(null)

  // Track canvas dimensions
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })

  // Fetch data
  useEffect(() => {
    let cancelled = false

    const fetchData = async () => {
      try {
        const result = await getCognitiveData()
        if (!cancelled && result.data) {
          setData(result.data)
        }
      } catch (err) {
        console.error('Failed to fetch cognitive data:', err)
      }
    }

    fetchData()
    const interval = setInterval(fetchData, 30000)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  // Handle resize
  useEffect(() => {
    const updateDimensions = () => {
      setDimensions({
        width: window.innerWidth,
        height: window.innerHeight,
      })
    }

    updateDimensions()
    window.addEventListener('resize', updateDimensions)
    return () => window.removeEventListener('resize', updateDimensions)
  }, [])

  // Fullscreen handling
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement)
    }

    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  // Auto-hide controls
  const resetHideTimer = useCallback(() => {
    setShowControls(true)
    clearTimeout(hideTimeoutRef.current)
    hideTimeoutRef.current = setTimeout(() => {
      setShowControls(false)
    }, 4000)
  }, [])

  useEffect(() => {
    const handleMouseMove = () => resetHideTimer()
    window.addEventListener('mousemove', handleMouseMove)
    resetHideTimer()
    return () => window.removeEventListener('mousemove', handleMouseMove)
  }, [resetHideTimer])

  // Canvas animation
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || dimensions.width === 0) return

    const ctx = canvas.getContext('2d')
    const dpr = window.devicePixelRatio || 1

    // Set canvas size with DPR
    canvas.width = dimensions.width * dpr
    canvas.height = dimensions.height * dpr
    ctx.scale(dpr, dpr)

    const centerX = dimensions.width / 2
    const centerY = dimensions.height / 2
    const implantRadius = Math.min(dimensions.width, dimensions.height) * 0.28

    const implantPositions = calculateImplantPositions(centerX, centerY, implantRadius)
    const datapointNodes = generateDatapointNodes(data, implantPositions)
    nodesRef.current = datapointNodes
    implantPosRef.current = implantPositions

    let time = 0

    const draw = () => {
      time += 1

      // Clear with fade effect for trails
      ctx.fillStyle = 'rgba(5, 5, 15, 0.15)'
      ctx.fillRect(0, 0, dimensions.width, dimensions.height)

      // Determine if anything is highlighted - if so, dim everything else
      const hasHover = hoveredImplant !== null

      // Draw connections from datapoints to implants
      datapointNodes.forEach(node => {
        const implantPos = implantPositions[node.implantId]
        if (!implantPos) return

        const isHighlighted = hoveredImplant === node.implantId
        const isDimmed = hasHover && !isHighlighted
        const alpha = isHighlighted ? 0.6 : isDimmed ? 0.02 : 0.08

        ctx.beginPath()
        ctx.moveTo(node.x, node.y)
        ctx.lineTo(implantPos.x, implantPos.y)
        ctx.strokeStyle = node.color + Math.floor(alpha * 255).toString(16).padStart(2, '0')
        ctx.lineWidth = isHighlighted ? 1.5 : 0.5
        ctx.stroke()
      })

      // Draw connections from implants to core
      Object.entries(implantPositions).forEach(([id, pos]) => {
        const isHighlighted = hoveredImplant === id
        const isDimmed = hasHover && !isHighlighted
        const color = IMPLANT_COLORS[id] || '#38bdf8'
        const alpha = isHighlighted ? 0.8 : isDimmed ? 0.05 : 0.2

        // Animated pulse along connection
        const pulsePos = (time * 0.02) % 1

        ctx.beginPath()
        ctx.moveTo(pos.x, pos.y)
        ctx.lineTo(centerX, centerY)
        ctx.strokeStyle = color + Math.floor(alpha * 255).toString(16).padStart(2, '0')
        ctx.lineWidth = isHighlighted ? 3 : 1
        ctx.stroke()

        // Pulse dot - only show for highlighted or when nothing hovered
        if (isHighlighted || !hasHover) {
          const px = pos.x + (centerX - pos.x) * pulsePos
          const py = pos.y + (centerY - pos.y) * pulsePos
          ctx.beginPath()
          ctx.arc(px, py, isHighlighted ? 5 : 2, 0, Math.PI * 2)
          ctx.fillStyle = isHighlighted ? color : color + '80'
          ctx.fill()
        }
      })

      // Draw datapoint nodes
      datapointNodes.forEach(node => {
        const isHighlighted = hoveredImplant === node.implantId
        const isDimmed = hasHover && !isHighlighted

        // Orbit animation
        node.orbitAngle += node.orbitSpeed
        const implantPos = implantPositions[node.implantId]
        if (implantPos) {
          node.x = implantPos.x + Math.cos(node.orbitAngle) * node.orbitRadius
          node.y = implantPos.y + Math.sin(node.orbitAngle) * node.orbitRadius
        }

        // Pulse animation
        const pulse = Math.sin(time * 0.05 + node.pulseOffset) * 0.3 + 0.7
        const size = node.size * (isHighlighted ? 2 : isDimmed ? 0.6 : 1) * pulse
        const opacity = isHighlighted ? 1 : isDimmed ? node.opacity * 0.15 : node.opacity * pulse

        ctx.beginPath()
        ctx.arc(node.x, node.y, size, 0, Math.PI * 2)
        ctx.fillStyle = node.color + Math.floor(opacity * 255).toString(16).padStart(2, '0')
        ctx.fill()

        // Large glow for highlighted nodes
        if (isHighlighted) {
          ctx.beginPath()
          ctx.arc(node.x, node.y, size * 3, 0, Math.PI * 2)
          const gradient = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, size * 3)
          gradient.addColorStop(0, node.color + '60')
          gradient.addColorStop(0.5, node.color + '20')
          gradient.addColorStop(1, node.color + '00')
          ctx.fillStyle = gradient
          ctx.fill()
        }
      })

      // Draw implant nodes
      Object.entries(implantPositions).forEach(([id, pos]) => {
        const isHighlighted = hoveredImplant === id
        const isDimmed = hasHover && !isHighlighted
        const color = IMPLANT_COLORS[id] || '#38bdf8'
        const implant = COGNITIVE_IMPLANTS[id]
        const size = isHighlighted ? 25 : isDimmed ? 12 : 15

        // Large glow for highlighted
        if (isHighlighted) {
          const glowSize = size * 4
          const gradient = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, glowSize)
          gradient.addColorStop(0, color + '80')
          gradient.addColorStop(0.3, color + '40')
          gradient.addColorStop(0.6, color + '15')
          gradient.addColorStop(1, color + '00')
          ctx.beginPath()
          ctx.arc(pos.x, pos.y, glowSize, 0, Math.PI * 2)
          ctx.fillStyle = gradient
          ctx.fill()
        } else if (!isDimmed) {
          // Normal glow
          const glowSize = size * 2
          const gradient = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, glowSize)
          gradient.addColorStop(0, color + '30')
          gradient.addColorStop(1, color + '00')
          ctx.beginPath()
          ctx.arc(pos.x, pos.y, glowSize, 0, Math.PI * 2)
          ctx.fillStyle = gradient
          ctx.fill()
        }

        // Node fill
        ctx.beginPath()
        ctx.arc(pos.x, pos.y, size, 0, Math.PI * 2)
        ctx.fillStyle = isHighlighted ? color : isDimmed ? color + '40' : color + 'cc'
        ctx.fill()

        // Border
        ctx.beginPath()
        ctx.arc(pos.x, pos.y, size, 0, Math.PI * 2)
        ctx.strokeStyle = isHighlighted ? '#ffffff' : color
        ctx.lineWidth = isHighlighted ? 3 : 1
        ctx.stroke()

        // Label
        if (implant) {
          ctx.font = `${isHighlighted ? 'bold 14px' : '10px'} system-ui, sans-serif`
          ctx.textAlign = 'center'
          ctx.fillStyle = isHighlighted ? '#ffffff' : isDimmed ? 'rgba(255, 255, 255, 0.3)' : 'rgba(255, 255, 255, 0.7)'
          ctx.fillText(implant.name, pos.x, pos.y + size + 18)
        }
      })

      // Draw core node with Q
      const coreSize = 40
      const corePulse = Math.sin(time * 0.03) * 5 + coreSize

      // Core glow
      const coreGradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, corePulse * 3)
      coreGradient.addColorStop(0, 'rgba(0, 212, 170, 0.4)')
      coreGradient.addColorStop(0.5, 'rgba(56, 189, 248, 0.2)')
      coreGradient.addColorStop(1, 'rgba(56, 189, 248, 0)')
      ctx.beginPath()
      ctx.arc(centerX, centerY, corePulse * 3, 0, Math.PI * 2)
      ctx.fillStyle = coreGradient
      ctx.fill()

      // Core outer ring
      ctx.beginPath()
      ctx.arc(centerX, centerY, corePulse + 10, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(0, 212, 170, 0.3)'
      ctx.lineWidth = 2
      ctx.stroke()

      // Core inner ring
      ctx.beginPath()
      ctx.arc(centerX, centerY, corePulse, 0, Math.PI * 2)
      ctx.strokeStyle = '#00d4aa'
      ctx.lineWidth = 3
      ctx.stroke()

      // Core fill
      ctx.beginPath()
      ctx.arc(centerX, centerY, corePulse - 5, 0, Math.PI * 2)
      const coreFill = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, corePulse)
      coreFill.addColorStop(0, '#00d4aa')
      coreFill.addColorStop(0.5, '#00a080')
      coreFill.addColorStop(1, '#006050')
      ctx.fillStyle = coreFill
      ctx.fill()

      // Q letter in center
      ctx.font = 'bold 36px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = '#ffffff'
      ctx.fillText('Q', centerX, centerY)

      // Core label
      ctx.font = '14px system-ui, sans-serif'
      ctx.textBaseline = 'alphabetic'
      ctx.fillStyle = '#00d4aa'
      ctx.fillText('QUOX CORE', centerX, centerY + corePulse + 25)

      // Health percentage
      const health = data['quox-sense']?.overallHealth ?? 0
      ctx.font = 'bold 12px system-ui, sans-serif'
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)'
      ctx.fillText(`${Math.round(health)}% Health`, centerX, centerY + corePulse + 42)

      animationRef.current = requestAnimationFrame(draw)
    }

    draw()

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [dimensions, data, hoveredImplant])

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'f' || e.key === 'F') {
        toggleFullscreen()
      } else if (e.key === 'Escape') {
        if (document.fullscreenElement) {
          document.exitFullscreen()
        } else {
          navigate('/topology')
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [navigate])

  // Canvas mousemove — hit-test datapoint nodes for tooltips
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const handleCanvasMouseMove = (e) => {
      const rect = canvas.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      setMousePos({ x: e.clientX, y: e.clientY })

      const HIT_RADIUS = 12
      const nodes = nodesRef.current
      let found = null

      for (const node of nodes) {
        // Nodes orbit — approximate current position from stored orbitAngle + time
        // For simplicity, use the base position (close enough for hit testing)
        const dx = node.x - x
        const dy = node.y - y
        if (dx * dx + dy * dy < HIT_RADIUS * HIT_RADIUS) {
          found = node
          break
        }
      }

      setHoveredNode(found)
      canvas.style.cursor = found ? 'pointer' : 'default'
    }

    canvas.addEventListener('mousemove', handleCanvasMouseMove)
    canvas.addEventListener('mouseleave', () => { setHoveredNode(null); canvas.style.cursor = 'default' })
    return () => {
      canvas.removeEventListener('mousemove', handleCanvasMouseMove)
    }
  }, [dimensions])

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen()
      } else {
        await document.exitFullscreen()
      }
    } catch (err) {
      console.error('Fullscreen error:', err)
    }
  }

  // Get primary value for legend
  const getPrimaryValue = (implantId) => {
    const implant = COGNITIVE_IMPLANTS[implantId]
    const implantData = data[implantId]
    if (!implant || !implantData) return '---'

    const primaryMetric = implant.metrics?.find(m => m.primary)
    if (!primaryMetric) return '---'

    const value = implantData[primaryMetric.key]
    if (value === null || value === undefined) return '---'

    switch (primaryMetric.format) {
      case 'percent': return `${Math.round(value)}%`
      case 'number': return value.toLocaleString()
      default: return String(value)
    }
  }

  return (
    <div className="quox-core">
      <canvas
        ref={canvasRef}
        className="quox-core__canvas"
        style={{ width: dimensions.width, height: dimensions.height }}
      />

      {/* Datapoint hover info panel */}
      {hoveredNode && (() => {
        const implant = COGNITIVE_IMPLANTS[hoveredNode.implantId]
        const implantData = data[hoveredNode.implantId] || {}
        const name = implant?.name || hoveredNode.implantId
        const inspiredBy = implant?.inspiredBy
        const tier = implant?.tier
        const primaryMetric = implant?.metrics?.find(m => m.primary)
        const primaryValue = primaryMetric ? implantData[primaryMetric.key] : null
        const secondaryMetrics = implant?.metrics?.filter(m => !m.primary) || []

        return (
          <div style={{
            position: 'fixed',
            left: Math.min(mousePos.x + 16, window.innerWidth - 260),
            top: Math.max(mousePos.y - 20, 10),
            background: 'rgba(5,5,16,0.96)',
            border: `1px solid ${hoveredNode.color}35`,
            borderRadius: 10,
            padding: '14px 16px',
            fontFamily: "system-ui, -apple-system, sans-serif",
            fontSize: 12,
            color: 'rgba(255,255,255,0.85)',
            backdropFilter: 'blur(16px)',
            pointerEvents: 'none',
            zIndex: 100,
            width: 230,
            boxShadow: `0 8px 32px rgba(0,0,0,0.5), 0 0 20px ${hoveredNode.color}10`,
          }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <div style={{
                width: 10, height: 10, borderRadius: '50%',
                background: hoveredNode.color,
                boxShadow: `0 0 8px ${hoveredNode.color}80`,
              }} />
              <div>
                <div style={{ fontWeight: 700, color: hoveredNode.color, fontSize: 13 }}>{name} Implant</div>
                {inspiredBy && <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>Inspired by the {inspiredBy.toLowerCase()}</div>}
              </div>
              {tier && (
                <span style={{
                  marginLeft: 'auto', padding: '2px 6px', borderRadius: 4, fontSize: 9, fontWeight: 700,
                  background: tier === 'free' ? 'rgba(34,197,94,0.15)' : tier === 'pro' ? 'rgba(245,158,11,0.15)' : 'rgba(168,85,247,0.15)',
                  color: tier === 'free' ? '#22c55e' : tier === 'pro' ? '#f59e0b' : '#a855f7',
                  textTransform: 'uppercase',
                }}>{tier}</span>
              )}
            </div>

            {/* Primary metric */}
            {primaryMetric && primaryValue != null && (
              <div style={{
                padding: '8px 10px', borderRadius: 6, marginBottom: 8,
                background: `${hoveredNode.color}08`, border: `1px solid ${hoveredNode.color}15`,
              }}>
                <div style={{ fontSize: 20, fontWeight: 800, color: '#fff' }}>
                  {typeof primaryValue === 'number' && primaryMetric.format === 'percent'
                    ? `${Math.round(primaryValue)}%`
                    : primaryValue}
                </div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  {primaryMetric.label}
                </div>
              </div>
            )}

            {/* Secondary metrics */}
            {secondaryMetrics.length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                {secondaryMetrics.slice(0, 4).map(m => {
                  const val = implantData[m.key]
                  return (
                    <div key={m.key} style={{ padding: '4px 6px', borderRadius: 4, background: 'rgba(255,255,255,0.03)' }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.8)' }}>
                        {val != null ? (m.format === 'percent' ? `${Math.round(val)}%` : val) : '-'}
                      </div>
                      <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)' }}>{m.label}</div>
                    </div>
                  )
                })}
              </div>
            )}

            {/* Data status */}
            <div style={{ marginTop: 8, fontSize: 10, color: 'rgba(255,255,255,0.3)', display: 'flex', justifyContent: 'space-between' }}>
              <span>{hoveredNode.hasRealData ? '● Live data' : '○ Awaiting data'}</span>
              <span>Node {hoveredNode.nodeIndex + 1}/{hoveredNode.totalNodes}</span>
            </div>
          </div>
        )
      })()}

      {/* Legend */}
      <div className={`quox-core__legend ${showControls ? 'visible' : ''}`}>
        <div className="quox-core__legend-header">
          <span>Cognitive Implants</span>
        </div>
        <div className="quox-core__legend-items">
          {Object.entries(IMPLANT_COLORS).map(([id, color]) => {
            const implant = COGNITIVE_IMPLANTS[id]
            if (!implant) return null

            return (
              <button
                key={id}
                className={`quox-core__legend-item ${hoveredImplant === id ? 'active' : ''}`}
                onMouseEnter={() => setHoveredImplant(id)}
                onMouseLeave={() => setHoveredImplant(null)}
                style={{ '--item-color': color }}
              >
                <span className="quox-core__legend-dot" />
                <span className="quox-core__legend-name">{implant.name}</span>
                <span className="quox-core__legend-value">{getPrimaryValue(id)}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Controls */}
      <div className={`quox-core__controls ${showControls ? 'visible' : ''}`}>
        <button
          className="quox-core__btn"
          onClick={() => navigate('/topology')}
          title="Back to Topology (Esc)"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>
        <button
          className="quox-core__btn"
          onClick={toggleFullscreen}
          title={isFullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)'}
        >
          {isFullscreen ? (
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" />
            </svg>
          )}
        </button>
      </div>

      {/* Keyboard hints */}
      <div className={`quox-core__hints ${showControls ? 'visible' : ''}`}>
        <span><kbd>F</kbd> Fullscreen</span>
        <span><kbd>Esc</kbd> Back</span>
      </div>
    </div>
  )
}
