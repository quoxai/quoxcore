/**
 * DepartmentManagementView — Thin wrapper around ScopeDashboard for departments.
 *
 * Extracts route params and delegates everything to useScopeData + ScopeDashboard.
 * Adds a "Create Team" page action button in the breadcrumb bar.
 */

import { useEffect } from 'react';
import { useParams, useOutletContext } from 'react-router-dom';
import useScopeData from '../../hooks/useScopeData';
import ScopeDashboard from '../../components/scope/ScopeDashboard';
import Button from '../../components/ui/Button';
import './views.css';

const PlusIcon = () => (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
);

function DepartmentManagementView() {
    const { deptId } = useParams();
    const { setPageActions } = useOutletContext() || {};
    const data = useScopeData({ entityType: 'department', entityId: deptId });

    useEffect(() => {
        if (!data.isAdmin) {
            setPageActions?.(null);
            return () => setPageActions?.(null);
        }
        setPageActions?.(
            <Button variant="primary" onClick={() => data.setShowCreateTeam(true)}>
                <PlusIcon />
                <span style={{ marginLeft: '8px' }}>Create Team</span>
            </Button>
        );
        return () => setPageActions?.(null);
    }, [setPageActions, data.isAdmin, data.setShowCreateTeam]);

    return <ScopeDashboard data={data} />;
}

export default DepartmentManagementView;
