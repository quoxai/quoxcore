/**
 * Terminal File Service
 *
 * Client-side service for AI-proposed file creation and editing in the user's terminal session.
 * Handles parsing structured file blocks from AI markdown responses, path validation,
 * diff computation, and POST/GET to collector file endpoints.
 *
 * Phase 4a: file:create support.
 * Phase 4b: file:edit with diffs, read-file, backup/undo.
 * Phase 4d: file:delete and file:rename actions.
 */

import { MODE_FILE_POLICIES } from '../config/terminalModes';
import { diffLines } from 'diff';

const COLLECTOR_BASE = '/collector';

// ── File block pattern: file:(create|edit|delete|rename):/absolute/path ──

const FILE_BLOCK_PATTERN = /^file:(create|edit|delete|rename):(\/.+)$/;

// ── Path classification ─────────────────────────────────────────────

const PATH_RULES = {
  blocked: [
    /\.\./,             // directory traversal
    /\x00/,             // null bytes
  ],
  red: [
    /^\/dev\//,
    /^\/proc\//,
    /^\/sys\//,
    /^\/boot\//,
  ],
  amber: [
    /^\/etc\//,
    /^\/opt\//,
    /^\/var\//,
  ],
};


/**
 * Parse a file block from ReactMarkdown's language string and code content.
 *
 * @param {string} language - The language string from the code block (e.g. "file:create:/tmp/hello.js")
 * @param {string} codeText - The raw text content of the code block
 * @returns {{ action: string, filePath: string, content: string, meta: object|null } | null}
 */
export function parseFileBlock(language, codeText) {
  if (!language || !codeText) return null;

  const match = language.match(FILE_BLOCK_PATTERN);
  if (!match) return null;

  const action = match[1];   // "create", "edit", "delete", or "rename"
  const pathPart = match[2];  // "/absolute/path" or "/old/path:/new/path" (rename)

  // Extract optional #quox-meta JSON from first line
  let content = codeText;
  let meta = null;

  const lines = codeText.split('\n');
  if (lines[0] && lines[0].startsWith('#quox-meta:')) {
    try {
      meta = JSON.parse(lines[0].slice('#quox-meta:'.length).trim());
    } catch {
      // invalid meta — treat as content
    }
    if (meta) {
      content = lines.slice(1).join('\n');
    }
  }

  // Trim trailing newline (markdown parsers often add one)
  if (content.endsWith('\n')) {
    content = content.slice(0, -1);
  }

  // Rename: split dual paths — file:rename:/old/path:/new/path
  if (action === 'rename') {
    const colonIdx = pathPart.indexOf(':', 1); // skip first char (root /)
    if (colonIdx === -1 || !pathPart.slice(colonIdx + 1).startsWith('/')) return null;
    const oldPath = pathPart.slice(0, colonIdx);
    const newPath = pathPart.slice(colonIdx + 1);
    return { action, filePath: oldPath, targetPath: newPath, content, meta };
  }

  // Delete: content body is optional (reason text)
  if (action === 'delete') {
    return { action, filePath: pathPart, content, meta };
  }

  return { action, filePath: pathPart, content, meta };
}


/**
 * Validate a file path and return a severity classification.
 *
 * @param {string} filePath - Absolute path to validate
 * @returns {{ valid: boolean, severity: 'GREEN'|'AMBER'|'RED'|'BLOCKED', reason?: string }}
 */
export function validateFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return { valid: false, severity: 'BLOCKED', reason: 'Empty path' };
  }

  if (!filePath.startsWith('/')) {
    return { valid: false, severity: 'BLOCKED', reason: 'Path must be absolute' };
  }

  // Check blocked patterns
  for (const pattern of PATH_RULES.blocked) {
    if (pattern.test(filePath)) {
      return { valid: false, severity: 'BLOCKED', reason: 'Path contains blocked pattern' };
    }
  }

  // Check red (dangerous system paths)
  for (const pattern of PATH_RULES.red) {
    if (pattern.test(filePath)) {
      return { valid: true, severity: 'RED', reason: 'System path — high risk' };
    }
  }

  // Check amber (sensitive paths)
  for (const pattern of PATH_RULES.amber) {
    if (pattern.test(filePath)) {
      return { valid: true, severity: 'AMBER', reason: 'Sensitive path — review carefully' };
    }
  }

  return { valid: true, severity: 'GREEN' };
}


