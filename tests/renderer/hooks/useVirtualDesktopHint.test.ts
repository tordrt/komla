/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useVirtualDesktopHint } from '../../../src/renderer/hooks/useVirtualDesktopHint';
import { useToastStore } from '../../../src/renderer/stores/toast.store';
import { useWorkspacesStore } from '../../../src/renderer/stores/workspaces.store';

import type { Workspace } from '../../../src/shared/types/workspace';

type PtyDataHandler = (terminalId: string, data: string, seq: number) => void;

let emit: PtyDataHandler;

function workspace(id: string, overrides: Partial<Workspace>, terminalIds: string[]): Workspace {
  return {
    id,
    name: id,
    workingDirectory: `/work/${id}`,
    isWorktree: true,
    projectId: 'project-1',
    terminals: terminalIds.map((terminalId) => ({ id: terminalId })),
    ...overrides,
  } as Workspace;
}

const sshBackend = { kind: 'ssh', hostId: 'host-1' } as unknown as Workspace['backend'];

function toastMessages(): string[] {
  return useToastStore.getState().toasts.map((toast) => toast.message);
}

describe('useVirtualDesktopHint', () => {
  beforeEach(() => {
    localStorage.clear();
    useToastStore.setState({ toasts: [] });
    useWorkspacesStore.setState({
      workspaces: [
        workspace('ssh-ws', { backend: sshBackend }, ['ssh-term', 'other-ssh-term']),
        workspace('ssh-ws-2', { backend: sshBackend }, ['second-ssh-term']),
        workspace('local-ws', {}, ['local-term']),
      ],
    });
    (window as unknown as { api: unknown }).api = {
      onPtyData: vi.fn((handler: PtyDataHandler) => {
        emit = handler;
        return () => {};
      }),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['Electron', '[1234:ERROR:ozone_platform_x11.cc(240)] Missing X server or $DISPLAY'],
    ['GTK', '(app:42): Gtk-WARNING **: 10:00:00.000: cannot open display: '],
    ['Qt', 'qt.qpa.xcb: could not connect to display '],
    ['Tk', '_tkinter.TclError: no display name and no $DISPLAY environment variable'],
    ['winit', 'Failed to initialize any backend! X11 status: XOpenDisplayFailed'],
    ['Xlib', "Error: Can't open display: "],
    ['Firefox', 'Error: no DISPLAY environment variable specified'],
    ['Tk', 'couldn\'t connect to display ":1"'],
    ['Java AWT', 'java.awt.AWTError: No X11 DISPLAY variable was set'],
  ])('suggests a virtual desktop when %s finds no display on an SSH host', (_app, line) => {
    renderHook(() => useVirtualDesktopHint());
    act(() => emit('ssh-term', `${line}\r\n`, 1));

    expect(toastMessages()).toEqual([expect.stringContaining('komla desktop run -- <command>')]);
  });

  it('finds the error through colors and across output chunks', () => {
    renderHook(() => useVirtualDesktopHint());
    act(() => emit('ssh-term', '\x1b[31mMissing X server ', 1));
    act(() => emit('ssh-term', 'or $DISPLAY\x1b[0m\r\n', 2));

    expect(toastMessages()).toHaveLength(1);
  });

  it('reads a space an agent TUI skips over with the cursor', () => {
    renderHook(() => useVirtualDesktopHint());
    act(() => emit('ssh-term', 'Missing\x1b[1CX\x1b[1Cserver\x1b[1Cor\x1b[1C$DISPLAY', 1));

    expect(toastMessages()).toHaveLength(1);
  });

  it('ignores local terminals and SSH terminals that run in the Local copy', () => {
    useWorkspacesStore.setState({
      workspaces: [
        workspace('local-ws', {}, ['local-term']),
        {
          ...workspace('ssh-ws', { backend: sshBackend }, []),
          terminals: [{ id: 'mirror-term', executionLocation: 'local-mirror' }],
        } as Workspace,
      ],
    });
    renderHook(() => useVirtualDesktopHint());
    act(() => emit('local-term', 'Missing X server or $DISPLAY\r\n', 1));
    act(() => emit('mirror-term', 'Missing X server or $DISPLAY\r\n', 1));

    expect(toastMessages()).toEqual([]);
  });

  it('watches a terminal opened after it started', () => {
    renderHook(() => useVirtualDesktopHint());
    act(() =>
      useWorkspacesStore.setState({
        workspaces: [workspace('ssh-ws', { backend: sshBackend }, ['new-ssh-term'])],
      })
    );
    act(() => emit('new-ssh-term', 'cannot open display\r\n', 1));

    expect(toastMessages()).toHaveLength(1);
  });

  it('ignores ordinary output', () => {
    renderHook(() => useVirtualDesktopHint());
    act(() => emit('ssh-term', 'Display settings saved\r\n', 1));

    expect(toastMessages()).toEqual([]);
  });

  it('suggests it once per workspace', () => {
    renderHook(() => useVirtualDesktopHint());
    act(() => emit('ssh-term', 'cannot open display\r\n', 1));
    act(() => emit('other-ssh-term', 'cannot open display\r\n', 1));
    act(() => emit('second-ssh-term', 'cannot open display\r\n', 1));

    expect(toastMessages()).toHaveLength(2);
  });

  it('remembers across restarts which workspaces it suggested it in', () => {
    const firstRun = renderHook(() => useVirtualDesktopHint());
    act(() => emit('ssh-term', 'cannot open display\r\n', 1));
    firstRun.unmount();
    useToastStore.setState({ toasts: [] });

    // tmux redraws the old error when the terminal reattaches.
    renderHook(() => useVirtualDesktopHint());
    act(() => emit('ssh-term', 'cannot open display\r\n', 1));
    act(() => emit('second-ssh-term', 'cannot open display\r\n', 1));

    expect(toastMessages()).toHaveLength(1);
  });

  it('stays quiet after "Don’t show again"', () => {
    renderHook(() => useVirtualDesktopHint());
    act(() => emit('ssh-term', 'cannot open display\r\n', 1));
    act(() => useToastStore.getState().toasts[0].action?.onClick());
    act(() => emit('second-ssh-term', 'cannot open display\r\n', 1));

    expect(toastMessages()).toHaveLength(1);
  });
});
