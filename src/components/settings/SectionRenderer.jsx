/**
 * SectionRenderer — SET-IA Phase 3.
 *
 * Renders the right component for a given settings section ID under
 * the V2 IA. The Phase 1 registry stores logical mappings (component
 * names as strings); this file resolves them to actual React imports.
 *
 * Lazy-imports per section to keep the initial settings bundle small.
 *
 * Org panels reuse the existing components in src/components/org/
 * unchanged; they take ({ orgId, isAdmin }) props which we wire from
 * useResolvedCapabilities + WorkspaceContext.
 */

import { Suspense, lazy, useMemo } from 'react';
import { useWorkspace } from '../../contexts/WorkspaceContext.jsx';
import { useResolvedCapabilities } from '../../hooks/useResolvedCapabilities.js';
import { canEditSection, getSectionById } from '../../config/settingsSections.js';
// LICENSE-LAUNCH LL-7 local-inference strip: the Local Inference section is a
// PREMIUM settings section now. Core keeps the row + this renderer entry (a
// section that silently vanished would be indistinguishable from a broken
// build); the panel's code ships in the signed local-inference bundle and
// registers itself as 'settings.local-inference' on activation. Re-adding a
// lazy() import of LocalInferenceSettings here un-strips a paid plugin, and
// both eslint.config.js and scripts/check-dist-clean.mjs fail on it now.
import { CapabilityPanelSlot } from '../../config/capabilityPanelRegistry.js';

// ── Account scope ──────────────────────────────────────────────────
const AccountProfilePanel   = lazy(() => import('./AccountProfilePanel.jsx'));
const AppearanceSettings     = lazy(() => import('./AppearanceSettings.jsx'));
const VoiceSettings          = lazy(() => import('./VoiceSettings.jsx'));
const CoreCommsSettings      = lazy(() => import('./CoreCommsSettings.jsx'));
const PrivacySettings        = lazy(() => import('./PrivacySettings.jsx'));
const DataRetentionSettings  = lazy(() => import('./DataRetentionSettings.jsx'));
// PluginSettings (the full plugin manager) is no longer rendered in Settings —
// it lives only on the /plugins dashboard now. The Settings tab shows a link.
const PluginsSettingsLink    = lazy(() => import('./PluginsSettingsLink.jsx'));
// CoreIntegrations is now rendered inside ProviderKeysPanel rather
// than at its own section; keeping the import here would be a
// dead reference.
// LocalInferenceSettings is NOT lazy-imported here any more — see the
// CapabilityPanelSlot import above and the 'account/local-inference' entry.
const BackupSettings         = lazy(() => import('./BackupSettings.jsx'));
const ClaudeDesktopInstall   = lazy(() => import('./ClaudeDesktopInstall.jsx'));
const MCPCredentialsPanel    = lazy(() => import('./MCPCredentialsPanel.jsx'));
// SET-IA parity-restoration panels (V1 sections recovered)
const QuoxMindPanel          = lazy(() => import('../../pages/settings/account/QuoxMindPanel.jsx'));
const Brain2Settings         = lazy(() => import('./Brain2Settings.jsx'));
const NotesQSettings         = lazy(() => import('./NotesQSettings.jsx'));
const ServicesPanel          = lazy(() => import('../../pages/settings/account/ServicesPanel.jsx'));
const InfrastructurePanel    = lazy(() => import('../../pages/settings/account/InfrastructurePanel.jsx'));
const TelemetryPanel         = lazy(() => import('../../pages/settings/account/TelemetryPanel.jsx'));
const DocsPanel              = lazy(() => import('../../pages/settings/account/DocsPanel.jsx'));
const GeneralPanel           = lazy(() => import('../../pages/settings/account/GeneralPanel.jsx'));
const AssistantsPanel        = lazy(() => import('../../pages/settings/account/AssistantsPanel.jsx'));

// ── Org scope ──────────────────────────────────────────────────────
const OrgRolesPanel       = lazy(() => import('../org/OrgRolesPanel.jsx'));
const OrgSecurityPanel    = lazy(() => import('../org/OrgSecurityPanel.jsx'));
const OrgSsoPanel         = lazy(() => import('../org/OrgSsoPanel.jsx'));
const OrgDomainsPanel     = lazy(() => import('../org/OrgDomainsPanel.jsx'));
const OrgSecretsPanel     = lazy(() => import('../org/OrgSecretsPanel.jsx'));
const OrgWebhooksPanel    = lazy(() => import('../org/OrgWebhooksPanel.jsx'));
const OrgScimTokensPanel  = lazy(() => import('../org/OrgScimTokensPanel.jsx'));
const OrgAgentMatrixPanel = lazy(() => import('../org/OrgAgentMatrixPanel.jsx'));
const OrgActivityPanel    = lazy(() => import('../org/OrgActivityPanel.jsx'));
const OrgMembersGrid      = lazy(() => import('../org/OrgMembersGrid.jsx'));
const ExecutionPolicySettings = lazy(() => import('./ExecutionPolicySettings.jsx'));
const RouterSettings          = lazy(() => import('../router/RouterSettings.jsx'));

