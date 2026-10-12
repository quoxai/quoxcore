/**
 * File Processing Utilities (CW-8.3)
 *
 * Text extraction and chunk preparation for the knowledge pipeline.
 * Used by both collector (server-side processing) and tests.
 *
 * Server-side PDF parsing uses pdf-parse (installed in collector).
 * This module handles text/HTML/markdown — PDF is server-only.
 */

import { chunkText, computeContentHash, buildChunkMetadata } from './knowledgePipeline'

/**
 * Extract plain text from file content based on MIME type.
 * Handles: text/plain, text/markdown, text/html, text/csv, application/json
 * PDF/DOCX require server-side libraries (pdf-parse, mammoth) — not handled here.
 */
export function extractTextFromContent(content, mimeType) {
  if (!content) return ''

  switch (mimeType) {
    case 'text/plain':
    case 'text/csv':
      return content

    case 'text/markdown':
      // Strip markdown syntax but preserve text
      return content
        .replace(/#{1,6}\s+/g, '') // headers
        .replace(/\*\*(.+?)\*\*/g, '$1') // bold
        .replace(/\*(.+?)\*/g, '$1') // italic
        .replace(/`{1,3}[^`]*`{1,3}/g, '') // code
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
        .replace(/^\s*[-*+]\s+/gm, '') // list bullets
        .replace(/^\s*\d+\.\s+/gm, '') // numbered lists
        .trim()

    case 'text/html':
      // Strip HTML tags, scripts, styles
      return content
        .replace(/<script[\s\S]*?<\/script>/gi, '') // scripts
        .replace(/<style[\s\S]*?<\/style>/gi, '') // styles
        .replace(/<nav[\s\S]*?<\/nav>/gi, '') // nav
        .replace(/<footer[\s\S]*?<\/footer>/gi, '') // footer
        .replace(/<header[\s\S]*?<\/header>/gi, '') // header
        .replace(/<[^>]+>/g, ' ') // all remaining tags
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim()

    case 'application/json':
      // Pretty-print JSON as readable text
      try {
        const parsed = JSON.parse(content)
        return JSON.stringify(parsed, null, 2)
      } catch {
        return content
      }

    default:
      return content
  }
}

/**
 * Chunk text and prepare metadata for Qdrant upsert.
 * Returns array of { text, metadata } objects ready for embedding.
 *
 * @param {string} text — extracted plain text
 * @param {object} opts — { sourceName, sourceType, widgetId, sectionHeading }
 * @returns {Array<{text: string, metadata: object}>}
 */
export function chunkAndPrepare(text, { sourceName, sourceType, widgetId, sectionHeading } = {}) {
  if (!text || text.trim().length === 0) return []

  const chunks = chunkText(text, { chunkSize: 1000, overlap: 200 })

  return chunks.map((chunk, i) => {
    const meta = buildChunkMetadata({
      sourceType: sourceType || 'file',
      sourceName: sourceName || 'unknown',
      sectionHeading: sectionHeading || null,
      chunkIndex: chunk.index,
      totalChunks: chunks.length,
    })

    return {
      text: chunk.text,
      metadata: {
        ...meta,
        widgetId: widgetId || '',
        contentHash: computeContentHash(chunk.text),
        chunkStart: chunk.start,
        chunkEnd: chunk.end,
      },
    }
  })
}
