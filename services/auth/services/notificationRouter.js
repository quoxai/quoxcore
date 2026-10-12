/**
 * Notification Router Service
 *
 * Evaluates routing_rules against inbox items and dispatches notifications
 * to target users via their configured notification channels.
 *
 * Flow:
 *   1. Query routing_rules WHERE org_id = ? AND enabled = 1 ORDER BY priority
 *   2. Evaluate match conditions (kind, priority, tags) against item
 *   3. For matching rules, resolve target users from route_json
 *   4. For each target user, query notification_channels WHERE org_id = ?
 *   5. Fire-and-forget: call collector's sendNotification for each enabled channel
 *   6. Record delivery in notification_deliveries table
 */

import { prepare } from '../db/index.js';
import { ulid } from '../utils/helpers.js';

/**
 * Get the set of enabled channel types for a scope (including ancestor scopes).
 * Returns null if no assignments exist (backwards-compatible: all channels pass).
 *
 * @param {string} orgId
 * @param {string} scopeId
 * @returns {Set<string>|null}
 */
export function getEnabledChannelsForScope(orgId, scopeId) {
  if (!scopeId) return null;

  // Get scope's path for ancestor matching
  const scope = prepare('SELECT path FROM scopes WHERE id = ? AND org_id = ?').get(scopeId, orgId);
  if (!scope || !scope.path) return null;

  // Build ancestor path prefixes: /org/X → /org/X/div/Y → ...
  const parts = scope.path.split('/').filter(Boolean);
  const prefixes = [];
  for (let i = 2; i <= parts.length; i += 2) {
    prefixes.push('/' + parts.slice(0, i).join('/'));
  }

  if (prefixes.length === 0) return null;

  // Query assignments for this scope and all ancestors
  const placeholders = prefixes.map(() => '?').join(', ');
  const rows = prepare(`
    SELECT DISTINCT sca.channel_type
    FROM scope_channel_assignments sca
    JOIN scopes s ON sca.scope_id = s.id
    WHERE sca.org_id = ? AND sca.enabled = 1
      AND s.path IN (${placeholders})
  `).all(orgId, ...prefixes);

  if (rows.length === 0) {
    // Check if any assignments exist at all for these scopes
    const anyAssignments = prepare(`
      SELECT 1 FROM scope_channel_assignments sca
      JOIN scopes s ON sca.scope_id = s.id
      WHERE sca.org_id = ? AND s.path IN (${placeholders})
      LIMIT 1
    `).get(orgId, ...prefixes);

    // No assignments at all → null (backwards-compatible, all channels pass)
    if (!anyAssignments) return null;

    // Assignments exist but none enabled → empty set (block all)
    return new Set();
  }

  return new Set(rows.map(r => r.channel_type));
}

const COLLECTOR_BASE_URL = `http://${process.env.COLLECTOR_HOST || 'collector'}:${process.env.COLLECTOR_PORT || '9848'}`;

/**
 * Evaluate routing rules and dispatch notifications for a new inbox item.
 * Fire-and-forget — errors are logged but don't propagate.
 *
 * @param {string} orgId - Organization ID
 * @param {object} item - Inbox item { id, kind, priority, title, body_md, payload_json }
 */
/**
 * HITL-CONTEXT (owner 2026-10-07): an approval notification on a phone or in
 * Discord must say who is asking, why and how, in one or two lines, before the
 * long body. Source/Reason/Method come from payload.approval_context, built
 * server-side by the collector at request time (lib/approvalContext.js).
 * Returns the message to send; unchanged for items without a context block.
 */
export function buildNotificationMessage(item) {
  const body = item.body_md || item.title;
  let payload = {};
  try { payload = typeof item.payload_json === 'string' ? JSON.parse(item.payload_json || '{}') : (item.payload || {}); } catch { payload = {}; }
  const line = payload && payload.approval_context && payload.approval_context.summary_line;
  if (typeof line !== 'string' || !line.trim()) return body;
  const expires = payload.approval_context.expires_at ? ` (expires ${payload.approval_context.expires_at})` : '';
  return `${line.trim()}${expires}\n\n${body}`;
}

