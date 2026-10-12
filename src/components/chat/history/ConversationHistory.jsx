/**
 * ConversationHistory - Browse Past Conversations
 *
 * Features:
 * - Lists conversations grouped by date
 * - Shows preview, agent, message count, timestamp
 * - Search and filter functionality
 * - Click to load/continue a conversation
 *
 * Designed to match the dark theme of the Quox dashboard.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { createMessageService } from '../../../services/messageService';
import { buildAssistantIdentityMap, getAssistantDisplayName, resolveAssistantIdentity } from '../../../services/assistantIdentity';
import { loadUserEntities } from '../../../services/entityRegistry';
import './conversation-history.css';

/**
 * Group conversations by date (Today, Yesterday, This Week, Older)
 */
function groupByDate(conversations) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const thisWeek = new Date(today);
    thisWeek.setDate(thisWeek.getDate() - 7);

    const groups = {
        today: [],
        yesterday: [],
        thisWeek: [],
        older: []
    };

    conversations.forEach(conv => {
        const date = new Date(conv.updated_at || conv.created_at);
        if (date >= today) {
            groups.today.push(conv);
        } else if (date >= yesterday) {
            groups.yesterday.push(conv);
        } else if (date >= thisWeek) {
            groups.thisWeek.push(conv);
        } else {
            groups.older.push(conv);
        }
    });

    return groups;
}

/**
 * Format timestamp for display
 */
function formatTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (diffDays === 1) {
        return 'Yesterday';
    } else if (diffDays < 7) {
        return date.toLocaleDateString([], { weekday: 'short' });
    } else {
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
}

/**
 * ConversationItem - Single conversation in the list
 * H13 fix: Added isLoading prop for visual feedback
 * H16 fix: Added onArchive prop to wire archive functionality
 */
