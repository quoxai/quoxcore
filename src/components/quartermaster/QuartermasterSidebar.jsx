/**
 * QuartermasterSidebar — Reusable chat sidebar for Quartermaster agent.
 *
 * Two mounts:
 *   mode="library" — /tools page. Opening greeting lists catalog size.
 *   mode="detail"  — /tools/:id page. Seed includes tool metadata + README excerpt.
 *
 * Props:
 *   mode: 'library' | 'detail'
 *   seedTool?: object  (required when mode='detail')
 *
 * Collapse state is persisted in localStorage under 'quartermaster-sidebar-collapsed'.
 *
 * Chat shell: reuses AgentChatSidebar → ChatEngine (wraps, does NOT fork).
 *
 * Tool-call result rendering: Approach Y (narration-only).
 * The collector formats search_catalog results as narration in the assistant message.
 * Approach X (custom tool-call renderer) is deferred — the chat thread does not
 * currently expose a tool-call result hook in AgentChatSidebar. Bank note: wire
 * onAssistantMessage + parse tool_use blocks when ChatEngine exposes them.
 *
 * UPDATE (Approach X partial): onAssistantMessage is available. We intercept
 * messages that contain JSON tool-result patterns via post-processing — see
 * renderMessageAddon for the SearchResultCards injection.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AgentChatSidebar } from '../chat/AgentChatSidebar';
import { SearchResultCards } from './SearchResultCards';

const AGENT_ID = 'quartermaster';
const AMBER = '#d97706';
const AVATAR_URL = '/assets/agents/quartermaster.svg';
const COLLAPSE_KEY = 'quartermaster-sidebar-collapsed';
const MAX_README_CHARS = 4000;

// ── Greeting messages ──────────────────────────────────────────────────────────

const LIBRARY_GREETING =
    "Hi, I'm Quartermaster. The catalog has ~3200 tools. Ask me to find something — e.g. 'tools for image manipulation' or 'something to query Postgres'.";

function buildDetailGreeting(tool) {
    if (!tool) return "Ask me about this tool — how it works, what it does, or whether it fits a specific use case.";
    return `I see you're looking at ${tool.name}. Ask me how it works, what it does, or whether it fits a specific use case.`;
}

// ── Context builders ──────────────────────────────────────────────────────────

function buildLibraryContext() {
    return async () => {
        return {
            surface: 'tools-library',
            context: 'The user is browsing the Quox tool catalog (~3200 entries). Help them discover tools using the search_catalog tool.',
        };
    };
}

function buildDetailContext(tool, readmeContent) {
    return async () => {
        if (!tool) return { surface: 'tools-detail', context: '' };

        const readmeExcerpt = readmeContent
            ? readmeContent.slice(0, MAX_README_CHARS)
            : null;

        const parts = [
            `Tool: ${tool.name}`,
            tool.description ? `Description: ${tool.description}` : null,
            tool.category ? `Category: ${tool.category}` : null,
            tool.subcategory ? `Subcategory: ${tool.subcategory}` : null,
            tool.reference ? `Reference: ${tool.reference}` : null,
            readmeExcerpt
                ? `\nREADME (first ${MAX_README_CHARS} chars):\n${readmeExcerpt}`
                : null,
        ].filter(Boolean).join('\n');

        return {
            surface: 'tools-detail',
            toolId: tool.id,
            toolName: tool.name,
            context: parts,
        };
    };
}

// ── Parse search_catalog results from assistant message ────────────────────────
// Approach X partial: scan assistant message text for a JSON block that looks
// like search_catalog output (matches array). This covers the case where the
// collector includes the raw tool result in the message text.

const SEARCH_RESULT_RE = /```json\s*(\{[\s\S]*?"matches"\s*:[\s\S]*?\})\s*```/i;

function extractSearchMatches(text) {
    if (!text || !text.includes('"matches"')) return null;
    try {
        const m = text.match(SEARCH_RESULT_RE);
        if (m) {
            const parsed = JSON.parse(m[1]);
            if (Array.isArray(parsed.matches)) return parsed.matches;
        }
        // Try bare JSON without fences
        const bareIdx = text.indexOf('"matches"');
        if (bareIdx !== -1) {
            // find the enclosing { } around "matches"
            let start = bareIdx;
            while (start > 0 && text[start] !== '{') start--;
            const sub = text.slice(start);
            const parsed = JSON.parse(sub.slice(0, sub.lastIndexOf('}') + 1));
            if (Array.isArray(parsed.matches)) return parsed.matches;
        }
    } catch {
        // not parseable — fall back to narration only
    }
    return null;
}

// ── Floating trigger button (collapsed state) ──────────────────────────────────

function FloatingTrigger({ onClick }) {
    return (
        <button
            onClick={onClick}
            style={{
                position: 'fixed',
                bottom: 24,
                right: 24,
                zIndex: 200,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 16px',
                borderRadius: 999,
                background: AMBER,
                border: 'none',
                color: '#000',
                fontFamily: "'Inter',system-ui,sans-serif",
                fontWeight: 600,
                fontSize: 13,
                cursor: 'pointer',
                boxShadow: `0 4px 20px ${AMBER}50`,
                transition: 'transform 0.15s ease, box-shadow 0.15s ease',
            }}
            onMouseEnter={e => {
                e.currentTarget.style.transform = 'scale(1.04)';
                e.currentTarget.style.boxShadow = `0 6px 28px ${AMBER}70`;
            }}
            onMouseLeave={e => {
                e.currentTarget.style.transform = 'scale(1)';
                e.currentTarget.style.boxShadow = `0 4px 20px ${AMBER}50`;
            }}
            title="Ask Quartermaster"
        >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            Ask Quartermaster
        </button>
    );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function QuartermasterSidebar({ mode = 'library', seedTool = null, readmeContent = null }) {
    // Collapse state persisted in localStorage
    const [collapsed, setCollapsed] = useState(() => {
        try {
            const stored = localStorage.getItem(COLLAPSE_KEY);
            if (stored !== null) return stored === 'true';
        } catch { /* ignore */ }
        // Default: collapsed on mobile (<900px), expanded on desktop
        return typeof window !== 'undefined' && window.innerWidth < 900;
    });

    // Mobile overlay state — separate from desktop collapsed so they don't interfere
    const [mobileOpen, setMobileOpen] = useState(false);

    // Track whether the viewport is currently mobile-sized
    const [isMobile, setIsMobile] = useState(
        typeof window !== 'undefined' && window.innerWidth < 900
    );

    // Per-message addon state — map from messageId → matches[]
    const matchesRef = useRef({});

    const handleToggle = useCallback(() => {
        setCollapsed(c => {
            const next = !c;
            try { localStorage.setItem(COLLAPSE_KEY, String(next)); } catch { /* ignore */ }
            return next;
        });
    }, []);

    // Responsive: collapse when viewport shrinks below 900px; track isMobile
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const mq = window.matchMedia('(max-width: 899px)');
        const handler = (e) => {
            setIsMobile(e.matches);
            if (e.matches) {
                // Only auto-collapse — don't force-expand when going wide
                setCollapsed(true);
                setMobileOpen(false);
                try { localStorage.setItem(COLLAPSE_KEY, 'true'); } catch { /* ignore */ }
            }
        };
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, []);

    // Build context builder memoised by mode + seedTool + readmeContent
    const contextBuilderRef = useRef(null);
    if (!contextBuilderRef.current || contextBuilderRef._mode !== mode || contextBuilderRef._toolId !== seedTool?.id) {
        contextBuilderRef.current = mode === 'library'
            ? buildLibraryContext()
            : buildDetailContext(seedTool, readmeContent);
        contextBuilderRef._mode = mode;
        contextBuilderRef._toolId = seedTool?.id;
    }

    // renderMessageAddon: inject SearchResultCards under assistant messages that
    // contain parseable search_catalog results (Approach X partial).
    const renderMessageAddon = useCallback((msg) => {
        if (msg.role !== 'assistant') return null;
        const text = msg.text || msg.content || '';
        const key = msg.messageId || msg.envelopeId;
        // Cache to avoid re-parsing on every render
        if (key && matchesRef.current[key] !== undefined) {
            const cached = matchesRef.current[key];
            return cached && cached.length > 0 ? <SearchResultCards matches={cached} /> : null;
        }
        const matches = extractSearchMatches(text);
        if (key) matchesRef.current[key] = matches;
        return matches && matches.length > 0 ? <SearchResultCards matches={matches} /> : null;
    }, []);

    const greeting = mode === 'library'
        ? LIBRARY_GREETING
        : buildDetailGreeting(seedTool);

    const suggestions = mode === 'library'
        ? [
            'Tools for image manipulation',
            'Something to query Postgres',
            'Browser automation tools',
            'Audio processing tools',
          ]
        : seedTool
        ? [
            `How does ${seedTool.name} work?`,
            'What are the main use cases?',
            'How would I integrate this with an agent?',
          ]
        : [];

    // ── Mobile overlay chat panel ──────────────────────────────────────────────
    const mobileOverlay = isMobile && mobileOpen ? (
        <div
            style={{
                position: 'fixed',
                inset: 0,
                zIndex: 300,
                display: 'flex',
                flexDirection: 'column',
                background: 'var(--bg-primary, #0f1117)',
            }}
        >
            {/* Close bar */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 16px',
                borderBottom: '1px solid rgba(255,255,255,0.08)',
                background: 'var(--bg-secondary, #1a1d2e)',
                flex: '0 0 auto',
            }}>
                <span style={{ fontWeight: 600, fontSize: 14, color: AMBER }}>Quartermaster</span>
                <button
                    onClick={() => setMobileOpen(false)}
                    aria-label="Close Quartermaster"
                    style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--text-secondary, #94a3b8)',
                        cursor: 'pointer',
                        padding: '4px 8px',
                        fontSize: 18,
                        lineHeight: 1,
                    }}
                >
                    ×
                </button>
            </div>
            {/* Chat surface — takes full remaining height */}
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <AgentChatSidebar
                    agentId={AGENT_ID}
                    agentName="Quartermaster"
                    agentColor={AMBER}
                    agentRole="Tool Catalog"
                    avatarUrl={AVATAR_URL}
                    contextBuilder={contextBuilderRef.current}
                    suggestions={suggestions}
                    collapsed={false}
                    onToggle={() => setMobileOpen(false)}
                    emptyText={greeting}
                    sessionPrefix={`QUARTERMASTER_${mode.toUpperCase()}${seedTool?.id ? `_${seedTool.id}` : ''}`}
                    enableSmartRouter={false}
                    enableMemory={true}
                    renderMessageAddon={renderMessageAddon}
                />
            </div>
        </div>
    ) : null;

    // ── Mobile floating trigger (portalled to body to escape display:none aside) ──
    const mobileTrigger = isMobile && !mobileOpen ? createPortal(
        <FloatingTrigger onClick={() => setMobileOpen(true)} />,
        document.body
    ) : null;

    // ── Desktop collapsed state — show floating trigger (already visible, not in hidden aside) ──
    if (!isMobile && collapsed) {
        return <FloatingTrigger onClick={handleToggle} />;
    }

    // ── Mobile: render portal trigger + portal overlay, nothing in the aside ──
    if (isMobile) {
        return (
            <>
                {mobileTrigger}
                {mobileOverlay && createPortal(mobileOverlay, document.body)}
            </>
        );
    }

    // ── Desktop expanded ──────────────────────────────────────────────────────
    return (
        <AgentChatSidebar
            agentId={AGENT_ID}
            agentName="Quartermaster"
            agentColor={AMBER}
            agentRole="Tool Catalog"
            avatarUrl={AVATAR_URL}
            contextBuilder={contextBuilderRef.current}
            suggestions={suggestions}
            collapsed={false}
            onToggle={handleToggle}
            emptyText={greeting}
            sessionPrefix={`QUARTERMASTER_${mode.toUpperCase()}${seedTool?.id ? `_${seedTool.id}` : ''}`}
            enableSmartRouter={false}
            enableMemory={true}
            renderMessageAddon={renderMessageAddon}
        />
    );
}

export default QuartermasterSidebar;
