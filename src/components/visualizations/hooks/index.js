/**
 * Visualization Hooks - Reusable hooks for visualizer components
 *
 * These hooks consolidate common patterns found across multiple visualizers,
 * reducing code duplication and ensuring consistent behavior.
 */

export {
  useAudioEnergy,
  useAudioBands,
  useAudioMFCC
} from './useAudioEnergy'

export {
  useResponsiveCanvas,
  useResponsiveCanvasSimple
} from './useResponsiveCanvas'

export {
  useFrameThrottle,
  useAdaptiveFrameRate,
  useShadowOptimization
} from './useFrameThrottle'
