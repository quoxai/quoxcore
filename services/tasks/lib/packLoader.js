// Pack Loader — batch install teams from pack manifests, export team definitions
import { installTeam, getTeamDefinition } from './teamLoader.js';

const REQUIRED_PACK_FIELDS = ['id', 'type', 'version', 'displayName', 'teams'];

/**
 * Validate a pack manifest before installation.
 */
function validatePackForInstall(packManifest) {
  const errors = [];
  for (const field of REQUIRED_PACK_FIELDS) {
    if (!packManifest[field]) errors.push(`Missing required field: ${field}`);
  }
  if (packManifest.type !== 'team-pack') {
    errors.push(`Invalid type: ${packManifest.type} (expected "team-pack")`);
  }
  if (!Array.isArray(packManifest.teams) || packManifest.teams.length === 0) {
    errors.push('teams array must be non-empty');
  }
  return errors;
}

/**
 * Install all teams from a pack manifest.
 *
 * @param {string} orgId - Organization ID
 * @param {string} userId - Installing user ID
 * @param {object} packManifest - The pack JSON (id, type, teams[], etc.)
 * @param {object[]} teamManifests - Resolved array of full team manifests
 * @returns {{ packId: string, installed: string[], skipped: string[] }}
 */
export function installPack(orgId, userId, packManifest, teamManifests) {
  const errors = validatePackForInstall(packManifest);
  if (errors.length > 0) {
    throw new Error(`Invalid pack manifest: ${errors.join(', ')}`);
  }
  if (!Array.isArray(teamManifests) || teamManifests.length === 0) {
    throw new Error('teamManifests must be a non-empty array');
  }

  const installed = [];
  const skipped = [];
  const failed = [];

  for (const manifest of teamManifests) {
    try {
      const result = installTeam(orgId, manifest, userId, 'pack');
      if (result.action === 'installed') {
        installed.push(result.id);
      } else {
        // 'updated' means it already existed — count as skipped
        skipped.push(result.id);
      }
    } catch (err) {
      failed.push({ id: manifest.id || 'unknown', error: err.message });
    }
  }

  return {
    packId: packManifest.id,
    installed,
    skipped,
    failed,
  };
}

/**
 * Export a team definition as a clean manifest JSON.
 * Strips org-specific fields so it can be shared/imported elsewhere.
 *
 * @param {string} orgId - Organization ID
 * @param {string} teamId - Team definition ID
 * @returns {object|null} Clean manifest or null if not found
 */
const PORTABLE_FIELDS = [
  'id', 'type', 'version', 'displayName', 'description', 'icon', 'accentColor',
  'tier', 'author', 'tags', 'orchestrator', 'members', 'policies', 'autonomyPolicies',
];

export function exportTeam(orgId, teamId) {
  const def = getTeamDefinition(orgId, teamId);
  if (!def) return null;

  // Whitelist portable fields — strips any org-specific or runtime fields
  const clean = {};
  for (const key of PORTABLE_FIELDS) {
    if (def.manifest[key] !== undefined) {
      clean[key] = def.manifest[key];
    }
  }
  return clean;
}
