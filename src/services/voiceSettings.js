import { syncPreferenceToServer } from './userPreferences';

/**
 * Voice Settings Service V2
 * Manages voice preferences with localStorage persistence
 *
 * Features:
 * - 20 ElevenLabs voices with descriptive naming
 * - Dynamic assistant detection
 * - Backwards compatibility with legacy voice keys
 */

import { isPluginLicensed } from './licenseValidator';
import { assistants } from '../config/assistants';

import { personalGet, personalSet } from './orgScopedStorage';
const PREMIUM_PLUGIN = 'advanced-voice';

/**
 * Voice Library - 20 ElevenLabs default voices
 * Naming: {accent}_{gender}_{number}
 * Display: "{Accent} {Gender} {Number} ({Tone})"
 */
export const VOICE_LIBRARY = {
  // DISTINCT VOICES (VOICE-P1, 2026-10-07). Not ElevenLabs premades: one
  // voice generated on the account plus low-usage community library voices
  // added to it (no extra cost on the current plan). Owner brief: variety
  // without ubiquity, wean off the classic defaults everyone has heard.
  distinct_computer_female: {
    voiceId: 'gxnrXBz8KFwT6PWArKsG',
    displayName: 'Vela, Futuristic Female (Computer)',
    gender: 'female',
    accent: 'Synthetic',
    tone: 'Clear, slightly synthetic',
    category: 'distinct'
  },
  distinct_nordic_female: {
    voiceId: 'othsitkiTCdLyCKCIC1P',
    displayName: 'Nina, Nordic Female (Calm)',
    gender: 'female',
    accent: 'Nordic / British',
    tone: 'Mature, calm, a little raspy',
    category: 'distinct'
  },
  distinct_south_african_male: {
    voiceId: 'UbiZ0cvQBrDPiczSmr1p',
    displayName: 'Leon, South African Male (Steady)',
    gender: 'male',
    accent: 'South African',
    tone: 'Stable, clear',
    category: 'distinct'
  },
  distinct_scottish_male: {
    voiceId: 'l2gKwBLgCSwxnJMVsG0l',
    displayName: 'Fraser, Glaswegian Male (Storyteller)',
    gender: 'male',
    accent: 'Scottish',
    tone: 'Calm, grounded',
    category: 'distinct'
  },
  distinct_dry_male: {
    voiceId: 'N6E9d25OXSxYqJ8XaMXN',
    displayName: 'Olayan, American Male (Dry Wit)',
    gender: 'male',
    accent: 'American',
    tone: 'Measured, dry humour',
    category: 'distinct'
  },
  distinct_character: {
    voiceId: 'HsZsb8nllvY3Q0cIv3IZ',
    displayName: 'Bonkus, Character (Playful)',
    gender: 'neutral',
    accent: 'Character',
    tone: 'Playful, animated',
    category: 'distinct'
  },

  // ---- CLASSIC ElevenLabs premades below (kept selectable, no longer defaults)
  // American Female (5)
  american_female_1: {
    voiceId: 'EXAVITQu4vr4xnSDxMaL',
    displayName: 'American Female 1 (Warm)',
    gender: 'female',
    accent: 'American',
    tone: 'Soft, warm',
    category: 'american_female'
  },
  american_female_2: {
    voiceId: '9BWtsMINqrJLrRacOk9x',
    displayName: 'American Female 2 (Expressive)',
    gender: 'female',
    accent: 'American',
    tone: 'Expressive, dynamic',
    category: 'american_female'
  },
  american_female_3: {
    voiceId: 'FGY2WhTYpPnrIDTdsKH5',
    displayName: 'American Female 3 (Upbeat)',
    gender: 'female',
    accent: 'American',
    tone: 'Upbeat, energetic',
    category: 'american_female'
  },
  american_female_4: {
    voiceId: 'XrExE9yKIg1WjnnlVkGX',
    displayName: 'American Female 4 (Friendly)',
    gender: 'female',
    accent: 'American',
    tone: 'Friendly, approachable',
    category: 'american_female'
  },
  american_female_5: {
    voiceId: 'cgSgspJ2msm6clMCkdW9',
    displayName: 'American Female 5 (Young)',
    gender: 'female',
    accent: 'American',
    tone: 'Young, expressive',
    category: 'american_female'
  },

  // American Male (7)
  american_male_1: {
    voiceId: 'nPczCjzI2devNBz1zQrb',
    displayName: 'American Male 1 (Deep)',
    gender: 'male',
    accent: 'American',
    tone: 'Deep, authoritative',
    category: 'american_male'
  },
  american_male_2: {
    voiceId: 'iP95p4xoKVk53GoZ742B',
    displayName: 'American Male 2 (Casual)',
    gender: 'male',
    accent: 'American',
    tone: 'Casual, conversational',
    category: 'american_male'
  },
  american_male_3: {
    voiceId: 'cjVigY5qzO86Huf0OWal',
    displayName: 'American Male 3 (Friendly)',
    gender: 'male',
    accent: 'American',
    tone: 'Friendly, approachable',
    category: 'american_male'
  },
  american_male_4: {
    voiceId: 'CYw3kZ02Hs0563khs1Fj',
    displayName: 'American Male 4 (Confident)',
    gender: 'male',
    accent: 'American',
    tone: 'Confident, professional',
    category: 'american_male'
  },
  american_male_5: {
    voiceId: 'TX3LPaxmHKxFdv7VOQHJ',
    displayName: 'American Male 5 (Articulate)',
    gender: 'male',
    accent: 'American',
    tone: 'Young, articulate',
    category: 'american_male'
  },
  american_male_6: {
    voiceId: 'pqHfZKP75CvOlQylNhV4',
    displayName: 'American Male 6 (Trustworthy)',
    gender: 'male',
    accent: 'American',
    tone: 'Mature, trustworthy',
    category: 'american_male'
  },
  american_male_7: {
    voiceId: 'bIHbv24MWmeRgasZH58o',
    displayName: 'American Male 7 (Warm)',
    gender: 'male',
    accent: 'American',
    tone: 'Young, warm',
    category: 'american_male'
  },

  // American Non-binary (1)
  american_neutral_1: {
    voiceId: 'CwhRBWXzGAHq8TQ4Fs17',
    displayName: 'American Neutral 1 (Confident)',
    gender: 'neutral',
    accent: 'American',
    tone: 'Confident, balanced',
    category: 'american_neutral'
  },

  // British Female (2)
  british_female_1: {
    voiceId: 'Xb7hH8MSUJpSbSDYk0k2',
    displayName: 'British Female 1 (Confident)',
    gender: 'female',
    accent: 'British',
    tone: 'Confident, professional',
    category: 'british'
  },
  british_female_2: {
    voiceId: 'pFZP5JQG7iQjIQuC4Bku',
    displayName: 'British Female 2 (Warm)',
    gender: 'female',
    accent: 'British',
    tone: 'Warm, nurturing',
    category: 'british'
  },

  // British Male (2)
  british_male_1: {
    voiceId: 'onwK4e9ZLuTAKqWW03F9',
    displayName: 'British Male 1 (Authoritative)',
    gender: 'male',
    accent: 'British',
    tone: 'Authoritative, professional',
    category: 'british'
  },
  british_male_2: {
    voiceId: 'JBFqnCBsd6RMkjVDRZzb',
    displayName: 'British Male 2 (Warm)',
    gender: 'male',
    accent: 'British',
    tone: 'Warm, storytelling',
    category: 'british'
  },

  // Australian Male (1)
  australian_male_1: {
    voiceId: 'IKne3meq5aSn9XLyUdCD',
    displayName: 'Australian Male 1 (Natural)',
    gender: 'male',
    accent: 'Australian',
    tone: 'Natural, conversational',
    category: 'other'
  },

  // Transatlantic Male (1)
  transatlantic_male_1: {
    voiceId: 'N2lVS1w4EtoT3dr4eOWO',
    displayName: 'Transatlantic Male 1 (Intense)',
    gender: 'male',
    accent: 'Transatlantic',
    tone: 'Intense, dramatic',
    category: 'other'
  },

  // Swedish Female (1)
  swedish_female_1: {
    voiceId: 'XB0fDUnXU5powFXDhCwa',
    displayName: 'Swedish Female 1 (Alluring)',
    gender: 'female',
    accent: 'Swedish',
    tone: 'Alluring, mysterious',
    category: 'other'
  },

  // Irish Male (1)
  irish_male_1: {
    voiceId: 'D38z5RcWu1voky8WS1ja',
    displayName: 'Irish Male 1 (Charming)',
    gender: 'male',
    accent: 'Irish',
    tone: 'Charming, friendly',
    category: 'other'
  },

  // Italian Male (1)
  italian_male_1: {
    voiceId: 'zcAOhNBS3c14rBihAFp1',
    displayName: 'Italian Male 1 (Mature)',
    gender: 'male',
    accent: 'Italian',
    tone: 'Mature, seasoned',
    category: 'other'
  },

  // CHARACTER VOICES - More personality!
  // Arnold - THE ORIGINAL CHOOM VOICE! Deep, raspy, German-American
  character_arnold: {
    voiceId: 'VR6AewLTigWG4xSOukaG',
    displayName: 'Arnold - Cyberpunk (Deep Raspy)',
    gender: 'male',
    accent: 'German-American',
    tone: 'Deep, raspy, commanding - THE CHOOM VOICE',
    category: 'character'
  },

  // Clyde - War veteran, gruff
  character_clyde: {
    voiceId: '2EiwWnXFnvU5JabPnv8n',
    displayName: 'Clyde - War Veteran (Gruff)',
    gender: 'male',
    accent: 'American',
    tone: 'Gruff, battle-worn, cyberpunk vibes',
    category: 'character'
  },

  // Patrick - Shouty, intense
  character_patrick: {
    voiceId: 'ODq5zmih8GrVes37Dizd',
    displayName: 'Patrick - Intense (Shouty)',
    gender: 'male',
    accent: 'American',
    tone: 'Loud, intense, energetic',
    category: 'character'
  },

  // Jessie - Old raspy
  character_jessie: {
    voiceId: 't0jbNlBVZ17f02VDIeMI',
    displayName: 'Jessie - Old Timer (Raspy)',
    gender: 'male',
    accent: 'American',
    tone: 'Old, raspy, weathered',
    category: 'character'
  },

  // Harry - Anxious young guy
  character_harry: {
    voiceId: 'SOYHLrjzK2X1ezoPC6cr',
    displayName: 'Harry - Nervous (Anxious)',
    gender: 'male',
    accent: 'American',
    tone: 'Young, anxious, jittery',
    category: 'character'
  },

  // Jeremy - Excited enthusiast
  character_jeremy: {
    voiceId: 'bVMeCyTHy58xNoL34h3p',
    displayName: 'Jeremy - Enthusiast (Excited)',
    gender: 'male',
    accent: 'American',
    tone: 'Young, excited, peppy',
    category: 'character'
  },

  // Glinda - Witch character
  character_glinda: {
    voiceId: 'z9fAnlkpzviPz146aGWa',
    displayName: 'Glinda - Witch (Mystical)',
    gender: 'female',
    accent: 'American',
    tone: 'Mystical, theatrical',
    category: 'character'
  },

  // Freya - Expressive storyteller
  character_freya: {
    voiceId: 'jsCqWAovK2LkecY7zXl4',
    displayName: 'Freya - Storyteller (Expressive)',
    gender: 'female',
    accent: 'American',
    tone: 'Expressive, animated',
    category: 'character'
  },

  // Sam - Raspy narrator
  character_sam: {
    voiceId: 'yoZ06aMxZJJ28mfd3POQ',
    displayName: 'Sam - Narrator (Raspy)',
    gender: 'male',
    accent: 'American',
    tone: 'Raspy, gritty',
    category: 'character'
  },

  // Nicole - Whispery ASMR
  character_nicole: {
    voiceId: 'piTKgcLEGmPE4e6mEKli',
    displayName: 'Nicole - ASMR (Whisper)',
    gender: 'female',
    accent: 'American',
    tone: 'Soft, whispery, intimate',
    category: 'character'
  },

  // Gigi - Childish animated
  character_gigi: {
    voiceId: 'jBpfuIE2acCO8z3wKNLl',
    displayName: 'Gigi - Animated (Childish)',
    gender: 'female',
    accent: 'American',
    tone: 'Childish, animated, fun',
    category: 'character'
  },
};

