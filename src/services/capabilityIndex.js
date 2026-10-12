/**
 * Unified Capability Index
 *
 * Provides a single interface to search and discover capabilities across
 * all entity types: agents, assistants, tools, and workflows.
 *
 * This enables efficient "what can do X?" queries without loading
 * full entity definitions - reducing token usage when assistants
 * need to find the right capability.
 *
 * Key Features:
 * - Unified search across entity types
 * - Intent-based discovery (find entities by AEE intent)
 * - Integration-based discovery (find everything that uses Telegram)
 * - Tag-based discovery
 * - Capability scoring for relevance ranking
 */

import { getExtensions } from '../config/extensions.js';
import { searchWorkflows, getLibraryStats, initializeLibrary } from './workflowLibrary.js';

// Entity type definitions
const ENTITY_TYPES = {
    AGENT: 'agent',
    ASSISTANT: 'assistant',
    TOOL: 'tool',
    WORKFLOW: 'workflow'
};

// In-memory capability index
let capabilityIndex = {
    byIntent: new Map(),      // intent -> [entities]
    byIntegration: new Map(), // integration -> [entities]
    byTag: new Map(),         // tag -> [entities]
    byType: new Map(),        // entityType -> [entities]
    entities: new Map()       // id -> entity summary
};

let indexInitialized = false;

/**
 * Lightweight entity summary for index
 */
function createEntitySummary(entity, type) {
    const summary = {
        id: entity.id,
        type: type,
        name: entity.identity?.name || entity.name || entity.id,
        description: entity.identity?.description || entity.description || '',
        intents: [],
        integrations: [],
        tags: [],
        category: entity.identity?.category || entity.category || null,
        defconLevel: entity.safety?.defconLevel || 'GREEN'
    };

    // Extract capabilities based on entity type
    if (type === ENTITY_TYPES.WORKFLOW) {
        summary.intents = entity.capabilities?.intents || [];
        summary.integrations = entity.capabilities?.integrations || [];
        summary.tags = entity.identity?.tags || [];
        summary.triggerType = entity.trigger?.type || 'manual';
    } else if (type === ENTITY_TYPES.ASSISTANT) {
        summary.intents = entity.capabilities?.intents || [];
        summary.integrations = entity.capabilities?.toolCapabilities || [];
        summary.tags = entity.capabilities?.domains || [];
        summary.role = entity.hierarchy?.role || 'specialist';
    } else if (type === ENTITY_TYPES.TOOL) {
        summary.intents = []; // Tools don't have intents in current schema
        summary.integrations = entity.capabilities || [];
        summary.tags = entity.capabilities || [];
    }

    return summary;
}

/**
 * Add entity to index
 */
function addToIndex(summary) {
    // Add to entities map
    capabilityIndex.entities.set(summary.id, summary);

    // Add to type index
    if (!capabilityIndex.byType.has(summary.type)) {
        capabilityIndex.byType.set(summary.type, []);
    }
    capabilityIndex.byType.get(summary.type).push(summary.id);

    // Add to intent index
    summary.intents.forEach(intent => {
        if (!capabilityIndex.byIntent.has(intent)) {
            capabilityIndex.byIntent.set(intent, []);
        }
        capabilityIndex.byIntent.get(intent).push(summary.id);
    });

    // Add to integration index
    summary.integrations.forEach(integration => {
        if (!capabilityIndex.byIntegration.has(integration)) {
            capabilityIndex.byIntegration.set(integration, []);
        }
        capabilityIndex.byIntegration.get(integration).push(summary.id);
    });

    // Add to tag index
    summary.tags.forEach(tag => {
        if (!capabilityIndex.byTag.has(tag)) {
            capabilityIndex.byTag.set(tag, []);
        }
        capabilityIndex.byTag.get(tag).push(summary.id);
    });
}

/**
 * Initialize the capability index
 */
