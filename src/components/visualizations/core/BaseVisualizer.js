// BaseVisualizer - Core utilities for all visualizers
// Ported from ai-visualizer/js/visualizers/base.js

/**
 * BaseVisualizer class for canvas-based visualizers to extend
 */
export class BaseVisualizerClass {
  constructor(canvas) {
    this.canvas = canvas
    this.ctx = canvas?.getContext('2d')
    this.width = canvas?.width || 0
    this.height = canvas?.height || 0
    this.animationId = null
    this.isRunning = false
  }

  init() {
    if (this.canvas) {
      this.width = this.canvas.width
      this.height = this.canvas.height
    }
  }

  start() {
    if (this.isRunning) return
    this.isRunning = true
    this.animate()
  }

  stop() {
    this.isRunning = false
    if (this.animationId) {
      cancelAnimationFrame(this.animationId)
      this.animationId = null
    }
  }

  animate() {
    if (!this.isRunning) return
    this.draw()
    this.animationId = requestAnimationFrame(() => this.animate())
  }

  draw() {
    // Override in subclass
  }

  resize(width, height) {
    this.width = width
    this.height = height
    if (this.canvas) {
      this.canvas.width = width
      this.canvas.height = height
    }
  }

  clear() {
    if (this.ctx) {
      this.ctx.clearRect(0, 0, this.width, this.height)
    }
  }
}

/**
 * Default configuration for visualizers
 *
 * NEW: Per-state settings structure
 * Each state now has its own speed, scale, sensitivity, and hue values
 */
export const DEFAULT_CONFIG = {
  state: 'idle', // idle, listening, speaking, thinking, error
  // Per-state settings - each state can have different values
  stateSettings: {
    idle: {
      speed: 0.3,
      scale: 1.0,
      sensitivity: 0.5,
      hue: 200  // Blue
    },
    listening: {
      speed: 0.5,
      scale: 1.1,
      sensitivity: 0.7,
      hue: 160  // Cyan/Green
    },
    speaking: {
      speed: 0.8,
      scale: 1.2,
      sensitivity: 0.9,
      hue: 0    // Red
    },
    thinking: {
      speed: 1.2,
      scale: 1.0,
      sensitivity: 0.6,
      hue: 280  // Purple
    },
    error: {
      speed: 0.5,
      scale: 1.0,
      sensitivity: 0.5,
      hue: 0    // Red
    }
  },
  // Legacy compatibility - these are used if stateSettings is not present
  sensitivity: 0.5,
  speed: 0.5,
  scale: 1.0,
  stateColors: {
    idle: 200,
    listening: 160,
    speaking: 0,
    thinking: 280,
    error: 0
  }
}

/**
 * State color definitions matching HALVisualizer pattern
 * Uses RGB format for React components
 */
export const STATE_COLORS = {
  idle: { primary: '#3090ff', secondary: '#60a0ff', glow: 'rgba(48, 144, 255, 0.4)', hue: 200 },
  listening: { primary: '#30ff90', secondary: '#60ffb0', glow: 'rgba(48, 255, 144, 0.4)', hue: 160 },
  speaking: { primary: '#38bdf8', secondary: '#ff6060', glow: 'rgba(255, 48, 48, 0.4)', hue: 0 },
  thinking: { primary: '#9d4edd', secondary: '#b06eff', glow: 'rgba(157, 78, 221, 0.4)', hue: 280 },
  error: { primary: '#38bdf8', secondary: '#38bdf8', glow: 'rgba(255, 0, 0, 0.6)', hue: 0 }
}

/**
 * Get the primary color for a given state using HSL format
 * @param {string} state - Current state (idle, listening, speaking, thinking, error)
 * @param {number} alpha - Alpha value 0-1
 * @param {object} customColors - Optional custom stateColors hue map
 * @returns {string} HSLA color string
 */
export function getPrimaryColor(state = 'idle', alpha = 1, customColors = null) {
  const colors = customColors || DEFAULT_CONFIG.stateColors
  const hue = colors[state] ?? colors.idle ?? 200
  return `hsla(${hue}, 100%, 50%, ${alpha})`
}

/**
 * Get RGB state colors for a given state
 * @param {string} state - Current state
 * @returns {object} Color object with primary, secondary, glow
 */
export function getStateColors(state = 'idle') {
  return STATE_COLORS[state] || STATE_COLORS.idle
}

/**
 * Calculate average value from audio data array
 * @param {Uint8Array|number[]} audioData - Audio frequency data
 * @returns {number} Average value 0-255
 */