/**
 * Legacy voice key mapping for backwards compatibility
 */
export const LEGACY_VOICE_MAP = {
  // Old personal name keys -> new descriptive keys
  rachel: 'american_female_1',
  adam: 'american_male_1',
  arnold: 'american_male_4',
  daniel: 'british_male_1',
  // Old voice mode keys
  jarvis: 'british_male_1',
  hal: 'american_male_1',
  cyberpunk: 'character_arnold',  // THE ORIGINAL CHOOM VOICE!
  trinity: 'american_female_1',
  // Character voice shortcuts
  arnold: 'character_arnold',
  choom: 'character_arnold',
  clyde: 'character_clyde',
  patrick: 'character_patrick',
  jessie: 'character_jessie',
  harry: 'character_harry',
  jeremy: 'character_jeremy',
  glinda: 'character_glinda',
  freya: 'character_freya',
  sam: 'character_sam',
  nicole: 'character_nicole',
  gigi: 'character_gigi',
};

/**
 * Voice categories for grouped display
 */
export const VOICE_CATEGORIES = [
  { key: 'distinct', label: 'Distinct (recommended)' },
  { key: 'character', label: '🎭 Character Voices' },
  { key: 'american_female', label: 'American Female' },
  { key: 'american_male', label: 'American Male' },
  { key: 'american_neutral', label: 'American Neutral' },
  { key: 'british', label: 'British' },
  { key: 'other', label: 'Other Accents' },
];

