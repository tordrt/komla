import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { SshHost } from '../../../src/shared/types/ssh';

const execFileAsync = promisify(execFile);
const FIXTURE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const IMAGE_NAME = 'komla-ssh-integration:debian-13';
const REMOTE_HOME = '/home/komla';
const SSH_WORKSPACE_BASE_NAME = '.komla-ssh-integration';
const SSH_WORKSPACE_FIXTURE_NAME = '.komla-ssh-integration-fixture';
const testRoot = mkdtempSync(join(tmpdir(), 'komla-ssh-integration-'));

// Main-process services resolve this during module import. The test imports
// them only after setupTestContainer(), so every run gets isolated local data.
process.env.KOMLA_DATA_DIR = join(testRoot, 'data');
mkdirSync(process.env.KOMLA_DATA_DIR, { recursive: true });

export interface ContainerExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SshWorkspaceTestTarget {
  host: SshHost;
  remoteHome: string;
  resolvedBasePath: string;
  originUrl: string;
}

export interface TestContainerHandle {
  name: string;
  target: SshWorkspaceTestTarget;
  exec(
    command: string[],
    options?: { timeoutMs?: number; allowFailure?: boolean }
  ): Promise<ContainerExecResult>;
}

export async function setupTestContainer(): Promise<TestContainerHandle> {
  const name = `komla-ssh-${process.pid}-${randomBytes(4).toString('hex')}`;
  const keyPath = join(testRoot, 'id_ed25519');

  try {
    await requireDocker();
    const buildArgs = ['build'];
    // Docker Desktop supplies container DNS through its VM. On native Linux,
    // use the host network while apt builds the cached fixture image so the
    // build remains usable on hosts with restrictive bridge-forwarding rules.
    if (process.platform === 'linux') buildArgs.push('--network', 'host');
    buildArgs.push('--tag', IMAGE_NAME, FIXTURE_DIRECTORY);
    await runDocker(buildArgs, 10 * 60_000);
    await runHost('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath], 30_000);
    await runDocker(
      [
        'run',
        '--detach',
        '--rm',
        '--init',
        '--name',
        name,
        '--publish',
        '127.0.0.1::22',
        IMAGE_NAME,
      ],
      60_000
    );
    await runDocker(['cp', `${keyPath}.pub`, `${name}:/tmp/komla-authorized-key`], 30_000);
    await runDocker(
      [
        'exec',
        name,
        'sh',
        '-lc',
        'install -m 0600 -o komla -g komla /tmp/komla-authorized-key /home/komla/.ssh/authorized_keys',
      ],
      30_000
    );

    const portOutput = await runDocker(['port', name, '22/tcp'], 30_000);
    const port = parsePublishedPort(portOutput.stdout);
    const host: SshHost = {
      id: 'ssh-integration-container',
      name: 'Docker SSH integration test',
      hostname: '127.0.0.1',
      user: 'komla',
      port,
      identityFile: keyPath,
      basePath: `~/${SSH_WORKSPACE_BASE_NAME}`,
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

    await waitForSsh(host);
    const handle: TestContainerHandle = {
      name,
      target: {
        host,
        remoteHome: REMOTE_HOME,
        resolvedBasePath: `${REMOTE_HOME}/${SSH_WORKSPACE_BASE_NAME}`,
        originUrl: `file://${REMOTE_HOME}/${SSH_WORKSPACE_FIXTURE_NAME}/origin.git`,
      },
      exec: (command, options) => containerExec(name, command, options),
    };
    await seedRemoteRepository(handle);
    return handle;
  } catch (error) {
    await runDocker(['rm', '--force', name], 30_000, true);
    rmSync(testRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function teardownTestContainer(handle: TestContainerHandle): Promise<void> {
  await runDocker(['rm', '--force', handle.name], 30_000, true);
  rmSync(testRoot, { recursive: true, force: true });
}

async function seedRemoteRepository(handle: TestContainerHandle): Promise<void> {
  await handle.exec([
    'sh',
    '-lc',
    [
      'set -eu',
      `base="$HOME/${SSH_WORKSPACE_BASE_NAME}"`,
      `fixture="$HOME/${SSH_WORKSPACE_FIXTURE_NAME}"`,
      'rm -rf -- "$base" "$fixture"',
      'mkdir -p "$fixture/seed"',
      'git init -q -b main "$fixture/seed"',
      'printf "ssh workspace integration fixture\n" > "$fixture/seed/README.md"',
      'git -C "$fixture/seed" add README.md',
      'git -C "$fixture/seed" commit -q -m "Initial fixture commit"',
      'git init -q --bare "$fixture/origin.git"',
      'git -C "$fixture/seed" remote add origin "$fixture/origin.git"',
      'git -C "$fixture/seed" push -q origin main',
      'git --git-dir="$fixture/origin.git" symbolic-ref HEAD refs/heads/main',
      'rm -rf -- "$fixture/seed"',
    ].join('\n'),
  ]);
}

async function containerExec(
  name: string,
  command: string[],
  options: { timeoutMs?: number; allowFailure?: boolean } = {}
): Promise<ContainerExecResult> {
  return runDocker(
    [
      'exec',
      '--user',
      'komla',
      '--env',
      `HOME=${REMOTE_HOME}`,
      '--workdir',
      REMOTE_HOME,
      name,
      ...command,
    ],
    options.timeoutMs ?? 60_000,
    options.allowFailure
  );
}

async function waitForSsh(host: SshHost): Promise<void> {
  const deadline = Date.now() + 30_000;
  const args = sshArgs(host, ['true']);
  while (Date.now() < deadline) {
    const result = await runHost('ssh', args, 5_000, true);
    if (result.exitCode === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for the Docker SSH server');
}

function sshArgs(host: SshHost, remoteCommand: string[]): string[] {
  return [
    '-p',
    String(host.port),
    '-i',
    String(host.identityFile),
    ...(host.extraSshArgs ?? []),
    `${host.user}@${host.hostname}`,
    ...remoteCommand,
  ];
}

function parsePublishedPort(output: string): number {
  const match = output.trim().match(/:(\d+)$/);
  const port = match ? Number(match[1]) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Could not parse Docker's published SSH port: ${output.trim()}`);
  }
  return port;
}

async function requireDocker(): Promise<void> {
  const result = await runHost('docker', ['info'], 30_000, true);
  if (result.exitCode !== 0) {
    throw new Error(`Docker is required for SSH workspace integration tests.\n${result.stderr}`);
  }
}

function runDocker(
  args: string[],
  timeoutMs: number,
  allowFailure = false
): Promise<ContainerExecResult> {
  return runHost('docker', args, timeoutMs, allowFailure);
}

async function runHost(
  command: string,
  args: string[],
  timeoutMs: number,
  allowFailure = false
): Promise<ContainerExecResult> {
  try {
    const result = await execFileAsync(command, args, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string };
    const result = {
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message,
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
    };
    if (allowFailure) return result;
    throw new Error(
      `${command} ${args.join(' ')} failed with exit code ${result.exitCode}\n${result.stderr}`
    );
  }
}