export async function initializeCapabilityIndex() {
    console.log('[CapabilityIndex] Initializing...');

    // Reset index
    capabilityIndex = {
        byIntent: new Map(),
        byIntegration: new Map(),
        byTag: new Map(),
        byType: new Map(),
        entities: new Map()
    };

    // Load assistants from config files
    try {
        const assistantModules = import.meta.glob('../config/entities/assistants/*.json', { eager: true });
        Object.values(assistantModules).forEach(module => {
            const assistant = module.default || module;
            if (assistant && assistant.id) {
                const summary = createEntitySummary(assistant, ENTITY_TYPES.ASSISTANT);
                addToIndex(summary);
            }
        });
        console.log(`[CapabilityIndex] Loaded ${capabilityIndex.byType.get(ENTITY_TYPES.ASSISTANT)?.length || 0} assistants`);
    } catch (err) {
        console.warn('[CapabilityIndex] Could not load assistants:', err.message);
    }

    // Load tools from config files
    try {
        const toolModules = import.meta.glob('../config/entities/tools/*.json', { eager: true });
        Object.values(toolModules).forEach(module => {
            const tool = module.default || module;
            if (tool && tool.id) {
                const summary = createEntitySummary(tool, ENTITY_TYPES.TOOL);
                addToIndex(summary);
            }
        });
        console.log(`[CapabilityIndex] Loaded ${capabilityIndex.byType.get(ENTITY_TYPES.TOOL)?.length || 0} tools`);
    } catch (err) {
        console.warn('[CapabilityIndex] Could not load tools:', err.message);
    }

    // Load workflow library
    try {
        const libraryModule = await import('../config/workflow-library-index.json');
        const library = libraryModule.default || libraryModule;
        if (library && library.workflows) {
            initializeLibrary(library.workflows);
            library.workflows.forEach(workflow => {
                const summary = createEntitySummary(workflow, ENTITY_TYPES.WORKFLOW);
                addToIndex(summary);
            });
            console.log(`[CapabilityIndex] Loaded ${library.workflows.length} workflows`);
        }
    } catch (err) {
        console.warn('[CapabilityIndex] Could not load workflow library:', err.message);
    }

    indexInitialized = true;
    console.log(`[CapabilityIndex] Initialized with ${capabilityIndex.entities.size} total entities`);

    return getIndexStats();
}

/**
 * Search capabilities across all entity types
 */
export function searchCapabilities(query, options = {}) {
    const {
        types = null,          // Filter by entity types
        intents = null,        // Filter by intents
        integrations = null,   // Filter by integrations
        tags = null,           // Filter by tags
        category = null,       // Filter by category
        limit = 20,
        offset = 0
    } = options;

    let results = [];

    // Start with all entities or filtered by type
    if (types && types.length > 0) {
        types.forEach(type => {
            const ids = capabilityIndex.byType.get(type) || [];
            ids.forEach(id => {
                const entity = capabilityIndex.entities.get(id);
                if (entity) results.push(entity);
            });
        });
    } else {
        results = Array.from(capabilityIndex.entities.values());
    }

    // Text search
    if (query) {
        const q = query.toLowerCase();
        results = results.filter(e =>
            e.name.toLowerCase().includes(q) ||
            e.description.toLowerCase().includes(q) ||
            e.tags.some(t => t.toLowerCase().includes(q)) ||
            e.integrations.some(i => i.toLowerCase().includes(q))
        );
    }

    // Intent filter
    if (intents && intents.length > 0) {
        results = results.filter(e =>
            intents.some(intent => e.intents.includes(intent))
        );
    }

    // Integration filter
    if (integrations && integrations.length > 0) {
        results = results.filter(e =>
            integrations.some(i => e.integrations.includes(i))
        );
    }

    // Tag filter
    if (tags && tags.length > 0) {
        results = results.filter(e =>
            tags.some(t => e.tags.includes(t))
        );
    }

    // Category filter
    if (category) {
        results = results.filter(e => e.category === category);
    }

    // Sort by relevance (simple scoring)
    if (query) {
        const q = query.toLowerCase();
        results.sort((a, b) => {
            const scoreA = (a.name.toLowerCase().startsWith(q) ? 10 : 0) +
                          (a.name.toLowerCase().includes(q) ? 5 : 0) +
                          (a.description.toLowerCase().includes(q) ? 2 : 0);
            const scoreB = (b.name.toLowerCase().startsWith(q) ? 10 : 0) +
                          (b.name.toLowerCase().includes(q) ? 5 : 0) +
                          (b.description.toLowerCase().includes(q) ? 2 : 0);
            return scoreB - scoreA;
        });
    }

    const total = results.length;
    results = results.slice(offset, offset + limit);

    return {
        results,
        total,
        offset,
        limit,
        hasMore: offset + limit < total
    };
}

/**
 * Find capabilities by intent
 */
export function findByIntent(intent) {
    const ids = capabilityIndex.byIntent.get(intent) || [];
    return ids.map(id => capabilityIndex.entities.get(id)).filter(Boolean);
}

/**
 * Find capabilities by integration
 */
