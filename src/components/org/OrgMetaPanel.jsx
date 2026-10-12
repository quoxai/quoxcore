/**
 * OrgMetaPanel — compact fact sheet.
 *
 * Vertical stacked rows: small-caps label on top, full-width value
 * below. Generous line-height, not cramped. Plan promoted to a pill
 * at the top of the panel.
 */

import { useState } from 'react';
import PlanBadge from '../billing/PlanBadge';
import { usePlan } from '../../hooks/usePlan';

function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
}

const PLAN_ACCENT = {
    free:       '#38bdf8',
    starter:    '#a78bfa',
    team:       '#4ade80',
    enterprise: '#fbbf24',
};

function CopyButton({ value, label }) {
    const [copied, setCopied] = useState(false);
    const handleCopy = (e) => {
        e.stopPropagation();
        if (!value || value === '—') return;
        navigator.clipboard?.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
    };
    return (
        <button
            type="button"
            className={`org-meta-panel__copy${copied ? ' org-meta-panel__copy--copied' : ''}`}
            onClick={handleCopy}
            title={copied ? 'Copied' : `Copy ${label}`}
            aria-label={`Copy ${label}`}
        >
            {copied ? (
                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12" />
                </svg>
            ) : (
                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.75">
                    <rect x="9" y="9" width="13" height="13" rx="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
            )}
        </button>
    );
}

export default function OrgMetaPanel({ entity, entityScopeId }) {
    if (!entity) return null;

    // /orgs/:id/plan is authoritative; fall back to entity.plan while loading.
    const planState = usePlan(entity.id);
    const plan = (planState.plan || entity.plan || 'free').toLowerCase();

    const rows = [
        { label: 'Slug',        value: entity.slug || '—',              mono: true, copyable: !!entity.slug },
        { label: 'Organisation ID', value: entity.id,                   mono: true, copyable: true },
        { label: 'Scope ID',    value: entityScopeId || '—',            mono: true, copyable: !!entityScopeId },
        { label: 'MFA policy',  value: (entity.mfa_policy || 'optional').replace(/_/g, ' ') },
        { label: 'Created',     value: formatDate(entity.created_at) },
        { label: 'Updated',     value: formatDate(entity.updated_at) },
    ];

    return (
        <div className="qx-card org-meta-panel">
            <div className="org-meta-panel__head">
                <h4 className="org-meta-panel__title">Details</h4>
                <PlanBadge
                    plan={plan}
                    isTrial={planState.isTrial}
                    expired={planState.expired}
                />
            </div>
            <dl className="org-meta-panel__list">
                {rows.map(row => (
                    <div key={row.label} className="org-meta-panel__row">
                        <dt className="org-meta-panel__label">{row.label}</dt>
                        <dd className={`org-meta-panel__value${row.mono ? ' org-meta-panel__value--mono' : ''}`}>
                            <span className="org-meta-panel__value-text" title={row.value}>{row.value}</span>
                            {row.copyable && <CopyButton value={row.value} label={row.label} />}
                        </dd>
                    </div>
                ))}
            </dl>
        </div>
    );
}
