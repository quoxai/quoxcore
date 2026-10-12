/**
 * ScopeChatPanel — First-class scope assistant with visualizer.
 *
 * Wraps ChatEngine with a scope-specific contextBuilder, VisualizerSection
 * (HAL eye), and reusable ChatInput. Lives in the main content area
 * of the scope dashboard, not the sidebar.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { ChatEngine } from '../chat/ChatEngine';
import MarkdownContent from '../ui/MarkdownContent';
import { VisualizerSection } from '../chat/sidebar/VisualizerSection';
import { ChatInput } from '../chat/input/ChatInput';
import { GlassChatPanel } from '../chat/glass';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useSettings } from '../../hooks/useSettings';

export default function ScopeChatPanel({
    entityType,
    entityId,
    entityName,
    scopeId,
    scopeAssistant,
    members = [],
    teams = [],
    childEntities = [],
    accentColour = '#38bdf8',
}) {
    const { authFetch } = useAuth();
    const { currentOrg } = useWorkspace();
    const { getSetting } = useSettings();
    const useGlassChat = getSetting('useGlassChat', false);
    const messagesEndRef = useRef(null);
    const panelRef = useRef(null);
    const activeAssistantId = scopeAssistant?.id || 'quox';
    const activeAssistantName = scopeAssistant?.name || `${entityName} Assistant`;

    // Session prefix unique per scope entity
    const sessionPrefix = entityId ? `SCOPE_${entityType}_${entityId}` : 'SCOPE_pending';
    const orgId = currentOrg?.id;

    // Context builder — formats scope data as markdown for the assistant
    const buildScopeContext = useCallback(async () => {
        const lines = [
            `## Current Scope Context`,
            `- **Type:** ${entityType}`,
            `- **Name:** ${entityName}`,
            scopeId ? `- **Scope ID:** ${scopeId}` : null,
            '',
        ];

        if (members.length > 0) {
            lines.push(`### Members (${members.length})`);
            members.slice(0, 15).forEach(m => {
                lines.push(`- ${m.name || m.email} (${m.role})`);
            });
            if (members.length > 15) lines.push(`- ... and ${members.length - 15} more`);
            lines.push('');
        }

        if (teams.length > 0) {
            lines.push(`### Teams (${teams.length})`);
            teams.slice(0, 10).forEach(t => {
                lines.push(`- ${t.name}${t.member_count != null ? ` (${t.member_count} members)` : ''}`);
            });
            if (teams.length > 10) lines.push(`- ... and ${teams.length - 10} more`);
            lines.push('');
        }

        if (childEntities.length > 0) {
            const childType = entityType === 'org' ? 'Divisions' : entityType === 'division' ? 'Departments' : 'Sub-units';
            lines.push(`### ${childType} (${childEntities.length})`);
            childEntities.slice(0, 10).forEach(c => {
                lines.push(`- ${c.name}`);
            });
            if (childEntities.length > 10) lines.push(`- ... and ${childEntities.length - 10} more`);
            lines.push('');
        }

        lines.push(`You are the "${activeAssistantName}" for the ${entityName} ${entityType} scope. Answer questions about its members, teams, structure, and operations. Be concise.`);

        return lines.filter(l => l !== null).join('\n');
    }, [entityType, entityName, scopeId, members, teams, childEntities, activeAssistantName]);

    // Auto-scroll on new messages
    const scrollToBottom = useCallback(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, []);

    // Expose expandAndFocus on the panel DOM element for external scroll-to
    useEffect(() => {
        if (panelRef.current) {
            panelRef.current.__expandChat = () => {
                panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            };
        }
    }, []);

    // Guard — don't render ChatEngine until we have an entity
    if (!entityId) {
        return (
            <div className="scope-assistant scope-assistant--empty" id="scope-chat-panel" style={{ '--scope-accent': accentColour }}>
                <div className="scope-assistant__placeholder">
                    Scope assistant will appear once data loads...
                </div>
            </div>
        );
    }

    return (
        <div
            ref={panelRef}
            className="scope-assistant"
            style={{ '--scope-accent': accentColour }}
            id="scope-chat-panel"
        >
            {/* Visualizer — HAL eye */}
            <div className="scope-assistant__viz">
                <VisualizerSection
                    agent={activeAssistantId}
                    state="idle"
                    showVoice={false}
                    showControls={true}
                    showStatus={false}
                    defaultCollapsed={false}
                    storageKey={`scope-viz-${entityType}-collapsed`}
                />
            </div>

            {/* Chat body — uses ChatEngine render-prop */}
            <ChatEngine
                agent={activeAssistantId}
                contextBuilder={buildScopeContext}
                sessionPrefix={sessionPrefix}
                enableSmartRouter={true}
                enableMemory={true}
                authFetch={authFetch}
                orgId={orgId}
                enablePersistence={!!orgId}
            >
                {(chatState) => {
                    const { messages, isProcessing, halState, sendMessage, abortMessage } = chatState;

                    const handleSend = (text) => {
                        if (!text || isProcessing) return;
                        sendMessage(text);
                        setTimeout(scrollToBottom, 100);
                    };

                    const messageList = (
                        <>
                            {messages.length === 0 && (
                                <div className="scope-assistant__empty">
                                    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.3, marginBottom: 8 }}>
                                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                                    </svg>
                                    Ask anything about {entityName}...
                                </div>
                            )}
                            {messages.map((msg, i) => (
                                <div
                                    key={msg.messageId || i}
                                    className={`scope-assistant__msg scope-assistant__msg--${msg.role === 'user' ? 'user' : 'assistant'}`}
                                >
                                    <div className="scope-assistant__msg-text">
                                        <MarkdownContent compact>{msg.text}</MarkdownContent>
                                    </div>
                                </div>
                            ))}
                            {isProcessing && (
                                <div className="scope-assistant__msg scope-assistant__msg--assistant">
                                    <div className="scope-assistant__typing">
                                        <span /><span /><span />
                                    </div>
                                </div>
                            )}
                            <div ref={messagesEndRef} />
                        </>
                    );

                    if (useGlassChat) {
                        return (
                            <GlassChatPanel
                                variant="compact"
                                agent={activeAssistantId}
                                halState={halState || 'idle'}
                                isProcessing={isProcessing}
                                onSend={handleSend}
                                onStop={abortMessage}
                                placeholder={`Ask about ${entityName}...`}
                                enableVoice={false}
                            >
                                <div className="scope-assistant__messages">{messageList}</div>
                            </GlassChatPanel>
                        );
                    }

                    return (
                        <>
                            {/* Messages area */}
                            <div className="scope-assistant__messages">{messageList}</div>

                            {/* Input — reusable ChatInput */}
                            <div className="scope-assistant__input-wrap">
                                <ChatInput
                                    onSend={handleSend}
                                    onStop={abortMessage}
                                    placeholder={`Ask about ${entityName}...`}
                                    isProcessing={isProcessing}
                                    enableVoice={false}
                                    enableFileUpload={false}
                                    hints={false}
                                    maxRows={3}
                                />
                            </div>
                        </>
                    );
                }}
            </ChatEngine>
        </div>
    );
}
