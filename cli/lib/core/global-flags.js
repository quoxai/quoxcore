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

  // Nearest ancestor first, root last. quox#1077 follow-up: a PARENT group
  // that declares the same option shadows its leaf exactly like the root does
  // (`quox lucid since-last --no-advance` set the flag on `lucid`, and the
  // leaf kept its default and advanced the cursor). Only the root used to be
  // consulted.
  const ancestors = [];
  for (let c = actionCommand.parent; c; c = c.parent) {
    ancestors.push(c);
    if (c === rootCommand) break;
  }
  const typed = (src) => src === 'cli' || src === 'env';
  const merged = [];

  for (const option of actionCommand.options) {
    const name = option.attributeName();
    const localValue = actionCommand.getOptionValue(name);
    const localSource = actionCommand.getOptionValueSource(name);
    if (typed(localSource)) continue; // the user typed it on the leaf itself

    // 1. A value the user TYPED on an ancestor wins over the leaf's default.
    //    A shadowed option can never carry a user value (commander gave it to
    //    the ancestor), so the leaf's value here is at most a default. This is
    //    what makes --no-* options work: their default is true, never undefined.
    const typedOn = ancestors.find((a) => a.options.some((o) => o.attributeName() === name)
      && typed(a.getOptionValueSource(name)));
    if (typedOn) {
      actionCommand.setOptionValue(name, typedOn.getOptionValue(name));
      merged.push(name);
      continue;
    }

    // 2. Otherwise fill an empty leaf from the root (its default included),
    //    as before. A subcommand default is a real value and is left alone.
    const rootOpts = rootCommand.opts();
    if (localValue === undefined && rootOpts[name] !== undefined) {
      actionCommand.setOptionValue(name, rootOpts[name]);
      merged.push(name);
    }
  }

  return merged;
}

const HONOURS_GLOBAL_DRY_RUN = Symbol.for('quox.forwardsRawArgs');

/**
 * Mark a leaf that honours a --dry-run WITHOUT declaring its own option,
 * because it forwards every raw argv token after its verb word to a wrapped
 * tool (claude, codex, gemini, wrap). Such a leaf honours the flag only when
 * it is typed AFTER the verb (it then reaches the wrapped tool); typed before
 * the verb it reaches nothing, so it is refused like any other.
 */
export function markForwardsRawArgs(command, reason) {
  command[HONOURS_GLOBAL_DRY_RUN] = reason || true;
  return command;
}

/** 'declared' | 'forwards' | false */
export function dryRunSupport(command) {
  if (!command) return false;
  if (command.options.some((o) => o.attributeName() === 'dryRun')) return 'declared';
  if (command[HONOURS_GLOBAL_DRY_RUN]) return 'forwards';
  return false;
}

/** The raw argv tokens before the leaf's own verb word (commander's root rawArgs). */
function tokensBeforeVerb(rootCommand, actionCommand) {
  const raw = Array.isArray(rootCommand.rawArgs) ? rootCommand.rawArgs : [];
  const words = [];
  for (let c = actionCommand; c && c !== rootCommand; c = c.parent) words.unshift(c.name());
  let at = 0;
  for (const w of words) {
    const i = raw.indexOf(w, at);
    if (i < 0) return raw; // cannot locate: treat everything as "before" (refuse)
    at = i + 1;
  }
  return raw.slice(0, at - 1);
}

export function honoursGlobalDryRun(command, rootCommand) {
  const support = dryRunSupport(command);
  if (support === 'declared') return true;
  if (support === 'forwards') return !rootCommand || !tokensBeforeVerb(rootCommand, command).includes('--dry-run');
  return false;
}

/**
 * Refuse a --dry-run the running leaf cannot honour (quox#1077 follow-up).
 *
 * `--dry-run` is a ROOT option, so commander accepts it after ANY verb. A leaf
 * that never declared it then ignores it and runs for real: `quox offload npm
 * publish --dry-run` published (the flag never reached npm), `quox discord bind
 * ... --dry-run` bound (qdp bind has no dry run). A requested dry run must
 * either be honoured or refused; it is never silently dropped.
 *
 * @throws {Error} exitCode 2, before the action runs
 */
export function assertDryRunHonoured(rootCommand, actionCommand) {
  if (!rootCommand || !actionCommand || actionCommand === rootCommand) return;
  const typed = (c) => ['cli', 'env'].includes(c.getOptionValueSource('dryRun')) && c.getOptionValue('dryRun') === true;
  let requested = false;
  for (let c = actionCommand; c; c = c.parent) {
    if (typed(c)) { requested = true; break; }
    if (c === rootCommand) break;
  }
  if (!requested || honoursGlobalDryRun(actionCommand, rootCommand)) return;
  const path = [];
  for (let c = actionCommand; c && c !== rootCommand; c = c.parent) path.unshift(c.name());
  const err = new Error(
    `\`quox ${path.join(' ')}\` has no dry run, so --dry-run cannot be honoured. Nothing was run. `
    + 'If --dry-run belongs to a command you are passing through, put that command after -- .',
  );
  err.code = 'quox.dryRunNotHonoured';
  err.exitCode = 2;
  throw err;
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
