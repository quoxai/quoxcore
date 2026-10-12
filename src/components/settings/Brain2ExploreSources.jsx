/**
 * Brain2ExploreSources — the tier-grouped, catalog-driven source picker
 * (BRAIN2-NIGHT2, redesigned for self-explanatory "add a source"). Per the
 * owner: "everything in Quox is a source, guided and toggleable in
 * settings — not every user needs every source, but they should be guided
 * as to what is available."
 *
 * A controlled presentational component: Brain2Settings owns the sources
 * state and every mutation (load/toggle/connect); this file only groups the
 * given `sources` by `tier` (core / knowledge / evidence / world) under
 * plain-language headings, sorts recommended (`defaultOn`) sources first in
 * each tier, and renders each source as a card led by `whatItGives` — the
 * agent-POV value prop — rather than the connector-plumbing description.
 * `status: 'live'` sources get a real toggle/connect action (same putSource
 * + Brain2ConnectSource flow as Brain2Settings' cockpit); `status:
 * 'available'` sources render a disabled "Not yet ingesting" state —
 * visible, but not actionable yet. EXCEPTION (BRAIN2-OAUTH-NOTION): an
 * 'oauth' connector source stays actionable even at 'available' status —
 * its ingester is real but its scheduler registration is deliberately
 * env-flag-gated (see feedScheduler.js), so the catalog status honestly
 * never claims 'live' until an operator has actually witnessed a sync.
 * Honesty about connectability lives in Brain2ConnectSource's own
 * GET /connect/providers check instead of being fully hidden here.
 *
 * Role-based highlighting: the frontend's `user.role` is an RBAC role
 * (admin/member/owner), not a job-function persona, so it can't be mapped to
 * `recommendedFor` (developer/compliance/ops/everyone) honestly. Per spec,
 * this renders `recommendedFor` as small chips on each card instead of
 * claiming a personalised "recommended for you" match.
 *
 * Composed entirely from `.qx-*` glass-design-system utilities
 * (src/styles/QX_INDEX.md) — no bespoke CSS.
 */

import { useState, useMemo } from 'react';

// ── tier grouping ────────────────────────────────────────────────────────

const TIER_ORDER = ['core', 'knowledge', 'evidence', 'world'];

const TIER_LABELS = {
    core: 'Core',
    knowledge: 'Knowledge',
    evidence: 'Evidence',
    world: 'Your world',
};

const SENSITIVITY_META = {
    pii: { label: 'Personal data', pillClass: 'qx-pill--degraded' },
    evidence: { label: 'Evidence', pillClass: 'qx-pill--info' },
};

const RECOMMENDED_LABELS = {
    developer: 'For developers',
    compliance: 'For compliance',
    ops: 'For ops',
    everyone: 'Everyone',
};

// C3: enabling a 'pii'/'evidence' source is a one-tap confirm, not a silent
// flip — mirrors Brain2Settings' SourceCard consent gate.
const SENSITIVE_KINDS = new Set(['pii', 'evidence']);

function consentCopyFor(sensitivity) {
    if (sensitivity === 'pii') return 'This source contains personal data. Add it to your brain?';
    return 'This source contains evidence data. Add it to your brain?';
}

// Small inline consent line shown next to the sensitivity pill, so the
// tradeoff is visible before a user even opens the toggle's confirm banner.
function consentLineFor(sensitivity) {
    if (sensitivity === 'pii') return 'This source contains personal data.';
    if (sensitivity === 'evidence') return 'This source contains governance evidence.';
    return null;
}

function getScopeMeta(scope) {
    if (scope === 'user') return { label: 'You', pillClass: 'qx-pill--purple' };
    if (scope === 'shared') return { label: 'Shared', pillClass: 'qx-pill--degraded' };
    return { label: 'Org', pillClass: 'qx-pill--info' };
}

// ── ExploreSourceCard ────────────────────────────────────────────────────

