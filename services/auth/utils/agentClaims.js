/**
 * Claims that mark a token as an AGENT's. Every token mint for an existing
 * identity (switch-org, refresh) must carry them, or the agent silently
 * becomes a human: the collector's deriveActorType() reads req.user.agent_id,
 * so an agent token without it gets human attribution and human approval
 * policy. Found 2026-10-11: a resident CLI token re-minted by switch-org had
 * no agent_id, and its NotesQ edits were recorded as human.
 */
export function agentClaims(user, prior = null) {
    if (!user || user.actor_type !== 'agent') return {};
    const out = { agent_id: user.id };
    const host = prior && (prior.resident_host || prior.residentHost);
    if (typeof host === 'string' && host) out.resident_host = host;
    return out;
}
