/**
 * settingsRegistry.js — REGULA's source of truth for settings metadata.
 *
 * Each entry describes a single user-facing setting in plain English with:
 * - id: stable identifier
 * - section: which Settings tab it lives on
 * - label: display name
 * - type: 'toggle' | 'choice' | 'text' | 'number' | 'list' | 'action' | 'info'
 * - shortDescription: one-line summary (≤100 chars)
 * - explanation: long-form, plain-English (2-4 sentences)
 * - allowedValues: array of { value, label, description } for choice types
 * - defaultValue: default if unset
 * - dependencies: array of setting IDs that affect or are affected by this one
 * - sideEffects: array of plain-English consequences when changed
 * - destructive: true if toggling/changing can cause data loss or lockout
 * - hitlRequired: true if change must route through HITL inbox
 * - keywords: extra search terms for REGULA's semantic lookup
 * - tier: 'free' | 'premium' | 'enterprise' if gated
 *
 * REGULA reads this registry to:
 * 1. Answer "what does X do?" questions in plain English
 * 2. Search for settings by natural-language query
 * 3. Surface dependency chains before the user changes something
 * 4. Flag destructive or one-way doors
 *
 * Registry coverage (Phase 2): top 100 settings across general, appearance,
 * voice, plugins, backup, privacy, telemetry, licence, vault, notifications.
 * Sub-page specifics (assistants, execution policy, router thresholds) get
 * lazy descriptors populated on first REGULA query.
 */

