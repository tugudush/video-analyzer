/**
 * Diagnostics channel.
 *
 * stdout is reserved for machine-readable CLI output and for the MCP stdio
 * transport, so every diagnostic is written to stderr or forwarded to an
 * optional sink (for example MCP logging notifications).
 */

export const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export type LogSink = (level: Exclude<LogLevel, 'silent'>, message: string) => void

const LEVEL_RANK: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
}

export interface Logger {
  level: LogLevel
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export function isLogLevel(value: string | undefined): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value)
}

function write(level: Exclude<LogLevel, 'silent'>, message: string, sink?: LogSink): void {
  if (sink) {
    try {
      sink(level, message)
      return
    } catch {
      // Fall through to stderr if the sink itself fails.
    }
  }
  process.stderr.write(`${level.toUpperCase()} ${message}\n`)
}

export function createLogger(level: LogLevel = 'warn', sink?: LogSink): Logger {
  const enabled = (candidate: Exclude<LogLevel, 'silent'>) =>
    LEVEL_RANK[level] >= LEVEL_RANK[candidate]

  return {
    level,
    debug(message) {
      if (enabled('debug')) write('debug', message, sink)
    },
    info(message) {
      if (enabled('info')) write('info', message, sink)
    },
    warn(message) {
      if (enabled('warn')) write('warn', message, sink)
    },
    error(message) {
      if (enabled('error')) write('error', message, sink)
    },
  }
}
