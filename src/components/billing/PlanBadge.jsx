/**
 * ET-1 — PlanBadge.
 *
 * Small pill showing the org's current plan. Colour per tier.
 */

import { PLAN_COLORS, formatPlanName } from '../../services/planClient';

export default function PlanBadge({ plan, isTrial, expired, size = 'sm', title }) {
    const key = (plan || 'free').toLowerCase();
    const accent = PLAN_COLORS[key] || PLAN_COLORS.free;
    const label  = formatPlanName(key) + (isTrial ? ' · Trial' : '');
    const style  = {
        '--plan-accent': accent,
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: size === 'lg' ? '4px 12px' : '2px 9px',
        fontSize: size === 'lg' ? 12 : 10,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.1em',
        color: accent,
        background: `color-mix(in srgb, ${accent} 14%, transparent)`,
        border: `1px solid color-mix(in srgb, ${accent} 34%, transparent)`,
        borderRadius: 999,
        whiteSpace: 'nowrap',
    };
    return (
        <span className="plan-badge" style={style} title={title || label}>
            {expired ? 'Expired' : label}
        </span>
    );
}