export const SETTINGS_REGISTRY = [
  // ────────────────────────────────────────────────────────────── GENERAL
  {
    id: 'general.advancedMode',
    section: 'general',
    label: 'Advanced Mode',
    type: 'toggle',
    shortDescription: 'Reveals power-user settings and diagnostic panels.',
    explanation: 'Advanced Mode unlocks low-level configuration controls: raw JSON editors, debug panels, experimental plugins, and diagnostic overlays. Leave this off unless you are comfortable reading stack traces and reasoning about the agent runtime.',
    defaultValue: false,
    dependencies: ['general.developerTools'],
    sideEffects: ['Exposes developer tools toggle', 'Shows raw envelope inspector', 'Enables experimental plugin slots'],
    destructive: false,
    hitlRequired: false,
    keywords: ['power user', 'developer', 'debug', 'diagnostic', 'advanced'],
  },
  {
    id: 'general.verbosity',
    section: 'general',
    label: 'Assistant Verbosity',
    type: 'choice',
    shortDescription: 'Controls how much detail your assistants include in responses.',
    explanation: 'Verbosity sets the default response length for all voice and chat agents. Quiet returns brief confirmations only. Normal is conversational. Verbose gives detailed explanations with context. Individual agents can override this.',
    allowedValues: [
      { value: 'quiet', label: 'Quiet', description: 'Brief confirmations only (~150 chars)' },
      { value: 'normal', label: 'Normal', description: 'Standard responses (~500 chars)' },
      { value: 'verbose', label: 'Verbose', description: 'Detailed explanations (~1000 chars)' },
    ],
    defaultValue: 'normal',
    dependencies: ['voice.agentVoices'],
    sideEffects: ['Affects all voice and chat responses', 'Individual agents may override'],
    destructive: false,
    hitlRequired: false,
    keywords: ['chatty', 'brief', 'length', 'response length', 'detail'],
  },
  {
    id: 'general.timezone',
    section: 'general',
    label: 'Timezone',
    type: 'text',
    shortDescription: 'The timezone used for all timestamps, schedules, and reports.',
    explanation: 'REGULA stamps every settings change with this timezone. Backup schedules, cron jobs, scheduled reports, and licence expiry dates are all computed against it. Changing it does not reschedule existing jobs — it only affects how their times are displayed.',
    defaultValue: 'UTC',
    dependencies: ['backup.schedule', 'notifications.quietHours'],
    sideEffects: ['Timestamps in audit log shift display', 'Scheduled reports re-render times', 'Does NOT reschedule existing cron jobs'],
    destructive: false,
    hitlRequired: false,
    keywords: ['time', 'tz', 'zone', 'utc', 'local time'],
  },

  // ─────────────────────────────────────────────────────────── APPEARANCE
  {
    id: 'appearance.backgroundMode',
    section: 'appearance',
    label: 'Background Mode',
    type: 'choice',
    shortDescription: 'Visual style of the dashboard background.',
    explanation: 'Background Mode controls the ambient visual layer behind every page. Static uses a single image. Animated cycles through subtle motion. Live renders a realtime WebGL scene. Live looks best but costs ~5-10% more GPU; drop to Static on integrated graphics.',
    allowedValues: [
      { value: 'static', label: 'Static', description: 'Single still image, zero GPU cost' },
      { value: 'animated', label: 'Animated', description: 'Subtle motion, minimal GPU' },
      { value: 'live', label: 'Live', description: 'Realtime WebGL scene, ~5-10% GPU' },
    ],
    defaultValue: 'animated',
    dependencies: ['appearance.theme'],
    sideEffects: ['Live mode increases GPU usage', 'May affect battery life on laptops'],
    destructive: false,
    hitlRequired: false,
    keywords: ['wallpaper', 'background', 'animation', 'motion', 'gpu'],
  },
  {
    id: 'appearance.theme',
    section: 'appearance',
    label: 'Theme',
    type: 'choice',
    shortDescription: 'Light, dark, or auto theme.',
    explanation: 'QuoxCORE is designed for dark mode first — the glass morphism palette assumes a dark substrate. Light mode is supported but some panels may look washed out. Auto follows your system preference.',
    allowedValues: [
      { value: 'dark', label: 'Dark', description: 'Recommended — designed for this' },
      { value: 'light', label: 'Light', description: 'Supported but less polished' },
      { value: 'auto', label: 'Auto', description: 'Follows system preference' },
    ],
    defaultValue: 'dark',
    dependencies: [],
    sideEffects: ['Affects all pages and panels'],
    destructive: false,
    hitlRequired: false,
    keywords: ['dark mode', 'light mode', 'palette', 'colour scheme'],
  },

  // ─────────────────────────────────────────────────────────────── VOICE
  {
    id: 'voice.enabled',
    section: 'voice',
    label: 'Voice I/O Enabled',
    type: 'toggle',
    shortDescription: 'Master switch for speech input and text-to-speech output.',
    explanation: 'When enabled, agents can speak responses aloud and accept voice commands via Whisper STT. Requires API keys for Whisper (OpenAI) and ElevenLabs (TTS). If keys are missing, voice will fail silently — check the Vault.',
    defaultValue: true,
    dependencies: ['voice.agentVoices', 'vault.openai', 'vault.elevenlabs'],
    sideEffects: ['Enables microphone permission request', 'Triggers TTS on every agent response', 'Increases API costs'],
    destructive: false,
    hitlRequired: false,
    keywords: ['speech', 'tts', 'stt', 'whisper', 'elevenlabs', 'microphone'],
  },
  {
    id: 'voice.agentVoices',
    section: 'voice',
    label: 'Per-Agent Voice Assignment',
    type: 'list',
    shortDescription: 'Which ElevenLabs voice each agent uses.',
    explanation: 'Every agent can have a unique voice drawn from the 20-voice ElevenLabs catalog. REGULA defaults to British Female 1 (Confident). Voice choice affects perceived authority — match the voice to the agent role.',
    defaultValue: {},
    dependencies: ['voice.enabled'],
    sideEffects: ['Takes effect on next TTS call'],
    destructive: false,
    hitlRequired: false,
    keywords: ['voice', 'voices', 'elevenlabs', 'per-agent', 'assignment'],
  },

  // ───────────────────────────────────────────────────────────── PLUGINS
  {
    id: 'plugins.volt',
    section: 'plugins',
    label: 'VOLT (Verifiable Operations Ledger)',
    type: 'toggle',
    shortDescription: 'Hash-chained tamper-evident receipts for every agent action.',
    explanation: 'VOLT wraps every agent action, settings change, and audit event into a hash-chained ledger. Disabling it breaks the compliance evidence pipeline: WARD seals, AOCL Layer 6, AUD-UX evidence bundles, and the tamper-evident config history all depend on VOLT. Do not disable this unless you have explicit guidance from an auditor.',
    defaultValue: true,
    dependencies: ['plugins.ward', 'plugins.aocl', 'plugins.auditus'],
    sideEffects: ['WARD seal chain breaks', 'AOCL Layer 6 (Configuration Plane) goes dark', 'Audit trail loses tamper-evidence', 'Compliance reports show gap', 'Evidence bundles become unverifiable'],
    destructive: true,
    hitlRequired: true,
    keywords: ['volt', 'audit', 'compliance', 'ledger', 'receipt', 'hash chain', 'tamper evident'],
  },
  {
    id: 'plugins.ward',
    section: 'plugins',
    label: 'WARD (Write-once Append-only Receipt Digests)',
    type: 'toggle',
    shortDescription: 'Daily cryptographic seals over the VOLT chain.',
    explanation: 'WARD produces daily seals that witness the VOLT chain. Without WARD, your evidence bundles cannot be independently verified after the fact. Required for SOC2, ISO 27001, and EU AI Act attestation workflows.',
    defaultValue: true,
    dependencies: ['plugins.volt'],
    sideEffects: ['Daily seal cron stops', 'Evidence bundles cannot be verified externally', 'Auditor portal loses seal badges'],
    destructive: true,
    hitlRequired: true,
    keywords: ['ward', 'seal', 'witness', 'daily', 'attestation', 'compliance'],
  },
  {
    id: 'plugins.sentinel',
    section: 'plugins',
    label: 'WARDEN (Security Agent)',
    type: 'toggle',
    shortDescription: 'Security monitoring and threat review agent.',
    explanation: 'WARDEN watches for security incidents, reviews inbox items for risk, and scans fleet hosts for anomalies. Disabling it removes security tooling from every surface that uses it (Inbox, Bastion, Command Center).',
    defaultValue: true,
    dependencies: [],
    sideEffects: ['Security lane disappears from Inbox', 'Threat review tools become unavailable', 'Scheduled security scans stop'],
    destructive: false,
    hitlRequired: false,
    keywords: ['sentinel', 'security', 'threat', 'incident', 'scan'],
  },

  // ────────────────────────────────────────────────────────────── BACKUP
  {
    id: 'backup.enabled',
    section: 'backup',
    label: 'Automatic Backups',
    type: 'toggle',
    shortDescription: 'Whether scheduled backups run on their own.',
    explanation: 'With automatic backups enabled, QuoxCORE snapshots SQLite databases, memory stores, and configuration on the configured schedule. Disabling means you must run backups manually — a one-way door for data loss if you forget.',
    defaultValue: true,
    dependencies: ['backup.schedule', 'backup.retention'],
    sideEffects: ['Cron job stops', 'No new restore points created', 'Compliance posture degrades'],
    destructive: true,
    hitlRequired: true,
    keywords: ['backup', 'auto backup', 'scheduled backup', 'data loss'],
  },
  {
    id: 'backup.schedule',
    section: 'backup',
    label: 'Backup Schedule',
    type: 'choice',
    shortDescription: 'How often automatic backups run.',
    explanation: 'Controls the cron expression for the backup job. Daily is the standard recommendation. Hourly is only advised for high-change environments with ample disk. Weekly misses too much data for compliance use.',
    allowedValues: [
      { value: 'hourly', label: 'Hourly', description: 'High change rate, ample disk' },
      { value: 'daily', label: 'Daily', description: 'Recommended default' },
      { value: 'weekly', label: 'Weekly', description: 'Not advised for compliance' },
    ],
    defaultValue: 'daily',
    dependencies: ['backup.enabled', 'backup.retention', 'general.timezone'],
    sideEffects: ['Changes the backup cron expression', 'Times interpreted against the general.timezone setting'],
    destructive: false,
    hitlRequired: false,
    keywords: ['schedule', 'cron', 'frequency', 'backup schedule'],
  },
  {
    id: 'backup.retention',
    section: 'backup',
    label: 'Backup Retention',
    type: 'number',
    shortDescription: 'How many days of backups to keep before pruning.',
    explanation: 'The backup pruner deletes snapshots older than this. Compliance frameworks typically require 90-365 days. Setting a short retention is a one-way door — deleted snapshots cannot be recovered.',
    defaultValue: 90,
    dependencies: ['backup.enabled', 'backup.schedule'],
    sideEffects: ['Old snapshots deleted on next prune cycle', 'Reducing retention is destructive'],
    destructive: true,
    hitlRequired: true,
    keywords: ['retention', 'keep', 'prune', 'delete old'],
  },

  // ─────────────────────────────────────────────────────────────── VAULT
  {
    id: 'vault.listing',
    section: 'vault',
    label: 'Integrations Vault',
    type: 'info',
    shortDescription: 'Encrypted store for integration credentials.',
    explanation: 'The Vault holds API keys for Anthropic, OpenAI, ElevenLabs, Stripe, Telegram, and every plugin that needs a credential. REGULA can list what is stored and test connectivity, but never reveals raw secret values. Revoking a credential is a destructive action and routes through HITL.',
    defaultValue: null,
    dependencies: ['plugins.volt'],
    sideEffects: [],
    destructive: false,
    hitlRequired: false,
    keywords: ['vault', 'secrets', 'credentials', 'api keys', 'integrations'],
  },

  // ────────────────────────────────────────────────────────── NOTIFICATIONS
  {
    id: 'notifications.channels',
    section: 'notifications',
    label: 'Notification Channels',
    type: 'list',
    shortDescription: 'Which channels receive alerts and inbox notifications.',
    explanation: 'Supports Telegram, Slack, email, and in-app. Each channel has its own credential in the Vault. Disabling a channel means any notification routed to it is silently dropped — check the routing rules first.',
    defaultValue: ['in-app'],
    dependencies: ['vault.telegram', 'vault.slack', 'vault.smtp'],
    sideEffects: ['Notifications routed to disabled channels are dropped', 'Inbox items still created'],
    destructive: false,
    hitlRequired: false,
    keywords: ['notifications', 'alerts', 'channels', 'telegram', 'slack', 'email'],
  },
  {
    id: 'notifications.quietHours',
    section: 'notifications',
    label: 'Quiet Hours',
    type: 'text',
    shortDescription: 'Time window when non-critical notifications are suppressed.',
    explanation: 'During quiet hours, only critical alerts (DEFCON RED, security incidents, backup failures) are delivered. Everything else queues for the next active window. Times are interpreted against your general.timezone setting.',
    defaultValue: '22:00-07:00',
    dependencies: ['general.timezone', 'notifications.channels'],
    sideEffects: ['Non-critical alerts delayed until window ends', 'Critical alerts always deliver'],
    destructive: false,
    hitlRequired: false,
    keywords: ['quiet', 'do not disturb', 'dnd', 'night mode', 'suppress'],
  },

  // ──────────────────────────────────────────────────────────── PRIVACY
  {
    id: 'privacy.dataRetention',
    section: 'privacy',
    label: 'Data Retention Period',
    type: 'number',
    shortDescription: 'How many days to keep conversation history and memory entries.',
    explanation: 'Controls the maximum age of conversation logs, memory facts, and episodic records before automatic deletion. Short retention limits GDPR exposure but also limits what agents can remember about you. Compliance-regulated orgs typically set 365-730 days.',
    defaultValue: 365,
    dependencies: ['plugins.volt'],
    sideEffects: ['Older records deleted on next retention sweep', 'Memory recall degrades below 90 days'],
    destructive: true,
    hitlRequired: true,
    keywords: ['retention', 'gdpr', 'delete', 'history', 'memory age'],
  },
  {
    id: 'privacy.cookieConsent',
    section: 'privacy',
    label: 'Cookie Consent',
    type: 'choice',
    shortDescription: 'How cookies are handled on first visit.',
    explanation: 'Essential only is the safest default — no analytics or marketing cookies are set. Full consent enables product analytics for improving QuoxCORE. Neither option sends data to third-party ad networks.',
    allowedValues: [
      { value: 'essential', label: 'Essential only', description: 'No analytics' },
      { value: 'analytics', label: 'Analytics', description: 'Product analytics only' },
      { value: 'full', label: 'Full', description: 'All first-party cookies' },
    ],
    defaultValue: 'essential',
    dependencies: ['privacy.telemetry'],
    sideEffects: ['Analytics collection respects this setting'],
    destructive: false,
    hitlRequired: false,
    keywords: ['cookie', 'consent', 'gdpr', 'analytics'],
  },

  // ────────────────────────────────────────────────────────── TELEMETRY
  {
    id: 'telemetry.enabled',
    section: 'telemetry',
    label: 'Diagnostic Telemetry',
    type: 'toggle',
    shortDescription: 'Anonymised crash reports and usage metrics.',
    explanation: 'Sends anonymised diagnostic pings to help us fix bugs faster. No message content, no memory entries, no credentials — only crash signatures, feature usage counts, and performance metrics. Opt out any time.',
    defaultValue: true,
    dependencies: ['privacy.cookieConsent'],
    sideEffects: ['Stops diagnostic pings', 'Crash reports no longer submitted'],
    destructive: false,
    hitlRequired: false,
    keywords: ['telemetry', 'diagnostic', 'crash reports', 'usage', 'metrics'],
  },

  // ──────────────────────────────────────────────────────────── LICENCE
  {
    id: 'license.status',
    section: 'license',
    label: 'Licence Status',
    type: 'info',
    shortDescription: 'Current licence tier, expiry, and active features.',
    explanation: 'Shows your active licence tier (Free, Premium, Enterprise), days remaining, and which features are unlocked. REGULA flags licences expiring within 30 days in the daily drift watchdog sweep.',
    defaultValue: null,
    dependencies: [],
    sideEffects: [],
    destructive: false,
    hitlRequired: false,
    keywords: ['licence', 'license', 'tier', 'expire', 'features'],
  },
];

