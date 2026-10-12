/**
 * EvidenceView - QuoxFlow Evidence Browser
 *
 * Browse, search, and inspect evidence records attached to
 * workflow executions. Supports:
 * - Filterable evidence list (correlation, workflow, type, date range)
 * - Correlation ID search (enter + press Enter)
 * - Detail panel with full metadata + JSON content viewer
 * - Loading, error, and empty states
 *
 * Route: /evidence
 */

import { useState, useEffect, useCallback } from 'react';
import { listEvidence, getEvidence, getEvidenceByCorrelation } from '../../services/quoxflowClient';
import GovernancePageLayout from '../../components/compliance/GovernancePageLayout';
import { COLORS, GlassPanel, GlassButton, M } from '../../components/compliance/glass-primitives';
import PluginLicenseNotice from '../../components/plugins/PluginLicenseNotice';
import { usePluginLicenseDiagnosis } from '../../hooks/usePluginLicensed';
import './views.css';

const glassInputStyle = {
    fontFamily: M, fontSize: 11, color: '#fff',
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: 8, padding: '6px 10px', outline: 'none',
};

const GRID = '130px 160px 100px 100px 140px 1fr';

// ---------------------------------------------------------------------------
// Inline SVG icons
// ---------------------------------------------------------------------------

const SearchIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
);

const FilterIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
        <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    </svg>
);

const CloseIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
);

const ChevronLeftIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="15 18 9 12 15 6" />
    </svg>
);

const ChevronRightIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="9 18 15 12 9 6" />
    </svg>
);

const FileIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
    </svg>
);

const RefreshIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="23 4 23 10 17 10" />
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
);

// ---------------------------------------------------------------------------
// Evidence type badge colours
// ---------------------------------------------------------------------------

const TYPE_COLORS = {
    execution_result: { bg: 'rgba(52, 211, 153, 0.15)', fg: '#34d399' },
    approval_request: { bg: 'rgba(251, 191, 36, 0.15)', fg: '#fbbf24' },
    approval_decision: { bg: 'rgba(56, 189, 248, 0.15)', fg: '#38bdf8' },
    policy_evaluation: { bg: 'rgba(167, 139, 250, 0.15)', fg: '#a78bfa' },
    node_output: { bg: 'rgba(99, 102, 241, 0.15)', fg: '#6366f1' },
    error: { bg: 'rgba(239, 68, 68, 0.15)', fg: '#ef4444' },
    audit_trail: { bg: 'rgba(6, 182, 212, 0.15)', fg: '#06b6d4' },
};

