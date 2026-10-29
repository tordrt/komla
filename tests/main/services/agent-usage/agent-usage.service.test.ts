import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockBrowserWindow, mockElectron } from '../../../mocks/electron';

vi.mock('electron', () => mockElectron());

const credentials = vi.hoisted(() => ({
  readClaudeCredentials: vi.fn(),
  readClaudeAccountEmail: vi.fn(),
  readCodexCredentials: vi.fn(),
}));
vi.mock('../../../../src/main/services/agent-usage/agent-credentials', () => credentials);

const logger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../../../../src/main/lib/logger', () => ({ createLogger: () => logger }));

import { BrowserWindow } from 'electron';

import { AgentUsageService } from '../../../../src/main/services/agent-usage/agent-usage.service';

const NOW = Date.parse('2026-10-23T12:00:00Z');

const CLAUDE_BODY = {
  limits: [
    { kind: 'session', percent: 3, resets_at: '2026-10-23T17:00:00Z' },
    { kind: 'weekly_all', percent: 47, resets_at: '2026-10-27T16:00:00Z' },
  ],
};

const CODEX_BODY = {
  email: 'codex@example.com',
  plan_type: 'plus',
  rate_limit: {
    primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: null },
    secondary_window: null,
  },
};

function respond(responses: Record<string, { status: number; body?: unknown } | Error>) {
  return vi.fn(async (url: string) => {
    const response = responses[new URL(url).hostname];
    if (response instanceof Error) throw response;
    return { status: response.status, body: response.body ?? null };
  });
}