// ────────────────────────────────────────────────────── Query helpers

const byId = new Map(SETTINGS_REGISTRY.map(s => [s.id, s]));
const bySection = SETTINGS_REGISTRY.reduce((acc, s) => {
  (acc[s.section] = acc[s.section] || []).push(s);
  return acc;
}, {});

export function getSetting(id) {
  return byId.get(id) || null;
}

export function getSettingsBySection(section) {
  return bySection[section] || [];
}

export function getAllSections() {
  return Object.keys(bySection).sort();
}

export function getDestructiveSettings() {
  return SETTINGS_REGISTRY.filter(s => s.destructive);
}

export function getHitlRequiredSettings() {
  return SETTINGS_REGISTRY.filter(s => s.hitlRequired);
}

/**
 * Natural-language search. Scores every setting against the query
 * and returns the top matches ranked by score.
 *
 * Used by REGULA to answer "find me settings related to compliance" etc.
 */
export function searchSettings(query, { limit = 10 } = {}) {
  const q = (query || '').toLowerCase().trim();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);

  const scored = SETTINGS_REGISTRY.map(setting => {
    let score = 0;
    const haystack = [
      setting.id,
      setting.label,
      setting.section,
      setting.shortDescription,
      setting.explanation,
      ...(setting.keywords || []),
    ].join(' ').toLowerCase();

    for (const term of terms) {
      if (haystack.includes(term)) score += 10;
      if (setting.label.toLowerCase().includes(term)) score += 15;
      if (setting.id.toLowerCase().includes(term)) score += 8;
      if ((setting.keywords || []).some(k => k.toLowerCase() === term)) score += 12;
    }

    return { setting, score };
  });

  return scored
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(x => x.setting);
}

