/**
 * QuoxChat commands: website-widget list + operator availability + live-support
 * desk parity (QuoxChat Pro).
 *
 * quox quoxchat widgets
 * quox quoxchat availability <widgetId> [--online|--offline]
 * quox quoxchat conversations <widgetId> [--status <status>] [--waiting]
 * quox quoxchat transcript <widgetId> <conversationId>
 * quox quoxchat reply <widgetId> <conversationId> <message...>
 *
 * Backend: services/auth/routes/widgets.js (mounted at plain `/api`,
 * requireOrgMembership): GET/PATCH `/api/orgs/:orgId/widgets[/:widgetId]`,
 * GET `/api/orgs/:orgId/widgets/:widgetId/conversations[/:conversationId/messages]`.
 * `operator_online` and `office_hours_json` are the QuoxChat Pro availability
 * fields; plan-gated PATCH fields return 402 `plan_upgrade_required`.
 *
 * Operator reply is a separate org-authed router: POST
 * `/api/orgs/:orgId/widgets/:widgetId/conversations/:conversationId/operator-reply`
 * in services/auth/routes/internal-widget-matrix.js (widgetConversationOrgRouter).
 * It derives the sender name server-side and returns 409 when the
 * conversation is not `handed_off`.
 *
 * Desk status label + visitor display precedence mirror
 * src/pages/views/LiveSupportView.jsx (convDeskStatus / visitorDisplay) so the
 * CLI shows the same picture as the dashboard live-support desk.
 */

import { formatOutput, formatDetail, printSuccess } from '../core/output.js';
import { resolveOrgId } from './helpers.js';
import { resolveEndpoint } from '../api/endpoints.js';

/** Reduce a full widget row to the availability-relevant fields. */
function availabilityView(widget) {
  return {
    id: widget.id,
    name: widget.name,
    status: widget.status,
    operator_online: Boolean(widget.operator_online),
    office_hours: widget.office_hours_json ?? null,
  };
}

// Desk status, mirrors convDeskStatus() in LiveSupportView.jsx. A handed-off
// conversation that no operator has joined yet is WAITING whoever spoke last
// (the AI's handoff ack is the last turn right after a handoff, so keying off
// the last turn alone showed every fresh handoff as "AI active"). Otherwise
// the last turn decides: the visitor spoke last means waiting on a human, an
// operator spoke last means answered, anything else means the AI holds it.
function deskStatus(row) {
  if (row?.status === 'handed_off') {
    if (!row?.operator_joined_at && row?.last_message_role !== 'operator') return 'waiting';
    return row?.last_message_role === 'user' ? 'waiting' : 'answered';
  }
  if (row?.last_message_role === 'user') return 'waiting';
  if (row?.last_message_role === 'operator') return 'answered';
  return 'ai';
}

const DESK_STATUS_LABEL = { waiting: 'Waiting', answered: 'Answered', ai: 'AI active' };

// Handed-off rows say so, so the desk never reads a human-owned chat as AI.
function deskStatusLabel(row) {
  const base = DESK_STATUS_LABEL[deskStatus(row)];
  return row?.status === 'handed_off' ? `${base} (handed off)` : base;
}

// Visitor display precedence mirrors visitorDisplay() in LiveSupportView.jsx:
// pre-handoff form name, then identify() attrs, then email, then a short
// readable visitor id. Never crops a name mid-word.
function visitorLabel(row) {
  if (!row || typeof row !== 'object') return 'Visitor';
  if (row.visitor_name && String(row.visitor_name).trim()) return String(row.visitor_name).trim();
  let attrs = {};
  if (row.visitor_identified_attrs_json) {
    try {
      const parsed = JSON.parse(row.visitor_identified_attrs_json);
      if (parsed && typeof parsed === 'object') attrs = parsed;
    } catch {
      // malformed attrs, fall through to the other precedence levels
    }
  }
  const name = attrs.name || [attrs.first_name, attrs.last_name].filter(Boolean).join(' ');
  if (name) return name;
  if (row.visitor_email) return String(row.visitor_email);
  if (attrs.email) return String(attrs.email);
  const raw = String(row.visitor_id || '').replace(/^(visitor[-_]?|qc[-_]?)/i, '');
  return raw ? `Visitor ${raw.slice(0, 8)}` : 'Visitor';
}

