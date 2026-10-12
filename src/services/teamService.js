// API client for the Agentic Teams system (task service port 3104)
// Stream E: Team definitions, instances, and context management

import {
  logTeamCreated, logTeamUpdated, logTeamInstalled, logTeamUninstalled,
  logPackInstalled, logTeamContextUpdated,
  logScheduleCreated, logScheduleUpdated, logScheduleDeleted, logScheduleToggled,
} from './teamAudit'
import { requestTaskServiceJson } from './taskServiceClient';

/**
 * List installed teams for the current org.
 */
export async function listTeams(authFetch) {
  return requestTaskServiceJson(authFetch, '/api/teams', undefined, 'Failed to list agentic teams');
}

/**
 * Get team details including full manifest.
 */
export async function getTeam(authFetch, teamId) {
  return requestTaskServiceJson(authFetch, `/api/teams/${encodeURIComponent(teamId)}`, undefined, 'Failed to load team details');
}

/**
 * Install a team from a manifest.
 */
export async function installTeam(authFetch, manifest) {
  const result = await requestTaskServiceJson(authFetch, '/api/teams/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest }),
  }, 'Failed to install team');
  logTeamInstalled(result);
  return result;
}

/**
 * Create a custom team from user-provided data.
 */
export async function createTeam(authFetch, teamData) {
  const result = await requestTaskServiceJson(authFetch, '/api/teams/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(teamData),
  }, 'Failed to create team');
  logTeamCreated(result);
  return result;
}

/**
 * Update team settings (PATCH).
 */
export async function updateTeam(authFetch, teamId, updates) {
  const result = await requestTaskServiceJson(authFetch, `/api/teams/${encodeURIComponent(teamId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  }, 'Failed to update team');
  logTeamUpdated(teamId, updates);
  return result;
}

/**
 * Uninstall (archive) a team.
 */
export async function uninstallTeam(authFetch, teamId) {
  const result = await requestTaskServiceJson(authFetch, `/api/teams/${encodeURIComponent(teamId)}`, {
    method: 'DELETE',
  }, 'Failed to uninstall team');
  logTeamUninstalled(teamId);
  return result;
}

/**
 * Get team shared context (latest instance).
 */
export async function getTeamContext(authFetch, teamId) {
  return requestTaskServiceJson(authFetch, `/api/teams/${encodeURIComponent(teamId)}/context`, undefined, 'Failed to load team context');
}

/**
 * Update a key in the team's shared context.
 */
export async function updateTeamContext(authFetch, teamId, instanceId, key, value) {
  const result = await requestTaskServiceJson(authFetch, `/api/teams/${encodeURIComponent(teamId)}/context`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instance_id: instanceId, key, value }),
  }, 'Failed to update team context');
  logTeamContextUpdated(teamId, key);
  return result;
}

// --- Stream E5: Pack + Export API functions ---

/**
 * Install all teams from a pack manifest.
 */
export async function installPack(authFetch, packManifest, teamManifests) {
  const result = await requestTaskServiceJson(authFetch, '/api/teams/install-pack', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ packManifest, teamManifests }),
  }, 'Failed to install team pack');
  logPackInstalled(packManifest?.name, teamManifests?.length);
  return result;
}

/**
 * Export a team definition as portable JSON.
 */
export async function exportTeam(authFetch, teamId) {
  return requestTaskServiceJson(authFetch, `/api/teams/${encodeURIComponent(teamId)}/export`, undefined, 'Failed to export team');
}

// --- Stream E4: Schedule API functions ---

/**
 * List schedules for a team.
 */
export async function listSchedules(authFetch, teamId) {
  return requestTaskServiceJson(authFetch, `/api/teams/${encodeURIComponent(teamId)}/schedules`, undefined, 'Failed to list team schedules');
}

/**
 * Create a schedule for a team.
 */
export async function createSchedule(authFetch, teamId, data) {
  const result = await requestTaskServiceJson(authFetch, `/api/teams/${encodeURIComponent(teamId)}/schedules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }, 'Failed to create schedule');
  logScheduleCreated(teamId, result);
  return result;
}

/**
 * Update a schedule.
 */
