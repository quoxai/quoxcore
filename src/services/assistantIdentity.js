import { assistants as staticAssistants } from '../config/assistants';
import { getAssistant, buildRuntimeAssistantConfig } from './entityRegistry';

function normalizeColor(color) {
    if (color?.primary) return color.primary;
    if (typeof color === 'string') return color;
    return '#8b5cf6';
}

function buildStaticIdentity(assistantId, config) {
    if (!config) return null;
    return {
        id: assistantId,
        name: config.name || assistantId,
        shortName: config.shortName || config.name?.charAt(0) || assistantId?.charAt(0)?.toUpperCase() || 'A',
        specialty: config.specialty || '',
        voice: config.voice || null,
        color: normalizeColor(config.color),
    };
}

function buildUnknownIdentity(assistantId, fallbackName = null) {
    const name = fallbackName || assistantId || 'Assistant';
    return {
        id: assistantId || null,
        name,
        shortName: name.charAt(0)?.toUpperCase() || 'A',
        specialty: '',
        voice: null,
        color: '#8b5cf6',
    };
}

export function buildAssistantIdentityMap(entities = []) {
    return entities.reduce((acc, entity) => {
        const runtime = buildRuntimeAssistantConfig(entity);
        if (runtime?.id) {
            acc[runtime.id] = {
                id: runtime.id,
                name: runtime.name,
                shortName: runtime.shortName,
                specialty: runtime.specialty || '',
                voice: runtime.voice || null,
                color: normalizeColor(runtime.color),
            };
        }
        return acc;
    }, {});
}

export function buildAssistantIdentityList(entities = []) {
    return entities
        .map(entity => {
            const assistantId = entity?.id || entity?.assistantId || null;
            if (!assistantId) return null;
            const identity = resolveAssistantIdentity(assistantId);
            if (!identity) return null;
            return {
                ...entity,
                id: assistantId,
                name: identity.name,
                shortName: identity.shortName,
                specialty: identity.specialty,
                voice: identity.voice,
                color: identity.color,
                colorRgb: entity?.colorRgb || null,
            };
        })
        .filter(Boolean);
}

export function resolveAssistantIdentity(assistantId, options = {}) {
    const {
        runtimeMap = {},
        fallbackId = null,
        fallbackName = null,
    } = options;

    if (assistantId && runtimeMap[assistantId]) {
        return runtimeMap[assistantId];
    }

    if (assistantId) {
        const core = getAssistant(assistantId);
        if (core) {
            const runtime = buildRuntimeAssistantConfig(core);
            return {
                id: runtime.id,
                name: runtime.name,
                shortName: runtime.shortName,
                specialty: runtime.specialty || '',
                voice: runtime.voice || null,
                color: normalizeColor(runtime.color),
            };
        }

        const staticIdentity = buildStaticIdentity(assistantId, staticAssistants[assistantId]);
        if (staticIdentity) return staticIdentity;
    }

    if (assistantId && fallbackId) {
        console.warn(`[assistantIdentity] No entity JSON or static identity found for agent "${assistantId}" — silently falling back to "${fallbackId}". See docs/STATUS_AND_LIMITS_AGENTS.md.`);
    }

    if (fallbackId) {
        return resolveAssistantIdentity(fallbackId, {
            runtimeMap,
            fallbackId: null,
            fallbackName,
        });
    }

    return buildUnknownIdentity(assistantId, fallbackName);
}

export function getAssistantDisplayName(assistantId, options = {}) {
    return resolveAssistantIdentity(assistantId, options).name;
}

export function getAssistantDisplayColor(assistantId, options = {}) {
    return resolveAssistantIdentity(assistantId, options).color;
}

export function getAssistantVoiceMode(assistantId, options = {}) {
    return resolveAssistantIdentity(assistantId, options).voice;
}