/** Fallback voice key for any agent without an explicit default. */
export const DEFAULT_VOICE_KEY = 'distinct_nordic_female';

/**
 * Keys of the CLASSIC ElevenLabs premade voices (every voice that is not in
 * the distinct category). Used to label them in the picker.
 */
export const CLASSIC_VOICE_KEYS = Object.freeze(
  Object.keys(VOICE_LIBRARY).filter((k) => VOICE_LIBRARY[k].category !== 'distinct')
);

/**
 * Pre-VOICE-P1 defaults. Kept ONLY so the one-time migration can tell an
 * untouched default (move it to the new map) from a deliberate user choice
 * (leave it alone).
 */
const LEGACY_AGENT_VOICE_DEFAULTS = {
  quox: 'american_female_1', sentinel: 'british_male_1', cipher: 'american_male_1',
  nova: 'american_female_2', prism: 'american_female_3', atlas: 'american_male_2',
  metrics: 'american_male_3', insight: 'british_female_2', scholar: 'british_female_1',
  beacon: 'australian_male_1', forge: 'american_male_5', archivist: 'british_male_2',
  corey: 'american_male_7', tester: 'american_neutral_1', netwatch: 'transatlantic_male_1',
  default: 'american_female_1',
};

/**
 * Default voice assignments per agent (VOICE-P1). Grouped by family so the
 * agents you talk to most sound distinct from each other, and none uses a
 * classic premade. Anything unlisted falls back to DEFAULT_VOICE_KEY.
 */
