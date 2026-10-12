/**
 * Terminal Exec Service
 *
 * Client-side service for executing commands in the user's active terminal session.
 * Handles pre-validation against the denylist, mode-aware policies, and POST to collector.
 */

import { getCommandAction } from '../config/denylist';
import { MODE_EXEC_POLICIES } from '../config/terminalModes';

const COLLECTOR_BASE = '/collector';

/**
 * Execute a command in the user's terminal via the collector POST endpoint.
 * @param {string} sessionId - Active terminal session ID
 * @param {string} command - Command to execute
 * @param {function} [fetchFn] - Optional authenticated fetch (e.g. authFetch from AuthContext). Handles token refresh on 401.
 * @returns {Promise<{ok: boolean, action?: string, validation?: object, error?: string}>}
 */
export async function execInTerminal(sessionId, command, fetchFn) {
  if (!sessionId) {
    return { ok: false, error: 'No active terminal session' };
  }
  if (!command || !command.trim()) {
    return { ok: false, error: 'Empty command' };
  }

  const doFetch = fetchFn || fetch;

  try {
    const resp = await doFetch(`${COLLECTOR_BASE}/terminal/shell/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ sessionId, command: command.trim() })
    });

    const data = await resp.json();

    if (!resp.ok) {
      return {
        ok: false,
        action: data.action || 'BLOCK',
        validation: data.validation || null,
        error: data.message || data.error || `HTTP ${resp.status}`
      };
    }

    return {
      ok: true,
      action: data.action || 'ALLOW',
      validation: data.validation || null
    };
  } catch (err) {
    return { ok: false, error: err.message || 'Network error' };
  }
}

/**
 * Client-side pre-validation of a command for the given mode.
 * Uses the existing denylist + mode exec policies.
 *
 * @param {string} command - Command to validate
 * @param {string} mode - Terminal mode (strict/balanced/builder/audit)
 * @returns {{ action: string, allowed: boolean, severity?: string, description?: string, showButton: boolean }}
 */
export function validateForExec(command, mode = 'balanced') {
  const policy = MODE_EXEC_POLICIES[mode] || MODE_EXEC_POLICIES.balanced;

  // Audit mode: no execution allowed
  if (!policy.showRunButtons) {
    return { action: 'BLOCK', allowed: false, showButton: false, description: 'Audit mode - read only' };
  }

  const result = getCommandAction(command);

  // In strict mode, WARN becomes REQUIRE_APPROVAL
  if (policy.warnAsBlock && result.action === 'WARN') {
    return {
      ...result,
      action: 'REQUIRE_APPROVAL',
      showButton: true
    };
  }

  return {
    ...result,
    showButton: result.action !== 'BLOCK'
  };
}

/**
 * Extract shell commands from markdown code blocks.
 * Looks for fenced code blocks with shell-related language tags.
 *
 * @param {string} markdown - Markdown text (AI response)
 * @returns {Array<{command: string, language: string}>}
 */
export function extractCommands(markdown) {
  if (!markdown) return [];

  const results = [];
  // Match fenced code blocks: ```lang\ncode\n```
  const fenceRegex = /```(\w*)\n([\s\S]*?)```/g;
  const shellLangs = new Set(['bash', 'sh', 'shell', 'console', 'zsh', '']);

  let match;
  while ((match = fenceRegex.exec(markdown)) !== null) {
    const lang = match[1].toLowerCase();
    const code = match[2].trim();

    if (!shellLangs.has(lang)) continue;

    // For unlabeled blocks, heuristic: starts with $ or # prompt, or looks like a command
    if (lang === '' && !looksLikeShellCommand(code)) continue;

    // Strip leading $ prompts only — # lines are valid shell comments, not prompts
    const command = code
      .split('\n')
      .map(line => line.replace(/^\s*\$\s*/, ''))
      .join('\n')
      .trim();

    if (command) {
      results.push({ command, language: lang || 'shell' });
    }
  }

  return results;
}

/**
 * Heuristic: does this code block text look like a shell command?
 */
function looksLikeShellCommand(text) {
  if (!text) return false;
  const firstLine = text.split('\n')[0].trim();
  // Starts with $ or # prompt
  if (/^\s*[\$#]\s/.test(firstLine)) return true;
  // Common command prefixes
  if (/^(sudo|apt|yum|npm|docker|git|curl|wget|ssh|scp|rsync|systemctl|journalctl|cat|ls|cd|mkdir|rm|cp|mv|chmod|chown|grep|find|tar|zip|unzip|df|du|top|htop|ps|kill|ping|dig|nslookup|traceroute|nc|openssl|python|node|go|make|cargo)\b/.test(firstLine)) return true;
  return false;
}
