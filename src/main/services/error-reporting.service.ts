import { homedir, hostname } from 'os';

import { app, net } from 'electron';

import { API_BASE_URL } from '../lib/api-urls';
import { telemetryDisabledByEnv } from '../lib/telemetry-env';

const ERROR_URL = `${API_BASE_URL}/api/v1/errors`;

// Client-side rate limiting: max 10 errors per minute
const MAX_ERRORS_PER_MINUTE = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

type ErrorType = 'uncaughtException' | 'unhandledRejection' | 'errorBoundary' | 'processGone';

interface ErrorReport {
  message: string;
  stack?: string;
  type: ErrorType;
  context?: Record<string, unknown>;
  systemInfo: {
    appVersion: string;
    platform: string;
    arch: string;
    electronVersion: string;
    isLicensed: boolean;
    agentPresetName: string;
  };
}

// Transient network errors that are not actionable — skip reporting
const TRANSIENT_ERROR_PATTERNS = [
  'net::ERR_CONNECTION_RESET',
  'net::ERR_CONNECTION_REFUSED',
  'net::ERR_CONNECTION_TIMED_OUT',
  'net::ERR_CONNECTION_CLOSED',
  'net::ERR_NETWORK_CHANGED',
  'net::ERR_INTERNET_DISCONNECTED',
  'net::ERR_NAME_NOT_RESOLVED',
  'net::ERR_TIMED_OUT',
];

// Patterns for personal data that can leak into error messages, stacks, and
// component stacks. Order matters: URL credentials before emails, since
// `user:token@host` would otherwise half-match as an email.
const SCRUB_RULES: Array<[RegExp, string]> = [
  [/(\w+:\/\/)[^/\s:@]+(:[^/\s@]*)?@/g, '$1[REDACTED]@'],
  [/[\w.+-]+@[\w-]+(\.[\w-]+)*\.[A-Za-z]{2,}\b/g, '[EMAIL]'],
  [
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-[\w-]{20,}|xox[abposr]-[\w-]{10,})/g,
    '[TOKEN]',
  ],
  [/\/Users\/[^/\s]+/g, '/Users/[REDACTED]'],
  [/\/home\/[^/\s]+/g, '/home/[REDACTED]'],
  [/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s]+/gi, '$1[REDACTED]'],
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function scrubErrorText(text: string): string {
  let scrubbed = text;
  // Custom home locations (e.g. /var/home/<user>, D:\<user>) aren't covered
  // by the generic rules, so strip this machine's actual home dir and hostname.
  const home = homedir();
  if (home.length > 3) scrubbed = scrubbed.split(home).join('~');
  // Also match the short name: macOS reports `Johns-MacBook.local` but tools
  // often print `Johns-MacBook`. Skip generic names that aren't identifying.
  const host = hostname();
  const shortHost = host.split('.')[0];
  for (const name of new Set([host, shortHost])) {
    if (name.length >= 3 && name.toLowerCase() !== 'localhost') {
      scrubbed = scrubbed.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, 'gi'), '[HOST]');
    }
  }
  for (const [pattern, replacement] of SCRUB_RULES) {
    scrubbed = scrubbed.replace(pattern, replacement);
  }
  return scrubbed;
}

class ErrorReportingService {
  private errorTimestamps: number[] = [];
  private reportedErrors = new Set<string>();

  async report(error: Error, type: ErrorType, context?: Record<string, unknown>): Promise<void> {
    // Skip transient network errors — not actionable
    if (this.isTransientNetworkError(error)) return;

    // Lazy import to avoid circular dependencies
    const { configService } = await import('./config.service');

    // Check opt-out
    const config = configService.get();
    if (config.errorReportingEnabled === false || telemetryDisabledByEnv()) return;

    // Only report in production
    if (!app.isPackaged) return;

    // Client-side rate limiting
    if (!this.checkRateLimit()) return;

    // Dedupe: don't report same error twice in session
    const errorKey = this.hashError(error);
    if (this.reportedErrors.has(errorKey)) return;
    this.reportedErrors.add(errorKey);

    const { licenseService } = await import('./license.service');
    const { agentPresetService } = await import('./agent-preset.service');
    const { telemetryAgentName } = await import('./telemetry-dimensions');

    const report: ErrorReport = {
      message: this.scrubMessage(error.message),
      stack: this.scrubStack(error.stack),
      type,
      context: context ? this.scrubContext(context) : undefined,
      systemInfo: {
        appVersion: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        electronVersion: process.versions.electron,
        isLicensed: licenseService.getStatus().isLicensed,
        agentPresetName: telemetryAgentName(agentPresetService.getActive()),
      },
    };

    // Fire and forget - errors in error reporting should never crash the app
    this.send(report).catch(() => {});
  }

  private isTransientNetworkError(error: Error): boolean {
    return TRANSIENT_ERROR_PATTERNS.some((pattern) => error.message.includes(pattern));
  }

  private checkRateLimit(): boolean {
    const now = Date.now();
    this.errorTimestamps = this.errorTimestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (this.errorTimestamps.length >= MAX_ERRORS_PER_MINUTE) return false;
    this.errorTimestamps.push(now);
    return true;
  }

  private hashError(error: Error): string {
    return `${error.message}:${error.stack?.slice(0, 200) || ''}`;
  }

  private scrubMessage(message: string): string {
    return scrubErrorText(message);
  }

  private scrubStack(stack?: string): string | undefined {
    if (!stack) return undefined;
    return scrubErrorText(stack).split('\n').slice(0, 10).join('\n');
  }

  private scrubContext(context: Record<string, unknown>): Record<string, unknown> {
    const safeKeys = ['type', 'origin', 'componentStack', 'processType', 'reason', 'exitCode'];
    const scrubbed: Record<string, unknown> = {};
    for (const key of safeKeys) {
      if (key in context) {
        const value = context[key];
        scrubbed[key] = typeof value === 'string' ? scrubErrorText(value) : value;
      }
    }
    return scrubbed;
  }

  private send(report: ErrorReport): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const request = net.request({
          method: 'POST',
          url: ERROR_URL,
        });

        request.setHeader('Content-Type', 'application/json');

        request.on('response', (response) => {
          response.on('data', () => {});
          response.on('end', () => {
            if (response.statusCode === 200) {
              resolve();
            } else {
              reject();
            }
          });
        });

        request.on('error', reject);
        request.write(JSON.stringify(report));
        request.end();
      } catch {
        reject();
      }
    });
  }
}

export const errorReportingService = new ErrorReportingService();
