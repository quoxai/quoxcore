/**
 * PayloadRenderer, Smart visual rendering for inbox item payloads
 *
 * Replaces raw JSON <pre> blocks with pattern-detected cards:
 * - MetricsCard: host + metric + value → gauge-style display
 * - DeploymentCard: version + environment → deployment summary
 * - BudgetCard: amount/cost + breakdown → cost table
 * - CertCard: certificate/domain + expires → expiry countdown
 * - ResourceCard: resource_type + resource_id → resource detail
 * - KeyValueTable: fallback for any payload
 *
 * Also exports detectPattern and KeyValueTable for testing.
 */

import { useContext, useEffect, useState } from 'react';
import AuthContext from '../../contexts/AuthContext';
import { fetchMediaObjectUrl } from '../../services/xClient';
import QHorn from '../ui/QHorn';
import './payload-renderer.css';

// ─── Pattern Detection ─────────────────────────────────────────────

/**
 * Detect which specialized card pattern matches a payload
 * @param {Object} payload
 * @returns {'metrics'|'deployment'|'budget'|'cert'|'resource'|null}
 */
export function detectPattern(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const keys = Object.keys(payload);

    // X plugin: checked first so it can never be shadowed by a coincidental
    // key match against one of the generic patterns below.
    if (payload.source === 'x-plugin' || (typeof payload.action === 'string' && payload.action.startsWith('x.'))) {
        return 'x';
    }

    // LinkedIn plugin (LI-OVERHAUL P9): connector-gated writes mint
    // payload.source 'linkedin-plugin' with a typed card object.
    if (payload.source === 'linkedin-plugin' && payload.card) {
        return 'linkedin';
    }

    // Facebook plugin (FB-3): connector-gated Page posts mint
    // payload.source 'facebook-plugin' with a typed card object.
    if (payload.source === 'facebook-plugin' && payload.card) {
        return 'facebook';
    }

    // Instagram plugin (IG-3): connector-gated publish/reply writes mint
    // payload.source 'instagram-plugin' with a typed card object.
    if (payload.source === 'instagram-plugin' && payload.card) {
        return 'instagram';
    }

    // TikTok plugin (TT-4): connector-gated publish/draft writes mint
    // payload.source 'tiktok-plugin' with a typed card object.
    if (payload.source === 'tiktok-plugin' && payload.card) {
        return 'tiktok';
    }

    // Metrics: host + metric + value (or threshold)
    if (keys.includes('host') && keys.includes('metric') && keys.includes('value')) {
        return 'metrics';
    }

    // Deployment: version + environment
    if (keys.includes('version') && keys.includes('environment')) {
        return 'deployment';
    }

    // Budget: (amount or cost or total_cost) + breakdown
    if ((keys.includes('amount') || keys.includes('cost') || keys.includes('total_cost')) && keys.includes('breakdown')) {
        return 'budget';
    }

    // Certificate: (certificate or domain) + expires
    if ((keys.includes('certificate') || keys.includes('domain')) && keys.includes('expires')) {
        return 'cert';
    }

    // Resource: resource_type + resource_id
    if (keys.includes('resource_type') && keys.includes('resource_id')) {
        return 'resource';
    }

    return null;
}

// ─── Value Formatters ───────────────────────────────────────────────

function isISODate(val) {
    if (typeof val !== 'string') return false;
    return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/.test(val) && !isNaN(Date.parse(val));
}

function isURL(val) {
    if (typeof val !== 'string') return false;
    return /^https?:\/\//.test(val);
}

