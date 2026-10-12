/**
 * ToolDetailView — STUDY-REV-2/P1.A-rebuild
 *
 * Full-page replacement for ToolDetailModal / CoreToolDetailModal / PluginToolDetailModal.
 * Route: /tools/:id
 *
 * Panel A: header (.qx-card.qx-card--bar) — back link, tool name, badges
 * Panel B: meta + actions (.qx-card) — description, properties, action buttons
 * Panel B.5: README (.qx-card.tool-readme) — fetched from GitHub raw
 * Panel C: input_schema (.qx-card) — parsed schema as code block
 *
 * The three old inline modal components remain in ToolsView.jsx as fallback
 * for any core/plugin tool "View Details" clicks (they open modals locally).
 * This page handles catalog tool click-through from card navigation.
 *
 * Tool data is sourced from the auth service catalog API:
 *   GET /api/catalog?limit=500&status=available  (list, match by id)
 *   or GET /collector/api/v1/tools/list?agent_id=all (core/plugin)
 */

import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import MarkdownContent from '../../components/ui/MarkdownContent';
import { QuartermasterSidebar } from '../../components/quartermaster/QuartermasterSidebar';
import { isDeployable, ctaCopyFor } from '../../lib/catalogExecutorTypes';
import { prettifySourceList } from '../../components/tools/ToolCard';
import { archiveRepoDeploy, restoreRepoDeploy, destroyRepoDeploy, patchRepoDeployConfig } from '../../services/powersClient';

// ── README helpers ────────────────────────────────────────────────────────────

const README_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Parse owner/repo from a GitHub URL.
 * Handles: github.com/owner/repo, github.com/owner/repo/tree/main/subdir, etc.
 * Returns null for non-github URLs.
 */
function parseGithubOwnerRepo(url) {
    if (!url) return null;
    try {
        const u = new URL(url.startsWith('http') ? url : `https://${url}`);
        if (!u.hostname.includes('github.com')) return null;
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts.length < 2) return null;
        return { owner: parts[0], repo: parts[1] };
    } catch {
        return null;
    }
}

/**
 * Fetch README from raw.githubusercontent.com, trying HEAD → main → master.
 * Returns { content: string } on success or throws.
 */
