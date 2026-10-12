/**
 * First-party plugin registry.
 *
 * These are Quox-authored ("official") plugins that graduate out of the manual
 * community-upload flow: instead of an admin uploading a `.quoxplugin`, the auth
 * service ships the built bundle on disk and auto-provisions it into every org
 * at boot (and into each new org at creation) — see utils/firstPartyProvision.js.
 *
 * The `official: true` manifest flag was previously decorative (read by nothing);
 * this registry is what actually makes a plugin first-party. Adding an entry here
 * + committing its built bundle under first-party-plugins/<dir>/ is all it takes.
 *
 * Each `dir` must contain the three unpacked build outputs (as produced by
 * `quox-plugin-vite` inside the .quoxplugin ZIP):
 *   manifest.json · plugin.esm.js · plugin.css
 *
 * `pluginId` MUST equal the manifest `id` (the install is keyed on it, and the
 * two legacy community installs of QuoxTrade were keyed on `star-alignment`, so
 * keeping the id makes the provisioner UPGRADE them in place rather than
 * colliding on UNIQUE(org_id, plugin_id)).
 */

// QuoxTrade (pluginId 'star-alignment') was auto-provisioned here 2026-07 but
// is being RE-CLASSIFIED (2026-07-26 quick fix) to the standard
// download+install+license-key-required tier — NOT core/auto-present on every
// instance. The built bundle stays on disk under
// first-party-plugins/star-alignment/ (still installable via the normal admin
// .quoxplugin/trusted-key install route + server-side entitlement gate in
// services/auth/lib/entitlements.js LICENSE_GOVERNED_PLUGINS), it is simply no
// longer auto-installed+auto-enabled for every org at boot/org-creation.
export const FIRST_PARTY_PLUGINS = [
    // LICENSE-LAUNCH LL-7 increment 1 — the loader-contract pilot.
    //
    // QuoxBox's view was STRIPPED out of the dashboard's free build and now
    // ships only as this signed bundle (built from
    // quox-dashboard/plugins-src/quoxbox-macmini/ via
    // scripts/build-first-party-plugin.mjs). Its dashboard route /quoxbox no
    // longer exists in routeRegistry: the bundle re-registers it on activation.
    //
    // `entitlementGated` is what makes provisioning follow the LICENCE rather
    // than boot: the org gets an install row only while it holds the
    // quoxbox-macmini entitlement, and the row is REMOVED at the next
    // reconciliation once the lease lapses (utils/firstPartyProvision.js).
    // Without that reverse direction, "deactivating removes access" would be a
    // claim with nothing behind it.
    {
        pluginId: 'quoxbox-macmini',
        dir: 'quoxbox-macmini',
        entitlementGated: true,
    },
    // LICENSE-LAUNCH LL-7 increment 3a — a FREE-tier Group-A strip.
    //
    // PromptsLibraryView was stripped out of the free build (built from
    // quox-dashboard/plugins-src/prompts-library/ via
    // scripts/build-first-party-plugin.mjs). Free does NOT mean ungated: per
    // owner ruling R1 a free plugin still carries a (free) entitlement, and
    // prompts-library is in LICENSE_GOVERNED_PLUGINS, so provisioning follows the
    // entitlement exactly as quoxbox does. The org gets an install row only while
    // it holds the grant, and the row is REMOVED at the next reconciliation once
    // it lapses (utils/firstPartyProvision.js).
    {
        pluginId: 'prompts-library',
        dir: 'prompts-library',
        entitlementGated: true,
    },
    // LICENSE-LAUNCH LL-7 increment 3a — a FREE-tier Group-A strip. Same shape as
    // prompts-library: free but license-governed (owner ruling R1), so
    // provisioning follows the entitlement exactly as quoxbox does. The bundle
    // carries backup-restore's BackupPanel as a tab (backup has no route of its
    // own), so the /system surface still includes backups on activation.
    {
        pluginId: 'system-maintenance',
        dir: 'system-maintenance',
        entitlementGated: true,
    },
    // LICENSE-LAUNCH LL-7 increment 3b — PAID Group-A strips. Each view was
    // stripped out of the free build (built from quox-dashboard/plugins-src/<id>/
    // via scripts/build-first-party-plugin.mjs). All are in
    // LICENSE_GOVERNED_PLUGINS, so provisioning follows the entitlement exactly as
    // quoxbox does: the org gets an install row only while it holds the licence,
    // and the row is REMOVED at the next reconciliation once it lapses
    // (utils/firstPartyProvision.js). The BACKEND surfaces (github-proxy.js,
    // qlarity's container + proxy, the discord-pro daemon + routes) are separately
    // entitlement-gated by LL-6d and are NOT touched by the strip.
    {
        pluginId: 'github',
        dir: 'github',
        entitlementGated: true,
    },
    {
        pluginId: 'qlarity',
        dir: 'qlarity',
        entitlementGated: true,
    },
    {
        pluginId: 'discord-pro',
        dir: 'discord-pro',
        entitlementGated: true,
    },
    // LICENSE-LAUNCH LL-7 increment 3c — a FREE-tier Group-B strip. Same shape as
    // prompts-library: free but license-governed (owner ruling R1), so
    // provisioning follows the entitlement exactly as quoxbox does. The org gets
    // an install row only while it holds the grant, and the row is REMOVED at the
    // next reconciliation once it lapses (utils/firstPartyProvision.js). The
    // scanner backend (/api/v1/codebase) is a separate BACKEND surface, not
    // touched by the strip.
    {
        pluginId: 'codebase-mirror',
        dir: 'codebase-mirror',
        entitlementGated: true,
    },
    // LICENSE-LAUNCH LL-7 increment 3c — a PAID Group-B strip. DockerView was
    // stripped out of the free build (built from
    // quox-dashboard/plugins-src/docker-fleet/ via
    // scripts/build-first-party-plugin.mjs). It is in LICENSE_GOVERNED_PLUGINS, so
    // provisioning follows the entitlement exactly as quoxbox does: the org gets an
    // install row only while it holds the licence, and the row is REMOVED at the
    // next reconciliation once it lapses (utils/firstPartyProvision.js). The Docker
    // fleet collector routes are a separate BACKEND surface, not touched here.
    {
        pluginId: 'docker-fleet',
        dir: 'docker-fleet',
        entitlementGated: true,
    },
    // LICENSE-LAUNCH LL-7 increment 3c — a PAID Group-B strip. BrowserQView +
    // BrowserQRunDetailView were stripped out of the free build (built from
    // quox-dashboard/plugins-src/browser-q/ via
    // scripts/build-first-party-plugin.mjs). It is in LICENSE_GOVERNED_PLUGINS, so
    // provisioning follows the entitlement exactly as quoxbox does: the org gets an
    // install row only while it holds the licence, and the row is REMOVED at the
    // next reconciliation once it lapses (utils/firstPartyProvision.js). The
    // browser-q collector routes are a separate BACKEND surface, not touched here.
    {
        pluginId: 'browser-q',
        dir: 'browser-q',
        entitlementGated: true,
    },
    // LICENSE-LAUNCH LL-7 increment 3d — a PAID Group-B strip. LinkedInView was
    // stripped out of the free build (built from quox-dashboard/plugins-src/linkedin/
    // via scripts/build-first-party-plugin.mjs). It is in LICENSE_GOVERNED_PLUGINS, so
    // provisioning follows the entitlement exactly as quoxbox does: the org gets an
    // install row only while it holds the licence, and the row is REMOVED at the
    // next reconciliation once it lapses (utils/firstPartyProvision.js).
    // NOTE (LI-OVERHAUL P6): there are NO backend LinkedIn OAuth routes — an
    // earlier version of this comment asserted some existed. Auth is a pasted
    // 60-day vault token; a real OAuth broker is future work.
    {
        pluginId: 'linkedin',
        dir: 'linkedin',
        entitlementGated: true,
    },
    // FB-3 — same shape as linkedin above (built from
    // quox-dashboard/plugins-src/facebook/ via scripts/build-first-party-plugin.mjs).
    // NOT yet added to entitlements.js LICENSE_GOVERNED_PLUGINS: that fallback
    // list is drift-checked against the signed catalogue and the sibling
    // quox-website pluginCatalog.js (tests/signed-catalog.test.js), and
    // registering a governed id with no catalogue entry permanently locks it
    // for every customer. Adding facebook to the catalogue is an owner-gated,
    // cross-repo step, not done here; until then requirePluginEntitlement
    // treats it as ungoverned (LE-3c: hasPlugin() returns true for everyone),
    // same interim posture x had before its catalogue entry landed.
    {
        pluginId: 'facebook',
        dir: 'facebook',
        entitlementGated: true,
    },
    // IG-3 — same shape as facebook above (built from
    // quox-dashboard/plugins-src/instagram/ via scripts/build-first-party-plugin.mjs).
    // Instagram runs on the SAME shared 'meta' vault credential as facebook; there is
    // no separate credential type or OAuth surface to provision here. NOT yet added
    // to entitlements.js LICENSE_GOVERNED_PLUGINS, same known constraint as facebook
    // (drift-checked against the signed catalogue and quox-website pluginCatalog.js;
    // registering a governed id with no catalogue entry permanently locks it for
    // every customer). Until that owner-gated, cross-repo step lands,
    // requirePluginEntitlement treats it as ungoverned (LE-3c: hasPlugin() returns
    // true for everyone), same interim posture facebook and x had before their
    // catalogue entries landed.
    {
        pluginId: 'instagram',
        dir: 'instagram',
        entitlementGated: true,
    },
    // TT-4 — same shape as instagram above (built from
    // quox-dashboard/plugins-src/tiktok/ via scripts/build-first-party-plugin.mjs).
    // TikTok has its OWN dedicated 'tiktok' vault credential type, not shared with
    // any other plugin. NOT yet added to entitlements.js LICENSE_GOVERNED_PLUGINS,
    // same known constraint as facebook/instagram (drift-checked against the signed
    // catalogue and quox-website pluginCatalog.js; registering a governed id with no
    // catalogue entry permanently locks it for every customer). Until that
    // owner-gated, cross-repo step lands, requirePluginEntitlement treats it as
    // ungoverned (LE-3c: hasPlugin() returns true for everyone), same interim
    // posture facebook and instagram had before their catalogue entries landed.
    {
        pluginId: 'tiktok',
        dir: 'tiktok',
        entitlementGated: true,
    },
    // X-PLUGIN P3 — entitlement-gated like linkedin, but PRE-STRIP: the /x
    // core edges still exist, so the provisioned bundle is additive today
    // (core route shadows the bundle route until the strip increment lands).
    // It is in LICENSE_GOVERNED_PLUGINS, so provisioning follows the
    // entitlement exactly as linkedin does: install row only while the org
    // holds the licence, removed at reconciliation once it lapses
    // (utils/firstPartyProvision.js). The X backend surfaces (xTools.js,
    // routes/xRoutes.js, the twitter connector) are collector-side and are
    // not touched by provisioning.
    {
        pluginId: 'x',
        dir: 'x',
        entitlementGated: true,
    },
    // LICENSE-LAUNCH LL-7 increment 3d — a PAID Group-B strip. YouTubeView was
    // stripped out of the free build (built from quox-dashboard/plugins-src/youtube/
    // via scripts/build-first-party-plugin.mjs). It is in LICENSE_GOVERNED_PLUGINS, so
    // provisioning follows the entitlement exactly as quoxbox does: the org gets an
    // install row only while it holds the licence, and the row is REMOVED at the
    // next reconciliation once it lapses (utils/firstPartyProvision.js). The YouTube
    // OAuth routes are a separate BACKEND surface, not touched here.
    {
        pluginId: 'youtube',
        dir: 'youtube',
        entitlementGated: true,
    },
    // LICENSE-LAUNCH LL-7 increment 3d — a PAID Group-B strip. TelegramProView was
    // stripped out of the free build (built from quox-dashboard/plugins-src/telegram-pro/
    // via scripts/build-first-party-plugin.mjs). It is in LICENSE_GOVERNED_PLUGINS, so
    // provisioning follows the entitlement exactly as quoxbox does: the org gets an
    // install row only while it holds the licence, and the row is REMOVED at the
    // next reconciliation once it lapses (utils/firstPartyProvision.js). The collector
    // /telegram-pro routes (already entitlement-gated by LL-6d) are a separate BACKEND
    // surface, not touched here.
    {
        pluginId: 'telegram-pro',
        dir: 'telegram-pro',
        entitlementGated: true,
    },
    // LICENSE-LAUNCH LL-7 increment 3e — a PAID Group-B strip. BastionView was
    // stripped out of the free build (built from quox-dashboard/plugins-src/bastion-fleet/
    // via scripts/build-first-party-plugin.mjs). It is in LICENSE_GOVERNED_PLUGINS, so
    // provisioning follows the entitlement exactly as docker-fleet does: the org gets an
    // install row only while it holds the licence, and the row is REMOVED at the
    // next reconciliation once it lapses (utils/firstPartyProvision.js). The QuoxBastion
    // collector proxy + auth bastion routes are a separate BACKEND surface, not touched here.
    {
        pluginId: 'bastion-fleet',
        dir: 'bastion-fleet',
        entitlementGated: true,
    },
    // LICENSE-LAUNCH LL-7 increment 3e — a PAID Group-B strip. TerminalView (the
    // /terminal workspace) was stripped out of the free build (built from
    // quox-dashboard/plugins-src/web-terminal/ via scripts/build-first-party-plugin.mjs).
    // It is in LICENSE_GOVERNED_PLUGINS, so provisioning follows the entitlement
    // exactly as docker-fleet does: the org gets an install row only while it holds
    // the licence, and the row is REMOVED at the next reconciliation once it lapses
    // (utils/firstPartyProvision.js). /terminal/about + /terminal/share are a
    // separate FREE core surface and are not touched here.
    {
        pluginId: 'web-terminal',
        dir: 'web-terminal',
        entitlementGated: true,
    },
    // LICENSE-LAUNCH LL-7 increment 3f — a PAID Group-B strip. CommsView was
    // stripped out of the free build (built from quox-dashboard/plugins-src/core-comms/
    // via scripts/build-first-party-plugin.mjs). It is in LICENSE_GOVERNED_PLUGINS, so
    // provisioning follows the entitlement exactly as quoxbox does: the org gets an
    // install row only while it holds the licence, and the row is REMOVED at the next
    // reconciliation once it lapses (utils/firstPartyProvision.js). The collector
    // notification routes (auth routes/messages.js + routes/notifications.js) are a
    // separate BACKEND surface, not touched here.
    {
        pluginId: 'core-comms',
        dir: 'core-comms',
        entitlementGated: true,
    },
    // LICENSE-LAUNCH LL-7 increment 3f — a PAID Group-B strip. WazuhView (only the
    // FRONTEND) was stripped out of the free build (built from
    // quox-dashboard/plugins-src/wazuh/ via scripts/build-first-party-plugin.mjs). It
    // is in LICENSE_GOVERNED_PLUGINS, so provisioning follows the entitlement exactly
    // as quoxbox does: the org gets an install row only while it holds the licence,
    // and the row is REMOVED at the next reconciliation once it lapses
    // (utils/firstPartyProvision.js). The 16 Wazuh collector handlers are a separate
    // BACKEND surface, not touched here.
    {
        pluginId: 'wazuh',
        dir: 'wazuh',
        entitlementGated: true,
    },
    // LICENSE-LAUNCH LL-7 increment 3g — a PAID Group-B strip. QuoxSignalView (only
    // the FRONTEND) was stripped out of the free build (built from
    // quox-dashboard/plugins-src/quoxsignal/ via scripts/build-first-party-plugin.mjs).
    // It is in LICENSE_GOVERNED_PLUGINS, so provisioning follows the entitlement
    // exactly as quoxbox does: the org gets an install row only while it holds the
    // licence, and the row is REMOVED at the next reconciliation once it lapses
    // (utils/firstPartyProvision.js). The quoxsignal service (:3108) + its
    // /api/v1/signal/* collector proxy are a separate BACKEND surface, not touched here.
    {
        pluginId: 'quoxsignal',
        dir: 'quoxsignal',
        entitlementGated: true,
    },
    // QUOXSEO S2 (2026-09-04) — the witnessed SEO warehouse view, built from
    // quox-dashboard/plugins-src/quoxseo/. Entitlement-gated from day one
    // (in LICENSE_GOVERNED_PLUGINS): the org gets an install row only while
    // it holds the licence. The quoxseo service (:3110, repo quoxai/quox-seo)
    // + its /api/v1/quoxseo/* collector proxy are a separate BACKEND surface.
    {
        pluginId: 'quoxseo',
        dir: 'quoxseo',
        entitlementGated: true,
    },
    // LICENSE-LAUNCH LL-7 increment 4a — a PAID Group-B strip. QuoxPlanView (only
    // the FRONTEND) was stripped out of the free build (built from
    // quox-dashboard/plugins-src/quoxplan/ via scripts/build-first-party-plugin.mjs).
    // It is in LICENSE_GOVERNED_PLUGINS, so provisioning follows the entitlement
    // exactly as quoxbox does: the org gets an install row only while it holds the
    // licence, and the row is REMOVED at the next reconciliation once it lapses
    // (utils/firstPartyProvision.js). The QuoxPlan API client OnboardView needs was
    // extracted to a core service (src/services/quoxplanApiClient.js) first. The
    // QuoxPlan service (:3107) + its /api/v1/quoxplan/* collector proxy are a
    // separate BACKEND surface, not touched here.
    {
        pluginId: 'quoxplan',
        dir: 'quoxplan',
        entitlementGated: true,
    },
    // LICENSE-LAUNCH LL-7 increment 3g — a PAID Group-B strip. RepoBrainView (only
    // the FRONTEND) was stripped out of the free build (built from
    // quox-dashboard/plugins-src/quox-nucleus/ via scripts/build-first-party-plugin.mjs).
    // It is in LICENSE_GOVERNED_PLUGINS, so provisioning follows the entitlement
    // exactly as quoxbox does: the org gets an install row only while it holds the
    // licence, and the row is REMOVED at the next reconciliation once it lapses
    // (utils/firstPartyProvision.js). The RepoBrain engine (:3105) + its collector
    // proxy are a separate BACKEND surface, not touched here.
    {
        pluginId: 'quox-nucleus',
        dir: 'quox-nucleus',
        entitlementGated: true,
    },
    // LICENSE-LAUNCH LL-7 increment 3h — a strip of the Files view. FilesView
    // (only the FRONTEND view tree: FileManager/FolderTree/FolderChat/
    // FileSkillPanel/ArchivistPanel) was stripped out of the free build (built
    // from quox-dashboard/plugins-src/files/ via
    // scripts/build-first-party-plugin.mjs). It is entitlement-gated on the
    // 'files' entitlement, so provisioning follows the licence exactly as
    // quoxbox does: the org gets an install row only while it holds the licence,
    // and the row is REMOVED at the next reconciliation once it lapses
    // (utils/firstPartyProvision.js). The shared file pickers
    // (components/files/shared/*) and the file backend are separate surfaces,
    // not touched here.
    {
        pluginId: 'files',
        dir: 'files',
        entitlementGated: true,
    },
    // LICENSE-LAUNCH LL-7 increment 3h — a strip of the QuoxChat views. QuoxChatView
    // + QuoxChatWidgetRoom (only the FRONTEND) were stripped out of the free build
    // (built from quox-dashboard/plugins-src/quoxchat/ via
    // scripts/build-first-party-plugin.mjs). It is entitlement-gated on the
    // 'quoxchat' entitlement, so provisioning follows the licence exactly as quoxbox
    // does: the org gets an install row only while it holds the licence, and the row
    // is REMOVED at the next reconciliation once it lapses
    // (utils/firstPartyProvision.js). The QuoxChat collector routes + widget store
    // are a separate BACKEND surface, not touched here.
    {
        pluginId: 'quoxchat',
        dir: 'quoxchat',
        entitlementGated: true,
    },
    // LICENSE-LAUNCH LL-7 increment 3h — a strip of the QuoxLens view. QuoxLensView
    // (only the FRONTEND, with its components/quoxlens subtree) was stripped out of
    // the free build (built from quox-dashboard/plugins-src/quoxlens/ via
    // scripts/build-first-party-plugin.mjs). It is entitlement-gated on the
    // 'quoxlens' entitlement, so provisioning follows the licence exactly as quoxbox
    // does: the org gets an install row only while it holds the licence, and the row
    // is REMOVED at the next reconciliation once it lapses
    // (utils/firstPartyProvision.js). The QuoxLens collector routes (gated under
    // LL-6d) are a separate BACKEND surface, not touched here.
    {
        pluginId: 'quoxlens',
        dir: 'quoxlens',
        entitlementGated: true,
    },
    // LICENSE-LAUNCH LL-7 increment 3h — a strip of the TailMesh (tailscale) view.
    // TailscaleView (only the FRONTEND, with its components/tailscale subtree) was
    // stripped out of the free build (built from
    // quox-dashboard/plugins-src/tailscale/ via
    // scripts/build-first-party-plugin.mjs). It is entitlement-gated on the
    // 'tailscale' entitlement, so provisioning follows the licence exactly as
    // quoxbox does. The "Tailscale" INTEGRATION TYPE (tailscaleClient /
    // integrationTypes / extensions) is a separate surface, not touched here.
    {
        pluginId: 'tailscale',
        dir: 'tailscale',
        entitlementGated: true,
    },
    // LICENSE-LAUNCH LL-7 increment 3h — a strip of the RouterOS view. RouterOSView
    // (only the FRONTEND, with its components/routeros subtree) was stripped out of
    // the free build (built from quox-dashboard/plugins-src/mikrotik-routeros/ via
    // scripts/build-first-party-plugin.mjs). The canonical id is mikrotik-routeros;
    // the route stays /routeros. It is entitlement-gated on the 'mikrotik-routeros'
    // entitlement, so provisioning follows the licence exactly as quoxbox does. The
    // "RouterOS" INTEGRATION TYPE (routerosClient / extensions) is a separate
    // surface, not touched here.
    {
        pluginId: 'mikrotik-routeros',
        dir: 'mikrotik-routeros',
        entitlementGated: true,
    },
    // LICENSE-LAUNCH LL-7 extraction 1 — a strip of the Action Tracker Kanban
    // view. ActionsView (only the FRONTEND, with its ActionQSidebar) was
    // stripped out of the free build (built from
    // quox-dashboard/plugins-src/action-tracker/ via
    // scripts/build-first-party-plugin.mjs). It is entitlement-gated on the
    // 'action-tracker' entitlement, so provisioning follows the licence exactly
    // as quoxbox does. useActionExecution/ActionResultsPanel (NOC/SOC's
    // unrelated quick-action executor, moved to src/components/core/actions/ in
    // the prior commit) are a separate CORE surface, not touched here.
    {
        pluginId: 'action-tracker',
        dir: 'action-tracker',
        entitlementGated: true,
    },
    // LICENSE-LAUNCH LL-7 dev-servers strip, 2026-08-30 — the ratified LL-5
    // classification table (docs/LL5_CLASSIFICATION_TABLE_2026-08-28.md, Group
    // B) supersedes the 2026-08-21 nav-review finding that /dev-suite must stay
    // static/ungated. DevSuiteView, DevSuiteHostDetailView and
    // QuoxperticusResidentView (the tabbed hub, per-host capability drill-in,
    // and resident pages) were stripped out of the free build (built from
    // quox-dashboard/plugins-src/dev-servers/ via
    // scripts/build-first-party-plugin.mjs). It is entitlement-gated on the
    // 'dev-servers' entitlement (a genuinely $39 paid plugin, per
    // src/config/plugins/dev-servers.json — not the free-tier R1 shape used for
    // prompts-library/system-maintenance), so provisioning follows the licence
    // exactly as quoxbox does. DevServersHubPanel + DocsPanel (the inventory
    // grid + docs browser, now src/components/core/devsuite/) are a separate
    // CORE surface rendered on /infra for every org and are NOT touched here —
    // that split is what keeps the hub reachable without a licence.
    {
        pluginId: 'dev-servers',
        dir: 'dev-servers',
        entitlementGated: true,
    },
    // LICENSE-LAUNCH LL-7 extraction 3, 2026-08-30 — the R3F half.
    // CognitiveCore3DView (the fullscreen /cogcore3d visualiser) was stripped
    // out of the free build (built from quox-dashboard/plugins-src/cogcore3d/
    // via scripts/build-first-party-plugin.mjs). It is entitlement-gated on the
    // 'cogcore3d' entitlement (a genuinely $18 one-time professional-tier
    // plugin, per src/config/plugins/cogcore3d.json — not the free-tier R1
    // shape used for prompts-library/system-maintenance), so provisioning
    // follows the licence exactly as quoxbox does.
    // src/components/opsdeck3d/ is a separate CORE surface: /3d-lab and
    // /brain2 still render from it for every org and it is NOT touched here.
    {
        pluginId: 'cogcore3d',
        dir: 'cogcore3d',
        entitlementGated: true,
    },
    // LICENSE-LAUNCH LL-7 extraction 4, 2026-08-30 — the four monitoring
    // plugins. ProxmoxView, PrometheusView, UptimeKumaView and GrafanaView were
    // stripped out of the free build TOGETHER (built from
    // quox-dashboard/plugins-src/{proxmox,prometheus,uptime-kuma,grafana}/ via
    // scripts/build-first-party-plugin.mjs), because LL-5 classified them as a
    // set: they shared one component directory, so any single strip gave zero
    // dist reduction until the directory was split. Each is entitlement-gated on
    // its own entitlement, at the price in src/config/plugins/<id>.json
    // (proxmox $29, prometheus $19, grafana $9, uptime-kuma $9), so provisioning
    // follows the licence exactly as quoxbox does.
    //
    // The shared half of that directory is a separate CORE surface and is NOT
    // touched here: src/components/core/monitoring/ (ProxmoxPanel, MetricsPanel,
    // UptimePanel, GrafanaEmbed, GrafanaAlertBadge, useProxmoxData,
    // AgentFleetPanel, GPUFleetPanel, ServiceDetailModal, ToolOutcomesPanel,
    // LiveEventStream, PlaybooksPanel, JobsPanel and the four chat sidebars)
    // keeps rendering on NOC, SOC, Infra, the main Dashboard and the NOC popout
    // for every org, licensed or not. That split is what makes these four
    // strippable without taking live monitoring away from the free build.
    {
        pluginId: 'proxmox',
        dir: 'proxmox',
        entitlementGated: true,
    },
    {
        pluginId: 'prometheus',
        dir: 'prometheus',
        entitlementGated: true,
    },
    {
        pluginId: 'grafana',
        dir: 'grafana',
        entitlementGated: true,
    },
    {
        pluginId: 'uptime-kuma',
        dir: 'uptime-kuma',
        entitlementGated: true,
    },
    // LICENSE-LAUNCH LL-7 quoxbuild strip, 2026-08-31 — the first strip in this
    // stream with NO route to rehome. QuoxBuild's entire UI is DevBuildPanel, a
    // dev-suite capability panel embedded in a host card (its catalogue
    // manifest's dashboardSurface is "embedded" by design: a build queue belongs
    // to a host). It shipped in the free build because
    // src/components/devsuite/panels/index.js registered the panel
    // unconditionally and the CORE DevServersHubPanel side-effect imports that
    // barrel for the ungated /infra route — which is exactly why this row sat
    // deferred when dev-servers stripped on 2026-08-30.
    //
    // The panel now ships here (built from quox-dashboard/plugins-src/quoxbuild/
    // via scripts/build-first-party-plugin.mjs) and registers itself into the
    // shared capability-panel registry on activation. Entitlement-gated on the
    // 'quoxbuild' entitlement (a genuinely paid $20 plugin per
    // src/config/plugins/quoxbuild.json — not the free-tier R1 shape used for
    // prompts-library/system-maintenance), so provisioning follows the licence
    // exactly as quoxbox does. DevServersHubPanel stays CORE and keeps
    // rendering on /infra for every org; unentitled, the dev.build pill opens a
    // locked upsell slot built from metadata alone.
    {
        pluginId: 'quoxbuild',
        dir: 'quoxbuild',
        entitlementGated: true,
    },
    // LICENSE-LAUNCH LL-7 quoxslots strip, 2026-08-31 — the second routeless
    // strip, and the one whose row sat deferred for an honest reason: the deck
    // (SlotsDeckPanel) was imported only by DevSuiteView, which stripped with
    // dev-servers, so its code had already left the FREE build as a side
    // effect. What had NOT happened was the strip in its own right: the deck
    // was compiling into the dev-servers bundle, so a $39 Dev Servers customer
    // received the $39 QuoxSlots deck for nothing, and /dev-suite?tab=slots was
    // still a static core nav row.
    //
    // The deck now ships here (built from quox-dashboard/plugins-src/quoxslots/
    // via scripts/build-first-party-plugin.mjs) and registers itself as the
    // 'dev.slots' capability panel on activation; the sidebar row comes from
    // this bundle's own manifest.sidebar. Entitlement-gated on the 'quoxslots'
    // entitlement (already a known entitlement in services/auth/lib/
    // entitlements.js), so provisioning follows the licence. The /dev-suite tab
    // itself belongs to dev-servers and is unchanged; unentitled, it renders a
    // locked upsell slot built from metadata alone.
    {
        pluginId: 'quoxslots',
        dir: 'quoxslots',
        entitlementGated: true,
    },
    // LICENSE-LAUNCH LL-7 local-inference strip, 2026-08-31 — the third
    // routeless strip and the last row the LL-7 extraction plan owed. Its only
    // client surface is a SECTION of core /settings, which is why the plan left
    // it as an owner call; owner ruled it a paid plugin and it strips.
    //
    // The settings panel now ships here (built from
    // quox-dashboard/plugins-src/local-inference/ via
    // scripts/build-first-party-plugin.mjs) and registers itself as the
    // 'settings.local-inference' capability panel on activation. Core /settings
    // keeps the section ROW as metadata, so an unentitled org sees the locked
    // upsell rather than a section that vanished. Entitlement-gated on the
    // 'local-inference' entitlement (already known to
    // services/auth/lib/entitlements.js), so provisioning follows the licence.
    // The collector's /api/v1/local-inference/* backend is unchanged.
    {
        pluginId: 'local-inference',
        dir: 'local-inference',
        entitlementGated: true,
    },
    // QUOXVOICE QVOICE phase 5, 2026-10-12 — the QuoxVoice team dashboard surface
    // (Session + OutboundQ Schedules tabs), built from
    // quox-dashboard/plugins-src/quox-voice/ via scripts/build-first-party-plugin.mjs.
    // Unlike every other first-party bundle above, this is NOT entitlement-gated:
    // quox-voice is license:"free" and is NOT in LICENSE_GOVERNED_PLUGINS, so a gated
    // entry would resolve to 'absent' and never install (firstPartyProvision.js
    // ensureFirstPartyForOrg). A plain entry provisions it to every org unconditionally
    // (createInstall), which is what mounts its /quox-voice/* route. The collector
    // /api/v1/telephony-schedules proxy to the voice bridge (:3112) is a separate
    // BACKEND surface, not touched here.
    {
        pluginId: 'quox-voice',
        dir: 'quox-voice',
    },
];

// Sentinel actor recorded as installed_by / assigned_by for auto-provisioned
// rows, so they're distinguishable from human admin uploads in audits.
export const FIRST_PARTY_ACTOR = 'system:first-party';
