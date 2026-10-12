/**
 * ServicesPanel — SET-IA parity restoration.
 *
 * V1 had this at /settings#services as three stacked sub-panels:
 *   ServiceStatus       — health of connected integrations
 *   CustomServicesPanel — add/manage custom service monitors
 *   AlertRulesPanel     — configure alert conditions
 *
 * Restored as a single section that mounts all three, matching V1
 * placement/order.
 */

import ServiceStatus       from '../../../components/settings/ServiceStatus';
import CustomServicesPanel from '../../../components/settings/CustomServicesPanel';
import AlertRulesPanel     from '../../../components/settings/AlertRulesPanel';

// The three child panels use their own .service-status / .alert-rules
// CSS classes but do NOT self-pad against the page. An outer wrapper
// gives them consistent gutters and breathing room between sections.
export default function ServicesPanel() {
    return (
        <div style={{ padding: 24, maxWidth: 980, display: 'flex', flexDirection: 'column', gap: 24 }}>
            <ServiceStatus />
            <CustomServicesPanel />
            <AlertRulesPanel />
        </div>
    );
}
