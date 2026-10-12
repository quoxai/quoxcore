/**
 * Assistants compatibility shim — STUDY-REV-2/P3.E registry collapse Phase 1+2.
 * Re-exports from entityRegistry. Same surface as the old 2,245-line JS map.
 * Source of truth: src/config/entities/assistants/*.json + entityRegistry.js
 */

import {
  getAssistants as _getAssistants,
  getAssistantsByRole as _getAssistantsByRole,
  getAssistantsByLevel as _getAssistantsByLevel,
  getManagedAssistants,
  buildRuntimeAssistantConfig,
} from '../services/entityRegistry';
import { normalizeLlmPolicy } from '../services/llmPolicy.js';

// Derived flat-shape assistants map — computed once at module load.
function _buildFlatMap() {
  const entities = _getAssistants();
  const result = {};
  for (const [id, entity] of Object.entries(entities)) {
    const rt = buildRuntimeAssistantConfig(entity);
    if (!rt) continue;
    result[id] = {
      id: rt.id, name: rt.name, shortName: rt.shortName,
      voice: rt.voice, color: rt.color, colorRgb: rt.colorRgb,
      specialty: rt.specialty, description: rt.description,
      personality: rt.personality, capabilities: rt.capabilities,
      role: rt.role, level: rt.level, manages: rt.manages,
      reportsTo: rt.reportsTo, canDelegateTo: rt.canDelegateTo,
      defconLevel: rt.defconLevel, llm: rt.llm, llmPolicy: rt.llmPolicy,
      systemPrompt: rt.systemPrompt,
    };
  }
  return result;
}

export const assistants = _buildFlatMap();

// Helpers — same signatures as the old JS file.
export const getAssistant = (id) => assistants[id] || null;

export const getAssistantLlmPolicy = (id) =>
  getAssistant(id)?.llmPolicy || normalizeLlmPolicy(null, { entityId: id });

export const getAssistantByVoice = (voice) =>
  Object.values(assistants).find(a => a.voice === voice) || null;

export const getAllAssistants = () => Object.values(assistants);

export const getAssistantsByRole = (role) =>
  _getAssistantsByRole(role).map(e => assistants[e.id]).filter(Boolean);

export const getAssistantsByLevel = (level) =>
  _getAssistantsByLevel(level).map(e => assistants[e.id]).filter(Boolean);

export const getManagers = () => getAssistantsByLevel(1);

export const getSpecialists = () => getAssistantsByLevel(2);

export const getManagedAgents = (id) =>
  getManagedAssistants(id).map(e => assistants[e.id]).filter(Boolean);

export const getReportingChain = (id) => {
  const chain = [];
  let currentId = assistants[id]?.reportsTo;
  while (currentId && assistants[currentId]) {
    chain.push(assistants[currentId]);
    currentId = assistants[currentId].reportsTo;
  }
  return chain;
};

export const defaultAssistant = assistants.quox || null;
