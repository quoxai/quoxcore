/**
 * OrgManagementView — /orgs/:orgId route.
 *
 * Hydrates scope data via useScopeData, delegates rendering to
 * OrgDashboardLayout. Division/Department views still use
 * ScopeDashboard until their own layouts land.
 */

import { useEffect } from 'react';
import { useParams, useOutletContext } from 'react-router-dom';
import useScopeData from '../../hooks/useScopeData';
import OrgDashboardLayout from '../../components/org/OrgDashboardLayout';
import Button from '../../components/ui/Button';
import './views.css';

const PlusIcon = () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
);

function OrgManagementView() {
    const { orgId } = useParams();
    const { setPageActions } = useOutletContext() || {};
    const data = useScopeData({ entityType: 'org', entityId: orgId });

    useEffect(() => {
        if (!data.isAdmin) {
            setPageActions?.(null);
            return () => setPageActions?.(null);
        }
        setPageActions?.(
            <Button variant="primary" onClick={() => data.setShowCreateChild(true)}>
                <PlusIcon />
                <span>Create Division</span>
            </Button>
        );
        return () => setPageActions?.(null);
    }, [setPageActions, data.isAdmin, data.setShowCreateChild]);

    return <OrgDashboardLayout data={data} />;
}

export default OrgManagementView;
