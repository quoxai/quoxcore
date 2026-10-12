/**
 * OrgBanner - Prominent active organisation display
 *
 * Shows current org logo/initials, name, and role badge.
 * Used at the top of Divisions, Departments, and Teams pages.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

const BuildingIcon = () => (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M3 21h18"/>
        <path d="M5 21V7l8-4v18"/>
        <path d="M19 21V11l-6-4"/>
    </svg>
);

export default function OrgBanner({ org }) {
    const navigate = useNavigate();
    const [imgError, setImgError] = useState(false);

    if (!org) return null;

    const name = org.name || '';
    const initials = name
        .split(' ')
        .filter(w => w.length > 0)
        .map(w => w[0])
        .join('')
        .slice(0, 2)
        .toUpperCase() || 'O';
    const role = org.membership?.role || org.role || null;

    return (
        <div
            className="org-banner"
            onClick={() => navigate(`/orgs/${org.id}`)}
            title="Go to organisation management"
        >
            <div className="org-banner__avatar">
                {org.logo_url && !imgError ? (
                    <img
                        src={org.logo_url}
                        alt={name}
                        onError={() => setImgError(true)}
                    />
                ) : (
                    <span className="org-banner__initials">{initials}</span>
                )}
            </div>
            <div className="org-banner__info">
                <div className="org-banner__label">
                    <BuildingIcon />
                    Active Organisation
                </div>
                <div className="org-banner__name">{name}</div>
            </div>
            {role && (
                <span className={`org-banner__role org-banner__role--${role}`}>
                    {role}
                </span>
            )}
        </div>
    );
}
