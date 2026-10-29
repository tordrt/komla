import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { gzipSync } from 'zlib';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../mocks/electron';

const {
  configServiceMock,
  execFileMock,
  gitServiceMock,
  htmlPreviewServiceMock,
  localMirrorServiceMock,
  ptyServiceMock,
  remoteCompanionServiceMock,
  searchServiceMock,
  sshWorkspaceServiceMock,
  workspaceServiceMock,
  workspaceStatusServiceMock,
} = vi.hoisted(() => ({
  configServiceMock: {
    get: vi.fn(),
  },
  execFileMock: vi.fn(),
  gitServiceMock: {
    listFiles: vi.fn(),
    readFileContent: vi.fn(),
    readImageFileContent: vi.fn(),
    importExternalFile: vi.fn(),
    deleteFile: vi.fn(),
    writeFile: vi.fn(),
  },
  htmlPreviewServiceMock: {
    createPreviewUrl: vi.fn(),
    createContentPreviewUrl: vi.fn(),
  },
  localMirrorServiceMock: {
    getMirrorPath: vi.fn(),
  },
  ptyServiceMock: {
    getBuffer: vi.fn(),
  },
  remoteCompanionServiceMock: {
    ensureInstalled: vi.fn(),
  },
  searchServiceMock: {
    searchContent: vi.fn(),
  },
  sshWorkspaceServiceMock: {
    getHost: vi.fn(),
    run: vi.fn(),
    runStreaming: vi.fn(),
    runWithFileInput: vi.fn(),
    runWithInput: vi.fn(),
  },
  workspaceServiceMock: {
    get: vi.fn(),
  },
  workspaceStatusServiceMock: { change: vi.fn() },
}));

vi.mock('child_process', () => ({ execFile: execFileMock }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});
vi.mock('electron', () => mockElectron());
vi.mock('../../../src/main/services/config.service', () => ({ configService: configServiceMock }));

vi.mock('../../../src/main/services/git.service', () => ({ gitService: gitServiceMock }));
vi.mock('../../../src/main/services/html-preview.service', () => ({
  htmlPreviewService: htmlPreviewServiceMock,
}));
vi.mock('../../../src/main/services/local-mirror.service', () => ({
  localMirrorService: localMirrorServiceMock,
}));
vi.mock('../../../src/main/services/pty.service', () => ({ ptyService: ptyServiceMock }));
vi.mock('../../../src/main/services/remote-companion.service', () => ({
  remoteCompanionService: remoteCompanionServiceMock,
}));
vi.mock('../../../src/main/services/search.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/services/search.service')>()),
  searchService: searchServiceMock,
}));
vi.mock('../../../src/main/services/ssh-workspace.service', () => ({
  sshWorkspaceService: sshWorkspaceServiceMock,
}));
vi.mock('../../../src/main/services/workspace.service', () => ({
  workspaceService: workspaceServiceMock,
}));
vi.mock('../../../src/main/services/workspace-status.service', () => ({
  workspaceStatusService: workspaceStatusServiceMock,
}));
vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

async function execFileAsync(file: string, args: string[]): Promise<{ stdout: string }> {
  const childProcess = await vi.importActual<typeof import('child_process')>('child_process');
  return promisify(childProcess.execFile)(file, args);
}

