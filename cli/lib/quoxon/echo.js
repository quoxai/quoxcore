// Echo of a command the human typed, shown in the scrollback like a prompt line (wrapped in full, secrets masked).
// Owner 2026-10-15: "why truncated": the echo wraps like any prompt; only a runaway paste is capped.
import { redactSecrets } from './slotChat.js';
import { clip } from './theme.js';

const PIN_CMD = /^\/(authenticate|authorise|authorize)(\s|$)/i;

/** -> { shown, full }: `shown` is the whole command on one logical line (the view wraps it; capped at ECHO_CAP), `full` is the masked text the transcript records. */
export const ECHO_CAP = 2000;
export function echoLine(text, { cols = 100 } = {}) {
  let t = String(text ?? '').trim();
  if (PIN_CMD.test(t)) t = t.split(/\s+/)[0]; // a stray argument may be a PIN: never shown
  const full = redactSecrets(t).text;
  return { shown: clip(full.replace(/\s*\n\s*/g, ' '), ECHO_CAP), full };
}