async function fetchGithubReadme(owner, repo) {
    const branches = ['HEAD', 'main', 'master'];
    for (const branch of branches) {
        const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/README.md`;
        const resp = await fetch(url);
        if (resp.ok) {
            const content = await resp.text();
            return content;
        }
    }
    return null; // all branches 404
}

/**
 * Read from localStorage cache. Returns cached content string or null.
 */
function readReadmeCache(toolId) {
    try {
        const raw = localStorage.getItem(`tool-readme:${toolId}`);
        if (!raw) return null;
        const entry = JSON.parse(raw);
        if (Date.now() - entry.fetchedAt > README_CACHE_TTL_MS) return null;
        return entry.content; // may be empty string (meaning: not found)
    } catch {
        return null;
    }
}

/**
 * Write to localStorage cache.
 */
function writeReadmeCache(toolId, content, ref) {
    try {
        localStorage.setItem(`tool-readme:${toolId}`, JSON.stringify({
            content,
            fetchedAt: Date.now(),
            ref,
        }));
    } catch {
        // localStorage may be unavailable — ignore
    }
}

// ── AvailableToolsPanel (LIFECYCLE-P4-D4) ────────────────────────────────────

/**
 * Panel showing the MCP server's inner tools (available_tools[]).
 * Sorted: active tools first, deprecated last.
 * Click on tool name copies the LLM-emitted alias to clipboard.
 * Exported for testing.
 */
export function AvailableToolsPanel({ toolId, availableTools }) {
    if (!Array.isArray(availableTools) || availableTools.length === 0) return null;

    // Sort: non-deprecated first, deprecated last
    const sorted = [...availableTools].sort((a, b) => {
        const aDepr = !!a.deprecated_at;
        const bDepr = !!b.deprecated_at;
        if (aDepr === bDepr) return 0;
        return aDepr ? 1 : -1;
    });

    function copyAlias(innerName) {
        // Build the LLM-emitted alias: canonical tool_id with dots→underscores + _ + innerName
        const canonicalBase = (toolId || '').replace(/\./g, '_');
        const alias = canonicalBase ? `${canonicalBase}_${innerName}` : innerName;
        try {
            navigator.clipboard.writeText(alias);
        } catch (_) {
            // Clipboard unavailable — silently ignore
        }
    }

    return (
        <section className="qx-card" data-testid="available-tools-panel" style={{ minHeight: 0 }}>
            <h3 style={{
                margin: '0 0 10px',
                fontSize: 12,
                fontWeight: 600,
                color: 'rgba(255,255,255,0.5)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
            }}>
                Inner Tools ({availableTools.length})
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {sorted.map((t) => (
                    <div
                        key={t.name}
                        data-testid={`inner-tool-row-${t.name}`}
                        style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: 8,
                            padding: '5px 0',
                            borderBottom: '1px solid rgba(255,255,255,0.04)',
                            opacity: t.deprecated_at ? 0.5 : 1,
                        }}
                    >
                        {/* Clickable name copies alias */}
                        <button
                            title="Click to copy LLM alias to clipboard"
                            style={{
                                background: 'transparent',
                                border: 'none',
                                padding: 0,
                                cursor: 'pointer',
                                fontFamily: 'monospace',
                                fontSize: 12,
                                color: 'var(--accent-cyan, #22d3ee)',
                                flexShrink: 0,
                                textAlign: 'left',
                            }}
                            onClick={() => copyAlias(t.name)}
                        >
                            {t.name}
                        </button>
                        {t.deprecated_at && (
                            <span
                                data-testid={`deprecated-badge-${t.name}`}
                                style={{
                                    fontSize: 10,
                                    fontWeight: 600,
                                    background: 'rgba(239,68,68,0.15)',
                                    color: '#f87171',
                                    border: '1px solid rgba(239,68,68,0.3)',
                                    borderRadius: 3,
                                    padding: '1px 5px',
                                    flexShrink: 0,
                                    alignSelf: 'center',
                                    textTransform: 'uppercase',
                                }}
                            >
                                DEPRECATED
                            </span>
                        )}
                        {t.description && (
                            <span style={{
                                fontSize: 12,
                                color: 'rgba(255,255,255,0.55)',
                                lineHeight: 1.4,
                            }}>
                                {t.description.length > 120 ? t.description.slice(0, 120) + '…' : t.description}
                            </span>
                        )}
                    </div>
                ))}
            </div>
        </section>
    );
}

// ── ToolReadmePanel ───────────────────────────────────────────────────────────

/**
 * Panel B.5 — README (between meta+actions and input_schema)
 * Fetches and renders the README for a tool whose reference URL points to GitHub.
 * Exported for testing.
 */
export function ToolReadmePanel({ tool, onReadmeLoaded }) {
    const [status, setStatus] = useState('loading'); // loading | found | not-found | non-github | error
    const [content, setContent] = useState('');

    useEffect(() => {
        if (!tool?.id) return;

        const gh = parseGithubOwnerRepo(tool.reference);

        if (!gh) {
            // Non-github reference
            setStatus('non-github');
            if (onReadmeLoaded) onReadmeLoaded(null);
            return;
        }

        // Check cache first
        const cached = readReadmeCache(tool.id);
        if (cached !== null) {
            if (cached === '') {
                setStatus('not-found');
                if (onReadmeLoaded) onReadmeLoaded(null);
            } else {
                setContent(cached);
                setStatus('found');
                if (onReadmeLoaded) onReadmeLoaded(cached);
            }
            return;
        }

        // Fetch from GitHub
        setStatus('loading');
        fetchGithubReadme(gh.owner, gh.repo)
            .then((text) => {
                if (text === null) {
                    writeReadmeCache(tool.id, '', tool.reference);
                    setStatus('not-found');
                    if (onReadmeLoaded) onReadmeLoaded(null);
                } else {
                    writeReadmeCache(tool.id, text, tool.reference);
                    setContent(text);
                    setStatus('found');
                    if (onReadmeLoaded) onReadmeLoaded(text);
                }
            })
            .catch(() => {
                setStatus('error');
                if (onReadmeLoaded) onReadmeLoaded(null);
            });
    }, [tool?.id, tool?.reference]); // eslint-disable-line react-hooks/exhaustive-deps

    const refLink = tool?.reference ? (
        <a href={tool.reference} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-cyan, #22d3ee)' }}>
            View source ↗
        </a>
    ) : null;

    return (
        <section className="qx-card tool-readme" aria-label="README pane">
            <h3 style={{
                margin: '0 0 12px',
                fontSize: 12,
                fontWeight: 600,
                color: 'rgba(255,255,255,0.5)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
            }}>
                README
            </h3>

            {status === 'loading' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'rgba(255,255,255,0.55)', fontSize: 13 }}>
                    <div className="qx-spinner qx-spinner--sm" />
                    Loading README...
                </div>
            )}

            {status === 'found' && (
                <div
                    className="tool-readme__body"
                    style={{ maxHeight: 600, overflowY: 'auto' }}
                >
                    <MarkdownContent>{content}</MarkdownContent>
                </div>
            )}

            {status === 'not-found' && (
                <p style={{ margin: 0, fontSize: 13, color: 'rgba(255,255,255,0.5)' }}>
                    No README available — {refLink}
                </p>
            )}

            {status === 'non-github' && (
                <p style={{ margin: 0, fontSize: 13, color: 'rgba(255,255,255,0.5)' }}>
                    README pane available for GitHub-hosted tools. {refLink}
                </p>
            )}

            {status === 'error' && (
                <p style={{ margin: 0, fontSize: 13, color: 'rgba(255,255,255,0.5)' }}>
                    Couldn't load README. {refLink}
                </p>
            )}
        </section>
    );
}

const RISK_COLORS = {
    low: '#22c55e',
    medium: '#eab308',
    high: '#f97316',
    critical: '#ef4444',
};

// Parent-category icons — matches PARENT_ICONS in ToolsView.jsx.
// Catalog densification grew the granular `category` field to 361 distinct values,
// so the hand-curated CATEGORY_ICONS map below covers only ~10% of catalog. Use
// parent_category (7 buckets, every tool has one) as the primary lookup; fall
// back to the granular CATEGORY_ICONS for legacy entries; fall back to package.
const PARENT_ICONS = {
    Connectors: '🔌',
    Development: '💻',
    Finance: '💰',
    Security: '🛡️',
    'Self-Hosted': '🏠',
    AI: '🤖',
    Productivity: '📋',
};

const CATEGORY_ICONS = {
    orchestration: '⚡', integration: '🔗', data: '🗄️', dev: '💻',
    infrastructure: '🔧', content: '📝', analytics: '📊', 'model-ops': '🧠',
    visualization: '📈', governance: '🛡️', media: '📸', video: '🎬',
    image: '🖼️', audio: '🎵', social: '📱', marketing: '📣',
    ecommerce: '🛒', legal: '⚖️', hr: '👥', finance: '💰',
    healthcare: '🏥', education: '📚', 'real-estate': '🏠', gaming: '🎮',
    iot: '📡', robotics: '🤖', research: '🔬', translation: '🌐',
    'customer-service': '💬', sales: '📈', 'project-management': '📋',
};

export default function ToolDetailView() {
    const { id } = useParams();
    const navigate = useNavigate();
    const { authFetch } = useAuth();
    const { currentOrg } = useWorkspace();

    const [tool, setTool] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [readmeContent, setReadmeContent] = useState(null);

    // D3/D4: POWERS lifecycle action state
    const [powersAction, setPowersAction] = useState(null); // null | 'archive' | 'destroy' | 'config'
    const [powersActionWorking, setPowersActionWorking] = useState(false);
    const [powersActionError, setPowersActionError] = useState(null);
    const [powersConfigName, setPowersConfigName] = useState('');
    const [powersConfigDesc, setPowersConfigDesc] = useState('');

    // LIFECYCLE-P4-D4: available_tools from catalog detail endpoint
    const [availableTools, setAvailableTools] = useState([]);

    useEffect(() => {
        async function fetchTool() {
            if (!id) return;
            setLoading(true);
            setError(null);
            try {
                // 1) Static catalog (the 365 curated tool entries with github references)
                const staticIndex = await import('../../config/tool-library-index.json');
                const staticTools = (staticIndex.default?.tools || staticIndex.default || staticIndex.tools || []);
                const fromStatic = staticTools.find(t =>
                    t.id === id || t.tool_id === id || t.name === id
                );
                if (fromStatic) {
                    setTool(fromStatic);
                    return;
                }

                // 2) Auth catalog API (the LIVE tools backed by tool_definitions)
                // First try the detail endpoint (includes available_tools + trust_tier)
                const detailResp = await authFetch(`/api/catalog/${encodeURIComponent(id)}`);
                if (detailResp.ok) {
                    const detailData = await detailResp.json();
                    if (detailData.tool) {
                        setTool(detailData.tool);
                        // LIFECYCLE-P4-D4: populate available_tools from catalog detail
                        if (Array.isArray(detailData.tool.available_tools)) {
                            setAvailableTools(detailData.tool.available_tools);
                        }
                        return;
                    }
                }
                // Fallback: list endpoint (no available_tools, covers status=beta too)
                const resp = await authFetch(`/api/catalog?limit=500&status=available`);
                if (resp.ok) {
                    const data = await resp.json();
                    const found = (data.items || []).find(t =>
                        t.id === id || t.tool_id === id || t.name === id
                    );
                    if (found) {
                        setTool(found);
                        return;
                    }
                }

                // 3) Collector list (native + user-installed openapi/mcp tools)
                const orgQ = currentOrg?.id ? `&org_id=${encodeURIComponent(currentOrg.id)}` : '';
                const collResp = await fetch(`/collector/api/v1/tools/list?agent_id=all&include_user=1${orgQ}`);
                if (collResp.ok) {
                    const collData = await collResp.json();
                    const found = (collData.tools || []).find(t =>
                        t.name === id || String(t.id) === id
                    );
                    if (found) {
                        setTool(found);
                        return;
                    }
                }

                setError('Tool not found');
            } catch (err) {
                setError(err.message);
            } finally {
                setLoading(false);
            }
        }
        fetchTool();
    }, [id, authFetch, currentOrg?.id]);

    if (loading) {
        return (
            <div className="qx-view" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <section className="qx-card qx-card--bar">
                    <div className="qx-row qx-row--apart">
                        <Link to="/tools" className="qx-btn qx-btn--ghost qx-btn--sm">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
                                <polyline points="15 18 9 12 15 6"/>
                            </svg>
                            Back
                        </Link>
                        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Loading...</h1>
                    </div>
                </section>
                <section className="qx-card" style={{ flex: 1, minHeight: 0 }}>
                    <div className="qx-spinner" />
                </section>
            </div>
        );
    }

    if (error || !tool) {
        return (
            <div className="qx-view" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <section className="qx-card qx-card--bar">
                    <div className="qx-row qx-row--apart">
                        <Link to="/tools" className="qx-btn qx-btn--ghost qx-btn--sm">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
                                <polyline points="15 18 9 12 15 6"/>
                            </svg>
                            Back
                        </Link>
                        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Tool Not Found</h1>
                    </div>
                </section>
                <section className="qx-card" style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div className="qx-empty">
                        <div className="qx-empty__title">{error || 'Tool not found'}</div>
                        <div className="qx-empty__body">The tool "{id}" could not be located in the catalog or collector.</div>
                        <Link to="/tools" className="qx-btn qx-btn--ghost">Browse Tools</Link>
                    </div>
                </section>
            </div>
        );
    }

    const icon = PARENT_ICONS[tool.parent_category] || CATEGORY_ICONS[tool.category] || '📦';
    const riskColor = RISK_COLORS[tool.risk_level] || '#6b7280';
    const schemaStr = tool.input_schema
        ? JSON.stringify(tool.input_schema, null, 2)
        : null;

    // D3/D4: Is this a POWERS-deployed tool?
    const isPowersDeploy = tool.provider === 'powers';
    const toolDefId = tool.id; // tool_definitions.id (ULID)
    const isArchived = tool.status === 'disabled';
    const orgId = currentOrg?.id;

    async function handlePowersArchive() {
        if (!orgId || !toolDefId) return;
        setPowersActionWorking(true);
        setPowersActionError(null);
        try {
            await archiveRepoDeploy(orgId, toolDefId);
            setPowersAction(null);
            // Reload tool to reflect new status
            window.location.reload();
        } catch (err) {
            setPowersActionError(err.message || 'Archive failed.');
        } finally {
            setPowersActionWorking(false);
        }
    }

    async function handlePowersRestore() {
        if (!orgId || !toolDefId) return;
        setPowersActionWorking(true);
        setPowersActionError(null);
        try {
            await restoreRepoDeploy(orgId, toolDefId);
            setPowersAction(null);
            window.location.reload();
        } catch (err) {
            setPowersActionError(err.message || 'Restore failed.');
        } finally {
            setPowersActionWorking(false);
        }
    }

    async function handlePowersDestroy() {
        if (!orgId || !toolDefId) return;
        setPowersActionWorking(true);
        setPowersActionError(null);
        try {
            await destroyRepoDeploy(orgId, toolDefId);
            setPowersAction(null);
            navigate('/tools');
        } catch (err) {
            setPowersActionError(err.message || 'Destroy failed.');
        } finally {
            setPowersActionWorking(false);
        }
    }

    async function handlePowersConfigSave() {
        if (!orgId || !toolDefId) return;
        setPowersActionWorking(true);
        setPowersActionError(null);
        const persona = {};
        if (powersConfigName.trim()) persona.name = powersConfigName.trim();
        if (typeof powersConfigDesc === 'string') persona.description = powersConfigDesc;
        try {
            await patchRepoDeployConfig(orgId, toolDefId, { persona });
            setPowersAction(null);
            window.location.reload();
        } catch (err) {
            setPowersActionError(err.message || 'Config update failed.');
        } finally {
            setPowersActionWorking(false);
        }
    }

    return (
        <div className="qx-view" style={{ display: 'flex', flexDirection: 'row', gap: 16, height: '100%', minHeight: 0 }}>

            {/* LEFT — main detail panels */}
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto' }}>

            {/* Panel A — header bar */}
            <section className="qx-card qx-card--bar">
                <div className="qx-row qx-row--apart">
                    <div className="qx-row qx-row--tight">
                        <Link to="/tools" className="qx-btn qx-btn--ghost qx-btn--sm">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
                                <polyline points="15 18 9 12 15 6"/>
                            </svg>
                            Back
                        </Link>
                        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>
                            {icon} {tool.name}
                        </h1>
                        {tool.risk_level && (
                            <span className="qx-pill qx-pill--ghost qx-pill--sm" style={{ color: riskColor }}>
                                {tool.risk_level}
                            </span>
                        )}
                        {tool.category && (
                            <span className="qx-chip">{tool.category}</span>
                        )}
                        {tool.source && (
                            <span className="qx-pill qx-pill--info qx-pill--sm">{tool.source}</span>
                        )}
                        {/* LIFECYCLE-P4-D1: trust_tier pill */}
                        {tool.trust_tier && (
                            <span
                                data-testid="trust-tier-pill"
                                className="qx-pill qx-pill--ghost qx-pill--sm"
                                style={{
                                    color: tool.trust_tier === 'verified' ? '#22c55e'
                                        : tool.trust_tier === 'untrusted' ? '#ef4444'
                                        : 'rgba(255,255,255,0.45)',
                                    fontSize: 11,
                                }}
                            >
                                Trust tier: {tool.trust_tier}
                            </span>
                        )}
                    </div>
                </div>
            </section>

            {/* Panel B — meta + actions */}
            <section className="qx-card">
                <div className="qx-stack">
                    {tool.description && (
                        <p style={{ margin: 0, fontSize: 14, color: 'rgba(255,255,255,0.85)', lineHeight: 1.6 }}>
                            {tool.description}
                        </p>
                    )}

                    <div className="tool-detail__props">
                        {tool.id && (
                            <div className="tool-property">
                                <span className="property-label">ID</span>
                                <code className="qx-code">{tool.id}</code>
                            </div>
                        )}
                        {tool.category && (
                            <div className="tool-property">
                                <span className="property-label">Category</span>
                                <span>{tool.category}{tool.subcategory && ` / ${tool.subcategory}`}</span>
                            </div>
                        )}
                        {tool.risk_level && (
                            <div className="tool-property">
                                <span className="property-label">Risk Level</span>
                                <span style={{ color: riskColor, fontWeight: 600 }}>{tool.risk_level}</span>
                            </div>
                        )}
                        {tool.sandbox_profile && (
                            <div className="tool-property">
                                <span className="property-label">Sandbox</span>
                                <span>{tool.sandbox_profile}</span>
                            </div>
                        )}
                        {tool.provider && (
                            <div className="tool-property">
                                <span className="property-label">Provider</span>
                                <span>{tool.provider}</span>
                            </div>
                        )}
                        {tool.installed_at && (
                            <div className="tool-property">
                                <span className="property-label">Installed</span>
                                <span>{new Date(tool.installed_at).toLocaleDateString()}</span>
                            </div>
                        )}
                        {tool.last_executed_at && (
                            <div className="tool-property">
                                <span className="property-label">Last Used</span>
                                <span>{new Date(tool.last_executed_at).toLocaleDateString()}</span>
                            </div>
                        )}
                        {tool.status && (
                            <div className="tool-property">
                                <span className="property-label">Status</span>
                                <span>
                                    <span className="qx-dot qx-dot--online" style={{ marginRight: 4 }} />
                                    {tool.status}
                                </span>
                            </div>
                        )}
                        {tool.source_list && (
                            <div className="tool-property">
                                <span className="property-label">Found via</span>
                                <a
                                    href={tool.source_list}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{ color: 'var(--accent-cyan, #22d3ee)', fontSize: 13 }}
                                >
                                    {prettifySourceList(tool.source_list)} ↗
                                </a>
                            </div>
                        )}
                    </div>

                    {tool.reference && (
                        <div>
                            <span className="property-label" style={{ display: 'block', marginBottom: 4, fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>Reference</span>
                            <a
                                href={tool.reference}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="qx-code"
                                style={{ fontSize: 12 }}
                            >
                                {tool.reference}
                            </a>
                        </div>
                    )}

                    <div className="qx-row qx-row--tight">
                        {isDeployable(tool) && (
                            <button
                                className="qx-btn qx-btn--primary qx-btn--sm"
                                onClick={() => navigate(`/tools/add?type=external-repo&prefill=${encodeURIComponent(tool.reference)}`)}
                            >
                                {ctaCopyFor(tool)}
                            </button>
                        )}
                        {!isDeployable(tool) && ctaCopyFor(tool) !== null && (
                            <button
                                className="qx-btn qx-btn--ghost qx-btn--sm"
                                disabled
                                title="HTTP API executor ships with POWERS-API. Catalog entry kept; full deploy path coming."
                            >
                                {ctaCopyFor(tool)}
                            </button>
                        )}
                        {tool.reference && (
                            <a
                                href={tool.reference}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="qx-btn qx-btn--ghost qx-btn--sm"
                            >
                                View source ↗
                            </a>
                        )}
                    </div>
                </div>
            </section>

            {/* Panel B.1 — POWERS lifecycle actions (only for POWERS deploys) */}
            {isPowersDeploy && (
                <section className="qx-card" style={{ borderLeft: '3px solid rgba(99,102,241,0.4)' }}>
                    <div className="qx-row qx-row--apart" style={{ marginBottom: powersAction ? 12 : 0 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                            POWERS Actions
                        </span>
                        <div className="qx-row qx-row--tight">
                            {/* D4: Edit configuration */}
                            <button
                                className="qx-btn qx-btn--ghost qx-btn--sm"
                                onClick={() => {
                                    setPowersConfigName(tool.name || '');
                                    setPowersConfigDesc(tool.description || '');
                                    setPowersAction(powersAction === 'config' ? null : 'config');
                                    setPowersActionError(null);
                                }}
                            >
                                <svg width="13" height="13" viewBox="0 0 24 24" style={{ fill: 'none', stroke: '#94a3b8', strokeWidth: 2, marginRight: 4 }} strokeLinecap="round" strokeLinejoin="round">
                                    <circle cx="12" cy="12" r="3"/>
                                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                                </svg>
                                Edit config
                            </button>
                            {/* D3: Archive or Restore */}
                            {isArchived ? (
                                <button
                                    className="qx-btn qx-btn--ghost qx-btn--sm"
                                    onClick={() => { setPowersAction('restore'); setPowersActionError(null); }}
                                >
                                    <svg width="13" height="13" viewBox="0 0 24 24" style={{ fill: 'none', stroke: '#22c55e', strokeWidth: 2, marginRight: 4 }} strokeLinecap="round" strokeLinejoin="round">
                                        <polyline points="23 4 23 10 17 10"/>
                                        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                                    </svg>
                                    Restore
                                </button>
                            ) : (
                                <button
                                    className="qx-btn qx-btn--ghost qx-btn--sm"
                                    onClick={() => { setPowersAction('archive'); setPowersActionError(null); }}
                                >
                                    <svg width="13" height="13" viewBox="0 0 24 24" style={{ fill: 'none', stroke: '#f59e0b', strokeWidth: 2, marginRight: 4 }} strokeLinecap="round" strokeLinejoin="round">
                                        <polyline points="21 8 21 21 3 21 3 8"/>
                                        <rect x="1" y="3" width="22" height="5"/>
                                        <line x1="10" y1="12" x2="14" y2="12"/>
                                    </svg>
                                    Archive
                                </button>
                            )}
                            {/* D3: Destroy */}
                            <button
                                className="qx-btn qx-btn--ghost qx-btn--sm"
                                onClick={() => { setPowersAction('destroy'); setPowersActionError(null); }}
                                style={{ color: 'var(--color-error, #ef4444)' }}
                            >
                                <svg width="13" height="13" viewBox="0 0 24 24" style={{ fill: 'none', stroke: '#ef4444', strokeWidth: 2, marginRight: 4 }} strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="3 6 5 6 21 6"/>
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                                </svg>
                                Destroy
                            </button>
                        </div>
                    </div>

                    {isArchived && powersAction !== 'restore' && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#f59e0b', marginTop: 4 }}>
                            <svg width="14" height="14" viewBox="0 0 24 24" style={{ fill: 'none', stroke: '#f59e0b', strokeWidth: 2 }} strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/>
                            </svg>
                            This power is archived and not available to agents.
                        </div>
                    )}

                    {powersActionError && (
                        <div className="wizard-error-inline" style={{ marginTop: 8 }}>{powersActionError}</div>
                    )}

                    {/* D4: Edit config panel */}
                    {powersAction === 'config' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                            <div className="wizard-field">
                                <label className="wizard-label" style={{ fontSize: '0.8rem' }}>Display name</label>
                                <input
                                    type="text"
                                    className="qx-input"
                                    value={powersConfigName}
                                    onChange={e => setPowersConfigName(e.target.value)}
                                    placeholder={tool.name}
                                />
                            </div>
                            <div className="wizard-field">
                                <label className="wizard-label" style={{ fontSize: '0.8rem' }}>Description</label>
                                <textarea
                                    className="qx-input"
                                    rows={2}
                                    value={powersConfigDesc}
                                    onChange={e => setPowersConfigDesc(e.target.value)}
                                    placeholder={tool.description || 'Agent description...'}
                                    style={{ resize: 'vertical' }}
                                />
                            </div>
                            <div className="qx-row qx-row--tight">
                                <button className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setPowersAction(null)} disabled={powersActionWorking}>
                                    Cancel
                                </button>
                                <button
                                    className="qx-btn qx-btn--primary qx-btn--sm"
                                    onClick={handlePowersConfigSave}
                                    disabled={powersActionWorking}
                                >
                                    {powersActionWorking ? 'Saving…' : 'Save changes'}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* D3: Archive confirm */}
                    {powersAction === 'archive' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                            <p style={{ margin: 0, fontSize: 13, color: 'rgba(255,255,255,0.75)' }}>
                                Archive this power? It will be disabled and unavailable to agents. All rows (credentials, build data) are preserved — you can restore it later.
                            </p>
                            <div className="qx-row qx-row--tight">
                                <button className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setPowersAction(null)} disabled={powersActionWorking}>Cancel</button>
                                <button
                                    className="qx-btn qx-btn--ghost qx-btn--sm"
                                    style={{ color: '#f59e0b', borderColor: 'rgba(245,158,11,0.3)' }}
                                    onClick={handlePowersArchive}
                                    disabled={powersActionWorking}
                                >
                                    {powersActionWorking ? 'Archiving…' : 'Confirm archive'}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* D3: Restore confirm */}
                    {powersAction === 'restore' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                            <p style={{ margin: 0, fontSize: 13, color: 'rgba(255,255,255,0.75)' }}>
                                Restore this power? It will be re-enabled and available to agents on next invocation.
                            </p>
                            <div className="qx-row qx-row--tight">
                                <button className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setPowersAction(null)} disabled={powersActionWorking}>Cancel</button>
                                <button
                                    className="qx-btn qx-btn--primary qx-btn--sm"
                                    onClick={handlePowersRestore}
                                    disabled={powersActionWorking}
                                >
                                    {powersActionWorking ? 'Restoring…' : 'Confirm restore'}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* D3: Destroy confirm */}
                    {powersAction === 'destroy' && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                            <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 6, padding: '10px 14px', fontSize: 13, color: '#fca5a5' }}>
                                <strong>Permanent and irreversible.</strong> This will delete the agent, credentials, build data, and all associated rows. You cannot undo this.
                            </div>
                            <div className="qx-row qx-row--tight">
                                <button className="qx-btn qx-btn--ghost qx-btn--sm" onClick={() => setPowersAction(null)} disabled={powersActionWorking}>Cancel</button>
                                <button
                                    className="qx-btn qx-btn--ghost qx-btn--sm"
                                    style={{ color: '#ef4444', borderColor: 'rgba(239,68,68,0.4)' }}
                                    onClick={handlePowersDestroy}
                                    disabled={powersActionWorking}
                                >
                                    {powersActionWorking ? 'Destroying…' : 'Yes, destroy permanently'}
                                </button>
                            </div>
                        </div>
                    )}
                </section>
            )}

            {/* Panel B.6 — LIFECYCLE-P4-D4: MCP inner-tools list */}
            <AvailableToolsPanel toolId={tool.tool_id || tool.id} availableTools={availableTools} />

            {/* Panel B.5 — README (after meta + actions) */}
            <ToolReadmePanel tool={tool} onReadmeLoaded={setReadmeContent} />

            {/* Panel C — input_schema */}
            {schemaStr && (
                <section className="qx-card" style={{ minHeight: 0 }}>
                    <h3 style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.7)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        Input Schema
                    </h3>
                    <pre className="qx-code-block" style={{ margin: 0, overflowX: 'auto', fontSize: 12 }}>
                        {schemaStr}
                    </pre>
                </section>
            )}

            </div>{/* end left column */}

            {/* RIGHT — Quartermaster sidebar, 360px, hidden on mobile */}
            <aside
                className="qx-card quartermaster-detail-sidebar"
                style={{
                    flex: '0 0 360px',
                    minHeight: 0,
                    padding: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                    alignSelf: 'stretch',
                }}
            >
                <style>{`
                    @media (max-width: 899px) {
                        .quartermaster-detail-sidebar { display: none !important; }
                    }
                `}</style>
                <QuartermasterSidebar
                    mode="detail"
                    seedTool={tool}
                    readmeContent={readmeContent}
                />
            </aside>

        </div>
    );
}
