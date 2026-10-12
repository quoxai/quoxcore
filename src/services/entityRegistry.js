/**
 * Entity Registry Service
 *
 * Loads, manages, and provides query access to entity manifests.
 * Supports assistants, tools, and workflows.
 * Handles merging default manifests with user overrides.
 */

// Import all assistant manifests
import quoxManifest from '../config/entities/assistants/quox.json'
import architectManifest from '../config/entities/assistants/architect.json'
import linkedinManifest from '../config/entities/assistants/linkedin.json'
import facebookManifest from '../config/entities/assistants/facebook.json'
import instagramManifest from '../config/entities/assistants/instagram.json'
import tiktokManifest from '../config/entities/assistants/tiktok.json'
import xtwitterManifest from '../config/entities/assistants/xtwitter.json'
import youtubeManifest from '../config/entities/assistants/youtube.json'
import sentinelManifest from '../config/entities/assistants/sentinel.json'
import cipherManifest from '../config/entities/assistants/cipher.json'
import novaManifest from '../config/entities/assistants/nova.json'
import prismManifest from '../config/entities/assistants/prism.json'
import atlasManifest from '../config/entities/assistants/atlas.json'
import metricsManifest from '../config/entities/assistants/metrics.json'
import insightManifest from '../config/entities/assistants/insight.json'
import scholarManifest from '../config/entities/assistants/scholar.json'
import beaconManifest from '../config/entities/assistants/beacon.json'
import forgeManifest from '../config/entities/assistants/forge.json'
import gripeManifest from '../config/entities/assistants/gripe.json'
import gitqManifest from '../config/entities/assistants/gitq.json'
import bobManifest from '../config/entities/assistants/bob.json'
// QUOXIFY pass 1 (DEVSUITE phase 14): the dev-suite's two new conversational
// identities. Both MUST be registered here as well as in agentRegistry.js -
// this codebase has two agent sources and adding to only one makes an agent
// appear in some UIs and not others.
import loopQManifest from '../config/entities/assistants/loop-q.json'
import lucidManifest from '../config/entities/assistants/lucid.json'
import nucleusManifest from '../config/entities/assistants/nucleus.json'
import coreyManifest from '../config/entities/assistants/corey.json'
import archivistManifest from '../config/entities/assistants/archivist.json'
import testerManifest from '../config/entities/assistants/tester.json'
import netwatchManifest from '../config/entities/assistants/netwatch.json'
import quoxcodeManifest from '../config/entities/assistants/quoxcode.json'
import geminiManifest from '../config/entities/assistants/gemini.json'
import imagesqManifest from '../config/entities/assistants/imagesq.json'
import perplexityManifest from '../config/entities/assistants/perplexity.json'
import auditusManifest from '../config/entities/assistants/auditus.json'
import janusManifest from '../config/entities/assistants/janus.json'
import weaverManifest from '../config/entities/assistants/weaver.json'
import argusManifest from '../config/entities/assistants/argus.json'
import meshnetManifest from '../config/entities/assistants/meshnet.json'
import regulaManifest from '../config/entities/assistants/regula.json'
import roadyManifest from '../config/entities/assistants/roady.json'
import scoutManifest from '../config/entities/assistants/scout.json'
import inboxqManifest from '../config/entities/assistants/inboxq.json'
import notesqManifest from '../config/entities/assistants/notesq.json'
import contactsqManifest from '../config/entities/assistants/contactsq.json'
import calendarQManifest from '../config/entities/assistants/calendar-q.json'
import seerManifest from '../config/entities/assistants/seer.json'
import actionQManifest from '../config/entities/assistants/action-q.json'
import browserQManifest from '../config/entities/assistants/browser-q.json'
import triageQManifest from '../config/entities/assistants/triage-q.json'
import keeperManifest from '../config/entities/assistants/keeper.json'
import dockeragentManifest from '../config/entities/assistants/dockeragent.json'
import horusManifest from '../config/entities/assistants/horus.json'
import toolsmithManifest from '../config/entities/assistants/toolsmith.json'
import quartermasterManifest from '../config/entities/assistants/quartermaster.json'
import quoxflowManifest from '../config/entities/assistants/quoxflow.json'
import securityLeadManifest from '../config/entities/assistants/security_lead.json'
import reconSpecialistManifest from '../config/entities/assistants/recon_specialist.json'
import webSpecialistManifest from '../config/entities/assistants/web_specialist.json'
import findingsVerifierManifest from '../config/entities/assistants/findings_verifier.json'
import conciergeManifest from '../config/entities/assistants/concierge.json'
import quoxperticusManifest from '../config/entities/assistants/quoxperticus.json'
import cortexManifest from '../config/entities/assistants/cortex.json'
// QuoxVoice bundle census (no secret agents): the four voice-team agents.
// MUST also be registered in agentRegistry.js (dual source) or they appear in
// some UIs and not others, and never reach the public roster.
import receptionistqManifest from '../config/entities/assistants/receptionistq.json'
import seshaManifest from '../config/entities/assistants/sesha.json'
import voiceqManifest from '../config/entities/assistants/voiceq.json'
import outboundqManifest from '../config/entities/assistants/outboundq.json'

import { DEFAULT_LLM_CONFIG } from './llmService.js';
import { normalizeLlmPolicy } from './llmPolicy.js';

import { queueSync } from './serverSyncQueue'

const CONSOLIDATED_KEY = 'quox-entity-overrides'

