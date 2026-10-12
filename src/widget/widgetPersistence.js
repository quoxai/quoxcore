/**
 * Widget Persistence Utilities (CW-8.2)
 *
 * Payload construction for widget CRUD and conversation storage.
 * Used by both auth routes (server) and dashboard UI (client).
 */

/**
 * Generate a ULID-style unique ID.
 */
function generateId() {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 10)
  return `${ts}${rand}`
}

/**
 * Build payload for POST /api/orgs/:orgId/widgets (create widget).
 */
export function buildWidgetCreatePayload({ name, greeting, domain, orgId, theme = 'auto', position = 'bottom-right' }) {
  const publicKey = `wid_${generateId()}`

  return {
    name: name || 'Chat Widget',
    public_key: publicKey,
    allowed_domains_json: JSON.stringify(domain ? [domain, 'localhost'] : ['localhost']),
    deployment_type: 'embed',
    embed_config_json: JSON.stringify({
      greeting: greeting || 'Hi! How can I help?',
      theme,
      position,
    }),
    qdrant_namespace: `widget_${publicKey}`,
    status: 'draft',
  }
}

/**
 * Build payload for PATCH /api/orgs/:orgId/widgets/:id (update settings).
 */
export function buildWidgetUpdatePayload({ domains, theme, greeting, position, monthlyBudgetCents, budgetAction }) {
  const payload = {}

  if (domains !== undefined) {
    payload.allowed_domains_json = JSON.stringify(domains)
  }

  const embedConfig = {}
  if (theme !== undefined) embedConfig.theme = theme
  if (greeting !== undefined) embedConfig.greeting = greeting
  if (position !== undefined) embedConfig.position = position
  if (Object.keys(embedConfig).length > 0) {
    payload.embed_config_json = JSON.stringify(embedConfig)
  }

  if (monthlyBudgetCents !== undefined) payload.monthly_budget_cents = monthlyBudgetCents
  if (budgetAction !== undefined) payload.budget_action = budgetAction

  return payload
}

/**
 * Build a conversation record for widget_conversations table.
 */
export function buildConversationRecord({ widgetId, orgId, visitorId, correlationId, visitorEmail, visitorName, pageUrl }) {
  return {
    id: `conv_${generateId()}`,
    widget_id: widgetId,
    org_id: orgId,
    visitor_id: visitorId || 'anon',
    visitor_email: visitorEmail || null,
    visitor_name: visitorName || null,
    visitor_metadata_json: JSON.stringify({ page_url: pageUrl || null }),
    status: 'active',
    correlation_id: correlationId || `corr_${generateId()}`,
    message_count: 0,
    started_at: new Date().toISOString(),
  }
}

/**
 * Build a message record for widget_messages table.
 */
export function buildMessageRecord({ conversationId, widgetId, role, content, sources, confidence, injectionScore, envelopeId, toolCalls }) {
  return {
    id: `msg_${generateId()}`,
    conversation_id: conversationId,
    widget_id: widgetId,
    role: role || 'user',
    content: content || '',
    sources_json: sources ? JSON.stringify(sources) : null,
    confidence: confidence ?? null,
    tool_calls_json: toolCalls ? JSON.stringify(toolCalls) : null,
    envelope_id: envelopeId || null,
    injection_score: injectionScore ?? 0,
    filtered: 0,
    created_at: new Date().toISOString(),
  }
}
