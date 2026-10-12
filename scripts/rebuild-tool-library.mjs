#!/usr/bin/env node
/**
 * rebuild-tool-library.mjs
 * Rebuilds src/config/tool-library-index.json with:
 *  - Per-tool source URLs matched from awesome-lists
 *  - Honest `status: "reference"` (not "available")
 *  - `source_list` provenance field
 *  - `reference_status: "unmatched"` for tools without a match
 *
 * Usage:
 *   node scripts/rebuild-tool-library.mjs
 *
 * Prerequisites — fetch raw markdown first:
 *   curl -sf https://raw.githubusercontent.com/steven2358/awesome-generative-ai/master/README.md \
 *     -o /tmp/awesome-genai.md
 *   curl -sf https://raw.githubusercontent.com/appcypher/awesome-mcp-servers/main/README.md \
 *     -o /tmp/awesome-mcp-appcypher.md
 *   curl -sf https://raw.githubusercontent.com/wong2/awesome-mcp-servers/main/README.md \
 *     -o /tmp/awesome-mcp-wong2.md
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = path.join(__dirname, '../src/config/tool-library-index.json');

// ---- Awesome-list source definitions ----
// "category" provides a default for new entries from this list when section headings are absent or noisy.
const AWESOME_LISTS = [
  // Original 3 (used by the matching path for existing catalog entries)
  { id: 'awesome-generative-ai',     url: 'https://github.com/steven2358/awesome-generative-ai',     rawPath: '/tmp/awesome-genai.md',                category: 'ai-utility' },
  { id: 'awesome-mcp-appcypher',     url: 'https://github.com/appcypher/awesome-mcp-servers',        rawPath: '/tmp/awesome-mcp-appcypher.md',        category: 'mcp-server' },
  { id: 'awesome-mcp-wong2',         url: 'https://github.com/wong2/awesome-mcp-servers',            rawPath: '/tmp/awesome-mcp-wong2.md',            category: 'mcp-server' },
  // Wave 1 — MCP densification
  { id: 'awesome-mcp-punkpeye',      url: 'https://github.com/punkpeye/awesome-mcp-servers',         rawPath: '/tmp/awesome-mcp-punkpeye.md',         category: 'mcp-server' },
  { id: 'awesome-mcp-official',      url: 'https://github.com/modelcontextprotocol/servers',         rawPath: '/tmp/awesome-mcp-official.md',         category: 'mcp-server' },
  // Wave 2 — security + OSINT
  { id: 'awesome-security',          url: 'https://github.com/sbilly/awesome-security',              rawPath: '/tmp/awesome-security.md',             category: 'security' },
  { id: 'awesome-threat-detection',  url: 'https://github.com/0x4D31/awesome-threat-detection',      rawPath: '/tmp/awesome-threat-detection.md',     category: 'security' },
  { id: 'awesome-appsec',            url: 'https://github.com/paragonie/awesome-appsec',             rawPath: '/tmp/awesome-appsec.md',               category: 'security' },
  { id: 'awesome-osint',             url: 'https://github.com/jivoi/awesome-osint',                  rawPath: '/tmp/awesome-osint.md',                category: 'osint' },
  // Wave 2 — broad utility/connector breadth
  { id: 'awesome-quant',             url: 'https://github.com/wilsonfreitas/awesome-quant',          rawPath: '/tmp/awesome-quant.md',                category: 'finance' },
  { id: 'awesome-crypto',            url: 'https://github.com/coinpride/CryptoList',                 rawPath: '/tmp/awesome-crypto.md',               category: 'crypto' },
  { id: 'awesome-selfhosted',        url: 'https://github.com/awesome-selfhosted/awesome-selfhosted',rawPath: '/tmp/awesome-selfhosted.md',           category: 'self-hosted' },
  { id: 'awesome-public-apis',       url: 'https://github.com/public-apis/public-apis',              rawPath: '/tmp/awesome-public-apis.md',          category: 'public-api' },
  { id: 'awesome-nodejs',            url: 'https://github.com/sindresorhus/awesome-nodejs',          rawPath: '/tmp/awesome-nodejs.md',               category: 'developer' },
  { id: 'awesome-postgres',          url: 'https://github.com/dhamaniasad/awesome-postgres',         rawPath: '/tmp/awesome-postgres.md',             category: 'database' },
  { id: 'awesome-web-scraping',      url: 'https://github.com/lorien/awesome-web-scraping',          rawPath: '/tmp/awesome-web-scraping.md',         category: 'web-scraping' },
  { id: 'awesome-puppeteer',         url: 'https://github.com/transitive-bullshit/awesome-puppeteer',rawPath: '/tmp/awesome-puppeteer.md',            category: 'browser-automation' },
  // Wave 3 — API densification (2026-05-21) per API audit
  { id: 'awesome-public-api-lists',  url: 'https://github.com/public-api-lists/public-api-lists',    rawPath: '/tmp/awesome-public-api-lists.md',     category: 'public-api' },
  { id: 'awesome-integration',       url: 'https://github.com/stn1slv/awesome-integration',          rawPath: '/tmp/awesome-integration.md',          category: 'integration' },
  { id: 'awesome-public-apis-kiran', url: 'https://github.com/itskiranbabu/awesome-public-apis',     rawPath: '/tmp/awesome-public-apis-kiran.md',    category: 'public-api' },
];

// ---- Catalog-level references that are NOT per-tool (list-level refs to normalise) ----
const LIST_LEVEL_REFS = new Set([
  'https://github.com/steven2358/awesome-generative-ai',
  'https://github.com/appcypher/awesome-mcp-servers',
  'https://github.com/wong2/awesome-mcp-servers',
  'https://github.com/topics/ai-orchestration',
]);

// ---- Framework / meta / orchestrator deny-list ----
// Things that BUILD agents, ORCHESTRATE agents, or are PLATFORMS for agents — NOT single-purpose powers.
// User direction 2026-05-20: utilities + connectors only.
const DENY_KEYWORDS = [
  // Agent frameworks
  'langchain', 'langgraph', 'llamaindex', 'llama-index',
  'autogen', 'crewai', 'metagpt', 'babyagi', 'agentgpt', 'openagents',
  'haystack', 'semantic kernel', 'autochain', 'agent-os',
  'multi-agent framework', 'agent framework', 'agentic framework',
  'build agents', 'build your own agent', 'agent platform',
  'agent library', 'agent sdk', 'agent runtime', 'agent toolkit',
  // Workflow orchestrators (their CONNECTOR/MCP would be fine; the orchestrators themselves are not)
  'workflow orchestrator', 'orchestration platform', 'orchestration framework',
  // Prompt eng + eval frameworks (meta to agents)
  'prompt engineering', 'prompt template library', 'promptfoo', 'braintrust',
  'evaluation framework', 'eval framework', 'observability framework',
  'agent observability', 'agent monitoring framework',
  // Learning resources / curated lists (not deployables)
  'curated list', 'collection of', 'awesome list', 'cheatsheet', 'tutorial',
  'methodology guide', 'best practices guide', 'learning resource',
  // Generic LLM serving / model libraries (not connectors)
  'large language model', 'model library', 'foundation model',
];

// Allow-list signals — utility/connector keywords that boost confidence
const UTILITY_SIGNAL_KEYWORDS = [
  'mcp server', 'connector', 'api wrapper', 'client library', 'sdk for',
  'scraper', 'parser', 'converter', 'exporter', 'importer',
  'lookup', 'query', 'fetch', 'sync', 'webhook', 'integration with',
];

function isFramework(entry) {
  const text = `${entry.name} ${entry.description || ''}`.toLowerCase();
  return DENY_KEYWORDS.some(kw => text.includes(kw));
}

// ---- Tier C: embarrassing entries to strip outright ----
// Joke/toy APIs, parser artifacts, listings-not-tools.
// User 2026-05-21: "tier C did sound a bit crap... strip out embarrassing tier C nonsense"
const JUNK_NAME_PATTERNS = [
  /^cat\s*facts?$/i,
  /^dog\s*facts?$/i,
  /^meow\s*facts?$/i,
  /^anime\s*(chan|facts)$/i,
  /^bored\s*api$/i,
  /^chuck\s*norris/i,
  /^ron\s*swanson/i,
  /^yo\s*momma/i,
  /^trump\s*quotes?/i,
  /^rick\s*and\s*morty/i,
  /^breaking\s*bad/i,
  /^futurama/i,
  /^fortune\s*cookie/i,
  /^lorem\s*(picsum|ipsum)/i,
  /^emoji\s*hub$/i,
  /^pokemon$/i,
  /^pok[éeè]\s*api/i,
  // Parser artifacts — section headings & template lines mistakenly captured
  /^api\s*for\s*this\s*project$/i,
  /^issues$/i,
  /^pull\s*requests?$/i,
  /^contributing(\.md)?$/i,
  /^readme(\.md)?$/i,
  /^changelog(\.md)?$/i,
  /^license(\.md)?$/i,
  /^code\s*of\s*conduct$/i,
  /^closed\s*source\s*now$/i,
  /^see\s*also$/i,
  /^references?$/i,
  // Single-purpose joke/toy categories
  /^poetry\s*db$/i,
  /^trace\s*moe$/i,
  /\bbuzz\s*words?\b/i,
  /\bmeme(s|\s*maker|s\s*api)?$/i,
  /\bnamomemes/i,
  /\bgeek[\s-]?jokes?/i,
  /\b(black|fun|silly|weird|random)\s+(history\s+)?facts?\b/i,
  /\bquotes?\s*generator\b/i,
  /\brandom\s*(words?|name(s)?|user(s)?)\b/i,
  /^randommer$/i,
  /\b(web\s*series|movie|tv)\s*quotes?\b/i,
  // TV / film / franchise novelty APIs — added 2026-05-21 from API audit
  /\bstranger\s*things\b/i,
  /\bflorida\s*man\b/i,
  /^mcu\s+/i,
  /\bmarvel\s+(comics|cinematic)/i,
  /\b(harry\s*potter|hogwarts)\b/i,
  /\b(star\s*wars|jedi)\b/i,
  /\bgame\s*of\s*thrones\b/i,
  /\b(simpsons?|south\s*park)\b/i,
  /\bbreaking\s*bad\b/i,
  /\b(rick\s*and\s*morty|adventure\s*time)\b/i,
  /\bdragon\s*ball\b/i,
  /\bone\s*piece\b/i,
  /\bdiscworld\b/i,
  /\b(seinfeld|friends)\s+quotes?\b/i,
  /\b(office|parks\s*and\s*rec)\s+quotes?\b/i,
  // Generic "Quotes" entries — quote-of-X services
  /^quote(s)?\s+(garden|api|of\s+the\s+day|generator)$/i,
  /^(famous|inspirational|motivational)\s+quotes?$/i,
  // Specific novelty repos surfaced by audit
  /^license-api$/i,  // unofficial license JSON wrapper, low value
  /^mcu\s+countdown/i,
];

const JUNK_DESC_PATTERNS = [
  /^\|+$/,                          // table-cell artifact
  /^[\s\-:—`'"*]+$/,                // pure punctuation
  /^closed\s*source/i,
  /^learn\s+to\s+/i,                // learning resources
  /^a?\s*crowdsourced\s+reading/i,  // "crowdsourced reading list"
  /^first\.?$/i,                    // "CONTRIBUTING.md - first."
];

function isTierC(entry) {
  const name = (entry.name || '').trim();
  const desc = (entry.description || '').trim();

  // Drop if name is a single character or empty
  if (name.length <= 1) return true;

  // Drop if name matches a junk pattern
  if (JUNK_NAME_PATTERNS.some(p => p.test(name))) return true;

  // Drop if description is parser noise (but ONLY if description is short — MCP SDKs with
  // empty desc are legit; an empty desc on its own isn't junk-worthy)
  if (desc && JUNK_DESC_PATTERNS.some(p => p.test(desc))) return true;

  return false;
}

function isUtilityLikely(entry) {
  const text = `${entry.name} ${entry.description || ''}`.toLowerCase();
  return UTILITY_SIGNAL_KEYWORDS.some(kw => text.includes(kw));
}

// Slugify for new entry IDs
function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

// ---- Stop words to exclude from matching tokens ----
// These are too generic to be meaningful match signals on their own.
const STOP_WORDS = new Set([
  'tool', 'tools', 'agent', 'agents', 'ai', 'ml', 'api', 'server', 'service',
  'mcp', 'llm', 'gpt', 'via', 'with', 'and', 'for', 'the', 'an', 'or',
  'of', 'in', 'on', 'to', 'from', 'by', 'at', 'as', 'is', 'it', 'be',
  'using', 'based', 'powered', 'integration', 'management',
  // Domain words that appear in many unrelated entries:
  'data', 'code', 'language', 'model', 'system', 'platform', 'framework',
  'open', 'source', 'free', 'app', 'cloud', 'multi', 'auto', 'smart',
  'advanced', 'simple', 'fast', 'new', 'best', 'top', 'pro',
  'console', 'hub', 'studio', 'lab', 'kit', 'suite', 'engine',
  'assistant', 'chat', 'bot', 'copilot', 'helper', 'manager',
]);

// ---- Parse an awesome-list markdown into structured entries ----
// Generic link labels that are NOT tool names — these are link types found on the same line
const GENERIC_LINK_LABELS = new Set([
  'source code', 'github', 'gitlab', 'bitbucket', 'demo', 'live demo', 'website',
  'docs', 'documentation', 'api', 'download', 'home', 'homepage', 'site',
  'video', 'blog', 'paper', 'pdf', 'screenshot', 'changelog', 'roadmap',
  'license', 'install', 'wiki', 'forum', 'chat', 'discord', 'slack', 'matrix',
  'twitter', 'mastodon', 'reddit', 'youtube', 'twitch',
  // hashtags / tags
  '#opensource', '#open-source', '#free', '#paid',
  // common section words
  'clients', 'servers', 'resources', 'tools', 'libraries',
]);

function isGenericLabel(label) {
  const l = label.toLowerCase().trim();
  if (GENERIC_LINK_LABELS.has(l)) return true;
  if (l.startsWith('#')) return true;
  if (l.length <= 2) return true; // single letters, very short labels
  return false;
}

// Strip HTML tags (img / div / span / br / etc.) from awesome-mcp-punkpeye-style
// link labels that contain raw HTML alongside the tool name.
// E.g. `<div align="center"><img src="..." height="20"/></div> ToolName` → `ToolName`
function stripHtml(s) {
  if (!s) return s;
  return s
    .replace(/<[^>]+>/g, ' ')  // strip all HTML tags
    .replace(/&[a-z]+;/gi, ' ') // strip HTML entities
    .replace(/\s+/g, ' ')       // collapse whitespace
    .trim();
}

// Reject names that look like article/guide titles, not tool names.
// User 2026-05-21: "wait we just did a quality check?" → these slipped through.
const NAME_LOOKS_LIKE_ARTICLE = [
  /^a\s+guide\s+to\s+/i,
  /^how\s+to\s+/i,
  /^why\s+(you|i)\s+/i,
  /^introduction\s+to\s+/i,
  /^learn(ing)?\s+(how\s+)?to\s+/i,
  /^tutorial:?\s+/i,
  /^getting\s+started\s+with\s+/i,
  /^the\s+(complete|ultimate|definitive)\s+/i,
];

function isArticleTitle(name) {
  return NAME_LOOKS_LIKE_ARTICLE.some(p => p.test(name));
}

// Derive a fallback name from URL when the link label is garbage (HTML, empty, etc.)
// github.com/owner/repo → "owner/repo"; npmjs.com/package/foo → "foo"; etc.
function nameFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'github.com' || u.hostname === 'gitlab.com') {
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    }
    if (u.hostname === 'www.npmjs.com' || u.hostname === 'npmjs.com') {
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts[0] === 'package' && parts[1]) return parts.slice(1).join('/');
    }
    if (u.hostname === 'pypi.org') {
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts[0] === 'project' && parts[1]) return parts[1];
    }
    if (u.hostname === 'huggingface.co') {
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    }
    return u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// Clean a candidate name: strip HTML, strip markdown noise, drop if junk.
// Returns null if the cleaned name is unusable.
function cleanName(rawName, url) {
  if (!rawName) return null;
  let n = stripHtml(rawName).replace(/[`*]/g, '').trim();
  // Strip leading `!` from image-markdown leaks (![alt](url) fragments)
  n = n.replace(/^!+/, '').trim();
  if (!n || n.length < 2) return nameFromUrl(url);
  if (isGenericLabel(n)) return nameFromUrl(url);
  // If name still contains a URL fragment (long unbreakable string), reject it
  if (/https?:\/\//.test(n) || n.length > 80) return nameFromUrl(url);
  // Reject obvious header/title text shapes captured as link labels
  if (/^(browse|search|click|see|view|read|explore|check)\s+/i.test(n)) return nameFromUrl(url);
  if (/\s+on\s+our\s+/i.test(n)) return nameFromUrl(url);
  // Reject if name still has unbalanced markdown brackets (parser leak)
  if ((n.match(/\[/g) || []).length !== (n.match(/\]/g) || []).length) return nameFromUrl(url);
  if ((n.match(/\(/g) || []).length !== (n.match(/\)/g) || []).length) return nameFromUrl(url);
  return n;
}

function parseAwesomeList(markdown, sourceListUrl) {
  const lines = markdown.split('\n');
  let currentCategory = '';
  const entries = [];
  const seen = new Set(); // deduplicate by url

  // Regex to extract ALL [Name](URL) patterns from a line.
  // Negative lookbehind for `!` so we don't capture ![alt](url) markdown-image syntax.
  const linkPattern = /(?<!!)\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  // Bold name pattern: line starts with optional bullet then **Name** then ` ` or ` -` or ` —` or ` (`
  const boldNamePattern = /^\s*[-*]?\s*\*\*([^*]+?)\*\*/;

  for (const line of lines) {
    // Track headings — strip HTML (e.g. <a name="x"></a> anchor tags common in
    // awesome-mcp-punkpeye) BEFORE removing punctuation, otherwise the closing
    // `>` merges into adjacent text producing garbage like
    // `a-namecommunicationacommunication`.
    if (/^#{1,3}\s/.test(line)) {
      let raw = line.replace(/^#{1,3}\s+/, '');
      raw = raw.replace(/<[^>]+>/g, ' ');           // strip ALL HTML tags first
      raw = raw.replace(/&[a-z]+;/gi, ' ');         // strip HTML entities
      raw = raw.replace(/[^\w\s-]/g, ' ');          // strip non-word/non-space/non-hyphen
      raw = raw.replace(/\s+/g, ' ').trim();
      currentCategory = raw;
      continue;
    }

    // Skip table-of-contents bullets (internal #-anchors only)
    if (/^\s*[-*]\s+\[.*\]\(#/.test(line)) continue;

    // Look for a leading bold tool name (awesome-selfhosted format)
    // Handles both `**Tool Name**` and `**[Tool Name](url)**` (wong2 style)
    const boldMatch = line.match(boldNamePattern);
    let lineBoldName = boldMatch ? boldMatch[1].trim() : null;
    if (lineBoldName) {
      // If the bold wraps a markdown link, extract just the label
      const innerLink = lineBoldName.match(/^\[([^\]]+)\]\(/);
      if (innerLink) lineBoldName = innerLink[1].trim();
      // Strip HTML + markdown noise
      lineBoldName = stripHtml(lineBoldName).replace(/[`*]/g, '').trim();
      // Reject if it became empty, generic, or article-title shaped
      if (!lineBoldName || isGenericLabel(lineBoldName) || isArticleTitle(lineBoldName)) lineBoldName = null;
    }

    const matches = [...line.matchAll(linkPattern)];
    // For lines with a bold leading name, we want ONE entry per line — pick the best URL.
    // For lines without a bold name, we keep one-entry-per-link behaviour (legacy lists).
    if (lineBoldName) {
      // Pick the first link with a non-generic label, preferring a github.com or pypi/npm URL
      const candidate = matches.find(m => !isGenericLabel(m[1]) && isRepoUrl(m[2]))
        || matches.find(m => isRepoUrl(m[2]))
        || matches[0];
      if (!candidate) continue;

      const rawUrl = candidate[2].trim();
      if (!isToolUrl(rawUrl)) continue;
      const url = normaliseUrl(rawUrl);
      if (seen.has(url)) continue;
      seen.add(url);

      // Final clean: strip HTML, fall back to URL-derived name if junk
      const finalName = cleanName(lineBoldName, url);
      if (!finalName) continue;

      // Description: text after the chosen link, cleaned
      const afterLink = line.slice(line.indexOf(candidate[0]) + candidate[0].length);
      const desc = stripHtml(afterLink.replace(/\[[^\]]+\]\([^)]+\)/g, '').replace(/[`*]/g, '').replace(/^[\s\-:—()]+/, '')).trim();

      entries.push({
        name: finalName,
        url,
        description: desc.slice(0, 300),
        category: currentCategory,
        sourceList: sourceListUrl,
      });
      continue;
    }

    // Fallback path — no bold name, parse each link as a potential entry
    for (const match of matches) {
      const rawName = match[1].trim();
      const rawUrl = match[2].trim();

      // Skip generic link labels — these are link-type indicators, not tool names
      if (isGenericLabel(rawName)) continue;

      // Only accept URLs that look like specific repos / tools
      if (!isToolUrl(rawUrl)) continue;

      const url = normaliseUrl(rawUrl);
      if (seen.has(url)) continue;
      seen.add(url);

      // Final clean: strip HTML, fall back to URL-derived name if junk
      const finalName = cleanName(rawName, url);
      if (!finalName) continue;
      if (isArticleTitle(finalName)) continue;

      // Extract description: text after the closing ) and optional ** and dash, strip HTML
      const afterLink = line.slice(line.indexOf(match[0]) + match[0].length);
      const desc = stripHtml(afterLink.replace(/^\*\*/, '').replace(/^[\s\-:*]+/, '')).trim();

      entries.push({
        name: finalName,
        url,
        description: desc.slice(0, 300),
        category: currentCategory,
        sourceList: sourceListUrl,
      });
    }
  }

  return entries;
}

function isToolUrl(url) {
  // Must be a repo or product URL, not an article/announcement
  if (/github\.com\/[^/]+\/[^/]+/.test(url)) return true;
  if (/github\.com\/topics\//.test(url)) return false; // topics page
  if (/npmjs\.com\/package\//.test(url)) return true;
  if (/pypi\.org\/project\//.test(url)) return true;
  if (/huggingface\.co\/[^/]+\/[^/]+/.test(url)) return true;
  // Conservative: only short-path product domains (no blog/article paths)
  if (/\.(dev|io|ai|app|cloud)\//.test(url) && !/blog|news|article|post|announcement/i.test(url)) {
    const urlObj = new URL(url);
    const parts = urlObj.pathname.split('/').filter(Boolean);
    if (parts.length <= 1) return true;
  }
  return false;
}

// Guard: reject entries that are themselves meta-lists (avoid awesome-X matching as per-tool)
function isMetaList(entry) {
  const nameLower = entry.name.toLowerCase();
  const urlLower = entry.url.toLowerCase();
  return (
    nameLower.startsWith('awesome') ||
    urlLower.includes('awesome') ||
    nameLower.includes('curated list') ||
    nameLower.includes('collection of')
  );
}

// Guard: for non-GitHub URLs matched via substring, require that the entry URL
// actually contains GitHub (so we don't match random comparison sites as per-tool refs)
function isRepoUrl(url) {
  return /github\.com\/[^/]+\/[^/]+/.test(url);
}

function normaliseUrl(url) {
  // Strip trailing slashes, anchors, and query strings
  return url.replace(/[#?].*$/, '').replace(/\/+$/, '');
}

// ---- Tokenise a string for matching ----
function tokenise(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

// ---- Score a catalog tool against an awesome-list entry ----
// Returns a score object; only "acceptable" matches should be used.
function scoreMatch(tool, entry) {
  const toolNameTokens = new Set(tokenise(tool.name));
  const toolDescTokens = new Set(tokenise(tool.description || ''));
  const entryNameTokens = new Set(tokenise(entry.name));
  const entryDescTokens = new Set(tokenise(entry.description || ''));
  const entryAllTokens = new Set([...entryNameTokens, ...entryDescTokens]);

  // 1. Name-to-name token overlap
  let nameToNameOverlap = 0;
  for (const t of toolNameTokens) {
    if (entryNameTokens.has(t)) nameToNameOverlap++;
  }

  // 2. Tool name tokens matching entry description tokens
  // (catches "Slack messaging tool" ↔ entry name "Slack" with desc "send Slack messages")
  let nameToDescOverlap = 0;
  for (const t of toolNameTokens) {
    if (entryDescTokens.has(t)) nameToDescOverlap++;
  }

  // 3. Tool name tokens matching entry name+desc combined
  let nameToAllOverlap = 0;
  for (const t of toolNameTokens) {
    if (entryAllTokens.has(t)) nameToAllOverlap++;
  }

  // 4. Substring match (tool name contains entry name as substring or vice versa)
  const toolNameLower = tool.name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const entryNameLower = entry.name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const substringMatch =
    entryNameLower.length > 2 && (
      toolNameLower.includes(entryNameLower) || entryNameLower.includes(toolNameLower)
    );

  return {
    nameToNameOverlap,
    nameToDescOverlap,
    nameToAllOverlap,
    substringMatch,
  };
}

// Threshold: accept if strong name-to-name match OR substring match
// Bias toward rejection — only accept high-confidence matches.
function isAcceptableMatch(score) {
  // Strong name-to-name: e.g., "Slack Messaging" ↔ "Slack" → 1 token overlap but substring
  if (score.substringMatch) return true;
  // Two name tokens overlap: "Vector Search" ↔ "Vector Search Tool"
  if (score.nameToNameOverlap >= 2) return true;
  // Name matches against entry description AND name tokens overlap
  if (score.nameToNameOverlap >= 1 && score.nameToDescOverlap >= 1) return true;
  return false;
}

function matchScore(score) {
  // Comparable score for ranking among acceptable matches (higher = better)
  return score.nameToNameOverlap * 10 + (score.substringMatch ? 5 : 0) + score.nameToDescOverlap;
}

// ---- Map catalog reference URLs to awesome-list IDs ----
function getSourceListId(reference) {
  if (!reference) return null;
  if (reference.includes('steven2358')) return 'awesome-generative-ai';
  if (reference.includes('appcypher')) return 'awesome-mcp-appcypher';
  if (reference.includes('wong2')) return 'awesome-mcp-wong2';
  return null;
}

// ---- Soft cap per source to prevent any single list dominating ----
// User direction 2026-05-20: ~few thousand total, quality over quantity.
const PER_SOURCE_CAP = 400;

// ---- Parent-category mapping for sidebar grouping ----
// 367 distinct `category` values (per-tool section headings) are too many for
// a usable sidebar. The `subcategory` field is the source-list level (~12
// values). Roll those up into ~7 parent categories that group cleanly.
// User direction 2026-05-22: "any logical grouping for parent categories to improve sidebar"
const PARENT_CATEGORY_BY_SUBCATEGORY = {
  // Densification subcategories (source-list level, 12 distinct)
  'mcp-server':         'Connectors',
  'integration':        'Connectors',
  'public-api':         'Connectors',
  'developer':          'Development',
  'database':           'Development',
  'browser-automation': 'Development',
  'web-scraping':       'Development',
  'security':           'Security',
  'osint':              'Security',
  'self-hosted':        'Self-Hosted',
  'finance':            'Finance',
  'crypto':             'Finance',
  'ai-utility':         'AI',
  // Original hand-curated subcategories (32 distinct, ~69 entries)
  'mcp':                'Connectors',
  'communication':      'Connectors',
  'dev':                'Development',
  'ml-database':        'Development',
  'framework':          'Development',
  'sdk':                'Development',
  'analytics':          'Development',
  'observability':      'Development',
  'sandbox':            'Development',
  'execution':          'Development',
  'ingestion':          'Development',
  'tools':              'Development',
  'tracking':           'Development',
  'validation':         'Development',
  'vcs':                'Development',
  'scraping':           'Development',
  'safety':             'Security',
  'ai-coding':          'AI',
  'coordination':       'AI',
  'prompts':            'AI',
  'evaluation':         'AI',
  'inference':          'AI',
  'memory':             'AI',
  'orchestration':      'AI',
  'retrieval':          'AI',
  'routing':            'AI',
  'vector-db':          'AI',
  'workflow':           'AI',
  'docs':               'Productivity',
  'project':            'Productivity',
  'productivity':       'Productivity',
};

function parentCategoryFor(subcategory) {
  return PARENT_CATEGORY_BY_SUBCATEGORY[subcategory] || 'Other';
}

// ---- Main ----
function main() {
  console.log('Reading catalog...');
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));

  console.log('Parsing awesome-lists...');
  const listEntries = {}; // id -> entries[]
  for (const list of AWESOME_LISTS) {
    let markdown;
    try {
      markdown = readFileSync(list.rawPath, 'utf8');
    } catch (e) {
      console.warn(`  WARNING: Could not read ${list.rawPath} — ${e.message}`);
      listEntries[list.id] = [];
      continue;
    }
    const entries = parseAwesomeList(markdown, list.url);
    listEntries[list.id] = entries;
    console.log(`  ${list.id}: ${entries.length} entries parsed`);
  }

  // Stats counters
  let keptSpecific = 0;
  let matched = 0;
  let unmatchedListRef = 0;
  let alreadyNull = 0;

  const matchedExamples = [];
  const unmatchedExamples = [];

  const updatedTools = catalog.tools.map(tool => {
    const ref = tool.reference;

    // Case 1: already has a specific per-tool URL — keep it, fix status + add parent_category
    if (ref && !LIST_LEVEL_REFS.has(ref)) {
      keptSpecific++;
      return {
        ...tool,
        status: 'reference',
        parent_category: parentCategoryFor(tool.subcategory),
      };
    }

    // Case 2: no reference at all — leave null
    if (!ref) {
      alreadyNull++;
      return {
        ...tool,
        status: 'reference',
        reference: null,
        reference_status: 'unmatched',
      };
    }

    // Case 3: list-level ref (or topics page) — try to match
    const sourceListId = getSourceListId(ref);
    const sourceListUrl = AWESOME_LISTS.find(l => l.id === sourceListId)?.url || ref;

    if (!sourceListId || !listEntries[sourceListId] || listEntries[sourceListId].length === 0) {
      // Topics page or unknown — clear reference
      unmatchedListRef++;
      unmatchedExamples.push({ tool, reason: 'No searchable list for ref: ' + ref });
      return {
        ...tool,
        status: 'reference',
        reference: null,
        source_list: sourceListUrl !== ref ? sourceListUrl : null,
        reference_status: 'unmatched',
      };
    }

    const candidates = listEntries[sourceListId];
    let bestEntry = null;
    let bestScoreVal = -1;

    for (const entry of candidates) {
      // Reject meta-lists (awesome-X repos)
      if (isMetaList(entry)) continue;
      // For non-GitHub URLs, require stronger name-to-name match (avoid comparison sites)
      const score = scoreMatch(tool, entry);
      if (!isAcceptableMatch(score)) continue;
      // Extra guard: if URL is not a GitHub repo, require nameToNameOverlap >= 2
      if (!isRepoUrl(entry.url) && score.nameToNameOverlap < 2) continue;
      const sv = matchScore(score);
      if (sv > bestScoreVal) {
        bestEntry = entry;
        bestScoreVal = sv;
      }
    }

    if (bestEntry) {
      matched++;
      if (matchedExamples.length < 5) {
        matchedExamples.push({ tool, entry: bestEntry, score: bestScoreVal });
      }
      return {
        ...tool,
        status: 'reference',
        reference: bestEntry.url,
        source_list: sourceListUrl,
      };
    } else {
      unmatchedListRef++;
      if (unmatchedExamples.length < 5) {
        unmatchedExamples.push({ tool, reason: 'No entry in ' + sourceListId + ' matched threshold' });
      }
      return {
        ...tool,
        status: 'reference',
        reference: null,
        source_list: sourceListUrl,
        reference_status: 'unmatched',
      };
    }
  });

  // ---- Emit new entries from parsed awesome-lists ----
  // Collect every URL already in the catalog (existing 365 + newly-matched references)
  // so we don't add a duplicate row for the same tool.
  const existingUrls = new Set();
  for (const t of updatedTools) {
    if (t.reference) existingUrls.add(normaliseUrl(t.reference));
  }

  const newEntries = [];
  const perSourceCounts = {};
  const frameworkRejects = {};
  const dupRejects = {};

  for (const list of AWESOME_LISTS) {
    const parsed = listEntries[list.id] || [];
    perSourceCounts[list.id] = 0;
    frameworkRejects[list.id] = 0;
    dupRejects[list.id] = 0;

    for (const entry of parsed) {
      if (perSourceCounts[list.id] >= PER_SOURCE_CAP) break;

      // Reject meta-lists (awesome-X repos themselves)
      if (isMetaList(entry)) { frameworkRejects[list.id]++; continue; }

      // Reject framework / orchestrator / methodology entries
      if (isFramework(entry)) { frameworkRejects[list.id]++; continue; }

      // Reject Tier C (joke APIs, parser artifacts, listings-not-tools)
      if (isTierC(entry)) { frameworkRejects[list.id]++; continue; }

      // Skip if already in catalog (by URL)
      if (existingUrls.has(entry.url)) { dupRejects[list.id]++; continue; }
      existingUrls.add(entry.url);

      // Skip if URL isn't a real repo/product URL (extra defensive — parser already filters)
      if (!isToolUrl(entry.url)) continue;

      // Derive category — prefer the entry's parsed section heading, fall back to list-level default
      const category = (entry.category && entry.category.length > 1 && entry.category.length < 60)
        ? entry.category.toLowerCase().replace(/\s+/g, '-')
        : list.category;

      // Provider inference from URL
      let provider = 'external';
      if (/github\.com/.test(entry.url)) provider = 'github';
      else if (/npmjs\.com/.test(entry.url)) provider = 'npm';
      else if (/pypi\.org/.test(entry.url)) provider = 'pypi';
      else if (/huggingface\.co/.test(entry.url)) provider = 'huggingface';

      newEntries.push({
        id: `${list.id}.${slugify(entry.name)}`.slice(0, 100),
        name: entry.name,
        description: (entry.description || '').slice(0, 240),
        category,
        subcategory: list.category,
        parent_category: parentCategoryFor(list.category),
        risk_level: 'medium',
        sandbox_profile: 'standard',
        status: 'reference',
        provider,
        icon: 'tool',
        reference: entry.url,
        source_list: list.url,
        reference_status: 'matched',
        added_at: new Date().toISOString().slice(0, 10),
        added_source: 'awesome-list-densification',
        added_via: list.id,
      });
      perSourceCounts[list.id]++;
    }
  }

  // HONESTY: drop entries with no real reference URL.
  // These are concept-only stubs from the original hand-curated IDEAS_TOOLING.md
  // ("Image Editor", "orchestration.workflow-engine", etc.) — they imply a tool
  // exists but link to nothing. AGENT-HONESTY discipline forbids fake data.
  // User 2026-05-21: "no fake data!"
  const droppedUnmatched = updatedTools.filter(t => !t.reference).length;
  const matchedKept = updatedTools.filter(t => t.reference);

  const allTools = [...matchedKept, ...newEntries];

  // Update meta
  // TODO: the inherited `.categories` summary object (~30 hand-curated icon/color
  // entries) is now stale relative to the 361 distinct `category` values across
  // all tools. ToolDetailView's icon resolution now uses parent_category as
  // primary lookup, so this is informational-only. A future densify pass could
  // regenerate `.categories` to include per-parent-category metadata for the 7
  // parent buckets, or drop the field entirely (consumers should read tools[]
  // directly, not the summary).
  const updated = {
    ...catalog,
    version: '2.1.0-densified',
    generatedAt: new Date().toISOString(),
    totalTools: allTools.length,
    tools: allTools,
  };

  writeFileSync(CATALOG_PATH, JSON.stringify(updated, null, 2) + '\n');

  console.log('\n=== Rebuild complete ===');
  console.log(`Pre-existing catalog entries: ${updatedTools.length}`);
  console.log(`  Dropped (no real URL):       ${droppedUnmatched}`);
  console.log(`  Kept specific URLs:          ${keptSpecific}`);
  console.log(`  Newly matched from lists:    ${matched}`);
  console.log(`  Stays null (no match):       ${alreadyNull + unmatchedListRef}`);
  console.log(`New entries added:            ${newEntries.length}`);
  console.log(`Total after densification:    ${allTools.length}`);
  console.log(`Real-URL coverage:            ${allTools.filter(t => t.reference).length} / ${allTools.length}  (${Math.round(100 * allTools.filter(t => t.reference).length / allTools.length)}%)`);

  console.log('\n--- Per-source new-entry counts ---');
  for (const list of AWESOME_LISTS) {
    const c = perSourceCounts[list.id];
    const fr = frameworkRejects[list.id];
    const dr = dupRejects[list.id];
    console.log(`  ${list.id.padEnd(28)}  added=${String(c).padStart(4)}  rejected(framework/meta)=${String(fr).padStart(4)}  dup=${String(dr).padStart(4)}`);
  }

  console.log('\n--- Good matches (existing-entry match path) ---');
  for (const { tool, entry, score } of matchedExamples) {
    console.log(`  "${tool.name}"`);
    console.log(`    → [${entry.name}] ${entry.url}  (score=${score})`);
  }

  console.log('\n--- Sample new entries ---');
  for (const e of newEntries.slice(0, 10)) {
    console.log(`  [${e.added_via}] ${e.name}  →  ${e.reference}`);
  }
}

main();
