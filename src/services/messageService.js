/**
 * Message Service
 * Frontend API client for conversations and messages
 *
 * Provides CRUD operations for:
 * - Conversations (chat sessions)
 * - Messages (with AOCL/AEE fields)
 * - Message reactions (thumbs up/down, flags)
 *
 * Usage:
 * const { authFetch, user } = useAuth();
 * const messageService = createMessageService(authFetch, user.orgMemberships[0]?.org_id);
 * const { conversation } = await messageService.createConversation({ agent_id: 'quox' });
 */

const AUTH_API = '/api';

/**
 * Create a message service instance
 * @param {Function} authFetch - Authenticated fetch from AuthContext
 * @param {string} orgId - Current organization ID
 * @returns {Object} Message service methods
 */
export function createMessageService(authFetch, orgId) {
    if (!authFetch) {
        throw new Error('authFetch is required');
    }
    if (!orgId) {
        console.warn('[MessageService] No orgId provided - API calls will fail');
    }

    const baseUrl = `${AUTH_API}/orgs/${orgId}`;

    // Helper for JSON requests
    const jsonFetch = async (url, options = {}) => {
        const response = await authFetch(url, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...options.headers
            }
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ error: 'Request failed' }));
            throw new Error(error.error || `HTTP ${response.status}`);
        }

        return response.json();
    };

    return {
        // ========================================
        // CONVERSATIONS
        // ========================================

        /**
         * List conversations for current user/org
         * @param {Object} options - Query options
         * @param {string} options.agent_id - Filter by agent
         * @param {string} options.status - Filter by status (active, archived)
         * @param {number} options.limit - Max results
         * @param {number} options.offset - Pagination offset
         */
        async listConversations(options = {}) {
            const params = new URLSearchParams();
            if (options.agent_id) params.set('agent_id', options.agent_id);
            if (options.status) params.set('status', options.status);
            if (options.limit) params.set('limit', options.limit);
            if (options.offset) params.set('offset', options.offset);

            const query = params.toString();
            return jsonFetch(`${baseUrl}/conversations${query ? `?${query}` : ''}`);
        },

        /**
         * Create a new conversation
         * @param {Object} data - Conversation data
         * @param {string} data.title - Optional title
         * @param {string} data.agent_id - Agent ID (default: 'quox')
         * @param {string} data.correlation_id - AEE correlation ID
         */
        async createConversation(data = {}) {
            return jsonFetch(`${baseUrl}/conversations`, {
                method: 'POST',
                body: JSON.stringify(data)
            });
        },

        /**
         * Get a conversation with messages
         * @param {string} conversationId - Conversation ID
         * @param {Object} options - Query options
         * @param {boolean} options.include_messages - Include messages (default: true)
         * @param {number} options.message_limit - Max messages to return
         */
        async getConversation(conversationId, options = {}) {
            const params = new URLSearchParams();
            if (options.include_messages !== undefined) {
                params.set('include_messages', options.include_messages);
            }
            if (options.message_limit) params.set('message_limit', options.message_limit);

            const query = params.toString();
            return jsonFetch(`${baseUrl}/conversations/${conversationId}${query ? `?${query}` : ''}`);
        },

        /**
         * Update a conversation
         * @param {string} conversationId - Conversation ID
         * @param {Object} data - Fields to update
         * @param {string} data.title - New title
         * @param {string} data.status - New status (active, archived)
         * @param {string} data.summary - AI-generated summary
         */
        async updateConversation(conversationId, data) {
            return jsonFetch(`${baseUrl}/conversations/${conversationId}`, {
                method: 'PATCH',
                body: JSON.stringify(data)
            });
        },

        /**
         * Archive a conversation
         * @param {string} conversationId - Conversation ID
         */
        async archiveConversation(conversationId) {
            return this.updateConversation(conversationId, { status: 'archived' });
        },

        // ========================================
        // MESSAGES
        // ========================================

        /**
         * List messages in a conversation
         * @param {string} conversationId - Conversation ID
         * @param {Object} options - Query options
         * @param {number} options.limit - Max messages
         * @param {number} options.offset - Pagination offset
         * @param {number} options.after_sequence - Get messages after this sequence
         */
        async listMessages(conversationId, options = {}) {
            const params = new URLSearchParams();
            if (options.limit) params.set('limit', options.limit);
            if (options.offset) params.set('offset', options.offset);
            if (options.after_sequence) params.set('after_sequence', options.after_sequence);

            const query = params.toString();
            return jsonFetch(`${baseUrl}/conversations/${conversationId}/messages${query ? `?${query}` : ''}`);
        },

        /**
         * Add a message to a conversation
         * @param {string} conversationId - Conversation ID
         * @param {Object} message - Message data
         * @param {string} message.role - 'user', 'assistant', 'system', 'tool'
         * @param {string} message.content - Message content
         * @param {string} message.sender_type - 'human', 'agent', 'system'
         * @param {string} message.sender_id - User or agent ID
         * @param {number} message.tokens_in - Input tokens
         * @param {number} message.tokens_out - Output tokens
         * @param {string} message.model - Model used
         * @param {string} message.aee_envelope_id - AEE envelope ID
         * @param {string} message.correlation_id - Correlation ID
         * @param {string} message.aocl_layers_json - JSON array of layers processed
         * @param {string} message.verify_status - L8 verify status
         * @param {boolean} message.requires_approval - HITL flag
         */
        async addMessage(conversationId, message) {
            return jsonFetch(`${baseUrl}/conversations/${conversationId}/messages`, {
                method: 'POST',
                body: JSON.stringify(message)
            });
        },

        /**
         * Batch insert messages (for migration)
         * @param {Object} data - Batch data
         * @param {string} data.conversation_id - Target conversation (optional if creating)
         * @param {Object} data.create_conversation - Create conversation if needed
         * @param {Array} data.messages - Messages to insert
         */
        async batchInsertMessages(data) {
            return jsonFetch(`${baseUrl}/messages/batch`, {
                method: 'POST',
                body: JSON.stringify(data)
            });
        },

        /**
         * Get a single message
         * @param {string} messageId - Message ID
         */
        async getMessage(messageId) {
            return jsonFetch(`${baseUrl}/messages/${messageId}`);
        },

        /**
         * Update a message (edit content, HITL approval)
         * @param {string} messageId - Message ID
         * @param {Object} data - Fields to update
         * @param {string} data.content - New content (marks as edited)
         * @param {string} data.approval_status - 'approved' or 'rejected'
         * @param {string} data.verify_status - L8 verify status
         */
        async updateMessage(messageId, data) {
            return jsonFetch(`${baseUrl}/messages/${messageId}`, {
                method: 'PATCH',
                body: JSON.stringify(data)
            });
        },

        /**
         * Delete a message (soft delete)
         * @param {string} messageId - Message ID
         */
        async deleteMessage(messageId) {
            return jsonFetch(`${baseUrl}/messages/${messageId}`, {
                method: 'DELETE'
            });
        },

        // ========================================
        // REACTIONS
        // ========================================

        /**
         * Add a reaction to a message
         * @param {string} messageId - Message ID
         * @param {string} reactionType - 'thumbs_up', 'thumbs_down', 'flag', 'bookmark'
         * @param {string} feedbackText - Optional feedback text
         */
        async addReaction(messageId, reactionType, feedbackText = null) {
            return jsonFetch(`${baseUrl}/messages/${messageId}/reactions`, {
                method: 'POST',
                body: JSON.stringify({ reaction_type: reactionType, feedback_text: feedbackText })
            });
        },

        /**
         * Remove a reaction from a message
         * @param {string} messageId - Message ID
         * @param {string} reactionType - Reaction type to remove
         */
        async removeReaction(messageId, reactionType) {
            return jsonFetch(`${baseUrl}/messages/${messageId}/reactions/${reactionType}`, {
                method: 'DELETE'
            });
        },

        // ========================================
        // SEARCH
        // ========================================

        /**
         * Search messages across conversations
         * @param {string} query - Search query text
         * @param {Object} options - Search options
         * @param {string} options.conversation_id - Limit to specific conversation
         * @param {string} options.agent_id - Filter by agent
         * @param {string} options.role - Filter by role ('user', 'assistant')
         * @param {number} options.limit - Max results
         * @param {number} options.offset - Pagination offset
         * @returns {Promise<Object>} Search results with messages and metadata
         */
        async searchMessages(query, options = {}) {
            const params = new URLSearchParams();
            params.set('q', query);
            if (options.conversation_id) params.set('conversation_id', options.conversation_id);
            if (options.agent_id) params.set('agent_id', options.agent_id);
            if (options.role) params.set('role', options.role);
            if (options.limit) params.set('limit', options.limit);
            if (options.offset) params.set('offset', options.offset);

            return jsonFetch(`${baseUrl}/messages/search?${params.toString()}`);
        },

        /**
         * Search messages locally (client-side fallback when backend search unavailable)
         * @param {Array} messages - Array of messages to search
         * @param {string} query - Search query text
         * @returns {Array} Matching messages with index and snippets
         */
        searchMessagesLocal(messages, query) {
            if (!query || query.length < 2 || !messages?.length) return [];

            const lowerQuery = query.toLowerCase();
            const results = [];

            messages.forEach((msg, index) => {
                const text = msg.text || msg.content || '';
                const lowerText = text.toLowerCase();
                const matchIndex = lowerText.indexOf(lowerQuery);

                if (matchIndex !== -1) {
                    // Extract snippet around the match
                    const snippetStart = Math.max(0, matchIndex - 40);
                    const snippetEnd = Math.min(text.length, matchIndex + query.length + 60);
                    let snippet = text.substring(snippetStart, snippetEnd);

                    // Add ellipsis if truncated
                    if (snippetStart > 0) snippet = '...' + snippet;
                    if (snippetEnd < text.length) snippet = snippet + '...';

                    results.push({
                        index,
                        message: msg,
                        snippet,
                        matchIndex
                    });
                }
            });

            return results;
        },

        // ========================================
        // HITL
        // ========================================

        /**
         * Get messages pending approval
         * @param {Object} options - Query options
         * @param {number} options.limit - Max results
         */
        async getPendingApprovals(options = {}) {
            const params = new URLSearchParams();
            if (options.limit) params.set('limit', options.limit);

            const query = params.toString();
            return jsonFetch(`${baseUrl}/messages/pending-approval${query ? `?${query}` : ''}`);
        },

        /**
         * Approve a message
         * @param {string} messageId - Message ID
         */
        async approveMessage(messageId) {
            return this.updateMessage(messageId, { approval_status: 'approved' });
        },

        /**
         * Reject a message
         * @param {string} messageId - Message ID
         */
        async rejectMessage(messageId) {
            return this.updateMessage(messageId, { approval_status: 'rejected' });
        },

        // ========================================
        // MIGRATION HELPERS
        // ========================================

        /**
         * Migrate localStorage conversations to database
         * @param {string} agentId - Agent ID to migrate
         * @returns {Object} Migration result with details about success/failure
         */
        async migrateLocalStorage(agentId = 'quox') {
            // Find all localStorage keys for this agent
            const sessionKey = `quox-session-${agentId}`;
            const sessionId = localStorage.getItem(sessionKey);

            if (!sessionId) {
                return { migrated: false, reason: 'No session found' };
            }

            const convoKey = `quox-convo-${agentId}-${sessionId}`;
            const corrKey = `quox-corr-${agentId}`;

            const messagesJson = localStorage.getItem(convoKey);
            const correlationId = localStorage.getItem(corrKey);

            if (!messagesJson) {
                return { migrated: false, reason: 'No messages found' };
            }

            try {
                const messages = JSON.parse(messagesJson);
                if (!messages || messages.length === 0) {
                    return { migrated: false, reason: 'Empty messages array' };
                }

                // Convert localStorage format to API format with index tracking
                const apiMessages = messages.map((msg, index) => ({
                    _localIndex: index, // Track original index for error handling
                    role: msg.role,
                    content: msg.text || msg.content,
                    sender_type: msg.role === 'user' ? 'human' : 'agent',
                    sender_id: msg.role === 'user' ? undefined : (msg.assistant || agentId),
                    correlation_id: correlationId,
                    envelope_id: msg.envelopeId
                }));

                // Batch insert with conversation creation
                const result = await this.batchInsertMessages({
                    create_conversation: { agent_id: agentId },
                    messages: apiMessages.map(({ _localIndex, ...msg }) => msg) // Remove tracking field
                });

                // Check for partial success - only clear localStorage if ALL messages migrated
                const totalMessages = messages.length;
                const insertedCount = result.inserted_count || 0;
                const failedMessages = result.failed_messages || [];

                if (failedMessages.length > 0 || insertedCount < totalMessages) {
                    // Partial success - keep failed messages in localStorage
                    const failedIndices = new Set(failedMessages.map(f => f.index));

                    // If we have explicit failed indices, filter them out
                    // Otherwise, assume last (totalMessages - insertedCount) messages failed
                    let remainingMessages;
                    if (failedMessages.length > 0) {
                        remainingMessages = messages.filter((_, idx) => failedIndices.has(idx));
                    } else {
                        // Conservative: keep all messages that might have failed
                        remainingMessages = messages.slice(insertedCount);
                    }

                    // Log which messages failed for debugging
                    console.warn('[MessageService] Partial migration - some messages failed:', {
                        total: totalMessages,
                        inserted: insertedCount,
                        failed: failedMessages.length || (totalMessages - insertedCount),
                        failedDetails: failedMessages
                    });

                    // Update localStorage with only the failed messages (don't delete!)
                    if (remainingMessages.length > 0) {
                        localStorage.setItem(convoKey, JSON.stringify(remainingMessages));
                        console.log(`[MessageService] Retained ${remainingMessages.length} failed messages in localStorage for retry`);
                    } else {
                        // All accounted for, safe to clear
                        localStorage.removeItem(sessionKey);
                        localStorage.removeItem(convoKey);
                        localStorage.removeItem(corrKey);
                    }

                    return {
                        migrated: 'partial',
                        conversation_id: result.conversation_id,
                        message_count: insertedCount,
                        failed_count: totalMessages - insertedCount,
                        failed_messages: failedMessages,
                        retry_available: remainingMessages.length > 0
                    };
                }

                // Full success - safe to clear localStorage
                localStorage.removeItem(sessionKey);
                localStorage.removeItem(convoKey);
                localStorage.removeItem(corrKey);

                return {
                    migrated: true,
                    conversation_id: result.conversation_id,
                    message_count: result.inserted_count
                };
            } catch (err) {
                // Complete failure - DO NOT clear localStorage, preserve all data
                console.error('[MessageService] Migration failed:', err);
                console.log('[MessageService] localStorage preserved for retry');
                return {
                    migrated: false,
                    reason: err.message,
                    retry_available: true
                };
            }
        },

        /**
         * Retry migration of failed messages from localStorage
         * @param {string} agentId - Agent ID to retry migration for
         * @param {string} conversationId - Existing conversation ID to add messages to
         * @returns {Object} Retry result
         */
        async retryFailedMigration(agentId = 'quox', conversationId = null) {
            const sessionKey = `quox-session-${agentId}`;
            const sessionId = localStorage.getItem(sessionKey);

            if (!sessionId) {
                return { success: false, reason: 'No session found to retry' };
            }

            const convoKey = `quox-convo-${agentId}-${sessionId}`;
            const messagesJson = localStorage.getItem(convoKey);

            if (!messagesJson) {
                return { success: false, reason: 'No messages found to retry' };
            }

            try {
                const messages = JSON.parse(messagesJson);
                if (!messages || messages.length === 0) {
                    // Clean up empty storage
                    localStorage.removeItem(convoKey);
                    return { success: true, reason: 'No messages to retry (cleaned up)' };
                }

                console.log(`[MessageService] Retrying migration of ${messages.length} messages`);

                // Use existing conversation if provided, otherwise create new one
                const result = await this.migrateLocalStorage(agentId);

                return {
                    success: result.migrated === true,
                    ...result
                };
            } catch (err) {
                console.error('[MessageService] Retry migration failed:', err);
                return {
                    success: false,
                    reason: err.message,
                    retry_available: true
                };
            }
        }
    };
}

/**
 * Hook-friendly singleton pattern
 * Use this when you need message service outside of React components
 */
let cachedService = null;
let cachedOrgId = null;
let cachedAuthFetch = null;

export function getMessageService(authFetch, orgId) {
    if (cachedService && cachedOrgId === orgId && cachedAuthFetch === authFetch) {
        return cachedService;
    }

    cachedService = createMessageService(authFetch, orgId);
    cachedOrgId = orgId;
    cachedAuthFetch = authFetch;

    return cachedService;
}

export default createMessageService;
