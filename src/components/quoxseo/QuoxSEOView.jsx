/**
 * QuoxSEOView — QuoxSEO mounted as a native Quox dashboard view.
 *
 * Follows the QuoxSignal embed pattern (src/components/quoxsignal/QuoxSignalView.jsx):
 * a single `qx-view` with a command-strip header (health dot/pill + `.qx-tabs`) and the
 * tab content below, no ported app-shell chrome. The active tab lives in local state but is
 * synced to a `?tab=` query param (readTabFromUrl + replaceState below), so each tab
 * (Overview, Opportunities, Keywords, Keyword Manager, Audit, URL Warehouse, Changes,
 * Evidence) is directly linkable and reachable by a headless inspector, not click-only.
 *
 * Every panel/table/chip/pill/empty/skeleton below uses a global .qx-* utility from
 * src/styles/QX_INDEX.md. quoxseo.css exists only for the one piece of layout glue no
 * qx class covers (the scrolling tab body under the fixed header).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, isEntitlementError } from './lib/api.js';
import SeerChatSidebar from './SeerChatSidebar.jsx';
import PluginLicenseNotice from '../plugins/PluginLicenseNotice';
import { usePluginLicenseDiagnosis } from '../../hooks/usePluginLicensed';
import './quoxseo.css';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'opportunities', label: 'Opportunities' },
  { key: 'keywords', label: 'Keywords' },
  { key: 'kwmanager', label: 'Keyword Manager' },
  { key: 'audit', label: 'Audit' },
  { key: 'urls', label: 'URL Warehouse' },
  { key: 'changes', label: 'Changes' },
  { key: 'evidence', label: 'Evidence' },
];

const TAB_KEYS = new Set(TABS.map((t) => t.key));

// Deep-link support: read/write the active tab via a `?tab=` query param so a
// tab (e.g. Keyword Manager) is directly linkable and reachable by a headless
// inspector, instead of being trapped in local state that only a click can reach.
function readTabFromUrl() {
  try {
    const t = new URLSearchParams(window.location.search).get('tab');
    return t && TAB_KEYS.has(t) ? t : 'overview';
  } catch {
    return 'overview';
  }
}

const OPPORTUNITY_FILTERS = [
  { key: '', label: 'All' },
  { key: 'striking_distance', label: 'Striking distance' },
  { key: 'ctr_gap', label: 'CTR gap' },
  { key: 'orphan_with_traffic', label: 'Orphans' },
  { key: 'thin_with_traffic', label: 'Thin' },
];

const OPPORTUNITY_TYPE_META = {
  striking_distance: { label: 'Striking distance', variant: 'success' },
  ctr_gap: { label: 'CTR gap', variant: 'info' },
  orphan_with_traffic: { label: 'Orphan with traffic', variant: 'warn' },
  thin_with_traffic: { label: 'Thin with traffic', variant: 'ghost' },
};

const URL_FILTERS = [
  { key: '', label: 'All' },
  { key: 'orphans', label: 'Orphans' },
  { key: 'noindex', label: 'Noindex' },
  { key: 'errors', label: 'Errors' },
  { key: 'no-gsc', label: 'No GSC data' },
  { key: 'discovered', label: 'Discovered, not in sitemap' },
];

/* ------------------------------------------------------------------ icons */

function RefreshIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" />
    </svg>
  );
}

function ShieldCheckIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2l8 4v6c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10V6l8-4z" /><path d="M9 12l2 2 4-4" />
    </svg>
  );
}

function CompassIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" /><path d="M16.24 7.76l-2.12 6.36-6.36 2.12 2.12-6.36 6.36-2.12z" />
    </svg>
  );
}

function LinksIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07L11.5 4.5" /><path d="M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 0 0 7.07 7.07l1.36-1.36" />
    </svg>
  );
}

function LayersIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2l9 5-9 5-9-5 9-5z" /><path d="M3 12l9 5 9-5" /><path d="M3 17l9 5 9-5" />
    </svg>
  );
}

function GlobeIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z" />
    </svg>
  );
}

function TrendIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 3v18h18" /><path d="M7 15l4-6 3 3 5-8" />
    </svg>
  );
}

function ClipboardXIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4V3h6v1" /><path d="M9.5 13.5l5 5M14.5 13.5l-5 5" />
    </svg>
  );
}

function ClipboardTextIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4V3h6v1" /><path d="M8.5 11h7M8.5 15h5" />
    </svg>
  );
}

function MapIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z" /><path d="M9 4v14M15 6v14" />
    </svg>
  );
}

function EyeOffIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 3l18 18" /><path d="M10.6 5.1A9.6 9.6 0 0 1 12 5c5 0 9 4 10 7-0.4 1.1-1.2 2.4-2.4 3.6M6.6 6.6C4.4 8 2.9 10 2 12c1 3 5 7 10 7 1.4 0 2.7-0.3 3.9-0.8" /><path d="M9.5 9.5a3 3 0 0 0 4.2 4.2" />
    </svg>
  );
}

function ExternalLinkIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><path d="M15 3h6v6" /><path d="M10 14L21 3" />
    </svg>
  );
}

/** Direction glyph for a movement pill: up (improved), down (declined), flat (no change). */
function TrendArrowIcon({ direction, size = 10 }) {
  if (direction === 'up') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 19V5M5 12l7-7 7 7" />
      </svg>
    );
  }
  if (direction === 'down') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 5v14M5 12l7 7 7-7" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14" />
    </svg>
  );
}

/* ------------------------------------------------------------------ shared bits */

function BackendBanner({ error, onRetry }) {
  return (
    <div className="qx-banner qx-banner--error">
      <span className="qx-banner__title">QuoxSEO backend unreachable</span>
      <span>{error?.message || 'The request failed and no data could be loaded.'}</span>
      {onRetry && (
        <span className="qx-banner__actions">
          <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={onRetry}>
            <RefreshIcon /> Retry
          </button>
        </span>
      )}
    </div>
  );
}

function TableSkeleton({ lines = 6 }) {
  return (
    <div className="qx-card qx-card--compact">
      <div className="qx-stack qx-stack--tight">
        {Array.from({ length: lines }).map((_, i) => (
          <div key={i} className="qx-skeleton qx-skeleton--line-md" style={{ width: `${92 - i * 6}%` }} />
        ))}
      </div>
    </div>
  );
}

function StatTile({ icon, label, value, sub }) {
  return (
    <div className="qx-card qx-card--compact">
      <div className="qx-stat">
        <span className="qx-stat__head">{icon}<span>{label}</span></span>
        <span className="qx-stat__value">{value ?? 0}</span>
        {sub ? <span className="qx-stat__sub">{sub}</span> : null}
      </div>
    </div>
  );
}

function statusPillVariant(status) {
  const code = Number(status);
  if (!Number.isFinite(code)) return 'ghost';
  if (code >= 200 && code < 300) return 'success';
  if (code >= 300 && code < 400) return 'medium';
  if (code >= 400) return 'danger';
  return 'ghost';
}

function UrlFlags({ row }) {
  const flags = [];
  if (row.orphan) flags.push({ key: 'orphan', label: 'orphan', variant: 'danger' });
  if (row.in_sitemap === false) flags.push({ key: 'not-in-sitemap', label: 'not in sitemap', variant: 'warn' });
  if (row.meta_robots && /noindex/i.test(row.meta_robots)) flags.push({ key: 'noindex', label: 'noindex', variant: 'ghost' });
  if (flags.length === 0) return <span className="qx-hint qx-hint--sm">None</span>;
  return (
    <div className="qx-row qx-row--tight qx-row--wrap">
      {flags.map((f) => (
        <span key={f.key} className={`qx-pill qx-pill--xs qx-pill--${f.variant}`}>{f.label}</span>
      ))}
    </div>
  );
}

/**
 * Local fetch-on-mount/deps-change hook, the same shape as quoxsignal's lib/useAsync.js,
 * kept inline here rather than as a fourth file per the brief's exact file list. Routes any
 * entitlement 403 to `onLocked` instead of the generic error state, so a stale client-side
 * license cache still lands on the sales surface rather than a raw banner.
 */
