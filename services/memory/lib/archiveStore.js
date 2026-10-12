// Conversation Archive CRUD operations
import { ulid } from 'ulid'
import { getDatabase } from './db.js'

// =============================================================================
// CONVERSATION ARCHIVES
// =============================================================================

/**
 * Save a conversation with all its messages in a single transaction
 */
export function saveConversation({ org_id, user_id, conversation_id, platform, title, summary, message_count, token_count, topics, entities_mentioned, first_message_at, last_message_at, metadata }, messages = []) {
  const db = getDatabase()
  const id = ulid()

  const insertArchive = db.prepare(`
    INSERT OR IGNORE INTO conversation_archives (
      id, org_id, user_id, conversation_id, platform, title, summary,
      message_count, token_count, topics, entities_mentioned,
      first_message_at, last_message_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const insertMessage = db.prepare(`
    INSERT OR IGNORE INTO conversation_messages (
      id, conversation_archive_id, message_idx, role, content, model, created_at, platform_message_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const txn = db.transaction(() => {
    const info = insertArchive.run(
      id, org_id, user_id, conversation_id, platform, title, summary || null,
      message_count || messages.length, token_count || 0,
      JSON.stringify(topics || []), JSON.stringify(entities_mentioned || []),
      first_message_at || null, last_message_at || null,
      JSON.stringify(metadata || {})
    )

    if (info.changes === 0) {
      return { id: null, conversation_id, skipped: true }
    }

    for (const msg of messages) {
      insertMessage.run(
        ulid(), id, msg.message_idx, msg.role, msg.content,
        msg.model || null, msg.created_at || null, msg.platform_message_id || null
      )
    }

    return { id, conversation_id, title, message_count: messages.length }
  })

  try {
    return txn()
  } catch (err) {
    // If conversation_id already exists, skip silently
    if (err.message.includes('UNIQUE constraint')) {
      return { id: null, conversation_id, skipped: true }
    }
    throw err
  }
}

/**
 * Batch save multiple conversations
 */
export function saveConversationBatch(conversations, org_id, user_id) {
  const db = getDatabase()
  const results = { saved: 0, skipped: 0, errors: [] }

  const insertArchive = db.prepare(`
    INSERT OR IGNORE INTO conversation_archives (
      id, org_id, user_id, conversation_id, platform, title, summary,
      message_count, token_count, topics, entities_mentioned,
      first_message_at, last_message_at, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const insertMessage = db.prepare(`
    INSERT OR IGNORE INTO conversation_messages (
      id, conversation_archive_id, message_idx, role, content, model, created_at, platform_message_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const txn = db.transaction(() => {
    for (const conv of conversations) {
      try {
        const id = ulid()
        const info = insertArchive.run(
          id, org_id, user_id,
          conv.conversation_id, conv.platform || 'chatgpt',
          conv.title || 'Untitled', conv.summary || null,
          conv.message_count || (conv.messages || []).length,
          conv.token_count || 0,
          JSON.stringify(conv.topics || []),
          JSON.stringify(conv.entities_mentioned || []),
          conv.first_message_at || null, conv.last_message_at || null,
          JSON.stringify(conv.metadata || {})
        )

        if (info.changes === 0) {
          results.skipped++
          continue
        }

        const messages = conv.messages || []
        for (const msg of messages) {
          insertMessage.run(
            ulid(), id, msg.message_idx, msg.role, msg.content,
            msg.model || null, msg.created_at || null, msg.platform_message_id || null
          )
        }

        results.saved++
      } catch (err) {
        if (err.message.includes('UNIQUE constraint')) {
          results.skipped++
        } else {
          results.errors.push({ conversation_id: conv.conversation_id, error: err.message })
        }
      }
    }
  })

  txn()
  return results
}

/**
 * List conversations with filters and pagination
 */
export function getConversations({ org_id, user_id, platform, limit = 50, offset = 0 }) {
  const db = getDatabase()

  let query = 'SELECT * FROM conversation_archives WHERE org_id = ? AND user_id = ?'
  const params = [org_id, user_id]

  if (platform) {
    query += ' AND platform = ?'
    params.push(platform)
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)

  const rows = db.prepare(query).all(...params)
  return rows.map(parseArchiveRow)
}

/**
 * Get a single conversation with all messages
 */
export function getConversation(id) {
  const db = getDatabase()

  const archive = db.prepare('SELECT * FROM conversation_archives WHERE id = ?').get(id)
  if (!archive) return null

  const messages = db.prepare(
    'SELECT * FROM conversation_messages WHERE conversation_archive_id = ? ORDER BY message_idx'
  ).all(id)

  return {
    ...parseArchiveRow(archive),
    messages
  }
}

/**
 * Search conversations using FTS5
 */
export function searchConversations({ org_id, user_id, query, platform, limit = 20 }) {
  const db = getDatabase()

  let sql = `
    SELECT a.*,
           bm25(conversation_fts) as rank
    FROM conversation_archives a
    JOIN conversation_fts ON a.rowid = conversation_fts.rowid
    WHERE conversation_fts MATCH ?
      AND a.org_id = ?
      AND a.user_id = ?
  `
  const params = [query, org_id, user_id]

  if (platform) {
    sql += ' AND a.platform = ?'
    params.push(platform)
  }

  sql += ' ORDER BY rank LIMIT ?'
  params.push(limit)

  try {
    const rows = db.prepare(sql).all(...params)
    return rows.map(parseArchiveRow)
  } catch (err) {
    // FTS5 query syntax error — fall back to LIKE
    console.warn('[ArchiveStore] FTS5 query failed, falling back to LIKE:', err.message)
    let fallbackSql = `
      SELECT * FROM conversation_archives
      WHERE org_id = ? AND user_id = ?
        AND (title LIKE ? OR summary LIKE ?)
    `
    const likeTerm = `%${query}%`
    const fallbackParams = [org_id, user_id, likeTerm, likeTerm]

    if (platform) {
      fallbackSql += ' AND platform = ?'
      fallbackParams.push(platform)
    }

    fallbackSql += ' ORDER BY created_at DESC LIMIT ?'
    fallbackParams.push(limit)

    const rows = db.prepare(fallbackSql).all(...fallbackParams)
    return rows.map(parseArchiveRow)
  }
}

/**
 * Delete a conversation and all its messages (cascade)
 */
export function deleteConversation(id) {
  const db = getDatabase()

  const txn = db.transaction(() => {
    db.prepare('DELETE FROM conversation_messages WHERE conversation_archive_id = ?').run(id)
    db.prepare('DELETE FROM conversation_archives WHERE id = ?').run(id)
  })

  txn()
  return { deleted: true }
}

/**
 * Get archive statistics
 */
export function getArchiveStats(org_id, user_id) {
  const db = getDatabase()

  const total = db.prepare(
    'SELECT COUNT(*) as count FROM conversation_archives WHERE org_id = ? AND user_id = ?'
  ).get(org_id, user_id)

  const byPlatform = db.prepare(
    'SELECT platform, COUNT(*) as count FROM conversation_archives WHERE org_id = ? AND user_id = ? GROUP BY platform'
  ).all(org_id, user_id)

  const totalMessages = db.prepare(`
    SELECT COUNT(*) as count FROM conversation_messages m
    JOIN conversation_archives a ON m.conversation_archive_id = a.id
    WHERE a.org_id = ? AND a.user_id = ?
  `).get(org_id, user_id)

  const dateRange = db.prepare(`
    SELECT MIN(first_message_at) as earliest, MAX(last_message_at) as latest
    FROM conversation_archives WHERE org_id = ? AND user_id = ?
  `).get(org_id, user_id)

  return {
    conversations: total?.count || 0,
    messages: totalMessages?.count || 0,
    by_platform: Object.fromEntries((byPlatform || []).map(r => [r.platform, r.count])),
    date_range: {
      earliest: dateRange?.earliest || null,
      latest: dateRange?.latest || null
    }
  }
}

// =============================================================================
// HELPERS
// =============================================================================

function parseArchiveRow(row) {
  if (!row) return null
  return {
    ...row,
    topics: safeJsonParse(row.topics, []),
    entities_mentioned: safeJsonParse(row.entities_mentioned, []),
    metadata: safeJsonParse(row.metadata, {})
  }
}

function safeJsonParse(str, fallback) {
  if (!str) return fallback
  try { return JSON.parse(str) } catch { return fallback }
}
