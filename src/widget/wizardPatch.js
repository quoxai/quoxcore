/**
 * Wizard PATCH builder: only send what the admin actually changed, so
 * re-running the wizard on an existing widget can never overwrite the real
 * greeting (embed_config.greeting) or silently drop other allowed domains.
 */
export function parseJson(v, fallback) {
  if (v && typeof v === 'object') return v
  try { return v ? JSON.parse(v) : fallback } catch { return fallback }
}

export function existingGreeting(widget) {
  if (!widget) return ''
  const cfg = parseJson(widget.embed_config ?? widget.embed_config_json, {})
  return (typeof cfg?.greeting === 'string' && cfg.greeting) || (typeof widget.greeting === 'string' ? widget.greeting : '') || ''
}

export function existingDomains(widget) {
  const d = parseJson(widget?.allowed_domains ?? widget?.allowed_domains_json, [])
  return Array.isArray(d) ? d : []
}

export function buildWizardPatch(widget, { name, businessName, greeting, domain }) {
  const patch = {}
  if (name !== (widget?.name || '')) patch.name = name
  if ((businessName || '').trim() !== (widget?.business_name || '')) patch.business_name = (businessName || '').trim()
  if (greeting !== existingGreeting(widget)) patch.greeting = greeting
  const doms = existingDomains(widget)
  const d = (domain || '').trim()
  // Clearing the field never wipes the list; editing replaces the primary
  // (first) entry and keeps every other allowed domain.
  if (d && d !== (doms[0] || '')) patch.allowed_domains = [d, ...doms.slice(1).filter((x) => x !== d)]
  return patch
}
