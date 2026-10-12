/**
 * Slack Connector — VAULT-INTEG P10
 *
 * Tools for the Slack Web API. Requires: bot_token (xoxb-...).
 *
 * Slack's Web API is unusual: most failures still return HTTP 200 with
 * `{ ok: false, error: '<code>' }` in the body, so a bare status check is
 * not enough — every response is inspected for `ok` before being trusted.
 */

const SLACK_API = 'https://slack.com/api'
const REQUEST_TIMEOUT_MS = 15_000

async function slackFetch(path, credentials, options = {}) {
  const url = `${SLACK_API}${path}`

  const resp = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${credentials.bot_token}`,
      'Content-Type': 'application/json; charset=utf-8',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`Slack API ${resp.status}: ${body.slice(0, 200)}`)
  }

  const data = await resp.json()
  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error || 'unknown_error'}`)
  }

  return data
}

function getTools(credentials) {
  return [
    {
      name: 'list_channels',
      description: 'List Slack channels visible to the bot (public and private it has joined)',
      input_schema: {
        type: 'object',
        properties: {
          types: { type: 'string', description: 'Comma-separated channel types (default "public_channel,private_channel")' },
          limit: { type: 'number', description: 'Max channels to return (default 100, max 200)' },
          cursor: { type: 'string', description: 'Pagination cursor from a previous call' },
        },
      },
      execute: async (input, creds) => {
        const { types = 'public_channel,private_channel', limit = 100, cursor } = input
        const params = new URLSearchParams({
          types,
          limit: String(Math.min(limit, 200)),
        })
        if (cursor) params.set('cursor', cursor)
        const data = await slackFetch(`/conversations.list?${params}`, creds)
        return {
          channels: (data.channels || []).map(c => ({
            id: c.id,
            name: c.name,
            is_private: c.is_private,
            is_archived: c.is_archived,
            is_member: c.is_member,
            num_members: c.num_members,
            topic: c.topic?.value || '',
          })),
          next_cursor: data.response_metadata?.next_cursor || null,
        }
      },
    },

    {
      name: 'read_channel',
      description: 'Read recent message history from a Slack channel',
      input_schema: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'Channel ID (e.g. C0123456789)' },
          limit: { type: 'number', description: 'Max messages to return (default 20, max 100)' },
          oldest: { type: 'string', description: 'Only messages after this Slack timestamp' },
        },
        required: ['channel'],
      },
      execute: async (input, creds) => {
        const { channel, limit = 20, oldest } = input
        const params = new URLSearchParams({
          channel,
          limit: String(Math.min(limit, 100)),
        })
        if (oldest) params.set('oldest', oldest)
        const data = await slackFetch(`/conversations.history?${params}`, creds)
        return {
          messages: (data.messages || []).map(m => ({
            ts: m.ts,
            user: m.user || m.bot_id || null,
            text: m.text || '',
            type: m.type,
            thread_ts: m.thread_ts || null,
          })),
          has_more: !!data.has_more,
        }
      },
    },

    {
      name: 'post_message',
      description: 'Post a message to a Slack channel (or a thread within it)',
      input_schema: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'Channel ID to post to' },
          text: { type: 'string', description: 'Message text' },
          thread_ts: { type: 'string', description: 'Optional Slack timestamp to reply in a thread' },
        },
        required: ['channel', 'text'],
      },
      execute: async (input, creds) => {
        const { channel, text, thread_ts } = input
        const body = { channel, text }
        if (thread_ts) body.thread_ts = thread_ts
        const data = await slackFetch('/chat.postMessage', creds, {
          method: 'POST',
          body: JSON.stringify(body),
        })
        return { channel: data.channel, ts: data.ts, text: data.message?.text || text }
      },
    },
  ]
}

module.exports = { getTools }
