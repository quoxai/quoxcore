/**
 * QUOXON A2: tell the collector its per-org connector tool-list cache is stale
 * after a vault credential write (create / update / delete / rotate / set
 * default / copy). Without this a new credential waits out the collector's
 * 60 s TTL before its connector's tools reach a chat turn.
 *
 * Also clears this service's own credential resolver cache (30 s), because the
 * collector's rebuild reads through it: invalidating the collector alone would
 * just re-cache the stale answer. Not every write route cleared it before.
 *
 * Best effort and non-blocking: writes are coalesced for 250 ms into one POST,
 * a failure is logged (the TTL still bounds staleness), and nothing is sent
 * under a test runner.
 */
const COALESCE_MS = 250;
let _timer = null;

function collectorUrl() {
    return process.env.COLLECTOR_URL || process.env.QUOX_COLLECTOR_URL || 'http://collector:9848';
}

async function flush() {
    _timer = null;
    try {
        const { clearCache } = await import('../services/credentialResolver.js');
        clearCache();
    } catch (err) {
        console.warn(`[ConnectorToolsCache] resolver cache clear failed: ${err.message}`);
    }
    const serviceKey = process.env.INTERNAL_SERVICE_KEY || '';
    try {
        const resp = await fetch(`${collectorUrl()}/api/internal/connectors/invalidate-tools-cache`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(serviceKey ? { 'X-Service-Key': serviceKey } : {}),
            },
            body: JSON.stringify({}),
            signal: AbortSignal.timeout(3000),
        });
        if (!resp.ok) console.warn(`[ConnectorToolsCache] collector invalidate returned ${resp.status}`);
    } catch (err) {
        console.warn(`[ConnectorToolsCache] collector invalidate failed: ${err.message}`);
    }
}

export function notifyConnectorCredentialsChanged() {
    if (process.env.VITEST || process.env.NODE_ENV === 'test') return;
    if (_timer) return;
    _timer = setTimeout(flush, COALESCE_MS);
    if (typeof _timer.unref === 'function') _timer.unref();
}
