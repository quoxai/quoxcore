/**
 * settingsSections.js — SET-IA Phase 1 foundation.
 *
 * Declarative registry of every settings section in the unified
 * /settings tree. Single source of truth for:
 *   1. Which sections exist
 *   2. Their scope (account / org / instance)
 *   3. The capability required to *see* each section (read)
 *   4. The capability required to *edit* (write)
 *   5. Plan tier gate (if any)
 *
 * Built sidebar + future route guards (Phase 7) consume this registry
 * via useSettingsSections() to render hidden-not-greyed scope blocks.
 *
 * NOT yet wired to the live SettingsView — the new sidebar is gated
 * behind `?ia=v2` until Phase 7 flips the default.
 *
 * Adjacent files:
 *   - settingsRegistry.js   per-setting metadata for REGULA explainability
 *   - lib/policy.js         Capabilities enum + roleCapabilities matrix
 */

import { Capabilities } from '../lib/policy.js';

// Scopes
export const SCOPE_ACCOUNT  = 'account';
export const SCOPE_ORG      = 'org';
export const SCOPE_INSTANCE = 'instance';

// Plan tiers (gate visibility for Enterprise-only sections etc).
// `null` plan means no plan gate.
export const PLAN_FREE       = 'free';
export const PLAN_TEAM       = 'team';
export const PLAN_ENTERPRISE = 'enterprise';

// Synthetic capabilities scoped to instance role (not in the org
// roleCapabilities matrix because the instance role is a separate
// dimension on instance_admins). Resolved by useResolvedCapabilities
// based on req.user.instanceAdminRole / /api/admin/stats probe.
export const InstanceCapabilities = Object.freeze({
    INSTANCE_VIEW:                 'instance.view',                 // any instance admin tier
    INSTANCE_WRITE:                'instance.write',                // admin or superadmin
    INSTANCE_SUPERADMIN:           'instance.superadmin',           // superadmin only
    INSTANCE_VIEW_OBSERVABILITY:   'instance.view_observability',   // readonly+
});

