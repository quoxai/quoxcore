/**
 * React Hooks for Voice Settings V2
 *
 * Features:
 * - Dynamic agent detection
 * - Grouped voice selector
 * - Legacy voice key migration
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import voiceSettings, {
  loadSettings,
  updateSettings,
  getAgentVoice,
  getTTSModel,
  buildTTSParams,
  getAllAgentIds,
  getVoicesByCategory,
  resolveVoiceKey,
  resolveAgentSynthetic,
  DEFAULT_VOICE_KEY,
  VOICE_LIBRARY,
  VOICE_CATEGORIES,
  TTS_MODELS,
  VERBOSITY_MODES,
} from '../services/voiceSettings.js';
import { preprocessForTTS } from '../services/ttsPreprocessor.js';

/**
 * Main hook for voice settings state
 */
export function useVoiceSettings() {
  const [settings, setSettings] = useState(() => loadSettings());

  // Reload settings when localStorage changes (for cross-tab sync)
  useEffect(() => {
    const handleStorage = (e) => {
      if (e.key === 'quox-voice-settings') {
        setSettings(loadSettings());
      }
    };

    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  // Update settings and persist
  const update = useCallback((updates) => {
    const newSettings = updateSettings(updates);
    setSettings(newSettings);
    return newSettings;
  }, []);

  // Toggle mute
  const toggleMute = useCallback(() => {
    const newSettings = update({ muted: !settings.muted });
    return newSettings.muted;
  }, [settings.muted, update]);

  // Set verbosity
  const setVerbosity = useCallback((verbosity) => {
    return update({ verbosity });
  }, [update]);

  // Set model
  const setModel = useCallback((model) => {
    return update({ model });
  }, [update]);

  // Set agent voice
  const setAgentVoice = useCallback((agentId, voiceKey) => {
    const resolvedKey = resolveVoiceKey(voiceKey);
    return update({
      agentVoices: {
        ...settings.agentVoices,
        [agentId]: resolvedKey,
      },
    });
  }, [settings.agentVoices, update]);

  // VOICE-P1: per-agent Synthetic (subtle robotic) playback effect
  const setAgentSynthetic = useCallback((agentId, enabled) => {
    return update({
      agentSynthetic: {
        ...(settings.agentSynthetic || {}),
        [agentId]: enabled === true,
      },
    });
  }, [settings.agentSynthetic, update]);

  // Reset to defaults
  const reset = useCallback(() => {
    const defaults = voiceSettings.resetSettings();
    setSettings(defaults);
    return defaults;
  }, []);

  return {
    settings,
    update,
    toggleMute,
    setVerbosity,
    setModel,
    setAgentVoice,
    setAgentSynthetic,
    reset,

    // Computed values
    isMuted: settings.muted,
    isEnabled: settings.enabled,
    verbosity: settings.verbosity,
    model: settings.model,

    // Constants
    VOICE_LIBRARY,
    VOICE_CATEGORIES,
    TTS_MODELS,
    VERBOSITY_MODES,
  };
}

/**
 * Hook for mute state only (lightweight)
 */
export function useMuteState() {
  const [muted, setMuted] = useState(() => loadSettings().muted);

  useEffect(() => {
    const handleStorage = (e) => {
      if (e.key === 'quox-voice-settings') {
        setMuted(loadSettings().muted);
      }
    };

    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const toggle = useCallback(() => {
    const newMuted = !muted;
    updateSettings({ muted: newMuted });
    setMuted(newMuted);
    return newMuted;
  }, [muted]);

  const set = useCallback((value) => {
    updateSettings({ muted: value });
    setMuted(value);
  }, []);

  return { muted, toggle, set };
}

/**
 * Hook for TTS with preprocessing
 */
export function useTTS(agentId = 'default') {
  const { settings, isMuted } = useVoiceSettings();

  // Get voice config for this agent
  const voiceConfig = useMemo(() => {
    return getAgentVoice(agentId);
  }, [agentId, settings.agentVoices]);

  // Get model config
  const modelConfig = useMemo(() => {
    return getTTSModel();
  }, [settings.model]);

  // Preprocess text for TTS
  const preprocess = useCallback((text) => {
    return preprocessForTTS(text);
  }, [settings.verbosity, settings.preprocessing]);

  // Build full TTS request params
  const buildParams = useCallback((text, isPremium = false) => {
    const processed = preprocess(text);
    return buildTTSParams(agentId, processed, isPremium);
  }, [agentId, preprocess]);

  // Check if TTS should speak
  const shouldSpeak = useCallback((text) => {
    if (!settings.enabled || isMuted) return false;
    if (!text || text.trim().length === 0) return false;
    return true;
  }, [settings.enabled, isMuted]);

  return {
    voiceConfig,
    modelConfig,
    preprocess,
    buildParams,
    shouldSpeak,
    isMuted,
    isEnabled: settings.enabled,
  };
}

/**
 * Hook for voice selection UI with dynamic agents and grouped voices
 */
export function useVoiceSelector() {
  const { settings, setAgentVoice, setAgentSynthetic } = useVoiceSettings();

  // Get all voices as flat list
  const voices = useMemo(() => {
    return Object.entries(VOICE_LIBRARY).map(([key, voice]) => ({
      key,
      ...voice,
    }));
  }, []);

  // Get voices grouped by category for select optgroups
  const voicesByCategory = useMemo(() => {
    return getVoicesByCategory();
  }, []);

  // Get all agents dynamically from config
  const agents = useMemo(() => {
    const agentIds = getAllAgentIds();
    return agentIds.map((agentId) => {
      const voiceKey = resolveVoiceKey(settings.agentVoices[agentId]);
      return {
        agentId,
        voiceKey,
        voice: VOICE_LIBRARY[voiceKey] || VOICE_LIBRARY[DEFAULT_VOICE_KEY],
        synthetic: resolveAgentSynthetic(settings, agentId),
      };
    });
  }, [settings]);

  return {
    voices,
    voicesByCategory,
    agents,
    setAgentVoice,
    setAgentSynthetic,
    VOICE_CATEGORIES,
  };
}

/**
 * Hook for verbosity selection UI
 */
export function useVerbositySelector() {
  const { settings, setVerbosity, VERBOSITY_MODES } = useVoiceSettings();

  const modes = useMemo(() => {
    return Object.entries(VERBOSITY_MODES).map(([key, mode]) => ({
      key,
      ...mode,
    }));
  }, [VERBOSITY_MODES]);

  const current = useMemo(() => {
    return {
      key: settings.verbosity,
      ...VERBOSITY_MODES[settings.verbosity],
    };
  }, [settings.verbosity, VERBOSITY_MODES]);

  return {
    modes,
    current,
    setVerbosity,
  };
}

export default {
  useVoiceSettings,
  useMuteState,
  useTTS,
  useVoiceSelector,
  useVerbositySelector,
};
