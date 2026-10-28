/**
 * A Docker container the landing videos use as Komla's SSH host, so agents,
 * worktrees and dev servers run remotely like on a real dev box.
 *
 * The sandbox and this directory are bind-mounted at their real paths, so the
 * scripted agent's command line and scenes file resolve the same on both sides.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { MANAGED_TMUX_SOCKET_NAME } from '../../src/shared/lib/ssh-tmux-attach';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMAGE = 'komla-video-ssh-host';
const CONTAINER = 'komla-video-ssh-host';
const REMOTE_HOME = '/home/komla';
export const SSH_HOST_ID = 'video-ssh-host';

export interface VideoSshHost {
  id: string;
  name: string;
  hostname: string;
  user: string;
  port: number;
  identityFile: string;
  basePath: string;
  extraSshArgs: string[];
}

function docker(args: string[], timeout = 60_000): string {
  return execFileSync('docker', args, { encoding: 'utf8', timeout, stdio: 'pipe' });
}

/** Removes a host left behind by an earlier run; its mounts would go stale. */
export function stopSshHost(): void {
  try {
    docker(['rm', '--force', CONTAINER]);
  } catch {
    // Not running.
  }
}

export function startSshHost(options: {
  sandboxDir: string;
  hostname: string;
  name: string;
}): VideoSshHost {
  stopSshHost();
  docker(['build', '--tag', IMAGE, path.join(__dirname, 'ssh-host')], 10 * 60_000);

  const keyDir = path.join(options.sandboxDir, 'ssh');
  fs.mkdirSync(keyDir, { recursive: true });
  const identityFile = path.join(keyDir, 'id_ed25519');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', identityFile]);

  const mounts = [fs.realpathSync(options.sandboxDir), fs.realpathSync(__dirname)];
  docker([
    'run',
    '--detach',
    '--rm',
    '--init',
    '--name',
    CONTAINER,
    '--hostname',
    options.hostname,
    '--publish',
    '127.0.0.1::22',
    ...mounts.flatMap((dir) => ['--volume', `${dir}:${dir}`]),
    IMAGE,
  ]);
  docker(['cp', `${identityFile}.pub`, `${CONTAINER}:/tmp/authorized-key`]);
  docker([
    'exec',
    CONTAINER,
    'install',
    '-m',
    '0600',
    '-o',
    'komla',
    '-g',
    'komla',
    '/tmp/authorized-key',
    `${REMOTE_HOME}/.ssh/authorized_keys`,
  ]);

  const port = Number(docker(['port', CONTAINER, '22/tcp']).trim().split(':').at(-1));
  const host: VideoSshHost = {
    id: SSH_HOST_ID,
    name: options.name,
    hostname: '127.0.0.1',
    user: 'komla',
    port,
    identityFile,
    basePath: '~/.komla',
    extraSshArgs: [
      '-o',
      'BatchMode=yes',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'UserKnownHostsFile=/dev/null',
      '-o',
      'LogLevel=ERROR',
    ],
  };
  waitForSsh(host);
  return host;
}

function waitForSsh(host: VideoSshHost): void {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      execFileSync('ssh', [
        ...['-p', String(host.port), '-i', host.identityFile, ...host.extraSshArgs],
        `${host.user}@${host.hostname}`,
        'true',
      ]);
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      execFileSync('sleep', ['0.3']);
    }
  }
}

/** Quotes a value as one word for the host's `sh`. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Runs a shell command on the host as the SSH user. */
export function hostExec(command: string): string {
  return docker([
    'exec',
    '--user',
    'komla',
    '--workdir',
    REMOTE_HOME,
    CONTAINER,
    'sh',
    '-c',
    command,
  ]);
}

/**
 * Has tmux repaint every client attached to Komla's terminals from its own copy
 * of their screens.
 */
export function repaintSshTerminals(): void {
  const tmux = `tmux -L ${MANAGED_TMUX_SOCKET_NAME}`;
  hostExec(
    `${tmux} list-clients -F '#{client_name}' | while read -r client; do ${tmux} refresh-client -t "$client"; done`
  );
}

/**
 * Publishes a locally seeded repo as a bare origin on the host and points the
 * local checkout at it, so Komla's SSH workspaces clone it on the host.
 */
export function publishOrigin(localRepo: string, projectName: string): void {
  const origin = `${REMOTE_HOME}/origin/${projectName}.git`;
  hostExec(
    `mkdir -p origin && git clone --quiet --bare ${shellQuote(fs.realpathSync(localRepo))} ${shellQuote(origin)}`
  );
  execFileSync('git', ['remote', 'add', 'origin', `file://${origin}`], { cwd: localRepo });
}
