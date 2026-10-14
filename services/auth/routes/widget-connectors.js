/**
 * Widget Connectors & Tools — CW-9.1
 *
 * Connectors = reusable integrations (database, rest_api, webhook, quoxflow).
 * Tools = LLM-callable functions, backed by a connector or a builtin (lead_capture, human_handoff, redirect_url,
 * email_transcript, book_demo, create_ticket, send_resource).
 *
 * All endpoints are org-scoped via requireOrgMembership.
 * Vault refs are stored but never returned in full to the client (we return a boolean presence flag).
 */

import { Router } from 'express';
import crypto from 'crypto';
import { prepare } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOrgMembership } from '../middleware/org.js';
import { ulid, getPagination, formatPaginatedResponse } from '../utils/helpers.js';
import { listTemplates, getTemplate } from '../lib/widgetConnectorGallery.js';
import { denyIfNotPro } from '../lib/widgetTierGate.js';
import { mergeIdentifiedAttrs } from '../lib/widgetVisitorMemory.js';
import { alertsConfigured } from '../lib/widgetAlertsWarning.js';
// PRO-2: transcript email send + witness.
import { sendEmail } from '../utils/emailService.js';
import { logAudit } from '../utils/audit.js';
import { sha256 } from '../utils/crypto.js';

const router = Router();
router.use(requireAuth);

function safeCompare(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
}

function requireInternalAuth(req, res, next) {
  const expected = process.env.INTERNAL_SERVICE_KEY;
  if (!expected) return res.status(401).json({ error: 'Service key not configured' });
  const key = req.headers['x-service-key'];
  if (key && safeCompare(String(key), expected)) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

export const widgetConnectorsInternalRouter = Router();
widgetConnectorsInternalRouter.use(requireInternalAuth);

/**
 * GET /internal/widgets/:widgetId/tools (CW-9.2)
 * Collector fetches active tools for a widget before each LLM call.
 * Returns Anthropic-format function schemas — same shape works for OpenAI
 * after a flatten (type:object is already compatible).
 */
widgetConnectorsInternalRouter.get('/widgets/:widgetId/tools', (req, res) => {
  try {
    const { widgetId } = req.params;
    // CW-SEC-1: accept either internal id or public_key.
    const widget = prepare('SELECT id, org_id FROM website_widgets WHERE id = ? OR public_key = ?').get(widgetId, widgetId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });

    const rows = prepare(`
      SELECT t.id, t.name, t.description, t.tool_type, t.builtin_kind, t.connector_id,
             t.parameters_json, t.config_json, t.rate_limit_per_session,
             c.connector_type, c.config_json AS connector_config_json
      FROM widget_tools t
      LEFT JOIN widget_connectors c ON c.id = t.connector_id
      WHERE t.widget_id = ? AND t.status = 'active'
      ORDER BY t.created_at ASC
    `).all(widget.id);

    const tools = rows.map(r => {
      let input_schema = { type: 'object', properties: {} };
      let tool_config = {};
      let connector_config = null;
      try { input_schema = r.parameters_json ? JSON.parse(r.parameters_json) : input_schema; } catch { /* noop */ }
      try { tool_config = r.config_json ? JSON.parse(r.config_json) : {}; } catch { /* noop */ }
      if (r.connector_config_json) {
        try { connector_config = JSON.parse(r.connector_config_json); } catch { /* noop */ }
      }
      return {
        id: r.id,
        name: r.name,
        description: r.description || '',
        input_schema,
        tool_type: r.tool_type,
        builtin_kind: r.builtin_kind,
        connector_id: r.connector_id,
        connector_type: r.connector_type || null,
        tool_config,
        connector_config,
        rate_limit_per_session: r.rate_limit_per_session,
      };
    });

    res.json({ widget_id: widget.id, org_id: widget.org_id, tools });
  } catch (err) {
    console.error('Error listing widget tools (internal):', err);
    res.status(500).json({ error: 'Failed to list tools' });
  }
});

/**
 * POST /internal/widgets/:widgetId/tools/:toolId/record-usage (CW-9.2)
 * Collector reports execution outcome after each tool invocation.
 * Body: { success: boolean }
 */
