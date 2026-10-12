export const TRUSTED_ADMIN_ONLY_LABEL = 'Trusted admin only'

export const COMMUNITY_PLUGIN_TRUST_NOTICE =
  'Community plugins are trusted-admin extensions. Install only from sources you trust.'

export const COMMUNITY_PLUGIN_TRUST_DETAIL =
  'Community plugins can add routes, sidebar items, styles, and backend/API behavior. Treat them like code you are choosing to run inside your estate.'

export const AOCL_PLUGIN_TRUST_NOTICE =
  'AOCL layer plugins are a trusted-admin feature. JSON plugins are preferred; JavaScript plugins are only for reviewed code from trusted sources.'

export const AOCL_PLUGIN_JS_WARNING =
  'JavaScript AOCL plugins use controlled dynamic evaluation during import. Only install reviewed code from trusted sources.'

export function isDynamicPluginExtension(filename = '') {
  return /\.m?js$/i.test(filename)
}
