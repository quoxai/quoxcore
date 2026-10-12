/**
 * PluginsView - Plugin Management
 *
 * View for managing QuoxCORE plugins and licenses.
 * Features:
 * - Installed plugins listing
 * - Plugin store browser
 * - License activation
 * - Enable/disable plugins
 * - Trial key generation
 */

import { useEffect, useState } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import PluginSettings from '../../components/settings/PluginSettings';
import './views.css';

function PluginsView() {
    // Safely access outlet context with fallback
    let contextValue = {};
    try {
        contextValue = useOutletContext() || {};
    } catch (e) {
        // Context not available, use default
    }
    const { halState } = contextValue;

    // Check for plugin highlight from URL params (e.g., /plugins?highlight=soc)
    const [searchParams] = useSearchParams();
    const highlightPlugin = searchParams.get('highlight');

    // Track plugin changes for any parent components that need to know
    const [lastPluginChange, setLastPluginChange] = useState(null);

    useEffect(() => {
        if (!import.meta.env.DEV) return undefined;
        try {
            if (localStorage.getItem('quox_route_debug') !== 'true') return undefined;
        } catch {
            return undefined;
        }

        console.debug('[RouteDebug] PluginsView mounted');
        return () => console.debug('[RouteDebug] PluginsView unmounted');
    }, []);

    const handlePluginChange = () => {
        setLastPluginChange(new Date().toISOString());
        // Could dispatch events or update global state here if needed
    };

    return (
        <div className="plugins-view qx-view" role="main" aria-label="Plugin Management">
            <PluginSettings
                onPluginChange={handlePluginChange}
                highlightPlugin={highlightPlugin}
            />
        </div>
    );
}

export default PluginsView;
