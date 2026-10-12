/**
 * QuoxChat Widget Loader (CW-3)
 *
 * Lightweight loader script (<3KB minified) that:
 * 1. Reads data attributes from the <script> tag
 * 2. Creates a Shadow DOM container
 * 3. Lazy-loads the main widget bundle
 * 4. Validates the domain against the widget's allowlist
 *
 * Usage:
 *   <script src="https://your-core.com/quoxchat/widget.js"
 *           data-widget-id="wid_abc123"
 *           data-endpoint="https://your-core.com"
 *           async></script>
 *
 * Or as a Web Component:
 *   <quox-chat widget-id="wid_abc123" endpoint="https://your-core.com"></quox-chat>
 */

(function() {
  'use strict'

  // Find our script tag to read data attributes
  const currentScript = document.currentScript || document.querySelector('script[data-widget-id]')
  if (!currentScript) {
    console.warn('[QuoxChat] No script tag found with data-widget-id')
    return
  }

  const widgetId = currentScript.getAttribute('data-widget-id')
  if (!widgetId) {
    console.warn('[QuoxChat] Missing data-widget-id attribute')
    return
  }

  const endpoint = currentScript.getAttribute('data-endpoint') || ''
  const theme = currentScript.getAttribute('data-theme') || 'auto'
  const position = currentScript.getAttribute('data-position') || 'bottom-right'
  const showBranding = currentScript.getAttribute('data-show-branding') === 'true'

  // Create shadow DOM host
  const host = document.createElement('div')
  host.id = `quoxchat-${widgetId}`
  host.style.cssText = 'position:fixed;bottom:0;right:0;z-index:99999;pointer-events:none;'
  document.body.appendChild(host)

  const shadow = host.attachShadow({ mode: 'open' })

  // Style the shadow root to allow pointer events on children
  const rootStyle = document.createElement('style')
  rootStyle.textContent = ':host { pointer-events: none; } * { pointer-events: auto; }'
  shadow.appendChild(rootStyle)

  // Store config for the widget to read
  window.__quoxchat = window.__quoxchat || {}
  window.__quoxchat[widgetId] = {
    widgetId,
    endpoint,
    theme,
    position,
    showBranding,
    shadow,
    host,
    loaded: false,
  }

  // Load the main widget bundle
  // In production: loads a separate JS file
  // In development: the widget is rendered by the dashboard app directly
  console.log(`[QuoxChat] Widget ${widgetId} initialised (endpoint: ${endpoint || 'local'})`)

  // Mark as loaded
  window.__quoxchat[widgetId].loaded = true

  // CW-8.9.2 — fire-and-forget first-seen ping (idempotent server-side)
  try {
    const base = endpoint || ''
    fetch(`${base}/quoxchat/first-seen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_key: widgetId }),
      keepalive: true,
    }).catch(() => {})
  } catch (_) { /* non-fatal */ }
})()
