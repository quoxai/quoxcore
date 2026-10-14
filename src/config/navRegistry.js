/**
 * Navigation Registry
 *
 * Centralises sidebar navigation configuration. Core sections are defined here
 * (moved from AppShell.jsx). Third-party plugins can register additional nav
 * items at runtime via registerPluginNavItems / unregisterPluginNavItems.
 *
 * Pattern follows extensions.js registerExtension().
 */

// ── Core navigation sections (formerly in AppShell.jsx lines 59-181) ──────

const CORE_NAV_SECTIONS = [
    {
        id: 'home',
        label: 'Home',
        items: [
            { path: '/', label: 'Command', icon: 'eye', exact: true, shortcut: '1' },
            { path: '/dashboard', label: 'Dashboard', icon: 'grid', shortcut: '0' },
            { path: '/mission-control', label: 'Mission Control', icon: 'radar', shortcut: '3', minRole: 'runner' },
            { path: '/activity', label: 'Activity', icon: 'activity', shortcut: '7' },
            // ACAT-6: /schedules consolidated into /triggers?tab=schedules (Triggers is canonical)
            { path: '/triggers', label: 'Triggers', icon: 'zap', minRole: 'runner' },
            // QUOXPERTICUS-REVISIT N1 (owner ruling): Quoxperticus is its own
            // surface, not a Dev Suite subfeature, so it gets a Home row
            // rather than living under Developers next to the dev-servers hub.
            // pluginId gate mirrors every other priced nav row (e.g.
            // /cogcore3d below): hidden from the sidebar for an unlicensed
            // org, same as the rest of dev-servers' surfaces; a direct visit
            // to /quoxperticus renders an honest locked state instead
            // (QuoxperticusLandingView, mirroring QuoxperticusResidentView's
            // own isPluginLicensed('dev-servers') gate).
            { path: '/quoxperticus', label: 'Quoxperticus', icon: 'userCheck', badge: 'NEW', pluginId: 'dev-servers' },
        ]
    },
    {
        // Communications (owner 2026-09-21): a dedicated home for the message/notify
        // surfaces that used to clutter Home. Inbox (HITL approvals + notifications),
        // Matrix Rooms and Live Support live here, and the signed comms plugins
        // (core-comms, telegram-pro, discord-pro) register into this section via
        // OFFICIAL_PLUGIN_SECTION on activation (previously mapped to 'home').
        id: 'communications',
        label: 'Communications',
        items: [
            { path: '/inbox', label: 'Inbox', icon: 'inbox', shortcut: '2' },
            // MATRIX-P4a: Matrix rooms pilot — ungated, no pluginId (like /soc, /noc)
            { path: '/matrix-comms', label: 'Matrix Rooms', icon: 'messageSquare', badge: 'PILOT' },
            // QUOXCHAT-PRO: Live Support desk, works with or without Matrix
            { path: '/live-support', label: 'Live Support', icon: 'headset', badge: 'NEW' },
            // QUOXVOICE-CONSOLE P0: QuoxLine numbers + policy.
            { path: '/quox-voice-console', label: 'QuoxVoice Console', icon: 'phone', badge: 'NEW' },
        ]
    },
    {
        // OFFICE (owner 2026-09-25): the home for the AssistantQ family — the
        // office chief-of-staff agent and its specialists (InboxQ email now;
        // Calendar-Q, FilesQ, MediaQ and the AssistantQ orchestrator as they
        // land). Distinct from Communications (message/notify surfaces) and the
        // internal HITL /inbox approvals queue. Members register here on
        // activation once they are stripped/priced; InboxQ ships in the free
        // build so its static row is the real nav entry.
        id: 'office',
        label: 'Office',
        items: [
            // INBOXQ-1: governed IMAP mailbox triage — distinct from '/inbox',
            // which is the internal HITL approvals/notifications queue.
            { path: '/inboxq', label: 'InboxQ', icon: 'mail', badge: 'NEW', pluginId: 'inboxq' },
            // AQ-9B L2-C1b: Calendar-Q, the second AssistantQ family member.
            { path: '/calendarq', label: 'Calendar-Q', icon: 'calendar', badge: 'NEW', pluginId: 'calendar-q' },
            // NOTESQ-1: markdown notebook (AssistantQ family, bundle-priced).
            { path: '/notes', label: 'NotesQ', icon: 'file-text', badge: 'NEW', pluginId: 'notesq' },
            // CONTACTSQ: governed contacts (core-free).
            { path: '/contacts', label: 'ContactsQ', icon: 'users', badge: 'NEW', pluginId: 'contactsq' },
        ]
    },
    {
        // DEVSUITE-HUB: own rail section (owner ask 2026-08-14, "get it on the
        // sidebar"). Grows per-server drill-in entries as plan-v6 windows land.
        //
        // UPDATED 2026-08-30 (LICENSE-LAUNCH LL-7 dev-servers strip): the
        // 2026-08-21 note below this comment (still visible in git blame) said
        // the /dev-suite hub row must stay static and ungated "whether or not
        // any priced member is licensed" — that finding is SUPERSEDED by the
        // owner-ratified LL-5 classification table (docs/LL5_CLASSIFICATION_
        // TABLE_2026-08-28.md, Group B, "strip, all 32", explicitly including
        // dev-servers). The always-reachable-HUB intent still holds, but it is
        // now met a different way: DevServersHubPanel + DocsPanel moved to
        // src/components/core/devsuite/ (LL-7 extraction 2) and render on the
        // CORE /infra route for every org regardless of licence. The
        // /dev-suite ROUTE itself is a normal gated stripped-plugin surface
        // now (like the other 25 stripped plugins), so its static nav row is
        // gone — the signed dev-servers bundle's own manifest.sidebar
        // registers it on activation, same pattern as action-tracker's /actions
        // row below.
        id: 'dev-suite',
        label: 'Dev Suite',
        // DEVSUITE phase 9 (2026-08-18): priced members were sellable and
        // licensable with no way to FIND them once bought. These entries
        // are pluginId-gated (appear only for an org that enabled that
        // member) and deep-link straight to the member's surface rather
        // than dumping the customer on the hub. Slots and QLoop live at
        // distinct routes/tabs, so they are real destinations, not
        // duplicates of the (now-stripped) hub entry above.
        //
        // LICENSE-LAUNCH LL-7 quoxslots strip (2026-08-31): the Slots row is
        // gone from here. It was already pluginId-gated, so no free org ever
        // saw it, but a static core row for a STRIPPED plugin is the exact
        // shape every other strip in this stream removed — and it named a
        // destination whose panel no longer lives in the free build at all.
        // The signed quoxslots bundle's own manifest.sidebar registers
        // /dev-suite?tab=slots into the Official section on activation, same
        // pattern as the dev-servers /dev-suite row above it.
        items: [
            { path: '/objectives', label: 'QLoop', icon: 'refresh-cw', pluginId: 'qloop', badge: 'NEW' },
        ]
    },
    {
        id: 'work',
        label: 'Work',
        items: [
            { path: '/cli', label: 'Quox CLI', icon: 'terminal', minRole: 'builder' },
            // LICENSE-LAUNCH LL-7 increment 3e: /terminal's rail entry now comes from
            // the signed web-terminal bundle's own manifest.sidebar (registered into
            // the Official section on activation), so the static row here is removed.
            // LICENSE-LAUNCH LL-7 increment 3e: /bastion's rail entry now comes from
            // the signed bastion-fleet bundle's own manifest.sidebar (registered into
            // the Official section on activation), so the static row here is removed.
            { path: '/infra', label: 'QuoxAgents', icon: 'cpu', shortcut: '4', minRole: 'runner' },
            // LICENSE-LAUNCH LL-7 increment 3h: /files's rail entry now comes from
            // the signed files bundle's own manifest.sidebar (registered into the
            // Official section on activation), so the static row here is removed.

            { path: '/archivist', label: 'Archivist', icon: 'archive' },
            { path: '/image-gallery', label: 'Image Gallery', icon: 'image' },
            // LICENSE-LAUNCH LL-7 extraction 1: /actions' rail entry now comes
            // from the signed action-tracker bundle's own manifest.sidebar
            // (registered into the Official section on activation), so the
            // static row here is removed.
            // LICENSE-LAUNCH LL-7 increment 3c: /browser-q's rail entry now comes
            // from the signed browser-q bundle's own manifest.sidebar (registered
            // into the Official section on activation), so the static row here is
            // removed.
            { path: '/quoxmcp', label: 'QuoxMCP', icon: 'cpu', badge: 'NEW' },
            { path: '/gpu-setup', label: 'QuoxGPU', icon: 'cpu', badge: 'NEW', minRole: 'builder' },
        ]
    },
    {
        id: 'monitoring',
        label: 'Monitoring',
        items: [
            { path: '/noc', label: 'NOC', icon: 'activity', description: 'Network Operations Center' },
            // LICENSE-LAUNCH LL-7 extraction 4: the Grafana / Prometheus /
            // Uptime Kuma / Proxmox rail entries now come from each signed
            // bundle's own manifest.sidebar (registered on activation), so the
            // static rows here are removed. /noc above stays: it is core, and it
            // is where the free build still renders the compact Proxmox, metrics,
            // uptime and Grafana panels from src/components/core/monitoring/.
            // LICENSE-LAUNCH LL-7 increment 3f: /wazuh's rail entry now comes from
            // the signed wazuh bundle's own manifest.sidebar (registered into the
            // Official section on activation), so the static row here is removed.
            // LICENSE-LAUNCH LL-7 increment 3c: /docker's rail entry now comes from
            // the signed docker-fleet bundle's own manifest.sidebar (registered into
            // the Official section on activation), so the static row here is removed.
            // LICENSE-LAUNCH LL-7 increment 3h: /tailscale's rail entry now comes from
            // the signed tailscale bundle's own manifest.sidebar (registered into the
            // Official section on activation), so the static row here is removed.

            // LICENSE-LAUNCH LL-7 increment 3h: /routeros's rail entry now comes from
            // the signed mikrotik-routeros bundle's own manifest.sidebar (registered
            // into the Official section on activation), so the static row here is
            // removed. (The pluginId was reconciled to the canonical mikrotik-routeros
            // in the commit just prior to this strip.)

            { path: '/soc', label: 'SOC', icon: 'shield' },
            { path: '/lucid', label: 'LUCID', icon: 'eye', description: 'LUCID · Situation' },
        ]
    },
    {
        id: 'vault',
        label: 'QuoxVault',
        items: [
            { path: '/vault', label: 'Dashboard', icon: 'dashboard' },
            { path: '/vault/browse', label: 'Browse', icon: 'grid' },
            { path: '/vault/credentials', label: 'Credentials', icon: 'key', minRole: 'builder' },
            { path: '/vault/folders', label: 'Folders', icon: 'folder', minRole: 'builder' },
            { path: '/vault/leases', label: 'Leases', icon: 'clock', minRole: 'builder' },
            { path: '/vault/activity', label: 'Vault Activity', icon: 'history', minRole: 'admin' },
        ]
    },
    {
        id: 'organisation',
        label: 'Organisation',
        minRole: 'admin',
        items: [
            { path: '/orgs', label: 'Organisations', icon: 'building' },
            { path: '/divisions', label: 'Divisions', icon: 'layers' },
            { path: '/departments', label: 'Departments', icon: 'briefcase' },
            { path: '/teams', label: 'Human Teams', icon: 'users' },
            // LICENSE-LAUNCH LL-7 increment 3b: /github's rail entry now comes from
            // the signed github bundle's own manifest.sidebar (registered into the
            // Official section on activation), so the static row here is removed.
        ]
    },
    {
        id: 'ai-studio',
        label: 'AI Studio',
        items: [
            { path: '/assistants', label: 'Assistants', icon: 'users' },
            { path: '/agents', label: 'Agents', icon: 'bot', shortcut: '5' },
            // QUOXON J3: every live session (tmux, conversations, slots, work), by agent.
            { path: '/sessions', label: 'Sessions', icon: 'terminal', badge: 'NEW' },
            { path: '/teams-overview', label: 'Agentic Teams', icon: 'network', minRole: 'builder' },
            { path: '/agents/stream', label: 'Agent Stream', icon: 'activity' },
            // Family Tree (/agents/family-tree) removed from the sidebar 2026-09-21:
            // it draws an org-chart of an intentionally FLAT agent hierarchy (one
            // orchestrator + peers), so it reads as a mystery. Route still resolves;
            // its delegation/context views can fold into the Agents detail page later.
            { path: '/tools', label: 'Tools', icon: 'tool', minRole: 'builder' },
            // LICENSE-LAUNCH LL-7 increment 3a: /prompts-library's rail entry now
            // comes from the signed prompts-library bundle's own manifest.sidebar
            // (registered into the Official section on activation), so the static
            // row here is removed to avoid duplicating the icon.
            // STUDY-REV-2 P5.A: three entries collapsed to one hub
            { path: '/workflows-hub', label: 'Workflows', icon: 'git-branch', minRole: 'builder' },
            { path: '/crystals', label: 'Crystals Library', icon: 'tree', badge: 'NEW', minRole: 'builder' },
            { path: '/skills', label: 'Skills', icon: 'book-open', badge: 'NEW', minRole: 'builder' },
            { path: '/skills/review', label: 'Skill Reviews', icon: 'shield', minRole: 'admin' },
            // LICENSE-LAUNCH LL-7 increment 3h: /quoxchat's rail entry now comes from
            // the signed quoxchat bundle's own manifest.sidebar (registered into the
            // Official section on activation), so the static row here is removed.

            // OpsDeck merged into Mission Control Live tab (EX-2)
        ]
    },
    {
        id: 'social',
        label: 'Social',
        items: [
            // LICENSE-LAUNCH LL-7 increment 3d: /linkedin's and /youtube's rail
            // entries now come from their signed bundles' own manifest.sidebar
            // (registered into the Official section on activation), so the static
            // rows here are removed.
            // X-PLUGIN P3: /x's rail row comes from the signed bundle's own
            // manifest.sidebar (registered into the Official section on
            // activation), same as linkedin/youtube after 3d. The static core
            // row that used to sit here rendered a SECOND X entry for any
            // entitled org (owner report 2026-09-12) — the exact double-render
            // trap the quoxbox note below Governance describes. Removed; the
            // route + XView stay core edges until the full strip increment
            // (stripRegistry x row stays PENDING).
        ]
    },
    // Operations items merged into Platform
    {
        id: 'governance',
        label: 'Governance',
        minRole: 'admin',
        items: [
            { path: '/compliance', label: 'Compliance', icon: 'clipboardCheck' },
            { path: '/policies', label: 'Policies', icon: 'shield' },
            { path: '/traces', label: 'Traces', icon: 'activity', badge: 'NEW', pluginId: 'aocl-compliance-suite', preview: true },
            { path: '/evidence', label: 'Evidence', icon: 'archive', pluginId: 'aocl-compliance-suite', preview: true },
            // LICENSE-LAUNCH LL-7 increment 1: /quoxbox's rail entry now comes
            // from the signed quoxbox-macmini bundle's own manifest.sidebar,
            // registered into the "Official" section on activation. Keeping a
            // static row here as well would render the icon twice for an
            // entitled org. Unentitled orgs reach the locked upsell by URL
            // (src/config/premiumRouteStubs.js) and through Settings, Plugins.
            { path: '/volt', label: 'VOLT', icon: 'lock', pluginId: 'decision-evidence', preview: true },
            { path: '/ward', label: 'WARD', icon: 'fileCheck', pluginId: 'decision-evidence', preview: true },
            { path: '/honesty', label: 'Honesty', icon: 'shield', badge: 'NEW' },
            { path: '/certification', label: 'Certification', icon: 'award', minRole: 'admin' },
        ]
    },
    {
        id: 'marketplace',
        label: 'Marketplace',
        items: [
            { path: '/marketplace/browse', label: 'Browse', icon: 'grid' },
            { path: '/seller', label: 'Seller Dashboard', icon: 'building', pluginId: 'developer-tools' },
            { path: '/seller/submit', label: 'New Listing', icon: 'plus', minRole: 'builder', pluginId: 'developer-tools' },
        ]
    },
    {
        id: 'platform',
        label: 'Platform',
        items: [
            { path: '/topology', label: 'Topology', icon: 'topology', minRole: 'builder' },
            { path: '/memory', label: 'Memory', icon: 'database', shortcut: '6', minRole: 'builder' },
            { path: '/brain2', label: 'Qortex', icon: 'network', badge: 'NEW', minRole: 'builder' },
            { path: '/plugins', label: 'Plugins', icon: 'puzzle', minRole: 'admin' },
            { path: '/test-lab', label: 'Test Lab', icon: 'beaker', minRole: 'builder' },
            { path: '/diagnostics', label: 'Diagnostics', icon: 'activity', minRole: 'builder' },
            { path: '/platform-capabilities', label: 'Platform Capabilities', icon: 'shield-lock', badge: 'NEW', minRole: 'admin' },
            { path: '/cogcore3d', label: 'Core 3D', icon: 'box', badge: 'PREMIUM', pluginId: 'cogcore3d' },
            // LICENSE-LAUNCH LL-7 increment 3a: /system's rail entry now comes from
            // the signed system-maintenance bundle's own manifest.sidebar
            // (registered into the Official section on activation), so the static
            // row here is removed to avoid duplicating the icon.
            { path: '/settings', label: 'Settings', icon: 'settings', shortcut: '9' },
            { path: '/feedback', label: 'Feedback', icon: 'messageSquare' },
            // SET-IA Phase 7: single Settings entry (the V2 sidebar
            // surfaces Instance scope to instance admins automatically)
            // plus the peer Observability nav. The legacy Instance Admin
            // entry is retired; /admin/* still redirects.
            { path: '/observability', label: 'Observability', icon: 'activity', minRole: 'admin' },
        ]
    },
    // QUOXPLAN-P4: Developers section — dev-bundle products (RepoBrain #1,
    // QuoxPlan #2) grouped together, owner order (see STREAM_QUOXPLAN_PLAN.md).
    // RepoBrain moved here from Platform; the community Roadmap
    // (roadmap-viewer) nav entry stays wherever it already lives, untouched.
    {
        id: 'developers',
        label: 'Developers',
        items: [
            // LICENSE-LAUNCH LL-7 increment 3g: /nucleus's rail entry now comes from
            // the signed quox-nucleus bundle's own manifest.sidebar (registered into
            // the Official section on activation), so the static row here is removed.
            // (QN Phase 3 had collapsed three split nav items into this one RepoBrain
            // entry; RepoBrainView still hosts Search/Graph/Repos/Connections as tabs.)
            // LICENSE-LAUNCH LL-7 increment 4a: /quoxplan's rail entry now comes
            // from the signed quoxplan bundle's own manifest.sidebar (registered
            // into the Official section on activation), so the static row here is
            // removed.
            // QUOX-SECURITY: Phase 1, in development. No license badge shown
            // (free tier, not gated), a plain "BETA" badge instead of "NEW"
            // reflects the honest maturity from STATUS_AND_LIMITS_SECURITY.md.
            // VULCAN-DASH: Vulcan agent surface — stats, history and a
            // talk-to-agent sidebar that carries the same context as its
            // attach-bound CLI sessions. Ungated (no pluginId) so it stays
            // visible; octahedron = the Quox agent motif.
            { path: '/vulcan', label: 'Vulcan', icon: 'octahedron', badge: 'NEW' },
            // VULCAN #780: Gripe page (file a one-liner as a GitHub issue).
            { path: '/gripe', label: 'Gripe', icon: 'megaphone', badge: 'NEW' },
            { path: '/quox-security', label: 'QUOX-SECURITY', icon: 'shield', badge: 'BETA', pluginId: 'quox-security' },
            // ONBOARD: visual tenant onboarding wizard (mirrors `quox onboard <host>`)
            { path: '/onboard', label: 'Onboard tenant', icon: 'plus', badge: 'BETA' },
            // LICENSE-LAUNCH LL-7 increment 3b: /qlarity's rail entry now comes from
            // the signed qlarity bundle's own manifest.sidebar (registered into the
            // Official section on activation), so the static row here is removed.
            // SIGNAL-EMBED: placed here deliberately, not by proximity.
            // Considered and ruled out: Social (LinkedIn/YouTube) — that
            // section is OUTBOUND, publishing/monitoring Quox's own channels;
            // QuoxSignal is INBOUND, watching *other* creators' content. AI
            // Studio — QuoxSignal doesn't build agents/workflows, it consumes
            // SCOUT as a triage agent. Developers fits because QuoxSignal's
            // entire output (approved proposals) hands off directly into
            // QuoxPlan (see proposal.handed_off) — it's upstream of the same
            // internal build-Quox pipeline RepoBrain/QuoxPlan already live in,
            // not a coincidence of "another dev-bundle product".
            // LICENSE-LAUNCH LL-7 increment 3g: /quoxsignal's rail entry now comes
            // from the signed quoxsignal bundle's own manifest.sidebar (registered
            // into the Official section on activation), so the static row here is
            // removed.
            // QUOXLENS-UI: placed next to QuoxSignal, not by proximity to
            // RepoBrain/QuoxPlan. QuoxLens's own output — a Lens's verdict on
            // an internal artifact (the honesty-and-claims Lens sweeping
            // quox.ai, e.g.) — is upstream evidence for the same internal
            // build-Quox pipeline QuoxSignal/QuoxPlan/RepoBrain already live
            // in, and it shares QuoxSignal's exact posture: read-only surface
            // over an engine that already runs.
            // QUOXLENS-GATING: registered as a real plugin (quoxlens.json)
            // and gated here the same way quoxsignal is above. Note this
            // only bites once quoxlens is added to the server-side
            // LICENSE_GOVERNED_PLUGINS set -- not done in this change, see
            // docs/QUOXLENS_GATING.md for what that cutover needs.
            // LICENSE-LAUNCH LL-7 increment 3h: /quoxlens's rail entry now comes from
            // the signed quoxlens bundle's own manifest.sidebar (registered into the
            // Official section on activation), so the static row here is removed.
        ]
    }
];

