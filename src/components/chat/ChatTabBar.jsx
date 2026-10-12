/**
 * ChatTabBar - Horizontal tab strip for multi-tab chat
 *
 * Mirrors the terminal workspace tab bar pattern.
 * Features: switch, close, add, inline rename (double-click).
 */

import { useState, useRef, useEffect } from 'react';
import { getAssistant, buildRuntimeAssistantConfig } from '../../services/entityRegistry';
import './chat-tab-bar.css';

function ChatTabBar({ tabs, activeTabId, onSwitch, onClose, onAdd, onRename, canAdd = true, warning }) {
    const [renamingId, setRenamingId] = useState(null);
    const [renameValue, setRenameValue] = useState('');
    const renameInputRef = useRef(null);
    const scrollRef = useRef(null);

    // Focus rename input when it appears
    useEffect(() => {
        if (renamingId && renameInputRef.current) {
            renameInputRef.current.focus();
            renameInputRef.current.select();
        }
    }, [renamingId]);

    const handleDoubleClick = (tab) => {
        setRenamingId(tab.id);
        setRenameValue(tab.name || getTabDisplayName(tab));
    };

    const commitRename = () => {
        if (renamingId) {
            onRename?.(renamingId, renameValue);
            setRenamingId(null);
        }
    };

    const cancelRename = () => {
        setRenamingId(null);
    };

    const handleRenameKeyDown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            commitRename();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelRename();
        }
    };

    return (
        <div className="chat-tab-bar" ref={scrollRef}>
            <div className="chat-tab-bar__tabs">
                {tabs.map((tab) => {
                    const isActive = tab.id === activeTabId;
                    const displayName = getTabDisplayName(tab);
                    const assistantColor = getAssistantColor(tab.assistantId);

                    return (
                        <div
                            key={tab.id}
                            className={`chat-tab ${isActive ? 'chat-tab--active' : ''}`}
                            onClick={() => onSwitch?.(tab.id)}
                            onDoubleClick={() => handleDoubleClick(tab)}
                            title={displayName}
                        >
                            <span
                                className="chat-tab__dot"
                                style={{ background: assistantColor }}
                            />

                            {renamingId === tab.id ? (
                                <input
                                    ref={renameInputRef}
                                    className="chat-tab__rename-input"
                                    value={renameValue}
                                    onChange={(e) => setRenameValue(e.target.value)}
                                    onBlur={commitRename}
                                    onKeyDown={handleRenameKeyDown}
                                    onClick={(e) => e.stopPropagation()}
                                    maxLength={30}
                                />
                            ) : (
                                <span className="chat-tab__name">{displayName}</span>
                            )}

                            <button
                                className="chat-tab__close"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onClose?.(tab.id);
                                }}
                                title="Close tab"
                                aria-label={`Close ${displayName}`}
                            >
                                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5">
                                    <path d="M18 6L6 18M6 6l12 12" />
                                </svg>
                            </button>
                        </div>
                    );
                })}
            </div>

            {canAdd && (
                <button
                    className="chat-tab__add"
                    onClick={() => onAdd?.()}
                    title="New chat tab"
                    aria-label="New chat tab"
                >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 5v14M5 12h14" />
                    </svg>
                </button>
            )}

            {warning && (
                <span className="chat-tab__warning">{warning}</span>
            )}
        </div>
    );
}

/** Get display name for a tab */
function getTabDisplayName(tab) {
    if (tab.name) return tab.name;
    const assistant = getAssistant(tab.assistantId);
    const config = assistant ? buildRuntimeAssistantConfig(assistant) : null;
    return config?.name || tab.assistantId || 'New Chat';
}

/** Get assistant color for the tab dot */
function getAssistantColor(assistantId) {
    const assistant = getAssistant(assistantId);
    const config = assistant ? buildRuntimeAssistantConfig(assistant) : null;
    if (config?.color?.primary) return config.color.primary;
    if (typeof config?.color === 'string') return config.color;
    // Fallback colors for scope/user assistants
    return '#8b5cf6';
}

export default ChatTabBar;
export { getTabDisplayName, getAssistantColor };
