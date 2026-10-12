/**
 * TerminalDock — agent-agnostic collapsible terminal panel.
 *
 * Renders stdout/stderr from a one-shot sandbox run with ANSI colour
 * support via `ansi-to-react` (6.x, ~5 KB). Placed in src/components/devshell/
 * so future tenants (QuoxDev, etc.) can mount it without depending on
 * Toolsmith internals. Nothing in this file is Toolsmith-specific —
 * agentColor is the only theming prop.
 *
 * ANSI library choice: `ansi-to-react` was selected over `anser` because it
 * returns a React tree directly (no manual span building) and is smaller than
 * xterm.js for a non-interactive read-only pane. If npm availability changes,
 * `anser` + custom render is the drop-in fallback.
 *
 * Result shape expected from the sandbox endpoint:
 *   { exitCode, durationMs, stdout, stderr, killedAt, egressLog, evidenceBundleId, error }
 */

import { useEffect, useRef } from 'react';
import Ansi from 'ansi-to-react';

// ── Duration formatting ───────────────────────────────────────────────────────

function formatDuration(ms) {
    if (ms === undefined || ms === null) return null;
    if (ms >= 1000) return `${(ms / 1000).toFixed(1)} s`;
    return `${ms} ms`;
}

// ── Status chip ───────────────────────────────────────────────────────────────

function Chip({ children, color }) {
    return (
        <span
            style={{
                fontFamily: '"JetBrains Mono", "Fira Mono", monospace',
                fontSize: 10,
                fontWeight: 600,
                color,
                padding: '1px 6px',
                borderRadius: 3,
                border: `1px solid ${color}55`,
                background: `${color}18`,
                letterSpacing: '0.02em',
                flexShrink: 0,
            }}
        >
            {children}
        </span>
    );
}

// ── Icon buttons ──────────────────────────────────────────────────────────────

function IconBtn({ title, onClick, children }) {
    return (
        <button
            title={title}
            onClick={onClick}
            style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 22,
                height: 22,
                padding: 0,
                background: 'transparent',
                border: 'none',
                borderRadius: 3,
                color: 'rgba(255,255,255,0.45)',
                cursor: 'pointer',
                flexShrink: 0,
            }}
        >
            {children}
        </button>
    );
}

// ── Copy SVG ─────────────────────────────────────────────────────────────────

function CopyIcon() {
    return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
    );
}

// ── Clear SVG ────────────────────────────────────────────────────────────────

function ClearIcon() {
    return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <path d="M10 11v6M14 11v6" />
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
        </svg>
    );
}

// ── Chevron SVG ───────────────────────────────────────────────────────────────

function ChevronIcon({ collapsed }) {
    return (
        <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ transform: collapsed ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}
        >
            <polyline points="18 15 12 9 6 15" />
        </svg>
    );
}

// ── Main component ────────────────────────────────────────────────────────────

/**
 * @param {object}   props
 * @param {string}   props.agentColor          Hex/CSS colour for title bullet and brand accent
 * @param {object}   [props.result]            Sandbox result or null
 * @param {boolean}  props.collapsed           Collapsed state (controlled from parent)
 * @param {Function} props.onToggleCollapsed   Called when user clicks expand/collapse
 * @param {Function} [props.onCopy]            Optional; defaults to copying stdout+stderr
 * @param {Function} [props.onClear]           Optional; called when user clicks Clear
 */