/**
 * Write a file to the user's terminal session via the collector endpoint.
 * The collector writes a heredoc through the PTY, so it works for both local and SSH sessions.
 * For edit actions, the collector creates a backup before writing.
 * For restore actions, the collector restores from backup.
 *
 * @param {string} sessionId - Active terminal session ID
 * @param {string} filePath - Absolute path to create/edit
 * @param {string} content - File content to write (empty for restore)
 * @param {string} action - File action ("create", "edit", "restore")
 * @param {function} [fetchFn] - Optional authenticated fetch (e.g. authFetch)
 * @param {object} [extra] - Extra fields to include in the request body (e.g. backupPath)
 * @returns {Promise<{ ok: boolean, error?: string, backupPath?: string }>}
 */
export async function writeFile(sessionId, filePath, content, action, fetchFn, extra) {
  if (!sessionId) {
    return { ok: false, error: 'No active terminal session' };
  }
  if (!filePath || !filePath.startsWith('/')) {
    return { ok: false, error: 'Invalid file path' };
  }

  const doFetch = fetchFn || fetch;

  try {
    const resp = await doFetch(`${COLLECTOR_BASE}/terminal/shell/write-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ sessionId, filePath, content, action: action || 'create', ...extra })
    });

    const data = await resp.json();

    if (!resp.ok) {
      return { ok: false, error: data.message || data.error || `HTTP ${resp.status}` };
    }

    return { ok: true, backupPath: data.backupPath || null };
  } catch (err) {
    return { ok: false, error: err.message || 'Network error' };
  }
}


/**
 * Read the current content of a file via the collector endpoint.
 * Used to compute diffs for file:edit blocks.
 * Works for local sessions (fs.readFile). SSH sessions gracefully fail.
 *
 * @param {string} sessionId - Active terminal session ID
 * @param {string} filePath - Absolute path to read
 * @param {function} [fetchFn] - Optional authenticated fetch
 * @returns {Promise<{ ok: boolean, content?: string, error?: string }>}
 */
export async function readFile(sessionId, filePath, fetchFn) {
  if (!sessionId) {
    return { ok: false, error: 'No active terminal session' };
  }
  if (!filePath || !filePath.startsWith('/')) {
    return { ok: false, error: 'Invalid file path' };
  }

  const doFetch = fetchFn || fetch;

  try {
    const params = new URLSearchParams({ sessionId, filePath });
    const resp = await doFetch(`${COLLECTOR_BASE}/terminal/shell/read-file?${params}`, {
      credentials: 'include',
      signal: AbortSignal.timeout(10000),
    });

    const data = await resp.json();

    if (!resp.ok) {
      return { ok: false, error: data.message || data.error || `HTTP ${resp.status}` };
    }

    return { ok: true, content: data.content };
  } catch (err) {
    return { ok: false, error: err.message || 'Network error' };
  }
}


/**
 * Compute a line-level diff between original and modified file content.
 * Uses the `diff` npm package (LCS-based algorithm).
 *
 * @param {string} original - Original file content
 * @param {string} modified - New (modified) file content
 * @returns {{ lines: Array<{ type: 'added'|'removed'|'context', content: string }>, stats: { added: number, removed: number, context: number } }}
 */
export function computeDiff(original, modified) {
  const changes = diffLines(original, modified);

  const lines = [];
  for (const part of changes) {
    // Remove trailing newline from each part (diffLines includes them)
    const partLines = part.value.replace(/\n$/, '').split('\n');
    const type = part.added ? 'added' : part.removed ? 'removed' : 'context';
    for (const line of partLines) {
      lines.push({ type, content: line });
    }
  }

  const stats = { added: 0, removed: 0, context: 0 };
  for (const l of lines) {
    stats[l.type]++;
  }

  return { lines, stats };
}


/**
 * Get file policy for the current mode.
 *
 * @param {string} mode - Terminal mode (strict/balanced/builder/audit)
 * @returns {{ showApplyButtons: boolean, requireConfirmModal: boolean }}
 */
export function getFilePolicy(mode) {
  return MODE_FILE_POLICIES[mode] || MODE_FILE_POLICIES.balanced;
}