function ConversationItem({ conversation, assistantIdentities, isActive, isLoading, onClick, onArchive }) {
    const agentConfig = resolveAssistantIdentity(conversation.agent_id, {
        runtimeMap: assistantIdentities,
        fallbackId: 'quox',
    });
    const preview = conversation.title ||
                   conversation.first_message_preview ||
                   'New conversation';

    return (
        <button
            className={`conversation-item ${isActive ? 'conversation-item--active' : ''} ${isLoading ? 'conversation-item--loading' : ''}`}
            onClick={() => onClick(conversation)}
            disabled={isLoading}
        >
            <div className="conversation-item__avatar">
                {isLoading ? (
                    <div className="conversation-item__spinner"></div>
                ) : (
                    <svg viewBox="0 0 24 24" width="20" height="20" style={{ fill: 'none', stroke: 'rgba(255,255,255,0.7)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
                        <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>
                    </svg>
                )}
            </div>
            <div className="conversation-item__content">
                <div className="conversation-item__header">
                    <span className="conversation-item__agent" title={agentConfig.name}>
                        {agentConfig.name}
                    </span>
                    <span className="conversation-item__time">
                        {formatTime(conversation.updated_at || conversation.created_at)}
                    </span>
                </div>
                <div className="conversation-item__preview" title={preview}>
                    {preview}
                </div>
                <div className="conversation-item__meta">
                    {conversation.message_count > 0 && (
                        <span className="conversation-item__count">
                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
                            </svg>
                            {conversation.message_count}
                        </span>
                    )}
                    {conversation.status === 'archived' && (
                        <span className="conversation-item__badge conversation-item__badge--archived">
                            Archived
                        </span>
                    )}
                    {/* H16 fix: Wire archive button to handleArchive */}
                    {onArchive && conversation.status !== 'archived' && (
                        <button
                            className="conversation-item__archive-btn"
                            onClick={(e) => onArchive(e, conversation.id)}
                            title="Archive conversation"
                        >
                            <svg viewBox="0 0 24 24" width="14" height="14" style={{ fill: 'none', stroke: 'rgba(255,255,255,0.7)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }}>
                                <polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>
                            </svg>
                        </button>
                    )}
                </div>
            </div>
        </button>
    );
}

/**
 * ConversationGroup - Group of conversations with date header
 * H13/H16 fix: Pass loading state and archive handler to items
 */
function ConversationGroup({ title, conversations, assistantIdentities, activeId, loadingId, onSelect, onArchive }) {
    if (conversations.length === 0) return null;

    return (
        <div className="conversation-group">
            <div className="conversation-group__header">
                <span className="conversation-group__title">{title}</span>
                <span className="conversation-group__count">{conversations.length}</span>
            </div>
            <div className="conversation-group__list">
                {conversations.map(conv => (
                    <ConversationItem
                        key={conv.id}
                        conversation={conv}
                        assistantIdentities={assistantIdentities}
                        isActive={conv.id === activeId}
                        isLoading={conv.id === loadingId}
                        onClick={onSelect}
                        onArchive={onArchive}
                    />
                ))}
            </div>
        </div>
    );
}

/**
 * ConversationHistory Component
 */
export function ConversationHistory({
    isOpen,
    onClose,
    onSelect,
    activeConversationId = null
}) {
    const { authFetch, user, isAuthenticated } = useAuth();
    const [conversations, setConversations] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [filterAgent, setFilterAgent] = useState('all');
    const [filterStatus, setFilterStatus] = useState('active');
    const [loadingConversation, setLoadingConversation] = useState(null);  // H13 fix: Loading state for selection
    const [hasMore, setHasMore] = useState(false);  // H12 fix: Pagination
    const [offset, setOffset] = useState(0);  // H12 fix: Pagination offset
    const [assistantIdentities, setAssistantIdentities] = useState({});
    const PAGE_SIZE = 50;

    // Get org ID from user
    const orgId = useMemo(() => {
        if (!user?.orgMemberships?.length) return null;
        return user.orgMemberships[0]?.org_id;
    }, [user]);

    // Create message service
    const messageService = useMemo(() => {
        if (!authFetch || !orgId) return null;
        try {
            return createMessageService(authFetch, orgId);
        } catch (err) {
            console.error('[ConversationHistory] Failed to create message service:', err);
            return null;
        }
    }, [authFetch, orgId]);

    // Fetch conversations with pagination (H12 fix)
    const fetchConversations = useCallback(async (loadMore = false) => {
        if (!messageService) return;

        setLoading(true);
        setError(null);

        try {
            const currentOffset = loadMore ? offset : 0;
            const params = {
                limit: PAGE_SIZE,
                offset: currentOffset,
                status: filterStatus === 'all' ? undefined : filterStatus
            };
            if (filterAgent !== 'all') {
                params.agent_id = filterAgent;
            }

            const result = await messageService.listConversations(params);
            const newConversations = result.conversations || [];

            if (loadMore) {
                setConversations(prev => [...prev, ...newConversations]);
            } else {
                setConversations(newConversations);
            }

            // H12 fix: Check if there are more conversations to load
            setHasMore(newConversations.length === PAGE_SIZE);
            setOffset(currentOffset + newConversations.length);
        } catch (err) {
            console.error('[ConversationHistory] Failed to fetch conversations:', err);
            setError('Failed to load conversations');
        } finally {
            setLoading(false);
        }
    }, [messageService, filterAgent, filterStatus, offset]);

    useEffect(() => {
        if (!isOpen || !orgId || !authFetch) return;
        let cancelled = false;

        loadUserEntities(orgId, authFetch)
            .then((entities) => {
                if (!cancelled) {
                    setAssistantIdentities(buildAssistantIdentityMap(entities));
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setAssistantIdentities({});
                }
            });

        return () => {
            cancelled = true;
        };
    }, [isOpen, orgId, authFetch]);

    // Load more conversations (H12 fix)
    const loadMoreConversations = useCallback(() => {
        fetchConversations(true);
    }, [fetchConversations]);

    // Fetch on open or filter change - reset offset on filter change
    useEffect(() => {
        if (isOpen && messageService) {
            setOffset(0);  // Reset pagination on filter change
            fetchConversations(false);
        }
    }, [isOpen, messageService, filterAgent, filterStatus]);

    // Filter conversations by search query
    const filteredConversations = useMemo(() => {
        if (!searchQuery.trim()) return conversations;

        const query = searchQuery.toLowerCase();
        return conversations.filter(conv => {
            const title = (conv.title || '').toLowerCase();
            const preview = (conv.first_message_preview || '').toLowerCase();
            const agent = (conv.agent_id || '').toLowerCase();
            return title.includes(query) || preview.includes(query) || agent.includes(query);
        });
    }, [conversations, searchQuery]);

    // Group conversations by date
    const groupedConversations = useMemo(() => {
        return groupByDate(filteredConversations);
    }, [filteredConversations]);

    // Handle conversation selection (H13 fix: added loading state)
    const handleSelect = useCallback(async (conversation) => {
        if (!messageService) return;

        setLoadingConversation(conversation.id);  // H13 fix: Show loading state
        setError(null);

        try {
            // Fetch full conversation with messages
            const result = await messageService.getConversation(conversation.id, {
                include_messages: true,
                message_limit: 50
            });

            // Transform to the format HomeView expects
            const messages = (result.messages || []).map(msg => ({
                role: msg.role,
                text: msg.content,
                assistant: msg.sender_id,
                envelopeId: msg.aee_envelope_id,
                memoryUsed: false
            }));

            onSelect?.({
                id: conversation.id,
                messages,
                agent_id: conversation.agent_id,
                correlation_id: conversation.correlation_id
            });

            onClose?.();
        } catch (err) {
            console.error('[ConversationHistory] Failed to load conversation:', err);
            setError('Failed to load conversation');
        } finally {
            setLoadingConversation(null);  // H13 fix: Clear loading state
        }
    }, [messageService, onSelect, onClose]);

    // Handle archive
    const handleArchive = useCallback(async (e, conversationId) => {
        e.stopPropagation();
        if (!messageService) return;

        try {
            await messageService.archiveConversation(conversationId);
            fetchConversations();
        } catch (err) {
            console.error('[ConversationHistory] Failed to archive:', err);
        }
    }, [messageService, fetchConversations]);

    // Get available agents for filter
    const availableAgents = useMemo(() => {
        const agents = new Set(conversations.map(c => c.agent_id).filter(Boolean));
        return Array.from(agents);
    }, [conversations]);

    if (!isOpen) return null;

    return (
        <div className="conversation-history-overlay" onClick={onClose}>
            <div className="conversation-history" onClick={e => e.stopPropagation()}>
                {/* Header */}
                <div className="conversation-history__header">
                    <h2 className="conversation-history__title">
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                        </svg>
                        Chat History
                    </h2>
                    <button className="conversation-history__close" onClick={onClose} title="Close">
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M18 6L6 18M6 6l12 12"/>
                        </svg>
                    </button>
                </div>

                {/* Search & Filters */}
                <div className="conversation-history__filters">
                    <div className="conversation-history__search">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                        </svg>
                        <input
                            type="text"
                            placeholder="Search conversations..."
                            value={searchQuery}
                            onChange={e => setSearchQuery(e.target.value)}
                            className="conversation-history__search-input"
                        />
                    </div>
                    <div className="conversation-history__filter-row">
                        <select
                            value={filterAgent}
                            onChange={e => setFilterAgent(e.target.value)}
                            className="conversation-history__filter-select"
                        >
                            <option value="all">All Agents</option>
                            {availableAgents.map(agent => (
                                <option key={agent} value={agent}>
                                    {getAssistantDisplayName(agent, { runtimeMap: assistantIdentities })}
                                </option>
                            ))}
                        </select>
                        <select
                            value={filterStatus}
                            onChange={e => setFilterStatus(e.target.value)}
                            className="conversation-history__filter-select"
                        >
                            <option value="active">Active</option>
                            <option value="archived">Archived</option>
                            <option value="all">All</option>
                        </select>
                    </div>
                </div>

                {/* Content */}
                <div className="conversation-history__content">
                    {!isAuthenticated && (
                        <div className="conversation-history__empty">
                            <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.3">
                                <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
                            </svg>
                            <p>Sign in to view your conversation history</p>
                        </div>
                    )}

                    {isAuthenticated && loading && (
                        <div className="conversation-history__loading">
                            <div className="conversation-history__spinner"></div>
                            <p>Loading conversations...</p>
                        </div>
                    )}

                    {isAuthenticated && error && (
                        <div className="conversation-history__error">
                            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/>
                            </svg>
                            <p>{error}</p>
                            <button onClick={fetchConversations} className="conversation-history__retry-btn">
                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M21 12a9 9 0 11-6.22-8.56"/><path d="M21 3v6h-6"/>
                                </svg>
                                Retry
                            </button>
                        </div>
                    )}

                    {isAuthenticated && !loading && !error && filteredConversations.length === 0 && (
                        <div className="conversation-history__empty">
                            <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.3">
                                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
                            </svg>
                            <p>
                                {searchQuery ? 'No conversations match your search' : 'No conversations yet'}
                            </p>
                            {!searchQuery && (
                                <span className="conversation-history__empty-hint">
                                    Start a chat to begin saving history
                                </span>
                            )}
                        </div>
                    )}

                    {isAuthenticated && !loading && !error && filteredConversations.length > 0 && (
                        <div className="conversation-history__list">
                            <ConversationGroup
                                title="Today"
                                conversations={groupedConversations.today}
                                assistantIdentities={assistantIdentities}
                                activeId={activeConversationId}
                                loadingId={loadingConversation}
                                onSelect={handleSelect}
                                onArchive={handleArchive}
                            />
                            <ConversationGroup
                                title="Yesterday"
                                conversations={groupedConversations.yesterday}
                                assistantIdentities={assistantIdentities}
                                activeId={activeConversationId}
                                loadingId={loadingConversation}
                                onSelect={handleSelect}
                                onArchive={handleArchive}
                            />
                            <ConversationGroup
                                title="This Week"
                                conversations={groupedConversations.thisWeek}
                                assistantIdentities={assistantIdentities}
                                activeId={activeConversationId}
                                loadingId={loadingConversation}
                                onSelect={handleSelect}
                                onArchive={handleArchive}
                            />
                            <ConversationGroup
                                title="Older"
                                conversations={groupedConversations.older}
                                assistantIdentities={assistantIdentities}
                                activeId={activeConversationId}
                                loadingId={loadingConversation}
                                onSelect={handleSelect}
                                onArchive={handleArchive}
                            />
                            {/* H12 fix: Load more button for pagination */}
                            {hasMore && (
                                <button
                                    className="conversation-history__load-more"
                                    onClick={loadMoreConversations}
                                    disabled={loading}
                                >
                                    {loading ? 'Loading...' : 'Load more conversations'}
                                </button>
                            )}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="conversation-history__footer">
                    <span className="conversation-history__count">
                        {filteredConversations.length} conversation{filteredConversations.length !== 1 ? 's' : ''}
                    </span>
                </div>
            </div>
        </div>
    );
}

export default ConversationHistory;