export function TerminalDock({
    agentColor = '#f97316',
    result = null,
    collapsed,
    onToggleCollapsed,
    onCopy,
    onClear,
}) {
    const bodyRef = useRef(null);

    // Auto-scroll body to bottom when result changes
    useEffect(() => {
        if (!collapsed && bodyRef.current && result) {
            bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
        }
    }, [result, collapsed]);

    // ── Status chips ──────────────────────────────────────────────────────────

    function renderChips() {
        if (!result) return null;
        const { exitCode, durationMs, killedAt, egressLog } = result;
        const chips = [];

        // Exit code / killed
        if (killedAt) {
            chips.push(
                <Chip key="exit" color="#f59e0b">
                    killed: {killedAt}
                </Chip>
            );
        } else if (exitCode !== undefined && exitCode !== null) {
            const ok = exitCode === 0;
            chips.push(
                <Chip key="exit" color={ok ? '#22c55e' : '#ef4444'}>
                    exit {exitCode}
                </Chip>
            );
        }

        // Duration
        const dur = formatDuration(durationMs);
        if (dur) {
            chips.push(
                <Chip key="dur" color="rgba(255,255,255,0.4)">
                    {dur}
                </Chip>
            );
        }

        // Egress
        if (Array.isArray(egressLog) && egressLog.length > 0) {
            chips.push(
                <Chip key="egress" color="#f97316">
                    {egressLog.length} egress
                </Chip>
            );
        }

        return chips;
    }

    // ── Copy handler ──────────────────────────────────────────────────────────

    function handleCopy() {
        if (onCopy) { onCopy(); return; }
        if (!result) return;
        const combined = [result.stdout, result.stderr].filter(Boolean).join('\n');
        navigator.clipboard?.writeText(combined).catch(() => { /* ignore */ });
    }

    // ── Body content ──────────────────────────────────────────────────────────

    function renderBody() {
        if (!result) {
            return (
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '100%',
                    color: `${agentColor}66`,
                    fontSize: 11,
                    fontFamily: '"JetBrains Mono", "Fira Mono", monospace',
                    textAlign: 'center',
                    padding: '0 16px',
                }}>
                    No sandbox runs yet. Press Test in the pipeline bar.
                </div>
            );
        }

        const { stdout, stderr, error } = result;

        return (
            <div style={{ padding: '6px 10px' }}>
                {/* Error section */}
                {error && (
                    <div>
                        <div style={sectionLabelStyle('#ef4444')}>error</div>
                        <pre style={{ ...preStyle, color: '#f87171' }}>
                            <Ansi>{error}</Ansi>
                        </pre>
                    </div>
                )}

                {/* stdout section */}
                {stdout && (
                    <div>
                        <div style={sectionLabelStyle('rgba(255,255,255,0.3)')}>stdout</div>
                        <pre style={preStyle}>
                            <Ansi>{stdout}</Ansi>
                        </pre>
                    </div>
                )}

                {/* stderr section */}
                {stderr && (
                    <div>
                        <div style={sectionLabelStyle('rgba(239,68,68,0.6)')}>stderr</div>
                        <pre style={{ ...preStyle, color: '#ff8585' }} className="terminal-dock__stderr">
                            <Ansi>{stderr}</Ansi>
                        </pre>
                    </div>
                )}

                {/* Result with no output */}
                {!stdout && !stderr && !error && (
                    <span style={{
                        fontSize: 10,
                        color: 'rgba(255,255,255,0.3)',
                        fontFamily: '"JetBrains Mono", "Fira Mono", monospace',
                    }}>
                        (no output)
                    </span>
                )}
            </div>
        );
    }

    return (
        <div
            data-terminal-dock
            style={{
                display: 'flex',
                flexDirection: 'column',
                borderTop: '1px solid rgba(255,255,255,0.08)',
                background: 'rgba(0,0,0,0.2)',
                minHeight: 0,
            }}
        >
            {/* Header bar — always visible */}
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '0 10px',
                    height: 28,
                    flexShrink: 0,
                    borderBottom: collapsed ? 'none' : '1px solid rgba(255,255,255,0.06)',
                    background: 'rgba(0,0,0,0.15)',
                    userSelect: 'none',
                }}
            >
                {/* Title */}
                <span
                    style={{
                        fontSize: 11,
                        fontWeight: 600,
                        fontFamily: 'Inter, system-ui, sans-serif',
                        color: 'rgba(255,255,255,0.7)',
                        letterSpacing: '0.01em',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        flexShrink: 0,
                    }}
                >
                    <span style={{ color: agentColor, fontSize: 8, lineHeight: 1 }}>&#x25cf;</span>
                    Terminal
                </span>

                {/* Status chips */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    {renderChips()}
                </div>

                {/* Spacer */}
                <div style={{ flex: 1 }} />

                {/* Icon buttons */}
                <IconBtn title="Copy output to clipboard" onClick={handleCopy}>
                    <CopyIcon />
                </IconBtn>

                {onClear && (
                    <IconBtn title="Clear terminal output" onClick={onClear}>
                        <ClearIcon />
                    </IconBtn>
                )}

                <IconBtn
                    title={collapsed ? 'Expand terminal' : 'Collapse terminal'}
                    onClick={onToggleCollapsed}
                >
                    <ChevronIcon collapsed={collapsed} />
                </IconBtn>
            </div>

            {/* Body — hidden when collapsed */}
            {!collapsed && (
                <div
                    ref={bodyRef}
                    style={{
                        flex: 1,
                        height: 172,          // ~200px total = 28px header + 172px body
                        minHeight: 0,
                        overflowY: 'auto',
                        background: 'rgba(0,0,0,0.3)',
                        fontFamily: '"JetBrains Mono", "Fira Mono", monospace',
                        fontSize: 11,
                    }}
                >
                    {renderBody()}
                </div>
            )}
        </div>
    );
}

// ── Shared sub-styles ─────────────────────────────────────────────────────────

function sectionLabelStyle(color) {
    return {
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color,
        marginBottom: 2,
        marginTop: 6,
    };
}

const preStyle = {
    margin: 0,
    fontFamily: 'inherit',
    fontSize: 'inherit',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    color: 'rgba(255,255,255,0.8)',
    lineHeight: 1.5,
};

export default TerminalDock;