// ── Third-party plugin nav items ──────────────────────────────────────────

/** Map<pluginId, { sectionId?, items[] }> */
const pluginNavItems = new Map();

/**
 * Register sidebar nav items for a third-party plugin.
 * Items are flagged with _thirdParty: true and appear in the declared section
 * or in a "Community Plugins" section if no sectionId is provided.
 *
 * @param {string} pluginId - Unique plugin identifier
 * @param {Array<{path: string, label: string, icon: string, minRole?: string, badge?: string}>} items
 * @param {string} [sectionId] - Existing section to append to, or omit for "Community Plugins"
 */
export function registerPluginNavItems(pluginId, items, sectionId) {
    if (!pluginId || !Array.isArray(items) || items.length === 0) {
        throw new Error(`registerPluginNavItems: pluginId and non-empty items[] required`);
    }

    // Validate items
    for (const item of items) {
        if (!item.path || !item.label) {
            throw new Error(`registerPluginNavItems: each item requires path and label`);
        }
    }

    // Tag items as third-party
    const taggedItems = items.map(item => ({
        ...item,
        pluginId,
        _thirdParty: true,
    }));

    pluginNavItems.set(pluginId, { sectionId, items: taggedItems });

    // Notify listeners
    window.dispatchEvent(new CustomEvent('quox-plugin-nav-change', {
        detail: { pluginId, action: 'register' }
    }));
}

