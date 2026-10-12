/**
 * Settings Tab Utilities (CW-8)
 *
 * Theme presets, embed code generation, deployment configuration.
 */

// Every preset maps to things quoxchat-widget.js really reads: `theme` is one
// of auto|light|dark (the widget ignores anything else), and `variables` are
// the widget's --qx-* custom properties. `accent` is applied through
// --qx-user-bg plus the .bubble/.header rules (see presetToStyleOverrides).
export const THEME_PRESETS = {
  minimal:   { label: 'Minimal',   theme: 'light', accent: '#6366f1', variables: { '--qx-body-bg': '#f8fafc' } },
  corporate: { label: 'Corporate', theme: 'light', accent: '#1e40af', variables: { '--qx-body-bg': '#f1f5f9', '--qx-border': '#cbd5e1' } },
  playful:   { label: 'Playful',   theme: 'light', accent: '#ec4899', variables: { '--qx-body-bg': '#fdf2f8', '--qx-bot-bg': '#ffffff' } },
  dark:      { label: 'Dark',      theme: 'dark',  accent: '#a855f7', variables: {} },
  glass:     { label: 'Glass',     theme: 'dark',  accent: '#38bdf8', variables: { '--qx-panel-bg': '#0f1524', '--qx-body-bg': '#0b1020' } },
  clean:     { label: 'Clean',     theme: 'light', accent: '#10b981', variables: { '--qx-body-bg': '#ffffff', '--qx-border': '#e5e7eb' } },
  bold:      { label: 'Bold',      theme: 'light', accent: '#ef4444', variables: { '--qx-border-strong': '#111827', '--qx-body-bg': '#ffffff' } },
  ocean:     { label: 'Ocean',     theme: 'light', accent: '#06b6d4', variables: { '--qx-body-bg': '#ecfeff', '--qx-bot-bg': '#ffffff' } },
}

export const PRESET_BLOCK_START = '/* qx-preset:start */'
export const PRESET_BLOCK_END = '/* qx-preset:end */'

/** CSS that applies a preset to the widget; only --qx-* variables and real classes. */
export function presetToStyleOverrides(preset) {
  const vars = { ...preset.variables, '--qx-user-bg': preset.accent }
  const decl = Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';')
  return `${PRESET_BLOCK_START}\n:host{${decl}}\n.bubble,.header{background:${preset.accent}}\n${PRESET_BLOCK_END}`
}

/** Replace (or add) the preset block inside existing style_overrides, keeping any custom CSS. */
export function applyPresetToOverrides(existing, preset) {
  const block = presetToStyleOverrides(preset)
  const re = new RegExp(PRESET_BLOCK_START.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&') + '[\\s\\S]*?' + PRESET_BLOCK_END.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'))
  const cur = String(existing || '')
  return re.test(cur) ? cur.replace(re, block) : (cur ? cur + '\n' : '') + block
}

/**
 * The endpoint the embed snippet points at. A saved embed_config.endpoint
 * wins; otherwise the dashboard's own origin, which for a self-hosted
 * instance IS the public origin the widget loads from. Without a data-endpoint
 * the widget calls whatever site embeds it (wave 6 defect 4).
 */
export function defaultEndpoint(saved) {
  const s = typeof saved === 'string' ? saved.trim() : ''
  if (s) return s
  return typeof window !== 'undefined' && window.location ? window.location.origin : ''
}

/**
 * Generate <script> embed code.
 */
export function generateEmbedCode({ widgetId, endpoint, theme, position, showBranding }) {
  const attrs = [`data-widget-id="${widgetId}"`]
  if (endpoint) attrs.push(`data-endpoint="${endpoint}"`)
  if (theme && theme !== 'auto') attrs.push(`data-theme="${theme}"`)
  if (position && position !== 'bottom-right') attrs.push(`data-position="${position}"`)
  if (showBranding === true) attrs.push('data-show-branding="true"')

  const src = endpoint ? `${endpoint.replace(/\/+$/, '')}/quoxchat/widget.js` : '/quoxchat/widget.js'
  return `<script src="${src}"\n    ${attrs.join('\n    ')}\n    async></script>`
}

/**
 * Generate <quox-chat> Web Component code.
 */
export function generateWebComponentCode({ widgetId, endpoint, theme, position, accentColor }) {
  const attrs = [`widget-id="${widgetId}"`]
  if (endpoint) attrs.push(`endpoint="${endpoint}"`)
  if (theme && theme !== 'auto') attrs.push(`theme="${theme}"`)
  if (position && position !== 'bottom-right') attrs.push(`position="${position}"`)
  if (accentColor) attrs.push(`accent="${accentColor}"`)

  const src = endpoint ? `${endpoint.replace(/\/+$/, '')}/quoxchat/widget.js` : '/quoxchat/widget.js'
  return `<quox-chat\n    ${attrs.join('\n    ')}>\n</quox-chat>\n<script src="${src}" async></script>`
}

/**
 * OpenAI-compatible LLM block (embed_config.llm). Mirrors
 * services/collector/lib/quoxchatCompatLlm.js. The API key is never written
 * here: only a vault credential reference. The private-endpoint allow entry
 * is always the EXACT origin of the base URL, never free text.
 * Returns { ok, config?, error? }.
 */
export function buildCompatLlmConfig({ baseUrl, model, vaultId, allowPrivate } = {}) {
  let u
  try { u = new URL(String(baseUrl || '').trim()) } catch { return { ok: false, error: 'Enter a valid base URL, for example http://10.0.0.5:11434/v1' } }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'The base URL must start with http:// or https://' }
  if (u.username || u.password) return { ok: false, error: 'Do not put credentials in the URL. Use a vault credential for the key.' }
  const m = String(model || '').trim()
  if (!m) return { ok: false, error: 'Enter the model name your endpoint serves.' }
  const llm = {
    provider: 'openai_compatible',
    base_url: (u.origin + u.pathname).replace(/\/+$/, ''),
    model: m.slice(0, 120),
  }
  const v = String(vaultId || '').trim()
  if (v) llm.api_key_ref = { vault_id: v }
  if (allowPrivate) llm.allow_private_origin = u.origin
  return { ok: true, config: llm }
}

/**
 * Platform-specific install instructions.
 */
export const PLATFORM_GUIDES = {
  wordpress: { label: 'WordPress', instructions: 'Paste the script tag in Appearance → Theme Editor → header.php, or use a "Header Scripts" plugin.' },
  shopify: { label: 'Shopify', instructions: 'Online Store → Themes → Edit Code → theme.liquid → paste before </body>.' },
  webflow: { label: 'Webflow', instructions: 'Project Settings → Custom Code → Footer Code → paste script tag.' },
  wix: { label: 'Wix', instructions: 'Settings → Custom Code → Add Code → Body end → paste script tag.' },
  nextjs: { label: 'Next.js', instructions: 'Add to _document.tsx or use the NPM package @quox/chat-sdk for full React integration.' },
  html: { label: 'HTML', instructions: 'Paste the script tag before </body> in your HTML file.' },
}
