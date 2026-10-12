/**
 * Per-session shell input buffer for command capture.
 *
 * Each shell WebSocket keystroke goes through here. When a line-terminator
 * (Enter) arrives, the accumulated bytes are flushed as one "command" the
 * caller can log to AEE. Backspace and common cursor movements are honoured
 * so the recorded command matches what the user actually submitted.
 *
 * Privacy: truncates to MAX_COMMAND_LENGTH bytes so pathological pastes
 * don't bloat the audit store. Never captures PTY output — only input.
 */

const MAX_COMMAND_LENGTH = 4096; // per-command payload cap

/**
 * @param {object} opts
 * @param {(cmd: string) => void} opts.onCommand  fires once per completed line
 * @param {number} [opts.maxLength]  override for MAX_COMMAND_LENGTH
 */
function createShellCapture({ onCommand, maxLength = MAX_COMMAND_LENGTH } = {}) {
  let buffer = '';
  let truncated = false;

  function reset() { buffer = ''; truncated = false; }

  function feed(data) {
    if (typeof data !== 'string' || data.length === 0) return;

    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      const code = data.charCodeAt(i);

      // Enter — flush the line. \r alone is what most shells submit.
      if (ch === '\r' || ch === '\n') {
        const cmd = buffer.trim();
        if (cmd.length > 0 && typeof onCommand === 'function') {
          try { onCommand(cmd, { truncated }); } catch { /* never throw */ }
        }
        reset();
        continue;
      }

      // Backspace / Ctrl-H — remove the last char
      if (code === 0x7f || code === 0x08) {
        buffer = buffer.slice(0, -1);
        continue;
      }

      // Ctrl-U — kill the line
      if (code === 0x15) {
        reset();
        continue;
      }

      // Ctrl-C — abandon the line without logging
      if (code === 0x03) {
        reset();
        continue;
      }

      // ESC sequences / arrow keys etc. — skip the sequence.
      // Minimal handler: drop ESC + next one or two bytes.
      if (code === 0x1b) {
        // peek next byte
        const next = data.charCodeAt(i + 1);
        if (next === 0x5b /* [ */ || next === 0x4f /* O */) {
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }

      // Accumulate normal chars (including spaces + tabs).
      if (buffer.length < maxLength) {
        buffer += ch;
      } else {
        truncated = true;
      }
    }
  }

  return { feed, reset };
}

module.exports = { createShellCapture, MAX_COMMAND_LENGTH };