/**
 * Remove all sidebar nav items for a plugin.
 * @param {string} pluginId
 */
export function unregisterPluginNavItems(pluginId) {
    if (!pluginNavItems.has(pluginId)) return;
    pluginNavItems.delete(pluginId);

    window.dispatchEvent(new CustomEvent('quox-plugin-nav-change', {
        detail: { pluginId, action: 'unregister' }
    }));
}

/**
 * Get all registered third-party plugin nav items.
 * @returns {Map<string, {sectionId?: string, items: Array}>}
 */
export function getPluginNavItems() {
    return pluginNavItems;
}

// Where each first-party ("official") plugin BELONGS in the sidebar. The bundle
// registers every official plugin with sectionId 'official' (thirdPartyPluginHost
// passes manifest.official===true ? 'official' : undefined), which used to dump
// monitoring, comms, dev, social all into one flat "Official" list — Bastion and
// everything else buried together. This map restores each plugin to the
// functional section its static row lived in before the LL-7 strip (the removed
// rows are documented in CORE_NAV_SECTIONS above). Dev Suite is merged into
// Developers per owner (2026-09-02). Anything not listed falls back to a safety
// "Official" section so a plugin can never vanish.
const OFFICIAL_PLUGIN_SECTION = {
    // Communications — messaging bridges (moved from Home 2026-09-21)
    'core-comms': 'communications', 'telegram-pro': 'communications', 'discord-pro': 'communications',
    // Work — fleet ops, browser
    'web-terminal': 'work', 'bastion-fleet': 'work', 'browser-q': 'work',
    // Office — the AssistantQ bundle (owner 2026-10-03: "move files, actions to
    // office section as they will be bundled")
    'files': 'office', 'action-tracker': 'office',
    // Monitoring — observability + infra probes
    'grafana': 'monitoring', 'prometheus': 'monitoring', 'uptime-kuma': 'monitoring',
    'proxmox': 'monitoring', 'wazuh': 'monitoring', 'docker-fleet': 'monitoring',
    'tailscale': 'monitoring', 'mikrotik-routeros': 'monitoring',
    // Organisation
    'github': 'organisation',
    // AI Studio
    'prompts-library': 'ai-studio', 'quoxchat': 'ai-studio',
    // Social — QuoxSignal is inbound social listening (owner 2026-09-21: it is a
    // social tool, not a dev tool), so it lives with the other social surfaces.
    'linkedin': 'social', 'facebook': 'social', 'instagram': 'social', 'tiktok': 'social', 'youtube': 'social', 'x': 'social',
    'quoxsignal': 'social',
    // Governance
    'quoxbox-macmini': 'governance',
    // Platform
    'system-maintenance': 'platform',
    // Developers (incl. the merged Dev Suite members). codebase-mirror + quoxbuild
    // were unmapped and fell into the "Official" leftovers bucket; they are dev
    // tools, mapped here 2026-09-21.
    'quox-nucleus': 'developers', 'quoxplan': 'developers', 'qlarity': 'developers',
    'quoxseo': 'developers', 'quoxlens': 'developers',
    'dev-servers': 'developers', 'quoxslots': 'developers',
    'codebase-mirror': 'developers', 'quoxbuild': 'developers',
};