const AGENT_VOICE_DEFAULTS = {
  // Futuristic female, Synthetic effect on by default (see AGENT_SYNTHETIC_DEFAULTS)
  cortex: 'distinct_computer_female',
  // Orchestrator: calm, unusual accent, instantly not "the YouTube voice"
  quox: 'distinct_nordic_female',
  // Security and governance: steady and clear
  sentinel: 'distinct_south_african_male', security_lead: 'distinct_south_african_male',
  regula: 'distinct_south_african_male', auditus: 'distinct_south_african_male',
  argus: 'distinct_south_african_male', horus: 'distinct_south_african_male',
  cipher: 'distinct_south_african_male', recon_specialist: 'distinct_south_african_male',
  findings_verifier: 'distinct_south_african_male', janus: 'distinct_south_african_male',
  keeper: 'distinct_south_african_male', netwatch: 'distinct_south_african_male',
  // Knowledge, research, docs and code: grounded storyteller
  scholar: 'distinct_scottish_male', archivist: 'distinct_scottish_male',
  forge: 'distinct_scottish_male', seer: 'distinct_scottish_male',
  insight: 'distinct_scottish_male', nucleus: 'distinct_scottish_male',
  perplexity: 'distinct_scottish_male', gemini: 'distinct_scottish_male',
  roady: 'distinct_scottish_male', architect: 'distinct_scottish_male',
  quoxperticus: 'distinct_scottish_male', toolsmith: 'distinct_scottish_male',
  quoxcode: 'distinct_scottish_male',
  // Ops, infra and automation: dry and measured
  atlas: 'distinct_dry_male', metrics: 'distinct_dry_male', beacon: 'distinct_dry_male',
  meshnet: 'distinct_dry_male', dockeragent: 'distinct_dry_male',
  quartermaster: 'distinct_dry_male', quoxflow: 'distinct_dry_male',
  'loop-q': 'distinct_dry_male', 'action-q': 'distinct_dry_male',
  tester: 'distinct_dry_male', 'triage-q': 'distinct_dry_male', scout: 'distinct_dry_male',
  web_specialist: 'distinct_dry_male', 'browser-q': 'distinct_dry_male',
  gripe: 'distinct_dry_male',
  // Social and creative: playful character
  xtwitter: 'distinct_character', linkedin: 'distinct_character',
  facebook: 'distinct_character', instagram: 'distinct_character',
  tiktok: 'distinct_character', youtube: 'distinct_character',
  imagesq: 'distinct_character', nova: 'distinct_character',
  prism: 'distinct_character', weaver: 'distinct_character',
  default: DEFAULT_VOICE_KEY,
};

