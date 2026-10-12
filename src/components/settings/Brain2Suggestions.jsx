/**
 * Brain2Suggestions — the growth-story suggestions panel (BRAIN2-PRODUCT
 * Phase D). docs/STREAM_QUOXBRAIN2_COCKPIT_DESIGN.md screen 3, "Growth &
 * guidance": "You have code but no docs — connect your docs." "You're 733
 * from MY BRAIN IS GROWING (5k)." "Connect another source to grow faster."
 *
 * Every tip is derived from the real `feed_sources` rows (brain2FeedClient)
 * and the real quoxbrain `/brain/status` payload — no hardcoded/fake tips.
 * If none of the rules fire, the panel renders nothing (an empty array is
 * an honest empty state, not padded to look busier than the data is).
 *
 * Composed entirely from `.qx-*` glass-design-system utilities — no bespoke CSS.
 */

const DOCS_SOURCE_TYPES = ['docs', 'folder', 'obsidian'];
const CODE_OR_CONVERSATION_TYPES = ['conversation', 'git'];

/**
 * Pure function (exported for testing) — computes suggestions from the
 * cockpit's already-loaded sources + brain status. No fetching here.
 */
export function computeSuggestions({ sources = [], brainStatus = null } = {}) {
    const tips = [];

    // 1) Any connected source in an error state — its notes are going stale.
    for (const source of sources) {
        if (source.connected && typeof source.last_status === 'string' && source.last_status.toLowerCase().startsWith('error')) {
            tips.push({
                id: `reconnect-${source.sourceType}`,
                accent: 'amber',
                text: `Reconnect ${source.name} — ${(source.last_count || 0).toLocaleString()} notes going stale.`,
            });
        }
    }

    // 2) Code/conversations connected but no docs source connected.
    const hasCodeOrConversation = sources.some(s => CODE_OR_CONVERSATION_TYPES.includes(s.sourceType) && s.connected);
    const hasDocs = sources.some(s => DOCS_SOURCE_TYPES.includes(s.sourceType) && s.connected);
    if (hasCodeOrConversation && !hasDocs) {
        tips.push({
            id: 'connect-docs',
            accent: 'amber',
            text: 'You have code & conversations but no docs — connect a docs folder.',
        });
    }

    // 3) Milestone — distance to the next growth threshold.
    if (brainStatus?.milestone) {
        const { remaining, label } = brainStatus.milestone;
        tips.push({
            id: 'milestone',
            accent: 'green',
            text: `You're ${(remaining || 0).toLocaleString()} from ${label}.`,
        });
    }

    // 4) Sparse brain — fewer than 2 connected sources, nudge to add more.
    const connectedCount = sources.filter(s => s.connected).length;
    if (connectedCount < 2) {
        tips.push({
            id: 'connect-more',
            accent: 'amber',
            text: 'Connect another source to grow faster.',
        });
    }

    return tips.slice(0, 4);
}

const ACCENT_DOT_CLASS = {
    amber: 'qx-dot--degraded',
    green: 'qx-dot--online',
};

export default function Brain2Suggestions({ sources = [], brainStatus = null }) {
    const tips = computeSuggestions({ sources, brainStatus });
    if (tips.length === 0) return null;

    return (
        <div className="qx-card qx-card--compact qx-stack qx-stack--tight" data-testid="brain2-suggestions">
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--m-text-primary)' }}>Suggestions</div>
            <div className="qx-stack qx-stack--tight">
                {tips.map(tip => (
                    <div key={tip.id} className="qx-row qx-row--tight" data-testid={`brain2-suggestion-${tip.id}`}>
                        <span className={`qx-dot ${ACCENT_DOT_CLASS[tip.accent] || ACCENT_DOT_CLASS.amber}`} />
                        <span style={{ fontSize: 13, color: 'var(--m-text-secondary)' }}>{tip.text}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}
