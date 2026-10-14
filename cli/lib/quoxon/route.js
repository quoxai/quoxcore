/**
 * Bare `quox` is the conversation. Decide, from argv alone, whether this
 * invocation belongs to the QUOXON client (no subcommand, only client flags).
 * Anything with a subcommand, --help or --version stays with commander.
 */
const VALUE_FLAGS = new Set(['-p', '--profile', '-n', '--name']);
const LEVELS = new Set(['off', 'on', 'full']); // `--verbose` alone means on; it only takes a value that is a level
const PRINT_VALUE_FLAGS = new Set(['--output', '--conversation', '--turn-id', '--timeout', '--provider', '--model', '--agent', '--prompt-profile']);
const BOOL_FLAGS = new Set(['--demo', '--autoplay', '--demo-onboarding', '--no-clear', '--color', '--service-key']);
const ALL_FLAGS = new Set([...VALUE_FLAGS, ...PRINT_VALUE_FLAGS, ...BOOL_FLAGS, '--print', '--resume', '--autoplay-exit', '-h', '--help', '--']);

export function routesToQuoxon(argv, isTTY) {
  let print = false;
  let help = false;
  const dd = argv.indexOf('--');
  const head = dd === -1 ? argv : argv.slice(0, dd);
  const hasPrint = head.some(a => a === '--print' || a.startsWith('--print='));
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { return print; } // everything after -- is the prompt
    if (a === '--print') { print = true; const n = argv[i + 1]; if (n !== undefined && !ALL_FLAGS.has(n) && !/^--(profile|verbose|output|conversation|turn-id|timeout|print|provider|model|agent|prompt-profile)=/.test(n)) i++; }
    else if (a.startsWith('--print=')) print = true;
    else if (a === '-h' || a === '--help') help = true;
    else if (a === '--verbose') { if (LEVELS.has(argv[i + 1])) i++; }
    else if (a === '--resume') { const n = argv[i + 1]; if (n !== undefined && !n.startsWith('-')) i++; } // optional id or name
    else if (a === '--autoplay-exit') { if (/^\d+(\.\d+)?$/.test(argv[i + 1] || '')) i++; } // optional seconds
    else if (a.startsWith('--resume=')) { /* inline value */ }
    else if (VALUE_FLAGS.has(a)) i++;
    else if (/^--(profile|verbose|name)=/.test(a)) { /* inline value */ }
    else if (BOOL_FLAGS.has(a)) { /* no value */ }
    else if (PRINT_VALUE_FLAGS.has(a)) i++;
    else if (/^--(output|conversation|turn-id|timeout|provider|model|agent|prompt-profile)=/.test(a)) { /* inline value */ }
    else if (hasPrint && !a.startsWith('-')) { print = true; } // the prompt, wherever it sits among the flags
    else return false; // subcommand, positional, --help, --version, unknown flag
  }
  if (print) return true;
  if (help) return false; // plain `quox --help` is commander's
  return Boolean(isTTY); // interactive client needs a terminal; scripts keep the banner
}
