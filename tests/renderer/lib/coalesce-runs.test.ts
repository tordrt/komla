import { describe, expect, it, vi } from 'vitest';

import { coalesceRuns } from '../../../src/renderer/lib/coalesce-runs';
import { createDeferred } from '../../setup';

describe('coalesceRuns', () => {
  it('runs once for calls made while a run is under way, after that run', async () => {
    const runs = [createDeferred<void>(), createDeferred<void>()];
    const task = vi.fn(() => runs[task.mock.calls.length - 1].promise);
    const run = coalesceRuns(task);

    const first = run();
    const settled: string[] = [];
    void run().then(() => settled.push('second'));
    void run().then(() => settled.push('third'));
    expect(task).toHaveBeenCalledTimes(1);

    runs[0].resolve();
    await first;
    // The shared run starts only now, so it reads what changed before the calls it serves.
    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(2));
    expect(settled).toEqual([]);

    runs[1].resolve();
    await vi.waitFor(() => expect(settled).toEqual(['second', 'third']));
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('runs straight away once nothing is under way', async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const run = coalesceRuns(task);

    await run();
    await run();

    expect(task).toHaveBeenCalledTimes(2);
  });

  it('still runs for the waiting calls when the run under way fails', async () => {
    const failing = createDeferred<void>();
    const task = vi
      .fn<() => Promise<void>>()
      .mockReturnValueOnce(failing.promise)
      .mockResolvedValue(undefined);
    const run = coalesceRuns(task);

    const first = run();
    const second = run();
    failing.reject(new Error('offline'));

    await expect(first).rejects.toThrow('offline');
    await expect(second).resolves.toBeUndefined();
    expect(task).toHaveBeenCalledTimes(2);
  });
});
