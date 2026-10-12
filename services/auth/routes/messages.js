/**
 * Messages & Conversations Routes for Quox Auth Service
 * Phase 1: Conversation audit trail with AOCL/AEE alignment
 *
 * Provides CRUD for conversations and messages to support:
 * - Chat history persistence (replacing localStorage)
 * - AOCL layer tracking (L0-L10)
 * - AEE envelope correlation
 * - Immutable audit chain (L10)
 */

import { Router } from 'express';
import crypto from 'crypto';
import { prepare } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership, requireOrgMembershipSecure } from '../middleware/org.js';
import { createAuditEvent, ulid } from '../utils/helpers.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);

/**
 * Compute SHA256 hash for audit chain
 */
function computeMessageHash(prevHash, id, content, createdAt) {
    const data = `${prevHash || ''}|${id}|${content}|${createdAt}`;
    return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * F04 fix: org membership alone is not ownership. A conversation created with
 * scope_type 'user' is private to the user named in scope_id — any other org
 * member (even on the same org) must be denied, not just non-members.
 * Non-user-scoped conversations (team/org) stay org-wide, unchanged.
 */
function isConversationOwner(conversation, userId) {
    if (!conversation) return false;
    if (conversation.scope_type !== 'user') return true;
    return conversation.scope_id === userId;
}

/**
 * F04 fix: a message's own row is org-scoped only, so a direct message-id
 * route has to walk back to its parent conversation to know whether the
 * caller owns it.
 */
function isMessageOwner(message, userId) {
    if (!message) return false;
    const conversation = prepare('SELECT scope_type, scope_id FROM conversations WHERE id = ?')
        .get(message.conversation_id);
    return isConversationOwner(conversation, userId);
}

// ============================================================================
// CONVERSATIONS
// ============================================================================

/**
 * GET /orgs/:orgId/conversations
 * List conversations for the current user/org
 * Phase 2: Uses secure middleware for cross-org leak prevention
 */
router.get('/orgs/:orgId/conversations', requireOrgMembershipSecure, async (req, res) => {
    try {
        const { orgId } = req.params;
        const userId = req.user.id;
        const { agent_id, status = 'active', limit = 50, offset = 0 } = req.query;

        let query = `
            SELECT c.*,
                   (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY sequence_num DESC LIMIT 1) as last_message
            FROM conversations c
            WHERE c.org_id = ?
              AND c.status = ?
              AND (c.scope_type = 'user' AND c.scope_id = ?)
        `;
        const params = [orgId, status, userId];

        if (agent_id) {
            query += ' AND c.agent_id = ?';
            params.push(agent_id);
        }

        query += ' ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        const conversations = prepare(query).all(...params);

        res.json({ conversations });
    } catch (error) {
        console.error('Error listing conversations:', error);
        res.status(500).json({ error: 'Failed to list conversations' });
    }
});

/**
 * POST /orgs/:orgId/conversations
 * Create a new conversation
 */
router.post('/orgs/:orgId/conversations', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const userId = req.user.id;
        const {
            title,
            agent_id = 'quox',
            scope_type = 'user',
            scope_id,
            correlation_id
        } = req.body;

        const id = ulid();
        const now = new Date().toISOString();
        const finalScopeId = scope_id || userId;

        prepare(`
            INSERT INTO conversations (
                id, org_id, scope_type, scope_id, title, agent_id,
                status, created_by, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
        `).run(id, orgId, scope_type, finalScopeId, title, agent_id, userId, now, now);

        // Add creator as owner participant
        prepare(`
            INSERT INTO conversation_participants (id, conversation_id, user_id, role, joined_at)
            VALUES (?, ?, ?, 'owner', ?)
        `).run(ulid(), id, userId, now);

        createAuditEvent({
            orgId,
            actorType: 'user',
            actorId: userId,
            action: 'conversation.create',
            targetType: 'conversation',
            targetId: id,
            metadata: { agent_id, correlation_id }
        });

        const conversation = prepare('SELECT * FROM conversations WHERE id = ?').get(id);
        res.status(201).json({ conversation });
    } catch (error) {
        console.error('Error creating conversation:', error);
        res.status(500).json({ error: 'Failed to create conversation' });
    }
});