/** Agents whose voice plays through the Synthetic effect unless toggled off. */
const AGENT_SYNTHETIC_DEFAULTS = { cortex: true };

/** Bumped when the default map changes in a way stored settings should adopt. */
export const VOICE_MAP_VERSION = 2;

// ElevenLabs models
export const TTS_MODELS = {
  flash: { id: 'eleven_flash_v2_5', name: 'Flash', description: 'Fastest, lowest latency' },
  turbo: { id: 'eleven_turbo_v2_5', name: 'Turbo', description: 'Balanced speed/quality' },
  multilingual: { id: 'eleven_multilingual_v2', name: 'Multilingual', description: 'Highest quality' },
};

// Verbosity presets
export const VERBOSITY_MODES = {
  quiet: {
    name: 'Quiet',
    description: 'Brief acknowledgments only',
    maxLength: 150,
    skipCodeBlocks: true,
    skipTables: true,
    skipLists: true,
    summarizeLongResponses: true,
  },
  normal: {
    name: 'Normal',
    description: 'Balanced - skips technical details',
    maxLength: 500,
    skipCodeBlocks: true,
    skipTables: true,
    skipLists: false,
    summarizeLongResponses: false,
  },
  verbose: {
    name: 'Verbose',
    description: 'Reads most content',
    maxLength: 1000,
    skipCodeBlocks: true,
    skipTables: false,
    skipLists: false,
    summarizeLongResponses: false,
  },
};

/**
 * Get all agent IDs dynamically from assistants config
 */
export function getAllAgentIds() {
  return Object.keys(assistants);
}

/**
 * Get default voice for an agent
 */
