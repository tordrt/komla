import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mockElectron } from '../../mocks/electron';
import { createVirtualFs } from '../../mocks/fs';
import {
  createExecMock,
  createExecFileMock,
  createSpawnMock,
  mockChildProcess,
} from '../../mocks/child-process';

// Set up mocks
vi.mock('electron', () => mockElectron());

const vfs = createVirtualFs();
vi.mock('fs', () => vfs.mock);

const execMock = createExecMock();
const execFileMock = createExecFileMock();
const spawnMock = createSpawnMock();
vi.mock('child_process', () => mockChildProcess(execMock, spawnMock, execFileMock));

// Mock askpass service
const mockAskpass = {
  isRunning: vi.fn(),
  getHelperScriptPath: vi.fn(),
  getSocketPath: vi.fn(),
  issueSession: vi.fn(() => 'askpass-session'),
};

vi.mock('../../../src/main/services/askpass.service', () => ({
  askpassService: mockAskpass,
}));

describe('GitService Remote Validation', () => {
  beforeEach(() => {
    vi.resetModules();
    execMock.clearMocks();
    execFileMock.clearMocks();
    spawnMock.clearProcesses();
    vfs.clear();

    // Default askpass to not running
    mockAskpass.isRunning.mockReturnValue(false);
    mockAskpass.getHelperScriptPath.mockReturnValue(null);
    mockAskpass.getSocketPath.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should validate accessible remote URL', async () => {
    const { gitService } = await import('../../../src/main/services/git.service');

    const validatePromise = gitService.validateRemoteUrl('git@github.com:owner/repo.git');

    // Get the spawned process
    const process = spawnMock.getLatestProcess();
    expect(process).toBeDefined();
    expect(process?._command).toBe('git');
    expect(process?._args).toEqual([
      'ls-remote',
      '--exit-code',
      'git@github.com:owner/repo.git',
      'HEAD',
    ]);

    // Simulate success
    spawnMock.simulateExit(process!.pid, 0);

    const result = await validatePromise;
    expect(result).toEqual({ valid: true });
  });

  it('should return error for non-existent repository', async () => {
    const { gitService } = await import('../../../src/main/services/git.service');

    const validatePromise = gitService.validateRemoteUrl('https://github.com/owner/missing.git');

    const process = spawnMock.getLatestProcess();
    expect(process).toBeDefined();

    // Simulate failure output
    spawnMock.simulateOutput(
      process!.pid,
      'stderr',
      "remote: Repository not found.\nfatal: repository 'https://github.com/owner/missing.git/' not found\n"
    );
    spawnMock.simulateExit(process!.pid, 128);

    const result = await validatePromise;
    expect(result).toEqual({
      valid: false,
      error: 'Repository not found',
    });
  });

  it('refuses a URL git would read as an option without running git', async () => {
    const { gitService } = await import('../../../src/main/services/git.service');

    await expect(gitService.validateRemoteUrl('--upload-pack=x')).resolves.toEqual({
      valid: false,
      error: 'A Git URL can\'t start with "-".',
    });
    expect(spawnMock.getLatestProcess()).toBeUndefined();
  });

  it('should handle authentication failure messages', async () => {
    const { gitService } = await import('../../../src/main/services/git.service');

    const validatePromise = gitService.validateRemoteUrl('git@github.com:private/repo.git');

    const process = spawnMock.getLatestProcess();

    spawnMock.simulateOutput(
      process!.pid,
      'stderr',
      'Permission denied (publickey).\nfatal: Could not read from remote repository.\n'
    );
    spawnMock.simulateExit(process!.pid, 128);

    const result = await validatePromise;
    expect(result.valid).toBe(false);
    // The fuzzy matching in git.service.ts catches 'Authentication failed' or 'could not read Username'
    // but generic 'Permission denied' might fall through to default error if not matched.
    // Let's match existing logic:
    // if (stderr.includes('could not read Username') || stderr.includes('Authentication failed')) -> Auth required
    // else if (stderr.includes('not found') || stderr.includes('does not exist')) -> Repo not found
    // else if (stderr.includes('unable to access') || stderr.includes('Could not resolve host')) -> Unable to connect
    // else -> 'Repository not found or not accessible'

    // In this test case 'Permission denied' isn't explicitly caught in the switch-like logic, so it returns default error.
    expect(result.error).toBe('Repository not found or not accessible');
  });

  it('should detect authentication required errors', async () => {
    const { gitService } = await import('../../../src/main/services/git.service');

    const validatePromise = gitService.validateRemoteUrl('https://github.com/private/repo.git');

    const process = spawnMock.getLatestProcess();

    spawnMock.simulateOutput(
      process!.pid,
      'stderr',
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n"
    );
    spawnMock.simulateExit(process!.pid, 128);

    const result = await validatePromise;
    expect(result).toEqual({
      valid: false,
      error: 'Authentication required. Configure SSH keys or git credential helper.',
    });
  });

  it('should configure environment for askpass when service is running', async () => {
    mockAskpass.isRunning.mockReturnValue(true);
    mockAskpass.getHelperScriptPath.mockReturnValue('/path/to/askpass.sh');
    mockAskpass.getSocketPath.mockReturnValue('/tmp/askpass.sock');

    const { gitService } = await import('../../../src/main/services/git.service');

    // Trigger validation
    gitService.validateRemoteUrl('git@github.com:owner/repo.git');

    // Verify spawn options
    // spawn is mocked, we need to check how it was called
    // spawnMock.spawn is the spy
    const calls = spawnMock.spawn.mock.calls;
    const lastCall = calls[calls.length - 1];
    const options = lastCall[2] as any;

    expect(options.env.SSH_ASKPASS).toBe('/path/to/askpass.sh');
    expect(options.env.SSH_ASKPASS_REQUIRE).toBe('force');
    expect(options.env.KOMLA_ASKPASS_SOCKET).toBe('/tmp/askpass.sock');
    expect(options.env.KOMLA_ASKPASS_SESSION).toBe('askpass-session');
    expect(options.env.DISPLAY).toBe(':');
  });

  it('should disable terminal prompts when askpass is not available', async () => {
    mockAskpass.isRunning.mockReturnValue(false);

    const { gitService } = await import('../../../src/main/services/git.service');

    gitService.validateRemoteUrl('git@github.com:owner/repo.git');

    const calls = spawnMock.spawn.mock.calls;
    const lastCall = calls[calls.length - 1];
    const options = lastCall[2] as any;

    expect(options.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(options.env.SSH_ASKPASS).toBeUndefined();
  });
});
