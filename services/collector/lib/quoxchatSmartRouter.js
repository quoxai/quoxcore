/**
 * QuoxChat Smart Router — CW-12.1
 *
 * Classifies a visitor message into one of four tiers and picks the model
 * that should answer it. Rule-based so it adds zero latency and zero cost
 * — a separate LLM classifier would eat the savings we're trying to capture.
 *
 * Tiers:
 *   simple  — greetings, thanks, yes/no, tiny questions → cheapest model.
 *   mid     — ordinary questions → default model.
 *   tool    — message that should invoke a configured widget tool →
 *             tool-capable model (same as mid by default, here for audit).
 *   complex — long, multi-question, or code-containing → top-tier model.
 */

// QUOXCHAT-BRUTALOOP ITER 1: greetings / thanks are simple only when they
// are the WHOLE message. Prefix-only matching sent "Hi, which plan for 10
// people?" to the cheapest model (wave-1 audit P01).
const SIMPLE_PATTERNS = [
  /^\s*(hi|hello|hey|hiya|howdy)(\s+(there|all|team|everyone|again))?[\s!.,]*$/i,
  /^\s*(good\s+(morning|afternoon|evening|day))(\s+(there|all|team|everyone))?[\s!.,]*$/i,
  /^\s*(thanks?(\s+you)?(\s+(so|very)\s+much)?|cheers|ta|thx|bye|goodbye|see\s+ya)[\s!.,]*$/i,
  /^\s*(yes|no|ok|okay|sure|nope|yep)\b[!?. ]*$/i,
];

const TOOL_TRIGGER_PATTERNS = [
  /\b(check|look\s*up|find|get|fetch|query|search|capture|save|register|redirect|open|transfer|hand\s*off|connect)\b/i,
  /\border\s+(#|number\s|id\s)?[\w-]+/i,
  /\b(email|phone|contact|lead)\b.*@/i,
];

function classifyIntent(message, opts = {}) {
  const text = String(message || '');
  const trimmed = text.trim();
  const toolNames = Array.isArray(opts.toolNames) ? opts.toolNames : [];
  const len = trimmed.length;

  // Safety: empty / whitespace → simple.
  if (len === 0) return { tier: 'simple', reason: 'empty_message' };

  // Length cap — anything over ~500 chars is probably a multi-topic ask.
  if (len > 500) return { tier: 'complex', reason: 'length_over_500' };

  // Code block → complex.
  if (/```[\s\S]+```/.test(text) || /`[^`]{30,}`/.test(text)) {
    return { tier: 'complex', reason: 'code_block' };
  }

  // Multi-question (count question marks in standalone sentences)
  const qMarks = (trimmed.match(/\?/g) || []).length;
  if (qMarks >= 3) return { tier: 'complex', reason: 'multi_question' };

  // Fast path: simple.
  for (const re of SIMPLE_PATTERNS) {
    if (re.test(trimmed)) return { tier: 'simple', reason: 'fast_path_simple' };
  }
  if (len <= 20 && !/[?!.]/.test(trimmed)) return { tier: 'simple', reason: 'short_phrase' };
  if (len <= 12) return { tier: 'simple', reason: 'very_short' };

  // Tool signals — only bump to tool tier if the widget has tools configured.
  if (toolNames.length > 0) {
    // Direct mention of a tool name by its identifier.
    for (const name of toolNames) {
      if (name && new RegExp(`\\b${name.replace(/[^\w]/g, '')}\\b`, 'i').test(text)) {
        return { tier: 'tool', reason: `mentioned_tool:${name}` };
      }
    }
    for (const re of TOOL_TRIGGER_PATTERNS) {
      if (re.test(text)) return { tier: 'tool', reason: 'tool_trigger_phrase' };
    }
  }

  // Default.
  return { tier: 'mid', reason: 'default' };
}

const DEFAULT_TIER_MAP = {
  anthropic: {
    simple: 'claude-haiku-4-5-20251001',
    mid: 'claude-haiku-4-5-20251001',
    tool: 'claude-haiku-4-5-20251001',
    complex: 'claude-sonnet-4-5-20251001',
  },
  openai: {
    simple: 'gpt-4.1-nano',
    mid: 'gpt-4.1-mini',
    tool: 'gpt-4.1-mini',
    complex: 'gpt-4.1',
  },
  gemini: {
    simple: 'gemini-2.5-flash',
    mid: 'gemini-2.5-flash',
    tool: 'gemini-2.5-flash',
    complex: 'gemini-2.5-pro',
  },
};

// LLM-CHOICE 3.2c: providers outside {anthropic, openai, gemini} (e.g. a
// future 'local' provider) have no entry in DEFAULT_TIER_MAP. Rather than
// silently reusing the anthropic table for them, prefer the widget's own
// map first (unchanged), and only fall back to anthropic as a last resort —
// logging a warning once per unmapped provider (not per call) so operators
// notice the gap without flooding logs on every chat message.
const _warnedUnmappedProviders = new Set();

function pickModelForTier(tier, widgetTierMap, provider) {
  if (widgetTierMap && typeof widgetTierMap === 'object' && widgetTierMap[tier]) {
    return widgetTierMap[tier];
  }

  const providerFallback = DEFAULT_TIER_MAP[provider];
  if (!providerFallback && provider && !_warnedUnmappedProviders.has(provider)) {
    _warnedUnmappedProviders.add(provider);
    console.warn(
      `[quoxchatSmartRouter] pickModelForTier: no tier map for provider "${provider}" — ` +
      `falling back to anthropic defaults. Add a widget-level tier map or extend DEFAULT_TIER_MAP.`
    );
  }

  const resolvedFallback = providerFallback || DEFAULT_TIER_MAP.anthropic;
  return resolvedFallback[tier] || resolvedFallback.mid;
}

// Test-only: clear the warn-once dedupe set between test cases.
function _resetUnmappedProviderWarnings() {
  _warnedUnmappedProviders.clear();
}

module.exports = {
  classifyIntent,
  pickModelForTier,
  DEFAULT_TIER_MAP,
  SIMPLE_PATTERNS,
  TOOL_TRIGGER_PATTERNS,
  _resetUnmappedProviderWarnings,
};
