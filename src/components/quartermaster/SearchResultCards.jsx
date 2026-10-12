/**
 * SearchResultCards — compact clickable cards for Quartermaster search results.
 *
 * Rendered inside the chat thread when Quartermaster calls search_catalog.
 * Props:
 *   matches: Array<{ id, name, description, subcategory, source_list, score }>
 *   maxVisible: number (default 5)
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

const AMBER = '#d97706';

export function SearchResultCards({ matches = [], maxVisible = 5 }) {
    const navigate = useNavigate();
    const [expanded, setExpanded] = useState(false);

    if (!matches || matches.length === 0) return null;

    const visible = expanded ? matches : matches.slice(0, maxVisible);
    const hiddenCount = matches.length - maxVisible;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
            {visible.map((match, i) => (
                <SearchResultCard
                    key={match.id || match.name || i}
                    match={match}
                    onClick={() => navigate(`/tools/${encodeURIComponent(match.id || match.name)}`)}
                />
            ))}
            {!expanded && hiddenCount > 0 && (
                <button
                    onClick={() => setExpanded(true)}
                    style={{
                        background: 'none',
                        border: `1px solid ${AMBER}40`,
                        borderRadius: 6,
                        color: AMBER,
                        cursor: 'pointer',
                        fontSize: 11,
                        fontFamily: "'Inter',system-ui,sans-serif",
                        padding: '4px 10px',
                        alignSelf: 'flex-start',
                        transition: 'background 0.15s ease',
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = `${AMBER}15`}
                    onMouseLeave={e => e.currentTarget.style.background = 'none'}
                >
                    See {hiddenCount} more
                </button>
            )}
        </div>
    );
}

function SearchResultCard({ match, onClick }) {
    const [hovered, setHovered] = useState(false);

    return (
        <div
            role="button"
            tabIndex={0}
            onClick={onClick}
            onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && onClick()}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                padding: '8px 10px',
                borderRadius: 6,
                border: `1px solid ${hovered ? AMBER : 'rgba(255,255,255,0.08)'}`,
                background: hovered ? `${AMBER}08` : 'rgba(255,255,255,0.02)',
                cursor: 'pointer',
                transition: 'border-color 0.15s ease, background 0.15s ease',
                userSelect: 'none',
            }}
        >
            <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                flexWrap: 'wrap',
            }}>
                <span style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'rgba(255,255,255,0.9)',
                    fontFamily: "'Inter',system-ui,sans-serif",
                }}>
                    {match.name}
                </span>
                {match.subcategory && (
                    <span style={{
                        fontSize: 10,
                        padding: '1px 6px',
                        borderRadius: 999,
                        background: `${AMBER}20`,
                        color: AMBER,
                        fontFamily: "'Inter',system-ui,sans-serif",
                        fontWeight: 500,
                    }}>
                        {match.subcategory}
                    </span>
                )}
                {(match.source_list || match.provider) && (
                    <span style={{
                        fontSize: 10,
                        padding: '1px 6px',
                        borderRadius: 999,
                        background: 'rgba(255,255,255,0.06)',
                        color: 'rgba(255,255,255,0.5)',
                        fontFamily: "'Inter',system-ui,sans-serif",
                    }}>
                        {match.source_list || match.provider}
                    </span>
                )}
            </div>
            {match.description && (
                <span style={{
                    fontSize: 11,
                    color: 'rgba(255,255,255,0.55)',
                    fontFamily: "'Inter',system-ui,sans-serif",
                    lineHeight: 1.4,
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                }}>
                    {match.description}
                </span>
            )}
        </div>
    );
}

export default SearchResultCards;