export async function routeAndNotify(orgId, item) {
  try {
    // 1. Fetch enabled rules for this org, ordered by priority
    const rules = prepare(`
      SELECT id, match_json, route_json, priority
      FROM routing_rules
      WHERE org_id = ? AND enabled = 1
      ORDER BY priority ASC
    `).all(orgId);

    // 2+3. Resolve target users.
    // Owner law 2026-10-05 (quox#694): HITL is primary; channels get a copy only
    // when configured AND switched on. An org with NO routing rules used to get
    // nothing on any channel, so switching Discord on did nothing. With no rules,
    // default to the org's active owners/admins (their ENABLED channels are still
    // the gate below). Orgs that set up rules keep exactly their rules.
    const targetUserIds = new Set();
    // "Never configured" means no rules at all, enabled or not: an org that
    // disabled its rules has made a routing choice and keeps it.
    const anyRule = rules.length > 0
      || !!prepare(`SELECT 1 FROM routing_rules WHERE org_id = ? LIMIT 1`).get(orgId);
    if (!anyRule) {
      for (const role of ['owner', 'admin']) {
        for (const uid of resolveTargetUsers(orgId, { role })) targetUserIds.add(uid);
      }
    } else if (rules.length > 0) {
      const matchedRules = rules.filter(rule => {
        const match = rule.match_json ? JSON.parse(rule.match_json) : {};
        return evaluateMatch(match, item);
      });
      if (matchedRules.length === 0) return;
      for (const rule of matchedRules) {
        const route = rule.route_json ? JSON.parse(rule.route_json) : {};
        const users = resolveTargetUsers(orgId, route);
        for (const uid of users) targetUserIds.add(uid);
      }
    }

    if (targetUserIds.size === 0) return;

    // 4. Resolve scope-level channel filtering
    const allowedChannels = item.scope_id
      ? getEnabledChannelsForScope(orgId, item.scope_id)
      : null;

    // 5. For each user, find their enabled notification channels and dispatch
    for (const userId of targetUserIds) {
      const channels = prepare(`
        SELECT channel_type, config_json, enabled
        FROM notification_channels
        WHERE user_id = ? AND (org_id = ? OR org_id IS NULL) AND enabled = 1
      `).all(userId, orgId);

      for (const ch of channels) {
        if (ch.channel_type === 'in_app') continue; // In-app handled via SSE
        // Skip channels not allowed by scope assignment (if configured)
        if (allowedChannels && !allowedChannels.has(ch.channel_type)) continue;
        const config = ch.config_json ? JSON.parse(ch.config_json) : {};
        const recipient = resolveRecipient(ch.channel_type, config, userId);
        if (!recipient) continue;

        // 5. Record delivery attempt
        const deliveryId = ulid();
        try {
          prepare(`
            INSERT INTO notification_deliveries
              (id, org_id, inbox_item_id, channel_type, recipient, status, content_json, created_at)
            VALUES (?, ?, ?, ?, ?, 'pending', ?, datetime('now'))
          `).run(
            deliveryId, orgId, item.id, ch.channel_type, recipient,
            JSON.stringify({ title: item.title, message: buildNotificationMessage(item) })
          );
        } catch (err) {
          console.warn('[NotifRouter] Failed to record delivery:', err.message);
        }

        // 6. Fire-and-forget dispatch via collector
        dispatchNotification({
          deliveryId,
          channel: ch.channel_type,
          recipient,
          title: item.title,
          message: buildNotificationMessage(item),
          priority: item.priority || 'normal',
          orgId
        }).catch(err => {
          console.error(`[NotifRouter] Dispatch failed for ${ch.channel_type}:`, err.message);
        });
      }
    }
  } catch (err) {
    console.error('[NotifRouter] routeAndNotify error:', err.message);
  }
}

/**
 * Evaluate whether a rule's match conditions apply to an inbox item.
 *
 * @param {object} match - Parsed match_json: { kind, priority, tags, risk_level }
 * @param {object} item - Inbox item
 * @returns {boolean}
 */
export function evaluateMatch(match, item) {
  // Empty match = catch-all
  if (!match || Object.keys(match).length === 0) return true;

  // Kind filter (string or array)
  if (match.kind) {
    const kinds = Array.isArray(match.kind) ? match.kind : [match.kind];
    if (!kinds.includes(item.kind)) return false;
  }

  // Priority filter (string or array)
  if (match.priority) {
    const priorities = Array.isArray(match.priority) ? match.priority : [match.priority];
    if (!priorities.includes(item.priority)) return false;
  }

  // Tags filter (item must have ALL specified tags)
  if (match.tags && Array.isArray(match.tags) && match.tags.length > 0) {
    const payload = typeof item.payload_json === 'string'
      ? JSON.parse(item.payload_json)
      : (item.payload_json || {});
    const itemTags = payload.tags || [];
    if (!match.tags.every(t => itemTags.includes(t))) return false;
  }

  return true;
}

/**
 * Resolve target user IDs from a route_json definition.
 *
 * @param {string} orgId
 * @param {object} route - Parsed route_json: { user_ids, role, team_id, fallback }
 * @returns {string[]} user IDs
 */
export function resolveTargetUsers(orgId, route) {
  const users = [];

  // Explicit user IDs
  if (route.user_ids && Array.isArray(route.user_ids)) {
    users.push(...route.user_ids);
  }

  // By role (query org_memberships)
  if (route.role) {
    const rows = prepare(`
      SELECT user_id FROM org_memberships
      WHERE org_id = ? AND role = ? AND status = 'active'
    `).all(orgId, route.role);
    users.push(...rows.map(r => r.user_id));
  }

  // By team_id (query team memberships)
  if (route.team_id) {
    const rows = prepare(`
      SELECT user_id FROM team_memberships
      WHERE team_id = ? AND status = 'active'
    `).all(route.team_id);
    users.push(...rows.map(r => r.user_id));
  }

  // Deduplicate
  return [...new Set(users)];
}

