/**
 * InfrastructurePanel — SET-IA parity restoration.
 *
 * V1 had this at /settings#infrastructure as inline JSX in
 * SettingsView.jsx (lines 1147-1246). Two subsections:
 *   1. Jump Host configuration (SSH bastion: hostname / IP / user)
 *   2. Monitoring integrations (Prometheus / Grafana URL display)
 *
 * Persistence mirrors V1: jumpHost config stored in localStorage
 * under `quox-jumphost-config`. Monitoring URLs are read-only
 * (configured at deploy time).
 */

import { useState } from 'react';
import SettingsSection from '../../../components/settings/SettingsSection';
import SettingsCard, { SettingsCardGroup } from '../../../components/settings/SettingsCard';
import { Input, FormField } from '../../../components/ui/Input';
// quox#541: jump host read/write extracted to the shared module so
// BastionPanel's quick-connect reads the SAME setting this panel writes.
import { loadJumpHost, saveJumpHost } from '../../../services/jumpHostConfig';

const DEFAULT_MONITORING = {
    prometheus: { url: 'http://localhost:9090', enabled: false },
    grafana:    { url: 'http://localhost:3000', enabled: false },
};

function validateField(field, value) {
    if (!value) return null;
    if (field === 'hostname' && !/^[a-z0-9-]+(\.[a-z0-9-]+)*$/i.test(value)) {
        return 'Hostname should be alphanumeric with optional dots/hyphens';
    }
    if (field === 'ip' && !/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
        return 'IP should look like 192.168.1.1';
    }
    if (field === 'user' && !/^[a-z_][a-z0-9_-]*$/i.test(value)) {
        return 'User must be a valid Unix username';
    }
    return null;
}

export default function InfrastructurePanel() {
    const [jumpHost, setJumpHost] = useState(loadJumpHost);
    const [errors, setErrors] = useState({});

    const update = (field, value) => {
        const next = { ...jumpHost, [field]: value };
        setJumpHost(next);
        saveJumpHost(next);
        setErrors(e => ({ ...e, [field]: validateField(field, value) }));
    };

    return (
        <div style={{ padding: 24, maxWidth: 980 }}>
            <div role="note" style={{
                padding: 12, borderRadius: 6, marginBottom: 16, fontSize: 13,
                background: 'rgba(56, 189, 248, 0.10)',
                border: '1px solid rgba(56, 189, 248, 0.30)',
                color: '#7dd3fc',
            }}>
                These values are reference configuration only — they're stored
                in your browser. The deploy-time bastion host (set in the
                instance's docker compose / env vars) is what actually routes
                SSH connections. Use this panel to record what the deployed
                values are.
            </div>

            <SettingsSection title="Jump Host Configuration"
                description="Configure SSH bastion host for secure connections">
                <SettingsCard glass>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <input type="checkbox" checked={jumpHost.enabled}
                                onChange={(e) => update('enabled', e.target.checked)} />
                            <div>
                                <div style={{ fontWeight: 600 }}>Enable Jump Host</div>
                                <div style={{ fontSize: 13, color: 'var(--ui-text-secondary)' }}>
                                    Use bastion for SSH connections
                                </div>
                            </div>
                        </label>

                        <FormField label="Hostname" htmlFor="jumphost-hostname" error={errors.hostname}>
                            <Input id="jumphost-hostname" type="text" value={jumpHost.hostname}
                                onChange={(e) => update('hostname', e.target.value)}
                                disabled={!jumpHost.enabled} error={!!errors.hostname}
                                placeholder="e.g., gw-01" />
                        </FormField>

                        <FormField label="IP Address" htmlFor="jumphost-ip" error={errors.ip}>
                            <Input id="jumphost-ip" type="text" value={jumpHost.ip}
                                onChange={(e) => update('ip', e.target.value)}
                                disabled={!jumpHost.enabled} error={!!errors.ip}
                                placeholder="e.g., 198.51.100.247" />
                        </FormField>

                        <FormField label="SSH User" htmlFor="jumphost-user" error={errors.user}>
                            <Input id="jumphost-user" type="text" value={jumpHost.user}
                                onChange={(e) => update('user', e.target.value)}
                                disabled={!jumpHost.enabled} error={!!errors.user}
                                placeholder="e.g., control" />
                        </FormField>
                    </div>
                </SettingsCard>
            </SettingsSection>

            <SettingsSection title="Monitoring Integrations"
                description="Configure connections to monitoring services">
                <SettingsCardGroup>
                    <div className="settings-grid settings-grid--2">
                        <SettingsCard
                            title="Prometheus"
                            status={DEFAULT_MONITORING.prometheus.enabled ? 'success' : 'neutral'}
                            statusText={DEFAULT_MONITORING.prometheus.enabled ? 'Connected' : 'Disabled'}
                            glass compact>
                            <FormField label="URL" htmlFor="prometheus-url">
                                <Input id="prometheus-url"
                                    value={DEFAULT_MONITORING.prometheus.url} readOnly />
                            </FormField>
                        </SettingsCard>

                        <SettingsCard
                            title="Grafana"
                            status={DEFAULT_MONITORING.grafana.enabled ? 'success' : 'neutral'}
                            statusText={DEFAULT_MONITORING.grafana.enabled ? 'Connected' : 'Disabled'}
                            glass compact>
                            <FormField label="URL" htmlFor="grafana-url">
                                <Input id="grafana-url"
                                    value={DEFAULT_MONITORING.grafana.url} readOnly />
                            </FormField>
                        </SettingsCard>
                    </div>
                </SettingsCardGroup>
            </SettingsSection>
        </div>
    );
}
