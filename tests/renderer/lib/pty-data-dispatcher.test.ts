import { describe, it, expect, vi, beforeEach } from 'vitest';
import { importFresh } from '../../setup';

// Module state is shared across imports, so we re-import fresh each time
async function getFreshModule() {
  return importFresh<typeof import('../../../src/renderer/lib/pty-data-dispatcher')>(
    '../../../src/renderer/lib/pty-data-dispatcher'
  );
}

describe('subscribePtyData', () => {
  let mockCleanup: ReturnType<typeof vi.fn>;
  let mockOnPtyData: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockCleanup = vi.fn();
    mockOnPtyData = vi.fn().mockReturnValue(mockCleanup);
    vi.stubGlobal('window', {
      api: {
        onPtyData: mockOnPtyData,
      },
    });
  });

  it('registers a callback and sets up the global listener', async () => {
    const { subscribePtyData } = await getFreshModule();
    const callback = vi.fn();
    subscribePtyData('term-1', callback);

    expect(mockOnPtyData).toHaveBeenCalledOnce();
  });

  it('dispatches data to the correct terminal callback', async () => {
    const { subscribePtyData } = await getFreshModule();
    const cb1 = vi.fn();
    const cb2 = vi.fn();

    subscribePtyData('term-1', cb1);
    subscribePtyData('term-2', cb2);

    // Get the handler passed to onPtyData
    const handler = mockOnPtyData.mock.calls[0][0];
    handler('term-1', 'hello', 1);

    expect(cb1).toHaveBeenCalledWith('hello', 1);
    expect(cb2).not.toHaveBeenCalled();
  });

  it('only creates one global listener for multiple subscriptions', async () => {
    const { subscribePtyData } = await getFreshModule();

    subscribePtyData('term-1', vi.fn());
    subscribePtyData('term-2', vi.fn());

    expect(mockOnPtyData).toHaveBeenCalledOnce();
  });

  it('unsubscribe removes the terminal callback', async () => {
    const { subscribePtyData } = await getFreshModule();
    const cb = vi.fn();

    // Keep another subscription alive so global listener stays
    subscribePtyData('term-other', vi.fn());
    const unsub = subscribePtyData('term-1', cb);
    unsub();

    const handler = mockOnPtyData.mock.calls[0][0];
    handler('term-1', 'data', 1);

    expect(cb).not.toHaveBeenCalled();
  });

  it('cleans up global listener when last subscriber unsubscribes', async () => {
    const { subscribePtyData } = await getFreshModule();

    const unsub = subscribePtyData('term-1', vi.fn());
    unsub();

    expect(mockCleanup).toHaveBeenCalledOnce();
  });

  it('does not clean up global listener when other subscribers remain', async () => {
    const { subscribePtyData } = await getFreshModule();

    subscribePtyData('term-1', vi.fn());
    const unsub2 = subscribePtyData('term-2', vi.fn());
    unsub2();

    expect(mockCleanup).not.toHaveBeenCalled();
  });

  it('re-creates global listener after full cleanup', async () => {
    const { subscribePtyData } = await getFreshModule();

    const unsub = subscribePtyData('term-1', vi.fn());
    unsub();

    expect(mockCleanup).toHaveBeenCalledOnce();
    expect(mockOnPtyData).toHaveBeenCalledTimes(1);

    subscribePtyData('term-2', vi.fn());
    expect(mockOnPtyData).toHaveBeenCalledTimes(2);
  });

  it('ignores data for unknown terminal IDs', async () => {
    const { subscribePtyData } = await getFreshModule();
    subscribePtyData('term-1', vi.fn());

    const handler = mockOnPtyData.mock.calls[0][0];
    // Should not throw
    expect(() => handler('unknown-term', 'data', 1)).not.toThrow();
  });

  it('delivers terminal queries immediately while hidden', async () => {
    const { subscribePtyData } = await getFreshModule();
    const callback = vi.fn();
    subscribePtyData('term-1', callback);

    const handler = mockOnPtyData.mock.calls[0][0];
    handler('term-1', '\x1b[6n', 1);

    expect(callback).toHaveBeenCalledExactlyOnceWith('\x1b[6n', 1);
  });
});
