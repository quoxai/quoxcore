/**
 * Inbox Event System
 *
 * Simple event emitter for real-time inbox updates.
 * Supports SSE (Server-Sent Events) for connected clients.
 */

import { EventEmitter } from 'events';

// Global event emitter for inbox updates
const inboxEmitter = new EventEmitter();
inboxEmitter.setMaxListeners(100); // Support many concurrent SSE connections

// Track connected clients per org
const clients = new Map(); // orgId -> Set of response objects

/**
 * Subscribe a client to inbox updates for an org
 * @param {string} orgId - Organization ID
 * @param {Response} res - Express response object for SSE
 */
export function subscribeClient(orgId, res) {
    if (!clients.has(orgId)) {
        clients.set(orgId, new Set());
    }
    clients.get(orgId).add(res);

    // Remove client on disconnect
    res.on('close', () => {
        clients.get(orgId)?.delete(res);
        if (clients.get(orgId)?.size === 0) {
            clients.delete(orgId);
        }
    });
}

/**
 * Emit an inbox event to all subscribed clients
 * @param {string} orgId - Organization ID
 * @param {string} event - Event type (item_created, item_updated, item_responded, etc.)
 * @param {Object} data - Event data
 */
export function emitInboxEvent(orgId, event, data) {
    const eventData = {
        event,
        data,
        timestamp: new Date().toISOString()
    };

    // Emit to EventEmitter (for internal handlers)
    inboxEmitter.emit('inbox_event', orgId, eventData);

    // Send to SSE clients
    const orgClients = clients.get(orgId);
    if (orgClients && orgClients.size > 0) {
        const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const client of orgClients) {
            try {
                client.write(message);
            } catch (err) {
                // Client disconnected, will be cleaned up
                orgClients.delete(client);
            }
        }
    }
}

/**
 * Get the event emitter for internal subscriptions
 */
export function getEmitter() {
    return inboxEmitter;
}

/**
 * Get count of connected clients for an org
 */
export function getClientCount(orgId) {
    return clients.get(orgId)?.size || 0;
}

/**
 * Emit item created event
 */
export function emitItemCreated(orgId, item) {
    emitInboxEvent(orgId, 'item_created', {
        id: item.id,
        kind: item.kind,
        priority: item.priority,
        title: item.title,
        status: item.status || 'open'
    });
}

/**
 * Emit item updated event
 */
export function emitItemUpdated(orgId, itemId, changes) {
    emitInboxEvent(orgId, 'item_updated', {
        id: itemId,
        ...changes
    });
}

/**
 * Emit item responded event
 */
export function emitItemResponded(orgId, itemId, action, respondedBy) {
    emitInboxEvent(orgId, 'item_responded', {
        id: itemId,
        action,
        responded_by: respondedBy
    });
}

/**
 * Emit stats update (for badge refresh)
 */
export function emitStatsUpdate(orgId) {
    emitInboxEvent(orgId, 'stats_updated', {
        refresh: true
    });
}

export default {
    subscribeClient,
    emitInboxEvent,
    emitItemCreated,
    emitItemUpdated,
    emitItemResponded,
    emitStatsUpdate,
    getEmitter,
    getClientCount
};
