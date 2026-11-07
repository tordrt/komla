import { execFileSync } from 'child_process';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  remoteSecretFileCommand,
  writeLocalSecretFile,
  SECRET_FILE_NO_CONTENTS,
  writeSecretFile,
  type SecretFileWriteDependencies,
} from '../../../../src/main/services/workspace-setup/secret-file-write';
import { createWorktreeWorkspace } from '../../../factories';

import type { SetupStep, Workspace } from '../../../../src/shared/types';

const CONTENTS = 'API_KEY=sk-live-123\n';

const step: SetupStep = {
  id: 'step-1',
  name: 'Secret .env',
  command: '',
  placement: 'background',
  kind: 'secret-file',
  file: 'apps/web/.env',
};

/** `null` for a step without contents. */
function dependencies(contents: string | null = CONTENTS): SecretFileWriteDependencies & {
  [K in keyof SecretFileWriteDependencies]: ReturnType<typeof vi.fn>;
} {
  return {
    read: vi.fn(async () => contents ?? undefined),
    writeLocal: vi.fn(),
    gitIgnoresLocally: vi.fn(async () => true),
    runOnHost: vi.fn(async () => 'motd\nkomla-secret-file-ignored:no'),
  };
}

const localWorkspace = (): Workspace =>
  createWorktreeWorkspace({ id: 'ws', projectId: 'project-1', workingDirectory: '/work/tree' });

const sshWorkspace = (): Workspace =>
  createWorktreeWorkspace({
    id: 'ws',
    projectId: 'project-1',
    backend: {
      kind: 'ssh',
      hostId: 'host-1',
      remoteDirectory: '/remote/tree',
      remoteRepoPath: '/remote/repo.git',
      remoteProjectRoot: '/remote',
      gitUrl: 'git@example:repo.git',
    },
  } as Partial<Workspace>);