describe('AgentUsageService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    credentials.readClaudeCredentials.mockResolvedValue({
      accessToken: 'claude-token',
      expiresAt: NOW + 3600_000,
      plan: 'max',
    });
    credentials.readClaudeAccountEmail.mockResolvedValue('claude@example.com');
    credentials.readCodexCredentials.mockResolvedValue({
      accessToken: 'codex-token',
      accountId: 'acct',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads each agent's usage with its own sign-in and tells the windows", async () => {
    const window = createMockBrowserWindow();
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([window] as never);
    const fetchJson = respond({
      'api.anthropic.com': { status: 200, body: CLAUDE_BODY },
      'chatgpt.com': { status: 200, body: CODEX_BODY },
    });
    const service = new AgentUsageService(fetchJson);

    const usage = await service.refresh({ sources: ['claude-code', 'codex'] });

    expect(fetchJson).toHaveBeenCalledWith('https://api.anthropic.com/api/oauth/usage', {
      Authorization: 'Bearer claude-token',
      'anthropic-beta': 'oauth-2025-04-20',
    });
    expect(fetchJson).toHaveBeenCalledWith('https://chatgpt.com/backend-api/wham/usage', {
      Authorization: 'Bearer codex-token',
      'ChatGPT-Account-Id': 'acct',
    });
    expect(usage['claude-code']).toMatchObject({
      plan: 'max',
      account: 'claude@example.com',
      readAt: NOW,
      problem: null,
      windows: [
        { short: '5h', usedPercent: 3 },
        { short: '7d', usedPercent: 47 },
      ],
    });
    expect(usage.codex).toMatchObject({ plan: 'plus', account: 'codex@example.com' });
    expect(window.webContents.send).toHaveBeenCalledWith('agent-usage:changed', usage);
  });

  it('reads only the agents asked for', async () => {
    const fetchJson = respond({ 'api.anthropic.com': { status: 200, body: CLAUDE_BODY } });

    const usage = await new AgentUsageService(fetchJson).refresh({ sources: ['claude-code'] });

    expect(Object.keys(usage)).toEqual(['claude-code']);
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(credentials.readCodexCredentials).not.toHaveBeenCalled();
  });

  it('says when an agent is not signed in, without asking its provider', async () => {
    credentials.readCodexCredentials.mockResolvedValue(null);
    const fetchJson = respond({});

    const usage = await new AgentUsageService(fetchJson).refresh({ sources: ['codex'] });

    expect(usage.codex).toEqual({
      source: 'codex',
      windows: [],
      plan: null,
      account: null,
      readAt: 0,
      problem: 'signed-out',
      retryAt: null,
    });
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it('reads each agent at most every 4 minutes, or every 10 seconds when forced', async () => {
    const fetchJson = respond({
      'api.anthropic.com': { status: 200, body: CLAUDE_BODY },
      'chatgpt.com': { status: 200, body: CODEX_BODY },
    });
    const service = new AgentUsageService(fetchJson);

    await Promise.all([
      service.refresh({ sources: ['claude-code'] }),
      service.refresh({ sources: ['claude-code'] }),
    ]);
    await service.refresh({ sources: ['claude-code'] });
    expect(fetchJson).toHaveBeenCalledTimes(1);
    // Another agent's read is due on its own.
    await service.refresh({ sources: ['claude-code', 'codex'] });
    expect(fetchJson).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(10_000);
    await service.refresh({ sources: ['claude-code'], force: true });
    expect(fetchJson).toHaveBeenCalledTimes(3);

    // Focusing the window asks again, and on its own would read far more often than the poll.
    vi.advanceTimersByTime(3 * 60_000);
    await service.refresh({ sources: ['claude-code'] });
    expect(fetchJson).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(60_000);
    await service.refresh({ sources: ['claude-code'] });
    expect(fetchJson).toHaveBeenCalledTimes(4);
  });

  it('keeps the last reading, marked, while the sign-in is expired or the provider fails', async () => {
    let claude: { status: number; body?: unknown } | Error = { status: 200, body: CLAUDE_BODY };
    const fetchJson = vi.fn(async (url: string) => {
      if (url.includes('chatgpt')) return { status: 200, body: CODEX_BODY };
      if (claude instanceof Error) throw claude;
      return { status: claude.status, body: claude.body ?? null };
    });
    const service = new AgentUsageService(fetchJson);
    const first = (await service.refresh({ sources: ['claude-code'] }))['claude-code']!;

    claude = { status: 401 };
    vi.advanceTimersByTime(4 * 60_000);
    expect((await service.refresh({ sources: ['claude-code'] }))['claude-code']).toEqual({
      ...first,
      problem: 'expired',
    });

    claude = new Error('offline');
    vi.advanceTimersByTime(4 * 60_000);
    expect((await service.refresh({ sources: ['claude-code'] }))['claude-code']).toEqual({
      ...first,
      problem: 'unavailable',
    });
    expect(logger.info).toHaveBeenCalledWith('Could not read usage', {
      source: 'claude-code',
      error: 'Error: offline',
    });

    claude = { status: 500 };
    vi.advanceTimersByTime(4 * 60_000);
    expect((await service.refresh({ sources: ['claude-code'] }))['claude-code']?.problem).toBe(
      'unavailable'
    );
    expect(logger.info).toHaveBeenCalledWith('Unexpected usage response', {
      source: 'claude-code',
      status: 500,
    });
  });

  it("doesn't send a token that has expired", async () => {
    credentials.readClaudeCredentials.mockResolvedValue({
      accessToken: 'old',
      expiresAt: NOW - 1,
      plan: 'pro',
    });
    credentials.readCodexCredentials.mockResolvedValue(null);
    const fetchJson = respond({});

    const usage = await new AgentUsageService(fetchJson).refresh({ sources: ['claude-code'] });

    expect(fetchJson).not.toHaveBeenCalled();
    expect(usage['claude-code']).toMatchObject({ windows: [], readAt: 0, problem: 'expired' });
  });

  it('says a provider limited the reads, and asks it again itself 15 minutes later', async () => {
    let codex = { status: 200, body: CODEX_BODY as unknown };
    const fetchJson = vi.fn(async () => codex);
    const service = new AgentUsageService(fetchJson);
    const first = (await service.refresh({ sources: ['codex'] })).codex!;

    codex = { status: 429, body: null };
    vi.advanceTimersByTime(4 * 60_000);
    expect((await service.refresh({ sources: ['codex'] })).codex).toEqual({
      ...first,
      problem: 'rate-limited',
      retryAt: NOW + 19 * 60_000,
    });
    expect(logger.info).toHaveBeenCalledWith('Usage reads rate limited', {
      source: 'codex',
      retryInMinutes: 15,
    });
    expect(fetchJson).toHaveBeenCalledTimes(2);

    // A sign-out still shows, and signing back in doesn't cut the wait short.
    credentials.readCodexCredentials.mockResolvedValueOnce(null);
    vi.advanceTimersByTime(14 * 60_000);
    expect((await service.refresh({ sources: ['codex'], force: true })).codex?.problem).toBe(
      'signed-out'
    );
    vi.advanceTimersByTime(55_000);
    expect((await service.refresh({ sources: ['codex'], force: true })).codex?.problem).toBe(
      'rate-limited'
    );
    expect(fetchJson).toHaveBeenCalledTimes(2);

    // Then it asks again on its own, though a read was asked for just before.
    codex = { status: 200, body: CODEX_BODY };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchJson).toHaveBeenCalledTimes(3);
    expect(service.get().codex).toEqual({ ...first, readAt: NOW + 19 * 60_000 });
  });
});
