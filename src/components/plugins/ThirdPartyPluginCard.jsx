/**
 * ThirdPartyPluginCard — Card component for installed third-party plugins.
 *
 * Visual distinction from official plugins via "COMMUNITY" teal badge.
 * Shows name, version, author, description, signature status.
 * Actions: Enable/Disable toggle, Uninstall.
 */

import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    setThirdPartyPluginEnabled,
    uninstallThirdPartyPlugin,
    isPluginActive,
} from '../../services/thirdPartyPluginHost';
import { isThirdPartyPluginLicensed } from '../../services/licenseValidator';
import { TRUSTED_ADMIN_ONLY_LABEL } from '../../services/pluginTrustModel';
import { getPluginNavItems } from '../../config/navRegistry';

export default function ThirdPartyPluginCard({ plugin, onUpdate }) {
    const navigate = useNavigate();
    const [loading, setLoading] = useState(false);
    const [showUninstall, setShowUninstall] = useState(false);
    const [deleteData, setDeleteData] = useState(false);
    const [toggleError, setToggleError] = useState(null);

    const active = isPluginActive(plugin.pluginId);
    // The plugin's own page: the first route it registered in the sidebar.
    // Only present when the plugin is active (disabling unregisters its routes).
    const openPath = getPluginNavItems().get(plugin.pluginId)?.items?.[0]?.path || null;
    const licensed = !plugin.manifest?.license || plugin.manifest.license === 'free' || isThirdPartyPluginLicensed(plugin.pluginId);

    // PERSIST-TRUTH: enable/disable is an org-wide, admin-gated, server-persisted
    // action (PATCH /orgs/:orgId/plugins/:pluginId is_enabled) — not a local
    // DOM toggle. A non-admin's attempt surfaces the server's permission error
    // instead of silently only affecting the current tab.
    const handleToggle = useCallback(async () => {
        setLoading(true);
        setToggleError(null);
        const result = await setThirdPartyPluginEnabled(plugin.pluginId, !active);
        setLoading(false);
        if (!result.success) {
            setToggleError(result.error || 'Failed to update plugin state');
        }
        onUpdate?.();
    }, [active, plugin.pluginId, onUpdate]);

    const handleUninstall = useCallback(async () => {
        setLoading(true);
        await uninstallThirdPartyPlugin(plugin.pluginId, deleteData);
        setLoading(false);
        setShowUninstall(false);
        onUpdate?.();
    }, [plugin.pluginId, deleteData, onUpdate]);

    return (
        <div className="pc tpc" data-plugin-name={plugin.pluginId}>
            {/* Board-vision chip furniture — same convention as PluginCard.jsx
                (LICENSE-LAUNCH LL-8 v1): brand-color rim, bus-rail stub, and
                accent bloom, so the Community board's chips read as seated on
                the same PCB substrate as the licensed/claimable/premium boards
                instead of a plain grid of cards. */}
            <div className="pc__rim" />
            <span className="pc__stub" />
            <span className="pc__bloom" />

            {/* Header */}
            <div className="tpc__head">
                <div className="tpc__title-row">
                    <span className="tpc__name">{plugin.name}</span>
                    <span className="tpc__community-tag">COMMUNITY</span>
                </div>
                <div className="tpc__meta">
                    v{plugin.version}{plugin.author ? ` · by ${plugin.author}` : ''}
                </div>

                {/* Enable/Disable toggle */}
                <button
                    className="tpc__toggle"
                    role="switch"
                    aria-checked={active}
                    aria-label={`${active ? 'Disable' : 'Enable'} ${plugin.name}`}
                    onClick={handleToggle}
                    disabled={loading || (!licensed && !active)}
                    title={!licensed ? 'License required' : active ? 'Disable' : 'Enable'}
                    data-active={active ? 'true' : 'false'}
                />
            </div>

            {/* Description */}
            {plugin.manifest?.description && (
                <p className="tpc__desc">{plugin.manifest.description}</p>
            )}

            {/* Enable/disable permission or network error */}
            {toggleError && (
                <p className="tpc__error" role="alert">{toggleError}</p>
            )}

            {/* Status badges */}
            <div className="tpc__badges">
                <span className="tpc__badge tpc__badge--warn">
                    {TRUSTED_ADMIN_ONLY_LABEL}
                </span>
                {!licensed && (
                    <span className="tpc__badge tpc__badge--warn">
                        License Required
                    </span>
                )}
                <span className={`tpc__badge ${active ? 'tpc__badge--ok' : 'tpc__badge--err'}`}>
                    {active ? 'Active' : 'Inactive'}
                </span>
            </div>

            {/* Actions */}
            <div className="tpc__actions">
                {openPath && (
                    <button
                        className="ps-btn ps-btn--small ps-btn--primary"
                        onClick={() => navigate(openPath)}
                        title={`Open ${plugin.name}`}
                    >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="5" y1="12" x2="19" y2="12"/>
                            <polyline points="12 5 19 12 12 19"/>
                        </svg>
                        Open
                    </button>
                )}
                <button
                    className="ps-btn ps-btn--small ps-btn--danger"
                    onClick={() => setShowUninstall(true)}
                >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                        <polyline points="3 6 5 6 21 6"/>
                        <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                    </svg>
                    Uninstall
                </button>
            </div>

            {/* Uninstall confirmation */}
            {showUninstall && (
                <div className="tpc__uninstall-panel">
                    <p>Uninstall {plugin.name}?</p>
                    <p>This will remove the plugin, its sidebar items, and routes.</p>
                    <label className="tpc__uninstall-label">
                        <input
                            type="checkbox"
                            checked={deleteData}
                            onChange={e => setDeleteData(e.target.checked)}
                        />
                        Also delete plugin data
                    </label>
                    <div className="tpc__uninstall-actions">
                        <button
                            className="ps-btn ps-btn--small ps-btn--danger-confirm"
                            onClick={handleUninstall}
                            disabled={loading}
                        >
                            {loading ? 'Removing...' : 'Confirm Uninstall'}
                        </button>
                        <button
                            className="ps-btn ps-btn--small"
                            onClick={() => setShowUninstall(false)}
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
