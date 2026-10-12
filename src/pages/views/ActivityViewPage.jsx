/**
 * ActivityViewPage - Activity & Envelope Viewer
 *
 * Two-column layout: main content + ActivityChatSidebar (right).
 * Tab switching between Conversations, Layer Insights, and Export.
 */

import { useEffect, useState } from 'react';
import { useOutletContext, useNavigate, useSearchParams } from 'react-router-dom';
import { ActivityView, ExportView } from '../../components/activity';
import { ActivityChatSidebar } from '../../components/activity/ActivityChatSidebar';
import { LayerInsights } from '../../components/layers';
import { useAdvancedMode } from '../../services/uiSettings';
import './views.css';

function ActivityViewPage() {
    const { halState, setHalState } = useOutletContext() || {};
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const initialCorr = searchParams.get('corr');
    const [activeTab, setActiveTab] = useState('conversations');
    const advancedMode = useAdvancedMode();
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [selectedAgent, setSelectedAgent] = useState('sentinel');

    useEffect(() => {
        if (!import.meta.env.DEV) return undefined;
        try {
            if (localStorage.getItem('quox_route_debug') !== 'true') return undefined;
        } catch {
            return undefined;
        }

        console.debug('[RouteDebug] ActivityViewPage mounted');
        return () => console.debug('[RouteDebug] ActivityViewPage unmounted');
    }, []);

    // Shared state for export — populated by ActivityView
    const [exportContext, setExportContext] = useState({
        conversations: [],
        selectedConv: null,
        selectedConversation: null,
        selectedMessages: [],
        filters: {}
    });

    const handleContinueConversation = (conv) => {
        // AOCL-DISPATCH-B8: forward the conv (which now carries
        // _continuePayload from ActivityView.handleContinue) so HomeView
        // can read messages directly from navigation state without
        // depending on localStorage timing.
        navigate('/', { state: { continueConversation: conv } });
    };

    const handleSwitchView = (viewId) => {
        const viewRoutes = {
            'command': '/',
            'soc': '/soc',
            'noc': '/noc',
            'infra': '/infra',
            'agents': '/agents',
            'memory': '/memory',
            'activity': '/activity',
            'files': '/files',
            'settings': '/settings',
        };
        if (viewRoutes[viewId]) {
            navigate(viewRoutes[viewId]);
        }
    };

    return (
        <div className="activity-view-page activity-view-page--compact">
            <style>{`
                .app-shell__content:has(.activity-view-page) {
                    padding: 0;
                    overflow: hidden;
                }
                .app-shell__content:has(.activity-view-page) .breadcrumbs {
                    display: none;
                }
                .activity-view-page {
                    display: flex;
                    flex-direction: row;
                    gap: 16px;
                    height: 100%;
                    overflow: hidden;
                    /* NO padding — .app-shell already provides 16px outer */
                }
                .activity-view-page__main-col {
                    flex: 1;
                    min-width: 0;
                    display: flex;
                    flex-direction: column;
                    min-height: 0;
                }
                .activity-view-page__chat-col {
                    width: 360px;
                    flex-shrink: 0;
                    display: flex;
                    flex-direction: column;
                    position: relative;
                    isolation: isolate;
                    min-height: 0;
                    background: var(--m-bg-base, rgba(255,255,255,0.08));
                    border: 1px solid var(--m-border-default, rgba(255,255,255,0.18));
                    border-radius: var(--qx-radius, 20px);
                    box-shadow:
                        inset 0 1px 0 rgba(255,255,255,0.18),
                        inset 0 -1px 0 rgba(0,0,0,0.45);
                    overflow: hidden;
                }
                .activity-view-page__chat-col::before {
                    content: '';
                    position: absolute;
                    inset: 0;
                    z-index: -1;
                    border-radius: inherit;
                    pointer-events: none;
                    background: var(--qx-edges);
                    backdrop-filter: var(--qx-blur);
                    -webkit-backdrop-filter: var(--qx-blur);
                }
            `}</style>
            {/* Main content */}
            <div className="activity-view-page__main-col">
                {activeTab === 'conversations' && (
                    <ActivityView
                        onContinueConversation={handleContinueConversation}
                        onSwitchView={handleSwitchView}
                        showInsightsTab={advancedMode}
                        onSwitchToInsights={() => setActiveTab('insights')}
                        onSwitchToExport={() => setActiveTab('export')}
                        onExportContextChange={setExportContext}
                        initialCorr={initialCorr}
                    />
                )}

                {activeTab === 'insights' && (
                    <div className="activity-insights-wrapper">
                        <div className="activity-insights-header">
                            <button
                                className="activity-back-btn"
                                onClick={() => setActiveTab('conversations')}
                            >
                                <span style={{ fontSize: 14 }}>&#x25C0;</span>
                                Back to Activity
                            </button>
                            <h3 className="activity-insights-title">AOCL Layer Insights</h3>
                            <p className="activity-insights-subtitle">Processing layer analysis across all audited conversations</p>
                        </div>
                        <div className="activity-insights-container">
                            <LayerInsights />
                        </div>
                    </div>
                )}

                {activeTab === 'export' && (
                    <ExportView
                        conversations={exportContext.conversations}
                        selectedConv={exportContext.selectedConv}
                        selectedMessages={exportContext.selectedMessages}
                        filters={exportContext.filters}
                        onBack={() => setActiveTab('conversations')}
                    />
                )}
            </div>

            {/* Sidebar open tab — visible when closed */}
            {!sidebarOpen && (
                <button
                    onClick={() => setSidebarOpen(true)}
                    title="Open audit chat"
                    className="activity-sidebar-toggle activity-sidebar-toggle--closed"
                >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                </button>
            )}

            {/* Agent chat sidebar — its own glass panel */}
            {sidebarOpen && (
                <aside className="activity-view-page__chat-col">
                    <ActivityChatSidebar
                        onClose={() => setSidebarOpen(false)}
                        conversations={exportContext.conversations}
                        selectedConversation={exportContext.selectedConversation}
                        selectedMessages={exportContext.selectedMessages}
                        filters={exportContext.filters}
                        selectedAgent={selectedAgent}
                        onAgentChange={setSelectedAgent}
                    />
                </aside>
            )}
        </div>
    );
}

export default ActivityViewPage;
