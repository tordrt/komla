import { existsSync, mkdirSync, appendFileSync, statSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';

import { app } from 'electron';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LoggerOptions {
  /** Maximum log file size in bytes before rotation (default: 5 MB) */
  maxFileSize?: number;
  /** Number of rotated files to keep (default: 3) */
  maxFiles?: number;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// An unrecognized LOG_LEVEL would otherwise suppress every entry, errors included.
function minLevelFromEnv(): LogLevel {
  const level = process.env.LOG_LEVEL?.toLowerCase();
  return level !== undefined && Object.hasOwn(LOG_LEVELS, level) ? (level as LogLevel) : 'info';
}

// Determine if we're in development mode
function isDevelopment(): boolean {
  return !app.isPackaged || process.env.NODE_ENV === 'development';
}

declare const __KOMLA_ENV__: string;

// Get the logs directory path
function getLogsPath(): string {
  const isStaging = typeof __KOMLA_ENV__ !== 'undefined' && __KOMLA_ENV__ === 'staging';
  const basePath =
    process.env.KOMLA_DATA_DIR ||
    join(app.getPath('home'), isStaging ? '.komla-staging' : '.komla');
  return join(basePath, 'logs');
}

// Ensure logs directory exists
function ensureLogsDir(): string {
  const logsPath = getLogsPath();
  if (!existsSync(logsPath)) {
    mkdirSync(logsPath, { recursive: true });
  }
  return logsPath;
}

// Format timestamp for log entries
function formatTimestamp(): string {
  const now = new Date();
  return now.toISOString();
}

// Format a log message
function formatMessage(level: LogLevel, service: string, message: string, args: unknown[]): string {
  const timestamp = formatTimestamp();
  const levelStr = level.toUpperCase().padEnd(5);

  // Format additional arguments
  let argsStr = '';
  if (args.length > 0) {
    argsStr =
      ' ' +
      args
        .map((arg) => {
          if (arg instanceof Error) {
            return `${arg.message}${arg.stack ? '\n' + arg.stack : ''}`;
          }
          if (typeof arg === 'object') {
            try {
              return JSON.stringify(arg, (_key, value: unknown) => {
                if (value instanceof Error) {
                  return {
                    message: value.message,
                    stack: value.stack,
                    name: value.name,
                    ...Object.fromEntries(Object.entries(value)),
                  };
                }
                return value;
              });
            } catch {
              return '[Unserializable]';
            }
          }
          // oxlint-disable-next-line typescript/no-base-to-string -- objects returned above
          return String(arg);
        })
        .join(' ');
  }

  return `${timestamp} [${levelStr}] [${service}] ${message}${argsStr}`;
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

function tryRename(oldPath: string, newPath: string): void {
  try {
    renameSync(oldPath, newPath);
  } catch {
    // Ignore rename errors
  }
}

function tryUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Ignore deletion errors
  }
}

class FileLogger implements Logger {
  private service: string;
  private logFilePath: string;
  private maxFileSize: number;
  private maxFiles: number;
  private minLevel: LogLevel;

  constructor(service: string, options: LoggerOptions = {}) {
    this.service = service;
    this.maxFileSize = options.maxFileSize ?? 5 * 1024 * 1024; // 5MB
    this.maxFiles = options.maxFiles ?? 3;
    this.minLevel = minLevelFromEnv();

    const logsDir = ensureLogsDir();
    this.logFilePath = join(logsDir, 'komla.log');
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.minLevel];
  }

  private rotateIfNeeded(): void {
    try {
      if (!existsSync(this.logFilePath)) return;

      const stats = statSync(this.logFilePath);
      if (stats.size < this.maxFileSize) return;

      this.shiftRotatedFiles();
      tryRename(this.logFilePath, `${this.logFilePath}.1`);
    } catch {
      // Ignore rotation errors - don't let logging break the app
    }
  }

  // Rotate log files: komla.log.2 -> komla.log.3, komla.log.1 -> komla.log.2, etc.
  private shiftRotatedFiles(): void {
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const oldPath = i === 1 ? this.logFilePath : `${this.logFilePath}.${i}`;
      if (!existsSync(oldPath)) continue;

      if (i === this.maxFiles - 1) {
        tryUnlink(oldPath);
      } else {
        tryRename(oldPath, `${this.logFilePath}.${i + 1}`);
      }
    }
  }

  private write(level: LogLevel, message: string, args: unknown[]): void {
    if (!this.shouldLog(level)) return;

    const formattedMessage = formatMessage(level, this.service, message, args);

    // Always log to console in development, or for errors
    if (isDevelopment() || level === 'error') {
      const consoleMethod =
        level === 'error'
          ? console.error
          : level === 'warn'
            ? console.warn
            : level === 'debug'
              ? console.debug
              : console.log;
      consoleMethod(formattedMessage);
    }

    // Write to file in production
    if (!isDevelopment()) {
      try {
        this.rotateIfNeeded();
        appendFileSync(this.logFilePath, formattedMessage + '\n');
      } catch {
        // Don't let file writing errors crash the app
        // Fall back to console
        console.error(formattedMessage);
      }
    }
  }

  debug(message: string, ...args: unknown[]): void {
    this.write('debug', message, args);
  }

  info(message: string, ...args: unknown[]): void {
    this.write('info', message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.write('warn', message, args);
  }

  error(message: string, ...args: unknown[]): void {
    this.write('error', message, args);
  }
}

// Console-only logger for simple cases or when file logging fails
class ConsoleLogger implements Logger {
  private service: string;
  private minLevel: LogLevel;

  constructor(service: string) {
    this.service = service;
    this.minLevel = minLevelFromEnv();
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.minLevel];
  }

  private write(level: LogLevel, message: string, args: unknown[]): void {
    if (!this.shouldLog(level)) return;

    const formattedMessage = formatMessage(level, this.service, message, args);
    const consoleMethod =
      level === 'error'
        ? console.error
        : level === 'warn'
          ? console.warn
          : level === 'debug'
            ? console.debug
            : console.log;
    consoleMethod(formattedMessage);
  }

  debug(message: string, ...args: unknown[]): void {
    this.write('debug', message, args);
  }

  info(message: string, ...args: unknown[]): void {
    this.write('info', message, args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.write('warn', message, args);
  }

  error(message: string, ...args: unknown[]): void {
    this.write('error', message, args);
  }
}

/**
 * Create a logger instance for a service.
 *
 * In development: logs to console with timestamp and service prefix
 * In production: logs to ~/.komla/logs/komla.log with rotation
 *
 * @param serviceName - Name of the service (e.g., 'WorkspaceService', 'PtyService')
 * @param options - Optional configuration for file logging
 * @returns Logger instance
 *
 * @example
 * const logger = createLogger('WorkspaceService')
 * logger.info('Starting workspace', { id: workspace.id })
 * logger.error('Failed to create workspace', error)
 */
export function createLogger(serviceName: string, options?: LoggerOptions): Logger {
  // Use FileLogger in production, ConsoleLogger in development
  // FileLogger also outputs to console in dev mode, but this gives us
  // a clear separation and simpler dev experience
  if (isDevelopment()) {
    return new ConsoleLogger(serviceName);
  }
  return new FileLogger(serviceName, options);
}
