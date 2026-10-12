/**
 * Notion Connector — Wave 1
 *
 * Tools for Notion API v1.
 * Requires: token (Notion integration token)
 */

const NOTION_API = 'https://api.notion.com/v1'

async function notionFetch(path, credentials, options = {}) {
  const resp = await fetch(`${NOTION_API}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${credentials.token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  })

  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    throw new Error(`Notion API ${resp.status}: ${body.slice(0, 200)}`)
  }

  return resp.json()
}

function extractPlainText(richText) {
  if (!richText || !Array.isArray(richText)) return ''
  return richText.map(t => t.plain_text || '').join('')
}

function extractTitle(properties) {
  for (const prop of Object.values(properties || {})) {
    if (prop.type === 'title') return extractPlainText(prop.title)
  }
  return ''
}

function getTools(credentials) {
  return [
    {
      name: 'search',
      description: 'Search Notion pages and databases by query',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          filter_type: { type: 'string', enum: ['page', 'database'], description: 'Filter by object type' },
          page_size: { type: 'number', description: 'Results per page (max 100)' },
        },
        required: ['query'],
      },
      execute: async (input, creds) => {
        const { query, filter_type, page_size = 20 } = input
        const body = { query, page_size: Math.min(page_size, 100) }
        if (filter_type) body.filter = { value: filter_type, property: 'object' }

        const result = await notionFetch('/search', creds, {
          method: 'POST',
          body: JSON.stringify(body),
        })

        return {
          results: result.results?.map(r => ({
            id: r.id,
            type: r.object,
            title: r.object === 'page'
              ? extractTitle(r.properties)
              : extractPlainText(r.title),
            url: r.url,
            last_edited: r.last_edited_time,
          })),
          has_more: result.has_more,
        }
      },
    },

    {
      name: 'get_page',
      description: 'Get a Notion page and its properties',
      input_schema: {
        type: 'object',
        properties: {
          page_id: { type: 'string', description: 'Notion page ID' },
        },
        required: ['page_id'],
      },
      execute: async (input, creds) => {
        const { page_id } = input
        const page = await notionFetch(`/pages/${page_id}`, creds)
        const properties = {}
        for (const [name, prop] of Object.entries(page.properties || {})) {
          if (prop.type === 'title') properties[name] = extractPlainText(prop.title)
          else if (prop.type === 'rich_text') properties[name] = extractPlainText(prop.rich_text)
          else if (prop.type === 'select') properties[name] = prop.select?.name
          else if (prop.type === 'multi_select') properties[name] = prop.multi_select?.map(s => s.name)
          else if (prop.type === 'status') properties[name] = prop.status?.name
          else if (prop.type === 'date') properties[name] = prop.date?.start
          else if (prop.type === 'number') properties[name] = prop.number
          else if (prop.type === 'checkbox') properties[name] = prop.checkbox
          else if (prop.type === 'url') properties[name] = prop.url
        }
        return {
          id: page.id,
          url: page.url,
          created: page.created_time,
          last_edited: page.last_edited_time,
          properties,
        }
      },
    },

    {
      name: 'get_page_content',
      description: 'Get the block content of a Notion page',
      input_schema: {
        type: 'object',
        properties: {
          page_id: { type: 'string', description: 'Notion page ID' },
        },
        required: ['page_id'],
      },
      execute: async (input, creds) => {
        const { page_id } = input
        const blocks = await notionFetch(`/blocks/${page_id}/children?page_size=100`, creds)
        return {
          blocks: blocks.results?.map(b => {
            const text = b[b.type]?.rich_text
              ? extractPlainText(b[b.type].rich_text)
              : ''
            return { type: b.type, text: text.slice(0, 500), has_children: b.has_children }
          }),
          has_more: blocks.has_more,
        }
      },
    },

    {
      name: 'query_database',
      description: 'Query a Notion database with optional filters and sorts',
      input_schema: {
        type: 'object',
        properties: {
          database_id: { type: 'string', description: 'Notion database ID' },
          filter: { type: 'object', description: 'Notion filter object (see Notion API docs)' },
          page_size: { type: 'number', description: 'Results per page (max 100)' },
        },
        required: ['database_id'],
      },
      execute: async (input, creds) => {
        const { database_id, filter, page_size = 20 } = input
        const body = { page_size: Math.min(page_size, 100) }
        if (filter) body.filter = filter

        const result = await notionFetch(`/databases/${database_id}/query`, creds, {
          method: 'POST',
          body: JSON.stringify(body),
        })

        return {
          results: result.results?.map(r => {
            const properties = {}
            for (const [name, prop] of Object.entries(r.properties || {})) {
              if (prop.type === 'title') properties[name] = extractPlainText(prop.title)
              else if (prop.type === 'rich_text') properties[name] = extractPlainText(prop.rich_text)
              else if (prop.type === 'select') properties[name] = prop.select?.name
              else if (prop.type === 'status') properties[name] = prop.status?.name
              else if (prop.type === 'date') properties[name] = prop.date?.start
              else if (prop.type === 'number') properties[name] = prop.number
              else if (prop.type === 'checkbox') properties[name] = prop.checkbox
            }
            return { id: r.id, url: r.url, properties }
          }),
          has_more: result.has_more,
        }
      },
    },

    {
      name: 'create_page',
      description: 'Create a new page in a Notion database',
      input_schema: {
        type: 'object',
        properties: {
          database_id: { type: 'string', description: 'Parent database ID' },
          title: { type: 'string', description: 'Page title' },
          properties: { type: 'object', description: 'Additional properties (key-value pairs matching database schema)' },
        },
        required: ['database_id', 'title'],
      },
      execute: async (input, creds) => {
        const { database_id, title, properties = {} } = input

        // Build properties with title
        const pageProps = {
          ...Object.fromEntries(
            Object.entries(properties).map(([key, value]) => {
              if (typeof value === 'string') return [key, { rich_text: [{ text: { content: value } }] }]
              if (typeof value === 'number') return [key, { number: value }]
              if (typeof value === 'boolean') return [key, { checkbox: value }]
              return [key, value]
            })
          ),
        }

        // Find the title property name (first title-type property)
        // Default to 'Name' which is the most common
        const titleKey = 'Name'
        pageProps[titleKey] = { title: [{ text: { content: title } }] }

        const result = await notionFetch('/pages', creds, {
          method: 'POST',
          body: JSON.stringify({
            parent: { database_id },
            properties: pageProps,
          }),
        })
        return { id: result.id, url: result.url }
      },
    },
  ]
}

module.exports = { getTools }
