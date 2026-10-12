function csrfHeaders() {
    const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
    const headers = { 'Content-Type': 'application/json' };
    if (match) headers['X-CSRF-Token'] = decodeURIComponent(match[1]);
    return headers;
}

async function throwIfNotOk(res) {
    if (!res.ok) {
        let body = {};
        try { body = await res.json(); } catch { /* non-JSON error body */ }
        const err = new Error(body.message || body.error || `HTTP ${res.status}`);
        err.response = { status: res.status, body };
        throw err;
    }
    return res;
}

export async function detectPower(orgId, { url, authKind, authValue }) {
    const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/powers/detect`, {
        method: 'POST',
        credentials: 'include',
        headers: csrfHeaders(),
        body: JSON.stringify({ url, authKind, authValue }),
    });
    return res.json();
}

export async function deployPower(orgId, { url, authKind, authValue, persona }) {
    const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/powers/deploy`, {
        method: 'POST',
        credentials: 'include',
        headers: csrfHeaders(),
        body: JSON.stringify({ url, authKind, authValue, persona }),
    });

    await throwIfNotOk(res);
    return res.json();
}

// ── Repo-deploy (mcp_hosted) — P2.C ──────────────────────────────────────────

/**
 * Phase A: initiate a repo build.
 * Returns { ok, tool_def_id, tool_id, build_state: 'pending' }
 */
export async function deployRepo(orgId, { repo_url, env_vars = [] }) {
    const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/powers/deploy/repo`, {
        method: 'POST',
        credentials: 'include',
        headers: csrfHeaders(),
        body: JSON.stringify({ repo_url, env_vars }),
    });
    await throwIfNotOk(res);
    return res.json();
}

/**
 * Poll build status.
 * Returns { build_state, language, dockerfile_source, image_tag, build_failed_reason, logs }
 */
export async function getBuildStatus(orgId, toolDefId) {
    const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/powers/deploy/repo/${encodeURIComponent(toolDefId)}/status`,
        { method: 'GET', credentials: 'include', headers: csrfHeaders() }
    );
    await throwIfNotOk(res);
    return res.json();
}

/**
 * Phase B: finalize after build_state='built'.
 * Returns same shape as deployPower success: { ok, tool_id, agent_id, agent_ulid, scope }
 */
export async function finalizeRepoDeploy(orgId, toolDefId, persona) {
    const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/powers/deploy/repo/${encodeURIComponent(toolDefId)}/finalize`,
        {
            method: 'POST',
            credentials: 'include',
            headers: csrfHeaders(),
            body: JSON.stringify({ persona }),
        }
    );
    await throwIfNotOk(res);
    return res.json();
}

/**
 * Cancel a failed/pending build — marks tool as disabled, no agent created.
 * LIFECYCLE-P2-D3: Now requires ?confirm=true for hard destroys. This client
 * function uses ?confirm=true because it's called only after explicit user action.
 */
export async function cancelRepoDeploy(orgId, toolDefId) {
    const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/powers/deploy/repo/${encodeURIComponent(toolDefId)}?confirm=true`,
        { method: 'DELETE', credentials: 'include', headers: csrfHeaders() }
    );
    await throwIfNotOk(res);
    return res.json();
}

// ── LIFECYCLE-P2 operations ───────────────────────────────────────────────────

/**
 * D2: Update a deployed repo to a new ref (SHA or HEAD).
 * Kicks a fresh build. Returns { ok, tool_def_id, repo_ref, build_state }.
 */
export async function updateRepoDeploy(orgId, toolDefId, { repo_ref }) {
    const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/powers/deploy/repo/${encodeURIComponent(toolDefId)}/update`,
        {
            method: 'POST',
            credentials: 'include',
            headers: csrfHeaders(),
            body: JSON.stringify({ repo_ref }),
        }
    );
    await throwIfNotOk(res);
    return res.json();
}

/**
 * D3: Archive a deployed power (soft-disable, keep all rows).
 * Returns { ok, tool_def_id, status: 'archived' }.
 */
export async function archiveRepoDeploy(orgId, toolDefId) {
    const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/powers/deploy/repo/${encodeURIComponent(toolDefId)}/archive`,
        { method: 'POST', credentials: 'include', headers: csrfHeaders() }
    );
    await throwIfNotOk(res);
    return res.json();
}

/**
 * D3: Restore an archived power.
 * Returns { ok, tool_def_id, status: 'restored' }.
 */
export async function restoreRepoDeploy(orgId, toolDefId) {
    const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/powers/deploy/repo/${encodeURIComponent(toolDefId)}/restore`,
        { method: 'POST', credentials: 'include', headers: csrfHeaders() }
    );
    await throwIfNotOk(res);
    return res.json();
}

/**
 * D3: Permanently destroy a deployed power (hard teardown).
 * Requires explicit confirm=true. Returns { ok, teardown }.
 */
export async function destroyRepoDeploy(orgId, toolDefId) {
    const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/powers/deploy/repo/${encodeURIComponent(toolDefId)}?confirm=true`,
        { method: 'DELETE', credentials: 'include', headers: csrfHeaders() }
    );
    await throwIfNotOk(res);
    return res.json();
}

/**
 * D4: Update env_vars and/or persona without rebuilding the container.
 * Returns { ok, tool_def_id, changed_env_keys }.
 */
export async function patchRepoDeployConfig(orgId, toolDefId, { env_vars, persona }) {
    const res = await fetch(
        `/api/orgs/${encodeURIComponent(orgId)}/powers/deploy/repo/${encodeURIComponent(toolDefId)}/config`,
        {
            method: 'PATCH',
            credentials: 'include',
            headers: csrfHeaders(),
            body: JSON.stringify({ env_vars, persona }),
        }
    );
    await throwIfNotOk(res);
    return res.json();
}