// Product-name presentation for official plugin rows whose signed manifest
// still carries an older label. Owner 2026-10-03: "why is actionsq missing
// from sidebar/search?" The Action Tracker row read "Actions" and search only
// matches label/section/path, so "Action-Q" found nothing. Keep the old names
// as search keywords so nobody loses it the other way round.
const NAV_PRESENTATION = {
    '/actions': { label: 'Action-Q', keywords: ['actions', 'action tracker', 'actionq', 'tasks'] },
};

function presentNavItem(item) {
    const p = NAV_PRESENTATION[item.path];
    return p ? { ...item, ...p } : item;
}

/**
 * Get merged nav sections: core + plugin items, each routed to its FUNCTIONAL
 * section (not a flat "Official" bucket). Dev Suite is merged into Developers.
 * Community Plugins (genuine third-party) always keeps its own section; an
 * "Official" section only appears as a fallback for an official plugin we could
 * not place, so nothing ever disappears.
 *
 * @returns {Array} Merged nav sections
 */
export function getNavSections() {
    // Deep clone core sections so we don't mutate the originals.
    const sections = CORE_NAV_SECTIONS.map(s => ({ ...s, items: [...s.items] }));

    const officialFallback = [];
    const communityItems = [];

    for (const [pluginId, entry] of pluginNavItems) {
        // Official plugin → its functional section (mapped), else fallback.
        if (entry.sectionId === 'official') {
            const targetId = OFFICIAL_PLUGIN_SECTION[pluginId];
            const target = targetId && sections.find(s => s.id === targetId);
            if (target) { target.items.push(...entry.items.map(presentNavItem)); continue; }
            officialFallback.push(...entry.items); // unmapped official — never vanish
            continue;
        }
        // Explicit non-official section id → append to that core section.
        if (entry.sectionId) {
            const target = sections.find(s => s.id === entry.sectionId);
            if (target) { target.items.push(...entry.items); continue; }
        }
        // Genuine third-party plugin → Community Plugins.
        communityItems.push(...entry.items);
    }

    // Owner (2026-09-02): merge Dev Suite into Developers — one dev section. Its
    // items (QLoop, and any dev-servers/quoxslots routed to 'developers' above)
    // go to the top of Developers; the Dev Suite section is then dropped.
    const devSuite = sections.find(s => s.id === 'dev-suite');
    const developers = sections.find(s => s.id === 'developers');
    if (devSuite && developers) {
        developers.items.unshift(...devSuite.items);
    }
    const out = sections.filter(s => s.id !== 'dev-suite');

    // Fallback "Official" section ONLY for official plugins we could not place.
    if (officialFallback.length > 0) {
        out.push({ id: 'official-plugins', label: 'Official', items: officialFallback, _official: true });
    }
    // Community Plugins is always preserved for third-party uploads.
    if (communityItems.length > 0) {
        out.push({ id: 'community-plugins', label: 'Community Plugins', items: communityItems, _thirdParty: true });
    }

    return out;
}

/**
 * Get the core nav sections (without plugin items). Useful for snapshot tests.
 * @returns {Array}
 */
export function getCoreNavSections() {
    return CORE_NAV_SECTIONS;
}

/**
 * Primary sidebar route for a plugin, or null if it has no page.
 *
 * This is the canonical "does this plugin have a dashboard page, and where"
 * lookup: it reads the exact nav items the sidebar renders. A core plugin is
 * matched by the `pluginId` tag on its nav item; a third-party plugin by its
 * registered nav items. First matching path wins (plugins with several pages
 * open on their first). Returns null when nothing is registered so callers can
 * decide whether to show an "Open Dashboard" affordance.
 *
 * @param {string} pluginId
 * @returns {string|null}
 */
export function getPrimaryPathForPlugin(pluginId) {
    if (!pluginId) return null;
    for (const section of CORE_NAV_SECTIONS) {
        for (const item of section.items || []) {
            if (item.pluginId === pluginId && item.path) return item.path;
        }
    }
    const tp = pluginNavItems.get(pluginId);
    if (tp?.items?.length) return tp.items[0].path || null;
    return null;
}
