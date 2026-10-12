/**
 * DevShell — agent-agnostic resizable three-pane developer IDE shell.
 *
 * Layout: file-tree | editor + pipeline-bar (pinned) | right-rail
 *
 * Uses react-resizable-panels v4 (Group / Panel / Separator API) for stable,
 * accessible resize handles with optional localStorage persistence.
 *
 * ARCHITECTURAL INVARIANT: Nothing in this file is Toolsmith-specific.
 * agentId is a prop; all content is passed as ReactNode slots.
 * Future tenants (QuoxDev, etc.) mount <DevShell agentId="quoxdev"> with
 * their own slot content — no changes to this file required.
 */

import { useEffect, useRef } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import './devshell.css';

/** Panel IDs — stable strings used for layout persistence keying */
const PANEL_LEFT   = 'devshell-left';
const PANEL_CENTER = 'devshell-center';
const PANEL_RIGHT  = 'devshell-right';

/** Default panel sizes as percentages (must sum to 100) */
const DEFAULT_SIZES = { left: 15, center: 60, right: 25 };

/** Minimum panel sizes as percentages */
const DEFAULT_MIN_SIZES = { left: 8, center: 25, right: 15 };

/**
 * Resizable three-pane developer shell.
 *
 * @param {object}      props
 * @param {string}      props.agentId          Required — agent identifier for theming + telemetry
 * @param {ReactNode}   props.fileTree          Left pane content (file tree)
 * @param {ReactNode}   props.editor            Center pane content (editor)
 * @param {ReactNode}   props.rightRail         Right pane content (chat sidebar, etc.)
 * @param {ReactNode}   [props.pipelineBar]     Pinned to bottom of center pane; omit to hide
 * @param {ReactNode}   [props.bottomDock]      Reserved for Slice 3 terminal dock
 * @param {object}      [props.defaultSizes]    { left, center, right } percentages (sum to 100)
 * @param {object}      [props.minSizes]        { left, center, right } percentages
 * @param {string}      [props.storageKey]      localStorage key for size persistence
 * @param {string}      [props.className]       Additional class names on the root element
 */
export function DevShell({
    agentId,
    fileTree,
    editor,
    rightRail,
    pipelineBar = null,
    bottomDock = null,
    defaultSizes = DEFAULT_SIZES,
    minSizes = DEFAULT_MIN_SIZES,
    storageKey,
    className,
}) {
    const groupRef = useRef(null);

    // Build defaultLayout map expected by react-resizable-panels v4
    const defaultLayout = {
        [PANEL_LEFT]:   defaultSizes.left,
        [PANEL_CENTER]: defaultSizes.center,
        [PANEL_RIGHT]:  defaultSizes.right,
    };

    // Restore persisted layout on mount
    useEffect(() => {
        if (!storageKey || !groupRef.current) return;
        try {
            const saved = localStorage.getItem(storageKey);
            if (saved) {
                const layout = JSON.parse(saved);
                // layout must be { [panelId]: number } — validate minimally
                if (layout && typeof layout === 'object' && layout[PANEL_LEFT] !== undefined) {
                    groupRef.current.setLayout(layout);
                }
            }
        } catch {
            // Corrupt or stale storage — ignore
        }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    function handleLayoutChanged(layout) {
        if (!storageKey) return;
        try {
            localStorage.setItem(storageKey, JSON.stringify(layout));
        } catch {
            // Storage full — silently ignore
        }
    }

    return (
        <div
            data-devshell-agent={agentId}
            className={`ds-shell${className ? ` ${className}` : ''}`}
        >
            <Group
                groupRef={groupRef}
                orientation="horizontal"
                defaultLayout={defaultLayout}
                onLayoutChanged={handleLayoutChanged}
                style={{ flex: 1, minHeight: 0 }}
            >
                {/* LEFT — file tree pane */}
                <Panel
                    id={PANEL_LEFT}
                    minSize={`${minSizes.left}%`}
                    style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}
                >
                    <div className="ds-panel" data-devshell-panel="left">
                        {fileTree}
                    </div>
                </Panel>

                {/* Resize handle: left ↔ center */}
                <Separator className="ds-separator">
                    <div className="ds-separator__line" />
                </Separator>

                {/* CENTER — editor + optional bottom dock + pinned pipeline bar */}
                <Panel
                    id={PANEL_CENTER}
                    minSize={`${minSizes.center}%`}
                    style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}
                >
                    <div className="ds-panel" data-devshell-panel="center">
                        {/* Editor occupies remaining space */}
                        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                            {editor}
                        </div>

                        {/* Bottom dock — Slice 3 will populate */}
                        {bottomDock && (
                            <div style={{ flexShrink: 0, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                                {bottomDock}
                            </div>
                        )}

                        {/* Pipeline bar — pinned at bottom of center pane, never pushed off-screen */}
                        {pipelineBar && (
                            <div
                                data-devshell-pipeline
                                style={{
                                    flexShrink: 0,
                                    borderTop: '1px solid rgba(255,255,255,0.08)',
                                }}
                            >
                                {pipelineBar}
                            </div>
                        )}
                    </div>
                </Panel>

                {/* Resize handle: center ↔ right */}
                <Separator className="ds-separator">
                    <div className="ds-separator__line" />
                </Separator>

                {/* RIGHT — right rail (chat sidebar, etc.) */}
                <Panel
                    id={PANEL_RIGHT}
                    minSize={`${minSizes.right}%`}
                    style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}
                >
                    <div className="ds-panel" data-devshell-panel="right">
                        {rightRail}
                    </div>
                </Panel>
            </Group>
        </div>
    );
}

export default DevShell;
