/**
 * Workspace Layout Component
 * Main shell for the workspace with sidebar navigation
 */

import { Outlet, Navigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { WorkspaceSidebar, ScopeBreadcrumb } from '../../components/workspace';
import '../../components/workspace/workspace.css';

export default function WorkspaceLayout() {
    const { isAuthenticated, loading: authLoading } = useAuth();
    const { loading: workspaceLoading, currentOrg } = useWorkspace();

    // Show loading while checking auth
    if (authLoading || workspaceLoading) {
        return (
            <div className="workspace-layout">
                <div className="workspace-main">
                    <div className="workspace-content" style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        height: '100vh'
                    }}>
                        <div className="loading-spinner" />
                    </div>
                </div>
            </div>
        );
    }

    // Redirect to login if not authenticated
    if (!isAuthenticated) {
        return <Navigate to="/login" replace />;
    }

    return (
        <div className="workspace-layout">
            <WorkspaceSidebar />
            <main className="workspace-main">
                <header className="workspace-header">
                    <ScopeBreadcrumb />
                    <div style={{ flex: 1 }} />
                    <div className="search-input">
                        <span className="search-input-icon">[/]</span>
                        <input
                            type="text"
                            placeholder="Search workspace..."
                        />
                    </div>
                </header>
                <div className="workspace-content">
                    <Outlet />
                </div>
            </main>
        </div>
    );
}