/**
 * GET /orgs/:orgId/conversations/:conversationId
 * Get a conversation with recent messages
 * Phase 2: Uses secure middleware for cross-org leak prevention
 */
router.get('/orgs/:orgId/conversations/:conversationId', requireOrgMembershipSecure, async (req, res) => {
    try {
        const { orgId, conversationId } = req.params;
        const { include_messages = 'true', message_limit = 50 } = req.query;

        const conversation = prepare(`
            SELECT * FROM conversations WHERE id = ? AND org_id = ?
        `).get(conversationId, orgId);

        if (!conversation || !isConversationOwner(conversation, req.user.id)) {
            return res.status(404).json({ error: 'Conversation not found' });
        }

        let messages = [];
        if (include_messages === 'true') {
            messages = prepare(`
                SELECT * FROM messages
                WHERE conversation_id = ? AND deleted_at IS NULL
                ORDER BY sequence_num DESC
                LIMIT ?
            `).all(conversationId, parseInt(message_limit));
            messages.reverse(); // Return in chronological order
        }

        res.json({ conversation, messages });
    } catch (error) {
        console.error('Error getting conversation:', error);
        res.status(500).json({ error: 'Failed to get conversation' });
    }
});

/**
 * PATCH /orgs/:orgId/conversations/:conversationId
 * Update conversation (title, status, summary)
 */
router.patch('/orgs/:orgId/conversations/:conversationId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, conversationId } = req.params;
        const { title, status, summary } = req.body;

        const conversation = prepare('SELECT * FROM conversations WHERE id = ? AND org_id = ?')
            .get(conversationId, orgId);

        if (!conversation || !isConversationOwner(conversation, req.user.id)) {
            return res.status(404).json({ error: 'Conversation not found' });
        }

        const updates = [];
        const params = [];

        if (title !== undefined) {
            updates.push('title = ?');
            params.push(title);
        }
        if (status !== undefined) {
            updates.push('status = ?');
            params.push(status);
            if (status === 'archived') {
                updates.push('archived_at = ?');
                params.push(new Date().toISOString());
            }
        }
        if (summary !== undefined) {
            updates.push('summary = ?');
            params.push(summary);
        }

        if (updates.length > 0) {
            updates.push('updated_at = ?');
            params.push(new Date().toISOString());
            params.push(conversationId, orgId);

            prepare(`
                UPDATE conversations SET ${updates.join(', ')} WHERE id = ? AND org_id = ?
            `).run(...params);
        }

        const updated = prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId);
        res.json({ conversation: updated });
    } catch (error) {
        console.error('Error updating conversation:', error);
        res.status(500).json({ error: 'Failed to update conversation' });
    }
});

// ============================================================================
// MESSAGES
// ============================================================================

/**
 * GET /orgs/:orgId/conversations/:conversationId/messages
 * List messages in a conversation
 * Phase 2: Uses secure middleware for cross-org leak prevention
 */
router.get('/orgs/:orgId/conversations/:conversationId/messages', requireOrgMembershipSecure, async (req, res) => {
    try {
        const { orgId, conversationId } = req.params;
        const { limit = 100, offset = 0, after_sequence } = req.query;

        // Verify conversation access (F04: ownership, not just org membership)
        const conversation = prepare('SELECT id, scope_type, scope_id FROM conversations WHERE id = ? AND org_id = ?')
            .get(conversationId, orgId);

        if (!conversation || !isConversationOwner(conversation, req.user.id)) {
            return res.status(404).json({ error: 'Conversation not found' });
        }

        let query = `
            SELECT * FROM messages
            WHERE conversation_id = ? AND deleted_at IS NULL
        `;
        const params = [conversationId];

        if (after_sequence) {
            query += ' AND sequence_num > ?';
            params.push(parseInt(after_sequence));
        }

        query += ' ORDER BY sequence_num ASC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        const messages = prepare(query).all(...params);
        res.json({ messages });
    } catch (error) {
        console.error('Error listing messages:', error);
        res.status(500).json({ error: 'Failed to list messages' });
    }
});

/**
 * POST /orgs/:orgId/conversations/:conversationId/messages
 * Add a message to a conversation
 */
