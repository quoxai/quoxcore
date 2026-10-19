/**
 * #1101: Ctrl-C (or a closed stdin) at an inquirer prompt rejects with ExitPromptError
 * ("User force closed the prompt with SIGINT"). That is the user leaving, not a crash: say so in one word,
 * put the cursor back, and exit 130 instead of printing a raw Error line.
 */
export const PROMPT_CANCELLED = 'Cancelled.';

export function isPromptCancel(err) {
  if (!err) return false;
  return err.name === 'ExitPromptError' || /User force closed the prompt/.test(String(err.message || ''));
}

export function exitOnPromptCancel(err, { stderr = process.stderr, exit = process.exit } = {}) {
  if (!isPromptCancel(err)) return false;
  try { stderr.write(`\x1b[?25h\n${PROMPT_CANCELLED}\n`); } catch { /* the exit still happens */ }
  exit(130);
  return true;
}
