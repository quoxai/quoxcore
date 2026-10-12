/**
 * Internal widget-conversation Matrix relay routes, QUOXCHAT-PRO P2.
 *
 * Option B: every handed-off website chat gets its own governed Matrix room
 * (node_type 'quoxchat', node_id = widget_conversations.id). The collector is
 * the caller for everything here:
 *   - handoff lookup: is there a handed-off conversation for (widget, visitor)?
 *   - matrix-room set/get: store the provisioned room id on the conversation
 *     (NULL room on a handed_off conversation = provision pending, retried on
 *     the next visitor message);
 *   - by-room resolve: operator relay maps a Matrix room back to its
 *     conversation;
 *   - visitor-message / operator-message: persist the two relay directions
 *     (role 'user' from the widget, role 'operator' from the room, with the
 *     operator's display name in widget_messages.sender_name);
 *   - operator-messages: the widget poll read, scoped to (widget, visitor)
 *     so a conversation id alone can never read someone else's chat;
 *   - close: end the conversation and fire-and-forget deprovision the room.
 *
 * Lives in its own router (NOT routes/widgets.js) because parallel sessions
 * own that file; mounted under /api/internal with the same service-key gate
 * as internal-matrix-provision.js.
 */

import { Router } from 'express';
import { safeCompare } from '../utils/crypto.js';
import { prepare, getDb } from '../db/index.js';
import { ulid } from '../utils/helpers.js';
import { deprovisionRoomForNode } from '../lib/matrixProvisioner.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership } from '../middleware/org.js';

const router = Router();

function requireInternalAuth(req, res, next) {
    const expectedKey = process.env.INTERNAL_SERVICE_KEY;
    if (!expectedKey) {
        console.error('[SECURITY] INTERNAL_SERVICE_KEY not configured, denying request');
        return res.status(401).json({ error: 'Service key not configured' });
    }
    const serviceKey = req.headers['x-service-key'];
    if (serviceKey && safeCompare(serviceKey, expectedKey)) return next();
    return res.status(401).json({ error: 'Unauthorized: invalid service key' });
}

router.use(requireInternalAuth);

// CW-SEC-1 house pattern: accept either internal id or public_key.
function resolveWidget(widgetId) {
    return prepare('SELECT id, org_id FROM website_widgets WHERE id = ? OR public_key = ?').get(widgetId, widgetId);
}

const MESSAGE_MAX_LEN = 8000;

/**
 * GET /api/internal/widget-conversations/handoff?widget_id=&visitor_id=
 *
 * Latest handed-off conversation for (widget, visitor) within the last 24h
 * (the /message gate: while one exists, visitor messages skip the LLM and
 * relay to the room instead). 200 { conversation: null } when none.
 */
router.get('/widget-conversations/handoff', (req, res) => {
    try {
        const { widget_id: widgetId, visitor_id: visitorId } = req.query;
        if (!widgetId || !visitorId) return res.status(400).json({ error: 'widget_id and visitor_id required' });
        const widget = resolveWidget(widgetId);
        if (!widget) return res.status(404).json({ error: 'Widget not found' });

        const conv = prepare(`
            SELECT id, status, matrix_room_id, visitor_name, visitor_email, org_id, operator_joined_at
            FROM widget_conversations
            WHERE widget_id = ? AND visitor_id = ? AND status = 'handed_off'
              AND datetime(last_message_at) > datetime('now', '-24 hours')
            ORDER BY last_message_at DESC LIMIT 1
        `).get(widget.id, visitorId);

        res.json({ conversation: conv ? {
            conversation_id: conv.id,
            status: conv.status,
            matrix_room_id: conv.matrix_room_id || null,
            // Staged handoff: NULL until a human's first reply; the collector
            // gate keeps the AI holding the visitor while this is NULL.
            operator_joined_at: conv.operator_joined_at || null,
            visitor_name: conv.visitor_name || null,
            visitor_email: conv.visitor_email || null,
            org_id: conv.org_id,
        } : null });
    } catch (err) {
        console.error('[WidgetMatrix] handoff lookup error:', err.message);
        res.status(500).json({ error: 'Failed to look up handoff conversation' });
    }
});