widgetConnectorsInternalRouter.post('/widgets/:widgetId/tools/:toolId/record-usage', (req, res) => {
  try {
    const { widgetId, toolId } = req.params;
    const { success } = req.body || {};
    // CW-SEC-1: accept either internal id or public_key.
    const widget = prepare('SELECT id FROM website_widgets WHERE id = ? OR public_key = ?').get(widgetId, widgetId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });
    const tool = prepare('SELECT id FROM widget_tools WHERE id = ? AND widget_id = ?').get(toolId, widget.id);
    if (!tool) return res.status(404).json({ error: 'Tool not found' });
    prepare(`
      UPDATE widget_tools
      SET use_count = COALESCE(use_count, 0) + 1,
          error_count = COALESCE(error_count, 0) + CASE WHEN ? THEN 0 ELSE 1 END,
          last_used_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(success ? 1 : 0, toolId);
    res.json({ success: true });
  } catch (err) {
    console.error('Error recording tool usage:', err);
    res.status(500).json({ error: 'Failed to record usage' });
  }
});

/**
 * PRO-1: Create an HITL inbox item for a newly captured lead. Fail-soft by
 * design, same contract as createHandoffInboxItem below: a lead is already
 * safely persisted by the time this runs, so an unreachable inbox must
 * never turn a successful capture into an error response.
 *
 * PRO-3: `demo` + `preferredTime` let the book_demo builtin ride this same
 * lead + inbox pattern, just flagged with a higher priority and a distinct
 * title so a demo request doesn't get lost in a plain-lead inbox.
 */
async function createLeadInboxItem({ orgId, widgetId, conversationId, visitorId, name, email, intent, demo, preferredTime }) {
  if (!orgId) {
    console.warn('[widget-connectors] lead captured with no org_id, cannot create inbox item');
    return false;
  }
  const lines = [
    `Widget: ${widgetId}`,
    `Name: ${name || 'not provided'}`,
    `Email: ${email}`,
  ];
  if (intent) lines.push(`Intent: ${intent}`);
  if (demo && preferredTime) lines.push(`Preferred time: ${preferredTime}`);
  if (conversationId) lines.push(`Conversation: ${conversationId}`);

  try {
    const resp = await fetch(`${AUTH_INTERNAL_URL}/api/internal/orgs/${encodeURIComponent(orgId)}/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': process.env.INTERNAL_SERVICE_KEY || '' },
      body: JSON.stringify({
        kind: 'task',
        priority: demo ? 'high' : 'normal',
        title: demo ? 'Demo requested' : 'New lead captured',
        body_md: lines.join('\n'),
        payload: {
          source: demo ? 'quoxchat_book_demo' : 'quoxchat_lead',
          widget_id: widgetId,
          conversation_id: conversationId || null,
          visitor_id: visitorId || null,
          name: name || null,
          email,
          intent: intent || null,
          demo: !!demo,
          preferred_time: preferredTime || null,
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.error(`[widget-connectors] inbox create returned ${resp.status} for lead: ${text.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[widget-connectors] Failed to create lead inbox item:', err?.message || err);
    return false;
  }
}

/**
 * POST /internal/widgets/:widgetId/leads (CW-9.3, PRO-1 adds intent + inbox notify,
 * PRO-3 adds the demo flag the book_demo builtin sets via metadata)
 * lead_capture / book_demo builtins call this to persist a captured lead.
 * Body: { visitor_id, conversation_id?, name?, email, phone?, company?, notes?, metadata? }
 * metadata.intent (free text: pricing, demo, support, etc.) and
 * metadata.demo / metadata.preferred_time ride in metadata_json — no new
 * column needed.
 */
/**
 * QUOXCHAT-EMAIL D2 — chat-provided contact details become the visitor's
 * identified attrs, provenance 'chat'. This is the chokepoint for every
 * lead-shaped builtin (lead_capture, book_demo, create_ticket,
 * book_appointment, schedule_demo, leave_message): they all land here, so
 * the transcript tool stops being blind to an email the visitor typed in
 * the conversation. Fail-soft by contract: a lead/ticket insert must never
 * fail because the stamp did.
 *
 * Provenance rule mirrors the visitors/upsert endpoint: 'chat', unless the
 * SAME address is already identify-sourced, in which case trust is kept.
 * The visitor's verified flag is never touched (monotonic, HMAC-only).
 */
function stampChatContact(widget, visitorId, { email, name } = {}) {
  try {
    if (!visitorId || typeof visitorId !== 'string') return;
    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
    const existing = prepare('SELECT identified_attrs_json FROM widget_visitors WHERE widget_id = ? AND visitor_id = ?').get(widget.id, visitorId);
    let existingAttrs = {};
    if (existing?.identified_attrs_json) {
      try { existingAttrs = JSON.parse(existing.identified_attrs_json); } catch { /* noop */ }
    }
    const sameEmail = typeof existingAttrs.email === 'string'
      && existingAttrs.email.trim().toLowerCase() === email.trim().toLowerCase();
    const email_source = (sameEmail && existingAttrs.email_source === 'identify') ? 'identify' : 'chat';
    const incoming = { email: email.trim(), email_source };
    if (name && typeof name === 'string' && name.trim()) incoming.name = name.trim();
    const merged = JSON.stringify(mergeIdentifiedAttrs(existingAttrs, incoming));
    if (existing) {
      prepare(`UPDATE widget_visitors SET identified_attrs_json = ?, last_seen = datetime('now'), updated_at = datetime('now') WHERE widget_id = ? AND visitor_id = ?`)
        .run(merged, widget.id, visitorId);
    } else {
      prepare(`INSERT INTO widget_visitors (visitor_id, widget_id, org_id, first_seen, last_seen, conversation_count, identified_attrs_json)
               VALUES (?, ?, ?, datetime('now'), datetime('now'), 0, ?)`)
        .run(visitorId, widget.id, widget.org_id, merged);
    }
  } catch (err) {
    console.warn('[widget-connectors] chat-contact stamp failed (non-fatal):', err?.message || err);
  }
}

widgetConnectorsInternalRouter.post('/widgets/:widgetId/leads', async (req, res) => {
  try {
    const { widgetId } = req.params;
    const { visitor_id, conversation_id, name, email, phone, company, notes, metadata } = req.body || {};
    // CW-SEC-1: accept either internal id or public_key.
    const widget = prepare('SELECT id, org_id, notification_settings_json FROM website_widgets WHERE id = ? OR public_key = ?').get(widgetId, widgetId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });
    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'valid email required' });
    }

    // QUOXCHAT-EMAIL D2 — the visitor just typed their contact email into the
    // chat; make it their identified email (provenance 'chat') so the
    // transcript tool can use it. Before the insert on purpose: the stamp
    // holds for duplicates too, and a failed insert never orphans it.
    stampChatContact(widget, visitor_id, { email, name });

    const intent = typeof metadata?.intent === 'string' ? metadata.intent.trim().slice(0, 200) : null;
    const demo = metadata?.demo === true;
    const preferredTime = typeof metadata?.preferred_time === 'string' ? metadata.preferred_time.trim().slice(0, 200) : null;
    const id = ulid();
    try {
      prepare(`
        INSERT INTO widget_leads (id, widget_id, org_id, conversation_id, visitor_id, name, email, phone, company, notes, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, widget.id, widget.org_id,
        conversation_id || null, visitor_id || null,
        name || null, email, phone || null, company || null, notes || null,
        JSON.stringify(metadata || {}),
      );
      // PRO-1: notify a human. Fail-soft, awaited so the collector's tool
      // executor call resolves after the escalation attempt, but a slow or
      // failed inbox call can never undo the insert above or turn this into
      // a 500 (the lead is already durably captured).
      const notified = await createLeadInboxItem({
        orgId: widget.org_id,
        widgetId: widget.id,
        conversationId: conversation_id || null,
        visitorId: visitor_id || null,
        name: name || null,
        email,
        intent,
        demo,
        preferredTime,
      });
      // Wave 7: a failed notification must be visible. Flag the lead (admin
      // banner counts these) and tell the caller so the visitor reply is honest.
      if (!notified) {
        try { prepare('UPDATE widget_leads SET notification_failed = 1 WHERE id = ?').run(id); } catch (e) { console.error('[widget-connectors] failed to flag lead notification_failed:', e?.message || e); }
      }
      res.status(201).json({ success: true, id, duplicate: false, notified, alerts_configured: alertsConfigured(widget.notification_settings_json) });
    } catch (err) {
      if (String(err.message || '').includes('UNIQUE')) {
        // Same email + conversation, return the existing row rather than erroring the LLM.
        // No new inbox item on a duplicate: a human was already notified the first time.
        const existing = prepare('SELECT id FROM widget_leads WHERE widget_id = ? AND email = ? AND conversation_id IS ?').get(widget.id, email, conversation_id || null);
        return res.json({ success: true, id: existing?.id || null, duplicate: true });
      }
      throw err;
    }
  } catch (err) {
    console.error('Error capturing lead:', err);
    res.status(500).json({ error: 'Failed to capture lead' });
  }
});

// CW-9.3 handoff-to-inbox, using the auth service's own internal inbox-create
// endpoint (POST /api/internal/orgs/:orgId/inbox, routes/inbox.js). Same
// route + payload shape the collector's Slack/Telegram webhooks use
// (services/collector/lib/slackWebhook.js / telegramWebhook.js
// createInboxItem): kind, priority, title, body_md, payload. Since this
// file already runs inside the auth process, the call is a loopback fetch
// rather than a cross-service one.
const AUTH_INTERNAL_URL = process.env.AUTH_INTERNAL_URL
  || `http://localhost:${process.env.AUTH_PORT || 3101}`;

const INBOX_PRIORITIES = ['low', 'normal', 'high', 'urgent'];

/**
 * Handover-summary fallback: when the model does not fill `summary` (or the
 * widget predates the schema change), build a minimal one server-side so an
 * operator never gets a contextless pickup. No LLM calls here, just the
 * facts already on hand.
 */
function buildFallbackHandoffSummary(visitorName, reason) {
  const parts = [];
  if (visitorName) parts.push(`Visitor ${visitorName}.`);
  if (reason) parts.push(`Reason: ${reason}.`);
  if (parts.length === 0) return null;
  return parts.join(' ').slice(0, 500);
}

/**
 * Create an HITL inbox item for a widget human_handoff request. Fail-soft
 * by design: a human_handoff tool call must never fail (or leave the
 * conversation un-flipped) just because the inbox is briefly unreachable.
 */
async function createHandoffInboxItem({ orgId, widgetId, conversationId, visitorId, visitorName, visitorEmail, reason, priority, lastMessage, summary }) {
  if (!orgId) {
    console.warn('[widget-connectors] handoff requested with no org_id, cannot create inbox item');
    return false;
  }
  const visitorLabel = visitorName || visitorEmail || visitorId || 'unknown visitor';
  const lines = [
    `Widget: ${widgetId}`,
    `Conversation: ${conversationId}`,
    `Visitor: ${visitorLabel}`,
  ];
  if (summary) lines.push(`Summary: ${summary}`);
  if (reason) lines.push(`Reason: ${reason}`);
  if (lastMessage && lastMessage.content) {
    lines.push('', `Last message (${lastMessage.role}):`, lastMessage.content);
  }

  // QUOXCHAT-PRO visitor name: a named visitor headlines the inbox item
  // ("Sarah asked for a human") so operators can tell chats apart when
  // several visitors pile in at once.
  const title = visitorName
    ? `${String(visitorName).slice(0, 60)} asked for a human`
    : 'Live chat handoff requested';

  try {
    const resp = await fetch(`${AUTH_INTERNAL_URL}/api/internal/orgs/${encodeURIComponent(orgId)}/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': process.env.INTERNAL_SERVICE_KEY || '' },
      body: JSON.stringify({
        kind: 'task',
        priority,
        title,
        body_md: lines.join('\n'),
        payload: {
          source: 'quoxchat_widget',
          widget_id: widgetId,
          conversation_id: conversationId,
          visitor_id: visitorId || null,
          visitor_name: visitorName || null,
          visitor_email: visitorEmail || null,
          reason: reason || null,
          summary: summary || null,
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.error(`[widget-connectors] inbox create returned ${resp.status} for handoff: ${text.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[widget-connectors] Failed to create handoff inbox item:', err?.message || err);
    return false;
  }
}

/**
 * POST /internal/widgets/:widgetId/conversations/:conversationId/handoff (CW-9.3)
 * human_handoff builtin marks a conversation as handed off for human follow-up,
 * and escalates into the HITL inbox so a human is actually notified.
 * Body: { reason?, priority?, summary? }
 *
 * QUOXCHAT-PRO handover summary: `summary` is authored by the LLM in the
 * same tool call that fires the handoff. It is persisted into the
 * conversation transcript (role 'assistant', so LiveSupportView/LogsTab
 * render it as an AI bubble) and threaded into the HITL inbox item, so the
 * human teammate picks up with context instead of a bare conversation link.
 * When the model omits it, a minimal one is built server-side from
 * reason + visitor name (no LLM call) so a pickup is never contextless.
 */
widgetConnectorsInternalRouter.post('/widgets/:widgetId/conversations/:conversationId/handoff', async (req, res) => {
  try {
    const { widgetId, conversationId } = req.params;
    const { reason, priority, visitor_name: hintName, visitor_email: hintEmail, summary } = req.body || {};
    // CW-SEC-1: accept either internal id or public_key.
    const widget = prepare('SELECT id, org_id, notification_settings_json FROM website_widgets WHERE id = ? OR public_key = ?').get(widgetId, widgetId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });
    const conv = prepare('SELECT id, status, visitor_id, visitor_name, visitor_email FROM widget_conversations WHERE id = ? AND widget_id = ?').get(conversationId, widget.id);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    if (conv.status === 'handed_off') return res.json({ success: true, already: true });

    // QUOXCHAT-PRO visitor name: resolve who this is at handoff time —
    // the moment identity starts mattering to a human. Precedence:
    // conversation row (widget name form already stamped it) > collector
    // hint (identified attrs threaded through the executor) >
    // widget_visitors.identified_attrs_json (identify() ran earlier but the
    // conversation was never stamped). Whatever resolves is written back to
    // the conversation so the room label / LogsTab / operator context all
    // agree, without overwriting anything already there.
    let visitorName = conv.visitor_name || (typeof hintName === 'string' && hintName.trim() ? hintName.trim().slice(0, 120) : null);
    let visitorEmail = conv.visitor_email || (typeof hintEmail === 'string' && hintEmail.trim() ? hintEmail.trim().slice(0, 254) : null);
    if (!visitorName || !visitorEmail) {
      try {
        const visitorRow = conv.visitor_id
          ? prepare('SELECT identified_attrs_json FROM widget_visitors WHERE widget_id = ? AND visitor_id = ?').get(widget.id, conv.visitor_id)
          : null;
        const attrs = visitorRow?.identified_attrs_json ? JSON.parse(visitorRow.identified_attrs_json) : null;
        if (attrs && typeof attrs === 'object') {
          if (!visitorName) {
            const composed = (typeof attrs.name === 'string' && attrs.name.trim())
              || [attrs.first_name, attrs.last_name].filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim()).join(' ');
            if (composed) visitorName = String(composed).trim().slice(0, 120);
          }
          if (!visitorEmail && typeof attrs.email === 'string' && attrs.email.trim()) {
            visitorEmail = attrs.email.trim().slice(0, 254);
          }
        }
      } catch (attrErr) {
        console.warn('[widget-connectors] visitor attrs resolve failed (non-fatal):', attrErr?.message || attrErr);
      }
    }

    const trimmedReason = reason ? String(reason).slice(0, 500) : null;
    prepare(`
      UPDATE widget_conversations
      SET status = 'handed_off',
          resolution = COALESCE(resolution, ?),
          visitor_name = COALESCE(visitor_name, ?),
          visitor_email = COALESCE(visitor_email, ?),
          last_message_at = datetime('now')
      WHERE id = ?
    `).run(trimmedReason || 'handed_off_by_tool', visitorName, visitorEmail, conversationId);

    const resolvedPriority = INBOX_PRIORITIES.includes(priority) ? priority : 'normal';

    let lastMessage = null;
    try {
      lastMessage = prepare(`
        SELECT role, content FROM widget_messages
        WHERE conversation_id = ?
        ORDER BY created_at DESC LIMIT 1
      `).get(conversationId);
      if (lastMessage) lastMessage = { role: lastMessage.role, content: String(lastMessage.content || '').slice(0, 1000) };
    } catch (err) {
      console.error('[widget-connectors] Failed to load last message for handoff:', err?.message || err);
    }

    // Handover summary: prefer what the model authored; fall back to a
    // minimal server-built note (no LLM call) so an operator never gets a
    // contextless pickup.
    const rawSummary = typeof summary === 'string' && summary.trim() ? summary.trim().slice(0, 500) : null;
    const finalSummary = rawSummary || buildFallbackHandoffSummary(visitorName, trimmedReason);

    // Persist the summary into the conversation transcript so a human
    // teammate picking it up in LiveSupportView/LogsTab sees it inline.
    // Role 'assistant' renders as an AI bubble in both views. Non-fatal:
    // a write failure here must never undo the status flip above.
    if (finalSummary) {
      try {
        prepare(`
          INSERT INTO widget_messages (id, conversation_id, widget_id, org_id, role, content, created_at)
          VALUES (?, ?, ?, ?, 'assistant', ?, datetime('now'))
        `).run(ulid(), conversationId, widget.id, widget.org_id, `Handover summary: ${finalSummary}`);
      } catch (err) {
        console.error('[widget-connectors] Failed to persist handover summary message:', err?.message || err);
      }
    }

    // Escalate into the HITL inbox so a human is actually notified. This is
    // awaited (createHandoffInboxItem never throws, it only logs) so the
    // caller gets a response after the escalation attempt completes, but a
    // failed or slow inbox call still cannot undo the status flip above or
    // turn this into a 500 (the handoff itself already succeeded).
    const notified = await createHandoffInboxItem({
      orgId: widget.org_id,
      widgetId: widget.id,
      conversationId,
      visitorId: conv.visitor_id,
      visitorName,
      visitorEmail,
      reason: trimmedReason,
      priority: resolvedPriority,
      lastMessage,
      summary: finalSummary,
    });

    if (!notified) {
      try { prepare('UPDATE widget_conversations SET notification_failed = 1 WHERE id = ?').run(conversationId); } catch (e) { console.error('[widget-connectors] failed to flag handoff notification_failed:', e?.message || e); }
    }
    res.json({ success: true, priority: resolvedPriority, notified, alerts_configured: alertsConfigured(widget.notification_settings_json) });
  } catch (err) {
    console.error('Error marking handoff:', err);
    res.status(500).json({ error: 'Failed to mark handoff' });
  }
});

/**
 * PRO-3: create_ticket builtin support. There is no dedicated ticket table
 * (and no 'ticket' value in inbox_items.kind's CHECK constraint), so a
 * ticket is an HITL inbox item — same canonical path as leads/handoff —
 * distinguished by title/payload and a human-readable reference number
 * (short enough to read back over chat) rather than a new schema.
 * Fail-soft is NOT appropriate here the way it is for lead/handoff
 * escalation: unlike those, a ticket IS the inbox item (there's no separate
 * durable row backing it), so a failed inbox create must be reported as a
 * failure to the caller rather than silently swallowed.
 */
function generateTicketReference() {
  return `TCK-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

widgetConnectorsInternalRouter.post('/widgets/:widgetId/tickets', async (req, res) => {
  try {
    const { widgetId } = req.params;
    const { visitor_id, conversation_id, subject, description, email, page_url } = req.body || {};
    // CW-SEC-1: accept either internal id or public_key.
    const widget = prepare('SELECT id, org_id FROM website_widgets WHERE id = ? OR public_key = ?').get(widgetId, widgetId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });
    if (!subject || typeof subject !== 'string') {
      return res.status(400).json({ error: 'subject required' });
    }
    if (!widget.org_id) {
      return res.status(422).json({ error: 'widget has no org_id, cannot create ticket' });
    }

    // QUOXCHAT-EMAIL D2 — same stamp as /leads, before the inbox call so a
    // failed inbox post never loses the captured email.
    stampChatContact(widget, visitor_id, { email });

    const reference = generateTicketReference();
    const lines = [
      `Widget: ${widget.id}`,
      `Reference: ${reference}`,
    ];
    if (email) lines.push(`Email: ${email}`);
    if (conversation_id) lines.push(`Conversation: ${conversation_id}`);
    if (page_url) lines.push(`Page: ${page_url}`);
    if (description) lines.push('', description);

    const resp = await fetch(`${AUTH_INTERNAL_URL}/api/internal/orgs/${encodeURIComponent(widget.org_id)}/inbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': process.env.INTERNAL_SERVICE_KEY || '' },
      body: JSON.stringify({
        kind: 'task',
        priority: 'normal',
        title: `Support ticket: ${String(subject).slice(0, 120)}`,
        body_md: lines.join('\n'),
        payload: {
          source: 'quoxchat_ticket',
          reference,
          widget_id: widget.id,
          conversation_id: conversation_id || null,
          visitor_id: visitor_id || null,
          subject: String(subject).slice(0, 200),
          description: description ? String(description).slice(0, 2000) : null,
          email: email || null,
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.error(`[widget-connectors] inbox create returned ${resp.status} for ticket: ${text.slice(0, 200)}`);
      return res.status(502).json({ error: 'Failed to create ticket' });
    }

    res.status(201).json({ success: true, reference });
  } catch (err) {
    console.error('Error creating ticket:', err);
    res.status(500).json({ error: 'Failed to create ticket' });
  }
});

/**
 * PRO-2: email_transcript builtin support.
 *
 * POST /internal/widgets/:widgetId/conversations/:conversationId/email-transcript
 * Body: {} (nothing from the caller is trusted for the recipient).
 *
 * SECURITY: the recipient is resolved SERVER-SIDE from the visitor's own
 * identified email (widget_visitors.identified_attrs_json.email keyed by the
 * conversation's own visitor_id), never from the request body. Captcha
 * verification already happened collector-side (email_transcript builtin in
 * quoxchatToolExecutors.js) before this endpoint is ever called; this
 * endpoint's job is: resolve the visitor's own email, assemble the
 * transcript from durably stored widget_messages, send it via the auth-side
 * emailService (SMTP config in instance_config), and witness the send with a
 * HASHED (never plaintext) recipient.
 *
 * One-per-conversation cap: enforced here by checking for a prior SUCCESSFUL
 * audit_events row for this conversation_id, durable (survives restarts,
 * correct across multiple auth/collector instances), unlike an in-process
 * counter. A failed attempt never counts against the cap so a transient SMTP
 * error can be retried.
 */
const TRANSCRIPT_EMAIL_ACTION = 'quoxchat.transcript.emailed';
const TRANSCRIPT_MAX_MESSAGES = 300;

function maskTranscriptEmail(email) {
  const at = email.indexOf('@');
  if (at <= 1) return email;
  return `${email[0]}***${email.slice(at - 1)}`;
}

function escapeTranscriptHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

widgetConnectorsInternalRouter.post('/widgets/:widgetId/conversations/:conversationId/email-transcript', async (req, res) => {
  try {
    const { widgetId, conversationId } = req.params;
    // CW-SEC-1: accept either internal id or public_key.
    const widget = prepare('SELECT id, org_id, name FROM website_widgets WHERE id = ? OR public_key = ?').get(widgetId, widgetId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });

    const conv = prepare('SELECT id, visitor_id FROM widget_conversations WHERE id = ? AND widget_id = ?').get(conversationId, widget.id);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    // Durable one-per-conversation cap. A prior SUCCESSFUL send blocks a repeat.
    const already = prepare(`
      SELECT id FROM audit_events
      WHERE action = ? AND target_type = 'widget_conversation' AND target_id = ? AND status = 'success'
      LIMIT 1
    `).get(TRANSCRIPT_EMAIL_ACTION, conversationId);
    if (already) {
      return res.json({ success: true, delivered: false, reason: 'already_sent' });
    }

    // Resolve the visitor's OWN identified email SERVER-SIDE. Nothing in the
    // request body is trusted for this: recipient_policy self_only is
    // enforced structurally, there is no recipient parameter anywhere on
    // this path.
    const visitorRow = prepare('SELECT identified_attrs_json FROM widget_visitors WHERE widget_id = ? AND visitor_id = ?').get(widget.id, conv.visitor_id);
    let email = null;
    if (visitorRow?.identified_attrs_json) {
      try {
        const attrs = JSON.parse(visitorRow.identified_attrs_json);
        if (typeof attrs?.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(attrs.email)) email = attrs.email;
      } catch { /* noop */ }
    }
    if (!email) {
      return res.json({ success: true, delivered: false, reason: 'visitor_email_unknown' });
    }

    const messages = prepare(`
      SELECT role, content, created_at FROM widget_messages
      WHERE conversation_id = ?
      ORDER BY created_at ASC
      LIMIT ?
    `).all(conversationId, TRANSCRIPT_MAX_MESSAGES);

    const widgetName = widget.name || 'our chat assistant';
    const lines = messages.map(m => `[${m.created_at}] ${m.role === 'user' ? 'You' : widgetName}: ${m.content}`);
    const text = [
      `Here is a copy of your conversation with ${widgetName}.`,
      '',
      ...lines,
      '',
      'This transcript was generated by an AI assistant. If anything above looks wrong, reply in the chat and a human can follow up.',
    ].join('\n');
    const html = `<p>Here is a copy of your conversation with ${escapeTranscriptHtml(widgetName)}.</p>`
      + `<pre style="white-space:pre-wrap;font-family:inherit;">${escapeTranscriptHtml(lines.join('\n'))}</pre>`
      + `<p><em>This transcript was generated by an AI assistant.</em></p>`;

    let sendResult;
    try {
      sendResult = await sendEmail({ to: email, subject: `Your conversation with ${widgetName}`, text, html });
    } catch (err) {
      sendResult = { delivered: false, reason: String(err?.message || err).slice(0, 200) };
    }

    // Witness. Fail-soft on the audit write itself (never turn a successful
    // send into an error response), but a FAILED send is always reported as
    // a failure to the caller (fail-closed, no silent success).
    try {
      logAudit({
        action: TRANSCRIPT_EMAIL_ACTION,
        actor: { type: 'system', id: 'quoxchat_widget' },
        orgId: widget.org_id,
        target: { type: 'widget_conversation', id: conversationId },
        status: sendResult.delivered === true ? 'success' : 'failure',
        metadata: {
          widget_id: widget.id,
          conversation_id: conversationId,
          recipient_hash: sha256(email).slice(0, 16),
          message_count: messages.length,
          message_id: sendResult.message_id || null,
          reason: sendResult.reason || null,
        },
      });
    } catch (err) {
      console.error('[widget-connectors] Failed to witness transcript email:', err?.message || err);
    }

    if (sendResult.delivered !== true) {
      return res.json({ success: true, delivered: false, reason: sendResult.reason || 'send_failed' });
    }

    res.json({ success: true, delivered: true, masked_email: maskTranscriptEmail(email), message_id: sendResult.message_id || null });
  } catch (err) {
    console.error('Error emailing transcript:', err);
    res.status(500).json({ error: 'Failed to email transcript' });
  }
});

// ─── Config validators ──────────────────────────────────────────────────────
const CONNECTOR_TYPES = ['database', 'rest_api', 'webhook', 'quoxflow'];
const BUILTIN_KINDS = ['lead_capture', 'human_handoff', 'redirect_url', 'email_transcript', 'book_demo', 'create_ticket', 'send_resource', 'book_appointment', 'schedule_demo', 'leave_message'];

function validateConnectorConfig(connector_type, config) {
  const c = config || {};
  // VAULT-P6.F (CONFIRMED cross-org credential exfiltration): secret_vault_id /
  // hmac_secret_vault_id link a connector to a decrypted vault credential —
  // that linkage must NEVER be settable as free-form client JSON. Without
  // this check, an org-A user could set config.secret_vault_id to an org-B
  // credential id on their OWN widget connector; at tool-execution time the
  // executor resolved that id with no org check and forwarded the decrypted
  // secret to a base_url the attacker controls. There is currently no
  // org-verified "attach a vault credential to this connector" flow, so we
  // reject outright rather than silently stripping (visible failure is
  // safer than silent data loss). `null` is allowed — it's the placeholder
  // value used by widgetConnectorGallery.js templates, never a real id.
  if (c.secret_vault_id !== undefined && c.secret_vault_id !== null) {
    return 'config.secret_vault_id cannot be set directly — vault credential linkage is not configurable via this endpoint';
  }
  if (c.hmac_secret_vault_id !== undefined && c.hmac_secret_vault_id !== null) {
    return 'config.hmac_secret_vault_id cannot be set directly — vault credential linkage is not configurable via this endpoint';
  }
  switch (connector_type) {
    case 'rest_api': {
      if (!c.base_url || typeof c.base_url !== 'string') return 'rest_api requires config.base_url (string)';
      let u;
      try { u = new URL(c.base_url); } catch { return 'rest_api config.base_url is not a valid URL'; }
      if (!['http:', 'https:'].includes(u.protocol)) return 'rest_api config.base_url must be http or https';
      const authType = c.auth_type || 'none';
      if (!['none', 'api_key', 'bearer', 'oauth'].includes(authType)) return 'rest_api config.auth_type must be none|api_key|bearer|oauth';
      if (authType === 'api_key') {
        if (!c.api_key_header && !c.api_key_query) return 'api_key auth requires api_key_header or api_key_query';
        if (c.api_key_header && c.api_key_query) return 'api_key auth cannot set both api_key_header and api_key_query';
        if (!c.secret_env_var || !/^[A-Z][A-Z0-9_]{0,63}$/.test(c.secret_env_var)) return 'api_key auth requires secret_env_var (uppercase env var name)';
      }
      if (authType === 'bearer') {
        if (!c.secret_env_var || !/^[A-Z][A-Z0-9_]{0,63}$/.test(c.secret_env_var)) return 'bearer auth requires secret_env_var (uppercase env var name)';
      }
      if (authType === 'oauth') return 'oauth auth not supported yet (coming post CW-9.8)';
      if (c.default_headers !== undefined) {
        if (!c.default_headers || typeof c.default_headers !== 'object' || Array.isArray(c.default_headers)) return 'default_headers must be an object';
        for (const [k, v] of Object.entries(c.default_headers)) {
          if (typeof v !== 'string') return `default_headers.${k} must be a string`;
          if (/^authorization$/i.test(k)) return 'default_headers must not include Authorization (use auth_type instead)';
        }
      }
      return null;
    }
    case 'database': {
      if (!c.driver || !['postgres', 'mysql', 'sqlite'].includes(c.driver)) return 'database config.driver must be postgres|mysql|sqlite';
      if (c.driver === 'sqlite') {
        if (!c.db_path || typeof c.db_path !== 'string') return 'sqlite driver requires db_path';
        if (c.db_path !== ':memory:') {
          if (c.db_path.includes('..')) return 'sqlite db_path cannot contain ..';
          if (!['/var/lib/quox/', '/tmp/'].some(p => c.db_path.startsWith(p))) return 'sqlite db_path must live under /var/lib/quox or /tmp';
        }
      } else {
        if (!c.host || typeof c.host !== 'string') return `${c.driver} driver requires config.host`;
        if (c.database !== undefined && typeof c.database !== 'string') return 'config.database must be a string';
        if (c.port !== undefined && (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535)) return 'config.port must be an integer 1-65535';
        if (c.secret_env_var !== undefined && !/^[A-Z][A-Z0-9_]{0,63}$/.test(c.secret_env_var)) return 'secret_env_var must be an uppercase env var name';
        // pg/mysql drivers land in CW-9.6b — allow config but warn via status.
      }
      return null;
    }
    case 'webhook': {
      if (!c.url || typeof c.url !== 'string') return 'webhook requires config.url (string)';
      let wu;
      try { wu = new URL(c.url); } catch { return 'webhook config.url is not a valid URL'; }
      if (!['http:', 'https:'].includes(wu.protocol)) return 'webhook config.url must be http or https';
      if (c.hmac_secret_env_var !== undefined) {
        if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(c.hmac_secret_env_var)) return 'hmac_secret_env_var must be an uppercase env var name';
      }
      if (c.hmac_header !== undefined) {
        if (typeof c.hmac_header !== 'string' || !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(c.hmac_header)) return 'hmac_header must be a valid HTTP header name';
      }
      if (c.default_headers !== undefined) {
        if (!c.default_headers || typeof c.default_headers !== 'object' || Array.isArray(c.default_headers)) return 'default_headers must be an object';
        for (const [k, v] of Object.entries(c.default_headers)) {
          if (typeof v !== 'string') return `default_headers.${k} must be a string`;
          if (/^authorization$/i.test(k)) return 'default_headers must not include Authorization';
        }
      }
      return null;
    }
    case 'quoxflow': {
      if (!c.workflow_id) return 'quoxflow requires config.workflow_id';
      return null;
    }
    default:
      return `unknown connector_type: ${connector_type}`;
  }
}

function validateToolConfig(tool_type, builtin_kind, parameters_json, config, connector_id) {
  if (!['connector', 'builtin'].includes(tool_type)) return 'tool_type must be connector|builtin';
  if (tool_type === 'builtin') {
    if (!builtin_kind || !BUILTIN_KINDS.includes(builtin_kind)) return `builtin tool requires builtin_kind in ${BUILTIN_KINDS.join('|')}`;
    if (connector_id) return 'builtin tools must not have connector_id';
  } else {
    if (!connector_id) return 'connector tools require connector_id';
    if (builtin_kind) return 'connector tools must not have builtin_kind';
  }
  if (parameters_json) {
    try {
      const p = typeof parameters_json === 'string' ? JSON.parse(parameters_json) : parameters_json;
      if (!p || typeof p !== 'object' || p.type !== 'object') return 'parameters_json must be a JSONSchema object with type=object';
    } catch { return 'parameters_json must be valid JSON'; }
  }
  return null;
}

/**
 * Connector-type-specific validation for tool config_json.
 * Called at tool create/update time once we know which connector the tool is bound to.
 */
function validateToolConfigForConnectorType(connectorType, config) {
  const c = config || {};
  switch (connectorType) {
    case 'rest_api': {
      const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
      if (!c.method || !ALLOWED_METHODS.includes(String(c.method).toUpperCase())) {
        return `rest_api tool requires config.method in ${ALLOWED_METHODS.join('|')}`;
      }
      if (!c.path || typeof c.path !== 'string' || !c.path.startsWith('/')) {
        return 'rest_api tool requires config.path starting with /';
      }
      if (/[\r\n]/.test(c.path)) return 'rest_api tool config.path must not contain CR/LF';
      if (c.timeout_ms !== undefined && (!Number.isFinite(c.timeout_ms) || c.timeout_ms < 500 || c.timeout_ms > 15000)) {
        return 'rest_api tool config.timeout_ms must be between 500 and 15000';
      }
      if (c.query_params !== undefined) {
        if (!Array.isArray(c.query_params)) return 'rest_api tool config.query_params must be an array';
        for (const q of c.query_params) {
          if (!q || typeof q.name !== 'string') return 'each query_params entry needs a string name';
          if (q.from !== undefined && typeof q.from !== 'string') return 'query_params.from must be a string';
        }
      }
      if (c.response_extract !== undefined && typeof c.response_extract !== 'string') {
        return 'rest_api tool config.response_extract must be a string dotted path';
      }
      // QCX-ACTIONS P1 — identity_param: the request acts on the signed-in
      // visitor; the collector injects the HMAC-verified external_user_id
      // into this param/header and refuses unverified visitors. Mirrors
      // normalizeIdentityParam() in collector quoxchatToolExecutors.js.
      if (c.identity_param !== undefined && c.identity_param !== null) {
        const ip = c.identity_param;
        const validString = typeof ip === 'string' && ip.trim();
        const validObj = ip && typeof ip === 'object' && !Array.isArray(ip)
          && typeof ip.name === 'string' && ip.name.trim()
          && (ip.in === undefined || ['query', 'body', 'header'].includes(ip.in))
          && (ip.in !== 'header' || /^[A-Za-z0-9-]+$/.test(ip.name.trim()));
        if (!validString && !validObj) {
          return 'rest_api tool config.identity_param must be a param name or {name, in: query|body|header}';
        }
        if ((validObj && ip.in === 'body') && ['GET', 'DELETE'].includes(String(c.method).toUpperCase())) {
          return 'rest_api tool config.identity_param in:body requires a method with a request body';
        }
      }
      return null;
    }
    case 'database': {
      if (!c.query_template || typeof c.query_template !== 'string') return 'database tool requires config.query_template';
      // Run the same validator the collector uses, so admins see inline errors
      // instead of the tool failing on every LLM call.
      try {
        // Lazy require so auth service does not depend on collector code layout
        // beyond the validator module (which is a tiny, self-contained file
        // with no network / DB deps).
        const { validateReadOnlySqlTemplate } = require('../../collector/lib/quoxchatSqlValidator');
        const r = validateReadOnlySqlTemplate(c.query_template, { allowedTables: Array.isArray(c.allowed_tables) ? c.allowed_tables : [] });
        if (!r.ok) return `database tool query_template invalid: ${r.error}`;
      } catch (err) {
        // If we can't load the validator, don't let it block — collector will
        // catch the problem at execute time. Log and move on.
        console.warn('[widget-connectors] SQL validator unavailable — deferring to runtime:', err?.message);
      }
      if (c.allowed_tables !== undefined && !Array.isArray(c.allowed_tables)) return 'database tool config.allowed_tables must be an array of strings';
      if (c.row_limit !== undefined && (!Number.isFinite(c.row_limit) || c.row_limit < 1 || c.row_limit > 1000)) {
        return 'database tool config.row_limit must be between 1 and 1000';
      }
      if (c.timeout_ms !== undefined && (!Number.isFinite(c.timeout_ms) || c.timeout_ms < 500 || c.timeout_ms > 30000)) {
        return 'database tool config.timeout_ms must be between 500 and 30000';
      }
      return null;
    }
    case 'webhook': {
      if (c.timeout_ms !== undefined && (!Number.isFinite(c.timeout_ms) || c.timeout_ms < 500 || c.timeout_ms > 10000)) {
        return 'webhook tool config.timeout_ms must be between 500 and 10000';
      }
      if (c.include_metadata !== undefined && typeof c.include_metadata !== 'boolean') {
        return 'webhook tool config.include_metadata must be boolean';
      }
      if (c.body_template !== undefined && (typeof c.body_template !== 'object' || c.body_template === null || Array.isArray(c.body_template))) {
        return 'webhook tool config.body_template must be a JSON object';
      }
      return null;
    }
    default:
      return null; // other connector types validated in their own slices
  }
}

function rowToConnector(r) {
  if (!r) return null;
  let config = {};
  try { config = r.config_json ? JSON.parse(r.config_json) : {}; } catch { /* noop */ }
  return {
    id: r.id,
    widget_id: r.widget_id,
    org_id: r.org_id,
    connector_type: r.connector_type,
    name: r.name,
    config,
    has_vault_ref: !!r.vault_ref,
    status: r.status,
    last_used_at: r.last_used_at,
    use_count: r.use_count || 0,
    error_count: r.error_count || 0,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function rowToTool(r) {
  if (!r) return null;
  let parameters = { type: 'object', properties: {} };
  let config = {};
  try { parameters = r.parameters_json ? JSON.parse(r.parameters_json) : parameters; } catch { /* noop */ }
  try { config = r.config_json ? JSON.parse(r.config_json) : {}; } catch { /* noop */ }
  return {
    id: r.id,
    widget_id: r.widget_id,
    connector_id: r.connector_id,
    org_id: r.org_id,
    name: r.name,
    description: r.description,
    tool_type: r.tool_type,
    builtin_kind: r.builtin_kind,
    parameters,
    config,
    status: r.status,
    last_used_at: r.last_used_at,
    use_count: r.use_count || 0,
    error_count: r.error_count || 0,
    rate_limit_per_session: r.rate_limit_per_session,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function loadWidget(orgId, widgetId) {
  return prepare('SELECT id, org_id FROM website_widgets WHERE id = ? AND org_id = ?').get(widgetId, orgId);
}

// ─── Connector CRUD ─────────────────────────────────────────────────────────

router.get('/orgs/:orgId/widgets/:widgetId/connectors', requireOrgMembership, (req, res) => {
  try {
    const { orgId, widgetId } = req.params;
    if (!loadWidget(orgId, widgetId)) return res.status(404).json({ error: 'Widget not found' });
    const pagination = getPagination(req.query, 50, 100);
    const total = prepare('SELECT COUNT(*) AS n FROM widget_connectors WHERE widget_id = ?').get(widgetId).n;
    const rows = prepare(`
      SELECT * FROM widget_connectors
      WHERE widget_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(widgetId, pagination.limit, pagination.offset);
    res.json(formatPaginatedResponse(rows.map(rowToConnector), total, pagination));
  } catch (err) {
    console.error('list connectors', err);
    res.status(500).json({ error: 'Failed to list connectors' });
  }
});

router.get('/orgs/:orgId/widgets/:widgetId/connectors/:connectorId', requireOrgMembership, (req, res) => {
  try {
    const { orgId, widgetId, connectorId } = req.params;
    if (!loadWidget(orgId, widgetId)) return res.status(404).json({ error: 'Widget not found' });
    const row = prepare('SELECT * FROM widget_connectors WHERE id = ? AND widget_id = ?').get(connectorId, widgetId);
    if (!row) return res.status(404).json({ error: 'Connector not found' });
    res.json(rowToConnector(row));
  } catch (err) {
    console.error('get connector', err);
    res.status(500).json({ error: 'Failed to load connector' });
  }
});

// QCX-1.5 — public (auth-required) listing of pre-built connector templates.
// Gallery is org-agnostic: everyone sees the same 15 integrations.
router.get('/widget-connector-templates', (req, res) => {
  try {
    const templates = listTemplates().map(t => ({
      slug: t.slug,
      name: t.name,
      vendor: t.vendor,
      category: t.category,
      description: t.description,
      docs_url: t.docs_url,
      connector_type: t.connector.connector_type,
    }));
    res.json({ templates });
  } catch (err) {
    console.error('list connector templates', err);
    res.status(500).json({ error: 'Failed to list templates' });
  }
});

router.get('/widget-connector-templates/:slug', (req, res) => {
  const t = getTemplate(req.params.slug);
  if (!t) return res.status(404).json({ error: 'Template not found' });
  res.json(t);
});

// QCX-1.5 — one-click "add from template". Creates both the connector row
// and a starter tool bound to it. `overrides.connector` merges into the
// template's connector.config (for base_url placeholders like {shop}),
// `overrides.tool` merges into tool.config.
router.post('/orgs/:orgId/widgets/:widgetId/connectors/from-template', requireOrgMembership, (req, res) => {
  try {
    if (denyIfNotPro(req, res, 'connector_framework_enabled')) return;
    const { orgId, widgetId } = req.params;
    const widget = loadWidget(orgId, widgetId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });

    const { slug, overrides } = req.body || {};
    if (!slug || typeof slug !== 'string') return res.status(400).json({ error: 'slug is required' });
    const template = getTemplate(slug);
    if (!template) return res.status(404).json({ error: `Unknown template: ${slug}` });

    // Merge overrides (shallow) into the connector + tool configs.
    const connectorConfig = { ...template.connector.config, ...((overrides?.connector) || {}) };
    const toolConfig = { ...template.tool.config, ...((overrides?.tool) || {}) };

    // Reject unresolved placeholders in the connector's primary URL so the
    // admin sees a clear error rather than a live 400 later.
    const primaryUrl = connectorConfig.base_url || connectorConfig.url || '';
    const placeholders = [...primaryUrl.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
    if (placeholders.length > 0) {
      return res.status(400).json({
        error: 'unresolved_placeholders',
        message: `Template ${slug} needs overrides for: ${placeholders.join(', ')}`,
        placeholders,
      });
    }

    // Validate the final config before writing any row.
    const cfgErr = validateConnectorConfig(template.connector.connector_type, connectorConfig);
    if (cfgErr) return res.status(400).json({ error: `connector config invalid: ${cfgErr}` });

    // Insert connector, then tool, in a transaction-like pair.
    const connectorId = ulid();
    prepare(`
      INSERT INTO widget_connectors (id, widget_id, org_id, connector_type, name, config_json, vault_ref, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      connectorId, widgetId, orgId,
      template.connector.connector_type,
      template.connector.name,
      JSON.stringify(connectorConfig),
      connectorConfig.secret_vault_id || null,
      'active',
    );

    const toolConfigErr = validateToolConfigForConnectorType(template.connector.connector_type, toolConfig);
    if (toolConfigErr) {
      // Roll back the connector — orphan connectors are ugly.
      prepare('DELETE FROM widget_connectors WHERE id = ?').run(connectorId);
      return res.status(400).json({ error: `tool config invalid: ${toolConfigErr}` });
    }

    const toolId = ulid();
    prepare(`
      INSERT INTO widget_tools
        (id, widget_id, connector_id, org_id, name, description, tool_type, builtin_kind,
         parameters_json, config_json, status, rate_limit_per_session)
      VALUES (?, ?, ?, ?, ?, ?, 'connector', NULL, ?, ?, 'active', ?)
    `).run(
      toolId, widgetId, connectorId, orgId,
      template.tool.name, template.tool.description,
      JSON.stringify(template.tool.parameters),
      JSON.stringify(toolConfig),
      Number.isFinite(template.tool.rate_limit_per_session) ? template.tool.rate_limit_per_session : null,
    );

    const connectorRow = prepare('SELECT * FROM widget_connectors WHERE id = ?').get(connectorId);
    const toolRow = prepare('SELECT * FROM widget_tools WHERE id = ?').get(toolId);
    res.status(201).json({
      template: { slug: template.slug, vendor: template.vendor, name: template.name },
      connector: rowToConnector(connectorRow),
      tool: rowToTool(toolRow),
    });
  } catch (err) {
    console.error('add connector from template', err);
    if (String(err.message || '').includes('UNIQUE')) {
      return res.status(409).json({ error: 'A connector or tool with that name already exists for this widget' });
    }
    res.status(500).json({ error: 'Failed to add from template' });
  }
});

router.post('/orgs/:orgId/widgets/:widgetId/connectors', requireOrgMembership, (req, res) => {
  try {
    if (denyIfNotPro(req, res, 'connector_framework_enabled')) return;
    const { orgId, widgetId } = req.params;
    const widget = loadWidget(orgId, widgetId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });

    const { connector_type, name, config, vault_ref, status } = req.body || {};
    if (!connector_type || !CONNECTOR_TYPES.includes(connector_type)) return res.status(400).json({ error: `connector_type must be one of ${CONNECTOR_TYPES.join('|')}` });
    if (!name || typeof name !== 'string' || name.length > 80) return res.status(400).json({ error: 'name required (<=80 chars)' });
    // VAULT-P6.F: same class of injection as config.secret_vault_id — this
    // column has no org-verified attach flow either, and no legitimate
    // caller sets it today (grep across src/ confirms). Reject rather than
    // silently persist an unverified vault id.
    if (vault_ref) return res.status(400).json({ error: 'vault_ref cannot be set directly — vault credential linkage is not configurable via this endpoint' });
    const cfgErr = validateConnectorConfig(connector_type, config);
    if (cfgErr) return res.status(400).json({ error: cfgErr });

    const id = ulid();
    prepare(`
      INSERT INTO widget_connectors (id, widget_id, org_id, connector_type, name, config_json, vault_ref, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, widgetId, orgId, connector_type, name, JSON.stringify(config || {}), vault_ref || null, status || 'active');
    const row = prepare('SELECT * FROM widget_connectors WHERE id = ?').get(id);
    res.status(201).json(rowToConnector(row));
  } catch (err) {
    console.error('create connector', err);
    if (String(err.message || '').includes('UNIQUE')) return res.status(409).json({ error: 'Connector name already in use for this widget' });
    res.status(500).json({ error: 'Failed to create connector' });
  }
});

router.patch('/orgs/:orgId/widgets/:widgetId/connectors/:connectorId', requireOrgMembership, (req, res) => {
  try {
    if (denyIfNotPro(req, res, 'connector_framework_enabled')) return;
    const { orgId, widgetId, connectorId } = req.params;
    if (!loadWidget(orgId, widgetId)) return res.status(404).json({ error: 'Widget not found' });
    const existing = prepare('SELECT * FROM widget_connectors WHERE id = ? AND widget_id = ?').get(connectorId, widgetId);
    if (!existing) return res.status(404).json({ error: 'Connector not found' });

    const { name, config, vault_ref, status } = req.body || {};
    const updates = [];
    const params = [];

    if (name !== undefined) {
      if (typeof name !== 'string' || name.length === 0 || name.length > 80) return res.status(400).json({ error: 'name must be 1-80 chars' });
      updates.push('name = ?'); params.push(name);
    }
    if (config !== undefined) {
      const cfgErr = validateConnectorConfig(existing.connector_type, config);
      if (cfgErr) return res.status(400).json({ error: cfgErr });
      updates.push('config_json = ?'); params.push(JSON.stringify(config || {}));
    }
    if (vault_ref) {
      // VAULT-P6.F: same class of injection as config.secret_vault_id.
      return res.status(400).json({ error: 'vault_ref cannot be set directly — vault credential linkage is not configurable via this endpoint' });
    }
    if (status !== undefined) {
      if (!['active', 'disabled'].includes(status)) return res.status(400).json({ error: 'status must be active|disabled' });
      updates.push('status = ?'); params.push(status);
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No updatable fields' });
    updates.push("updated_at = datetime('now')");
    params.push(connectorId);

    prepare(`UPDATE widget_connectors SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    const row = prepare('SELECT * FROM widget_connectors WHERE id = ?').get(connectorId);
    res.json(rowToConnector(row));
  } catch (err) {
    console.error('update connector', err);
    if (String(err.message || '').includes('UNIQUE')) return res.status(409).json({ error: 'Connector name already in use for this widget' });
    res.status(500).json({ error: 'Failed to update connector' });
  }
});

router.delete('/orgs/:orgId/widgets/:widgetId/connectors/:connectorId', requireOrgMembership, (req, res) => {
  try {
    const { orgId, widgetId, connectorId } = req.params;
    if (!loadWidget(orgId, widgetId)) return res.status(404).json({ error: 'Widget not found' });
    const info = prepare('DELETE FROM widget_connectors WHERE id = ? AND widget_id = ?').run(connectorId, widgetId);
    if (info.changes === 0) return res.status(404).json({ error: 'Connector not found' });
    res.status(204).end();
  } catch (err) {
    console.error('delete connector', err);
    res.status(500).json({ error: 'Failed to delete connector' });
  }
});

// ─── Tool CRUD ──────────────────────────────────────────────────────────────

router.get('/orgs/:orgId/widgets/:widgetId/tools', requireOrgMembership, (req, res) => {
  try {
    const { orgId, widgetId } = req.params;
    if (!loadWidget(orgId, widgetId)) return res.status(404).json({ error: 'Widget not found' });
    const pagination = getPagination(req.query, 50, 100);
    const total = prepare('SELECT COUNT(*) AS n FROM widget_tools WHERE widget_id = ?').get(widgetId).n;
    const rows = prepare(`
      SELECT * FROM widget_tools
      WHERE widget_id = ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(widgetId, pagination.limit, pagination.offset);
    res.json(formatPaginatedResponse(rows.map(rowToTool), total, pagination));
  } catch (err) {
    console.error('list tools', err);
    res.status(500).json({ error: 'Failed to list tools' });
  }
});

router.get('/orgs/:orgId/widgets/:widgetId/tools/:toolId', requireOrgMembership, (req, res) => {
  try {
    const { orgId, widgetId, toolId } = req.params;
    if (!loadWidget(orgId, widgetId)) return res.status(404).json({ error: 'Widget not found' });
    const row = prepare('SELECT * FROM widget_tools WHERE id = ? AND widget_id = ?').get(toolId, widgetId);
    if (!row) return res.status(404).json({ error: 'Tool not found' });
    res.json(rowToTool(row));
  } catch (err) {
    console.error('get tool', err);
    res.status(500).json({ error: 'Failed to load tool' });
  }
});

router.post('/orgs/:orgId/widgets/:widgetId/tools', requireOrgMembership, (req, res) => {
  try {
    const { orgId, widgetId } = req.params;
    if (!loadWidget(orgId, widgetId)) return res.status(404).json({ error: 'Widget not found' });

    const { name, description, tool_type, builtin_kind, connector_id, parameters, config, status, rate_limit_per_session } = req.body || {};
    if (!name || typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,48}$/.test(name)) {
      return res.status(400).json({ error: 'name must start with a letter, <=49 chars, [a-zA-Z0-9_] only (LLM function name rules)' });
    }
    const ttype = tool_type || 'connector';
    // Builtin tools (lead capture, redirect, ...) ship on every plan; only the
    // connector-backed tools are the Professional "tool and connector framework".
    if (ttype !== 'builtin' && denyIfNotPro(req, res, 'connector_framework_enabled')) return;
    const err = validateToolConfig(ttype, builtin_kind, parameters, config, connector_id);
    if (err) return res.status(400).json({ error: err });

    if (ttype === 'connector') {
      const conn = prepare('SELECT id, connector_type FROM widget_connectors WHERE id = ? AND widget_id = ?').get(connector_id, widgetId);
      if (!conn) return res.status(400).json({ error: 'connector_id does not belong to this widget' });
      const toolCfgErr = validateToolConfigForConnectorType(conn.connector_type, config);
      if (toolCfgErr) return res.status(400).json({ error: toolCfgErr });
    }

    const id = ulid();
    prepare(`
      INSERT INTO widget_tools
        (id, widget_id, connector_id, org_id, name, description, tool_type, builtin_kind,
         parameters_json, config_json, status, rate_limit_per_session)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, widgetId,
      ttype === 'connector' ? connector_id : null,
      orgId, name, description || null, ttype,
      ttype === 'builtin' ? builtin_kind : null,
      JSON.stringify(parameters || { type: 'object', properties: {} }),
      JSON.stringify(config || {}),
      status || 'active',
      Number.isFinite(rate_limit_per_session) ? rate_limit_per_session : null,
    );
    const row = prepare('SELECT * FROM widget_tools WHERE id = ?').get(id);
    res.status(201).json(rowToTool(row));
  } catch (err) {
    console.error('create tool', err);
    if (String(err.message || '').includes('UNIQUE')) return res.status(409).json({ error: 'Tool name already in use for this widget' });
    res.status(500).json({ error: 'Failed to create tool' });
  }
});

router.patch('/orgs/:orgId/widgets/:widgetId/tools/:toolId', requireOrgMembership, (req, res) => {
  try {
    const { orgId, widgetId, toolId } = req.params;
    if (!loadWidget(orgId, widgetId)) return res.status(404).json({ error: 'Widget not found' });
    const existing = prepare('SELECT * FROM widget_tools WHERE id = ? AND widget_id = ?').get(toolId, widgetId);
    if (!existing) return res.status(404).json({ error: 'Tool not found' });
    if (existing.tool_type !== 'builtin' && denyIfNotPro(req, res, 'connector_framework_enabled')) return;

    const { description, parameters, config, status, rate_limit_per_session } = req.body || {};
    const updates = [];
    const params = [];

    if (description !== undefined) { updates.push('description = ?'); params.push(description || null); }
    if (parameters !== undefined) {
      const err = validateToolConfig(existing.tool_type, existing.builtin_kind, parameters, existing.config_json, existing.connector_id);
      if (err) return res.status(400).json({ error: err });
      updates.push('parameters_json = ?'); params.push(JSON.stringify(parameters));
    }
    if (config !== undefined) {
      if (existing.connector_id) {
        const conn = prepare('SELECT connector_type FROM widget_connectors WHERE id = ?').get(existing.connector_id);
        if (conn) {
          const toolCfgErr = validateToolConfigForConnectorType(conn.connector_type, config);
          if (toolCfgErr) return res.status(400).json({ error: toolCfgErr });
        }
      }
      updates.push('config_json = ?'); params.push(JSON.stringify(config || {}));
    }
    if (status !== undefined) {
      if (!['active', 'disabled'].includes(status)) return res.status(400).json({ error: 'status must be active|disabled' });
      updates.push('status = ?'); params.push(status);
    }
    if (rate_limit_per_session !== undefined) {
      if (rate_limit_per_session !== null && !Number.isFinite(rate_limit_per_session)) return res.status(400).json({ error: 'rate_limit_per_session must be a number or null' });
      updates.push('rate_limit_per_session = ?'); params.push(rate_limit_per_session);
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No updatable fields' });
    updates.push("updated_at = datetime('now')");
    params.push(toolId);

    prepare(`UPDATE widget_tools SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    const row = prepare('SELECT * FROM widget_tools WHERE id = ?').get(toolId);
    res.json(rowToTool(row));
  } catch (err) {
    console.error('update tool', err);
    res.status(500).json({ error: 'Failed to update tool' });
  }
});

router.delete('/orgs/:orgId/widgets/:widgetId/tools/:toolId', requireOrgMembership, (req, res) => {
  try {
    const { orgId, widgetId, toolId } = req.params;
    if (!loadWidget(orgId, widgetId)) return res.status(404).json({ error: 'Widget not found' });
    const info = prepare('DELETE FROM widget_tools WHERE id = ? AND widget_id = ?').run(toolId, widgetId);
    if (info.changes === 0) return res.status(404).json({ error: 'Tool not found' });
    res.status(204).end();
  } catch (err) {
    console.error('delete tool', err);
    res.status(500).json({ error: 'Failed to delete tool' });
  }
});

// QCX-1.4 — Per-tool Test Run. Admin-only: loads tool + connector rows,
// forwards to the collector's internal test-run endpoint (service-key
// guarded), returns the raw executor result + duration. The collector
// holds executeTool; auth just proxies + enforces org membership.
router.post('/orgs/:orgId/widgets/:widgetId/tools/:toolId/test-run', requireOrgMembership, async (req, res) => {
  try {
    const { orgId, widgetId, toolId } = req.params;
    const widget = loadWidget(orgId, widgetId);
    if (!widget) return res.status(404).json({ error: 'Widget not found' });

    const toolRow = prepare('SELECT * FROM widget_tools WHERE id = ? AND widget_id = ?').get(toolId, widgetId);
    if (!toolRow) return res.status(404).json({ error: 'Tool not found' });
    if (toolRow.tool_type !== 'builtin' && denyIfNotPro(req, res, 'connector_framework_enabled')) return;
    const tool = rowToTool(toolRow);

    // Hydrate connector row so the executor has the same shape it gets
    // during /message — base_url, auth_type, vault refs, etc.
    let connector = null;
    if (tool.tool_type === 'connector' && tool.connector_id) {
      const connRow = prepare('SELECT * FROM widget_connectors WHERE id = ? AND widget_id = ?').get(tool.connector_id, widgetId);
      if (!connRow) return res.status(400).json({ error: 'Connector not found for this tool' });
      connector = rowToConnector(connRow);
    }

    // Flatten to the shape executeTool expects. Mirrors the internal
    // /widgets/:id/tools response structure.
    const execTool = {
      id: tool.id,
      name: tool.name,
      description: tool.description || '',
      input_schema: tool.parameters,
      tool_type: tool.tool_type,
      builtin_kind: tool.builtin_kind,
      connector_id: tool.connector_id,
      connector_type: connector?.connector_type || null,
      connector_config: connector?.config || null,
      tool_config: tool.config || {},
      rate_limit_per_session: tool.rate_limit_per_session,
    };

    const collectorUrl = process.env.COLLECTOR_URL
      || process.env.QUOX_COLLECTOR_URL
      || 'http://collector:9848';
    const serviceKey = process.env.INTERNAL_SERVICE_KEY;
    if (!serviceKey) return res.status(503).json({ error: 'Service key not configured' });

    const userInput = (req.body && typeof req.body.input === 'object') ? req.body.input : {};

    let upstream;
    try {
      upstream = await fetch(`${collectorUrl}/quoxchat/internal/tools/test-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-service-key': serviceKey },
        body: JSON.stringify({ tool: execTool, widget: { id: widget.id, org_id: widget.org_id }, input: userInput }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      return res.status(502).json({ error: 'collector_unreachable', message: String(err?.message || err).slice(0, 200) });
    }
    const data = await upstream.json().catch(() => ({}));
    return res.status(upstream.status).json(data);
  } catch (err) {
    console.error('tool test-run', err);
    res.status(500).json({ error: 'Failed to test tool' });
  }
});

// ─── Leads (CW-9.3) ─────────────────────────────────────────────────────────
// Captured by the lead_capture builtin. Read-only from the dashboard;
// creation is restricted to the internal router (service-key auth).

function rowToLead(r) {
  if (!r) return null;
  let metadata = {};
  try { metadata = r.metadata_json ? JSON.parse(r.metadata_json) : {}; } catch { /* noop */ }
  return {
    id: r.id,
    widget_id: r.widget_id,
    org_id: r.org_id,
    conversation_id: r.conversation_id,
    visitor_id: r.visitor_id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    company: r.company,
    notes: r.notes,
    metadata,
    status: r.status,
    captured_at: r.captured_at,
    updated_at: r.updated_at,
  };
}

router.get('/orgs/:orgId/widgets/:widgetId/leads', requireOrgMembership, (req, res) => {
  try {
    const { orgId, widgetId } = req.params;
    if (!loadWidget(orgId, widgetId)) return res.status(404).json({ error: 'Widget not found' });
    const pagination = getPagination(req.query, 50, 200);
    const total = prepare('SELECT COUNT(*) AS n FROM widget_leads WHERE widget_id = ?').get(widgetId).n;
    const rows = prepare(`
      SELECT * FROM widget_leads
      WHERE widget_id = ?
      ORDER BY captured_at DESC
      LIMIT ? OFFSET ?
    `).all(widgetId, pagination.limit, pagination.offset);
    res.json(formatPaginatedResponse(rows.map(rowToLead), total, pagination));
  } catch (err) {
    console.error('list leads', err);
    res.status(500).json({ error: 'Failed to list leads' });
  }
});

router.patch('/orgs/:orgId/widgets/:widgetId/leads/:leadId', requireOrgMembership, (req, res) => {
  try {
    const { orgId, widgetId, leadId } = req.params;
    if (!loadWidget(orgId, widgetId)) return res.status(404).json({ error: 'Widget not found' });
    const existing = prepare('SELECT id FROM widget_leads WHERE id = ? AND widget_id = ?').get(leadId, widgetId);
    if (!existing) return res.status(404).json({ error: 'Lead not found' });

    const { status, notes } = req.body || {};
    const updates = [];
    const params = [];
    if (status !== undefined) {
      if (!['new', 'contacted', 'qualified', 'closed'].includes(status)) return res.status(400).json({ error: 'status must be new|contacted|qualified|closed' });
      updates.push('status = ?'); params.push(status);
    }
    if (notes !== undefined) { updates.push('notes = ?'); params.push(notes || null); }
    if (updates.length === 0) return res.status(400).json({ error: 'No updatable fields' });
    updates.push("updated_at = datetime('now')");
    params.push(leadId);

    prepare(`UPDATE widget_leads SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    const row = prepare('SELECT * FROM widget_leads WHERE id = ?').get(leadId);
    res.json(rowToLead(row));
  } catch (err) {
    console.error('update lead', err);
    res.status(500).json({ error: 'Failed to update lead' });
  }
});

export default router;
