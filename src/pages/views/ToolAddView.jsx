/**
 * ToolAddView — STUDY-REV-2/P1.A-rebuild
 *
 * Full-page replacement for AddToolModal.
 * Route: /tools/add?type=external-repo|mcp|openapi|script-forge
 *
 * Panel A: header bar (back link + title)
 *   Script Forge: mirrors wb-toolbar (title pill + inline name input + Save action)
 *   Other tabs: simple qx-card bar with back link + title + subtitle
 * Panel B: sub-tab nav (External Repository / MCP Server / OpenAPI / Script Forge)
 * Panel C: tab content (flex 1, overflow auto)
 *
 * After successful install: navigate('/tools', { state: { freshInstall: N } })
 * Script Forge (TOOLSMITH Slice B) — full UI shell with draft persistence.
 */

import { Suspense, lazy, useState, useRef, useCallback, useEffect } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import OpenApiInstallPanel from '../../components/tools/OpenApiInstallPanel';
import McpInstallPanel from '../../components/tools/McpInstallPanel';
import DeployPowerWizard from '../../components/powers/DeployPowerWizard';
import '../../components/workflow/WorkflowBuilder.css';

// Lazy-load ScriptForgeView — contains Monaco which is a heavy dependency.
// React.lazy preserves the forwardRef contract, so sfRef works correctly.
const ScriptForgeView = lazy(() => import('../../components/tools/ScriptForgeView'));

const TABS = [
    { id: 'external-repo', label: 'External Repository' },
    { id: 'mcp', label: 'MCP Server' },
    { id: 'openapi', label: 'OpenAPI' },
    { id: 'script-forge', label: 'Script Forge' },
];