export function getDefaultVoiceForAgent(agentId) {
  return AGENT_VOICE_DEFAULTS[agentId] || AGENT_VOICE_DEFAULTS.default;
}

/**
 * Resolve a voice key (handles legacy keys)
 */
export function resolveVoiceKey(key) {
  if (!key) return DEFAULT_VOICE_KEY;
  // Check if it's a legacy key
  if (LEGACY_VOICE_MAP[key]) {
    return LEGACY_VOICE_MAP[key];
  }
  // Check if it's a valid current key
  if (VOICE_LIBRARY[key]) {
    return key;
  }
  // Fallback
  return DEFAULT_VOICE_KEY;
}

/**
 * Initialize agent voices - merges stored with all current agents
 */
function initializeAgentVoices(storedVoices = {}) {
  const allAgents = getAllAgentIds();
  const merged = {};

  // First, migrate any legacy keys in stored voices
  for (const [agentId, voiceKey] of Object.entries(storedVoices)) {
    merged[agentId] = resolveVoiceKey(voiceKey);
  }

  // Then, ensure all current agents have a voice
  for (const agentId of allAgents) {
    if (!merged[agentId]) {
      merged[agentId] = getDefaultVoiceForAgent(agentId);
    }
  }

  // Always have a default
  if (!merged.default) {
    merged.default = DEFAULT_VOICE_KEY;
  }

  return merged;
}

/**
 * One-time move off the classic defaults: any agent still on its OLD default
 * (or on a key the old default map would have given it) moves to the new
 * default. A voice the user picked deliberately is left alone.
 */
export function migrateAgentVoiceMap(storedVoices = {}) {
  const out = {};
  for (const [agentId, rawKey] of Object.entries(storedVoices)) {
    const key = resolveVoiceKey(rawKey);
    const oldDefault = LEGACY_AGENT_VOICE_DEFAULTS[agentId] || LEGACY_AGENT_VOICE_DEFAULTS.default;
    out[agentId] = key === oldDefault ? getDefaultVoiceForAgent(agentId) : key;
  }
  return out;
}

// Build default settings dynamically
function getDefaultSettings() {
  return {
    enabled: false,
    muted: false,
    verbosity: 'normal',
    model: 'multilingual',
    preprocessing: {
      skipCodeBlocks: true,
      skipTables: true,
      skipIpAddresses: true,
      skipPaths: true,
      skipUrls: true,
      maxListItems: 5,
    },
    agentVoices: initializeAgentVoices({}),
    agentSynthetic: { ...AGENT_SYNTHETIC_DEFAULTS },
    voiceMapVersion: VOICE_MAP_VERSION,
    premium: {
      voiceSettings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.0,
        speed: 1.0,
      },
      maxLength: 2000,
      smartSummarization: false,
    },
  };
}

/**
 * Load settings from localStorage
 */
export function loadSettings() {
  try {
    const stored = personalGet('voice');
    if (stored) {
      const parsed = JSON.parse(stored);
      // Merge with defaults and initialize agent voices dynamically
      const defaults = getDefaultSettings();
      const needsMapMigration = (parsed.voiceMapVersion || 1) < VOICE_MAP_VERSION;
      const migratedVoices = needsMapMigration
        ? migrateAgentVoiceMap(parsed.agentVoices || {})
        : (parsed.agentVoices || {});
      const merged = deepMerge(defaults, { ...parsed, agentVoices: {} });
      // Re-initialize agent voices to pick up new agents and migrate legacy
      merged.agentVoices = initializeAgentVoices(migratedVoices);
      if (needsMapMigration) {
        merged.voiceMapVersion = VOICE_MAP_VERSION;
        // Persist once so the server-side copy adopts the new map too.
        saveSettings(merged);
      }
      return merged;
    }
  } catch (err) {
    console.warn('Failed to load voice settings:', err);
  }
  return getDefaultSettings();
}

/**
 * Save settings to localStorage
 */