function ExploreSourceCard({ source, pending, onToggle, onConnect }) {
    const sensitivityMeta = SENSITIVITY_META[source.sensitivity];
    const consentLine = consentLineFor(source.sensitivity);
    const scopeMeta = getScopeMeta(source.scope || source.defaultScope);
    const isLive = source.status === 'live';
    // BRAIN2-OAUTH-NOTION: an 'oauth' connector stays actionable even while
    // its catalog `status` is honestly 'available' (no ingester registered
    // under LIVE_SOURCE_TYPES yet — see feedScheduler.js's env-gated
    // registration). The connect flow itself is the honest layer here:
    // Brain2ConnectSource's oauth branch checks GET /connect/providers and
    // shows "not configured" for a provider with no OAuth app set up,
    // rather than this picker silently hiding the button.
    const isOauthConnector = source.connector === 'oauth';
    const isActionable = isLive || isOauthConnector;
    const isConnected = !!source.connected;
    const isPending = !!pending;
    const recommended = Array.isArray(source.recommendedFor) ? source.recommendedFor : [];
    // P3: same "alive" glow as the cockpit's SourceCard — connected, enabled,
    // no error, and actually live (has a real ingester).
    const isAlive = isLive && isConnected && !!source.enabled && source.last_status !== 'error';

    const [showConsent, setShowConsent] = useState(false);
    const needsConsent = SENSITIVE_KINDS.has(source.sensitivity);

    function requestEnable(nextEnabled) {
        if (nextEnabled && needsConsent) {
            setShowConsent(true);
            return;
        }
        onToggle(source, nextEnabled);
    }

    function confirmConsent() {
        setShowConsent(false);
        onToggle(source, true);
    }

    return (
        <div
            className={`qx-card qx-card--compact qx-card--lift qx-stack qx-stack--tight${isAlive ? ' qx-enabled-glow' : ''}`}
            data-testid={`brain2-explore-${source.sourceType}`}
        >
            <div className="qx-row qx-row--apart">
                <div className="qx-row qx-row--tight">
                    <span style={{ fontWeight: 600, color: 'var(--m-text-primary)' }}>{source.name}</span>
                    {source.defaultOn && <span className="qx-chip qx-chip--brand qx-chip--xs">Recommended</span>}
                </div>
                {sensitivityMeta && <span className={`qx-pill qx-pill--xs ${sensitivityMeta.pillClass}`}>{sensitivityMeta.label}</span>}
            </div>

            <p style={{ margin: 0, fontSize: 13, fontWeight: 500, color: 'var(--m-text-primary)' }}>
                {source.whatItGives || source.description}
            </p>

            {consentLine && (
                <p style={{ margin: 0, fontSize: 12, color: 'var(--m-text-tertiary)' }}>{consentLine}</p>
            )}

            {recommended.length > 0 && (
                <div className="qx-row qx-row--tight qx-row--wrap">
                    {recommended.map(role => (
                        <span key={role} className="qx-chip qx-chip--xs">{RECOMMENDED_LABELS[role] || role}</span>
                    ))}
                </div>
            )}

            <div className="qx-row qx-row--apart">
                <div className="qx-row qx-row--tight">
                    <span className={`qx-pill qx-pill--xs ${scopeMeta.pillClass}`}>{scopeMeta.label}</span>
                    {!isLive && <span className="qx-pill qx-pill--xs qx-pill--ghost">Not yet ingesting</span>}
                    {isAlive && <span className="qx-plugin-state qx-plugin-state--on">Live</span>}
                    {isConnected && !isAlive && isLive && <span className="qx-pill qx-pill--xs qx-pill--online">Connected</span>}
                </div>

                {isActionable ? (
                    isConnected ? (
                        <label className="qx-toggle" style={{ display: 'inline-flex', alignItems: 'center', cursor: isPending ? 'wait' : 'pointer' }}>
                            <input
                                type="checkbox"
                                checked={!!source.enabled}
                                disabled={isPending}
                                onChange={e => requestEnable(e.target.checked)}
                                aria-label={`Enable ${source.name}`}
                            />
                            <span className="qx-toggle__track" />
                        </label>
                    ) : (
                        <button
                            type="button"
                            className="qx-btn qx-btn--ghost qx-btn--sm"
                            disabled={isPending}
                            onClick={() => onConnect(source)}
                        >
                            {isPending ? 'Connecting…' : 'Connect'}
                        </button>
                    )
                ) : (
                    <label
                        className="qx-toggle"
                        style={{ display: 'inline-flex', alignItems: 'center', opacity: 0.5, cursor: 'not-allowed' }}
                        title="Coming soon"
                    >
                        <input type="checkbox" checked={false} disabled aria-label={`Enable ${source.name} (coming soon)`} />
                        <span className="qx-toggle__track" />
                    </label>
                )}
            </div>

            {showConsent && (
                <div className="qx-banner qx-banner--warn" role="alertdialog" data-testid={`brain2-explore-consent-${source.sourceType}`}>
                    <span>{consentCopyFor(source.sensitivity)}</span>
                    <div className="qx-banner__actions">
                        <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setShowConsent(false)}>Cancel</button>
                        <button type="button" className="qx-btn qx-btn--primary qx-btn--sm" onClick={confirmConsent}>Add it</button>
                    </div>
                </div>
            )}
        </div>
    );
}

// ── TierSection ──────────────────────────────────────────────────────────

function TierSection({ tier, sources, pending, onToggle, onConnect }) {
    if (!sources.length) return null;
    return (
        <div className="qx-stack qx-stack--tight">
            <div className="qx-section-title">{TIER_LABELS[tier] || tier}</div>
            <div className="qx-grid-2">
                {sources.map(source => (
                    <ExploreSourceCard
                        key={source.sourceType}
                        source={source}
                        pending={pending[source.sourceType]}
                        onToggle={onToggle}
                        onConnect={onConnect}
                    />
                ))}
            </div>
        </div>
    );
}

// ── Brain2ExploreSources ─────────────────────────────────────────────────

export default function Brain2ExploreSources({ sources, pending = {}, onToggle, onConnect, filter }) {
    const grouped = useMemo(() => {
        const map = {};
        for (const tier of TIER_ORDER) map[tier] = [];
        const list = typeof filter === 'function' ? (sources || []).filter(filter) : (sources || []);
        for (const source of list) {
            const tier = TIER_ORDER.includes(source.tier) ? source.tier : 'world';
            map[tier].push(source);
        }
        // Recommended (defaultOn) sources lead each tier, catalog order kept
        // within each group.
        for (const tier of TIER_ORDER) {
            map[tier].sort((a, b) => (b.defaultOn ? 1 : 0) - (a.defaultOn ? 1 : 0));
        }
        return map;
    }, [sources, filter]);

    const total = TIER_ORDER.reduce((sum, tier) => sum + grouped[tier].length, 0);

    if (total === 0) {
        return (
            <div className="qx-empty" data-testid="brain2-explore-sources">
                <div className="qx-empty__title">Every catalog source is already connected</div>
            </div>
        );
    }

    return (
        <div className="qx-stack" data-testid="brain2-explore-sources">
            {TIER_ORDER.map(tier => (
                <TierSection
                    key={tier}
                    tier={tier}
                    sources={grouped[tier]}
                    pending={pending}
                    onToggle={onToggle}
                    onConnect={onConnect}
                />
            ))}
        </div>
    );
}
