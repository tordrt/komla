/**
 * @vitest-environment jsdom
 */
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NativeDevPreviewHost } from '../../../src/renderer/components/terminal/NativeDevPreviewHost';

const captureDevPreview = vi.fn();
const hideDevPreview = vi.fn();
const syncDevPreview = vi.fn();
let resizeCallback: ResizeObserverCallback | null = null;
let frameCallback: FrameRequestCallback | null = null;
let snapshotCallback:
  | ((event: { workspaceId: string; tabId: string; dataUrl: string }) => void)
  | null = null;

// Settles pending promises and observer callbacks without relying on setTimeout,
// which the frame-timing tests fake.
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });

describe('NativeDevPreviewHost', () => {
  beforeEach(() => {
    captureDevPreview.mockReset();
    captureDevPreview.mockResolvedValue(null);
    hideDevPreview.mockReset();
    syncDevPreview.mockReset();
    resizeCallback = null;
    frameCallback = null;
    snapshotCallback = null;
    (window as any).api = {
      captureDevPreview,
      hideDevPreview,
      syncDevPreview,
      onDevPreviewSnapshotUpdated: vi.fn((callback) => {
        snapshotCallback = callback;
        return vi.fn();
      }),
    };
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameCallback = callback;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    HTMLImageElement.prototype.decode = vi.fn(async () => undefined);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }
        observe(): void {}
        disconnect(): void {}
      }
    );
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 450,
      height: 300,
      left: 120,
      right: 620,
      top: 150,
      width: 500,
      x: 120,
      y: 150,
      toJSON: () => ({}),
    });
  });

  afterEach(() => {
    document.querySelectorAll('[data-native-overlay]').forEach((element) => element.remove());
    delete (HTMLImageElement.prototype as Partial<HTMLImageElement>).decode;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('syncs the DOM rectangle to the main-process native view', () => {
    render(
      <NativeDevPreviewHost
        workspaceId="workspace-1"
        tabId="tab-1"
        url="http://localhost:5173"
        visible
      />
    );

    expect(syncDevPreview).toHaveBeenCalledWith('workspace-1', 'tab-1', 'http://localhost:5173', {
      x: 120,
      y: 150,
      width: 500,
      height: 300,
    });
  });

  it('resyncs after the host is resized', () => {
    render(
      <NativeDevPreviewHost
        workspaceId="workspace-1"
        tabId="tab-1"
        url="http://localhost:5173"
        visible
      />
    );
    syncDevPreview.mockClear();

    resizeCallback?.([], {} as ResizeObserver);

    expect(syncDevPreview).toHaveBeenCalledTimes(1);
  });

  it('hides the native view while a renderer overlay is present', async () => {
    const overlay = document.createElement('div');
    overlay.dataset.nativeOverlay = 'dialog';
    document.body.appendChild(overlay);

    render(
      <NativeDevPreviewHost
        workspaceId="workspace-1"
        tabId="tab-1"
        url="http://localhost:5173"
        visible
      />
    );

    expect(syncDevPreview).not.toHaveBeenCalled();
    await waitFor(() => expect(hideDevPreview).toHaveBeenCalledWith('workspace-1', 'tab-1'));
    overlay.remove();
  });

  it('paints a fresh frame of the page before hiding it for an overlay', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    captureDevPreview.mockResolvedValue('data:image/jpeg;base64,fresh');
    const { getByTestId } = render(
      <NativeDevPreviewHost
        workspaceId="workspace-1"
        tabId="tab-1"
        url="http://localhost:5173"
        visible
      />
    );
    hideDevPreview.mockClear();

    const overlay = document.createElement('div');
    overlay.dataset.nativeOverlay = 'menu';
    document.body.appendChild(overlay);
    await flush();

    expect(captureDevPreview).toHaveBeenCalledWith('workspace-1', 'tab-1');
    expect(getByTestId('native-dev-preview-host').querySelector('img')).toHaveAttribute(
      'src',
      'data:image/jpeg;base64,fresh'
    );
    expect(HTMLImageElement.prototype.decode).toHaveBeenCalled();
    expect(hideDevPreview).not.toHaveBeenCalled();

    act(() => frameCallback?.(16));
    act(() => vi.advanceTimersByTime(0));
    await flush();

    expect(hideDevPreview).toHaveBeenCalledWith('workspace-1', 'tab-1');
  });

  it('hides the native view anyway when a fresh frame takes too long', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    captureDevPreview.mockReturnValue(new Promise(() => {}));
    render(
      <NativeDevPreviewHost
        workspaceId="workspace-1"
        tabId="tab-1"
        url="http://localhost:5173"
        visible
      />
    );
    hideDevPreview.mockClear();

    const overlay = document.createElement('div');
    overlay.dataset.nativeOverlay = 'dialog';
    document.body.appendChild(overlay);
    await flush();
    act(() => vi.advanceTimersByTime(199));
    await flush();

    expect(captureDevPreview).toHaveBeenCalledWith('workspace-1', 'tab-1');
    expect(hideDevPreview).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    await flush();

    expect(hideDevPreview).toHaveBeenCalledWith('workspace-1', 'tab-1');
  });

  it('keeps the page live when the overlay closes before its frame is captured', async () => {
    let resolveCapture: (dataUrl: string | null) => void = () => {};
    captureDevPreview.mockReturnValue(
      new Promise<string | null>((resolve) => {
        resolveCapture = resolve;
      })
    );
    render(
      <NativeDevPreviewHost
        workspaceId="workspace-1"
        tabId="tab-1"
        url="http://localhost:5173"
        visible
      />
    );
    hideDevPreview.mockClear();

    const overlay = document.createElement('div');
    overlay.dataset.nativeOverlay = 'tooltip';
    document.body.appendChild(overlay);
    await waitFor(() => expect(captureDevPreview).toHaveBeenCalledTimes(1));
    syncDevPreview.mockClear();
    overlay.remove();
    await waitFor(() => expect(syncDevPreview).toHaveBeenCalledTimes(1));

    await act(async () => resolveCapture('data:image/jpeg;base64,late'));

    expect(hideDevPreview).not.toHaveBeenCalled();
  });

  it('captures once while an open overlay keeps changing', async () => {
    render(
      <NativeDevPreviewHost
        workspaceId="workspace-1"
        tabId="tab-1"
        url="http://localhost:5173"
        visible
      />
    );

    const overlay = document.createElement('div');
    overlay.dataset.nativeOverlay = 'menu';
    document.body.appendChild(overlay);
    await waitFor(() => expect(hideDevPreview).toHaveBeenCalledWith('workspace-1', 'tab-1'));
    overlay.style.transform = 'translateY(4px)';
    overlay.dataset.state = 'open';
    await act(async () => {});

    expect(captureDevPreview).toHaveBeenCalledTimes(1);
  });

  it('hides and restores the native view as renderer overlays open and close', async () => {
    render(
      <NativeDevPreviewHost
        workspaceId="workspace-1"
        tabId="tab-1"
        url="http://localhost:5173"
        visible
      />
    );
    hideDevPreview.mockClear();
    syncDevPreview.mockClear();

    const overlay = document.createElement('div');
    overlay.dataset.nativeOverlay = 'menu';
    document.body.appendChild(overlay);
    await waitFor(() => expect(hideDevPreview).toHaveBeenCalledWith('workspace-1', 'tab-1'));

    syncDevPreview.mockClear();
    overlay.remove();
    await waitFor(() => expect(syncDevPreview).toHaveBeenCalledTimes(1));
  });

  it('ignores overlays that do not overlap the preview host', () => {
    const overlay = document.createElement('div');
    overlay.dataset.nativeOverlay = 'tooltip';
    overlay.getBoundingClientRect = vi.fn(() => ({
      bottom: 40,
      height: 20,
      left: 10,
      right: 110,
      top: 20,
      width: 100,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    }));
    document.body.appendChild(overlay);

    render(
      <NativeDevPreviewHost
        workspaceId="workspace-1"
        tabId="tab-1"
        url="http://localhost:5173"
        visible
      />
    );

    expect(syncDevPreview).toHaveBeenCalled();
    overlay.remove();
  });

  it('resyncs when the host moves without changing size', () => {
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    render(
      <NativeDevPreviewHost
        workspaceId="workspace-1"
        tabId="tab-1"
        url="http://localhost:5173"
        visible
      />
    );
    syncDevPreview.mockClear();
    rectSpy.mockReturnValue({
      bottom: 450,
      height: 300,
      left: 200,
      right: 700,
      top: 150,
      width: 500,
      x: 200,
      y: 150,
      toJSON: () => ({}),
    });

    frameCallback?.(16);

    expect(syncDevPreview).toHaveBeenCalledWith('workspace-1', 'tab-1', 'http://localhost:5173', {
      x: 200,
      y: 150,
      width: 500,
      height: 300,
    });
  });

  it('shows the last native frame while an overlapping renderer overlay is open', async () => {
    const { getByTestId } = render(
      <NativeDevPreviewHost
        workspaceId="workspace-1"
        tabId="tab-1"
        url="http://localhost:5173"
        visible
      />
    );
    act(() =>
      snapshotCallback?.({
        workspaceId: 'workspace-1',
        tabId: 'tab-1',
        dataUrl: 'data:image/jpeg;base64,preview',
      })
    );

    await waitFor(() =>
      expect(getByTestId('native-dev-preview-host').querySelector('img')).toHaveAttribute(
        'src',
        'data:image/jpeg;base64,preview'
      )
    );
  });

  it('marks itself as a native view only while visible', () => {
    const { getByTestId, rerender } = render(
      <NativeDevPreviewHost
        workspaceId="workspace-1"
        tabId="tab-1"
        url="http://localhost:5173"
        visible
      />
    );
    expect(getByTestId('native-dev-preview-host')).toHaveAttribute('data-native-view');

    rerender(
      <NativeDevPreviewHost
        workspaceId="workspace-1"
        tabId="tab-1"
        url="http://localhost:5173"
        visible={false}
      />
    );
    expect(getByTestId('native-dev-preview-host')).not.toHaveAttribute('data-native-view');
  });

  it('shows the app background, not white, where the hidden native view was', () => {
    const { getByTestId } = render(
      <NativeDevPreviewHost
        workspaceId="workspace-1"
        tabId="tab-1"
        url="http://localhost:5173"
        visible={false}
      />
    );
    const host = getByTestId('native-dev-preview-host');
    expect(host).toHaveClass('bg-background');
    expect(host).not.toHaveClass('bg-white');
  });

  it('hides the native view when inactive and when unmounted', () => {
    const { rerender, unmount } = render(
      <NativeDevPreviewHost
        workspaceId="workspace-1"
        tabId="tab-1"
        url="http://localhost:5173"
        visible
      />
    );
    hideDevPreview.mockClear();

    rerender(
      <NativeDevPreviewHost
        workspaceId="workspace-1"
        tabId="tab-1"
        url="http://localhost:5173"
        visible={false}
      />
    );
    expect(hideDevPreview).toHaveBeenCalledWith('workspace-1', 'tab-1');

    hideDevPreview.mockClear();
    unmount();
    expect(hideDevPreview).toHaveBeenCalledWith('workspace-1', 'tab-1');
  });

  it('does not observe or poll layout while inactive', () => {
    const resizeObserver = vi.spyOn(ResizeObserver.prototype, 'observe');
    const mutationObserver = vi.spyOn(MutationObserver.prototype, 'observe');
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame');

    render(
      <NativeDevPreviewHost
        workspaceId="workspace-1"
        tabId="tab-1"
        url="http://localhost:5173"
        visible={false}
      />
    );

    expect(hideDevPreview).toHaveBeenCalledWith('workspace-1', 'tab-1');
    expect(resizeObserver).not.toHaveBeenCalled();
    expect(mutationObserver).not.toHaveBeenCalled();
    expect(requestFrame).not.toHaveBeenCalled();
  });
});
