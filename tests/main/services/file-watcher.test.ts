import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as watcher from '@parcel/watcher';
import { FileWatcher, MultiFileWatcher } from '../../../src/main/services/file-watcher';

vi.mock('fs', () => ({
  realpathSync: (p: string) => p,
}));
vi.mock('@parcel/watcher');

describe('FileWatcher', () => {
  let mockSubscribe: ReturnType<typeof vi.fn>;
  let mockUnsubscribe: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockUnsubscribe = vi.fn().mockResolvedValue(undefined);
    mockSubscribe = vi.mocked(watcher.subscribe).mockResolvedValue({
      unsubscribe: mockUnsubscribe,
    } as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('should subscribe to changes in the file directory', async () => {
    const onChange = vi.fn();
    const fw = new FileWatcher('/path/to/config.json', onChange);
    await fw.start();

    expect(mockSubscribe).toHaveBeenCalledWith('/path/to', expect.any(Function));
  });

  it('should ignore events for other files', async () => {
    const onChange = vi.fn();
    const fw = new FileWatcher('/path/to/config.json', onChange);
    await fw.start();

    const callback = mockSubscribe.mock.calls[0][1];

    // Simulate unrelated event
    callback(null, [{ type: 'update', path: '/path/to/other.json' }]);

    vi.runAllTimers();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('should trigger callback for target file update', async () => {
    const onChange = vi.fn();
    const fw = new FileWatcher('/path/to/config.json', onChange);
    await fw.start();

    const callback = mockSubscribe.mock.calls[0][1];

    // Simulate update event
    callback(null, [{ type: 'update', path: '/path/to/config.json' }]);

    vi.runAllTimers();
    expect(onChange).toHaveBeenCalled();
  });

  it('should debounce multiple events', async () => {
    const onChange = vi.fn();
    const fw = new FileWatcher('/path/to/config.json', onChange, 100);
    await fw.start();

    const callback = mockSubscribe.mock.calls[0][1];

    // Simulate multiple rapid updates
    callback(null, [{ type: 'update', path: '/path/to/config.json' }]);
    vi.advanceTimersByTime(50);
    callback(null, [{ type: 'update', path: '/path/to/config.json' }]);
    vi.advanceTimersByTime(50);

    expect(onChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50); // Total 150ms from first, 100ms from last
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('should stop watching when stop() is called', async () => {
    const onChange = vi.fn();
    const fw = new FileWatcher('/path/to/config.json', onChange);
    await fw.start();
    await fw.stop();

    expect(mockUnsubscribe).toHaveBeenCalled();
  });
});

describe('MultiFileWatcher', () => {
  let mockSubscribe: ReturnType<typeof vi.fn>;
  let mockUnsubscribe: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockUnsubscribe = vi.fn().mockResolvedValue(undefined);
    mockSubscribe = vi.mocked(watcher.subscribe).mockResolvedValue({
      unsubscribe: mockUnsubscribe,
    } as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('should throw if files are in different directories', () => {
    expect(() => {
      new MultiFileWatcher(['/a/file1', '/b/file2'], vi.fn());
    }).toThrow(/same directory/);
  });

  it('should trigger callback with specific file path', async () => {
    const onChange = vi.fn();
    const watcher = new MultiFileWatcher(['/path/to/a.json', '/path/to/b.json'], onChange);
    await watcher.start();

    const callback = mockSubscribe.mock.calls[0][1];

    callback(null, [
      { type: 'update', path: '/path/to/a.json' },
      { type: 'create', path: '/path/to/b.json' },
    ]);

    vi.runAllTimers();
    expect(onChange).toHaveBeenCalledWith('/path/to/a.json');
    expect(onChange).toHaveBeenCalledWith('/path/to/b.json');
  });

  it('should ignore unrelated files', async () => {
    const onChange = vi.fn();
    const watcher = new MultiFileWatcher(['/path/to/a.json'], onChange);
    await watcher.start();

    const callback = mockSubscribe.mock.calls[0][1];

    callback(null, [{ type: 'update', path: '/path/to/c.json' }]);

    vi.runAllTimers();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('should stop watching when stop() is called', async () => {
    const onChange = vi.fn();
    const watcher = new MultiFileWatcher(['/path/to/a.json'], onChange);
    await watcher.start();
    await watcher.stop();

    expect(mockUnsubscribe).toHaveBeenCalled();
  });
});
