// Team Registry — loads and validates team manifests
// Teams are bundles of agents + orchestrator + policies for agentic collaboration

import quoxcoreManifest from './quoxcore.json';
import secopsManifest from './secops.json';
import startupOpsManifest from './startup-ops.json';
import growthOpsManifest from './growth-ops.json';
import contentResearchManifest from './content-research.json';
import softwareDevManifest from './software-dev.json';
import chiefSmallManifest from './chief-small.json';
import chiefMediumManifest from './chief-medium.json';
import chiefEnterpriseManifest from './chief-enterprise.json';
import securityCoreManifest from './security-core.json';

const REQUIRED_FIELDS = ['id', 'type', 'version', 'displayName', 'orchestrator', 'members', 'policies'];

function validateManifest(manifest) {
  const errors = [];
  for (const field of REQUIRED_FIELDS) {
    if (!manifest[field]) errors.push(`Missing required field: ${field}`);
  }
  if (manifest.type !== 'team') errors.push(`Invalid type: ${manifest.type} (expected "team")`);
  if (!manifest.orchestrator?.agentId) errors.push('Missing orchestrator.agentId');
  if (!Array.isArray(manifest.members) || manifest.members.length === 0) {
    errors.push('Members must be a non-empty array');
  }
  for (const member of manifest.members || []) {
    if (!member.agentId) errors.push(`Member missing agentId`);
    if (!member.role) errors.push(`Member ${member.agentId || '?'} missing role`);
  }
  return errors;
}

// All built-in team manifests
const builtInTeams = {
  quoxcore: quoxcoreManifest,
  secops: secopsManifest,
  'startup-ops': startupOpsManifest,
  'growth-ops': growthOpsManifest,
  'content-research': contentResearchManifest,
  'software-dev': softwareDevManifest,
  'chief-small': chiefSmallManifest,
  'chief-medium': chiefMediumManifest,
  'chief-enterprise': chiefEnterpriseManifest,
  'security-core': securityCoreManifest,
};

// Validate all built-in manifests on load
for (const [id, manifest] of Object.entries(builtInTeams)) {
  const errors = validateManifest(manifest);
  if (errors.length > 0) {
    console.error(`[TeamRegistry] Invalid manifest for ${id}:`, errors);
  }
}

export function getBuiltInTeams() {
  return { ...builtInTeams };
}

export function getBuiltInTeam(teamId) {
  return builtInTeams[teamId] || null;
}

export function getAllTeamIds() {
  return Object.keys(builtInTeams);
}

export function getTeamMemberIds(teamId) {
  const team = builtInTeams[teamId];
  if (!team) return [];
  return [
    team.orchestrator.agentId,
    ...team.members.map(m => m.agentId)
  ];
}

export function getTeamAgentCount(teamId) {
  const team = builtInTeams[teamId];
  if (!team) return 0;
  return team.members.length + 1; // +1 for orchestrator
}

export { validateManifest };

export default {
  getBuiltInTeams,
  getBuiltInTeam,
  getAllTeamIds,
  getTeamMemberIds,
  getTeamAgentCount,
  validateManifest,
};
