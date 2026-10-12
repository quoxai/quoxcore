/**
 * Personality Utilities (AUX-3)
 *
 * Tone/style presets and prompt generation from personality settings.
 * Used by PersonalityTab to generate the personality injection for system prompts.
 */

export const TONE_PRESETS = {
  professional: { label: 'Professional', prompt: 'Maintain a professional, business-appropriate tone.' },
  casual: { label: 'Casual', prompt: 'Use a casual, relaxed conversational tone.' },
  friendly: { label: 'Friendly', prompt: 'Be warm, friendly, and approachable.' },
  formal: { label: 'Formal', prompt: 'Use formal language with proper grammar and structure.' },
  technical: { label: 'Technical', prompt: 'Use precise technical language appropriate for expert audiences.' },
  playful: { label: 'Playful', prompt: 'Be lighthearted and playful, using humour where appropriate.' },
  empathetic: { label: 'Empathetic', prompt: 'Be understanding and empathetic, acknowledging the user\'s feelings.' },
  authoritative: { label: 'Authoritative', prompt: 'Speak with authority and confidence, projecting expertise.' },
}

export const STYLE_PRESETS = {
  concise: { label: 'Concise', prompt: 'Keep responses brief and to the point. Avoid unnecessary detail.' },
  detailed: { label: 'Detailed', prompt: 'Provide thorough, detailed explanations with context and examples.' },
  conversational: { label: 'Conversational', prompt: 'Respond in a natural, conversational style as if chatting with a colleague.' },
  instructional: { label: 'Instructional', prompt: 'Structure responses as clear step-by-step instructions when applicable.' },
}

export const AVAILABLE_TRAITS = [
  'empathetic', 'direct', 'curious', 'precise', 'warm', 'analytical',
  'witty', 'patient', 'proactive', 'methodical', 'creative', 'assertive',
  'diplomatic', 'resourceful', 'systematic', 'encouraging'
]

/**
 * Generate a personality prompt fragment from settings.
 * This text gets injected into the system prompt's personality layer.
 *
 * @param {Object} personality - { tone, style, traits, catchphrases }
 * @returns {string} Natural language personality description for the LLM
 */
export function generatePersonalityPrompt(personality = {}) {
  const parts = []

  // Tone
  if (personality.tone) {
    const preset = TONE_PRESETS[personality.tone]
    if (preset) {
      parts.push(preset.prompt)
    } else if (typeof personality.tone === 'string' && personality.tone.length > 0) {
      // Custom tone text (not a preset key)
      parts.push(`Tone: ${personality.tone}.`)
    }
  }

  // Style
  if (personality.style) {
    const preset = STYLE_PRESETS[personality.style]
    if (preset) {
      parts.push(preset.prompt)
    } else if (typeof personality.style === 'string' && personality.style.length > 0) {
      parts.push(`Style: ${personality.style}.`)
    }
  }

  // Traits
  if (Array.isArray(personality.traits) && personality.traits.length > 0) {
    parts.push(`Key traits: ${personality.traits.join(', ')}.`)
  }

  // Catchphrases
  if (Array.isArray(personality.catchphrases) && personality.catchphrases.length > 0) {
    parts.push(`Signature phrases: "${personality.catchphrases.join('", "')}"`)
  }

  return parts.join(' ')
}

/**
 * Estimate token count for a text string (rough approximation).
 * Uses the ~4 characters per token heuristic for English text.
 */
export function estimateTokens(text) {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}