/**
 * GET /api/internal/widget-conversations/by-room?room_id=
 *
 * Operator relay: resolve a Matrix room id back to its conversation.
 * Query param (not a path segment) because room ids contain ! and :.
 */
router.get('/widget-conversations/by-room', (req, res) => {
    try {
        const roomId = req.query.room_id;
        if (!roomId) return res.status(400).json({ error: 'room_id required' });
        const conv = prepare(`
            SELECT id, widget_id, org_id, visitor_id, visitor_name, visitor_email, status, matrix_room_id
            FROM widget_conversations WHERE matrix_room_id = ?
            ORDER BY last_message_at DESC LIMIT 1
        `).get(roomId);
        if (!conv) return res.status(404).json({ error: 'Conversation not found for room' });
        res.json({
            conversation_id: conv.id,
            widget_id: conv.widget_id,
            org_id: conv.org_id,
            visitor_id: conv.visitor_id,
            // QUOXCHAT-PRO visitor name: operator-side context — who is in
            // this room — without a second lookup.
            visitor_name: conv.visitor_name || null,
            visitor_email: conv.visitor_email || null,
            status: conv.status,
        });
    } catch (err) {
        console.error('[WidgetMatrix] by-room lookup error:', err.message);
        res.status(500).json({ error: 'Failed to resolve room' });
    }
});

/**
 * GET  /api/internal/widget-conversations/:conversationId/matrix-room
 * POST /api/internal/widget-conversations/:conversationId/matrix-room { matrix_room_id }
 *
 * Set/get the provisioned room id on a conversation.
 */
router.get('/widget-conversations/:conversationId/matrix-room', (req, res) => {
    try {
        const conv = prepare('SELECT id, status, matrix_room_id, org_id FROM widget_conversations WHERE id = ?').get(req.params.conversationId);
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });
        res.json({ conversation_id: conv.id, status: conv.status, matrix_room_id: conv.matrix_room_id || null, org_id: conv.org_id });
    } catch (err) {
        console.error('[WidgetMatrix] matrix-room get error:', err.message);
        res.status(500).json({ error: 'Failed to read matrix room' });
    }
});

router.post('/widget-conversations/:conversationId/matrix-room', (req, res) => {
    try {
        const { matrix_room_id: roomId } = req.body || {};
        if (!roomId || typeof roomId !== 'string') return res.status(400).json({ error: 'matrix_room_id required' });
        const conv = prepare('SELECT id FROM widget_conversations WHERE id = ?').get(req.params.conversationId);
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });
        prepare('UPDATE widget_conversations SET matrix_room_id = ? WHERE id = ?').run(roomId, conv.id);
        res.json({ success: true, conversation_id: conv.id, matrix_room_id: roomId });
    } catch (err) {
        console.error('[WidgetMatrix] matrix-room set error:', err.message);
        res.status(500).json({ error: 'Failed to store matrix room' });
    }
});

/**
 * POST /api/internal/widget-conversations/:conversationId/visitor-identity
 *   { widget_id, visitor_id, visitor_name?, visitor_email? }
 *
 * QUOXCHAT-PRO visitor name: stamp the visitor's self-given name/email onto
 * the conversation row (widget pre-handoff name form, or a late name after
 * an LLM-triggered handoff, via the collector's /events/visitor-identified).
 * Scoped like the poll read: the conversation must belong to the given
 * (widget, visitor) pair, so a leaked conversation id alone renames nothing.
 * Latest non-empty value wins (a visitor correcting their own name is
 * legitimate); empty/missing fields never blank an existing value.
 */
