import { useState, useRef, useCallback, useEffect } from 'react'
import { getAudioAverage, getAudioEnergy } from './BaseVisualizer'

/**
 * Audio analysis features structure
 * Matches the ai-visualizer AudioAnalysis class features
 */
const DEFAULT_FEATURES = {
  rms: 0,           // Root mean square (volume)
  zcr: 0,           // Zero crossing rate (texture)
  spectralCentroid: 0,  // Pitch estimation
  mfcc: new Array(13).fill(0),  // Mel-frequency cepstral coefficients
  energy: 0         // Overall energy level
}

/**
 * Custom hook for audio reactivity in visualizers
 * Provides audio data and analysis features for visualization
 *
 * @param {Object} options - Configuration options
 * @param {boolean} options.enabled - Whether audio analysis is enabled
 * @param {boolean} options.simulationMode - Use simulated audio data
 * @param {number} options.fftSize - FFT size for frequency analysis (default: 256)
 * @returns {Object} Audio analysis state and controls
 *
 * @example
 * const { audioData, features, isActive, enableMicrophone } = useAudioAnalysis({
 *   enabled: true,
 *   simulationMode: false
 * })
 */
export function useAudioAnalysis(options = {}) {
  const {
    enabled = false,
    simulationMode = false,
    fftSize = 256
  } = options

  const [isActive, setIsActive] = useState(false)
  const [error, setError] = useState(null)
  const [features, setFeatures] = useState(DEFAULT_FEATURES)

  const audioContextRef = useRef(null)
  const analyserRef = useRef(null)
  const dataArrayRef = useRef(null)
  const sourceRef = useRef(null)
  const streamRef = useRef(null)
  const simulationTimerRef = useRef(null)
  const frameRef = useRef(null)

  /**
   * Initialize microphone audio input
   */
  const enableMicrophone = useCallback(async () => {
    try {
      setError(null)

      // Create audio context
      const AudioContext = window.AudioContext || window.webkitAudioContext
      audioContextRef.current = new AudioContext()

      // Get microphone stream
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      // Create source and analyser
      sourceRef.current = audioContextRef.current.createMediaStreamSource(stream)
      analyserRef.current = audioContextRef.current.createAnalyser()
      analyserRef.current.fftSize = fftSize

      sourceRef.current.connect(analyserRef.current)

      // Create data array for frequency data
      const bufferLength = analyserRef.current.frequencyBinCount
      dataArrayRef.current = new Uint8Array(bufferLength)

      setIsActive(true)
      return true
    } catch (err) {
      console.error('Audio init failed:', err)
      setError(err.message || 'Could not access microphone')
      return false
    }
  }, [fftSize])

  /**
   * Disable audio input and cleanup
   */
  const disableAudio = useCallback(() => {
    // Stop animation frame
    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }

    // Stop simulation
    if (simulationTimerRef.current) {
      clearInterval(simulationTimerRef.current)
      simulationTimerRef.current = null
    }

    // Cleanup audio resources
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop())
      streamRef.current = null
    }

    if (audioContextRef.current) {
      audioContextRef.current.close()
      audioContextRef.current = null
    }

    analyserRef.current = null
    sourceRef.current = null
    dataArrayRef.current = null

    setIsActive(false)
    setFeatures(DEFAULT_FEATURES)
  }, [])

  /**
   * Start simulation mode with fake audio data
   */
  const startSimulation = useCallback(() => {
    if (simulationTimerRef.current) return

    // Create fake data array
    dataArrayRef.current = new Uint8Array(128).fill(0)
    setIsActive(true)

    // Update simulation every frame
    const updateSimulation = () => {
      const t = Date.now() / 1000

      // Generate "breathing" audio data
      const baseLevel = 50 + Math.sin(t) * 30
      dataArrayRef.current = dataArrayRef.current.map((_, i) => {
        return Math.max(0, Math.min(255,
          baseLevel + Math.sin(t * 2 + i * 0.1) * 20 + Math.random() * 10
        ))
      })

      // Generate fake features
      setFeatures({
        rms: 0.1 + Math.abs(Math.sin(t)) * 0.4,
        zcr: 0.5 + Math.random() * 0.5,
        spectralCentroid: 100 + Math.sin(t * 2) * 50,
        mfcc: new Array(13).fill(0).map((_, i) => Math.sin(t * (i + 1) + i) * 10),
        energy: 0.1 + Math.abs(Math.sin(t)) * 0.4
      })

      frameRef.current = requestAnimationFrame(updateSimulation)
    }

    frameRef.current = requestAnimationFrame(updateSimulation)
  }, [])

  /**
   * Stop simulation mode
   */
  const stopSimulation = useCallback(() => {
    if (frameRef.current) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    dataArrayRef.current = null
    setIsActive(false)
    setFeatures(DEFAULT_FEATURES)
  }, [])

  /**
   * Get current audio data array
   */
  const getAudioData = useCallback(() => {
    if (analyserRef.current && dataArrayRef.current) {
      analyserRef.current.getByteFrequencyData(dataArrayRef.current)
    }
    return dataArrayRef.current
  }, [])

  /**
   * Get computed audio metrics
   */
  const getMetrics = useCallback(() => {
    const audioData = getAudioData()
    if (!audioData) return { average: 0, energy: 0 }

    return {
      average: getAudioAverage(audioData),
      energy: getAudioEnergy(audioData)
    }
  }, [getAudioData])

  // Handle enabled state changes
  useEffect(() => {
    if (enabled && simulationMode) {
      startSimulation()
    } else if (!enabled) {
      disableAudio()
      stopSimulation()
    }

    return () => {
      disableAudio()
      stopSimulation()
    }
  }, [enabled, simulationMode, startSimulation, stopSimulation, disableAudio])

  return {
    // State
    isActive,
    error,
    features,

    // Data access
    audioData: dataArrayRef.current,
    getAudioData,
    getMetrics,

    // Controls
    enableMicrophone,
    disableAudio,
    startSimulation,
    stopSimulation
  }
}

/**
 * Simplified hook for external audio data
 * Use when audio data is passed as props (from parent component)
 *
 * @param {Uint8Array|number[]} audioData - External audio data
 * @returns {Object} Computed audio metrics
 */
export function useExternalAudio(audioData) {
  const average = audioData ? getAudioAverage(audioData) : 0
  const energy = audioData ? getAudioEnergy(audioData) : 0

  return {
    average,
    energy,
    hasAudio: audioData && audioData.length > 0
  }
}

export default useAudioAnalysis