// Account-scope sections always visible to the logged-in user;
// `read: null` means "no capability gate, just a logged-in user".
const ACCOUNT_SECTIONS = [
    { id: 'account/profile',       label: 'Profile',           order: 10,  read: null, write: null,
      legacyHash: 'account',       component: 'AccountProfilePanel' },
    { id: 'account/general',       label: 'General',           order: 15,  read: null, write: null,
      legacyHash: 'general',       component: 'GeneralPanel' },
    { id: 'account/appearance',    label: 'Appearance',        order: 20,  read: null, write: null,
      legacyHash: 'appearance',    component: 'AppearanceSettings' },
    { id: 'account/voice',         label: 'Voice',             order: 30,  read: null, write: null,
      legacyHash: 'voice',         component: 'VoiceSettings' },
    { id: 'account/notifications', label: 'Notifications',     order: 40,  read: null, write: null,
      legacyHash: 'notifications', component: 'CoreCommsSettings' },
    { id: 'account/privacy',       label: 'Privacy & Consent', order: 50,  read: null, write: null,
      legacyHash: 'privacy',       component: 'PrivacySettings' },
    { id: 'account/retention',     label: 'Data Retention',    order: 60,  read: null, write: null,
      legacyHash: 'files',         component: 'DataRetentionSettings' },
    { id: 'account/plugins',       label: 'Plugins',           order: 70,  read: null, write: null,
      legacyHash: 'plugins',       component: 'PluginSettings' },
    // account/integrations was where CoreIntegrations briefly lived in
    // Phase 1, but CoreIntegrations writes instance-level config and
    // hosts the Claude CLI OAuth flow — not personal data. Moved to
    // instance/setup below; legacy #vault alias follows it there.
    // LICENSE-LAUNCH LL-7 local-inference strip: the first PREMIUM settings
    // section. The ROW stays core metadata — an unentitled org still sees that
    // Local Inference exists and gets the locked upsell — while the panel's
    // code ships in the signed local-inference bundle and registers itself
    // under `premiumCapability` on activation. `component` names the core slot
    // that resolves it, not a component core still holds.
    { id: 'account/local-inference', label: 'Local Inference', order: 90,  read: null, write: null,
      legacyHash: 'local-inference', component: 'CapabilityPanelSlot',
      premiumCapability: 'settings.local-inference' },
    { id: 'account/backup',        label: 'Backup',            order: 100, read: null, write: null,
      legacyHash: 'backup',        component: 'BackupSettings' },
    { id: 'account/claude-desktop', label: 'Claude Desktop',   order: 102, read: null, write: null,
      legacyHash: 'claude-desktop', component: 'ClaudeDesktopInstall',
      description: 'Install MCP bundle for Claude Desktop' },
    { id: 'account/mcp-credentials', label: 'MCP Credentials', order: 103, read: null, write: null,
      legacyHash: 'mcp-credentials', component: 'MCPCredentialsPanel',
      description: 'Per-user MCP tokens for Claude Desktop and other MCP clients' },

    // SET-IA parity restoration: 5 V1 sections that were silently
    // dropped when the registry was first built. Restored to the
    // Account scope where V1 had them so users (especially admins)
    // can find the same functions in /settings.
    { id: 'account/assistants',    label: 'Assistants',        order: 105, read: null, write: null,
      legacyHash: 'assistants',    component: 'AssistantsPanel' },
    { id: 'account/quoxmind',      label: 'QuoxMind',          order: 110, read: null, write: null,
      legacyHash: 'quoxmind',      component: 'QuoxMindPanel' },
    { id: 'account/brain2',        label: 'Qortex',            order: 112, read: null, write: null,
      legacyHash: 'brain2',        component: 'Brain2Settings',
      description: 'Quox Qortex — governed second-brain source feed' },
    { id: 'account/notesq',         label: 'NotesQ',            order: 113, read: null, write: null,
      legacyHash: 'notesq',        component: 'NotesQSettings',
      description: 'NotesQ autosave, default collection, agent edit policy and revision retention' },
    { id: 'account/services',      label: 'Services',          order: 120, read: null, write: null,
      legacyHash: 'services',      component: 'ServicesPanel' },
    { id: 'account/infrastructure', label: 'Infrastructure',   order: 130, read: null, write: null,
      legacyHash: 'infrastructure', component: 'InfrastructurePanel' },
    { id: 'account/telemetry',     label: 'Telemetry',         order: 140, read: null, write: null,
      legacyHash: 'telemetry',     component: 'TelemetryPanel' },
    { id: 'account/docs',          label: 'Docs & Compliance', order: 150, read: null, write: null,
      legacyHash: 'docs',          component: 'DocsPanel' },
];

