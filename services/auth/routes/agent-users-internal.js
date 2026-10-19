/**
 * QUOXMIND #1111: service-key route listing the agent identities (users with
 * actor_type='agent') that are members of one org. The collector uses it to
 * widen memory recall to agent-written rows WITHOUT widening any human's
 * private rows. Ids and agent names only, never emails or tokens.
 */
import { getDb } from '../db/index.js';
import { listOrgAgentUsers } from '../lib/agentIdentity.js';

export function internalOrgAgentUsersHandler(req, res) {
    const expected = process.env.INTERNAL_SERVICE_KEY;
    const got = req.headers['x-service-key'];
    if (!expected || !got || got !== expected) return res.status(401).json({ error: 'Unauthorized' });
    try {
        res.json({ users: listOrgAgentUsers(getDb(), req.params.orgId) });
    } catch (err) {
        console.error('[AgentUsers] internal list failed:', err.message);
        res.status(500).json({ error: 'internal_error' });
    }
}