// Old per-type storage keys (for migration)
const OLD_STORAGE_KEYS = {
  assistants: 'quox_assistant_overrides',
  tools: 'quox_tool_overrides',
  workflows: 'quox_workflow_overrides'
}
const STORAGE_KEYS = OLD_STORAGE_KEYS

let _entityOverrides = null

function getEntityOverrides() {
  if (_entityOverrides) return _entityOverrides
  try {
    const raw = localStorage.getItem(CONSOLIDATED_KEY)
    if (raw) {
      _entityOverrides = JSON.parse(raw)
      return _entityOverrides
    }
  } catch { /* fall through */ }

  // Migrate from old keys
  _entityOverrides = {}
  let migrated = false
  for (const [field, oldKey] of Object.entries(OLD_STORAGE_KEYS)) {
    try {
      const old = localStorage.getItem(oldKey)
      if (old) {
        _entityOverrides[field] = JSON.parse(old)
        localStorage.removeItem(oldKey)
        migrated = true
      } else {
        _entityOverrides[field] = {}
      }
    } catch {
      _entityOverrides[field] = {}
    }
  }
  if (migrated) {
    saveEntityOverrides()
    console.log('[EntityRegistry] Migrated from per-key to consolidated storage')
  }
  return _entityOverrides
}

function saveEntityOverrides() {
  try {
    localStorage.setItem(CONSOLIDATED_KEY, JSON.stringify(_entityOverrides))
    queueSync('entityOverrides', _entityOverrides)
  } catch (e) {
    console.error('Error saving entity overrides:', e)
  }
}

// Entity sources
export const ENTITY_SOURCES = {
  CORE: 'core',
  USER: 'user',
  SCOPE: 'scope',
  MARKETPLACE: 'marketplace',
  IMPORTED: 'imported'
}

// Visibility levels
export const VISIBILITY_LEVELS = {
  SYSTEM: 'system',
  ORGANIZATION: 'organization',
  DIVISION: 'division',
  TEAM: 'team',
  PRIVATE: 'private'
}

// Default assistant manifests (CORE entities)
const DEFAULT_ASSISTANTS = {
  quox: quoxManifest,
  architect: architectManifest,
  linkedin: linkedinManifest,
  facebook: facebookManifest,
  instagram: instagramManifest,
  tiktok: tiktokManifest,
  xtwitter: xtwitterManifest,
  youtube: youtubeManifest,
  sentinel: sentinelManifest,
  cipher: cipherManifest,
  nova: novaManifest,
  prism: prismManifest,
  atlas: atlasManifest,
  metrics: metricsManifest,
  insight: insightManifest,
  scholar: scholarManifest,
  beacon: beaconManifest,
  forge: forgeManifest,
  gripe: gripeManifest,
  gitq: gitqManifest,
  bob: bobManifest,
  'loop-q': loopQManifest,
  lucid: lucidManifest,
  nucleus: nucleusManifest,
  corey: coreyManifest,
  archivist: archivistManifest,
  tester: testerManifest,
  netwatch: netwatchManifest,
  quoxcode: quoxcodeManifest,
  gemini: geminiManifest,
  imagesq: imagesqManifest,
  perplexity: perplexityManifest,
  auditus: auditusManifest,
  janus: janusManifest,
  weaver: weaverManifest,
  argus: argusManifest,
  meshnet: meshnetManifest,
  regula: regulaManifest,
  roady: roadyManifest,
  scout: scoutManifest,
  inboxq: inboxqManifest,
  notesq: notesqManifest,
  contactsq: contactsqManifest,
  'calendar-q': calendarQManifest,
  seer: seerManifest,
  'action-q': actionQManifest,
  'browser-q': browserQManifest,
  'triage-q': triageQManifest,
  keeper: keeperManifest,
  dockeragent: dockeragentManifest,
  horus: horusManifest,
  toolsmith: toolsmithManifest,
  quartermaster: quartermasterManifest,
  quoxflow: quoxflowManifest,
  security_lead: securityLeadManifest,
  recon_specialist: reconSpecialistManifest,
  web_specialist: webSpecialistManifest,
  findings_verifier: findingsVerifierManifest,
  concierge: conciergeManifest,
  quoxperticus: quoxperticusManifest,
  cortex: cortexManifest,
  receptionistq: receptionistqManifest,
  sesha: seshaManifest,
  voiceq: voiceqManifest,
  outboundq: outboundqManifest
}

// Registry cache
let _assistantsCache = null
let _toolsCache = null
let _workflowsCache = null

// USER entities cache (keyed by orgId)
let _userAssistantsCache = {}

function parseEntityPersona(entity) {
  if (entity?.persona && typeof entity.persona === 'object') return entity.persona
  try {
    return JSON.parse(entity?.persona_json || '{}')
  } catch {
    return {}
  }
}

function normalizeEntityLlm(entity, persona = parseEntityPersona(entity)) {
  const topLevel = entity?.llm || {}
  return {
    ...DEFAULT_LLM_CONFIG,
    ...topLevel,
    provider: topLevel.provider || persona.provider || DEFAULT_LLM_CONFIG.provider,
    model: topLevel.model || persona.model || DEFAULT_LLM_CONFIG.model,
    temperature: topLevel.temperature ?? persona.temperature ?? DEFAULT_LLM_CONFIG.temperature,
    maxTokens: topLevel.maxTokens ?? persona.maxTokens ?? persona.max_tokens ?? DEFAULT_LLM_CONFIG.maxTokens
  }
}

function normalizeEntityLlmPolicy(entity) {
  return normalizeLlmPolicy(entity?.llmPolicy || entity?.config?.llmPolicy || entity?.llm?.policy || null, {
    entityId: entity?.id,
  })
}

