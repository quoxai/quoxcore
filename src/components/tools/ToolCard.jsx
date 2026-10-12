/**
 * ToolCard — Unified tool card for /tools grid view.
 *
 * Fixed 180px height, uniform layout: icon + name + status pill,
 * 3-line clamped description, meta strip pinned to bottom.
 * Replaces ToolLibraryCard / CoreToolCard / PluginToolCard in the grid.
 * STUDY-REV-2/P1.A-rebuild2
 *
 * STUDY-REV-2/P1.A-categories: CATEGORY_META removed.
 * Category icon/name resolved from `categoryMeta` prop (passed by parent)
 * or falls back to a minimal default. No static maps.
 *
 * POWERS-P3.C: source_list linkout added below description (catalog entries only).
 */

import React from 'react';

// Minimal inline fallback — no hard-coded category enumeration
const _DEFAULT_CAT = { icon: '🔧', name: 'Tool' };

/**
 * Prettify a source list URL for display.
 * github.com/owner/repo → "owner/repo"
 * Falls back to hostname for non-GitHub URLs.
 *
 * @param {string} url
 * @returns {string}
 */
export function prettifySourceList(url) {
    try {
        const u = new URL(url);
        if (u.hostname === 'github.com') {
            const parts = u.pathname.split('/').filter(Boolean);
            if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
        }
        return u.hostname.replace(/^www\./, '');
    } catch {
        return url;
    }
}

/**
 * ToolCard
 *
 * Props:
 *  tool         — tool object (id, name, description, category, executor_type, risk_level)
 *  categoryMeta — optional { icon, name } from the parent's categoryById lookup
 *  isInstalled  — boolean, shows green "Installed" pill
 *  isDeployable — boolean, shows small green "Deploy" indicator in top-right corner
 *  notYetAvailable — boolean (TRUST-GATE-1.7), shows a "Not yet available" ghost
 *                    pill for catalog entries with no live install/enable pipeline
 *                    (e.g. http_api entries, or any reference-only entry with no
 *                    backing tool_definitions row). Excludes the entry from any
 *                    install affordance without hiding it from the grid.
 *  onClick      — click handler (navigates to /tools/:id)
 */
export default function ToolCard({ tool, categoryMeta, isInstalled, isDeployable, notYetAvailable, onClick }) {
    const catMeta = categoryMeta || _DEFAULT_CAT;

    return (
        <button
            className="qx-card tool-card"
            onClick={onClick}
            type="button"
            title={tool.name}
            style={{ position: 'relative' }}
        >
            {/* Deployable indicator — small green dot in top-right corner */}
            {isDeployable && !isInstalled && (
                <span
                    title="Deployable as Power"
                    style={{
                        position: 'absolute',
                        top: 8,
                        right: 8,
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: '#22c55e',
                        boxShadow: '0 0 4px rgba(34, 197, 94, 0.6)',
                        flexShrink: 0,
                    }}
                />
            )}

            {/* Row 1 — icon + name + status pill */}
            <div className="tool-card__row1">
                <span className="tool-card__icon">{catMeta.icon}</span>
                <span className="tool-card__name">{tool.name}</span>
                {isInstalled && (
                    <span className="qx-pill qx-pill--sm qx-pill--success tool-card__status">
                        Installed
                    </span>
                )}
                {!isInstalled && notYetAvailable && (
                    <span
                        className="qx-pill qx-pill--ghost qx-pill--sm tool-card__status"
                        title="No install pipeline for this catalog entry yet"
                    >
                        Not yet available
                    </span>
                )}
            </div>

            {/* Row 2 — description (3-line clamp) */}
            <p className="tool-card__desc">
                {tool.description || 'No description available.'}
            </p>

            {/* Source-list linkout — only for densified catalog entries that have source_list */}
            {tool.source_list && (
                <a
                    href={tool.source_list}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    style={{
                        display: 'block',
                        fontSize: 11,
                        color: 'rgba(255,255,255,0.4)',
                        textDecoration: 'none',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        marginTop: 2,
                        marginBottom: 4,
                    }}
                >
                    From: {prettifySourceList(tool.source_list)} ↗
                </a>
            )}

            {/* Row 3 — meta strip pinned to bottom */}
            <div className="tool-card__meta">
                {tool.category && (
                    <span className="qx-chip qx-chip--xs">{catMeta.name}</span>
                )}
                {tool.executor_type && (
                    <span className="qx-chip qx-chip--xs">{tool.executor_type}</span>
                )}
                {tool.risk_level && (
                    <span className={`qx-pill qx-pill--xs qx-pill--${tool.risk_level}`}>
                        {tool.risk_level}
                    </span>
                )}
            </div>
        </button>
    );
}
