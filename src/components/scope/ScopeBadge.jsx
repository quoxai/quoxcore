/**
 * ScopeBadge — Shows scope identity with breadcrumb path, icons, and org logo.
 *
 * Variants:
 *   compact  — Icon + last name, tooltip shows labeled path (for card headers)
 *   full     — Logo + labeled breadcrumb (for detail headers)
 *   inline   — Plain text breadcrumb (for info rows)
 *   labeled  — Type labels + names: "Organisation: X > Division: Y > Department: Z"
 */

import { useMemo, useState } from 'react';
import './scope.css';

// Scope type icons (matching ScopePicker + WorkflowEditModal)
const SCOPE_ICONS = { core: '{}', org: '[]', division: '||', department: '#', team: '@' };

// Scope type labels
const SCOPE_LABELS = { core: 'Core', org: 'Organisation', division: 'Division', department: 'Department', team: 'Team' };

/**
 * Parse a scope path string and resolve names from the scopes array.
 *
 * Path format: "/<orgId>" or "/<orgId>/<divId>" or "/<orgId>/<divId>/<deptId>"
 * The newer paths use: "/org/<refId>/division/<refId>/department/<refId>"
 * We support both by matching ref_id against all known scopes.
 */
function resolveBreadcrumb(scopePath, allScopes, orgName) {
    if (!scopePath || !allScopes?.length) return null;

    // Build a lookup: ref_id -> scope
    const byRefId = new Map();
    const byId = new Map();
    for (const s of allScopes) {
        byRefId.set(s.ref_id, s);
        byId.set(s.id, s);
    }

    // Parse path segments — strip type labels, keep IDs
    const segments = scopePath.split('/').filter(Boolean);
    const crumbs = [];

    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        // Skip type labels (org, division, department, team)
        if (['org', 'division', 'department', 'team'].includes(seg)) continue;
        // This is a ref_id — look it up
        const scope = byRefId.get(seg);
        if (scope) {
            crumbs.push({
                name: scope.name_cache || scope.name,
                type: scope.scope_type,
                id: scope.id,
            });
        }
    }

    // If path parsing found nothing, try parent chain via parent_scope_id
    if (crumbs.length === 0 && allScopes.length > 0) {
        // Find the scope matching this path
        const thisScope = allScopes.find(s => s.path === scopePath);
        if (thisScope) {
            // Walk up the parent chain
            const chain = [];
            let current = thisScope;
            while (current) {
                chain.unshift({
                    name: current.name_cache || current.name,
                    type: current.scope_type,
                    id: current.id,
                });
                current = current.parent_scope_id ? byId.get(current.parent_scope_id) : null;
            }
            return chain.length > 0 ? chain : null;
        }
    }

    return crumbs.length > 0 ? crumbs : null;
}

function OrgLogo({ logoUrl, name, size = 14 }) {
    const [imgError, setImgError] = useState(false);
    const initials = (name || '')
        .split(' ')
        .filter(w => w.length > 0)
        .map(w => w[0])
        .join('')
        .slice(0, 2)
        .toUpperCase() || 'O';

    return (
        <span className="scope-badge__logo" style={{ width: size, height: size, minWidth: size }}>
            {logoUrl && !imgError ? (
                <img src={logoUrl} alt={name} onError={() => setImgError(true)} />
            ) : (
                <span className="scope-badge__logo-initials">{initials}</span>
            )}
        </span>
    );
}

export default function ScopeBadge({
    scopePath,
    scopeName,
    scopeType = 'org',
    allScopes = [],
    orgName,
    orgLogoUrl,
    variant = 'compact',
    showIcon = true,
    showLogo = true,
}) {
    const breadcrumb = useMemo(
        () => resolveBreadcrumb(scopePath, allScopes, orgName),
        [scopePath, allScopes, orgName]
    );

    // Full path text for tooltip (with type labels)
    const fullPathText = breadcrumb
        ? breadcrumb.map(c => `${SCOPE_LABELS[c.type] || c.type}: ${c.name}`).join(' > ')
        : scopeName
            ? (orgName ? `Organisation: ${orgName} > ${SCOPE_LABELS[scopeType] || scopeType}: ${scopeName}` : `${SCOPE_LABELS[scopeType] || scopeType}: ${scopeName}`)
            : orgName ? `Organisation: ${orgName}` : 'Unscoped';

    // Last segment name (for compact)
    const displayName = breadcrumb
        ? breadcrumb[breadcrumb.length - 1].name
        : scopeName || orgName || 'Unscoped';

    // Icon for the deepest scope type
    const icon = SCOPE_ICONS[scopeType] || '';

    if (variant === 'inline') {
        return (
            <span className={`scope-badge scope-badge--inline scope-badge--${scopeType}`}>
                {showIcon && icon && <span className="scope-badge__icon">{icon}</span>}
                <span className="scope-badge__text">{fullPathText}</span>
            </span>
        );
    }

    if (variant === 'labeled' || variant === 'full') {
        const crumbs = breadcrumb
            ? [...breadcrumb]
            : (scopeName ? [{ name: scopeName, type: scopeType }] : [{ name: orgName || 'Unscoped', type: 'org' }]);
        // If breadcrumb doesn't include org but we have orgName, prepend it
        if (crumbs.length > 0 && crumbs[0].type !== 'org' && orgName) {
            crumbs.unshift({ name: orgName, type: 'org' });
        }

        return (
            <span className={`scope-badge scope-badge--${variant} scope-badge--${scopeType}`}>
                {showLogo && variant === 'full' && <OrgLogo logoUrl={orgLogoUrl} name={orgName} size={16} />}
                {crumbs.map((c, i) => (
                    <span key={i} className="scope-badge__crumb">
                        {i > 0 && <span className="scope-badge__sep">&rsaquo;</span>}
                        {showIcon && variant === 'full' && <span className="scope-badge__icon">{SCOPE_ICONS[c.type] || ''}</span>}
                        <span className="scope-badge__type-label">{SCOPE_LABELS[c.type] || c.type}:</span>
                        <span className="scope-badge__segment">{c.name}</span>
                    </span>
                ))}
            </span>
        );
    }

    // compact (default)
    return (
        <span
            className={`scope-badge scope-badge--compact scope-badge--${scopeType}`}
            title={fullPathText}
        >
            {showLogo && <OrgLogo logoUrl={orgLogoUrl} name={orgName} size={14} />}
            {showIcon && icon && <span className="scope-badge__icon">{icon}</span>}
            <span className="scope-badge__name">{displayName}</span>
        </span>
    );
}