function useTabData(loader, deps, onLocked) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const generation = useRef(0);

  const run = useCallback((runOpts = {}) => {
    const gen = ++generation.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    loader(runOpts)
      .then((data) => {
        if (gen !== generation.current) return;
        setState({ loading: false, error: null, data });
      })
      .catch((error) => {
        if (gen !== generation.current) return;
        if (isEntitlementError(error)) {
          onLocked();
          return;
        }
        setState({ loading: false, error, data: null });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  return { ...state, refresh: run };
}

/* ------------------------------------------------------------------ DataForSEO activation */

// Shipped capability count, kept honest against services/collector proxy routes and
// the quox-seo server (server/src/server.mjs): 13 tools run on the org's own crawl and
// Google Search Console at no extra cost (warehouse/crawl, WARD witnessing + verify,
// change events, opportunities, query intelligence, GEO render-diff, index coverage,
// schema checks, internal linking, Core Web Vitals, GA4, bot intelligence, zero-click).
// 3 tools are DataForSEO-backed (keyword research with volume/difficulty/CPC, competitor
// keyword gaps, backlinks); see docs/STATUS_AND_LIMITS_QUOXSEO.md for the maturity map.
const QUOXSEO_FREE_TOOL_COUNT = 13;
const QUOXSEO_TOTAL_TOOL_COUNT = 16;
const QUOXSEO_DATAFORSEO_TOOL_COUNT = QUOXSEO_TOTAL_TOOL_COUNT - QUOXSEO_FREE_TOOL_COUNT;
const DATAFORSEO_AFFILIATE_URL = 'https://try.dataforseo.com/42m46wzff74b';

/** Clean styled wordmark, not a logo asset: no DataForSEO brand mark ships in this repo. */
function DataForSeoWordmark() {
  return (
    <span className="qx-dfs-wordmark">
      Data<span className="qx-dfs-wordmark__accent">For</span>SEO
    </span>
  );
}

// Named export for direct render assertions (see src/test/QuoxSEODataForSeoBanner.test.jsx):
// the default export requires mocking the whole api/license-diagnosis stack to reach it.
export function DataForSeoBanner({ compact = false }) {
  return (
    <div className={`qx-card qx-dfs-banner${compact ? ' qx-dfs-banner--compact' : ''}`}>
      <div className="qx-dfs-banner__main">
        <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
          <DataForSeoWordmark />
          <span className="qx-pill qx-pill--xs qx-pill--info">Partner</span>
        </div>
        <p className="qx-dfs-banner__msg">
          {QUOXSEO_FREE_TOOL_COUNT} of {QUOXSEO_TOTAL_TOOL_COUNT} QuoxSEO tools work on your own crawl and Google Search Console
          at no extra cost. The remaining {QUOXSEO_DATAFORSEO_TOOL_COUNT} (keyword research, competitor keyword gaps, backlinks)
          become available with a DataForSEO account.
        </p>
        {!compact && (
          <span className="qx-hint qx-hint--sm">
            Pay-per-use commodity data, cents per call, no subscription. QuoxSEO adds no markup beyond the provider cost.
          </span>
        )}
        <span className="qx-hint qx-hint--sm">
          Disclosure: this is a referral link, and Quox may receive referral credit if you open a DataForSEO account through it.
        </span>
      </div>
      <a
        className="qx-btn qx-btn--primary qx-btn--lg qx-dfs-banner__cta"
        href={DATAFORSEO_AFFILIATE_URL}
        target="_blank"
        rel="sponsored noopener"
      >
        <ExternalLinkIcon /> Get a DataForSEO account
      </a>
    </div>
  );
}

/* ------------------------------------------------------------------ Overview */

function CrawlRow({ crawl }) {
  const witnessed = Boolean(crawl.ward_seq);
  return (
    <div className="qx-row qx-row--apart" style={{ padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
        <span>{crawl.started_at ? new Date(crawl.started_at).toLocaleString() : 'unknown date'}</span>
        <span className="qx-hint qx-hint--sm">{crawl.url_count ?? 0} urls, {crawl.ok_count ?? 0} ok</span>
        {crawl.root_hash ? <span className="qx-mono qx-hint qx-hint--sm">{String(crawl.root_hash).slice(0, 10)}…</span> : null}
      </div>
      <span className={`qx-pill qx-pill--xs ${witnessed ? 'qx-pill--success' : 'qx-pill--ghost'}`}>
        {witnessed ? `witnessed #${crawl.ward_seq}` : 'UNWITNESSED'}
      </span>
    </div>
  );
}

function OverviewTab({ siteId, onEntitlementLocked, dataforseoConfigured }) {
  const loader = useCallback((opts) => api.getSummary(siteId, opts), [siteId]);
  const { loading, error, data, refresh } = useTabData(loader, [siteId], onEntitlementLocked);

  if (loading) {
    return (
      <div className="qx-stack">
        <div className="qx-grid-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="qx-card qx-card--compact"><div className="qx-skeleton qx-skeleton--block" /></div>
          ))}
        </div>
        <TableSkeleton lines={4} />
      </div>
    );
  }

  if (error) {
    return <BackendBanner error={error} onRetry={() => refresh({ force: true })} />;
  }

  const empty = !data || data.empty;
  const summary = data?.summary || {};
  const crawls = data?.crawls || [];

  return (
    <div className="qx-stack">
      {dataforseoConfigured === false && <DataForSeoBanner />}
      <div className="qx-row qx-row--apart">
        <span className="qx-hint">SEO warehouse overview</span>
        <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={() => refresh({ force: true })}>
          <RefreshIcon /> Refresh
        </button>
      </div>

      {empty ? (
        <div className="qx-empty">
          <span className="qx-empty__icon"><CompassIcon size={26} /></span>
          <span className="qx-empty__title">No crawls yet</span>
          <span className="qx-empty__body">Run the QuoxSEO crawler against this org's site and the warehouse fills in on the next refresh.</span>
        </div>
      ) : (
        <>
          <div className="qx-grid-4">
            <StatTile icon={<LayersIcon />} label="URLs" value={summary.url_count} sub={`${summary.ok_count ?? 0} ok, ${summary.error_count ?? 0} errors`} />
            <StatTile icon={<LinksIcon />} label="Orphans" value={summary.orphans} />
            <StatTile icon={<EyeOffIcon />} label="Noindex" value={summary.noindex} />
            <StatTile icon={<TrendIcon />} label="With GSC data" value={summary.with_gsc} sub={`of ${summary.url_count ?? 0} URLs`} />
            <StatTile icon={<ClipboardXIcon />} label="Missing canonical" value={summary.missing_canonical} />
            <StatTile icon={<ClipboardTextIcon />} label="Missing meta description" value={summary.missing_meta_description} />
            <StatTile icon={<MapIcon />} label="Discovered, not in sitemap" value={summary.discovered_not_in_sitemap} />
            <StatTile
              icon={<TrendIcon />}
              label="Impressions / clicks"
              value={`${Number(summary.totals?.impressions ?? 0).toLocaleString()} / ${Number(summary.totals?.clicks ?? 0).toLocaleString()}`}
            />
          </div>

          <div className="qx-card qx-card--compact">
            <div className="qx-stack qx-stack--tight">
              <strong>Latest crawls</strong>
              {crawls.length === 0
                ? <span className="qx-hint">No crawl history yet.</span>
                : crawls.map((c) => <CrawlRow key={c.id ?? c.crawl_id} crawl={c} />)}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ Opportunities */

function formatOpportunityMetrics(type, metrics = {}) {
  const parts = [];
  if (metrics.position != null) parts.push(`pos ${Number(metrics.position).toFixed(1)}`);
  if (metrics.impressions != null) parts.push(`${Number(metrics.impressions).toLocaleString()} impr`);
  if (metrics.clicks != null) parts.push(`${Number(metrics.clicks).toLocaleString()} clicks`);
  if (type === 'ctr_gap' && metrics.ctr != null) {
    const expected = metrics.expected_ctr != null ? ` (expected ${(Number(metrics.expected_ctr) * 100).toFixed(1)}%)` : '';
    parts.push(`${(Number(metrics.ctr) * 100).toFixed(1)}% ctr${expected}`);
  }
  if (type === 'orphan_with_traffic' && metrics.inlinks_contextual != null) {
    parts.push(`${Number(metrics.inlinks_contextual).toLocaleString()} inlink(s)`);
  }
  if (type === 'thin_with_traffic' && metrics.word_count != null) {
    parts.push(`${Number(metrics.word_count).toLocaleString()} words`);
  }
  return parts.join(' · ');
}

function OpportunityCard({ opp }) {
  const meta = OPPORTUNITY_TYPE_META[opp.type] || { label: opp.type, variant: 'ghost' };
  return (
    <div className="qx-card qx-card--compact">
      <div className="qx-stack qx-stack--tight">
        <div className="qx-row qx-row--apart" style={{ alignItems: 'center' }}>
          <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
            <span className="qx-num qx-mono">{Number(opp.score ?? 0).toFixed(1)}</span>
            <span className={`qx-pill qx-pill--xs qx-pill--${meta.variant}`}>{meta.label}</span>
            <span className="qx-mono" title={opp.path}>{opp.path}</span>
          </div>
        </div>
        <span className="qx-hint qx-hint--sm">{formatOpportunityMetrics(opp.type, opp.metrics)}</span>
        <span>{opp.action}</span>
      </div>
    </div>
  );
}

function OpportunitiesTab({ siteId, onEntitlementLocked }) {
  const [filter, setFilter] = useState('');

  const loader = useCallback(
    (opts) => api.listOpportunities({ type: filter || undefined, limit: 100 }, siteId, opts),
    [filter, siteId]
  );
  const { loading, error, data, refresh } = useTabData(loader, [filter, siteId], onEntitlementLocked);

  const opportunities = data?.opportunities || [];
  const summary = data?.summary || {};
  const byType = summary.by_type || {};

  return (
    <div className="qx-stack">
      <div className="qx-row qx-row--apart">
        <div className="qx-row qx-row--tight qx-row--nowrap" role="group" aria-label="Opportunity filters">
          {OPPORTUNITY_FILTERS.map((f) => (
            <button
              key={f.key || 'all'}
              type="button"
              className={`qx-chip${filter === f.key ? ' qx-chip--active' : ''}`}
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={() => refresh({ force: true })}>
          <RefreshIcon /> Refresh
        </button>
      </div>

      {loading ? (
        <TableSkeleton />
      ) : error ? (
        <BackendBanner error={error} onRetry={() => refresh({ force: true })} />
      ) : opportunities.length === 0 ? (
        <div className="qx-empty">
          <span className="qx-empty__icon"><TrendIcon size={26} /></span>
          <span className="qx-empty__title">No opportunities surfaced for this crawl</span>
          <span className="qx-empty__body">That is a good sign, or the crawl has little Search Console data yet.</span>
        </div>
      ) : (
        <>
          <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
            <span className="qx-hint qx-hint--sm">{Number(summary.total ?? opportunities.length).toLocaleString()} opportunit{(summary.total ?? opportunities.length) === 1 ? 'y' : 'ies'}</span>
            {Object.entries(OPPORTUNITY_TYPE_META).map(([key, meta]) => (
              byType[key] ? (
                <span key={key} className={`qx-pill qx-pill--xs qx-pill--${meta.variant}`}>
                  {meta.label}: {Number(byType[key]).toLocaleString()}
                </span>
              ) : null
            ))}
          </div>
          <div className="qx-stack qx-stack--tight">
            {opportunities.map((opp) => (
              <OpportunityCard key={`${opp.type}-${opp.path}`} opp={opp} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ Keywords */

function KeywordOpportunityCard({ item }) {
  return (
    <div className="qx-card qx-card--compact">
      <div className="qx-stack qx-stack--tight">
        <div className="qx-row qx-row--apart" style={{ alignItems: 'center' }}>
          <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
            <span className="qx-num qx-mono">{Number(item.score ?? 0).toFixed(1)}</span>
            <span>&ldquo;{item.query}&rdquo;</span>
            <span className="qx-pill qx-pill--xs qx-pill--ghost">pos {Number(item.position ?? 0).toFixed(1)}</span>
          </div>
          <span className="qx-hint qx-hint--sm qx-mono">
            {Number(item.impressions ?? 0).toLocaleString()} impr · {Number(item.clicks ?? 0).toLocaleString()} clicks
          </span>
        </div>
        <span className="qx-mono qx-hint qx-hint--sm" title={item.page}>{item.page}</span>
      </div>
    </div>
  );
}

function CannibalisationCard({ item }) {
  const pages = (item.pages || []).slice(0, 5);
  return (
    <div className="qx-card qx-card--compact">
      <div className="qx-stack qx-stack--tight">
        <div className="qx-row qx-row--apart" style={{ alignItems: 'center' }}>
          <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
            <span>&ldquo;{item.query}&rdquo;</span>
            <span className="qx-pill qx-pill--xs qx-pill--warn">{item.page_count} pages</span>
          </div>
          <span className="qx-hint qx-hint--sm qx-mono">{Number(item.total_impressions ?? 0).toLocaleString()} impr total</span>
        </div>
        <div className="qx-stack qx-stack--tight">
          {pages.map((p) => (
            <div key={p.page} className="qx-row qx-row--apart">
              <span className="qx-mono" title={p.page}>{p.page}</span>
              <span className="qx-hint qx-hint--sm qx-mono">{Number(p.impressions ?? 0).toLocaleString()} impr · pos {Number(p.position ?? 0).toFixed(1)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const TREND_VARIANT = { winner: 'success', loser: 'danger', new: 'info', lost: 'warn', flat: 'ghost' };

function fmtWindow(w) {
  if (!w?.current) return null;
  const d = (s) => (s ? s.slice(5).replace('-', '/') : '?'); // 2026-08-06 -> 08/06
  return `${d(w.previous?.start)}–${d(w.previous?.end)}  →  ${d(w.current?.start)}–${d(w.current?.end)}`;
}

function TrendMoverRow({ row }) {
  const variant = TREND_VARIANT[row.status] || 'ghost';
  const dImpr = row.delta_impressions ?? 0;
  return (
    <div className="qx-card qx-card--compact">
      <div className="qx-row qx-row--apart" style={{ alignItems: 'center' }}>
        <div className="qx-row qx-row--tight" style={{ alignItems: 'center', minWidth: 0 }}>
          <span className={`qx-pill qx-pill--xs qx-pill--${variant}`}>{row.status}</span>
          <span className="qx-mono" title={row.key} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.key}</span>
          {row.position_improved ? <span className="qx-pill qx-pill--xs qx-pill--success" title="rank improved">rank ↑</span> : null}
        </div>
        <span className="qx-hint qx-hint--sm qx-mono" style={{ flexShrink: 0 }}>
          {Number(row.prev_impressions ?? 0).toLocaleString()}→{Number(row.impressions ?? 0).toLocaleString()} impr
          {dImpr ? ` (${dImpr > 0 ? '+' : ''}${dImpr.toLocaleString()})` : ''} · {Number(row.prev_clicks ?? 0).toLocaleString()}→{Number(row.clicks ?? 0).toLocaleString()} clk
        </span>
      </div>
    </div>
  );
}

function TrendsSection({ siteId, onEntitlementLocked }) {
  const [scope, setScope] = useState('url');
  const loader = useCallback((opts) => api.listTrends({ scope, limit: 12 }, siteId, opts), [siteId, scope]);
  const { loading, error, data } = useTabData(loader, [siteId, scope], onEntitlementLocked);

  // Silent when the trend warehouse has nothing yet: the tab still shows the
  // cannibalisation/keyword sections below. Never a scary banner for "no data".
  if (error) return null;
  const rows = scope === 'query' ? (data?.queries || []) : (data?.urls || []);
  const summary = scope === 'query' ? data?.query_summary : data?.url_summary;
  const windows = data?.windows;
  const hasSignal = data?.crawl_id && (rows.length > 0 || (summary && (summary.winner || summary.loser || summary.new)));
  if (!loading && !hasSignal) return null;

  return (
    <div className="qx-stack qx-stack--tight">
      <div className="qx-row qx-row--apart" style={{ alignItems: 'center' }}>
        <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
          <strong>Trends</strong>
          {windows ? <span className="qx-hint qx-hint--sm qx-mono">{fmtWindow(windows)}</span> : null}
        </div>
        <div className="qx-row qx-row--tight">
          {['url', 'query'].map((s) => (
            <button
              key={s}
              type="button"
              className={`qx-btn qx-btn--sm ${scope === s ? 'qx-btn--primary' : 'qx-btn--ghost'}`}
              onClick={() => setScope(s)}
            >
              {s === 'url' ? 'Pages' : 'Queries'}
            </button>
          ))}
        </div>
      </div>
      <span className="qx-hint qx-hint--sm">
        Winners and losers over time, from a Search Console period compare (last 28 days vs the 28 before). Every crawl is WARD-witnessed, so the history is verifiable.
      </span>
      {summary ? (
        <div className="qx-row qx-row--tight qx-row--wrap">
          <span className="qx-pill qx-pill--sm qx-pill--success">{summary.winner} winners</span>
          <span className="qx-pill qx-pill--sm qx-pill--danger">{summary.loser} losers</span>
          <span className="qx-pill qx-pill--sm qx-pill--info">{summary.new} new</span>
          {summary.lost ? <span className="qx-pill qx-pill--sm qx-pill--warn">{summary.lost} lost</span> : null}
        </div>
      ) : null}
      {loading ? (
        <TableSkeleton lines={4} />
      ) : rows.length === 0 ? (
        <span className="qx-hint qx-hint--sm">No movers above the impression floor this period.</span>
      ) : (
        rows.map((r, i) => <TrendMoverRow key={`${r.key}-${i}`} row={r} />)
      )}
    </div>
  );
}

function KeywordsTab({ siteId, onEntitlementLocked, dataforseoConfigured }) {
  const loader = useCallback((opts) => api.listQueries({ limit: 100 }, siteId, opts), [siteId]);
  const { loading, error, data, refresh } = useTabData(loader, [siteId], onEntitlementLocked);

  if (loading) {
    return (
      <div className="qx-stack">
        <div className="qx-grid-2">
          <div className="qx-card qx-card--compact"><div className="qx-skeleton qx-skeleton--block" /></div>
          <div className="qx-card qx-card--compact"><div className="qx-skeleton qx-skeleton--block" /></div>
        </div>
        <TableSkeleton />
      </div>
    );
  }

  if (error) {
    return <BackendBanner error={error} onRetry={() => refresh({ force: true })} />;
  }

  const keywordOpportunities = data?.keyword_opportunities || [];
  const cannibalisation = data?.cannibalisation || [];
  const brand = data?.brand || null;
  const empty = keywordOpportunities.length === 0 && cannibalisation.length === 0;

  return (
    <div className="qx-stack">
      {dataforseoConfigured === false && <DataForSeoBanner compact />}
      <div className="qx-row qx-row--apart">
        <span className="qx-hint">Query-level SEO intelligence, from Search Console data</span>
        <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={() => refresh({ force: true })}>
          <RefreshIcon /> Refresh
        </button>
      </div>

      <TrendsSection siteId={siteId} onEntitlementLocked={onEntitlementLocked} />

      {brand ? (
        <div className="qx-stack qx-stack--tight">
          <div className="qx-grid-2">
            <StatTile
              icon={<TrendIcon />}
              label="Non-brand demand"
              value={Number(brand.nonbrand?.impressions ?? 0).toLocaleString()}
              sub={`${Number(brand.nonbrand?.queries ?? 0).toLocaleString()} queries`}
            />
            <StatTile
              icon={<GlobeIcon />}
              label="Brand"
              value={Number(brand.brand?.impressions ?? 0).toLocaleString()}
              sub={`${Number(brand.brand?.queries ?? 0).toLocaleString()} queries`}
            />
          </div>
          <span className="qx-hint qx-hint--sm">
            Non-brand impressions are the demand you can actually grow: brand traffic mostly comes looking for you already.
          </span>
        </div>
      ) : null}

      {empty ? (
        <div className="qx-empty">
          <span className="qx-empty__icon"><TrendIcon size={26} /></span>
          <span className="qx-empty__title">No query-level signals yet</span>
          <span className="qx-empty__body">This needs Search Console query data, which lands on the next ingest.</span>
        </div>
      ) : (
        <>
          <div className="qx-stack qx-stack--tight">
            <strong>Keyword opportunities</strong>
            {keywordOpportunities.length === 0 ? (
              <span className="qx-hint qx-hint--sm">No ranked keyword opportunities in this crawl.</span>
            ) : (
              keywordOpportunities.map((item, i) => (
                <KeywordOpportunityCard key={`${item.query}-${item.page}-${i}`} item={item} />
              ))
            )}
          </div>

          <div className="qx-stack qx-stack--tight">
            <strong>Cannibalisation</strong>
            <span className="qx-hint qx-hint--sm">
              Multiple pages competing for one query split its ranking authority instead of adding up.
            </span>
            {cannibalisation.length === 0 ? (
              <span className="qx-hint qx-hint--sm">No cannibalising queries found.</span>
            ) : (
              cannibalisation.map((item, i) => (
                <CannibalisationCard key={`${item.query}-${i}`} item={item} />
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ Keyword Manager */

/** <30 = easy (green), 30-60 = moderate (amber), >60 = hard (red). Null = no score yet. */
function difficultyVariant(difficulty) {
  if (difficulty == null) return 'ghost';
  const v = Number(difficulty);
  if (v < 30) return 'success';
  if (v <= 60) return 'warn';
  return 'danger';
}

function MovementPill({ movement }) {
  const m = Number(movement) || 0;
  const direction = m > 0 ? 'up' : m < 0 ? 'down' : 'flat';
  const variant = direction === 'up' ? 'success' : direction === 'down' ? 'danger' : 'ghost';
  return (
    <span className={`qx-pill qx-pill--xs qx-pill--${variant}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span className="qx-trend__arrow"><TrendArrowIcon direction={direction} /></span>
      {m === 0 ? 'flat' : `${m > 0 ? '+' : ''}${m}`}
    </span>
  );
}

/**
 * Position sparkline for one tracked keyword. Lower position is better, so the value axis is
 * inverted: the best (lowest) position plots near the top, meaning a rising line always reads
 * as an improving rank. A single data point renders as a lone dot rather than a broken line.
 */
function PositionSparkline({ history }) {
  if (history?.loading) {
    return <div className="qx-skeleton qx-skeleton--line-md" style={{ width: 70, height: 16 }} />;
  }
  if (history?.error) {
    return <span className="qx-hint qx-hint--sm">History unavailable</span>;
  }
  const points = (history?.data?.points || []).filter((p) => typeof p.position === 'number');
  if (points.length === 0) {
    return <span className="qx-hint qx-hint--sm">No history yet</span>;
  }

  const w = 80, h = 24, pad = 2;

  if (points.length === 1) {
    return (
      <span className="qx-spark" title="Only one crawl on file so far">
        <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
          <circle cx={w / 2} cy={h / 2} r={2.4} className="qx-spark__dot" />
        </svg>
      </span>
    );
  }

  const vals = points.map((p) => p.position);
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  const range = max - min || 1;
  const step = (w - pad * 2) / (vals.length - 1);
  const coords = vals.map((v, i) => [pad + i * step, pad + ((v - min) / range) * (h - pad * 2)]);
  const line = coords.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(' ');
  const area = `${line} L${coords[coords.length - 1][0]},${h} L${coords[0][0]},${h} Z`;
  const last = coords[coords.length - 1];
  const improving = vals[vals.length - 1] < vals[0];
  const worsening = vals[vals.length - 1] > vals[0];
  const variant = improving ? ' qx-spark--success' : worsening ? ' qx-spark--crit' : '';

  return (
    <span className={`qx-spark${variant}`} title={improving ? 'Position improving' : worsening ? 'Position declining' : 'Position flat'}>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
        <path d={area} className="qx-spark__area" />
        <path d={line} className="qx-spark__line" />
        <circle cx={last[0]} cy={last[1]} r={2.2} className="qx-spark__dot" />
      </svg>
    </span>
  );
}

function RankTrackerSection({ tracked, rankRows, histories }) {
  const rankByQuery = useMemo(() => {
    const map = new Map();
    for (const r of rankRows) map.set(r.query, r);
    return map;
  }, [rankRows]);

  if (tracked.length === 0) {
    return (
      <div className="qx-empty">
        <span className="qx-empty__icon"><MapIcon size={22} /></span>
        <span className="qx-empty__title">No tracked keywords yet</span>
        <span className="qx-empty__body">Track a keyword against this property to start building rank history here.</span>
      </div>
    );
  }

  return (
    <div className="qx-card qx-card--compact" style={{ overflow: 'auto' }}>
      <table className="qx-table">
        <thead>
          <tr>
            <th>Keyword</th>
            <th className="qx-num">Position</th>
            <th>Movement</th>
            <th className="qx-num">Impressions</th>
            <th className="qx-num">Clicks</th>
            <th>Trend</th>
          </tr>
        </thead>
        <tbody>
          {tracked.map((t) => {
            const row = rankByQuery.get(t.keyword);
            return (
              <tr key={t.keyword}>
                <td>{t.keyword}</td>
                <td className="qx-num">
                  {row?.position != null
                    ? Number(row.position).toFixed(1)
                    : <span className="qx-hint qx-hint--sm">not ranking</span>}
                </td>
                <td>{row ? <MovementPill movement={row.movement} /> : <span className="qx-hint qx-hint--sm">n/a</span>}</td>
                <td className="qx-num">{Number(row?.impressions ?? 0).toLocaleString()}</td>
                <td className="qx-num">{Number(row?.clicks ?? 0).toLocaleString()}</td>
                <td><PositionSparkline history={histories[t.keyword]} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ShareOfVoiceBars({ competitors }) {
  if (competitors.length === 0) return null;
  const max = Math.max(...competitors.map((c) => Number(c.keywords) || 0), 1);
  return (
    <div className="qx-stack qx-stack--tight">
      <span className="qx-hint qx-hint--sm">Share of voice, by keyword count on file</span>
      <div className="qx-bars" style={{ height: 90 }}>
        {competitors.map((c) => (
          <div
            key={c.competitor}
            className="qx-bars__bar"
            style={{ '--qx-h': (Number(c.keywords) || 0) / max }}
            title={`${c.competitor}: ${Number(c.keywords || 0).toLocaleString()} keywords`}
          />
        ))}
      </div>
      <div className="qx-row qx-row--tight qx-row--wrap">
        {competitors.map((c) => (
          <span key={c.competitor} className="qx-hint qx-hint--sm qx-mono">
            {c.competitor}: {Number(c.keywords || 0).toLocaleString()}
          </span>
        ))}
      </div>
    </div>
  );
}

function CompetitorChips({ competitors, selected, onSelect }) {
  return (
    <div className="qx-row qx-row--tight qx-row--wrap" role="group" aria-label="Competitor selector">
      {competitors.map((c) => (
        <button
          key={c.competitor}
          type="button"
          className={`qx-chip${selected === c.competitor ? ' qx-chip--active' : ''}`}
          aria-pressed={selected === c.competitor}
          onClick={() => onSelect(c.competitor)}
        >
          <GlobeIcon size={12} /> {c.competitor}
        </button>
      ))}
    </div>
  );
}

function CompetitorGapPanel({ siteId, onEntitlementLocked, competitors }) {
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    if (!selected && competitors.length > 0) setSelected(competitors[0].competitor);
  }, [competitors, selected]);

  const loader = useCallback(
    (opts) => (selected ? api.getGapDetail(selected, siteId, opts) : Promise.resolve(null)),
    [selected, siteId]
  );
  const { loading, error, data, refresh } = useTabData(loader, [selected, siteId], onEntitlementLocked);

  if (competitors.length === 0) {
    return (
      <div className="qx-empty">
        <span className="qx-empty__icon"><CompassIcon size={22} /></span>
        <span className="qx-empty__title">No competitors tracked yet</span>
        <span className="qx-empty__body">Add a competitor domain to see where they outrank this property.</span>
      </div>
    );
  }

  const summary = data?.summary;
  const gaps = (data?.keyword_gaps || []).slice().sort((a, b) => (Number(b.volume) || 0) - (Number(a.volume) || 0));
  const maxVolume = Math.max(...gaps.map((g) => Number(g.volume) || 0), 1);

  return (
    <div className="qx-stack qx-stack--tight">
      <div className="qx-row qx-row--apart" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <CompetitorChips competitors={competitors} selected={selected} onSelect={setSelected} />
        <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={() => refresh({ force: true })}>
          <RefreshIcon /> Refresh
        </button>
      </div>

      {loading ? (
        <TableSkeleton lines={5} />
      ) : error ? (
        <BackendBanner error={error} onRetry={() => refresh({ force: true })} />
      ) : !data ? null : (
        <>
          {summary ? (
            <span className="qx-hint qx-hint--sm">
              {Number(summary.gap_keywords ?? 0).toLocaleString()} keyword gaps, {Number(summary.gap_volume ?? 0).toLocaleString()} monthly search volume behind {selected}
            </span>
          ) : null}
          {gaps.length === 0 ? (
            <span className="qx-hint qx-hint--sm">No keyword gaps found against {selected}.</span>
          ) : (
            <div className="qx-card qx-card--compact" style={{ overflow: 'auto' }}>
              <table className="qx-table">
                <thead>
                  <tr>
                    <th>Keyword</th>
                    <th className="qx-num">Volume</th>
                    <th className="qx-num">Their position</th>
                    <th className="qx-num">Our position</th>
                    <th>Their URL</th>
                  </tr>
                </thead>
                <tbody>
                  {gaps.map((g, i) => (
                    <tr key={`${g.keyword}-${i}`}>
                      <td>{g.keyword}</td>
                      <td className="qx-num">
                        <div className="qx-row qx-row--tight" style={{ alignItems: 'center', justifyContent: 'flex-end' }}>
                          <span className="qx-mono">{Number(g.volume ?? 0).toLocaleString()}</span>
                          <span className="qx-bars" style={{ height: 14, width: 48 }}>
                            <span className="qx-bars__bar" style={{ '--qx-h': (Number(g.volume) || 0) / maxVolume }} />
                          </span>
                        </div>
                      </td>
                      <td className="qx-num">{g.their_position != null ? Number(g.their_position).toFixed(1) : 'n/a'}</td>
                      <td className="qx-num">
                        {g.our_position != null
                          ? Number(g.our_position).toFixed(1)
                          : <span className="qx-hint qx-hint--sm">absent</span>}
                      </td>
                      <td>
                        {g.competitor_url ? (
                          <a className="qx-mono" href={g.competitor_url} target="_blank" rel="noopener noreferrer" title={g.competitor_url}>
                            <ExternalLinkIcon size={11} /> {truncateMono(g.competitor_url, 44)}
                          </a>
                        ) : 'None'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function KeywordUniverseTable({ keywords }) {
  if (keywords.length === 0) {
    return (
      <div className="qx-empty">
        <span className="qx-empty__icon"><ClipboardTextIcon size={22} /></span>
        <span className="qx-empty__title">No keyword research on file yet</span>
        <span className="qx-empty__body">Volume, difficulty, and CPC appear here once DataForSEO keyword research has run for this property.</span>
      </div>
    );
  }
  return (
    <div className="qx-card qx-card--compact" style={{ overflow: 'auto' }}>
      <table className="qx-table">
        <thead>
          <tr>
            <th>Keyword</th>
            <th className="qx-num">Volume</th>
            <th className="qx-num">Difficulty</th>
            <th className="qx-num">CPC</th>
            <th className="qx-num">Competition</th>
          </tr>
        </thead>
        <tbody>
          {keywords.map((k, i) => (
            <tr key={`${k.keyword}-${i}`}>
              <td>{k.keyword}</td>
              <td className="qx-num qx-mono">{Number(k.volume ?? 0).toLocaleString()}</td>
              <td className="qx-num">
                {k.difficulty != null
                  ? <span className={`qx-pill qx-pill--xs qx-pill--${difficultyVariant(k.difficulty)}`}>{Math.round(Number(k.difficulty))}</span>
                  : <span className="qx-hint qx-hint--sm">n/a</span>}
              </td>
              <td className="qx-num qx-mono">{k.cpc != null ? `$${Number(k.cpc).toFixed(2)}` : 'n/a'}</td>
              <td className="qx-num qx-mono">{k.competition != null ? Number(k.competition).toFixed(2) : 'n/a'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KeywordManagerTab({ siteId, onEntitlementLocked, dataforseoConfigured }) {
  const loader = useCallback(
    async (opts) => {
      const [keywordsRes, trackedRes, rankRes, gapsRes] = await Promise.all([
        api.listKeywords({ limit: 200 }, siteId, opts),
        api.listTracked(siteId, opts),
        api.listRank(siteId, opts),
        api.listGaps(siteId, opts),
      ]);
      return { keywordsRes, trackedRes, rankRes, gapsRes };
    },
    [siteId]
  );
  const { loading, error, data, refresh } = useTabData(loader, [siteId], onEntitlementLocked);

  const tracked = data?.trackedRes?.tracked || [];
  const rankRows = data?.rankRes?.rows || [];
  const keywords = data?.keywordsRes?.keywords || [];
  const competitors = data?.gapsRes?.competitors || [];

  // Rank history is fetched per tracked keyword once the tracked list is known, in parallel,
  // keyed by keyword text so RankTrackerSection can look each one up while rendering rows.
  const [histories, setHistories] = useState({});
  const trackedKey = tracked.map((t) => t.keyword).join('|');

  useEffect(() => {
    if (tracked.length === 0) {
      setHistories({});
      return undefined;
    }
    let cancelled = false;
    setHistories((prev) => {
      const next = {};
      for (const t of tracked) next[t.keyword] = prev[t.keyword] || { loading: true };
      return next;
    });
    Promise.all(
      tracked.map((t) =>
        api.getRankHistory(t.keyword, siteId)
          .then((res) => ({ keyword: t.keyword, data: res }))
          .catch((err) => ({ keyword: t.keyword, error: err }))
      )
    ).then((results) => {
      if (cancelled) return;
      const next = {};
      for (const r of results) {
        next[r.keyword] = r.error ? { loading: false, error: r.error } : { loading: false, data: r.data };
      }
      setHistories(next);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId, trackedKey]);

  if (loading) {
    return (
      <div className="qx-stack">
        <div className="qx-grid-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="qx-card qx-card--compact"><div className="qx-skeleton qx-skeleton--block" /></div>
          ))}
        </div>
        <TableSkeleton lines={6} />
      </div>
    );
  }

  if (error) {
    return <BackendBanner error={error} onRetry={() => refresh({ force: true })} />;
  }

  const totalVolume = keywords.reduce((sum, k) => sum + (Number(k.volume) || 0), 0);
  const difficulties = keywords.map((k) => k.difficulty).filter((d) => d != null);
  const avgDifficulty = difficulties.length
    ? difficulties.reduce((sum, d) => sum + Number(d), 0) / difficulties.length
    : null;
  const rankingRows = rankRows.filter((r) => r.position != null && r.position <= 100);
  const positions = rankRows.map((r) => r.position).filter((p) => p != null);
  const bestPosition = positions.length ? Math.min(...positions) : null;

  return (
    <div className="qx-stack">
      {dataforseoConfigured === false && <DataForSeoBanner compact />}

      {/* One shared gradient definition for every neutral (flat-trend) sparkline below,
          so per-row sparklines never each declare their own duplicate element id. */}
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
        <defs>
          <linearGradient id="qx-spark-grad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#38bdf8" /><stop offset="100%" stopColor="#a855f7" />
          </linearGradient>
          <linearGradient id="qx-spark-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(56,189,248,0.35)" /><stop offset="100%" stopColor="rgba(168,85,247,0)" />
          </linearGradient>
        </defs>
      </svg>

      <div className="qx-row qx-row--apart">
        <span className="qx-hint">Tracked keywords, rank history, and competitor keyword gaps</span>
        <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={() => refresh({ force: true })}>
          <RefreshIcon /> Refresh
        </button>
      </div>

      <div className="qx-grid-3">
        <StatTile icon={<MapIcon />} label="Tracked keywords" value={tracked.length.toLocaleString()} />
        <StatTile
          icon={<TrendIcon />}
          label="Total search volume"
          value={totalVolume.toLocaleString()}
          sub={`across ${keywords.length.toLocaleString()} keyword(s)`}
        />
        <StatTile icon={<CompassIcon />} label="Avg difficulty" value={avgDifficulty != null ? Math.round(avgDifficulty) : 'n/a'} />
        <StatTile
          icon={<ShieldCheckIcon />}
          label="Keywords ranking"
          value={rankingRows.length.toLocaleString()}
          sub="position 100 or better"
        />
        <StatTile icon={<TrendIcon />} label="Best position" value={bestPosition != null ? Number(bestPosition).toFixed(1) : 'n/a'} />
        <StatTile icon={<GlobeIcon />} label="Competitors tracked" value={competitors.length.toLocaleString()} />
      </div>

      <div className="qx-stack qx-stack--tight">
        <strong>Rank tracker</strong>
        <span className="qx-hint qx-hint--sm">
          Search Console position for each tracked keyword, with a short history. A rising sparkline means the rank is improving.
        </span>
        <RankTrackerSection tracked={tracked} rankRows={rankRows} histories={histories} />
      </div>

      <div className="qx-stack qx-stack--tight">
        <strong>Competitor gap intelligence</strong>
        <ShareOfVoiceBars competitors={competitors} />
        <CompetitorGapPanel siteId={siteId} onEntitlementLocked={onEntitlementLocked} competitors={competitors} />
      </div>

      <div className="qx-stack qx-stack--tight">
        <strong>Keyword universe</strong>
        <KeywordUniverseTable keywords={keywords} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Audit */

const AUDIT_SEVERITY_FILTERS = [
  { key: '', label: 'All' },
  { key: 'high', label: 'High' },
  { key: 'medium', label: 'Medium' },
  { key: 'low', label: 'Low' },
];

const AUDIT_SEVERITY_VARIANT = { high: 'danger', medium: 'warn', low: 'ghost' };

/** "thin_content" -> "thin content", "missing_h1" -> "missing h1". */
function humaniseIssueType(type) {
  return String(type || '').replace(/_/g, ' ');
}

function IssueRow({ issue }) {
  const variant = AUDIT_SEVERITY_VARIANT[issue.severity] || 'ghost';
  const paths = Array.isArray(issue.paths) ? issue.paths : null;
  return (
    <div className="qx-card qx-card--compact">
      <div className="qx-stack qx-stack--tight">
        <div className="qx-row qx-row--tight qx-row--wrap" style={{ alignItems: 'center' }}>
          <span className={`qx-pill qx-pill--xs qx-pill--${variant}`}>{issue.severity}</span>
          <span>{humaniseIssueType(issue.type)}</span>
          {paths ? (
            <span className="qx-hint qx-hint--sm">{paths.length.toLocaleString()} pages</span>
          ) : (
            <span className="qx-mono" title={issue.path}>{issue.path}</span>
          )}
        </div>
        {issue.detail ? <span>{issue.detail}</span> : null}
        {paths && paths.length > 0 ? (
          <div className="qx-stack qx-stack--tight">
            {paths.slice(0, 3).map((p) => (
              <span key={p} className="qx-mono qx-hint qx-hint--sm">{p}</span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

const CONFLICT_VARIANT = { high: 'danger', medium: 'warn', low: 'ghost' };

function CoverageSection({ siteId, onEntitlementLocked }) {
  const loader = useCallback((opts) => api.listInspection({ limit: 200 }, siteId, opts), [siteId]);
  const { loading, error, data } = useTabData(loader, [siteId], onEntitlementLocked);

  if (error) return null; // silent: the audit's own issues render below regardless
  const coverage = data?.coverage;
  const conflicts = data?.conflicts || [];
  const hasData = coverage && coverage.total > 0;
  if (!loading && !hasData) return null;

  const states = Object.entries(coverage?.by_state || {}).sort((a, b) => b[1] - a[1]);
  return (
    <div className="qx-stack qx-stack--tight">
      <div className="qx-row qx-row--apart" style={{ alignItems: 'center' }}>
        <strong>Index coverage</strong>
        <span className="qx-hint qx-hint--sm">Google's own verdict per URL, cross-checked against the page</span>
      </div>
      {loading ? (
        <div className="qx-grid-2"><div className="qx-card qx-card--compact"><div className="qx-skeleton qx-skeleton--block" /></div><div className="qx-card qx-card--compact"><div className="qx-skeleton qx-skeleton--block" /></div></div>
      ) : (
        <>
          <div className="qx-grid-2">
            <StatTile icon={<GlobeIcon />} label="Indexed by Google" value={Number(coverage.indexed).toLocaleString()} sub={`of ${Number(coverage.total).toLocaleString()} inspected`} />
            <StatTile icon={<ClipboardXIcon />} label="Not indexed" value={Number(coverage.not_indexed).toLocaleString()} sub={conflicts.length ? `${conflicts.length} need attention` : 'none flagged'} />
          </div>
          {states.length ? (
            <div className="qx-row qx-row--tight qx-row--wrap">
              {states.map(([state, n]) => (
                <span key={state} className="qx-pill qx-pill--xs qx-pill--ghost" title={state}>{n} · {state}</span>
              ))}
            </div>
          ) : null}
          {conflicts.length ? (
            <div className="qx-stack qx-stack--tight">
              <span className="qx-hint qx-hint--sm">Where Google disagrees with the page (highest signal first):</span>
              {conflicts.slice(0, 8).map((c, i) => (
                <div key={`${c.path}-${i}`} className="qx-card qx-card--compact">
                  <div className="qx-stack qx-stack--tight">
                    <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
                      <span className={`qx-pill qx-pill--xs qx-pill--${CONFLICT_VARIANT[c.severity] || 'ghost'}`}>{c.severity}</span>
                      <span className="qx-mono" title={c.path}>{c.path}</span>
                    </div>
                    <span className="qx-hint qx-hint--sm">{c.detail}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function AuditTab({ siteId, onEntitlementLocked }) {
  const [severityFilter, setSeverityFilter] = useState('');

  const loader = useCallback(
    (opts) => api.listIssues({ severity: severityFilter || undefined, limit: 300 }, siteId, opts),
    [severityFilter, siteId]
  );
  const { loading, error, data, refresh } = useTabData(loader, [severityFilter, siteId], onEntitlementLocked);

  const issues = data?.issues || [];
  const summary = data?.summary || {};
  const bySeverity = summary.by_severity || {};
  const byType = summary.by_type || {};

  return (
    <div className="qx-stack">
      <div className="qx-row qx-row--apart">
        <div className="qx-row qx-row--tight qx-row--nowrap" role="group" aria-label="Severity filters">
          {AUDIT_SEVERITY_FILTERS.map((f) => (
            <button
              key={f.key || 'all'}
              type="button"
              className={`qx-chip${severityFilter === f.key ? ' qx-chip--active' : ''}`}
              aria-pressed={severityFilter === f.key}
              onClick={() => setSeverityFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={() => refresh({ force: true })}>
          <RefreshIcon /> Refresh
        </button>
      </div>

      <CoverageSection siteId={siteId} onEntitlementLocked={onEntitlementLocked} />

      {loading ? (
        <div className="qx-stack">
          <div className="qx-grid-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="qx-card qx-card--compact"><div className="qx-skeleton qx-skeleton--block" /></div>
            ))}
          </div>
          <TableSkeleton />
        </div>
      ) : error ? (
        <BackendBanner error={error} onRetry={() => refresh({ force: true })} />
      ) : issues.length === 0 ? (
        <div className="qx-empty">
          <span className="qx-empty__icon"><ShieldCheckIcon size={26} /></span>
          <span className="qx-empty__title">No issues found in the latest crawl</span>
          <span className="qx-empty__body">Clean site, or the crawl has not run yet.</span>
        </div>
      ) : (
        <>
          <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
            <span className="qx-pill qx-pill--xs qx-pill--danger">High: {Number(bySeverity.high ?? 0).toLocaleString()}</span>
            <span className="qx-pill qx-pill--xs qx-pill--warn">Medium: {Number(bySeverity.medium ?? 0).toLocaleString()}</span>
            <span className="qx-pill qx-pill--xs qx-pill--ghost">Low: {Number(bySeverity.low ?? 0).toLocaleString()}</span>
          </div>

          {Object.keys(byType).length > 0 ? (
            <div className="qx-row qx-row--tight qx-row--wrap">
              {Object.entries(byType).map(([key, count]) => (
                <span key={key} className="qx-pill qx-pill--xs qx-pill--ghost">
                  {humaniseIssueType(key)}: {Number(count).toLocaleString()}
                </span>
              ))}
            </div>
          ) : null}

          <div className="qx-stack qx-stack--tight">
            {issues.map((issue, i) => (
              <IssueRow key={`${issue.type}-${issue.path || i}`} issue={issue} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ URL Warehouse */

function UrlWarehouseTab({ siteId, onEntitlementLocked }) {
  const [filter, setFilter] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');

  useEffect(() => {
    const handle = setTimeout(() => setQuery(searchInput), 300);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const loader = useCallback(
    (opts) => api.listUrls({ filter, q: query, sort: 'impressions', limit: 200 }, siteId, opts),
    [filter, query, siteId]
  );
  const { loading, error, data, refresh } = useTabData(loader, [filter, query, siteId], onEntitlementLocked);

  const urls = data?.urls || [];

  return (
    <div className="qx-stack">
      <div className="qx-row qx-row--apart">
        <div className="qx-row qx-row--tight qx-row--nowrap" role="group" aria-label="URL filters">
          {URL_FILTERS.map((f) => (
            <button
              key={f.key || 'all'}
              type="button"
              className={`qx-chip${filter === f.key ? ' qx-chip--active' : ''}`}
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={() => refresh({ force: true })}>
          <RefreshIcon /> Refresh
        </button>
      </div>

      <div className="qx-search-wrap" style={{ maxWidth: 320 }}>
        <span className="qx-search-wrap__icon" aria-hidden="true">⌕</span>
        <input
          type="text"
          className="qx-input"
          placeholder="Search path or title…"
          aria-label="Search URLs"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
      </div>

      {loading ? (
        <TableSkeleton />
      ) : error ? (
        <BackendBanner error={error} onRetry={() => refresh({ force: true })} />
      ) : urls.length === 0 ? (
        <div className="qx-empty">
          <span className="qx-empty__icon"><LayersIcon size={26} /></span>
          <span className="qx-empty__title">No URLs match this filter</span>
          <span className="qx-empty__body">Try a different filter chip, or clear the search.</span>
        </div>
      ) : (
        <div className="qx-card qx-card--compact" style={{ overflow: 'auto' }}>
          <table className="qx-table">
            <thead>
              <tr>
                <th>Path</th>
                <th>Status</th>
                <th>Title</th>
                <th className="qx-num">Impressions</th>
                <th className="qx-num">Clicks</th>
                <th className="qx-num">Position</th>
                <th className="qx-num">Inlinks</th>
                <th>Flags</th>
              </tr>
            </thead>
            <tbody>
              {urls.map((row) => (
                <tr key={row.path}>
                  <td className="qx-mono" title={row.path}>{row.path}</td>
                  <td><span className={`qx-pill qx-pill--xs qx-pill--${statusPillVariant(row.status)}`}>{row.status ?? 'n/a'}</span></td>
                  <td>{row.title || 'None'}</td>
                  <td className="qx-num">{Number(row.gsc_impressions ?? 0).toLocaleString()}</td>
                  <td className="qx-num">{Number(row.gsc_clicks ?? 0).toLocaleString()}</td>
                  <td className="qx-num">{row.gsc_position != null ? Number(row.gsc_position).toFixed(1) : 'None'}</td>
                  <td className="qx-num">{row.inlinks_contextual ?? 0} / {row.inlinks_all ?? 0}</td>
                  <td><UrlFlags row={row} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <span className="qx-hint qx-hint--sm">
        {data?.total ?? urls.length} URL(s){data?.crawl_id ? `, from crawl ${data.crawl_id}` : ''}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ Changes */

function ChangeGlyph({ type }) {
  if (type === 'url_added') return <span className="qx-pill qx-pill--xs qx-pill--success" title="URL added">+</span>;
  if (type === 'url_removed') return <span className="qx-pill qx-pill--xs qx-pill--danger" title="URL removed">-</span>;
  return <span className="qx-pill qx-pill--xs qx-pill--info" title="Field changed">~</span>;
}

/** classification -> pill variant, shared by the strip, the rollup rows, and the per-event pill. */
function classificationVariant(classification) {
  if (classification === 'improvement') return 'success';
  if (classification === 'regression') return 'danger';
  return 'ghost';
}

function truncateMono(value, max = 40) {
  const str = String(value ?? 'None');
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

function ClassificationStrip({ classification }) {
  const improvement = classification?.improvement ?? 0;
  const regression = classification?.regression ?? 0;
  const neutral = classification?.neutral ?? 0;
  return (
    <div className="qx-grid-3">
      <StatTile icon={<TrendIcon />} label="Improvements" value={improvement.toLocaleString()} />
      <StatTile icon={<ClipboardXIcon />} label="Regressions" value={regression.toLocaleString()} />
      <StatTile icon={<LayersIcon />} label="Neutral" value={neutral.toLocaleString()} />
    </div>
  );
}

function RollupRow({ group, i }) {
  const variant = classificationVariant(group.classification);
  return (
    <div className="qx-row qx-row--apart" style={{ padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
        <span className={`qx-pill qx-pill--xs qx-pill--${variant}`}>{group.classification}</span>
        <span>{group.summary}</span>
        {group.example ? (
          <span className="qx-mono qx-hint qx-hint--sm">
            {truncateMono(group.example.from)} → {truncateMono(group.example.to)}
          </span>
        ) : null}
      </div>
      <span className="qx-hint qx-hint--sm">{Number(group.count ?? 0).toLocaleString()}</span>
    </div>
  );
}

function ChangesTab({ siteId, onEntitlementLocked }) {
  const loader = useCallback((opts) => api.listChanges({ limit: 100 }, siteId, opts), [siteId]);
  const { loading, error, data, refresh } = useTabData(loader, [siteId], onEntitlementLocked);
  const changes = data?.changes || [];
  const rollup = data?.rollup || [];
  const classification = data?.classification;

  return (
    <div className="qx-stack">
      <div className="qx-row qx-row--apart">
        <span className="qx-hint">Witnessed change log, most recent first</span>
        <button type="button" className="qx-btn qx-btn--sm qx-btn--ghost" onClick={() => refresh({ force: true })}>
          <RefreshIcon /> Refresh
        </button>
      </div>

      {loading ? (
        <TableSkeleton />
      ) : error ? (
        <BackendBanner error={error} onRetry={() => refresh({ force: true })} />
      ) : changes.length === 0 ? (
        <div className="qx-empty">
          <span className="qx-empty__icon"><ShieldCheckIcon size={26} /></span>
          <span className="qx-empty__title">No change events yet</span>
          <span className="qx-empty__body">Two identical crawls mean exactly that. The first real site change will land here, signed.</span>
        </div>
      ) : (
        <>
          {classification ? <ClassificationStrip classification={classification} /> : null}

          {rollup.length > 0 ? (
            <div className="qx-card qx-card--compact">
              <div className="qx-stack qx-stack--tight">
                <strong>Summary</strong>
                {rollup.map((group, i) => (
                  <RollupRow key={`${group.field ?? group.kind ?? 'group'}-${group.classification}-${i}`} group={group} i={i} />
                ))}
              </div>
            </div>
          ) : null}

          <div className="qx-card qx-card--compact" style={{ overflow: 'auto' }}>
            <table className="qx-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Path</th>
                  <th>Change</th>
                  <th></th>
                  <th>Crawl</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {changes.map((ch, i) => (
                  <tr key={`${ch.crawl_id}-${ch.path}-${ch.field || ch.type}-${i}`}>
                    <td><ChangeGlyph type={ch.type} /></td>
                    <td className="qx-mono" title={ch.path}>{ch.path}</td>
                    <td>
                      {ch.type === 'field_changed' ? (
                        <span>{ch.field}: <span className="qx-mono">{String(ch.from ?? 'None')}</span> to <span className="qx-mono">{String(ch.to ?? 'None')}</span></span>
                      ) : ch.type === 'url_added' ? 'URL added' : 'URL removed'}
                    </td>
                    <td>
                      {ch.classification ? (
                        <span className={`qx-pill qx-pill--xs qx-pill--${classificationVariant(ch.classification)}`}>{ch.classification}</span>
                      ) : null}
                    </td>
                    <td className="qx-mono">{ch.crawl_id}{ch.prev_crawl_id != null ? ` (from ${ch.prev_crawl_id})` : ''}</td>
                    <td>{ch.created_at ? new Date(ch.created_at).toLocaleString() : 'unknown'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ Evidence */

// eslint-disable-next-line no-unused-vars -- `siteId` accepted for prop-signature consistency
// with the other tabs; verify() recomputes the whole org's chain, so it is not forwarded.
function EvidenceTab({ siteId, onEntitlementLocked }) {
  const [state, setState] = useState({ loading: false, error: null, data: null });

  const runVerify = useCallback(() => {
    setState({ loading: true, error: null, data: null });
    api.verify()
      .then((data) => setState({ loading: false, error: null, data }))
      .catch((error) => {
        if (isEntitlementError(error)) {
          onEntitlementLocked();
          return;
        }
        setState({ loading: false, error, data: null });
      });
  }, [onEntitlementLocked]);

  const allOk = state.data && state.data.chain_status === 'INTACT' && state.data.all_ok;

  return (
    <div className="qx-stack">
      <div className="qx-card qx-card--compact">
        <div className="qx-stack qx-stack--tight">
          <strong>Evidence</strong>
          <span className="qx-hint">
            This recomputes hashes and Ed25519 signatures server-side from the warehouse rows and the exported WARD chain: nothing here is taken on trust.
          </span>
          <div>
            <button type="button" className="qx-btn qx-btn--primary qx-btn--sm" onClick={runVerify} disabled={state.loading}>
              <ShieldCheckIcon />
              {state.loading ? 'Verifying…' : 'Verify chain'}
            </button>
          </div>
        </div>
      </div>

      {state.loading && <TableSkeleton lines={3} />}

      {state.error && <BackendBanner error={state.error} onRetry={runVerify} />}

      {state.data && (
        <div className="qx-stack">
          <div className="qx-card qx-card--compact qx-row qx-row--apart">
            <span>Chain status</span>
            <span className={`qx-pill ${allOk ? 'qx-pill--success' : 'qx-pill--danger'}`}>
              {state.data.chain_status}{allOk ? '' : ', issues found'}
            </span>
          </div>
          <div className="qx-card qx-card--compact" style={{ overflow: 'auto' }}>
            <table className="qx-table">
              <thead>
                <tr>
                  <th>Crawl</th>
                  <th>WARD seq</th>
                  <th>Statement hash</th>
                  <th>Root hash</th>
                </tr>
              </thead>
              <tbody>
                {(state.data.crawls || []).map((c) => (
                  <tr key={c.crawl_id}>
                    <td className="qx-mono">{c.crawl_id}</td>
                    <td className="qx-mono">{c.ward_seq ?? 'unwitnessed'}</td>
                    <td>
                      {c.statement_hash_ok
                        ? <span className="qx-pill qx-pill--xs qx-pill--success">ok</span>
                        : <span className="qx-pill qx-pill--xs qx-pill--danger">mismatch</span>}
                    </td>
                    <td>
                      {c.root_hash_ok
                        ? <span className="qx-pill qx-pill--xs qx-pill--success">ok</span>
                        : <span className="qx-pill qx-pill--xs qx-pill--danger">mismatch</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!state.loading && !state.error && !state.data && (
        <div className="qx-empty">
          <span className="qx-empty__icon"><ShieldCheckIcon size={26} /></span>
          <span className="qx-empty__title">No verification run yet</span>
          <span className="qx-empty__body">Click verify chain to recompute every crawl's hashes and signatures now.</span>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ shell */

/** Strips the scheme off an origin for display: "https://quox.ai" -> "quox.ai". */
function displayOrigin(origin) {
  return String(origin || '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/$/, '');
}

function PropertySwitcher({ properties, selectedSiteId, onSelect }) {
  if (!properties || properties.length === 0) return null;

  if (properties.length === 1) {
    return (
      <span className="qx-row qx-row--tight" style={{ alignItems: 'center' }} title="Property">
        <GlobeIcon />
        <span className="qx-pill qx-pill--xs qx-pill--ghost">{displayOrigin(properties[0].origin)}</span>
      </span>
    );
  }

  return (
    <span className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
      <GlobeIcon />
      <select
        className="qx-select qx-select--auto"
        aria-label="Property"
        value={selectedSiteId ?? ''}
        onChange={(e) => onSelect(e.target.value)}
      >
        {properties.map((p) => (
          <option key={p.id} value={p.id}>{displayOrigin(p.origin)}</option>
        ))}
      </select>
    </span>
  );
}

function CommandStrip({ tab, onTabChange, health, properties, selectedSiteId, onSelectSite }) {
  const dotClass = health.ok === null ? 'qx-dot--idle' : health.ok ? 'qx-dot--online' : 'qx-dot--offline';
  const pillClass = health.ok === null ? 'qx-pill--ghost' : health.ok ? 'qx-pill--online' : 'qx-pill--offline';
  const pillText = health.ok === null ? 'checking…' : health.ok ? 'server ok' : 'server unreachable';

  return (
    <div className="qx-card qx-card--bar qx-row qx-row--apart">
      <div className="qx-row qx-row--tight" style={{ alignItems: 'center' }}>
        <strong>QuoxSEO</strong>
        <span className={`qx-dot ${dotClass}`} aria-hidden="true" />
        <span className={`qx-pill ${pillClass} qx-pill--xs`}>{pillText}</span>
        <span className="qx-hint qx-hint--sm" title="What this surface is for">
          SEO intelligence with a witnessed history: every crawl is hashed, signed, and verifiable.
        </span>
        <PropertySwitcher properties={properties} selectedSiteId={selectedSiteId} onSelect={onSelectSite} />
      </div>
      <div className="qx-tabs" role="tablist" aria-label="QuoxSEO tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`qx-tab${tab === t.key ? ' qx-tab--active' : ''}`}
            onClick={() => onTabChange(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function QuoxSEOView() {
  // Same gating mechanism as QuoxSignalView: isPluginLicensed reads the server-fetched
  // entitlement cache. useTabData's onEntitlementLocked callback is the second layer: if a
  // tab's own fetch comes back with the collector's 403 gate (stale client cache, or an org
  // whose entitlement was revoked mid-session), the view still lands on the sales surface
  // instead of a raw error banner.
  const diag = usePluginLicenseDiagnosis('quoxseo');
  const licensed = diag.licensed;
  const [tab, setTab] = useState(readTabFromUrl);
  // Keep the URL in step with the active tab (replaceState: no history spam),
  // and follow browser back/forward so a deep-linked tab survives navigation.
  useEffect(() => {
    try {
      const u = new URL(window.location.href);
      if (u.searchParams.get('tab') !== tab) {
        u.searchParams.set('tab', tab);
        window.history.replaceState(window.history.state, '', u);
      }
    } catch { /* URL API unavailable — deep-linking simply no-ops */ }
  }, [tab]);
  useEffect(() => {
    const onPop = () => setTab(readTabFromUrl());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const [locked, setLocked] = useState(false);
  const [health, setHealth] = useState({ ok: null });
  const [seerCollapsed, setSeerCollapsed] = useState(false);
  const [properties, setProperties] = useState([]);
  const [selectedSiteId, setSelectedSiteId] = useState(null);
  // null = not checked yet (banner stays hidden rather than flashing on), true/false once
  // the settings read resolves. A failed read (e.g. the entitlement gate) leaves it null,
  // so the banner never shows on an error, only on a confirmed "not configured" read.
  const [dataforseoConfigured, setDataforseoConfigured] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.getSettings()
      .then((data) => {
        if (cancelled) return;
        setDataforseoConfigured(Boolean(data?.settings?.dataforseo_credential_id?.value));
      })
      .catch(() => {
        // Non-fatal: banner stays hidden rather than guessing at activation state.
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.health()
      .then(() => { if (!cancelled) setHealth({ ok: true }); })
      .catch(() => { if (!cancelled) setHealth({ ok: false }); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.getProperties()
      .then((data) => {
        if (cancelled) return;
        const list = data?.properties || [];
        setProperties(list);
        setSelectedSiteId((current) => current ?? (list[0]?.id ?? null));
      })
      .catch(() => {
        // Non-fatal: no switcher renders, tab loaders fall back to the server's
        // default-property behaviour (siteId undefined = org's first property).
      });
    return () => { cancelled = true; };
  }, []);

  const onEntitlementLocked = useCallback(() => setLocked(true), []);

  if (!licensed || locked) {
    return <PluginLicenseNotice diag={diag} displayName="QuoxSEO" accentColor="#22d3ee" />;
  }

  return (
    <div className="qx-view">
      <CommandStrip
        tab={tab}
        onTabChange={setTab}
        health={health}
        properties={properties}
        selectedSiteId={selectedSiteId}
        onSelectSite={setSelectedSiteId}
      />
      <div className="qx-row" style={{ flex: 1, minHeight: 0, alignItems: 'stretch', gap: 16 }}>
        <div className="quoxseo-view__body" style={{ flex: 1, minWidth: 0 }}>
          {tab === 'overview' && <OverviewTab siteId={selectedSiteId} onEntitlementLocked={onEntitlementLocked} dataforseoConfigured={dataforseoConfigured} />}
          {tab === 'opportunities' && <OpportunitiesTab siteId={selectedSiteId} onEntitlementLocked={onEntitlementLocked} />}
          {tab === 'keywords' && <KeywordsTab siteId={selectedSiteId} onEntitlementLocked={onEntitlementLocked} dataforseoConfigured={dataforseoConfigured} />}
          {tab === 'kwmanager' && <KeywordManagerTab siteId={selectedSiteId} onEntitlementLocked={onEntitlementLocked} dataforseoConfigured={dataforseoConfigured} />}
          {tab === 'audit' && <AuditTab siteId={selectedSiteId} onEntitlementLocked={onEntitlementLocked} />}
          {tab === 'urls' && <UrlWarehouseTab siteId={selectedSiteId} onEntitlementLocked={onEntitlementLocked} />}
          {tab === 'changes' && <ChangesTab siteId={selectedSiteId} onEntitlementLocked={onEntitlementLocked} />}
          {tab === 'evidence' && <EvidenceTab siteId={selectedSiteId} onEntitlementLocked={onEntitlementLocked} />}
        </div>
        <div style={{ width: seerCollapsed ? 48 : 320, flexShrink: 0 }}>
          <SeerChatSidebar
            tab={tab}
            collapsed={seerCollapsed}
            onToggle={() => setSeerCollapsed((v) => !v)}
          />
        </div>
      </div>
    </div>
  );
}