async function execShWithInput(command: string, input: string): Promise<string> {
  const childProcess = await vi.importActual<typeof import('child_process')>('child_process');
  return childProcess.execFileSync('/bin/sh', ['-c', command], {
    input,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

// Runs the remote script with this computer's /bin/sh as the SSH host; Windows has none.
const itWithPosixShell = it.skipIf(process.platform === 'win32');
// Terminal files are POSIX paths. Terminals on Windows don't offer them as links
// (resolveTerminalFileOpenTarget), and getTerminalFileSource refuses other paths.
const itWithTerminalFiles = it.skipIf(process.platform === 'win32');

describe('workspaceFileService', () => {
  let tempDirectories: string[] = [];
  const localWorkspace = {
    id: 'ws-local',
    workingDirectory: '/repo/worktree',
    backend: { kind: 'local' as const },
    terminals: [{ id: 'term-local', executionLocation: 'workspace' as const }],
  };
  const sshWorkspace = {
    id: 'ws-ssh',
    workingDirectory: 'ssh://ssh-dev/home/dev/repo',
    backend: {
      kind: 'ssh' as const,
      hostId: 'ssh-dev',
      remoteDirectory: '/home/dev/repo',
      remoteRepoPath: '/home/dev/repo.git',
      remoteProjectRoot: '/home/dev',
      gitUrl: 'git@example/repo.git',
    },
    terminals: [
      { id: 'term-ssh', executionLocation: 'workspace' as const },
      { id: 'term-mirror', executionLocation: 'local-mirror' as const },
    ],
  };
  const linkedSshWorkspace = {
    ...sshWorkspace,
    id: 'ws-peer',
    workingDirectory: 'ssh://ssh-dev/home/dev/peer',
    backend: {
      ...sshWorkspace.backend,
      remoteDirectory: '/home/dev/peer',
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    configServiceMock.get.mockReturnValue({});
    localMirrorServiceMock.getMirrorPath.mockReturnValue('/tmp/komla/mirrors/project/branch');
    ptyServiceMock.getBuffer.mockReturnValue({ buffer: '', seq: 0 });
    sshWorkspaceServiceMock.getHost.mockReturnValue({ id: 'ssh-dev', name: 'SSH Dev' });
    workspaceStatusServiceMock.change.mockResolvedValue({ disposition: 'applied' });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.mocked(realpath).mockReset();
    await Promise.all(tempDirectories.map((directory) => rm(directory, { recursive: true })));
    tempDirectories = [];
  });

  async function createSourceFile(name: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'komla-workspace-file-test-'));
    tempDirectories.push(directory);
    const sourcePath = join(directory, name);
    await writeFile(sourcePath, 'contents');
    return sourcePath;
  }

  function mockLinkedSshPair() {
    const origin = { ...sshWorkspace, linkedWorkspaceIds: ['ws-peer'] };
    workspaceServiceMock.get.mockImplementation((id) =>
      id === origin.id ? origin : id === linkedSshWorkspace.id ? linkedSshWorkspace : undefined
    );
    return origin;
  }

  it('delegates local file listing and reads to gitService', async () => {
    workspaceServiceMock.get.mockReturnValue(localWorkspace);
    gitServiceMock.listFiles.mockResolvedValue({
      files: ['src/app.ts'],
      gitIgnoredFiles: [],
      emptyDirs: [],
    });
    gitServiceMock.readFileContent.mockResolvedValue('content');

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    await expect(workspaceFileService.listFiles('ws-local')).resolves.toMatchObject({
      files: ['src/app.ts'],
    });
    await expect(workspaceFileService.readFile('ws-local', 'src/app.ts')).resolves.toBe('content');

    expect(gitServiceMock.listFiles).toHaveBeenCalledWith('/repo/worktree', false);
    expect(gitServiceMock.readFileContent).toHaveBeenCalledWith('/repo/worktree', 'src/app.ts');
  });

  it.runIf(process.platform !== 'win32')(
    'protects only verified managed links for local workspaces',
    async () => {
      const workspaceDirectory = await mkdtemp(join(tmpdir(), 'komla-local-link-list-test-'));
      const peerDirectory = await mkdtemp(join(tmpdir(), 'komla-local-link-peer-test-'));
      tempDirectories.push(workspaceDirectory, peerDirectory);
      await mkdir(join(workspaceDirectory, 'linked-workspaces'));
      await symlink(peerDirectory, join(workspaceDirectory, 'linked-workspaces', 'peer'));
      await writeFile(join(workspaceDirectory, 'linked-workspaces', 'notes.txt'), 'notes');
      const origin = {
        ...localWorkspace,
        workingDirectory: workspaceDirectory,
        linkedWorkspaceIds: ['ws-local-peer'],
      };
      const peer = {
        ...localWorkspace,
        id: 'ws-local-peer',
        workingDirectory: peerDirectory,
      };
      workspaceServiceMock.get.mockImplementation((id) =>
        id === origin.id ? origin : id === peer.id ? peer : undefined
      );
      const { workspaceFileService } =
        await import('../../../src/main/services/workspace-file.service');

      await expect(
        workspaceFileService.deletePath(origin.id, 'linked-workspaces/peer')
      ).rejects.toThrow('linked workspace');
      await expect(
        workspaceFileService.deletePath(origin.id, 'linked-workspaces/notes.txt')
      ).resolves.toBeUndefined();
      expect(gitServiceMock.deleteFile).toHaveBeenCalledOnce();
    }
  );

  it('delegates local deletion to gitService', async () => {
    workspaceServiceMock.get.mockReturnValue(localWorkspace);

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    await expect(
      workspaceFileService.deletePath('ws-local', 'src/app.ts')
    ).resolves.toBeUndefined();

    expect(gitServiceMock.deleteFile).toHaveBeenCalledWith(
      '/repo/worktree',
      'src/app.ts',
      'modified'
    );

    await expect(workspaceFileService.deletePath('ws-local', '../outside')).rejects.toThrow(
      'escapes the allowed root path'
    );
    expect(gitServiceMock.deleteFile).toHaveBeenCalledTimes(1);
  });

  it('rejects local deletion paths that resolve to the workspace root or are noncanonical', async () => {
    workspaceServiceMock.get.mockReturnValue(localWorkspace);

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');

    await expect(workspaceFileService.deletePath('ws-local', '.')).rejects.toThrow();
    await expect(workspaceFileService.deletePath('ws-local', 'src/..')).rejects.toThrow();
    await expect(workspaceFileService.deletePath('ws-local', 'src/../README.md')).rejects.toThrow(
      'canonical relative path'
    );
    expect(gitServiceMock.deleteFile).not.toHaveBeenCalled();
  });

  it('delegates local imports to the existing git importer', async () => {
    const sourcePath = await createSourceFile('report.pdf');
    gitServiceMock.importExternalFile.mockResolvedValue('.komla-files/report.pdf');
    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');

    workspaceServiceMock.get.mockReturnValue(localWorkspace);
    await expect(
      workspaceFileService.importExternalFile('ws-local', sourcePath, 'report.pdf')
    ).resolves.toBe('.komla-files/report.pdf');
    expect(gitServiceMock.importExternalFile).toHaveBeenLastCalledWith(
      '/repo/worktree',
      sourcePath,
      'report.pdf'
    );
  });

  it('imports dropped files into disposable local copies', async () => {
    const sourcePath = await createSourceFile('report.pdf');
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    gitServiceMock.importExternalFile.mockResolvedValue('.komla-files/report.pdf');
    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');

    await expect(
      workspaceFileService.importExternalFile('ws-ssh', sourcePath, 'report.pdf', 'local-mirror')
    ).resolves.toBe('.komla-files/report.pdf');
    expect(localMirrorServiceMock.getMirrorPath).toHaveBeenCalledWith(
      'ws-ssh',
      sshWorkspace.backend
    );
    expect(gitServiceMock.importExternalFile).toHaveBeenCalledWith(
      '/tmp/komla/mirrors/project/branch',
      sourcePath,
      'report.pdf'
    );
    expect(sshWorkspaceServiceMock.runWithFileInput).not.toHaveBeenCalled();
  });

  it('uploads SSH imports into the remote Komla files folder', async () => {
    const sourcePath = await createSourceFile('original.pdf');
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    sshWorkspaceServiceMock.runWithFileInput.mockResolvedValue(
      'STATUS=OK\nPATH=.komla-files/Report-copy.pdf\n'
    );

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    await expect(
      workspaceFileService.importExternalFile('ws-ssh', sourcePath, 'Report copy.PDF')
    ).resolves.toBe('.komla-files/Report-copy.pdf');

    expect(sshWorkspaceServiceMock.runWithFileInput).toHaveBeenCalledWith(
      { id: 'ssh-dev', name: 'SSH Dev' },
      expect.stringContaining("cd '/home/dev/repo'"),
      sourcePath,
      { purpose: { kind: 'interactive' } }
    );
    const command = sshWorkspaceServiceMock.runWithFileInput.mock.calls[0][1];
    expect(command).toContain("base_name='Report-copy'");
    expect(command).toContain("extension='.pdf'");
    expect(command).toContain("import_dir='.komla-files'");
    expect(command).toContain("gitignore_path='.komla-files/.gitignore'");
    expect(command).toContain('expected_size=8');
    expect(command).toContain('actual_size=$(wc -c < "$temp_path"');
    expect(command).toContain('if [ "$actual_size" != "$expected_size" ]; then');
    expect(command.indexOf('if [ "$actual_size" != "$expected_size" ]; then')).toBeLessThan(
      command.indexOf('mv -f "$temp_path" "$result_path"')
    );
    expect(command).toContain('if [ ! -e "$candidate" ] && [ ! -L "$candidate" ]; then');
    expect(command).toContain('Unable to reserve remote import path');
    expect(command).toContain('if [ "$suffix" -gt 10000 ]; then');
  });

  // Inherited from `git rebase --exec`, hooks or `git -c`, these would point git at
  // another repository or inject config.
  const INHERITED_GIT_ENV_KEYS = [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CONFIG_PARAMETERS',
    'GIT_CONFIG_COUNT',
  ];

  /** Runs SSH imports through a real shell, into a folder inside a fresh repo. */
  async function setupRealSshImport() {
    const { execFileSync } = await vi.importActual<typeof import('child_process')>('child_process');
    const repoPath = await mkdtemp(join(tmpdir(), 'komla-ssh-import-'));
    tempDirectories.push(repoPath);
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };
    for (const key of INHERITED_GIT_ENV_KEYS) delete env[key];
    const gitStatus = () =>
      execFileSync('git', ['status', '--porcelain', '-uall'], {
        cwd: repoPath,
        encoding: 'utf8',
        env,
      });
    execFileSync('git', ['init', '-q'], { cwd: repoPath, env });
    const folderPath = join(repoPath, 'notes');
    await mkdir(folderPath);
    workspaceServiceMock.get.mockReturnValue({
      ...sshWorkspace,
      backend: { ...sshWorkspace.backend, remoteDirectory: folderPath },
    });
    sshWorkspaceServiceMock.runWithFileInput.mockImplementation(
      async (_host, command: string, inputPath: string) =>
        execShWithInput(command, await readFile(inputPath, 'utf8'))
    );
    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    return { folderPath, gitStatus, workspaceFileService };
  }

  itWithPosixShell(
    'runs the SSH import script so git ignores imports in a repo subfolder',
    async () => {
      const sourcePath = await createSourceFile('shot.png');
      const { folderPath, gitStatus, workspaceFileService } = await setupRealSshImport();

      await expect(workspaceFileService.importExternalFile('ws-ssh', sourcePath)).resolves.toBe(
        '.komla-files/shot.png'
      );

      expect(await readFile(join(folderPath, '.komla-files', 'shot.png'), 'utf8')).toBe('contents');
      expect(gitStatus()).toBe('');
    }
  );

  itWithPosixShell(
    'lists SSH imports without the folder’s own ignore file but with an imported one',
    async () => {
      const { execFileSync } =
        await vi.importActual<typeof import('child_process')>('child_process');
      const { folderPath } = await setupRealSshImport();
      sshWorkspaceServiceMock.run.mockImplementation(async (_host, command: string) =>
        execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
      );
      await mkdir(join(folderPath, '.komla-files'));
      await writeFile(join(folderPath, '.komla-files', 'shot.png'), 'png');
      await writeFile(join(folderPath, '.komla-files', '.gitignore'), '*\n');
      const { workspaceFileService } =
        await import('../../../src/main/services/workspace-file.service');

      expect((await workspaceFileService.listFiles('ws-ssh', false)).files).toEqual([
        '.komla-files/shot.png',
      ]);

      await writeFile(join(folderPath, '.komla-files', '.gitignore'), 'dist/\n');
      expect((await workspaceFileService.listFiles('ws-ssh', false)).files.sort()).toEqual([
        '.komla-files/.gitignore',
        '.komla-files/shot.png',
      ]);
    }
  );

  itWithPosixShell(
    'moves an earlier SSH import named .gitignore aside for the folder’s own',
    async () => {
      const sourcePath = await createSourceFile('shot.png');
      const { folderPath, gitStatus, workspaceFileService } = await setupRealSshImport();
      await mkdir(join(folderPath, '.komla-files'));
      await writeFile(join(folderPath, '.komla-files', '.gitignore'), 'dist/\n');

      await workspaceFileService.importExternalFile('ws-ssh', sourcePath);

      expect(await readFile(join(folderPath, '.komla-files', '.gitignore'), 'utf8')).toBe('*\n');
      expect(await readFile(join(folderPath, '.komla-files', '.gitignore-2'), 'utf8')).toBe(
        'dist/\n'
      );
      expect(gitStatus()).toBe('');
    }
  );

  const terminalFile = (fullPath: string) => ({ kind: 'terminal' as const, fullPath });
  const workspaceFile = (filePath: string) => ({ kind: 'workspace' as const, filePath });

  itWithTerminalFiles(
    'lists a local terminal folder here, whatever host its shell reports',
    async () => {
      const directory = await createViewerFolder();
      workspaceServiceMock.get.mockReturnValue(localWorkspace);
      ptyServiceMock.getBuffer.mockReturnValue({
        buffer: '',
        seq: 0,
        hostInfo: { hostname: 'ssh:ssh-dev', isLocal: false },
      });
      const { workspaceFileService } =
        await import('../../../src/main/services/workspace-file.service');

      await expect(
        workspaceFileService.listViewerFolder(
          'ws-local',
          'term-local',
          terminalFile(`${directory}/`)
        )
      ).resolves.toEqual(VIEWER_FOLDER_FILES);
      expect(execFileMock).not.toHaveBeenCalled();
      expect(ptyServiceMock.getBuffer).not.toHaveBeenCalled();
    }
  );

  it('rejects unknown terminals and non-absolute terminal paths', async () => {
    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');

    workspaceServiceMock.get.mockReturnValue(localWorkspace);
    await expect(
      workspaceFileService.readViewerFile('ws-local', 'missing', terminalFile('/tmp/report.html'))
    ).rejects.toThrow('not found in workspace');

    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    await expect(
      workspaceFileService.readViewerFile('ws-ssh', 'term-ssh', terminalFile('report.html'))
    ).rejects.toThrow('absolute POSIX path');
    expect(sshWorkspaceServiceMock.run).not.toHaveBeenCalled();

    // Terminal files are POSIX paths, so a Windows one is refused, even from a local terminal.
    workspaceServiceMock.get.mockReturnValue(localWorkspace);
    await expect(
      workspaceFileService.readViewerFile(
        'ws-local',
        'term-local',
        terminalFile('C:\\Users\\dev\\report.html')
      )
    ).rejects.toThrow('absolute POSIX path');
  });

  itWithTerminalFiles(
    'reads a host terminal image in place instead of snapshotting it',
    async () => {
      const sourcePath = await createSourceFile('shot.png');
      workspaceServiceMock.get.mockReturnValue(localWorkspace);
      const { workspaceFileService } =
        await import('../../../src/main/services/workspace-file.service');

      await expect(
        workspaceFileService.readViewerFile('ws-local', 'term-local', terminalFile(sourcePath))
      ).resolves.toEqual({
        data: Buffer.from('contents').toString('base64'),
        mimeType: 'image/png',
      });
      expect(gitServiceMock.importExternalFile).not.toHaveBeenCalled();
      expect(execFileMock).not.toHaveBeenCalled();
    }
  );

  itWithTerminalFiles('reads a local-mirror terminal file from this computer', async () => {
    const sourcePath = await createSourceFile('shot.webp');
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');

    await expect(
      workspaceFileService.readViewerFile('ws-ssh', 'term-mirror', terminalFile(sourcePath))
    ).resolves.toEqual({
      data: Buffer.from('contents').toString('base64'),
      mimeType: 'image/webp',
    });
    expect(sshWorkspaceServiceMock.run).not.toHaveBeenCalled();
  });

  itWithTerminalFiles(
    'refuses host terminal files that are symlinks or too large for their type',
    async () => {
      const sourcePath = await createSourceFile('target.png');
      const directory = join(sourcePath, '..');
      const linkPath = join(directory, 'link.png');
      await symlink(sourcePath, linkPath);
      await writeFile(join(directory, 'large.png'), Buffer.alloc(10 * 1024 * 1024 + 1));
      await writeFile(join(directory, 'large.log'), Buffer.alloc(5 * 1024 * 1024 + 1));
      await writeFile(join(directory, 'clip.mp4'), Buffer.alloc(5 * 1024 * 1024 + 1));
      workspaceServiceMock.get.mockReturnValue(localWorkspace);
      const { workspaceFileService } =
        await import('../../../src/main/services/workspace-file.service');
      const read = (path: string) =>
        workspaceFileService.readViewerFile('ws-local', 'term-local', terminalFile(path));

      await expect(read(linkPath)).rejects.toThrow('symlink');
      await expect(read(join(directory, 'large.png'))).rejects.toThrow('too large');
      await expect(read(join(directory, 'large.log'))).rejects.toThrow('too large');
      await expect(read(join(directory, 'clip.mp4'))).resolves.toMatchObject({
        mimeType: 'video/mp4',
      });
    }
  );

  it('reads a remote terminal file over SSH without copying it', async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    sshWorkspaceServiceMock.run.mockResolvedValue('STATUS=OK\nDATA=aW1hZ2U=\n');
    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');

    await expect(
      workspaceFileService.readViewerFile('ws-ssh', 'term-ssh', terminalFile('/tmp/shots/a b.png'))
    ).resolves.toEqual({ data: 'aW1hZ2U=', mimeType: 'image/png' });

    const command = sshWorkspaceServiceMock.run.mock.calls[0][1];
    expect(command).toContain("source_path='/tmp/shots/a b.png'");
    expect(command).toContain(`cap=${7 * 1024 * 1024}`);
    expect(command).toContain('if [ -L "$source_path" ]');
    expect(command).toContain('komla_b64 <"$source_path"');
    expect(command).not.toContain('cp ');

    await workspaceFileService.readViewerFile('ws-ssh', 'term-ssh', terminalFile('/tmp/notes.md'));
    expect(sshWorkspaceServiceMock.run.mock.calls[1][1]).toContain(`cap=${5 * 1024 * 1024}`);
  });

  itWithTerminalFiles('runs the remote terminal file script against real files', async () => {
    const { execFileSync } = await vi.importActual<typeof import('child_process')>('child_process');
    const sourcePath = await createSourceFile('shot.png');
    const directory = join(sourcePath, '..');
    await symlink(sourcePath, join(directory, 'link.png'));
    await writeFile(join(directory, 'large.png'), Buffer.alloc(7 * 1024 * 1024 + 1));
    workspaceServiceMock.get.mockReturnValue({
      ...sshWorkspace,
      backend: { ...sshWorkspace.backend, remoteDirectory: directory },
    });
    sshWorkspaceServiceMock.run.mockImplementation(async (_host, command: string) =>
      execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    );
    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    const read = (name: string) =>
      workspaceFileService.readViewerFile(
        'ws-ssh',
        'term-ssh',
        terminalFile(join(directory, name))
      );

    await expect(read('shot.png')).resolves.toEqual({
      data: Buffer.from('contents').toString('base64'),
      mimeType: 'image/png',
    });
    await expect(read('link.png')).rejects.toThrow('symlink');
    await expect(read('large.png')).rejects.toThrow('too large');
    await expect(read('missing.png')).rejects.toThrow('ENOENT');
  });

  it.each([
    ['STATUS=NOT_FOUND\n', 'ENOENT'],
    ['STATUS=SYMLINK\n', 'symlink'],
    ['STATUS=TOO_LARGE\nSIZE=9000000\n', 'too large'],
    ['STATUS=ENCODING_UNAVAILABLE\n', 'base64 or openssl'],
  ])('reports a remote terminal file read of %j', async (output, message) => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    sshWorkspaceServiceMock.run.mockResolvedValue(output);
    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');

    await expect(
      workspaceFileService.readViewerFile('ws-ssh', 'term-ssh', terminalFile('/tmp/shot.png'))
    ).rejects.toThrow(message);
  });

  it('rejects terminal file reads with invalid paths or terminals', async () => {
    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    const read = (terminalId: string, path: string) =>
      workspaceFileService.readViewerFile('ws-ssh', terminalId, terminalFile(path));

    await expect(read('term-ssh', 'shot.png')).rejects.toThrow('absolute POSIX path');
    await expect(read('term-ssh', '/tmp/a\0.png')).rejects.toThrow('null byte');
    await expect(read('missing', '/tmp/shot.png')).rejects.toThrow('not found in workspace');
    expect(sshWorkspaceServiceMock.run).not.toHaveBeenCalled();
  });

  it('reads a workspace file for the viewer from the local worktree', async () => {
    const sourcePath = await createSourceFile('notes.md');
    const workingDirectory = join(sourcePath, '..');
    workspaceServiceMock.get.mockReturnValue({ ...localWorkspace, workingDirectory });
    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');

    await expect(
      workspaceFileService.readViewerFile('ws-local', 'term-local', workspaceFile('notes.md'))
    ).resolves.toEqual({
      data: Buffer.from('contents').toString('base64'),
      mimeType: 'application/octet-stream',
    });
    await expect(
      workspaceFileService.readViewerFile('ws-local', 'term-local', workspaceFile('../notes.md'))
    ).rejects.toThrow();
  });

  it('searches a local workspace with ripgrep in its directory', async () => {
    workspaceServiceMock.get.mockReturnValue(localWorkspace);
    searchServiceMock.searchContent.mockResolvedValue([]);

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    await workspaceFileService.searchContent('ws-local', 'needle', { caseSensitive: true });

    expect(searchServiceMock.searchContent).toHaveBeenCalledWith('/repo/worktree', 'needle', {
      caseSensitive: true,
    });
    expect(sshWorkspaceServiceMock.run).not.toHaveBeenCalled();
  });

  /** Answers `runStreaming` the way the SSH connection service does: output, then an exit. */
  function streamSearch(output: string, failure?: { stderr: string; error: Error }) {
    sshWorkspaceServiceMock.runStreaming.mockImplementation(
      async (
        _host: unknown,
        _command: string,
        options: { onData?: (data: string) => void; onErrorData?: (data: string) => void }
      ) => {
        options.onData?.(output);
        if (!failure) return 0;
        options.onErrorData?.(failure.stderr);
        throw failure.error;
      }
    );
  }

  it('searches an SSH workspace with the Remote Companion on its host', async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    sshWorkspaceServiceMock.getHost.mockReturnValue({ id: 'ssh-dev' });
    remoteCompanionServiceMock.ensureInstalled.mockResolvedValue('/opt/komla/komla');
    const match = {
      type: 'match',
      data: {
        path: { text: 'src/app.ts' },
        lines: { text: 'call(foo,\n  bar)\n' },
        line_number: 4,
        submatches: [{ start: 5, end: 15 }],
      },
    };
    streamSearch(`${JSON.stringify(match)}\n`);

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    await expect(workspaceFileService.searchContent('ws-ssh', "foo, bar's")).resolves.toEqual([
      {
        path: 'src/app.ts',
        lineNumber: 4,
        lineContent: 'call(foo,   bar)',
        matches: [{ start: 5, end: 15 }],
      },
    ]);
    expect(remoteCompanionServiceMock.ensureInstalled).toHaveBeenCalledWith({ id: 'ssh-dev' }, '/');
    expect(sshWorkspaceServiceMock.runStreaming).toHaveBeenCalledWith(
      { id: 'ssh-dev' },
      "cd '/home/dev/repo' || exit 1; '/opt/komla/komla' '__search' '--max-results' '100' " +
        "'--max-filesize' '1048576' '--ignore-case' '--multiline' '--' 'foo,\\s+bar'\"'\"'s'",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(sshWorkspaceServiceMock.run).not.toHaveBeenCalled();
  });

  it('passes regex and size options to the Remote Companion as it takes them', async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    remoteCompanionServiceMock.ensureInstalled.mockResolvedValue('/opt/komla/komla');
    streamSearch('');

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    await workspaceFileService.searchContent('ws-ssh', 'a.+b', {
      caseSensitive: true,
      regex: true,
      maxResults: 5,
      maxFileSize: '2K',
    });

    expect(sshWorkspaceServiceMock.runStreaming.mock.calls[0][1]).toContain(
      "'__search' '--max-results' '5' '--max-filesize' '2048' '--' 'a.+b'"
    );
  });

  it('stops an SSH content search once a newer one starts in the same workspace', async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    remoteCompanionServiceMock.ensureInstalled.mockResolvedValue('/opt/komla/komla');
    const signals: AbortSignal[] = [];
    sshWorkspaceServiceMock.runStreaming.mockImplementation(
      (_host: unknown, _command: string, options: { signal: AbortSignal }) => {
        signals.push(options.signal);
        if (signals.length > 1) return Promise.resolve(0);
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('stopped'), { name: 'AbortError' }))
          );
        });
      }
    );

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    const older = workspaceFileService.searchContent('ws-ssh', 'han');
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    const newer = workspaceFileService.searchContent('ws-ssh', 'handle');

    await expect(older).resolves.toEqual([]);
    await expect(newer).resolves.toEqual([]);
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
  });

  it('does not start a superseded SSH content search', async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    remoteCompanionServiceMock.ensureInstalled.mockResolvedValue('/opt/komla/komla');
    streamSearch('');

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    const older = workspaceFileService.searchContent('ws-ssh', 'han');
    const newer = workspaceFileService.searchContent('ws-ssh', 'handle');

    await expect(older).resolves.toEqual([]);
    await expect(newer).resolves.toEqual([]);
    expect(sshWorkspaceServiceMock.runStreaming).toHaveBeenCalledTimes(1);
    expect(sshWorkspaceServiceMock.runStreaming.mock.calls[0][1]).toContain("'handle'");
  });

  it("explains an SSH content search failure with the host's last error line", async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    remoteCompanionServiceMock.ensureInstalled.mockResolvedValue('/opt/komla/komla');
    streamSearch('', {
      stderr: 'warning: something\ninvalid search pattern: unclosed group\n',
      error: new Error('SSH command exited with code 1'),
    });

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    await expect(workspaceFileService.searchContent('ws-ssh', 'needle')).rejects.toThrow(
      "Couldn't search the SSH host: invalid search pattern: unclosed group"
    );

    remoteCompanionServiceMock.ensureInstalled.mockRejectedValue(
      new Error('Komla Remote Companion artifact is missing')
    );
    await expect(workspaceFileService.searchContent('ws-ssh', 'needle')).rejects.toThrow(
      "Couldn't search the SSH host: Komla Remote Companion artifact is missing"
    );
  });

  it('says when an SSH content search ran out of time before finding anything', async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    remoteCompanionServiceMock.ensureInstalled.mockResolvedValue('/opt/komla/komla');
    const stopped = '{"type":"stopped","data":{"reason":"deadline"}}\n';
    const match = JSON.stringify({
      type: 'match',
      data: {
        path: { text: 'a.ts' },
        lines: { text: 'needle\n' },
        line_number: 1,
        submatches: [{ start: 0, end: 6 }],
      },
    });

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    streamSearch(stopped);
    await expect(workspaceFileService.searchContent('ws-ssh', 'needle')).rejects.toThrow(
      'The search took too long on the SSH host'
    );
    streamSearch(`${match}\n${stopped}`);
    await expect(workspaceFileService.searchContent('ws-ssh', 'needle')).resolves.toHaveLength(1);
  });

  it('does not search an SSH workspace for a blank query or while it is being set up', async () => {
    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    await expect(workspaceFileService.searchContent('ws-ssh', '   ')).resolves.toEqual([]);
    workspaceServiceMock.get.mockReturnValue({ ...sshWorkspace, provisioning: true });
    await expect(workspaceFileService.searchContent('ws-ssh', 'needle')).resolves.toEqual([]);

    expect(remoteCompanionServiceMock.ensureInstalled).not.toHaveBeenCalled();
    expect(sshWorkspaceServiceMock.runStreaming).not.toHaveBeenCalled();
  });

  it('reads an SSH workspace file for the viewer on the remote host', async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    sshWorkspaceServiceMock.run.mockResolvedValue('STATUS=OK\nDATA=JVBERg==\n');
    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');

    await expect(
      workspaceFileService.readViewerFile('ws-ssh', 'term-ssh', workspaceFile('out/paper.pdf'))
    ).resolves.toEqual({ data: 'JVBERg==', mimeType: 'application/pdf' });
    const command = sshWorkspaceServiceMock.run.mock.calls[0][1];
    expect(command).toContain("file='out/paper.pdf'");
    expect(command).toContain(`cap=${7 * 1024 * 1024}`);
  });

  it('previews an SSH workspace PDF without a terminal', async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    sshWorkspaceServiceMock.run.mockResolvedValue('STATUS=OK\nDATA=JVBERg==\n');
    htmlPreviewServiceMock.createContentPreviewUrl.mockResolvedValue('komla-preview://t/paper.pdf');
    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');

    await expect(
      workspaceFileService.getViewerPreviewUrl('ws-ssh', null, workspaceFile('out/paper.pdf'))
    ).resolves.toBe('komla-preview://t/paper.pdf');
    expect(htmlPreviewServiceMock.createContentPreviewUrl).toHaveBeenCalledWith(
      'paper.pdf',
      Buffer.from('JVBERg==', 'base64'),
      // Kept for its hour, as the viewer or the file panel may still show it.
      { web: true }
    );
  });

  it('replaces the hover card preview before of the same file', async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    sshWorkspaceServiceMock.run.mockResolvedValue('STATUS=OK\nDATA=JVBERg==\n');
    htmlPreviewServiceMock.createContentPreviewUrl.mockResolvedValue('komla-preview://t/paper.pdf');
    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');

    await workspaceFileService.getViewerPreviewUrl('ws-ssh', null, workspaceFile('out/paper.pdf'), {
      replacesPrevious: true,
    });
    expect(htmlPreviewServiceMock.createContentPreviewUrl).toHaveBeenCalledWith(
      'paper.pdf',
      Buffer.from('JVBERg==', 'base64'),
      { web: true, key: 'viewer:ws-ssh:workspace:out/paper.pdf' }
    );
  });

  it('needs a terminal for a terminal file', async () => {
    workspaceServiceMock.get.mockReturnValue(localWorkspace);
    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');

    await expect(
      workspaceFileService.readViewerFile('ws-local', null, terminalFile('/tmp/report.html'))
    ).rejects.toThrow('needs its terminal');
  });

  it('serves a local workspace page from the worktree so its own files load', async () => {
    workspaceServiceMock.get.mockReturnValue(localWorkspace);
    htmlPreviewServiceMock.createPreviewUrl.mockResolvedValue('komla-preview://token/out/r.html');
    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');

    await expect(
      workspaceFileService.getViewerPreviewUrl(
        'ws-local',
        'term-local',
        workspaceFile('out/r.html')
      )
    ).resolves.toBe('komla-preview://token/out/r.html');
    expect(htmlPreviewServiceMock.createPreviewUrl).toHaveBeenCalledWith(
      '/repo/worktree',
      'out/r.html'
    );
  });

  /** Makes the temp folders resolve to `folder`, so a fixture elsewhere is outside them. */
  async function placeTempFolderAt(folder: string) {
    const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
    vi.mocked(realpath).mockImplementation(((path: string) =>
      actual.realpath(path === '/tmp' || path === tmpdir() ? folder : path)) as typeof realpath);
  }

  async function createTempFolder(): Promise<string> {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'komla-workspace-file-test-')));
    tempDirectories.push(directory);
    return directory;
  }

  async function writePage(folder: string): Promise<string> {
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'index.html'), 'contents');
    return join(folder, 'index.html');
  }

  /** Previews a terminal's page, served from its folder or on its own. */
  async function previewTerminalPage(workspaceId: string, terminalId: string, page: string) {
    htmlPreviewServiceMock.createPreviewUrl.mockResolvedValue('komla-preview://folder/index.html');
    htmlPreviewServiceMock.createContentPreviewUrl.mockResolvedValue(
      'komla-preview://content/index.html'
    );
    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    const url = await workspaceFileService.getViewerPreviewUrl(
      workspaceId,
      terminalId,
      terminalFile(page)
    );
    return url === 'komla-preview://folder/index.html' ? 'folder' : 'content';
  }

  itWithTerminalFiles(
    'serves a terminal page two levels into a temp folder, not one or a hidden or home one',
    async () => {
      const temp = await createTempFolder();
      await placeTempFolderAt(temp);
      workspaceServiceMock.get.mockReturnValue(localWorkspace);
      const preview = (page: string) => previewTerminalPage('ws-local', 'term-local', page);

      await expect(preview(await writePage(join(temp, 'app', 'site')))).resolves.toBe('folder');
      expect(htmlPreviewServiceMock.createPreviewUrl).toHaveBeenCalledWith(
        join(temp, 'app', 'site'),
        'index.html'
      );
      await expect(preview(await writePage(join(temp, 'app')))).resolves.toBe('content');
      await expect(preview(await writePage(join(temp, 'app', '.cache', 'site')))).resolves.toBe(
        'content'
      );
      vi.stubEnv('HOME', join(temp, 'app', 'site'));
      await expect(preview(join(temp, 'app', 'site', 'index.html'))).resolves.toBe('content');
      expect(htmlPreviewServiceMock.createContentPreviewUrl).toHaveBeenCalledWith(
        'index.html',
        'contents',
        expect.objectContaining({ web: true })
      );
    }
  );

  itWithTerminalFiles(
    'serves a terminal page in its workspace or two levels into the worktrees folder',
    async () => {
      await placeTempFolderAt(await createTempFolder());
      const workspaceFolder = await createTempFolder();
      const komlaFolder = await createTempFolder();
      vi.stubEnv('KOMLA_DATA_DIR', komlaFolder);
      workspaceServiceMock.get.mockReturnValue({
        ...localWorkspace,
        workingDirectory: workspaceFolder,
      });
      const preview = (page: string) => previewTerminalPage('ws-local', 'term-local', page);

      await expect(preview(await writePage(workspaceFolder))).resolves.toBe('folder');
      expect(htmlPreviewServiceMock.createPreviewUrl).toHaveBeenCalledWith(
        workspaceFolder,
        'index.html'
      );
      await expect(preview(await writePage(join(workspaceFolder, '.git')))).resolves.toBe(
        'content'
      );
      const worktrees = join(komlaFolder, 'worktrees');
      await expect(preview(await writePage(join(worktrees, 'project', 'branch')))).resolves.toBe(
        'folder'
      );
      await expect(preview(await writePage(join(worktrees, 'project')))).resolves.toBe('content');
      await expect(preview(await writePage(join(komlaFolder, 'a', 'b')))).resolves.toBe('content');
    }
  );

  itWithTerminalFiles(
    "serves a Local copy terminal's page from the workspace's mirror",
    async () => {
      await placeTempFolderAt(await createTempFolder());
      const mirror = await createTempFolder();
      localMirrorServiceMock.getMirrorPath.mockReturnValue(mirror);
      workspaceServiceMock.get.mockReturnValue(sshWorkspace);

      await expect(
        previewTerminalPage('ws-ssh', 'term-mirror', await writePage(join(mirror, 'dist')))
      ).resolves.toBe('folder');
      expect(htmlPreviewServiceMock.createPreviewUrl).toHaveBeenCalledWith(
        join(mirror, 'dist'),
        'index.html'
      );
    }
  );

  itWithTerminalFiles(
    "serves a page's folder by its real path, so a symlink can't point it elsewhere",
    async () => {
      await placeTempFolderAt(await createTempFolder());
      const workspaceFolder = await createTempFolder();
      const outside = await createTempFolder();
      await writePage(join(workspaceFolder, 'site'));
      await writePage(outside);
      await symlink(join(workspaceFolder, 'site'), join(workspaceFolder, 'site-link'));
      await symlink(outside, join(workspaceFolder, 'outside-link'));
      workspaceServiceMock.get.mockReturnValue({
        ...localWorkspace,
        workingDirectory: workspaceFolder,
      });
      const preview = (page: string) => previewTerminalPage('ws-local', 'term-local', page);

      await expect(preview(join(workspaceFolder, 'site-link', 'index.html'))).resolves.toBe(
        'folder'
      );
      expect(htmlPreviewServiceMock.createPreviewUrl).toHaveBeenCalledWith(
        join(workspaceFolder, 'site'),
        'index.html'
      );
      await expect(preview(join(workspaceFolder, 'outside-link', 'index.html'))).resolves.toBe(
        'content'
      );
      expect(htmlPreviewServiceMock.createPreviewUrl).toHaveBeenCalledTimes(1);
    }
  );

  it('shows a remote terminal PDF from its bytes', async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    sshWorkspaceServiceMock.run.mockResolvedValue(
      `STATUS=OK\nDATA=${Buffer.from('%PDF-1.4').toString('base64')}\n`
    );
    htmlPreviewServiceMock.createContentPreviewUrl.mockResolvedValue(
      'komla-preview://content/paper.pdf'
    );
    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');

    await expect(
      workspaceFileService.getViewerPreviewUrl(
        'ws-ssh',
        'term-ssh',
        terminalFile('/home/dev/out/paper.pdf'),
        { replacesPrevious: true }
      )
    ).resolves.toBe('komla-preview://content/paper.pdf');
    expect(htmlPreviewServiceMock.createContentPreviewUrl).toHaveBeenCalledWith(
      'paper.pdf',
      Buffer.from('%PDF-1.4'),
      { web: true, key: 'viewer:ws-ssh:terminal:term-ssh:/home/dev/out/paper.pdf' }
    );
    expect(htmlPreviewServiceMock.createPreviewUrl).not.toHaveBeenCalled();
  });

  it('only makes preview URLs for pages and PDFs', async () => {
    workspaceServiceMock.get.mockReturnValue(localWorkspace);
    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');

    await expect(
      workspaceFileService.getViewerPreviewUrl('ws-local', 'term-local', workspaceFile('a.md'))
    ).rejects.toThrow('Not an HTML or PDF file');
  });

  /** A folder of agent output: viewable files a minute apart, oldest first, and others. */
  async function createViewerFolder(): Promise<string> {
    const directory = join(await createSourceFile('option-a.png'), '..');
    for (const name of ['option-b.png', 'notes.md', 'report.html']) {
      await writeFile(join(directory, name), 'contents');
    }
    for (const [index, name] of ['option-a.png', 'option-b.png', 'notes.md'].entries()) {
      const time = new Date(Date.UTC(2020, 0, 1, 12, index));
      await utimes(join(directory, name), time, time);
    }
    await writeFile(join(directory, '.hidden.png'), 'contents');
    await writeFile(join(directory, 'check.ts'), 'contents');
    await symlink(join(directory, 'option-a.png'), join(directory, 'link.png'));
    await mkdir(join(directory, 'nested.png'));
    const folderTime = new Date(Date.UTC(2020, 0, 1, 11));
    await utimes(join(directory, 'nested.png'), folderTime, folderTime);
    await mkdir(join(directory, '.cache'));
    await symlink(join(directory, 'nested.png'), join(directory, 'linked-folder'));
    return directory;
  }

  /**
   * What the viewer can show in `createViewerFolder`: its folders, then its viewable files,
   * newest first, with when each was modified.
   */
  const VIEWER_FOLDER_FILES = [
    { name: 'nested.png/', modifiedMs: Date.UTC(2020, 0, 1, 11) },
    { name: 'report.html', modifiedMs: expect.any(Number) },
    { name: 'notes.md', modifiedMs: Date.UTC(2020, 0, 1, 12, 2) },
    { name: 'option-b.png', modifiedMs: Date.UTC(2020, 0, 1, 12, 1) },
    { name: 'option-a.png', modifiedMs: Date.UTC(2020, 0, 1, 12, 0) },
  ];

  itWithTerminalFiles(
    "lists a host terminal file's folder: viewable files, newest first",
    async () => {
      const directory = await createViewerFolder();
      workspaceServiceMock.get.mockReturnValue(localWorkspace);
      const { workspaceFileService } =
        await import('../../../src/main/services/workspace-file.service');

      await expect(
        workspaceFileService.listViewerFolder(
          'ws-local',
          'term-local',
          terminalFile(join(directory, 'option-a.png'))
        )
      ).resolves.toEqual(VIEWER_FOLDER_FILES);
      expect(execFileMock).not.toHaveBeenCalled();
    }
  );

  itWithTerminalFiles(
    "lists a folder's files however many subfolders it has, here and by script",
    async () => {
      const { execFileSync } =
        await vi.importActual<typeof import('child_process')>('child_process');
      const directory = await createViewerFolder();
      // Folders newer than the files, past the 200 a listing keeps of each.
      const newer = new Date(Date.UTC(2030, 0, 1));
      for (let index = 0; index < 205; index++) {
        await mkdir(join(directory, `run-${index}`));
        await utimes(join(directory, `run-${index}`), newer, newer);
      }
      const { workspaceFileService } =
        await import('../../../src/main/services/workspace-file.service');
      const files = VIEWER_FOLDER_FILES.slice(1).map(({ name }) => name);

      workspaceServiceMock.get.mockReturnValue(localWorkspace);
      const local = await workspaceFileService.listViewerFolder(
        'ws-local',
        'term-local',
        terminalFile(`${directory}/`)
      );
      workspaceServiceMock.get.mockReturnValue(sshWorkspace);
      sshWorkspaceServiceMock.run.mockImplementation(async (_host, command: string) =>
        execFileSync('/bin/sh', ['-c', command.replace(/^cd '[^']*' \|\| exit 1; /, '')], {
          encoding: 'utf8',
        })
      );
      const remote = await workspaceFileService.listViewerFolder(
        'ws-ssh',
        'term-ssh',
        terminalFile(`${directory}/`)
      );

      for (const listing of [local, remote]) {
        expect(listing.filter(({ name }) => name.endsWith('/'))).toHaveLength(200);
        expect(listing.slice(200).map(({ name }) => name)).toEqual(files);
      }
    }
  );

  itWithTerminalFiles(
    'reads and lists paths in the home folder of where the terminal runs',
    async () => {
      const { execFileSync } =
        await vi.importActual<typeof import('child_process')>('child_process');
      const home = await createViewerFolder();
      const { workspaceFileService } =
        await import('../../../src/main/services/workspace-file.service');
      const notes = expect.objectContaining({ data: Buffer.from('contents').toString('base64') });

      // On this computer, Komla's own home folder.
      vi.stubEnv('HOME', home);
      workspaceServiceMock.get.mockReturnValue(localWorkspace);
      await expect(
        workspaceFileService.readViewerFile('ws-local', 'term-local', terminalFile('~/notes.md'))
      ).resolves.toEqual(notes);
      await expect(
        workspaceFileService.listViewerFolder('ws-local', 'term-local', terminalFile('~/notes.md'))
      ).resolves.toEqual(VIEWER_FOLDER_FILES);
      await expect(
        workspaceFileService.listViewerFolder('ws-local', 'term-local', terminalFile('~/'))
      ).resolves.toEqual(VIEWER_FOLDER_FILES);

      // Over SSH, the SSH user's, which the script reads from its own HOME.
      vi.stubEnv('HOME', '/nonexistent');
      workspaceServiceMock.get.mockReturnValue(sshWorkspace);
      sshWorkspaceServiceMock.run.mockImplementation(async (_host, command: string) =>
        execFileSync('/bin/sh', ['-c', command.replace(/^cd '[^']*' \|\| exit 1; /, '')], {
          encoding: 'utf8',
          env: { ...process.env, HOME: home },
        })
      );
      await expect(
        workspaceFileService.readViewerFile('ws-ssh', 'term-ssh', terminalFile('~/notes.md'))
      ).resolves.toEqual(notes);
      await expect(
        workspaceFileService.listViewerFolder('ws-ssh', 'term-ssh', terminalFile('~/notes.md'))
      ).resolves.toEqual(VIEWER_FOLDER_FILES);
      await expect(
        workspaceFileService.listViewerFolder('ws-ssh', 'term-ssh', terminalFile('~/'))
      ).resolves.toEqual(VIEWER_FOLDER_FILES);

      // .. after a symlinked folder leaves where the link points, as the shell resolves it.
      await mkdir(join(home, 'nested.png', 'inner'));
      await writeFile(join(home, 'nested.png', 'notes.md'), 'elsewhere');
      await symlink(join(home, 'nested.png', 'inner'), join(home, 'linked'));
      const elsewhere = expect.objectContaining({
        data: Buffer.from('elsewhere').toString('base64'),
      });
      await expect(
        workspaceFileService.readViewerFile(
          'ws-ssh',
          'term-ssh',
          terminalFile('~/linked/../notes.md')
        )
      ).resolves.toEqual(elsewhere);
      vi.stubEnv('HOME', home);
      workspaceServiceMock.get.mockReturnValue(localWorkspace);
      await expect(
        workspaceFileService.readViewerFile(
          'ws-local',
          'term-local',
          terminalFile('~/linked/../notes.md')
        )
      ).resolves.toEqual(elsewhere);
    }
  );

  itWithTerminalFiles(
    'lists a host terminal folder itself when its path ends in a slash',
    async () => {
      const directory = await createViewerFolder();
      workspaceServiceMock.get.mockReturnValue(localWorkspace);
      const { workspaceFileService } =
        await import('../../../src/main/services/workspace-file.service');
      const list = (path: string) =>
        workspaceFileService.listViewerFolder('ws-local', 'term-local', terminalFile(path));

      await expect(list(`${directory}/`)).resolves.toEqual(VIEWER_FOLDER_FILES);
      await expect(list(join(directory, 'nested.png/'))).resolves.toEqual([]);
    }
  );

  itWithTerminalFiles('runs the remote folder listing script against a real folder', async () => {
    const { execFileSync } = await vi.importActual<typeof import('child_process')>('child_process');
    const directory = await createViewerFolder();
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    sshWorkspaceServiceMock.run.mockImplementation(async (_host, command: string) =>
      execFileSync('/bin/sh', ['-c', command.replace(/^cd '[^']*' \|\| exit 1; /, '')], {
        encoding: 'utf8',
      })
    );
    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    const list = (path: string) =>
      workspaceFileService.listViewerFolder('ws-ssh', 'term-ssh', terminalFile(path));

    await expect(list(join(directory, 'notes.md'))).resolves.toEqual(VIEWER_FOLDER_FILES);
    await expect(list(`${directory}/`)).resolves.toEqual(VIEWER_FOLDER_FILES);
    await expect(list(join(directory, 'missing', 'a.png'))).rejects.toThrow('ENOENT');
  });

  itWithPosixShell(
    'still lists a remote folder, without times, on a host without xargs',
    async () => {
      const { execFileSync } =
        await vi.importActual<typeof import('child_process')>('child_process');
      const directory = await createViewerFolder();
      // Only the commands the listing needs besides xargs, as in a minimal container image.
      const bin = await mkdtemp(join(tmpdir(), 'komla-workspace-file-bin-'));
      tempDirectories.push(bin);
      for (const command of ['ls', 'base64', 'tr', 'stat']) {
        const target = execFileSync('/bin/sh', ['-c', `command -v ${command}`], {
          encoding: 'utf8',
        });
        await symlink(target.trim(), join(bin, command));
      }
      workspaceServiceMock.get.mockReturnValue(sshWorkspace);
      sshWorkspaceServiceMock.run.mockImplementation(async (_host, command: string) =>
        execFileSync('/bin/sh', ['-c', command.replace(/^cd '[^']*' \|\| exit 1; /, '')], {
          encoding: 'utf8',
          env: { PATH: bin },
        })
      );
      const { workspaceFileService } =
        await import('../../../src/main/services/workspace-file.service');

      await expect(
        workspaceFileService.listViewerFolder(
          'ws-ssh',
          'term-ssh',
          terminalFile(join(directory, 'notes.md'))
        )
      ).resolves.toEqual(VIEWER_FOLDER_FILES.map(({ name }) => ({ name })));
    }
  );

  itWithPosixShell(
    'lists an SSH workspace folder only while it stays inside the workspace',
    async () => {
      const { execFileSync } =
        await vi.importActual<typeof import('child_process')>('child_process');
      const outside = await createViewerFolder();
      const remoteDirectory = await mkdtemp(join(tmpdir(), 'komla-workspace-file-test-'));
      tempDirectories.push(remoteDirectory);
      await mkdir(join(remoteDirectory, 'out'));
      await writeFile(join(remoteDirectory, 'out', 'shot.png'), 'contents');
      // A name `stat` could take for an option.
      const older = new Date(Date.UTC(2020, 0, 1));
      await writeFile(join(remoteDirectory, 'out', '-L.png'), 'contents');
      await utimes(join(remoteDirectory, 'out', '-L.png'), older, older);
      await symlink(outside, join(remoteDirectory, 'escape'));
      workspaceServiceMock.get.mockReturnValue({
        ...sshWorkspace,
        backend: { ...sshWorkspace.backend, remoteDirectory },
      });
      sshWorkspaceServiceMock.run.mockImplementation(async (_host, command: string) =>
        execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
      );
      const { workspaceFileService } =
        await import('../../../src/main/services/workspace-file.service');
      const list = (filePath: string) =>
        workspaceFileService.listViewerFolder('ws-ssh', 'term-ssh', workspaceFile(filePath));

      await expect(list('out/shot.png')).resolves.toEqual([
        { name: 'shot.png', modifiedMs: expect.any(Number) },
        { name: '-L.png', modifiedMs: older.getTime() },
      ]);
      await expect(list('out/')).resolves.toHaveLength(2);
      await expect(list('escape/notes.md')).rejects.toThrow('outside the workspace');
      await expect(list('escape/')).rejects.toThrow('outside the workspace');
      await expect(list('../notes.md')).rejects.toThrow();
    }
  );

  it('lists a local workspace folder and refuses paths outside it', async () => {
    const workingDirectory = await createViewerFolder();
    workspaceServiceMock.get.mockReturnValue({ ...localWorkspace, workingDirectory });
    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    const list = (filePath: string) =>
      workspaceFileService.listViewerFolder('ws-local', 'term-local', workspaceFile(filePath));

    await expect(list('notes.md')).resolves.toEqual(VIEWER_FOLDER_FILES);
    await expect(list('nested.png/')).resolves.toEqual([]);
    await expect(list('../notes.md')).rejects.toThrow();
    await expect(list('../')).rejects.toThrow();
  });

  it('fingerprints SSH files as the Remote Companion does, leaving out Komla imports', async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    const files = Buffer.from('src/app.ts\0notes.txt\0').toString('base64');
    const komlaFiles = Buffer.from('.komla-files/report.html\0').toString('base64');
    const deleted = Buffer.from('src/app.ts\0').toString('base64');
    sshWorkspaceServiceMock.run.mockResolvedValue(
      `STATUS=OK\nFILES=${files}\nKOMLA_FILES=${komlaFiles}\nIGNORED=\nDELETED=${deleted}\n`
    );

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    await expect(workspaceFileService.listFiles('ws-ssh')).resolves.toMatchObject({
      files: ['notes.txt', '.komla-files/report.html'],
      // native/src/repository/snapshot.rs checks its fingerprint against this value.
      fileListHash: '5e9250789ab8a815b3dcecd74f1f91dc7c84bda1d8ad05780909a8e60c779343',
    });
  });

  it('unpacks gzipped SSH listings before fingerprinting them', async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    const pack = (paths: string) => gzipSync(paths).toString('base64');
    sshWorkspaceServiceMock.run.mockResolvedValue(
      `STATUS=OK\nENCODING=gzip\nFILES=${pack('src/app.ts\0notes.txt\0')}\nKOMLA_FILES=${pack('')}\nPEERS=${pack('')}\nIGNORED=\nDELETED=${pack('src/app.ts\0')}\n`
    );

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    await expect(workspaceFileService.listFiles('ws-ssh')).resolves.toEqual({
      files: ['notes.txt'],
      gitIgnoredFiles: [],
      emptyDirs: [],
      fileListHash: '5e9250789ab8a815b3dcecd74f1f91dc7c84bda1d8ad05780909a8e60c779343',
    });
    expect(sshWorkspaceServiceMock.run.mock.calls[0][1]).toContain('gzip -c | komla_b64');
  });

  it('refuses a gzipped SSH listing larger than a local listing may be', async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    const oversized = gzipSync(Buffer.alloc(50 * 1024 * 1024 + 1)).toString('base64');
    sshWorkspaceServiceMock.run.mockResolvedValue(`STATUS=OK\nENCODING=gzip\nFILES=${oversized}\n`);

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    await expect(workspaceFileService.listFiles('ws-ssh')).rejects.toMatchObject({
      code: 'ERR_BUFFER_TOO_LARGE',
    });
  });

  it.runIf(process.platform !== 'win32')(
    'lists the same SSH files and fingerprint whether or not the host has gzip',
    async () => {
      const workspaceDirectory = await mkdtemp(join(tmpdir(), 'komla-workspace-gzip-test-'));
      tempDirectories.push(workspaceDirectory);
      await execFileAsync('git', ['init', '-q', workspaceDirectory]);
      await writeFile(join(workspaceDirectory, 'café.ts'), 'unicode');
      await writeFile(join(workspaceDirectory, 'removed.ts'), 'removed');
      await execFileAsync('git', ['-C', workspaceDirectory, 'add', 'café.ts', 'removed.ts']);
      await rm(join(workspaceDirectory, 'removed.ts'));
      await writeFile(join(workspaceDirectory, '.gitignore'), 'build/\n');
      await mkdir(join(workspaceDirectory, 'build'));
      await writeFile(join(workspaceDirectory, 'build', 'out.js'), 'ignored');
      workspaceServiceMock.get.mockReturnValue({
        ...sshWorkspace,
        backend: { ...sshWorkspace.backend, remoteDirectory: workspaceDirectory },
      });
      let hostHasGzip = true;
      const outputs: string[] = [];
      sshWorkspaceServiceMock.run.mockImplementation(async (_host, command: string) => {
        const script = hostHasGzip ? command : command.replace('command -v gzip', 'false');
        const { stdout } = await execFileAsync('/bin/sh', ['-c', script]);
        outputs.push(stdout);
        return stdout;
      });

      const { workspaceFileService } =
        await import('../../../src/main/services/workspace-file.service');
      const gzipped = await workspaceFileService.listFiles('ws-ssh', true);
      hostHasGzip = false;
      const plain = await workspaceFileService.listFiles('ws-ssh', true);

      expect(outputs[0]).toContain('ENCODING=gzip\n');
      expect(outputs[1]).toContain('ENCODING=plain\n');
      expect(plain).toEqual(gzipped);
      expect([...gzipped.files].sort()).toEqual(['.gitignore', 'café.ts']);
      expect(gzipped.gitIgnoredFiles).toEqual(['build/out.js']);
      expect(gzipped.fileListHash).toMatch(/^[0-9a-f]{64}$/);
    }
  );

  it("lists an SSH workspace's own files in one call, without its linked workspaces", async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    const files = gzipSync('public/favicon.svg\0README.md\0').toString('base64');
    sshWorkspaceServiceMock.run.mockResolvedValue(`STATUS=OK\nENCODING=gzip\nFILES=${files}\n`);

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    await expect(workspaceFileService.listRemoteGitFiles('ws-ssh')).resolves.toEqual([
      'public/favicon.svg',
      'README.md',
    ]);
    expect(sshWorkspaceServiceMock.run).toHaveBeenCalledTimes(1);
    const script = sshWorkspaceServiceMock.run.mock.calls[0][1];
    expect(script).toContain("cd '/home/dev/repo'");
    expect(script).toContain('git ls-files --cached --others --exclude-standard -z');
    expect(script).not.toContain('linked-workspaces');
  });

  it("fails an SSH workspace's listing that the host didn't finish", async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    sshWorkspaceServiceMock.run.mockResolvedValue('');

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    await expect(workspaceFileService.listRemoteGitFiles('ws-ssh')).rejects.toThrow(
      'Failed to list remote files'
    );
  });

  it('lists tracked, untracked, and ignored SSH files', async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    const files = Buffer.from('src/app.ts\0notes.txt\0').toString('base64');
    const ignored = Buffer.from('build/output.js\0').toString('base64');
    const deleted = Buffer.from('src/app.ts\0').toString('base64');
    sshWorkspaceServiceMock.run.mockResolvedValue(
      `STATUS=OK\nFILES=${files}\nIGNORED=${ignored}\nDELETED=${deleted}\n`
    );

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    await expect(workspaceFileService.listFiles('ws-ssh', true)).resolves.toEqual({
      files: ['notes.txt'],
      gitIgnoredFiles: ['build/output.js'],
      emptyDirs: [],
      fileListHash: expect.any(String),
    });
    expect(sshWorkspaceServiceMock.run.mock.calls[0][1]).toContain("cd '/home/dev/repo'");
    expect(sshWorkspaceServiceMock.run.mock.calls[0][1]).toContain('--exclude-standard -z');
    expect(sshWorkspaceServiceMock.run.mock.calls[0][1]).toContain('git ls-files --deleted -z');
    expect(sshWorkspaceServiceMock.run.mock.calls[0][2]).toEqual({
      purpose: { kind: 'interactive' },
    });
  });

  it('lists Komla imports without enabling all ignored SSH files', async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    const files = Buffer.from('src/app.ts\0').toString('base64');
    const komlaFiles = Buffer.from('.komla-files/report.html\0').toString('base64');
    const ignored = Buffer.from('.komla-files/report.html\0build/output.js\0').toString('base64');
    sshWorkspaceServiceMock.run.mockResolvedValue(
      `STATUS=OK\nFILES=${files}\nKOMLA_FILES=${komlaFiles}\nIGNORED=${ignored}\n`
    );

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    await expect(workspaceFileService.listFiles('ws-ssh', true)).resolves.toEqual({
      files: ['src/app.ts', '.komla-files/report.html'],
      gitIgnoredFiles: ['build/output.js'],
      emptyDirs: [],
      fileListHash: expect.any(String),
    });
    expect(sshWorkspaceServiceMock.run.mock.calls[0][1]).toContain(
      'find "$komla_files_dir" -type f ! -path "$komla_gitignore" -print0'
    );
  });

  it('does not list SSH files while the remote workspace is provisioning', async () => {
    workspaceServiceMock.get.mockReturnValue({ ...sshWorkspace, provisioning: true });

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');

    await expect(workspaceFileService.listFiles('ws-ssh')).resolves.toEqual({
      files: [],
      gitIgnoredFiles: [],
      emptyDirs: [],
    });
    expect(sshWorkspaceServiceMock.run).not.toHaveBeenCalled();
  });

  it('leaves linked workspaces out of an SSH listing, which the file panel shows apart', async () => {
    workspaceServiceMock.get.mockReturnValue({ ...sshWorkspace, linkedWorkspaceIds: ['ws-peer'] });
    const list = (paths: string[]) =>
      Buffer.from(paths.map((path) => `${path}\0`).join('')).toString('base64');
    sshWorkspaceServiceMock.run.mockResolvedValue(
      [
        'STATUS=OK',
        'ENCODING=plain',
        `FILES=${list(['README.md', 'linked-workspaces/NOTES.md'])}`,
        'KOMLA_FILES=',
        `IGNORED=${list(['linked-workspaces/peer', 'linked-workspaces/NOTES.local', 'dist/out.js'])}`,
        'DELETED=',
        '',
      ].join('\n')
    );

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    await expect(workspaceFileService.listFiles('ws-ssh', true)).resolves.toMatchObject({
      // A project's own file there stays; the links are ignored files.
      files: ['README.md', 'linked-workspaces/NOTES.md'],
      gitIgnoredFiles: ['dist/out.js'],
      emptyDirs: [],
    });
    expect(sshWorkspaceServiceMock.run).toHaveBeenCalledOnce();
    expect(sshWorkspaceServiceMock.run.mock.calls[0][1]).not.toContain('linked-workspaces');
  });

  it('reads SSH text and image files', async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    sshWorkspaceServiceMock.run
      .mockResolvedValueOnce(`STATUS=OK\nDATA=${Buffer.from('hello').toString('base64')}\n`)
      .mockResolvedValueOnce(`STATUS=OK\nDATA=${Buffer.from('image').toString('base64')}\n`);

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    await expect(workspaceFileService.readFile('ws-ssh', 'README.md')).resolves.toBe('hello');
    await expect(workspaceFileService.readImageFile('ws-ssh', 'logo.png')).resolves.toEqual({
      data: Buffer.from('image').toString('base64'),
      mimeType: 'image/png',
    });
    expect(sshWorkspaceServiceMock.run.mock.calls[0][2]).toEqual({
      purpose: { kind: 'interactive' },
    });
    expect(sshWorkspaceServiceMock.run.mock.calls[1][2]).toEqual({
      purpose: { kind: 'interactive' },
    });
  });

  it('rejects noncanonical SSH read paths before invoking the remote shell', async () => {
    workspaceServiceMock.get.mockReturnValue({
      ...sshWorkspace,
      linkedWorkspaceIds: ['ws-peer'],
    });

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    await expect(
      workspaceFileService.readFile(
        'ws-ssh',
        'linked-workspaces/peer/../../other-project/branch/.env'
      )
    ).rejects.toThrow('canonical relative path');

    expect(sshWorkspaceServiceMock.run).not.toHaveBeenCalled();
  });

  it('deletes SSH files or directories without following symlinks', async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    sshWorkspaceServiceMock.run.mockResolvedValue('STATUS=OK\n');

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    await expect(
      workspaceFileService.deletePath('ws-ssh', 'src/generated')
    ).resolves.toBeUndefined();

    const command = sshWorkspaceServiceMock.run.mock.calls[0][1];
    expect(command).toContain("cd '/home/dev/repo'");
    expect(command).toContain("target='src/generated'");
    expect(command).toContain('workspace_root=$(pwd -P)');
    expect(command).toContain('canonical_parent=$(pwd -P)');
    expect(command).toContain('STATUS=UNSAFE');
    expect(command).toContain('target=./"$name"');
    expect(command).toContain('if [ -L "$target" ] || [ -f "$target" ]; then');
    expect(command).toContain('rm -f -- "$target"');
    expect(command).toContain('elif [ -d "$target" ]; then');
    expect(command).toContain('rm -rf -- "$target"');
    expect(sshWorkspaceServiceMock.run.mock.calls[0][2]).toEqual({
      purpose: { kind: 'interactive' },
    });
    expect(workspaceStatusServiceMock.change).toHaveBeenCalledWith({
      kind: 'repository-mutated',
      workspaceId: 'ws-ssh',
    });
  });

  it('refreshes the verified SSH peer after deleting one of its files', async () => {
    workspaceServiceMock.get.mockImplementation((id) =>
      id === sshWorkspace.id
        ? sshWorkspace
        : id === linkedSshWorkspace.id
          ? linkedSshWorkspace
          : undefined
    );
    sshWorkspaceServiceMock.run.mockResolvedValue('STATUS=OK\nPEER_ID=ws-peer\n');

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    await workspaceFileService.deletePath('ws-ssh', 'linked-workspaces/peer/src/index.ts');

    expect(workspaceStatusServiceMock.change).toHaveBeenCalledWith({
      kind: 'repository-mutated',
      workspaceId: 'ws-peer',
    });
  });

  it('rejects direct deletion of the managed SSH link root', async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    await expect(workspaceFileService.deletePath('ws-ssh', 'linked-workspaces')).rejects.toThrow(
      'linked workspace'
    );

    expect(sshWorkspaceServiceMock.run).not.toHaveBeenCalled();
  });

  it('rejects direct deletion of a verified SSH workspace link', async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    sshWorkspaceServiceMock.run.mockResolvedValue('STATUS=MANAGED_LINK\n');

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    await expect(
      workspaceFileService.deletePath('ws-ssh', 'linked-workspaces/peer')
    ).rejects.toThrow('linked workspace');

    expect(sshWorkspaceServiceMock.run.mock.calls[0][1]).toContain(
      'komla_recorded_peer_root "$target"'
    );
  });

  it('allows deleting ordinary content directly under linked-workspaces', async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    sshWorkspaceServiceMock.run.mockResolvedValue('STATUS=OK\n');

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    await expect(
      workspaceFileService.deletePath('ws-ssh', 'linked-workspaces/notes.txt')
    ).resolves.toBeUndefined();

    expect(sshWorkspaceServiceMock.run).toHaveBeenCalledOnce();
    expect(sshWorkspaceServiceMock.run.mock.calls[0][1]).toContain(
      'komla_recorded_peer_root "$target"'
    );
  });

  it.runIf(process.platform !== 'win32')(
    'deletes files inside a recorded SSH peer without allowing other linked targets',
    async () => {
      const workspaceDirectory = await mkdtemp(join(tmpdir(), 'komla-workspace-delete-test-'));
      const peerDirectory = await mkdtemp(join(tmpdir(), 'komla-workspace-delete-peer-test-'));
      const unrelatedDirectory = await mkdtemp(
        join(tmpdir(), 'komla-workspace-delete-unrelated-test-')
      );
      tempDirectories.push(workspaceDirectory, peerDirectory, unrelatedDirectory);
      await mkdir(join(workspaceDirectory, 'linked-workspaces'));
      await symlink(peerDirectory, join(workspaceDirectory, 'linked-workspaces', 'peer'));
      await symlink(unrelatedDirectory, join(workspaceDirectory, 'linked-workspaces', 'unrelated'));
      await symlink(unrelatedDirectory, join(peerDirectory, 'escape'));
      await mkdir(join(peerDirectory, 'configs'));
      await writeFile(join(peerDirectory, 'configs', 'default.json'), 'safe symlink');
      await symlink('configs/default.json', join(peerDirectory, 'current-config.json'));
      await writeFile(join(peerDirectory, 'delete.txt'), 'delete');
      await writeFile(join(unrelatedDirectory, 'keep.txt'), 'keep');
      await symlink(join(unrelatedDirectory, 'keep.txt'), join(peerDirectory, 'leak.txt'));
      await writeFile(join(workspaceDirectory, 'linked-workspaces', 'notes.txt'), 'notes');
      const origin = {
        ...sshWorkspace,
        linkedWorkspaceIds: ['ws-peer'],
        backend: { ...sshWorkspace.backend, remoteDirectory: workspaceDirectory },
      };
      const peer = {
        ...linkedSshWorkspace,
        backend: { ...linkedSshWorkspace.backend, remoteDirectory: peerDirectory },
      };
      workspaceServiceMock.get.mockImplementation((id) =>
        id === origin.id ? origin : id === peer.id ? peer : undefined
      );
      sshWorkspaceServiceMock.run.mockImplementation(async (_host, command) => {
        const result = await execFileAsync('/bin/sh', ['-c', command]);
        return result.stdout;
      });

      const { workspaceFileService } =
        await import('../../../src/main/services/workspace-file.service');
      await expect(
        workspaceFileService.readFile('ws-ssh', 'linked-workspaces/peer/delete.txt')
      ).resolves.toBe('delete');
      await expect(
        workspaceFileService.readFile('ws-ssh', 'linked-workspaces/peer/current-config.json')
      ).resolves.toBe('safe symlink');
      await expect(
        workspaceFileService.readFile('ws-ssh', 'linked-workspaces/peer/leak.txt')
      ).rejects.toThrow('outside the workspace');
      await expect(
        workspaceFileService.readFile('ws-ssh', 'linked-workspaces/unrelated/keep.txt')
      ).rejects.toThrow('outside the workspace');
      await expect(
        workspaceFileService.readFile('ws-ssh', 'linked-workspaces/peer/escape/keep.txt')
      ).rejects.toThrow('outside the workspace');
      await expect(
        workspaceFileService.deletePath('ws-ssh', 'linked-workspaces/peer/delete.txt')
      ).resolves.toBeUndefined();
      await expect(
        workspaceFileService.deletePath('ws-ssh', 'linked-workspaces/unrelated/keep.txt')
      ).rejects.toThrow('outside the workspace');
      await expect(
        workspaceFileService.deletePath('ws-ssh', 'linked-workspaces/peer')
      ).rejects.toThrow('linked workspace');
      await expect(
        workspaceFileService.deletePath('ws-ssh', 'linked-workspaces/notes.txt')
      ).resolves.toBeUndefined();

      await expect(access(join(peerDirectory, 'delete.txt'))).rejects.toThrow();
      await expect(
        access(join(workspaceDirectory, 'linked-workspaces', 'peer'))
      ).resolves.toBeUndefined();
      await expect(
        access(join(workspaceDirectory, 'linked-workspaces', 'notes.txt'))
      ).rejects.toThrow();
      await expect(access(join(unrelatedDirectory, 'keep.txt'))).resolves.toBeUndefined();
      expect(workspaceStatusServiceMock.change).toHaveBeenCalledWith({
        kind: 'repository-mutated',
        workspaceId: 'ws-peer',
      });
    }
  );

  itWithPosixShell('rejects deletion through a symlinked ancestor', async () => {
    const workspaceDirectory = await mkdtemp(join(tmpdir(), 'komla-workspace-delete-test-'));
    const outsideDirectory = await mkdtemp(join(tmpdir(), 'komla-workspace-delete-outside-'));
    tempDirectories.push(workspaceDirectory, outsideDirectory);
    await writeFile(join(outsideDirectory, 'generated'), 'keep');
    await symlink(outsideDirectory, join(workspaceDirectory, 'src'));
    workspaceServiceMock.get.mockReturnValue({
      ...sshWorkspace,
      backend: { ...sshWorkspace.backend, remoteDirectory: workspaceDirectory },
    });
    sshWorkspaceServiceMock.run.mockImplementation(async (_host, command) => {
      const result = await execFileAsync('/bin/sh', ['-c', command]);
      return result.stdout;
    });

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    await expect(workspaceFileService.deletePath('ws-ssh', 'src/generated')).rejects.toThrow(
      'outside the workspace'
    );

    await expect(access(join(outsideDirectory, 'generated'))).resolves.toBeUndefined();
    expect(workspaceStatusServiceMock.change).not.toHaveBeenCalled();
  });

  itWithPosixShell('keeps SSH deletion anchored when a checked ancestor is replaced', async () => {
    const workspaceDirectory = await mkdtemp(join(tmpdir(), 'komla-workspace-delete-race-test-'));
    const outsideDirectory = await mkdtemp(join(tmpdir(), 'komla-workspace-delete-race-outside-'));
    const helperDirectory = await mkdtemp(join(tmpdir(), 'komla-workspace-delete-race-bin-'));
    tempDirectories.push(workspaceDirectory, outsideDirectory, helperDirectory);
    await mkdir(join(workspaceDirectory, 'src'));
    await writeFile(join(workspaceDirectory, 'src', 'generated'), 'delete');
    await writeFile(join(outsideDirectory, 'generated'), 'keep');
    const fakeRmPath = join(helperDirectory, 'rm');
    await writeFile(
      fakeRmPath,
      [
        '#!/bin/sh',
        'mv "$KOMLA_DELETE_RACE_WORKSPACE/src" "$KOMLA_DELETE_RACE_WORKSPACE/src-original"',
        'ln -s "$KOMLA_DELETE_RACE_OUTSIDE" "$KOMLA_DELETE_RACE_WORKSPACE/src"',
        'exec /bin/rm "$@"',
      ].join('\n')
    );
    await chmod(fakeRmPath, 0o755);
    vi.stubEnv('KOMLA_DELETE_RACE_WORKSPACE', workspaceDirectory);
    vi.stubEnv('KOMLA_DELETE_RACE_OUTSIDE', outsideDirectory);
    vi.stubEnv('PATH', `${helperDirectory}:${process.env.PATH ?? ''}`);
    workspaceServiceMock.get.mockReturnValue({
      ...sshWorkspace,
      backend: { ...sshWorkspace.backend, remoteDirectory: workspaceDirectory },
    });
    sshWorkspaceServiceMock.run.mockImplementation(async (_host, command) => {
      const result = await execFileAsync('/bin/sh', ['-c', command]);
      return result.stdout;
    });

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    await expect(
      workspaceFileService.deletePath('ws-ssh', 'src/generated')
    ).resolves.toBeUndefined();

    await expect(access(join(outsideDirectory, 'generated'))).resolves.toBeUndefined();
    await expect(access(join(workspaceDirectory, 'src-original', 'generated'))).rejects.toThrow();
  });

  itWithPosixShell('deletes the exact whitespace-sensitive SSH filename', async () => {
    const workspaceDirectory = await mkdtemp(join(tmpdir(), 'komla-workspace-delete-space-test-'));
    tempDirectories.push(workspaceDirectory);
    await writeFile(join(workspaceDirectory, 'report'), 'keep');
    await writeFile(join(workspaceDirectory, 'report '), 'delete');
    workspaceServiceMock.get.mockReturnValue({
      ...sshWorkspace,
      backend: { ...sshWorkspace.backend, remoteDirectory: workspaceDirectory },
    });
    sshWorkspaceServiceMock.run.mockImplementation(async (_host, command) => {
      const result = await execFileAsync('/bin/sh', ['-c', command]);
      return result.stdout;
    });

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    await expect(workspaceFileService.deletePath('ws-ssh', 'report ')).resolves.toBeUndefined();

    await expect(access(join(workspaceDirectory, 'report'))).resolves.toBeUndefined();
    await expect(access(join(workspaceDirectory, 'report '))).rejects.toThrow();
  });

  it('rejects escaping and missing SSH deletion targets', async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');

    await expect(workspaceFileService.deletePath('ws-ssh', '../outside')).rejects.toThrow(
      'escapes the workspace'
    );
    expect(sshWorkspaceServiceMock.run).not.toHaveBeenCalled();

    sshWorkspaceServiceMock.run.mockResolvedValue('STATUS=NOT_FOUND\n');
    await expect(workspaceFileService.deletePath('ws-ssh', 'missing.txt')).rejects.toThrow(
      'no such file or directory'
    );
  });

  it('refreshes SSH state when a remote deletion command partially fails', async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    sshWorkspaceServiceMock.run.mockRejectedValue(new Error('rm: permission denied'));

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');

    await expect(workspaceFileService.deletePath('ws-ssh', 'generated')).rejects.toThrow(
      'permission denied'
    );
    expect(workspaceStatusServiceMock.change).toHaveBeenCalledWith({
      kind: 'repository-mutated',
      workspaceId: 'ws-ssh',
    });
  });

  it('rejects escaping and oversized SSH files', async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');

    await expect(workspaceFileService.readFile('ws-ssh', '../secret')).rejects.toThrow(
      'escapes the workspace'
    );
    expect(sshWorkspaceServiceMock.run).not.toHaveBeenCalled();

    sshWorkspaceServiceMock.run.mockResolvedValue('STATUS=TOO_LARGE\nSIZE=9999999\n');
    await expect(workspaceFileService.readFile('ws-ssh', 'large.txt')).rejects.toThrow(
      'too large to view'
    );
  });

  it('delegates local writes to gitService', async () => {
    workspaceServiceMock.get.mockReturnValue(localWorkspace);

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    await expect(
      workspaceFileService.writeFile('ws-local', 'src/app.ts', 'content')
    ).resolves.toBeUndefined();

    expect(gitServiceMock.writeFile).toHaveBeenCalledWith(
      '/repo/worktree',
      'src/app.ts',
      'content'
    );

    await expect(
      workspaceFileService.writeFile('ws-local', '../outside', 'content')
    ).rejects.toThrow('escapes the allowed root path');
    expect(gitServiceMock.writeFile).toHaveBeenCalledTimes(1);
  });

  itWithPosixShell('writes SSH files in place without changing their mode', async () => {
    const workspaceDirectory = await mkdtemp(join(tmpdir(), 'komla-workspace-write-test-'));
    tempDirectories.push(workspaceDirectory);
    await mkdir(join(workspaceDirectory, 'scripts'));
    await writeFile(join(workspaceDirectory, 'scripts', 'run.sh'), 'old');
    await chmod(join(workspaceDirectory, 'scripts', 'run.sh'), 0o755);
    workspaceServiceMock.get.mockReturnValue({
      ...sshWorkspace,
      backend: { ...sshWorkspace.backend, remoteDirectory: workspaceDirectory },
    });
    sshWorkspaceServiceMock.runWithInput.mockImplementation(async (_host, command, input) =>
      execShWithInput(command, input)
    );

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    await expect(
      workspaceFileService.writeFile('ws-ssh', 'scripts/run.sh', 'echo "héllo"\n')
    ).resolves.toBeUndefined();

    await expect(readFile(join(workspaceDirectory, 'scripts', 'run.sh'), 'utf8')).resolves.toBe(
      'echo "héllo"\n'
    );
    expect((await stat(join(workspaceDirectory, 'scripts', 'run.sh'))).mode & 0o777).toBe(0o755);
    expect(sshWorkspaceServiceMock.runWithInput.mock.calls[0][3]).toEqual({
      purpose: { kind: 'interactive' },
    });
    expect(workspaceStatusServiceMock.change).toHaveBeenCalledWith({
      kind: 'repository-mutated',
      workspaceId: 'ws-ssh',
    });
  });

  itWithPosixShell(
    'writes through SSH symlinks only when they stay inside the workspace',
    async () => {
      const workspaceDirectory = await mkdtemp(join(tmpdir(), 'komla-workspace-write-test-'));
      const outsideDirectory = await mkdtemp(join(tmpdir(), 'komla-workspace-write-outside-'));
      tempDirectories.push(workspaceDirectory, outsideDirectory);
      await mkdir(join(workspaceDirectory, 'configs'));
      await writeFile(join(workspaceDirectory, 'configs', 'default.json'), 'old');
      await symlink('configs/default.json', join(workspaceDirectory, 'current.json'));
      await writeFile(join(outsideDirectory, 'keep.txt'), 'keep');
      await symlink(join(outsideDirectory, 'keep.txt'), join(workspaceDirectory, 'leak.txt'));
      await symlink(outsideDirectory, join(workspaceDirectory, 'escape'));
      await writeFile(join(workspaceDirectory, 'komla-root-probe.txt'), 'keep');
      await symlink('/komla-root-probe.txt', join(workspaceDirectory, 'root-alias.txt'));
      workspaceServiceMock.get.mockReturnValue({
        ...sshWorkspace,
        backend: { ...sshWorkspace.backend, remoteDirectory: workspaceDirectory },
      });
      sshWorkspaceServiceMock.runWithInput.mockImplementation(async (_host, command, input) =>
        execShWithInput(command, input)
      );
      sshWorkspaceServiceMock.run.mockImplementation(async (_host, command) => {
        const result = await execFileAsync('/bin/sh', ['-c', command]);
        return result.stdout;
      });

      const { workspaceFileService } =
        await import('../../../src/main/services/workspace-file.service');
      await expect(
        workspaceFileService.writeFile('ws-ssh', 'current.json', 'new')
      ).resolves.toBeUndefined();
      await expect(
        workspaceFileService.writeFile('ws-ssh', 'leak.txt', 'overwritten')
      ).rejects.toThrow('outside the workspace');
      await expect(
        workspaceFileService.writeFile('ws-ssh', 'escape/keep.txt', 'overwritten')
      ).rejects.toThrow('outside the workspace');
      await expect(
        workspaceFileService.writeFile('ws-ssh', 'root-alias.txt', 'overwritten')
      ).rejects.toThrow('outside the workspace');
      await expect(workspaceFileService.readFile('ws-ssh', 'root-alias.txt')).rejects.toThrow(
        'outside the workspace'
      );
      await expect(workspaceFileService.writeFile('ws-ssh', 'configs', 'new')).rejects.toThrow(
        'not a regular file'
      );

      await expect(
        readFile(join(workspaceDirectory, 'configs', 'default.json'), 'utf8')
      ).resolves.toBe('new');
      expect((await lstat(join(workspaceDirectory, 'current.json'))).isSymbolicLink()).toBe(true);
      await expect(readFile(join(outsideDirectory, 'keep.txt'), 'utf8')).resolves.toBe('keep');
      await expect(
        readFile(join(workspaceDirectory, 'komla-root-probe.txt'), 'utf8')
      ).resolves.toBe('keep');
    }
  );

  itWithPosixShell('keeps the SSH file unchanged when the upload is truncated', async () => {
    const workspaceDirectory = await mkdtemp(join(tmpdir(), 'komla-workspace-write-test-'));
    tempDirectories.push(workspaceDirectory);
    await writeFile(join(workspaceDirectory, 'notes.txt'), 'old');
    workspaceServiceMock.get.mockReturnValue({
      ...sshWorkspace,
      backend: { ...sshWorkspace.backend, remoteDirectory: workspaceDirectory },
    });
    sshWorkspaceServiceMock.runWithInput.mockImplementation(async (_host, command, input) =>
      execShWithInput(command, input.slice(0, 2))
    );

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    await expect(
      workspaceFileService.writeFile('ws-ssh', 'notes.txt', 'new notes')
    ).rejects.toThrow('Incomplete upload');

    await expect(readFile(join(workspaceDirectory, 'notes.txt'), 'utf8')).resolves.toBe('old');
  });

  it('refreshes SSH state when a remote write command fails', async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    sshWorkspaceServiceMock.runWithInput.mockRejectedValue(new Error('No space left on device'));

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    await expect(workspaceFileService.writeFile('ws-ssh', 'notes.txt', 'new')).rejects.toThrow(
      'No space left on device'
    );

    expect(workspaceStatusServiceMock.change).toHaveBeenCalledWith({
      kind: 'repository-mutated',
      workspaceId: 'ws-ssh',
    });
  });

  it('refreshes the verified SSH peer after writing one of its files', async () => {
    mockLinkedSshPair();
    sshWorkspaceServiceMock.runWithInput.mockResolvedValue('STATUS=OK\nPEER_ID=ws-peer\n');

    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    await workspaceFileService.writeFile('ws-ssh', 'linked-workspaces/peer/src/index.ts', 'x');

    expect(sshWorkspaceServiceMock.runWithInput.mock.calls[0][1]).toContain(
      "komla_recorded_peer_root 'linked-workspaces/peer'"
    );
    expect(workspaceStatusServiceMock.change).toHaveBeenCalledWith({
      kind: 'repository-mutated',
      workspaceId: 'ws-peer',
    });
  });

  it('rejects noncanonical and missing SSH write targets', async () => {
    workspaceServiceMock.get.mockReturnValue(sshWorkspace);
    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');

    await expect(workspaceFileService.writeFile('ws-ssh', '../outside', 'x')).rejects.toThrow(
      'escapes the workspace'
    );
    await expect(workspaceFileService.writeFile('ws-ssh', 'src/../app.ts', 'x')).rejects.toThrow(
      'canonical relative path'
    );
    expect(sshWorkspaceServiceMock.runWithInput).not.toHaveBeenCalled();

    sshWorkspaceServiceMock.runWithInput.mockResolvedValue('STATUS=NOT_FOUND\n');
    await expect(workspaceFileService.writeFile('ws-ssh', 'missing/app.ts', 'x')).rejects.toThrow(
      'no such file or directory'
    );
  });
});
