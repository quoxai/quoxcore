/**
 * WorkflowsHubView — unified workflow lifecycle surface.
 *
 * Three sidebar entries collapse into one tabbed hub:
 *   ?tab=mine    → WorkflowsView (list / manage / audit)
 *   ?tab=build   → WorkflowBuilderView (DAEDALUS chat + WireMap canvas)
 *   ?tab=library → WorkflowLibraryView (1,300+ templates)
 *
 * URL state: ?tab= is managed here; all other search params (?id=, ?wf=,
 * ?mode=, etc.) are preserved and forwarded to the active pane.
 *
 * STUDY-REV-2 P5.A
 */

import { createContext, useContext, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import WorkflowsView from './WorkflowsView';
import WorkflowBuilderView from './WorkflowBuilderView';
import WorkflowLibraryView from './WorkflowLibraryView';
import '../../styles/glass.css';

// Shared by hub-embedded views to render their action buttons next to the
// tab row (instead of pushing to the breadcrumb via setPageActions).
const HubActionsContext = createContext(null);

export function useHubActions() {
    return useContext(HubActionsContext);
}

export default function WorkflowsHubView() {
    const [params, setParams] = useSearchParams();
    const tab = params.get('tab') || 'mine';
    const [hubActions, setHubActions] = useState(null);

    function switchTab(newTab) {
        // Preserve all existing params (id, wf, mode, etc.) and update tab.
        const next = new URLSearchParams(params);
        next.set('tab', newTab);
        setParams(next, { replace: true });
        // Clear inherited actions; the new pane will set its own (or nothing).
        setHubActions(null);
    }

    const ctxValue = useCallback((actions) => setHubActions(actions), []);

    return (
        <HubActionsContext.Provider value={ctxValue}>
            <div
                className="qx-view"
                style={{ height: '100%', overflow: 'hidden' }}
            >
                {/* Tab row + right-aligned actions slot (replaces cramped breadcrumb buttons) */}
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 16,
                    }}
                >
                    <div className="qx-tabs" role="tablist" aria-label="Workflow hub tabs">
                        <button
                            className={`qx-tab${tab === 'mine' ? ' qx-tab--active' : ''}`}
                            role="tab"
                            aria-selected={tab === 'mine'}
                            onClick={() => switchTab('mine')}
                            type="button"
                        >
                            My Workflows
                        </button>
                        <button
                            className={`qx-tab${tab === 'build' ? ' qx-tab--active' : ''}`}
                            role="tab"
                            aria-selected={tab === 'build'}
                            onClick={() => switchTab('build')}
                            type="button"
                        >
                            Build
                        </button>
                        <button
                            className={`qx-tab${tab === 'library' ? ' qx-tab--active' : ''}`}
                            role="tab"
                            aria-selected={tab === 'library'}
                            onClick={() => switchTab('library')}
                            type="button"
                        >
                            Library
                        </button>
                    </div>
                    {hubActions && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            {hubActions}
                        </div>
                    )}
                </div>

                {/* Pane container — flex:1 + min-height:0 + overflow:hidden so .wb-shell { height: 100% } resolves and internal scroll is contained */}
                <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', marginTop: 16, overflow: 'hidden' }}>
                    {tab === 'mine' && <WorkflowsView embedded />}
                    {tab === 'build' && <WorkflowBuilderView embedded />}
                    {tab === 'library' && <WorkflowLibraryView embedded />}
                </div>
            </div>
        </HubActionsContext.Provider>
    );
}