/**
 * Resolve the actual recipient address for a channel type.
 *
 * @param {string} channelType - email, slack, telegram, webhook
 * @param {object} config - Channel config from notification_channels
 * @param {string} userId - Fallback user ID
 * @returns {string|null}
 */
function resolveRecipient(channelType, config, userId) {
  switch (channelType) {
    case 'email':
      return config.to || config.email || null;
    case 'slack':
      return config.webhookUrl || config.webhook_url || config.channel || null;
    case 'telegram':
      return config.chatId || config.chat_id || null;
    case 'webhook':
      return config.url || config.webhook_url || null;
    case 'discord':
      return config.webhookUrl || config.webhook_url || null;
    case 'msteams':
      return config.webhookUrl || config.webhook_url || null;
    case 'twilio-sms':
    case 'sms':
      return config.to || config.phone || config.phone_number || null;
    case 'pagerduty':
      return config.routing_key || config.routingKey || null;
    case 'opsgenie':
      return config.team || config.alias || config.responder || 'opsgenie-alert';
    case 'mattermost':
      return config.webhookUrl || config.webhook_url || null;
    case 'ntfy':
      return config.topic || null;
    case 'pushover':
      return config.user_key || config.userKey || null;
    case 'google-chat':
      return config.webhookUrl || config.webhook_url || null;
    case 'gotify':
      return config.server_url || config.serverUrl || null;
    case 'rocketchat':
      return config.webhookUrl || config.webhook_url || config.channel || null;
    case 'line':
      return config.access_token ? 'line-notify' : null;
    default:
      return null;
  }
}

// Retry configuration
const RETRY_BACKOFF_MS = [30_000, 120_000, 600_000]; // 30s, 2m, 10m
const MAX_ATTEMPTS = 3;

/**
 * Dispatch a notification via the collector service with automatic retry and backoff.
 * On failure, retries up to MAX_ATTEMPTS times with exponential backoff (30s, 2m, 10m).
 *
 * @param {object} params
 */
async function dispatchNotification({ deliveryId, channel, recipient, title, message, priority, orgId }) {
  const attemptSend = async () => {
    const resp = await fetch(`${COLLECTOR_BASE_URL}/api/notification/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // COLLECTOR-AUTH #52: collector default-deny gate authenticates
        // server-to-server callers via INTERNAL_SERVICE_KEY (httpAuth Priority 2).
        ...(process.env.INTERNAL_SERVICE_KEY ? { 'X-Service-Key': process.env.INTERNAL_SERVICE_KEY } : {})
      },
      body: JSON.stringify({ channel, recipient, title, message, priority, orgId }),
      signal: AbortSignal.timeout(30000)
    });
    return resp.ok ? await resp.json() : { success: false, error: `HTTP ${resp.status}` };
  };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const result = await attemptSend();

      if (result.success) {
        prepare(`
          UPDATE notification_deliveries
          SET status = 'sent', sent_at = datetime('now'), attempts = ?, last_attempt_at = datetime('now')
          WHERE id = ?
        `).run(attempt + 1, deliveryId);
        return; // Success — done
      }

      // Final attempt failed — mark as permanently failed
      if (attempt === MAX_ATTEMPTS - 1) {
        prepare(`
          UPDATE notification_deliveries
          SET status = 'failed', last_error = ?, attempts = ?, last_attempt_at = datetime('now')
          WHERE id = ?
        `).run(result.error || 'Unknown error', attempt + 1, deliveryId);
        return;
      }

      // Non-final attempt failed — update status to 'pending' (retrying) and wait
      prepare(`
        UPDATE notification_deliveries
        SET status = 'pending', last_error = ?, attempts = ?, last_attempt_at = datetime('now')
        WHERE id = ?
      `).run(`Retry ${attempt + 1}/${MAX_ATTEMPTS}: ${result.error || 'Unknown error'}`, attempt + 1, deliveryId);

      await new Promise(resolve => setTimeout(resolve, RETRY_BACKOFF_MS[attempt]));

    } catch (err) {
      // Network/timeout error
      if (attempt === MAX_ATTEMPTS - 1) {
        prepare(`
          UPDATE notification_deliveries
          SET status = 'failed', last_error = ?, attempts = ?, last_attempt_at = datetime('now')
          WHERE id = ?
        `).run(err.message, attempt + 1, deliveryId);
        return;
      }

      prepare(`
        UPDATE notification_deliveries
        SET status = 'pending', last_error = ?, attempts = ?, last_attempt_at = datetime('now')
        WHERE id = ?
      `).run(`Retry ${attempt + 1}/${MAX_ATTEMPTS}: ${err.message}`, attempt + 1, deliveryId);

      await new Promise(resolve => setTimeout(resolve, RETRY_BACKOFF_MS[attempt]));
    }
  }
}