export async function updateSchedule(authFetch, teamId, scheduleId, updates) {
  const result = await requestTaskServiceJson(authFetch, `/api/teams/${encodeURIComponent(teamId)}/schedules/${encodeURIComponent(scheduleId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  }, 'Failed to update schedule');
  logScheduleUpdated(teamId, scheduleId);
  return result;
}

/**
 * Delete a schedule.
 */
export async function deleteSchedule(authFetch, teamId, scheduleId) {
  const result = await requestTaskServiceJson(authFetch, `/api/teams/${encodeURIComponent(teamId)}/schedules/${encodeURIComponent(scheduleId)}`, {
    method: 'DELETE',
  }, 'Failed to delete schedule');
  logScheduleDeleted(teamId, scheduleId);
  return result;
}

/**
 * Toggle a schedule on/off.
 */
export async function toggleSchedule(authFetch, teamId, scheduleId, enabled) {
  const result = await requestTaskServiceJson(authFetch, `/api/teams/${encodeURIComponent(teamId)}/schedules/${encodeURIComponent(scheduleId)}/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  }, 'Failed to toggle schedule');
  logScheduleToggled(teamId, scheduleId, enabled);
  return result;
}

/**
 * Get daily autonomy usage stats for a team.
 */
export async function getDailyUsage(authFetch, teamId) {
  return requestTaskServiceJson(authFetch, `/api/teams/${encodeURIComponent(teamId)}/usage/daily`, undefined, 'Failed to load daily usage');
}

// ── WC-5: List all schedules across all teams + org-level ──────────

/**
 * List all schedules for the org (across all teams and org-level).
 */
export async function listAllSchedules(authFetch) {
  return requestTaskServiceJson(authFetch, '/api/schedules', undefined, 'Failed to list schedules');
}

/**
 * Trigger a schedule immediately (run now).
 */
export async function triggerSchedule(authFetch, teamId, scheduleId) {
  return requestTaskServiceJson(authFetch, `/api/teams/${encodeURIComponent(teamId)}/schedules/${encodeURIComponent(scheduleId)}/trigger`, {
    method: 'POST',
  }, 'Failed to trigger schedule');
}

// ── P6.A.1: Workflow-kind schedule actions ─────────────────────────

/**
 * Execute a workflow-kind schedule row immediately.
 * Hits the quoxflow execute endpoint via the dashboard's quoxflowClient.
 * Returns { executionId } on success.
 */
export async function triggerWorkflowSchedule(authFetch, workflowId) {
  // The quoxflow API is proxied at /quoxflow/api for frontend calls.
  // We re-use the same path quoxflowClient uses (credentials: include sends auth cookies).
  const res = await authFetch(`/quoxflow/api/workflows/${encodeURIComponent(workflowId)}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ async: true }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => `HTTP ${res.status}`)
    throw new Error(`Failed to execute workflow: ${text}`)
  }
  const data = await res.json()
  const executionId = data?.data?.executionId || data?.data?.id || data?.executionId || null
  return { executionId }
}

/**
 * Toggle active state of a workflow-kind schedule.
 * Patches the workflow via quoxflow PUT /api/workflows/:id.
 */
export async function toggleWorkflowSchedule(authFetch, workflowId, enabled) {
  const res = await authFetch(`/quoxflow/api/workflows/${encodeURIComponent(workflowId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active: enabled }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => `HTTP ${res.status}`)
    throw new Error(`Failed to toggle workflow: ${text}`)
  }
  return res.json()
}

// ── M-ROOMS: Provision the Matrix room for a team on demand ────────

/**
 * Provision (or re-provision) the Matrix room for a team. Called when a
 * team roster entry has no room yet so the user can start chatting
 * immediately rather than waiting for a background provisioning pass.
 */
export async function provisionTeamRoom(authFetch, teamId) {
  return requestTaskServiceJson(authFetch, `/api/teams/${encodeURIComponent(teamId)}/provision-room`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }, 'Failed to provision team room');
}

// ── WC-2: Org-level schedule (no team required) ────────────────────

/**
 * Create an org-level schedule from a template.
 * Routes to team schedule if objectiveTemplate.team_id is set.
 */
export async function createOrgSchedule(authFetch, data) {
  const result = await requestTaskServiceJson(authFetch, '/api/schedules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }, 'Failed to create org schedule');
  logScheduleCreated(data.objectiveTemplate?.team_id || 'org', result);
  return result;
}

export default {
  listTeams,
  getTeam,
  createTeam,
  updateTeam,
  installTeam,
  uninstallTeam,
  installPack,
  exportTeam,
  getTeamContext,
  updateTeamContext,
  listSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  toggleSchedule,
  getDailyUsage,
  listAllSchedules,
  triggerSchedule,
  createOrgSchedule,
  triggerWorkflowSchedule,
  toggleWorkflowSchedule,
  provisionTeamRoom,
};