export function normalizeApiAssistantEntity(entity, orgId = null) {
  const persona = parseEntityPersona(entity)
  const llm = normalizeEntityLlm(entity, persona)
  const llmPolicy = normalizeEntityLlmPolicy(entity)
  const source = entity.ownership?.source
    || (entity.home_scope_id ? ENTITY_SOURCES.SCOPE
      : entity.created_by ? ENTITY_SOURCES.USER : ENTITY_SOURCES.CORE)
  const ownership = {
    source,
    createdBy: entity.ownership?.createdBy || entity.created_by,
    orgId: entity.ownership?.orgId || orgId || entity.org_id || null,
    homeScopeId: entity.ownership?.homeScopeId || entity.home_scope_id || null,
    divisionId: entity.ownership?.divisionId || entity.division_id || null,
    teamId: entity.ownership?.teamId || entity.team_id || null,
    visibility: entity.ownership?.visibility || entity.visibility || VISIBILITY_LEVELS.ORGANIZATION
  }

  return {
    ...entity,
    type: 'assistant',
    persona,
    ownership,
    identity: {
      name: entity.name || 'Unnamed',
      shortName: persona.shortName || entity.name?.charAt(0) || 'A',
      tagline: entity.description || '',
      description: entity.description || '',
      personality: {
        tone: persona.personality?.tone || 'Professional and helpful',
        style: persona.personality?.style || 'detailed',
        traits: persona.personality?.traits || [],
        catchphrases: persona.personality?.catchphrases || []
      },
      color: {
        primary: persona.color || '#8b5cf6',
        secondary: '#1a1a2e'
      }
    },
    hierarchy: {
      role: persona.role || 'specialist',
      level: persona.level ?? 2,
      reportsTo: null,
      manages: []
    },
    capabilities: {
      domains: persona.domains || [persona.specialty].filter(Boolean),
      intents: [],
      toolAccess: 'none',
      toolCapabilities: persona.tools || [],
      workflows: []
    },
    rules: {
      always: persona.instructions || [],
      never: [],
      escalateTo: null
    },
    safety: {
      defconLevel: 'GREEN',
      requiresApproval: [],
      autoApproved: []
    },
    llm,
    llmPolicy,
    context: {
      systemPromptAdditions: persona.system_prompt || ''
    },
    ui: {
      settingsEnabled: true,
      visualizer: { type: 'commander-sigil', pulseSpeed: 'normal' },
      suggestions: []
    }
  }
}

export function buildRuntimeAssistantConfig(entity) {
  if (!entity) return null

  // Handle new-schema entities (identity + hierarchy nested structure)
  if (entity.identity && entity.hierarchy) {
    const colorObj = entity.identity?.color || entity.color || { primary: '#8b5cf6' }
    const colorRgb = typeof colorObj === 'object' ? (colorObj.rgb || null) : null
    const colorPrimary = typeof colorObj === 'object' ? (colorObj.primary || '#8b5cf6') : (colorObj || '#8b5cf6')
    const capsDomains = Array.isArray(entity.capabilities?.domains) ? entity.capabilities.domains : []
    return {
      id: entity.id,
      name: entity.identity?.name || entity.name || 'Unnamed',
      shortName: entity.identity?.shortName || entity.shortName || entity.name?.charAt(0) || 'A',
      systemPrompt: entity.context?.systemPromptAdditions || entity.systemPrompt || '',
      specialty: capsDomains[0] || entity.specialty || entity.identity?.tagline || entity.identity?.description || '',
      description: entity.identity?.description || entity.description || '',
      personality: entity.identity?.personality?.tone || '',
      voice: entity.voice || entity.persona?.voice || entity.identity?.personality?.voice || null,
      color: colorPrimary,
      colorRgb: colorRgb,
      role: entity.hierarchy?.role || entity.role || 'specialist',
      level: entity.hierarchy?.level ?? entity.level ?? 2,
      manages: entity.hierarchy?.manages || [],
      reportsTo: entity.hierarchy?.reportsTo || null,
      canDelegateTo: entity.hierarchy?.canDelegateTo || [],
      defconLevel: entity.safety?.defconLevel || 'GREEN',
      capabilities: capsDomains,
      llm: entity.llm ? { ...DEFAULT_LLM_CONFIG, ...entity.llm } : { ...DEFAULT_LLM_CONFIG },
      llmPolicy: normalizeLlmPolicy(entity.llmPolicy || entity.config?.llmPolicy || entity.llm?.policy || null, {
        entityId: entity.id,
      }),
    }
  }

  // Handle old-schema entities (agent_id / display_name format used by some legacy JSONs)
  if (entity.agent_id || entity.display_name) {
    const agentId = entity.agent_id || entity.id
    const capsDomains = Array.isArray(entity.capabilities?.domains) ? entity.capabilities.domains : []
    const colorStr = entity.color || '#8b5cf6'
    return {
      id: agentId,
      name: entity.display_name || entity.name || agentId,
      shortName: entity.short_name || entity.shortName || (entity.display_name || entity.name || agentId).charAt(0),
      systemPrompt: entity.system_prompt || entity.systemPrompt || '',
      specialty: capsDomains[0] || entity.specialty || entity.description || '',
      description: entity.description || '',
      personality: Array.isArray(entity.personality?.traits) ? entity.personality.traits.join(', ') : (entity.personality?.communication_style || ''),
      voice: entity.voice || null,
      color: colorStr,
      colorRgb: entity.colorRgb || null,
      role: entity.role || 'specialist',
      level: entity.level ?? 2,
      manages: entity.manages || [],
      reportsTo: entity.reportsTo || 'quox',
      canDelegateTo: entity.canDelegateTo || [],
      defconLevel: entity.safety?.defconLevel || 'GREEN',
      capabilities: capsDomains,
      llm: entity.llm ? { ...DEFAULT_LLM_CONFIG, ...entity.llm } : { ...DEFAULT_LLM_CONFIG },
      llmPolicy: normalizeEntityLlmPolicy(entity),
    }
  }

  // Handle API/legacy flat-schema entities
  const persona = parseEntityPersona(entity)
  return {
    id: entity.id,
    name: entity.name,
    shortName: persona.shortName || entity.shortName || entity.name?.charAt(0) || 'A',
    systemPrompt: persona.system_prompt || entity.systemPrompt || '',
    specialty: persona.specialty || entity.specialty || entity.description || '',
    description: entity.description || '',
    personality: persona.personality || (typeof entity.personality === 'string' ? entity.personality : ''),
    voice: persona.voice || entity.voice || null,
    color: persona.color || entity.color || '#8b5cf6',
    colorRgb: entity.colorRgb || null,
    role: persona.role || entity.role || 'specialist',
    level: persona.level ?? entity.level ?? 2,
    manages: entity.manages || [],
    reportsTo: entity.reportsTo || null,
    canDelegateTo: entity.canDelegateTo || [],
    defconLevel: entity.defconLevel || entity.safety?.defconLevel || 'GREEN',
    capabilities: Array.isArray(entity.capabilities) ? entity.capabilities : [],
    llm: normalizeEntityLlm(entity, persona),
    llmPolicy: normalizeEntityLlmPolicy(entity)
  }
}

