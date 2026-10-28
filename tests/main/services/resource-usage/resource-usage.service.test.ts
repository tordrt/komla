import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }));

vi.mock('../../../../src/main/services/ssh-workspace.service', () => ({
  sshWorkspaceService: {
    getHost: vi.fn((id: string) => ({ id, name: id, hostname: `${id}.lan`, basePath: '~' })),
    run: runMock,
  },
}));
vi.mock('../../../../src/main/services/workspace.service', () => ({
  workspaceService: { list: vi.fn(() => []) },
}));
vi.mock('../../../../src/main/services/pty.service', () => ({
  ptyService: { getPid: vi.fn() },
}));

const SNAPSHOT = [
  '@@komla-tmux',
  '@@komla-processes',
  '#ps',
  '  412     1  12.5  20480',
  '@@komla-machine',
  'cores 4',
].join('\n');

async function service() {
  vi.resetModules();
  const { resourceUsageService } =
    await import('../../../../src/main/services/resource-usage/resource-usage.service');
  return resourceUsageService;
}

describe('resourceUsageService', () => {
  beforeEach(() => {
    runMock.mockReset();
  });

  it('reads a host without a password prompt when asked not to, and says why it needs one', async () => {
    const usage = await service();
    runMock.mockRejectedValue(
      Object.assign(new Error("Command failed: ssh devbox sh -lc '…'"), {
        code: 255,
        stderr: 'dev@devbox.lan: Permission denied (publickey,password).\n',
      })
    );

    const reading = await usage.get('devbox', { prompt: false });

    expect(runMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'devbox' }),
      expect.any(String),
      expect.objectContaining({ prompt: false })
    );
    expect(reading.error).toBe('Needs a password or passphrase; open resource usage to enter it');

    // One that may ask passes ssh's own error on.
    await expect(usage.get('devbox')).resolves.toMatchObject({
      error: "Command failed: ssh devbox sh -lc '…'",
    });
    expect(runMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ prompt: true })
    );
  });

  it('serves a recent reading to whoever accepts one that old, but never a failed one', async () => {
    vi.useFakeTimers();
    try {
      const usage = await service();
      runMock.mockResolvedValue(SNAPSHOT);

      const first = await usage.get('devbox', { maxAgeMs: 4500 });
      await expect(usage.get('devbox', { maxAgeMs: 4500 })).resolves.toBe(first);
      expect(runMock).toHaveBeenCalledTimes(1);
      // The popover always reads afresh.
      await usage.get('devbox');
      expect(runMock).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(5000);
      await usage.get('devbox', { maxAgeMs: 4500 });
      expect(runMock).toHaveBeenCalledTimes(3);

      runMock.mockRejectedValue(new Error('ssh: Connection refused'));
      vi.advanceTimersByTime(5000);
      await usage.get('devbox', { maxAgeMs: 4500 });
      await usage.get('devbox', { maxAgeMs: 4500 });
      expect(runMock).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });
});
