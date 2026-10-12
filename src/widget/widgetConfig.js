/**
 * QuoxChat Widget Configuration (CW-3)
 *
 * Pure JS utilities for the embeddable widget. No React/Preact dependencies.
 * These are used by both the widget bundle AND the dashboard tests.
 *
 * Responsibilities:
 *   - Parse config from <script> data attributes
 *   - Define CSS custom property system (50+ tokens)
 *   - Mobile detection
 *   - Endpoint URL construction
 */

// ── Config Parsing ──────────────────────────────────────────────────────────

/**
 * Parse widget configuration from a map of data attributes.
 * In the real widget, these come from the <script> tag's dataset.
 * In tests, they're passed as a plain object.
 *
 * @param {Object} attrs — { 'data-widget-id': '...', 'data-endpoint': '...', ... }
 * @returns {Object} parsed config
 */
export function parseWidgetConfig(attrs = {}) {
  return {
    widgetId: attrs['data-widget-id'] || null,
    endpoint: attrs['data-endpoint'] || '',
    theme: attrs['data-theme'] || 'auto',
    position: attrs['data-position'] || 'bottom-right',
    showBranding: attrs['data-show-branding'] === 'true',
    locale: attrs['data-locale'] || 'en',
    greeting: attrs['data-greeting'] || null,
    accentColor: attrs['data-accent-color'] || null,
    fontFamily: attrs['data-font'] || null,
  }
}


// ── CSS Custom Properties ───────────────────────────────────────────────────

/**
 * All CSS custom properties exposed by the widget.
 * Users set these via style attribute on <quox-chat> or via ::part() selectors.
 * 50+ variables covering every visual aspect.
 */
