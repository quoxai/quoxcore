/**
 * Shared non-TTY-safe destructive-action confirmation.
 *
 * fleet #398/#399: several commands (`prompt delete`, `tag delete`, etc.)
 * either lacked a --force/-y escape hatch entirely, or called inquirer
 * unconditionally when neither was set. On a non-interactive shell (no
 * stdin TTY — cron, CI, a piped script) inquirer throws
 * `Error: User force closed the prompt with 13 null` AND leaks
 * `Warning: Detected unsettled top-level await at cli/bin/quox.js:221`,
 * verified live on .131. Checking `process.stdin.isTTY` BEFORE importing
 * inquirer avoids both — fail fast with a clear message instead.
 */

/**
 * @param {import('commander').Command} program - root commander program (for global --yes)
 * @param {{ force?: boolean }} options - local command options (for --force)
 * @param {string} message - confirmation prompt text
 * @returns {Promise<boolean>}
 */
export async function confirmDestructive(program, options, message) {
  if (options.force === true || program.opts().yes === true) {
    return true;
  }

  if (!process.stdin.isTTY) {
    throw new Error(`${message} — this needs confirmation; re-run with --force (or -y) in a non-interactive shell`);
  }

  const { default: inquirer } = await import('inquirer');
  const ans = await inquirer.prompt([{
    type: 'confirm',
    name: 'confirm',
    message,
    default: false,
  }]);
  return ans.confirm;
}
