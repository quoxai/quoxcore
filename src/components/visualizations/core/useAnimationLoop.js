import { useRef, useEffect, useCallback } from 'react'

/**
 * Custom hook for requestAnimationFrame-based animation loops
 * Provides consistent delta time and frame counting
 *
 * @param {function} callback - Animation callback (deltaTime, frameCount) => void
 * @param {boolean} running - Whether the animation should be running
 * @param {Array} deps - Additional dependencies for the callback
 * @returns {object} Animation controls { pause, resume, isRunning }
 *
 * @example
 * const { isRunning } = useAnimationLoop(
 *   (dt, frame) => {
 *     ctx.clearRect(0, 0, width, height)
 *     // Draw animation frame
 *   },
 *   true, // running
 *   [state, audioData]
 * )
 */
export function useAnimationLoop(callback, running = true, deps = []) {
  const animationRef = useRef(null)
  const lastTimeRef = useRef(null)
  const frameCountRef = useRef(0)
  const isPausedRef = useRef(!running)
  const callbackRef = useRef(callback)

  // Keep callback ref updated
  useEffect(() => {
    callbackRef.current = callback
  }, [callback])

  const animate = useCallback((timestamp) => {
    if (isPausedRef.current) {
      animationRef.current = null
      return
    }

    // Calculate delta time
    if (lastTimeRef.current === null) {
      lastTimeRef.current = timestamp
    }
    const deltaTime = (timestamp - lastTimeRef.current) / 1000 // Convert to seconds
    lastTimeRef.current = timestamp

    // Increment frame count
    frameCountRef.current++

    // Call the animation callback
    if (callbackRef.current) {
      callbackRef.current(deltaTime, frameCountRef.current)
    }

    // Schedule next frame
    animationRef.current = requestAnimationFrame(animate)
  }, [])

  const pause = useCallback(() => {
    isPausedRef.current = true
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current)
      animationRef.current = null
    }
  }, [])

  const resume = useCallback(() => {
    isPausedRef.current = false
    lastTimeRef.current = null // Reset timing
    if (!animationRef.current) {
      animationRef.current = requestAnimationFrame(animate)
    }
  }, [animate])

  const reset = useCallback(() => {
    frameCountRef.current = 0
    lastTimeRef.current = null
  }, [])

  // Handle running state changes
  useEffect(() => {
    if (running) {
      resume()
    } else {
      pause()
    }
  }, [running, resume, pause])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [])

  // Restart animation when dependencies change
  useEffect(() => {
    if (running && !isPausedRef.current) {
      // Restart the loop to pick up new deps
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
      lastTimeRef.current = null
      animationRef.current = requestAnimationFrame(animate)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return {
    pause,
    resume,
    reset,
    isRunning: !isPausedRef.current,
    frameCount: frameCountRef.current
  }
}

/**
 * Simplified animation hook that manages canvas context
 *
 * @param {RefObject} canvasRef - React ref to canvas element
 * @param {function} drawCallback - Draw function (ctx, dt, frame, dimensions) => void
 * @param {boolean} running - Whether animation is running
 * @param {Array} deps - Additional dependencies
 * @returns {object} Animation controls and dimensions
 *
 * @example
 * const canvasRef = useRef(null)
 * const { dimensions } = useCanvasAnimation(
 *   canvasRef,
 *   (ctx, dt, frame, { width, height }) => {
 *     ctx.clearRect(0, 0, width, height)
 *     ctx.fillStyle = 'red'
 *     ctx.fillRect(0, 0, 100, 100)
 *   },
 *   true,
 *   [state]
 * )
 */
export function useCanvasAnimation(canvasRef, drawCallback, running = true, deps = []) {
  const dimensionsRef = useRef({ width: 400, height: 400 })

  const animationCallback = useCallback((dt, frame) => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Update dimensions if canvas size changed
    if (canvas.width !== dimensionsRef.current.width ||
        canvas.height !== dimensionsRef.current.height) {
      dimensionsRef.current = { width: canvas.width, height: canvas.height }
    }

    drawCallback(ctx, dt, frame, dimensionsRef.current)
  }, [canvasRef, drawCallback])

  const controls = useAnimationLoop(animationCallback, running, deps)

  return {
    ...controls,
    dimensions: dimensionsRef.current
  }
}

export default useAnimationLoop