describe('writeSecretFile', () => {
  it('writes the contents in the workspace on this computer and says whether Git ignores them', async () => {
    const deps = dependencies();
    deps.gitIgnoresLocally.mockResolvedValue(false);

    const written = await writeSecretFile(deps, localWorkspace(), step, {
      cwd: '/work/tree',
      executionLocation: 'workspace',
    });

    expect(deps.read).toHaveBeenCalledWith('project-1', 'step-1');
    expect(deps.writeLocal).toHaveBeenCalledWith('/work/tree', 'apps/web/.env', CONTENTS);
    expect(deps.gitIgnoresLocally).toHaveBeenCalledWith('/work/tree', 'apps/web/.env');
    expect(written).toEqual({ gitIgnored: false });
    expect(deps.runOnHost).not.toHaveBeenCalled();
  });

  it('writes an SSH workspace’s file on its host through stdin, never in the command', async () => {
    const deps = dependencies();

    const written = await writeSecretFile(deps, sshWorkspace(), step, {
      cwd: '/remote/tree',
      executionLocation: 'workspace',
    });

    expect(deps.runOnHost).toHaveBeenCalledTimes(1);
    const [hostId, command, input] = deps.runOnHost.mock.calls[0] as [string, string, string];
    expect(hostId).toBe('host-1');
    expect(input).toBe(CONTENTS);
    expect(command).not.toContain('sk-live-123');
    expect(command).toContain("cd -- '/remote/tree'");
    expect(written).toEqual({ gitIgnored: false });
    expect(deps.writeLocal).not.toHaveBeenCalled();
  });

  it('writes an SSH workspace’s Local copy on this computer, without asking Git', async () => {
    const deps = dependencies();

    const written = await writeSecretFile(deps, sshWorkspace(), step, {
      cwd: '/local-copy',
      executionLocation: 'local-copy',
    });

    expect(deps.writeLocal).toHaveBeenCalledWith('/local-copy', 'apps/web/.env', CONTENTS);
    expect(deps.gitIgnoresLocally).not.toHaveBeenCalled();
    expect(deps.runOnHost).not.toHaveBeenCalled();
    expect(written).toEqual({});
  });

  it('fails without contents, writing nothing', async () => {
    const deps = dependencies(null);

    await expect(
      writeSecretFile(deps, localWorkspace(), step, {
        cwd: '/work/tree',
        executionLocation: 'workspace',
      })
    ).rejects.toThrow(SECRET_FILE_NO_CONTENTS);
    expect(deps.writeLocal).not.toHaveBeenCalled();
  });

  it('refuses a file outside where it runs before reading the contents', async () => {
    const deps = dependencies();

    await expect(
      writeSecretFile(
        deps,
        localWorkspace(),
        { ...step, file: '../../.bashrc' },
        { cwd: '/work/tree', executionLocation: 'workspace' }
      )
    ).rejects.toThrow(/inside the workspace/);
    expect(deps.read).not.toHaveBeenCalled();
    expect(deps.writeLocal).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform === 'win32')('remoteSecretFileCommand', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'komla-secret-file-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    writeFileSync(join(dir, '.gitignore'), '.env\n');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // stdin comes from a file, not a pipe: a command that refuses before reading it would otherwise
  // fail some runs with EPIPE instead of its own error.
  const run = (file: string, input = CONTENTS, cwd = dir) => {
    const inputDir = mkdtempSync(join(tmpdir(), 'komla-secret-input-'));
    const inputFile = join(inputDir, 'input');
    writeFileSync(inputFile, input);
    const stdin = openSync(inputFile, 'r');
    try {
      return execFileSync('sh', ['-c', remoteSecretFileCommand(cwd, file)], {
        stdio: [stdin, 'pipe', 'pipe'],
        encoding: 'utf-8',
      });
    } finally {
      closeSync(stdin);
      rmSync(inputDir, { recursive: true, force: true });
    }
  };

  it('writes stdin to the file, readable by the user alone, and says Git ignores it', () => {
    const output = run('.env');

    expect(readFileSync(join(dir, '.env'), 'utf-8')).toBe(CONTENTS);
    expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
    expect(output).toBe('komla-secret-file-ignored:yes');
  });

  it('makes the folders it needs, and says when Git doesn’t ignore the file', () => {
    const output = run('apps/web/.env.local');

    expect(readFileSync(join(dir, 'apps/web/.env.local'), 'utf-8')).toBe(CONTENTS);
    expect(output).toBe('komla-secret-file-ignored:no');
  });

  it('replaces a link rather than writing through it', () => {
    const outside = join(dir, 'outside.txt');
    writeFileSync(outside, 'keep me');
    symlinkSync(outside, join(dir, '.env'));

    run('.env');

    expect(lstatSync(join(dir, '.env')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dir, '.env'), 'utf-8')).toBe(CONTENTS);
    expect(readFileSync(outside, 'utf-8')).toBe('keep me');
  });

  it('leaves a folder at the path alone, failing', () => {
    mkdirSync(join(dir, '.env'));

    expect(() => run('.env')).toThrow();
    expect(statSync(join(dir, '.env')).isDirectory()).toBe(true);
  });

  it('refuses a folder on the way that links elsewhere', () => {
    const outside = mkdtempSync(join(tmpdir(), 'komla-secret-outside-'));
    symlinkSync(outside, join(dir, 'cfg'));
    try {
      expect(() => run('cfg/authorized_keys')).toThrow(/is a link/);
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('writes a file named like an option', () => {
    run('-rf/-env');

    expect(readFileSync(join(dir, '-rf/-env'), 'utf-8')).toBe(CONTENTS);
  });

  it('fails without making the folder it writes in, when it’s gone', () => {
    const removed = join(dir, 'removed');

    expect(() => run('.env', CONTENTS, removed)).toThrow();
    expect(existsSync(removed)).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('writeLocalSecretFile', () => {
  let dir: string;
  let outside: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'komla-secret-file-'));
    outside = mkdtempSync(join(tmpdir(), 'komla-secret-outside-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('writes the file, making the folders it needs, readable by the user alone', () => {
    writeLocalSecretFile(dir, './apps/web/.env', CONTENTS);

    expect(readFileSync(join(dir, 'apps/web/.env'), 'utf-8')).toBe(CONTENTS);
    expect(statSync(join(dir, 'apps/web/.env')).mode & 0o777).toBe(0o600);
  });

  it('replaces a link at the file rather than writing through it', () => {
    writeFileSync(join(outside, 'target'), 'keep me');
    symlinkSync(join(outside, 'target'), join(dir, '.env'));

    writeLocalSecretFile(dir, '.env', CONTENTS);

    expect(lstatSync(join(dir, '.env')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(outside, 'target'), 'utf-8')).toBe('keep me');
  });

  it('refuses a folder on the way that links elsewhere, as a repository could commit', () => {
    symlinkSync(outside, join(dir, 'cfg'));

    expect(() => writeLocalSecretFile(dir, 'cfg/authorized_keys', CONTENTS)).toThrow(
      /cfg is a link/
    );
    expect(readdirSync(outside)).toEqual([]);
  });

  it('never makes the folder it writes in, which may be a workspace removed meanwhile', () => {
    const removed = join(dir, 'removed-workspace');

    expect(() => writeLocalSecretFile(removed, '.env', CONTENTS)).toThrow();
    expect(existsSync(removed)).toBe(false);
  });
});
