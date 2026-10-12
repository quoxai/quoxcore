/**
 * jumpHostConfig — the ONE reader/writer for the org Jump Host setting
 * (quox#541). InfrastructurePanel writes it; BastionPanel's quick-connect
 * reads it instead of hardcoding host=gw-01, so a tenant whose bastion
 * is not called gw-01 connects to THEIR jump host.
 *
 * Honest residual (flagged on quox#541): persistence is still the V1
 * localStorage key. An org infrastructure setting belongs server-side
 * (org_platform_settings) per the zero-tolerance persistence rule; when that
 * migration happens it happens HERE, and both surfaces inherit it.
 */

export const JUMPHOST_STORAGE_KEY = 'quox-jumphost-config';

export const DEFAULT_JUMPHOST = {
    enabled:  false,
    hostname: 'gw-01',
    ip:       '',
    user:     'control',
};

export function loadJumpHost() {
    if (typeof window === 'undefined') return DEFAULT_JUMPHOST;
    try {
        const raw = window.localStorage.getItem(JUMPHOST_STORAGE_KEY);
        if (!raw) return DEFAULT_JUMPHOST;
        return { ...DEFAULT_JUMPHOST, ...JSON.parse(raw) };
    } catch {
        return DEFAULT_JUMPHOST;
    }
}

export function saveJumpHost(cfg) {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(JUMPHOST_STORAGE_KEY, JSON.stringify(cfg));
    } catch { /* ignore quota errors */ }
}

/**
 * The host the bastion quick-connect should target: the configured jump
 * host when the setting is enabled and carries a hostname, else the
 * install default.
 */
export function resolveBastionHost() {
    const cfg = loadJumpHost();
    if (cfg.enabled && cfg.hostname && String(cfg.hostname).trim()) {
        return String(cfg.hostname).trim();
    }
    return DEFAULT_JUMPHOST.hostname;
}
