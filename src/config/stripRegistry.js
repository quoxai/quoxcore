/**
 * Strip registry (LICENSE-LAUNCH LL-7 increment 2).
 *
 * ONE table, read by four things that would otherwise drift apart:
 *
 *   - src/config/premiumRouteStubs.js — decides which locked stubs actually
 *     mount (only a stripped plugin's do);
 *   - eslint.config.js — turns the stripped rows into no-restricted-imports
 *     patterns, so a core file cannot statically reach a stripped view;
 *   - scripts/check-dist-clean.mjs — which plugins the dist scan asserts absent
 *     from dist/assets and present in their built bundle (the marker STRINGS
 *     live in scripts/strip-markers.mjs, see below);
 *   - scripts/check-strip-registry.mjs — the build-time guard that refuses a
 *     half-landed increment.
 *
 * PURE DATA. It is imported by the router's critical path, by node scripts and
 * by the ESLint flat config, so it may never import anything itself.
 *
 * ── The states ────────────────────────────────────────────────────────────
 *
 *   pending    — classified category-1 (LL-5 groups A + B) but NOT yet stripped,
 *                and a strip IS still owed. Its view is still in the free build,
 *                its route row is still in routeRegistry.js/App.jsx, and its
 *                locked stub is authored but inert.
 *   stripped   — the whole strip landed: route edge deleted, plugins-src entry
 *                built, signed bundle published, stub mounted, dist markers
 *                declared in scripts/strip-markers.mjs.
 *                check-strip-registry.mjs enforces every one of those.
 *   core-gated — DELIBERATELY core, and owed NO strip. An owner ruling that this
 *                plugin STAYS in the free build (its code is statically reachable
 *                from core, or its only surface is a core-rendered panel), and its
 *                paid value is enforced SERVER-SIDE instead of by stripping the
 *                client. Validated like pending (route, if any, still in core; no
 *                entry/bundle), but it is NOT "pending a strip" and is NOT counted
 *                as stripped. Introduced 2026-08-31 (LL-6d) for opsdeck and
 *                quoxagent-fleet, superseding their misleading `pending` rows.
 *                NOTE: core-gated states an INTENT; it does not by itself prove a
 *                server gate exists — see each row's note for the enforcement
 *                status (opsdeck's server gate is an open LL-10 item).
 *   external   — already ships as a first-party bundle from before LL-7 and never
 *                had a core route to strip (quoxtrade / star-alignment).
 *
 * Flipping a row from pending to stripped is the LAST edit of a strip
 * increment, and it is what arms the ESLint patterns and the dist scan for
 * that plugin. Do it in the same commit that deletes the route edge, or the
 * guard fails — which is the entire point.
 *
 * ── Adding a marker row when a new plugin strips ──────────────────────────
 *
 *   1. Set `status: 'stripped'`, `entry: 'plugins-src/<id>'`,
 *      `bundle: 'services/auth/first-party-plugins/<id>/plugin.esm.js'`.
 *   2. Add its sentinel and dist-scan markers to scripts/strip-markers.mjs.
 *      They live THERE, not here, and the reason is load-bearing: this module
 *      is imported by the browser bundle, so a marker string written here
 *      would ship into dist/assets and make the scan permanently red. That is
 *      not hypothetical — it happened while this file was being written.
 *   3. List every module the free build must stop importing in `coreModules`.
 *   4. Run `npm run check:strip && npm run build && npm run scan:dist`.
 */

export const STRIP_STATUS = Object.freeze({
    PENDING: 'pending',
    STRIPPED: 'stripped',
    CORE_GATED: 'core-gated',
    EXTERNAL: 'external',
});

/** Shorthand for the rows that are pure "nothing has happened yet". */
const pending = (pluginId, group, routes, note = null) => ({
    pluginId,
    group,
    status: STRIP_STATUS.PENDING,
    routes,
    coreModules: [],
    entry: null,
    bundle: null,
    note,
});

/**
 * Shorthand for a DELIBERATELY-core, no-strip-owed row (owner ruling). Same
 * shape as a pending row — no entry, no bundle, code stays in the free build —
 * but classified so it is never counted as "pending a strip". The paid value is
 * enforced server-side; see the row's note for the enforcement status.
 */
const coreGated = (pluginId, group, routes, note = null) => ({
    pluginId,
    group,
    status: STRIP_STATUS.CORE_GATED,
    routes,
    coreModules: [],
    entry: null,
    bundle: null,
    note,
});

