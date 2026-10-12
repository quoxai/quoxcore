/**
 * TRUST-GATE-P2 — minimal leveled logger.
 *
 * Zero-dependency, leveled (debug/info/warn/error) logging that replaces raw
 * `console.*` calls scattered through the engine. Existing lines already use
 * an ad-hoc `[Component]` tag convention (e.g. `[Pipeline]`, `[SkillDecayCron]`)
 * — this logger formalises that into a single-line, greppable format:
 *
 *   [level] [component] message {"json":"context"}
 *
 * No timestamp is prepended: the container runtime (Docker's json-file log
 * driver / journald / any aggregator reading stdout) already stamps every
 * line with a receive-time timestamp out of band. Prepending our own would
 * double-timestamp every line and the two clocks would drift apart under
 * scrutiny. This follows standard 12-factor practice — the app logs an
 * unadorned event stream to stdout/stderr, the runtime owns "when".
 *
 * Level filtering is controlled by LOG_LEVEL (debug|info|warn|error),
 * default 'info'. Unrecognised values fall back to 'info'.
 *
 * Levels map to console methods as follows:
 *   debug -> console.debug (falls back to console.log if unavailable)
 *   info  -> console.log
 *   warn  -> console.warn
 *   error -> console.error
 *
 * Usage:
 *   import { logger } from '../logger.js';
 *   const log = logger.for('Pipeline');
 *   log.info('Run started', { workflowId });
 *   log.warn(`Retrying node ${nodeId} — attempt ${attempt}/${maxAttempts}`);
 *   log.error('Executor threw', { nodeId, error: err.message });
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const VALID_LEVELS = new Set<LogLevel>(['debug', 'info', 'warn', 'error']);

/** Resolved fresh on every call so tests can flip LOG_LEVEL at runtime. */
function resolveMinLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return VALID_LEVELS.has(raw as LogLevel) ? (raw as LogLevel) : 'info';
}

function consoleFn(level: LogLevel): (...args: unknown[]) => void {
  switch (level) {
    case 'debug':
      // eslint-disable-next-line no-console
      return (console.debug ?? console.log).bind(console);
    case 'info':
      // eslint-disable-next-line no-console
      return console.log.bind(console);
    case 'warn':
      // eslint-disable-next-line no-console
      return console.warn.bind(console);
    case 'error':
      // eslint-disable-next-line no-console
      return console.error.bind(console);
  }
}

function safeStringify(context: Record<string, unknown>): string {
  try {
    return JSON.stringify(context);
  } catch {
    return '"[unserializable log context]"';
  }
}

function formatLine(
  level: LogLevel,
  component: string | undefined,
  message: string,
  context?: Record<string, unknown>,
): string {
  const tag = component ? ` [${component}]` : '';
  const hasContext = context && Object.keys(context).length > 0;
  const ctx = hasContext ? ` ${safeStringify(context as Record<string, unknown>)}` : '';
  return `[${level}]${tag} ${message}${ctx}`;
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  /** Returns a child logger tagged with the given component name. */
  for(component: string): Logger;
}

class LeveledLogger implements Logger {
  constructor(private readonly component?: string) {}

  private emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[resolveMinLevel()]) return;
    consoleFn(level)(formatLine(level, this.component, message, context));
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.emit('debug', message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.emit('info', message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.emit('warn', message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.emit('error', message, context);
  }

  for(component: string): Logger {
    return new LeveledLogger(component);
  }
}

/** Root logger — untagged. Prefer `logger.for('ComponentName')` at call sites. */
export const logger: Logger = new LeveledLogger();