export function saveSettings(settings) {
  try {
    personalSet('voice', JSON.stringify(settings));
    syncPreferenceToServer('voiceSettings', settings);
    return true;
  } catch (err) {
    console.error('Failed to save voice settings:', err);
    return false;
  }
}

/**
 * Update specific settings (partial update)
 */
export function updateSettings(updates) {
  const current = loadSettings();
  const updated = deepMerge(current, updates);
  saveSettings(updated);
  return updated;
}

/**
 * Get mute state
 */
export function isMuted() {
  return loadSettings().muted;
}

/**
 * Set mute state
 */
export function setMuted(muted) {
  return updateSettings({ muted });
}

/**
 * Toggle mute state
 */
export function toggleMute() {
  const current = loadSettings();
  return updateSettings({ muted: !current.muted });
}

/**
 * Get voice for a specific agent
 */
export function getAgentVoice(agentId) {
  const settings = loadSettings();
  const voiceKey = resolveVoiceKey(
    settings.agentVoices[agentId] || settings.agentVoices.default
  );
  return VOICE_LIBRARY[voiceKey] || VOICE_LIBRARY[DEFAULT_VOICE_KEY];
}

/**
 * Is the Synthetic (subtle robotic) playback effect on for this agent?
 */
export function getAgentSynthetic(agentId) {
  return resolveAgentSynthetic(loadSettings(), agentId);
}

/** Pure form of getAgentSynthetic for an already-loaded settings object. */
export function resolveAgentSynthetic(settings, agentId) {
  const map = (settings && settings.agentSynthetic) || {};
  if (Object.prototype.hasOwnProperty.call(map, agentId)) return map[agentId] === true;
  return AGENT_SYNTHETIC_DEFAULTS[agentId] === true;
}

/**
 * Toggle the Synthetic effect for an agent. Saved with the rest of the voice
 * settings, which sync to the server-side user preferences.
 */
export function setAgentSynthetic(agentId, enabled) {
  const settings = loadSettings();
  return updateSettings({
    agentSynthetic: { ...(settings.agentSynthetic || {}), [agentId]: enabled === true },
  });
}

/**
 * Set voice for a specific agent
 */
export function setAgentVoice(agentId, voiceKey) {
  const settings = loadSettings();
  const resolvedKey = resolveVoiceKey(voiceKey);
  return updateSettings({
    agentVoices: {
      ...settings.agentVoices,
      [agentId]: resolvedKey,
    },
  });
}

/**
 * Get current verbosity config
 */
export function getVerbosityConfig() {
  const settings = loadSettings();
  return VERBOSITY_MODES[settings.verbosity] || VERBOSITY_MODES.normal;
}

/**
 * Get current TTS model
 */
export function getTTSModel() {
  const settings = loadSettings();
  return TTS_MODELS[settings.model] || TTS_MODELS.multilingual;
}

/**
 * Get preprocessing config merged with verbosity
 */
export function getPreprocessingConfig() {
  const settings = loadSettings();
  const verbosity = VERBOSITY_MODES[settings.verbosity] || VERBOSITY_MODES.normal;

  return {
    ...settings.preprocessing,
    maxLength: verbosity.maxLength,
    skipCodeBlocks: verbosity.skipCodeBlocks,
    skipTables: verbosity.skipTables,
    skipLists: verbosity.skipLists,
    summarizeLongResponses: verbosity.summarizeLongResponses,
  };
}

/**
 * Build TTS request parameters
 */
export function buildTTSParams(agentId, text, isPremium = false) {
  const settings = loadSettings();
  const voice = getAgentVoice(agentId);
  const model = getTTSModel();

  const params = {
    text,
    voice_id: voice.voiceId,
    model_id: model.id,
  };

  // Add premium voice settings if available
  if (isPremium && settings.premium) {
    params.voice_settings = settings.premium.voiceSettings;
  }

  return params;
}

/**
 * Reset to defaults
 */
export function resetSettings() {
  const defaults = getDefaultSettings();
  saveSettings(defaults);
  return defaults;
}