export function getRuntimeAssistantConfig(id) {
  const assistant = getAssistant(id)
  return assistant ? buildRuntimeAssistantConfig(assistant) : null
}

export function clearCoreAssistantCache() {
  _assistantsCache = null
  _entityOverrides = null
}

/**
 * Load USER entities from API for a specific organization
 * @param {string} orgId - Organization ID
 * @param {Function} authFetch - Authenticated fetch function from AuthContext
 * @returns {Promise<Array>} - Array of user assistant entities
 */
export async function loadUserEntities(orgId, authFetch) {
  if (!orgId) return []

  // Check cache first
  if (_userAssistantsCache[orgId]) {
    return _userAssistantsCache[orgId]
  }

  try {
    const response = await authFetch(`/api/orgs/${orgId}/assistants`)
    if (!response.ok) return []

    const data = await response.json()
    const assistants = data.items || data.assistants || []

    // Transform to entity format with ownership
    const userEntities = assistants.map(a => normalizeApiAssistantEntity(a, orgId))

    // Cache the results
    _userAssistantsCache[orgId] = userEntities
    return userEntities
  } catch (err) {
    console.warn('Failed to load user entities:', err)
    return []
  }
}

/**
 * Clear USER entities cache (call when org changes or entities are modified)
 */
export function clearUserEntitiesCache(orgId = null) {
  if (orgId) {
    delete _userAssistantsCache[orgId]
  } else {
    _userAssistantsCache = {}
  }

  // Agent roster changed — invalidate the Mirror reflection cache so the
  // next read rebuilds instead of serving a stale snapshot. Dynamic import
  // avoids a static circular dependency (reflectionService imports
  // getAssistants from this module).
  import('./reflectionService').then(({ invalidateReflectionCache }) => {
    invalidateReflectionCache()
  }).catch(() => { /* fire-and-forget */ })
}

/**
 * Forbidden keys that could enable prototype pollution attacks
 */
const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype']

/**
 * Check if a key is safe (not a prototype pollution vector)
 * @param {string} key
 * @returns {boolean}
 */
function isSafeKey(key) {
  return !FORBIDDEN_KEYS.includes(key)
}

/**
 * Deep merge two objects, with source overriding target
 * Includes prototype pollution protection
 */
function deepMerge(target, source) {
  const result = { ...target }

  for (const key of Object.keys(source)) {
    // Skip dangerous keys to prevent prototype pollution
    if (!isSafeKey(key)) continue

    if (source[key] !== null && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key])
    } else if (source[key] !== undefined) {
      result[key] = source[key]
    }
  }

  return result
}

/**
 * Load user overrides from localStorage
 */
function loadOverrides(key) {
  const consolidated = getEntityOverrides()
  const field = Object.entries(OLD_STORAGE_KEYS).find(([, v]) => v === key)?.[0]
  return field ? (consolidated[field] || {}) : {}
}

/**
 * Save user overrides to localStorage
 */
function saveOverrides(key, overrides) {
  const consolidated = getEntityOverrides()
  const field = Object.entries(OLD_STORAGE_KEYS).find(([, v]) => v === key)?.[0]
  if (field) {
    consolidated[field] = overrides
    _entityOverrides = consolidated
    saveEntityOverrides()
    return true
  }
  return false
}

/**
 * Get merged assistants (defaults + user overrides)
 * Synchronous version - returns only CORE entities with localStorage overrides
 */
