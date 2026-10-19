// quox#896: an Approvals item that mirrors an objective checkpoint
// (payload.source 'objective_checkpoint', raised by the tasks service) must
// decide the CHECKPOINT, not just close the card. The human's decision is
// forwarded to the tasks service's own checkpoint approve/reject route BEFORE
// the item is resolved; if tasks refuses, the item stays open and the human
// sees why. The tasks route keeps its own human-only gate, so the forward
// carries a 60-second token for the human whose respond already passed
// requireHumanDecider here: never the service key (tasks refuses that).

import { createAccessToken } from '../utils/crypto.js';

export function checkpointMirror(item) {
    if (!item || item.kind !== 'approval') return null;
    let p = null;
    try { p = item.payload_json ? JSON.parse(item.payload_json) : null; } catch { return null; }
    if (!p || p.source !== 'objective_checkpoint' || !p.objective_id || !p.checkpoint_id) return null;
    return { objectiveId: String(p.objective_id), checkpointId: String(p.checkpoint_id) };
}

export async function forwardCheckpointDecision({ item, action, comment, userId, orgId, role, sessionId = null, stepUpToken = null, fetchImpl = fetch }) {
    const mirror = checkpointMirror(item);
    if (!mirror) return { ok: true, skipped: true };
    const verb = action === 'approve' ? 'approve' : (action === 'deny' || action === 'reject') ? 'reject' : null;
    if (!verb) {
        return { ok: false, status: 400, error: 'checkpoint_action', message: 'An objective checkpoint takes approve or deny.' };
    }
    const tasksUrl = process.env.TASKS_SERVICE_URL || 'http://tasks:3104';
    // session_id and the human's own step-up token travel with the forward: tasks' checkpoint approve
    // route is step-up gated and binds the token to this user + session (QUOXON-STEPUP).
    const token = createAccessToken({ sub: userId, org_id: orgId, role: role || 'member', purpose: 'inbox_checkpoint_decision', session_id: sessionId || null }, { expiresIn: '60s' });
    try {
        const res = await fetchImpl(`${tasksUrl}/api/objectives/${encodeURIComponent(mirror.objectiveId)}/checkpoints/${encodeURIComponent(mirror.checkpointId)}/${verb}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
                'X-Org-Id': orgId,
                // tells tasks the mirror card is being resolved by this respond,
                // so it must not close it a second time
                'x-quox-inbox-item': String(item.id),
                ...(stepUpToken ? { 'x-step-up-token': String(stepUpToken) } : {}),
            },
            body: JSON.stringify({ notes: comment || null, reason: comment || null }),
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
            let detail = '';
            try { detail = (await res.json())?.error || ''; } catch { /* non-JSON */ }
            return { ok: false, status: res.status, error: 'checkpoint_decision_failed', message: `The objective checkpoint was not ${verb === 'approve' ? 'approved' : 'rejected'} (tasks HTTP ${res.status}${detail ? `: ${detail}` : ''}). The card stays open.` };
        }
        return { ok: true };
    } catch (e) {
        return { ok: false, status: 503, error: 'checkpoint_decision_unavailable', message: `Could not reach the tasks service to decide the checkpoint (${e?.message || 'error'}). The card stays open; try again.` };
    }
}
