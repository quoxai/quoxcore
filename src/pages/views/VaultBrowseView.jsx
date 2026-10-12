/**
 * VaultBrowseView — Integration Marketplace
 *
 * Full-page integration browse/discovery at /vault/browse.
 */

import IntegrationsBrowse from '../../components/integrations/IntegrationsBrowse';
import '../../components/vault/vault.css';

export default function VaultBrowseView() {
    return (
        <div className="vault-page">
            <IntegrationsBrowse />
        </div>
    );
}
