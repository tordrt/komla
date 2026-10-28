import { beforeEach, describe, expect, it, vi } from 'vitest';

// Must set up window.location before the store module loads (it reads at create() time)
vi.hoisted(() => {
  (globalThis as any).window = {
    location: { search: '?windowId=test-win' },
    api: {
      onWindowListUpdated: () => () => {},
      onWindowFullscreenChange: () => () => {},
      getAllWindowIds: () => Promise.resolve([]),
      isWindowFullscreen: () => Promise.resolve(false),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
});

import { useWindowStore } from '../../../src/renderer/stores/window.store';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function resetStore(): void {
  useWindowStore.setState(useWindowStore.getInitialState(), true);
}

describe('window.store', () => {
  beforeEach(() => {
    resetStore();
  });

  it('reads windowId from URL query params', () => {
    const state = useWindowStore.getState();
    expect(state.windowId).toBe('test-win');
    expect(state.availableWindows).toEqual([]);
    expect(state.isFullscreen).toBe(false);
  });

  it('sets available windows', () => {
    const windows = [
      { id: 'win-1', displayNumber: 1 },
      { id: 'win-2', displayNumber: 2 },
    ];
    useWindowStore.getState().setAvailableWindows(windows);
    expect(useWindowStore.getState().availableWindows).toEqual(windows);
  });

  it('replaces available windows on subsequent calls', () => {
    useWindowStore.getState().setAvailableWindows([{ id: 'win-1', displayNumber: 1 }]);
    useWindowStore.getState().setAvailableWindows([{ id: 'win-2', displayNumber: 2 }]);
    expect(useWindowStore.getState().availableWindows).toEqual([{ id: 'win-2', displayNumber: 2 }]);
  });

  it('subscribeToWindowEvents sets up listeners and loads initial list', async () => {
    let windowListCallback: ((windows: any[]) => void) | undefined;
    let fullscreenCallback: ((isFullscreen: boolean) => void) | undefined;
    const unsubMock = vi.fn();
    const fullscreenUnsubMock = vi.fn();
    const windowIdsDeferred = createDeferred<{ id: string; displayNumber: number }[]>();
    const fullscreenDeferred = createDeferred<boolean>();
    (globalThis as any).window = {
      ...globalThis.window,
      api: {
        onWindowListUpdated: vi.fn((cb: any) => {
          windowListCallback = cb;
          return unsubMock;
        }),
        onWindowFullscreenChange: vi.fn((cb: any) => {
          fullscreenCallback = cb;
          return fullscreenUnsubMock;
        }),
        getAllWindowIds: vi.fn(() => windowIdsDeferred.promise),
        isWindowFullscreen: vi.fn(() => fullscreenDeferred.promise),
      },
      location: { search: '' },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    const unsub = useWindowStore.getState().subscribeToWindowEvents();

    windowIdsDeferred.resolve([{ id: 'win-1', displayNumber: 1 }]);
    fullscreenDeferred.resolve(true);

    await vi.waitFor(() => {
      expect(useWindowStore.getState().availableWindows).toEqual([
        { id: 'win-1', displayNumber: 1 },
      ]);
      expect(useWindowStore.getState().isFullscreen).toBe(true);
    });

    // Simulate window list update via callback
    windowListCallback!([
      { id: 'win-1', displayNumber: 1 },
      { id: 'win-2', displayNumber: 2 },
    ]);
    expect(useWindowStore.getState().availableWindows).toHaveLength(2);

    fullscreenCallback!(false);
    expect(useWindowStore.getState().isFullscreen).toBe(false);

    // Cleanup
    unsub();
    expect(unsubMock).toHaveBeenCalled();
    expect(fullscreenUnsubMock).toHaveBeenCalled();
    expect(window.removeEventListener).toHaveBeenCalledWith('focus', expect.any(Function));
  });

  it('does not apply initial async state after unsubscribe', async () => {
    const windowIdsDeferred = createDeferred<{ id: string; displayNumber: number }[]>();
    const fullscreenDeferred = createDeferred<boolean>();
    const unsubMock = vi.fn();
    const fullscreenUnsubMock = vi.fn();

    (globalThis as any).window = {
      ...globalThis.window,
      api: {
        onWindowListUpdated: vi.fn(() => unsubMock),
        onWindowFullscreenChange: vi.fn(() => fullscreenUnsubMock),
        getAllWindowIds: vi.fn(() => windowIdsDeferred.promise),
        isWindowFullscreen: vi.fn(() => fullscreenDeferred.promise),
      },
      location: { search: '' },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    const unsub = useWindowStore.getState().subscribeToWindowEvents();
    unsub();

    windowIdsDeferred.resolve([{ id: 'win-9', displayNumber: 9 }]);
    fullscreenDeferred.resolve(true);

    await Promise.all([windowIdsDeferred.promise, fullscreenDeferred.promise]);

    expect(useWindowStore.getState().availableWindows).toEqual([]);
    expect(useWindowStore.getState().isFullscreen).toBe(false);
    expect(unsubMock).toHaveBeenCalled();
    expect(fullscreenUnsubMock).toHaveBeenCalled();
  });

  it('does not let a stale initial window list overwrite a pushed update', async () => {
    let windowListCallback:
      | ((windows: { id: string; displayNumber: number }[]) => void)
      | undefined;
    const windowIdsDeferred = createDeferred<{ id: string; displayNumber: number }[]>();

    (globalThis as any).window = {
      ...globalThis.window,
      api: {
        onWindowListUpdated: vi.fn((cb: typeof windowListCallback) => {
          windowListCallback = cb;
          return vi.fn();
        }),
        onWindowFullscreenChange: vi.fn(() => vi.fn()),
        getAllWindowIds: vi.fn(() => windowIdsDeferred.promise),
        isWindowFullscreen: vi.fn(() => Promise.resolve(false)),
      },
      location: { search: '' },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    useWindowStore.getState().subscribeToWindowEvents();

    windowListCallback!([
      { id: 'win-1', displayNumber: 1 },
      { id: 'win-2', displayNumber: 2 },
    ]);
    windowIdsDeferred.resolve([{ id: 'win-1', displayNumber: 1 }]);

    await windowIdsDeferred.promise;

    expect(useWindowStore.getState().availableWindows).toEqual([
      { id: 'win-1', displayNumber: 1 },
      { id: 'win-2', displayNumber: 2 },
    ]);
  });

  it('refreshes the available window list when the renderer window regains focus', async () => {
    let focusHandler: (() => void) | undefined;
    const getAllWindowIds = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'win-1', displayNumber: 1 }])
      .mockResolvedValueOnce([
        { id: 'win-1', displayNumber: 1 },
        { id: 'win-2', displayNumber: 2 },
      ]);

    (globalThis as any).window = {
      ...globalThis.window,
      api: {
        onWindowListUpdated: vi.fn(() => vi.fn()),
        onWindowFullscreenChange: vi.fn(() => vi.fn()),
        getAllWindowIds,
        isWindowFullscreen: vi.fn(() => Promise.resolve(false)),
      },
      location: { search: '' },
      addEventListener: vi.fn((event: string, handler: () => void) => {
        if (event === 'focus') {
          focusHandler = handler;
        }
      }),
      removeEventListener: vi.fn(),
    };

    const unsub = useWindowStore.getState().subscribeToWindowEvents();

    await vi.waitFor(() => {
      expect(useWindowStore.getState().availableWindows).toEqual([
        { id: 'win-1', displayNumber: 1 },
      ]);
    });

    focusHandler!();

    await vi.waitFor(() => {
      expect(useWindowStore.getState().availableWindows).toEqual([
        { id: 'win-1', displayNumber: 1 },
        { id: 'win-2', displayNumber: 2 },
      ]);
    });

    unsub();
  });
});
