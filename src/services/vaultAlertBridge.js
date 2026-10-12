/**
 * Vault Alert Bridge — QuoxVault Phase 5
 *
 * Bridges vault health scan issues to the server-side HITL inbox.
 * When a health scan detects expiring, expired, or rotation-overdue
 * credentials, this creates inbox items for visibility.
 *
 * Follows the serviceAlertBridge.js pattern:
 * - Dedup Map with 5-minute cooldown per credential+issue
 * - Severity → inbox priority mapping
 * - Prunes stale dedup entries to prevent memory leak
 *
 * Usage:
 *   import { bridgeVaultAlertsToInbox } from './vaultAlertBridge'
 *
 *   const scanResult = await runScan()
 *   bridgeVaultAlertsToInbox(scanResult.issues, { authFetch, orgId })
 */

// Deduplication: track recently bridged vault alerts
// Key: "credentialId:issueType" → timestamp of last bridge
const recentlyBridged = new Map();

// 5-minute dedup window
const DEDUP_COOLDOWN_MS = 5 * 60 * 1000;

// Map scan severity to inbox priority
const SEVERITY_TO_PRIORITY = {
    error: 'urgent',
    warning: 'high',
    info: 'normal'
};

// Human-readable issue descriptions
const ISSUE_LABELS = {
    expired: 'Credential expired',
    expiring: 'Credential expiring soon',
    rotation_overdue: 'Rotation overdue',
    failed: 'Connection test failed',
    untested: 'Never tested',
    stale: 'Not used in 30+ days'
};

/**
 * Check if a vault alert was recently bridged
 */
function isDuplicate(credentialId, issueType) {
    const key = `${credentialId}:${issueType}`;
    const lastBridged = recentlyBridged.get(key);
    if (!lastBridged) return false;
    return (Date.now() - lastBridged) < DEDUP_COOLDOWN_MS;
}

/**
 * Record that a vault alert was bridged
 */
function recordBridge(credentialId, issueType) {
    const key = `${credentialId}:${issueType}`;
    recentlyBridged.set(key, Date.now());

    // Prune old entries to prevent memory leak
    if (recentlyBridged.size > 200) {
        const now = Date.now();
        for (const [k, ts] of recentlyBridged) {
            if (now - ts > DEDUP_COOLDOWN_MS) {
                recentlyBridged.delete(k);
            }
        }
    }
}

/**
 * Build markdown body for a vault alert inbox item
 */
function buildAlertBody(issue) {
    const lines = [
        `**${ISSUE_LABELS[issue.issue] || issue.issue}**`,
        '',
        `- **Type:** ${issue.type || 'unknown'}`,
        `- **Label:** ${issue.label || 'unnamed'}`,
    ];

    if (issue.message) {
        lines.push(`- **Details:** ${issue.message}`);
    }
    if (issue.expires_at) {
        lines.push(`- **Expires:** ${new Date(issue.expires_at).toLocaleDateString()}`);
    }

    return lines.join('\n');
}

/**
 * Bridge vault health scan issues to the server-side inbox
 *
 * @param {Array} issues - Issues from runHealthScan() result
 * @param {Object} options
 * @param {Function} options.authFetch - Authenticated fetch from AuthContext
 * @param {string} options.orgId - Current organization ID
 * @returns {Promise<Array>} Successfully bridged issues
 */
export async function bridgeVaultAlertsToInbox(issues, { authFetch, orgId } = {}) {
    if (!issues || issues.length === 0) return [];
    if (!authFetch || !orgId) return [];

    const bridged = [];

    for (const issue of issues) {
        const credentialId = issue.credentialId || issue.id || 'unknown';
        const issueType = issue.issue || 'unknown';

        // Dedup check
        if (isDuplicate(credentialId, issueType)) continue;

        try {
            const title = `${ISSUE_LABELS[issueType] || issueType}: ${issue.label || issue.type || 'Credential'}`;

            const inboxItem = {
                kind: 'incident',
                priority: SEVERITY_TO_PRIORITY[issue.severity] || 'normal',
                title,
                body_md: buildAlertBody(issue),
                payload: {
                    source: 'vault_health_scan',
                    credential_id: credentialId,
                    integration_type: issue.type,
                    issue_type: issueType,
                    severity: issue.severity,
                    scanned_at: new Date().toISOString()
                }
            };

            await authFetch(`/api/orgs/${orgId}/inbox`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(inboxItem)
            });

            recordBridge(credentialId, issueType);
            bridged.push(issue);
        } catch (err) {
            console.warn(`[VaultAlertBridge] Failed to bridge alert for ${credentialId}:`, err.message || err);
        }
    }

    return bridged;
}

/**
 * Clear dedup state (for testing)
 */
export function clearVaultBridgeState() {
    recentlyBridged.clear();
}

/**
 * Get current dedup state size (for testing/debugging)
 */
export function getVaultBridgeStateSize() {
    return recentlyBridged.size;
}

export default { bridgeVaultAlertsToInbox, clearVaultBridgeState, getVaultBridgeStateSize };
