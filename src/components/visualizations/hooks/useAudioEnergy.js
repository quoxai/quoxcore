import { useMemo } from 'react'

/**
 * useAudioEnergy - Reusable hook for audio energy calculation
 *
 * Extracts and memoizes audio energy metrics from raw frequency data.
 * This consolidates the duplicated audio processing logic found across
 * multiple visualizers (FluidVisualizer, HoloFieldVisualizer, NexusVisualizer, etc.)
 *
 * @param {Uint8Array|number[]|null} audioData - Raw audio frequency data (0-255 values)
 * @param {number} sensitivity - Audio sensitivity multiplier (default: 1.0)
 * @returns {Object} Audio energy metrics
 *
 * @example
 * const { energy, average, rms, zcr, hasAudio } = useAudioEnergy(audioData, stateConfig.sensitivity)
 *
 * // Use energy for visualization intensity
 * const particleSize = baseSize * (1 + energy * 0.5)
 */
export function useAudioEnergy(audioData, sensitivity = 1) {
  return useMemo(() => {
    // No audio data case
    if (!audioData || audioData.length === 0) {
      return {
        energy: 0,
        average: 0,
        rms: 0,
        zcr: 0,
        hasAudio: false,
        // Normalized values (0-1 range)
        normalizedEnergy: 0,
        normalizedAverage: 0
      }
    }

    const len = audioData.length
    let sum = 0
    let sumSquares = 0
    let zeroCrossings = 0

    // Single pass through data for efficiency
    for (let i = 0; i < len; i++) {
      const value = audioData[i]
      sum += value

      // RMS calculation (centered around 128)
      const centered = value - 128
      sumSquares += centered * centered

      // Zero crossing rate (for texture/frequency estimation)
      if (i > 0 && ((audioData[i] >= 128) !== (audioData[i - 1] >= 128))) {
        zeroCrossings++
      }
    }

    // Raw average (0-255)
    const average = sum / len

    // Normalized average (0-1)
    const normalizedAverage = average / 255

    // RMS energy (0-1)
    const rms = Math.sqrt(sumSquares / len) / 128

    // Zero crossing rate (0-1)
    const zcr = zeroCrossings / len

    // Combined energy metric with sensitivity
    // Uses normalized average as the primary energy source
    const energy = normalizedAverage * sensitivity

    return {
      energy,
      average,
      rms: rms * sensitivity,
      zcr,
      hasAudio: true,
      normalizedEnergy: Math.min(1, energy),
      normalizedAverage
    }
  }, [audioData, sensitivity])
}

/**
 * useAudioBands - Hook for frequency band analysis
 *
 * Splits audio data into frequency bands for more nuanced visualization
 *
 * @param {Uint8Array|number[]|null} audioData - Raw audio frequency data
 * @param {number} numBands - Number of frequency bands (default: 4)
 * @param {number} sensitivity - Audio sensitivity multiplier (default: 1.0)
 * @returns {Object} Band energies and overall metrics
 *
 * @example
 * const { bands, bass, mid, treble } = useAudioBands(audioData, 4, sensitivity)
 * // bands = [0.2, 0.5, 0.3, 0.1] - energy per band
 */
export function useAudioBands(audioData, numBands = 4, sensitivity = 1) {
  return useMemo(() => {
    if (!audioData || audioData.length === 0) {
      return {
        bands: new Array(numBands).fill(0),
        bass: 0,
        mid: 0,
        treble: 0,
        hasAudio: false
      }
    }

    const len = audioData.length
    const bandSize = Math.floor(len / numBands)
    const bands = []

    for (let band = 0; band < numBands; band++) {
      const startIdx = band * bandSize
      const endIdx = Math.min(startIdx + bandSize, len)

      let bandSum = 0
      for (let i = startIdx; i < endIdx; i++) {
        bandSum += audioData[i]
      }

      // Normalize to 0-1 and apply sensitivity
      bands.push((bandSum / (endIdx - startIdx) / 255) * sensitivity)
    }

    // Named frequency ranges (assuming standard FFT layout)
    return {
      bands,
      bass: bands[0] || 0,           // Low frequencies
      mid: bands[Math.floor(numBands / 2)] || 0,  // Mid frequencies
      treble: bands[numBands - 1] || 0,  // High frequencies
      hasAudio: true
    }
  }, [audioData, numBands, sensitivity])
}

/**
 * useAudioMFCC - Hook for MFCC-like feature extraction
 *
 * Approximates Mel-Frequency Cepstral Coefficients for speech/audio analysis.
 * Used by HoloFieldVisualizer for spectral analysis.
 *
 * @param {Uint8Array|number[]|null} audioData - Raw audio frequency data
 * @param {number} numCoeffs - Number of MFCC coefficients (default: 13)
 * @param {number} sensitivity - Audio sensitivity multiplier (default: 1.0)
 * @returns {Object} MFCC coefficients and overall energy
 *
 * @example
 * const { mfcc, energy } = useAudioMFCC(audioData, 13, sensitivity)
 */
export function useAudioMFCC(audioData, numCoeffs = 13, sensitivity = 1) {
  return useMemo(() => {
    if (!audioData || audioData.length === 0) {
      return {
        mfcc: new Array(numCoeffs).fill(0),
        energy: 0,
        hasAudio: false
      }
    }

    const len = audioData.length
    const bandSize = Math.floor(len / numCoeffs)
    const mfcc = []
    let totalEnergy = 0

    for (let i = 0; i < numCoeffs; i++) {
      const startIdx = i * bandSize
      const endIdx = Math.min(startIdx + bandSize, len)

      let bandEnergy = 0
      for (let j = startIdx; j < endIdx; j++) {
        bandEnergy += Math.abs(audioData[j] - 128)
        totalEnergy += Math.abs(audioData[j] - 128)
      }

      // Normalize and apply sensitivity
      mfcc.push((bandEnergy / bandSize) * sensitivity * 0.5)
    }

    // RMS-style energy calculation
    const energy = (totalEnergy / len / 128) * sensitivity

    return {
      mfcc,
      energy,
      hasAudio: true
    }
  }, [audioData, numCoeffs, sensitivity])
}

export default useAudioEnergy