// ── Instance scope ─────────────────────────────────────────────────
const AuthSessionsPanel       = lazy(() => import('../../pages/settings/instance/AuthSessionsPanel.jsx'));
const EmailSmtpPanel          = lazy(() => import('../../pages/settings/instance/EmailSmtpPanel.jsx'));
const RetentionDefaultsPanel  = lazy(() => import('../../pages/settings/instance/RetentionDefaultsPanel.jsx'));
const OrgPolicyPanel          = lazy(() => import('../../pages/settings/instance/OrgPolicyPanel.jsx'));
const InstanceAdminsPanel     = lazy(() => import('../../pages/settings/instance/InstanceAdminsPanel.jsx'));
const EncryptionPanel         = lazy(() => import('../../pages/settings/instance/EncryptionPanel.jsx'));
const ProviderKeysPanel       = lazy(() => import('../../pages/settings/instance/ProviderKeysPanel.jsx'));
const QuoxperticusPanel       = lazy(() => import('../../pages/settings/instance/QuoxperticusPanel.jsx'));
const ServerBackupPanel       = lazy(() => import('../../pages/settings/instance/ServerBackupPanel.jsx'));
const InstanceSettingsPanel   = lazy(() => import('../../pages/settings/instance/InstanceSettingsPanel.jsx'));
const QlusterSettings         = lazy(() => import('./QlusterSettings.jsx'));
const DeviceActivationPanel   = lazy(() => import('./DeviceActivationPanel.jsx'));
const QuoxVerifiedSettings     = lazy(() => import('./QuoxVerifiedSettings.jsx'));

// Maps section.id → render(props) that returns a React element.
// Returning a function (not a JSX literal) lets us pass scope-derived
// props lazily without instantiating components for unrouted sections.
const SECTION_ELEMENTS = {
    // ── Account ────────────────────────────────────────────────────
    'account/profile':         () => <AccountProfilePanel />,
    'account/appearance':      () => <AppearanceSettings />,
    'account/voice':           () => <VoiceSettings />,
    'account/notifications':   () => <CoreCommsSettings />,
    'account/privacy':         () => <PrivacySettings />,
    'account/retention':       () => (
        // DataRetentionSettings doesn't self-pad against the page; wrap.
        <div style={{ padding: 24, maxWidth: 980 }}>
            <DataRetentionSettings />
        </div>
    ),
    'account/plugins':         () => <PluginsSettingsLink />,
    // account/integrations gone (was a misclassified instance-level
    // panel). CoreIntegrations now renders inside ProviderKeysPanel
    // as the "Advanced setup" subsection at instance/provider-keys.
    // Entitled: the real panel, carried by the signed local-inference bundle.
    // Unentitled: the locked upsell slot, built from metadata alone.
    'account/local-inference': () => <CapabilityPanelSlot capability="settings.local-inference" />,
    'account/backup':          () => <BackupSettings />,
    'account/claude-desktop':  () => <ClaudeDesktopInstall />,
    'account/mcp-credentials': () => <MCPCredentialsPanel />,
    'account/general':          () => <GeneralPanel />,
    'account/assistants':       () => <AssistantsPanel />,
    'account/quoxmind':        () => <QuoxMindPanel />,
    'account/brain2':          () => <Brain2Settings />,
    'account/notesq':          () => <NotesQSettings />,
    'account/services':        () => <ServicesPanel />,
    'account/infrastructure':  () => <InfrastructurePanel />,
    'account/telemetry':       () => <TelemetryPanel />,
    'account/docs':            () => <DocsPanel />,

    // ── Organization ───────────────────────────────────────────────
    // org/general / org/members / org/activity were hidden from the
    // registry in the Phase 8 hotfix — their backing panels need
    // OrgDashboardLayout's pre-fetched data. They live on /orgs/:id.
    'org/roles':         ({ orgId, isAdmin }) => <OrgRolesPanel orgId={orgId} isAdmin={isAdmin} />,
    'org/security':      ({ orgId, isAdmin }) => <OrgSecurityPanel orgId={orgId} isAdmin={isAdmin} />,
    'org/sso':           ({ orgId, isAdmin }) => <OrgSsoPanel orgId={orgId} isAdmin={isAdmin} />,
    'org/domains':       ({ orgId, isAdmin }) => <OrgDomainsPanel orgId={orgId} isAdmin={isAdmin} />,
    'org/secrets':       ({ orgId, isAdmin }) => <OrgSecretsPanel orgId={orgId} isAdmin={isAdmin} />,
    'org/webhooks':      ({ orgId, isAdmin }) => <OrgWebhooksPanel orgId={orgId} isAdmin={isAdmin} />,
    'org/scim':          ({ orgId, isAdmin }) => <OrgScimTokensPanel orgId={orgId} isAdmin={isAdmin} />,
    'org/agent-matrix':  ({ orgId, isAdmin }) => <OrgAgentMatrixPanel orgId={orgId} isAdmin={isAdmin} />,
    'org/execution':     () => <ExecutionPolicySettings />,
    'org/router':        () => <RouterSettings />,

    // ── Instance ───────────────────────────────────────────────────
    'instance/auth':          () => <AuthSessionsPanel />,
    'instance/email':         () => <EmailSmtpPanel />,
    'instance/retention':     () => <RetentionDefaultsPanel />,
    'instance/org-policy':    () => <OrgPolicyPanel />,
    'instance/provider-keys': () => <ProviderKeysPanel />,
    'instance/admins':        () => <InstanceAdminsPanel />,
    'instance/encryption':    () => <EncryptionPanel />,
    'instance/quoxperticus':  () => <QuoxperticusPanel />,
    'instance/backups':       () => <ServerBackupPanel />,
    'instance/licensing':     () => (
        <>
            <DeviceActivationPanel />
            {/* LL-9i3: Quox Verified is a licensing-scoped, instance-wide toggle,
                so its settings surface lives alongside device activation. */}
            <div style={{ padding: '0 24px 24px', maxWidth: 980 }}>
                <QuoxVerifiedSettings />
            </div>
        </>
    ),
    'instance/env-settings':  () => <InstanceSettingsPanel />,
    'instance/qluster':       ({ isAdmin }) => <QlusterSettings isAdmin={isAdmin} />,
};

