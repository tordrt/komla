/**
 * @vitest-environment jsdom
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NewTabButton } from '../../../src/renderer/components/terminal/NewTabButton';
import { useActionEditorStore } from '../../../src/renderer/stores/action-editor.store';

import type { Action } from '../../../src/shared/types';

// --- Mock state ---

const addAgentTab = vi.fn().mockResolvedValue({ id: 'term-agent' });
const addTab = vi.fn();
const showTabInFullPane = vi.fn();
const loadPresets = vi.fn().mockResolvedValue(undefined);
const setActivePreset = vi.fn().mockResolvedValue(undefined);
const executeShortcutAction = vi.fn();
const onNewTerminal = vi.fn();
const launchAction = vi.fn().mockResolvedValue('launched');
const loadActions = vi.fn().mockResolvedValue(undefined);

let presetsState: any[] = [];
let activePresetsState: any[] = [];
let workspacePresetId: string | undefined;
let defaultActionId: string | undefined;
let actionsState: Action[] = [];

// --- Mocks ---

vi.mock('../../../src/renderer/stores/workspaces.store', () => ({
  useWorkspacesStore: (selector: any) =>
    selector({
      addAgentTab,
      workspaces: [
        {
          id: 'ws-1',
          name: 'Test',
          projectId: 'proj-1',
          presetId: workspacePresetId,
          defaultActionId,
        },
      ],
    }),
}));

vi.mock('../../../src/renderer/stores/agent-presets.store', () => ({
  useAgentPresetsStore: (selector: any) =>
    selector({
      presets: presetsState,
      activePresets: activePresetsState,
      loadPresets,
      setActivePreset,
    }),
}));

vi.mock('../../../src/renderer/stores/actions.store', () => ({
  useActionsStore: (selector: any) =>
    selector({ actions: actionsState, loadActions }),
}));

vi.mock('../../../src/renderer/lib/action-launch', () => ({
  launchAction: (request: unknown) => launchAction(request),
}));

vi.mock('../../../src/renderer/stores/layout.store', () => ({
  useLayoutStore: (selector: any) => selector({ addTab, showTabInFullPane }),
}));

vi.mock('../../../src/renderer/stores/config.store', () => {
  const configState = { config: {} };
  const useConfigStore: any = (selector: any) => selector(configState);
  useConfigStore.getState = () => configState;
  return { useConfigStore };
});

vi.mock('../../../src/renderer/stores/toast.store', () => ({
  useToastStore: { getState: () => ({ addToast: vi.fn() }) },
}));

vi.mock('../../../src/renderer/lib/shortcut-actions', () => ({
  executeShortcutAction: (...args: any[]) => executeShortcutAction(...args),
}));

// Mock Radix dropdown to render inline (avoids portal issues in jsdom)
vi.mock('../../../src/renderer/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuContent: ({
    children,
    className,
  }: React.PropsWithChildren<{ className?: string }>) => (
    <div className={className}>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    ...props
  }: React.PropsWithChildren<
    Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onSelect'> & {
      onSelect?: (event: React.MouseEvent) => void;
    }
  >) => (
    <button {...props} onClick={(event) => onSelect?.(event)}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuSub: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuSubTrigger: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props} />
  ),
  DropdownMenuSubContent: ({
    children,
    className,
  }: React.PropsWithChildren<{ className?: string }>) => (
    <div data-testid="launch-modes" className={className}>
      {children}
    </div>
  ),
  DropdownMenuShortcut: ({ children }: React.PropsWithChildren) => <kbd>{children}</kbd>,
  DropdownMenuCheckboxItem: ({
    children,
    ...props
  }: React.PropsWithChildren<React.ButtonHTMLAttributes<HTMLButtonElement>>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock('../../../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipContent: ({ children }: React.PropsWithChildren) => (
    <div data-testid="tooltip">{children}</div>
  ),
}));

vi.mock('../../../src/renderer/stores/shortcuts.store', () => ({
  useShortcutsStore: (selector: any) =>
    selector({
      getDisplayShortcut: (action: string) =>
        ({ 'tab.newAgent': '⇧⌘T', 'terminal.new': '⌘T' })[action] ?? '',
    }),
  formatShortcutForDisplay: (shortcut: string) => shortcut,
}));

global.window.api = {} as any;

const ranAction = (id: string) =>
  expect(launchAction).toHaveBeenCalledWith({
    workspaceId: 'ws-1',
    action: expect.objectContaining({ id }),
    place: { kind: 'tab' },
  });

describe('NewTabButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    presetsState = [];
    activePresetsState = [];
    workspacePresetId = undefined;
    defaultActionId = undefined;
    actionsState = [];
    useActionEditorStore.setState({ request: null });
  });

  it('shows the new-terminal and new-agent shortcuts in its tooltip', () => {
    render(<NewTabButton workspaceId="ws-1" onNewTerminal={onNewTerminal} />);

    const tooltip = screen.getByTestId('tooltip');
    expect(tooltip).toHaveTextContent('New tab');
    expect(tooltip).toHaveTextContent('Terminal⌘T');
    expect(tooltip).toHaveTextContent('Agent⇧⌘T');
  });

  it('opens a terminal, or any other shell the workspace offers, above the agents', async () => {
    const newLocalCopyTerminal = vi.fn();
    const user = userEvent.setup();
    render(
      <NewTabButton
        workspaceId="ws-1"
        onNewTerminal={onNewTerminal}
        terminalOptions={[
          { label: 'New Local copy terminal', icon: null, onSelect: newLocalCopyTerminal },
        ]}
      />
    );

    const newTerminal = screen.getByRole('button', { name: /New terminal/ });
    expect(newTerminal).toHaveTextContent('⌘T');
    expect(newTerminal.compareDocumentPosition(screen.getByText('AI Agent'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    await user.click(newTerminal);
    expect(onNewTerminal).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'New Local copy terminal' }));
    expect(newLocalCopyTerminal).toHaveBeenCalledTimes(1);
    expect(addAgentTab).not.toHaveBeenCalled();
  });

  it('clicking AI Agent with no presets opens settings to configure one', async () => {
    const settingsHandler = vi.fn();
    window.addEventListener('open-settings', settingsHandler);
    const user = userEvent.setup();
    render(<NewTabButton workspaceId="ws-1" onNewTerminal={onNewTerminal} />);

    await user.click(screen.getByText('AI Agent'));

    expect(settingsHandler).toHaveBeenCalled();
    expect(addAgentTab).not.toHaveBeenCalled();
    window.removeEventListener('open-settings', settingsHandler);
  });

  it('shows and launches the single preset by name', async () => {
    presetsState = [{ id: 'p-1', name: 'Codex', openCommand: 'codex', launchModes: [] }];
    activePresetsState = [{ presetId: 'p-1', lastUsedAt: 1 }];

    const user = userEvent.setup();
    render(<NewTabButton workspaceId="ws-1" onNewTerminal={onNewTerminal} />);

    expect(screen.queryByText('AI Agent')).not.toBeInTheDocument();
    const presetLabel = screen.getByText('Codex');
    const presetIcon = presetLabel.previousElementSibling;
    expect(presetIcon).toHaveAttribute('aria-hidden', 'true');
    expect(presetIcon).not.toHaveAttribute('role');
    expect(presetIcon).not.toHaveAttribute('aria-label');

    await user.click(presetLabel);

    await waitFor(() => {
      expect(addAgentTab).toHaveBeenCalledWith('ws-1', undefined, undefined, 'p-1');
      expect(addTab).toHaveBeenCalledWith('ws-1', 'term-agent');
      expect(showTabInFullPane).toHaveBeenCalledWith('term-agent');
    });
    expect(executeShortcutAction).not.toHaveBeenCalled();
  });

  it('does not show or launch an inactive workspace preset', async () => {
    workspacePresetId = 'p-1';
    presetsState = [
      { id: 'p-1', name: 'Claude Code', openCommand: 'claude', launchModes: [] },
      {
        id: 'p-2',
        name: 'Codex',
        openCommand: 'codex',
        launchModes: [{ id: 'safe', name: 'Safe', command: 'codex --safe' }],
      },
    ];
    activePresetsState = [{ presetId: 'p-2', lastUsedAt: 1 }];

    const user = userEvent.setup();
    render(<NewTabButton workspaceId="ws-1" onNewTerminal={onNewTerminal} />);

    expect(screen.queryByText('Claude Code')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Codex, Default$/i }));

    await waitFor(() => {
      expect(addAgentTab).toHaveBeenCalledWith('ws-1', undefined, undefined, 'p-2');
    });
  });

  it('shows Configure instead of an inactive workspace preset when none are active', () => {
    workspacePresetId = 'p-1';
    presetsState = [{ id: 'p-1', name: 'Claude Code', openCommand: 'claude', launchModes: [] }];

    render(<NewTabButton workspaceId="ws-1" onNewTerminal={onNewTerminal} />);

    expect(screen.queryByText('Claude Code')).not.toBeInTheDocument();
    expect(screen.getByText('AI Agent')).toBeInTheDocument();
    expect(screen.getByText('Configure...')).toBeInTheDocument();
  });

  it('keeps launch modes behind the agent row arrow', async () => {
    presetsState = [
      {
        id: 'p-1',
        name: 'Codex',
        openCommand: 'codex',
        launchModes: [{ id: 'sandbox', name: 'Sandbox', command: 'codex --sandbox' }],
      },
    ];
    activePresetsState = [{ presetId: 'p-1', lastUsedAt: 1 }];

    const user = userEvent.setup();
    render(<NewTabButton workspaceId="ws-1" onNewTerminal={onNewTerminal} />);

    expect(screen.getByRole('button', { name: 'Codex launch modes' })).toBeInTheDocument();
    const modes = screen.getByTestId('launch-modes');
    expect(modes).toHaveClass('group/agent-launch-picker');
    expect(modes.querySelector('[data-agent-launch-matrix]')).toHaveAttribute(
      'data-agent-launch-layout',
      'compact'
    );
    expect(screen.getByRole('button', { name: /^Codex, Default$/i })).toHaveClass(
      'bg-foreground/8'
    );

    await user.click(screen.getByRole('button', { name: /^Codex, Sandbox$/i }));
    await waitFor(() => {
      expect(addAgentTab).toHaveBeenCalledWith('ws-1', undefined, 'sandbox', 'p-1');
    });
  });

  it('lists the default agent first, with the new-agent shortcut', () => {
    presetsState = [
      {
        id: 'p-1',
        name: 'Claude Code',
        openCommand: 'claude',
        launchModes: [
          { id: 'plan', name: 'Plan', command: 'claude --plan' },
          { id: 'dangerous', name: 'Dangerous', command: 'claude --yolo' },
        ],
      },
      { id: 'p-2', name: 'Codex', openCommand: 'codex', launchModes: [] },
    ];
    activePresetsState = [
      { presetId: 'p-1', lastUsedAt: 1 },
      { presetId: 'p-2', lastUsedAt: 2 },
    ];

    render(<NewTabButton workspaceId="ws-1" onNewTerminal={onNewTerminal} />);

    const codex = screen.getByRole('button', { name: /^Codex/ });
    const claude = screen.getByRole('button', { name: 'Claude Code' });
    expect(codex).toHaveTextContent('Codex⇧⌘T');
    expect(claude).not.toHaveTextContent('⇧⌘T');
    expect(codex.compareDocumentPosition(claude)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // Codex has no launch modes, so no arrow; Claude Code's modes wait behind one.
    expect(screen.queryByRole('button', { name: 'Codex launch modes' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Claude Code launch modes' })).toBeInTheDocument();
    expect(screen.getByText('Dangerous')).toBeInTheDocument();
  });

  it('launches an agent row in that preset last-used launch mode', async () => {
    presetsState = [
      {
        id: 'p-1',
        name: 'Claude Code',
        openCommand: 'claude',
        launchModes: [
          { id: 'plan', name: 'Plan', command: 'claude --plan' },
          { id: 'dangerous', name: 'Dangerous', command: 'claude --yolo' },
        ],
      },
      { id: 'p-2', name: 'Codex', openCommand: 'codex', launchModes: [] },
    ];
    activePresetsState = [
      { presetId: 'p-1', lastUsedAt: 1, lastLaunchModeId: 'plan' },
      { presetId: 'p-2', lastUsedAt: 2 },
    ];

    const user = userEvent.setup();
    render(<NewTabButton workspaceId="ws-1" onNewTerminal={onNewTerminal} />);

    const claudeRow = screen.getByText('Claude Code').closest('button')!;
    expect(claudeRow.querySelector('[aria-label="Plan launch mode"]')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Claude Code, Plan$/i })).toHaveClass(
      'bg-foreground/8'
    );

    await user.click(claudeRow);

    await waitFor(() => {
      expect(addAgentTab).toHaveBeenCalledWith('ws-1', undefined, 'plan', 'p-1');
    });
  });

  describe('Actions', () => {
    const action = (overrides: Partial<Action>): Action => ({
      id: 'a-1',
      title: 'Dev Server',
      type: 'command',
      content: 'npm run dev',
      projectIds: ['proj-1'],
      ...overrides,
    });

    it('offers to create one scoped to the project, below the agents', async () => {
      const user = userEvent.setup();
      render(<NewTabButton workspaceId="ws-1" onNewTerminal={onNewTerminal} />);

      const newAction = screen.getByRole('button', { name: 'New quick command' });
      expect(screen.getByText('AI Agent').compareDocumentPosition(newAction)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING
      );
      await user.click(newAction);

      expect(useActionEditorStore.getState().request).toMatchObject({
        actionId: null,
        projectIds: ['proj-1'],
      });
    });

    it('reruns the last used action from its row', async () => {
      actionsState = [
        action({ id: 'a-1', title: 'Lint', content: 'npm run lint', lastUsedAt: 1 }),
        action({ id: 'a-2', title: 'Dev Server', content: 'npm run dev', lastUsedAt: 2 }),
      ];
      const user = userEvent.setup();
      render(<NewTabButton workspaceId="ws-1" onNewTerminal={onNewTerminal} />);

      expect(screen.getByRole('button', { name: 'More quick commands' })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Dev Server' }));

      await waitFor(() => ranAction('a-2'));
    });

    it("reruns the workspace's default over the last used action", async () => {
      actionsState = [
        action({ id: 'a-1', title: 'Lint', content: 'npm run lint', lastUsedAt: 1 }),
        action({ id: 'a-2', title: 'Dev Server', content: 'npm run dev', lastUsedAt: 2 }),
      ];
      defaultActionId = 'a-1';
      const user = userEvent.setup();
      render(<NewTabButton workspaceId="ws-1" onNewTerminal={onNewTerminal} />);

      await user.click(screen.getByRole('button', { name: 'Lint' }));

      await waitFor(() => ranAction('a-1'));
    });

    it('lists every action for the project behind the row arrow', async () => {
      actionsState = [
        action({ id: 'a-1', title: 'Lint', content: 'npm run lint', lastUsedAt: 2 }),
        action({ id: 'a-2', title: 'Dev Server', content: 'npm run dev', lastUsedAt: 1 }),
        action({ id: 'a-3', title: 'Elsewhere', projectIds: ['proj-2'] }),
      ];
      const user = userEvent.setup();
      render(<NewTabButton workspaceId="ws-1" onNewTerminal={onNewTerminal} />);

      const list = screen.getByRole('listbox');
      expect(screen.getByRole('option', { name: /Dev Server/ })).toHaveAttribute(
        'title',
        'npm run dev'
      );
      expect(list).not.toHaveTextContent('Elsewhere');
      await user.click(screen.getByRole('option', { name: /Dev Server/ }));

      await waitFor(() => ranAction('a-2'));
    });
  });
});
