/**
 * Brain2Settings — the Qortex cockpit (BRAIN2-PRODUCT Phase B).
 *
 * Renders `feed_sources` (services/collector/lib/feedWatermark.js) as a
 * governance surface: docs/STREAM_QUOXBRAIN2_COCKPIT_DESIGN.md screen 2
 * "the cockpit". Every source is a card — name, scope, note count,
 * last-sync, status, and an enable toggle — backed by the collector's
 * Feed API (brain2FeedClient.js). Server-authoritative throughout: no
 * localStorage fallback, no fabricated counts.
 *
 * Composed entirely from `.qx-*` glass-design-system utilities
 * (src/styles/QX_INDEX.md) — no bespoke CSS.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { usePluginLicenseDiagnosis } from '../../hooks/usePluginLicensed';
import { getSources, putSource, getStatus } from '../../services/brain2FeedClient';
import { getQuoxbrainClient } from '../../services/quoxbrainClient';
import Brain2ConnectSource from './Brain2ConnectSource';
import Brain2Suggestions from './Brain2Suggestions';
import Brain2ExploreSources from './Brain2ExploreSources';
import PlatformFlagsPanel from './PlatformFlagsPanel';
import Brain2PrivacyPanel from './Brain2PrivacyPanel';
import Brain2RunningConfigPanel from './Brain2RunningConfigPanel';

// Phase 25 (owner mandate 2026-08-06): Feed-relevant platform flags —
// server-side, org-scoped, override the env default, admin-only, audited.
// See services/collector/lib/platformSettingsStore.js. Several require a
// collector restart to take effect (they gate the scheduler's bootstrap / a
// module-load-time dispatch table) — PlatformFlagsPanel surfaces that
// plainly per flag.
// VAULT-INTEG P17: group-driven instead of a hand-curated key list — every
// settable entry tagged group:'feed' renders here automatically, including
// the scheduler-interval/batch-size entries promoted after this shipped.

// ── icons (decorative, inline SVG per CLAUDE.md — no icon libraries) ───────

const BrainIcon = () => (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <circle cx="12" cy="12" r="6" />
        <circle cx="12" cy="12" r="2" fill="currentColor" />
    </svg>
);

const CONNECTOR_ICONS = {
    host: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="2" width="20" height="8" rx="2" ry="2" /><rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
            <line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" />
        </svg>
    ),
    oauth: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
    ),
    internal: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
        </svg>
    ),
};

function connectorIcon(connector) {
    return CONNECTOR_ICONS[connector] || CONNECTOR_ICONS.internal;
}

// ── helpers ──────────────────────────────────────────────────────────────

function timeAgo(dateStr) {
    if (!dateStr) return null;
    const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

function getScopeMeta(scope) {
    if (scope === 'user') return { label: 'You', pillClass: 'qx-pill--purple' };
    if (scope === 'shared') return { label: 'Shared', pillClass: 'qx-pill--degraded' };
    return { label: 'Org', pillClass: 'qx-pill--info' };
}

// BRAIN2-W5 129: the scheduler stores "error: HTTP 401" etc., not bare "error".
function isErrorStatus(status) {
    return typeof status === 'string' && status.trim().toLowerCase().startsWith('error');
}

function getStatusMeta(source) {
    if (!source.connected) return { label: 'Available', pillClass: 'qx-pill--ghost' };
    if (isErrorStatus(source.last_status)) return { label: 'Reconnect', pillClass: 'qx-pill--danger' };
    if (source.enabled) return { label: 'Healthy', pillClass: 'qx-pill--online' };
    return { label: 'Paused', pillClass: 'qx-pill--degraded' };
}

// Sensitivity → consent copy (C3). Mirrors Brain2ExploreSources' SENSITIVITY_META
// categories ('pii' / 'evidence') without duplicating its display chips here —
// SourceCard only needs the confirm copy, not the badge.
const SENSITIVE_KINDS = new Set(['pii', 'evidence']);

function consentCopyFor(sensitivity) {
    if (sensitivity === 'pii') return 'This source contains personal data. Add it to your brain?';
    return 'This source contains evidence data. Add it to your brain?';
}

// Brain-status band -> pill class + label (docs/STREAM_QUOXBRAIN2_COCKPIT_DESIGN.md screen 3
// "growth story"; ladder: dormant<500, forming 500-1999, growing 2000-4999, alive 5000-9999, dense 10000+).
const BRAIN_BAND_META = {
    dormant: { label: 'Dormant', pillClass: 'qx-pill--ghost' },
    forming: { label: 'Forming', pillClass: 'qx-pill--info' },
    growing: { label: 'Growing', pillClass: 'qx-pill--online' },
    alive: { label: 'Alive', pillClass: 'qx-pill--online' },
    dense: { label: 'Dense', pillClass: 'qx-pill--purple' },
};

function getBrainBandMeta(status) {
    return BRAIN_BAND_META[status] || BRAIN_BAND_META.dormant;
}

// ── SourceCard ───────────────────────────────────────────────────────────

function SourceCard({ source, pending, onToggle, onConnect }) {
    const scopeMeta = getScopeMeta(source.scope || source.defaultScope);
    const statusMeta = getStatusMeta(source);
    const isPending = !!pending;
    // C1: status is authoritative (backend derives it from the real ingester
    // map — see feedApiHandlers.js LIVE_SOURCE_TYPES). A source with no
    // ingester ('available') never gets a real action here, exactly like
    // Brain2ExploreSources' ExploreSourceCard — no silent no-op "Connect" —
    // EXCEPT an 'oauth' connector (BRAIN2-OAUTH-NOTION), which stays
    // actionable even while its catalog status is honestly 'available': the
    // connect flow itself (Brain2ConnectSource) is the honest layer, via
    // GET /connect/providers, not this card.
    const isLive = source.status === 'live';
    const isOauthConnector = source.connector === 'oauth';
    const isActionable = isLive || isOauthConnector;
    const isConnected = !!source.connected;
    // C2: connected + enabled + no last_sync yet reads as "broken" until the
    // 30-min scheduler tick fires — show it as queued, not "never synced".
    const syncPending = isConnected && !!source.enabled && !source.last_sync;
    // P3: live cockpit glow for genuinely alive sources (connected, enabled,
    // no error) — replaces the flat "Healthy" pill's static feel.
    const isAlive = isLive && isConnected && !!source.enabled && !isErrorStatus(source.last_status);

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
            data-testid={`brain2-source-${source.sourceType}`}
        >
            <div className="qx-row qx-row--apart">
                <div className="qx-row qx-row--tight">
                    <span style={{ opacity: 0.7 }}>{connectorIcon(source.connector)}</span>
                    <div>
                        <div style={{ fontWeight: 600, color: 'var(--m-text-primary)' }}>{source.name}</div>
                        <div style={{ fontSize: 12, color: 'var(--m-text-tertiary)', maxWidth: 480 }}>{source.description}</div>
                    </div>
                </div>
                <span className={`qx-pill ${scopeMeta.pillClass}`}>{scopeMeta.label}</span>
            </div>

            <div className="qx-row qx-row--apart">
                <div className="qx-row qx-row--tight" style={{ fontSize: 12, color: 'var(--m-text-tertiary)' }}>
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {(source.last_count || 0).toLocaleString()} pushed last sync
                    </span>
                    <span>·</span>
                    {syncPending ? (
                        <span className="qx-pill qx-pill--info qx-pill--xs">Queued for first sync</span>
                    ) : (
                        <span>{source.last_sync ? `synced ${timeAgo(source.last_sync)}` : 'never synced'}</span>
                    )}
                </div>

                <div className="qx-row qx-row--tight">
                    {isLive ? (
                        <span className={isAlive ? 'qx-plugin-state qx-plugin-state--on' : `qx-pill ${statusMeta.pillClass}`}>
                            {statusMeta.label}
                        </span>
                    ) : (
                        <span className="qx-pill qx-pill--ghost qx-pill--xs">Not yet ingesting</span>
                    )}
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
                            title="Not yet ingesting"
                        >
                            <input type="checkbox" checked={false} disabled aria-label={`Enable ${source.name} (not yet ingesting)`} />
                            <span className="qx-toggle__track" />
                        </label>
                    )}
                </div>
            </div>

            {showConsent && (
                <div className="qx-banner qx-banner--warn" role="alertdialog" data-testid={`brain2-consent-${source.sourceType}`}>
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

// ── BrainGrowthHero (P1 — the cockpit's emotional core) ─────────────────────
//
// Replaces the old flat pill + `.qx-progress` bar with a hero: a conic
// `.qx-percent--brand` ring showing progress to the next milestone, the
// growth-band name as gradient text, the note count as the ring's own
// value, and "N to <milestone>" beneath. Ambient ring intensity (P4) scales
// with the band via `.qx-brain-ambient`'s `--qx-ambient-intensity`.
const BAND_AMBIENT_INTENSITY = {
    dormant: 0.15,
    forming: 0.3,
    growing: 0.55,
    alive: 0.8,
    dense: 1,
};

function BrainGrowthHero({ brainStatus }) {
    if (!brainStatus) return null;
    const meta = getBrainBandMeta(brainStatus.status);
    const milestone = brainStatus.milestone;
    const noteCount = brainStatus.noteCount || 0;
    // No milestone left (top band, "dense") — ring reads as full; there's
    // nothing left to count down to.
    const pct = milestone && milestone.next > 0
        ? Math.min(Math.max(((milestone.current ?? noteCount) / milestone.next) * 100, 0), 100)
        : 100;
    const ambientIntensity = BAND_AMBIENT_INTENSITY[brainStatus.status] ?? BAND_AMBIENT_INTENSITY.dormant;

    return (
        <div className="qx-card qx-card--roomy" style={{ position: 'relative', overflow: 'hidden' }} data-testid="brain2-growth-hero">
            {/* P4 — ambient motif: subtle, intensifies with the band, respects prefers-reduced-motion (see qx-components.css). */}
            <div className="qx-brain-ambient" style={{ '--qx-ambient-intensity': ambientIntensity }} aria-hidden="true" />
            <div className="qx-row qx-row--tight" style={{ position: 'relative', zIndex: 1, alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
                <div className="qx-percent qx-percent--xl qx-percent--brand" style={{ '--qx-pct': pct }}>
                    <span className="qx-percent__value" style={{ fontVariantNumeric: 'tabular-nums' }}>{noteCount.toLocaleString()}</span>
                    <span className="qx-percent__label">notes</span>
                </div>
                <div className="qx-stack qx-stack--tight">
                    <span className={`qx-pill ${meta.pillClass}`} data-testid="brain2-status-pill">
                        {meta.label} · <span style={{ fontVariantNumeric: 'tabular-nums' }}>{noteCount.toLocaleString()}</span>
                    </span>
                    <div className="qx-percent-value qx-percent-value--brand" style={{ fontSize: 32 }}>{meta.label}</div>
                    {milestone && (
                        <div data-testid="brain2-milestone" style={{ fontSize: 13, color: 'var(--m-text-tertiary)' }}>
                            {milestone.remaining.toLocaleString()} to <em style={{ fontStyle: 'normal', color: 'var(--m-text-primary)' }}>{milestone.label}</em>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

// ── EmbeddingCoverageStat: semantic search coverage (no-env-only-config
// #setecastronomy: the embedding backfill scheduler runs silently in the
// background, so coverage must be a visible number in the cockpit rather
// than something only inferrable from server logs). embeddings.percent is
// 0-100; renders nothing while the number isn't loaded yet (best-effort,
// same non-blocking contract as brainStatus itself in load() below). ────────

function EmbeddingCoverageStat({ embeddings }) {
    if (!embeddings) return null;
    const { total, embedded, missing, percent, state, pending, provider } = embeddings;
    if (!total) return null;
    // BRAIN2-SEMANTIC: `state` (ready | indexing | no_provider | unknown)
    // composes coverage with the collector's live provider probe. When it is
    // present it supersedes the older raw-coverage warning; a legacy payload
    // without it renders exactly as before.
    const lowCoverage = percent < 50 && state !== 'no_provider';

    return (
        <div className="qx-card qx-card--compact" data-testid="brain2-embedding-coverage">
            <div className="qx-stat">
                <span className="qx-stat__head">Semantic search coverage</span>
                <span className="qx-stat__value">
                    {embedded.toLocaleString()} / {total.toLocaleString()}
                    <span style={{ fontSize: 14, fontWeight: 400, color: 'var(--m-text-tertiary)', marginLeft: 8 }}>({percent}%)</span>
                </span>
                <span className="qx-stat__sub">{missing.toLocaleString()} chunk{missing === 1 ? '' : 's'} not yet embedded</span>
            </div>
            {(state === 'ready' || state === 'indexing') && (
                <div className="qx-stat__sub" style={{ marginTop: 6 }} data-testid="brain2-embedding-state">
                    {state === 'ready'
                        ? <>Semantic search ready · provider {provider}</>
                        : <>Indexing: {(pending ?? 0).toLocaleString()} chunk{pending === 1 ? '' : 's'} still embedding into the current provider's space ({provider})</>}
                </div>
            )}
            {state === 'no_provider' && (
                <div className="qx-banner qx-banner--warn" style={{ marginTop: 8 }} role="status" data-testid="brain2-embedding-no-provider">
                    Semantic search is off: no embedding provider is connected, so Qortex answers from keyword matching only.{' '}
                    <a href="/settings#instance/provider-keys" style={{ color: 'inherit', fontWeight: 600 }}>
                        Connect an OpenAI or Gemini key
                    </a>{' '}
                    to switch it on — indexing starts automatically.
                </div>
            )}
            {lowCoverage && (
                <div className="qx-banner qx-banner--warn" style={{ marginTop: 8 }} role="status" data-testid="brain2-embedding-coverage-warning">
                    Semantic search is falling back to keyword matching for most queries, since less than half of your Brain's chunks have embeddings yet.
                </div>
            )}
        </div>
    );
}

// ── UsageCard (BRAIN2-PRODUCT P3a — the usage ledger, "is it used?" as a
// visible number). Renders services/quoxbrain's GET /brain/usage: this-week
// counts per read surface, plus the "last agent query" heartbeat line. Same
// non-fabrication contract as EmbeddingCoverageStat above — renders honest
// zeros ("No agent has queried the brain yet") rather than nothing when
// there is genuinely no activity, so an unused brain reads as unused rather
// than looking broken or absent. ────────────────────────────────────────────

const USAGE_SURFACE_LABELS = [
    { key: 'search', label: 'Searches' },
    { key: 'context', label: 'Context reads' },
    { key: 'note_read', label: 'Note reads' },
    { key: 'graph', label: 'Graph reads' },
];

// ── AgentGroundingStat (BRAIN2-V2 P1 — "is it USED by the agents?", one step
// past "is it read?"). Renders usage.citations from GET /brain/usage:
//
//   citations = { week:  { answers, grounded, retrievedNotes, citedNotes },
//                 total: { ...same },
//                 lastGroundedAt: iso | null }
//
// answers = agent answers that followed a brain search; grounded = those whose
// final answer actually cited at least one retrieved note. Absent-tolerant: an
// older quoxbrain that doesn't send `citations` renders nothing here, exactly
// like EmbeddingCoverageStat's missing-payload contract. A 0/0 percentage is a
// lie, so answers=0 gets an honest empty line instead of "0%".

function groundedPercent(pair) {
    const answers = pair?.answers || 0;
    if (!answers) return null;
    return Math.round(((pair.grounded || 0) / answers) * 100);
}

function AgentGroundingStat({ citations }) {
    if (!citations) return null;
    const week = citations.week || {};
    const total = citations.total || {};
    const weekAnswers = week.answers || 0;
    const totalAnswers = total.answers || 0;

    const lastGroundedLine = citations.lastGroundedAt
        ? `Last answer citing the brain: ${timeAgo(citations.lastGroundedAt)}`
        : 'No answer has cited the brain yet';

    if (!weekAnswers && !totalAnswers) {
        return (
            <div className="qx-stack qx-stack--tight" style={{ marginTop: 12 }} data-testid="brain2-usage-grounding">
                <div className="qx-section-title">Agent grounding</div>
                <div className="qx-stat__sub" data-testid="brain2-usage-grounding-empty">
                    No answers citing the brain recorded yet
                </div>
            </div>
        );
    }

    const weekPct = groundedPercent(week);
    const totalPct = groundedPercent(total);

    return (
        <div className="qx-stack qx-stack--tight" style={{ marginTop: 12 }} data-testid="brain2-usage-grounding">
            <div className="qx-section-title">Agent grounding</div>
            <div className="qx-stat">
                <span className="qx-stat__head">Answers citing a note</span>
                <span
                    className="qx-stat__value"
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                    data-testid="brain2-usage-grounding-week"
                >
                    week: {(week.grounded || 0).toLocaleString()} of {weekAnswers.toLocaleString()}
                    {weekPct !== null && (
                        <span style={{ fontSize: 14, fontWeight: 400, color: 'var(--m-text-tertiary)', marginLeft: 8 }}>
                            ({weekPct}%)
                        </span>
                    )}
                </span>
                <span className="qx-stat__sub" data-testid="brain2-usage-grounding-total">
                    all time: {(total.grounded || 0).toLocaleString()} of {totalAnswers.toLocaleString()}
                    {totalPct !== null ? ` (${totalPct}%)` : ''}
                </span>
            </div>
            <div
                style={{ fontSize: 12, color: 'var(--m-text-tertiary)', fontVariantNumeric: 'tabular-nums' }}
                data-testid="brain2-usage-grounding-notes"
            >
                notes cited / retrieved · week: {(week.citedNotes || 0).toLocaleString()} of {(week.retrievedNotes || 0).toLocaleString()}
                {' · '}all time: {(total.citedNotes || 0).toLocaleString()} of {(total.retrievedNotes || 0).toLocaleString()}
            </div>
            {((week.supportMeasured || 0) + (total.supportMeasured || 0)) > 0 && (
                <div
                    style={{ fontSize: 12, color: 'var(--m-text-tertiary)', fontVariantNumeric: 'tabular-nums' }}
                    data-testid="brain2-usage-grounding-support"
                    title="Supported means a model checked that the cited passage entails the sentence. Overlap means the source shares the sentence's words but was not checked for meaning. Citing a note alone is not grounding."
                >
                    supported when checked · week: {(week.supportedAnswers || 0).toLocaleString()} of {(week.supportMeasured || 0).toLocaleString()}
                    {' · '}all time: {(total.supportedAnswers || 0).toLocaleString()} of {(total.supportMeasured || 0).toLocaleString()}
                    <br />
                    overlap only (words match, not checked for meaning) · week: {(week.overlapAnswers || 0).toLocaleString()}
                    {' · '}all time: {(total.overlapAnswers || 0).toLocaleString()}
                </div>
            )}
            <div style={{ fontSize: 12, color: 'var(--m-text-tertiary)' }} data-testid="brain2-usage-last-grounded">
                {lastGroundedLine}
            </div>
        </div>
    );
}

function UsageCard({ usage }) {
    if (!usage) return null;
    const week = usage.week || {};
    const lastAgentLine = usage.lastAgentQueryAt
        ? `Last agent query: ${timeAgo(usage.lastAgentQueryAt)}`
        : 'No agent has queried the brain yet';
    const lastSearchLine = usage.lastSearchAt
        ? `Last search: ${timeAgo(usage.lastSearchAt)}`
        : 'No one has searched the brain yet';

    return (
        <div className="qx-card qx-card--compact" data-testid="brain2-usage-card">
            <div className="qx-section-title">Usage — this week</div>
            <div className="qx-grid-4" data-testid="brain2-usage-week">
                {USAGE_SURFACE_LABELS.map(({ key, label }) => (
                    <div className="qx-stat" key={key}>
                        <span className="qx-stat__head">{label}</span>
                        <span className="qx-stat__value" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {(week[key] || 0).toLocaleString()}
                        </span>
                    </div>
                ))}
            </div>
            <div className="qx-stack qx-stack--tight" style={{ marginTop: 8, fontSize: 12, color: 'var(--m-text-tertiary)' }}>
                <div data-testid="brain2-usage-last-agent">{lastAgentLine}</div>
                <div data-testid="brain2-usage-last-search">{lastSearchLine}</div>
            </div>
            <AgentGroundingStat citations={usage.citations} />
        </div>
    );
}

// ── KpiBand (P2 — real KPI tiles, no fabrication) ───────────────────────────

function KpiBand({ totals, sources }) {
    const lastSync = (sources || [])
        .map(s => s.last_sync)
        .filter(Boolean)
        .sort()
        .pop();

    return (
        <div className="qx-card qx-card--compact qx-grid-3" data-testid="brain2-kpi-band">
            <div className="qx-stat">
                <span className="qx-stat__head">Total notes</span>
                <span className="qx-stat__value" data-testid="brain2-total-notes">
                    {typeof totals.notes === 'number' ? totals.notes.toLocaleString() : '\u2014'}
                </span>
            </div>
            <div className="qx-stat">
                <span className="qx-stat__head">Sources connected</span>
                <span className="qx-stat__value">{totals.connected || 0}</span>
                <span className="qx-stat__sub">{totals.connected === 1 ? '1 source connected' : `${totals.connected || 0} sources connected`}</span>
            </div>
            {lastSync && (
                <div className="qx-stat">
                    <span className="qx-stat__head">Last sync</span>
                    <span className="qx-stat__value" style={{ fontSize: 20 }}>{timeAgo(lastSync)}</span>
                </div>
            )}
        </div>
    );
}

// ── Brain2Settings ───────────────────────────────────────────────────────

function Brain2SettingsContent() {
    const { authFetch } = useAuth();

    const [sources, setSources] = useState(null); // null = still loading
    const [status, setStatus] = useState(null);
    const [brainStatus, setBrainStatus] = useState(null); // quoxbrain /brain/status — growth-story pill+milestone
    const [usage, setUsage] = useState(null); // quoxbrain /brain/usage — the usage ledger (P3a)
    const [error, setError] = useState(null);
    const [pending, setPending] = useState({});
    const [showCatalog, setShowCatalog] = useState(false);
    const [connectSource, setConnectSource] = useState(null); // source object mid-connect (opens Brain2ConnectSource)

    const quoxbrainClient = useMemo(() => getQuoxbrainClient(), []);
    // BRAIN2-W5 130: a saved flag change refreshes the effective-privacy panel.
    const [privacyRefresh, setPrivacyRefresh] = useState(0);
    const bumpPrivacy = useCallback(() => setPrivacyRefresh((n) => n + 1), []);

    const load = useCallback(async () => {
        if (!authFetch) return;
        setError(null);
        try {
            const [srcs, st] = await Promise.all([
                getSources({ authFetch }),
                getStatus({ authFetch }),
            ]);
            setSources(srcs);
            setStatus(st);
        } catch (err) {
            setError(err?.message || 'Failed to load Qortex sources');
        }
        // Brain status is a separate service (quoxbrain) — best-effort, doesn't
        // block or fail the cockpit's primary feed-sources load.
        try {
            setBrainStatus(await quoxbrainClient.getBrainStatus());
        } catch {
            setBrainStatus(null);
        }
        // Usage ledger — same best-effort contract: a quoxbrain outage hides the
        // Usage card, it never fails the rest of the cockpit.
        try {
            setUsage(await quoxbrainClient.getUsage());
        } catch {
            setUsage(null);
        }
    }, [authFetch, quoxbrainClient]);

    useEffect(() => { load(); }, [load]);

    const handleToggle = useCallback(async (source, nextEnabled) => {
        setSources(prev => (prev || []).map(s => s.sourceType === source.sourceType ? { ...s, enabled: nextEnabled } : s));
        setPending(p => ({ ...p, [source.sourceType]: true }));
        try {
            const updated = await putSource({ authFetch }, source.sourceType, { enabled: nextEnabled });
            setSources(prev => (prev || []).map(s => s.sourceType === source.sourceType ? updated : s));
        } catch (err) {
            // Revert the optimistic flip — server is the source of truth.
            setSources(prev => (prev || []).map(s => s.sourceType === source.sourceType ? { ...s, enabled: !nextEnabled } : s));
            setError(err?.message || `Failed to update ${source.name}`);
        } finally {
            setPending(p => { const next = { ...p }; delete next[source.sourceType]; return next; });
        }
    }, [authFetch]);

    // Connect flow (Phase C): the "Connect" action on any not-yet-connected
    // source opens Brain2ConnectSource, which knows what each connector
    // needs (folder path / one-click / oauth-disabled) and calls putSource
    // itself. We just react to the result.
    const openConnect = useCallback((source) => setConnectSource(source), []);
    const closeConnect = useCallback(() => setConnectSource(null), []);

    const handleConnected = useCallback(async (updatedSource) => {
        setSources(prev => (prev || []).map(s => s.sourceType === updatedSource.sourceType ? updatedSource : s));
        setConnectSource(null);
        try {
            setStatus(await getStatus({ authFetch }));
        } catch {
            // status refresh is best-effort — the source list already reflects the connect
        }
    }, [authFetch]);

    const loading = sources === null && !error;
    const totals = status?.totals || { notes: 0, connected: 0 };

    const isOnboarding = !loading && !error && sources !== null && totals.connected === 0;
    const isCockpit = !loading && !error && sources !== null && totals.connected > 0;

    return (
        <div className="qx-view qx-stack" style={{ padding: 24, maxWidth: 980 }}>
            {/* Header — hidden during onboarding, where the screen-1 heading leads instead.
                P1/P2: the growth hero + KPI band are the visual anchor of the page —
                they render right under the header once data is in. */}
            {!isOnboarding && (
                <div className="qx-stack qx-stack--tight">
                    <div className="qx-row qx-row--apart">
                        <div className="qx-row qx-row--tight">
                            <span style={{ color: '#38bdf8' }}><BrainIcon /></span>
                            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: 'var(--m-text-primary)' }}>Qortex</h2>
                        </div>
                        <div className="qx-row qx-row--tight">
                            <button
                                type="button"
                                className="qx-btn qx-btn--primary qx-btn--sm"
                                onClick={() => setShowCatalog(v => !v)}
                                disabled={loading}
                            >
                                {showCatalog ? 'Hide sources' : 'Add a source'}
                            </button>
                        </div>
                    </div>
                    {loading && (
                        <p style={{ margin: 0, fontSize: 13, color: 'var(--m-text-tertiary)' }}>Loading…</p>
                    )}
                    {!loading && <BrainGrowthHero brainStatus={brainStatus} />}
                    {!loading && <EmbeddingCoverageStat embeddings={brainStatus?.embeddings} />}
                    {!loading && <KpiBand totals={totals} sources={sources} />}
                    {!loading && <UsageCard usage={usage} />}
                </div>
            )}

            {/* Error banner (non-blocking once we have data; blocking on first load) */}
            {error && sources !== null && (
                <div className="qx-banner qx-banner--error" role="alert">
                    {error}
                </div>
            )}

            {/* Loading */}
            {loading && (
                <div className="qx-card qx-row qx-row--center" style={{ justifyContent: 'center', padding: 40 }}>
                    <span className="qx-spinner" />
                    <span style={{ marginLeft: 12, color: 'var(--m-text-tertiary)' }}>Loading Qortex sources…</span>
                </div>
            )}

            {/* Error — initial load failed */}
            {error && sources === null && (
                <div className="qx-empty">
                    <div className="qx-empty__icon"><BrainIcon /></div>
                    <div className="qx-empty__title">Couldn't load Qortex</div>
                    <div className="qx-empty__body">{error}</div>
                    <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={load} style={{ marginTop: 12 }}>
                        Retry
                    </button>
                </div>
            )}

            {/* Onboarding — screen 1: no source connected yet, guided empty-state (not a blank table) */}
            {isOnboarding && (
                <div className="qx-stack" data-testid="brain2-onboarding">
                    <div className="qx-stack qx-stack--tight">
                        <div className="qx-row qx-row--tight">
                            <span style={{ color: '#38bdf8' }}><BrainIcon /></span>
                            <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--m-text-primary)' }}>
                                Your second brain is empty. Let's feed it.
                            </h2>
                        </div>
                        <p style={{ margin: 0, fontSize: 13, color: 'var(--m-text-tertiary)' }}>
                            Connect one source to get started. Sources are grouped below by what they give your agents, with the recommended ones marked.
                        </p>
                    </div>
                    {sources.length === 0 ? (
                        <div className="qx-empty">
                            <div className="qx-empty__icon"><BrainIcon /></div>
                            <div className="qx-empty__title">No sources available</div>
                            <div className="qx-empty__body">The Qortex source catalog didn't load any entries.</div>
                        </div>
                    ) : (
                        <Brain2ExploreSources
                            sources={sources}
                            pending={pending}
                            onToggle={handleToggle}
                            onConnect={openConnect}
                        />
                    )}
                </div>
            )}

            {/* Add-a-source picker (Phase C: opens the real per-connector connect flow).
                Filtered to sources not yet connected, grouped by tier, led by
                whatItGives, with the recommended ones marked, same picker as onboarding. */}
            {isCockpit && showCatalog && (
                <div className="qx-stack qx-stack--tight">
                    <div className="qx-section-title">Add a source</div>
                    <Brain2ExploreSources
                        sources={sources}
                        pending={pending}
                        onToggle={handleToggle}
                        onConnect={openConnect}
                        filter={s => !s.connected}
                    />
                </div>
            )}

            {/* Suggestions panel (Phase D — growth story) */}
            {isCockpit && <Brain2Suggestions sources={sources} brainStatus={brainStatus} />}

            {/* Source list — the cockpit, once at least one source is connected */}
            {isCockpit && (
                <div className="qx-stack qx-stack--tight">
                    {sources.map(source => (
                        <SourceCard
                            key={source.sourceType}
                            source={source}
                            pending={!!pending[source.sourceType]}
                            onToggle={handleToggle}
                            onConnect={openConnect}
                        />
                    ))}
                </div>
            )}

            {/* Connect flow modal — per-connector form, shared by onboarding + cockpit */}
            {connectSource && (
                <Brain2ConnectSource
                    source={connectSource}
                    onClose={closeConnect}
                    onConnected={handleConnected}
                />
            )}

            {/* Phase 25: The Feed autopilot scheduler flags */}
            <div className="qx-stack qx-stack--tight">
                <div className="qx-section-title">The Feed — autopilot scheduler</div>
                <PlatformFlagsPanel group="feed" title="Feed Flags" />
            </div>

            {/* BRAIN2-V3 B4: Qortex tuning + privacy switches (org admin, audited,
                override the env default) and the live "what leaves this instance"
                disclosure. group "brain2" renders every settable entry tagged
                brain2 automatically; QuoxDream's on/off lives in group memory. */}
            <div className="qx-stack qx-stack--tight" data-testid="brain2-privacy-section">
                <div className="qx-section-title">Qortex retrieval and privacy</div>
                <PlatformFlagsPanel group="brain2" title="Qortex Controls" onNotification={bumpPrivacy} />
                <PlatformFlagsPanel keys={['QUOXDREAM_ENABLED']} title="QuoxDream Consolidation" onNotification={bumpPrivacy} />
                <Brain2PrivacyPanel client={quoxbrainClient} refreshKey={privacyRefresh} />
                <Brain2RunningConfigPanel client={quoxbrainClient} authFetch={authFetch} refreshKey={privacyRefresh} />
            </div>
        </div>
    );
}

// ── Licence gate ─────────────────────────────────────────────────────────
// Owner ruling 2026-10-06: the Qortex COCKPIT (this section, incl. the privacy
// panel, and the /brain2 view) sits behind the one-time `quox-brain2` licence.
// The ENGINE (quoxbrain APIs, agent tools, `quox brain` CLI, citations/usage
// telemetry) is free in Core and never consults the licence. Unlicensed orgs
// get an honest activate state, not a broken section.

export default function Brain2Settings() {
    const diag = usePluginLicenseDiagnosis('quox-brain2');
    if (!diag.licensed) {
        return (
            <div data-testid="brain2-settings-locked" style={{ padding: 24, maxWidth: 560 }}>
                <h3 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>
                    Qortex cockpit {diag.code === 'loading' ? '' : 'is not active here'}
                </h3>
                <p style={{ fontWeight: 600, marginBottom: 8 }}>{diag.title}</p>
                <p style={{ color: 'var(--ui-text-secondary)', lineHeight: 1.5, marginBottom: 12 }}>{diag.detail}</p>
                <p style={{ color: 'var(--ui-text-secondary)', lineHeight: 1.5, marginBottom: 12 }}>
                    The Qortex engine stays free: agents keep searching, reading and saving to your brain, and the
                    quox brain CLI keeps working. The cockpit (graph explorer, source manager, settings) is the
                    one-time Qortex licence.
                </p>
                <a href="/settings#plugins">Open plugin licensing</a>
            </div>
        );
    }
    return <Brain2SettingsContent />;
}
