/**
 * Terminal Error Detector
 *
 * Lightweight utility that scans terminal output for common error patterns.
 * Used by RunnableCodeBlock for post-exec feedback.
 * Full "auto-detect and explain" is Phase 4.
 */

import { formatExitCode } from './exitCodes'

const ERROR_PATTERNS = [
  {
    pattern: /command not found/i,
    type: 'command_not_found',
    suggestion: 'Check if the command is installed or the PATH is correct.'
  },
  {
    pattern: /Permission denied/i,
    type: 'permission_denied',
    suggestion: 'You may need elevated privileges (sudo) or check file permissions.'
  },
  {
    pattern: /No such file or directory/i,
    type: 'file_not_found',
    suggestion: 'Verify the file path exists and is spelled correctly.'
  },
  {
    pattern: /Connection refused/i,
    type: 'connection_refused',
    suggestion: 'The target service may not be running or the port is wrong.'
  },
  {
    pattern: /Connection timed out/i,
    type: 'connection_timeout',
    suggestion: 'Check network connectivity and firewall rules.'
  },
  {
    pattern: /Segmentation fault/i,
    type: 'segfault',
    suggestion: 'The program crashed due to a memory error.'
  },
  {
    pattern: /Out of memory|OOM|oom-kill|Killed$/m,
    type: 'oom',
    suggestion: 'The system ran out of memory. Check available RAM.'
  },
  {
    pattern: /Traceback \(most recent call last\)/,
    type: 'python_traceback',
    suggestion: 'Python exception. Check the error message at the bottom of the traceback.'
  },
  {
    pattern: /Error: Cannot find module/,
    type: 'node_module_not_found',
    suggestion: 'Missing Node.js module. Run npm install.'
  },
  {
    pattern: /SyntaxError:|TypeError:|ReferenceError:|RangeError:/,
    type: 'js_error',
    suggestion: 'JavaScript runtime error. Check the error type and message.'
  },
  {
    pattern: /EACCES|EPERM/,
    type: 'node_permission',
    suggestion: 'Node.js permission error. Check file/port permissions.'
  },
  {
    pattern: /ECONNREFUSED/,
    type: 'node_connection_refused',
    suggestion: 'Connection refused. Verify the target service is running.'
  },
  {
    pattern: /ENOSPC/,
    type: 'disk_full',
    suggestion: 'No space left on device. Free up disk space.'
  },
  {
    pattern: /(?:exit(?:ed with)? code |returned )([1-9]\d*)/i,
    type: 'nonzero_exit',
    suggestion: null, // dynamic — resolved at detection time
    dynamic: (match) => formatExitCode(parseInt(match[1], 10))
  },
  {
    pattern: /fatal:/i,
    type: 'fatal_error',
    suggestion: 'A fatal error occurred. Check the full error message.'
  },
  {
    pattern: /E: Unable to locate package/,
    type: 'package_not_found',
    suggestion: 'Package not found. Try running apt update first.'
  },
  {
    pattern: /docker: Error response from daemon/,
    type: 'docker_error',
    suggestion: 'Docker daemon error. Check the error message for details.'
  }
];

/**
 * Detect errors in terminal output.
 *
 * @param {string} output - Terminal output text (already ANSI-stripped)
 * @returns {{ hasError: boolean, errorType: string, errorLine: string, suggestion: string } | null}
 */
export function detectTerminalError(output) {
  if (!output) return null;

  const lines = output.split('\n');

  for (const entry of ERROR_PATTERNS) {
    for (const line of lines) {
      const match = line.match(entry.pattern);
      if (match) {
        const msg = entry.dynamic ? entry.dynamic(match) : entry.suggestion;
        return {
          hasError: true,
          errorType: entry.type,
          errorLine: line.trim(),
          suggestion: msg
        };
      }
    }
  }

  return null;
}

/**
 * Get all errors found in terminal output (not just the first).
 *
 * @param {string} output - Terminal output text
 * @returns {Array<{ errorType: string, errorLine: string, suggestion: string }>}
 */
export function detectAllErrors(output) {
  if (!output) return [];

  const lines = output.split('\n');
  const errors = [];
  const seenTypes = new Set();

  for (const entry of ERROR_PATTERNS) {
    if (seenTypes.has(entry.type)) continue;
    for (const line of lines) {
      const match = line.match(entry.pattern);
      if (match) {
        const msg = entry.dynamic ? entry.dynamic(match) : entry.suggestion;
        errors.push({ errorType: entry.type, errorLine: line.trim(), suggestion: msg });
        seenTypes.add(entry.type);
        break;
      }
    }
  }

  return errors;
}

/**
 * Compose a chat query from a detected error.
 * Used by ErrorNotificationBar → TerminalView → ChatEngine flow.
 *
 * @param {'explain' | 'fix'} action - What the user wants
 * @param {{ errorLine: string, errorType: string, suggestion?: string }} error - Detected error
 * @returns {string} Composed chat query
 */
export function composeErrorQuery(action, error) {
  if (action === 'explain') {
    return `Explain this terminal error:\n\`\`\`\n${error.errorLine}\n\`\`\`\nError type: ${error.errorType}`;
  }
  if (action === 'fix') {
    return `How do I fix this terminal error?\n\`\`\`\n${error.errorLine}\n\`\`\`\nError type: ${error.errorType}${error.suggestion ? `\nSuggested: ${error.suggestion}` : ''}`;
  }
  return error.errorLine;
}