router.post('/orgs/:orgId/conversations/:conversationId/messages', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, conversationId } = req.params;
        const userId = req.user.id;
        const {
            role,
            content,
            content_type = 'text',
            sender_type,
            sender_id,
            sender_name,
            // Token usage
            tokens_in,
            tokens_out,
            model,
            provider,
            processing_time_ms,
            finish_reason,
            // AOCL/AEE fields
            aee_envelope_id,
            correlation_id,
            aocl_layers_json,
            verify_status,
            verify_flags_json,
            // HITL
            requires_approval,
            // Tool calls
            tool_calls_json,
            tool_result_json,
            // Attachments
            attachments_json
        } = req.body;

        // Verify conversation access (F04: ownership, not just org membership)
        const conversation = prepare('SELECT id, message_count, scope_type, scope_id FROM conversations WHERE id = ? AND org_id = ?')
            .get(conversationId, orgId);

        if (!conversation || !isConversationOwner(conversation, req.user.id)) {
            return res.status(404).json({ error: 'Conversation not found' });
        }

        const id = ulid();
        const now = new Date().toISOString();
        const sequenceNum = (conversation.message_count || 0) + 1;

        // Get previous message hash for audit chain (L10)
        const prevMessage = prepare(`
            SELECT message_hash FROM messages
            WHERE conversation_id = ?
            ORDER BY sequence_num DESC LIMIT 1
        `).get(conversationId);

        const prevMessageHash = prevMessage?.message_hash || null;
        const messageHash = computeMessageHash(prevMessageHash, id, content, now);

        // Determine sender info
        const finalSenderType = sender_type || (role === 'user' ? 'human' : 'agent');
        const finalSenderId = sender_id || (role === 'user' ? userId : 'quox');
        const finalSenderName = sender_name || (role === 'user' ? req.user.display_name : finalSenderId);

        prepare(`
            INSERT INTO messages (
                id, conversation_id, org_id, sequence_num,
                role, sender_type, sender_id, sender_name,
                content, content_type,
                tokens_in, tokens_out, model, provider,
                processing_time_ms, finish_reason,
                aee_envelope_id, correlation_id, aocl_layers_json,
                verify_status, verify_flags_json,
                requires_approval,
                tool_calls_json, tool_result_json, attachments_json,
                prev_message_hash, message_hash,
                created_at
            ) VALUES (
                ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?,
                ?, ?, ?, ?,
                ?, ?,
                ?, ?, ?,
                ?, ?,
                ?,
                ?, ?, ?,
                ?, ?,
                ?
            )
        `).run(
            id, conversationId, orgId, sequenceNum,
            role, finalSenderType, finalSenderId, finalSenderName,
            content, content_type,
            tokens_in || null, tokens_out || null, model || null, provider || null,
            processing_time_ms || null, finish_reason || null,
            aee_envelope_id || null, correlation_id || null, aocl_layers_json || null,
            verify_status || null, verify_flags_json || null,
            requires_approval ? 1 : 0,
            tool_calls_json || null, tool_result_json || null, attachments_json || null,
            prevMessageHash, messageHash,
            now
        );

        // Conversation counters are updated by trigger

        const message = prepare('SELECT * FROM messages WHERE id = ?').get(id);
        res.status(201).json({ message });
    } catch (error) {
        console.error('Error creating message:', error);
        res.status(500).json({ error: 'Failed to create message' });
    }
});

/**
 * POST /orgs/:orgId/messages/batch
 * Bulk insert messages (for migration from localStorage)
 */
