import { createHash } from 'crypto';
import { chmodSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { sshErrorText, sshTarget } from '../../lib/ssh-client';

import type { SshHost } from '../../../shared/types';
import type { SshTerminalPoolIndex } from '../../lib/terminal-control';

export const SSH_CONTROL_PERSIST_SECONDS = 60;
export const SSH_INTERACTIVE_CONTROL_PERSIST_SECONDS = 10 * 60;
export const SSH_SERVER_ALIVE_INTERVAL_SECONDS = 30;
export const SSH_SERVER_ALIVE_COUNT_MAX = 3;

const SSH_CONTROL_OPTIONS = new Set(['controlmaster', 'controlpath', 'controlpersist']);
// Darwin's sockaddr_un has 104 bytes including the trailing NUL. OpenSSH appends
// a dot and 16 random characters while atomically creating a control listener.
const SSH_CONTROL_PATH_MAX_BYTES = 103 - 17;
const SSH_CONTROL_HASH_LENGTH = 24;

let sshControlDirectory: string | undefined;

export type SshRunPurpose = { kind: 'background' } | { kind: 'interactive' };
export type SshConnectionPurpose =
  | SshRunPurpose
  | { kind: 'workspace-stream'; workspaceId: string }
  | { kind: 'terminal'; poolIndex: SshTerminalPoolIndex };

function hasSshOption(args: string[] | undefined, keyword: string): boolean {
  if (!args) return false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]?.trim() ?? '';
    const option =
      arg === '-o' ? (args[index + 1]?.trim() ?? '') : arg.slice(0, 2) === '-o' ? arg.slice(2) : '';
    const optionKeyword = option.replace(/^=/, '').split(/[=\s]/, 1)[0]?.toLowerCase();
    if (optionKeyword === keyword.toLowerCase()) return true;
  }
  return false;
}

function hasCustomSshControlOptions(args: string[] | undefined): boolean {
  if (
    args?.some((rawArg) => {
      const arg = rawArg.trim();
      return arg === '-S' || (arg.startsWith('-S') && arg.length > 2);
    })
  ) {
    return true;
  }
  return Array.from(SSH_CONTROL_OPTIONS).some((keyword) => hasSshOption(args, keyword));
}

function supportsSshMultiplexing(): boolean {
  return process.platform === 'darwin' || process.platform === 'linux';
}

function getSshControlTempRoot(): string {
  const preferredRoot = tmpdir();
  const longestControlPath = join(
    preferredRoot,
    'komla-ssh-XXXXXX',
    '0'.repeat(SSH_CONTROL_HASH_LENGTH)
  );
  return Buffer.byteLength(longestControlPath) <= SSH_CONTROL_PATH_MAX_BYTES
    ? preferredRoot
    : '/tmp';
}

function getSshControlDirectory(): string {
  if (sshControlDirectory) return sshControlDirectory;
  sshControlDirectory = mkdtempSync(join(getSshControlTempRoot(), 'komla-ssh-'));
  chmodSync(sshControlDirectory, 0o700);
  process.once('exit', () => {
    if (sshControlDirectory) rmSync(sshControlDirectory, { recursive: true, force: true });
  });
  return sshControlDirectory;
}

function purposePolicy(purpose: SshConnectionPurpose): {
  lane: 'background' | 'interactive' | 'terminal';
  poolIndex: number;
  scope?: string;
  persistSeconds: number;
} {
  switch (purpose.kind) {
    case 'interactive':
      return {
        lane: 'interactive',
        poolIndex: 0,
        persistSeconds: SSH_INTERACTIVE_CONTROL_PERSIST_SECONDS,
      };
    case 'workspace-stream':
      return {
        lane: 'background',
        poolIndex: 0,
        scope: purpose.workspaceId,
        persistSeconds: SSH_CONTROL_PERSIST_SECONDS,
      };
    case 'terminal':
      return {
        lane: 'terminal',
        poolIndex: purpose.poolIndex,
        persistSeconds: SSH_CONTROL_PERSIST_SECONDS,
      };
    case 'background':
      return {
        lane: 'background',
        poolIndex: 0,
        persistSeconds: SSH_CONTROL_PERSIST_SECONDS,
      };
  }
}

function hashedControlPath(host: SshHost, scope: Record<string, unknown>): string | undefined {
  if (!supportsSshMultiplexing() || hasCustomSshControlOptions(host.extraSshArgs)) return undefined;
  const connectionKey = JSON.stringify({
    id: host.id,
    hostname: host.hostname,
    user: host.user,
    port: host.port,
    identityFile: host.identityFile,
    forwardAgent: host.forwardAgent,
    extraSshArgs: host.extraSshArgs,
    ...scope,
  });
  const hash = createHash('sha256')
    .update(connectionKey)
    .digest('hex')
    .slice(0, SSH_CONTROL_HASH_LENGTH);
  return join(getSshControlDirectory(), hash);
}

export function sshControlPath(host: SshHost, purpose: SshConnectionPurpose): string | undefined {
  const policy = purposePolicy(purpose);
  return hashedControlPath(host, {
    lane: policy.lane,
    poolIndex: policy.poolIndex,
    scope: policy.scope,
  });
}

/**
 * The control socket of a tunnel process that is its own master, so its forwards change in place
 * with `ssh -O forward` and `-O cancel`. No connection lane shares it.
 */
export function sshTunnelControlPath(host: SshHost, tunnel: string): string | undefined {
  return hashedControlPath(host, { tunnel });
}

export function sshOptionArgs(host: SshHost, tty = false): string[] {
  const args: string[] = [];
  if (tty) args.push('-tt');
  if (host.port) args.push('-p', String(host.port));
  if (host.identityFile) args.push('-i', host.identityFile);
  if (host.forwardAgent) args.push('-A');
  if (!hasSshOption(host.extraSshArgs, 'ServerAliveInterval')) {
    args.push('-o', `ServerAliveInterval=${SSH_SERVER_ALIVE_INTERVAL_SECONDS}`);
  }
  if (!hasSshOption(host.extraSshArgs, 'ServerAliveCountMax')) {
    args.push('-o', `ServerAliveCountMax=${SSH_SERVER_ALIVE_COUNT_MAX}`);
  }
  if (host.extraSshArgs) args.push(...host.extraSshArgs);
  return args;
}

export function sshControlArgs(
  controlPath: string,
  createMaster: boolean,
  persistSeconds: number
): string[] {
  return [
    '-o',
    `ControlMaster=${createMaster ? 'auto' : 'no'}`,
    ...(createMaster ? ['-o', `ControlPersist=${persistSeconds}`] : []),
    '-o',
    `ControlPath=${controlPath}`,
  ];
}

export function sshArgs(
  host: SshHost,
  remoteCommand: string | undefined,
  purpose: SshConnectionPurpose,
  options: { tty?: boolean; multiplex?: boolean } = {}
): string[] {
  const args = sshOptionArgs(host, options.tty);
  if (!options.tty && options.multiplex !== false) {
    const controlPath = sshControlPath(host, purpose);
    if (controlPath) {
      args.push(...sshControlArgs(controlPath, true, purposePolicy(purpose).persistSeconds));
    }
  }
  args.push(sshTarget(host));
  if (remoteCommand) args.push(remoteCommand);
  return args;
}

export function isSshMultiplexedSessionFailure(error: unknown): boolean {
  const errorText = sshErrorText(error);
  return (
    errorText.includes('Session open refused by peer') ||
    errorText.includes('mux_client_request_session: send fds failed')
  );
}
