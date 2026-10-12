/**
 * Discord Connector — VAULT-INTEG P10
 *
 * Tools for the Discord API v10: guild channels and channel messages via a
 * bot token. Requires: bot_token.
 */

const DISCORD_API = 'https://discord.com/api/v10'
const REQUEST_TIMEOUT_MS = 15_000

async function discordFetch(path, credentials, options = {}) {
  const url = `${DISCORD_API}${path}`

  const resp = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bot ${credentials.bot_token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    if (resp.status === 401) {
      throw new Error(`Discord API 401 Unauthorized: invalid or revoked bot token. Body: ${body.slice(0, 200)}`)
    }
    if (resp.status === 429) {
      throw new Error(`Discord API 429: rate limited. Body: ${body.slice(0, 200)}`)
    }
    throw new Error(`Discord API ${resp.status}: ${body.slice(0, 200)}`)
  }

  if (resp.status === 204) return {}
  return resp.json()
}

function getTools(credentials) {
  return [
    {
      name: 'list_channels',
      description: 'List text channels in a Discord guild (server) the bot belongs to',
      input_schema: {
        type: 'object',
        properties: {
          guild_id: { type: 'string', description: 'Discord guild (server) ID' },
        },
        required: ['guild_id'],
      },
      execute: async (input, creds) => {
        const { guild_id } = input
        const channels = await discordFetch(`/guilds/${encodeURIComponent(guild_id)}/channels`, creds)
        return (channels || []).map(c => ({
          id: c.id,
          name: c.name,
          type: c.type,
          topic: c.topic || null,
          position: c.position,
          parent_id: c.parent_id || null,
        }))
      },
    },

    {
      name: 'read_channel',
      description: 'Read recent messages from a Discord channel',
      input_schema: {
        type: 'object',
        properties: {
          channel_id: { type: 'string', description: 'Discord channel ID' },
          limit: { type: 'number', description: 'Max messages to return (default 20, max 100)' },
        },
        required: ['channel_id'],
      },
      execute: async (input, creds) => {
        const { channel_id, limit = 20 } = input
        const params = new URLSearchParams({ limit: String(Math.min(limit, 100)) })
        const messages = await discordFetch(`/channels/${encodeURIComponent(channel_id)}/messages?${params}`, creds)
        return (messages || []).map(m => ({
          id: m.id,
          author: m.author?.username || null,
          content: m.content || '',
          timestamp: m.timestamp,
          edited_timestamp: m.edited_timestamp || null,
        }))
      },
    },

    {
      name: 'post_message',
      description: 'Post a message to a Discord channel',
      input_schema: {
        type: 'object',
        properties: {
          channel_id: { type: 'string', description: 'Discord channel ID to post to' },
          content: { type: 'string', description: 'Message content (max 2000 characters)' },
        },
        required: ['channel_id', 'content'],
      },
      execute: async (input, creds) => {
        const { channel_id, content } = input
        if (content.length > 2000) {
          throw new Error(`Discord message content exceeds 2000 character limit (got ${content.length})`)
        }
        const message = await discordFetch(`/channels/${encodeURIComponent(channel_id)}/messages`, creds, {
          method: 'POST',
          body: JSON.stringify({ content }),
        })
        return { id: message.id, channel_id: message.channel_id, timestamp: message.timestamp }
      },
    },
  ]
}

module.exports = { getTools }
