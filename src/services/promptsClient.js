/**
 * promptsClient — STUDY-REV-2 / P7.E.2
 *
 * Client for the auth-service prompts API (port 3101).
 *
 * Endpoints (all under /api/prompts, requireOrgMembership-gated):
 *   GET    /api/prompts?org_id=&q=&tags=         — list caller's + org-visible prompts
 *   GET    /api/prompts/:id?org_id=              — fetch one
 *   POST   /api/prompts                          — create (org_id in body)
 *   PATCH  /api/prompts/:id                      — update (auto-bumps version)
 *   DELETE /api/prompts/:id                      — soft-delete (org_id in body)
 *   GET    /api/prompts/:id/versions?org_id=     — version history
 *   POST   /api/prompts/:id/restore/:ver         — restore a version (org_id in body)
 *   POST   /api/prompts/import                   — JSON array import (org_id in body)
 *   GET    /api/prompts/export?org_id=           — full JSON export
 *   POST   /api/prompts/migrate                  — drain localStorage (org_id in body)
 *
 * Each function takes { authFetch, orgId?, ...args }. orgId defaults to the
 * active org from localStorage (`current_org_id` — same source as pluginApi /
 * serverSyncQueue / workflowEngine). Tests pass orgId explicitly.
 */

const BASE = '/api/prompts';

function readActiveOrgId() {
    try { return localStorage.getItem('current_org_id') || undefined; } catch { return undefined; }
}

async function handleResponse(resp) {
    if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || body.message || `Request failed: HTTP ${resp.status}`);
    }
    return resp.json();
}

function withOrg(orgId) {
    return orgId ?? readActiveOrgId();
}

function appendQs(base, params) {
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
}

// ─── listPrompts ─────────────────────────────────────────────────────────────

export async function listPrompts({ authFetch, orgId, q, tags } = {}) {
    const params = new URLSearchParams();
    const org = withOrg(orgId);
    if (org) params.set('org_id', org);
    if (q) params.set('q', q);
    if (tags) params.set('tags', tags);

    const data = await handleResponse(await authFetch(appendQs(BASE, params)));
    return data.prompts || [];
}

// ─── getPrompt ────────────────────────────────────────────────────────────────

export async function getPrompt({ authFetch, orgId, id }) {
    const params = new URLSearchParams();
    const org = withOrg(orgId);
    if (org) params.set('org_id', org);
    const data = await handleResponse(await authFetch(appendQs(`${BASE}/${encodeURIComponent(id)}`, params)));
    return data.prompt;
}

// ─── createPrompt ─────────────────────────────────────────────────────────────

export async function createPrompt({
    authFetch,
    orgId,
    name,
    body,
    description,
    tags,
    category,
    visibility,
    variables,
    deployTargets,
}) {
    const bodyObj = { name, body, org_id: withOrg(orgId) };
    if (description !== undefined) bodyObj.description = description;
    if (tags !== undefined) bodyObj.tags = tags;
    if (category !== undefined) bodyObj.category = category;
    if (visibility !== undefined) bodyObj.visibility = visibility;
    if (variables !== undefined) bodyObj.variables = variables;
    if (deployTargets !== undefined) bodyObj.deploy_targets = deployTargets;

    const data = await handleResponse(await authFetch(BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyObj),
    }));
    return data.prompt;
}

// ─── updatePrompt ─────────────────────────────────────────────────────────────

export async function updatePrompt({ authFetch, orgId, id, ...updates }) {
    const bodyObj = { ...updates, org_id: withOrg(orgId) };
    if (bodyObj.deployTargets !== undefined) {
        bodyObj.deploy_targets = bodyObj.deployTargets;
        delete bodyObj.deployTargets;
    }

    const data = await handleResponse(await authFetch(`${BASE}/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyObj),
    }));
    return data.prompt;
}

// ─── deletePrompt ─────────────────────────────────────────────────────────────

export async function deletePrompt({ authFetch, orgId, id }) {
    return handleResponse(await authFetch(`${BASE}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: withOrg(orgId) }),
    }));
}

// ─── listVersions ─────────────────────────────────────────────────────────────

export async function listVersions({ authFetch, orgId, id }) {
    const params = new URLSearchParams();
    const org = withOrg(orgId);
    if (org) params.set('org_id', org);
    const data = await handleResponse(await authFetch(appendQs(`${BASE}/${encodeURIComponent(id)}/versions`, params)));
    return data.versions || [];
}

// ─── restoreVersion ───────────────────────────────────────────────────────────

export async function restoreVersion({ authFetch, orgId, id, version }) {
    const data = await handleResponse(
        await authFetch(`${BASE}/${encodeURIComponent(id)}/restore/${encodeURIComponent(version)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ org_id: withOrg(orgId) }),
        })
    );
    return data.prompt;
}

// ─── importPrompts ────────────────────────────────────────────────────────────

export async function importPrompts({ authFetch, orgId, prompts }) {
    return handleResponse(await authFetch(`${BASE}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: withOrg(orgId), prompts }),
    }));
}

// ─── exportPrompts ────────────────────────────────────────────────────────────

export async function exportPrompts({ authFetch, orgId } = {}) {
    const params = new URLSearchParams();
    const org = withOrg(orgId);
    if (org) params.set('org_id', org);
    return handleResponse(await authFetch(appendQs(`${BASE}/export`, params)));
}

// ─── migratePromptsFromLocalStorage ──────────────────────────────────────────

export async function migratePromptsFromLocalStorage({ authFetch, orgId, customs, drafts, history }) {
    return handleResponse(await authFetch(`${BASE}/migrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ org_id: withOrg(orgId), customs, drafts, history }),
    }));
}
