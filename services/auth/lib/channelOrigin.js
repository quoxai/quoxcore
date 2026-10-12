/**
 * Channel Origin Resolver — CORECOMMS-LOOP
 *
 * Given an inbox item's parsed payload, decides whether the item actually
 * originated from an external channel (a Telegram/Slack unknown-sender
 * escalation minted by services/collector/lib/telegramWebhook.js or
 * slackWebhook.js createInboxItem — payload.source + chat_id/slack_user_id)
 * as opposed to an internal/agent/widget item (quoxchat_widget,
 * quoxchat_lead, quoxchat_ticket, credential_lease, native_tool_approval,
 * qluster_delegation, ...). Only channel-originated items are eligible for
 * the bidirectional reply fan-out in routes/inbox.js's respond handler.
 *
 * Pure, side-effect-free — safe to unit test in isolation.
 */

/**
 * @param {object|null} payload - parsed inbox_items.payload_json
 * @returns {{ channelType: string, externalId: string }|null}
 */
export function resolveChannelOrigin(payload) {
  if (!payload || typeof payload !== 'object') return null;

  if (payload.source === 'telegram' && payload.chat_id !== undefined && payload.chat_id !== null && payload.chat_id !== '') {
    return { channelType: 'telegram', externalId: String(payload.chat_id) };
  }

  if (payload.source === 'slack' && payload.slack_user_id !== undefined && payload.slack_user_id !== null && payload.slack_user_id !== '') {
    return { channelType: 'slack', externalId: String(payload.slack_user_id) };
  }

  // Forward-compatible generic shape, matching channelConversationStore's own
  // column names, in case a future escalation path sets these directly
  // instead of the telegram/slack-specific fields above.
  if (payload.channel_type && payload.external_id !== undefined && payload.external_id !== null && payload.external_id !== '') {
    return { channelType: String(payload.channel_type), externalId: String(payload.external_id) };
  }

  return null;
}
