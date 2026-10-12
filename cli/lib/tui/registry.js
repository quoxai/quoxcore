/**
 * SCREEN_REGISTRY — single source of truth for navigable TUI screens
 *
 * Consumed by:
 *   - components/Palette.jsx  — command-palette search + result list
 *   - app.jsx                 — global jump-key (hotkey -> screen id) map
 *   - components/Layout.jsx   — breadcrumb title lookup
 *
 * Mirrors MainMenu.jsx's MENU_ITEMS (same ids/hotkeys) but lives outside
 * views/ so non-view files (app.jsx, Palette, Layout) can import it
 * without reaching into MainMenu.jsx.
 *
 * Each entry: { id, title, keywords, hotkey }
 *   id       - matches app.jsx SCREENS / VIEW_COMPONENTS key
 *   title    - human-readable label (palette list + breadcrumb segment)
 *   keywords - extra terms the palette substring-matches against
 *   hotkey   - single-char global jump key (1-0, then o/i/v/g/h)
 */

export const SCREEN_REGISTRY = [
  { id: 'fleet',       title: 'Fleet',         keywords: ['status', 'agents', 'health', 'hosts'],            hotkey: '1' },
  { id: 'agents',      title: 'Agents',        keywords: ['activate', 'deactivate', 'tools'],                hotkey: '2' },
  { id: 'tools',       title: 'Tools',         keywords: ['catalog', 'install', 'manage'],                   hotkey: '3' },
  { id: 'orgs',        title: 'Organizations', keywords: ['org', 'members', 'divisions', 'switch'],          hotkey: '4' },
  { id: 'memory',      title: 'Memory',        keywords: ['entities', 'conversations', 'search'],            hotkey: '5' },
  { id: 'brain',       title: 'Brain',         keywords: ['quoxbrain', 'brain2', 'notes', 'knowledge', 'vaults', 'second brain', 'search'], hotkey: 'b' },
  { id: 'workflows',   title: 'Workflows',     keywords: ['crud', 'run', 'steps', 'versions'],                hotkey: '6' },
  { id: 'chat',        title: 'Chat',          keywords: ['commanderq', 'interactive'],                      hotkey: '7' },
  { id: 'admin',       title: 'Admin',         keywords: ['config', 'api keys', 'services', 'logs', 'retention'], hotkey: '8' },
  { id: 'files',       title: 'Files',         keywords: ['upload', 'download', 'list', 'delete'],           hotkey: '9' },
  { id: 'backups',     title: 'Backups',       keywords: ['restore', 'verify', 'schedules'],                 hotkey: '0' },
  { id: 'objectives',  title: 'Objectives',    keywords: ['goals', 'plan', 'approve', 'start', 'track'],     hotkey: 'o' },
  { id: 'inbox',       title: 'Inbox',         keywords: ['hitl', 'approvals', 'review', 'approve', 'deny'], hotkey: 'i' },
  { id: 'vault',       title: 'Vault',         keywords: ['credentials', 'test', 'expiry', 'activity'],      hotkey: 'v' },
  { id: 'governance',  title: 'Governance',    keywords: ['ward', 'volt', 'evidence', 'policies', 'approvals'], hotkey: 'g' },
  { id: 'health',      title: 'Health',        keywords: ['service health', 'incidents', 'sparklines'],      hotkey: 'h' },
];

/** Screen id -> title, with 'menu' -> 'Main' added for the breadcrumb root. */
export const SCREEN_TITLES = {
  menu: 'Main',
  ...Object.fromEntries(SCREEN_REGISTRY.map((entry) => [entry.id, entry.title])),
};

/** Screen id -> registry entry. */
export const SCREEN_BY_ID = Object.fromEntries(SCREEN_REGISTRY.map((entry) => [entry.id, entry]));

/** hotkey -> screen id, for the global jump-key handler in app.jsx. */
export const SCREEN_BY_HOTKEY = Object.fromEntries(SCREEN_REGISTRY.map((entry) => [entry.hotkey, entry.id]));
