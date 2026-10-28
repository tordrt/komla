import { vi, describe, it, expect, beforeEach } from 'vitest';
import { mockElectron } from '../../mocks/electron';
import { createVirtualFs, VirtualFilesystem } from '../../mocks/fs';
import { createWorktreeWorkspace, resetIdCounter } from '../../factories';

// Mock atomic-write
const mockWriteFileAtomic = vi.fn(() => Promise.resolve());
vi.doMock('../../../src/main/lib/atomic-write', () => ({
  writeFileAtomic: mockWriteFileAtomic,
}));

describe('Workspace Stale Cleanup', () => {
  let mockVfs: VirtualFilesystem;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetIdCounter();
    mockWriteFileAtomic.mockClear();

    mockVfs = createVirtualFs();
    mockVfs.setFile('/mock/home/.komla/workspaces.json', '[]');

    vi.doMock('electron', () => mockElectron());

    vi.doMock('fs', () => ({
      existsSync: vi.fn((path) => mockVfs.mock.existsSync(path)),
      readFileSync: vi.fn((path, enc) => mockVfs.mock.readFileSync(path, enc)),
      writeFileSync: vi.fn((path, data) => mockVfs.mock.writeFileSync(path, data)),
      mkdirSync: vi.fn((path) => mockVfs.mock.mkdirSync(path)),
      rmSync: vi.fn((path) => mockVfs.mock.rmSync(path)),
    }));

    vi.doMock('../../../src/main/services/git.service', () => ({
      gitService: {
        deleteWorktree: vi.fn(() => Promise.resolve()),
        registerTargetBranch: vi.fn(),
        setManagedWorktreeLookup: vi.fn(),
      },
    }));

    vi.doMock('../../../src/main/services/pty.service', () => ({
      ptyService: {
        kill: vi.fn(),
        onAbort: vi.fn(),
        onAnswerKey: vi.fn(),
        onExit: vi.fn(),
        onSshTerminalPoolAssignment: vi.fn(),
        onManagedRemoteTerminalSessionReplaced: vi.fn(),
        onStatus: vi.fn(),
      },
    }));

    vi.doMock('../../../src/main/services/project.service', () => ({
      projectService: {
        get: vi.fn(() => null),
        list: vi.fn(() => []),
      },
    }));

    vi.doMock('../../../src/main/services/worktree-watcher.service', () => ({
      worktreeWatcherService: { stopWatching: vi.fn(() => Promise.resolve()) },
    }));

    vi.doMock('../../../src/main/services/background-process.service', () => ({
      backgroundProcessService: {
        killForWorkspace: vi.fn(),
        killForWorkspaceAndWait: vi.fn(() => Promise.resolve()),
      },
    }));

    vi.doMock('../../../src/main/services/http-server.service', () => ({
      httpServerService: { clearAttention: vi.fn() },
    }));

    vi.doMock('../../../src/main/services/window.service', () => ({
      windowService: { getMainWindowId: vi.fn(() => 'main-window') },
    }));

    vi.doMock('../../../src/main/services/paths', () => ({
      getKomlaBasePath: vi.fn(() => '/mock/home/.komla'),
      ensureKomlaBasePath: vi.fn(() => '/mock/home/.komla'),
    }));

    vi.doMock('../../../src/main/services/metrics-collector.service', () => ({
      metricsCollectorService: {
        increment: vi.fn(),
        incrementAction: vi.fn(),
        incrementMcpTool: vi.fn(),
      },
    }));

    vi.doMock('../../../src/main/lib/logger', () => ({
      createLogger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    }));
  });

  it('should remove workspaces whose directory no longer exists on startup', async () => {
    const existing = createWorktreeWorkspace({ id: 'ws-good', workingDirectory: '/mock/exists' });
    const stale = createWorktreeWorkspace({ id: 'ws-stale', workingDirectory: '/mock/gone' });
    mockVfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify([existing, stale]));
    mockVfs.mock.mkdirSync('/mock/exists');

    const { workspaceService } = await import('../../../src/main/services/workspace.service');
    await vi.runAllTimersAsync();

    const ids = workspaceService.list().map((ws) => ws.id);
    expect(ids).toContain('ws-good');
    expect(ids).not.toContain('ws-stale');
    expect(mockWriteFileAtomic).toHaveBeenCalled();
  });

  it('should not save if all workspaces are valid', async () => {
    const workspace = createWorktreeWorkspace({ id: 'ws-ok', workingDirectory: '/mock/valid' });
    mockVfs.setFile('/mock/home/.komla/workspaces.json', JSON.stringify([workspace]));
    mockVfs.mock.mkdirSync('/mock/valid');

    await import('../../../src/main/services/workspace.service');
    await vi.runAllTimersAsync();

    expect(mockWriteFileAtomic).not.toHaveBeenCalled();
  });
});