function getTypeColor(type) {
    return TYPE_COLORS[type] || { bg: 'rgba(100, 116, 139, 0.15)', fg: '#64748b' };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateId(id, len = 12) {
    if (!id) return '--';
    return id.length > len ? id.slice(0, len) + '...' : id;
}

function formatTimestamp(ts) {
    if (!ts) return '--';
    const date = new Date(ts);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString('en-AU', {
        day: 'numeric',
        month: 'short',
        year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
        hour: '2-digit',
        minute: '2-digit',
    });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function EvidenceView() {
    const diag = usePluginLicenseDiagnosis('aocl-compliance-suite');
    const licensed = diag.licensed;

    // List state
    const [records, setRecords] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(0);
    const PAGE_SIZE = 25;

    // Detail panel
    const [selected, setSelected] = useState(null);
    const [detailLoading, setDetailLoading] = useState(false);
    const [detailError, setDetailError] = useState(null);

    // Correlation search
    const [corrSearch, setCorrSearch] = useState('');
    const [corrMode, setCorrMode] = useState(false); // true when showing correlation results

    // Filters
    const [showFilters, setShowFilters] = useState(false);
    const [filters, setFilters] = useState({
        correlationId: '',
        workflowId: '',
        type: '',
        since: '',
        until: '',
    });

    // ------------------------------------------------------------------
    // Data fetching
    // ------------------------------------------------------------------

    const fetchList = useCallback(async (pageNum) => {
        setLoading(true);
        setError(null);
        setCorrMode(false);
        try {
            const opts = {
                limit: PAGE_SIZE,
                offset: pageNum * PAGE_SIZE,
            };
            if (filters.correlationId) opts.corr = filters.correlationId;
            if (filters.workflowId) opts.workflowId = filters.workflowId;
            if (filters.type) opts.type = filters.type;
            if (filters.since) opts.since = new Date(filters.since).toISOString();
            if (filters.until) opts.until = new Date(filters.until).toISOString();

            const result = await listEvidence(opts);
            const items = Array.isArray(result) ? result : (result?.data || result?.evidence || []);
            setRecords(items);
            setTotal(result?.total ?? items.length);
        } catch (err) {
            console.error('Failed to load evidence:', err);
            setError(err.message || 'Failed to load evidence records');
            setRecords([]);
        } finally {
            setLoading(false);
        }
    }, [filters]);

    const fetchByCorrelation = useCallback(async (corrId) => {
        if (!corrId.trim()) return;
        setLoading(true);
        setError(null);
        setCorrMode(true);
        setSelected(null);
        try {
            const result = await getEvidenceByCorrelation(corrId.trim());
            const items = Array.isArray(result) ? result : (result?.data || result?.evidence || []);
            setRecords(items);
            setTotal(items.length);
            setPage(0);
        } catch (err) {
            console.error('Failed to fetch evidence by correlation:', err);
            setError(err.message || 'Failed to fetch evidence by correlation ID');
            setRecords([]);
        } finally {
            setLoading(false);
        }
    }, []);

    // Initial load
    useEffect(() => {
        fetchList(page);
    }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

    // ------------------------------------------------------------------
    // Detail panel
    // ------------------------------------------------------------------

    const openDetail = async (record) => {
        setSelected(record);
        setDetailLoading(true);
        setDetailError(null);
        try {
            const full = await getEvidence(record.id);
            setSelected(full);
        } catch (err) {
            console.error('Failed to load evidence detail:', err);
            setDetailError(err.message || 'Failed to load evidence detail');
        } finally {
            setDetailLoading(false);
        }
    };

    const closeDetail = () => {
        setSelected(null);
        setDetailError(null);
    };

    // ------------------------------------------------------------------
    // Filter handlers
    // ------------------------------------------------------------------

    const handleFilterChange = (key, value) => {
        setFilters((prev) => ({ ...prev, [key]: value }));
    };

    const applyFilters = () => {
        setPage(0);
        fetchList(0);
    };

    const clearFilters = () => {
        const cleared = { correlationId: '', workflowId: '', type: '', since: '', until: '' };
        setFilters(cleared);
        setPage(0);
        setCorrSearch('');
        setCorrMode(false);
        // fetch with empty filters after state settles
        setTimeout(() => fetchList(0), 0);
    };

    const handleCorrSearchKeyDown = (e) => {
        if (e.key === 'Enter') {
            fetchByCorrelation(corrSearch);
        }
    };

    // ------------------------------------------------------------------
    // Pagination
    // ------------------------------------------------------------------

    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const canPrev = page > 0 && !corrMode;
    const canNext = page < totalPages - 1 && !corrMode;

    const handlePrev = () => {
        if (canPrev) setPage((p) => p - 1);
    };
    const handleNext = () => {
        if (canNext) setPage((p) => p + 1);
    };

    const handleRefresh = () => {
        if (corrMode && corrSearch) {
            fetchByCorrelation(corrSearch);
        } else {
            fetchList(page);
        }
    };

    const hasActiveFilters = Object.values(filters).some((v) => v);

    // ------------------------------------------------------------------
    // Render
    // ------------------------------------------------------------------

    const labelStyle = {
        fontFamily: M, fontSize: 9, fontWeight: 600, letterSpacing: 0.8,
        color: COLORS.dimText, textTransform: 'uppercase',
    };

    if (!licensed) {
        return <PluginLicenseNotice diag={diag} displayName="Evidence" accentColor="#a855f7" />;
    }

    return (
        <GovernancePageLayout
            title="QuoxFlow Evidence Browser"
            subtitle="Workflow execution evidence · Correlation search · Detail inspection"
            crumbs={[{ label: 'Compliance', to: '/compliance' }, { label: 'Evidence' }]}
        >
        <div className="evidence-view view-page" style={{ padding: '12px 16px' }}>
            {/* Correlation ID search bar — GLV-6 */}
            <div style={{
                display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12,
            }}>
                <div style={{ position: 'relative', flex: 1 }}>
                    <span style={{
                        position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
                        color: COLORS.dimText, display: 'flex', pointerEvents: 'none',
                    }}>
                        <SearchIcon />
                    </span>
                    <input
                        type="text"
                        style={{
                            ...glassInputStyle, width: '100%',
                            paddingLeft: 34, paddingRight: corrMode ? 34 : 10,
                        }}
                        placeholder="Search by Correlation ID — press Enter"
                        value={corrSearch}
                        onChange={(e) => setCorrSearch(e.target.value)}
                        onKeyDown={handleCorrSearchKeyDown}
                    />
                    {corrMode && (
                        <button
                            onClick={clearFilters}
                            title="Clear correlation search"
                            style={{
                                position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
                                background: 'transparent', border: 'none', padding: 4,
                                color: COLORS.dimText, cursor: 'pointer', display: 'flex',
                            }}
                        >
                            <CloseIcon />
                        </button>
                    )}
                </div>
                <GlassButton
                    variant={showFilters || hasActiveFilters ? 'primary' : 'default'}
                    onClick={() => setShowFilters(!showFilters)}
                >
                    <FilterIcon />
                    Filters
                    {hasActiveFilters && (
                        <span style={{
                            padding: '1px 6px', borderRadius: 10,
                            background: 'rgba(168,85,247,0.25)',
                            fontFamily: M, fontSize: 9, fontWeight: 700,
                        }}>Active</span>
                    )}
                </GlassButton>
                <GlassButton size="sm" onClick={handleRefresh} title="Refresh">
                    <RefreshIcon />
                </GlassButton>
            </div>

            {/* Correlation mode indicator */}
            {corrMode && (
                <GlassPanel highlight={COLORS.cyan} style={{ padding: '8px 14px', marginBottom: 12 }}>
                    <div style={{
                        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                        fontFamily: M, fontSize: 11, color: '#fff',
                    }}>
                        <span style={{ ...labelStyle, color: COLORS.cyan }}>Correlation</span>
                        <code style={{
                            fontFamily: M, fontSize: 11, color: '#fff',
                            background: 'rgba(6,182,212,0.08)', padding: '2px 8px', borderRadius: 4,
                        }}>{corrSearch}</code>
                        <GlassButton size="sm" onClick={clearFilters} style={{ marginLeft: 'auto' }}>
                            Clear
                        </GlassButton>
                    </div>
                </GlassPanel>
            )}

            {/* Filters panel — GLV-6 */}
            {showFilters && (
                <GlassPanel style={{ padding: 14, marginBottom: 12 }}>
                    <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                        gap: 12,
                    }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <label style={labelStyle}>Correlation ID</label>
                            <input
                                type="text" style={glassInputStyle}
                                value={filters.correlationId}
                                onChange={(e) => handleFilterChange('correlationId', e.target.value)}
                                placeholder="corr_01..."
                            />
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <label style={labelStyle}>Workflow ID</label>
                            <input
                                type="text" style={glassInputStyle}
                                value={filters.workflowId}
                                onChange={(e) => handleFilterChange('workflowId', e.target.value)}
                                placeholder="wf_01..."
                            />
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <label style={labelStyle}>Type</label>
                            <select
                                style={{ ...glassInputStyle, cursor: 'pointer' }}
                                value={filters.type}
                                onChange={(e) => handleFilterChange('type', e.target.value)}
                            >
                                <option value="" style={{ background: '#1a1a2e' }}>All types</option>
                                <option value="execution_result" style={{ background: '#1a1a2e' }}>execution_result</option>
                                <option value="approval_request" style={{ background: '#1a1a2e' }}>approval_request</option>
                                <option value="approval_decision" style={{ background: '#1a1a2e' }}>approval_decision</option>
                                <option value="policy_evaluation" style={{ background: '#1a1a2e' }}>policy_evaluation</option>
                                <option value="node_output" style={{ background: '#1a1a2e' }}>node_output</option>
                                <option value="error" style={{ background: '#1a1a2e' }}>error</option>
                                <option value="audit_trail" style={{ background: '#1a1a2e' }}>audit_trail</option>
                            </select>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <label style={labelStyle}>Since</label>
                            <input
                                type="datetime-local" style={{ ...glassInputStyle, colorScheme: 'dark' }}
                                value={filters.since}
                                onChange={(e) => handleFilterChange('since', e.target.value)}
                            />
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <label style={labelStyle}>Until</label>
                            <input
                                type="datetime-local" style={{ ...glassInputStyle, colorScheme: 'dark' }}
                                value={filters.until}
                                onChange={(e) => handleFilterChange('until', e.target.value)}
                            />
                        </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
                        {hasActiveFilters && (
                            <GlassButton onClick={clearFilters}>Clear All</GlassButton>
                        )}
                        <GlassButton variant="primary" onClick={applyFilters}>
                            Apply Filters
                        </GlassButton>
                    </div>
                </GlassPanel>
            )}

            {/* Main content: list + detail split — GLV-6 */}
            <div style={{
                display: 'grid',
                gridTemplateColumns: selected ? 'minmax(0,1fr) minmax(420px, 42%)' : '1fr',
                gap: 12, minHeight: 400,
            }}>
                {/* Evidence list */}
                <div style={{ minWidth: 0 }}>
                    {loading ? (
                        <GlassPanel style={{ padding: 32, textAlign: 'center' }}>
                            <div className="evidence-spinner" style={{ margin: '0 auto 10px' }} />
                            <div style={{ fontFamily: M, fontSize: 11, color: COLORS.dimText }}>
                                Loading evidence records…
                            </div>
                        </GlassPanel>
                    ) : error ? (
                        <GlassPanel highlight={COLORS.red} style={{ padding: 20, textAlign: 'center' }}>
                            <div style={{ fontFamily: M, fontSize: 12, color: COLORS.red, fontWeight: 700, marginBottom: 6 }}>
                                Error
                            </div>
                            <div style={{ fontFamily: M, fontSize: 11, color: COLORS.dimText, marginBottom: 12 }}>
                                {error}
                            </div>
                            <GlassButton variant="danger" onClick={handleRefresh}>Retry</GlassButton>
                        </GlassPanel>
                    ) : records.length === 0 ? (
                        <GlassPanel style={{ padding: 36, textAlign: 'center' }}>
                            <div style={{ color: 'rgba(255,255,255,0.25)', display: 'flex', justifyContent: 'center', marginBottom: 10 }}>
                                <FileIcon />
                            </div>
                            <div style={{ fontFamily: M, fontSize: 12, color: COLORS.dimText }}>
                                {hasActiveFilters || corrMode ? 'No evidence matches your search' : 'No evidence records found'}
                            </div>
                        </GlassPanel>
                    ) : (
                        <GlassPanel style={{ padding: 0, overflow: 'hidden' }}>
                            {/* Header */}
                            <div style={{
                                display: 'grid', gridTemplateColumns: GRID, gap: 10,
                                padding: '10px 14px',
                                borderBottom: '1px solid rgba(255,255,255,0.06)',
                                background: 'rgba(255,255,255,0.02)',
                            }}>
                                {['ID', 'Type', 'Workflow', 'Execution', 'Correlation', 'Timestamp'].map(h => (
                                    <div key={h} style={{
                                        fontFamily: M, fontSize: 9, fontWeight: 700, letterSpacing: 1,
                                        color: COLORS.dimText, textTransform: 'uppercase',
                                    }}>{h}</div>
                                ))}
                            </div>

                            {/* Rows */}
                            <div style={{ maxHeight: 520, overflowY: 'auto' }}>
                                {records.map((rec, i) => {
                                    const typeColor = getTypeColor(rec.type);
                                    const isActive = selected?.id === rec.id;
                                    return (
                                        <div
                                            key={rec.id}
                                            onClick={() => openDetail(rec)}
                                            style={{
                                                display: 'grid', gridTemplateColumns: GRID, gap: 10,
                                                padding: '8px 14px',
                                                borderBottom: '1px solid rgba(255,255,255,0.04)',
                                                background: isActive
                                                    ? `linear-gradient(145deg, ${typeColor.fg}18 0%, ${typeColor.fg}06 100%)`
                                                    : i % 2 ? 'rgba(255,255,255,0.015)' : 'transparent',
                                                borderLeft: isActive
                                                    ? `2px solid ${typeColor.fg}`
                                                    : '2px solid transparent',
                                                cursor: 'pointer', alignItems: 'center',
                                                transition: 'all 0.15s',
                                            }}
                                        >
                                            <code style={{
                                                fontFamily: M, fontSize: 10, color: '#fff',
                                                fontVariantNumeric: 'tabular-nums',
                                            }}>{truncateId(rec.id)}</code>
                                            <span style={{
                                                fontFamily: M, fontSize: 9, fontWeight: 600,
                                                padding: '2px 8px', borderRadius: 4,
                                                background: typeColor.bg, color: typeColor.fg,
                                                display: 'inline-block', maxWidth: '100%',
                                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                            }}>
                                                {rec.type || 'unknown'}
                                            </span>
                                            <code style={{ fontFamily: M, fontSize: 10, color: COLORS.dimText }}>
                                                {truncateId(rec.workflowId, 10)}
                                            </code>
                                            <code style={{ fontFamily: M, fontSize: 10, color: COLORS.dimText }}>
                                                {truncateId(rec.executionId, 10)}
                                            </code>
                                            <code style={{ fontFamily: M, fontSize: 10, color: COLORS.dimText }}>
                                                {truncateId(rec.correlationId, 14)}
                                            </code>
                                            <span style={{ fontFamily: M, fontSize: 10, color: COLORS.dimText }}>
                                                {formatTimestamp(rec.createdAt || rec.metadata?.timestamp)}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>

                            {/* Pagination */}
                            {!corrMode && (
                                <div style={{
                                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                    padding: '10px 14px',
                                    borderTop: '1px solid rgba(255,255,255,0.06)',
                                    background: 'rgba(255,255,255,0.02)',
                                    fontFamily: M, fontSize: 10, color: COLORS.dimText,
                                }}>
                                    <span>
                                        {total > 0
                                            ? `Showing ${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} of ${total}`
                                            : 'No records'}
                                    </span>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <GlassButton size="sm" disabled={!canPrev} onClick={handlePrev} title="Previous page">
                                            <ChevronLeftIcon />
                                        </GlassButton>
                                        <span style={{ padding: '0 8px', fontVariantNumeric: 'tabular-nums' }}>
                                            Page {page + 1} of {totalPages}
                                        </span>
                                        <GlassButton size="sm" disabled={!canNext} onClick={handleNext} title="Next page">
                                            <ChevronRightIcon />
                                        </GlassButton>
                                    </div>
                                </div>
                            )}
                        </GlassPanel>
                    )}
                </div>

                {/* Detail panel — GLV-6 */}
                {selected && (
                    <GlassPanel
                        highlight={getTypeColor(selected.type).fg}
                        style={{ padding: 0, overflow: 'hidden', alignSelf: 'start', position: 'sticky', top: 8 }}
                    >
                        <div style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                            padding: '12px 16px',
                            borderBottom: '1px solid rgba(255,255,255,0.06)',
                            background: 'linear-gradient(145deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0.005) 100%)',
                        }}>
                            <h3 style={{
                                fontFamily: M, fontSize: 12, fontWeight: 700, color: '#fff',
                                letterSpacing: 0.8, textTransform: 'uppercase', margin: 0,
                            }}>Evidence Detail</h3>
                            <GlassButton size="sm" onClick={closeDetail} title="Close evidence detail">
                                <CloseIcon />
                            </GlassButton>
                        </div>

                        {detailLoading ? (
                            <div style={{ padding: 32, textAlign: 'center' }}>
                                <div className="evidence-spinner" style={{ margin: '0 auto 10px' }} />
                                <div style={{ fontFamily: M, fontSize: 11, color: COLORS.dimText }}>
                                    Loading detail…
                                </div>
                            </div>
                        ) : detailError ? (
                            <div style={{ padding: 20 }}>
                                <div style={{ fontFamily: M, fontSize: 12, color: COLORS.red, fontWeight: 700, marginBottom: 6 }}>
                                    Error
                                </div>
                                <div style={{ fontFamily: M, fontSize: 11, color: COLORS.dimText }}>{detailError}</div>
                            </div>
                        ) : (
                            <div style={{
                                padding: 16, maxHeight: 600, overflowY: 'auto',
                                display: 'flex', flexDirection: 'column', gap: 14,
                            }}>
                                {/* Metadata grid */}
                                <div style={{
                                    display: 'grid',
                                    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                                    gap: '10px 16px',
                                }}>
                                    {[
                                        { label: 'ID',             value: selected.id, mono: true },
                                        { label: 'Type',           value: (
                                            <span style={{
                                                fontFamily: M, fontSize: 9, fontWeight: 600,
                                                padding: '2px 8px', borderRadius: 4,
                                                background: getTypeColor(selected.type).bg,
                                                color: getTypeColor(selected.type).fg,
                                            }}>{selected.type}</span>
                                        )},
                                        { label: 'Envelope ID',    value: selected.envelopeId || '—', mono: true },
                                        { label: 'Execution ID',   value: selected.executionId || '—', mono: true },
                                        { label: 'Workflow ID',    value: selected.workflowId || '—', mono: true },
                                        { label: 'Correlation ID', value: selected.correlationId || '—', mono: true },
                                        { label: 'Created',        value: selected.createdAt ? new Date(selected.createdAt).toLocaleString() : '—' },
                                    ].map((item, i) => (
                                        <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                                            <span style={labelStyle}>{item.label}</span>
                                            <span style={{
                                                fontFamily: M, fontSize: 11, color: '#fff',
                                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                            }}>{item.value}</span>
                                        </div>
                                    ))}
                                </div>

                                {/* Metadata object */}
                                {selected.metadata && Object.keys(selected.metadata).length > 0 && (
                                    <div>
                                        <div style={{ ...labelStyle, marginBottom: 6 }}>Metadata</div>
                                        <pre style={{
                                            fontFamily: M, fontSize: 10, color: '#fff',
                                            background: 'rgba(0,0,0,0.3)', padding: 10, borderRadius: 6,
                                            margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                                            maxHeight: 260, overflowY: 'auto',
                                        }}>
                                            {JSON.stringify(selected.metadata, null, 2)}
                                        </pre>
                                    </div>
                                )}

                                {/* Content */}
                                {selected.content && (
                                    <div>
                                        <div style={{ ...labelStyle, marginBottom: 6 }}>Content</div>
                                        <pre style={{
                                            fontFamily: M, fontSize: 10, color: '#fff',
                                            background: 'rgba(0,0,0,0.3)', padding: 10, borderRadius: 6,
                                            margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                                            maxHeight: 320, overflowY: 'auto',
                                        }}>
                                            {typeof selected.content === 'string'
                                                ? selected.content
                                                : JSON.stringify(selected.content, null, 2)}
                                        </pre>
                                    </div>
                                )}
                            </div>
                        )}
                    </GlassPanel>
                )}
            </div>
        </div>
        </GovernancePageLayout>
    );
}

export default EvidenceView;
