import { useRef, useState, useEffect, useCallback } from 'react'

/**
 * useResponsiveCanvas - Standardized ResizeObserver pattern for canvas visualizers
 *
 * Provides consistent canvas sizing and resize handling across all visualizers.
 * This consolidates the ResizeObserver patterns from IrisVisualizer, AtomVisualizer,
 * BrainVisualizer, DnaVisualizer, and SphereVisualizer.
 *
 * Features:
 * - ResizeObserver-based responsive sizing (preferred over window resize)
 * - Proper canvas dimension updates (width/height attributes, not just CSS)
 * - Maintains aspect ratio option
 * - Device pixel ratio handling for sharp rendering
 * - Debouncing option for performance
 *
 * @param {Object} options - Configuration options
 * @param {boolean} options.maintainAspectRatio - Keep square aspect ratio (default: false)
 * @param {boolean} options.useDevicePixelRatio - Scale for high-DPI displays (default: false)
 * @param {number} options.debounceMs - Debounce resize events (default: 0)
 * @param {number} options.minWidth - Minimum width (default: 100)
 * @param {number} options.minHeight - Minimum height (default: 100)
 * @returns {Object} Canvas ref, container ref, dimensions, and utility functions
 *
 * @example
 * // Basic usage
 * const { canvasRef, containerRef, dimensions, ctx } = useResponsiveCanvas()
 *
 * useEffect(() => {
 *   if (!ctx) return
 *   ctx.clearRect(0, 0, dimensions.width, dimensions.height)
 *   // Draw...
 * }, [ctx, dimensions])
 *
 * return (
 *   <div ref={containerRef} style={{ width: '100%', height: '100%' }}>
 *     <canvas ref={canvasRef} />
 *   </div>
 * )
 *
 * @example
 * // Square canvas (for circular visualizers)
 * const { canvasRef, containerRef, dimensions } = useResponsiveCanvas({
 *   maintainAspectRatio: true
 * })
 */
export function useResponsiveCanvas(options = {}) {
  const {
    maintainAspectRatio = false,
    useDevicePixelRatio = false,
    debounceMs = 0,
    minWidth = 100,
    minHeight = 100
  } = options

  const canvasRef = useRef(null)
  const containerRef = useRef(null)
  const ctxRef = useRef(null)
  const debounceTimerRef = useRef(null)

  const [dimensions, setDimensions] = useState({ width: 400, height: 400 })

  /**
   * Update canvas dimensions
   */
  const updateDimensions = useCallback((width, height) => {
    const canvas = canvasRef.current
    if (!canvas) return

    // Apply minimum sizes
    width = Math.max(minWidth, width)
    height = Math.max(minHeight, height)

    // Maintain aspect ratio if requested (use smaller dimension)
    if (maintainAspectRatio) {
      const size = Math.min(width, height)
      width = size
      height = size
    }

    // Handle device pixel ratio for sharp rendering
    const dpr = useDevicePixelRatio ? (window.devicePixelRatio || 1) : 1

    // Set actual canvas size (for drawing)
    canvas.width = width * dpr
    canvas.height = height * dpr

    // Set display size (CSS)
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`

    // Scale context for device pixel ratio
    if (useDevicePixelRatio && dpr !== 1) {
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.scale(dpr, dpr)
      }
    }

    // Update state
    setDimensions({ width, height })
  }, [maintainAspectRatio, useDevicePixelRatio, minWidth, minHeight])

  /**
   * Handle resize with optional debouncing
   */
  const handleResize = useCallback((entries) => {
    const entry = entries[0]
    if (!entry) return

    const { width, height } = entry.contentRect
    if (width === 0 || height === 0) return

    if (debounceMs > 0) {
      // Debounced resize
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
      debounceTimerRef.current = setTimeout(() => {
        updateDimensions(width, height)
      }, debounceMs)
    } else {
      // Immediate resize
      updateDimensions(width, height)
    }
  }, [updateDimensions, debounceMs])

  /**
   * Get canvas 2D context (memoized)
   */
  const getContext = useCallback(() => {
    if (ctxRef.current) return ctxRef.current

    const canvas = canvasRef.current
    if (!canvas) return null

    ctxRef.current = canvas.getContext('2d')
    return ctxRef.current
  }, [])

  /**
   * Clear the canvas
   */
  const clearCanvas = useCallback((fillColor = null) => {
    const ctx = getContext()
    const canvas = canvasRef.current
    if (!ctx || !canvas) return

    if (fillColor) {
      ctx.fillStyle = fillColor
      ctx.fillRect(0, 0, dimensions.width, dimensions.height)
    } else {
      ctx.clearRect(0, 0, dimensions.width, dimensions.height)
    }
  }, [getContext, dimensions])

  // Setup ResizeObserver
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(container)

    // Initial size
    const { clientWidth, clientHeight } = container
    if (clientWidth > 0 && clientHeight > 0) {
      updateDimensions(clientWidth, clientHeight)
    }

    return () => {
      resizeObserver.disconnect()
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
      ctxRef.current = null
    }
  }, [handleResize, updateDimensions])

  return {
    canvasRef,
    containerRef,
    dimensions,
    ctx: getContext(),
    getContext,
    clearCanvas,
    updateDimensions
  }
}

/**
 * useResponsiveCanvasSimple - Simplified version without container ref
 *
 * For cases where the canvas itself is observed (parent element)
 *
 * @param {Object} options - Same as useResponsiveCanvas
 * @returns {Object} Canvas ref, dimensions
 *
 * @example
 * const { canvasRef, dimensions } = useResponsiveCanvasSimple()
 *
 * return (
 *   <div style={{ width: '100%', height: '100%' }}>
 *     <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} />
 *   </div>
 * )
 */
export function useResponsiveCanvasSimple(options = {}) {
  const {
    maintainAspectRatio = false,
    minWidth = 100,
    minHeight = 100
  } = options

  const canvasRef = useRef(null)
  const dimensionsRef = useRef({ width: 400, height: 400 })
  const [dimensions, setDimensions] = useState({ width: 400, height: 400 })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const parent = canvas.parentElement
    if (!parent) return

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        let { width, height } = entry.contentRect
        if (width === 0 || height === 0) continue

        // Apply minimum sizes
        width = Math.max(minWidth, width)
        height = Math.max(minHeight, height)

        // Maintain aspect ratio if requested
        if (maintainAspectRatio) {
          const size = Math.min(width, height)
          width = size
          height = size
        }

        // Update canvas dimensions
        canvas.width = width
        canvas.height = height
        dimensionsRef.current = { width, height }
        setDimensions({ width, height })
      }
    })

    resizeObserver.observe(parent)

    // Initial size
    const { clientWidth, clientHeight } = parent
    if (clientWidth > 0 && clientHeight > 0) {
      let width = Math.max(minWidth, clientWidth)
      let height = Math.max(minHeight, clientHeight)

      if (maintainAspectRatio) {
        const size = Math.min(width, height)
        width = size
        height = size
      }

      canvas.width = width
      canvas.height = height
      dimensionsRef.current = { width, height }
      setDimensions({ width, height })
    }

    return () => resizeObserver.disconnect()
  }, [maintainAspectRatio, minWidth, minHeight])

  return {
    canvasRef,
    dimensions,
    dimensionsRef
  }
}

export default useResponsiveCanvas
