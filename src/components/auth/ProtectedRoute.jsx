/**
 * ProtectedRoute - Route guard component for role-based access control
 *
 * Wraps route content and checks user's org role before rendering.
 * If no org is selected, shows AccessDenied (fail-closed).
 */

import { useWorkspace } from '../../contexts/WorkspaceContext';
import { hasRoleLevel, hasCapability } from '../../lib/policy';
import AccessDenied from './AccessDenied';

/**
 * @param {Object} props
 * @param {string} [props.minRole] - Minimum role required (e.g. 'admin', 'builder')
 * @param {string} [props.capability] - Specific capability required (e.g. 'org.manage_members')
 * @param {boolean} [props.auditorAllowed] - If true, the 'auditor' role bypasses minRole check.
 *                                           Auditor is cross-cutting — not in the numeric
 *                                           hierarchy — so must be explicitly allowed on
 *                                           governance routes.
 * @param {React.ReactNode} props.children - Content to render if authorized
 */
export default function ProtectedRoute({ minRole, capability, auditorAllowed, children }) {
    const { currentOrg, loading } = useWorkspace();
    const role = currentOrg?.membership?.role;

    // Still loading org context — don't flash AccessDenied
    if (loading) {
        return null;
    }

    // No org selected — fail-closed, don't render protected content
    if (!currentOrg || !role) {
        return <AccessDenied />;
    }

    // AUD-WS-2: auditor bypass for flagged governance routes.
    // Only applies when auditorAllowed=true AND the user's role is 'auditor'.
    // Write-capability checks inside views still gate any destructive UI.
    const isAuditorPass = auditorAllowed === true && role === 'auditor';

    // Check minRole if specified (auditor bypasses if flagged)
    if (minRole && !isAuditorPass && !hasRoleLevel(role, minRole)) {
        return <AccessDenied />;
    }

    // Check capability if specified
    if (capability && !hasCapability(role, capability)) {
        return <AccessDenied />;
    }

    return children;
}
