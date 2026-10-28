import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useToastStore } from '../../../src/renderer/stores/toast.store';

function resetStore(): void {
  useToastStore.setState(useToastStore.getInitialState(), true);
}

describe('toast.store', () => {
  beforeEach(() => {
    resetStore();
    vi.useFakeTimers();
  });

  it('adds a toast with generated id', () => {
    const id = useToastStore.getState().addToast('hello', 'success');
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].message).toBe('hello');
    expect(toasts[0].type).toBe('success');
    expect(toasts[0].id).toBeTruthy();
    expect(id).toBe(toasts[0].id);
  });

  it('keeps an informational progress toast until it is explicitly removed', () => {
    const id = useToastStore
      .getState()
      .addToast('Deleting remote workspace...', 'info', {
        dismissOnTimeout: false,
        progress: true,
      });

    vi.advanceTimersByTime(60_000);
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({
        id,
        type: 'info',
        message: 'Deleting remote workspace...',
        progress: true,
      }),
    ]);

    useToastStore.getState().removeToast(id);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('adds multiple toasts', () => {
    useToastStore.getState().addToast('first', 'success');
    useToastStore.getState().addToast('second', 'error');
    expect(useToastStore.getState().toasts).toHaveLength(2);
  });

  it('removes toast by id', () => {
    useToastStore.getState().addToast('msg', 'success');
    const id = useToastStore.getState().toasts[0].id;
    useToastStore.getState().removeToast(id);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('leaves timed dismissal to the toast component', () => {
    useToastStore.getState().addToast('temp', 'success');
    vi.advanceTimersByTime(60_000);
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ message: 'temp', dismissOnTimeout: true }),
    ]);
  });

  it('draws success toasts quietly unless they stay until dismissed', () => {
    const { addToast } = useToastStore.getState();
    addToast('Copied path', 'success');
    addToast('Unlocked', 'success', { dismissOnTimeout: false });
    addToast('Pinned', 'success', { quiet: false });
    addToast('oops', 'error');
    expect(useToastStore.getState().toasts.map((toast) => toast.quiet)).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });

  it('marks plain error toasts to stay until dismissed', () => {
    useToastStore.getState().addToast('oops', 'error');
    expect(useToastStore.getState().toasts[0].dismissOnTimeout).toBe(false);

    const id = useToastStore.getState().toasts[0].id;
    useToastStore.getState().removeToast(id);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('marks error toasts for timed dismissal when explicitly requested', () => {
    useToastStore.getState().addToast('oops', 'error', { dismissOnTimeout: true });
    expect(useToastStore.getState().toasts[0].dismissOnTimeout).toBe(true);
  });

  it('marks toasts with an action for timed dismissal', () => {
    useToastStore.getState().addToast('action-toast', 'error', {
      action: { label: 'Undo', onClick: vi.fn() },
    });
    expect(useToastStore.getState().toasts[0].dismissOnTimeout).toBe(true);
  });

  it('keeps only the four newest toasts', () => {
    for (let i = 1; i <= 6; i++) {
      useToastStore.getState().addToast(`toast ${i}`, 'error');
    }
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual([
      'toast 3',
      'toast 4',
      'toast 5',
      'toast 6',
    ]);
  });

  it('stores action on toast', () => {
    const onClick = vi.fn();
    useToastStore.getState().addToast('msg', 'success', {
      action: { label: 'Do', onClick },
    });
    const toast = useToastStore.getState().toasts[0];
    expect(toast.action?.label).toBe('Do');
    toast.action?.onClick();
    expect(onClick).toHaveBeenCalled();
  });

  it('removeToast is a no-op for unknown id', () => {
    useToastStore.getState().addToast('msg', 'success');
    useToastStore.getState().removeToast('nonexistent');
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });
});