export default function ToolAddView() {
    const [searchParams, setSearchParams] = useSearchParams();
    const navigate = useNavigate();
    const { currentOrg } = useWorkspace();

    // Alias ?type=github → ?type=external-repo (back-button-safe replace)
    useEffect(() => {
        if (searchParams.get('type') === 'github') {
            setSearchParams({ type: 'external-repo' }, { replace: true });
        }
    }, [searchParams, setSearchParams]);

    const activeTab = searchParams.get('type') === 'github'
        ? 'external-repo'
        : (searchParams.get('type') || 'external-repo');
    const isScriptForge = activeTab === 'script-forge';

    // Script Forge top-bar — imperative ref to ScriptForgeView and name state
    const sfRef = useRef(null);
    const [toolName, setToolName] = useState('');
    const [sfSaveStatus, setSfSaveStatus] = useState('unsaved');

    const handleNameChange = useCallback((name) => {
        setToolName(name);
    }, []);

    const handleSaveStatusChange = useCallback((status) => {
        setSfSaveStatus(status);
    }, []);

    const handleTopBarSave = useCallback(() => {
        sfRef.current?.saveNow();
    }, []);

    function setTab(id) {
        setSearchParams({ type: id });
    }

    function handleSuccess(registered) {
        navigate('/tools', { state: { freshInstall: registered.length } });
    }

    function renderTabContent() {
        switch (activeTab) {
            case 'external-repo':
                return (
                    <DeployPowerWizard
                        inline
                        orgId={currentOrg?.id}
                        onClose={() => navigate('/tools')}
                        onDeployed={() => navigate('/agents')}
                    />
                );
            case 'openapi':
                return <OpenApiInstallPanel onSuccess={handleSuccess} />;
            case 'mcp':
                return <McpInstallPanel onSuccess={handleSuccess} />;
            case 'script-forge':
                return (
                    <Suspense fallback={
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                            <span className="qx-spinner qx-spinner--sm" />
                        </div>
                    }>
                        <ScriptForgeView
                            ref={sfRef}
                            onNameChange={handleNameChange}
                            onSaveStatusChange={handleSaveStatusChange}
                        />
                    </Suspense>
                );
            default:
                return (
                    <DeployPowerWizard
                        inline
                        orgId={currentOrg?.id}
                        onClose={() => navigate('/tools')}
                        onDeployed={() => navigate('/agents')}
                    />
                );
        }
    }

    return (
        <div className="qx-view" style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%', minHeight: 0 }}>

            {/* Panel A — header bar
                Script Forge: wb-toolbar pattern (title pill + name input + Save).
                Other tabs: standard qx-card bar. */}
            {isScriptForge ? (
                <div className="wb-toolbar">
                    {/* Back to Tools */}
                    <Link
                        to="/tools"
                        className="wb-toolbar__btn"
                        style={{ textDecoration: 'none', flexShrink: 0 }}
                        title="Back to Tools"
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="15 18 9 12 15 6"/>
                        </svg>
                        Tools
                    </Link>

                    {/* Title pill — Script Forge */}
                    <div className="wb-toolbar__title">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
                        </svg>
                        Script Forge
                    </div>

                    {/* Inline name input — bound to tool.json:name */}
                    <div className="wb-toolbar__name">
                        <input
                            type="text"
                            placeholder="Untitled Tool"
                            value={toolName}
                            data-testid="sf-tool-name-input"
                            onChange={(e) => {
                                const name = e.target.value;
                                setToolName(name);
                                sfRef.current?.setName(name);
                            }}
                        />
                    </div>

                    <div className="wb-toolbar__spacer" />

                    {/* Primary Save action */}
                    <div className="wb-toolbar__actions">
                        <button
                            data-testid="sf-topbar-save-btn"
                            className="wb-toolbar__btn wb-toolbar__btn--primary"
                            onClick={handleTopBarSave}
                            disabled={sfSaveStatus === 'saving'}
                            title={sfSaveStatus === 'saving' ? 'Saving…' : 'Save draft'}
                        >
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                                <polyline points="17 21 17 13 7 13 7 21"/>
                                <polyline points="7 3 7 8 15 8"/>
                            </svg>
                            {sfSaveStatus === 'saving' ? 'Saving…' : 'Save'}
                        </button>
                    </div>
                </div>
            ) : (
                <section className="qx-card qx-card--bar">
                    <div className="qx-row qx-row--apart">
                        <div className="qx-row qx-row--tight">
                            <Link to="/tools" className="qx-btn qx-btn--ghost qx-btn--sm">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}>
                                    <polyline points="15 18 9 12 15 6"/>
                                </svg>
                                Back to Tools
                            </Link>
                            <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Add Tool</h1>
                        </div>
                        <p style={{ margin: 0, fontSize: 13, color: 'rgba(255,255,255,0.6)' }}>
                            Register an external repository, MCP server, OpenAPI spec, or author a custom script.
                        </p>
                    </div>
                </section>
            )}

            {/* Panel B — sub-tab nav */}
            <section className="qx-card qx-card--bar">
                <nav className="qx-tabs">
                    {TABS.map(tab => (
                        <button
                            key={tab.id}
                            className={`qx-tab${activeTab === tab.id ? ' qx-tab--active' : ''}`}
                            onClick={() => setTab(tab.id)}
                        >
                            {tab.label}
                        </button>
                    ))}
                </nav>
            </section>

            {/* Panel C — tab content
                Script Forge: DevShell panels carry their own glass chrome, so this
                wrapper drops its card chrome (background, border, padding) to avoid
                glass-on-glass double-framing. The DevShell panels float directly on
                the view's cinematic background.
                Other tabs: keep standard qx-card chrome + 20px padding. */}
            <section
                className={isScriptForge ? undefined : 'qx-card'}
                style={{
                    flex: 1,
                    minHeight: 0,
                    overflow: isScriptForge ? 'hidden' : 'auto',
                    padding: isScriptForge ? 0 : 20,
                    ...(isScriptForge ? {
                        background: 'transparent',
                        border: 'none',
                        borderRadius: 0,
                    } : {}),
                }}
            >
                {renderTabContent()}
            </section>

        </div>
    );
}
