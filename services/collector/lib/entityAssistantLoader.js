/**
 * Entity Assistant Loader
 *
 * Reads entity assistant JSON files from src/config/entities/assistants/
 * and provides system prompt construction for any agent — hardcoded or custom.
 *
 * This is the single source of truth for agent identity, rules, and personality.
 * Both the frontend (display) and collector (system prompt) use the same entity JSON.
 *
 * Usage:
 *   const { loadAssistants, getAssistantPrompt } = require('./entityAssistantLoader');
 *   loadAssistants();  // call once at startup
 *   const prompt = await getAssistantPrompt('imagesq');
 */

const fs = require('fs');
const path = require('path');
const { readPersona } = require('./personaReader');

const ASSISTANTS_PATH = path.join(__dirname, '../../../src/config/entities/assistants');

// Cache: agentId → parsed assistant data
const _cache = new Map();

/**
 * Load all assistant entity JSON files into cache.
 * Call once at startup. Returns count of loaded assistants.
 */
function loadAssistants(basePath) {
  const dir = basePath || ASSISTANTS_PATH;
  _cache.clear();

  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch (err) {
    console.error(`[EntityAssistantLoader] Failed to read ${dir}: ${err.message}`);
    return 0;
  }

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), 'utf8');
      const data = JSON.parse(raw);
      if (data.id) {
        _cache.set(data.id.toLowerCase(), data);
      }
    } catch (err) {
      console.warn(`[EntityAssistantLoader] Failed to parse ${file}: ${err.message}`);
    }
  }

  console.log(`[EntityAssistantLoader] Loaded ${_cache.size} assistant entities`);
  return _cache.size;
}

/**
 * Get the raw assistant entity data for an agent.
 * @param {string} agentId
 * @returns {object|null}
 */
function getAssistant(agentId) {
  return _cache.get((agentId || '').toLowerCase()) || null;
}

/**
 * Build a system prompt from the assistant entity JSON, merged with the
 * agent's persona.md file (if present).
 *
 * Composition order:
 *   1. Entity JSON identity block:
 *      - systemPromptAdditions (identity + domain guidance)
 *      - personality traits (tone guidance)
 *      - rules.always (behavioural directives)
 *      - rules.never (guardrails)
 *   2. Persona block appended at the end (fresh disk read — no caching):
 *      ## Persona
 *      <content of personas/<agentId>.md>
 *
 * If the persona file does not exist, step 2 is omitted entirely (no header).
 *
 * @param {string} agentId
 * @returns {Promise<string|null>} System prompt block, or null if agent not found
 */
// Written voice rules every Quox agent inherits, regardless of persona.
const HOUSE_VOICE = `
## House voice (all Quox agents)
- Never use em dashes or double hyphens in prose. Use commas, periods, parentheses, or a colon instead.
- Write plain, direct sentences. Avoid stock AI phrasing: no "delve", no "it's not just X, it's Y" framing, no padded three-item lists.
- Sound like a capable colleague, not a press release.`;

async function getAssistantPrompt(agentId) {
  const data = getAssistant(agentId);
  if (!data) return null;

  const parts = [];

  // Identity & domain guidance
  const additions = data.context?.systemPromptAdditions;
  if (additions) {
    parts.push(additions);
  }

  // Personality
  const personality = data.identity?.personality;
  if (personality?.tone) {
    parts.push(`\nTone: ${personality.tone}`);
  }

  // Rules — always
  const always = data.rules?.always;
  if (Array.isArray(always) && always.length > 0) {
    parts.push(`\nAlways:\n${always.map(r => `- ${r}`).join('\n')}`);
  }

  // Rules — never
  const never = data.rules?.never;
  if (Array.isArray(never) && never.length > 0) {
    parts.push(`\nNever:\n${never.map(r => `- ${r}`).join('\n')}`);
  }

  // Persona — fresh disk read per call, no caching
  const personaText = await readPersona((agentId || '').toLowerCase());
  if (personaText) {
    parts.push(`\n## Persona\n${personaText}`);
  }

  // House voice: applies to every agent on every surface (owner rule 2026-07-19).
  // Bare minimum by design; expand only with owner-identified signals.
  parts.push(HOUSE_VOICE);

  return parts.join('\n');
}

/**
 * List all loaded assistant IDs.
 * @returns {string[]}
 */
function listAssistants() {
  return Array.from(_cache.keys());
}

module.exports = {
  loadAssistants,
  getAssistant,
  getAssistantPrompt,
  listAssistants,
  HOUSE_VOICE,  // QuoxIdentity custom-attach fix Part A: reused by the collector's
                // custom (DB) assistant kit fallback (agentAttachKit.js) so a
                // custom assistant's rendered prompt carries the same house-voice
                // rules a static core agent's does.
  _cache  // exposed for testing
};