export function getAudioAverage(audioData) {
  if (!audioData || audioData.length === 0) return 0
  let sum = 0
  for (let i = 0; i < audioData.length; i++) {
    sum += audioData[i]
  }
  return sum / audioData.length
}

/**
 * Get normalized audio energy (0-1)
 * @param {Uint8Array|number[]} audioData - Audio frequency data
 * @returns {number} Normalized energy 0-1
 */
export function getAudioEnergy(audioData) {
  return getAudioAverage(audioData) / 255
}

/**
 * Calculate intensity based on audio or fallback animation
 * @param {Uint8Array|number[]} audioData - Audio frequency data
 * @param {number} pulsePhase - Current pulse phase for animation
 * @returns {number} Intensity value 0-1
 */
export function calculateIntensity(audioData, pulsePhase = 0) {
  if (audioData && audioData.length > 0) {
    const avg = getAudioAverage(audioData)
    return Math.min(1, avg / 128)
  }
  // Default pulsing animation
  return 0.5 + Math.sin(pulsePhase) * 0.2
}

/**
 * Merge config with defaults
 * @param {object} config - Partial config to merge
 * @returns {object} Complete config with defaults
 */
export function mergeConfig(config = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    stateColors: {
      ...DEFAULT_CONFIG.stateColors,
      ...(config.stateColors || {})
    }
  }
}

/**
 * Convert hex color to HSL hue
 * @param {string} hex - Hex color string
 * @returns {number} Hue value 0-360
 */
export function hexToHue(hex) {
  // Remove # if present
  hex = hex.replace('#', '')

  const r = parseInt(hex.substr(0, 2), 16) / 255
  const g = parseInt(hex.substr(2, 2), 16) / 255
  const b = parseInt(hex.substr(4, 2), 16) / 255

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let h = 0

  if (max !== min) {
    const d = max - min
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break
      case g: h = ((b - r) / d + 2) / 6; break
      case b: h = ((r - g) / d + 4) / 6; break
    }
  }

  return Math.round(h * 360)
}

/**
 * Create state colors from a base hue
 * @param {number} baseHue - Base hue value 0-360
 * @returns {object} State colors map
 */
export function createStateColorsFromHue(baseHue) {
  return {
    idle: baseHue,
    listening: baseHue,
    speaking: baseHue,
    thinking: (baseHue + 180) % 360,  // Complementary color for thinking
    error: 0  // Red for error state
  }
}

/**
 * Create full state settings from a base hue
 * @param {number} baseHue - Base hue value 0-360
 * @returns {object} State settings map with all properties
 */
export function createStateSettingsFromHue(baseHue) {
  return {
    idle: { speed: 0.3, scale: 1.0, sensitivity: 0.5, hue: baseHue },
    listening: { speed: 0.5, scale: 1.1, sensitivity: 0.7, hue: baseHue },
    speaking: { speed: 0.8, scale: 1.2, sensitivity: 0.9, hue: baseHue },
    thinking: { speed: 1.2, scale: 1.0, sensitivity: 0.6, hue: (baseHue + 180) % 360 },
    error: { speed: 0.5, scale: 1.0, sensitivity: 0.5, hue: 0 }
  }
}

/**
 * Get effective config values for a given state
 * Supports both new stateSettings and legacy flat config
 *
 * @param {object} config - Full config object
 * @param {string} state - Current state (idle, listening, speaking, thinking, error)
 * @returns {object} Effective config { speed, scale, sensitivity, hue }
 */
export function getStateConfig(config, state = 'idle') {
  // Use stateSettings if available (new format)
  if (config?.stateSettings?.[state]) {
    return {
      speed: config.stateSettings[state].speed ?? 0.5,
      scale: config.stateSettings[state].scale ?? 1.0,
      sensitivity: config.stateSettings[state].sensitivity ?? 0.5,
      hue: config.stateSettings[state].hue ?? 200
    }
  }

  // Fall back to legacy format
  return {
    speed: config?.speed ?? 0.5,
    scale: config?.scale ?? 1.0,
    sensitivity: config?.sensitivity ?? 0.5,
    hue: config?.stateColors?.[state] ?? 200
  }
}

export default {
  DEFAULT_CONFIG,
  STATE_COLORS,
  getPrimaryColor,
  getStateColors,
  getAudioAverage,
  getAudioEnergy,
  calculateIntensity,
  mergeConfig,
  hexToHue,
  createStateColorsFromHue,
  createStateSettingsFromHue,
  getStateConfig
}