function formatValue(val) {
    if (val === null || val === undefined) return <span className="payload-kv-table__null">—</span>;
    if (typeof val === 'boolean') {
        return val
            ? <span className="payload-kv-table__bool payload-kv-table__bool--true">Yes</span>
            : <span className="payload-kv-table__bool payload-kv-table__bool--false">No</span>;
    }
    if (typeof val === 'number') {
        return <span className="payload-kv-table__number">{val.toLocaleString()}</span>;
    }
    if (isURL(val)) {
        return <a href={val} target="_blank" rel="noopener noreferrer" className="payload-kv-table__link">{val}</a>;
    }
    if (isISODate(val)) {
        const d = new Date(val);
        return <span className="payload-kv-table__date" title={d.toISOString()}>{d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>;
    }
    if (Array.isArray(val)) {
        if (val.length === 0) return <span className="payload-kv-table__null">—</span>;
        if (val.every(v => typeof v === 'string' || typeof v === 'number')) {
            return <span>{val.join(', ')}</span>;
        }
        return (
            <ul className="payload-kv-table__list">
                {val.map((item, i) => (
                    <li key={i}>{typeof item === 'object' ? JSON.stringify(item) : String(item)}</li>
                ))}
            </ul>
        );
    }
    if (typeof val === 'object') {
        return <KeyValueTable data={val} depth={1} />;
    }
    return <span>{String(val)}</span>;
}

function formatKey(key) {
    return key
        .replace(/_/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/\b\w/g, c => c.toUpperCase());
}

// ─── KeyValueTable ──────────────────────────────────────────────────

/**
 * Render an object as a 2-column key-value table
 * Excludes known meta keys (response_schema, custom_actions, sections, attachments)
 */
const META_KEYS = new Set(['response_schema', 'custom_actions', 'sections', 'attachments']);

export function KeyValueTable({ data, depth = 0 }) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

    const entries = Object.entries(data).filter(([key]) => depth > 0 || !META_KEYS.has(key));
    if (entries.length === 0) return null;

    return (
        <table className={`payload-kv-table${depth > 0 ? ' payload-kv-table--nested' : ''}`}>
            <tbody>
                {entries.map(([key, val]) => (
                    <tr key={key} className="payload-kv-table__row">
                        <td className="payload-kv-table__key">{formatKey(key)}</td>
                        <td className="payload-kv-table__value">{formatValue(val)}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

// ─── Specialized Cards ──────────────────────────────────────────────

function MetricsCard({ payload }) {
    const { host, metric, value, threshold, unit } = payload;
    const pct = threshold ? Math.min((value / threshold) * 100, 100) : null;
    const isAlert = threshold && value >= threshold;

    return (
        <div className="payload-metrics-card">
            <div className="payload-metrics-card__gauge">
                <div className="payload-metrics-card__value-text">
                    <span className={`payload-metrics-card__value ${isAlert ? 'payload-metrics-card__value--alert' : ''}`}>
                        {typeof value === 'number' ? value.toLocaleString() : value}
                    </span>
                    {unit && <span className="payload-metrics-card__unit">{unit}</span>}
                </div>
                <div className="payload-metrics-card__label">{formatKey(metric)}</div>
                {pct !== null && (
                    <div className="payload-metrics-card__bar">
                        <div
                            className={`payload-metrics-card__bar-fill ${isAlert ? 'payload-metrics-card__bar-fill--alert' : ''}`}
                            style={{ width: `${pct}%` }}
                        />
                    </div>
                )}
                {threshold && (
                    <div className="payload-metrics-card__threshold">
                        Threshold: {threshold.toLocaleString()}{unit ? ` ${unit}` : ''}
                    </div>
                )}
            </div>
            <div className="payload-metrics-card__meta">
                <span className="payload-metrics-card__host">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                    {host}
                </span>
            </div>
            <RemainingFields payload={payload} exclude={['host', 'metric', 'value', 'threshold', 'unit']} />
        </div>
    );
}

function DeploymentCard({ payload }) {
    const { version, environment, commit, changelog, ...rest } = payload;

    return (
        <div className="payload-deploy-card">
            <div className="payload-deploy-card__header">
                <span className="payload-deploy-card__version">{version}</span>
                <span className={`payload-deploy-card__env payload-deploy-card__env--${environment}`}>{environment}</span>
            </div>
            {commit && (
                <div className="payload-deploy-card__commit">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="4"/><line x1="1.05" y1="12" x2="7" y2="12"/><line x1="17.01" y1="12" x2="22.96" y2="12"/></svg>
                    <code>{typeof commit === 'string' ? commit.slice(0, 8) : commit}</code>
                </div>
            )}
            {changelog && (
                <div className="payload-deploy-card__changelog">
                    {Array.isArray(changelog) ? (
                        <ul>{changelog.map((c, i) => <li key={i}>{c}</li>)}</ul>
                    ) : (
                        <p>{changelog}</p>
                    )}
                </div>
            )}
            <RemainingFields payload={rest} exclude={[]} />
        </div>
    );
}

function BudgetCard({ payload }) {
    const total = payload.amount ?? payload.cost ?? payload.total_cost;
    const { breakdown, currency } = payload;
    const cur = currency || 'USD';

    const fmt = (n) => {
        if (typeof n !== 'number') return n;
        return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(n);
    };

    return (
        <div className="payload-budget-card">
            <div className="payload-budget-card__total">
                <span className="payload-budget-card__total-label">Total</span>
                <span className="payload-budget-card__total-value">{fmt(total)}</span>
            </div>
            {Array.isArray(breakdown) && breakdown.length > 0 && (
                <table className="payload-budget-card__table">
                    <tbody>
                        {breakdown.map((item, i) => (
                            <tr key={i}>
                                <td className="payload-budget-card__item-name">{item.name || item.item || item.label || `Item ${i + 1}`}</td>
                                <td className="payload-budget-card__item-amount">{fmt(item.amount ?? item.cost ?? item.value)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            <RemainingFields payload={payload} exclude={['amount', 'cost', 'total_cost', 'breakdown', 'currency']} />
        </div>
    );
}

function CertCard({ payload }) {
    const { certificate, domain, expires, issuer, type: certType } = payload;
    const expiresDate = expires ? new Date(expires) : null;
    const now = new Date();
    const daysLeft = expiresDate ? Math.ceil((expiresDate - now) / (1000 * 60 * 60 * 24)) : null;

    let urgency = '';
    if (daysLeft !== null) {
        if (daysLeft <= 0) urgency = 'expired';
        else if (daysLeft <= 7) urgency = 'critical';
        else if (daysLeft <= 30) urgency = 'warning';
        else urgency = 'ok';
    }

    return (
        <div className="payload-cert-card">
            <div className="payload-cert-card__header">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                <span className="payload-cert-card__domain">{domain || certificate}</span>
            </div>
            {daysLeft !== null && (
                <div className={`payload-cert-card__countdown payload-cert-card__countdown--${urgency}`}>
                    {daysLeft <= 0 ? 'Expired' : `${daysLeft} day${daysLeft !== 1 ? 's' : ''} remaining`}
                </div>
            )}
            {issuer && <div className="payload-cert-card__issuer">Issuer: {issuer}</div>}
            {certType && <div className="payload-cert-card__type">Type: {certType}</div>}
            <RemainingFields payload={payload} exclude={['certificate', 'domain', 'expires', 'issuer', 'type']} />
        </div>
    );
}

function ResourceCard({ payload }) {
    const { resource_type, resource_id, protection, protection_level } = payload;

    const protLevel = protection_level || protection;
    let protColor = '';
    if (protLevel) {
        const p = String(protLevel).toLowerCase();
        if (p.includes('critical') || p.includes('high')) protColor = 'red';
        else if (p.includes('medium') || p.includes('standard')) protColor = 'amber';
        else protColor = 'blue';
    }

    return (
        <div className="payload-resource-card">
            <div className="payload-resource-card__header">
                <span className="payload-resource-card__type">{formatKey(resource_type)}</span>
                <code className="payload-resource-card__id">{resource_id}</code>
            </div>
            {protLevel && (
                <span className={`payload-resource-card__protection payload-resource-card__protection--${protColor}`}>
                    {String(protLevel)}
                </span>
            )}
            <RemainingFields payload={payload} exclude={['resource_type', 'resource_id', 'protection', 'protection_level']} />
        </div>
    );
}

// ─── X (Twitter) Card — WYSIWYG tweet preview ────────────────────────
// The approver sees the tweet the way X itself will render it: avatar,
// name, handle, verified mark, body text with linked URLs/hashtags/
// mentions, and inline media in X's real grid (1 full width, 2 side by
// side, 3-4 in a grid). Compose-only metadata (poll/quote/reply settings/
// budget) renders BELOW the simulated tweet as approver context, never
// inside the preview surface itself (2026-09-24 WYSIWYG upgrade; prior
// version rendered a filename-chip row instead of a real tweet card).

const X_BLUE = '#1d9bf0';

const X_IMAGE_ICON = (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
    </svg>
);

const X_TRASH_ICON = (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" />
    </svg>
);

const X_VERIFIED_ICON = (
    <svg width="16" height="16" viewBox="0 0 24 24" fill={X_BLUE} aria-hidden="true">
        <path d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81s-1.26 2.52-.8 3.91c-1.31.67-2.2 1.91-2.2 3.34s.89 2.67 2.2 3.34c-.46 1.39-.21 2.9.8 3.91s2.52 1.26 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.45 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34zm-11.71 4.2L6.8 12.46l1.41-1.42 2.26 2.26 4.8-5.23 1.47 1.36-6.2 6.77z"/>
    </svg>
);

const X_ACTION_ICONS = {
    reply: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" /></svg>
    ),
    repost: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></svg>
    ),
    like: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" /></svg>
    ),
    views: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>
    ),
};

/** A link to the live tweet, used for reply-to and delete targets */
function XStatusLink({ tweetId }) {
    if (!tweetId) return null;
    return (
        <a
            href={`https://x.com/i/web/status/${tweetId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="payload-kv-table__link"
        >
            {tweetId}
        </a>
    );
}

/** Resolve the connected account's display name + handle for the preview
 *  header. Payload-first (a card can carry its own bound-account identity),
 *  else the Quox brand default. The X-PLUGIN mint side does not stamp an
 *  account identity onto action_params today, so the default is the common
 *  case; this stays payload-first so it upgrades for free the moment it does. */
function resolveXAccount(payload, params) {
    const source = params?.account || payload?.account || params?.x_account || payload?.x_account || {};
    const rawHandle = source.username || source.handle || params?.account_handle || payload?.account_handle;
    const name = source.name || params?.account_name || payload?.account_name;
    return {
        name: name || 'Quox',
        handle: rawHandle ? (String(rawHandle).startsWith('@') ? String(rawHandle) : `@${rawHandle}`) : '@Quox_AI',
        verified: source.verified !== false,
    };
}

function XAvatar() {
    return (
        <span className="payload-x-tweet__avatar" aria-hidden="true">
            <QHorn size={20} style={{ filter: 'none' }} />
        </span>
    );
}

const X_TEXT_TOKEN_SPLIT_RE = /(https?:\/\/[^\s]+|#[a-zA-Z0-9_]+|@[a-zA-Z0-9_]+)/g;
const X_TEXT_TOKEN_MATCH_RE = /^(https?:\/\/[^\s]+|#[a-zA-Z0-9_]+|@[a-zA-Z0-9_]+)$/;

/** Tweet body text with URLs, #hashtags and @mentions coloured X blue, the
 *  way x.com itself renders them. Line breaks are preserved via CSS
 *  white-space, never truncated. */
function XTweetText({ text }) {
    if (!text) return null;
    const parts = String(text).split(X_TEXT_TOKEN_SPLIT_RE);
    return (
        <p className="payload-x-tweet__text">
            {parts.map((part, i) => (
                part === ''
                    ? null
                    : X_TEXT_TOKEN_MATCH_RE.test(part)
                        ? <span key={i} className="payload-x-tweet__link">{part}</span>
                        : part
            ))}
        </p>
    );
}

/** One authenticated media tile inside the WYSIWYG grid. The bytes come from
 *  GET /x/media/file through authFetch (a bare <img src> cannot carry the
 *  JWT), served as a blob URL revoked on unmount, same fetch/blob path the
 *  phase-13 media route has always exposed, now rendered full-tile instead
 *  of a small filename-chip thumbnail (2026-09-24 WYSIWYG upgrade). Falls
 *  back to the filename + alt text as plain text, never a broken <img>,
 *  when no AuthContext is mounted (tests, any standalone route), the file
 *  is a video (no preview route yet), or the fetch fails. */
function XTweetMediaTile({ path, altText, overlayCount, mediaOrg }) {
    const auth = useContext(AuthContext);
    const authFetch = auth?.authFetch;
    const [url, setUrl] = useState(null);
    const [failed, setFailed] = useState(false);
    const isVideo = String(path).toLowerCase().endsWith('.mp4');
    const filename = String(path).split('/').pop() || String(path);

    useEffect(() => {
        if (!authFetch || isVideo) return undefined;
        let revoked = null;
        let alive = true;
        // #605: pass the card's org so the collector serves media filed under a
        // different org than the approver's active one (membership-gated server-side).
        fetchMediaObjectUrl(authFetch, path, mediaOrg)
            .then((objectUrl) => {
                if (!alive) { URL.revokeObjectURL(objectUrl); return; }
                revoked = objectUrl;
                setUrl(objectUrl);
            })
            .catch(() => { if (alive) setFailed(true); });
        return () => {
            alive = false;
            if (revoked) URL.revokeObjectURL(revoked);
        };
    }, [authFetch, path, isVideo, mediaOrg]);

    return (
        <span className="payload-x-tweet__media-item" title={String(path)}>
            {url ? (
                <img
                    src={url}
                    alt={altText || `Attached image ${filename}`}
                    className="payload-x-tweet__media-img"
                    onClick={() => window.open(url, '_blank', 'noopener')}
                    title="Open full size"
                />
            ) : (
                <span className="payload-x-tweet__media-fallback">
                    {X_IMAGE_ICON}
                    <span className="payload-x-tweet__media-filename">{filename}</span>
                    {failed && (
                        <span className="qx-hint qx-hint--sm">
                            Preview couldn't load in this view because the image is stored under the org that filed the post, not your active org. It is saved with the post server-side and will publish as attached. Cross-org preview is tracked in #605; until then, check the alt text below before approving.
                        </span>
                    )}
                    {altText && <span className="payload-x-tweet__alt-text">Alt: {altText}</span>}
                </span>
            )}
            {overlayCount > 0 && <span className="payload-x-tweet__media-more">+{overlayCount}</span>}
        </span>
    );
}

/** Inline media grid, X-style: 1 image full width, 2 side by side, 3-4 in a
 *  grid (first 4 shown, remainder collapsed into a "+N" tile). Accepts the
 *  legacy image_paths array of strings or the phase 10 images array of
 *  {path, alt_text} objects. */
function XTweetMedia({ imagePaths, images, mediaOrg }) {
    const items = Array.isArray(images) && images.length > 0
        ? images.map((img) => ({ path: img?.path, altText: img?.alt_text }))
        : Array.isArray(imagePaths)
            ? imagePaths.map((p) => ({ path: p }))
            : [];
    if (items.length === 0) return null;
    const shown = items.slice(0, 4);
    const overflow = items.length - shown.length;
    return (
        <div className={`payload-x-tweet__media payload-x-tweet__media--count-${shown.length}`}>
            {shown.map((item, i) => (
                <XTweetMediaTile
                    key={i}
                    path={item.path}
                    altText={item.altText}
                    overlayCount={i === shown.length - 1 ? overflow : 0}
                    mediaOrg={mediaOrg}
                />
            ))}
        </div>
    );
}

/** The WYSIWYG tweet card: avatar, name, handle, verified mark, body text
 *  with coloured links, inline media, and a greyed static action row (for
 *  visual fidelity only, not interactive). Compose-only metadata never
 *  lives inside this surface, see XComposeExtras / XBudgetLine below. */
function XTweetPreview({ post, account, mediaOrg }) {
    return (
        <div className="payload-x-tweet">
            <div className="payload-x-tweet__header">
                <XAvatar />
                <div className="payload-x-tweet__identity">
                    <div className="payload-x-tweet__names">
                        <span className="payload-x-tweet__name">{account.name}</span>
                        {account.verified && (
                            <span className="payload-x-tweet__verified" title="Preview only, not a live verification status" aria-hidden="true">
                                {X_VERIFIED_ICON}
                            </span>
                        )}
                        <span className="payload-x-tweet__handle">{account.handle}</span>
                    </div>
                </div>
            </div>
            <XTweetText text={post.text} />
            <XTweetMedia imagePaths={post.image_paths} images={post.images} mediaOrg={mediaOrg} />
            <div className="payload-x-tweet__actions" aria-hidden="true">
                <span className="payload-x-tweet__action">{X_ACTION_ICONS.reply}</span>
                <span className="payload-x-tweet__action">{X_ACTION_ICONS.repost}</span>
                <span className="payload-x-tweet__action">{X_ACTION_ICONS.like}</span>
                <span className="payload-x-tweet__action">{X_ACTION_ICONS.views}</span>
            </div>
        </div>
    );
}

const X_REPLY_SETTINGS_LABELS = {
    following: 'People you follow',
    mentionedUsers: 'Only people mentioned',
};

/** Phase 10 compose data: poll, quote target, reply controls. Rendered BELOW
 *  the tweet preview, as approver metadata, so the approver SEES everything
 *  the publish will carry before tapping, without it being mistaken for part
 *  of the simulated tweet itself. */
function XComposeExtras({ poll, quoteTweetId, replySettings }) {
    const hasPoll = poll && Array.isArray(poll.options) && poll.options.length > 0;
    if (!hasPoll && !quoteTweetId && !replySettings) return null;
    return (
        <div className="qx-stack qx-stack--tight payload-x-card__compose">
            {hasPoll && (
                <div className="payload-x-card__poll" style={{ border: '1px solid var(--ui-border, rgba(255,255,255,0.12))', borderRadius: 8, padding: '8px 10px' }}>
                    {poll.options.map((opt, i) => (
                        <div key={i} className="payload-x-card__poll-option" style={{ fontSize: 13, padding: '4px 0', color: 'var(--ui-text-primary, #fff)' }}>
                            {opt}
                        </div>
                    ))}
                    <div className="qx-hint qx-hint--sm" style={{ marginTop: 4 }}>
                        Poll runs for {poll.duration_minutes} minutes
                    </div>
                </div>
            )}
            {quoteTweetId && (
                <div className="qx-hint qx-hint--sm payload-x-card__quote">
                    Quoting <XStatusLink tweetId={quoteTweetId} />
                </div>
            )}
            {replySettings && X_REPLY_SETTINGS_LABELS[replySettings] && (
                <div className="qx-hint qx-hint--sm payload-x-card__reply-settings">
                    Who can reply: {X_REPLY_SETTINGS_LABELS[replySettings]}
                </div>
            )}
        </div>
    );
}

/** Optional budget line. Only rendered when a real amount is present on the
 *  payload; never invents a number. */
function XBudgetLine({ payload, params }) {
    const amount = params?.budget ?? params?.cost ?? params?.amount
        ?? payload?.budget ?? payload?.cost ?? payload?.amount;
    if (amount === null || amount === undefined) return null;
    const currency = params?.currency || payload?.currency || 'USD';
    const display = typeof amount === 'number'
        ? new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount)
        : String(amount);
    return (
        <div className="qx-stat-row payload-x-card__budget">
            <span className="qx-stat-row__label">Budget</span>
            <span className="qx-stat-row__value">{display}</span>
        </div>
    );
}

// ─── LinkedIn Card (LI-OVERHAUL P9) ─────────────────────────────────
// Renders a connector-gated LinkedIn write as a post preview instead of a
// key/value dump, the same idea as XCard. The approver sees exactly the
// text, target identity and attachments that will publish on approve.
const LINKEDIN_BLUE = '#0A66C2';

function linkedInIdentity(urn) {
    if (!urn || typeof urn !== 'string') return { label: 'Unknown', detail: '' };
    if (urn.startsWith('urn:li:organization:')) return { label: 'Organisation page', detail: urn.slice('urn:li:organization:'.length) };
    if (urn.startsWith('urn:li:person:')) return { label: 'Member', detail: '' };
    return { label: urn, detail: '' };
}

function LinkedInCard({ payload }) {
    const card = payload.card || {};
    const isComment = card.kind === 'create_comment';
    const who = linkedInIdentity(isComment ? card.actor : card.author);

    return (
        <div className="qx-card qx-card--compact payload-linkedin-card" style={{ borderLeft: `3px solid ${LINKEDIN_BLUE}` }}>
            <div className="qx-row qx-row--tight" style={{ alignItems: 'center', gap: 8 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6z" stroke={LINKEDIN_BLUE} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    <rect x="2" y="9" width="4" height="12" stroke={LINKEDIN_BLUE} strokeWidth="1.8" />
                    <circle cx="4" cy="4" r="2" stroke={LINKEDIN_BLUE} strokeWidth="1.8" />
                </svg>
                <span style={{ fontWeight: 700, textTransform: 'uppercase', fontSize: 12, letterSpacing: '0.04em', color: LINKEDIN_BLUE }}>
                    {isComment ? 'LinkedIn comment' : 'LinkedIn post'}
                </span>
                <span style={{ fontSize: 12, color: 'var(--ui-text-secondary, #aaa)' }}>
                    as {who.label}{who.detail ? ` ${who.detail}` : ''}
                </span>
                {!isComment && card.visibility && (
                    <span style={{ fontSize: 11, color: 'var(--ui-text-secondary, #aaa)', border: '1px solid var(--ui-border, #333)', borderRadius: 4, padding: '1px 6px' }}>
                        {card.visibility}
                    </span>
                )}
            </div>

            <div style={{ marginTop: 10, fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap', color: 'var(--ui-text-primary, #fff)' }}>
                {card.text || ''}
            </div>

            {isComment && card.post_urn && (
                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--ui-text-secondary, #aaa)' }}>
                    On post <code className="qx-code">{card.post_urn}</code>
                </div>
            )}
            {!isComment && card.link_url && (
                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--ui-text-secondary, #aaa)' }}>
                    Link: <a href={card.link_url} target="_blank" rel="noopener noreferrer" style={{ color: LINKEDIN_BLUE }}>{card.link_url}</a>
                </div>
            )}
            {!isComment && card.media_id && (
                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--ui-text-secondary, #aaa)' }}>
                    Attached image: <code className="qx-code">{card.media_id}</code>
                </div>
            )}
        </div>
    );
}

// ─── Facebook Card (FB-3) ────────────────────────────────────────────
// Renders a connector-gated Facebook Page post as a post preview instead
// of a key/value dump, the same idea as LinkedInCard. The approver sees
// exactly the message, target Page and attachments that will publish on
// approve.
const FACEBOOK_BLUE = '#1877F2';

function FacebookCard({ payload }) {
    const card = payload.card || {};

    return (
        <div className="qx-card qx-card--compact payload-facebook-card" style={{ borderLeft: `3px solid ${FACEBOOK_BLUE}` }}>
            <div className="qx-row qx-row--tight" style={{ alignItems: 'center', gap: 8 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M15 4h-2a5 5 0 0 0-5 5v3H6v4h2v8h4v-8h3l1-4h-4V9a1 1 0 0 1 1-1h3z" stroke={FACEBOOK_BLUE} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span style={{ fontWeight: 700, textTransform: 'uppercase', fontSize: 12, letterSpacing: '0.04em', color: FACEBOOK_BLUE }}>
                    Facebook post
                </span>
                {card.page_id && (
                    <span style={{ fontSize: 12, color: 'var(--ui-text-secondary, #aaa)' }}>
                        to page <code className="qx-code">{card.page_id}</code>
                    </span>
                )}
            </div>

            <div style={{ marginTop: 10, fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap', color: 'var(--ui-text-primary, #fff)' }}>
                {card.message || ''}
            </div>

            {card.link && (
                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--ui-text-secondary, #aaa)' }}>
                    Link: <a href={card.link} target="_blank" rel="noopener noreferrer" style={{ color: FACEBOOK_BLUE }}>{card.link}</a>
                </div>
            )}
            {card.image_url && (
                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--ui-text-secondary, #aaa)' }}>
                    Image URL: <code className="qx-code">{card.image_url}</code>
                </div>
            )}
        </div>
    );
}

// ─── Instagram Card (IG-3) ───────────────────────────────────────────
// Renders a connector-gated Instagram write (publish_media or reply_comment)
// as a preview instead of a key/value dump, the same idea as FacebookCard.
// The approver sees exactly the caption/media or reply text that will
// execute on approve.
const INSTAGRAM_PINK = '#E4405F';

function InstagramCard({ payload }) {
    const card = payload.card || {};
    const isReply = card.kind === 'reply_comment';
    const mediaUrl = card.image_url || card.video_url || null;

    return (
        <div className="qx-card qx-card--compact payload-instagram-card" style={{ borderLeft: `3px solid ${INSTAGRAM_PINK}` }}>
            <div className="qx-row qx-row--tight" style={{ alignItems: 'center', gap: 8 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <rect x="3" y="3" width="18" height="18" rx="5" stroke={INSTAGRAM_PINK} strokeWidth="1.8" />
                    <circle cx="12" cy="12" r="4" stroke={INSTAGRAM_PINK} strokeWidth="1.8" />
                    <circle cx="17.5" cy="6.5" r="1.2" fill={INSTAGRAM_PINK} />
                </svg>
                <span style={{ fontWeight: 700, textTransform: 'uppercase', fontSize: 12, letterSpacing: '0.04em', color: INSTAGRAM_PINK }}>
                    {isReply ? 'Instagram comment reply' : 'Instagram post'}
                </span>
                {!isReply && card.ig_user_id && (
                    <span style={{ fontSize: 12, color: 'var(--ui-text-secondary, #aaa)' }}>
                        to account <code className="qx-code">{card.ig_user_id}</code>
                    </span>
                )}
                {!isReply && card.media_type && (
                    <span style={{ fontSize: 11, color: 'var(--ui-text-secondary, #aaa)', border: '1px solid var(--ui-border, #333)', borderRadius: 4, padding: '1px 6px' }}>
                        {card.media_type}
                    </span>
                )}
                {isReply && card.comment_id && (
                    <span style={{ fontSize: 12, color: 'var(--ui-text-secondary, #aaa)' }}>
                        on comment <code className="qx-code">{card.comment_id}</code>
                    </span>
                )}
            </div>

            <div style={{ marginTop: 10, fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap', color: 'var(--ui-text-primary, #fff)' }}>
                {(isReply ? card.message : card.caption) || ''}
            </div>

            {!isReply && mediaUrl && (
                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--ui-text-secondary, #aaa)' }}>
                    Media: <a href={mediaUrl} target="_blank" rel="noopener noreferrer" style={{ color: INSTAGRAM_PINK }}>{mediaUrl}</a>
                </div>
            )}
        </div>
    );
}

// ─── TikTok Card (TT-4) ──────────────────────────────────────────────
// Renders a connector-gated TikTok write (publish_video or upload_draft)
// as a preview instead of a key/value dump, the same idea as InstagramCard.
// The approver sees exactly the title, privacy level and file that will
// execute on approve. A SELF_ONLY badge flags the one privacy level TikTok
// actually honours pre-audit; any other requested level still shows as
// requested (never silently rewritten), since TikTok itself is the one that
// may override it.
const TIKTOK_PINK = '#FE2C55';
const TIKTOK_CYAN = '#25F4EE';

function TikTokCard({ payload }) {
    const card = payload.card || {};
    const isDraft = card.kind === 'upload_draft';
    const privacyLevel = !isDraft ? (card.privacy_level || 'SELF_ONLY') : null;

    return (
        <div className="qx-card qx-card--compact payload-tiktok-card" style={{ borderLeft: `3px solid ${TIKTOK_PINK}` }}>
            <div className="qx-row qx-row--tight" style={{ alignItems: 'center', gap: 8 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M16 3v9.5a4 4 0 1 1-4-4V3" stroke={TIKTOK_PINK} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M16 3a5 5 0 0 0 5 5" stroke={TIKTOK_CYAN} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span style={{ fontWeight: 700, textTransform: 'uppercase', fontSize: 12, letterSpacing: '0.04em', color: TIKTOK_PINK }}>
                    {isDraft ? 'TikTok draft upload' : 'TikTok video publish'}
                </span>
                {privacyLevel && (
                    <span style={{
                        fontSize: 11, color: privacyLevel === 'SELF_ONLY' ? TIKTOK_CYAN : 'var(--ui-text-secondary, #aaa)',
                        border: `1px solid ${privacyLevel === 'SELF_ONLY' ? TIKTOK_CYAN : 'var(--ui-border, #333)'}`,
                        borderRadius: 4, padding: '1px 6px',
                    }}>
                        {privacyLevel}
                    </span>
                )}
            </div>

            <div style={{ marginTop: 10, fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap', color: 'var(--ui-text-primary, #fff)' }}>
                {card.title || '(no title)'}
            </div>

            {card.file && (
                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--ui-text-secondary, #aaa)' }}>
                    File: <code className="qx-code">{card.file}</code>{card.size ? ` (${card.size})` : ''}
                </div>
            )}

            {isDraft && (
                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--ui-text-secondary, #aaa)' }}>
                    Finished and published manually inside the TikTok app after upload.
                </div>
            )}
        </div>
    );
}

function XCard({ payload }) {
    const params = payload.action_params || {};
    const action = params.action || payload.action;

    if (action === 'x.delete') {
        return (
            <div className="qx-card qx-card--compact qx-card--danger payload-x-card payload-x-card--delete">
                <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
                    <span style={{ color: 'var(--ui-red, #ef4444)' }}>{X_TRASH_ICON}</span>
                    <span className="payload-x-card__delete-label" style={{ fontWeight: 700, color: 'var(--ui-red, #ef4444)', textTransform: 'uppercase', fontSize: 12, letterSpacing: '0.04em' }}>
                        Delete tweet
                    </span>
                </div>
                <div className="payload-x-card__delete-target" style={{ marginTop: 8, fontSize: 13, color: 'var(--ui-text-secondary, #aaa)' }}>
                    Tweet <XStatusLink tweetId={params.tweet_id} />
                </div>
                <XBudgetLine payload={payload} params={params} />
            </div>
        );
    }

    // Phase 10 slice B: like/repost cards. Small by design: the whole
    // decision is "this tweet, this action, as this account".
    if (action === 'x.like' || action === 'x.repost') {
        const label = action === 'x.like' ? 'Like tweet' : 'Repost tweet';
        const icon = action === 'x.like'
            ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" /></svg>
            : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="17 1 21 5 17 9" /><path d="M3 11V9a4 4 0 0 1 4-4h14" /><polyline points="7 23 3 19 7 15" /><path d="M21 13v2a4 4 0 0 1-4 4H3" /></svg>;
        return (
            <div className={`qx-card qx-card--compact payload-x-card payload-x-card--engagement payload-x-card--${action === 'x.like' ? 'like' : 'repost'}`}>
                <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
                    <span style={{ color: 'var(--ui-text-secondary, #aaa)' }}>{icon}</span>
                    <span style={{ fontWeight: 700, textTransform: 'uppercase', fontSize: 12, letterSpacing: '0.04em', color: 'var(--ui-text-primary, #fff)' }}>
                        {label}
                    </span>
                </div>
                <div style={{ marginTop: 8, fontSize: 13, color: 'var(--ui-text-secondary, #aaa)' }}>
                    Tweet <XStatusLink tweetId={params.tweet_id} />
                </div>
                <XBudgetLine payload={payload} params={params} />
            </div>
        );
    }

    if (action === 'x.thread') {
        const posts = Array.isArray(params.posts)
            ? params.posts
            : Array.isArray(params.texts)
                ? params.texts.map((t) => ({ text: t }))
                : [];
        const account = resolveXAccount(payload, params);
        return (
            <div className="qx-card qx-card--compact payload-x-card payload-x-card--thread">
                <div className="payload-x-tweet__thread">
                    {posts.map((post, i) => (
                        <div key={i} className="payload-x-tweet__thread-post">
                            <div className="payload-x-tweet__thread-index">{i + 1}/{posts.length}</div>
                            <XTweetPreview post={post} account={account} mediaOrg={params.org_id} />
                        </div>
                    ))}
                </div>
                <div className="payload-x-tweet__caption">Preview of how this appears on X</div>
                <div className="payload-x-card__meta">
                    {posts.map((post, i) => (
                        <XComposeExtras key={i} poll={post.poll} quoteTweetId={post.quote_tweet_id} replySettings={post.reply_settings} />
                    ))}
                    <XBudgetLine payload={payload} params={params} />
                </div>
            </div>
        );
    }

    // Default: x.post
    {
        const account = resolveXAccount(payload, params);
        return (
            <div className="qx-card qx-card--compact payload-x-card payload-x-card--post">
                {params.reply_to_tweet_id && (
                    <div className="qx-hint qx-hint--sm payload-x-card__reply" style={{ marginBottom: 6 }}>
                        Replying to <XStatusLink tweetId={params.reply_to_tweet_id} />
                    </div>
                )}
                <XTweetPreview post={params} account={account} mediaOrg={params.org_id} />
                <div className="payload-x-tweet__caption">Preview of how this appears on X</div>
                <div className="payload-x-card__meta">
                    <XComposeExtras poll={params.poll} quoteTweetId={params.quote_tweet_id} replySettings={params.reply_settings} />
                    <XBudgetLine payload={payload} params={params} />
                </div>
            </div>
        );
    }
}

/** Render remaining payload keys not consumed by the specialized card */
function RemainingFields({ payload, exclude }) {
    if (!payload || typeof payload !== 'object') return null;
    const remaining = {};
    for (const [k, v] of Object.entries(payload)) {
        if (!exclude.includes(k) && !META_KEYS.has(k)) {
            remaining[k] = v;
        }
    }
    if (Object.keys(remaining).length === 0) return null;
    return <KeyValueTable data={remaining} depth={0} />;
}

// ─── Attachment List ─────────────────────────────────────────────

export function formatFileSize(bytes) {
    if (typeof bytes !== 'number' || bytes < 0) return '';
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const val = bytes / Math.pow(1024, i);
    return `${i === 0 ? val : val.toFixed(1)} ${units[i]}`;
}

export function getFileIcon(type) {
    if (!type) return 'file';
    if (type.startsWith('image/')) return 'image';
    if (type.startsWith('text/')) return 'text';
    if (type === 'application/pdf') return 'pdf';
    if (type.includes('zip') || type.includes('tar') || type.includes('gzip')) return 'archive';
    if (type.includes('json') || type.includes('yaml') || type.includes('xml')) return 'code';
    return 'file';
}

const fileIcons = {
    file: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>,
    image: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>,
    text: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>,
    pdf: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M9 15v-2h2a1 1 0 1 1 0 2H9z"/></svg>,
    archive: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>,
    code: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>,
};

export function AttachmentList({ attachments }) {
    if (!Array.isArray(attachments) || attachments.length === 0) return null;

    return (
        <div className="payload-attachments">
            <div className="payload-attachments__title">Attachments</div>
            {attachments.map((att, i) => {
                const iconType = getFileIcon(att.type);
                const isImage = att.type && att.type.startsWith('image/');

                return (
                    <a
                        key={i}
                        href={att.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="payload-attachment"
                    >
                        {isImage && att.url ? (
                            <img
                                src={att.url}
                                alt={att.name || ''}
                                className="payload-attachment__thumb"
                                loading="lazy"
                                onError={(e) => { e.target.style.display = 'none'; }}
                            />
                        ) : (
                            <span className="payload-attachment__icon">{fileIcons[iconType]}</span>
                        )}
                        <span className="payload-attachment__name">{att.name || `File ${i + 1}`}</span>
                        {att.size != null && (
                            <span className="payload-attachment__size">{formatFileSize(att.size)}</span>
                        )}
                    </a>
                );
            })}
        </div>
    );
}

// ─── Main Component ─────────────────────────────────────────────────

export default function PayloadRenderer({ payload, className = '' }) {
    const [showRaw, setShowRaw] = useState(false);

    if (!payload || typeof payload !== 'object' || Object.keys(payload).length === 0) {
        return null;
    }

    // Filter out meta keys for display purposes
    const displayPayload = {};
    for (const [k, v] of Object.entries(payload)) {
        if (!META_KEYS.has(k)) displayPayload[k] = v;
    }
    if (Object.keys(displayPayload).length === 0) return null;

    const pattern = detectPattern(displayPayload);

    const renderCard = () => {
        switch (pattern) {
            case 'x': return <XCard payload={displayPayload} />;
            case 'linkedin': return <LinkedInCard payload={displayPayload} />;
            case 'facebook': return <FacebookCard payload={displayPayload} />;
            case 'instagram': return <InstagramCard payload={displayPayload} />;
            case 'tiktok': return <TikTokCard payload={displayPayload} />;
            case 'metrics': return <MetricsCard payload={displayPayload} />;
            case 'deployment': return <DeploymentCard payload={displayPayload} />;
            case 'budget': return <BudgetCard payload={displayPayload} />;
            case 'cert': return <CertCard payload={displayPayload} />;
            case 'resource': return <ResourceCard payload={displayPayload} />;
            default: return <KeyValueTable data={displayPayload} />;
        }
    };

    return (
        <div className={`payload-renderer ${className}`.trim()}>
            {showRaw ? (
                <pre className="payload-renderer__raw">{JSON.stringify(payload, null, 2)}</pre>
            ) : (
                renderCard()
            )}
            <button
                className="payload-renderer__raw-toggle"
                onClick={() => setShowRaw(!showRaw)}
                type="button"
            >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
                </svg>
                {showRaw ? 'View Formatted' : 'View Raw JSON'}
            </button>
        </div>
    );
}
