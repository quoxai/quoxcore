import { safeCompare } from './crypto.js';

function getClientIp(req) {
    return req?.ip || req?.connection?.remoteAddress || req?.socket?.remoteAddress || '';
}

export function isLocalInternalAddress(ip = '') {
    const match172 = String(ip).match(/^(?:::ffff:)?172\.(\d{1,3})\./);
    const secondOctet = match172 ? Number(match172[1]) : null;

    return ip === '127.0.0.1'
        || ip === '::1'
        || ip === '::ffff:127.0.0.1'
        || (secondOctet !== null && secondOctet >= 16 && secondOctet <= 31);
}

export function hasValidInternalServiceKey(req, expectedKey = process.env.INTERNAL_SERVICE_KEY) {
    const serviceKey = req?.headers?.['x-service-key'];
    if (!expectedKey || !serviceKey) return false;
    return safeCompare(serviceKey, expectedKey);
}

export function authorizeInternalServiceRequest(req, options = {}) {
    const {
        requireServiceKeyWhenConfigured = true,
        allowLocalFallbackWithoutKey = true,
    } = options;

    const expectedKey = process.env.INTERNAL_SERVICE_KEY;
    const clientIp = getClientIp(req);

    if (expectedKey && hasValidInternalServiceKey(req, expectedKey)) {
        return { authorized: true, reason: 'service_key', clientIp };
    }

    if (!expectedKey && allowLocalFallbackWithoutKey && isLocalInternalAddress(clientIp)) {
        return { authorized: true, reason: 'local_fallback', clientIp };
    }

    if (expectedKey && !requireServiceKeyWhenConfigured && isLocalInternalAddress(clientIp)) {
        return { authorized: true, reason: 'local_with_configured_key', clientIp };
    }

    return { authorized: false, reason: expectedKey ? 'missing_or_invalid_service_key' : 'non_local_request', clientIp };
}