export const STRIP_REGISTRY = [
    // ── Group A: clean shape today (LL-5 §"Group A", 8 rows) ──────────────
    pending('backup-restore', 'A', [], 'No route of its own: /backup redirects to /system?tab=backups and the surface is a panel inside System Maintenance.'),
    {
        pluginId: 'prompts-library',
        group: 'A',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/prompts-library'],
        // The view still LIVES in src/ — the plugin entry imports it from there
        // (plugins-src/prompts-library/index.jsx). What was deleted is the EDGE:
        // the lazy() import + views-map entry in App.jsx, the row in
        // routeRegistry.js, and the barrel re-export in pages/views/index.js.
        // PromptHistoryModal is exclusive to the view and ships with it;
        // PromptPicker + promptsClient are used by the chat composer and STAY in
        // the free build, so they are not listed here.
        coreModules: [
            'src/pages/views/PromptsLibraryView.jsx',
            'src/components/prompts/PromptHistoryModal.jsx',
        ],
        entry: 'plugins-src/prompts-library',
        bundle: 'services/auth/first-party-plugins/prompts-library/plugin.esm.js',
        note: 'LL-7 increment 3a. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    {
        pluginId: 'system-maintenance',
        group: 'A',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/system'],
        // The view still LIVES in src/ — the plugin entry imports it from there
        // (plugins-src/system-maintenance/index.jsx). What was deleted is the
        // EDGE: the lazy() import + views-map entry in App.jsx, the row in
        // routeRegistry.js, and the barrel re-export in pages/views/index.js.
        // KeeperChatSidebar is exclusive to the view and ships with it (it is the
        // legal home for this row's dist-scan markers). UpdatePanel/UpdateHistory/
        // UpdateProgress are shared with services/maintenance + hooks, so they are
        // NOT listed here. SystemMaintenanceView also renders backup-restore's
        // BackupPanel as a tab, so backup's UI rides into this bundle — the
        // current shape (backup-restore has no route of its own), not decided here.
        coreModules: [
            'src/pages/views/SystemMaintenanceView.jsx',
            'src/components/maintenance/KeeperChatSidebar.jsx',
        ],
        entry: 'plugins-src/system-maintenance',
        bundle: 'services/auth/first-party-plugins/system-maintenance/plugin.esm.js',
        note: 'LL-7 increment 3a. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    {
        pluginId: 'quoxtrade',
        group: 'A',
        status: STRIP_STATUS.EXTERNAL,
        routes: [],
        coreModules: [],
        entry: null,
        bundle: 'services/auth/first-party-plugins/star-alignment/plugin.esm.js',
        note: 'Already shipped through the third-party pipe as star-alignment before LL-7. It never had a core route or a src/ view, so there is nothing to strip and nothing for the dist scan to prove absent.',
    },
    {
        pluginId: 'quoxbox-macmini',
        group: 'A',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/quoxbox'],
        // The view still LIVES in src/ — the plugin entry imports it from there
        // (see plugins-src/quoxbox-macmini/index.jsx). What was deleted is the
        // EDGE: the lazy() import in App.jsx and the row in routeRegistry.js.
        // These are the modules no free-build file may import again.
        coreModules: ['src/pages/views/QuoxBoxView.jsx', 'src/hooks/useQuoxBoxData.js'],
        entry: 'plugins-src/quoxbox-macmini',
        bundle: 'services/auth/first-party-plugins/quoxbox-macmini/plugin.esm.js',
        note: 'LL-7 increment 1 pilot. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    {
        pluginId: 'github',
        group: 'A',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/github'],
        // The view still LIVES in src/ — the plugin entry imports it from there
        // (plugins-src/github/index.jsx). What was deleted is the EDGE: the
        // lazy() import + views-map entry in App.jsx, the row in routeRegistry.js,
        // and the barrel re-export in pages/views/index.js. GitHubPanel is
        // exclusive to the view (it is the legal home for this row's dist-scan
        // markers) and ships with it. The collector proxy (github-proxy.js) is a
        // BACKEND surface, entitlement-gated by LL-6d, and is not touched here.
        coreModules: [
            'src/pages/views/GitHubView.jsx',
            'src/components/github/GitHubPanel.jsx',
        ],
        entry: 'plugins-src/github',
        bundle: 'services/auth/first-party-plugins/github/plugin.esm.js',
        note: 'LL-7 increment 3b. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    {
        pluginId: 'qlarity',
        group: 'A',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/qlarity/*'],
        // The view still LIVES in src/ — the plugin entry imports it from there
        // (plugins-src/qlarity/index.jsx). What was deleted is the EDGE: the
        // lazy() import + views-map entry in App.jsx and the row in
        // routeRegistry.js. lib/api.js is exclusive to the view and ships with it
        // transitively; it is NOT a separate free-build edge, and its basename
        // ("api") is too generic to arm as an import pattern, so only QlarityView
        // is listed. Qlarity's container + collector proxy are BACKEND surfaces,
        // entitlement-gated by LL-6d, and are not touched here.
        coreModules: [
            'src/components/qlarity/QlarityView.jsx',
        ],
        entry: 'plugins-src/qlarity',
        bundle: 'services/auth/first-party-plugins/qlarity/plugin.esm.js',
        note: 'LL-7 increment 3b. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    {
        pluginId: 'discord-pro',
        group: 'A',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/discord-pro'],
        // The view still LIVES in src/ — the plugin entry imports it from there
        // (plugins-src/discord-pro/index.jsx). What was deleted is the EDGE: the
        // lazy() import + views-map entry in App.jsx and the row in
        // routeRegistry.js. DiscordProLocked is exclusive to the view and ships
        // with it transitively; it is not a separate free-build edge. The daemon
        // and its collector routes are BACKEND surfaces, entitlement-gated by
        // LL-6d, and are not touched here.
        coreModules: [
            'src/components/discord-pro/DiscordProView.jsx',
        ],
        entry: 'plugins-src/discord-pro',
        bundle: 'services/auth/first-party-plugins/discord-pro/plugin.esm.js',
        note: 'LL-7 increment 3b. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },

    // ── Group B: strip with named tangles (LL-5 §"Group B", 32 rows) ──────
    // The four monitoring views share one component dir and one endpoint
    // family; LL-5 says they strip as a set.
    //
    // LL-7 extraction 4 (the supervised set's riskiest) landed all four in one
    // commit, on top of a preceding commit that SPLIT the shared directory. The
    // split is what made the strip worth doing: deleting the four route edges
    // alone gave zero dist reduction while ProxmoxPanel/MetricsPanel/
    // UptimePanel/GrafanaEmbed/useProxmoxData/AgentFleetPanel and the chat
    // sidebars still sat in the same directory as the plugin-exclusive parts.
    // Those shared pieces are now src/components/core/monitoring/ and stay in
    // the free build for NOCView, SOCView, InfraView, DashboardView and
    // NOCPopout; what is listed in coreModules below is quad-exclusive.
    {
        pluginId: 'proxmox',
        group: 'B',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/monitoring/proxmox'],
        // The view still LIVES in src/ — plugins-src/proxmox/index.jsx imports it
        // from there. What was deleted is the EDGE: the lazy() import + views-map
        // entry in App.jsx, the row in routeRegistry.js, the pages/views barrel
        // re-export, and the navRegistry rail row. This row also carries the
        // MonitoringSetup, which is shared between the FOUR stripped views and
        // no longer reachable from any core file, plus the panels left orphaned
        // once the barrel's only importers left. They are listed once, here,
        // rather than repeated on all four rows. The Proxmox COLLECTOR routes
        // are a backend surface and are not touched.
        //
        // The old src/components/monitoring/index.js barrel is DELETED in this
        // commit rather than listed: the extraction kept it for exactly one
        // increment (per docs/LL7_EXTRACTION_DIFFS_READY.md) so the five core
        // consumers could flip in one edit each, and the four plugin views now
        // import what they need directly. It also could not be listed if we
        // wanted to — strippedImportPatterns() turns a coreModule into the
        // BASENAME glob `**/<name>*`, and `**/index*` matches every barrel
        // import in the repo (32 false lint errors, including main.jsx).
        // StatusBar.jsx and ServicesPanel.jsx are absent for the same reason
        // (`**/StatusBar*` hits components/chat/glass/StatusBar, `**/ServicesPanel*`
        // hits pages/settings/account/ServicesPanel). With the barrel gone
        // nothing imports either of them at all, so reachability takes them out
        // of the free dist without the lint boundary having to say so. The three
        // panels listed at the end below (CollapsibleSection,
        // FleetConnectivityPanel, AgentSessionsPanel) are in the same position:
        // orphaned by the barrel's deletion, listed here because they are
        // monitoring-domain code the free build must not import again.
        coreModules: [
            'src/pages/views/ProxmoxView.jsx',
            'src/components/monitoring/MonitoringSetup.jsx',
            'src/components/monitoring/ProxmoxTable.jsx',
            'src/components/monitoring/ProxmoxTopology.jsx',
            'src/components/monitoring/ProxmoxActions.jsx',
            'src/components/monitoring/ProxmoxChatSidebar.jsx',
            'src/components/monitoring/ProxmoxContextMenu.jsx',
            'src/components/monitoring/ProxmoxNodes.jsx',
            'src/components/monitoring/ProxmoxBackups.jsx',
            'src/components/monitoring/ProxmoxAlertConfig.jsx',
            'src/components/monitoring/SparklineCell.jsx',
            'src/components/monitoring/useResourceHistory.js',
            'src/components/monitoring/vmActions.js',
            'src/components/monitoring/CollapsibleSection.jsx',
            'src/components/monitoring/FleetConnectivityPanel.jsx',
            'src/components/monitoring/AgentSessionsPanel.jsx',
        ],
        entry: 'plugins-src/proxmox',
        bundle: 'services/auth/first-party-plugins/proxmox/plugin.esm.js',
        note: 'LL-7 extraction 4. Row was minRole builder, preserved in manifest.routeGuards. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    {
        pluginId: 'uptime-kuma',
        group: 'B',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/monitoring/uptime-kuma'],
        // UptimeKumaView is the whole exclusive surface: the licence gate,
        // connection check, guided setup and multi status-page flow. UptimePanel
        // itself is CORE (src/components/core/monitoring/) because NOC and
        // NOCPopout render it for every org, so it is deliberately absent here.
        coreModules: [
            'src/pages/views/UptimeKumaView.jsx',
        ],
        entry: 'plugins-src/uptime-kuma',
        bundle: 'services/auth/first-party-plugins/uptime-kuma/plugin.esm.js',
        note: 'LL-7 extraction 4. Row was minRole builder, preserved in manifest.routeGuards. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    {
        pluginId: 'prometheus',
        group: 'B',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/monitoring/prometheus'],
        // MetricsPanel is CORE (NOC + NOCPopout) and is deliberately absent.
        // What leaves is the intelligence layer PrometheusView is built on:
        // the fleet heatmap, the PromQL explorer, the alert timeline and the
        // METRICS chat sidebar. AlertTimeline and MetricsChatSidebar each hold
        // one of this row's dist-scan markers, so both must be listed (the
        // marker guard requires every file a marker lives in to be a coreModule).
        coreModules: [
            'src/pages/views/PrometheusView.jsx',
            'src/components/monitoring/FleetHeatmap.jsx',
            'src/components/monitoring/PromQLExplorer.jsx',
            'src/components/monitoring/AlertTimeline.jsx',
            'src/components/monitoring/MetricsChatSidebar.jsx',
        ],
        entry: 'plugins-src/prometheus',
        bundle: 'services/auth/first-party-plugins/prometheus/plugin.esm.js',
        note: 'LL-7 extraction 4. Row was minRole builder, preserved in manifest.routeGuards. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    {
        pluginId: 'grafana',
        group: 'B',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/monitoring/grafana'],
        // The thinnest of the four. GrafanaView is a licence gate plus a page
        // frame around GrafanaEmbed, and GrafanaEmbed + GrafanaAlertBadge are
        // CORE (NOC renders the embed, the badge polls alert state for the NOC
        // header), so only the standalone page leaves. Same shape as the
        // dev-servers strip, where the hub content stayed core.
        coreModules: [
            'src/pages/views/GrafanaView.jsx',
        ],
        entry: 'plugins-src/grafana',
        bundle: 'services/auth/first-party-plugins/grafana/plugin.esm.js',
        note: 'LL-7 extraction 4. Row was minRole builder, preserved in manifest.routeGuards. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    {
        pluginId: 'files',
        group: 'B',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/files'],
        // The view still LIVES in src/ — the plugin entry imports it from there
        // (plugins-src/files/index.jsx). What was deleted is the EDGE: the static
        // import + views-map entry in App.jsx, the row in routeRegistry.js, the
        // pages/views barrel re-export, and the navRegistry rail row. FilesView is
        // the SOLE importer of the components/files barrel, so its view tree
        // (FileManager/FolderTree/FolderChat/FileSkillPanel/ArchivistPanel) ships
        // transitively and all three dist-scan markers live there. The shared
        // pickers under components/files/shared/* STAY in the free build — core
        // surfaces (assistant-editor KnowledgeTab) import them directly and they
        // carry no markers. The file backend is a separate surface, not touched.
        coreModules: [
            'src/pages/views/FilesView.jsx',
            // FileManager.jsx carries the dist-scan markers and is what FilesView
            // renders. FilesView imports it DIRECTLY (not through the
            // components/files barrel), and the barrel's FileManager re-export was
            // removed, so no free-build file reaches FileManager once the FilesView
            // edge is gone. Listing it here is what lets the marker strings legally
            // live in src/. The other view-tree components (FolderTree,
            // FolderChat, FileSkillPanel, ArchivistPanel) ship transitively via
            // FileManager but carry no markers, so they are not coreModules.
            'src/components/files/FileManager.jsx',
        ],
        entry: 'plugins-src/files',
        bundle: 'services/auth/first-party-plugins/files/plugin.esm.js',
        note: 'LL-7 increment 3h. /files was ungated, so no routeGuards. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    // advanced-voice was here (group B, pending). REMOVED from the strip
    // registry by owner ruling 2026-08-31 (LICENSE-LAUNCH LL-6d): it is now
    // genuinely FREE core, ungoverned (dropped from GOVERNED_PLUGIN_IDS in
    // services/auth/lib/entitlements.js). This registry tracks ONLY category-1
    // (strip) plugins; a free, ungoverned, service-woven plugin with no route is
    // not category-1, so it has no row here. It was never stripped and owes no
    // strip. Group B is therefore 31 rows, not 32 (see ll7StripRegistry.test.js).
    {
        pluginId: 'core-comms',
        group: 'B',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/comms'],
        // The view still LIVES in src/ — the plugin entry imports it from there
        // (plugins-src/core-comms/index.jsx). What was deleted is the EDGE: the
        // lazy() import + views-map entry in App.jsx, the row in routeRegistry.js,
        // the barrel re-export in pages/views/index.js, and the navRegistry rail
        // row. The components/comms/* panels + useCommsData are exclusive to
        // CommsView and ship with it transitively; only the view is listed, and it
        // is the sole home of this row's dist-scan markers. MatrixCommsView
        // (/matrix-comms) is a SEPARATE surviving core view that merely ends in
        // "CommsView" — the anchored strip-boundary selector (increment 3f) is what
        // stops this basename substring-matching that import. CoreCommsSettings.jsx
        // (core Settings) and the collector notification routes (auth
        // routes/messages.js + routes/notifications.js) are separate surfaces and
        // are not touched here.
        coreModules: [
            'src/pages/views/CommsView.jsx',
        ],
        entry: 'plugins-src/core-comms',
        bundle: 'services/auth/first-party-plugins/core-comms/plugin.esm.js',
        note: 'LL-7 increment 3f. Unblocked by the anchored strip-boundary selector. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    {
        pluginId: 'mikrotik-routeros',
        group: 'B',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/routeros'],
        // The view still LIVES in src/ — the plugin entry imports it from there
        // (plugins-src/mikrotik-routeros/index.jsx). What was deleted is the EDGE: the
        // lazy() import + views-map entry in App.jsx, the row in routeRegistry.js, the
        // pages/views barrel re-export, and the navRegistry rail row (whose pluginId
        // was reconciled to the canonical mikrotik-routeros in the prior commit). The
        // dist-scan markers live in RouterOSView.jsx, which is imported directly by the
        // plugin entry; its components/routeros subtree (panels/modals/wizard) ships
        // transitively but carries no markers. Only the VIEW strips: the "RouterOS"
        // INTEGRATION TYPE (services/routerosClient.js, config/extensions.js) stays in
        // the free build. Catalogue id is mikrotik-routeros; the ROUTE stays /routeros.
        coreModules: [
            'src/pages/views/RouterOSView.jsx',
        ],
        entry: 'plugins-src/mikrotik-routeros',
        bundle: 'services/auth/first-party-plugins/mikrotik-routeros/plugin.esm.js',
        note: 'LL-7 increment 3h. /routeros was minRole builder, preserved in manifest.routeGuards. Canonical id mikrotik-routeros, route /routeros. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    {
        pluginId: 'web-terminal',
        group: 'B',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/terminal'],
        // Only the /terminal WORKSPACE strips. The view still LIVES in src/ — the
        // plugin entry imports it from there (plugins-src/web-terminal/index.jsx).
        // What was deleted is the EDGE: the lazy() import + views-map entry in
        // App.jsx, the row in routeRegistry.js, the barrel re-export in
        // pages/views/index.js, and the navRegistry rail row. TerminalView holds all
        // three of this row's dist-scan markers (vim-mode + observer microcopy), so
        // it is the sole coreModule; the components/terminal panes it pulls ship with
        // it transitively. /terminal/about (TerminalPromo) and /terminal/share
        // (SnapshotViewer) stay in core, as do shared services like
        // terminalMemoryBridge that other core code still imports. No free-build file
        // imports TerminalView.
        coreModules: [
            'src/pages/views/TerminalView.jsx',
        ],
        entry: 'plugins-src/web-terminal',
        bundle: 'services/auth/first-party-plugins/web-terminal/plugin.esm.js',
        note: 'LL-7 increment 3e. /terminal carried minRole runner, preserved in manifest.routeGuards. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    {
        pluginId: 'action-tracker',
        group: 'B',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/actions'],
        // The view still LIVES in src/ — the plugin entry imports it from there
        // (plugins-src/action-tracker/index.jsx). What was deleted is the EDGE:
        // the lazy() import + views-map entry in App.jsx, the row in
        // routeRegistry.js, the pages/views barrel re-export, and the navRegistry
        // rail row. ActionQSidebar is exclusive to the view (it is the legal
        // home for this row's dist-scan markers) and ships with it.
        // useActionExecution + ActionResultsPanel are a DIFFERENT "actions"
        // concept (NOC/SOC's quick-action executor) that moved to
        // src/components/core/actions/ in the prior commit — they are core, not
        // listed here, and stay in the free build.
        coreModules: [
            'src/pages/views/ActionsView.jsx',
            'src/components/actions/ActionQSidebar.jsx',
        ],
        entry: 'plugins-src/action-tracker',
        bundle: 'services/auth/first-party-plugins/action-tracker/plugin.esm.js',
        note: 'LL-7 extraction 1. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    {
        pluginId: 'wazuh',
        group: 'B',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/wazuh'],
        // The view still LIVES in src/ — the plugin entry imports it from there
        // (plugins-src/wazuh/index.jsx). What was deleted is the EDGE: the lazy()
        // import + views-map entry in App.jsx, the row in routeRegistry.js, the
        // barrel re-export in pages/views/index.js, and the navRegistry rail row.
        // WazuhPanel + WazuhChatSidebar + WazuhSetupGate are exclusive to the view
        // and ship with it transitively; the setup gate and chat sidebar each hold
        // one of this row's dist-scan markers, so both are listed alongside the view
        // (the marker guard requires every file a marker lives in to be a
        // coreModule). No free-build file imports them. The 16 Wazuh collector
        // handlers are a BACKEND surface, entitlement-gated, and are not touched here.
        coreModules: [
            'src/pages/views/WazuhView.jsx',
            'src/components/wazuh/WazuhSetupGate.jsx',
            'src/components/wazuh/WazuhChatSidebar.jsx',
        ],
        entry: 'plugins-src/wazuh',
        bundle: 'services/auth/first-party-plugins/wazuh/plugin.esm.js',
        note: 'LL-7 increment 3f. /wazuh carried minRole builder, preserved in manifest.routeGuards. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    // LL-7 extraction 4 tried to take this row with the other four monitoring
    // plugins and could not. It has no route of its own, and its ONLY surface,
    // AgentFleetPanel, is rendered by core InfraView (/infra) alongside
    // GPUFleetPanel — which is precisely why the extraction moved
    // AgentFleetPanel INTO src/components/core/monitoring/. After that move
    // there is nothing left for a bundle to carry: stripping it would mean
    // removing the fleet panel from the core /infra page, a visible product
    // change for every org, or resolving the panel from the plugin host at
    // runtime (a pattern nothing uses yet). Neither is a coder-level call, so
    // the row stays pending and the decision goes to the owner.
    coreGated('quoxagent-fleet', 'B', [], 'OWNER RULED 2026-08-30: SUBSUMED BY CORE (backup-restore precedent), reclassified core-gated 2026-08-31 (LL-6d) — was a misleading `pending` row. AgentFleetPanel lives in src/components/core/monitoring/ and /infra keeps rendering it; nothing exclusive remains to strip, the SKU stays governed server-side (entitlements.js `quoxagent-fleet`). Row kept only until the signed catalogue carries the subsumed classification; no strip work is owed.'),
    {
        pluginId: 'codebase-mirror',
        group: 'B',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/codebase-mirror'],
        // The view still LIVES in src/ — the plugin entry imports it from there
        // (plugins-src/codebase-mirror/index.jsx). What was deleted is the EDGE:
        // the lazy() import + views-map entry in App.jsx, the row in
        // routeRegistry.js, and the barrel re-export in pages/views/index.js.
        // CodebaseMirrorView imports nothing exclusive of its own beyond React,
        // so only the view is listed. The scanner backend (/api/v1/codebase +
        // lib/codebaseScanner|Store|Diff) is a BACKEND surface and is not touched
        // here.
        coreModules: [
            'src/pages/views/CodebaseMirrorView.jsx',
        ],
        entry: 'plugins-src/codebase-mirror',
        bundle: 'services/auth/first-party-plugins/codebase-mirror/plugin.esm.js',
        note: 'LL-7 increment 3c. FREE tier but license-governed (owner ruling R1). Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    coreGated('opsdeck', 'B', ['/opsdeck'], 'OWNER RULED 2026-08-30: reclassified CORE-GATED (soc precedent), moved to the core-gated STATUS 2026-08-31 (LL-6d) — was a misleading `pending` row. Blocker that forced the call: core MissionControlView statically imports OpsDeckView for its licence-gated Live tab, so a strip needs either removing that tab or a new runtime plugin-export pattern; owner chose neither. SERVER-GATE GAP (LL-10, open): opsdeck has NO server-exclusive endpoint — OpsDeckView gates client-side via isPluginLicensed(opsdeck) (src/pages/views/OpsDeckView.jsx:174) and streams the SHARED core objectives feed /api/objectives/:id/stream (services/tasks/server.js:1635), which /objectives, orchestration CommandStream and cogcore3d all consume ungated. Gating that endpoint by opsdeck would break core objectives for every non-opsdeck user, so the server gate is deferred to LL-10, not hacked. See docs/STATUS_AND_LIMITS_LICENSING.md and src/test/opsdeckServerGate.test.js (skipped, documents intended behaviour). No strip work is owed.'),
    {
        pluginId: 'bastion-fleet',
        group: 'B',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/bastion'],
        // The view still LIVES in src/ — the plugin entry imports it from there
        // (plugins-src/bastion-fleet/index.jsx). What was deleted is the EDGE: the
        // lazy() import + views-map entry in App.jsx, the row in routeRegistry.js,
        // the barrel re-export in pages/views/index.js, and the navRegistry rail
        // row. BastionPanel + BastionChatSidebar (and the other components/bastion
        // tabs) are exclusive to the view and ship with it transitively; the panel
        // holds two of this row's dist-scan markers and the chat sidebar the third,
        // so both are listed alongside the view (the marker guard requires every
        // file a marker lives in to be a coreModule). No free-build file imports
        // them. The QuoxBastion collector proxy + auth bastion routes are a BACKEND
        // surface and are not touched here.
        coreModules: [
            'src/pages/views/BastionView.jsx',
            'src/components/bastion/BastionPanel.jsx',
            'src/components/bastion/BastionChatSidebar.jsx',
        ],
        entry: 'plugins-src/bastion-fleet',
        bundle: 'services/auth/first-party-plugins/bastion-fleet/plugin.esm.js',
        note: 'LL-7 increment 3e. /bastion carried minRole builder, preserved in manifest.routeGuards. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    {
        pluginId: 'docker-fleet',
        group: 'B',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/docker'],
        // The view still LIVES in src/ — the plugin entry imports it from there
        // (plugins-src/docker-fleet/index.jsx). What was deleted is the EDGE: the
        // lazy() import + views-map entry in App.jsx, the row in routeRegistry.js,
        // the barrel re-export in pages/views/index.js, and the navRegistry rail
        // row. DockerDashboard + DockerChatSidebar are exclusive to the view (the
        // sidebar is the legal home for this row's dist-scan markers) and ship with
        // it transitively; they hold this row's dist-scan markers, so both are
        // listed alongside the view (the marker guard requires every file a marker
        // lives in to be a coreModule). No free-build file imports them. The Docker
        // fleet collector routes are a BACKEND surface and are not touched here.
        coreModules: [
            'src/pages/views/DockerView.jsx',
            'src/components/docker/DockerDashboard.jsx',
            'src/components/docker/DockerChatSidebar.jsx',
        ],
        entry: 'plugins-src/docker-fleet',
        bundle: 'services/auth/first-party-plugins/docker-fleet/plugin.esm.js',
        note: 'LL-7 increment 3c. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    {
        pluginId: 'quoxchat',
        group: 'B',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/quoxchat', '/quoxchat/:widgetId'],
        // The views still LIVE in src/ — the plugin entry imports them from there
        // (plugins-src/quoxchat/index.jsx). What was deleted is the EDGE: the two
        // lazy() imports + views-map entries in App.jsx, the two rows in
        // routeRegistry.js, and the navRegistry rail row (neither view is in the
        // pages/views barrel, so there is no re-export to remove). The dist-scan
        // markers live in QuoxChatWidgetRoom.jsx. Shared UI (assistant-editor
        // OnboardingWizard, automation EvolutionStagePill) stays in the free build —
        // core surfaces import it and it carries no markers. The QuoxChat collector
        // routes + widget store are a separate BACKEND surface, not touched.
        coreModules: [
            'src/pages/views/QuoxChatView.jsx',
            'src/pages/views/QuoxChatWidgetRoom.jsx',
        ],
        entry: 'plugins-src/quoxchat',
        bundle: 'services/auth/first-party-plugins/quoxchat/plugin.esm.js',
        note: 'LL-7 increment 3h. /quoxchat + /quoxchat/:widgetId were ungated, so no routeGuards. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    {
        pluginId: 'browser-q',
        group: 'B',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/browser-q', '/browser-q/run/:objectiveId'],
        // The views still LIVE in src/ — the plugin entry imports them from there
        // (plugins-src/browser-q/index.jsx). What was deleted is the EDGE: the two
        // lazy() imports + views-map entries in App.jsx, the two rows in
        // routeRegistry.js, the two barrel re-exports in pages/views/index.js, and
        // the navRegistry rail row. The components/browser-q dir + browserQService
        // are exclusive to the views and ship with them transitively; they are not
        // separate free-build edges. BrowserQView is the legal home for this row's
        // dist-scan markers. The browser-q collector routes (/api/browser-q,
        // screencap) are a BACKEND surface and are not touched here.
        coreModules: [
            'src/pages/views/BrowserQView.jsx',
            'src/pages/views/BrowserQRunDetailView.jsx',
        ],
        entry: 'plugins-src/browser-q',
        bundle: 'services/auth/first-party-plugins/browser-q/plugin.esm.js',
        note: 'LL-7 increment 3c. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    {
        pluginId: 'cogcore3d',
        group: 'B',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/cogcore3d'],
        // The view still LIVES in src/ — the plugin entry imports it from there
        // (plugins-src/cogcore3d/index.jsx). What was deleted is the EDGE: the
        // lazy() import and the inline <Route path="/cogcore3d"> in App.jsx's
        // STANDALONE block. The stub-mount-point worry flagged on this row while
        // it was pending turned out to need no code: selectPremiumStubRoutes
        // filters on paths owned by CORE_ROUTES + registered plugin routes, and
        // /cogcore3d was never in either (it was inline JSX), so deleting the
        // inline route is enough for the stub to mount in the AppShell block
        // like every other stripped plugin. Both mount points are inside the
        // app-level AuthProvider, so nothing loses useAuth.
        //
        // src/components/opsdeck3d/ is NOT listed here and is NOT part of this
        // strip: it stays CORE because ThreeDLabView (/3d-lab) and QuoxbrainView
        // (/brain2, lazy BrainOrgan3D) still import its zones, effects and lib.
        // Rollup decides by reachability which of its modules follow the bundle
        // out (CognitiveCore.jsx, hud/*, hooks/*), which is why this row's
        // dist-scan markers must come from CognitiveCore3DView.jsx text only —
        // never from anything /3d-lab or /brain2 can reach.
        coreModules: [
            'src/pages/views/CognitiveCore3DView.jsx',
        ],
        entry: 'plugins-src/cogcore3d',
        bundle: 'services/auth/first-party-plugins/cogcore3d/plugin.esm.js',
        note: 'LL-7 extraction 3. /cogcore3d was ungated at the route level (the licence gate lived inside the view via isPluginLicensed), so no routeGuards. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    {
        pluginId: 'tailscale',
        group: 'B',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/tailscale'],
        // The view still LIVES in src/ — the plugin entry imports it from there
        // (plugins-src/tailscale/index.jsx). What was deleted is the EDGE: the lazy()
        // import + views-map entry in App.jsx, the row in routeRegistry.js, the
        // pages/views barrel re-export, and the navRegistry rail row. The dist-scan
        // markers live in TailscaleChatSidebar.jsx + MeshOverview.jsx. Only the VIEW
        // strips: the "Tailscale" INTEGRATION TYPE (services/tailscaleClient.js,
        // config/integrationTypes.js, config/extensions.js) and the shared
        // CrossOrgCredentialBanner stay in the free build and carry no markers.
        coreModules: [
            'src/pages/views/TailscaleView.jsx',
            'src/components/tailscale/TailscaleChatSidebar.jsx',
            'src/components/tailscale/MeshOverview.jsx',
        ],
        entry: 'plugins-src/tailscale',
        bundle: 'services/auth/first-party-plugins/tailscale/plugin.esm.js',
        note: 'LL-7 increment 3h. /tailscale was minRole viewer, preserved in manifest.routeGuards. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    {
        pluginId: 'local-inference',
        group: 'B',
        status: STRIP_STATUS.STRIPPED,
        routes: [],
        // The panel still LIVES in src/ — the plugin entry imports it from there
        // (plugins-src/local-inference/index.jsx). What was deleted is the EDGE,
        // and there were three of them into CORE SETTINGS: the lazy() import +
        // section map entry in components/settings/SectionRenderer.jsx (the V2
        // IA), and the static import + inline render in pages/views/SettingsView
        // .jsx (V1). Both now resolve LATE through the capability-panel registry
        // under 'settings.local-inference', so the section renders the real panel
        // when the signed bundle is active and the locked upsell when it is not.
        //
        // What STAYS core, deliberately, is METADATA: the section row in
        // config/settingsSections.js, the sidebar row + icon in
        // SettingsSidebar.jsx, the label in SettingsChatSidebar.jsx, the
        // 'local-inference' entry in SettingsView's VALID_SECTIONS, the
        // catalogue manifest config/plugins/local-inference.json and the
        // PluginCard icon. A settings section that silently vanished would be
        // indistinguishable from a broken build, and none of those carry a byte
        // of the panel.
        //
        // src/services/localModelRegistry.js is NOT listed and is NOT part of
        // this strip, despite the catalogue manifest naming it as this plugin's
        // integration surface. Nothing imports it — not the panel, not any core
        // file — so rollup never followed it into the free build (verified
        // before the strip: its storage key is absent from every dist asset,
        // while the panel's microcopy was in main-*.js). Listing it would arm
        // the ESLint boundary against src/test/localInference.test.js, the one
        // file that legitimately exercises it, and importing it into the bundle
        // purely for completeness would compile dead code into paid output.
        // ll7LocalInferenceStrip.test.js pins that it stays unimported.
        //
        // The collector's /api/v1/local-inference/* routes and the
        // handleLocalInferenceChat provider path are a BACKEND surface,
        // entitlement-gated at the service, and are not touched here.
        coreModules: [
            'src/components/settings/LocalInferenceSettings.jsx',
        ],
        entry: 'plugins-src/local-inference',
        bundle: 'services/auth/first-party-plugins/local-inference/plugin.esm.js',
        note: 'LL-7 extraction 6, the last row the extraction plan owed. Routeless: the surface is a section of core /settings, kept as metadata with a locked slot. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    {
        pluginId: 'quox-nucleus',
        group: 'B',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/nucleus'],
        // The view still LIVES in src/ — the plugin entry imports it from there
        // (plugins-src/quox-nucleus/index.jsx). What was deleted is the EDGE: the
        // lazy() import + views-map entry in App.jsx and the row in routeRegistry.js
        // (RepoBrainView lives under components/, so there is no pages/views barrel
        // re-export to remove), plus the navRegistry rail row. The tab components
        // (CodeSearch, CodebaseGraph, ManageRepos, ConnectionsView, HowToUseView,
        // RepoBrainContext) ship with the view transitively; all three dist-scan
        // markers live in RepoBrainView.jsx, so it is the sole coreModule. No
        // free-build file imports it once the edge above is gone — the /nucleus/graph
        // and /nucleus/repos redirects in App.jsx only <Navigate>, never import the
        // view. The RepoBrain engine (:3105) is a BACKEND surface, entitlement-gated,
        // and is not touched here.
        coreModules: [
            'src/components/nucleus/RepoBrainView.jsx',
        ],
        entry: 'plugins-src/quox-nucleus',
        bundle: 'services/auth/first-party-plugins/quox-nucleus/plugin.esm.js',
        note: 'LL-7 increment 3g. /nucleus was ungated, so no routeGuards. /nucleus/graph and /nucleus/repos are App.jsx redirects into ?tab=, not separate surfaces. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    {
        pluginId: 'quoxplan',
        group: 'B',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/quoxplan/*'],
        // The view still LIVES in src/ — the plugin entry imports it from there
        // (plugins-src/quoxplan/index.jsx). What was deleted is the EDGE: the
        // lazy() import + views-map entry in App.jsx, the row in routeRegistry.js,
        // and the navRegistry rail row (QuoxPlanView lives under components/, so
        // there is no pages/views barrel re-export to remove). The sub-views
        // (Focus/Board/Timeline/Streams/StreamPage), RoadyRail, the contexts and
        // the lib/* helpers ship with the view transitively. The QuoxPlan API
        // client was EXTRACTED to a core service (src/services/quoxplanApiClient.js,
        // increment 4a first commit) so OnboardView no longer reaches into this
        // plugin — that is what let it strip. All three dist-scan markers live in
        // QuoxPlanView.jsx, so it is the sole coreModule. No free-build file
        // imports it once the edge above is gone. The QuoxPlan service (:3107) + its
        // /api/v1/quoxplan/* collector proxy are a BACKEND surface, entitlement-gated,
        // and are not touched here.
        coreModules: [
            'src/components/quoxplan/QuoxPlanView.jsx',
        ],
        entry: 'plugins-src/quoxplan',
        bundle: 'services/auth/first-party-plugins/quoxplan/plugin.esm.js',
        note: 'LL-7 increment 4a. /quoxplan/* was ungated (pluginId only, no minRole), so no routeGuards. API client extracted to core first (src/services/quoxplanApiClient.js). Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    {
        pluginId: 'telegram-pro',
        group: 'B',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/telegram-pro'],
        // The view still LIVES in src/ — the plugin entry imports it from there
        // (plugins-src/telegram-pro/index.jsx). What was deleted is the EDGE: the
        // lazy() import + views-map entry in App.jsx, the row in routeRegistry.js,
        // and the navRegistry rail row (this view lives in components/, not
        // pages/views/, so there is no barrel re-export to delete). TelegramProWizard
        // + telegramProService are exclusive to the view and ship with it
        // transitively; the wizard holds two of this row's dist-scan markers and
        // the view holds the third, so both are listed (the marker guard requires
        // every file a marker lives in to be a coreModule). No free-build file
        // imports them. The collector /telegram-pro routes (auth
        // routes/telegramPro.js), already entitlement-gated by LL-6d, are a BACKEND
        // surface and are not touched here.
        coreModules: [
            'src/components/telegram-pro/TelegramProView.jsx',
            'src/components/telegram-pro/TelegramProWizard.jsx',
        ],
        entry: 'plugins-src/telegram-pro',
        bundle: 'services/auth/first-party-plugins/telegram-pro/plugin.esm.js',
        note: 'LL-7 increment 3d. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    {
        pluginId: 'dev-servers',
        group: 'B',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/dev-suite', '/dev-suite/servers/:hostId', '/quoxperticus/:hostId'],
        // The views still LIVE in src/ — the plugin entry imports them from
        // there (plugins-src/dev-servers/index.jsx). What was deleted is the
        // EDGE: the three lazy() imports + views-map entries in App.jsx, the
        // three rows in routeRegistry.js, and the navRegistry hub rail row
        // (superseded 2026-08-30 per the ratified LL-5 table; see the comment
        // there). DevServersHubPanel + DocsPanel are a DIFFERENT, CORE surface
        // (src/components/core/devsuite/, extraction 2) rendering on /infra for
        // every org — NOT listed here, they are not part of this strip.
        coreModules: [
            'src/pages/views/DevSuiteView.jsx',
            'src/pages/views/DevSuiteHostDetailView.jsx',
            'src/pages/views/QuoxperticusResidentView.jsx',
        ],
        entry: 'plugins-src/dev-servers',
        bundle: 'services/auth/first-party-plugins/dev-servers/plugin.esm.js',
        note: 'LL-7 dev-servers strip, 2026-08-30. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    {
        pluginId: 'quoxbuild',
        group: 'B',
        status: STRIP_STATUS.STRIPPED,
        // ROUTELESS, and the first row here that is. quoxbuild's catalogue
        // manifest sets dashboardSurface "embedded" on purpose (a build queue
        // belongs to a host), so there was never a route to delete and there is
        // no locked route stub to mount — the locked surface is a PANEL SLOT
        // inside the core dev-servers hub instead.
        routes: [],
        // What was deleted is not a route edge but a REGISTRATION edge: the
        // `import DevBuildPanel` + registerCapabilityPanel('dev.build', ...)
        // pair in src/components/devsuite/panels/index.js. That barrel is
        // side-effect imported by CORE DevServersHubPanel (/infra), so the
        // paid panel shipped to every org regardless of the dev-servers strip.
        // That is the exact blocker this row was deferred on, 2026-08-30.
        //
        // The panel still LIVES in src/ — the plugin entry imports it from
        // there (plugins-src/quoxbuild/index.jsx) — and registers itself into
        // the shared capability-panel registry from its onActivate hook, via
        // window.__quoxSharedDeps.CapabilityPanels. Core keeps only metadata
        // (PREMIUM_CAPABILITY_PANELS in src/config/capabilityPanelRegistry.js),
        // which is what renders the honest locked/upsell slot; metadata is
        // exempt from the acceptance, code is not. The sibling panels
        // (DevRegisterPanel/DevSessionsPanel/DevPlanPanel) are free and stay
        // registered from the barrel, so they are not listed here. All three
        // dist-scan markers live in DevBuildPanel.jsx, so it is the sole
        // coreModule. The dev-build collector routes are a separate BACKEND
        // surface and are not touched here.
        coreModules: [
            'src/components/devsuite/panels/DevBuildPanel.jsx',
        ],
        entry: 'plugins-src/quoxbuild',
        bundle: 'services/auth/first-party-plugins/quoxbuild/plugin.esm.js',
        note: 'LL-7 quoxbuild strip, 2026-08-31 (owner word given the same day). Entitlement-keyed LAZY capability-panel registration, not a route-edge deletion — the pattern any future paid dev-suite panel should copy. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    // TANGLE CHECK 2026-08-31 (owner word given the same day), superseding the
    // LL-5 note, which was wrong on the facts even though its conclusion held:
    // gripe is not feedback capture, and src/pages/views/FeedbackView.jsx (the
    // core /feedback form, posting to the quox.ai feedback API) has not one
    // reference to it. Gripe is a GitHub issue filer.
    //
    // The check found NO client surface — not "already gone as a side effect
    // of another strip" like quoxslots, but never built. The catalogue manifest
    // says so itself (dashboardSurface "cli", "there is no dashboard screen
    // yet", dataPlane "agent-tools" so not even a proxy route to gate), and
    // the tree agrees: no route, no view, no panel, no nav row, no service, no
    // hook. The only two files it owns in the buildable tree are metadata
    // manifests (src/config/plugins/gripe.json, the catalogue row every
    // stripped plugin also keeps in core; and the GRIPE entity manifest).
    // Everything that ships is the CLI (`quox gripe`, which posts to the
    // governed chat route), the core GRIPE agent, and the github_create_issue
    // connector tool.
    //
    // So a strip has no subject: no route edge to delete, nothing to move into
    // a plugins-src entry, and no marker string that could live only in paid
    // code. Manufacturing an entry, a bundle and markers would mean WRITING
    // client code in order to have something to strip, so the row stays
    // pending on the quoxagent-fleet/opsdeck precedent above: honest note, no
    // strip work owed. Agents are not strip subjects anywhere in this table —
    // a plugin-owned agent stays in core agentRegistry and is gated with
    // `requiresPlugin` (tailscale, wazuh, browser-q, linkedin all do). Pinned
    // by src/test/ll7GripeStrip.test.js, which re-runs the tangle check on
    // every test run (the 2026-10-11 /gripe page was the planned trip of that wire).
    // UPDATE 2026-10-11 (quox#780, owner ask): a /gripe dashboard page now exists
    // (GripeView). It is FREE and ships in core on purpose (gripe is free, it
    // files through the already-governed GitHub proxy), so there is still no
    // paid-only client code to strip: the row stays pending with no strip work.
    pending('gripe', 'B', [], 'Free plugin, core-shipped surface. `quox gripe` and the /gripe dashboard page (GripeView, files via the governed POST /github/issues proxy) both ship in core, and the GRIPE agent is plugin-owned and gated through GitQ. Nothing client-exclusive to a paid bundle exists, so no strip work is owed. Value stays governed server-side by the github entitlement on the proxy.'),
    {
        pluginId: 'quoxslots',
        group: 'B',
        status: STRIP_STATUS.STRIPPED,
        // ROUTELESS, like quoxbuild and for the same declared reason: the
        // catalogue manifest sets dashboardSurface "embedded" and says so in
        // prose ("No standalone route by design: Slots is a tab on /dev-suite").
        // So there is no locked route stub to mount — the locked surface is the
        // slots TAB inside the dev-servers hub.
        routes: [],
        // The tangle check this row was deferred for, run 2026-08-31, found
        // exactly one import edge in the whole tree: DevSuiteView.jsx. Every
        // other mention of SlotsDeckPanel under src/ is prose in a comment
        // ("same fix as SlotsDeckPanel", "the sibling pattern"), which puts no
        // byte into dist. So the deck had indeed already left the FREE build as
        // a side effect of the dev-servers strip — but two edges were still
        // open, and they are what this row pays off:
        //
        //   1. DevSuiteView is itself stripped, so its `import SlotsDeckPanel`
        //      compiled the $39 QuoxSlots deck INTO the $39 dev-servers bundle.
        //      A Dev Servers customer received QuoxSlots for nothing. That is
        //      the same cross-bundle leak the quoxbuild strip found, and it is
        //      fixed the same way: the import is replaced by a late
        //      resolveCapabilityPanel('dev.slots') and dev-servers was REBUILT
        //      in this commit (verified: all three markers absent from it
        //      afterwards, its own three still present).
        //   2. /dev-suite?tab=slots was still a static core nav row. It was
        //      pluginId-gated, so no free org ever saw it, but the signed
        //      bundle's manifest.sidebar owns it now like every other strip.
        //
        // The deck still LIVES in src/ — plugins-src/quoxslots/index.jsx
        // imports it from there — and registers itself as the 'dev.slots'
        // capability panel from its onActivate hook, via
        // window.__quoxSharedDeps.CapabilityPanels. Core keeps only metadata
        // (PREMIUM_CAPABILITY_PANELS in src/config/capabilityPanelRegistry.js),
        // which renders the honest locked/upsell slot. That registry's Map is
        // window-backed as of this strip: DevSuiteView carries a SECOND
        // compiled copy of the module inside the dev-servers bundle, and two
        // module-scope Maps would leave an entitled org staring at the locked
        // slot forever.
        //
        // GovernedConfirmDialog.jsx is deliberately NOT listed: it was
        // extracted OUT of this panel to be shared with the free
        // DevSessionsPanel, so it is core code, not quoxslots-exclusive. All
        // three dist-scan markers live in SlotsDeckPanel.jsx, so it is the sole
        // coreModule. The /api/v1/slots collector routes are a separate BACKEND
        // surface and are not touched here.
        coreModules: [
            'src/components/devsuite/SlotsDeckPanel.jsx',
        ],
        entry: 'plugins-src/quoxslots',
        bundle: 'services/auth/first-party-plugins/quoxslots/plugin.esm.js',
        note: 'LL-7 quoxslots strip, 2026-08-31 (owner word given the same day). The second routeless strip: entitlement-keyed lazy capability-panel registration for the /dev-suite slots tab, plus the nav row moving to the signed bundle, plus a dev-servers rebuild to evict the deck from that bundle. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    {
        pluginId: 'quoxsignal',
        group: 'B',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/quoxsignal/*'],
        // The view still LIVES in src/ — the plugin entry imports it from there
        // (plugins-src/quoxsignal/index.jsx). What was deleted is the EDGE: the
        // lazy() import + views-map entry in App.jsx, the row in routeRegistry.js,
        // and the navRegistry rail row (QuoxSignalView lives under components/, so
        // there is no pages/views barrel re-export to remove). The sub-views,
        // ScoutChatSidebar, QuoxSignalLocked and the lib/* clients ship with the
        // view transitively (including the quoxplan lib/api it reaches into as a
        // PLUGIN-to-PLUGIN dependency — quoxplan itself is NOT stripped, so that lib
        // also stays in the free build; the dist markers below are drawn ONLY from
        // QuoxSignalView.jsx so nothing shared leaks). All three dist-scan markers
        // live in QuoxSignalView.jsx, so it is the sole coreModule. No free-build
        // file imports it once the edge above is gone. The quoxsignal service
        // (:3108) is a BACKEND surface, entitlement-gated at the /api/v1/signal/*
        // collector proxy, and is not touched here.
        coreModules: [
            'src/components/quoxsignal/QuoxSignalView.jsx',
        ],
        entry: 'plugins-src/quoxsignal',
        bundle: 'services/auth/first-party-plugins/quoxsignal/plugin.esm.js',
        note: 'LL-7 increment 3g. /quoxsignal/* was ungated, so no routeGuards. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    {
        pluginId: 'quoxlens',
        group: 'B',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/quoxlens'],
        // The view still LIVES in src/ — the plugin entry imports it from there
        // (plugins-src/quoxlens/index.jsx). What was deleted is the EDGE: the lazy()
        // import + views-map entry in App.jsx, the row in routeRegistry.js, and the
        // navRegistry rail row (the view is under components/quoxlens, so there is no
        // pages/views barrel re-export to remove). The dist-scan markers live in
        // QuoxLensLocked.jsx, imported only by QuoxLensView. Shared services
        // (licenseValidator) stay in the free build — core surfaces import them and
        // they carry no markers. The QuoxLens collector routes (LL-6d gated) are a
        // separate BACKEND surface, not touched.
        coreModules: [
            'src/components/quoxlens/QuoxLensView.jsx',
            'src/components/quoxlens/QuoxLensLocked.jsx',
        ],
        entry: 'plugins-src/quoxlens',
        bundle: 'services/auth/first-party-plugins/quoxlens/plugin.esm.js',
        note: 'LL-7 increment 3h. /quoxlens was ungated at the route level (the real gate is inside the view via isPluginLicensed), so no routeGuards. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    {
        pluginId: 'linkedin',
        group: 'B',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/linkedin'],
        // The view still LIVES in src/ — the plugin entry imports it from there
        // (plugins-src/linkedin/index.jsx). What was deleted is the EDGE: the
        // lazy() import + views-map entry in App.jsx, the row in routeRegistry.js,
        // the barrel re-export in pages/views/index.js, and the navRegistry rail
        // row. The components/linkedin dir + useLinkedInData are exclusive to the
        // view and ship with it transitively. LinkedInChatSidebar holds this row's
        // dist-scan markers, so it is listed alongside the view (the marker guard
        // requires every file a marker lives in to be a coreModule). No free-build
        // file imports them. The LinkedIn OAuth routes are a BACKEND surface and
        // are not touched here.
        coreModules: [
            'src/pages/views/LinkedInView.jsx',
            'src/components/linkedin/LinkedInChatSidebar.jsx',
        ],
        entry: 'plugins-src/linkedin',
        bundle: 'services/auth/first-party-plugins/linkedin/plugin.esm.js',
        note: 'LL-7 increment 3d. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    {
        pluginId: 'facebook',
        group: 'B',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/facebook'],
        // Same shape as the linkedin row above: the view still LIVES in src/
        // (plugins-src/facebook/index.jsx imports it from there). What is
        // deleted is the EDGE: the lazy() import + views-map entry in
        // App.jsx, the row in routeRegistry.js, the barrel re-export in
        // pages/views/index.js, and the navRegistry rail row. The
        // components/facebook dir + useFacebookData are exclusive to the
        // view and ship with it transitively. FacebookChatSidebar holds this
        // row's dist-scan markers, so it is listed alongside the view (the
        // marker guard requires every file a marker lives in to be a
        // coreModule). No free-build file imports them.
        coreModules: [
            'src/pages/views/FacebookView.jsx',
            'src/components/facebook/FacebookChatSidebar.jsx',
        ],
        entry: 'plugins-src/facebook',
        bundle: 'services/auth/first-party-plugins/facebook/plugin.esm.js',
        note: 'FB-3. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    {
        pluginId: 'instagram',
        group: 'B',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/instagram'],
        // Same shape as the facebook row above: the view still LIVES in src/
        // (plugins-src/instagram/index.jsx imports it from there). What is
        // deleted is the EDGE: the lazy() import + views-map entry in
        // App.jsx, the row in routeRegistry.js, the barrel re-export in
        // pages/views/index.js, and the navRegistry rail row. The
        // components/instagram dir + useInstagramData are exclusive to the
        // view and ship with it transitively. InstagramChatSidebar holds
        // this row's dist-scan markers, so it is listed alongside the view
        // (the marker guard requires every file a marker lives in to be a
        // coreModule). No free-build file imports them.
        coreModules: [
            'src/pages/views/InstagramView.jsx',
            'src/components/instagram/InstagramChatSidebar.jsx',
        ],
        entry: 'plugins-src/instagram',
        bundle: 'services/auth/first-party-plugins/instagram/plugin.esm.js',
        note: 'IG-3. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    {
        pluginId: 'tiktok',
        group: 'B',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/tiktok'],
        // Same shape as the instagram row above: the view still LIVES in
        // src/ (plugins-src/tiktok/index.jsx imports it from there). What is
        // deleted is the EDGE: the lazy() import + views-map entry in
        // App.jsx, the row in routeRegistry.js, the barrel re-export in
        // pages/views/index.js, and the navRegistry rail row. The
        // components/tiktok dir + useTikTokData are exclusive to the view
        // and ship with it transitively. TikTokChatSidebar holds this row's
        // dist-scan markers, so it is listed alongside the view (the marker
        // guard requires every file a marker lives in to be a coreModule).
        // No free-build file imports them.
        coreModules: [
            'src/pages/views/TikTokView.jsx',
            'src/components/tiktok/TikTokChatSidebar.jsx',
        ],
        entry: 'plugins-src/tiktok',
        bundle: 'services/auth/first-party-plugins/tiktok/plugin.esm.js',
        note: 'TT-4. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
    // X-PLUGIN P3: deliberately PENDING, not STRIPPED. XView + /x are still
    // CORE edges (App.jsx lazy import, routeRegistry row, social rail row) and
    // the signed bundle (plugins-src/x/, sentinel QX_P1_x) exists ADDITIVELY.
    // The strip increment (delete the core edges, add markers to
    // scripts/strip-markers.mjs, flip this row to STRIPPED) is future work —
    // do NOT flip this row before those edges are actually deleted, or
    // premiumRouteStubs starts fighting the live core route.
    pending('x', 'B', ['/x'], 'Pre-strip: core edges live, signed bundle additive. Candidate coreModules when stripping: src/pages/views/XView.jsx, src/components/x/XChatSidebar.jsx.'),
    {
        pluginId: 'youtube',
        group: 'B',
        status: STRIP_STATUS.STRIPPED,
        routes: ['/youtube'],
        // The view still LIVES in src/ — the plugin entry imports it from there
        // (plugins-src/youtube/index.jsx). What was deleted is the EDGE: the
        // lazy() import + views-map entry in App.jsx, the row in routeRegistry.js,
        // the barrel re-export in pages/views/index.js, and the navRegistry rail
        // row. The components/youtube dir + youtubeClient + useYouTubeData are
        // exclusive to the view and ship with it transitively. YouTubeSetupWizard
        // holds this row's dist-scan markers, so it is listed alongside the view
        // (the marker guard requires every file a marker lives in to be a
        // coreModule). No free-build file imports them. The YouTube OAuth routes
        // are a BACKEND surface and are not touched here.
        coreModules: [
            'src/pages/views/YouTubeView.jsx',
            'src/components/youtube/YouTubeSetupWizard.jsx',
        ],
        entry: 'plugins-src/youtube',
        bundle: 'services/auth/first-party-plugins/youtube/plugin.esm.js',
        note: 'LL-7 increment 3d. Dist-scan sentinel and markers live in scripts/strip-markers.mjs, never here.',
    },
];

/** Every plugin LL-5 classified category-1 (strip), groups A and B. */
export const CATEGORY_ONE_PLUGIN_IDS = STRIP_REGISTRY.map((row) => row.pluginId);

const BY_ID = new Map(STRIP_REGISTRY.map((row) => [row.pluginId, row]));

/** @returns {object|undefined} */
export function getStripRow(pluginId) {
    return BY_ID.get(pluginId);
}

/** Rows whose code has actually left the free build. */
export function strippedPlugins(registry = STRIP_REGISTRY) {
    return registry.filter((row) => row.status === STRIP_STATUS.STRIPPED);
}

/** Rows still waiting for their strip increment (a strip IS owed). */
export function pendingPlugins(registry = STRIP_REGISTRY) {
    return registry.filter((row) => row.status === STRIP_STATUS.PENDING);
}

/**
 * Rows DELIBERATELY kept in core with no strip owed (owner ruling). Distinct
 * from pending: these are never "awaiting a strip". Their paid value is enforced
 * server-side, so they are neither stripped nor counted as owing a strip.
 */
export function coreGatedPlugins(registry = STRIP_REGISTRY) {
    return registry.filter((row) => row.status === STRIP_STATUS.CORE_GATED);
}

/** @returns {boolean} */
export function isStripped(pluginId, registry = STRIP_REGISTRY) {
    return registry.find((row) => row.pluginId === pluginId)?.status === STRIP_STATUS.STRIPPED;
}

/** The set of route paths owned by plugins that have already stripped. */
export function strippedRoutePaths(registry = STRIP_REGISTRY) {
    return new Set(strippedPlugins(registry).flatMap((row) => row.routes));
}

const basename = (modulePath) => modulePath.split('/').pop().replace(/\.[jt]sx?$/, '');

/**
 * no-restricted-imports patterns for eslint.config.js.
 *
 * ONLY stripped plugins are listed. A pending plugin's imports are still
 * correct code today, so listing it would either break the build or add a
 * permanent warning — and a lint rule nobody can get to zero is a lint rule
 * nobody reads. The list GROWS as strips land, and each strip arms its own
 * patterns by flipping one status field.
 */
export function strippedImportPatterns(registry = STRIP_REGISTRY) {
    const modulePatterns = strippedPlugins(registry)
        .flatMap((row) => row.coreModules)
        .map((modulePath) => `**/${basename(modulePath)}*`);
    // plugins-src is a BUILD INPUT for the premium bundles. Nothing in the free
    // build may import it, stripped plugin or not.
    return [...new Set([...modulePatterns, '**/plugins-src/**', 'plugins-src/**'])];
}

/**
 * The SAME boundary, expressed as esquery selectors for no-restricted-syntax.
 *
 * no-restricted-imports only sees static `import` declarations. Core route
 * wiring is `lazy(() => import('./pages/views/X'))` — a dynamic ImportExpression
 * — which is precisely the edge a strip deletes and precisely the edge someone
 * would re-add by accident. Without this second rule the boundary would be
 * enforced against the one shape the mistake does not take.
 */
export function strippedImportSelectors(registry = STRIP_REGISTRY) {
    // A basename must match as a whole path segment / filename, never as a bare
    // substring. An UNANCHORED /CommsView/ also matches a SURVIVING core import
    // of MatrixCommsView and fires a false boundary violation (the proven case
    // that motivated increment 3f). Anchor the left to a path boundary (^ or /)
    // and the right to end-of-string with an optional extension. The literal
    // slash is written \/ because esquery's own selector parser terminates a
    // regex literal on a bare slash.
    const fileSelectors = [...new Set(
        strippedPlugins(registry).flatMap((row) => row.coreModules).map(basename),
    )].map((name) => `ImportExpression > Literal[value=/(^|\\/)${name}(\\.[jt]sx?)?$/]`);
    // plugins-src is a DIRECTORY, and the specifier points INTO it
    // (plugins-src/<id>/index.jsx), so it anchors as a path segment on both
    // sides rather than to end-of-string.
    const dirSelector = 'ImportExpression > Literal[value=/(^|\\/)plugins-src(\\/|$)/]';
    return [...new Set([...fileSelectors, dirSelector])];
}

/**
 * Files the boundary rule must NOT police: the stripped modules themselves
 * (QuoxBoxView legitimately imports its own hook — they ship together in the
 * bundle) and the plugin entries that exist to import them.
 */
export function strippedBoundaryExemptFiles(registry = STRIP_REGISTRY) {
    return [
        ...strippedPlugins(registry).flatMap((row) => row.coreModules),
        'plugins-src/**',
    ];
}

export default STRIP_REGISTRY;
