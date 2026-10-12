/**
 * TerminalPromo - Web Terminal Plugin Feature Page
 *
 * Standalone promo/feature page accessible at /terminal/about.
 * Shows plugin features, capabilities, and activation CTA.
 */

import { useNavigate } from 'react-router-dom';
import { isPluginLicensed } from '../../services/licenseValidator';
import { getPluginManifest } from '../../config/plugins';
import './terminal-promo.css';

const manifest = getPluginManifest('web-terminal');

const FEATURE_ICONS = {
    terminal: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
    ),
    layout: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <line x1="3" y1="9" x2="21" y2="9" />
            <line x1="9" y1="21" x2="9" y2="9" />
        </svg>
    ),
    lock: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
    ),
    'message-square': (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
    ),
    folder: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
    ),
    'refresh-cw': (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
    ),
    shield: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
    ),
    cpu: (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="4" width="16" height="16" rx="2" ry="2" />
            <rect x="9" y="9" width="6" height="6" />
            <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
            <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
            <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
            <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
        </svg>
    )
};

export default function TerminalPromo() {
    const navigate = useNavigate();
    const licensed = isPluginLicensed('web-terminal');
    const features = manifest?.features || {};

    const handleActivate = () => {
        navigate('/settings#plugins', { state: { highlight: 'web-terminal' } });
    };

    const handleOpenTerminal = () => {
        navigate('/terminal');
    };

    return (
        <div className="terminal-promo">
            {/* Hero */}
            <div className="terminal-promo__hero">
                <div className="terminal-promo__hero-icon">
                    <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="4 17 10 11 4 5" />
                        <line x1="12" y1="19" x2="20" y2="19" />
                    </svg>
                </div>
                <h1 className="terminal-promo__title">{manifest?.displayName || 'Web Terminal'}</h1>
                <p className="terminal-promo__tagline">{manifest?.tagline}</p>
                <p className="terminal-promo__desc">{manifest?.description}</p>

                <div className="terminal-promo__cta">
                    {licensed ? (
                        <button className="terminal-promo__btn terminal-promo__btn--primary" onClick={handleOpenTerminal}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="4 17 10 11 4 5" />
                                <line x1="12" y1="19" x2="20" y2="19" />
                            </svg>
                            Open Terminal
                        </button>
                    ) : (
                        <>
                            <button className="terminal-promo__btn terminal-promo__btn--primary" onClick={handleActivate}>
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                                </svg>
                                Activate Plugin
                            </button>
                            <span className="terminal-promo__price">{manifest?.priceDisplay} one-time</span>
                        </>
                    )}
                </div>
            </div>

            {/* Feature Grid */}
            <div className="terminal-promo__features">
                <h2 className="terminal-promo__section-title">Features</h2>
                <div className="terminal-promo__grid">
                    {Object.entries(features).map(([key, feat]) => (
                        <div
                            key={key}
                            className={`terminal-promo__card ${feat.highlight ? 'terminal-promo__card--highlight' : ''} ${feat.comingSoon ? 'terminal-promo__card--soon' : ''}`}
                        >
                            <div className="terminal-promo__card-icon">
                                {FEATURE_ICONS[feat.icon] || FEATURE_ICONS.terminal}
                            </div>
                            <h3 className="terminal-promo__card-title">
                                {feat.name}
                                {feat.comingSoon && <span className="terminal-promo__badge">Coming Soon</span>}
                            </h3>
                            <p className="terminal-promo__card-desc">{feat.description}</p>
                        </div>
                    ))}
                </div>
            </div>

            {/* Highlights */}
            <div className="terminal-promo__highlights">
                <h2 className="terminal-promo__section-title">Why Web Terminal?</h2>
                <ul className="terminal-promo__list">
                    {(manifest?.marketingPoints || []).map((point, i) => (
                        <li key={i} className="terminal-promo__list-item">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12" />
                            </svg>
                            <span>{point}</span>
                        </li>
                    ))}
                </ul>
            </div>

            {/* Requirements */}
            <div className="terminal-promo__requirements">
                <h2 className="terminal-promo__section-title">Requirements</h2>
                <p className="terminal-promo__req-text">
                    QuoxCORE {manifest?.requirements?.quox || '>=1.0.0'} with {manifest?.requirements?.external || 'Collector service'}.
                </p>
            </div>
        </div>
    );
}