export function getAssistants() {
  if (_assistantsCache) return _assistantsCache

  const overrides = loadOverrides(STORAGE_KEYS.assistants)
  _assistantsCache = {}

  for (const [id, defaultManifest] of Object.entries(DEFAULT_ASSISTANTS)) {
    const userOverride = overrides[id] || {}
    const merged = deepMerge(defaultManifest, userOverride)

    // Ensure LLM config exists with defaults
    if (!merged.llm) {
      merged.llm = { ...DEFAULT_LLM_CONFIG }
    } else {
      // Merge with defaults to fill any missing fields
      merged.llm = { ...DEFAULT_LLM_CONFIG, ...merged.llm }
    }

    _assistantsCache[id] = merged
  }

  return _assistantsCache
}

/**
 * Get all assistants including USER entities from API
 * Async version that merges CORE + USER entities
 * @param {Object} options
 * @param {string} options.orgId - Organization ID (required for USER entities)
 * @param {Function} options.authFetch - Authenticated fetch function
 * @param {boolean} options.includeUser - Whether to include USER entities (default: true)
 * @param {string} options.source - Filter by source: 'core', 'user', or null for all
 * @returns {Promise<Object>} - Map of entity ID to entity
 */
export async function getAssistantsAsync(options = {}) {
  const { orgId, authFetch, includeUser = true, source = null } = options

  // Get CORE entities with localStorage overrides
  const coreEntities = getAssistants()

  // If filtering to user-only or no orgId, return appropriately
  if (source === ENTITY_SOURCES.USER) {
    if (!orgId || !authFetch) return {}
    const userEntities = await loadUserEntities(orgId, authFetch)
    const result = {}
    for (const entity of userEntities) {
      result[entity.id] = entity
    }
    return result
  }

  // If filtering to core-only, return just core
  if (source === ENTITY_SOURCES.CORE) {
    return { ...coreEntities }
  }

  // Merge CORE + USER
  const result = { ...coreEntities }

  if (includeUser && orgId && authFetch) {
    const userEntities = await loadUserEntities(orgId, authFetch)
    for (const entity of userEntities) {
      // USER entities can shadow CORE entities with same ID (unlikely but supported)
      // Use namespaced key to avoid collision with CORE entities
      const key = entity.id.startsWith('user_') ? entity.id : `user_${entity.id}`
      result[key] = entity
    }
  }

  return result
}

/**
 * Get entity source badge info
 */
export function getSourceBadge(entity) {
  const source = entity?.ownership?.source || ENTITY_SOURCES.CORE

  switch (source) {
    case ENTITY_SOURCES.CORE:
      return { label: 'CORE', color: '#8b5cf6', description: 'System entity' }
    case ENTITY_SOURCES.USER:
      return { label: 'USER', color: '#10b981', description: 'Custom entity' }
    case ENTITY_SOURCES.SCOPE:
      return { label: 'SCOPE', color: '#f59e0b', description: 'Scope assistant' }
    case ENTITY_SOURCES.MARKETPLACE:
      return { label: 'MARKET', color: '#f59e0b', description: 'Marketplace entity' }
    case ENTITY_SOURCES.IMPORTED:
      return { label: 'IMPORT', color: '#6366f1', description: 'Imported entity' }
    default:
      return { label: 'CORE', color: '#8b5cf6', description: 'System entity' }
  }
}

/**
 * Get a single assistant by ID
 */
export function getAssistant(id) {
  const assistants = getAssistants()
  return assistants[id] || null
}

/**
 * Get all assistants as array, optionally sorted
 * Synchronous version - CORE entities only
 */
export function listAssistants(options = {}) {
  const { sortBy = 'level', filter, source = null } = options
  let assistants = Object.values(getAssistants())

  // Filter by source if specified
  if (source) {
    assistants = assistants.filter(a => (a.ownership?.source || ENTITY_SOURCES.CORE) === source)
  }

  let result = assistants

  // Apply custom filter if provided
  if (filter) {
    result = result.filter(filter)
  }

  // Sort by specified field
  if (sortBy === 'level') {
    result.sort((a, b) => (a.hierarchy?.level ?? 99) - (b.hierarchy?.level ?? 99))
  } else if (sortBy === 'name') {
    result.sort((a, b) => (a.identity?.name || a.name || '').localeCompare(b.identity?.name || b.name || ''))
  } else if (sortBy === 'role') {
    const roleOrder = { orchestrator: 0, manager: 1, analyst: 2, specialist: 3 }
    result.sort((a, b) => (roleOrder[a.hierarchy?.role] || 99) - (roleOrder[b.hierarchy?.role] || 99))
  } else if (sortBy === 'source') {
    const sourceOrder = { core: 0, user: 1, marketplace: 2, imported: 3 }
    result.sort((a, b) => {
      const aSource = a.ownership?.source || ENTITY_SOURCES.CORE
      const bSource = b.ownership?.source || ENTITY_SOURCES.CORE
      return (sourceOrder[aSource] || 99) - (sourceOrder[bSource] || 99)
    })
  }

  return result
}

/**
 * Get all assistants as array (async version with USER entities)
 * @param {Object} options
 * @param {string} options.orgId - Organization ID
 * @param {Function} options.authFetch - Authenticated fetch function
 * @param {boolean} options.includeUser - Include USER entities
 * @param {string} options.source - Filter by source
 * @param {string} options.sortBy - Sort field
 * @param {Function} options.filter - Custom filter function
 * @returns {Promise<Array>}
 */