router.post('/orgs/:orgId/messages/batch', requireOrgMembership, async (req, res) => {
    try {
        const { orgId } = req.params;
        const userId = req.user.id;
        const { conversation_id, messages: messagesToInsert, create_conversation } = req.body;

        if (!messagesToInsert || !Array.isArray(messagesToInsert) || messagesToInsert.length === 0) {
            return res.status(400).json({ error: 'messages array is required' });
        }

        let convId = conversation_id;

        // Optionally create conversation first
        if (create_conversation && !convId) {
            convId = ulid();
            const now = new Date().toISOString();
            prepare(`
                INSERT INTO conversations (
                    id, org_id, scope_type, scope_id, agent_id,
                    status, created_by, created_at, updated_at
                ) VALUES (?, ?, 'user', ?, ?, 'active', ?, ?, ?)
            `).run(convId, orgId, userId, create_conversation.agent_id || 'quox', userId, now, now);

            prepare(`
                INSERT INTO conversation_participants (id, conversation_id, user_id, role, joined_at)
                VALUES (?, ?, ?, 'owner', ?)
            `).run(ulid(), convId, userId, now);
        }

        // Verify conversation exists and caller owns it (F04: ownership, not just org membership)
        const conversation = prepare('SELECT id, message_count, scope_type, scope_id FROM conversations WHERE id = ? AND org_id = ?')
            .get(convId, orgId);

        if (!conversation || !isConversationOwner(conversation, userId)) {
            return res.status(404).json({ error: 'Conversation not found' });
        }

        let sequenceNum = conversation.message_count || 0;
        let prevHash = null;

        // Get last message hash if any
        const lastMsg = prepare(`
            SELECT message_hash FROM messages
            WHERE conversation_id = ? ORDER BY sequence_num DESC LIMIT 1
        `).get(convId);
        if (lastMsg) prevHash = lastMsg.message_hash;

        const insertedIds = [];

        for (const msg of messagesToInsert) {
            const id = ulid();
            const now = new Date().toISOString();
            sequenceNum++;

            const hash = computeMessageHash(prevHash, id, msg.content, now);

            prepare(`
                INSERT INTO messages (
                    id, conversation_id, org_id, sequence_num,
                    role, sender_type, sender_id, sender_name,
                    content, content_type,
                    aee_envelope_id, correlation_id,
                    prev_message_hash, message_hash,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                id, convId, orgId, sequenceNum,
                msg.role, msg.sender_type || (msg.role === 'user' ? 'human' : 'agent'),
                msg.sender_id || (msg.role === 'user' ? userId : msg.assistant || 'quox'),
                msg.sender_name || null,
                msg.content || msg.text, msg.content_type || 'text',
                msg.envelope_id || null, msg.correlation_id || null,
                prevHash, hash,
                now
            );

            insertedIds.push(id);
            prevHash = hash;
        }

        res.status(201).json({
            conversation_id: convId,
            inserted_count: insertedIds.length,
            message_ids: insertedIds
        });
    } catch (error) {
        console.error('Error batch inserting messages:', error);
        res.status(500).json({ error: 'Failed to batch insert messages' });
    }
});

/**
 * GET /orgs/:orgId/messages/:messageId
 * Get a single message
 * Phase 2: Uses secure middleware for cross-org leak prevention
 */
router.get('/orgs/:orgId/messages/:messageId', requireOrgMembershipSecure, async (req, res) => {
    try {
        const { orgId, messageId } = req.params;

        const message = prepare('SELECT * FROM messages WHERE id = ? AND org_id = ?')
            .get(messageId, orgId);

        if (!message || !isMessageOwner(message, req.user.id)) {
            return res.status(404).json({ error: 'Message not found' });
        }

        res.json({ message });
    } catch (error) {
        console.error('Error getting message:', error);
        res.status(500).json({ error: 'Failed to get message' });
    }
});

/**
 * PATCH /orgs/:orgId/messages/:messageId
 * Update message (edit, HITL approval)
 */
router.patch('/orgs/:orgId/messages/:messageId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, messageId } = req.params;
        const userId = req.user.id;
        const { content, approval_status, verify_status, verify_flags_json } = req.body;

        const message = prepare('SELECT * FROM messages WHERE id = ? AND org_id = ?')
            .get(messageId, orgId);

        if (!message || !isMessageOwner(message, userId)) {
            return res.status(404).json({ error: 'Message not found' });
        }

        const updates = [];
        const params = [];

        // Content edit (marks message as edited)
        if (content !== undefined && content !== message.content) {
            updates.push('content = ?', 'edited = 1', 'edited_at = ?');
            params.push(content, new Date().toISOString());
        }

        // HITL approval
        if (approval_status !== undefined) {
            updates.push('approval_status = ?', 'approved_by = ?', 'approved_at = ?');
            params.push(approval_status, userId, new Date().toISOString());

            createAuditEvent({
                orgId,
                actorType: 'user',
                actorId: userId,
                action: `message.${approval_status}`,
                targetType: 'message',
                targetId: messageId,
                metadata: { previous_status: message.approval_status }
            });
        }

        // L8 Verify status update
        if (verify_status !== undefined) {
            updates.push('verify_status = ?');
            params.push(verify_status);
        }
        if (verify_flags_json !== undefined) {
            updates.push('verify_flags_json = ?');
            params.push(verify_flags_json);
        }

        if (updates.length > 0) {
            params.push(messageId, orgId);
            prepare(`UPDATE messages SET ${updates.join(', ')} WHERE id = ? AND org_id = ?`)
                .run(...params);
        }

        const updated = prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
        res.json({ message: updated });
    } catch (error) {
        console.error('Error updating message:', error);
        res.status(500).json({ error: 'Failed to update message' });
    }
});

/**
 * DELETE /orgs/:orgId/messages/:messageId
 * Soft delete a message
 */
router.delete('/orgs/:orgId/messages/:messageId', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, messageId } = req.params;

        const message = prepare('SELECT * FROM messages WHERE id = ? AND org_id = ?')
            .get(messageId, orgId);

        if (!message || !isMessageOwner(message, req.user.id)) {
            return res.status(404).json({ error: 'Message not found' });
        }

        prepare('UPDATE messages SET deleted_at = ? WHERE id = ?')
            .run(new Date().toISOString(), messageId);

        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting message:', error);
        res.status(500).json({ error: 'Failed to delete message' });
    }
});

// ============================================================================
// MESSAGE REACTIONS
// ============================================================================

/**
 * POST /orgs/:orgId/messages/:messageId/reactions
 * Add a reaction to a message
 */
router.post('/orgs/:orgId/messages/:messageId/reactions', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, messageId } = req.params;
        const userId = req.user.id;
        const { reaction_type, feedback_text } = req.body;

        if (!reaction_type) {
            return res.status(400).json({ error: 'reaction_type is required' });
        }

        // Verify message exists
        const message = prepare('SELECT id FROM messages WHERE id = ? AND org_id = ?')
            .get(messageId, orgId);

        if (!message) {
            return res.status(404).json({ error: 'Message not found' });
        }

        const id = ulid();

        // Upsert reaction
        prepare(`
            INSERT INTO message_reactions (id, message_id, user_id, reaction_type, feedback_text, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(message_id, user_id, reaction_type)
            DO UPDATE SET feedback_text = excluded.feedback_text, created_at = excluded.created_at
        `).run(id, messageId, userId, reaction_type, feedback_text || null, new Date().toISOString());

        res.status(201).json({ success: true, reaction_id: id });
    } catch (error) {
        console.error('Error adding reaction:', error);
        res.status(500).json({ error: 'Failed to add reaction' });
    }
});

/**
 * DELETE /orgs/:orgId/messages/:messageId/reactions/:reactionType
 * Remove a reaction from a message
 */
router.delete('/orgs/:orgId/messages/:messageId/reactions/:reactionType', requireOrgMembership, async (req, res) => {
    try {
        const { orgId, messageId, reactionType } = req.params;
        const userId = req.user.id;

        prepare(`
            DELETE FROM message_reactions
            WHERE message_id = ? AND user_id = ? AND reaction_type = ?
        `).run(messageId, userId, reactionType);

        res.json({ success: true });
    } catch (error) {
        console.error('Error removing reaction:', error);
        res.status(500).json({ error: 'Failed to remove reaction' });
    }
});

// ============================================================================
// HITL: Pending Approvals
// ============================================================================

/**
 * GET /orgs/:orgId/messages/pending-approval
 * Get messages requiring HITL approval
 * Phase 2: Uses secure middleware for cross-org leak prevention
 */
router.get('/orgs/:orgId/messages/pending-approval', requireOrgMembershipSecure, async (req, res) => {
    try {
        const { orgId } = req.params;
        const { limit = 50 } = req.query;

        const messages = prepare(`
            SELECT m.*, c.title as conversation_title, c.agent_id
            FROM messages m
            JOIN conversations c ON m.conversation_id = c.id
            WHERE m.org_id = ?
              AND m.requires_approval = 1
              AND m.approval_status IS NULL
              AND m.deleted_at IS NULL
            ORDER BY m.created_at DESC
            LIMIT ?
        `).all(orgId, parseInt(limit));

        res.json({ messages });
    } catch (error) {
        console.error('Error listing pending approvals:', error);
        res.status(500).json({ error: 'Failed to list pending approvals' });
    }
});

export default router;
