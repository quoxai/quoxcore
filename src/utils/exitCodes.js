/**
 * Human-readable exit code descriptions.
 * Covers POSIX signals (128+N), common app codes, and QuoxCLI custom codes.
 */

const SIGNAL_NAMES = {
  1: 'SIGHUP',
  2: 'SIGINT',
  3: 'SIGQUIT',
  6: 'SIGABRT',
  9: 'SIGKILL',
  11: 'SIGSEGV',
  13: 'SIGPIPE',
  14: 'SIGALRM',
  15: 'SIGTERM',
}

const KNOWN_CODES = {
  0: { label: 'Success', detail: null },
  1: { label: 'General error', detail: null },
  2: { label: 'Invalid usage', detail: 'Bad arguments or syntax' },
  3: { label: 'Auth required', detail: 'Authentication needed' },
  4: { label: 'Permission denied', detail: 'Insufficient privileges' },
  5: { label: 'Not found', detail: 'Target host or resource not found' },
  6: { label: 'Conflict', detail: 'Resource conflict or lock contention' },
  7: { label: 'Connection failed', detail: 'Network or SSH connection error' },
  8: { label: 'Server error', detail: 'Remote server returned an error' },
  126: { label: 'Not executable', detail: 'Permission denied or not a valid command' },
  127: { label: 'Command not found', detail: 'Binary or script does not exist on target' },
  // -1 is used internally for JS exceptions
  '-1': { label: 'Client error', detail: 'Request failed before reaching the host' },
}

/**
 * Get a human-readable description for an exit code.
 * @param {number} code
 * @returns {{ label: string, detail: string|null }}
 */
export function describeExitCode(code) {
  if (code == null) return { label: 'Unknown', detail: null }

  // Check known codes first
  const known = KNOWN_CODES[code]
  if (known) return known

  // Signal-killed processes: 128 + signal number
  if (code > 128 && code <= 165) {
    const sig = code - 128
    const name = SIGNAL_NAMES[sig]
    if (sig === 2) return { label: 'Interrupted', detail: 'Process was interrupted (Ctrl+C)' }
    if (sig === 9) return { label: 'Killed', detail: 'Process was forcefully killed (out of memory or manual kill)' }
    if (sig === 11) return { label: 'Crashed', detail: 'Segmentation fault — process accessed invalid memory' }
    if (sig === 13) return { label: 'Broken pipe', detail: 'Output stream closed unexpectedly' }
    if (sig === 15) return { label: 'Stopped', detail: 'Process was asked to terminate gracefully' }
    if (name) return { label: `Signal ${name}`, detail: `Process received ${name} (signal ${sig})` }
    return { label: `Signal ${sig}`, detail: `Process was killed by signal ${sig}` }
  }

  // Generic non-zero
  return { label: `Failed (${code})`, detail: null }
}

/**
 * Format exit code for display: "label" or "label — detail"
 * @param {number} code
 * @returns {string}
 */
export function formatExitCode(code) {
  const { label, detail } = describeExitCode(code)
  return detail ? `${label} — ${detail}` : label
}
