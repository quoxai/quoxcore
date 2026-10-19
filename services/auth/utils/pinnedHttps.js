/**
 * Fingerprint-pinned HTTPS GET for self-signed targets (Proxmox).
 *
 * A stock Proxmox ships a self-signed certificate, so a verifying fetch dies
 * with "fetch failed" before the API token is even looked at. This accepts the
 * certificate ONLY when its SHA-256 fingerprint equals the pinned value, and it
 * holds the request (and therefore the Authorization header) back until that
 * check has passed: the socket is corked at creation and uncorked on a match,
 * destroyed on a mismatch, so a credential is never written to an unpinned
 * peer. Same approach as services/collector/lib/proxmoxApi.js getPveAgent.
 *
 * Never follows redirects. Never returns or logs request headers.
 */

import https from 'node:https';

export class PinError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'PinError';
        this.code = code;
    }
}

export function normalizeFingerprint(fp) {
    return String(fp || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
}

export function fingerprintMatches(expected, actual) {
    const e = normalizeFingerprint(expected);
    const a = normalizeFingerprint(actual);
    return e.length === 64 && a.length === 64 && e === a;
}

/**
 * @returns {Promise<{status:number, body:string}>}
 * @throws {PinError} tls_fingerprint_mismatch | timeout | network_error
 */
export function pinnedGet(url, headers, fingerprint, { timeoutMs = 15000, maxBytes = 1024 * 1024 } = {}) {
    const target = new URL(url);
    // maxCachedSessions:0 = a fresh full handshake every time. A resumed TLS
    // session carries no certificate, which would make a correct pin look wrong.
    const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: false, maxCachedSessions: 0 });
    const origCreate = agent.createConnection.bind(agent);
    agent.createConnection = function createPinnedConnection(options, cb) {
        const socket = origCreate({ ...options, session: undefined }, cb);
        if (socket && typeof socket.cork === 'function') {
            socket.cork();
            socket.once('secureConnect', () => {
                let cert = null;
                try { cert = socket.getPeerCertificate(); } catch { cert = null; }
                if (fingerprintMatches(fingerprint, cert && cert.fingerprint256)) socket.uncork();
                else socket.destroy(new PinError('tls_fingerprint_mismatch', 'Certificate fingerprint does not match the pinned tls_fingerprint'));
            });
        }
        return socket;
    };

    return new Promise((resolve, reject) => {
        const req = https.request({
            method: 'GET',
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || 443,
            path: `${target.pathname}${target.search}`,
            headers,
            agent,
            timeout: timeoutMs,
        }, (resp) => {
            let buf = '';
            resp.setEncoding('utf8');
            resp.on('data', (c) => { buf += c; if (buf.length > maxBytes) req.destroy(new PinError('network_error', 'Response too large')); });
            resp.on('end', () => { agent.destroy(); resolve({ status: resp.statusCode, body: buf }); });
            resp.on('error', (e) => { agent.destroy(); reject(e); });
        });
        req.on('timeout', () => req.destroy(new PinError('timeout', `No answer within ${timeoutMs}ms`)));
        req.on('error', (e) => {
            agent.destroy();
            reject(e instanceof PinError ? e : new PinError('network_error', `Request failed: ${e.code || e.message}`));
        });
        req.end();
    });
}
