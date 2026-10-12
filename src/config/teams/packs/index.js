// Pack Registry — loads and validates team pack manifests
// Packs are bundles of team references for batch installation

import quoxcoreDemoPack from './quoxcore-demo.json';
import startupBusinessPack from './startup-business.json';
import growthBusinessPack from './growth-business.json';
import contentResearchPack from './content-research.json';
import softwareDevPack from './software-dev.json';
import chiefSmallPack from './chief-small.json';
import chiefMediumPack from './chief-medium.json';
import chiefEnterprisePack from './chief-enterprise.json';
import { getBuiltInTeam } from '../index.js';

const REQUIRED_PACK_FIELDS = ['id', 'type', 'version', 'displayName', 'teams'];

/**
 * Validate a pack manifest has all required fields and correct type.
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validatePackManifest(pack) {
  const errors = [];
  for (const field of REQUIRED_PACK_FIELDS) {
    if (!pack[field]) errors.push(`Missing required field: ${field}`);
  }
  if (pack.type !== 'team-pack') {
    errors.push(`Invalid type: ${pack.type} (expected "team-pack")`);
  }
  if (pack.teams && !Array.isArray(pack.teams)) {
    errors.push('teams must be an array');
  }
  if (Array.isArray(pack.teams) && pack.teams.length === 0) {
    errors.push('teams array must not be empty');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Resolve team IDs in a pack to full team manifests from the built-in registry.
 * Filters out any team IDs that don't resolve.
 */
export function resolvePackTeams(pack) {
  if (!Array.isArray(pack.teams)) return [];
  return pack.teams.map(id => getBuiltInTeam(id)).filter(Boolean);
}

// All built-in packs
const builtInPacks = {
  'quoxcore-demo': quoxcoreDemoPack,
  'startup-business': startupBusinessPack,
  'growth-business': growthBusinessPack,
  'content-research': contentResearchPack,
  'software-dev': softwareDevPack,
  'chief-small': chiefSmallPack,
  'chief-medium': chiefMediumPack,
  'chief-enterprise': chiefEnterprisePack,
};

// Validate all built-in packs on load
for (const [id, pack] of Object.entries(builtInPacks)) {
  const { valid, errors } = validatePackManifest(pack);
  if (!valid) {
    console.error(`[PackRegistry] Invalid pack manifest for ${id}:`, errors);
  }
}

export function getBuiltInPacks() {
  return { ...builtInPacks };
}

export function getBuiltInPack(packId) {
  return builtInPacks[packId] || null;
}

export function getAllPackIds() {
  return Object.keys(builtInPacks);
}

export default {
  getBuiltInPacks,
  getBuiltInPack,
  getAllPackIds,
  validatePackManifest,
  resolvePackTeams,
};
