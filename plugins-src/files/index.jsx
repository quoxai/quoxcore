/**
 * Files — first-party plugin entry (LICENSE-LAUNCH LL-7 increment 3h).
 *
 * A THIN entry, following the quoxbox-macmini pilot / bastion-fleet pattern
 * exactly. It imports the existing view from its current home in the dashboard
 * source tree rather than moving it: the strip is about proving the loader
 * contract, not relocating code. Rollup follows the import from here, so
 * FilesView (and the components/files view tree it pulls transitively —
 * FileManager, FolderTree, FolderChat, FileSkillPanel, ArchivistPanel) compile
 * into plugin.esm.js and are NOT reachable from the free dashboard build once
 * the /files row and its import are deleted from the core tables.
 *
 * The shared pickers under components/files/shared/ (FilePicker, FileDropZone,
 * FileUploadToast) STAY in the free build: they are imported directly by core
 * surfaces (assistant-editor KnowledgeTab) and are leaf components the stripped
 * view tree does not reach through the barrel. The file backend (fileStorage /
 * fileObjectsClient services + collector file routes) is a separate surface and
 * is left in place — only the FRONTEND view strips.
 *
 * Contract (src/services/thirdPartyPluginHost.js):
 *   - React/JSX runtime come from window.__quoxSharedDeps, externalised by
 *     quox-plugin-vite, so this bundle never ships a second React.
 *   - The bundle registers itself through window.__quoxPluginRegister(id, exports).
 *   - The route keeps its ROOT path (/files) only because the host verifies the
 *     Ed25519 signature over this plugin's manifest against a Quox publisher key.
 *     Unsigned, it lands under /plugins/files/.
 *   - The stripped /files core row was UNGATED, so no routeGuards.
 */

import FilesView from '../../src/pages/views/FilesView.jsx'

const PLUGIN_ID = 'files'

const pluginExports = {
    routes: {
        '/files': FilesView,
    },
    sidebar: [
        { path: '/files', label: 'Files', icon: 'folder' },
    ],
    // LL-7 review note 2: the dist scan's positive control needs a marker that
    // SURVIVES minification. A bare unused const is tree-shaken; a property on
    // the object handed to __quoxPluginRegister cannot be, because the object
    // escapes into a call the bundler cannot see through.
    __qxSentinel: 'QX_P1_files',
}

if (typeof window !== 'undefined' && typeof window.__quoxPluginRegister === 'function') {
    window.__quoxPluginRegister(PLUGIN_ID, pluginExports)
}

export default pluginExports
