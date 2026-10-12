/**
 * ChatSearch - Search UI for finding messages in chat history
 *
 * Features:
 * - Search input with expandable icon
 * - Keyboard shortcut (Ctrl/Cmd+F)
 * - Real-time filtering of conversation history
 * - Highlights matching text
 * - Click to jump to message
 *
 * Usage:
 * <ChatSearch
 *   messages={conversationHistory}
 *   onJumpToMessage={(index) => scrollToMessage(index)}
 * />
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import './ChatSearch.css';

/**
 * Highlight search term in text
 * @param {string} text - Text to search in
 * @param {string} term - Search term to highlight
 * @returns {React.ReactNode} Text with highlighted matches
 */
function highlightMatch(text, term) {
    if (!term || term.length < 2) return text;

    const regex = new RegExp(`(${escapeRegex(term)})`, 'gi');
    const parts = text.split(regex);

    // Use case-insensitive comparison instead of regex.test() to avoid
    // lastIndex bug with global flag (H6 fix - skipping every other match)
    const lowerTerm = term.toLowerCase();
    return parts.map((part, i) =>
        part.toLowerCase() === lowerTerm ? (
            <mark key={i} className="chat-search__highlight">{part}</mark>
        ) : (
            part
        )
    );
}

/**
 * Escape special regex characters
 */
function escapeRegex(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Search messages for matching text
 * @param {Array} messages - Array of message objects
 * @param {string} query - Search query
 * @returns {Array} Matching messages with index and snippets
 */
function searchMessages(messages, query) {
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
}

/**
 * Format relative time for search results
 */
function formatRelativeTime(timestamp) {
    if (!timestamp) return '';

    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function ChatSearch({
    messages = [],
    onJumpToMessage,
    className = ''
}) {
    const [isOpen, setIsOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [results, setResults] = useState([]);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const inputRef = useRef(null);
    const resultsRef = useRef(null);

    // Search when query changes
    useEffect(() => {
        const searchResults = searchMessages(messages, query);
        setResults(searchResults);
        setSelectedIndex(0);
    }, [query, messages]);

    // Keyboard shortcut to open search (Ctrl/Cmd+F)
    useEffect(() => {
        const handleKeyDown = (e) => {
            // Ctrl+F or Cmd+F to open search
            if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                e.preventDefault();
                setIsOpen(true);
                setTimeout(() => inputRef.current?.focus(), 50);
            }

            // Escape to close
            if (e.key === 'Escape' && isOpen) {
                e.preventDefault();
                handleClose();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen]);

    // Navigate results with arrow keys
    useEffect(() => {
        if (!isOpen || results.length === 0) return;

        const handleKeyDown = (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelectedIndex(prev => Math.min(prev + 1, results.length - 1));
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelectedIndex(prev => Math.max(prev - 1, 0));
            } else if (e.key === 'Enter' && results[selectedIndex]) {
                e.preventDefault();
                handleResultClick(results[selectedIndex]);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, results, selectedIndex]);

    // Scroll selected result into view
    useEffect(() => {
        if (resultsRef.current && results.length > 0) {
            const selectedEl = resultsRef.current.children[selectedIndex];
            selectedEl?.scrollIntoView({ block: 'nearest' });
        }
    }, [selectedIndex, results.length]);

    const handleOpen = useCallback(() => {
        setIsOpen(true);
        setTimeout(() => inputRef.current?.focus(), 50);
    }, []);

    const handleClose = useCallback(() => {
        setIsOpen(false);
        setQuery('');
        setResults([]);
        setSelectedIndex(0);
    }, []);

    const handleResultClick = useCallback((result) => {
        onJumpToMessage?.(result.index, result.message);
        handleClose();
    }, [onJumpToMessage, handleClose]);

    // Collapsed search icon button
    if (!isOpen) {
        return (
            <button
                className={`chat-search__trigger ${className}`}
                onClick={handleOpen}
                title="Search messages (Ctrl+F)"
                aria-label="Search messages"
            >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
            </button>
        );
    }

    // Expanded search panel
    return (
        <div className={`chat-search ${className}`}>
            <div className="chat-search__input-wrapper">
                <svg className="chat-search__icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                <input
                    ref={inputRef}
                    type="text"
                    className="chat-search__input"
                    placeholder="Search messages..."
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    autoFocus
                />
                {query && (
                    <span className="chat-search__count">
                        {results.length} {results.length === 1 ? 'match' : 'matches'}
                    </span>
                )}
                <button
                    className="chat-search__close"
                    onClick={handleClose}
                    title="Close search (Esc)"
                    aria-label="Close search"
                >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 6L6 18M6 6l12 12"/>
                    </svg>
                </button>
            </div>

            {/* Results dropdown */}
            {query.length >= 2 && (
                <div className="chat-search__results" ref={resultsRef}>
                    {results.length === 0 ? (
                        <div className="chat-search__no-results">
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" opacity="0.5">
                                <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
                            </svg>
                            <span>No messages found for "{query}"</span>
                        </div>
                    ) : (
                        results.map((result, idx) => (
                            <button
                                key={result.index}
                                className={`chat-search__result ${idx === selectedIndex ? 'chat-search__result--selected' : ''}`}
                                onClick={() => handleResultClick(result)}
                            >
                                <div className="chat-search__result-header">
                                    <span className={`chat-search__result-role chat-search__result-role--${result.message.role}`}>
                                        {result.message.role === 'user' ? 'You' : (result.message.assistant || 'QuoxCORE')}
                                    </span>
                                    {result.message.timestamp && (
                                        <span className="chat-search__result-time">
                                            {formatRelativeTime(result.message.timestamp)}
                                        </span>
                                    )}
                                </div>
                                <div className="chat-search__result-snippet">
                                    {highlightMatch(result.snippet, query)}
                                </div>
                            </button>
                        ))
                    )}
                </div>
            )}

            {/* Keyboard hints */}
            <div className="chat-search__hints">
                <span><kbd>Enter</kbd> jump</span>
                <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
                <span><kbd>Esc</kbd> close</span>
            </div>
        </div>
    );
}

export default ChatSearch;
