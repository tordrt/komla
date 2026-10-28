import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pushWithAutoRecover } from '../../../src/renderer/utils/push-with-recover';
import { usePushConflictStore } from '../../../src/renderer/stores/push-conflict.store';
import type { PushConflictResolution } from '../../../src/renderer/stores/push-conflict.store';

function createMocks() {
  return {
    pushFn:
      vi.fn<(path: string) => Promise<{ success: boolean; message: string; errorCode?: string }>>(),
    pullFn: vi.fn<(path: string) => Promise<{ success: boolean; message: string }>>(),
    pullRebaseFn: vi.fn<(path: string) => Promise<{ success: boolean; message: string }>>(),
    startOperation: vi.fn(),
    endOperation: vi.fn(),
    addToast: vi.fn(),
  };
}

function makeOpts(mocks: ReturnType<typeof createMocks>) {
  return {
    workingDir: '/repo',
    operationPrefix: 'push',
    workspaceKey: 'ws1',
    ...mocks,
  };
}

/** Mock the store's requestResolution to auto-resolve with the given value */
function mockResolution(resolution: PushConflictResolution) {
  const spy = vi.fn().mockResolvedValue(resolution);
  vi.spyOn(usePushConflictStore, 'getState').mockReturnValue({
    ...usePushConflictStore.getState(),
    requestResolution: spy,
  });
  return spy;
}

