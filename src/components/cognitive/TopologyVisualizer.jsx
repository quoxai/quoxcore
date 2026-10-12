/**
 * TopologyVisualizer - Data-driven neural network visualization
 *
 * Styled like NexusVisualizer but populated with ALL real system data.
 * Shows every memory, agent, tool, file, workflow, integration as individual nodes.
 */

import { useRef, useEffect, useCallback, useState, useMemo } from 'react'
import { queueSync } from '../../services/serverSyncQueue'
import { useCognitiveData } from './hooks/useCognitiveData'
import { getMemoryManager } from '../../services/memoryManager'
import { getAssistants } from '../../services/entityRegistry'
import { listFiles } from '../../services/fileStorage'
import { getIndexStats } from '../../services/capabilityIndex'
import { getHostsWithPing, isBastionAvailable } from '../../config/hosts'
import { PALETTES, NODE_TYPE_COLOR_MAP, LEGEND_ITEMS, getNodeTypeColor, getImplantColor, IMPLANT_TO_NODE_TYPES } from '../../config/visualPalettes'

// Node type labels (colors now come from palette)
const NODE_TYPES = {
  core: { label: 'Core' },
  memory: { label: 'Memory' },
  fact: { label: 'Fact' },
  preference: { label: 'Preference' },
  decision: { label: 'Decision' },
  reflection: { label: 'Reflection' },
  conversation: { label: 'Conversation' },
  agent: { label: 'Agent' },
  tool: { label: 'Tool' },
  workflow: { label: 'Workflow' },
  file: { label: 'File' },
  integration: { label: 'Integration' },
  entity: { label: 'Entity' },
  host: { label: 'Host' },
  'host-online': { label: 'Host (Online)' },
  'host-offline': { label: 'Host (Offline)' },
}

// Convert hex to RGB for canvas operations
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : { r: 128, g: 128, b: 128 }
}

/**
 * Build ALL data nodes from real system data - no limits!
 */
