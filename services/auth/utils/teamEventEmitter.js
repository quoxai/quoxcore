/**
 * ET-3 Phase B — combined emit + dispatch helper.
 *
 * Route handlers call emitAndDispatch() on a team lifecycle change;
 * this writes to team_events and fires webhooks in the background.
 * Swallows its own errors so webhook delivery can never fail a user
 * request — delivery failures are persisted in webhook_deliveries
 * for a retry worker to pick up later.
 */

import { emitTeamEvent } from './teamEvents.js';
import { dispatchEventToWebhooks } from './webhookDispatcher.js';

export async function emitAndDispatch(db, args) {
    let event = null;
    try {
        event = emitTeamEvent(db, args);
    } catch (err) {
        console.error('[team-events] emit failed:', err.message);
        return null;
    }
    // Fire-and-forget. Deliveries persist themselves.
    try {
        await dispatchEventToWebhooks(db, args.orgId, event);
    } catch (err) {
        console.error('[team-events] dispatch failed:', err.message);
    }
    return event;
}
