/**
 * Workspace Sidebar Component
 * Navigation sidebar for workspace sections
 */

import { NavLink } from 'react-router-dom';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import OrgSelector from './OrgSelector';
import ScopePicker from './ScopePicker';
import './workspace.css';

const NAV_ITEMS = [
    { path: '/workspace', label: 'Overview', icon: '[=]', exact: true },
    { path: '/workspace/directory', label: 'Directory', icon: '{}' },
    { divider: true, label: 'Assets' },
    { path: '/workspace/tools', label: 'Tools', icon: '<>' },
    { path: '/workspace/workflows', label: 'Workflows', icon: '>>' },
    { path: '/workspace/assistants', label: 'Assistants', icon: '@' },
    { divider: true, label: 'Organization' },
    { path: '/workspace/divisions', label: 'Divisions', icon: '||' },
    { path: '/workspace/teams', label: 'Teams', icon: '##' },
    { path: '/workspace/members', label: 'Members', icon: '()' },
    { divider: true, label: 'Settings' },
    { path: '/workspace/settings', label: 'Settings', icon: '*' },
    { path: '/workspace/audit', label: 'Audit Log', icon: '~' },
];

export default function WorkspaceSidebar() {
    const { currentOrg, isOrgAdmin } = useWorkspace();

    return (
        <aside className="workspace-sidebar">
            <div className="sidebar-header">
                <OrgSelector />
            </div>

            <div className="sidebar-scope">
                <label className="scope-label">Scope Lens</label>
                <ScopePicker />
            </div>

            <nav className="sidebar-nav">
                {NAV_ITEMS.map((item, index) => {
                    if (item.divider) {
                        return (
                            <div key={`divider-${index}`} className="nav-divider">
                                <span>{item.label}</span>
                            </div>
                        );
                    }

                    // Hide admin-only items
                    if (item.adminOnly && !isOrgAdmin) {
                        return null;
                    }

                    // Only disable asset/org-specific pages when no org selected
                    // Always allow access to Overview, Settings, and Home
                    const requiresOrg = !['/workspace', '/workspace/settings'].includes(item.path);
                    const isDisabled = requiresOrg && !currentOrg;

                    return (
                        <NavLink
                            key={item.path}
                            to={item.path}
                            end={item.exact}
                            className={({ isActive }) =>
                                `nav-item ${isActive ? 'active' : ''} ${isDisabled ? 'disabled' : ''}`
                            }
                        >
                            <span className="nav-icon">{item.icon}</span>
                            <span className="nav-label">{item.label}</span>
                        </NavLink>
                    );
                })}
            </nav>

            <div className="sidebar-footer">
                <NavLink to="/" className="nav-item home-link">
                    <span className="nav-icon">{'<-'}</span>
                    <span className="nav-label">Back to Dashboard</span>
                </NavLink>
            </div>
        </aside>
    );
}
