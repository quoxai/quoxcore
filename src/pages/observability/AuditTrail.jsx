/**
 * Audit Trail — placeholder.
 *
 * Future: unified view of org audit_events + instance audit (admin
 * actions, encryption rotations, SCIM provisioning) with filters by
 * actor, action, scope, time range. Currently fragmented across
 * OrgActivityPanel and various endpoint logs.
 *
 * Tracked under SET-IA stream, scheduled for a later phase.
 */

export default function AuditTrail() {
    return (
        <div className="observability-page-placeholder" style={{ padding: 24 }}>
            <h2 style={{ marginTop: 0 }}>Audit Trail</h2>
            <p style={{ opacity: 0.7, maxWidth: 600 }}>
                A unified audit view is on the SET-IA roadmap. Today, audit
                events live in two places:
            </p>
            <ul style={{ opacity: 0.7, maxWidth: 600 }}>
                <li>
                    <strong>Org-scoped:</strong> visit{' '}
                    <code>/orgs/&lt;your-org-id&gt;</code> → <em>Activity</em> tab
                    for membership, role, and configuration changes scoped to
                    a single organisation.
                </li>
                <li>
                    <strong>Instance-scoped:</strong> instance-admin actions
                    (key rotation, admin grants, config patches) are recorded
                    server-side via <code>logAdminAccess()</code> — no UI yet.
                </li>
            </ul>
            <p style={{ opacity: 0.5, fontSize: 12 }}>
                Source: docs/STREAM_SET_IA_PLAN.md
            </p>
        </div>
    );
}