export function findByIntegration(integration) {
    const ids = capabilityIndex.byIntegration.get(integration) || [];
    return ids.map(id => capabilityIndex.entities.get(id)).filter(Boolean);
}

/**
 * Find capabilities by tag
 */
export function findByTag(tag) {
    const ids = capabilityIndex.byTag.get(tag) || [];
    return ids.map(id => capabilityIndex.entities.get(id)).filter(Boolean);
}

/**
 * Get entity by ID
 */
export function getEntity(id) {
    return capabilityIndex.entities.get(id);
}

/**
 * Get all unique intents
 */
export function getAllIntents() {
    return Array.from(capabilityIndex.byIntent.keys()).sort();
}

/**
 * Get all unique integrations
 */
export function getAllIntegrations() {
    const integrations = [];
    capabilityIndex.byIntegration.forEach((ids, name) => {
        integrations.push({ name, count: ids.length });
    });
    return integrations.sort((a, b) => b.count - a.count);
}

/**
 * Get all unique tags
 */
export function getAllTags() {
    const tags = [];
    capabilityIndex.byTag.forEach((ids, name) => {
        tags.push({ name, count: ids.length });
    });
    return tags.sort((a, b) => b.count - a.count);
}

/**
 * Get index statistics
 */
export function getIndexStats() {
    return {
        initialized: indexInitialized,
        totalEntities: capabilityIndex.entities.size,
        byType: {
            assistants: capabilityIndex.byType.get(ENTITY_TYPES.ASSISTANT)?.length || 0,
            tools: capabilityIndex.byType.get(ENTITY_TYPES.TOOL)?.length || 0,
            workflows: capabilityIndex.byType.get(ENTITY_TYPES.WORKFLOW)?.length || 0
        },
        uniqueIntents: capabilityIndex.byIntent.size,
        uniqueIntegrations: capabilityIndex.byIntegration.size,
        uniqueTags: capabilityIndex.byTag.size
    };
}

/**
 * Generate a compact capability summary for LLM context
 * This is the token-efficient format for AI discovery
 */
export function generateCompactSummary(options = {}) {
    const { types = null, maxEntries = 50 } = options;

    const summary = {
        assistants: [],
        tools: [],
        workflows: []
    };

    // Get entities by type
    const getTypeEntries = (type, maxCount) => {
        const ids = capabilityIndex.byType.get(type) || [];
        return ids.slice(0, maxCount).map(id => {
            const e = capabilityIndex.entities.get(id);
            return {
                id: e.id,
                name: e.name,
                desc: e.description.substring(0, 100),
                intents: e.intents.slice(0, 3),
                integrations: e.integrations.slice(0, 3)
            };
        });
    };

    if (!types || types.includes(ENTITY_TYPES.ASSISTANT)) {
        summary.assistants = getTypeEntries(ENTITY_TYPES.ASSISTANT, maxEntries);
    }

    if (!types || types.includes(ENTITY_TYPES.TOOL)) {
        summary.tools = getTypeEntries(ENTITY_TYPES.TOOL, maxEntries);
    }

    if (!types || types.includes(ENTITY_TYPES.WORKFLOW)) {
        summary.workflows = getTypeEntries(ENTITY_TYPES.WORKFLOW, maxEntries);
    }

    return summary;
}

/**
 * Find the best capability for a given task description
 */
export function findBestCapability(taskDescription, options = {}) {
    const { types = null, limit = 5 } = options;

    // Extract keywords from task description
    const keywords = taskDescription
        .toLowerCase()
        .split(/\s+/)
        .filter(w => w.length > 2);

    // Search with keywords
    const results = searchCapabilities(taskDescription, {
        types,
        limit: limit * 3 // Get more to filter
    });

    // Score results
    const scored = results.results.map(entity => {
        let score = 0;

        // Keyword matches
        keywords.forEach(kw => {
            if (entity.name.toLowerCase().includes(kw)) score += 5;
            if (entity.description.toLowerCase().includes(kw)) score += 2;
            if (entity.tags.some(t => t.includes(kw))) score += 3;
            if (entity.integrations.some(i => i.includes(kw))) score += 4;
        });

        return { ...entity, score };
    });

    // Sort by score and return top results
    return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
}

export default {
    ENTITY_TYPES,
    initializeCapabilityIndex,
    searchCapabilities,
    findByIntent,
    findByIntegration,
    findByTag,
    getEntity,
    getAllIntents,
    getAllIntegrations,
    getAllTags,
    getIndexStats,
    generateCompactSummary,
    findBestCapability
};
