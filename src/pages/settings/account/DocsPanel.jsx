/**
 * DocsPanel — SET-IA parity restoration.
 *
 * V1 had this at /settings#docs as a mix of compliance/architecture
 * reference content + quick links. Restored as a focused link list
 * pointing at the canonical surfaces (Test Lab, Compliance, Activity)
 * plus a short architecture explainer. Marketing-style content moved
 * to the website docs.
 */

import { Link } from 'react-router-dom';
import SettingsSection from '../../../components/settings/SettingsSection';
import SettingsCard from '../../../components/settings/SettingsCard';

export default function DocsPanel() {
    return (
        <div style={{ padding: 24, maxWidth: 980 }}>
            <SettingsSection title="Documentation & Compliance"
                description="Quick links to the surfaces backing audit, compliance, and the agent control plane.">

                <SettingsCard glass>
                    <h3 style={{ margin: 0, marginBottom: 8 }}>Audit & evidence</h3>
                    <p style={{ opacity: 0.75, marginTop: 0 }}>
                        Every agent action, settings change, and security event is hash-chained
                        through VOLT and sealed daily by WARD. Evidence bundles export to PDF
                        with redaction and per-control mapping (SOC 2, ISO 27001, EU AI Act).
                    </p>
                    <ul style={{ marginTop: 12 }}>
                        <li><Link to="/activity">Activity log</Link> — live feed of org-scoped audit events</li>
                        <li><Link to="/evidence">Evidence Explorer</Link> — chain-of-custody view per control</li>
                        <li><Link to="/policies">Policies</Link> — capability assignments by role</li>
                        <li><Link to="/ward">WARD chain</Link> — daily seal verification</li>
                    </ul>
                </SettingsCard>

                <SettingsCard glass>
                    <h3 style={{ margin: 0, marginBottom: 8 }}>Architecture reference</h3>
                    <p style={{ opacity: 0.75, marginTop: 0 }}>
                        AOCL (Agent Orchestration Control Layers) is QuoxCORE's 11-layer
                        observability + control stack — every agent operation flows through
                        identity, intent, capability, governance, action, and audit layers.
                    </p>
                    <ul style={{ marginTop: 12 }}>
                        <li><Link to="/topology">Cognitive Topology</Link> — agent + implant graph</li>
                        <li><Link to="/traces">AOCL Traces</Link> — per-request layer waterfall</li>
                        <li><Link to="/test-lab">Test Lab</Link> — run the 126+ compliance tests</li>
                        <li><Link to="/observability">Observability</Link> — service health, logs, errors</li>
                    </ul>
                </SettingsCard>

                <SettingsCard glass>
                    <h3 style={{ margin: 0, marginBottom: 8 }}>External docs</h3>
                    <p style={{ opacity: 0.75, marginTop: 0 }}>
                        Full product documentation, plugin guides, and API references live
                        on the marketing site.
                    </p>
                    <p>
                        <a href="https://quox.ai/docs" target="_blank" rel="noopener noreferrer">
                            quox.ai/docs →
                        </a>
                    </p>
                </SettingsCard>
            </SettingsSection>
        </div>
    );
}
