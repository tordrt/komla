import { BrowserWindow, net } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import { createLogger } from '../../lib/logger';

import {
  readClaudeAccountEmail,
  readClaudeCredentials,
  readCodexCredentials,
} from './agent-credentials';
import { parseClaudeUsage, parseCodexUsage, type ParsedUsage } from './usage-parsing';

import type {
  AgentUsage,
  AgentUsageProblem,
  AgentUsageReading,
  AgentUsageSource,
} from '../../../shared/types/agent-usage';

const logger = createLogger('AgentUsageService');

// Reads the bar asks for, on its timer or on focus, at most this often.
const MIN_READ_INTERVAL_MS = 60_000;
// The Refresh button may read sooner.
const MIN_FORCED_READ_INTERVAL_MS = 10_000;
// After a provider says too many requests, it isn't asked again for this long.
const RATE_LIMITED_BACKOFF_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface JsonResponse {
  status: number;
  body: unknown;
}

export type FetchJson = (url: string, headers: Record<string, string>) => Promise<JsonResponse>;

async function fetchJsonWithNet(
  url: string,
  headers: Record<string, string>
): Promise<JsonResponse> {
  // net.fetch, unlike Node's fetch, goes through the system's proxy settings.
  const response = await net.fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Komla', ...headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: response.status, body: response.ok ? await response.json() : null };
}

function withProblem(
  source: AgentUsageSource,
  previous: AgentUsageReading | undefined,
  problem: AgentUsageProblem
): AgentUsageReading {
  return previous
    ? { ...previous, problem }
    : { source, windows: [], plan: null, account: null, readAt: 0, problem };
}

function signedOut(source: AgentUsageSource): AgentUsageReading {
  return { source, windows: [], plan: null, account: null, readAt: 0, problem: 'signed-out' };
}

/**
 * The plan usage limits of the agents signed in on this computer, asked of each provider with
 * the agent's own sign-in, as the agents' `/usage` and `/status` do. Each agent is read only
 * while the bar shows it. Komla never renews a sign-in: the agent does that on its next run, and
 * until then the last reading stays, marked expired.
 */
export class AgentUsageService {
  private usage: AgentUsage = {};
  private lastReadAt: Partial<Record<AgentUsageSource, number>> = {};
  private reading: Partial<Record<AgentUsageSource, Promise<void>>> = {};
  private retryAt: Partial<Record<AgentUsageSource, number>> = {};
  private claudeEmail: { token: string; email: string | null } | null = null;

  constructor(private readonly fetchJson: FetchJson = fetchJsonWithNet) {}

  get(): AgentUsage {
    return this.usage;
  }

  /** Reads these agents' usage again, each unless that happened in the last minute. */
  async refresh(options: { sources: AgentUsageSource[]; force?: boolean }): Promise<AgentUsage> {
    await Promise.all(options.sources.map((source) => this.refreshSource(source, options.force)));
    return this.usage;
  }

  private refreshSource(source: AgentUsageSource, force = false): Promise<void> {
    const pending = this.reading[source];
    if (pending) return pending;
    const interval = force ? MIN_FORCED_READ_INTERVAL_MS : MIN_READ_INTERVAL_MS;
    if (Date.now() - (this.lastReadAt[source] ?? 0) < interval) return Promise.resolve();
    this.lastReadAt[source] = Date.now();
    const previous = this.usage[source];
    const read = (source === 'claude-code' ? this.readClaude(previous) : this.readCodex(previous))
      .then((reading) => this.record(reading))
      .finally(() => {
        delete this.reading[source];
      });
    this.reading[source] = read;
    return read;
  }

  private record(reading: AgentUsageReading): void {
    if (JSON.stringify(reading) === JSON.stringify(this.usage[reading.source])) return;
    this.usage = { ...this.usage, [reading.source]: reading };
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC.AGENT_USAGE_CHANGED, this.usage);
    }
  }

  private async readClaude(previous: AgentUsageReading | undefined): Promise<AgentUsageReading> {
    const credentials = await readClaudeCredentials();
    if (!credentials) return signedOut('claude-code');
    // An expired token only gets refused; Claude Code renews it on its next run.
    if (credentials.expiresAt !== null && credentials.expiresAt <= Date.now()) {
      return withProblem('claude-code', previous, 'expired');
    }
    const parsed = await this.request(
      'claude-code',
      previous,
      'https://api.anthropic.com/api/oauth/usage',
      {
        Authorization: `Bearer ${credentials.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      parseClaudeUsage
    );
    if ('problem' in parsed) return parsed;
    if (this.claudeEmail?.token !== credentials.accessToken) {
      this.claudeEmail = { token: credentials.accessToken, email: await readClaudeAccountEmail() };
    }
    return {
      source: 'claude-code',
      ...parsed,
      plan: credentials.plan,
      account: this.claudeEmail.email,
      readAt: Date.now(),
      problem: null,
    };
  }

  private async readCodex(previous: AgentUsageReading | undefined): Promise<AgentUsageReading> {
    const credentials = await readCodexCredentials();
    if (!credentials) return signedOut('codex');
    const parsed = await this.request(
      'codex',
      previous,
      'https://chatgpt.com/backend-api/wham/usage',
      {
        Authorization: `Bearer ${credentials.accessToken}`,
        ...(credentials.accountId ? { 'ChatGPT-Account-Id': credentials.accountId } : {}),
      },
      parseCodexUsage
    );
    if ('problem' in parsed) return parsed;
    return { source: 'codex', ...parsed, readAt: Date.now(), problem: null };
  }

  /** The parsed response, or the previous reading marked with why the request failed. */
  private async request(
    source: AgentUsageSource,
    previous: AgentUsageReading | undefined,
    url: string,
    headers: Record<string, string>,
    parse: (body: unknown) => ParsedUsage | null
  ): Promise<ParsedUsage | AgentUsageReading> {
    if ((this.retryAt[source] ?? 0) > Date.now())
      return withProblem(source, previous, 'unavailable');
    try {
      const response = await this.fetchJson(url, headers);
      if (response.status === 401 || response.status === 403) {
        return withProblem(source, previous, 'expired');
      }
      if (response.status === 429) this.retryAt[source] = Date.now() + RATE_LIMITED_BACKOFF_MS;
      const parsed = response.status === 200 ? parse(response.body) : null;
      if (parsed) return parsed;
      logger.debug('Unexpected usage response', { source, status: response.status });
    } catch (error) {
      logger.debug('Could not read usage', { source, error: String(error) });
    }
    return withProblem(source, previous, 'unavailable');
  }
}

export const agentUsageService = new AgentUsageService();
