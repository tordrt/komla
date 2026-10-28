import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useToastStore } from '../../../src/renderer/stores/toast.store';
import { useUpdateStore } from '../../../src/renderer/stores/update.store';

function resetStore(): void {
  useUpdateStore.setState(useUpdateStore.getInitialState(), true);
}

function mockApi(): void {
  (globalThis as any).window = {
    api: {
      checkForUpdates: vi.fn().mockResolvedValue(undefined),
      downloadUpdate: vi.fn(),
      installUpdate: vi.fn(),
      openExternal: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe('update.store', () => {
  beforeEach(() => {
    resetStore();
    mockApi();
  });

  it('setChecking transitions to checking status', () => {
    useUpdateStore.getState().setChecking();
    const state = useUpdateStore.getState();
    expect(state.status).toBe('checking');
    expect(state.error).toBeNull();
  });

  it('setAvailable stores update info and starts download state', () => {
    useUpdateStore.setState({ dismissed: true });
    useUpdateStore.getState().setAvailable({
      version: '2.0.0',
      releaseNotes: 'New features',
      releaseName: 'v2.0.0',
    });
    const state = useUpdateStore.getState();
    expect(state.status).toBe('downloading');
    expect(state.version).toBe('2.0.0');
    expect(state.releaseNotes).toBe('New features');
    expect(state.releaseName).toBe('v2.0.0');
    expect(state.dismissed).toBe(false);
  });

  it('setNotAvailable returns to idle', () => {
    useUpdateStore.getState().setChecking();
    useUpdateStore.getState().setNotAvailable();
    expect(useUpdateStore.getState().status).toBe('idle');
  });

  it('setDownloading transitions to downloading without exposing progress', () => {
    useUpdateStore.getState().setDownloading();
    const state = useUpdateStore.getState();
    expect(state.status).toBe('downloading');
    expect(state).not.toHaveProperty('downloadProgress');
  });

  it('setReady transitions to ready with version', () => {
    useUpdateStore.getState().setReady('2.0.0');
    const state = useUpdateStore.getState();
    expect(state.status).toBe('ready');
    expect(state.version).toBe('2.0.0');
    expect(state.dismissed).toBe(false);
  });

  it('setError stores error message', () => {
    useUpdateStore.getState().setError('Download failed');
    const state = useUpdateStore.getState();
    expect(state.status).toBe('error');
    expect(state.error).toBe('Download failed');
  });

  it('dismiss sets dismissed to true', () => {
    useUpdateStore.getState().dismiss();
    expect(useUpdateStore.getState().dismissed).toBe(true);
  });

  it('downloadUpdate only works when status is available', () => {
    // Should be no-op when idle
    useUpdateStore.getState().downloadUpdate();
    expect(useUpdateStore.getState().status).toBe('idle');
    expect(globalThis.window.api.downloadUpdate).not.toHaveBeenCalled();

    // Should work when available. setAvailable now moves straight to downloading
    // because the main process starts downloads automatically.
    useUpdateStore.setState({ status: 'available' });
    useUpdateStore.getState().downloadUpdate();
    expect(useUpdateStore.getState().status).toBe('downloading');
    expect(globalThis.window.api.downloadUpdate).toHaveBeenCalled();
  });

  it('installUpdate calls api', () => {
    useUpdateStore.getState().installUpdate();
    expect(globalThis.window.api.installUpdate).toHaveBeenCalled();
  });

  it('checkForUpdates sets checking and calls api', async () => {
    vi.useFakeTimers();
    await useUpdateStore.getState().checkForUpdates();
    expect(globalThis.window.api.checkForUpdates).toHaveBeenCalled();
    // After 10s if still checking, resets to idle
    useUpdateStore.setState({ status: 'checking' });
    vi.advanceTimersByTime(10_000);
    expect(useUpdateStore.getState().status).toBe('idle');
  });

  describe('where Komla cannot update itself', () => {
    const download = {
      version: '3.7.0',
      releaseNotes: 'Notes',
      releaseName: null,
      downloadUrl: 'https://downloads.komla.dev/latest/komla-3.7.0-x86_64.AppImage',
    };

    it('offers the new version as a download, which openDownload opens', () => {
      useUpdateStore.getState().setAvailable(download);
      const state = useUpdateStore.getState();
      expect(state).toMatchObject({
        status: 'manual',
        version: '3.7.0',
        downloadUrl: download.downloadUrl,
        dismissed: false,
      });

      state.openDownload();
      expect(window.api.openExternal).toHaveBeenCalledWith(download.downloadUrl);
    });

    it('says so when the download page does not open', async () => {
      vi.mocked(window.api.openExternal).mockRejectedValueOnce(new Error('no xdg-open'));
      useUpdateStore.getState().setAvailable(download);

      useUpdateStore.getState().openDownload();
      await vi.waitFor(() =>
        expect(useToastStore.getState().toasts).toContainEqual(
          expect.objectContaining({
            message: `Couldn't open ${download.downloadUrl}`,
            type: 'error',
          })
        )
      );
    });

    it('keeps the notice dismissed when a later check finds the same version', () => {
      useUpdateStore.getState().setAvailable(download);
      useUpdateStore.getState().dismiss();

      useUpdateStore.getState().setAvailable(download);
      expect(useUpdateStore.getState().dismissed).toBe(true);

      useUpdateStore.getState().setAvailable({ ...download, version: '3.7.1' });
      expect(useUpdateStore.getState().dismissed).toBe(false);
    });

    it('keeps offering the download when a later check fails', () => {
      useUpdateStore.getState().setAvailable(download);
      useUpdateStore.getState().setError('Update check failed: HTTP 503');
      expect(useUpdateStore.getState().status).toBe('manual');
    });
  });
});