// Org-scope sections — capability + plan gated.
// `auditorAllowed` mirrors the existing routeRegistry pattern: auditor
// role bypasses the role hierarchy if true, while write capabilities
// inside the panel still gate destructive UI.
//
// org/general, org/members, org/activity are hidden from the V2
// sidebar — their content (org metadata, member directory, activity
// feed) lives on /orgs/:id and the panels there expect pre-fetched
// data from OrgDashboardLayout. A follow-up extracts self-fetching
// versions; until then, the org dashboard is the canonical home.
const ORG_SECTIONS = [
    { id: 'org/roles',        label: 'Roles & Permissions',  order: 30,
      read: Capabilities.ORG_VIEW_AUDIT, write: Capabilities.ORG_MANAGE_ROLES,
      auditorAllowed: true, plan: PLAN_ENTERPRISE,
      legacyPanel: 'OrgRolesPanel', component: 'OrgRolesPanel' },

    { id: 'org/security',     label: 'Security',             order: 40,
      read: Capabilities.ORG_VIEW_AUDIT, write: Capabilities.ORG_MANAGE_SETTINGS,
      auditorAllowed: true, plan: PLAN_ENTERPRISE,
      legacyPanel: 'OrgSecurityPanel', component: 'OrgSecurityPanel' },

    { id: 'org/sso',          label: 'SSO',                  order: 50,
      read: Capabilities.ORG_MANAGE_SSO, write: Capabilities.ORG_MANAGE_SSO,
      auditorAllowed: false, plan: PLAN_ENTERPRISE,
      legacyPanel: 'OrgSsoPanel', component: 'OrgSsoPanel' },

    { id: 'org/domains',      label: 'Domains',              order: 60,
      read: Capabilities.ORG_MANAGE_SETTINGS, write: Capabilities.ORG_MANAGE_SETTINGS,
      auditorAllowed: false, plan: PLAN_TEAM,
      legacyPanel: 'OrgDomainsPanel', component: 'OrgDomainsPanel' },

    { id: 'org/secrets',      label: 'Secrets',              order: 70,
      read: Capabilities.SECRETS_VIEW, write: Capabilities.SECRETS_MANAGE,
      auditorAllowed: true, plan: PLAN_TEAM,
      legacyPanel: 'OrgSecretsPanel', component: 'OrgSecretsPanel' },

    { id: 'org/webhooks',     label: 'Webhooks',             order: 80,
      read: Capabilities.INTEGRATIONS_MANAGE, write: Capabilities.INTEGRATIONS_MANAGE,
      auditorAllowed: false, plan: PLAN_ENTERPRISE,
      legacyPanel: 'OrgWebhooksPanel', component: 'OrgWebhooksPanel' },

    { id: 'org/scim',         label: 'SCIM Provisioning',    order: 90,
      read: Capabilities.INTEGRATIONS_MANAGE, write: Capabilities.INTEGRATIONS_MANAGE,
      auditorAllowed: false, plan: PLAN_ENTERPRISE,
      legacyPanel: 'OrgScimTokensPanel', component: 'OrgScimTokensPanel' },

    { id: 'org/agent-matrix', label: 'Agent Matrix',         order: 100,
      read: Capabilities.AGENTS_VIEW, write: Capabilities.AGENTS_MANAGE,
      auditorAllowed: true, plan: PLAN_ENTERPRISE,
      legacyPanel: 'OrgAgentMatrixPanel', component: 'OrgAgentMatrixPanel' },

    { id: 'org/execution',    label: 'Execution Policy',     order: 110,
      read: Capabilities.ORG_VIEW_AUDIT, write: Capabilities.ORG_MANAGE_SETTINGS,
      auditorAllowed: true, plan: null,
      legacyHash: 'execution-policy', component: 'ExecutionPolicySettings' },

    { id: 'org/router',       label: 'Router Policy',        order: 120,
      read: Capabilities.ORG_VIEW_AUDIT, write: Capabilities.ORG_MANAGE_SETTINGS,
      auditorAllowed: true, plan: null,
      legacyHash: 'router',    component: 'RouterSettings' },

    // org/retention and org/activity removed from V2 sidebar — no
    // self-fetching panels yet. Activity still reachable via
    // /orgs/:id; retention added back when an org-level panel ships.
];