// Transcript rows mix SQLite "YYYY-MM-DD HH:MM:SS" (UTC, no marker) and ISO
// strings depending on which service wrote them; render both as one local
// "YYYY-MM-DD HH:MM" format.
function formatMessageTime(value) {
  if (!value) return '-';
  const raw = String(value);
  const normalised = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const d = new Date(normalised);
  if (Number.isNaN(d.getTime())) return raw;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function registerQuoxchatCommands(program, ctx) {
  const { client, auth } = ctx;

  const quoxchat = program
    .command('quoxchat')
    .description('Manage QuoxChat website widgets');

  quoxchat
    .command('widgets')
    .description('List QuoxChat widgets for the active org')
    .action(async () => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const data = await client.get(resolveEndpoint('quoxchat.widgets.list', { orgId }).path, { service: resolveEndpoint('quoxchat.widgets.list', { orgId }).service });
      formatOutput({
        columns: ['id', 'name', 'assistant_name', 'status', 'operator_online', 'created_at'],
        headers: ['ID', 'Name', 'Assistant', 'Status', 'Operator online', 'Created'],
        rows: data.items || data,
      }, { format: program.opts().output, emptyMessage: 'No widgets found.' });
    });

  quoxchat
    .command('availability')
    .description('Show or set operator availability for a widget (QuoxChat Pro)')
    .argument('<widgetId>', 'widget ID')
    .option('--online', 'mark the human operator online')
    .option('--offline', 'mark the human operator offline')
    .action(async (widgetId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      if (options.online && options.offline) {
        throw new Error('Use either --online or --offline, not both.');
      }

      let widget;
      if (options.online || options.offline) {
        const data = await client.patch(resolveEndpoint('quoxchat.widgets.update', { orgId, widgetId }).path, {
          service: resolveEndpoint('quoxchat.widgets.update', { orgId, widgetId }).service,
          body: { operator_online: Boolean(options.online) },
        });
        widget = data.widget || data;
        printSuccess(`Operator marked ${options.online ? 'online' : 'offline'}.`);
      } else {
        const data = await client.get(resolveEndpoint('quoxchat.widgets.get', { orgId, widgetId }).path, { service: resolveEndpoint('quoxchat.widgets.get', { orgId, widgetId }).service });
        widget = data.widget || data;
      }

      formatDetail(availabilityView(widget), {
        format: program.opts().output,
        title: 'QuoxChat Availability',
      });
    });

  quoxchat
    .command('conversations')
    .description('List conversations for a QuoxChat widget (live-support desk)')
    .argument('<widgetId>', 'widget ID')
    .option('--status <status>', 'filter by conversation status (active, handed_off, closed)')
    .option('--waiting', 'show only conversations waiting on a human reply')
    .action(async (widgetId, options) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      const query = {};
      if (options.status) query.status = options.status;

      const ep = resolveEndpoint('quoxchat.conversations.list', { orgId, widgetId });
      const data = await client.get(ep.path, { service: ep.service, query });
      let rows = data.items || data.conversations || data || [];
      if (options.waiting) rows = rows.filter((row) => deskStatus(row) === 'waiting');

      formatOutput({
        columns: ['id', 'visitor', 'status', 'last_message_at', 'message_count'],
        headers: ['ID', 'Visitor', 'Status', 'Last message', 'Messages'],
        rows: rows.map((row) => ({
          id: row.id,
          visitor: visitorLabel(row),
          status: deskStatusLabel(row),
          last_message_at: row.last_message_at || row.started_at || '-',
          message_count: row.message_count ?? 0,
        })),
      }, { format: program.opts().output, emptyMessage: 'No conversations found.' });
    });

  quoxchat
    .command('transcript')
    .description('Print a conversation transcript in chronological order')
    .argument('<widgetId>', 'widget ID')
    .argument('<conversationId>', 'conversation ID')
    .action(async (widgetId, conversationId) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);

      // Look up the visitor's display name from the conversation list (the
      // messages endpoint itself carries no visitor identity, only role +
      // sender_name for operator turns), mirroring LiveSupportView.jsx.
      const listEp = resolveEndpoint('quoxchat.conversations.list', { orgId, widgetId });
      const listData = await client.get(listEp.path, { service: listEp.service, query: { limit: 100 } });
      const listRows = listData.items || listData.conversations || listData || [];
      const conv = listRows.find((row) => row.id === conversationId);
      const visitorName = conv ? visitorLabel(conv) : 'Visitor';

      const msgEp = resolveEndpoint('quoxchat.conversations.messages.list', { orgId, widgetId, conversationId });
      const data = await client.get(msgEp.path, { service: msgEp.service });
      const messages = data.messages || data || [];

      formatOutput({
        columns: ['created_at', 'from', 'content'],
        headers: ['Time', 'From', 'Message'],
        rows: messages.map((m) => ({
          // Rows mix SQLite datetime('now') and ISO strings depending on the
          // writer; normalise to one readable local format.
          created_at: formatMessageTime(m.created_at),
          from: m.role === 'user' ? visitorName : m.role === 'operator' ? (m.sender_name || 'Operator') : 'AI assistant',
          content: m.content || '',
        })),
      }, { format: program.opts().output, emptyMessage: 'No messages in this conversation yet.' });
    });

  quoxchat
    .command('reply')
    .description('Send an operator reply in a handed-off QuoxChat conversation')
    .argument('<widgetId>', 'widget ID')
    .argument('<conversationId>', 'conversation ID')
    .argument('<message...>', 'reply text')
    .action(async (widgetId, conversationId, messageParts) => {
      auth.requireAuth();
      const orgId = resolveOrgId(auth, program);
      const body = { body: messageParts.join(' ') };

      const ep = resolveEndpoint('quoxchat.conversations.reply.create', { orgId, widgetId, conversationId });
      try {
        const data = await client.post(ep.path, { service: ep.service, body });
        printSuccess(`Reply sent as ${data.sender_name || 'operator'}.`);
      } catch (err) {
        if (err.status === 409) {
          throw new Error(
            'This conversation is not handed off to a human operator yet. The visitor needs to request a human, or the AI needs to hand off, before a reply can be sent.'
          );
        }
        throw err;
      }
    });
}
