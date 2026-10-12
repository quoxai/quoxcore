/**
 * URL Crawl Utilities (CW-8.4)
 *
 * URL validation, normalization, and link extraction for the knowledge crawler.
 */

const PRIVATE_IP_PATTERNS = [
  /^https?:\/\/localhost/i,
  /^https?:\/\/127\./,
  /^https?:\/\/10\./,
  /^https?:\/\/192\.168\./,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\./,
  /^https?:\/\/\[::1\]/,
  /^https?:\/\/0\.0\.0\.0/,
]

const NON_PAGE_EXTENSIONS = ['.pdf', '.zip', '.tar', '.gz', '.jpg', '.jpeg', '.png', '.gif', '.svg', '.mp4', '.mp3', '.doc', '.docx', '.xls', '.xlsx']

/**
 * Check if a URL is valid for crawling (public HTTP/HTTPS, not private).
 */
export function isValidCrawlUrl(url) {
  if (!url || typeof url !== 'string') return false

  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) return false
  } catch {
    return false
  }

  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(url)) return false
  }

  return true
}

/**
 * Normalize a URL: strip trailing slash, fragment, query params, lowercase hostname.
 */
export function normalizeUrl(url) {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    parsed.search = ''
    let normalized = parsed.toString()
    if (normalized.endsWith('/')) normalized = normalized.slice(0, -1)
    return normalized
  } catch {
    return url
  }
}

/**
 * Extract same-domain links from HTML content.
 * Returns unique, normalized URLs that belong to the same domain.
 */
export function extractLinks(html, baseUrl) {
  if (!html || !baseUrl) return []

  const links = new Set()
  let baseDomain
  try {
    baseDomain = new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return []
  }

  // Simple regex to extract href values (no DOM dependency for shared use)
  const hrefRegex = /href=["']([^"']+)["']/gi
  let match
  while ((match = hrefRegex.exec(html)) !== null) {
    const href = match[1]

    // Skip non-navigable
    if (href.startsWith('mailto:') || href.startsWith('javascript:') || href.startsWith('#') || href.startsWith('tel:')) continue

    // Resolve relative URLs
    let resolved
    try {
      resolved = new URL(href, baseUrl).toString()
    } catch {
      continue
    }

    // Same domain only
    try {
      const resolvedDomain = new URL(resolved).hostname.toLowerCase()
      if (resolvedDomain !== baseDomain) continue
    } catch {
      continue
    }

    // Skip non-page extensions
    const path = new URL(resolved).pathname.toLowerCase()
    if (NON_PAGE_EXTENSIONS.some(ext => path.endsWith(ext))) continue

    const normalized = normalizeUrl(resolved)
    if (normalized && normalized !== normalizeUrl(baseUrl)) {
      links.add(normalized)
    }
  }

  return Array.from(links)
}
