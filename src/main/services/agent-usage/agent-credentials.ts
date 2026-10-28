import { execFile } from 'child_process';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

import { z } from 'zod';

export interface ClaudeCredentials {
  accessToken: string;
  /** Epoch milliseconds; Claude Code renews the token on its next run after this. */
  expiresAt: number | null;
  plan: string | null;
}

export interface CodexCredentials {
  accessToken: string;
  accountId: string | null;
}

const claudeCredentialsSchema = z.object({
  claudeAiOauth: z.object({
    accessToken: z.string().min(1),
    expiresAt: z.number().nullish(),
    subscriptionType: z.string().nullish(),
  }),
});

const claudeAccountSchema = z.object({
  oauthAccount: z.object({ emailAddress: z.string().nullish() }).nullish(),
});

const codexAuthSchema = z.object({
  tokens: z.object({ access_token: z.string().min(1), account_id: z.string().nullish() }).nullish(),
});

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Claude Code keeps its sign-in in the login Keychain on macOS. */
function readMacKeychain(service: string): Promise<unknown> {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/security',
      ['find-generic-password', '-s', service, '-w'],
      { timeout: 5000 },
      (error, stdout) => {
        if (error) return resolve(null);
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch {
          resolve(null);
        }
      }
    );
  });
}

/** Claude Code's sign-in, or null when it isn't signed in with a Claude account. */
export async function readClaudeCredentials(): Promise<ClaudeCredentials | null> {
  const fromKeychain =
    process.platform === 'darwin' ? await readMacKeychain('Claude Code-credentials') : null;
  const parsed = claudeCredentialsSchema.safeParse(
    fromKeychain ?? (await readJson(join(claudeConfigDir(), '.credentials.json')))
  );
  if (!parsed.success) return null;
  const { accessToken, expiresAt, subscriptionType } = parsed.data.claudeAiOauth;
  return { accessToken, expiresAt: expiresAt ?? null, plan: subscriptionType ?? null };
}

/** The Claude account's email, from Claude Code's `.claude.json`. */
export async function readClaudeAccountEmail(): Promise<string | null> {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const path = configDir ? join(configDir, '.claude.json') : join(homedir(), '.claude.json');
  const parsed = claudeAccountSchema.safeParse(await readJson(path));
  return (parsed.success && parsed.data.oauthAccount?.emailAddress) || null;
}

/** Codex's ChatGPT sign-in, or null when it uses an API key or isn't signed in. */
export async function readCodexCredentials(): Promise<CodexCredentials | null> {
  const parsed = codexAuthSchema.safeParse(await readJson(join(codexHome(), 'auth.json')));
  const tokens = parsed.success ? parsed.data.tokens : null;
  if (!tokens) return null;
  return { accessToken: tokens.access_token, accountId: tokens.account_id ?? null };
}
