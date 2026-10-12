/**
 * Terminal Context Builder
 *
 * Builds AI context from terminal output + mode policy for the QuoxCode assistant.
 * Called by TerminalChat's contextBuilder prop on every chat message.
 *
 * Flow:
 *   1. Fetch terminal output from collector via GET /terminal/shell/output/:sessionId
 *   2. Strip ANSI escape codes so AI sees clean text
 *   3. Compose: MODE_POLICY_BLOCK + TERMINAL_OUTPUT section
 *   4. Return composed string (ChatEngine wraps in security delimiters, sanitizes to 6000 chars)
 */

import { MODE_POLICIES, DEFAULT_MODE } from '../config/terminalModes';

const COLLECTOR_BASE = '/collector';
const MAX_OUTPUT_CHARS = 4000;

/**
 * Strip ANSI escape sequences and control characters from raw PTY output.
 *
 * Raw terminal output contains:
 *   - SGR (colors/styles):       \x1B[32m ... \x1B[0m
 *   - CSI sequences (cursor etc): \x1B[2A, \x1B[?2004h (bracketed paste)
 *   - OSC (window title):         \x1B]0;title\x07
 *   - Character set / keypad:     \x1B(B, \x1B>, \x1B=
 *   - Backspace echoes:           \x08 (BS) from readline editing
 *   - Other control chars:        \x00-\x1F except \n \r \t
 *
 * We also simulate backspace: "ab\x08c" → "ac" (character deletion).
 *
 * @param {string} text - Raw terminal output with ANSI codes
 * @returns {string} Clean text suitable for AI consumption
 */
export function stripAnsi(text) {
  if (!text) return '';

  // 1. Strip all ESC sequences (CSI with optional ? > ! prefixes, OSC, charset, keypad)
  // eslint-disable-next-line no-control-regex
  let clean = text.replace(
    /\x1B(?:\[[?>=!]?[0-9;]*[A-Za-z]|\][^\x07]*\x07|\([A-Z]|[>=])/g,
    ''
  );

  // 2. Simulate backspace: each \x08 deletes the preceding character
  // eslint-disable-next-line no-control-regex
  while (/[^\x08]\x08/.test(clean)) {
    // eslint-disable-next-line no-control-regex
    clean = clean.replace(/[^\x08\n]\x08/g, '');
  }
  // Remove any remaining orphan backspaces
  // eslint-disable-next-line no-control-regex
  clean = clean.replace(/\x08/g, '');

  // 3. Strip remaining control chars except \n \r \t
  // eslint-disable-next-line no-control-regex
  clean = clean.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  return clean;
}

/**
 * Fetch terminal output from the collector server's RingBuffer.
 * @param {string} sessionId - Terminal session ID
 * @param {number} [chars=4000] - Max characters to fetch
 * @returns {Promise<{output: string, mode: string, hostId: string|null}|null>}
 */
export async function fetchTerminalOutput(sessionId, chars = MAX_OUTPUT_CHARS) {
  if (!sessionId) {
    console.log('[terminalContextBuilder] fetchTerminalOutput: no sessionId');
    return null;
  }

  try {
    const url = `${COLLECTOR_BASE}/terminal/shell/output/${encodeURIComponent(sessionId)}?chars=${chars}`;
    console.log(`[terminalContextBuilder] Fetching: ${url}`);
    const resp = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(5000) });
    if (!resp.ok) {
      console.warn(`[terminalContextBuilder] Fetch failed: HTTP ${resp.status}`);
      return null;
    }
    const data = await resp.json();
    console.log(`[terminalContextBuilder] Got output: ${data.output?.length || 0} chars, mode=${data.mode}`);
    return data;
  } catch (err) {
    console.warn('[terminalContextBuilder] Failed to fetch output:', err.message);
    return null;
  }
}

/**
 * Build the full dynamic context string for ChatEngine.
 *
 * Returns: MODE_POLICY_BLOCK + TERMINAL_OUTPUT_SECTION
 * ChatEngine will wrap this in security delimiters and sanitize to 6000 chars.
 *
 * @param {string} query - User's chat message
 * @param {string|null} sessionId - Focused terminal pane's session ID
 * @param {string} [mode='balanced'] - Terminal mode: strict | balanced | builder | audit
 * @returns {Promise<string>} Composed context string
 */
export async function buildTerminalContext(query, sessionId, mode = DEFAULT_MODE) {
  console.log(`[terminalContextBuilder] buildTerminalContext: sessionId=${sessionId}, mode=${mode}`);
  const sections = [];

  // 1. Mode policy block (always included — defines behavior posture)
  const modePolicy = MODE_POLICIES[mode] || MODE_POLICIES[DEFAULT_MODE];
  sections.push(modePolicy);

  // 2. Terminal output section
  if (sessionId) {
    const result = await fetchTerminalOutput(sessionId, MAX_OUTPUT_CHARS);
    if (result && result.output) {
      const cleanOutput = stripAnsi(result.output);
      // Trim to budget after ANSI stripping (stripping may reduce length)
      const trimmedOutput = cleanOutput.length > MAX_OUTPUT_CHARS
        ? cleanOutput.slice(-MAX_OUTPUT_CHARS)
        : cleanOutput;

      const hostInfo = result.hostId
        ? ` (SSH: ${result.hostId})`
        : ' (local shell)';

      const hostReminder = result.hostId
        ? `This output is from remote host "${result.hostId}" via SSH. ` +
          'Any Docker containers, services, or processes visible here belong to that remote host — not to you. '
        : 'This output is from a local shell session. ';

      sections.push(
        `## Terminal Output${hostInfo}\n\n` +
        '```\n' +
        trimmedOutput +
        '\n```\n\n' +
        hostReminder +
        'Use this terminal output as context when answering the user\'s question. ' +
        'Reference specific lines or errors when relevant.'
      );
    } else {
      sections.push(
        '## Terminal Output\n\n' +
        'No terminal output available. The terminal session may not be connected or may have no output yet.'
      );
    }
  } else {
    sections.push(
      '## Terminal Output\n\n' +
      'No terminal session is currently focused. The user may not have an active terminal pane.'
    );
  }

  return sections.join('\n\n---\n\n');
}