// Instance-scope sections — visible only to instance admins.
// These currently live under /admin/* and migrate to /settings#instance/* in Phase 4.
const INSTANCE_SECTIONS = [
    { id: 'instance/auth',         label: 'Auth & Sessions',   order: 10,
      read: InstanceCapabilities.INSTANCE_VIEW, write: InstanceCapabilities.INSTANCE_WRITE,
      legacyRoute: '/admin/config', component: 'InstanceAuthPanel',
      // Houses the auth.session_*_minutes keys added in commit 418e1d6a.
      keys: ['auth.allow_signup', 'auth.require_email_verification',
             'auth.allowed_email_domains', 'auth.session_idle_minutes',
             'auth.session_max_minutes'] },

    { id: 'instance/email',        label: 'Email & SMTP',      order: 20,
      read: InstanceCapabilities.INSTANCE_VIEW, write: InstanceCapabilities.INSTANCE_WRITE,
      legacyRoute: '/admin/config', component: 'InstanceEmailPanel' },

    { id: 'instance/provider-keys', label: 'Provider Keys',    order: 30,
      read: InstanceCapabilities.INSTANCE_VIEW, write: InstanceCapabilities.INSTANCE_WRITE,
      legacyRoute: '/admin/keys', component: 'InstanceProviderKeysPanel' },

    { id: 'instance/admins',       label: 'Instance Admins',   order: 40,
      read: InstanceCapabilities.INSTANCE_VIEW, write: InstanceCapabilities.INSTANCE_SUPERADMIN,
      legacyRoute: '/admin/admins', component: 'InstanceAdminsPanel' },

    { id: 'instance/retention',    label: 'Retention Defaults', order: 50,
      read: InstanceCapabilities.INSTANCE_VIEW, write: InstanceCapabilities.INSTANCE_WRITE,
      legacyRoute: '/admin/config', component: 'InstanceRetentionPanel',
      keys: ['retention.default_days', 'retention.audit_events_days',
             'retention.cleanup_enabled', 'retention.cleanup_hour'] },

    { id: 'instance/org-policy',   label: 'Org Policy',        order: 60,
      read: InstanceCapabilities.INSTANCE_VIEW, write: InstanceCapabilities.INSTANCE_WRITE,
      legacyRoute: '/admin/config', component: 'InstanceOrgPolicyPanel',
      keys: ['orgs.allow_user_creation', 'orgs.max_per_user',
             'keys.allow_org_override', 'keys.allow_user_byok',
             'keys.default_provider'] },

    { id: 'instance/encryption',   label: 'Encryption',        order: 70,
      read: InstanceCapabilities.INSTANCE_SUPERADMIN, write: InstanceCapabilities.INSTANCE_SUPERADMIN,
      legacyRoute: '/admin/config', component: 'InstanceEncryptionPanel' },

    { id: 'instance/quoxperticus', label: 'Quoxperticus Agent', order: 75,
      read: InstanceCapabilities.INSTANCE_VIEW, write: InstanceCapabilities.INSTANCE_WRITE,
      legacyRoute: '/admin/config', component: 'InstanceQuoxperticusPanel',
      description: 'Resident governed agent mode, disposable sandbox flag, test-approver lease',
      keys: ['instance.mode.quoxperticus', 'instance.disposable_test',
             'instance.test_approver_lease_until', 'instance.quoxperticus.org_id'] },

    // LICENSE-LAUNCH LL-8-dash: activation with no key paste. Instance-scoped
    // because a licence binds THIS instance, same gating as
    // POST /setup/licensing/device/start.
    { id: 'instance/licensing',    label: 'Licensing',         order: 78,
      read: InstanceCapabilities.INSTANCE_VIEW, write: InstanceCapabilities.INSTANCE_WRITE,
      component: 'DeviceActivationPanel',
      description: 'Activate this server by approving a short code on quox.ai' },

    // G2d slice 3: the SERVER-WIDE backup/restore lane (whole box, every org).
    // Read is instance.view so a readonly admin can see runner state and the
    // receipts; the panel itself hides dispatch behind instance.write and
    // restore behind superadmin, matching the per-route gates in
    // services/auth/routes/admin-backups.js. `write` names the tier that can
    // dispatch a backup, NOT the tier that can restore.
    { id: 'instance/backups',      label: 'Server Backups',    order: 79,
      read: InstanceCapabilities.INSTANCE_VIEW, write: InstanceCapabilities.INSTANCE_WRITE,
      component: 'ServerBackupPanel',
      description: 'Server-wide backup and restore through the governed host-side runner' },

    { id: 'instance/env-settings', label: 'Instance settings', order: 79.5,
      read: InstanceCapabilities.INSTANCE_VIEW, write: InstanceCapabilities.INSTANCE_WRITE,
      component: 'InstanceSettingsPanel',
      description: 'Every non-secret setting this instance reads from its environment, with its effective value' },

    { id: 'instance/qluster',      label: 'Qluster',           order: 80,
      read: InstanceCapabilities.INSTANCE_VIEW, write: InstanceCapabilities.INSTANCE_WRITE,
      component: 'QlusterSettings',
      description: 'Enroll external Qluster fleet controllers with scoped tokens' },

    // Note: instance/setup retired. CoreIntegrations is now rendered
    // inside ProviderKeysPanel as an "Advanced setup" subsection so
    // the OAuth + vault picker live alongside the three-scope key view.
];

