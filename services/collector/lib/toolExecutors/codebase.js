/**
 * Codebase Tool Executor
 *
 * Native executor for codebase_query tool.
 * Queries the RepoBrain API for code definitions, patterns, and flows.
 * Returns agent-friendly text with file:line citations.
 */

const REPOBRAIN_API = (process.env.REPOBRAIN_URL || 'http://repobrain:3105') + '/api'
const TIMEOUT_MS = 10000

/**
 * codebase_query — search the indexed codebase via RepoBrain
 */
/**
 * QUOXON-ADV: RepoBrain's "Unknown targets: x. Available: a, b, c" 400 -> the real names.
 * Closest = case-insensitive exact, else the one repo whose hyphen-words contain the guess
 * ("dashboard" -> "quox-dashboard"). Ambiguous or no match -> null (never guess between two).
 */
function parseUnknownTarget(body) {
  const m = /Unknown targets?:[^.]*\.\s*Available:\s*([^"}\n]+)/i.exec(body || '')
  return m ? m[1].split(',').map(x => x.trim()).filter(Boolean) : null
}
function closestTarget(guess, available) {
  const g = String(guess || '').toLowerCase()
  const exact = available.filter(a => a.toLowerCase() === g)
  if (exact.length) return exact[0]
  const word = available.filter(a => a.toLowerCase().split(/[-_]/).includes(g))
  return word.length === 1 ? word[0] : null
}

async function codebaseQuery(input, _retried = false) {
  const question = input.question
  const target = input.target || 'quox-dashboard'
  const maxSnippets = Math.min(parseInt(input.max_snippets) || 4, 10)

  if (!question || typeof question !== 'string') {
    return { success: false, error: 'Missing required parameter: question' }
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

    const res = await fetch(`${REPOBRAIN_API}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        targets: [target],
        max_snippets: maxSnippets,
      }),
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      const available = res.status === 400 ? parseUnknownTarget(errText) : null
      if (available) {
        const near = !_retried && closestTarget(target, available)
        if (near && near !== target) return codebaseQuery({ ...input, target: near }, true)
        return { success: false, error: `Unknown codebase target "${target}". Available targets: ${available.join(', ')}` }
      }
      return {
        success: false,
        error: `RepoBrain returned ${res.status}: ${errText.substring(0, 200)}`,
      }
    }

    const data = await res.json()
    const results = data.results || data.snippets || []

    if (results.length === 0) {
      return {
        success: true,
        output: `No results found for: "${question}" in ${target}`,
      }
    }

    // Format as agent-friendly text with file:line citations
    const lines = [`Found ${results.length} result${results.length !== 1 ? 's' : ''} in ${target}:\n`]

    for (const r of results.slice(0, maxSnippets)) {
      const file = r.file || r.path || 'unknown'
      const startLine = r.line || r.start_line || r.lineNumber || ''
      const endLine = r.end_line || r.endLine || ''
      // RepoBrain returns the snippet body under `code` and the score under
      // `retrieval.score` — the original chain missed both, so the agent surface
      // showed bare file:line with no bodies (tooling audit, nucleus). Include
      // them so codebase_query delivers the cited snippets its description
      // promises (RepoBrain's whole value over a raw file read).
      const snippet = r.content || r.snippet || r.text || r.code || ''
      const score = r.score || r.relevance || (r.retrieval && r.retrieval.score) || null

      const location = endLine && endLine !== startLine
        ? `${file}:${startLine}-${endLine}`
        : startLine
          ? `${file}:${startLine}`
          : file

      lines.push(location)
      if (snippet) {
        // Indent snippet lines
        const trimmed = snippet.trim()
        const indented = trimmed.split('\n').map(l => `  ${l}`).join('\n')
        lines.push(indented)
      }
      if (score) {
        lines.push(`  (relevance: ${typeof score === 'number' ? score.toFixed(2) : score})`)
      }
      lines.push('') // blank line between results
    }

    return {
      success: true,
      output: lines.join('\n').trim(),
      resultCount: results.length,
      target,
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      return { success: false, error: 'Codebase search timed out (RepoBrain may be unreachable)' }
    }
    return { success: false, error: `Codebase search unavailable: ${err.message}` }
  }
}

module.exports = { codebaseQuery }