export async function listAssistantsAsync(options = {}) {
  const { orgId, authFetch, includeUser = true, source = null, sortBy = 'level', filter } = options

  const assistantsMap = await getAssistantsAsync({ orgId, authFetch, includeUser, source })
  let assistants = Object.values(assistantsMap)

  // Apply custom filter if provided
  if (filter) {
    assistants = assistants.filter(filter)
  }

  // Sort by specified field
  if (sortBy === 'level') {
    assistants.sort((a, b) => (a.hierarchy?.level ?? 99) - (b.hierarchy?.level ?? 99))
  } else if (sortBy === 'name') {
    assistants.sort((a, b) => (a.identity?.name || a.name || '').localeCompare(b.identity?.name || b.name || ''))
  } else if (sortBy === 'role') {
    const roleOrder = { orchestrator: 0, manager: 1, analyst: 2, specialist: 3 }
    assistants.sort((a, b) => (roleOrder[a.hierarchy?.role] || 99) - (roleOrder[b.hierarchy?.role] || 99))
  } else if (sortBy === 'source') {
    const sourceOrder = { core: 0, user: 1, marketplace: 2, imported: 3 }
    assistants.sort((a, b) => {
      const aSource = a.ownership?.source || ENTITY_SOURCES.CORE
      const bSource = b.ownership?.source || ENTITY_SOURCES.CORE
      return (sourceOrder[aSource] || 99) - (sourceOrder[bSource] || 99)
    })
  }

  return assistants
}

/**
 * Get assistants by role
 */
export function getAssistantsByRole(role) {
  return listAssistants({
    filter: a => a.hierarchy.role === role
  })
}

/**
 * Get assistants by level
 */
export function getAssistantsByLevel(level) {
  return listAssistants({
    filter: a => a.hierarchy.level === level
  })
}

/**
 * Get assistants managed by a specific assistant
 */
export function getManagedAssistants(managerId) {
  const manager = getAssistant(managerId)
  if (!manager || !manager.hierarchy.manages) return []

  return manager.hierarchy.manages.map(id => getAssistant(id)).filter(Boolean)
}

/**
 * Get the manager of an assistant
 */
export function getManager(assistantId) {
  const assistant = getAssistant(assistantId)
  if (!assistant || !assistant.hierarchy.reportsTo) return null

  return getAssistant(assistant.hierarchy.reportsTo)
}

/**
 * Get assistants that can handle a specific domain
 */
export function getAssistantsByDomain(domain) {
  return listAssistants({
    filter: a => a.capabilities.domains.includes(domain)
  })
}

/**
 * Get assistants that can handle a specific intent
 */
export function getAssistantsByIntent(intent) {
  return listAssistants({
    filter: a => a.capabilities.intents.some(i =>
      i === intent || intent.startsWith(i.replace('*', ''))
    )
  })
}

/**
 * Get assistants by DEFCON level
 */
export function getAssistantsByDefcon(level) {
  return listAssistants({
    filter: a => a.safety.defconLevel === level
  })
}

/**
 * Get the hierarchy tree starting from Quox
 * FLAT 2-tier structure: All core agents are level 1 and report directly to Quox
 * (reportsTo is preserved for escalation routing, not org chart)
 */
export function getHierarchyTree() {
  const quoxAgent = getAssistant('quox')
  if (!quoxAgent) return null

  const allAssistants = listAssistants()

  // Get all level 1 agents (everyone except quox in flat hierarchy)
  const coreAgents = allAssistants.filter(a => a.hierarchy?.level === 1)

  // Sort: managers first, then analysts, then specialists, then by name
  const roleOrder = { manager: 0, analyst: 1, specialist: 2 }
  coreAgents.sort((a, b) => {
    const aOrder = roleOrder[a.hierarchy?.role] ?? 99
    const bOrder = roleOrder[b.hierarchy?.role] ?? 99
    if (aOrder !== bOrder) return aOrder - bOrder
    return (a.identity?.name || '').localeCompare(b.identity?.name || '')
  })

  // Build flat 2-tier tree - all agents as direct children of Quox
  return {
    ...quoxAgent,
    children: coreAgents.map(a => ({ ...a, children: [] }))
  }
}

/**
 * Update an assistant's settings (user override)
 */
export function updateAssistant(id, updates) {
  const overrides = loadOverrides(STORAGE_KEYS.assistants)
  overrides[id] = deepMerge(overrides[id] || {}, updates)

  const saved = saveOverrides(STORAGE_KEYS.assistants, overrides)
  if (saved) {
    // Invalidate cache
    _assistantsCache = null
  }

  return saved ? getAssistant(id) : null
}

/**
 * Reset an assistant to default settings
 */
export function resetAssistant(id) {
  const overrides = loadOverrides(STORAGE_KEYS.assistants)
  delete overrides[id]

  const saved = saveOverrides(STORAGE_KEYS.assistants, overrides)
  if (saved) {
    _assistantsCache = null
  }

  return saved ? getAssistant(id) : null
}

/**
 * Reset all assistants to defaults
 */
export function resetAllAssistants() {
  const consolidated = getEntityOverrides()
  consolidated.assistants = {}
  _entityOverrides = consolidated
  saveEntityOverrides()
  _assistantsCache = null
  return true
}

/**
 * Check if an assistant has user overrides
 */
export function hasOverrides(id) {
  const overrides = loadOverrides(STORAGE_KEYS.assistants)
  return id in overrides
}

/**
 * Get user overrides for an assistant (for diff display)
 */
export function getOverrides(id) {
  const overrides = loadOverrides(STORAGE_KEYS.assistants)
  return overrides[id] || null
}

/**
 * Generate self-knowledge markdown for an assistant
 * Used for context injection into LLM calls
 */
