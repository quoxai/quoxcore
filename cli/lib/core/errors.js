/**
 * Error types and handler for QuoxCLI
 */

import chalk from 'chalk';

export class QuoxError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'QuoxError';
    this.exitCode = exitCode;
  }
}

export class QuoxApiError extends QuoxError {
  /**
   * @param {number} status  HTTP status
   * @param {string} code    machine-readable error code from the body
   * @param {string} message human-readable message
   * @param {*} [detail]     the body's `detail`/`details` field, if any
   * @param {object} [body]  LL-3d: the WHOLE parsed JSON error body. Lifting
   *   only message/detail threw away everything else the server said, and the
   *   licensing endpoints say a lot: which instance holds the seat, how many
   *   of the licensed servers are in use, which plugin is unlicensed. Command
   *   handlers read this to render something actionable; --json emits it raw.
   */
  constructor(status, code, message, detail, body) {
    super(message, statusToExitCode(status));
    this.name = 'QuoxApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    if (body && typeof body === 'object') this.body = body;
  }
}

export class QuoxAuthError extends QuoxError {
  constructor(message = 'Not authenticated. Run `quox login` first.') {
    super(message, 3);
    this.name = 'QuoxAuthError';
  }
}

/**
 * A re-authentication that failed for a reason expected to clear by itself
 * (auth service restarting, 429 rate_limited on the resident token exchange,
 * 502/503/504, network fault). It IS a QuoxAuthError, so every verb that does
 * not know about it behaves exactly as before; only long-lived listeners
 * (`quox slot wait`) choose to back off and keep going. `retryAfterMs` carries
 * the server's Retry-After when it sent one.
 */
export class QuoxTransientAuthError extends QuoxAuthError {
  constructor(message, retryAfterMs = null) {
    super(message);
    this.name = 'QuoxTransientAuthError';
    this.transient = true;
    this.retryAfterMs = retryAfterMs;
  }
}

export class QuoxNetworkError extends QuoxError {
  constructor(message = 'Could not connect to QuoxCORE services.', cause) {
    super(message, 7);
    this.name = 'QuoxNetworkError';
    this.cause = cause;
  }
}

export class QuoxValidationError extends QuoxError {
  constructor(message) {
    super(message, 2);
    this.name = 'QuoxValidationError';
  }
}

function statusToExitCode(status) {
  if (status === 401) return 3;
  if (status === 403) return 4;
  if (status === 404) return 5;
  if (status === 409) return 6;
  if (status >= 500) return 8;
  return 1;
}

const STATUS_HINTS = {
  401: 'Run `quox login` to authenticate.',
  403: 'You may not have permission. Try `quox org switch` to change context.',
  404: 'Resource not found. Use the `list` subcommand to see what exists.',
  409: 'Resource conflict. The item may already exist.',
  429: 'Rate limited. Wait a moment and try again.',
  500: 'Server error. Use --debug for details.',
  502: 'Service temporarily unavailable. Check `quox service health`.',
  503: 'Service temporarily unavailable. Check `quox service health`.',
};

export function handleError(err, outputFormat = 'table') {
  if (outputFormat === 'json') {
    const obj = {
      error: true,
      code: err.code || err.name,
      message: err.message,
    };
    if (err.status) obj.status = err.status;
    if (err.detail) obj.detail = err.detail;
    // LL-3d: scripts parsing --json get the server's own body verbatim, not
    // our prose rendering of it.
    if (err.body && typeof err.body === 'object') obj.body = err.body;
    process.stderr.write(JSON.stringify(obj) + '\n');
    return;
  }

  if (err instanceof QuoxApiError) {
    console.error(chalk.red(`Error: ${err.message}`));
    if (err.detail) console.error(chalk.dim(`  Detail: ${err.detail}`));
    console.error(chalk.dim(`  Status: ${err.status} ${err.code || ''}`));
    const hint = STATUS_HINTS[err.status];
    if (hint) console.error(chalk.yellow(`  Hint: ${hint}`));
  } else if (err instanceof QuoxAuthError) {
    console.error(chalk.red(`Auth: ${err.message}`));
  } else if (err instanceof QuoxNetworkError) {
    console.error(chalk.red(`Network: ${err.message}`));
    console.error(chalk.yellow('  Hint: Check that services are running with `quox service health`.'));
  } else if (err instanceof QuoxValidationError) {
    console.error(chalk.red(`Validation: ${err.message}`));
  } else {
    console.error(chalk.red(`Error: ${err.message}`));
    if (process.env.DEBUG || process.argv.includes('--debug')) {
      const sanitized = (err.stack || '').replace(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[JWT_REDACTED]');
      console.error(chalk.dim(sanitized));
    }
  }
}
