import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No test reads the real macOS Keychain.
vi.mock('child_process', () => ({
  execFile: (_file: string, _args: string[], _options: unknown, callback: (e: Error) => void) =>
    callback(new Error('not in tests')),
}));

import {
  readClaudeAccountEmail,
  readClaudeCredentials,
  readCodexCredentials,
} from '../../../../src/main/services/agent-usage/agent-credentials';

describe('agent credentials', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-credentials-'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', dir);
    vi.stubEnv('CODEX_HOME', dir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads Claude Code's sign-in, plan and account", async () => {
    writeFileSync(
      join(dir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'tok', expiresAt: 123, subscriptionType: 'max' },
      })
    );
    writeFileSync(
      join(dir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'dev@example.com' } })
    );

    await expect(readClaudeCredentials()).resolves.toEqual({
      accessToken: 'tok',
      expiresAt: 123,
      plan: 'max',
    });
    await expect(readClaudeAccountEmail()).resolves.toBe('dev@example.com');
  });

  it("reads Codex's ChatGPT sign-in", async () => {
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'tok', account_id: 'acct' } })
    );

    await expect(readCodexCredentials()).resolves.toEqual({ accessToken: 'tok', accountId: 'acct' });
  });

  it('finds nothing without a sign-in, or with an API key', async () => {
    await expect(readClaudeCredentials()).resolves.toBeNull();
    await expect(readClaudeAccountEmail()).resolves.toBeNull();
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-x', tokens: null }));
    await expect(readCodexCredentials()).resolves.toBeNull();
  });
});