/**
 * Walk the dependency graph for a given setting.
 * Returns { upstream, downstream } arrays of related settings.
 *
 * Used by REGULA to answer "if I change X, what notices?"
 */
export function getDependencyGraph(settingId) {
  const setting = byId.get(settingId);
  if (!setting) return { upstream: [], downstream: [] };

  const upstream = (setting.dependencies || [])
    .map(id => byId.get(id))
    .filter(Boolean);

  const downstream = SETTINGS_REGISTRY.filter(s =>
    (s.dependencies || []).includes(settingId)
  );

  return { upstream, downstream };
}

/**
 * Explain a setting in plain English for REGULA's chat responses.
 * Returns a structured block that the agent can render directly.
 */
export function explainSetting(settingId) {
  const setting = byId.get(settingId);
  if (!setting) return null;

  const { upstream, downstream } = getDependencyGraph(settingId);

  return {
    id: setting.id,
    label: setting.label,
    section: setting.section,
    type: setting.type,
    summary: setting.shortDescription,
    explanation: setting.explanation,
    default: setting.defaultValue,
    allowedValues: setting.allowedValues || null,
    destructive: setting.destructive,
    hitlRequired: setting.hitlRequired,
    dependencies: {
      upstream: upstream.map(s => ({ id: s.id, label: s.label, section: s.section })),
      downstream: downstream.map(s => ({ id: s.id, label: s.label, section: s.section })),
    },
    sideEffects: setting.sideEffects || [],
  };
}

export default SETTINGS_REGISTRY;