router.post('/widget-conversations/:conversationId/visitor-identity', (req, res) => {
    try {
        const { widget_id: widgetId, visitor_id: visitorId, visitor_name: rawName, visitor_email: rawEmail } = req.body || {};
        if (!widgetId || !visitorId) return res.status(400).json({ error: 'widget_id and visitor_id required' });
        const widget = resolveWidget(widgetId);
        if (!widget) return res.status(404).json({ error: 'Widget not found' });
        const conv = prepare(`
            SELECT id, visitor_name, visitor_email FROM widget_conversations
            WHERE id = ? AND widget_id = ? AND visitor_id = ?
        `).get(req.params.conversationId, widget.id, visitorId);
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });

        const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim().slice(0, 120) : null;
        const email = typeof rawEmail === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail.trim())
            ? rawEmail.trim().slice(0, 254) : null;
        if (!name && !email) return res.status(400).json({ error: 'visitor_name or visitor_email required' });

        prepare(`
            UPDATE widget_conversations
            SET visitor_name = COALESCE(?, visitor_name),
                visitor_email = COALESCE(?, visitor_email)
            WHERE id = ?
        `).run(name, email, conv.id);
        res.json({
            success: true,
            conversation_id: conv.id,
            visitor_name: name || conv.visitor_name || null,
            visitor_email: email || conv.visitor_email || null,
        });
    } catch (err) {
        console.error('[WidgetMatrix] visitor-identity error:', err.message);
        res.status(500).json({ error: 'Failed to store visitor identity' });
    }
});

/**
 * POST /api/internal/widget-conversations/:conversationId/visitor-message { content }
 *
 * Persist a visitor message sent while the conversation is handed off (the
 * LLM is skipped, so persist-message's user+assistant pair does not apply).
 */
router.post('/widget-conversations/:conversationId/visitor-message', (req, res) => {
    try {
        const { content } = req.body || {};
        if (!content || typeof content !== 'string') return res.status(400).json({ error: 'content required' });
        const conv = prepare('SELECT id, widget_id, org_id FROM widget_conversations WHERE id = ?').get(req.params.conversationId);
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });

        const messageId = ulid();
        const db = getDb();
        db.transaction(() => {
            prepare(`
                INSERT INTO widget_messages (id, conversation_id, widget_id, org_id, role, content, created_at)
                VALUES (?, ?, ?, ?, 'user', ?, datetime('now'))
            `).run(messageId, conv.id, conv.widget_id, conv.org_id, content.slice(0, MESSAGE_MAX_LEN));
            prepare(`
                UPDATE widget_conversations
                SET message_count = message_count + 1, last_message_at = datetime('now')
                WHERE id = ?
            `).run(conv.id);
            prepare(`
                UPDATE website_widgets
                SET total_messages = COALESCE(total_messages, 0) + 1, last_conversation_at = datetime('now')
                WHERE id = ?
            `).run(conv.widget_id);
        })();
        res.json({ success: true, message_id: messageId });
    } catch (err) {
        console.error('[WidgetMatrix] visitor-message error:', err.message);
        res.status(500).json({ error: 'Failed to persist visitor message' });
    }
});

/**
 * Shared persist path for a human operator reply, whatever the transport
 * (Matrix room relay OR the dashboard LogsTab reply box). Stored with role
 * 'operator' + sender_name; the widget poll below delivers it. Returns the
 * new message id.
 */
function persistOperatorReply(conv, content, senderName) {
    const messageId = ulid();
    const db = getDb();
    db.transaction(() => {
        prepare(`
            INSERT INTO widget_messages (id, conversation_id, widget_id, org_id, role, content, sender_name, created_at)
            VALUES (?, ?, ?, ?, 'operator', ?, ?, datetime('now'))
        `).run(
            messageId, conv.id, conv.widget_id, conv.org_id,
            String(content).slice(0, MESSAGE_MAX_LEN),
            senderName ? String(senderName).slice(0, 120) : null,
        );
        prepare(`
            UPDATE widget_conversations
            SET message_count = message_count + 1, last_message_at = datetime('now'),
                operator_joined_at = COALESCE(operator_joined_at, datetime('now'))
            WHERE id = ?
        `).run(conv.id);
        prepare(`
            UPDATE website_widgets
            SET total_messages = COALESCE(total_messages, 0) + 1
            WHERE id = ?
        `).run(conv.widget_id);
    })();
    return messageId;
}

/**
 * POST /api/internal/widget-conversations/:conversationId/operator-message
 *   { content, sender_name? }
 *
 * Persist a human operator reply relayed out of the Matrix room (or posted
 * by-conversation from the collector's Matrix-less path).
 */
