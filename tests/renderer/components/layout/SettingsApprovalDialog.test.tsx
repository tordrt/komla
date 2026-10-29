/**
 * @vitest-environment jsdom
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsApprovalDialog } from '../../../../src/renderer/components/layout/SettingsApprovalDialog';
import { useCustomizationStore } from '../../../../src/renderer/stores/customization.store';

import type { SettingsApprovalPrompt, ThemeConfig } from '../../../../src/shared/types';

vi.mock('../../../../src/renderer/lib/monaco-loader', () => ({}));
vi.mock('../../../../src/renderer/lib/terminal-renderer-runtime', () => ({}));

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
  DialogContent: ({
    children,
    onInteractOutside,
  }: React.PropsWithChildren<{ onInteractOutside?: (event: Event) => void }>) => (
    <div>
      {children}
      <button
        onClick={() => {
          // Radix closes the dialog on an outside click unless the handler prevents it.
          const event = new Event('interactoutside', { cancelable: true });
          onInteractOutside?.(event);
          if (!event.defaultPrevented) dialog.onOpenChange?.(false);
        }}
      >
        Outside
      </button>
    </div>
  ),
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

  it('keeps previewing when the user clicks outside the dialog', async () => {
    const user = userEvent.setup();
    render(<SettingsApprovalDialog />);
    act(() => onRequested?.(appearancePrompt));

    await user.click(screen.getByRole('button', { name: 'Outside' }));

    expect(resolveSettingsApproval).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Review settings changes' })).toBeInTheDocument();
    expect(useCustomizationStore.getState().theme).toMatchObject({ palette: 'nord' });
  });

  it('cancels a proposal without a preview when the user clicks outside the dialog', async () => {
    const user = userEvent.setup();
    render(<SettingsApprovalDialog />);
    act(() => onRequested?.({ ...appearancePrompt, id: 'approval-2', preview: undefined }));

    await user.click(screen.getByRole('button', { name: 'Outside' }));

    expect(resolveSettingsApproval).toHaveBeenCalledWith('approval-2', 'cancel');
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
