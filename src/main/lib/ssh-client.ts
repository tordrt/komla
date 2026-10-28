import type { SshHost } from '../../shared/types';

export interface SshAskpassProvider {
  isRunning(): boolean;
  getHelperScriptPath(): string | null;
  getSocketPath(): string | null;
  issueSession(usesPathSsh?: () => Promise<boolean>): string;
}

export function sshTarget(host: SshHost): string {
  return host.user ? `${host.user}@${host.hostname}` : host.hostname;
}

/**
 * The env that sends ssh's prompts to Komla's askpass helper under `session`.
 */
export function sshAskpassVars(
  helperPath: string,
  socketPath: string,
  session: string
): NodeJS.ProcessEnv {
  return {
    SSH_ASKPASS: helperPath,
    SSH_ASKPASS_REQUIRE: 'force', // Required for macOS
    DISPLAY: ':', // Dummy value for compatibility
    KOMLA_ASKPASS_SOCKET: socketPath,
    KOMLA_ASKPASS_SESSION: session,
  };
}

/**
 * Route ssh passphrase prompts in a process spawned with `env` to Komla's dialog.
 * Returns false when the askpass service isn't ready. Pass `usesPathSsh` when the process
 * may run another ssh than the one on PATH.
 */
export function applySshAskpassEnv(
  env: NodeJS.ProcessEnv,
  askpass: SshAskpassProvider,
  usesPathSsh?: () => Promise<boolean>
): boolean {
  if (!askpass.isRunning()) return false;

  const helperPath = askpass.getHelperScriptPath();
  const socketPath = askpass.getSocketPath();
  if (!helperPath || !socketPath) return false;

  Object.assign(env, sshAskpassVars(helperPath, socketPath, askpass.issueSession(usesPathSsh)));
  return true;
}

export function buildSshEnv(askpass: SshAskpassProvider): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  applySshAskpassEnv(env, askpass);
  return env;
}

/** Whether ssh failed because it needed a password, passphrase or new host key. */
export function needsSshPrompt(error: unknown): boolean {
  return /Permission denied|Host key verification failed/.test(sshErrorText(error));
}

export function sshErrorText(error: unknown): string {
  if (error instanceof Error) {
    const stderr =
      typeof (error as Error & { stderr?: unknown }).stderr === 'string'
        ? (error as Error & { stderr: string }).stderr
        : '';
    return `${error.message}\n${stderr}`;
  }
  return String(error);
}
