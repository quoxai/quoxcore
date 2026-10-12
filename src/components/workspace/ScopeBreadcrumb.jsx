/**
 * Scope Breadcrumb Component
 * Shows the path to the current scope
 */

import { useWorkspace } from '../../contexts/WorkspaceContext';
import './workspace.css';

export default function ScopeBreadcrumb() {
    const { scopePath, navigateToScope, currentOrg } = useWorkspace();

    if (!currentOrg || scopePath.length === 0) {
        return null;
    }

    return (
        <nav className="scope-breadcrumb" aria-label="Scope navigation">
            {scopePath.map((item, index) => (
                <span key={item.id} className="breadcrumb-item">
                    {index > 0 && <span className="breadcrumb-sep">/</span>}
                    <button
                        className={`breadcrumb-link ${index === scopePath.length - 1 ? 'current' : ''}`}
                        onClick={() => navigateToScope(item.id)}
                        disabled={index === scopePath.length - 1}
                    >
                        {item.name_cache}
                    </button>
                </span>
            ))}
        </nav>
    );
}
