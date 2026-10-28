/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastContainer, ToastOverlay } from '../../../../src/renderer/components/ui/toast';
import { useToastStore } from '../../../../src/renderer/stores/toast.store';

import { TOAST_OVERLAY_MESSAGE_MAX_LENGTH } from '../../../../src/shared/types';

import type { ToastOverlayContent } from '../../../../src/shared/types';

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function toastElement(message: string): HTMLElement {
  const element = screen.getByText(message).closest('.toast-enter');
  if (!element) throw new Error(`toast "${message}" not found`);
  return element as HTMLElement;
}

describe('ToastContainer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.setState(useToastStore.getInitialState(), true);
    window.api = {
      copyToClipboard: vi.fn(),
      hideToastOverlay: vi.fn(),
      onToastOverlayEvent: vi.fn(() => () => {}),
      showToastOverlay: vi.fn(),
    } as unknown as typeof window.api;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('plays the exit animation before removing a timed-out toast', () => {
    act(() => {
      useToastStore.getState().addToast('Saved', 'success');
    });
    render(<ToastContainer />);

    advance(3000);
    expect(toastElement('Saved')).toHaveClass('toast-exit');

    advance(200);
    expect(screen.queryByText('Saved')).toBeNull();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('pauses auto-dismiss while the pointer is over the toast', () => {
    act(() => {
      useToastStore.getState().addToast('Saved', 'success');
    });
    render(<ToastContainer />);

    advance(1000);
    fireEvent.mouseEnter(toastElement('Saved'));
    advance(10_000);
    expect(screen.getByText('Saved')).toBeInTheDocument();
    expect(toastElement('Saved')).not.toHaveClass('toast-exit');

    fireEvent.mouseLeave(toastElement('Saved'));
    advance(1999);
    expect(toastElement('Saved')).not.toHaveClass('toast-exit');
    advance(1 + 200);
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('pauses auto-dismiss while focus is inside the toast', () => {
    act(() => {
      useToastStore.getState().addToast('Saved', 'info');
    });
    render(<ToastContainer />);

    fireEvent.focus(screen.getByRole('button', { name: 'Dismiss notification' }));
    advance(10_000);
    expect(toastElement('Saved')).not.toHaveClass('toast-exit');

    fireEvent.blur(screen.getByRole('button', { name: 'Dismiss notification' }));
    advance(3000 + 200);
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('announces toasts politely and labels the dismiss button', () => {
    act(() => {
      useToastStore.getState().addToast('Something failed', 'error');
    });
    render(<ToastContainer />);

    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('Something failed');
    expect(screen.getByRole('button', { name: 'Dismiss notification' })).toBeInTheDocument();
  });

  it('closes an error toast shortly after its message is copied', () => {
    act(() => {
      useToastStore.getState().addToast('Push failed', 'error');
    });
    render(<ToastContainer />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy error message' }));
    expect(window.api.copyToClipboard).toHaveBeenCalledWith('Push failed');
    expect(screen.getByRole('button', { name: 'Copied error message' })).toBeInTheDocument();
    expect(toastElement('Push failed')).not.toHaveClass('toast-exit');

    advance(600);
    expect(toastElement('Push failed')).toHaveClass('toast-exit');

    advance(200);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('keeps an error toast with an action open after its message is copied', () => {
    act(() => {
      useToastStore.getState().addToast('Rebase hit conflicts', 'error', {
        action: { label: 'Abort rebase', onClick: vi.fn() },
      });
    });
    render(<ToastContainer />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy error message' }));
    expect(screen.getByRole('button', { name: 'Copied error message' })).toBeInTheDocument();

    advance(1500);
    expect(toastElement('Rebase hit conflicts')).not.toHaveClass('toast-exit');
    expect(screen.getByRole('button', { name: 'Abort rebase' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy error message' })).toBeInTheDocument();
  });

  it('marks an info toast with a still icon rather than a loading spinner', () => {
    act(() => {
      useToastStore.getState().addToast('No workspaces need input', 'info');
      useToastStore.getState().addToast('Right-click a pane', 'info', {
        dismissOnTimeout: false,
        action: { label: 'Show pane headers', onClick: vi.fn() },
      });
      useToastStore.getState().addToast('Stays until closed', 'info', { dismissOnTimeout: false });
    });
    render(<ToastContainer />);

    expect(toastElement('No workspaces need input').querySelector('.animate-spin')).toBeNull();
    expect(toastElement('Right-click a pane').querySelector('.animate-spin')).toBeNull();
    expect(toastElement('Stays until closed').querySelector('.animate-spin')).toBeNull();
  });

  it('shows a spinner on a toast whose work is still running', () => {
    act(() => {
      useToastStore.getState().addToast('Deleting workspace "demo"...', 'info', {
        dismissOnTimeout: false,
        progress: true,
      });
    });
    render(<ToastContainer />);

    expect(
      toastElement('Deleting workspace "demo"...').querySelector('.animate-spin')
    ).not.toBeNull();
  });

  it('draws a quiet toast with its action but no icon or dismiss button', () => {
    const onUndo = vi.fn();
    act(() => {
      useToastStore.getState().addToast('Launched in komla', 'success', {
        quiet: true,
        action: { label: 'Undo', onClick: onUndo },
      });
    });
    render(<ToastContainer />);

    const toast = toastElement('Launched in komla');
    expect(toast.querySelector('svg')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dismiss notification' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledOnce();
  });

  it('keeps a quiet toast at its own width beside a wider toast', () => {
    act(() => {
      useToastStore.getState().addToast('Copied', 'success');
      useToastStore.getState().addToast('Push failed: permission denied', 'error');
    });
    render(<ToastContainer />);

    expect(toastElement('Copied')).toHaveClass('self-end');
    expect(toastElement('Push failed: permission denied')).not.toHaveClass('self-end');
  });

  it('shows at most four toasts, keeping the newest', () => {
    act(() => {
      for (let i = 1; i <= 6; i++) {
        useToastStore.getState().addToast(`Toast ${i}`, 'error');
      }
    });
    render(<ToastContainer />);

    expect(screen.queryByText('Toast 1')).toBeNull();
    expect(screen.queryByText('Toast 2')).toBeNull();
    for (let i = 3; i <= 6; i++) {
      expect(screen.getByText(`Toast ${i}`)).toBeInTheDocument();
    }
  });
});

describe('ToastContainer next to a native browser preview', () => {
  const previewHost = document.createElement('div');
  previewHost.dataset.nativeView = 'dev-preview';
  let previewRect = { left: 600, right: 1200, top: 40, bottom: 800 };

  function stack(): HTMLElement {
    return screen.getByRole('status').firstElementChild as HTMLElement;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.setState(useToastStore.getInitialState(), true);
    window.api = {
      copyToClipboard: vi.fn(),
      hideToastOverlay: vi.fn(),
      onToastOverlayEvent: vi.fn(() => () => {}),
      showToastOverlay: vi.fn(),
    } as unknown as typeof window.api;
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      value: 1200,
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        const box = this.dataset.nativeView
          ? previewRect
          : this.classList.contains('left-4')
            ? { left: 16, right: 300, top: 740, bottom: 784 }
            : this.classList.contains('right-4')
              ? { left: 900, right: 1184, top: 740, bottom: 784 }
              : { left: 0, right: 0, top: 0, bottom: 0 };
        return DOMRect.fromRect({
          x: box.left,
          y: box.top,
          width: box.right - box.left,
          height: box.bottom - box.top,
        });
      }
    );
    document.body.appendChild(previewHost);
    act(() => {
      useToastStore.getState().addToast('Saved', 'success');
    });
  });

  afterEach(() => {
    previewHost.remove();
    delete (document.documentElement as { clientWidth?: number }).clientWidth;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('moves to the bottom-left corner when a preview covers the bottom-right', () => {
    previewRect = { left: 600, right: 1200, top: 40, bottom: 800 };
    render(<ToastContainer />);

    expect(stack()).toHaveClass('left-4', 'toast-stack-left');
    expect(stack()).not.toHaveAttribute('data-native-overlay');
  });

  it('returns to the bottom-right corner once the preview goes away', () => {
    previewRect = { left: 600, right: 1200, top: 40, bottom: 800 };
    render(<ToastContainer />);
    expect(stack()).toHaveClass('left-4');

    previewHost.remove();
    advance(50);

    expect(stack()).toHaveClass('right-4');
  });

  it('draws the stack in the overlay layer above the preview when neither corner is free', () => {
    previewRect = { left: 0, right: 1200, top: 40, bottom: 800 };
    document.documentElement.className = 'dark';
    render(<ToastContainer />);

    expect(stack()).toHaveClass('right-4');
    expect(stack()).not.toHaveAttribute('data-native-overlay');
    // Any part of this copy outside the preview would show as a second toast.
    expect(stack()).toHaveClass('opacity-0');
    expect(toastElement('Saved')).not.toHaveClass('pointer-events-auto');
    expect(window.api.showToastOverlay).toHaveBeenCalledWith({
      bounds: { x: 900, y: 740, width: 284, height: 44 },
      toasts: [
        {
          id: useToastStore.getState().toasts[0].id,
          message: 'Saved',
          type: 'success',
          actionLabel: undefined,
          dismissOnTimeout: true,
          quiet: true,
        },
      ],
      themeClassName: 'dark',
      themeStyle: '',
      messageMaxHeight: window.innerHeight * 0.4,
    });
    document.documentElement.className = '';
  });

  it('cuts a message longer than the overlay layer accepts', () => {
    previewRect = { left: 0, right: 1200, top: 40, bottom: 800 };
    act(() => {
      useToastStore.getState().addToast('x'.repeat(TOAST_OVERLAY_MESSAGE_MAX_LENGTH + 1), 'error');
    });
    render(<ToastContainer />);

    const sent = vi.mocked(window.api.showToastOverlay).mock.lastCall?.[0];
    expect(sent?.toasts.at(-1)?.message).toHaveLength(TOAST_OVERLAY_MESSAGE_MAX_LENGTH);
  });

  it('tells the overlay layer which toasts report work that is still running', () => {
    previewRect = { left: 0, right: 1200, top: 40, bottom: 800 };
    act(() => {
      useToastStore.getState().addToast('Deleting workspace "demo"...', 'info', {
        dismissOnTimeout: false,
        progress: true,
      });
    });
    render(<ToastContainer />);

    const sent = vi.mocked(window.api.showToastOverlay).mock.lastCall?.[0];
    expect(sent?.toasts.map((toast) => toast.progress)).toEqual([undefined, true]);
  });

  it('tells the overlay layer which toasts are quiet', () => {
    previewRect = { left: 0, right: 1200, top: 40, bottom: 800 };
    act(() => {
      useToastStore.getState().addToast('Launched in komla', 'success', { quiet: true });
    });
    render(<ToastContainer />);

    const sent = vi.mocked(window.api.showToastOverlay).mock.lastCall?.[0];
    expect(sent?.toasts.at(-1)?.quiet).toBe(true);
  });

  it('sends the overlay layer only what changed, not every frame', () => {
    previewRect = { left: 0, right: 1200, top: 40, bottom: 800 };
    render(<ToastContainer />);
    advance(100);
    expect(window.api.showToastOverlay).toHaveBeenCalledTimes(1);

    act(() => {
      useToastStore.getState().addToast('Copied', 'success');
    });
    advance(50);
    expect(window.api.showToastOverlay).toHaveBeenCalledTimes(2);
    expect(vi.mocked(window.api.showToastOverlay).mock.lastCall?.[0].toasts).toHaveLength(2);
  });

  it('leaves the countdown to the overlay layer while it shows the toasts', () => {
    previewRect = { left: 0, right: 1200, top: 40, bottom: 800 };
    render(<ToastContainer />);

    advance(10_000);

    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it('takes the toasts back from the overlay layer once a corner is free', () => {
    previewRect = { left: 0, right: 1200, top: 40, bottom: 800 };
    render(<ToastContainer />);
    expect(window.api.hideToastOverlay).not.toHaveBeenCalled();

    previewRect = { left: 600, right: 1200, top: 40, bottom: 800 };
    advance(50);

    expect(window.api.hideToastOverlay).toHaveBeenCalledTimes(1);
    expect(stack()).toHaveClass('left-4');
    expect(stack()).not.toHaveClass('opacity-0');
    expect(toastElement('Saved')).toHaveClass('pointer-events-auto');
    advance(3000 + 200);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('applies removals and actions from the overlay layer', () => {
    const onClick = vi.fn();
    act(() => {
      useToastStore
        .getState()
        .addToast('Update ready', 'info', { action: { label: 'Restart', onClick } });
    });
    render(<ToastContainer />);
    const onOverlayEvent = vi.mocked(window.api.onToastOverlayEvent).mock.calls[0][0];
    const [saved, update] = useToastStore.getState().toasts;

    act(() => onOverlayEvent({ type: 'action', id: update.id }));
    expect(onClick).toHaveBeenCalledTimes(1);

    act(() => onOverlayEvent({ type: 'remove', id: saved.id }));
    expect(useToastStore.getState().toasts.map((toast) => toast.id)).toEqual([update.id]);
  });
});

describe('ToastOverlay', () => {
  let sendContent: (content: ToastOverlayContent) => void;

  function content(toasts: ToastOverlayContent['toasts']): ToastOverlayContent {
    return {
      toasts,
      themeClassName: 'dark',
      themeStyle: '--primary: 0.5 0.1 200;',
      messageMaxHeight: 320,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    window.api = {
      copyToClipboard: vi.fn(),
      onToastOverlayContent: vi.fn((callback: (content: ToastOverlayContent) => void) => {
        sendContent = callback;
        return () => {};
      }),
      releaseToastOverlayFocus: vi.fn(),
      sendToastOverlayEvent: vi.fn(),
    } as unknown as typeof window.api;
  });

  afterEach(() => {
    document.documentElement.className = '';
    document.documentElement.style.cssText = '';
    vi.useRealTimers();
  });

  it("shows the main window's toasts in its theme", () => {
    render(<ToastOverlay />);
    act(() => {
      sendContent(
        content([{ id: 'a', message: 'Saved', type: 'success', dismissOnTimeout: true }])
      );
    });

    expect(screen.getByText('Saved')).toBeInTheDocument();
    expect(screen.getByText('Saved')).toHaveStyle({ maxHeight: '320px' });
    expect(document.documentElement).toHaveClass('dark');
    expect(document.documentElement.style.getPropertyValue('--primary')).toBe('0.5 0.1 200');
  });

  it('counts down and reports the removal to the main window', () => {
    render(<ToastOverlay />);
    act(() => {
      sendContent(
        content([{ id: 'a', message: 'Saved', type: 'success', dismissOnTimeout: true }])
      );
    });

    advance(3000 + 200);

    expect(screen.queryByText('Saved')).toBeNull();
    expect(window.api.sendToastOverlayEvent).toHaveBeenCalledWith({ type: 'remove', id: 'a' });
  });

  it('does not bring back a toast the main window has not removed yet', () => {
    const saved = { id: 'a', message: 'Saved', type: 'success', dismissOnTimeout: true } as const;
    render(<ToastOverlay />);
    act(() => sendContent(content([saved])));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    advance(200);

    act(() => sendContent(content([saved])));

    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('shows the spinner of a toast whose work is still running', () => {
    render(<ToastOverlay />);
    act(() => {
      sendContent(
        content([
          {
            id: 'a',
            message: 'Deleting workspace "demo"...',
            type: 'info',
            dismissOnTimeout: false,
            progress: true,
          },
        ])
      );
    });

    expect(
      toastElement('Deleting workspace "demo"...').querySelector('.animate-spin')
    ).not.toBeNull();
  });

  it('runs actions in the main window', () => {
    render(<ToastOverlay />);
    act(() => {
      sendContent(
        content([
          {
            id: 'a',
            message: 'Update ready',
            type: 'info',
            actionLabel: 'Restart',
            dismissOnTimeout: true,
          },
        ])
      );
    });

    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    advance(200);

    expect(window.api.sendToastOverlayEvent).toHaveBeenNthCalledWith(1, {
      type: 'action',
      id: 'a',
    });
    expect(window.api.sendToastOverlayEvent).toHaveBeenNthCalledWith(2, {
      type: 'remove',
      id: 'a',
    });
  });

  it('reports finished clicks so the main process can hand focus back', () => {
    render(<ToastOverlay />);

    fireEvent.pointerUp(window);

    expect(window.api.releaseToastOverlayFocus).toHaveBeenCalledTimes(1);
  });
});
