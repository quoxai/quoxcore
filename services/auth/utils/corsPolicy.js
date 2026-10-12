function parseOriginHost(origin) {
    try {
        return new URL(origin).hostname;
    } catch {
        return null;
    }
}

function parseRequestHost(hostHeader = '') {
    if (!hostHeader) return null;
    const candidate = hostHeader.includes('://') ? hostHeader : `http://${hostHeader}`;
    try {
        return new URL(candidate).hostname;
    } catch {
        return hostHeader.split(':')[0] || null;
    }
}

function isLoopbackHost(hostname = '') {
    return hostname === 'localhost'
        || hostname === '127.0.0.1'
        || hostname === '::1'
        || hostname === '[::1]';
}

function isPrivateIpv4(hostname = '') {
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
    const match172 = hostname.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
    if (match172) {
        const second = Number(match172[1]);
        return second >= 16 && second <= 31;
    }
    return false;
}

function parseDashboardPorts(env = process.env) {
    const raw = env.AUTH_DASHBOARD_PORTS || '3000,3002,3443,5173,443,80';
    return raw
        .split(',')
        .map(port => port.trim())
        .filter(Boolean);
}

function isDashboardOrigin(origin, dashboardPorts = parseDashboardPorts()) {
    if (!origin) return false;

    try {
        const url = new URL(origin);
        const hostname = url.hostname;
        const effectivePort = url.port || (url.protocol === 'https:' ? '443' : '80');

        return dashboardPorts.includes(effectivePort)
            && (isLoopbackHost(hostname) || isPrivateIpv4(hostname));
    } catch {
        return false;
    }
}

function isExplicitlyAllowedOrigin(origin, explicitOrigins = []) {
    return explicitOrigins.includes(origin);
}

function isSetupSafeOrigin(origin, requestHost, explicitOrigins = []) {
    if (!origin) return true;
    if (isExplicitlyAllowedOrigin(origin, explicitOrigins)) return true;

    const originHost = parseOriginHost(origin);
    const requestHostname = parseRequestHost(requestHost);

    if (!originHost) return false;
    if (requestHostname && originHost === requestHostname) return true;
    if (isLoopbackHost(originHost)) return true;
    if (isPrivateIpv4(originHost)) return true;

    return false;
}

export function isAllowedCorsOrigin({
    origin,
    requestHost,
    explicitOrigins = [],
    setupComplete = true,
}) {
    if (!origin) {
        return { allowed: true, reason: 'no_origin' };
    }

    if (isExplicitlyAllowedOrigin(origin, explicitOrigins)) {
        return { allowed: true, reason: 'explicit_origin' };
    }

    const originHost = parseOriginHost(origin);
    const requestHostname = parseRequestHost(requestHost);

    if (originHost && requestHostname && originHost === requestHostname) {
        return { allowed: true, reason: 'same_host' };
    }

    if (isDashboardOrigin(origin)) {
        return { allowed: true, reason: 'dashboard_origin' };
    }

    if (!setupComplete && isSetupSafeOrigin(origin, requestHost, explicitOrigins)) {
        return { allowed: true, reason: 'setup_safe_origin' };
    }

    return { allowed: false, reason: 'origin_not_allowed' };
}

export {
    parseOriginHost,
    parseRequestHost,
    isLoopbackHost,
    isPrivateIpv4,
    parseDashboardPorts,
    isDashboardOrigin,
    isSetupSafeOrigin,
};