describe('pushWithAutoRecover', () => {
  let mocks: ReturnType<typeof createMocks>;

  beforeEach(() => {
    mocks = createMocks();
    vi.restoreAllMocks();
  });

  it('returns success without a toast on first push success', async () => {
    mocks.pushFn.mockResolvedValue({ success: true, message: 'Pushed' });

    const result = await pushWithAutoRecover(makeOpts(mocks));

    expect(result.success).toBe(true);
    expect(mocks.pushFn).toHaveBeenCalledTimes(1);
    expect(mocks.pullFn).not.toHaveBeenCalled();
    expect(mocks.addToast).not.toHaveBeenCalled();
  });

  it('returns failure on non-rejected push error', async () => {
    mocks.pushFn.mockResolvedValue({ success: false, message: 'Auth failed', errorCode: 'auth' });

    const result = await pushWithAutoRecover(makeOpts(mocks));

    expect(result.success).toBe(false);
    expect(mocks.pullFn).not.toHaveBeenCalled();
    expect(mocks.addToast).toHaveBeenCalledWith('Auth failed', 'error');
  });

  it('recovers from rejection when user approves: pull then retry push', async () => {
    mockResolution('pull-and-push');
    mocks.pushFn
      .mockResolvedValueOnce({ success: false, message: 'rejected', errorCode: 'rejected' })
      .mockResolvedValueOnce({ success: true, message: 'Pushed' });
    mocks.pullFn.mockResolvedValue({ success: true, message: 'Pulled' });

    const result = await pushWithAutoRecover(makeOpts(mocks));

    expect(result.success).toBe(true);
    expect(mocks.pushFn).toHaveBeenCalledTimes(2);
    expect(mocks.pullFn).toHaveBeenCalledTimes(1);
    expect(mocks.pullRebaseFn).not.toHaveBeenCalled();
    expect(mocks.addToast).not.toHaveBeenCalled();
  });

  it('recovers from rejection with rebase: pullRebase then retry push', async () => {
    mockResolution('rebase-and-push');
    mocks.pushFn
      .mockResolvedValueOnce({ success: false, message: 'rejected', errorCode: 'rejected' })
      .mockResolvedValueOnce({ success: true, message: 'Pushed' });
    mocks.pullRebaseFn.mockResolvedValue({ success: true, message: 'Rebased' });

    const result = await pushWithAutoRecover(makeOpts(mocks));

    expect(result.success).toBe(true);
    expect(mocks.pushFn).toHaveBeenCalledTimes(2);
    expect(mocks.pullRebaseFn).toHaveBeenCalledTimes(1);
    expect(mocks.pullFn).not.toHaveBeenCalled();
    expect(mocks.addToast).not.toHaveBeenCalled();
  });

  it('confirms a push the caller asks to confirm, first try or recovered', async () => {
    mocks.pushFn.mockResolvedValue({ success: true, message: 'Pushed main' });
    await pushWithAutoRecover({ ...makeOpts(mocks), recoverySuccessMessage: 'Pulled and pushed' });
    expect(mocks.addToast).toHaveBeenCalledWith('Pushed main', 'success');

    mockResolution('pull-and-push');
    mocks.addToast.mockClear();
    mocks.pushFn
      .mockResolvedValueOnce({ success: false, message: 'rejected', errorCode: 'rejected' })
      .mockResolvedValueOnce({ success: true, message: 'Pushed main' });
    mocks.pullFn.mockResolvedValue({ success: true, message: 'Pulled' });
    await pushWithAutoRecover({ ...makeOpts(mocks), recoverySuccessMessage: 'Pulled and pushed' });
    expect(mocks.addToast).toHaveBeenCalledWith('Pulled and pushed', 'success');
  });

  it('returns failure when user cancels on rejection', async () => {
    mockResolution('cancel');
    mocks.pushFn.mockResolvedValue({
      success: false,
      message: 'Remote has new commits',
      errorCode: 'rejected',
    });

    const result = await pushWithAutoRecover(makeOpts(mocks));

    expect(result.success).toBe(false);
    expect(mocks.pullFn).not.toHaveBeenCalled();
    // No error toast on user cancel
    expect(mocks.addToast).not.toHaveBeenCalled();
  });

  it('returns failure when pull fails during recovery', async () => {
    mockResolution('pull-and-push');
    mocks.pushFn.mockResolvedValue({ success: false, message: 'rejected', errorCode: 'rejected' });
    mocks.pullFn.mockResolvedValue({ success: false, message: 'Merge conflict' });

    const result = await pushWithAutoRecover(makeOpts(mocks));

    expect(result.success).toBe(false);
    expect(mocks.pushFn).toHaveBeenCalledTimes(1);
    expect(mocks.addToast).toHaveBeenCalledWith('Merge conflict', 'error');
  });

  it('returns failure when pullRebase fails during recovery', async () => {
    mockResolution('rebase-and-push');
    mocks.pushFn.mockResolvedValue({ success: false, message: 'rejected', errorCode: 'rejected' });
    mocks.pullRebaseFn.mockResolvedValue({ success: false, message: 'Rebase conflict' });

    const result = await pushWithAutoRecover(makeOpts(mocks));

    expect(result.success).toBe(false);
    expect(mocks.pushFn).toHaveBeenCalledTimes(1);
    expect(mocks.addToast).toHaveBeenCalledWith('Rebase conflict', 'error');
  });

  it('returns failure when retry push fails after successful pull', async () => {
    mockResolution('pull-and-push');
    mocks.pushFn
      .mockResolvedValueOnce({ success: false, message: 'rejected', errorCode: 'rejected' })
      .mockResolvedValueOnce({ success: false, message: 'Still rejected' });
    mocks.pullFn.mockResolvedValue({ success: true, message: 'Pulled' });

    const result = await pushWithAutoRecover(makeOpts(mocks));

    expect(result.success).toBe(false);
    expect(mocks.addToast).toHaveBeenCalledWith('Still rejected', 'error');
  });

  it('handles push throwing an exception', async () => {
    mocks.pushFn.mockRejectedValue(new Error('Network error'));

    const result = await pushWithAutoRecover(makeOpts(mocks));

    expect(result.success).toBe(false);
    expect(mocks.addToast).toHaveBeenCalledWith('Network error', 'error');
    expect(mocks.pullFn).not.toHaveBeenCalled();
  });

  it('handles pull throwing an exception during recovery', async () => {
    mockResolution('pull-and-push');
    mocks.pushFn.mockResolvedValue({ success: false, message: 'rejected', errorCode: 'rejected' });
    mocks.pullFn.mockRejectedValue(new Error('Pull network error'));

    const result = await pushWithAutoRecover(makeOpts(mocks));

    expect(result.success).toBe(false);
    expect(mocks.addToast).toHaveBeenCalledWith('Pull network error', 'error');
  });

  it('starts and ends each operation exactly once (pull-and-push)', async () => {
    mockResolution('pull-and-push');
    mocks.pushFn
      .mockResolvedValueOnce({ success: false, message: 'rejected', errorCode: 'rejected' })
      .mockResolvedValueOnce({ success: true, message: 'Pushed' });
    mocks.pullFn.mockResolvedValue({ success: true, message: 'Pulled' });

    await pushWithAutoRecover(makeOpts(mocks));

    // 3 phases: push, pull, retry push
    expect(mocks.startOperation).toHaveBeenCalledTimes(3);
    expect(mocks.endOperation).toHaveBeenCalledTimes(3);

    // Each started operation ID was ended exactly once
    const startedIds = mocks.startOperation.mock.calls.map((c) => c[0]);
    const endedIds = mocks.endOperation.mock.calls.map((c) => c[0]);
    expect(new Set(startedIds).size).toBe(3);
    expect(new Set(endedIds).size).toBe(3);
    for (const id of startedIds) {
      expect(endedIds).toContain(id);
    }
  });

  it('ends operation even when push throws', async () => {
    mocks.pushFn.mockRejectedValue(new Error('boom'));

    await pushWithAutoRecover(makeOpts(mocks));

    expect(mocks.startOperation).toHaveBeenCalledTimes(1);
    expect(mocks.endOperation).toHaveBeenCalledTimes(1);
    expect(mocks.endOperation.mock.calls[0][0]).toBe(mocks.startOperation.mock.calls[0][0]);
  });

  it('ends pull operation even when pull throws', async () => {
    mockResolution('pull-and-push');
    mocks.pushFn.mockResolvedValue({ success: false, message: 'rejected', errorCode: 'rejected' });
    mocks.pullFn.mockRejectedValue(new Error('pull boom'));

    await pushWithAutoRecover(makeOpts(mocks));

    // push op + pull op = 2
    expect(mocks.startOperation).toHaveBeenCalledTimes(2);
    expect(mocks.endOperation).toHaveBeenCalledTimes(2);
  });

  it('passes rejection message and options to requestResolution', async () => {
    const spy = mockResolution('cancel');
    mocks.pushFn.mockResolvedValue({
      success: false,
      message: 'Remote has new commits',
      errorCode: 'rejected',
    });

    await pushWithAutoRecover(makeOpts(mocks));

    expect(spy).toHaveBeenCalledWith('Remote has new commits', {
      allowRebase: true,
    });
  });

  it('passes allowRebase: false when pullRebaseFn is not provided', async () => {
    const spy = mockResolution('cancel');
    mocks.pushFn.mockResolvedValue({
      success: false,
      message: 'Remote has new commits',
      errorCode: 'rejected',
    });

    const { pullRebaseFn: _removed, ...optsWithoutRebase } = makeOpts(mocks);
    await pushWithAutoRecover(optsWithoutRebase);

    expect(spy).toHaveBeenCalledWith('Remote has new commits', {
      allowRebase: false,
    });
  });

  it('returns failure when rebase-and-push selected but pullRebaseFn not provided', async () => {
    mockResolution('rebase-and-push');
    mocks.pushFn.mockResolvedValue({
      success: false,
      message: 'rejected',
      errorCode: 'rejected',
    });

    const { pullRebaseFn: _removed, ...optsWithoutRebase } = makeOpts(mocks);
    const result = await pushWithAutoRecover(optsWithoutRebase);

    expect(result.success).toBe(false);
    expect(mocks.addToast).toHaveBeenCalledWith('Rebase not available for this operation', 'error');
  });
});
