/**
 * ET-1 — UpgradeBanner.
 *
 * Shown when a feature is gated behind a higher plan tier. Uses
 * .qx-banner so it inherits the canonical glass recipe.
 */

import { Link } from 'react-router-dom';
import { formatPlanName, PLAN_COLORS } from '../../services/planClient';

const SparkIcon = () => (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6">
        <polygon points="12 2 15 8 22 9 17 14 18 21 12 18 6 21 7 14 2 9 9 8 12 2" />
    </svg>
);

export default function UpgradeBanner({
    requiredTier   = 'team',
    currentPlan    = 'free',
    message,
    billingHref    = '/settings#billing',
    compact        = false,
}) {
    const accent = PLAN_COLORS[requiredTier.toLowerCase()] || PLAN_COLORS.team;
    const bannerStyle = {
        '--qx-banner-accent': accent,
        '--qx-banner-tint':   `color-mix(in srgb, ${accent} 8%, transparent)`,
        '--qx-banner-border': `color-mix(in srgb, ${accent} 30%, transparent)`,
    };

    const defaultMsg = `This feature is available on the ${formatPlanName(requiredTier)} plan.`;
    return (
        <div className="qx-banner" style={bannerStyle} role="note">
            <SparkIcon />
            <span>
                <span className="qx-banner__title">{formatPlanName(requiredTier)} plan</span>
                {message || defaultMsg}
                {!compact && currentPlan && (
                    <> You're currently on <strong>{formatPlanName(currentPlan)}</strong>.</>
                )}
            </span>
            <span className="qx-banner__actions">
                <Link
                    to={billingHref}
                    style={{
                        padding: '4px 12px',
                        borderRadius: 999,
                        background: `color-mix(in srgb, ${accent} 22%, transparent)`,
                        border: `1px solid color-mix(in srgb, ${accent} 45%, transparent)`,
                        color: accent,
                        fontSize: 11,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        letterSpacing: '0.08em',
                        textDecoration: 'none',
                    }}
                >
                    Upgrade
                </Link>
            </span>
        </div>
    );
}
