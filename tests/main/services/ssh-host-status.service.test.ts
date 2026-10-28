import { beforeEach, describe, expect, it, vi } from 'vitest';

async function load() {
  return import('../../../src/main/services/ssh-host-status.service');
}

const refused = Object.assign(new Error('Command failed'), {
  code: 255,
  stderr: 'Warning: Permanently added host\nssh: connect to host box port 22: Connection refused\n',
});

describe('sshHostStatusService', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("marks a host unreachable on ssh's own failures, with its last error line", async () => {
    const { sshHostStatusService } = await load();

    sshHostStatusService.failed('host-1', refused);

    expect(sshHostStatusService.list()).toEqual([
      {
        hostId: 'host-1',
        state: 'unreachable',
        checkedAt: expect.any(Number),
        message: 'ssh: connect to host box port 22: Connection refused',
      },
    ]);
  });

  it('counts a quick command killed at its timeout as unreachable', async () => {
    const { sshHostStatusService } = await load();

    sshHostStatusService.failed('host-1', Object.assign(new Error('x'), { killed: true }));

    expect(sshHostStatusService.list()[0]).toMatchObject({
      state: 'unreachable',
      message: 'Timed out',
    });
  });

  it('counts output too large to keep as connected', async () => {
    const { sshHostStatusService } = await load();

    sshHostStatusService.failed(
      'host-1',
      Object.assign(new Error('x'), { killed: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
    );

    expect(sshHostStatusService.get('host-1')).toMatchObject({ state: 'connected' });
  });

  it('counts a remote command that failed as connected, and ignores failures before ssh ran', async () => {
    const { sshHostStatusService } = await load();

    sshHostStatusService.failed('host-1', new Error('Timed out waiting for an SSH command slot'));
    sshHostStatusService.failed(
      'host-2',
      Object.assign(new Error('stopped'), { name: 'AbortError' })
    );
    expect(sshHostStatusService.list()).toEqual([]);

    sshHostStatusService.failed('host-1', Object.assign(new Error('x'), { code: 128 }));
    expect(sshHostStatusService.list()[0]).toMatchObject({ hostId: 'host-1', state: 'connected' });
  });

  it('tells listeners only when a state or message changes', async () => {
    const { sshHostStatusService } = await load();
    const listener = vi.fn();
    const unsubscribe = sshHostStatusService.onChange(listener);

    sshHostStatusService.reached('host-1');
    sshHostStatusService.reached('host-1');
    sshHostStatusService.failed('host-1', refused);
    sshHostStatusService.failed('host-1', refused);
    sshHostStatusService.reached('host-1');
    unsubscribe();
    sshHostStatusService.failed('host-1', refused);

    expect(listener.mock.calls.map(([statuses]) => statuses[0].state)).toEqual([
      'connected',
      'unreachable',
      'connected',
    ]);
  });

  it.each([
    [{ code: 255 }, true],
    [{ code: 'ETIMEDOUT' }, true],
    [{ killed: true }, true],
    [{ killed: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, false],
    [{ code: 1 }, false],
    [null, false],
  ])('treats %j as a connection failure: %s', async (error, expected) => {
    const { isSshConnectionFailure } = await load();
    expect(isSshConnectionFailure(error)).toBe(expected);
  });

  it.each([
    [{ killed: true }, true],
    [{ killed: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, false],
    [{ code: 255 }, false],
  ])('treats %j as a timeout: %s', async (error, expected) => {
    const { isSshTimeout } = await load();
    expect(isSshTimeout(error)).toBe(expected);
  });
});