export const WIDGET_CSS_VARIABLES = [
  // Layout
  { name: '--qc-position', default: 'fixed', description: 'Widget positioning (fixed/absolute)' },
  { name: '--qc-bottom', default: '20px', description: 'Distance from bottom' },
  { name: '--qc-right', default: '20px', description: 'Distance from right' },
  { name: '--qc-left', default: 'auto', description: 'Distance from left' },
  { name: '--qc-z-index', default: '9999', description: 'Z-index of widget' },
  { name: '--qc-width', default: '380px', description: 'Chat panel width (desktop)' },
  { name: '--qc-height', default: '520px', description: 'Chat panel height (desktop)' },
  { name: '--qc-mobile-width', default: '100%', description: 'Chat panel width (mobile)' },
  { name: '--qc-mobile-height', default: '80vh', description: 'Chat panel height (mobile)' },

  // Colors — core
  { name: '--qc-accent', default: '#7c3aed', description: 'Primary accent colour' },
  { name: '--qc-accent-hover', default: '#6d28d9', description: 'Accent on hover' },
  { name: '--qc-bg', default: '#ffffff', description: 'Panel background' },
  { name: '--qc-bg-dark', default: '#0f0f14', description: 'Panel background (dark theme)' },
  { name: '--qc-text', default: '#1a1a1a', description: 'Primary text colour' },
  { name: '--qc-text-dark', default: '#ffffff', description: 'Primary text (dark theme)' },
  { name: '--qc-text-secondary', default: '#6b7280', description: 'Secondary text colour' },
  { name: '--qc-text-secondary-dark', default: 'rgba(255,255,255,0.65)', description: 'Secondary text (dark)' },

  // Colors — bubbles
  { name: '--qc-bubble-user-bg', default: '#7c3aed', description: 'User message bubble background' },
  { name: '--qc-bubble-user-text', default: '#ffffff', description: 'User message text' },
  { name: '--qc-bubble-bot-bg', default: '#f3f4f6', description: 'Bot message bubble background' },
  { name: '--qc-bubble-bot-bg-dark', default: 'rgba(255,255,255,0.06)', description: 'Bot bubble background (dark)' },
  { name: '--qc-bubble-bot-text', default: '#1a1a1a', description: 'Bot message text' },
  { name: '--qc-bubble-bot-text-dark', default: '#ffffff', description: 'Bot message text (dark)' },
  { name: '--qc-bubble-radius', default: '16px', description: 'Message bubble border radius' },

  // Colors — header
  { name: '--qc-header-bg', default: '#7c3aed', description: 'Header background' },
  { name: '--qc-header-text', default: '#ffffff', description: 'Header text' },
  { name: '--qc-header-height', default: '56px', description: 'Header height' },

  // Colors — input
  { name: '--qc-input-bg', default: '#ffffff', description: 'Input area background' },
  { name: '--qc-input-bg-dark', default: 'rgba(255,255,255,0.04)', description: 'Input background (dark)' },
  { name: '--qc-input-border', default: '#e5e7eb', description: 'Input border' },
  { name: '--qc-input-border-dark', default: 'rgba(255,255,255,0.1)', description: 'Input border (dark)' },
  { name: '--qc-input-text', default: '#1a1a1a', description: 'Input text colour' },
  { name: '--qc-input-text-dark', default: '#ffffff', description: 'Input text (dark)' },
  { name: '--qc-input-placeholder', default: '#9ca3af', description: 'Input placeholder' },
  { name: '--qc-input-radius', default: '12px', description: 'Input border radius' },

  // Colors — trigger button
  { name: '--qc-trigger-bg', default: '#7c3aed', description: 'Trigger button background' },
  { name: '--qc-trigger-text', default: '#ffffff', description: 'Trigger button icon/text' },
  { name: '--qc-trigger-size', default: '56px', description: 'Trigger button diameter' },
  { name: '--qc-trigger-radius', default: '50%', description: 'Trigger button radius' },
  { name: '--qc-trigger-shadow', default: '0 4px 16px rgba(124,58,237,0.3)', description: 'Trigger button shadow' },

  // Typography
  { name: '--qc-font', default: "'Inter', system-ui, sans-serif", description: 'Font family' },
  { name: '--qc-font-mono', default: "'JetBrains Mono', monospace", description: 'Monospace font' },
  { name: '--qc-font-size', default: '14px', description: 'Base font size' },
  { name: '--qc-font-size-small', default: '12px', description: 'Small font size' },
  { name: '--qc-line-height', default: '1.5', description: 'Base line height' },

  // Spacing
  { name: '--qc-padding', default: '16px', description: 'Panel inner padding' },
  { name: '--qc-gap', default: '8px', description: 'Message gap' },
  { name: '--qc-radius', default: '16px', description: 'Panel border radius' },
  { name: '--qc-shadow', default: '0 8px 32px rgba(0,0,0,0.12)', description: 'Panel shadow' },
  { name: '--qc-shadow-dark', default: '0 8px 32px rgba(0,0,0,0.4)', description: 'Panel shadow (dark)' },

  // Branding
  { name: '--qc-branding-display', default: 'flex', description: '"Powered by" badge display (none to hide)' },
  { name: '--qc-branding-text', default: '#9ca3af', description: '"Powered by" text colour' },
  { name: '--qc-branding-size', default: '10px', description: '"Powered by" font size' },

  // Animation
  { name: '--qc-transition', default: '0.25s cubic-bezier(0.4, 0, 0.2, 1)', description: 'Default transition' },
  { name: '--qc-panel-animation', default: 'qc-slide-up', description: 'Panel open animation name' },

  // Source citations
  { name: '--qc-citation-bg', default: 'rgba(124,58,237,0.06)', description: 'Citation badge background' },
  { name: '--qc-citation-text', default: '#7c3aed', description: 'Citation badge text' },
  { name: '--qc-citation-radius', default: '4px', description: 'Citation badge radius' },

  // Typing indicator
  { name: '--qc-typing-dot-color', default: '#7c3aed', description: 'Typing indicator dot colour' },
  { name: '--qc-typing-dot-size', default: '6px', description: 'Typing indicator dot size' },
]

/**
 * Get default CSS variables as a key-value object.
 */
export function getDefaultCSSVariables() {
  const vars = {}
  for (const v of WIDGET_CSS_VARIABLES) {
    vars[v.name] = v.default
  }
  return vars
}


// ── Mobile Detection ────────────────────────────────────────────────────────

/**
 * Check if viewport width is mobile.
 * @param {number} width — viewport width in pixels
 * @returns {boolean}
 */
export function isMobileViewport(width) {
  return width < 768
}


// ── Endpoint URL Construction ───────────────────────────────────────────────

/**
 * Build a full URL to a QuoxChat collector endpoint.
 *
 * @param {string} endpoint — base Core URL (e.g., 'https://core.acme.com')
 * @param {string} path — endpoint path ('message', 'config', 'session', 'feedback')
 * @param {string} [param] — optional path parameter (e.g., widget public key)
 * @returns {string} full URL
 */
export function buildWidgetEndpointURL(endpoint, path, param) {
  const base = (endpoint || '').replace(/\/+$/, '')
  const segments = [base, 'collector', 'quoxchat', path]
  if (param) segments.push(param)
  return segments.join('/')
}
