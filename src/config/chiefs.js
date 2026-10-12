// Chief Assistants Registry
// Business advisory C-suite executive AI personas for Agentic Team Packs.
//
// Three tiers:
//   small      = 6 chiefs  (CEO + 5 direct reports)   — $5
//   medium     = 14 chiefs (small + 8 additional)      — $10
//   enterprise = 51 chiefs (medium + 37 additional)    — $15
//
// Hierarchy: FLAT. CEO is the orchestrator (level 0).
// All other chiefs are level 1, role: 'specialist', reportsTo: 'ceo'.
//
// ID disambiguation for clashing abbreviations:
//   CPO → cpo-people (People), cpo-product (Product), cpo-procurement (Procurement)
//   CCO → cco-comms (Communications), cco-customer (Customer), cco-compliance (Compliance)
//   CDO → cdo-data (Data), cdo-digital (Digital)
//   CRO → cro-revenue (Revenue), cro-risk (Risk)

import { coreChiefs } from './chiefs/core.js';
import { enterpriseChiefs } from './chiefs/enterprise.js';
import { normalizeLlmPolicy } from '../services/llmPolicy.js';

// Merged registry: all 51 chiefs in one lookup
export const chiefs = {
  ...coreChiefs,
  ...enterpriseChiefs,
};

// Tier boundaries
const TIER_SMALL_IDS = ['ceo', 'coo', 'cfo', 'cmo', 'cto', 'cpo-people'];
const TIER_MEDIUM_IDS = [...TIER_SMALL_IDS, 'ciso', 'clo', 'cpo-product', 'cro-revenue', 'cco-comms', 'cio', 'cdo-data', 'cao'];

/**
 * Get all chief IDs.
 */
export function getAllChiefIds() {
  return Object.keys(chiefs);
}

/**
 * Get chiefs available at a given tier level.
 * Tiers are additive: medium includes small, enterprise includes medium.
 */
export function getChiefsByTier(tier) {
  switch (tier) {
    case 'small':
      return TIER_SMALL_IDS.map(id => chiefs[id]);
    case 'medium':
      return TIER_MEDIUM_IDS.map(id => chiefs[id]);
    case 'enterprise':
      return Object.values(chiefs);
    default:
      return [];
  }
}

/**
 * Get chief IDs for a given tier.
 */
export function getChiefIdsByTier(tier) {
  switch (tier) {
    case 'small':
      return [...TIER_SMALL_IDS];
    case 'medium':
      return [...TIER_MEDIUM_IDS];
    case 'enterprise':
      return Object.keys(chiefs);
    default:
      return [];
  }
}

/**
 * Get a single chief by ID.
 */
export function getChief(id) {
  const chief = chiefs[id] || null;
  if (!chief) return null;
  return {
    ...chief,
    llmPolicy: normalizeLlmPolicy(chief.llmPolicy || chief.llm?.policy || null, { entityId: chief.id }),
  };
}

/**
 * Get the CEO (the orchestrator).
 */
export function getCEO() {
  return getChief('ceo');
}

/**
 * Get all chiefs that report to the CEO.
 */
export function getDirectReports() {
  return Object.keys(chiefs)
    .map(id => getChief(id))
    .filter(c => c?.reportsTo === 'ceo');
}

/**
 * Get a chief's normalized runtime LLM policy.
 */
export function getChiefLlmPolicy(id) {
  const chief = getChief(id);
  return chief?.llmPolicy || normalizeLlmPolicy(null, { entityId: id });
}

/**
 * Tier metadata for UI display.
 */
export const tierMeta = {
  small: {
    name: 'Small Business',
    chiefCount: TIER_SMALL_IDS.length,
    price: 5,
    description: 'Core executive team: CEO, COO, CFO, CMO, CTO, CPO',
  },
  medium: {
    name: 'Medium Business',
    chiefCount: TIER_MEDIUM_IDS.length,
    price: 10,
    description: 'Full C-suite: adds CISO, CLO, CPO (Product), CRO, CCO, CIO, CDO, CAO',
  },
  enterprise: {
    name: 'Enterprise',
    chiefCount: Object.keys({ ...coreChiefs, ...enterpriseChiefs }).length,
    price: 15,
    description: 'Global executive suite with regional leaders, specialist CTOs/CLOs/CISOs, VPs, and strategic officers',
  },
};

export default {
  chiefs,
  getAllChiefIds,
  getChiefsByTier,
  getChiefIdsByTier,
  getChief,
  getChiefLlmPolicy,
  getCEO,
  getDirectReports,
  tierMeta,
};
