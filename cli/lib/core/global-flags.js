/**
 * global-flags.js — repair for commander's silent global-flag shadowing.
 *
 * Commander 13 resolves a long flag against the ROOT program first. When a
 * subcommand redeclares a flag the root already declares, the root definition
 * wins: the typed value lands on `program.opts()` and the subcommand's own
 * options object holds `undefined` forever. Nothing warns. Nothing throws.
 *
 * That is a silent-wrong-answer bug, and it had already shipped in 13 places:
 *
 *   - `quox gripe --yes` read `options.yes === undefined`, so it never told
 *     GRIPE to file directly and then advised re-running with the flag the
 *     user had just passed (fleet #441). Headless sessions could not file
 *     a gripe at all.
 *   - `--dry-run` on `vault migrate`, `admin` and `backup restore` read
 *     `undefined`, meaning a requested dry run EXECUTED FOR REAL. That one
 *     can cost data, which is why this is a scaffold fix and not a patch to
 *     gripe.js alone.
 *   - `--org` on fleet/skills/governance/done and `--json` on done/qlarity
 *     silently fell back to the active org / table output.
 *
 * The fix is a merge-down, not a de-duplication. Removing the subcommand's
 * declaration would also work, but commander does not list parent options in
 * subcommand help (verified on 13.1.0), so `quox vault migrate --help` would
 * stop mentioning `--dry-run` while still honouring it. Keeping the local
 * declaration keeps it discoverable; this hook makes it actually arrive.
 *
 * Only options the subcommand ITSELF declares are merged, so a command that
 * never declared `--yes` does not silently gain it.
 */

/**
 * Copy shadowed global values down onto the subcommand that declared them.
 *
 * @param {import('commander').Command} rootCommand - the root program
 * @param {import('commander').Command} actionCommand - the subcommand running
 * @returns {string[]} attribute names that were merged (for tests/diagnostics)
 */
export function mergeShadowedGlobals(rootCommand, actionCommand) {
  if (!rootCommand || !actionCommand || actionCommand === rootCommand) return [];

  const rootOpts = rootCommand.opts();
  const merged = [];

  for (const option of actionCommand.options) {
    const name = option.attributeName();
    // A shadowed option can never carry a user value (commander gave it to
    // the root), so an undefined here is unambiguous: nothing local to lose.
    // A subcommand default is a real value and is left alone.
    if (actionCommand.getOptionValue(name) === undefined && rootOpts[name] !== undefined) {
      actionCommand.setOptionValue(name, rootOpts[name]);
      merged.push(name);
    }
  }

  return merged;
}

/**
 * Walk a command tree and report every subcommand option that collides with a
 * root option. Used by the regression test to keep the blast radius visible:
 * new collisions are fine (the hook handles them) but they should be a
 * deliberate, seen decision rather than a surprise.
 *
 * @param {import('commander').Command} rootCommand
 * @returns {Array<{command: string, flag: string, attribute: string}>}
 */
export function findShadowedOptions(rootCommand) {
  const rootAttrs = new Map();
  for (const option of rootCommand.options) {
    rootAttrs.set(option.attributeName(), option.flags);
  }

  const found = [];
  const walk = (cmd, path) => {
    for (const sub of cmd.commands) {
      const subPath = [...path, sub.name()];
      for (const option of sub.options) {
        const attr = option.attributeName();
        if (rootAttrs.has(attr)) {
          found.push({ command: subPath.join(' '), flag: option.flags, attribute: attr });
        }
      }
      walk(sub, subPath);
    }
  };
  walk(rootCommand, []);

  return found;
}
