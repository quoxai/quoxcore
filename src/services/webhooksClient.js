/**
 * ET-3 Phase E — webhooks frontend client.
 */

export const TEAM_EVENT_TYPES = [
    'team.created',
    'team.archived',
    'team.member.invited',
    'team.member.joined',
    'team.member.left',
    'team.member.role_changed',
];

const EVENT_SET = new Set(TEAM_EVENT_TYPES);

export function isValidWebhookUrl(input) {
    if (typeof input !== 'string' || !input) return false;
    try {
        const u = new URL(input);
        return u.protocol === 'https:';
    } catch {
        return false;
    }
}

async function parseOrEmpty(res) { try { return await res.json(); } catch { return null; } }

export async function fetchWebhooks(orgId, authFetch) {
    const res = await authFetch(`/api/orgs/${orgId}/webhooks`);
    if (res.status === 402 || res.status === 404) return [];
    if (!res.ok) throw new Error(`fetchWebhooks: ${res.status}`);
    const body = await parseOrEmpty(res);
    return body?.webhooks || [];
}

export async function createWebhook(orgId, { url, events }, authFetch) {
    if (!isValidWebhookUrl(url)) throw new Error('webhook url must be https://');
    if (!Array.isArray(events) || events.length === 0) {
        throw new Error('select at least one event (events array required)');
    }
    for (const e of events) {
        if (!EVENT_SET.has(e)) throw new Error(`unknown event "${e}"`);
    }
    const res = await authFetch(`/api/orgs/${orgId}/webhooks`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ url, events }),
    });
    if (!res.ok) {
        const body = await parseOrEmpty(res);
        throw new Error(body?.message || `createWebhook: ${res.status}`);
    }
    const body = await parseOrEmpty(res);
    return body?.webhook;
}

export async function rotateWebhookSecret(orgId, id, authFetch) {
    const res = await authFetch(`/api/orgs/${orgId}/webhooks/${id}/rotate`, { method: 'POST' });
    if (!res.ok) {
        const body = await parseOrEmpty(res);
        throw new Error(body?.message || `rotateWebhookSecret: ${res.status}`);
    }
    return parseOrEmpty(res);
}

export async function deleteWebhook(orgId, id, authFetch) {
    const res = await authFetch(`/api/orgs/${orgId}/webhooks/${id}`, { method: 'DELETE' });
    if (res.status === 204 || res.ok) return true;
    throw new Error(`deleteWebhook: ${res.status}`);
}

export async function fetchTeamEvents(orgId, { since, limit } = {}, authFetch) {
    const params = new URLSearchParams();
    if (since) params.set('since', since);
    if (limit) params.set('limit', String(limit));
    const qs = params.toString();
    const url = qs ? `/api/orgs/${orgId}/team-events?${qs}` : `/api/orgs/${orgId}/team-events`;
    const res = await authFetch(url);
    if (!res.ok) throw new Error(`fetchTeamEvents: ${res.status}`);
    const body = await parseOrEmpty(res);
    return body?.events || [];
}
