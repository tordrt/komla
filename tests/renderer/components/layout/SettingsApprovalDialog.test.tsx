/**
 * @vitest-environment jsdom
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsApprovalDialog } from '../../../../src/renderer/components/layout/SettingsApprovalDialog';
import { openWorkspace } from '../../../../src/renderer/lib/open-workspace';
import { useCustomizationStore } from '../../../../src/renderer/stores/customization.store';
import { useWindowStore } from '../../../../src/renderer/stores/window.store';
import { useWorkspacesStore } from '../../../../src/renderer/stores/workspaces.store';
import { createTerminal, createWorktreeWorkspace } from '../../../factories';

import type { SettingsApprovalPrompt, ThemeConfig } from '../../../../src/shared/types';

vi.mock('../../../../src/renderer/lib/monaco-loader', () => ({}));
vi.mock('../../../../src/renderer/lib/terminal-renderer-runtime', () => ({}));
vi.mock('../../../../src/renderer/lib/open-workspace', () => ({
  openWorkspace: vi.fn().mockResolvedValue(undefined),
}));

const dialog = vi.hoisted(() => ({
  onOpenChange: undefined as ((open: boolean) => void) | undefined,
}));

vi.mock('../../../../src/renderer/components/ui/dialog', () => ({
  Dialog: ({
    open,
    onOpenChange,
    children,
  }: React.PropsWithChildren<{ open?: boolean; onOpenChange?: (open: boolean) => void }>) => {
    dialog.onOpenChange = onOpenChange;
    return open ? <div>{children}</div> : null;
  },
  DialogContent: React.forwardRef<
    HTMLDivElement,
    React.PropsWithChildren<{
      onPointerDownOutside?: (event: Event) => void;
      onOpenAutoFocus?: (event: Event) => void;
      onFocusOutside?: (event: Event) => void;
      onInteractOutside?: (event: Event) => void;
      onCloseAutoFocus?: (event: Event) => void;
    }>
  >(function DialogContent(
    {
      children,
      onPointerDownOutside,
      onOpenAutoFocus,
      onFocusOutside,
      onInteractOutside,
      onCloseAutoFocus,
    },
    ref
  ) {
    const content = React.useRef<HTMLDivElement | null>(null);
    // Radix focuses the first focusable element once the dialog opens, unless the handler prevents
    // it or focus is already inside, and moves focus back to what had it once the dialog closes,
    // unless that handler prevents it.
    const closeAutoFocus = React.useRef(onCloseAutoFocus);
    closeAutoFocus.current = onCloseAutoFocus;
    React.useEffect(() => {
      const focusedBefore = document.activeElement as HTMLElement | null;
      const element = content.current;
      if (element) {
        const event = new Event('openautofocus', { cancelable: true });
        const handler = (dispatched: Event) => onOpenAutoFocus?.(dispatched);
        element.addEventListener('openautofocus', handler);
        element.dispatchEvent(event);
        element.removeEventListener('openautofocus', handler);
        if (!event.defaultPrevented && !element.contains(document.activeElement)) {
          element.querySelector<HTMLElement>('button')?.focus();
        }
      }
      return () => {
        const event = new Event('closeautofocus', { cancelable: true });
        closeAutoFocus.current?.(event);
        if (!event.defaultPrevented) focusedBefore?.focus();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // Radix closes the dialog on an outside press or focus unless a handler prevents it.
    const outside = (handler?: (event: Event) => void) => () => {
      const event = new Event('interactoutside', { cancelable: true });
      handler?.(event);
      onInteractOutside?.(event);
      if (!event.defaultPrevented) dialog.onOpenChange?.(false);
    };
    return (
      <div
        ref={(element) => {
          content.current = element;
          if (typeof ref === 'function') ref(element);
          else if (ref) ref.current = element;
        }}
        tabIndex={-1}
        data-testid="dialog-content"
      >
        {children}
        <button onClick={outside(onPointerDownOutside)}>Outside</button>
        <button onClick={outside(onFocusOutside)}>Focus outside</button>
      </div>
    );
  }),
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
}));

let onRequested: ((prompt: SettingsApprovalPrompt) => void) | undefined;
let onDismissed: ((id: string) => void) | undefined;
const resolveSettingsApproval = vi.fn().mockResolvedValue(true);
const requestPendingSettingsApproval = vi.fn().mockResolvedValue(false);
const savedTheme: ThemeConfig = {
  mode: 'dark',
  palette: 'default',
  colors: { accent: 'oklch(0.65 0.15 250)' },
  typography: { fontFamily: 'Inter', fontSize: 14, borderRadius: 6 },
};
const getTheme = vi.fn();
const appearancePrompt: SettingsApprovalPrompt = {
  id: 'appearance-1',
  resource: 'appearance',
  target: 'Appearance',
  changes: [
    {
      operation: 'change',
      kind: 'theme',
      title: 'Nord',
      details: [{ label: 'From', value: 'Default' }],
    },
  ],
  preview: { palette: 'nord', accent: 'oklch(0.65 0.15 145)', borderRadius: 8 },
};

describe('SettingsApprovalDialog', () => {
  beforeEach(() => {
    onRequested = undefined;
    onDismissed = undefined;
    resolveSettingsApproval.mockClear().mockResolvedValue(true);
    requestPendingSettingsApproval.mockResolvedValue(false);
    global.window.api = {
      onSettingsApprovalRequested: vi.fn((callback) => {
        onRequested = callback;
        return vi.fn();
      }),
      onSettingsApprovalDismissed: vi.fn((callback) => {
        onDismissed = callback;
        return vi.fn();
      }),
      resolveSettingsApproval,
      requestPendingSettingsApproval,
      getTheme,
    } as typeof window.api;
    getTheme.mockResolvedValue(savedTheme);
    useCustomizationStore.setState({ theme: savedTheme });
    useWorkspacesStore.setState({ workspaces: [] });
    useWindowStore.setState({ windowId: 'window-1' });
    vi.mocked(openWorkspace).mockClear();
  });

  it('shows proposed appearance until the user cancels it', async () => {
    const user = userEvent.setup();
    render(<SettingsApprovalDialog />);

    act(() => onRequested?.(appearancePrompt));

    expect(screen.getByText(/nothing is saved until you apply it/)).toBeInTheDocument();
    expect(useCustomizationStore.getState().theme).toMatchObject({
      palette: 'nord',
      colors: { accent: 'oklch(0.65 0.15 145)' },
      typography: { fontFamily: 'Inter', borderRadius: 8 },
    });

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(resolveSettingsApproval).toHaveBeenCalledWith('appearance-1', 'cancel');
    await waitFor(() => expect(useCustomizationStore.getState().theme).toBe(savedTheme));
  });

  it('keeps showing the proposed appearance when theme.json changes meanwhile', async () => {
    const user = userEvent.setup();
    render(<SettingsApprovalDialog />);
    act(() => onRequested?.(appearancePrompt));

    act(() =>
      useCustomizationStore.setState({
        theme: { ...savedTheme, typography: { ...savedTheme.typography, fontSize: 16 } },
      })
    );

    expect(useCustomizationStore.getState().theme).toMatchObject({
      palette: 'nord',
      typography: { fontSize: 16, borderRadius: 8 },
    });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(useCustomizationStore.getState().theme).toBe(savedTheme));
  });

  it('shows the saved appearance once the user applies the change', async () => {
    const appliedTheme = { ...savedTheme, palette: 'nord' };
    const user = userEvent.setup();
    render(<SettingsApprovalDialog />);
    act(() => onRequested?.(appearancePrompt));
    getTheme.mockResolvedValue(appliedTheme);

    await user.click(screen.getByRole('button', { name: 'Apply changes' }));

    expect(resolveSettingsApproval).toHaveBeenCalledWith('appearance-1', 'apply');
    await waitFor(() => expect(useCustomizationStore.getState().theme).toBe(appliedTheme));
  });

  it('asks whether to send a message into a terminal, not whether to apply settings', async () => {
    const user = userEvent.setup();
    render(<SettingsApprovalDialog />);

    act(() =>
      onRequested?.({
        id: 'send-1',
        resource: 'terminal-send',
        target: 'Terminal message',
        description: 'An agent wants to type this into Codex and press Enter.',
        warning: 'Codex is waiting for you: Run rm -rf?. This message answers it.',
        changes: [
          {
            operation: 'send',
            kind: 'terminal-message',
            title: 'Codex',
            content: 'yes',
            details: [],
          },
        ],
      })
    );

    expect(screen.getByRole('heading', { name: 'Allow this message?' })).toBeInTheDocument();
    expect(screen.getByText('An agent wants to type this into Codex and press Enter.')).toBeVisible();
    expect(screen.getByText(/This message answers it/)).toBeVisible();
    expect(screen.getByText('yes')).toBeVisible();
    expect(screen.getByText('Send', { selector: 'span' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Apply changes' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Send message' }));

    expect(resolveSettingsApproval).toHaveBeenCalledWith('send-1', 'apply');
  });

  it('calls a message waiting in the corner a message, not settings changes', async () => {
    const user = userEvent.setup();
    render(<SettingsApprovalDialog />);
    act(() =>
      onRequested?.({
        id: 'send-2',
        resource: 'terminal-send',
        target: 'Terminal message',
        changes: [],
      })
    );

    await user.click(screen.getByRole('button', { name: 'Outside' }));

    expect(screen.getByRole('region', { name: 'Message waiting' })).toBeInTheDocument();
  });

  it('keeps previewing while the user clicks outside the dialog to look around', async () => {
    const user = userEvent.setup();
    render(<SettingsApprovalDialog />);
    act(() => onRequested?.(appearancePrompt));

    await user.click(screen.getByRole('button', { name: 'Outside' }));

    expect(resolveSettingsApproval).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('heading', { name: 'Review settings changes' })
    ).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Settings changes waiting' })).toBeInTheDocument();
    expect(useCustomizationStore.getState().theme).toMatchObject({ palette: 'nord' });
  });

  it('keeps waiting for a decision when the user clicks outside the dialog', async () => {
    const user = userEvent.setup();
    render(<SettingsApprovalDialog />);
    act(() => onRequested?.({ ...appearancePrompt, id: 'approval-2', preview: undefined }));

    await user.click(screen.getByRole('button', { name: 'Outside' }));

    expect(resolveSettingsApproval).not.toHaveBeenCalled();
    const waiting = screen.getByRole('region', { name: 'Settings changes waiting' });
    await user.click(within(waiting).getByRole('button', { name: 'Review' }));
    expect(screen.getByRole('heading', { name: 'Review settings changes' })).toBeInTheDocument();
  });

  it('stays open when focus moves outside the dialog', async () => {
    const user = userEvent.setup();
    render(<SettingsApprovalDialog />);
    act(() => onRequested?.({ ...appearancePrompt, id: 'approval-8', preview: undefined }));

    await user.click(screen.getByRole('button', { name: 'Focus outside' }));

    expect(resolveSettingsApproval).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Review settings changes' })).toBeInTheDocument();
  });

  it('lifts toasts above the card left while the user looks around', async () => {
    const user = userEvent.setup();
    const root = document.documentElement;
    render(<SettingsApprovalDialog />);
    act(() => onRequested?.({ ...appearancePrompt, id: 'approval-9', preview: undefined }));
    expect(root.style.getPropertyValue('--toast-inset')).toBe('');

    await user.click(screen.getByRole('button', { name: 'Look around first' }));
    expect(root.style.getPropertyValue('--toast-inset')).not.toBe('');

    const waiting = screen.getByRole('region', { name: 'Settings changes waiting' });
    await user.click(within(waiting).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(root.style.getPropertyValue('--toast-inset')).toBe(''));
  });

  it('says the card is cancelling while the decision goes through', async () => {
    resolveSettingsApproval.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    render(<SettingsApprovalDialog />);
    act(() => onRequested?.({ ...appearancePrompt, id: 'approval-12', preview: undefined }));

    await user.click(screen.getByRole('button', { name: 'Look around first' }));
    const waiting = screen.getByRole('region', { name: 'Settings changes waiting' });
    await user.click(within(waiting).getByRole('button', { name: 'Cancel' }));

    expect(within(waiting).getByRole('button', { name: 'Cancelling…' })).toBeDisabled();
    expect(within(waiting).getByRole('button', { name: 'Review' })).toBeDisabled();
  });

  it('moves focus to the card when the user looks around', async () => {
    const user = userEvent.setup();
    render(<SettingsApprovalDialog />);
    act(() => onRequested?.({ ...appearancePrompt, id: 'approval-13', preview: undefined }));

    await user.click(screen.getByRole('button', { name: 'Look around first' }));

    const waiting = screen.getByRole('region', { name: 'Settings changes waiting' });
    expect(within(waiting).getByRole('button', { name: 'Review' })).toHaveFocus();
  });

  it('cancels from the card left while the user looks around', async () => {
    const user = userEvent.setup();
    render(<SettingsApprovalDialog />);
    act(() => onRequested?.({ ...appearancePrompt, id: 'approval-3', preview: undefined }));

    await user.click(screen.getByRole('button', { name: 'Look around first' }));
    const waiting = screen.getByRole('region', { name: 'Settings changes waiting' });
    await user.click(within(waiting).getByRole('button', { name: 'Cancel' }));

    expect(resolveSettingsApproval).toHaveBeenCalledWith('approval-3', 'cancel');
    await waitFor(() =>
      expect(
        screen.queryByRole('region', { name: 'Settings changes waiting' })
      ).not.toBeInTheDocument()
    );
  });

  it('names the terminal that asked and opens it without deciding', async () => {
    const terminal = createTerminal({ id: 'terminal-1', name: 'Claude Code' });
    const workspace = createWorktreeWorkspace({
      id: 'workspace-1',
      customName: 'Fix login redirect',
      terminals: [terminal],
    });
    useWorkspacesStore.setState({ workspaces: [workspace] });
    const user = userEvent.setup();
    render(<SettingsApprovalDialog />);
    act(() =>
      onRequested?.({
        ...appearancePrompt,
        id: 'approval-4',
        preview: undefined,
        source: { workspaceId: 'workspace-1', terminalId: 'terminal-1' },
      })
    );

    expect(screen.getByText('Fix login redirect')).toBeInTheDocument();
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show terminal' }));

    expect(openWorkspace).toHaveBeenCalledWith(workspace, 'window-1', 'terminal-1');
    expect(resolveSettingsApproval).not.toHaveBeenCalled();
    const waiting = screen.getByRole('region', { name: 'Settings changes waiting' });
    expect(within(waiting).getByText('Fix login redirect')).toBeInTheDocument();
    await user.click(within(waiting).getByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'Apply changes' }));
    expect(resolveSettingsApproval).toHaveBeenCalledWith('approval-4', 'apply');
  });

  it('names a terminal only once when its workspace is titled after it', () => {
    const terminal = createTerminal({ id: 'terminal-1', name: 'Shell', dynamicTitle: 'npm test' });
    const workspace = createWorktreeWorkspace({ id: 'workspace-1', terminals: [terminal] });
    useWorkspacesStore.setState({ workspaces: [workspace] });
    render(<SettingsApprovalDialog />);
    act(() =>
      onRequested?.({
        ...appearancePrompt,
        id: 'approval-7',
        preview: undefined,
        source: { workspaceId: 'workspace-1', terminalId: 'terminal-1' },
      })
    );

    // Named as on its workspace's card, as the agent's own name beside the title.
    expect(screen.getAllByText('npm test')).toHaveLength(1);
    expect(screen.getByText('Shell')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show terminal' })).toBeInTheDocument();
  });

  it('names a workspace in the Trash without offering to open it', () => {
    const workspace = createWorktreeWorkspace({
      id: 'workspace-1',
      customName: 'Old work',
      status: 'trashed',
      terminals: [],
    });
    useWorkspacesStore.setState({ workspaces: [workspace] });
    render(<SettingsApprovalDialog />);
    act(() =>
      onRequested?.({
        ...appearancePrompt,
        id: 'approval-10',
        preview: undefined,
        source: { workspaceId: 'workspace-1' },
      })
    );

    expect(screen.queryByRole('button', { name: /Show (terminal|workspace)/ })).not.toBeInTheDocument();
  });

  it('names who is waiting in the card to screen readers too', async () => {
    const terminal = createTerminal({ id: 'terminal-1', name: 'Claude Code' });
    const workspace = createWorktreeWorkspace({
      id: 'workspace-1',
      customName: 'Fix login redirect',
      terminals: [terminal],
    });
    useWorkspacesStore.setState({ workspaces: [workspace] });
    const user = userEvent.setup();
    render(<SettingsApprovalDialog />);
    act(() =>
      onRequested?.({
        ...appearancePrompt,
        id: 'approval-11',
        preview: undefined,
        source: { workspaceId: 'workspace-1', terminalId: 'terminal-1' },
      })
    );

    await user.click(screen.getByRole('button', { name: 'Look around first' }));

    const waiting = screen.getByRole('region', { name: 'Settings changes waiting' });
    expect(
      within(waiting).getByRole('button', { name: /Show terminal.*Fix login redirect.*Claude Code/ })
    ).toBeInTheDocument();
  });

  it('opens the workspace that asked when its terminal is gone', async () => {
    const workspace = createWorktreeWorkspace({
      id: 'workspace-1',
      customName: 'Docs',
      terminals: [],
    });
    useWorkspacesStore.setState({ workspaces: [workspace] });
    const user = userEvent.setup();
    render(<SettingsApprovalDialog />);
    act(() =>
      onRequested?.({
        ...appearancePrompt,
        id: 'approval-5',
        preview: undefined,
        source: { workspaceId: 'workspace-1', terminalId: 'terminal-closed' },
      })
    );

    await user.click(screen.getByRole('button', { name: 'Show workspace' }));

    expect(openWorkspace).toHaveBeenCalledWith(workspace, 'window-1', undefined);
  });

  it('waits in the corner, without cancelling, when the user presses Escape', () => {
    render(<SettingsApprovalDialog />);
    act(() => onRequested?.({ ...appearancePrompt, id: 'approval-6', preview: undefined }));

    act(() => dialog.onOpenChange?.(false));

    expect(resolveSettingsApproval).not.toHaveBeenCalled();
    expect(screen.getByRole('region', { name: 'Settings changes waiting' })).toBeInTheDocument();
  });

  it('gives focus back to what had it when the user presses Escape', () => {
    render(
      <>
        <textarea aria-label="Terminal input" />
        <SettingsApprovalDialog />
      </>
    );
    const terminal = screen.getByRole('textbox', { name: 'Terminal input' });
    terminal.focus();
    act(() => onRequested?.({ ...appearancePrompt, id: 'approval-15', preview: undefined }));

    act(() => dialog.onOpenChange?.(false));

    expect(terminal).toHaveFocus();
  });

  it('gives focus back to what had it when the user presses Escape after looking around', async () => {
    const user = userEvent.setup();
    render(
      <>
        <textarea aria-label="Terminal input" />
        <SettingsApprovalDialog />
      </>
    );
    const terminal = screen.getByRole('textbox', { name: 'Terminal input' });
    terminal.focus();
    act(() => onRequested?.({ ...appearancePrompt, id: 'approval-19', preview: undefined }));
    await user.click(screen.getByRole('button', { name: 'Look around first' }));
    const waiting = screen.getByRole('region', { name: 'Settings changes waiting' });
    await user.click(within(waiting).getByRole('button', { name: 'Review' }));

    act(() => dialog.onOpenChange?.(false));

    expect(terminal).toHaveFocus();
  });

  it('stays open when the user presses Escape while a decision goes through', async () => {
    resolveSettingsApproval.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    render(<SettingsApprovalDialog />);
    act(() => onRequested?.({ ...appearancePrompt, id: 'approval-16', preview: undefined }));
    await user.click(screen.getByRole('button', { name: 'Apply changes' }));

    act(() => dialog.onOpenChange?.(false));

    expect(screen.getByRole('button', { name: 'Applying…' })).toBeInTheDocument();
  });

  it('decides nothing when the user presses Enter or Space as it opens', async () => {
    const user = userEvent.setup();
    render(<SettingsApprovalDialog />);
    act(() => onRequested?.({ ...appearancePrompt, id: 'approval-14', preview: undefined }));

    expect(screen.getByTestId('dialog-content')).toHaveFocus();
    await user.keyboard('{Enter} ');

    expect(resolveSettingsApproval).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Review settings changes' })).toBeInTheDocument();
  });

  it('decides nothing when the user presses Enter again as the next request takes its place', async () => {
    const user = userEvent.setup();
    render(<SettingsApprovalDialog />);
    act(() => {
      onRequested?.({ ...appearancePrompt, id: 'approval-17', preview: undefined });
      onRequested?.({ ...appearancePrompt, id: 'approval-18', target: 'Agents', preview: undefined });
    });
    screen.getByRole('button', { name: 'Apply changes' }).focus();

    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByText('Agents')).toBeInTheDocument());
    await user.keyboard('{Enter}');

    expect(resolveSettingsApproval).toHaveBeenCalledOnce();
    expect(resolveSettingsApproval).toHaveBeenCalledWith('approval-17', 'apply');
  });

  it('restores the saved appearance when the agent stops waiting', async () => {
    render(<SettingsApprovalDialog />);
    act(() => onRequested?.(appearancePrompt));

    act(() => onDismissed?.('appearance-1'));

    await waitFor(() => expect(useCustomizationStore.getState().theme).toBe(savedTheme));
  });

  it('requests any pending approval after its event listeners are mounted', () => {
    render(<SettingsApprovalDialog />);

    expect(window.api.onSettingsApprovalRequested).toHaveBeenCalledOnce();
    expect(window.api.onSettingsApprovalDismissed).toHaveBeenCalledOnce();
    expect(requestPendingSettingsApproval).toHaveBeenCalledOnce();
  });

  it('shows exact proposed settings and applies them from a Komla dialog', async () => {
    const user = userEvent.setup();
    render(<SettingsApprovalDialog />);

    act(() => {
      onRequested?.({
        id: 'approval-1',
        resource: 'actions',
        target: 'Komla Actions',
        warning: 'This Action is shared with Other.',
        changes: [
          {
            operation: 'add',
            kind: 'action',
            title: 'Run checks',
            contentLabel: 'Command',
            content: 'npm test -- --runInBand',
            details: [
              { label: 'Preset', value: 'Codex' },
              { label: 'Sandbox', value: 'Docker (automatic)' },
            ],
          },
        ],
      });
    });

    expect(screen.getByRole('heading', { name: 'Review settings changes' })).toBeInTheDocument();
    expect(screen.getByText('Komla Actions')).toBeInTheDocument();
    expect(screen.getByText('Run checks')).toBeInTheDocument();
    expect(screen.getByText('npm test -- --runInBand')).toBeInTheDocument();
    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(screen.getByText('Docker (automatic)')).toBeInTheDocument();
    expect(screen.getByText('This Action is shared with Other.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Apply changes' }));

    expect(resolveSettingsApproval).toHaveBeenCalledWith('approval-1', 'apply');
  });

  it('says who proposes a change that no agent asked for', () => {
    render(<SettingsApprovalDialog />);

    act(() => {
      onRequested?.({
        id: 'approval-1',
        resource: 'project-settings',
        target: 'web settings',
        description: 'Another computer changed web’s settings on Devbox.',
        changes: [
          {
            operation: 'change',
            kind: 'project-setting',
            title: 'Branch and merge settings',
            details: [{ label: 'Push after merging', previous: 'Default', value: 'Yes' }],
          },
        ],
      });
    });

    expect(
      screen.getByText('Another computer changed web’s settings on Devbox.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/An agent wants/)).not.toBeInTheDocument();
    expect(screen.getByText('Push after merging:')).toBeInTheDocument();
  });

  it('shows every command a change runs in full', () => {
    render(<SettingsApprovalDialog />);

    act(() => {
      onRequested?.({
        id: 'approval-1',
        resource: 'status-items',
        target: 'Status bar items',
        changes: [
          {
            operation: 'add',
            kind: 'status-item',
            title: 'pr',
            contentLabel: 'Command',
            content: 'gh pr view',
            moreContent: [{ label: 'Button command rerun', content: 'gh run rerun --failed' }],
            details: [],
          },
        ],
      });
    });

    expect(screen.getByText('gh pr view')).toBeInTheDocument();
    expect(screen.getByText('Button command rerun')).toBeInTheDocument();
    expect(screen.getByText('gh run rerun --failed')).toBeInTheDocument();
  });

  it('shows a changed command once, as what it was and what it becomes', () => {
    render(<SettingsApprovalDialog />);

    act(() => {
      onRequested?.({
        id: 'approval-agents',
        resource: 'agents',
        target: 'Agents',
        changes: [
          {
            operation: 'edit',
            kind: 'agent-preset',
            title: 'Claude Code',
            moreContent: [
              {
                label: 'Open command',
                content: 'claude --add-dir ~/notes --verbose',
                previous: 'claude --verbose',
              },
              {
                label: 'Levels',
                content: 'Low: --effort low\nHigh: --effort max',
                previous: 'Low: --effort low\nHigh: --effort high',
              },
            ],
            details: [{ label: 'Picker title', value: 'Effort', previous: 'Reasoning' }],
          },
        ],
      });
    });

    expect(screen.getAllByText('Open command')).toHaveLength(1);
    const command = screen.getByRole('figure', { name: 'Open command' });
    expect(within(command).getByRole('deletion')).toHaveTextContent('claude --verbose');
    const added = within(command).getByRole('insertion');
    expect(added).toHaveTextContent('claude --add-dir ~/notes --verbose');
    // The arguments the change adds stand out within the command.
    expect(added.querySelector('mark')).toHaveTextContent(/^--add-dir ~\/notes\s*$/);

    // A line both versions share shows once, as neither removed nor added.
    const levels = screen.getByRole('figure', { name: 'Levels' });
    expect(within(levels).getAllByText('Low: --effort low')).toHaveLength(1);
    expect(within(levels).getByRole('deletion')).toHaveTextContent('High: --effort high');
    expect(within(levels).getByRole('insertion')).toHaveTextContent('High: --effort max');

    expect(screen.getByText('Reasoning')).toBeInTheDocument();
    expect(screen.getByText('Effort')).toBeInTheDocument();
  });

  it('marks changed words only in a line the edit replaces in place', () => {
    render(<SettingsApprovalDialog />);

    act(() => {
      onRequested?.({
        id: 'approval-levels',
        resource: 'agents',
        target: 'Agents',
        changes: [
          {
            operation: 'edit',
            kind: 'agent-preset',
            title: 'Claude Code',
            moreContent: [
              {
                label: 'Levels',
                content: 'High: --effort high\nMax: --effort max',
                previous: 'Low: --effort low\nHigh: --effort high',
              },
            ],
            details: [],
          },
        ],
      });
    });

    const levels = screen.getByRole('figure', { name: 'Levels' });
    expect(within(levels).getByRole('deletion')).toHaveTextContent('Low: --effort low');
    expect(within(levels).getByRole('insertion')).toHaveTextContent('Max: --effort max');
    expect(levels.querySelector('mark')).toBeNull();
  });

  it('marks nothing in a line that changes as a whole', () => {
    render(<SettingsApprovalDialog />);

    act(() => {
      onRequested?.({
        id: 'approval-levels',
        resource: 'agents',
        target: 'Agents',
        changes: [
          {
            operation: 'edit',
            kind: 'agent-preset',
            title: 'Claude Code',
            moreContent: [
              { label: 'Levels', content: 'None', previous: 'Not set' },
              { label: 'Open command', content: 'codex ', previous: 'claude ' },
            ],
            details: [],
          },
        ],
      });
    });

    const levels = screen.getByRole('figure', { name: 'Levels' });
    expect(within(levels).getByRole('deletion')).toHaveTextContent('Not set');
    expect(within(levels).getByRole('insertion')).toHaveTextContent('None');
    expect(levels.querySelector('mark')).toBeNull();
    // Sharing only a space still changes the line as a whole.
    const command = screen.getByRole('figure', { name: 'Open command' });
    expect(within(command).getByRole('insertion')).toHaveTextContent('codex');
    expect(command.querySelector('mark')).toBeNull();
  });

  it('cancels safely and advances queued proposals', async () => {
    const user = userEvent.setup();
    render(<SettingsApprovalDialog />);
    const prompt = (id: string, title: string): SettingsApprovalPrompt => ({
      id,
      resource: 'workspace-setup',
      target: 'Komla Workspace Setup',
      changes: [
        {
          operation: 'add',
          kind: 'setup-step',
          title,
          contentLabel: 'Command',
          content: 'npm install',
          details: [],
        },
      ],
    });

    act(() => {
      onRequested?.(prompt('approval-1', 'Install'));
      onRequested?.(prompt('approval-2', 'Build'));
    });
    expect(screen.getByText('Install')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(resolveSettingsApproval).toHaveBeenCalledWith('approval-1', 'cancel');
    expect(await screen.findByText('Build')).toBeInTheDocument();
    act(() => onDismissed?.('approval-2'));
    expect(screen.queryByText('Build')).not.toBeInTheDocument();
  });

  it('shows twelve changes at first and lets you expand to every change it will apply', async () => {
    const user = userEvent.setup();
    render(<SettingsApprovalDialog />);

    act(() => {
      onRequested?.({
        id: 'approval-many',
        resource: 'actions',
        target: 'Global Actions',
        changes: Array.from({ length: 14 }, (_, index) => ({
          operation: 'add',
          kind: 'action',
          title: `Action ${index + 1}`,
          contentLabel: 'Command',
          content: `command-${index + 1}`,
          details: [],
        })),
      });
    });

    expect(screen.getByText('Action 12')).toBeInTheDocument();
    expect(screen.queryByText('Action 13')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show all 14 changes' }));

    expect(screen.getByText('Action 13')).toBeInTheDocument();
    expect(screen.getByText('Action 14')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument();
  });

  it('shows the warning above the list of changes', () => {
    render(<SettingsApprovalDialog />);

    act(() => {
      onRequested?.({
        id: 'approval-warning',
        resource: 'actions',
        target: 'Global Actions',
        warning: 'These Actions run in every project.',
        changes: Array.from({ length: 3 }, (_, index) => ({
          operation: 'add',
          kind: 'action',
          title: `Action ${index + 1}`,
          contentLabel: 'Command',
          content: `command-${index + 1}`,
          details: [],
        })),
      });
    });

    const warning = screen.getByText('These Actions run in every project.');
    const firstChange = screen.getByText('Action 1');
    expect(
      warning.compareDocumentPosition(firstChange) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});
