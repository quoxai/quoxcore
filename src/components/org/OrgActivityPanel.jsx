/**
 * OrgActivityPanel — placeholder for org-scoped activity feed.
 *
 * The activity/conversations endpoint exists
 * (/collector/aee/conversations) but does not accept an orgId filter
 * today. Enabling this requires ~3 lines in services/collector/server.js
 * to accept `?orgId=<id>` and filter on `corr LIKE <orgId>_%` in
 * aee_envelopes. Wire that when the enterprise activity stream lands.
 */

const ActivityIcon = () => (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
);

export default function OrgActivityPanel() {
    return (
        <div className="qx-card org-activity-panel org-activity-panel--stub">
            <div className="org-activity-panel__head">
                <div className="org-activity-panel__title-group">
                    <h3 className="org-activity-panel__title">Activity</h3>
                    <span className="org-activity-panel__tag">Enterprise</span>
                </div>
            </div>
            <div className="org-activity-panel__stub-body">
                <div className="org-activity-panel__stub-icon" aria-hidden="true">
                    <ActivityIcon />
                </div>
                <div>
                    <div className="org-activity-panel__stub-title">Organisation-scoped activity feed</div>
                    <p className="org-activity-panel__stub-msg">
                        Recent conversations, audit events and agent actions filtered
                        by this organisation. Landing with the enterprise teams work.
                    </p>
                </div>
            </div>
        </div>
    );
}
