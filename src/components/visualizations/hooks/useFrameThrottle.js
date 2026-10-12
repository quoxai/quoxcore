import { useRef, useCallback, useMemo } from 'react'

/**
 * useFrameThrottle - Hook for frame rate throttling in animations
 *
 * Provides utilities to limit animation frame rate for performance optimization.
 * Useful for reducing CPU/GPU load on canvas visualizers.
 *
 * @param {number} targetFPS - Target frames per second (default: 60)
 * @returns {Object} Throttling utilities
 *
 * @example
 * const { shouldRender, lastFrameTime, getFrameInterval } = useFrameThrottle(30)
 *
 * useEffect(() => {
 *   const animate = (timestamp) => {
 *     if (shouldRender(timestamp)) {
 *       // Render frame
 *       ctx.clearRect(0, 0, width, height)
 *       draw()
 *     }
 *     requestAnimationFrame(animate)
 *   }
 *   requestAnimationFrame(animate)
 * }, [])
 */
export function useFrameThrottle(targetFPS = 60) {
  const lastFrameTimeRef = useRef(0)
  const frameCountRef = useRef(0)
  const actualFPSRef = useRef(targetFPS)
  const fpsUpdateTimeRef = useRef(0)

  // Calculate frame interval in milliseconds
  const frameInterval = useMemo(() => 1000 / targetFPS, [targetFPS])

  /**
   * Check if we should render this frame based on target FPS
   * @param {number} timestamp - Current timestamp from requestAnimationFrame
   * @returns {boolean} Whether to render this frame
   */
  const shouldRender = useCallback((timestamp) => {
    const elapsed = timestamp - lastFrameTimeRef.current

    if (elapsed >= frameInterval) {
      // Update last frame time, accounting for drift
      lastFrameTimeRef.current = timestamp - (elapsed % frameInterval)

      // Update FPS counter
      frameCountRef.current++
      if (timestamp - fpsUpdateTimeRef.current >= 1000) {
        actualFPSRef.current = frameCountRef.current
        frameCountRef.current = 0
        fpsUpdateTimeRef.current = timestamp
      }

      return true
    }

    return false
  }, [frameInterval])

  /**
   * Get time since last frame in seconds
   * @param {number} timestamp - Current timestamp
   * @returns {number} Delta time in seconds
   */
  const getDeltaTime = useCallback((timestamp) => {
    return (timestamp - lastFrameTimeRef.current) / 1000
  }, [])

  /**
   * Reset the frame timer
   */
  const reset = useCallback(() => {
    lastFrameTimeRef.current = 0
    frameCountRef.current = 0
    fpsUpdateTimeRef.current = 0
  }, [])

  return {
    shouldRender,
    getDeltaTime,
    reset,
    frameInterval,
    targetFPS,
    getActualFPS: () => actualFPSRef.current,
    lastFrameTime: lastFrameTimeRef.current
  }
}

/**
 * useAdaptiveFrameRate - Hook that adapts frame rate based on performance
 *
 * Automatically reduces frame rate if the browser is struggling,
 * and increases it when performance improves.
 *
 * @param {Object} options - Configuration
 * @param {number} options.maxFPS - Maximum FPS (default: 60)
 * @param {number} options.minFPS - Minimum FPS (default: 15)
 * @param {number} options.targetFrameTime - Target frame time in ms (default: 16)
 * @returns {Object} Adaptive frame rate utilities
 *
 * @example
 * const { shouldRender, currentFPS } = useAdaptiveFrameRate({ maxFPS: 60, minFPS: 20 })
 */
export function useAdaptiveFrameRate(options = {}) {
  const {
    maxFPS = 60,
    minFPS = 15,
    targetFrameTime = 16 // ~60fps
  } = options

  const currentFPSRef = useRef(maxFPS)
  const frameTimesRef = useRef([])
  const lastFrameTimeRef = useRef(0)
  const adaptationCooldownRef = useRef(0)

  const shouldRender = useCallback((timestamp) => {
    const elapsed = timestamp - lastFrameTimeRef.current
    const currentInterval = 1000 / currentFPSRef.current

    if (elapsed < currentInterval) {
      return false
    }

    // Record frame time for adaptation
    const frameTime = elapsed
    frameTimesRef.current.push(frameTime)

    // Keep last 30 frames for averaging
    if (frameTimesRef.current.length > 30) {
      frameTimesRef.current.shift()
    }

    // Adapt every 60 frames
    if (frameTimesRef.current.length >= 30 && adaptationCooldownRef.current <= 0) {
      const avgFrameTime = frameTimesRef.current.reduce((a, b) => a + b, 0) / frameTimesRef.current.length

      if (avgFrameTime > targetFrameTime * 1.5) {
        // Performance struggling - reduce FPS
        currentFPSRef.current = Math.max(minFPS, currentFPSRef.current - 5)
        adaptationCooldownRef.current = 60
      } else if (avgFrameTime < targetFrameTime * 0.8 && currentFPSRef.current < maxFPS) {
        // Performance good - increase FPS
        currentFPSRef.current = Math.min(maxFPS, currentFPSRef.current + 5)
        adaptationCooldownRef.current = 60
      }
    }

    adaptationCooldownRef.current--
    lastFrameTimeRef.current = timestamp

    return true
  }, [maxFPS, minFPS, targetFrameTime])

  return {
    shouldRender,
    getCurrentFPS: () => currentFPSRef.current,
    reset: () => {
      currentFPSRef.current = maxFPS
      frameTimesRef.current = []
      lastFrameTimeRef.current = 0
      adaptationCooldownRef.current = 0
    }
  }
}

/**
 * useShadowOptimization - Hook for optimizing expensive shadow effects
 *
 * Reduces shadow quality during animation for performance,
 * restoring quality when animation stops.
 *
 * @param {Object} options - Configuration
 * @param {number} options.maxBlur - Maximum shadow blur during idle (default: 20)
 * @param {number} options.animatingBlur - Shadow blur during animation (default: 5)
 * @param {number} options.idleTimeout - Time to wait before restoring quality (default: 500ms)
 * @returns {Object} Shadow optimization utilities
 *
 * @example
 * const { getShadowBlur, markAnimating } = useShadowOptimization()
 *
 * // In animation loop:
 * markAnimating()
 * ctx.shadowBlur = getShadowBlur() * baseBlur
 */
export function useShadowOptimization(options = {}) {
  const {
    maxBlur = 20,
    animatingBlur = 5,
    idleTimeout = 500
  } = options

  const isAnimatingRef = useRef(false)
  const lastActivityRef = useRef(0)
  const currentBlurRef = useRef(maxBlur)

  const markAnimating = useCallback(() => {
    isAnimatingRef.current = true
    lastActivityRef.current = Date.now()
    currentBlurRef.current = animatingBlur
  }, [animatingBlur])

  const getShadowBlur = useCallback(() => {
    const timeSinceActivity = Date.now() - lastActivityRef.current

    if (timeSinceActivity > idleTimeout) {
      isAnimatingRef.current = false
      // Gradually restore shadow quality
      const progress = Math.min(1, (timeSinceActivity - idleTimeout) / 500)
      currentBlurRef.current = animatingBlur + (maxBlur - animatingBlur) * progress
    }

    return currentBlurRef.current
  }, [maxBlur, animatingBlur, idleTimeout])

  return {
    getShadowBlur,
    markAnimating,
    isAnimating: () => isAnimatingRef.current
  }
}

export default useFrameThrottle