router.post('/widget-conversations/:conversationId/operator-message', (req, res) => {
    try {
        const { content, sender_name: senderName } = req.body || {};
        if (!content || typeof content !== 'string') return res.status(400).json({ error: 'content required' });
        const conv = prepare('SELECT id, widget_id, org_id FROM widget_conversations WHERE id = ?').get(req.params.conversationId);
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });

        const messageId = persistOperatorReply(conv, content, senderName);
        res.json({ success: true, message_id: messageId, conversation_id: conv.id });
    } catch (err) {
        console.error('[WidgetMatrix] operator-message error:', err.message);
        res.status(500).json({ error: 'Failed to persist operator message' });
    }
});

/**
 * GET /api/internal/widget-conversations/:conversationId/operator-messages
 *   ?widget_id=&visitor_id=&after=<messageId>
 *
 * Widget poll read. Visitor-scoped: the conversation must belong to the
 * given (widget, visitor) pair or the caller gets a 404, so a leaked
 * conversation id alone reads nothing. `after` is a widget_messages ULID;
 * ULIDs sort lexicographically by time so id > after is the delta.
 */
router.get('/widget-conversations/:conversationId/operator-messages', (req, res) => {
    try {
        const { widget_id: widgetId, visitor_id: visitorId, after } = req.query;
        if (!widgetId || !visitorId) return res.status(400).json({ error: 'widget_id and visitor_id required' });
        const widget = resolveWidget(widgetId);
        if (!widget) return res.status(404).json({ error: 'Widget not found' });
        const conv = prepare(`
            SELECT id, status FROM widget_conversations
            WHERE id = ? AND widget_id = ? AND visitor_id = ?
        `).get(req.params.conversationId, widget.id, visitorId);
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });

        const rows = after
            ? prepare(`
                SELECT id, content, sender_name, created_at FROM widget_messages
                WHERE conversation_id = ? AND role = 'operator' AND id > ?
                ORDER BY id ASC LIMIT 50
              `).all(conv.id, String(after))
            : prepare(`
                SELECT id, content, sender_name, created_at FROM widget_messages
                WHERE conversation_id = ? AND role = 'operator'
                ORDER BY id ASC LIMIT 50
              `).all(conv.id);

        res.json({ conversation_id: conv.id, status: conv.status, messages: rows });
    } catch (err) {
        console.error('[WidgetMatrix] operator-messages read error:', err.message);
        res.status(500).json({ error: 'Failed to read operator messages' });
    }
});

/**
 * POST /api/internal/widget-conversations/:conversationId/close
 *
 * End a handed-off conversation: status -> 'closed', resolved_at stamped,
 * then fire-and-forget deprovision of the quoxchat room (matrixProvisioner
 * runs in-process here, no cross-service hop). A deprovision failure never
 * blocks the close; the ledger row stays for a later retry.
 */
/**
 * POST /api/internal/widget-conversations/:conversationId/visitor-close
 *   { widget_id, visitor_id }
 *
 * QC-HOLES: visitor-scoped close behind the widget's "Start new chat". The
 * handed-off gate matches by (widget, visitor), so a purely local reset left
 * the visitor hijacked back into their old handed-off conversation. Scoped
 * exactly like the poll read: the conversation must belong to the given
 * (widget, visitor) pair, so a leaked conversation id alone closes nothing.
 * Same close semantics as the operator route below (status + resolved_at +
 * fail-soft room deprovision).
 */
