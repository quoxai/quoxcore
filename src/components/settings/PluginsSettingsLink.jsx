/**
 * PluginsSettingsLink
 *
 * The Settings "Plugins" section no longer embeds the full plugin manager.
 * Plugin management has ONE home: the Plugins dashboard at /plugins. This
 * card is what the Settings tab shows instead — a short explanation plus a
 * button that opens the dashboard — so the same heavy UI is not rendered and
 * maintained in two places (owner call, 2026-09-03: "Plugins gets its own
 * page, not a Settings tab. Settings tab can just have a link to open the
 * Plugins dashboard").
 */

import { Link } from 'react-router-dom';
import './PluginsSettingsLink.css';

export default function PluginsSettingsLink() {
    return (
        <div className="qx-view plugins-settings-link">
            <section className="qx-card">
                <div className="plugins-settings-link__icon" aria-hidden="true">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
                        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 12h-4v4a2 2 0 0 1-2 2h-4v-4a2 2 0 0 0-4 0v4H4a2 2 0 0 1-2-2v-4H6a2 2 0 0 0 0-4H2V4a2 2 0 0 1 2-2h4v4a2 2 0 0 0 4 0V2h4a2 2 0 0 1 2 2v4h-4a2 2 0 0 0 0 4h4z" />
                    </svg>
                </div>
                <h2>Plugins have their own dashboard</h2>
                <p>
                    Install, enable, license and manage every plugin from the Plugins
                    dashboard. It used to live here too — now it has a single home so
                    there is one place to manage everything.
                </p>
                <Link to="/plugins" className="qx-btn qx-btn--primary">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 3h7v7" />
                        <path d="M10 14 21 3" />
                        <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
                    </svg>
                    Open Plugins dashboard
                </Link>
            </section>
        </div>
    );
}
