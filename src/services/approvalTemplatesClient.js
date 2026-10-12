/**
 * approvalTemplatesClient — STUDY-REV-2 P8.C.3
 *
 * Client for approval template CRUD endpoints, proxied through the collector.
 *
 * Proxy base: /collector/quoxflow/approval-templates
 *
 * All functions accept an optional orgId. If not passed, it is read from
 * localStorage('current_org_id') — same pattern as budgetClient / promptsClient.
 * Tests pass orgId explicitly to avoid localStorage dependency.
 *
 * Functions:
 *   listApprovalTemplates    — GET /collector/quoxflow/approval-templates?org_id=…
 *   getApprovalTemplate      — GET /collector/quoxflow/approval-templates/:id?org_id=…
 *   createApprovalTemplate   — POST /collector/quoxflow/approval-templates (org_id in body)
 *   updateApprovalTemplate   — PATCH /collector/quoxflow/approval-templates/:id (org_id in body)
 *   deleteApprovalTemplate   — DELETE /collector/quoxflow/approval-templates/:id (org_id in body)
 */

const PROXY_BASE = '/collector/quoxflow/approval-templates';

function readActiveOrgId() {
    try { return localStorage.getItem('current_org_id') || undefined; } catch { return undefined; }
}

function withOrg(orgId) {
    return orgId ?? readActiveOrgId();
}

function appendQs(base, params) {
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
}

async function handleResponse(resp) {
    if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body?.error?.message || body.error || body.message || `Request failed: HTTP ${resp.status}`);
    }
    return resp.json();
}

// ─── listApprovalTemplates ────────────────────────────────────────────────────

/**
 * List approval templates for an org.
 *
 * @param {object} opts
 * @param {Function} opts.authFetch  — authenticated fetch (from useAuth)
 * @param {string}  [opts.orgId]     — org ID (defaults to localStorage current_org_id)
 * @returns {Promise<Array>} templates
 */
export async function listApprovalTemplates({ authFetch, orgId } = {}) {
    const org = withOrg(orgId);
    const params = new URLSearchParams();
    if (org) params.set('org_id', org);

    const json = await handleResponse(await authFetch(appendQs(PROXY_BASE, params)));
    return (json.data || json).templates || [];
}

// ─── getApprovalTemplate ──────────────────────────────────────────────────────

/**
 * Fetch a single approval template by ID.
 *
 * @param {object} opts
 * @param {Function} opts.authFetch
 * @param {string}  [opts.orgId]
 * @param {string}  opts.id          — template ID
 * @returns {Promise<object>} template
 */
export async function getApprovalTemplate({ authFetch, orgId, id }) {
    const org = withOrg(orgId);
    const params = new URLSearchParams();
    if (org) params.set('org_id', org);

    const json = await handleResponse(
        await authFetch(appendQs(`${PROXY_BASE}/${encodeURIComponent(id)}`, params))
    );
    return (json.data || json).template;
}

// ─── createApprovalTemplate ───────────────────────────────────────────────────

/**
 * Create a new approval template.
 *
 * @param {object} opts
 * @param {Function} opts.authFetch
 * @param {string}  [opts.orgId]
 * @param {string}  opts.name                  — template name
 * @param {string[]} opts.approvers            — list of approver identifiers
 * @param {string[]} [opts.escalationChain]    — escalation chain
 * @param {number}  [opts.timeoutMs]           — approval timeout (ms, default 86400000)
 * @param {number}  [opts.multiPartyThreshold] — how many approvers must agree (default 1)
 * @returns {Promise<object>} created template
 */
export async function createApprovalTemplate({
    authFetch,
    orgId,
    name,
    approvers,
    escalationChain,
    timeoutMs,
    multiPartyThreshold,
} = {}) {
    const org = withOrg(orgId);

    const json = await handleResponse(
        await authFetch(PROXY_BASE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                org_id: org,
                name,
                approvers,
                escalation_chain: escalationChain,
                timeout_ms: timeoutMs,
                multi_party_threshold: multiPartyThreshold,
            }),
        })
    );
    return (json.data || json).template;
}

// ─── updateApprovalTemplate ───────────────────────────────────────────────────

/**
 * Update an approval template.
 *
 * @param {object} opts
 * @param {Function} opts.authFetch
 * @param {string}  [opts.orgId]
 * @param {string}  opts.id                    — template ID
 * @param {string}  [opts.name]
 * @param {string[]} [opts.approvers]
 * @param {string[]} [opts.escalationChain]
 * @param {number}  [opts.timeoutMs]
 * @param {number}  [opts.multiPartyThreshold]
 * @returns {Promise<object>} updated template
 */
export async function updateApprovalTemplate({
    authFetch,
    orgId,
    id,
    name,
    approvers,
    escalationChain,
    timeoutMs,
    multiPartyThreshold,
} = {}) {
    const org = withOrg(orgId);
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (approvers !== undefined) updates.approvers = approvers;
    if (escalationChain !== undefined) updates.escalation_chain = escalationChain;
    if (timeoutMs !== undefined) updates.timeout_ms = timeoutMs;
    if (multiPartyThreshold !== undefined) updates.multi_party_threshold = multiPartyThreshold;

    const json = await handleResponse(
        await authFetch(`${PROXY_BASE}/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ org_id: org, ...updates }),
        })
    );
    return (json.data || json).template;
}

// ─── deleteApprovalTemplate ───────────────────────────────────────────────────

/**
 * Delete an approval template.
 *
 * @param {object} opts
 * @param {Function} opts.authFetch
 * @param {string}  [opts.orgId]
 * @param {string}  opts.id  — template ID
 * @returns {Promise<boolean>} true if deleted
 */
export async function deleteApprovalTemplate({ authFetch, orgId, id } = {}) {
    const org = withOrg(orgId);

    const json = await handleResponse(
        await authFetch(`${PROXY_BASE}/${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ org_id: org }),
        })
    );
    return (json.data || json).deleted === true;
}