function Placeholder({ title, body, editable }) {
    return (
        <div style={{ padding: 24, maxWidth: 720 }}>
            <h2 style={{ marginTop: 0 }}>{title}</h2>
            <p style={{ opacity: 0.75 }}>{body}</p>
            {editable === false && (
                <p style={{ opacity: 0.6, fontSize: 12 }}>Read-only — your role does not grant edit access.</p>
            )}
        </div>
    );
}

function InstancePlaceholder({ title, body }) {
    return (
        <div style={{ padding: 24, maxWidth: 720 }}>
            <h2 style={{ marginTop: 0 }}>{title}</h2>
            <p style={{ opacity: 0.75 }}>{body}</p>
            <p style={{ opacity: 0.5, fontSize: 12 }}>SET-IA Phase 4 — pending.</p>
        </div>
    );
}

function NotFound({ id }) {
    return (
        <div style={{ padding: 24 }}>
            <h2 style={{ marginTop: 0 }}>Section not found</h2>
            <p style={{ opacity: 0.7 }}>
                <code>{id}</code> is not a registered settings section.
            </p>
        </div>
    );
}

function NoSelection() {
    return (
        <div style={{ padding: 24, opacity: 0.7 }}>
            <p>Pick a section from the sidebar.</p>
        </div>
    );
}

export default function SectionRenderer({ sectionId }) {
    const { currentOrg } = useWorkspace();
    const { principal } = useResolvedCapabilities();

    const section = useMemo(() => sectionId ? getSectionById(sectionId) : null, [sectionId]);

    if (!sectionId) return <NoSelection />;
    if (!section)   return <NotFound id={sectionId} />;

    const renderFn = SECTION_ELEMENTS[sectionId];
    if (!renderFn) {
        return <Placeholder title={section.label}
            body={`No renderer wired for ${sectionId} yet.`} />;
    }

    const props = {
        orgId: currentOrg?.id || null,
        isAdmin: canEditSection(section, principal),
    };

    return (
        <Suspense fallback={<div style={{ padding: 24, opacity: 0.6 }}>Loading…</div>}>
            {renderFn(props)}
        </Suspense>
    );
}

// Test helper — exposes the registered section IDs.
export const _registeredSectionIds = Object.keys(SECTION_ELEMENTS);
