/**
 * VaultCredentialsView — QuoxVault Credential Management
 *
 * Full-page credential list at /vault/credentials.
 * Wraps the existing IntegrationsVault component with page-level chrome.
 * Phase 2 will rewrite IntegrationsVault to a full-page layout.
 */

import { useWorkspace } from '../../contexts/WorkspaceContext';
import { IntegrationsVault } from '../../components/integrations';
import '../../components/vault/vault.css';

export default function VaultCredentialsView() {
    const { currentOrg, orgs } = useWorkspace();

    if (!currentOrg?.id) {
        return (
            <div className="vault-page">
                <div className="vault-page__empty">
                    Select an organization to manage credentials.
                </div>
            </div>
        );
    }

    return (
        <div className="vault-page">
            <IntegrationsVault orgId={currentOrg.id} orgs={orgs} />
        </div>
    );
}
