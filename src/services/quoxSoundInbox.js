/**
 * QUOXSOUND-P1 inbox wiring: maps inbox SSE `item_created` events to earcons.
 *
 * - A NEW item awaiting the human (kind approval / override_required, still
 *   open) -> `hitl`. That chime means "human action required" and nothing else.
 * - Any other new open item -> `notify`.
 * - Items already seen (SSE reconnect replays, duplicate deliveries) -> nothing.
 * - Items that arrive already closed -> nothing.
 */

import { playSound } from './quoxSound';

export const HITL_KINDS = new Set(['approval', 'override_required']);
const OPEN_STATUSES = new Set(['open', 'pending', 'awaiting_approval', 'awaiting_response']);
const MAX_SEEN = 1000;

export function soundForInboxItem(item) {
    if (!item || typeof item !== 'object') return null;
    const status = item.status || 'open';
    if (!OPEN_STATUSES.has(status)) return null;
    return HITL_KINDS.has(item.kind) ? 'hitl' : 'notify';
}

/**
 * Stateful tracker: remembers ids it has already sounded for, so the same
 * item never chimes twice. `play` is injectable for tests.
 */
export function createInboxSoundTracker({ play = playSound, onNewItem = null } = {}) {
    const seen = new Set();
    return {
        handle(item) {
            const id = item && item.id;
            if (id != null) {
                if (seen.has(id)) return null;
                seen.add(id);
                if (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);
            }
            const sound = soundForInboxItem(item);
            if (sound) play(sound);
            // QUOXSOUND-P1.5: same first-seen gate drives desktop notifications.
            if (onNewItem && sound) { try { onNewItem(item); } catch { /* never throw */ } }
            return sound;
        },
        markSeen(ids) {
            for (const id of ids || []) seen.add(id);
        },
    };
}