// Frozen flat registry, ordered by scope+order for stable iteration.
export const SETTINGS_SECTIONS = Object.freeze([
    ...ACCOUNT_SECTIONS .map(s => ({ ...s, scope: SCOPE_ACCOUNT })),
    ...ORG_SECTIONS     .map(s => ({ ...s, scope: SCOPE_ORG })),
    ...INSTANCE_SECTIONS.map(s => ({ ...s, scope: SCOPE_INSTANCE })),
].map(Object.freeze));

// ============================================================================
// Query helpers
// ============================================================================

export function getSectionsByScope(scope) {
    return SETTINGS_SECTIONS.filter(s => s.scope === scope)
                            .sort((a, b) => a.order - b.order);
}

export function getSectionById(id) {
    return SETTINGS_SECTIONS.find(s => s.id === id) || null;
}

/**
 * Filter sections to those the principal can see.
 *
 * @param {Object} principal {
 *   role: org-membership role string (owner/admin/builder/runner/viewer/auditor) | null,
 *   capabilities: Set<string>  — resolved capability set (built-in role ∪ custom role grants),
 *   instanceRole: 'superadmin' | 'admin' | 'readonly' | null,
 *   plan: 'free' | 'team' | 'enterprise' | null,
 * }
 */
export function getVisibleSections(principal) {
    return SETTINGS_SECTIONS.filter(s => isSectionVisible(s, principal))
                            .sort((a, b) => a.scope.localeCompare(b.scope) || a.order - b.order);
}

export function isSectionVisible(section, principal) {
    if (!principal) return false;

    // Account scope: always visible to a logged-in user.
    if (section.scope === SCOPE_ACCOUNT) return true;

    // Org scope: needs a membership role; capability or auditor exception.
    if (section.scope === SCOPE_ORG) {
        if (!principal.role) return false;
        if (!isPlanSatisfied(section.plan, principal.plan)) return false;
        if (section.read == null) return true;
        if (section.auditorAllowed && principal.role === 'auditor') return true;
        return principal.capabilities?.has(section.read) ?? false;
    }

    // Instance scope: needs instanceRole sufficient for the section's read cap.
    if (section.scope === SCOPE_INSTANCE) {
        return instanceRoleSatisfies(principal.instanceRole, section.read);
    }

    return false;
}

export function canEditSection(section, principal) {
    if (!principal) return false;
    if (!isSectionVisible(section, principal)) return false;
    if (section.write == null) {
        // Account-scope sections: writable by the user themselves.
        return section.scope === SCOPE_ACCOUNT;
    }
    if (section.scope === SCOPE_INSTANCE) {
        return instanceRoleSatisfies(principal.instanceRole, section.write);
    }
    // Auditor never writes, even where they read.
    if (principal.role === 'auditor') return false;
    return principal.capabilities?.has(section.write) ?? false;
}

const PLAN_LEVELS = { [PLAN_FREE]: 0, [PLAN_TEAM]: 1, [PLAN_ENTERPRISE]: 2 };
function isPlanSatisfied(required, actual) {
    if (!required) return true;
    if (!actual) return false;
    return (PLAN_LEVELS[actual] ?? -1) >= (PLAN_LEVELS[required] ?? 99);
}

const INSTANCE_ROLE_LEVELS = { readonly: 1, admin: 2, superadmin: 3 };
function instanceRoleSatisfies(role, capability) {
    if (!role) return false;
    const level = INSTANCE_ROLE_LEVELS[role] ?? 0;
    if (capability === InstanceCapabilities.INSTANCE_VIEW)               return level >= 1;
    if (capability === InstanceCapabilities.INSTANCE_VIEW_OBSERVABILITY) return level >= 1;
    if (capability === InstanceCapabilities.INSTANCE_WRITE)              return level >= 2;
    if (capability === InstanceCapabilities.INSTANCE_SUPERADMIN)         return level >= 3;
    return false;
}

export function getScopesVisibleToPrincipal(principal) {
    const out = new Set();
    if (principal) {
        out.add(SCOPE_ACCOUNT);
        if (principal.role) out.add(SCOPE_ORG);
        if (principal.instanceRole) out.add(SCOPE_INSTANCE);
    }
    return out;
}