function useDataNodes() {
  const { data } = useCognitiveData()
  const [nodes, setNodes] = useState([])
  const builtRef = useRef(false)
  const dataHashRef = useRef('')

  useEffect(() => {
    // Create a simple hash of data to avoid unnecessary rebuilds
    const dataHash = JSON.stringify({
      ml: data?.['quox-memory'],
      is: data?.['quox-insight']?.totalIntegrations,
    })

    // Only rebuild if data actually changed meaningfully
    if (builtRef.current && dataHash === dataHashRef.current) {
      return
    }

    const buildNodes = async () => {
      const allNodes = []

      // Core node at center
      allNodes.push({
        id: 'core',
        type: 'core',
        label: 'QuoxCORE',
        x: 0, y: 0, z: 0,
        size: 6,
        isCore: true,
      })

      // Helper to distribute nodes in a sphere shell (flatten applied dynamically in render)
      const addNodesInShell = (items, type, minRadius, maxRadius, getLabel, getSublabel) => {
        items.forEach((item, i) => {
          // Fibonacci sphere distribution
          const phi = Math.acos(1 - 2 * (i + 0.5) / items.length)
          const theta = Math.PI * (1 + Math.sqrt(5)) * i
          const radius = minRadius + Math.random() * (maxRadius - minRadius)

          allNodes.push({
            id: `${type}-${i}`,
            type,
            label: getLabel(item, i),
            sublabel: getSublabel?.(item, i),
            x: radius * Math.sin(phi) * Math.cos(theta),
            y: radius * Math.cos(phi), // Flatten applied dynamically via settings
            z: radius * Math.sin(phi) * Math.sin(theta),
            size: 1 + Math.random() * 0.5,
          })
        })
      }

      // Memory nodes - get ALL memories by type
      try {
        const mm = getMemoryManager()

        // Facts
        const facts = mm.getLearnedItemsByType('fact') || []
        addNodesInShell(facts, 'fact', 150, 250,
          (m) => m.content?.slice(0, 40) || 'Fact',
          () => 'fact'
        )

        // Preferences
        const preferences = mm.getLearnedItemsByType('preference') || []
        addNodesInShell(preferences, 'preference', 160, 260,
          (m) => m.content?.slice(0, 40) || 'Preference',
          () => 'preference'
        )

        // Decisions
        const decisions = mm.getLearnedItemsByType('decision') || []
        addNodesInShell(decisions, 'decision', 170, 270,
          (m) => m.content?.slice(0, 40) || 'Decision',
          () => 'decision'
        )

        // Reflections
        const reflections = mm.getLearnedItemsByType('reflection') || []
        addNodesInShell(reflections, 'reflection', 180, 280,
          (m) => m.content?.slice(0, 40) || 'Reflection',
          () => 'reflection'
        )

        // Entities from memory
        const entities = mm.getAllEntities?.() || []
        addNodesInShell(entities, 'entity', 200, 300,
          (e) => e.name || e.id || 'Entity',
          (e) => e.type
        )

        // Conversations (episodic)
        const conversations = mm.getConversations?.() || mm.conversations || []
        if (Array.isArray(conversations)) {
          addNodesInShell(conversations, 'conversation', 220, 350,
            (c, i) => c.title || c.summary?.slice(0, 30) || `Conversation ${i + 1}`,
            (c) => c.timestamp ? new Date(c.timestamp).toLocaleDateString() : null
          )
        }
      } catch (e) { /* ignore */ }

      // Agent nodes - ALL agents
      try {
        const assistants = getAssistants()
        const agentList = Object.values(assistants || {})
        addNodesInShell(agentList, 'agent', 100, 180,
          (a) => a.name || 'Agent',
          (a) => a.role || `Level ${a.level || 0}`
        )
      } catch (e) { /* ignore */ }

      // Tool/capability nodes - ALL tools
      try {
        const stats = getIndexStats()
        const toolCount = stats?.tools || 0
        const toolItems = Array.from({ length: toolCount }, (_, i) => ({ id: i }))
        addNodesInShell(toolItems, 'tool', 250, 380,
          (_, i) => `Tool ${i + 1}`,
          () => 'capability'
        )

        // Workflow nodes - ALL workflows
        const workflowCount = stats?.workflows || 0
        const workflowItems = Array.from({ length: workflowCount }, (_, i) => ({ id: i }))
        addNodesInShell(workflowItems, 'workflow', 280, 400,
          (_, i) => `Workflow ${i + 1}`,
          () => 'automation'
        )
      } catch (e) { /* ignore */ }

      // File nodes - ALL files
      try {
        const files = await listFiles()
        if (files?.length > 0) {
          addNodesInShell(files, 'file', 300, 450,
            (f) => f.name?.slice(0, 30) || 'File',
            (f) => f.type || 'document'
          )
        }
      } catch (e) { /* ignore */ }

      // Host nodes from QuoxBastion - outer ring showing infrastructure
      try {
        const bastionOk = await isBastionAvailable()
        if (bastionOk) {
          const { hosts, ping } = await getHostsWithPing()
          if (hosts?.length > 0) {
            // Add hosts as outer ring nodes
            hosts.forEach((host, i) => {
              const isOnline = ping[host.id]?.reachable
              const latency = ping[host.id]?.latency_ms
              const type = isOnline ? 'host-online' : 'host-offline'

              // Distribute in outer ring with grouping
              const groupOffset = {
                'proxmox': 0,
                'docker': 0.15,
                'monitoring': 0.3,
                'storage': 0.45,
                'network': 0.55,
                'access': 0.65,
                'control': 0.75,
              }
              const baseAngle = (groupOffset[host.group] || 0.85) * Math.PI * 2
              const angleSpread = 0.12 * Math.PI * 2
              const hostIndex = hosts.filter((h, j) => j < i && h.group === host.group).length
              const groupSize = hosts.filter(h => h.group === host.group).length
              const angle = baseAngle + (hostIndex / Math.max(1, groupSize - 1)) * angleSpread

              const radius = 420 + (hostIndex % 2) * 30 // Stagger for readability

              allNodes.push({
                id: `host-${host.id}`,
                type,
                label: host.id,
                sublabel: isOnline ? `${latency}ms` : 'offline',
                x: radius * Math.cos(angle),
                y: (Math.random() - 0.5) * 80, // Slight vertical variation
                z: radius * Math.sin(angle),
                size: isOnline ? (latency < 50 ? 2 : latency < 200 ? 1.5 : 1) : 0.8,
                group: host.group,
                isOnline,
                latency,
              })
            })
            console.log(`[TopologyVisualizer] Added ${hosts.length} host nodes from Bastion`)
          }
        }
      } catch (e) {
        console.warn('[TopologyVisualizer] Failed to fetch hosts from Bastion:', e.message)
      }

      // Integration nodes from cognitive data
      if (data?.['quox-insight']?.totalIntegrations > 0) {
        const count = data['quox-insight'].totalIntegrations
        const integrationItems = Array.from({ length: count }, (_, i) => ({ id: i }))
        addNodesInShell(integrationItems, 'integration', 120, 200,
          (_, i) => `Integration ${i + 1}`,
          () => 'service'
        )
      }

      // If we still don't have many nodes, add more from cognitive data
      if (data?.['quox-memory']) {
        const ml = data['quox-memory']
        // Episodic memories
        if (ml.episodic > 0) {
          const episodicItems = Array.from({ length: ml.episodic }, (_, i) => ({ id: i }))
          addNodesInShell(episodicItems, 'memory', 200, 320,
            (_, i) => `Episode ${i + 1}`,
            () => 'episodic'
          )
        }
        // Semantic memories
        if (ml.semantic > 0) {
          const semanticItems = Array.from({ length: ml.semantic }, (_, i) => ({ id: i }))
          addNodesInShell(semanticItems, 'memory', 220, 340,
            (_, i) => `Semantic ${i + 1}`,
            () => 'semantic'
          )
        }
      }

      // TRUST-GATE 1.18e: no synthetic/demo node padding. Render exactly the
      // real nodes built above, however few — a sparse graph is an honest
      // signal (little real data yet), not something to paper over.
      console.log(`[TopologyVisualizer] Built ${allNodes.length} nodes from real data`)
      builtRef.current = true
      dataHashRef.current = dataHash
      setNodes(allNodes)
    }

    buildNodes()
  }, [data])

  return nodes
}