export function generateSelfKnowledge(assistantId) {
  const assistant = getAssistant(assistantId)
  if (!assistant) return ''

  const lines = [
    `## Your Identity: ${assistant.identity.name}`,
    '',
    assistant.identity.description,
    '',
    `**Tagline:** ${assistant.identity.tagline}`,
    `**Role:** ${assistant.hierarchy.role} (Level ${assistant.hierarchy.level})`,
    `**Reports to:** ${assistant.hierarchy.reportsTo || 'None'}`,
    ''
  ]

  // Personality
  lines.push('### Personality')
  lines.push(`- **Tone:** ${assistant.identity.personality.tone}`)
  lines.push(`- **Style:** ${assistant.identity.personality.style}`)
  lines.push(`- **Traits:** ${assistant.identity.personality.traits.join(', ')}`)
  lines.push('')

  // Capabilities
  lines.push('### Your Capabilities')
  lines.push(`- **Domains:** ${assistant.capabilities.domains.join(', ')}`)
  lines.push(`- **Tool Access:** ${assistant.capabilities.toolAccess}`)
  if (assistant.capabilities.toolCapabilities?.length) {
    lines.push(`- **Tool Capabilities:** ${assistant.capabilities.toolCapabilities.join(', ')}`)
  }
  if (assistant.capabilities.workflows?.length) {
    lines.push(`- **Workflows:** ${assistant.capabilities.workflows.join(', ')}`)
  }
  lines.push('')

  // Hierarchy - collaboration (flat structure)
  if (assistant.hierarchy.collaboratesWith?.length) {
    lines.push('### Collaboration Partners')
    lines.push('You frequently work with:')
    for (const partnerId of assistant.hierarchy.collaboratesWith) {
      const partner = getAssistant(partnerId)
      if (partner) {
        lines.push(`- **${partner.identity.name}**: ${partner.identity.tagline}`)
      }
    }
    lines.push('')
  }

  // Only show canDelegateTo for orchestrator (Quox)
  if (assistant.hierarchy.canDelegateTo?.length && assistant.hierarchy.role === 'orchestrator') {
    lines.push('### Can Delegate To')
    lines.push(assistant.hierarchy.canDelegateTo.map(id => {
      const a = getAssistant(id)
      return a ? a.identity.name : id
    }).join(', '))
    lines.push('')
  }

  // Rules
  lines.push('### Your Rules')
  lines.push('')
  lines.push('**ALWAYS:**')
  for (const rule of assistant.rules.always) {
    lines.push(`- ${rule}`)
  }
  lines.push('')
  lines.push('**NEVER:**')
  for (const rule of assistant.rules.never) {
    lines.push(`- ${rule}`)
  }
  lines.push('')

  if (assistant.rules.escalateTo) {
    lines.push(`**Escalate to ${assistant.rules.escalateTo.agent.toUpperCase()} when:**`)
    for (const trigger of assistant.rules.escalateTo.when) {
      lines.push(`- ${trigger}`)
    }
    lines.push('')
  }

  // Safety
  lines.push('### Safety Level')
  lines.push(`- **DEFCON:** ${assistant.safety.defconLevel}`)
  if (assistant.safety.requiresApproval?.length) {
    lines.push(`- **Requires Approval:** ${assistant.safety.requiresApproval.join(', ')}`)
  }
  if (assistant.safety.autoApproved?.length) {
    lines.push(`- **Auto-Approved:** ${assistant.safety.autoApproved.join(', ')}`)
  }
  lines.push('')

  // LLM Configuration
  if (assistant.llm) {
    lines.push('### LLM Configuration')
    lines.push(`- **Provider:** ${assistant.llm.provider}`)
    lines.push(`- **Model:** ${assistant.llm.model}`)
    if (assistant.llm.temperature !== undefined) {
      lines.push(`- **Temperature:** ${assistant.llm.temperature}`)
    }
    if (assistant.llm.maxTokens !== undefined) {
      lines.push(`- **Max Tokens:** ${assistant.llm.maxTokens}`)
    }
    lines.push('')
  }

  // Catchphrases
  if (assistant.identity.personality.catchphrases?.length) {
    lines.push('### Signature Phrases')
    lines.push('Use these occasionally:')
    for (const phrase of assistant.identity.personality.catchphrases) {
      lines.push(`- "${phrase}"`)
    }
    lines.push('')
  }

  // Additional context
  if (assistant.context.systemPromptAdditions) {
    lines.push('### Additional Context')
    lines.push(assistant.context.systemPromptAdditions)
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * Generate compact identity card for quick reference
 */
export function generateIdentityCard(assistantId) {
  const assistant = getAssistant(assistantId)
  if (!assistant) return null

  return generateIdentityCardFromEntity(assistant)
}

/**
 * Generate identity card from an entity object directly
 * Supports both CORE and USER entity formats
 */
export function generateIdentityCardFromEntity(entity) {
  if (!entity) return null

  // Handle both CORE format (nested identity/hierarchy) and USER format (flat)
  const isFlat = !entity.identity

  return {
    id: entity.id,
    name: isFlat ? entity.name : entity.identity?.name,
    shortName: isFlat ? (entity.short_name || entity.name?.charAt(0)) : entity.identity?.shortName,
    tagline: isFlat ? entity.tagline : entity.identity?.tagline,
    description: isFlat ? entity.description : entity.identity?.description,
    role: isFlat ? entity.role : entity.hierarchy?.role,
    level: isFlat ? (entity.level ?? 2) : (entity.hierarchy?.level ?? 2),
    color: isFlat ? (entity.color || '#8b5cf6') : (entity.identity?.color?.primary || '#8b5cf6'),
    domains: isFlat ? (entity.domains || []) : (entity.capabilities?.domains || []),
    defcon: isFlat ? (entity.defcon_level || 'GREEN') : (entity.safety?.defconLevel || 'GREEN'),
    manager: isFlat ? entity.parent_id : entity.hierarchy?.reportsTo,
    manages: isFlat ? (entity.manages || []) : (entity.hierarchy?.manages || []),
    // LLM configuration
    llm: entity.llm || DEFAULT_LLM_CONFIG,
    // Ownership info
    ownership: entity.ownership || { source: ENTITY_SOURCES.CORE },
    source: entity.ownership?.source || ENTITY_SOURCES.CORE,
    sourceBadge: getSourceBadge(entity)
  }
}

/**
 * Get all identity cards for quick UI rendering
 */
export function getAllIdentityCards() {
  return listAssistants().map(a => generateIdentityCard(a.id))
}

/**
 * Find the best assistant for a given query based on domain matching
 */
export function findBestAssistant(query, options = {}) {
  const { excludeIds = [], preferLevel } = options
  const queryLower = query.toLowerCase()

  const assistants = listAssistants({
    filter: a => !excludeIds.includes(a.id)
  })

  // Score each assistant
  const scored = assistants.map(assistant => {
    let score = 0

    // Domain matching
    for (const domain of assistant.capabilities.domains) {
      if (queryLower.includes(domain)) {
        score += 10
      }
    }

    // Keyword matching in description
    const descWords = assistant.identity.description.toLowerCase().split(/\s+/)
    for (const word of descWords) {
      if (word.length > 3 && queryLower.includes(word)) {
        score += 2
      }
    }

    // Tool capability matching
    for (const tool of assistant.capabilities.toolCapabilities || []) {
      if (queryLower.includes(tool.replace(/_/g, ' ').replace(/_/g, ''))) {
        score += 5
      }
    }

    // Level preference
    if (preferLevel !== undefined && assistant.hierarchy.level === preferLevel) {
      score += 3
    }

    return { assistant, score }
  })

  // Sort by score and return best match
  scored.sort((a, b) => b.score - a.score)

  return scored[0]?.score > 0 ? scored[0].assistant : getAssistant('quox')
}

/**
 * Validate an assistant manifest against the schema
 */
export function validateManifest(manifest) {
  const errors = []

  // Required top-level fields
  const required = ['v', 'type', 'id', 'identity', 'hierarchy', 'capabilities', 'rules', 'safety']
  for (const field of required) {
    if (!(field in manifest)) {
      errors.push(`Missing required field: ${field}`)
    }
  }

  // Identity validation
  if (manifest.identity) {
    if (!manifest.identity.name) errors.push('identity.name is required')
    if (!manifest.identity.description) errors.push('identity.description is required')
    if (!manifest.identity.personality) errors.push('identity.personality is required')
  }

  // Hierarchy validation
  if (manifest.hierarchy) {
    const validRoles = ['orchestrator', 'manager', 'analyst', 'specialist']
    if (!validRoles.includes(manifest.hierarchy.role)) {
      errors.push(`hierarchy.role must be one of: ${validRoles.join(', ')}`)
    }
    if (typeof manifest.hierarchy.level !== 'number') {
      errors.push('hierarchy.level must be a number')
    }
  }

  // Safety validation
  if (manifest.safety) {
    const validDefcon = ['GREEN', 'BLUE', 'AMBER', 'ORANGE', 'RED']
    if (!validDefcon.includes(manifest.safety.defconLevel)) {
      errors.push(`safety.defconLevel must be one of: ${validDefcon.join(', ')}`)
    }
  }

  return {
    valid: errors.length === 0,
    errors
  }
}

/**
 * Export manifest for backup/sharing
 */
export function exportManifest(id) {
  const assistant = getAssistant(id)
  if (!assistant) return null

  return JSON.stringify(assistant, null, 2)
}

/**
 * Import manifest (with validation)
 */
export function importManifest(manifestJson) {
  try {
    const manifest = JSON.parse(manifestJson)
    const validation = validateManifest(manifest)

    if (!validation.valid) {
      return { success: false, errors: validation.errors }
    }

    // Store as user override
    const updated = updateAssistant(manifest.id, manifest)
    return { success: !!updated, assistant: updated }
  } catch (err) {
    return { success: false, errors: [`Invalid JSON: ${err.message}`] }
  }
}

// Initialize cache on module load
getAssistants()

export default {
  // Entity sources and visibility
  ENTITY_SOURCES,
  VISIBILITY_LEVELS,

  // Core getters (sync - CORE entities only)
  getAssistants,
  getAssistant,
  listAssistants,

  // Async getters (CORE + USER entities)
  getAssistantsAsync,
  listAssistantsAsync,
  loadUserEntities,
  clearUserEntitiesCache,

  // Queries
  getAssistantsByRole,
  getAssistantsByLevel,
  getAssistantsByDomain,
  getAssistantsByIntent,
  getAssistantsByDefcon,
  getManagedAssistants,
  getManager,
  getHierarchyTree,

  // Mutations (localStorage overrides)
  updateAssistant,
  resetAssistant,
  resetAllAssistants,
  hasOverrides,
  getOverrides,

  // Identity and context generation
  generateSelfKnowledge,
  generateIdentityCard,
  generateIdentityCardFromEntity,
  getAllIdentityCards,
  getSourceBadge,
  findBestAssistant,

  // Validation and import/export
  validateManifest,
  exportManifest,
  importManifest
}