/**
 * Export settings for backup
 */
export function exportSettings() {
  return JSON.stringify(loadSettings(), null, 2);
}

/**
 * Import settings from backup
 */
export function importSettings(jsonString) {
  try {
    const imported = JSON.parse(jsonString);
    const defaults = getDefaultSettings();
    const merged = deepMerge(defaults, imported);
    // Re-initialize agent voices
    merged.agentVoices = initializeAgentVoices(merged.agentVoices);
    saveSettings(merged);
    return { success: true, settings: merged };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Forbidden keys that could enable prototype pollution attacks
 */
const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];

/**
 * Check if a key is safe (not a prototype pollution vector)
 * @param {string} key
 * @returns {boolean}
 */
function isSafeKey(key) {
  return !FORBIDDEN_KEYS.includes(key);
}

/**
 * Deep merge utility with prototype pollution protection
 */
function deepMerge(target, source) {
  const result = { ...target };
  for (const key in source) {
    // Skip dangerous keys to prevent prototype pollution
    if (!isSafeKey(key)) continue;
    // Only process own properties
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;

    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * Check if premium voice features are available
 */
export function isPremiumVoiceAvailable() {
  return isPluginLicensed(PREMIUM_PLUGIN);
}

/**
 * Get the effective max TTS length based on premium status
 */
export function getMaxTTSLength() {
  if (isPremiumVoiceAvailable()) {
    return 2000; // Premium limit
  }
  const settings = loadSettings();
  const verbosity = VERBOSITY_MODES[settings.verbosity] || VERBOSITY_MODES.normal;
  return verbosity.maxLength; // Free tier uses verbosity-based limits
}

/**
 * Get available voices grouped by category
 */
export function getAvailableVoices() {
  return Object.entries(VOICE_LIBRARY).map(([key, voice]) => ({
    key,
    ...voice,
    isPremium: false,
    isClassic: voice.category !== 'distinct',
  }));
}

/**
 * Get voices grouped by category for UI
 */
export function getVoicesByCategory() {
  const voices = getAvailableVoices();
  const grouped = {};

  for (const category of VOICE_CATEGORIES) {
    grouped[category.key] = {
      label: category.label,
      voices: voices.filter(v => v.category === category.key),
    };
  }

  return grouped;
}

/**
 * Check if voice parameters are available (premium only)
 */
export function areVoiceParametersAvailable() {
  return isPremiumVoiceAvailable();
}

/**
 * Check if smart summarization is available (premium only)
 */
export function isSmartSummarizationAvailable() {
  return isPremiumVoiceAvailable();
}

// Keep BUILTIN_VOICES as alias for backwards compatibility
export const BUILTIN_VOICES = VOICE_LIBRARY;

// Keep VOICE_MODE_MAP for backwards compatibility
export const VOICE_MODE_MAP = LEGACY_VOICE_MAP;

export default {
  loadSettings,
  saveSettings,
  updateSettings,
  isMuted,
  setMuted,
  toggleMute,
  getAgentVoice,
  setAgentVoice,
  getAgentSynthetic,
  setAgentSynthetic,
  migrateAgentVoiceMap,
  getVerbosityConfig,
  getTTSModel,
  getPreprocessingConfig,
  buildTTSParams,
  resetSettings,
  exportSettings,
  importSettings,
  isPremiumVoiceAvailable,
  getMaxTTSLength,
  getAvailableVoices,
  getVoicesByCategory,
  areVoiceParametersAvailable,
  isSmartSummarizationAvailable,
  getAllAgentIds,
  getDefaultVoiceForAgent,
  resolveVoiceKey,
  VOICE_LIBRARY,
  LEGACY_VOICE_MAP,
  VOICE_CATEGORIES,
  DEFAULT_VOICE_KEY,
  CLASSIC_VOICE_KEYS,
  VOICE_MAP_VERSION,
  BUILTIN_VOICES,
  VOICE_MODE_MAP,
  TTS_MODELS,
  VERBOSITY_MODES,
};