export default function TopologyVisualizer({ height = 320, highlightedTypes = null }) {
  const canvasRef = useRef(null)
  const containerRef = useRef(null)
  const animationRef = useRef(null)
  const angleRef = useRef(0)
  const nodesRef = useRef([])
  const hoveredNodeRef = useRef(null)
  const highlightedTypesRef = useRef(null)
  const [hoveredNode, setHoveredNode] = useState(null)
  const [legendHoveredTypes, setLegendHoveredTypes] = useState(null)
  const dimensionsRef = useRef({ width: 800, height })

  // Keep highlightedTypes ref in sync (combine prop with legend hover)
  useEffect(() => {
    highlightedTypesRef.current = legendHoveredTypes || highlightedTypes
  }, [highlightedTypes, legendHoveredTypes])

  // Controls state
  const [isPaused, setIsPaused] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [showSettings, setShowSettings] = useState(false)

  // Default settings values
  const DEFAULTS = {
    speed: 0.0005,
    flattenY: 0.35,
    spreadWidth: 1.0,
    spreadDepth: 1.0,
    tiltAngle: 0.3,
    nodeSize: 0.7,
    lineIntensity: 1.0,
    palette: 'observable',
  }

  // Valid palette IDs
  const VALID_PALETTES = ['observable', 'tableau', 'colorbrewer', 'vivid']

  // Load settings from localStorage
  const loadSettings = () => {
    try {
      const saved = localStorage.getItem('topology-visualizer-settings')
      if (saved) {
        const parsed = JSON.parse(saved)
        let needsSave = false
        // Validate palette - use default if invalid and update localStorage
        if (parsed.palette && !VALID_PALETTES.includes(parsed.palette)) {
          parsed.palette = DEFAULTS.palette
          needsSave = true
        }
        // Self-heal: update localStorage with valid settings
        if (needsSave) {
          try {
            localStorage.setItem('topology-visualizer-settings', JSON.stringify({ ...DEFAULTS, ...parsed }))
          } catch (e) { /* ignore */ }
        }
        return { ...DEFAULTS, ...parsed }
      }
    } catch (e) { /* ignore */ }
    return DEFAULTS
  }

  // Initialize settings from localStorage
  const [settings] = useState(loadSettings)
  const [speed, setSpeed] = useState(settings.speed)
  const [flattenY, setFlattenY] = useState(settings.flattenY)
  const [spreadWidth, setSpreadWidth] = useState(settings.spreadWidth)
  const [spreadDepth, setSpreadDepth] = useState(settings.spreadDepth)
  const [tiltAngle, setTiltAngle] = useState(settings.tiltAngle)
  const [nodeSize, setNodeSize] = useState(settings.nodeSize)
  const [lineIntensity, setLineIntensity] = useState(settings.lineIntensity)
  const [palette, setPalette] = useState(settings.palette || 'observable')

  // Save settings to localStorage when they change
  useEffect(() => {
    const toSave = { speed, flattenY, spreadWidth, spreadDepth, tiltAngle, nodeSize, lineIntensity, palette }
    try {
      localStorage.setItem('topology-visualizer-settings', JSON.stringify(toSave))
      queueSync('topologySettings', toSave)
    } catch (e) { /* ignore */ }
  }, [speed, flattenY, spreadWidth, spreadDepth, tiltAngle, nodeSize, lineIntensity, palette])

  const isPausedRef = useRef(false)
  const zoomRef = useRef(1)
  const speedRef = useRef(settings.speed)
  const flattenYRef = useRef(settings.flattenY)
  const spreadWidthRef = useRef(settings.spreadWidth)
  const spreadDepthRef = useRef(settings.spreadDepth)
  const tiltAngleRef = useRef(settings.tiltAngle)
  const nodeSizeRef = useRef(settings.nodeSize)
  const lineIntensityRef = useRef(settings.lineIntensity)
  const paletteRef = useRef(settings.palette || 'observable')

  // Keep refs in sync with state (for animation loop)
  useEffect(() => { isPausedRef.current = isPaused }, [isPaused])
  useEffect(() => { zoomRef.current = zoom }, [zoom])
  useEffect(() => { speedRef.current = speed }, [speed])
  useEffect(() => { flattenYRef.current = flattenY }, [flattenY])
  useEffect(() => { spreadWidthRef.current = spreadWidth }, [spreadWidth])
  useEffect(() => { spreadDepthRef.current = spreadDepth }, [spreadDepth])
  useEffect(() => { tiltAngleRef.current = tiltAngle }, [tiltAngle])
  useEffect(() => { nodeSizeRef.current = nodeSize }, [nodeSize])
  useEffect(() => { lineIntensityRef.current = lineIntensity }, [lineIntensity])
  useEffect(() => { paletteRef.current = palette }, [palette])

  const dataNodes = useDataNodes()

  // Update nodes ref when data changes
  useEffect(() => {
    nodesRef.current = dataNodes.map(n => ({ ...n }))
  }, [dataNodes])

  // Project 3D to 2D with zoom, flatten, spread (width/depth), and tilt
  const project3D = useCallback((node, angle, cx, cy, focalLength = 800, zoomLevel = 1, flattenAmount = 0.35, widthSpread = 1.0, depthSpread = 1.0, tilt = 0.3) => {
    const cosA = Math.cos(angle)
    const sinA = Math.sin(angle)
    const cosT = Math.cos(tilt)
    const sinT = Math.sin(tilt)

    // Apply width spread to X and Z, depth spread then flatten to Y
    const spreadX = node.x * widthSpread
    const spreadZ = node.z * widthSpread
    const flatY = node.y * depthSpread * flattenAmount

    // Rotate around Y axis (horizontal spin)
    const rotatedX = spreadX * cosA - spreadZ * sinA
    let rotatedZ = spreadX * sinA + spreadZ * cosA
    let rotatedY = flatY

    // Rotate around X axis (tilt - looking up/down at the plane)
    const tiltedY = rotatedY * cosT - rotatedZ * sinT
    const tiltedZ = rotatedY * sinT + rotatedZ * cosT

    const perspective = focalLength / (focalLength + tiltedZ)
    return {
      x: cx + rotatedX * perspective * zoomLevel,
      y: cy + tiltedY * perspective * zoomLevel,
      z: tiltedZ,
      scale: perspective * zoomLevel,
    }
  }, [])

  // Find node at position
  const findNodeAtPosition = useCallback((clientX, clientY) => {
    const canvas = canvasRef.current
    if (!canvas || nodesRef.current.length === 0) return null

    const rect = canvas.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top

    // Check in reverse (front to back) for proper z-order hit detection
    const sortedNodes = [...nodesRef.current]
      .filter(n => n.screenX !== undefined)
      .sort((a, b) => (b.screenZ || 0) - (a.screenZ || 0))

    for (const node of sortedNodes) {
      const dx = x - (node.screenX || 0)
      const dy = y - (node.screenY || 0)
      const dist = Math.sqrt(dx * dx + dy * dy)
      const hitRadius = Math.max(8, (node.size || 2) * (node.screenScale || 1) * 6)
      if (dist < hitRadius) {
        return node
      }
    }
    return null
  }, [])

  // Mouse handlers
  const handleMouseMove = useCallback((e) => {
    const node = findNodeAtPosition(e.clientX, e.clientY)
    hoveredNodeRef.current = node
    setHoveredNode(node)
    if (canvasRef.current) {
      canvasRef.current.style.cursor = node ? 'pointer' : 'crosshair'
    }
  }, [findNodeAtPosition])

  const handleMouseLeave = useCallback(() => {
    hoveredNodeRef.current = null
    setHoveredNode(null)
  }, [])

  // Render loop - NexusVisualizer style
  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const ctx = canvas.getContext('2d')

    // ResizeObserver for responsive canvas
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height: h } = entry.contentRect
        if (width > 0 && h > 0) {
          canvas.width = width
          canvas.height = h
          dimensionsRef.current = { width, height: h }
        }
      }
    })
    resizeObserver.observe(container)

    // Initial size
    const { clientWidth, clientHeight } = container
    if (clientWidth > 0 && clientHeight > 0) {
      canvas.width = clientWidth
      canvas.height = clientHeight
      dimensionsRef.current = { width: clientWidth, height: clientHeight }
    }

    const draw = () => {
      const { width, height: h } = dimensionsRef.current
      if (width === 0 || h === 0) {
        animationRef.current = requestAnimationFrame(draw)
        return
      }

      const cx = width / 2
      const cy = h / 2

      // Rotation speed from settings (only when not paused)
      if (!isPausedRef.current) {
        angleRef.current += speedRef.current
      }

      const currentZoom = zoomRef.current
      const currentFlatten = flattenYRef.current
      const currentSpreadWidth = spreadWidthRef.current
      const currentSpreadDepth = spreadDepthRef.current
      const currentTilt = tiltAngleRef.current
      const currentNodeSize = nodeSizeRef.current
      const currentLineIntensity = lineIntensityRef.current
      const currentPalette = paletteRef.current

      // Clear canvas (NexusVisualizer style - transparent bg)
      ctx.clearRect(0, 0, width, h)

      // Dark gradient background
      const bgGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(width, h) * 0.6)
      bgGrad.addColorStop(0, 'rgba(20, 10, 30, 0.95)')
      bgGrad.addColorStop(0.5, 'rgba(10, 5, 20, 0.98)')
      bgGrad.addColorStop(1, 'rgba(5, 2, 10, 1)')
      ctx.fillStyle = bgGrad
      ctx.fillRect(0, 0, width, h)

      // Project all nodes with zoom, flatten, spread (width/depth), and tilt
      const projected = nodesRef.current.map(node => {
        const proj = project3D(node, angleRef.current, cx, cy, 800, currentZoom, currentFlatten, currentSpreadWidth, currentSpreadDepth, currentTilt)
        // Store for hit detection
        node.screenX = proj.x
        node.screenY = proj.y
        node.screenZ = proj.z
        node.screenScale = proj.scale
        return { ...node, ...proj }
      })

      // Sort by z for proper depth rendering
      projected.sort((a, b) => a.z - b.z)

      // Draw connections TO CORE - with line intensity control
      const core = projected.find(n => n.isCore)
      const hoveredId = hoveredNodeRef.current?.id

      if (core && currentLineIntensity > 0) {
        // First pass: draw non-highlighted connections
        ctx.lineWidth = 1
        projected.forEach(node => {
          if (node.isCore) return
          const isHoveredNode = node.id === hoveredId

          const dx = node.x - core.x
          const dy = node.y - core.y
          const dist = Math.sqrt(dx * dx + dy * dy)
          const maxDist = 400

          if (dist < maxDist && !isHoveredNode) {
            const color = getNodeTypeColor(node.type, currentPalette)
            const rgb = hexToRgb(color)
            const baseAlpha = 0.08 + (1 - dist / maxDist) * 0.17
            const alpha = baseAlpha * currentLineIntensity
            ctx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`
            ctx.beginPath()
            ctx.moveTo(node.x, node.y)
            ctx.lineTo(core.x, core.y)
            ctx.stroke()
          }
        })

        // Draw connections between nearby same-type nodes (non-highlighted)
        const connectionDistance = 80
        for (let i = 0; i < projected.length; i++) {
          const p1 = projected[i]
          if (p1.isCore) continue
          const p1Hovered = p1.id === hoveredId

          for (let j = i + 1; j < projected.length; j++) {
            const p2 = projected[j]
            if (p2.isCore) continue
            if (p1.type !== p2.type) continue
            const p2Hovered = p2.id === hoveredId

            // Skip if either node is hovered (we'll draw highlighted later)
            if (p1Hovered || p2Hovered) continue

            const dx = p1.x - p2.x
            const dy = p1.y - p2.y
            const dist = Math.sqrt(dx * dx + dy * dy)

            if (dist < connectionDistance) {
              const color = getNodeTypeColor(p1.type, currentPalette)
              const rgb = hexToRgb(color)
              const baseAlpha = (1 - dist / connectionDistance) * 0.2
              const alpha = baseAlpha * currentLineIntensity
              ctx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`
              ctx.beginPath()
              ctx.moveTo(p1.x, p1.y)
              ctx.lineTo(p2.x, p2.y)
              ctx.stroke()
            }
          }
        }

        // Second pass: draw HIGHLIGHTED connections for hovered node
        if (hoveredId && hoveredId !== 'core') {
          const hoveredNode = projected.find(n => n.id === hoveredId)
          if (hoveredNode) {
            const color = getNodeTypeColor(hoveredNode.type, currentPalette)
            const rgb = hexToRgb(color)

            // Highlighted connection to core
            ctx.lineWidth = 2
            ctx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.9)`
            ctx.shadowBlur = 8
            ctx.shadowColor = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.8)`
            ctx.beginPath()
            ctx.moveTo(hoveredNode.x, hoveredNode.y)
            ctx.lineTo(core.x, core.y)
            ctx.stroke()

            // Highlighted connections to same-type nodes
            projected.forEach(other => {
              if (other.id === hoveredId || other.isCore) return
              if (other.type !== hoveredNode.type) return

              const dx = other.x - hoveredNode.x
              const dy = other.y - hoveredNode.y
              const dist = Math.sqrt(dx * dx + dy * dy)

              if (dist < connectionDistance * 1.5) {
                const alpha = Math.max(0.4, (1 - dist / (connectionDistance * 1.5)) * 0.8)
                ctx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`
                ctx.lineWidth = 1.5
                ctx.beginPath()
                ctx.moveTo(hoveredNode.x, hoveredNode.y)
                ctx.lineTo(other.x, other.y)
                ctx.stroke()
              }
            })

            ctx.shadowBlur = 0
            ctx.lineWidth = 1
          }
        }
      }

      // Draw center rings (muted, palette-aware)
      const coreColor = getNodeTypeColor('core', currentPalette)
      const coreRgb = hexToRgb(coreColor)
      ctx.strokeStyle = `rgba(${coreRgb.r}, ${coreRgb.g}, ${coreRgb.b}, 0.15)`
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(cx, cy, 120, 0, Math.PI * 2)
      ctx.stroke()

      ctx.strokeStyle = `rgba(${coreRgb.r}, ${coreRgb.g}, ${coreRgb.b}, 0.08)`
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(cx, cy, 80, 0, Math.PI * 2)
      ctx.stroke()

      // Pulsing inner ring
      const pulseRadius = 40 + Math.sin(angleRef.current * 50) * 8
      ctx.strokeStyle = `rgba(${coreRgb.r}, ${coreRgb.g}, ${coreRgb.b}, 0.25)`
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(cx, cy, pulseRadius, 0, Math.PI * 2)
      ctx.stroke()

      // Draw nodes with glow (NexusVisualizer style)
      const activeHighlightTypes = highlightedTypesRef.current
      projected.forEach(node => {
        const isHovered = hoveredNodeRef.current?.id === node.id
        const isTypeHighlighted = activeHighlightTypes?.includes(node.type)
        const isHighlighted = isHovered || isTypeHighlighted

        // Special coloring for host nodes based on status
        let color
        if (node.type === 'host-online') {
          color = '#30ff90' // Green for online
        } else if (node.type === 'host-offline') {
          color = '#ff3030' // Red for offline
        } else {
          color = getNodeTypeColor(node.type, currentPalette)
        }
        const rgb = hexToRgb(color)
        const baseSize = (node.size || 1.5) * node.scale * 4 * currentNodeSize
        const size = baseSize * (isHighlighted ? 1.5 : 1)

        // Depth-based alpha (brighter when highlighted)
        const depthAlpha = isTypeHighlighted
          ? 0.7 + node.scale * 0.3
          : (activeHighlightTypes ? 0.15 + node.scale * 0.2 : 0.4 + node.scale * 0.6)

        // Glow effect (stronger when highlighted)
        ctx.shadowBlur = isHighlighted ? 25 : (activeHighlightTypes ? 4 : 12)
        ctx.shadowColor = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${isHighlighted ? 1 : 0.8})`

        // Node fill
        ctx.fillStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${depthAlpha})`
        ctx.beginPath()
        ctx.arc(node.x, node.y, size, 0, Math.PI * 2)
        ctx.fill()

        // Core node special rendering
        if (node.isCore) {
          const coreCol = getNodeTypeColor('core', currentPalette)
          const coreRgb = hexToRgb(coreCol)
          ctx.shadowBlur = 30
          ctx.shadowColor = `rgba(${coreRgb.r}, ${coreRgb.g}, ${coreRgb.b}, 1)`
          ctx.fillStyle = `rgba(${coreRgb.r}, ${coreRgb.g}, ${coreRgb.b}, 0.9)`
          ctx.beginPath()
          ctx.arc(node.x, node.y, size * 1.5, 0, Math.PI * 2)
          ctx.fill()

          // Inner bright core
          ctx.fillStyle = `rgba(${Math.min(255, coreRgb.r + 40)}, ${Math.min(255, coreRgb.g + 40)}, ${Math.min(255, coreRgb.b + 40)}, 1)`
          ctx.beginPath()
          ctx.arc(node.x, node.y, size * 0.6, 0, Math.PI * 2)
          ctx.fill()
        }

        // Hover/highlight ring
        if (isHighlighted && !node.isCore) {
          ctx.shadowBlur = 0
          ctx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${isHovered ? 0.9 : 0.6})`
          ctx.lineWidth = isHovered ? 2 : 1.5
          ctx.beginPath()
          ctx.arc(node.x, node.y, size + 4, 0, Math.PI * 2)
          ctx.stroke()
        }
      })

      // Reset shadow
      ctx.shadowBlur = 0

      // Draw node count indicator
      ctx.fillStyle = 'rgba(255, 255, 255, 0.3)'
      ctx.font = '11px monospace'
      ctx.textAlign = 'right'
      ctx.fillText(`${nodesRef.current.length} nodes`, width - 12, h - 12)

      animationRef.current = requestAnimationFrame(draw)
    }

    draw()

    return () => {
      resizeObserver.disconnect()
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [project3D])

  // Tooltip positioning
  const tooltipStyle = useMemo(() => {
    if (!hoveredNode || !canvasRef.current) return { display: 'none' }
    const rect = canvasRef.current.getBoundingClientRect()
    return {
      display: 'block',
      left: Math.min(Math.max(hoveredNode.screenX || 0, 80), rect.width - 80),
      top: Math.max((hoveredNode.screenY || 0) - 70, 10),
    }
  }, [hoveredNode])

  const nodeColor = hoveredNode ? getNodeTypeColor(hoveredNode.type, palette) : '#7B61FF'

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        height,
        background: '#0a0510',
        borderRadius: 'var(--m-radius-xl)',
        overflow: 'hidden',
        border: '1px solid rgba(139, 92, 246, 0.2)',
      }}
    >
      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        style={{ width: '100%', height: '100%', display: 'block' }}
      />

      {/* Controls */}
      <div style={{
        position: 'absolute',
        top: 12,
        left: 12,
        display: 'flex',
        gap: 6,
        zIndex: 50,
      }}>
        <button
          onClick={() => setIsPaused(!isPaused)}
          title={isPaused ? 'Resume rotation' : 'Pause rotation'}
          style={{
            width: 32,
            height: 32,
            borderRadius: 6,
            border: '1px solid rgba(139, 92, 246, 0.4)',
            background: isPaused ? 'rgba(139, 92, 246, 0.3)' : 'rgba(0, 0, 0, 0.6)',
            color: '#fff',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
            transition: 'all 0.2s',
          }}
        >
          {isPaused ? '▶' : '⏸'}
        </button>
        <button
          onClick={() => setZoom(z => Math.min(z + 0.2, 2.5))}
          title="Zoom in"
          style={{
            width: 32,
            height: 32,
            borderRadius: 6,
            border: '1px solid rgba(139, 92, 246, 0.4)',
            background: 'rgba(0, 0, 0, 0.6)',
            color: '#fff',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 16,
            fontWeight: 'bold',
          }}
        >
          +
        </button>
        <button
          onClick={() => setZoom(z => Math.max(z - 0.2, 0.4))}
          title="Zoom out"
          style={{
            width: 32,
            height: 32,
            borderRadius: 6,
            border: '1px solid rgba(139, 92, 246, 0.4)',
            background: 'rgba(0, 0, 0, 0.6)',
            color: '#fff',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 16,
            fontWeight: 'bold',
          }}
        >
          −
        </button>
        <button
          onClick={() => setZoom(1)}
          title="Reset zoom"
          disabled={zoom === 1}
          style={{
            width: 32,
            height: 32,
            borderRadius: 6,
            border: '1px solid rgba(139, 92, 246, 0.4)',
            background: zoom === 1 ? 'rgba(0, 0, 0, 0.3)' : 'rgba(0, 0, 0, 0.6)',
            color: zoom === 1 ? 'rgba(255,255,255,0.3)' : '#fff',
            cursor: zoom === 1 ? 'default' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 11,
          }}
        >
          1:1
        </button>
        <button
          onClick={() => setShowSettings(!showSettings)}
          title="Settings"
          style={{
            width: 32,
            height: 32,
            borderRadius: 6,
            border: '1px solid rgba(139, 92, 246, 0.4)',
            background: showSettings ? 'rgba(139, 92, 246, 0.3)' : 'rgba(0, 0, 0, 0.6)',
            color: '#fff',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
          }}
        >
          ⚙
        </button>
        <button
          onClick={() => {
            const canvas = canvasRef.current
            if (!canvas) return
            canvas.toBlob((blob) => {
              if (!blob) return
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = `topology-${new Date().toISOString().split('T')[0]}.png`
              document.body.appendChild(a)
              a.click()
              document.body.removeChild(a)
              URL.revokeObjectURL(url)
            }, 'image/png')
          }}
          title="Export as PNG"
          style={{
            width: 32,
            height: 32,
            borderRadius: 6,
            border: '1px solid rgba(139, 92, 246, 0.4)',
            background: 'rgba(0, 0, 0, 0.6)',
            color: '#fff',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
          }}
        >
          📷
        </button>
      </div>

      {/* Settings Panel */}
      {showSettings && (
        <div style={{
          position: 'absolute',
          top: 52,
          left: 12,
          background: 'rgba(0, 0, 0, 0.9)',
          borderRadius: 8,
          zIndex: 60,
          backdropFilter: 'blur(12px)',
          border: '1px solid rgba(139, 92, 246, 0.3)',
          width: 220,
          maxHeight: 'calc(100% - 70px)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}>
          {/* Header */}
          <div style={{
            padding: '10px 14px',
            borderBottom: '1px solid rgba(139, 92, 246, 0.2)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', fontWeight: 500 }}>Settings</span>
            <button
              onClick={() => {
                setSpeed(DEFAULTS.speed)
                setTiltAngle(DEFAULTS.tiltAngle)
                setFlattenY(DEFAULTS.flattenY)
                setSpreadWidth(DEFAULTS.spreadWidth)
                setSpreadDepth(DEFAULTS.spreadDepth)
                setLineIntensity(DEFAULTS.lineIntensity)
                setNodeSize(DEFAULTS.nodeSize)
                setPalette(DEFAULTS.palette)
                localStorage.removeItem('topology-visualizer-settings')
              }}
              style={{
                padding: '3px 8px',
                background: 'rgba(139, 92, 246, 0.15)',
                border: '1px solid rgba(139, 92, 246, 0.3)',
                borderRadius: 4,
                color: 'rgba(255,255,255,0.6)',
                fontSize: 9,
                cursor: 'pointer',
              }}
            >
              Reset
            </button>
          </div>

          {/* Scrollable content */}
          <div style={{
            flex: 1,
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: '10px 14px',
          }}>
            {/* MOTION Section */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 9, color: 'rgba(139, 92, 246, 0.8)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8, fontWeight: 600 }}>
                Motion
              </div>
              {/* Speed slider */}
              <div style={{ marginBottom: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'rgba(255,255,255,0.6)', marginBottom: 2 }}>
                  <span>Speed</span>
                  <span style={{ color: 'rgba(255,255,255,0.4)' }}>{(speed * 10000).toFixed(1)}</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="0.01"
                  step="0.0002"
                  value={speed}
                  onChange={(e) => setSpeed(parseFloat(e.target.value))}
                  style={{ width: '100%', accentColor: '#8b5cf6', height: 4 }}
                />
              </div>
              {/* Tilt slider */}
              <div style={{ marginBottom: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'rgba(255,255,255,0.6)', marginBottom: 2 }}>
                  <span>Tilt</span>
                  <span style={{ color: 'rgba(255,255,255,0.4)' }}>{(tiltAngle * 57.3).toFixed(0)}°</span>
                </div>
                <input
                  type="range"
                  min="-0.8"
                  max="0.8"
                  step="0.05"
                  value={tiltAngle}
                  onChange={(e) => setTiltAngle(parseFloat(e.target.value))}
                  style={{ width: '100%', accentColor: '#8b5cf6', height: 4 }}
                />
              </div>
            </div>

            {/* SHAPE Section */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 9, color: 'rgba(139, 92, 246, 0.8)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8, fontWeight: 600 }}>
                Shape
              </div>
              {/* Height slider */}
              <div style={{ marginBottom: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'rgba(255,255,255,0.6)', marginBottom: 2 }}>
                  <span>Height</span>
                  <span style={{ color: 'rgba(255,255,255,0.4)' }}>{(flattenY * 100).toFixed(0)}%</span>
                </div>
                <input
                  type="range"
                  min="0.1"
                  max="1.0"
                  step="0.05"
                  value={flattenY}
                  onChange={(e) => setFlattenY(parseFloat(e.target.value))}
                  style={{ width: '100%', accentColor: '#8b5cf6', height: 4 }}
                />
              </div>
              {/* Width slider */}
              <div style={{ marginBottom: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'rgba(255,255,255,0.6)', marginBottom: 2 }}>
                  <span>Width</span>
                  <span style={{ color: 'rgba(255,255,255,0.4)' }}>{(spreadWidth * 100).toFixed(0)}%</span>
                </div>
                <input
                  type="range"
                  min="0.5"
                  max="2.0"
                  step="0.1"
                  value={spreadWidth}
                  onChange={(e) => setSpreadWidth(parseFloat(e.target.value))}
                  style={{ width: '100%', accentColor: '#8b5cf6', height: 4 }}
                />
              </div>
              {/* Depth slider */}
              <div style={{ marginBottom: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'rgba(255,255,255,0.6)', marginBottom: 2 }}>
                  <span>Depth</span>
                  <span style={{ color: 'rgba(255,255,255,0.4)' }}>{(spreadDepth * 100).toFixed(0)}%</span>
                </div>
                <input
                  type="range"
                  min="0.5"
                  max="2.0"
                  step="0.1"
                  value={spreadDepth}
                  onChange={(e) => setSpreadDepth(parseFloat(e.target.value))}
                  style={{ width: '100%', accentColor: '#8b5cf6', height: 4 }}
                />
              </div>
            </div>

            {/* VISUAL Section */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 9, color: 'rgba(139, 92, 246, 0.8)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8, fontWeight: 600 }}>
                Visual
              </div>
              {/* Node Size slider */}
              <div style={{ marginBottom: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'rgba(255,255,255,0.6)', marginBottom: 2 }}>
                  <span>Node Size</span>
                  <span style={{ color: 'rgba(255,255,255,0.4)' }}>{(nodeSize * 100).toFixed(0)}%</span>
                </div>
                <input
                  type="range"
                  min="0.3"
                  max="1.5"
                  step="0.1"
                  value={nodeSize}
                  onChange={(e) => setNodeSize(parseFloat(e.target.value))}
                  style={{ width: '100%', accentColor: '#8b5cf6', height: 4 }}
                />
              </div>
              {/* Lines slider */}
              <div style={{ marginBottom: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'rgba(255,255,255,0.6)', marginBottom: 2 }}>
                  <span>Lines</span>
                  <span style={{ color: 'rgba(255,255,255,0.4)' }}>{(lineIntensity * 100).toFixed(0)}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="2.0"
                  step="0.1"
                  value={lineIntensity}
                  onChange={(e) => setLineIntensity(parseFloat(e.target.value))}
                  style={{ width: '100%', accentColor: '#8b5cf6', height: 4 }}
                />
              </div>
            </div>

            {/* PALETTE Section */}
            <div>
              <div style={{ fontSize: 9, color: 'rgba(139, 92, 246, 0.8)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8, fontWeight: 600 }}>
                Color Palette
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {Object.values(PALETTES).map(p => {
                  const isSelected = palette === p.id
                  const colors = p.colors.slice(0, 6)
                  return (
                    <button
                      key={p.id}
                      onClick={() => setPalette(p.id)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 8px',
                        background: isSelected ? 'rgba(139, 92, 246, 0.25)' : 'rgba(0, 0, 0, 0.3)',
                        border: `1px solid ${isSelected ? 'rgba(139, 92, 246, 0.5)' : 'rgba(255,255,255,0.08)'}`,
                        borderRadius: 6,
                        cursor: 'pointer',
                        transition: 'all 0.15s',
                        textAlign: 'left',
                      }}
                    >
                      {/* Color swatches */}
                      <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                        {colors.map((color, i) => (
                          <div
                            key={i}
                            style={{
                              width: 8,
                              height: 8,
                              borderRadius: '50%',
                              background: color,
                              boxShadow: isSelected ? `0 0 4px ${color}66` : 'none',
                            }}
                          />
                        ))}
                      </div>
                      {/* Name */}
                      <span style={{
                        fontSize: 10,
                        color: isSelected ? '#fff' : 'rgba(255,255,255,0.6)',
                        fontWeight: isSelected ? 500 : 400,
                      }}>
                        {p.name}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Legend */}
      <div style={{
        position: 'absolute',
        bottom: 12,
        left: 12,
        background: 'rgba(0, 0, 0, 0.7)',
        borderRadius: 8,
        padding: '8px 10px',
        zIndex: 50,
        backdropFilter: 'blur(4px)',
        border: '1px solid rgba(100, 100, 120, 0.2)',
      }}>
        <div style={{
          fontSize: 9,
          color: 'rgba(255,255,255,0.5)',
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          marginBottom: 6,
        }}>
          Legend
        </div>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: '4px 12px',
          fontSize: 10,
        }}>
          {LEGEND_ITEMS.map(({ type, label, implant }) => {
            // Legend items are now implants, so use getImplantColor
            const color = implant ? getImplantColor(type, palette) : getNodeTypeColor(type, palette)
            const isHovered = legendHoveredTypes && IMPLANT_TO_NODE_TYPES[type]?.some(t => legendHoveredTypes.includes(t))
            return (
              <div
                key={type}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  cursor: 'pointer',
                  padding: '2px 4px',
                  margin: '-2px -4px',
                  borderRadius: 4,
                  background: isHovered ? 'rgba(255,255,255,0.1)' : 'transparent',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={() => setLegendHoveredTypes(IMPLANT_TO_NODE_TYPES[type] || [])}
                onMouseLeave={() => setLegendHoveredTypes(null)}
              >
                <div style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: color,
                  boxShadow: isHovered ? `0 0 10px ${color}` : `0 0 6px ${color}99`,
                  transform: isHovered ? 'scale(1.3)' : 'scale(1)',
                  transition: 'all 0.15s',
                }} />
                <span style={{ color: isHovered ? '#fff' : 'rgba(255,255,255,0.8)' }}>{label}</span>
              </div>
            )
          })}
        </div>
      </div>

      {hoveredNode && !hoveredNode.isCore && (
        <div
          style={{
            position: 'absolute',
            ...tooltipStyle,
            transform: 'translateX(-50%)',
            background: 'rgba(0, 0, 0, 0.9)',
            border: `1px solid ${nodeColor}80`,
            borderRadius: '8px',
            padding: '8px 12px',
            pointerEvents: 'none',
            zIndex: 100,
            textAlign: 'center',
            backdropFilter: 'blur(8px)',
            maxWidth: '200px',
          }}
        >
          <div style={{
            color: nodeColor,
            fontSize: '9px',
            textTransform: 'uppercase',
            letterSpacing: '1px',
            marginBottom: '2px',
          }}>
            {NODE_TYPES[hoveredNode.type]?.label || hoveredNode.type}
          </div>
          <div style={{
            color: '#fff',
            fontSize: '12px',
            fontWeight: 500,
            lineHeight: 1.3,
          }}>
            {hoveredNode.label}
          </div>
          {hoveredNode.sublabel && (
            <div style={{
              color: 'rgba(255, 255, 255, 0.5)',
              fontSize: '10px',
              marginTop: '2px',
            }}>
              {hoveredNode.sublabel}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