router.post('/widget-conversations/:conversationId/visitor-close', (req, res) => {
    try {
        const { widget_id: widgetId, visitor_id: visitorId } = req.body || {};
        if (!widgetId || !visitorId) return res.status(400).json({ error: 'widget_id and visitor_id required' });
        const widget = resolveWidget(widgetId);
        if (!widget) return res.status(404).json({ error: 'Widget not found' });
        const conv = prepare(`
            SELECT id, org_id, status, matrix_room_id FROM widget_conversations
            WHERE id = ? AND widget_id = ? AND visitor_id = ?
        `).get(req.params.conversationId, widget.id, visitorId);
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });
        if (conv.status !== 'closed') {
            prepare(`
                UPDATE widget_conversations
                SET status = 'closed', resolved_at = datetime('now')
                WHERE id = ?
            `).run(conv.id);
        }
        deprovisionRoomForNode({ orgId: conv.org_id, nodeType: 'quoxchat', nodeId: conv.id })
            .catch((err) => console.warn(`[WidgetMatrix] visitor-close deprovision for ${conv.id} failed: ${err.message}`));
        res.json({ success: true, conversation_id: conv.id, status: 'closed' });
    } catch (err) {
        console.error('[WidgetMatrix] visitor-close error:', err.message);
        res.status(500).json({ error: 'Failed to close conversation' });
    }
});

router.post('/widget-conversations/:conversationId/close', (req, res) => {
    try {
        const conv = prepare('SELECT id, org_id, status, matrix_room_id FROM widget_conversations WHERE id = ?').get(req.params.conversationId);
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });
        if (conv.status !== 'closed') {
            prepare(`
                UPDATE widget_conversations
                SET status = 'closed', resolved_at = datetime('now')
                WHERE id = ?
            `).run(conv.id);
        }
        // Fire-and-forget: deprovisionRoomForNode is fail-soft by contract.
        deprovisionRoomForNode({ orgId: conv.org_id, nodeType: 'quoxchat', nodeId: conv.id })
            .catch((err) => console.warn(`[WidgetMatrix] deprovision for conversation ${conv.id} failed: ${err.message}`));
        res.json({ success: true, conversation_id: conv.id, status: 'closed' });
    } catch (err) {
        console.error('[WidgetMatrix] close error:', err.message);
        res.status(500).json({ error: 'Failed to close conversation' });
    }
});

/**
 * QUOXCHAT-PRO Matrix-less handoff: org-authed dashboard reply route.
 *
 * POST /api/orgs/:orgId/widgets/:widgetId/conversations/:conversationId/operator-reply
 *   { body }
 *
 * Separate router (NOT the service-key-gated one above) so LogsTab can call
 * it through the auth proxy exactly like its other
 * /api/orgs/:orgId/widgets/... calls: requireAuth + requireOrgMembership,
 * matching routes/widgets.js. The operator identity is derived SERVER-SIDE
 * from the authenticated session (display_name, else email), never from the
 * client body. Persists through the same path as the Matrix relay above, so
 * the widget's GET /quoxchat/poll delivers it with no Matrix stack involved.
 *
 * Mounted at /api in server.js as widgetConversationOrgRouter.
 */
export const widgetConversationOrgRouter = Router();

widgetConversationOrgRouter.post(
    '/orgs/:orgId/widgets/:widgetId/conversations/:conversationId/operator-reply',
    requireAuth,
    requireOrgMembership,
    (req, res) => {
        try {
            const { orgId, widgetId, conversationId } = req.params;
            const { body: content } = req.body || {};
            if (!content || typeof content !== 'string' || !content.trim()) {
                return res.status(400).json({ error: 'body required' });
            }

            const widget = prepare('SELECT id FROM website_widgets WHERE id = ? AND org_id = ?').get(widgetId, orgId);
            if (!widget) return res.status(404).json({ error: 'Widget not found' });

            const conv = prepare(`
                SELECT id, widget_id, org_id, status FROM widget_conversations
                WHERE id = ? AND widget_id = ?
            `).get(conversationId, widget.id);
            if (!conv) return res.status(404).json({ error: 'Conversation not found' });
            if (conv.status !== 'handed_off') {
                return res.status(409).json({ error: 'Conversation is not handed off', status: conv.status });
            }

            const senderName = String(req.user?.displayName || req.user?.email || 'Operator').slice(0, 120);
            const messageId = persistOperatorReply(conv, content, senderName);
            res.json({ success: true, message_id: messageId, conversation_id: conv.id, sender_name: senderName });
        } catch (err) {
            console.error('[WidgetMatrix] operator-reply (org) error:', err.message);
            res.status(500).json({ error: 'Failed to persist operator reply' });
        }
    },
);

export default router;
